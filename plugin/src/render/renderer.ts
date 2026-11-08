// Shared hi-fi renderer (one implementation for the native plugin host and the
// connector $fig host). Measured absolute geometry only; nothing invented.
// Job-oriented: the native plugin runs every phase in one job; the connector
// runs bounded jobs (components, page shell, node batches, states, edges) that
// find earlier nodes by deterministic unique names.
import type { BoxNode, ClipGroup, HifiDoc, HifiNode, HifiPage, ImageNode, Paint, ShapeNode, SvgNode, TextNode as HifiText } from "../../../src/shared/hifiSchema";
import { isCanonicalSvg } from "../../../src/shared/svgSanitize";
import { mappedFamily, resolveFont, type ResolvedFont } from "../../../src/shared/fonts";
import type { Host } from "./host";

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
  variantSets: number;
  variants: number;
  reactions: number;
  media: number;
  warnings: string[];
}

export const newStats = (doc: HifiDoc): HifiStats => ({ pages: 0, nodes: 0, images: 0, placeholders: 0, fontFallbacks: 0, fitted: 0, unfitted: 0, shapes: 0, svgs: 0, components: 0, instances: 0, edges: 0, variantSets: 0, variants: 0, reactions: 0, media: 0, warnings: [...doc.warnings] });

const LABEL = { family: "Inter", style: "Regular" };
const LABEL_BOLD = { family: "Inter", style: "Bold" };
const MAX_LETTER_SPACING_RATIO = 0.25;
const X0 = 80;

export interface Ctx<N> {
  host: Host<N>;
  doc: HifiDoc;
  fonts: Map<HifiText, ResolvedFont>;
  failedLoads: string[];
  stats: HifiStats;
}

// Resolve and load fonts for the given node lists before any text exists.
export async function resolveFonts<N>(host: Host<N>, doc: HifiDoc, lists: HifiNode[][]): Promise<{ byNode: Map<HifiText, ResolvedFont>; failedLoads: string[] }> {
  const available = await host.availableFonts();
  for (const f of [LABEL, LABEL_BOLD]) {
    try {
      await host.loadFont(f);
    } catch {
      throw new Error("Could not load Inter Regular/Bold for labels. Nothing was created.");
    }
  }
  const loaded = new Set(["Inter|Regular", "Inter|Bold"]);
  const failedLoads: string[] = [];
  const byNode = new Map<HifiText, ResolvedFont>();
  for (let round = 0; round < 6; round++) {
    const needed = new Map<string, { family: string; style: string }>();
    for (const list of lists) {
      for (const n of list) {
        if (n.kind !== "text") continue;
        const r = resolveFont(n.fontStack, n.generic, n.weight, n.italic, available, mappedFamily(n.fontStack, n.generic, doc.fontMap));
        if (!r) throw new Error(`No loadable font for "${n.fontStack.join(", ")}" (not even Inter). Nothing was created.`);
        byNode.set(n, r);
        const key = `${r.family}|${r.style}`;
        if (!loaded.has(key)) needed.set(key, { family: r.family, style: r.style });
      }
    }
    if (needed.size === 0) return { byNode, failedLoads };
    for (const [key, font] of needed) {
      try {
        await host.loadFont(font);
        loaded.add(key);
      } catch {
        available.delete(key);
        if (failedLoads.length < 10) failedLoads.push(`${font.family} ${font.style} failed to load`);
      }
    }
  }
  throw new Error("Font resolution did not settle. Nothing was created.");
}

export function allNodeLists(doc: HifiDoc): HifiNode[][] {
  return [...doc.pages.map((p) => p.nodes), ...doc.pages.flatMap((p) => (p.states?.variants ?? []).map((v) => v.nodes)), ...(doc.components ?? []).map((c) => c.nodes)];
}

export async function label<N>(c: Ctx<N>, parent: N, chars: string, size: number, bold: boolean, x: number, y: number, width?: number, name?: string): Promise<{ node: N; height: number }> {
  const node = c.host.text(parent, { name: name ?? chars.split("\n")[0]!.slice(0, 80), x, y, characters: chars, font: bold ? LABEL_BOLD : LABEL, size, color: null, width });
  await c.host.flush();
  return { node, height: c.host.height(node) };
}

// Deterministic names; [bN]/[cN] keys let later connector jobs find frames.
export const pageFrameName = (p: HifiPage) => `Page / ${p.path}${p.segment ? ` (part ${p.segment.index + 1}/${p.segment.count})` : ""} (editable, measured)`;
export const clipName = (c: ClipGroup, i: number) => `${c.name} [c${i}]`;
export const buttonName = (label: string | null, i: number, prefix: string) => `${prefix}Button / ${label ?? "untitled"} [b${i}]`;
export const buttonLabelOf = (nodes: HifiNode[], i: number): string | null => nodes.find((t): t is HifiText => t.kind === "text" && t.button === i)?.text.trim() ?? null;
export function nodeName(nodes: HifiNode[], n: HifiNode, i: number, prefix: string, imageFilled: boolean | null, label?: (i: number) => string | null): { name: string; type: string } {
  if (n.kind === "box") {
    if (n.role === "button") return { name: buttonName(label ? label(i) : buttonLabelOf(nodes, i), i, prefix), type: "FRAME" };
    return { name: `${prefix}${n.name}`, type: "RECTANGLE" };
  }
  if (n.kind === "text") return { name: `${prefix}${n.name}`, type: "TEXT" };
  if (n.kind === "image") return { name: imageFilled === false ? `${prefix}${n.assetId ? "IMAGE PLACEHOLDER (fill unavailable)" : "MISSING IMAGE"} / ${n.name}` : `${prefix}${n.name}`, type: "RECTANGLE" };
  if (n.kind === "shape") return { name: `${prefix}${n.name}`, type: n.shape === "ellipse" ? "ELLIPSE" : "VECTOR" };
  return { name: `${prefix}${n.name}`, type: "FRAME" };
}

type Off = { x: number; y: number };

async function placeShape<N>(c: Ctx<N>, parent: N, sh: ShapeNode, off: Off, prefix: string): Promise<N> {
  const name = `${prefix}${sh.name}`;
  const base = { name, x: sh.x - off.x, y: sh.y - off.y, w: Math.max(0.01, sh.w), h: Math.max(0.01, sh.h) };
  if (sh.shape === "ellipse") {
    const e = c.host.ellipse(parent, { ...base, fill: sh.fill, stroke: sh.stroke ? { color: sh.stroke.color, weight: sh.stroke.weight } : null });
    c.host.meta(e, { prov: sh.prov, approximation: true });
    return e;
  }
  const { w, h } = sh;
  const v =
    sh.shape === "caret"
      ? await c.host.path(parent, { ...base, points: [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w / 2, y: h }], mode: "polygon", fill: sh.fill, stroke: null })
      : await c.host.path(parent, { ...base, points: [{ x: w * 0.2, y: h }, { x: w, y: h * 0.2 }, { x: w * 0.5, y: h }, { x: w, y: h * 0.5 }, { x: w * 0.8, y: h }, { x: w, y: h * 0.8 }], mode: "pairs", fill: null, stroke: sh.stroke ? { color: sh.stroke.color, weight: sh.stroke.weight } : null });
  c.host.meta(v, { prov: sh.prov, approximation: true });
  return v;
}

// Renders nodes into a parent: 1) unclipped non-text, 2) clip frames,
// 3) clipped non-text, 4) text on top. Width fitting happens after one flush.
export async function renderNodes<N>(
  c: Ctx<N>,
  parent: N,
  nodes: HifiNode[],
  clipGroups: ClipGroup[],
  prefix: (i: number) => string,
  opts: {
    only?: Set<number>;
    phase?: "all" | "unclipped" | "clipped" | "text";
    createClips?: boolean;
    findClip?: (i: number) => N | null;
    findButton?: (orig: number) => N | null;
    recordNames?: Map<number, { name: string; type: string }>;
    // batch rendering of a node subset: original index, button label and box by original index
    orig?: (local: number) => number;
    buttonLabel?: (orig: number) => string | null;
    buttonBox?: (orig: number) => { x: number; y: number } | null;
  } = {},
): Promise<number> {
  const { host } = c;
  const zero = { x: 0, y: 0 };
  const inScope = (i: number) => !opts.only || opts.only.has(i);
  const clipFrames: (N | null)[] = [];
  const buttonFrames = new Map<number, N>();
  const fits: { node: N; t: HifiText; font: ResolvedFont; prefixName: string }[] = [];
  let unfitted = 0;
  const clipOf = (n: HifiNode) => (n.clip !== undefined && n.clip >= 0 ? n.clip : -1);
  const orig = opts.orig ?? ((i: number) => i);
  const labelOf = opts.buttonLabel ?? ((o: number) => buttonLabelOf(nodes, o));
  const place = async (n: HifiNode, i: number, target: N, off: Off) => {
    const p = prefix(i);
    if (n.kind === "box") {
      const nm = nodeName(nodes, n, orig(i), p, null, labelOf);
      const spec = { name: nm.name, x: n.x - off.x, y: n.y - off.y, w: Math.max(0.01, n.w), h: Math.max(0.01, n.h), fill: n.fill, stroke: n.border ? { color: n.border.color, weight: n.border.weight } : null, radius: n.radius, opacity: n.opacity };
      const built = n.role === "button" ? host.frame(target, { ...spec, clipsContent: false }) : host.rect(target, spec);
      host.meta(built, { prov: n.prov, role: n.role });
      if (n.role === "button") buttonFrames.set(orig(i), built);
      opts.recordNames?.set(i, nm);
    } else if (n.kind === "image") {
      const filled = !!n.assetId && host.hasImage(n.assetId);
      const nm = nodeName(nodes, n, i, p, filled);
      const r = host.rect(target, { name: nm.name, x: n.x - off.x, y: n.y - off.y, w: Math.max(0.01, n.w), h: Math.max(0.01, n.h), fill: null, radius: n.radius, ...(filled ? { image: { assetId: n.assetId!, mode: n.fit === "fit" ? ("FIT" as const) : ("FILL" as const) } } : { placeholder: "missing" as const }) });
      host.meta(r, filled ? { prov: n.prov, assetId: n.assetId } : { prov: n.prov, missing: true });
      if (filled) c.stats.images++;
      else c.stats.placeholders++;
      opts.recordNames?.set(i, nm);
    } else if (n.kind === "shape") {
      await placeShape(c, target, n, off, p);
      c.stats.shapes++;
      opts.recordNames?.set(i, nodeName(nodes, n, i, p, null));
    } else if (n.kind === "svg") {
      if (!isCanonicalSvg(n.markup)) return;
      const f = host.svg(target, n.markup, { name: `${p}${n.name}`, x: n.x - off.x, y: n.y - off.y });
      host.meta(f, { prov: n.prov, sanitized: true });
      c.stats.svgs++;
      opts.recordNames?.set(i, nodeName(nodes, n, i, p, null));
    }
  };
  const phase = opts.phase ?? "all";
  const run = (ph: "unclipped" | "clipped" | "text") => phase === "all" || phase === ph;
  if (run("unclipped")) for (const [i, n] of nodes.entries()) if (inScope(i) && n.kind !== "text" && clipOf(n) < 0) await place(n, i, parent, zero);
  if (run("clipped") || run("text")) {
    for (const [ci, g] of clipGroups.entries()) {
      if (opts.createClips === false || !run("clipped")) clipFrames.push(opts.findClip ? opts.findClip(ci) : null);
      else clipFrames.push(host.frame(parent, { name: clipName(g, ci), x: g.x, y: g.y, w: Math.max(0.01, g.w), h: Math.max(0.01, g.h), fill: null, clipsContent: true }));
    }
  }
  if (run("clipped"))
    for (const [i, n] of nodes.entries()) {
      const ci = clipOf(n);
      if (inScope(i) && n.kind !== "text" && ci >= 0 && clipFrames[ci]) await place(n, i, clipFrames[ci]!, clipGroups[ci]!);
    }
  for (const [i, n] of nodes.entries()) {
    if (!run("text") || !inScope(i) || n.kind !== "text") continue;
    const font = c.fonts.get(n)!;
    const button = n.button >= 0 ? (buttonFrames.get(n.button) ?? opts.findButton?.(n.button) ?? undefined) : undefined;
    const ci = clipOf(n);
    const box = n.button >= 0 ? (opts.buttonBox ? opts.buttonBox(n.button) : (nodes[n.button] as BoxNode)) : null;
    const target = button ?? (ci >= 0 && clipFrames[ci] ? clipFrames[ci]! : parent);
    const off = button && box ? { x: box.x, y: box.y } : ci >= 0 && clipFrames[ci] ? clipGroups[ci]! : zero;
    const node = host.text(target, {
      name: `${prefix(i)}${n.name}`,
      x: n.x - off.x,
      y: n.y - off.y,
      characters: n.text,
      font: { family: font.family, style: font.style },
      size: n.size,
      lineHeight: n.lineHeight,
      color: n.color,
      decoration: n.decoration === "underline" ? "UNDERLINE" : n.decoration === "strike" ? "STRIKETHROUGH" : "NONE",
      ...(n.align === "right" ? { width: Math.max(1, n.w), align: "RIGHT" as const } : {}),
    });
    fits.push({ node, t: n, font, prefixName: prefix(i) });
    opts.recordNames?.set(i, nodeName(nodes, n, i, prefix(i), null));
  }
  // Width fitting needs real rendered widths: one flush, then reads.
  if (fits.length) await host.flush();
  for (const f of fits) {
    const t = f.t;
    let result: "fitted" | "unfitted" | "not-fitted" = "not-fitted";
    if (t.prov === "measured" && t.fit !== false && t.align !== "right" && t.graphemes > 1 && t.w > 0) {
      const ls = (t.w - host.width(f.node)) / (t.graphemes - 1);
      if (Math.abs(ls) <= t.size * MAX_LETTER_SPACING_RATIO) {
        host.setLetterSpacing(f.node, ls);
        result = "fitted";
      } else result = "unfitted";
    }
    if (result === "fitted") c.stats.fitted++;
    if (result === "unfitted") unfitted++;
    if (f.font.fallback) c.stats.fontFallbacks++;
    host.meta(f.node, { prov: t.prov, fit: result, font: `${f.font.family} ${f.font.style}`, fallback: f.font.fallback, reason: f.font.reason, measuredStack: t.fontStack });
  }
  if (phase === "all") c.stats.nodes += opts.only ? opts.only.size : nodes.length;
  else c.stats.nodes += nodes.filter((n, i) => inScope(i) && (phase === "text" ? n.kind === "text" : n.kind !== "text" && (phase === "clipped") === clipOf(n) >= 0)).length;
  return unfitted;
}

export function fontLines(nodes: HifiNode[], fonts: Map<HifiText, ResolvedFont>): string[] {
  const subs = new Map<string, number>();
  for (const n of nodes) {
    if (n.kind !== "text") continue;
    const f = fonts.get(n);
    if (f?.fallback) {
      const k = `"${n.fontStack.join(", ") || "(none)"}" ${n.weight >= 600 ? "bold" : "regular"}${n.italic ? " italic" : ""} -> ${f.family} ${f.style}${f.reason.startsWith("operator font map") ? " (operator font map)" : ""}`;
      subs.set(k, (subs.get(k) ?? 0) + 1);
    }
  }
  const lines = [...subs].slice(0, 8).map(([k, count]) => `Font fallback (${count} run${count === 1 ? "" : "s"}): ${k}`);
  if (subs.size > 8) lines.push(`Font fallback: ${subs.size - 8} more substitution(s) not listed`);
  return lines;
}

export function stateLines(page: HifiPage): string[] {
  const out: string[] = [];
  if (page.states) out.push(`States: ${page.states.variants.map((v) => `${v.name} (${v.provenance})`).join(", ")}. Synthetic = DOM modification, not an observed original state; manual = operator screenshot only.`);
  if (page.freeze) out.push(`Freeze: applied ${page.freeze.applied.map((a) => `${a.name} ${a.count}`).join(", ") || "none"}; unavailable ${page.freeze.unavailable.join(", ") || "none"}; NOT frozen: ${page.freeze.notFrozen.join(", ")}`);
  for (const m of page.freeze?.modifications ?? []) out.push(`Freeze modification: ${m}`);
  if (page.motion) out.push(`Motion (static notes, not animated): ${page.motion.rules.length} transition/animation/hover rule(s); ${page.motion.inaccessibleSheets} unreadable stylesheet(s)`);
  if (page.media?.length) out.push(`Media: ${page.media.length} placeholder(s) (video/canvas/lottie/iframe do not play in Figma)`);
  return out;
}

export function componentChildNames(doc: HifiDoc): Map<string, Map<number, { name: string; type: string }>> {
  const out = new Map<string, Map<number, { name: string; type: string }>>();
  for (const c of doc.components ?? []) {
    const m = new Map<number, { name: string; type: string }>();
    c.nodes.forEach((n, i) => m.set(i, nodeName(c.nodes, n, i, `#${i} `, null)));
    out.set(c.id, m);
  }
  return out;
}

// ---- phases -------------------------------------------------------------

export async function renderIntro<N>(c: Ctx<N>, root: N): Promise<number> {
  const { doc } = c;
  const intro = [
    `Source: ${doc.source.label} (${doc.source.mode}). ${doc.provenance.notes.join(" ")}`,
    ...(doc.fontMap?.length ? [`Operator font map: ${doc.fontMap.map((f) => `${f.match} -> ${f.use}`).join(", ")}`] : []),
    ...doc.warnings.map((w) => `Warning: ${w}`),
    "Not affiliated with Figma or the site owner. Not pixel-perfect.",
  ];
  const title = await label(c, root, `Hi-fi import · ${doc.site.host}`, 28, true, X0, 40);
  const info = await label(c, root, intro.join("\n"), 14, false, X0, 40 + title.height + 8, 1200);
  return 40 + title.height + 8 + info.height + 60;
}

export async function renderComponentShell<N>(c: Ctx<N>, root: N, cm: { name: string; w: number; h: number }, y: number): Promise<N> {
  const comp = c.host.component(root, { name: cm.name, x: X0, y, w: Math.max(1, cm.w), h: Math.max(1, cm.h), fill: null, clipsContent: false });
  c.stats.components++;
  return comp;
}

export async function renderComponents<N>(c: Ctx<N>, root: N, y0: number): Promise<{ y: number; right: number; components: Map<string, N> }> {
  const components = new Map<string, N>();
  let y = y0;
  let right = 1300;
  if (!c.doc.components?.length) return { y, right, components };
  await label(c, root, "Shared components (identical structure on 2+ pages; per-page paint differences are instance overrides)", 14, true, X0, y);
  y += 30;
  for (const cm of c.doc.components) {
    const comp = c.host.component(root, { name: cm.name, x: X0, y, w: Math.max(1, cm.w), h: Math.max(1, cm.h), fill: null, clipsContent: false });
    await renderNodes(c, comp, cm.nodes, [], (i) => `#${i} `);
    components.set(cm.id, comp);
    c.stats.components++;
    y += cm.h + 60;
    right = Math.max(right, X0 + cm.w + 80);
  }
  return { y: y + 60, right, components };
}

// Page shell: notes, page frame, (optionally all nodes), instances, media,
// references, states. Returns the frame and the bottom edge.
// Notes lines for a page (also used by connector label jobs).
export function pageNotes<N>(c: Ctx<N>, page: HifiPage): string[] {
  return [
    `${page.title} — ${page.url}`,
    `Measured absolute desktop snapshot (${page.width}×${page.height}px). Editable, not responsive, not pixel-perfect.`,
    ...(page.truncated ? ["TRUNCATED: see warnings below."] : []),
    ...(page.notes ?? []).map((n) => `Note: ${n}`),
    ...page.warnings.map((w) => `Warning: ${w}`),
    ...fontLines(page.nodes, c.fonts),
    ...c.failedLoads.map((f) => `Font load failure: ${f}`),
    ...(page.instances?.length ? [`Shared components: ${page.instances.length} instance(s) (${page.instances.map((i) => `${i.component}${i.overrides.length ? ` with ${i.overrides.length} override(s)` : ""}`).join(", ")})`] : []),
    ...(page.segment ? [`Segment ${page.segment.index + 1}/${page.segment.count} of a ${Math.round(page.segment.sourceHeight)}px document (offset y ${page.segment.offsetY}).`] : []),
    ...stateLines(page),
    ...(page.branding ? [`Branding (page-level, not per-element): ${Object.entries(page.branding.colors).map(([k, v]) => `${k} ${v}`).join(", ")}${page.branding.fonts.length ? `; fonts ${page.branding.fonts.join(", ")}` : ""}`] : []),
  ];
}
export const notesName = (page: HifiPage) => `Notes / ${page.path}${page.segment ? ` (part ${page.segment.index + 1}/${page.segment.count})` : ""}`;

// Instances (with paint overrides) and media placeholders: rendered above the
// page's nodes (native z-order); a separate connector job when nodes are batched.
export async function renderPageDecorations<N>(c: Ctx<N>, frame: N, page: HifiPage, components: Map<string, N>, childNames: Map<string, Map<number, { name: string; type: string }>>): Promise<void> {
  const { host } = c;
  for (const ins of page.instances ?? []) {
    const comp = components.get(ins.component);
    if (!comp) continue;
    const inst = await host.instance(frame, comp, { x: ins.x, y: ins.y });
    for (const o of ins.overrides) {
      const child = childNames.get(ins.component)?.get(o.index);
      if (!child) continue;
      if (o.fill !== undefined) await host.override(inst, child, { fills: o.fill });
      if (o.color) await host.override(inst, child, child.type === "TEXT" ? { fills: o.color } : { strokes: o.color });
    }
    c.stats.instances++;
  }
  for (const m of page.media ?? []) {
    const filled = !!m.stillAssetId && host.hasImage(m.stillAssetId);
    const name = filled ? `MEDIA STILL / ${m.kind} (operator still for the observed poster URL; not playing)` : `MEDIA PLACEHOLDER / ${m.kind} (${m.still === "poster-url-observed-not-downloaded" ? "poster URL observed, not downloaded" : m.still === "operator-asset" ? "operator still unavailable in this host" : "no still available"}${m.webgl ? "; WebGL" : ""})`;
    const r = host.rect(frame, { name, x: m.x, y: m.y, w: Math.max(0.01, m.w), h: Math.max(0.01, m.h), fill: null, ...(filled ? { image: { assetId: m.stillAssetId!, mode: "FILL" as const } } : { placeholder: "media" as const }) });
    host.meta(r, { media: m.kind, still: m.still, poster: m.poster, src: m.src, webgl: m.webgl });
    c.stats.media++;
  }
}

// opts.notes false: the caller already placed the notes (connector label jobs);
// opts.states false: states are rendered by separate jobs.
export async function renderPage<N>(c: Ctx<N>, root: N, page: HifiPage, y: number, components: Map<string, N>, opts: { nodes?: boolean; notes?: boolean; states?: boolean; decorations?: boolean; childNames?: Map<string, Map<number, { name: string; type: string }>> } = {}): Promise<{ bottom: number; top: number; frame: N; notes: N | null }> {
  const { host, doc } = c;
  const ref = page.referenceAssetId ? doc.assets.find((a) => a.id === page.referenceAssetId) : undefined;
  const notes = pageNotes(c, page);
  const head = opts.notes === false ? null : await label(c, root, notes.join("\n"), 14, false, X0, y, Math.max(600, page.width), notesName(page));
  const top = head ? y + head.height + 24 : y;
  const frame = host.frame(root, { name: pageFrameName(page), x: X0, y: top, w: page.width, h: page.height, fill: null, clipsContent: true });
  host.meta(frame, { url: page.url, truncated: page.truncated });
  let unfitted = 0;
  if (opts.nodes !== false) unfitted = await renderNodes(c, frame, page.nodes, page.clips ?? [], () => "");
  if (opts.decorations !== false) await renderPageDecorations(c, frame, page, components, opts.childNames ?? componentChildNames(doc));
  if (unfitted && head) {
    host.setCharacters(head.node, notes.join("\n") + `\nWidth fit skipped for ${unfitted} measured text run(s) (difference too large); natural width kept.`);
    c.stats.unfitted += unfitted;
  }
  let bottom = top + page.height;
  const rx = X0 + page.width + 80;
  if (ref) {
    await label(c, root, `Reference screenshot (image, not editable; ${ref.width}×${ref.height}px at 1:1)`, 14, true, rx, top - 24);
    const ok = host.hasImage(ref.id);
    const r = host.rect(root, { name: ok ? `Reference / ${page.path}` : `Reference / ${page.path} (IMAGE PLACEHOLDER: fill unavailable; sha256 ${ref.sha256.slice(0, 16)})`, x: rx, y: top, w: ref.width, h: ref.height, fill: null, ...(ok ? { image: { assetId: ref.id, mode: "FILL" as const } } : { placeholder: "missing" as const }) });
    host.meta(r, { reference: true, sha256: ref.sha256 });
    bottom = Math.max(bottom, top + ref.height);
  } else if (page.referenceTiles) {
    const rt = page.referenceTiles;
    await label(c, root, `Reference screenshot (image, not editable; ${rt.sourceWidth}×${rt.sourceHeight}px at 1:1, ${rt.tiles.length} tiles)`, 14, true, rx, top - 24);
    const holder = host.frame(root, { name: `Reference / ${page.path} (${rt.tiles.length} tiles)`, x: rx, y: top, w: rt.sourceWidth, h: rt.sourceHeight, fill: null, clipsContent: true });
    host.meta(holder, { reference: true, tiled: true, sourceSha256: rt.sourceSha256 });
    for (const [i, t] of rt.tiles.entries()) {
      const asset = doc.assets.find((a) => a.id === t.assetId)!;
      const ok = host.hasImage(asset.id);
      const r = host.rect(holder, { name: `Reference tile ${i + 1}/${rt.tiles.length} (y ${t.y})${ok ? "" : " (IMAGE PLACEHOLDER)"}`, x: 0, y: t.y, w: rt.sourceWidth, h: t.h, fill: null, ...(ok ? { image: { assetId: asset.id, mode: "FILL" as const } } : { placeholder: "missing" as const }) });
      host.meta(r, { referenceTile: i, y: t.y, h: t.h, tileSha256: asset.sha256, sourceSha256: rt.sourceSha256 });
    }
    bottom = Math.max(bottom, top + rt.sourceHeight);
  }
  if (page.states && opts.states !== false) bottom = await renderStates(c, root, page, bottom + 80);
  c.stats.pages++;
  return { bottom, top, frame, notes: head ? head.node : null };
}

// opts.nodes false: components are created empty (no description) and their
// nodes/descriptions are added by later connector jobs into the same components.
export const statesSetName = (page: HifiPage) => `States / ${page.path}`;
export async function renderStates<N>(c: Ctx<N>, root: N, page: HifiPage, y: number, opts: { nodes?: boolean } = {}): Promise<number> {
  const { host, doc } = c;
  const st = page.states!;
  const head = await label(c, root, `States / ${page.path}: native component variants (${st.variants.map((v) => `${v.name}: ${v.provenance}`).join(", ")}). Synthetic states are DOM modifications, not observed original states; scroll-triggered = observed page reaction to scrolling; page-api = the page's own Swiper advanced via its API (not a user event).${st.reactions === "click-cycle" && st.variants.length > 1 ? " Prototype: ON_CLICK -> CHANGE_TO next variant." : ""}`, 14, true, X0, y, 1200);
  const top = y + head.height + 16;
  const comps: N[] = [];
  let x = 0;
  for (const v of st.variants) {
    const comp = host.component(root, { name: `State=${v.name}`, x: X0 + x, y: top, w: Math.max(1, v.frame.w), h: Math.max(1, v.frame.h), fill: null, clipsContent: true, ...(opts.nodes === false ? {} : { description: v.notes.join("\n") }) });
    host.meta(comp, { state: v.name, provenance: v.provenance, frame: v.frame, screenshot: v.screenshot });
    const ref = v.referenceAssetId ? doc.assets.find((a) => a.id === v.referenceAssetId) : undefined;
    if (ref && v.screenshot && v.screenshot.scrollY !== null) {
      const name = `Reference screenshot / ${v.name} (hidden; ${v.screenshot.association}${v.screenshot.verified ? `; ${v.screenshot.verified}` : ""}${v.screenshot.distinct === false ? "; IDENTICAL to another state's screenshot" : ""})`;
      const ok = host.hasImage(ref.id);
      const r = host.rect(comp, { name: ok ? name : `${name} (IMAGE PLACEHOLDER)`, x: -v.frame.x, y: v.screenshot.scrollY - v.frame.y, w: ref.width, h: ref.height, fill: null, ...(ok ? { image: { assetId: ref.id, mode: "FILL" as const } } : { placeholder: "missing" as const }) });
      host.hide(r);
    }
    if (opts.nodes !== false) await renderNodes(c, comp, v.nodes, [], () => "");
    comps.push(comp);
    x += v.frame.w + 40;
    c.stats.variants++;
  }
  await host.variants(root, comps, { name: statesSetName(page), x: X0, y: top, gap: 40 });
  c.stats.variantSets++;
  if (st.reactions === "click-cycle" && comps.length > 1) {
    await host.flush();
    for (const [i, comp] of comps.entries()) {
      await host.reaction(comp, comps[(i + 1) % comps.length]!);
      c.stats.reactions++;
    }
  }
  return top + Math.max(...st.variants.map((v) => v.frame.h)) + 40;
}

export async function renderEdges<N>(c: Ctx<N>, root: N, frames: Map<string, { node: N; x: number; y: number; name: string }>): Promise<void> {
  const edges: N[] = [];
  for (const page of c.doc.pages) {
    const from = page.parentId ? frames.get(page.parentId) : undefined;
    const to = frames.get(page.id);
    if (!from || !to) continue;
    const gx = 40;
    const pts = [
      { x: from.x, y: from.y + 20 },
      { x: gx, y: from.y + 20 },
      { x: gx, y: to.y + 20 },
      { x: to.x, y: to.y + 20 },
    ];
    const minX = Math.min(...pts.map((p) => p.x));
    const minY = Math.min(...pts.map((p) => p.y));
    const maxX = Math.max(...pts.map((p) => p.x));
    const maxY = Math.max(...pts.map((p) => p.y));
    edges.push(await c.host.path(root, { name: `Sitemap edge / ${from.name} -> ${to.name}`, x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY), points: pts.map((p) => ({ x: p.x - minX, y: p.y - minY })), mode: "polyline", fill: null, stroke: { r: 0.6, g: 0.6, b: 0.6, weight: 2 }, arrowEnd: true }));
  }
  if (edges.length) {
    await c.host.group(root, edges, "Sitemap edges (vectors, URL path hierarchy)");
    c.stats.edges = edges.length;
  }
}

// Whole document in one job (native plugin; small connector docs).
export async function renderDocument<N>(host: Host<N>, doc: HifiDoc, rootName: string, originX: number): Promise<{ stats: HifiStats; root: N }> {
  const { byNode, failedLoads } = await resolveFonts(host, doc, allNodeLists(doc));
  const c: Ctx<N> = { host, doc, fonts: byNode, failedLoads, stats: newStats(doc) };
  const root = host.root({ name: rootName, x: originX, y: 0 });
  let y = await renderIntro(c, root);
  const comps = await renderComponents(c, root, y);
  y = comps.y;
  let maxRight = comps.right;
  const frames = new Map<string, { node: N; x: number; y: number; name: string }>();
  for (const page of doc.pages) {
    const r = await renderPage(c, root, page, y, comps.components);
    frames.set(page.id, { node: r.frame, x: X0, y: r.top, name: pageFrameName(page) });
    y = r.bottom + 120;
    const ref = page.referenceAssetId ? doc.assets.find((a) => a.id === page.referenceAssetId) : undefined;
    maxRight = Math.max(maxRight, X0 + page.width + 80 + (ref ? ref.width : page.referenceTiles ? page.referenceTiles.sourceWidth : 0) + 80);
  }
  await renderEdges(c, root, frames);
  await host.resizeRoot(root, maxRight, y);
  finishWarnings(c);
  return { stats: c.stats, root };
}

export function finishWarnings<N>(c: Ctx<N>) {
  const s = c.stats;
  if (s.fontFallbacks) s.warnings.push(`Font fallback used for ${s.fontFallbacks} text run(s); see each page's notes`);
  for (const f of c.failedLoads) s.warnings.push(`Font load failure: ${f}`);
  if (s.unfitted) s.warnings.push(`Width fit skipped for ${s.unfitted} text run(s)`);
  for (const p of c.doc.pages) if (p.truncated) s.warnings.push(`Page ${p.path} is truncated; see its notes`);
  if (s.placeholders) s.warnings.push(`${s.placeholders} image(s) shown as ${c.host.kind === "planned" ? "IMAGE PLACEHOLDER (fill unavailable in this host)" : "MISSING IMAGE"} placeholders`);
  for (const u of c.host.unsupported) s.warnings.push(`Not supported by this host: ${u}`);
}

export type { BoxNode, ImageNode, Paint, SvgNode };
