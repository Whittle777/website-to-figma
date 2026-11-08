// Pure layout planning shared by the plugin and tests (no Figma or Node APIs).
//  - planComponents: which nav/footer/card structures repeat, keyed by a
//    deterministic content (nav/footer) or shape (card) signature.
//  - placeSitemap: non-overlapping tree placement of measured page frames and
//    orthogonal edge polylines between them.
import type { Card, FooterBlock, NavBlock, Page } from "./schema";
import { fnv1a } from "./text";

export interface ContentGroup<T> {
  signature: string;
  content: T;
  pageIds: string[];
  // A component is only created when the identical structure repeats.
  isComponent: boolean;
}

export type CardShape = "title+text" | "title" | "text";

export interface CardShapeGroup {
  shape: CardShape;
  count: number;
  isComponent: boolean;
}

export interface ComponentPlan {
  navs: ContentGroup<NavBlock>[];
  footers: ContentGroup<FooterBlock>[];
  cardShapes: CardShapeGroup[];
  navByPage: Map<string, string>;
  footerByPage: Map<string, string>;
}

export function navSignature(nav: NavBlock): string {
  return "nav-" + fnv1a(["nav", ...nav.items].join("\u001f"));
}

export function footerSignature(footer: FooterBlock): string {
  return "footer-" + fnv1a(["footer", ...footer.items, "\u001e", footer.text].join("\u001f"));
}

export function cardShape(card: Card): CardShape {
  if (card.title && card.text) return "title+text";
  return card.title ? "title" : "text";
}

function group<T>(pages: Page[], get: (p: Page) => T | null, sig: (t: T) => string) {
  const groups = new Map<string, ContentGroup<T>>();
  const byPage = new Map<string, string>();
  for (const p of pages) {
    const content = get(p);
    if (!content) continue;
    const s = sig(content);
    byPage.set(p.id, s);
    const g = groups.get(s);
    if (g) g.pageIds.push(p.id);
    else groups.set(s, { signature: s, content, pageIds: [p.id], isComponent: false });
  }
  // Map preserves first-seen (page) order, which is deterministic.
  const list = [...groups.values()];
  for (const g of list) g.isComponent = g.pageIds.length >= 2;
  return { list, byPage };
}

export function planComponents(pages: Page[]): ComponentPlan {
  const navs = group(pages, (p) => p.nav, navSignature);
  const footers = group(pages, (p) => p.footer, footerSignature);
  const counts = new Map<CardShape, number>();
  for (const p of pages) {
    for (const b of p.blocks) {
      if (b.type !== "cards") continue;
      for (const c of b.cards) counts.set(cardShape(c), (counts.get(cardShape(c)) ?? 0) + 1);
    }
  }
  const order: CardShape[] = ["title+text", "title", "text"];
  const cardShapes = order
    .filter((s) => counts.has(s))
    .map((shape) => ({ shape, count: counts.get(shape)!, isComponent: counts.get(shape)! >= 2 }));
  return { navs: navs.list, footers: footers.list, cardShapes, navByPage: navs.byPage, footerByPage: footers.byPage };
}

export interface Size {
  w: number;
  h: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface EdgePlan {
  from: string;
  to: string;
  points: Point[];
}

export interface SitemapPlacement {
  frames: Map<string, Rect>;
  edges: EdgePlan[];
  bounds: Rect;
}

export const COLUMN_GAP = 160;
export const ROW_GAP = 80;
const ANCHOR_Y = 40;

// Columns by tree depth; within a column, depth-first order, each child placed
// no higher than its parent and below everything already in that column.
export function placeSitemap(pages: Page[], sizes: Map<string, Size>, origin: Point): SitemapPlacement {
  const children = new Map<string, Page[]>();
  for (const p of pages) {
    if (p.parentId === null) continue;
    const list = children.get(p.parentId) ?? [];
    list.push(p);
    children.set(p.parentId, list);
  }
  const maxDepth = pages.reduce((m, p) => Math.max(m, p.depth), 0);
  const colWidth: number[] = new Array(maxDepth + 1).fill(0);
  for (const p of pages) colWidth[p.depth] = Math.max(colWidth[p.depth]!, sizeOf(sizes, p.id).w);
  const colX: number[] = [];
  let x = origin.x;
  for (let d = 0; d <= maxDepth; d++) {
    colX.push(x);
    x += colWidth[d]! + COLUMN_GAP;
  }

  const frames = new Map<string, Rect>();
  const cursor: number[] = new Array(maxDepth + 1).fill(origin.y);
  const visit = (p: Page, parentY: number) => {
    const s = sizeOf(sizes, p.id);
    const y = Math.max(cursor[p.depth]!, parentY);
    frames.set(p.id, { x: colX[p.depth]!, y, w: s.w, h: s.h });
    cursor[p.depth] = y + s.h + ROW_GAP;
    for (const c of children.get(p.id) ?? []) visit(c, y);
  };
  const root = pages.find((p) => p.parentId === null);
  if (root) visit(root, origin.y);

  const edges: EdgePlan[] = [];
  for (const p of pages) {
    if (p.parentId === null) continue;
    const a = frames.get(p.parentId);
    const b = frames.get(p.id);
    if (!a || !b) continue;
    const start = { x: a.x + a.w, y: a.y + Math.min(ANCHOR_Y, a.h / 2) };
    const end = { x: b.x, y: b.y + Math.min(ANCHOR_Y, b.h / 2) };
    const midX = colX[p.depth]! - COLUMN_GAP / 2;
    const raw = [start, { x: midX, y: start.y }, { x: midX, y: end.y }, end];
    edges.push({ from: p.parentId, to: p.id, points: raw.filter((pt, i) => i === 0 || pt.x !== raw[i - 1]!.x || pt.y !== raw[i - 1]!.y) });
  }

  let maxX = origin.x;
  let maxY = origin.y;
  for (const r of frames.values()) {
    maxX = Math.max(maxX, r.x + r.w);
    maxY = Math.max(maxY, r.y + r.h);
  }
  return { frames, edges, bounds: { x: origin.x, y: origin.y, w: maxX - origin.x, h: maxY - origin.y } };
}

function sizeOf(sizes: Map<string, Size>, id: string): Size {
  const s = sizes.get(id);
  if (!s || !(s.w > 0) || !(s.h > 0)) throw new Error(`Missing size for page ${id}`);
  return s;
}

export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

// Simple row-wrapping placement for the separate components area.
export function placeRow(sizes: Size[], origin: Point, maxWidth: number, gap = 60): { rects: Rect[]; bounds: Rect } {
  const rects: Rect[] = [];
  let x = origin.x;
  let y = origin.y;
  let rowH = 0;
  for (const s of sizes) {
    if (x > origin.x && x + s.w > origin.x + maxWidth) {
      x = origin.x;
      y += rowH + gap;
      rowH = 0;
    }
    rects.push({ x, y, w: s.w, h: s.h });
    x += s.w + gap;
    rowH = Math.max(rowH, s.h);
  }
  let maxX = origin.x;
  let maxY = origin.y;
  for (const r of rects) {
    maxX = Math.max(maxX, r.x + r.w);
    maxY = Math.max(maxY, r.y + r.h);
  }
  return { rects, bounds: { x: origin.x, y: origin.y, w: maxX - origin.x, h: maxY - origin.y } };
}
