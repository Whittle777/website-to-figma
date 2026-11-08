// Shared renderer contract. The renderer (renderer.ts) only talks to a Host;
// the native plugin host (nativeHost.ts) uses figma.create*, the connector
// host (src/connector/plannedHost.ts) uses $fig plan constructors. Handles are
// opaque. Geometry is the measured absolute desktop layout (no auto layout):
// positions/sizes come from the validated document, never invented.
import type { Paint } from "../../../src/shared/hifiSchema";

export type Radii = [number, number, number, number];
export interface Stroke {
  color: Paint;
  weight: number;
}
export interface BoxSpec {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  fill: Paint | null;
  // custom solid paint (r,g,b 0..1) for placeholders
  rawFill?: { r: number; g: number; b: number; opacity?: number } | null;
  stroke?: Stroke | null;
  rawStroke?: { r: number; g: number; b: number; weight: number; dash?: [number, number] } | null;
  radius?: Radii;
  opacity?: number;
  // verified embedded image fill (only when host.hasImage(assetId))
  image?: { assetId: string; mode: "FILL" | "FIT" };
  // placeholder styling when an image is missing or unavailable in this host
  placeholder?: "missing" | "media";
}
export interface FrameSpec extends BoxSpec {
  clipsContent: boolean;
}
export interface TextSpec {
  name: string;
  x: number;
  y: number;
  characters: string;
  font: { family: string; style: string };
  size: number;
  lineHeight?: number;
  color: Paint | null; // null = default black label
  decoration?: "NONE" | "UNDERLINE" | "STRIKETHROUGH";
  // fixed width with height auto-resize (labels, right-aligned markers)
  width?: number;
  align?: "LEFT" | "RIGHT";
}
export interface PathSpec {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  // polyline/polygon in local coordinates
  points: { x: number; y: number }[];
  // polygon = closed filled shape; polyline = connected segments; pairs = independent strokes (p0-p1, p2-p3, ...)
  mode: "polygon" | "polyline" | "pairs";
  fill: Paint | null;
  stroke: { r: number; g: number; b: number; weight: number } | Stroke | null;
  arrowEnd?: boolean;
}

export interface Host<N> {
  readonly kind: "native" | "planned";
  // Records features this host cannot provide (reported, never faked).
  readonly unsupported: Set<string>;
  root(p: { name: string; x: number; y: number }): N;
  resizeRoot(root: N, w: number, h: number): Promise<void>;
  text(parent: N, p: TextSpec): N;
  rect(parent: N, p: BoxSpec): N;
  frame(parent: N, p: FrameSpec): N;
  ellipse(parent: N, p: BoxSpec): N;
  path(parent: N, p: PathSpec): Promise<N>;
  svg(parent: N, markup: string, p: { name: string; x: number; y: number }): N;
  // True when a verified embedded image can be filled by this host.
  hasImage(assetId: string): boolean;
  hide(n: N): void;
  // parent null = UNPARENTED (state variant children: only the combined set is appended)
  component(parent: N | null, p: FrameSpec & { description?: string }): N;
  instance(parent: N, comp: N, p: { x: number; y: number }): Promise<N>;
  // Paint override on an instance child found by its exact name and type.
  override(inst: N, child: { name: string; type: string }, patch: { fills?: Paint | null; strokes?: Paint }): Promise<boolean>;
  variants(parent: N, comps: N[], p: { name: string; x: number; y: number; gap: number }): Promise<N>;
  reaction(src: N, dest: N): Promise<void>;
  meta(n: N, data: unknown): void;
  group(parent: N, nodes: N[], name: string): Promise<void>;
  // Flush pending plan nodes (no-op natively); reads below require a flush.
  flush(): Promise<void>;
  width(n: N): number;
  height(n: N): number;
  setLetterSpacing(n: N, px: number): void;
  setCharacters(n: N, chars: string): void;
  availableFonts(): Promise<Set<string>>;
  loadFont(f: { family: string; style: string }): Promise<void>;
}
