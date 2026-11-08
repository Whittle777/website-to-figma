// Native Figma plugin host: real Plugin API calls (figma.create*), every
// created node tracked for rollback. Image fills only from bytes verified by
// verifyAssets (length, SHA-256, header, size) and registered via createImage.
import type { Paint } from "../../../src/shared/hifiSchema";
import type { BoxSpec, FrameSpec, Host, PathSpec, Stroke, TextSpec } from "./host";

type Track = <T extends SceneNode>(n: T) => T;
type Parent = BaseNode & ChildrenMixin;

export function solid(p: Paint): SolidPaint {
  const n = parseInt(p.hex.slice(1), 16);
  return { type: "SOLID", color: { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 }, opacity: p.alpha };
}
const isStroke = (s: unknown): s is Stroke => typeof s === "object" && s !== null && "color" in s;

export class NativeHost implements Host<SceneNode> {
  readonly kind = "native" as const;
  readonly unsupported = new Set<string>();
  constructor(
    private track: Track,
    private hashes: Map<string, string>,
  ) {}

  private box(n: RectangleNode | FrameNode | ComponentNode | EllipseNode, p: BoxSpec) {
    n.name = p.name;
    n.x = p.x;
    n.y = p.y;
    n.resize(Math.max(0.01, p.w), Math.max(0.01, p.h));
    if (p.image) {
      n.fills = [{ type: "IMAGE", imageHash: this.hashes.get(p.image.assetId)!, scaleMode: p.image.mode }];
    } else if (p.placeholder === "missing") {
      n.fills = [{ type: "SOLID", color: { r: 0.93, g: 0.93, b: 0.93 } }];
      n.strokes = [{ type: "SOLID", color: { r: 0.8, g: 0.2, b: 0.2 } }];
      n.strokeWeight = 1;
      n.dashPattern = [6, 4];
    } else if (p.placeholder === "media") {
      n.fills = [{ type: "SOLID", color: { r: 0.85, g: 0.85, b: 0.85 }, opacity: 0.6 }];
      n.dashPattern = [6, 4];
      n.strokes = [{ type: "SOLID", color: { r: 0.4, g: 0.4, b: 0.4 } }];
      n.strokeWeight = 1;
    } else {
      n.fills = p.fill ? [solid(p.fill)] : [];
      if (p.stroke !== undefined) {
        if (p.stroke) {
          n.strokes = [solid(p.stroke.color)];
          n.strokeWeight = p.stroke.weight;
          n.strokeAlign = "INSIDE";
        } else n.strokes = [];
      }
    }
    if (p.radius && n.type !== "ELLIPSE") {
      n.topLeftRadius = p.radius[0];
      n.topRightRadius = p.radius[1];
      n.bottomRightRadius = p.radius[2];
      n.bottomLeftRadius = p.radius[3];
    }
    if (p.opacity !== undefined) n.opacity = p.opacity;
  }

  root(p: { name: string; x: number; y: number }): SceneNode {
    const s = this.track(figma.createSection());
    s.name = p.name;
    s.x = p.x;
    s.y = p.y;
    return s;
  }
  async resizeRoot(root: SceneNode, w: number, h: number) {
    (root as SectionNode).resizeWithoutConstraints(w, h);
  }
  text(parent: SceneNode, p: TextSpec): SceneNode {
    const t = this.track(figma.createText());
    (parent as unknown as Parent).appendChild(t);
    t.name = p.name;
    t.fontName = p.font;
    t.characters = p.characters;
    t.fontSize = p.size;
    if (p.lineHeight !== undefined) t.lineHeight = { unit: "PIXELS", value: p.lineHeight };
    if (p.color) t.fills = [solid(p.color)];
    if (p.decoration) t.textDecoration = p.decoration;
    t.x = p.x;
    t.y = p.y;
    if (p.width !== undefined) {
      t.textAutoResize = "HEIGHT";
      t.resize(p.width, t.height);
      if (p.align === "RIGHT") t.textAlignHorizontal = "RIGHT";
    } else if (p.color) t.textAutoResize = "WIDTH_AND_HEIGHT";
    return t;
  }
  rect(parent: SceneNode, p: BoxSpec): SceneNode {
    const r = this.track(figma.createRectangle());
    (parent as unknown as Parent).appendChild(r);
    this.box(r, p);
    return r;
  }
  frame(parent: SceneNode, p: FrameSpec): SceneNode {
    const f = this.track(figma.createFrame());
    (parent as unknown as Parent).appendChild(f);
    this.box(f, p);
    f.clipsContent = p.clipsContent;
    return f;
  }
  ellipse(parent: SceneNode, p: BoxSpec): SceneNode {
    const e = this.track(figma.createEllipse());
    (parent as unknown as Parent).appendChild(e);
    e.name = p.name;
    e.x = p.x;
    e.y = p.y;
    e.resize(Math.max(0.01, p.w), Math.max(0.01, p.h));
    e.fills = p.fill ? [solid(p.fill)] : [];
    e.strokes = p.stroke ? [solid(p.stroke.color)] : [];
    if (p.stroke) e.strokeWeight = p.stroke.weight;
    return e;
  }
  async path(parent: SceneNode, p: PathSpec): Promise<SceneNode> {
    const v = this.track(figma.createVector());
    (parent as unknown as Parent).appendChild(v);
    v.name = p.name;
    const n = p.points.length;
    const segments = p.mode === "polygon" ? p.points.map((_, i) => ({ start: i, end: (i + 1) % n })) : p.mode === "polyline" ? p.points.slice(1).map((_, i) => ({ start: i, end: i + 1 })) : Array.from({ length: Math.floor(n / 2) }, (_, i) => ({ start: 2 * i, end: 2 * i + 1 }));
    await v.setVectorNetworkAsync({
      vertices: p.points.map((pt, i) => (p.arrowEnd && i === n - 1 ? { x: pt.x, y: pt.y, strokeCap: "ARROW_LINES" as const } : { x: pt.x, y: pt.y })),
      segments,
      regions: p.mode === "polygon" ? [{ windingRule: "NONZERO", loops: [p.points.map((_, i) => i)] }] : [],
    });
    v.fills = p.fill ? [solid(p.fill)] : [];
    if (p.stroke) {
      v.strokes = [isStroke(p.stroke) ? solid(p.stroke.color) : { type: "SOLID", color: { r: p.stroke.r, g: p.stroke.g, b: p.stroke.b } }];
      v.strokeWeight = p.stroke.weight;
    } else v.strokes = [];
    v.x = p.x;
    v.y = p.y;
    return v;
  }
  svg(parent: SceneNode, markup: string, p: { name: string; x: number; y: number }): SceneNode {
    const f = this.track(figma.createNodeFromSvg(markup));
    (parent as unknown as Parent).appendChild(f);
    f.name = p.name;
    f.x = p.x;
    f.y = p.y;
    return f;
  }
  hasImage(assetId: string): boolean {
    return this.hashes.has(assetId);
  }
  hide(n: SceneNode) {
    n.visible = false;
    n.locked = true;
  }
  component(parent: SceneNode | null, p: FrameSpec & { description?: string }): SceneNode {
    const c = this.track(figma.createComponent());
    if (parent) (parent as unknown as Parent).appendChild(c);
    this.box(c, p);
    c.clipsContent = p.clipsContent;
    if (p.description !== undefined) c.description = p.description;
    return c;
  }
  async instance(parent: SceneNode, comp: SceneNode, p: { x: number; y: number }): Promise<SceneNode> {
    const inst = this.track((comp as ComponentNode).createInstance());
    (parent as unknown as Parent).appendChild(inst);
    inst.x = p.x;
    inst.y = p.y;
    return inst;
  }
  async override(inst: SceneNode, child: { name: string; type: string }, patch: { fills?: Paint | null; strokes?: Paint }): Promise<boolean> {
    const target = (inst as InstanceNode).findOne((n) => n.name === child.name);
    if (!target || !("fills" in target)) return false;
    if (patch.fills !== undefined) (target as GeometryMixin).fills = patch.fills ? [solid(patch.fills)] : [];
    if (patch.strokes) (target as GeometryMixin).strokes = [solid(patch.strokes)];
    return true;
  }
  async variants(parent: SceneNode, comps: SceneNode[], p: { name: string; x: number; y: number }): Promise<SceneNode> {
    const set = this.track(figma.combineAsVariants(comps as ComponentNode[], parent as unknown as BaseNode & ChildrenMixin));
    set.name = p.name;
    set.x = p.x;
    set.y = p.y;
    return set;
  }
  async reaction(src: SceneNode, dest: SceneNode) {
    const action: Action = { type: "NODE", destinationId: dest.id, navigation: "CHANGE_TO", transition: null };
    const reaction: Reaction = { trigger: { type: "ON_CLICK" }, actions: [action] };
    await (src as ComponentNode).setReactionsAsync([reaction]);
  }
  meta(n: SceneNode, data: unknown) {
    n.setPluginData("w2f", JSON.stringify(data));
  }
  async group(parent: SceneNode, nodes: SceneNode[], name: string) {
    const g = this.track(figma.group(nodes, parent as unknown as BaseNode & ChildrenMixin, 0));
    g.name = name;
  }
  async flush() {}
  width(n: SceneNode) {
    return n.width;
  }
  height(n: SceneNode) {
    return n.height;
  }
  setLetterSpacing(n: SceneNode, px: number) {
    (n as TextNode).letterSpacing = { unit: "PIXELS", value: px };
  }
  setCharacters(n: SceneNode, chars: string) {
    (n as TextNode).characters = chars;
  }
  async availableFonts() {
    return new Set((await figma.listAvailableFontsAsync()).map((f) => `${f.fontName.family}|${f.fontName.style}`));
  }
  async loadFont(f: { family: string; style: string }) {
    await figma.loadFontAsync(f);
  }
}
