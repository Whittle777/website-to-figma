// Native renderer for schemaVersion 2 (measured hi-fi) documents. Uses only
// real Plugin API calls (figma.createFrame/createRectangle/createText/
// createImage/loadFontAsync). No network: image bytes come from the validated
// document, are decoded with figma.base64Decode and re-verified (length,
// SHA-256, PNG/JPEG/GIF header, <= 4096 px) before ANY node is created.
// Layout is the measured absolute desktop snapshot; it is not responsive.
import type { BoxNode, HifiDoc, HifiPage, ImageNode, Paint, TextNode as HifiText } from "../../src/shared/hifiSchema";
import { resolveFont, type ResolvedFont } from "../../src/shared/fonts";
import { inspectImage, sha256Hex } from "../../src/shared/imageInfo";

export interface HifiStats {
  pages: number;
  nodes: number;
  images: number;
  placeholders: number;
  fontFallbacks: number;
  fitted: number;
  unfitted: number;
  warnings: string[];
}

type Track = <T extends SceneNode>(n: T) => T;

const LABEL_FONT: FontName = { family: "Inter", style: "Regular" };
const LABEL_BOLD: FontName = { family: "Inter", style: "Bold" };
const MAX_LETTER_SPACING_RATIO = 0.25;

function solid(p: Paint): SolidPaint {
  const n = parseInt(p.hex.slice(1), 16);
  return { type: "SOLID", color: { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 }, opacity: p.alpha };
}

function radii(n: RectangleNode | FrameNode, r: [number, number, number, number]) {
  n.topLeftRadius = r[0];
  n.topRightRadius = r[1];
  n.bottomRightRadius = r[2];
  n.bottomLeftRadius = r[3];
}

// Verify every embedded asset before the canvas is touched.
export function verifyAssets(doc: HifiDoc): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  for (const a of doc.assets) {
    const bytes = figma.base64Decode(a.dataBase64);
    if (bytes.length !== a.bytes) throw new Error(`Asset ${a.id}: decoded length ${bytes.length} != ${a.bytes}`);
    if (sha256Hex(bytes) !== a.sha256) throw new Error(`Asset ${a.id}: SHA-256 mismatch`);
    const info = inspectImage(bytes);
    if (!info || info.mime !== a.mime || info.width !== a.width || info.height !== a.height) throw new Error(`Asset ${a.id}: image header does not match its declared type/size`);
    out.set(a.id, bytes);
  }
  return out;
}

// Resolve and LOAD every font before any text node is created or mutated.
// A font that is listed but fails to load is removed and its text re-resolved
// to the next available candidate (reported as a fallback).
export async function resolveFonts(doc: HifiDoc): Promise<{ byNode: Map<HifiText, ResolvedFont>; failedLoads: string[] }> {
  const available = new Set((await figma.listAvailableFontsAsync()).map((f) => `${f.fontName.family}|${f.fontName.style}`));
  for (const f of [LABEL_FONT, LABEL_BOLD]) {
    try {
      await figma.loadFontAsync(f);
    } catch {
      throw new Error("Could not load Inter Regular/Bold for labels. Nothing was created.");
    }
  }
  const loaded = new Set(["Inter|Regular", "Inter|Bold"]);
  const failedLoads: string[] = [];
  const byNode = new Map<HifiText, ResolvedFont>();
  for (let round = 0; round < 6; round++) {
    const needed = new Map<string, FontName>();
    for (const page of doc.pages) {
      for (const n of page.nodes) {
        if (n.kind !== "text") continue;
        const r = resolveFont(n.fontStack, n.generic, n.weight, n.italic, available);
        if (!r) throw new Error(`No loadable font for "${n.fontStack.join(", ")}" (not even Inter). Nothing was created.`);
        byNode.set(n, r); // r.fallback is set whenever the first measured family is unavailable or failed to load
        const key = `${r.family}|${r.style}`;
        if (!loaded.has(key)) needed.set(key, { family: r.family, style: r.style });
      }
    }
    if (needed.size === 0) return { byNode, failedLoads };
    for (const [key, font] of needed) {
      try {
        await figma.loadFontAsync(font);
        loaded.add(key);
      } catch {
        available.delete(key);
        if (failedLoads.length < 10) failedLoads.push(`${font.family} ${font.style} failed to load`);
      }
    }
  }
  throw new Error("Font resolution did not settle. Nothing was created.");
}

function label(track: Track, parent: FrameNode | SectionNode, chars: string, size: number, bold: boolean, x: number, y: number, width?: number): TextNode {
  const t = track(figma.createText());
  parent.appendChild(t);
  t.fontName = bold ? LABEL_BOLD : LABEL_FONT;
  t.characters = chars;
  t.fontSize = size;
  t.x = x;
  t.y = y;
  if (width) {
    t.resize(width, t.height);
    t.textAutoResize = "HEIGHT";
  }
  return t;
}

function buildBox(track: Track, parent: FrameNode, b: BoxNode, buttonLabel: string | null): RectangleNode | FrameNode {
  const n = b.role === "button" ? track(figma.createFrame()) : track(figma.createRectangle());
  parent.appendChild(n);
  n.name = b.role === "button" ? `Button / ${buttonLabel ?? "untitled"}` : b.name;
  n.x = b.x;
  n.y = b.y;
  n.resize(Math.max(0.01, b.w), Math.max(0.01, b.h));
  n.fills = b.fill ? [solid(b.fill)] : [];
  if (b.border) {
    n.strokes = [solid(b.border.color)];
    n.strokeWeight = b.border.weight;
    n.strokeAlign = "INSIDE";
  } else n.strokes = [];
  radii(n, b.radius);
  n.opacity = b.opacity;
  if (n.type === "FRAME") n.clipsContent = false;
  n.setPluginData("w2f", JSON.stringify({ prov: b.prov, role: b.role }));
  return n;
}

function buildImage(track: Track, parent: FrameNode, im: ImageNode, hashes: Map<string, string>): boolean {
  const r = track(figma.createRectangle());
  parent.appendChild(r);
  r.x = im.x;
  r.y = im.y;
  r.resize(Math.max(0.01, im.w), Math.max(0.01, im.h));
  radii(r, im.radius);
  const hash = im.assetId ? hashes.get(im.assetId) : undefined;
  if (hash) {
    r.name = im.name;
    r.fills = [{ type: "IMAGE", imageHash: hash, scaleMode: im.fit === "fit" ? "FIT" : "FILL" }];
    r.setPluginData("w2f", JSON.stringify({ prov: im.prov, assetId: im.assetId }));
    return true;
  }
  r.name = `MISSING IMAGE / ${im.name}`;
  r.fills = [{ type: "SOLID", color: { r: 0.93, g: 0.93, b: 0.93 } }];
  r.strokes = [{ type: "SOLID", color: { r: 0.8, g: 0.2, b: 0.2 } }];
  r.strokeWeight = 1;
  r.dashPattern = [6, 4];
  r.setPluginData("w2f", JSON.stringify({ prov: im.prov, missing: true }));
  return false;
}

function buildText(track: Track, parent: FrameNode, t: HifiText, font: ResolvedFont, offset: { x: number; y: number }): boolean {
  // Fonts were all loaded in resolveFonts before this is ever called.
  const n = track(figma.createText());
  parent.appendChild(n);
  n.name = t.name;
  n.fontName = { family: font.family, style: font.style };
  n.characters = t.text;
  n.fontSize = t.size;
  n.lineHeight = { unit: "PIXELS", value: t.lineHeight };
  n.fills = [solid(t.color)];
  n.textDecoration = t.decoration === "underline" ? "UNDERLINE" : t.decoration === "strike" ? "STRIKETHROUGH" : "NONE";
  n.textAutoResize = "WIDTH_AND_HEIGHT";
  n.x = t.x - offset.x;
  n.y = t.y - offset.y;
  // Fit the measured run width with letter spacing, within a sane bound.
  let fitted = false;
  if (t.graphemes > 1 && t.w > 0) {
    const ls = (t.w - n.width) / (t.graphemes - 1);
    if (Math.abs(ls) <= t.size * MAX_LETTER_SPACING_RATIO) {
      n.letterSpacing = { unit: "PIXELS", value: ls };
      fitted = true;
    }
  }
  n.setPluginData("w2f", JSON.stringify({ prov: t.prov, fitted, font: `${font.family} ${font.style}`, fallback: font.fallback, measuredStack: t.fontStack }));
  return fitted;
}

function buildPage(track: Track, section: SectionNode, page: HifiPage, y: number, fonts: Map<HifiText, ResolvedFont>, hashes: Map<string, string>, doc: HifiDoc, failedLoads: string[], stats: HifiStats): number {
  const x0 = 80;
  const ref = page.referenceAssetId ? doc.assets.find((a) => a.id === page.referenceAssetId) : undefined;
  // Per-page font substitutions (measured stack -> actual Figma font).
  const subs = new Map<string, number>();
  for (const n of page.nodes) {
    if (n.kind !== "text") continue;
    const f = fonts.get(n)!;
    if (f.fallback) {
      const k = `"${n.fontStack.join(", ") || "(none)"}" ${n.weight >= 600 ? "bold" : "regular"}${n.italic ? " italic" : ""} -> ${f.family} ${f.style}`;
      subs.set(k, (subs.get(k) ?? 0) + 1);
    }
  }
  const fallbackLines = [...subs].slice(0, 8).map(([k, count]) => `Font fallback (${count} run${count === 1 ? "" : "s"}): ${k}`);
  if (subs.size > 8) fallbackLines.push(`Font fallback: ${subs.size - 8} more substitution(s) not listed`);
  const notes = [
    `${page.title} — ${page.url}`,
    `Measured absolute desktop snapshot (${page.width}×${page.height}px). Editable, not responsive, not pixel-perfect.`,
    ...(page.truncated ? ["TRUNCATED: see warnings below."] : []),
    ...page.warnings.map((w) => `Warning: ${w}`),
    ...fallbackLines,
    ...failedLoads.map((f) => `Font load failure: ${f}`),
    ...(page.branding ? [`Branding (page-level, not per-element): ${Object.entries(page.branding.colors).map(([k, v]) => `${k} ${v}`).join(", ")}${page.branding.fonts.length ? `; fonts ${page.branding.fonts.join(", ")}` : ""}`] : []),
  ];
  const head = label(track, section, notes.join("\n"), 14, false, x0, y, Math.max(600, page.width));
  head.name = `Notes / ${page.path}`;
  const top = y + head.height + 24;

  const frame = track(figma.createFrame());
  section.appendChild(frame);
  frame.name = `Page / ${page.path} (editable, measured)`;
  frame.x = x0;
  frame.y = top;
  frame.resize(page.width, page.height);
  frame.fills = [];
  frame.clipsContent = true;
  frame.setPluginData("w2f", JSON.stringify({ url: page.url, truncated: page.truncated }));

  const buttonFrames = new Map<number, FrameNode>();
  page.nodes.forEach((n, i) => {
    if (n.kind === "box") {
      const labelText = n.role === "button" ? page.nodes.find((t): t is HifiText => t.kind === "text" && t.button === i)?.text.trim() ?? null : null;
      const built = buildBox(track, frame, n, labelText);
      if (built.type === "FRAME") buttonFrames.set(i, built);
    } else if (n.kind === "image") {
      if (buildImage(track, frame, n, hashes)) stats.images++;
      else stats.placeholders++;
    }
  });
  let unfitted = 0;
  for (const n of page.nodes) {
    if (n.kind !== "text") continue;
    const font = fonts.get(n)!;
    const button = n.button >= 0 ? buttonFrames.get(n.button) : undefined;
    const box = n.button >= 0 ? (page.nodes[n.button] as BoxNode) : null;
    if (buildText(track, button ?? frame, n, font, button && box ? { x: box.x, y: box.y } : { x: 0, y: 0 })) stats.fitted++;
    else if (n.graphemes > 1) unfitted++;
    if (font.fallback) stats.fontFallbacks++;
  }
  if (unfitted) {
    head.characters = head.characters + `\nWidth fit skipped for ${unfitted} text run(s) (difference too large); natural width kept.`;
    stats.unfitted += unfitted;
  }
  stats.nodes += page.nodes.length;

  let bottom = top + page.height;
  if (ref) {
    const refW = page.width;
    const refH = Math.round((refW * ref.height) / ref.width);
    const rx = x0 + page.width + 80;
    label(track, section, "Reference screenshot (image, not editable)", 14, true, rx, top - 24);
    const r = track(figma.createRectangle());
    section.appendChild(r);
    r.name = `Reference / ${page.path}`;
    r.x = rx;
    r.y = top;
    r.resize(refW, Math.max(1, refH));
    r.fills = [{ type: "IMAGE", imageHash: hashes.get(ref.id)!, scaleMode: "FIT" }];
    r.setPluginData("w2f", JSON.stringify({ reference: true, sha256: ref.sha256 }));
    bottom = Math.max(bottom, top + refH);
  }
  return bottom;
}

export async function buildHifiDoc(doc: HifiDoc, track: Track, created: SceneNode[], originX: number): Promise<HifiStats> {
  // 1) Verify all bytes and resolve/load all fonts before touching the canvas.
  const bytes = verifyAssets(doc);
  const { byNode, failedLoads } = await resolveFonts(doc);
  const hashes = new Map<string, string>();
  for (const [id, b] of bytes) hashes.set(id, figma.createImage(b).hash);

  const stats: HifiStats = { pages: 0, nodes: 0, images: 0, placeholders: 0, fontFallbacks: 0, fitted: 0, unfitted: 0, warnings: [...doc.warnings] };
  const section = track(figma.createSection());
  created.push(section);
  section.name = `website-to-figma · Hi-fi (measured) · ${doc.site.host}`;
  section.x = originX;
  section.y = 0;
  const intro = [
    `Source: ${doc.source.label} (${doc.source.mode}). ${doc.provenance.notes.join(" ")}`,
    ...doc.warnings.map((w) => `Warning: ${w}`),
    "Not affiliated with Figma or the site owner. Not pixel-perfect.",
  ];
  const title = label(track, section, `Hi-fi import · ${doc.site.host}`, 28, true, 80, 40);
  const info = label(track, section, intro.join("\n"), 14, false, 80, 40 + title.height + 8, 1200);
  let y = info.y + info.height + 60;
  let maxRight = 1300;
  for (const page of doc.pages) {
    y = buildPage(track, section, page, y, byNode, hashes, doc, failedLoads, stats) + 120;
    maxRight = Math.max(maxRight, 80 + page.width * 2 + 240);
    stats.pages++;
  }
  section.resizeWithoutConstraints(maxRight, y);
  if (stats.fontFallbacks) stats.warnings.push(`Font fallback used for ${stats.fontFallbacks} text run(s); see each page's notes`);
  for (const f of failedLoads) stats.warnings.push(`Font load failure: ${f}`);
  if (stats.unfitted) stats.warnings.push(`Width fit skipped for ${stats.unfitted} text run(s)`);
  for (const p of doc.pages) if (p.truncated) stats.warnings.push(`Page ${p.path} is truncated; see its notes`);
  if (stats.placeholders) stats.warnings.push(`${stats.placeholders} image(s) shown as MISSING IMAGE placeholders`);
  return stats;
}
