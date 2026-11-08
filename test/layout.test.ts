import { describe, expect, it } from "vitest";
import { buildFixture } from "../src/fixtures/generate";
import { COLUMN_GAP, placeRow, placeSitemap, planComponents, rectsOverlap, type Rect, type Size } from "../src/shared/layout";
import type { Page } from "../src/shared/schema";

// Deterministic fake measurements standing in for Figma's auto-layout heights.
const sizesFor = (pages: Page[]) => new Map<string, Size>(pages.map((p, i) => [p.id, { w: 480, h: 300 + ((i * 97) % 400) }]));

describe("planComponents", () => {
  it("groups nav/footer by exact content signature, not by role", () => {
    const doc = buildFixture(10);
    const plan = planComponents(doc.pages);
    // Site nav on 7 pages, docs nav on 3 pages: two distinct components.
    expect(plan.navs.map((g) => [g.content.items[0], g.pageIds.length, g.isComponent])).toEqual([
      ["Home", 7, true],
      ["Docs home", 3, true],
    ]);
    expect(plan.navs[0]!.signature).not.toBe(plan.navs[1]!.signature);
    expect(plan.footers).toHaveLength(1);
    expect(plan.footers[0]!.pageIds).toHaveLength(10);
    // Signatures are stable across runs.
    expect(planComponents(buildFixture(10).pages).navs.map((g) => g.signature)).toEqual(plan.navs.map((g) => g.signature));
  });

  it("does not make components out of one-off structures", () => {
    const doc = buildFixture(5);
    const pages = doc.pages.map((p, i) => (i === 0 ? { ...p, nav: { items: ["Unique"] } } : p));
    const plan = planComponents(pages);
    expect(plan.navs.find((g) => g.content.items[0] === "Unique")!.isComponent).toBe(false);
  });

  it("groups cards by shape and keeps each card's own text", () => {
    const doc = buildFixture(5);
    const plan = planComponents(doc.pages);
    expect(plan.cardShapes).toEqual([{ shape: "title+text", count: 8, isComponent: true }]);
    const titles = doc.pages.flatMap((p) => p.blocks.flatMap((b) => (b.type === "cards" ? b.cards.map((c) => c.title) : [])));
    expect(new Set(titles).size).toBe(8);
  });
});

describe("placeSitemap", () => {
  for (const size of [5, 10, 20] as const) {
    it(`fixture-${size}: frames never overlap, edges connect frame boundaries`, () => {
      const doc = buildFixture(size);
      const sizes = sizesFor(doc.pages);
      const origin = { x: 80, y: 1000 };
      const placed = placeSitemap(doc.pages, sizes, origin);
      const rects = [...placed.frames.values()];
      expect(rects).toHaveLength(size);
      for (let i = 0; i < rects.length; i++) {
        expect(rects[i]!.y).toBeGreaterThanOrEqual(origin.y);
        for (let j = i + 1; j < rects.length; j++) expect(rectsOverlap(rects[i]!, rects[j]!)).toBe(false);
      }
      expect(placed.edges).toHaveLength(size - 1);
      for (const e of placed.edges) {
        const a = placed.frames.get(e.from)!;
        const b = placed.frames.get(e.to)!;
        const first = e.points[0]!;
        const last = e.points[e.points.length - 1]!;
        expect(first.x).toBe(a.x + a.w);
        expect(first.y).toBeGreaterThanOrEqual(a.y);
        expect(first.y).toBeLessThanOrEqual(a.y + a.h);
        expect(last.x).toBe(b.x);
        expect(last.y).toBeGreaterThanOrEqual(b.y);
        expect(last.y).toBeLessThanOrEqual(b.y + b.h);
        // Orthogonal segments only, and vertical runs stay inside the column gap.
        for (let k = 1; k < e.points.length; k++) {
          const p = e.points[k - 1]!;
          const q = e.points[k]!;
          expect(p.x === q.x || p.y === q.y).toBe(true);
          if (p.x === q.x) {
            for (const r of rects) expect(p.x > r.x && p.x < r.x + r.w).toBe(false);
          }
        }
        expect(b.x - (a.x + a.w)).toBeGreaterThanOrEqual(COLUMN_GAP);
      }
    });
  }

  it("keeps the separate components area clear of the sitemap area", () => {
    const doc = buildFixture(20);
    const comps = placeRow(
      [
        { w: 448, h: 32 },
        { w: 448, h: 60 },
        { w: 136, h: 110 },
      ],
      { x: 80, y: 120 },
      1400,
    );
    const compBottom = comps.bounds.y + comps.bounds.h;
    const placed = placeSitemap(doc.pages, sizesFor(doc.pages), { x: 80, y: compBottom + 240 });
    const pageRects: Rect[] = [...placed.frames.values()];
    for (const c of comps.rects) for (const r of pageRects) expect(rectsOverlap(c, r)).toBe(false);
    for (let i = 0; i < comps.rects.length; i++)
      for (let j = i + 1; j < comps.rects.length; j++) expect(rectsOverlap(comps.rects[i]!, comps.rects[j]!)).toBe(false);
  });

  it("rejects missing or non-positive sizes", () => {
    const doc = buildFixture(5);
    expect(() => placeSitemap(doc.pages, new Map(), { x: 0, y: 0 })).toThrow(/Missing size/);
  });
});
