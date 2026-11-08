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
import { HIFI_SCHEMA_VERSION, validateHifiDoc, type BoxNode, type FontMapEntry, type HifiAsset, type HifiComponent, type HifiDoc, type HifiNode, type HifiPage, type Instance, type Paint } from "../shared/hifiSchema";
import { sanitizeSvg } from "../shared/svgSanitize";
import { gutterFix, htmlFacts, innermost, memberOf, overflowContainers, parentByPath, rejoinFragments, widthMap, type WidthMap } from "./corrections";
import { SCHEMA_ID } from "../shared/schema";
import { isSameSite, parseHttpUrl } from "../security/urlGuard";
import { canonicalizeUrl, displayPath } from "../normalize/canonicalize";
import { GENERATOR_VERSION } from "../normalize/build";
import type { ImageMime } from "../shared/imageInfo";
import { attachStates } from "../states/convertStates";

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
  // For kind "reference": the state variant it depicts (state screenshots only).
  state?: string;
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

export function parseRadius(v: unknown, w = 0, h = 0): [number, number, number, number] {
  const head = str(v, 80).split("/")[0]!.trim();
  const base = Math.min(w, h);
  const parts = head
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => (/^\d+(\.\d+)?px$/.test(t) ? Number(t.slice(0, -2)) : /^\d+(\.\d+)?%$/.test(t) && base > 0 ? Math.min(base / 2, (Number(t.slice(0, -1)) / 100) * base) : 0));
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

export interface RejectedReference {
  operatorId: string;
  pageUrl: string | null;
  width: number;
  height: number;
  reason: string;
}

export interface ConvertInput {
  capture: unknown;
  assets: LoadedAsset[];
  assetWarnings: string[];
  // references that could not be imported but whose pixel size is known
  rejectedReferences?: RejectedReference[];
  fontMap?: FontMapEntry[];
  // Explicit operator opt-in to INFERRED geometry normalization against the
  // reference screenshot size. Default (undefined): measured geometry kept.
  normalizeReference?: "centered-dpr1";
  // Tall reference PNGs tiled offline (see tileReference.ts).
  referenceTiles?: TiledReference[];
  // Optional native prototype reactions between state variants.
  stateReactions?: "none" | "click-cycle";
  // internal: converting one state's measurement (no nested states)
  nested?: boolean;
}

export interface TiledReference {
  operatorId: string;
  pageUrl: string | null;
  sourceSha256: string;
  width: number;
  height: number;
  tiles: { asset: LoadedAsset; y: number; h: number }[];
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
  const regionsByPage: { nav: Region; footer: Region }[] = [];

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
    const notes: string[] = [];
    const rawElements = arr(m.elements, LIMITS.captureMaxElements, "measured.elements").filter(isObj);
    const rawTexts = arr(m.texts, LIMITS.captureMaxTexts, "measured.texts").filter(isObj);
    const rawImages = arr(m.images, LIMITS.captureMaxImages, "measured.images").filter(isObj);
    const rawSvgs = arr(m.svgs, LIMITS.captureMaxElements, "measured.svgs").filter(isObj);

    const vw = isObj(m.viewport) ? fin(m.viewport.width) : null;
    if (vw === null || vw <= 0) throw new CaptureError(`capture.pages[${pi}].measured.viewport.width: required (measured)`);
    let truncated = false;

    // Reference screenshot: its own pixel size is the observed evidence for
    // width reconciliation and hidden-scrollbar normalization (also for a
    // reference that was rejected for import, e.g. taller than 4096px).
    const refId = str(rp.referenceAssetId, 64);
    const refAsset = refId ? byOperatorId.get(refId) : input.assets.find((a) => a.kind === "reference" && !a.state && a.pageUrl && canonicalizeUrl(a.pageUrl) === canonical);
    const refRejected = (input.rejectedReferences ?? []).find((r) => (refId ? r.operatorId === refId : !!r.pageUrl && canonicalizeUrl(r.pageUrl) === canonical));
    const refTiled = (input.referenceTiles ?? []).find((r) => (refId ? r.operatorId === refId : !!r.pageUrl && canonicalizeUrl(r.pageUrl) === canonical));
    const refDims = refTiled ? { w: refTiled.width, h: refTiled.height } : refAsset && refAsset.kind === "reference" ? { w: refAsset.width, h: refAsset.height } : refRejected ? { w: refRejected.width, h: refRejected.height } : null;
    if (refRejected && !refTiled && !(refAsset && refAsset.kind === "reference")) {
      warn(warnings, `Reference screenshot (${refRejected.width}x${refRejected.height}px) not imported: ${refRejected.reason}; its size is still used as evidence`);
    }

    // G1: reconcile measured viewport width with the reference width — only on
    // explicit operator opt-in (an inference: centered layout, DPR 1).
    const optIn = input.normalizeReference === "centered-dpr1";
    const wm: WidthMap | null = optIn && refDims && refDims.w < vw - 0.5 ? widthMap(vw, refDims.w) : null;
    if (!optIn && refDims && Math.abs(refDims.w - vw) > 0.5) {
      warn(warnings, `Measured width ${round(vw)}px differs from the reference's ${refDims.w}px; measured geometry kept (opt in with --normalize-reference centered-dpr1)`);
    }
    const mapBox = (o: Obj): Obj => {
      const r = rectOf(o);
      return r ? { ...o, ...(wm ? wm.apply(r) : r) } : o;
    };
    let elements = rawElements.map(mapBox);
    const rejoined = rejoinFragments(rawTexts.map(mapBox));
    let texts = rejoined.texts;
    let images = rawImages.map(mapBox);
    let svgs = rawSvgs.map(mapBox);
    let width = round(vw);
    if (wm && refDims) {
      width = refDims.w;
      const c = wm.counts;
      notes.push(`INFERRED normalization (opt-in centered-dpr1): width ${round(vw)}px -> ${refDims.w}px; ${c.fullBleed} full-bleed stretched, ${c.marginAnchored} margin-anchored narrowed, ${c.shifted} shifted ${round(-wm.offset)}px`);
      if (c.outside) warn(warnings, `${c.outside} box(es) extend outside the ${refDims.w}px target width (overflow is clipped where a container was measured)`);
    } else if (refDims && refDims.w > vw + 0.5) {
      warn(warnings, `Reference (${refDims.w}px) is wider than the measured viewport (${round(vw)}px); measured width kept`);
    } else if (!refDims) {
      notes.push(`No reference screenshot size available; measured width ${round(vw)}px kept`);
    }
    const measuredWidth = round(vw);
    if (width > LIMITS.hifiMaxPageWidth) {
      warn(warnings, `Width ${width}px exceeds ${LIMITS.hifiMaxPageWidth}px; frame clipped`);
      width = LIMITS.hifiMaxPageWidth;
      truncated = true;
    }
    if (rejoined.repaired) notes.push(`Rejoined ${rejoined.repaired} text fragment(s) that the capture split inside a surrogate pair or grapheme cluster`);
    if (rejoined.removed) warn(warnings, `${rejoined.removed} unpaired UTF-16 surrogate(s) had no adjacent partner in the source runs and were removed`);

    // Height: the measured body box when present, else the lowest measured box.
    const body = elements.find((e) => e.tag === "body");
    const bodyRect = body ? rectOf(body) : null;
    let height = bodyRect ? round(bodyRect.y + bodyRect.h) : 0;
    if (!height) for (const o of [...elements, ...texts, ...images]) {
      const r = rectOf(o);
      if (r) height = Math.max(height, round(r.y + r.h));
    }
    if (height <= 0) throw new CaptureError(`capture.pages[${pi}]: no measured geometry`);

    // G2: overflow containers (clip groups) + evidence-gated scrollbar gutters.
    const facts = htmlFacts(rp.html);
    let containers = overflowContainers(elements, [...texts, ...images], facts);
    const measuredHeight = height;
    const gf = optIn ? gutterFix(containers, height, refDims ? refDims.h : null) : { fix: null, note: null };
    if (gf.note) (gf.fix ? notes : warnings).push(cleanText(gf.fix ? `INFERRED normalization (opt-in centered-dpr1): ${gf.note}` : gf.note, LIMITS.maxNoteChars));
    if (!optIn && refDims && Math.abs(refDims.h - height) >= 1) {
      warn(warnings, `Measured height ${height}px differs from the reference's ${refDims.h}px${containers.length ? ` (${containers.length} horizontally overflowing container(s) may hold hidden scrollbars)` : ""}; measured geometry kept`);
    }
    if (gf.fix) {
      const fix = gf.fix;
      const ids = new Map(containers.map((c) => [c.id, c]));
      const shiftObj = (o: Obj): Obj => {
        const r = rectOf(o);
        if (!r) return o;
        const moved = fix.apply(r);
        const c = ids.get(String(o.id ?? ""));
        return { ...o, ...moved, ...(c && c.tag === o.tag ? { h: fix.containerHeight(c) } : {}) };
      };
      elements = elements.map(shiftObj);
      texts = texts.map(shiftObj);
      images = images.map(shiftObj);
      svgs = svgs.map(shiftObj);
      containers = containers.map((c) => ({ ...c, ...fix.apply(c), h: fix.containerHeight(c) }));
      // gutterFix only applies when delta/N is plausible, so the result is the observed reference height.
      height = refDims!.h;
    }
    const clips = containers.map((c) => ({ x: c.x, y: c.y, w: c.w, h: c.h, name: `Overflow clip / ${c.tag}` }));
    const clipOf = (src: Obj | null, r: { x: number; y: number; w: number; h: number }) => (src ? memberOf(src, r, containers, facts) : innermost(r, containers));
    if (clips.length) notes.push(`${clips.length} measured container(s) clip horizontally overflowing content (static; not scrollable)`);

    if (height > LIMITS.hifiMaxPageHeight) {
      warn(warnings, `Height ${height}px exceeds ${LIMITS.hifiMaxPageHeight}px; content below is truncated`);
      height = LIMITS.hifiMaxPageHeight;
      truncated = true;
    }
    const inPage = (r: { y: number }) => r.y < height;

    // Candidates are collected first, then a priority budget is applied so a
    // capped page drops decorative boxes before images and never text first:
    // 0 measured text, 1 buttons/controls/inferred labels+parts, 2 images/svg, 3 blocks.
    type Cand = { node: HifiNode; prio: number; buttonOf?: BoxNode; asset?: LoadedAsset | null };
    const boxC: Cand[] = [];
    const imgC: Cand[] = [];
    const textC: Cand[] = [];
    const buttonBoxes: BoxNode[] = [];
    let unparsedColors = 0;
    // Clip membership from the source item's observed DOM ancestry (rawHtml), else geometry.
    let src: Obj | null = null;
    const withClip = <T extends HifiNode>(n: T): T => {
      const c = clipOf(src, n);
      return c >= 0 ? { ...n, clip: c } : n;
    };
    const inferredText = (r: { x: number; y: number; w: number; h: number }, text: string, s: Obj, name: string, align?: "right"): HifiNode => {
      const size = px(s.fontSize) || 16;
      return withClip({
        kind: "text",
        ...r,
        name,
        text: protectEdgeSpaces(text),
        graphemes: Math.max(1, graphemeCount(text)),
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
        fit: false,
        ...(align ? { align } : {}),
      });
    };
    let missingOptionLabels = 0;

    for (const e of elements) {
      const r = rectOf(e);
      if (!r || !inPage(r)) continue;
      src = e;
      const s = isObj(e.style) ? e.style : {};
      if (s.display === "none" || s.visibility === "hidden") continue;
      const tag = str(e.tag, 20).toLowerCase();
      const control = isObj(e.control) ? e.control : null;
      const ctype = str(control?.type, 20).toLowerCase();
      // G5: OPTION rows of a multi-select: measured rect, label from rawHtml.
      if (tag === "option") {
        const label = facts?.option.get(str(e.id, 20));
        if (label) textC.push({ prio: 1, node: inferredText({ x: round(r.x + 4), y: r.y, w: Math.max(1, r.w - 4), h: r.h }, label, s, `option label / ${cleanText(label, 40)}`) });
        else missingOptionLabels++;
        continue;
      }
      const role: BoxNode["role"] = tag === "button" || (tag === "input" && ["button", "submit", "reset"].includes(ctype)) ? "button" : control ? "control" : "block";
      const fill = parseColor(s.backgroundColor);
      if (s.backgroundColor && !fill && !/rgba?\([^)]*,\s*0\)|transparent/.test(str(s.backgroundColor))) unparsedColors++;
      const sides = ["Top", "Right", "Bottom", "Left"].map((k) => ({ w: px(s[`border${k}Width`]), c: parseColor(s[`border${k}Color`]) }));
      const uniform = sides.every((x) => x.w === sides[0]!.w && x.c?.hex === sides[0]!.c?.hex && x.c?.alpha === sides[0]!.c?.alpha);
      const anyBorder = sides.some((x) => x.w > 0 && x.c);
      if (fill || anyBorder || role !== "block") {
        const opacityRaw = Number(str(s.opacity, 10) || "1");
        // A plain block whose only paint is non-uniform borders becomes just its edges.
        if (fill !== null || (anyBorder && uniform) || role !== "block") {
          const box: BoxNode = withClip({
            kind: "box",
            ...r,
            name: `${tag}${role === "button" ? " / button" : ""}`,
            role,
            fill,
            border: anyBorder && uniform ? { weight: sides[0]!.w, color: sides[0]!.c! } : null,
            radius: parseRadius(s.borderRadius, r.w, r.h),
            opacity: Number.isFinite(opacityRaw) ? Math.max(0, Math.min(1, opacityRaw)) : 1,
            prov: "measured",
          });
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
            if (side.w > 0 && side.c) boxC.push({ node: withClip({ kind: "box", ...er, name: `${tag} / border-${["top", "right", "bottom", "left"][i]}`, role: "block", fill: side.c, border: null, radius: [0, 0, 0, 0], opacity: 1, prov: "measured" }), prio: 3 });
          });
        }
      }
      if (role !== "control" || !control) continue;
      // G5: static approximations of native control parts (always inferred).
      if (ctype === "radio" && control.checked === true) {
        const d = round(Math.min(r.w, r.h) * 0.4);
        boxC.push({ prio: 1, node: withClip({ kind: "shape", x: round(r.x + (r.w - d) / 2), y: round(r.y + (r.h - d) / 2), w: d, h: d, name: "radio checked center (static approximation)", shape: "ellipse", fill: { hex: "#ffffff", alpha: 1 }, stroke: null, prov: "inferred" }) });
      }
      if (tag === "select" && ctype === "select-one") {
        boxC.push({ prio: 1, node: withClip({ kind: "shape", x: round(r.x + r.w - 20), y: round(r.y + r.h / 2 - 3), w: 10, h: 6, name: "select caret (static approximation)", shape: "caret", fill: parseColor(s.color) ?? { hex: "#000000", alpha: 1 }, stroke: null, prov: "inferred" }) });
      }
      if (tag === "textarea") {
        boxC.push({ prio: 1, node: withClip({ kind: "shape", x: round(r.x + r.w - 12), y: round(r.y + r.h - 12), w: 10, h: 10, name: "textarea resize grip (static approximation)", shape: "grip", fill: null, stroke: { weight: 0.6, color: { hex: "#898ea4", alpha: 1 } }, prov: "inferred" }) });
      }
      // Control label text is not a measured text run: mark it inferred, never width-fitted.
      const isMulti = ctype === "select-multiple" || (facts?.multiple.has(str(e.id, 20)) ?? false);
      const label = isMulti ? "" : cleanText(str(control.selected) || str(control.value) || str(control.placeholder), 200);
      if (label && !["checkbox", "radio", "range", "color", "file"].includes(ctype)) {
        textC.push({
          prio: 1,
          node: inferredText(
            {
              x: round(r.x + px(s.paddingLeft) + px(s.borderLeftWidth)),
              y: round(r.y + px(s.paddingTop) + px(s.borderTopWidth)),
              w: Math.max(1, round(r.w - px(s.paddingLeft) - px(s.paddingRight))),
              h: Math.max(1, round(r.h - px(s.paddingTop) - px(s.paddingBottom))),
            },
            label,
            s,
            `control label (${ctype || tag})`,
          ),
        });
      }
    }
    if (missingOptionLabels) warn(warnings, `${missingOptionLabels} option row(s) have no label in the saved rawHtml; left empty`);

    for (const im of images) {
      const r = rectOf(im);
      if (!r || !inPage(r)) continue;
      src = im;
      const s = isObj(im.style) ? im.style : {};
      const asset = bySource.get(str(im.src, LIMITS.maxUrlChars)) ?? null;
      imgC.push({
        prio: 2,
        asset,
        node: withClip({ kind: "image", ...r, name: `image / ${cleanText(str(im.alt, 80), 80) || "untitled"}`, assetId: null, fit: str(s.objectFit) === "contain" ? "fit" : "fill", radius: parseRadius(s.borderRadius, r.w, r.h), prov: "measured" }),
      });
    }

    // G6: sanitized inline SVG primitives (whole SVG rejected on any unsupported construct).
    const svgRejects = new Map<string, number>();
    for (const sv of svgs) {
      const r = rectOf(sv);
      if (!r || !inPage(r)) continue;
      src = null;
      const res = sanitizeSvg(str(sv.html, 40_000), r.w, r.h, parseColor(sv.color)?.hex ?? null);
      if (res.ok) imgC.push({ prio: 2, node: withClip({ kind: "svg", ...r, name: "svg / sanitized vector", markup: res.markup, prov: "measured" }) });
      else svgRejects.set(res.reason, (svgRejects.get(res.reason) ?? 0) + 1);
    }
    for (const [reason, n] of svgRejects) warn(warnings, `${n} inline SVG(s) omitted: ${reason}`);

    let shortened = 0;
    for (const t of texts) {
      const r = rectOf(t);
      if (!r || !inPage(r)) continue;
      src = t;
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
        node: withClip({
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
        }),
      });
    }

    // G3: list markers, only for <li> with measured display:list-item whose list
    // type/ordinal comes from the saved rawHtml (marker glyph/offset inferred).
    const listItems = elements.filter((e) => str(e.tag) === "li");
    if (listItems.length && !facts) warn(warnings, `${listItems.length} list item(s): no rawHtml in the capture, so list markers were not reconstructed`);
    let markers = 0;
    let unanchored = 0;
    for (const e of facts ? listItems : []) {
      const r = rectOf(e);
      const s = isObj(e.style) ? e.style : {};
      src = e;
      const fact = facts!.li.get(str(e.id, 20));
      if (!r || !inPage(r) || !fact || fact.inNav || s.display !== "list-item") continue;
      const first = texts.find((t) => t.parent === e.id);
      const fr = first ? rectOf(first) : null;
      if (!first || !fr) {
        unanchored++;
        continue;
      }
      const fs = isObj(first.style) ? first.style : s;
      const size = px(fs.fontSize) || 16;
      const w = round(size * 2.5);
      textC.push({ prio: 1, node: inferredText({ x: round(r.x - size * 0.4 - w), y: fr.y, w, h: fr.h }, fact.marker, { ...fs, fontWeight: "400" }, `list marker ${fact.marker}`, "right") });
      markers++;
    }
    if (markers) notes.push(`${markers} list marker(s) reconstructed from rawHtml list structure (glyph and offset inferred; list-style is not captured)`);
    if (unanchored) warn(warnings, `${unanchored} list item(s) had no text run to anchor a marker; no marker drawn`);

    const allC = [...boxC, ...imgC, ...textC];
    const budget = Math.max(0, Math.min(LIMITS.hifiMaxNodesPerPage, LIMITS.hifiMaxNodesTotal - totalNodes));
    const keep = new Set(allC.length <= budget ? allC : allC.map((c, i) => ({ c, i })).sort((a, b) => a.c.prio - b.c.prio || a.i - b.i).slice(0, budget).map((x) => x.c));
    // Emit in visual stacking order (boxes/parts, images/svg, text on top).
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
    if (unparsedColors) warn(warnings, `${unparsedColors} color value(s) were not rgb()/rgba() and were not applied`);
    if (dropped) {
      truncated = true;
      warn(warnings, `${dropped} node(s) omitted by the node cap (${droppedTexts} of them text runs); lowest-priority boxes dropped first`);
    }
    totalNodes += nodes.length;

    let referenceAssetId: string | null = null;
    let referenceTiles: HifiPage["referenceTiles"];
    if (refTiled) {
      referenceTiles = { sourceSha256: refTiled.sourceSha256, sourceWidth: refTiled.width, sourceHeight: refTiled.height, tiles: refTiled.tiles.map((t) => ({ assetId: assetIdFor(t.asset), y: t.y, h: t.h })) };
      notes.push(`Reference ${refTiled.width}x${refTiled.height}px tiled offline into ${refTiled.tiles.length} PNG tile(s) of <=${LIMITS.refTileHeight}px (source sha256 ${refTiled.sourceSha256.slice(0, 16)}...)`);
    } else if (refAsset && refAsset.kind === "reference") referenceAssetId = assetIdFor(refAsset);
    else if (refId && !refRejected) warn(warnings, `Reference screenshot "${refId}" not available (missing or rejected asset; see document warnings)`);
    else if (!refId && !refRejected) warn(warnings, "No reference screenshot supplied for this page");

    regionsByPage.push({
      nav: elements.map(rectWithTag).find((e) => e?.tag === "nav")?.r ?? null,
      footer: elements.map(rectWithTag).find((e) => e?.tag === "footer")?.r ?? null,
    });
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
      notes: notes.slice(0, LIMITS.hifiMaxWarnings).map((n) => cleanText(n, LIMITS.maxNoteChars)),
      ...(clips.length ? { clips } : {}),
      ...(referenceTiles ? { referenceTiles } : {}),
      ...(wm || gf.fix
        ? { normalization: { mode: "centered-dpr1" as const, measuredWidth, measuredHeight, offsetX: wm ? round(-wm.offset) : 0, gutterPx: gf.fix ? gf.fix.k : 0, gutters: gf.fix ? containers.length : 0 } }
        : {}),
    });
  }
  if (pages.length === 0 || !first) throw new CaptureError("capture: no usable HTML pages");

  // G9: sitemap parents (URL path hierarchy) and shared nav/footer components.
  const parents = parentByPath(pages.map((p) => p.path));
  pages.forEach((p, i) => (p.parentId = parents[i] ?? null));
  const components = extractComponents(pages, regionsByPage);

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
        "Width mapping and scrollbar-gutter removal are INFERRED, only with --normalize-reference centered-dpr1; such pages keep a normalization record (measured size, x offset, gutters).",
        "Fonts are mapped to fonts available in Figma at import; substitutions are reported.",
        "Control labels, option labels, list markers and control parts are inferred and marked inferred.",
      ],
    },
    assets: used,
    pages,
    warnings: docWarnings,
    ...(components.length ? { components } : {}),
    ...(input.fontMap && input.fontMap.length ? { fontMap: input.fontMap } : {}),
  };
  if (!input.nested) {
    const componentNodes = components.reduce((n, c) => n + c.nodes.length, 0);
    attachStates({
      rawPages,
      pages,
      assets: input.assets,
      assetIdFor: (a) => (used.some((u) => u.sha256 === a.sha256 && u.kind === a.kind) || used.length < LIMITS.hifiMaxAssets ? assetIdFor(a) : null),
      convertOne: (page) => convertCapture({ capture: { schema: "website-to-figma/capture", schemaVersion: 1, label, pages: [page] }, assets: input.assets.filter((a) => a.kind === "image"), assetWarnings: [], fontMap: input.fontMap, nested: true }),
      reactions: input.stateReactions ?? "none",
      nodeBudget: Math.max(0, LIMITS.hifiMaxNodesTotal - totalNodes - componentNodes),
      warn: (w) => warn(docWarnings, w),
    });
  }
  const v = validateHifiDoc(doc);
  if (!v.ok) throw new CaptureError(`Internal error: converted document failed validation:\n${v.errors.join("\n")}`);
  return v.doc;
}

function rectWithTag(e: Obj): { tag: string; r: { x: number; y: number; w: number; h: number } } | null {
  const r = rectOf(e);
  return r ? { tag: str(e.tag, 20).toLowerCase(), r } : null;
}

type Region = { x: number; y: number; w: number; h: number } | null;

// Group identical nav/footer regions across pages (structure + text + geometry
// relative to the region; paints may differ and become instance overrides).
function extractComponents(pages: HifiPage[], regions: { nav: Region; footer: Region }[]): HifiComponent[] {
  const components: HifiComponent[] = [];
  for (const kind of ["nav", "footer"] as const) {
    const groups = new Map<string, { page: number; region: NonNullable<Region>; idx: number[] }[]>();
    pages.forEach((p, pi) => {
      const region = regions[pi]?.[kind];
      if (!region) return;
      const idx: number[] = [];
      p.nodes.forEach((n, i) => {
        if (n.clip !== undefined && n.clip >= 0) return;
        if (n.x >= region.x - 0.5 && n.y >= region.y - 0.5 && n.x + n.w <= region.x + region.w + 0.5 && n.y + n.h <= region.y + region.h + 0.5) idx.push(i);
      });
      if (!idx.length) return;
      const sig = JSON.stringify([round(region.w), round(region.h), ...idx.map((i) => signatureOf(p.nodes[i]!, region))]);
      const list = groups.get(sig) ?? [];
      list.push({ page: pi, region, idx });
      groups.set(sig, list);
    });
    for (const members of groups.values()) {
      if (members.length < 2 || components.length >= 20) continue;
      const id = `c${components.length}`;
      const base = members[0]!;
      const baseNodes = base.idx.map((i) => pages[base.page]!.nodes[i]!);
      const local = baseNodes.map((n) => relativize(n, base.region));
      // remap button references inside the component
      local.forEach((n, j) => {
        if (n.kind === "text" && n.button >= 0) n.button = base.idx.indexOf(n.button);
      });
      components.push({ id, kind, name: `Shared ${kind} (${members.length} pages)`, w: round(base.region.w), h: round(base.region.h), nodes: local });
      for (const mbr of members) {
        const page = pages[mbr.page]!;
        const overrides: Instance["overrides"] = [];
        mbr.idx.forEach((i, j) => {
          const n = page.nodes[i]!;
          const b = baseNodes[j]!;
          if (n.kind === "box" && b.kind === "box") {
            if (JSON.stringify(n.fill) !== JSON.stringify(b.fill)) overrides.push({ index: j, fill: n.fill });
            if (JSON.stringify(n.border) !== JSON.stringify(b.border) && n.border) overrides.push({ index: j, color: n.border.color });
          }
          if (n.kind === "text" && b.kind === "text" && JSON.stringify(n.color) !== JSON.stringify(b.color)) overrides.push({ index: j, color: n.color });
        });
        const removed = new Set(mbr.idx);
        const remap = new Map<number, number>();
        const kept: HifiNode[] = [];
        page.nodes.forEach((n, i) => {
          if (removed.has(i)) return;
          remap.set(i, kept.length);
          kept.push(n);
        });
        for (const n of kept) if (n.kind === "text" && n.button >= 0) n.button = remap.get(n.button) ?? -1;
        page.nodes = kept;
        page.instances = [...(page.instances ?? []), { component: id, x: round(mbr.region.x), y: round(mbr.region.y), overrides }];
      }
    }
  }
  return components;
}

function signatureOf(n: HifiNode, region: { x: number; y: number }): unknown {
  const g = [Math.round((n.x - region.x) * 2) / 2, Math.round((n.y - region.y) * 2) / 2, Math.round(n.w * 2) / 2, Math.round(n.h * 2) / 2];
  if (n.kind === "text") return ["t", ...g, n.text, n.size, n.weight, n.italic];
  if (n.kind === "box") return ["b", ...g, n.role, n.radius, n.border ? n.border.weight : 0];
  if (n.kind === "image") return ["i", ...g, n.assetId];
  if (n.kind === "svg") return ["s", ...g, n.markup.length];
  return ["p", ...g, n.shape];
}

function relativize(n: HifiNode, region: { x: number; y: number }): HifiNode {
  const copy = JSON.parse(JSON.stringify(n)) as HifiNode;
  copy.x = round(n.x - region.x);
  copy.y = round(n.y - region.y);
  delete copy.clip;
  return copy;
}
