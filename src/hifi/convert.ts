// Measured capture (+ already-validated local assets) -> schemaVersion 2 doc.
// Pure: no network, no filesystem. Geometry and styles come only from the
// capture; anything derived is marked "inferred"; nothing is invented.
//
// Capture input ("website-to-figma/capture" v1) is the shape produced by a
// read-only DOM measurement (element boxes + computed styles, grapheme-grouped
// text line fragments, images with currentSrc). It is untrusted operator data:
// unknown fields are ignored, counts/strings/numbers are bounded.
import { LIMITS } from "../shared/limits";
import { cleanText } from "../shared/text";
import { genericOf, parseFontStack } from "../shared/fonts";
import { HIFI_SCHEMA_VERSION, validateHifiDoc, type BoxNode, type HifiAsset, type HifiDoc, type HifiNode, type HifiPage, type Paint } from "../shared/hifiSchema";
import { SCHEMA_ID } from "../shared/schema";
import { isSameSite, parseHttpUrl } from "../security/urlGuard";
import { canonicalizeUrl, displayPath } from "../normalize/canonicalize";
import { GENERATOR_VERSION } from "../normalize/build";
import type { ImageMime } from "../shared/imageInfo";

export class CaptureError extends Error {}

export interface LoadedAsset {
  operatorId: string;
  kind: "image" | "reference";
  mime: ImageMime;
  width: number;
  height: number;
  sha256: string;
  sourceUrl: string | null;
  // For kind "reference": the page URL it depicts (structurally checked), if given.
  pageUrl?: string | null;
  bytes: Uint8Array;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const arr = (v: unknown, max: number, what: string): unknown[] => {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new CaptureError(`${what}: expected array`);
  if (v.length > max) throw new CaptureError(`${what}: more than ${max} items`);
  return v;
};
const fin = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 100_000 ? v : null);
const str = (v: unknown, max = 500): string => (typeof v === "string" ? v.slice(0, max) : "");
const px = (v: unknown): number => {
  const m = /^(-?\d+(?:\.\d+)?)px$/.exec(str(v, 40).trim());
  return m ? Number(m[1]) : 0;
};
const round = (n: number) => Math.round(n * 1000) / 1000;

// Computed colors are rgb()/rgba() (legacy or space syntax). Anything else is
// not interpreted. Fully transparent -> null.
export function parseColor(v: unknown): Paint | null {
  const s = str(v, 80).trim().toLowerCase();
  const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(s);
  if (!m) return null;
  const c = [m[1], m[2], m[3]].map((x) => Math.max(0, Math.min(255, Math.round(Number(x)))));
  let alpha = 1;
  if (m[4] !== undefined) alpha = m[4].endsWith("%") ? Number(m[4].slice(0, -1)) / 100 : Number(m[4]);
  if (!Number.isFinite(alpha) || alpha <= 0) return null;
  return { hex: "#" + c.map((x) => x.toString(16).padStart(2, "0")).join(""), alpha: Math.min(1, round(alpha)) };
}

export function parseRadius(v: unknown): [number, number, number, number] {
  const head = str(v, 80).split("/")[0]!.trim();
  const parts = head.split(/\s+/).filter(Boolean).map((t) => (/^\d+(\.\d+)?px$/.test(t) ? Number(t.slice(0, -2)) : 0));
  const [a = 0, b = a, c = a, d = b] = parts;
  return [a, b, c, d].map((x) => Math.min(10_000, round(x))) as [number, number, number, number];
}

function weightOf(v: unknown): number {
  const s = str(v, 20);
  if (s === "bold") return 700;
  if (s === "normal" || s === "") return 400;
  const n = Number(s);
  return Number.isFinite(n) && n >= 1 && n <= 1000 ? n : 400;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
export function graphemeCount(s: string): number {
  let n = 0;
  for (const _ of segmenter.segment(s)) n++;
  return n;
}

// Leading/trailing spaces in independent styled fragments are significant for
// inline runs; NBSP keeps Figma from collapsing them.
function protectEdgeSpaces(s: string): string {
  return s.replace(/^ +/, (m) => "\u00a0".repeat(m.length)).replace(/ +$/, (m) => "\u00a0".repeat(m.length));
}

function rectOf(o: Obj): { x: number; y: number; w: number; h: number } | null {
  const x = fin(o.x);
  const y = fin(o.y);
  const w = fin(o.w);
  const h = fin(o.h);
  if (x === null || y === null || w === null || h === null || w <= 0 || h <= 0) return null;
  return { x: round(x), y: round(y), w: round(w), h: round(h) };
}

const NON_HTML_EXT = /\.(xml|rss|atom|json|pdf|txt|csv|zip|png|jpe?g|gif|svg|webp)$/i;

function brandingOf(v: unknown): HifiPage["branding"] {
  if (!isObj(v)) return null;
  const colors: Record<string, string> = Object.create(null) as Record<string, string>;
  if (isObj(v.colors)) {
    for (const [k, val] of Object.entries(v.colors).slice(0, 40)) {
      if (Object.keys(colors).length >= 20 || !/^[A-Za-z][A-Za-z0-9]{0,31}$/.test(k)) continue;
      const s = str(val, 20).trim().toLowerCase();
      const m6 = /^#([0-9a-f]{6})$/.exec(s);
      const m3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(s);
      if (m6) colors[k] = s;
      else if (m3) colors[k] = `#${m3[1]}${m3[1]}${m3[2]}${m3[2]}${m3[3]}${m3[3]}`;
    }
  }
  const fonts: string[] = [];
  for (const f of arr(v.fonts, 50, "branding.fonts")) {
    const fam = cleanText(str(isObj(f) ? f.family : "", 100), 100);
    if (fam && !fonts.includes(fam) && fonts.length < 10) fonts.push(fam);
  }
  return Object.keys(colors).length || fonts.length ? { colors, fonts } : null;
}

export interface ConvertInput {
  capture: unknown;
  assets: LoadedAsset[];
  assetWarnings: string[];
}

export function convertCapture(input: ConvertInput): HifiDoc {
  const cap = input.capture;
  if (!isObj(cap) || cap.schema !== "website-to-figma/capture" || cap.schemaVersion !== 1) {
    throw new CaptureError('capture: expected { schema: "website-to-figma/capture", schemaVersion: 1, ... }');
  }
  const label = cleanText(str(cap.label, 200), 200) || "operator capture";
  const docWarnings: string[] = [...input.assetWarnings];
  const warn = (list: string[], w: string) => {
    if (list.length < LIMITS.hifiMaxWarnings) list.push(cleanText(w, LIMITS.maxNoteChars));
  };

  const byOperatorId = new Map(input.assets.map((a) => [a.operatorId, a]));
  const bySource = new Map(input.assets.filter((a) => a.sourceUrl && a.kind === "image").map((a) => [a.sourceUrl!, a]));
  const used: HifiAsset[] = [];
  const assetIdFor = (a: LoadedAsset): string => {
    const existing = used.find((u) => u.sha256 === a.sha256 && u.kind === a.kind);
    if (existing) return existing.id;
    const id = `a${used.length}`;
    used.push({ id, kind: a.kind, mime: a.mime, width: a.width, height: a.height, bytes: a.bytes.length, sha256: a.sha256, sourceUrl: a.sourceUrl, dataBase64: Buffer.from(a.bytes).toString("base64") });
    return id;
  };

  const rawPages = arr(cap.pages, 100, "capture.pages");
  let first: URL | null = null;
  const pages: HifiPage[] = [];
  let totalNodes = 0;

  for (const [pi, rp] of rawPages.entries()) {
    if (!isObj(rp)) throw new CaptureError(`capture.pages[${pi}]: expected object`);
    const url = parseHttpUrl(str(rp.url, LIMITS.maxUrlChars));
    const canonical = canonicalizeUrl(url);
    const path = displayPath(canonical);
    if (first && !isSameSite(url, first)) {
      warn(docWarnings, `Skipped ${canonical}: not on the same site as the first page`);
      continue;
    }
    const ct = str(rp.contentType, 100).toLowerCase();
    if ((ct && !ct.startsWith("text/html")) || NON_HTML_EXT.test(new URL(canonical).pathname)) {
      warn(docWarnings, `Skipped non-HTML page ${path}`);
      continue;
    }
    if (pages.length >= LIMITS.hifiMaxPages) {
      warn(docWarnings, `Page cap ${LIMITS.hifiMaxPages} reached; ${path} and later pages omitted`);
      break;
    }
    first ??= url;
    const m = rp.measured;
    if (!isObj(m)) throw new CaptureError(`capture.pages[${pi}].measured: expected object`);
    const warnings: string[] = [];
    const elements = arr(m.elements, LIMITS.captureMaxElements, "measured.elements").filter(isObj);
    const texts = arr(m.texts, LIMITS.captureMaxTexts, "measured.texts").filter(isObj);
    const images = arr(m.images, LIMITS.captureMaxImages, "measured.images").filter(isObj);
    const svgCount = arr(m.svgs, LIMITS.captureMaxElements, "measured.svgs").length;

    const vw = isObj(m.viewport) ? fin(m.viewport.width) : null;
    if (vw === null || vw <= 0) throw new CaptureError(`capture.pages[${pi}].measured.viewport.width: required (measured)`);
    let width = round(vw);
    let truncated = false;
    if (width > LIMITS.hifiMaxPageWidth) {
      warn(warnings, `Measured width ${width}px exceeds ${LIMITS.hifiMaxPageWidth}px; frame clipped`);
      width = LIMITS.hifiMaxPageWidth;
      truncated = true;
    }
    // Height: the measured body box when present, else the lowest measured box.
    const body = elements.find((e) => e.tag === "body");
    const bodyRect = body ? rectOf(body) : null;
    let height = bodyRect ? round(bodyRect.y + bodyRect.h) : 0;
    if (!height) for (const o of [...elements, ...texts, ...images]) {
      const r = rectOf(o);
      if (r) height = Math.max(height, round(r.y + r.h));
    }
    if (height <= 0) throw new CaptureError(`capture.pages[${pi}]: no measured geometry`);
    if (height > LIMITS.hifiMaxPageHeight) {
      warn(warnings, `Measured height ${height}px exceeds ${LIMITS.hifiMaxPageHeight}px; content below is truncated`);
      height = LIMITS.hifiMaxPageHeight;
      truncated = true;
    }
    const inPage = (r: { y: number }) => r.y < height;

    // Candidates are collected first, then a priority budget is applied so a
    // capped page drops decorative boxes before images and never text first:
    // 0 measured text, 1 buttons/controls/inferred labels, 2 images, 3 blocks.
    type Cand = { node: HifiNode; prio: number; buttonOf?: BoxNode; asset?: LoadedAsset | null };
    const boxC: Cand[] = [];
    const imgC: Cand[] = [];
    const textC: Cand[] = [];
    const buttonBoxes: BoxNode[] = [];
    let unparsedColors = 0;

    for (const e of elements) {
      const r = rectOf(e);
      if (!r || !inPage(r)) continue;
      const s = isObj(e.style) ? e.style : {};
      if (s.display === "none" || s.visibility === "hidden") continue;
      const tag = str(e.tag, 20).toLowerCase();
      const control = isObj(e.control) ? e.control : null;
      const ctype = str(control?.type, 20).toLowerCase();
      const role: BoxNode["role"] = tag === "button" || (tag === "input" && ["button", "submit", "reset"].includes(ctype)) ? "button" : control ? "control" : "block";
      const fill = parseColor(s.backgroundColor);
      if (s.backgroundColor && !fill && !/rgba?\([^)]*,\s*0\)|transparent/.test(str(s.backgroundColor))) unparsedColors++;
      const sides = ["Top", "Right", "Bottom", "Left"].map((k) => ({ w: px(s[`border${k}Width`]), c: parseColor(s[`border${k}Color`]) }));
      const uniform = sides.every((x) => x.w === sides[0]!.w && x.c?.hex === sides[0]!.c?.hex && x.c?.alpha === sides[0]!.c?.alpha);
      const anyBorder = sides.some((x) => x.w > 0 && x.c);
      if (!fill && !anyBorder && role === "block") continue;
      const opacityRaw = Number(str(s.opacity, 10) || "1");
      // A plain block whose only paint is non-uniform borders becomes just its edges.
      if (fill !== null || (anyBorder && uniform) || role !== "block") {
        const box: BoxNode = {
          kind: "box",
          ...r,
          name: `${tag}${role === "button" ? " / button" : ""}`,
          role,
          fill,
          border: anyBorder && uniform ? { weight: sides[0]!.w, color: sides[0]!.c! } : null,
          radius: parseRadius(s.borderRadius),
          opacity: Number.isFinite(opacityRaw) ? Math.max(0, Math.min(1, opacityRaw)) : 1,
          prov: "measured",
        };
        boxC.push({ node: box, prio: role === "block" ? 3 : 1 });
        if (role === "button") buttonBoxes.push(box);
      }
      if (anyBorder && !uniform) {
        const edges = [
          { ...r, h: sides[0]!.w },
          { x: round(r.x + r.w - sides[1]!.w), y: r.y, w: sides[1]!.w, h: r.h },
          { x: r.x, y: round(r.y + r.h - sides[2]!.w), w: r.w, h: sides[2]!.w },
          { ...r, w: sides[3]!.w },
        ];
        edges.forEach((er, i) => {
          const side = sides[i]!;
          if (side.w > 0 && side.c) {
            boxC.push({ node: { kind: "box", ...er, name: `${tag} / border-${["top", "right", "bottom", "left"][i]}`, role: "block", fill: side.c, border: null, radius: [0, 0, 0, 0], opacity: 1, prov: "measured" }, prio: 3 });
          }
        });
      }
      // Control label text is not a measured text run: mark it inferred.
      if (role === "control" && control && tag !== "button") {
        const label = cleanText(str(control.selected) || str(control.value) || str(control.placeholder), 200);
        if (label && !["checkbox", "radio", "range", "color", "file"].includes(ctype)) {
          const size = px(s.fontSize) || 16;
          textC.push({
            prio: 1,
            node: {
              kind: "text",
              x: round(r.x + px(s.paddingLeft) + px(s.borderLeftWidth)),
              y: round(r.y + px(s.paddingTop) + px(s.borderTopWidth)),
              w: Math.max(1, round(r.w - px(s.paddingLeft) - px(s.paddingRight))),
              h: Math.max(1, round(r.h - px(s.paddingTop) - px(s.paddingBottom))),
              name: `control label (${ctype || tag})`,
              text: protectEdgeSpaces(label),
              graphemes: graphemeCount(label),
              fontStack: parseFontStack(str(s.fontFamily)),
              generic: genericOf(parseFontStack(str(s.fontFamily))),
              weight: weightOf(s.fontWeight),
              italic: false,
              size,
              lineHeight: Math.max(1, round(Math.min(r.h, size * 1.5))),
              color: parseColor(s.color) ?? { hex: "#000000", alpha: 1 },
              decoration: "none",
              button: -1,
              prov: "inferred",
            },
          });
        }
      }
    }

    for (const im of images) {
      const r = rectOf(im);
      if (!r || !inPage(r)) continue;
      const s = isObj(im.style) ? im.style : {};
      const asset = bySource.get(str(im.src, LIMITS.maxUrlChars)) ?? null;
      imgC.push({
        prio: 2,
        asset,
        node: { kind: "image", ...r, name: `image / ${cleanText(str(im.alt, 80), 80) || "untitled"}`, assetId: null, fit: str(s.objectFit) === "contain" ? "fit" : "fill", radius: parseRadius(s.borderRadius), prov: "measured" },
      });
    }

    let shortened = 0;
    for (const t of texts) {
      const r = rectOf(t);
      if (!r || !inPage(r)) continue;
      const raw = str(t.text, LIMITS.hifiMaxTextChars * 2);
      // eslint-disable-next-line no-control-regex
      const text = raw.replace(/[\u0000-\u001f\u007f]/g, " ");
      if (!text.trim()) continue;
      const bounded = text.length > LIMITS.hifiMaxTextChars ? text.slice(0, LIMITS.hifiMaxTextChars) : text;
      if (typeof t.text === "string" && t.text.length > LIMITS.hifiMaxTextChars) shortened++;
      const s = isObj(t.style) ? t.style : {};
      const stack = parseFontStack(str(s.fontFamily));
      const deco = str(s.textDecorationLine);
      const cx = r.x + r.w / 2;
      const cy = r.y + r.h / 2;
      const color = parseColor(s.color);
      if (!color) unparsedColors++;
      textC.push({
        prio: 0,
        buttonOf: buttonBoxes.find((b) => cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h),
        node: {
          kind: "text",
          ...r,
          name: `${str(t.tag, 20) || "text"} / ${cleanText(bounded, 40)}`,
          text: protectEdgeSpaces(bounded),
          graphemes: Math.max(1, graphemeCount(bounded)),
          fontStack: stack,
          generic: Boolean(t.code) ? "mono" : genericOf(stack),
          weight: weightOf(s.fontWeight),
          italic: /italic|oblique/.test(str(s.fontStyle)),
          size: px(s.fontSize) || 16,
          lineHeight: Math.max(1, r.h),
          color: color ?? { hex: "#000000", alpha: 1 },
          decoration: deco.includes("underline") ? "underline" : deco.includes("line-through") ? "strike" : "none",
          button: -1,
          prov: "measured",
        },
      });
    }

    const allC = [...boxC, ...imgC, ...textC];
    const budget = Math.max(0, Math.min(LIMITS.hifiMaxNodesPerPage, LIMITS.hifiMaxNodesTotal - totalNodes));
    const keep = new Set(allC.length <= budget ? allC : allC.map((c, i) => ({ c, i })).sort((a, b) => a.c.prio - b.c.prio || a.i - b.i).slice(0, budget).map((x) => x.c));
    // Emit in visual stacking order (boxes, images, text on top).
    const nodes: HifiNode[] = [];
    const indexOf = new Map<HifiNode, number>();
    let missingAssets = 0;
    for (const c of allC) {
      if (!keep.has(c)) continue;
      if (c.node.kind === "image") {
        c.node.assetId = c.asset ? assetIdFor(c.asset) : null;
        if (!c.asset) missingAssets++;
      }
      if (c.node.kind === "text") c.node.button = c.buttonOf && indexOf.has(c.buttonOf) ? indexOf.get(c.buttonOf)! : -1;
      indexOf.set(c.node, nodes.length);
      nodes.push(c.node);
    }
    const dropped = allC.length - keep.size;
    const droppedTexts = textC.filter((c) => !keep.has(c)).length;

    if (missingAssets) warn(warnings, `${missingAssets} image(s) have no supplied asset bytes; shown as labelled placeholders`);
    if (shortened) warn(warnings, `${shortened} text run(s) longer than ${LIMITS.hifiMaxTextChars} characters were shortened`);
    if (svgCount) warn(warnings, `${svgCount} inline SVG element(s) omitted: SVG markup is not imported`);
    if (unparsedColors) warn(warnings, `${unparsedColors} color value(s) were not rgb()/rgba() and were not applied`);
    if (dropped) {
      truncated = true;
      warn(warnings, `${dropped} node(s) omitted by the node cap (${droppedTexts} of them text runs); lowest-priority boxes dropped first`);
    }
    totalNodes += nodes.length;

    let referenceAssetId: string | null = null;
    const refId = str(rp.referenceAssetId, 64);
    if (refId) {
      const ref = byOperatorId.get(refId);
      if (ref && ref.kind === "reference") referenceAssetId = assetIdFor(ref);
      else warn(warnings, `Reference screenshot "${refId}" not available (missing or rejected asset; see document warnings)`);
    } else {
      const ref = input.assets.find((a) => a.kind === "reference" && a.pageUrl && canonicalizeUrl(a.pageUrl) === canonical);
      if (ref) referenceAssetId = assetIdFor(ref);
    }
    if (!referenceAssetId && !refId) warn(warnings, "No reference screenshot supplied for this page");

    pages.push({
      id: `p${pages.length}`,
      url: canonical,
      path,
      title: cleanText(str(m.title, 300), LIMITS.maxTitleChars) || path,
      width,
      height,
      truncated,
      referenceAssetId,
      branding: brandingOf(rp.branding),
      nodes,
      warnings,
    });
  }
  if (pages.length === 0 || !first) throw new CaptureError("capture: no usable HTML pages");

  const doc: HifiDoc = {
    schema: SCHEMA_ID,
    schemaVersion: HIFI_SCHEMA_VERSION,
    generator: { name: "website-to-figma", version: GENERATOR_VERSION },
    source: { mode: "capture", label },
    site: { origin: first.origin, host: first.hostname },
    provenance: {
      layout: "measured-dom",
      notes: [
        "Positions, sizes, colors, borders, radii and text runs are measured by the capture (absolute desktop snapshot, not responsive layout).",
        "Fonts are mapped to fonts available in Figma at import; substitutions are reported.",
        "Control label text is inferred from control values; it is marked inferred.",
      ],
    },
    assets: used,
    pages,
    warnings: docWarnings,
  };
  const v = validateHifiDoc(doc);
  if (!v.ok) throw new CaptureError(`Internal error: converted document failed validation:\n${v.errors.join("\n")}`);
  return v.doc;
}
