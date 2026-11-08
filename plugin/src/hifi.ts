// Native renderer for schemaVersion 2 (measured hi-fi) documents. Uses only
// real Plugin API calls (figma.createFrame/createRectangle/createText/
// createImage/loadFontAsync). No network: image bytes come from the validated
// document, are decoded with figma.base64Decode and re-verified (length,
// SHA-256, PNG/JPEG/GIF header, <= 4096 px) before ANY node is created.
// Layout is the measured absolute desktop snapshot; it is not responsive.
import type { BoxNode, ClipGroup, HifiDoc, HifiNode, HifiPage, ImageNode, Paint, ShapeNode, SvgNode, TextNode as HifiText } from "../../src/shared/hifiSchema";
import { isCanonicalSvg } from "../../src/shared/svgSanitize";
import { mappedFamily, resolveFont, type ResolvedFont } from "../../src/shared/fonts";
import { inspectImage, sha256Hex } from "../../src/shared/imageInfo";

export interface HifiStats {
  pages: number;
  nodes: number;
  images: number;
  placeholders: number;
  fontFallbacks: number;
  fitted: number;
  unfitted: number;
  shapes: number;
  svgs: number;
  components: number;
  instances: number;
  edges: number;
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
    for (const list of [...doc.pages.map((p) => p.nodes), ...(doc.components ?? []).map((c) => c.nodes)]) {
      for (const n of list) {
        if (n.kind !== "text") continue;
        const r = resolveFont(n.fontStack, n.generic, n.weight, n.italic, available, mappedFamily(n.fontStack, n.generic, doc.fontMap));
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

type Parent = FrameNode | ComponentNode;

function buildBox(track: Track, parent: Parent, b: BoxNode, buttonLabel: string | null, off: { x: number; y: number }, prefix: string): RectangleNode | FrameNode {
  const n = b.role === "button" ? track(figma.createFrame()) : track(figma.createRectangle());
  parent.appendChild(n);
  n.name = `${prefix}${b.role === "button" ? `Button / ${buttonLabel ?? "untitled"}` : b.name}`;
  n.x = b.x - off.x;
  n.y = b.y - off.y;
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

function buildImage(track: Track, parent: Parent, im: ImageNode, hashes: Map<string, string>, off: { x: number; y: number }, prefix: string): boolean {
  const r = track(figma.createRectangle());
  parent.appendChild(r);
  r.x = im.x - off.x;
  r.y = im.y - off.y;
  r.resize(Math.max(0.01, im.w), Math.max(0.01, im.h));
  radii(r, im.radius);
  const hash = im.assetId ? hashes.get(im.assetId) : undefined;
  if (hash) {
    r.name = `${prefix}${im.name}`;
    r.fills = [{ type: "IMAGE", imageHash: hash, scaleMode: im.fit === "fit" ? "FIT" : "FILL" }];
    r.setPluginData("w2f", JSON.stringify({ prov: im.prov, assetId: im.assetId }));
    return true;
  }
  r.name = `${prefix}MISSING IMAGE / ${im.name}`;
  r.fills = [{ type: "SOLID", color: { r: 0.93, g: 0.93, b: 0.93 } }];
  r.strokes = [{ type: "SOLID", color: { r: 0.8, g: 0.2, b: 0.2 } }];
  r.strokeWeight = 1;
  r.dashPattern = [6, 4];
  r.setPluginData("w2f", JSON.stringify({ prov: im.prov, missing: true }));
  return false;
}

// Static approximations of native control parts (prov "inferred").
async function buildShape(track: Track, parent: Parent, sh: ShapeNode, off: { x: number; y: number }, prefix: string) {
  const name = `${prefix}${sh.name}`;
  if (sh.shape === "ellipse") {
    const e = track(figma.createEllipse());
    parent.appendChild(e);
    e.name = name;
    e.x = sh.x - off.x;
    e.y = sh.y - off.y;
    e.resize(Math.max(0.01, sh.w), Math.max(0.01, sh.h));
    e.fills = sh.fill ? [solid(sh.fill)] : [];
    e.strokes = sh.stroke ? [solid(sh.stroke.color)] : [];
    if (sh.stroke) e.strokeWeight = sh.stroke.weight;
    e.setPluginData("w2f", JSON.stringify({ prov: sh.prov, approximation: true }));
    return;
  }
  const v = track(figma.createVector());
  parent.appendChild(v);
  v.name = name;
  const { w, h } = sh;
  if (sh.shape === "caret") {
    await v.setVectorNetworkAsync({
      vertices: [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w / 2, y: h }],
      segments: [{ start: 0, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 0 }],
      regions: [{ windingRule: "NONZERO", loops: [[0, 1, 2]] }],
    });
    v.fills = sh.fill ? [solid(sh.fill)] : [];
    v.strokes = [];
  } else {
    await v.setVectorNetworkAsync({
      vertices: [{ x: w * 0.2, y: h }, { x: w, y: h * 0.2 }, { x: w * 0.5, y: h }, { x: w, y: h * 0.5 }, { x: w * 0.8, y: h }, { x: w, y: h * 0.8 }],
      segments: [{ start: 0, end: 1 }, { start: 2, end: 3 }, { start: 4, end: 5 }],
      regions: [],
    });
    v.fills = [];
    v.strokes = sh.stroke ? [solid(sh.stroke.color)] : [];
    if (sh.stroke) v.strokeWeight = sh.stroke.weight;
  }
  v.x = sh.x - off.x;
  v.y = sh.y - off.y;
  v.setPluginData("w2f", JSON.stringify({ prov: sh.prov, approximation: true }));
}

// Sanitized vector markup only: the validator already required canonical
// output of the allowlist sanitizer; re-checked here before import.
function buildSvg(track: Track, parent: Parent, sv: SvgNode, off: { x: number; y: number }, prefix: string): boolean {
  if (!isCanonicalSvg(sv.markup)) return false;
  const f = track(figma.createNodeFromSvg(sv.markup));
  parent.appendChild(f);
  f.name = `${prefix}${sv.name}`;
  f.x = sv.x - off.x;
  f.y = sv.y - off.y;
  f.setPluginData("w2f", JSON.stringify({ prov: sv.prov, sanitized: true }));
  return true;
}

function buildText(track: Track, parent: Parent, t: HifiText, font: ResolvedFont, offset: { x: number; y: number }, prefix: string): "fitted" | "unfitted" | "not-fitted" {
  // Fonts were all loaded in resolveFonts before this is ever called.
  const n = track(figma.createText());
  parent.appendChild(n);
  n.name = `${prefix}${t.name}`;
  n.fontName = { family: font.family, style: font.style };
  n.characters = t.text;
  n.fontSize = t.size;
  n.lineHeight = { unit: "PIXELS", value: t.lineHeight };
  n.fills = [solid(t.color)];
  n.textDecoration = t.decoration === "underline" ? "UNDERLINE" : t.decoration === "strike" ? "STRIKETHROUGH" : "NONE";
  n.x = t.x - offset.x;
  n.y = t.y - offset.y;
  if (t.align === "right") {
    n.textAutoResize = "HEIGHT";
    n.resize(Math.max(1, t.w), n.height);
    n.textAlignHorizontal = "RIGHT";
  } else n.textAutoResize = "WIDTH_AND_HEIGHT";
  // Width fitting applies only to measured runs (inferred text has no measured run width).
  let result: "fitted" | "unfitted" | "not-fitted" = "not-fitted";
  if (t.prov === "measured" && t.fit !== false && t.align !== "right" && t.graphemes > 1 && t.w > 0) {
    const ls = (t.w - n.width) / (t.graphemes - 1);
    if (Math.abs(ls) <= t.size * MAX_LETTER_SPACING_RATIO) {
      n.letterSpacing = { unit: "PIXELS", value: ls };
      result = "fitted";
    } else result = "unfitted";
  }
  n.setPluginData("w2f", JSON.stringify({ prov: t.prov, fit: result, font: `${font.family} ${font.style}`, fallback: font.fallback, reason: font.reason, measuredStack: t.fontStack }));
  return result;
}

// Renders a flat node list into a page frame or component. Clipped nodes go
// into per-container clip frames; button labels into their button frame.
// `prefix(i)` names nodes so instance overrides can find them later.
async function renderNodes(track: Track, parent: Parent, nodes: HifiNode[], clipGroups: ClipGroup[], fonts: Map<HifiText, ResolvedFont>, hashes: Map<string, string>, stats: HifiStats, prefix: (i: number) => string): Promise<number> {
  const zero = { x: 0, y: 0 };
  const clipFrames: FrameNode[] = [];
  const buttonFrames = new Map<number, FrameNode>();
  let unfitted = 0;
  const clipOf = (n: HifiNode) => (n.clip !== undefined && n.clip >= 0 ? n.clip : -1);
  const place = async (n: HifiNode, i: number, target: Parent, off: { x: number; y: number }) => {
    if (n.kind === "box") {
      const labelText = n.role === "button" ? nodes.find((t): t is HifiText => t.kind === "text" && t.button === i)?.text.trim() ?? null : null;
      const built = buildBox(track, target, n, labelText, off, prefix(i));
      if (built.type === "FRAME") buttonFrames.set(i, built);
    } else if (n.kind === "image") {
      if (buildImage(track, target, n, hashes, off, prefix(i))) stats.images++;
      else stats.placeholders++;
    } else if (n.kind === "shape") {
      await buildShape(track, target, n, off, prefix(i));
      stats.shapes++;
    } else if (n.kind === "svg") {
      if (buildSvg(track, target, n, off, prefix(i))) stats.svgs++;
    }
  };
  // 1) unclipped non-text, 2) clip frames, 3) clipped non-text, 4) text on top
  for (const [i, n] of nodes.entries()) if (n.kind !== "text" && clipOf(n) < 0) await place(n, i, parent, zero);
  for (const c of clipGroups) {
    const f = track(figma.createFrame());
    parent.appendChild(f);
    f.name = c.name;
    f.x = c.x;
    f.y = c.y;
    f.resize(Math.max(0.01, c.w), Math.max(0.01, c.h));
    f.fills = [];
    f.clipsContent = true;
    clipFrames.push(f);
  }
  for (const [i, n] of nodes.entries()) {
    const ci = clipOf(n);
    if (n.kind !== "text" && ci >= 0) await place(n, i, clipFrames[ci]!, clipGroups[ci]!);
  }
  for (const [i, n] of nodes.entries()) {
    if (n.kind !== "text") continue;
    const font = fonts.get(n)!;
    const button = n.button >= 0 ? buttonFrames.get(n.button) : undefined;
    const ci = clipOf(n);
    const box = n.button >= 0 ? (nodes[n.button] as BoxNode) : null;
    const target: Parent = button ?? (ci >= 0 ? clipFrames[ci]! : parent);
    const off = button && box ? { x: box.x, y: box.y } : ci >= 0 ? clipGroups[ci]! : zero;
    const r = buildText(track, target, n, font, off, prefix(i));
    if (r === "fitted") stats.fitted++;
    if (r === "unfitted") unfitted++;
    if (font.fallback) stats.fontFallbacks++;
  }
  stats.nodes += nodes.length;
  return unfitted;
}

function fontLines(nodes: HifiNode[], fonts: Map<HifiText, ResolvedFont>): string[] {
  const subs = new Map<string, number>();
  for (const n of nodes) {
    if (n.kind !== "text") continue;
    const f = fonts.get(n)!;
    if (f.fallback) {
      const k = `"${n.fontStack.join(", ") || "(none)"}" ${n.weight >= 600 ? "bold" : "regular"}${n.italic ? " italic" : ""} -> ${f.family} ${f.style}${f.reason.startsWith("operator font map") ? " (operator font map)" : ""}`;
      subs.set(k, (subs.get(k) ?? 0) + 1);
    }
  }
  const lines = [...subs].slice(0, 8).map(([k, count]) => `Font fallback (${count} run${count === 1 ? "" : "s"}): ${k}`);
  if (subs.size > 8) lines.push(`Font fallback: ${subs.size - 8} more substitution(s) not listed`);
  return lines;
}

async function buildPage(track: Track, section: SectionNode, page: HifiPage, y: number, fonts: Map<HifiText, ResolvedFont>, hashes: Map<string, string>, doc: HifiDoc, failedLoads: string[], stats: HifiStats, componentNodes: Map<string, ComponentNode>): Promise<{ bottom: number; frame: FrameNode }> {
  const x0 = 80;
  const ref = page.referenceAssetId ? doc.assets.find((a) => a.id === page.referenceAssetId) : undefined;
  const notes = [
    `${page.title} — ${page.url}`,
    `Measured absolute desktop snapshot (${page.width}×${page.height}px). Editable, not responsive, not pixel-perfect.`,
    ...(page.truncated ? ["TRUNCATED: see warnings below."] : []),
    ...(page.notes ?? []).map((n) => `Note: ${n}`),
    ...page.warnings.map((w) => `Warning: ${w}`),
    ...fontLines(page.nodes, fonts),
    ...failedLoads.map((f) => `Font load failure: ${f}`),
    ...(page.instances?.length ? [`Shared components: ${page.instances.length} instance(s) (${page.instances.map((i) => `${i.component}${i.overrides.length ? ` with ${i.overrides.length} override(s)` : ""}`).join(", ")})`] : []),
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

  const unfitted = await renderNodes(track, frame, page.nodes, page.clips ?? [], fonts, hashes, stats, () => "");
  for (const ins of page.instances ?? []) {
    const comp = componentNodes.get(ins.component);
    if (!comp) continue;
    const inst = track(comp.createInstance());
    frame.appendChild(inst);
    inst.x = ins.x;
    inst.y = ins.y;
    for (const o of ins.overrides) {
      const target = inst.findOne((n) => n.name.startsWith(`#${o.index} `));
      if (!target || !("fills" in target)) continue;
      if (o.fill !== undefined) (target as GeometryMixin).fills = o.fill ? [solid(o.fill)] : [];
      if (o.color) {
        if (target.type === "TEXT") target.fills = [solid(o.color)];
        else (target as GeometryMixin).strokes = [solid(o.color)];
      }
    }
    stats.instances++;
  }
  if (unfitted) {
    head.characters = head.characters + `\nWidth fit skipped for ${unfitted} measured text run(s) (difference too large); natural width kept.`;
    stats.unfitted += unfitted;
  }

  let bottom = top + page.height;
  if (ref) {
    // Native pixel size (1:1), never rescaled to the page width.
    const rx = x0 + page.width + 80;
    label(track, section, `Reference screenshot (image, not editable; ${ref.width}×${ref.height}px at 1:1)`, 14, true, rx, top - 24);
    const r = track(figma.createRectangle());
    section.appendChild(r);
    r.name = `Reference / ${page.path}`;
    r.x = rx;
    r.y = top;
    r.resize(ref.width, ref.height);
    r.fills = [{ type: "IMAGE", imageHash: hashes.get(ref.id)!, scaleMode: "FILL" }];
    r.setPluginData("w2f", JSON.stringify({ reference: true, sha256: ref.sha256 }));
    bottom = Math.max(bottom, top + ref.height);
  }
  return { bottom, frame };
}

async function edge(track: Track, section: SectionNode, from: FrameNode, to: FrameNode): Promise<VectorNode> {
  const gx = 40;
  const pts = [
    { x: from.x, y: from.y + 20 },
    { x: gx, y: from.y + 20 },
    { x: gx, y: to.y + 20 },
    { x: to.x, y: to.y + 20 },
  ];
  const minX = Math.min(...pts.map((p) => p.x));
  const minY = Math.min(...pts.map((p) => p.y));
  const v = track(figma.createVector());
  section.appendChild(v);
  v.name = `Sitemap edge / ${from.name} -> ${to.name}`;
  await v.setVectorNetworkAsync({
    vertices: pts.map((p, i) => (i === pts.length - 1 ? { x: p.x - minX, y: p.y - minY, strokeCap: "ARROW_LINES" as const } : { x: p.x - minX, y: p.y - minY })),
    segments: [{ start: 0, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 3 }],
    regions: [],
  });
  v.x = minX;
  v.y = minY;
  v.strokes = [{ type: "SOLID", color: { r: 0.6, g: 0.6, b: 0.6 } }];
  v.strokeWeight = 2;
  v.fills = [];
  return v;
}

export async function buildHifiDoc(doc: HifiDoc, track: Track, created: SceneNode[], originX: number): Promise<HifiStats> {
  // 1) Verify all bytes and resolve/load all fonts before touching the canvas.
  const bytes = verifyAssets(doc);
  const { byNode, failedLoads } = await resolveFonts(doc);
  const hashes = new Map<string, string>();
  for (const [id, b] of bytes) hashes.set(id, figma.createImage(b).hash);

  const stats: HifiStats = { pages: 0, nodes: 0, images: 0, placeholders: 0, fontFallbacks: 0, fitted: 0, unfitted: 0, shapes: 0, svgs: 0, components: 0, instances: 0, edges: 0, warnings: [...doc.warnings] };
  const section = track(figma.createSection());
  created.push(section);
  section.name = `website-to-figma · Hi-fi (measured) · ${doc.site.host}`;
  section.x = originX;
  section.y = 0;
  const intro = [
    `Source: ${doc.source.label} (${doc.source.mode}). ${doc.provenance.notes.join(" ")}`,
    ...(doc.fontMap?.length ? [`Operator font map: ${doc.fontMap.map((f) => `${f.match} -> ${f.use}`).join(", ")}`] : []),
    ...doc.warnings.map((w) => `Warning: ${w}`),
    "Not affiliated with Figma or the site owner. Not pixel-perfect.",
  ];
  const title = label(track, section, `Hi-fi import · ${doc.site.host}`, 28, true, 80, 40);
  const info = label(track, section, intro.join("\n"), 14, false, 80, 40 + title.height + 8, 1200);
  let y = info.y + info.height + 60;
  let maxRight = 1300;

  // 2) Shared components (nav/footer) in their own labelled area.
  const componentNodes = new Map<string, ComponentNode>();
  if (doc.components?.length) {
    label(track, section, "Shared components (identical structure on 2+ pages; per-page paint differences are instance overrides)", 14, true, 80, y);
    y += 30;
    for (const c of doc.components) {
      const comp = track(figma.createComponent());
      section.appendChild(comp);
      comp.name = c.name;
      comp.x = 80;
      comp.y = y;
      comp.resize(Math.max(1, c.w), Math.max(1, c.h));
      comp.fills = [];
      comp.clipsContent = false;
      await renderNodes(track, comp, c.nodes, [], byNode, hashes, stats, (i) => `#${i} `);
      componentNodes.set(c.id, comp);
      stats.components++;
      y += c.h + 60;
      maxRight = Math.max(maxRight, 80 + c.w + 80);
    }
    y += 60;
  }

  // 3) Pages, then sitemap edges between page frames (URL path hierarchy).
  const frames = new Map<string, FrameNode>();
  for (const page of doc.pages) {
    const r = await buildPage(track, section, page, y, byNode, hashes, doc, failedLoads, stats, componentNodes);
    frames.set(page.id, r.frame);
    y = r.bottom + 120;
    const ref = page.referenceAssetId ? doc.assets.find((a) => a.id === page.referenceAssetId) : undefined;
    maxRight = Math.max(maxRight, 80 + page.width + 80 + (ref ? ref.width : 0) + 80);
    stats.pages++;
  }
  const edges: VectorNode[] = [];
  for (const page of doc.pages) {
    const from = page.parentId ? frames.get(page.parentId) : undefined;
    const to = frames.get(page.id);
    if (from && to) edges.push(await edge(track, section, from, to));
  }
  if (edges.length) {
    const g = track(figma.group(edges, section, 0));
    g.name = "Sitemap edges (vectors, URL path hierarchy)";
    stats.edges = edges.length;
  }
  section.resizeWithoutConstraints(maxRight, y);
  if (stats.fontFallbacks) stats.warnings.push(`Font fallback used for ${stats.fontFallbacks} text run(s); see each page's notes`);
  for (const f of failedLoads) stats.warnings.push(`Font load failure: ${f}`);
  if (stats.unfitted) stats.warnings.push(`Width fit skipped for ${stats.unfitted} text run(s)`);
  for (const p of doc.pages) if (p.truncated) stats.warnings.push(`Page ${p.path} is truncated; see its notes`);
  if (stats.placeholders) stats.warnings.push(`${stats.placeholders} image(s) shown as MISSING IMAGE placeholders`);
  return stats;
}
