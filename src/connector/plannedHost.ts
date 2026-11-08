// Connector ($fig) host for the SHARED renderer (plugin/src/render). Runs
// inside the Figma connector's script environment, where all creation and
// mutation goes through $fig plan constructors and wrapper .append/.set;
// figma.create* is unavailable. Raw reads (node.width/height, child lookup,
// listAvailableFontsAsync) and raw reactions happen ONLY after a flush
// (`await $fig.done()`); reading while plan nodes are pending throws.
//
// $fig surface used (as used by the original prototype scripts): frame,
// rectangle, text, svg, component, instance, ellipse, get, done; wrapper
// .append(child), .set(props), .query(selector).set(props), .node.
// $fig.variants follows the figma-use skill signature: OPTIONS FIRST, CHILDREN
// SECOND - `$fig.variants({ name }, componentWrappers)`. Variants are NOT
// positioned by $fig: an explicit grid and resize (.set) follow a flush.
//
// Not supported in this host (reported, never faked): image fills
// (no image-hash creation in the connector -> labelled placeholders),
// pluginData provenance (kept in names/descriptions), vector networks (paths
// become sanitized SVG polylines), grouping of edges.
import type { Paint } from "../shared/hifiSchema";
import type { BoxSpec, FrameSpec, Host, PathSpec, Stroke, TextSpec } from "../../plugin/src/render/host";

// Minimal structural types of the connector globals (no Figma calls here).
export interface FigWrapper {
  append(child: FigWrapper): unknown;
  set(props: Record<string, unknown>): unknown;
  query(selector: string): { set(props: Record<string, unknown>): unknown };
  readonly node: { id: string; width: number; height: number; x: number; y: number; name: string; children?: readonly { id: string; name: string; x: number; y: number; width: number; height: number; type: string }[]; setReactionsAsync?(r: unknown[]): Promise<void>; findOne?(p: (n: { name: string; type: string; id: string }) => boolean): { id: string; name: string; type: string } | null };
}
export interface FigBuilder {
  frame(p: Record<string, unknown>): FigWrapper;
  rectangle(p: Record<string, unknown>): FigWrapper;
  text(p: Record<string, unknown>): FigWrapper;
  svg(markup: string, p: Record<string, unknown>): FigWrapper;
  component(p: Record<string, unknown>): FigWrapper;
  instance(componentId: string, p: Record<string, unknown>): FigWrapper;
  ellipse(p: Record<string, unknown>): FigWrapper;
  variants(options: Record<string, unknown>, components: FigWrapper[]): FigWrapper;
  get(id: string): FigWrapper;
  done(): Promise<unknown>;
}
export interface FigRaw {
  listAvailableFontsAsync(): Promise<{ fontName: { family: string; style: string } }[]>;
  loadFontAsync(f: { family: string; style: string }): Promise<void>;
  currentPage: { findAll(p: (n: { name: string; type: string; id: string }) => boolean): { id: string; name: string; type: string }[] };
}

function paint(p: Paint) {
  const n = parseInt(p.hex.slice(1), 16);
  return { type: "SOLID", color: { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 }, opacity: p.alpha };
}
const isStroke = (s: unknown): s is Stroke => typeof s === "object" && s !== null && "color" in s;
const num = (v: number) => Math.round(v * 1000) / 1000;

export class PlannedHost implements Host<FigWrapper> {
  readonly kind = "planned" as const;
  readonly unsupported = new Set<string>();
  // plan nodes created but not flushed (reads must wait) / property sets on existing nodes
  private pending = 0;
  private pendingSets = 0;
  readonly created: { name: string }[] = [];
  constructor(
    private fig: FigBuilder,
    private raw: FigRaw,
    private imageHashes: Record<string, string> = {},
  ) {
    for (const [k, v] of Object.entries(imageHashes)) if (!/^[0-9a-f]{40}$/.test(v)) throw new Error(`image hash for ${k} is not a 40-hex Figma image hash`);
  }

  private mark(name: string) {
    this.pending++;
    if (this.created.length < 100_000) this.created.push({ name });
  }
  private assertFlushed(what: string) {
    if (this.pending > 0) throw new Error(`raw ${what} requested while ${this.pending} plan node(s) are pending; flush first`);
  }
  private markSet() {
    this.pendingSets++;
  }
  private boxProps(p: BoxSpec): Record<string, unknown> {
    const o: Record<string, unknown> = { name: p.name, x: num(p.x), y: num(p.y), width: Math.max(0.01, num(p.w)), height: Math.max(0.01, num(p.h)) };
    if (p.image) {
      const hash = this.imageHashes[p.image.assetId];
      if (!hash) throw new Error(`no mapped image hash for ${p.image.assetId}`);
      o.fills = [{ type: "IMAGE", imageHash: hash, scaleMode: p.image.mode }];
    } else if (p.placeholder === "missing") {
      o.fills = [{ type: "SOLID", color: { r: 0.93, g: 0.93, b: 0.93 } }];
      o.strokes = [{ type: "SOLID", color: { r: 0.8, g: 0.2, b: 0.2 } }];
      o.strokeWeight = 1;
      o.dashPattern = [6, 4];
    } else if (p.placeholder === "media") {
      o.fills = [{ type: "SOLID", color: { r: 0.85, g: 0.85, b: 0.85 }, opacity: 0.6 }];
      o.strokes = [{ type: "SOLID", color: { r: 0.4, g: 0.4, b: 0.4 } }];
      o.strokeWeight = 1;
      o.dashPattern = [6, 4];
    } else {
      o.fills = p.fill ? [paint(p.fill)] : [];
      if (p.stroke) {
        o.strokes = [paint(p.stroke.color)];
        o.strokeWeight = p.stroke.weight;
        o.strokeAlign = "INSIDE";
      } else if (p.stroke === null) o.strokes = [];
    }
    if (p.radius) Object.assign(o, { topLeftRadius: p.radius[0], topRightRadius: p.radius[1], bottomRightRadius: p.radius[2], bottomLeftRadius: p.radius[3] });
    if (p.opacity !== undefined) o.opacity = p.opacity;
    return o;
  }

  root(p: { name: string; x: number; y: number }): FigWrapper {
    this.mark(p.name);
    return this.fig.frame({ name: p.name, x: p.x, y: p.y, width: 1, height: 1, fills: [], clipsContent: false });
  }
  async resizeRoot(root: FigWrapper, w: number, h: number) {
    root.set({ width: Math.max(1, num(w)), height: Math.max(1, num(h)) });
    this.markSet();
    await this.flush();
  }
  text(parent: FigWrapper, p: TextSpec): FigWrapper {
    const o: Record<string, unknown> = { name: p.name, x: num(p.x), y: num(p.y), characters: p.characters, fontName: p.font, fontSize: p.size };
    if (p.lineHeight !== undefined) o.lineHeight = { unit: "PIXELS", value: p.lineHeight };
    if (p.color) o.fills = [paint(p.color)];
    if (p.decoration) o.textDecoration = p.decoration;
    if (p.width !== undefined) {
      Object.assign(o, { width: Math.max(1, num(p.width)), textAutoResize: "HEIGHT" });
      if (p.align === "RIGHT") o.textAlignHorizontal = "RIGHT";
    } else o.textAutoResize = "WIDTH_AND_HEIGHT";
    const t = this.fig.text(o);
    parent.append(t);
    this.mark(p.name);
    return t;
  }
  rect(parent: FigWrapper, p: BoxSpec): FigWrapper {
    const r = this.fig.rectangle(this.boxProps(p));
    parent.append(r);
    this.mark(p.name);
    return r;
  }
  frame(parent: FigWrapper, p: FrameSpec): FigWrapper {
    const f = this.fig.frame({ ...this.boxProps(p), clipsContent: p.clipsContent });
    parent.append(f);
    this.mark(p.name);
    return f;
  }
  ellipse(parent: FigWrapper, p: BoxSpec): FigWrapper {
    const o: Record<string, unknown> = { name: p.name, x: num(p.x), y: num(p.y), width: Math.max(0.01, num(p.w)), height: Math.max(0.01, num(p.h)), fills: p.fill ? [paint(p.fill)] : [], strokes: p.stroke ? [paint(p.stroke.color)] : [] };
    if (p.stroke) o.strokeWeight = p.stroke.weight;
    const e = this.fig.ellipse(o);
    parent.append(e);
    this.mark(p.name);
    return e;
  }
  // Vector networks are not exposed by the builder: generated SVG (numbers only).
  async path(parent: FigWrapper, p: PathSpec): Promise<FigWrapper> {
    this.unsupported.add("vector networks (shapes and sitemap edges drawn as generated SVG polylines instead)");
    const hex = (c: { r: number; g: number; b: number }) => `#${[c.r, c.g, c.b].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("")}`;
    const strokeHex = p.stroke ? (isStroke(p.stroke) ? (paint(p.stroke.color) as { color: { r: number; g: number; b: number } }).color : p.stroke) : null;
    const sw = p.stroke ? p.stroke.weight : 0;
    const pts = (list: { x: number; y: number }[]) => list.map((q) => `${num(q.x)},${num(q.y)}`).join(" ");
    const fill = p.fill ? hex((paint(p.fill) as { color: { r: number; g: number; b: number } }).color) : "none";
    const stroke = strokeHex ? hex(strokeHex) : "none";
    let body = "";
    if (p.mode === "polygon") body = `<polygon points="${pts(p.points)}" fill="${fill}" stroke="none"/>`;
    else if (p.mode === "polyline") body = `<polyline points="${pts(p.points)}" fill="none" stroke="${stroke}" stroke-width="${sw}"/>`;
    else for (let i = 0; i + 1 < p.points.length; i += 2) body += `<line x1="${num(p.points[i]!.x)}" y1="${num(p.points[i]!.y)}" x2="${num(p.points[i + 1]!.x)}" y2="${num(p.points[i + 1]!.y)}" stroke="${stroke}" stroke-width="${sw}"/>`;
    if (p.arrowEnd && p.points.length >= 2) {
      const a = p.points[p.points.length - 2]!;
      const b = p.points[p.points.length - 1]!;
      const dir = Math.sign(b.x - a.x) || 1;
      body += `<polyline points="${num(b.x - dir * 8)},${num(b.y - 5)} ${num(b.x)},${num(b.y)} ${num(b.x - dir * 8)},${num(b.y + 5)}" fill="none" stroke="${stroke}" stroke-width="${sw}"/>`;
    }
    const w = Math.max(1, num(p.w));
    const h = Math.max(1, num(p.h));
    const markup = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" overflow="visible">${body}</svg>`;
    const s = this.fig.svg(markup, { name: p.name, x: num(p.x), y: num(p.y), width: w, height: h });
    parent.append(s);
    this.mark(p.name);
    return s;
  }
  svg(parent: FigWrapper, markup: string, p: { name: string; x: number; y: number }): FigWrapper {
    const s = this.fig.svg(markup, { name: p.name, x: num(p.x), y: num(p.y) });
    parent.append(s);
    this.mark(p.name);
    return s;
  }
  hasImage(assetId: string): boolean {
    if (Object.prototype.hasOwnProperty.call(this.imageHashes, assetId)) return true;
    this.unsupported.add("image fills without an origin-supplied image-hash mapping (labelled placeholders created instead; the connector does not create image hashes)");
    return false;
  }
  describe(n: FigWrapper, text: string) {
    n.set({ description: text });
    this.markSet();
  }
  hide(n: FigWrapper) {
    n.set({ visible: false, locked: true });
    this.markSet();
  }
  component(parent: FigWrapper | null, p: FrameSpec & { description?: string }): FigWrapper {
    const c = this.fig.component({ ...this.boxProps(p), clipsContent: p.clipsContent, ...(p.description !== undefined ? { description: p.description } : {}) });
    if (parent) parent.append(c);
    this.mark(p.name);
    return c;
  }
  async instance(parent: FigWrapper, comp: FigWrapper, p: { x: number; y: number }): Promise<FigWrapper> {
    await this.flush();
    const inst = this.fig.instance(comp.node.id, { x: num(p.x), y: num(p.y) });
    parent.append(inst);
    this.mark("instance");
    return inst;
  }
  async override(inst: FigWrapper, child: { name: string; type: string }, patch: { fills?: Paint | null; strokes?: Paint }): Promise<boolean> {
    if (/["\\\]\[]/.test(child.name)) {
      this.unsupported.add("instance overrides on children whose names contain quotes or brackets");
      return false;
    }
    await this.flush();
    const props: Record<string, unknown> = {};
    if (patch.fills !== undefined) props.fills = patch.fills ? [paint(patch.fills)] : [];
    if (patch.strokes) props.strokes = [paint(patch.strokes)];
    inst.query(`${child.type}[name="${child.name}"]`).set(props);
    this.markSet();
    return true;
  }
  async variants(parent: FigWrapper, comps: FigWrapper[], p: { name: string; x: number; y: number; gap: number }): Promise<FigWrapper> {
    // figma-use signature: options first, children second. Grid + resize after a flush.
    const set = this.fig.variants({ name: p.name }, comps);
    parent.append(set);
    this.mark(p.name);
    await this.flush();
    let x = 0;
    let h = 1;
    for (const c of comps) {
      c.set({ x, y: 0 });
      x += c.node.width + p.gap;
      h = Math.max(h, c.node.height);
    }
    set.set({ x: num(p.x), y: num(p.y), width: Math.max(1, num(x - p.gap)), height: num(h) });
    this.markSet();
    await this.flush();
    return set;
  }
  async reaction(src: FigWrapper, dest: FigWrapper) {
    // Reactions are not exposed by the builder: raw, post-flush only.
    this.assertFlushed("reaction");
    if (typeof src.node.setReactionsAsync !== "function") throw new Error("setReactionsAsync unavailable on the flushed node");
    await src.node.setReactionsAsync([{ trigger: { type: "ON_CLICK" }, actions: [{ type: "NODE", destinationId: dest.node.id, navigation: "CHANGE_TO", transition: null }] }]);
  }
  meta() {
    this.unsupported.add("pluginData provenance (recorded in node names, component descriptions and the job result instead)");
  }
  async group() {
    this.unsupported.add("grouping sitemap edges (edges stay as separate layers)");
  }
  async flush() {
    if (this.pending === 0 && this.pendingSets === 0) return;
    await this.fig.done();
    this.pending = 0;
    this.pendingSets = 0;
  }
  width(n: FigWrapper) {
    this.assertFlushed("width read");
    return n.node.width;
  }
  height(n: FigWrapper) {
    this.assertFlushed("height read");
    return n.node.height;
  }
  setLetterSpacing(n: FigWrapper, px: number) {
    n.set({ letterSpacing: { unit: "PIXELS", value: px } });
    this.markSet();
  }
  setCharacters(n: FigWrapper, chars: string) {
    n.set({ characters: chars });
    this.markSet();
  }
  async availableFonts() {
    return new Set((await this.raw.listAvailableFontsAsync()).map((f) => `${f.fontName.family}|${f.fontName.style}`));
  }
  async loadFont(f: { family: string; style: string }) {
    await this.raw.loadFontAsync(f);
  }
  // Raw read (post-flush): exactly one node on the current page with this name.
  findUnique(name: string, type?: string): FigWrapper | null {
    this.assertFlushed("lookup");
    const hits = this.raw.currentPage.findAll((n) => n.name === name && (!type || n.type === type));
    if (hits.length > 1) throw new Error(`ambiguous: ${hits.length} nodes named ${JSON.stringify(name)} on this page`);
    return hits.length ? this.fig.get(hits[0]!.id) : null;
  }
  // Raw read (post-flush): exactly one descendant of `parent` with this name/type.
  findIn(parent: FigWrapper, name: string, type: string): FigWrapper | null {
    this.assertFlushed("lookup");
    const hits: { id: string }[] = [];
    const walk = (n: { id: string; name: string; type: string; children?: readonly unknown[] }) => {
      for (const c of (n.children ?? []) as { id: string; name: string; type: string; children?: readonly unknown[] }[]) {
        if (c.name === name && c.type === type) hits.push(c);
        walk(c);
      }
    };
    walk(parent.node as unknown as { id: string; name: string; type: string; children?: readonly unknown[] });
    if (hits.length > 1) throw new Error(`ambiguous: ${hits.length} ${type} nodes named ${JSON.stringify(name)}`);
    return hits.length ? this.fig.get(hits[0]!.id) : null;
  }
  bottomOf(root: FigWrapper): number {
    this.assertFlushed("bounds read");
    return Math.max(0, ...(root.node.children ?? []).map((c) => c.y + c.height));
  }
}
