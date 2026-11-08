import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildFixture, FIXTURE_LABEL, FIXTURE_SIZES } from "../src/fixtures/generate";
import { parseSiteMapJson } from "../src/shared/schema";

describe("synthetic fixtures", () => {
  it.each(FIXTURE_SIZES)("fixture-%i is deterministic, labeled, valid and matches samples/", (size) => {
    const a = JSON.stringify(buildFixture(size), null, 2) + "\n";
    const b = JSON.stringify(buildFixture(size), null, 2) + "\n";
    expect(a).toBe(b);
    expect(readFileSync(`samples/fixture-${size}.json`, "utf8")).toBe(a);
    const r = parseSiteMapJson(a);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc.source).toEqual({ mode: "fixture", fixtureId: `fixture-${size}`, label: FIXTURE_LABEL });
    expect(r.doc.pages).toHaveLength(size);
    expect(r.doc.pages.every((p) => p.url.startsWith("https://fixture.example/"))).toBe(true);
  });

  it("reports cap/incomplete state truthfully per size", () => {
    expect(buildFixture(5).crawl).toMatchObject({ truncated: false, incomplete: false, discoveredCount: 5 });
    expect(buildFixture(10).crawl).toMatchObject({ truncated: false, incomplete: true, discoveredCount: 10 });
    expect(buildFixture(20).crawl).toMatchObject({ truncated: true, incomplete: true, discoveredCount: 22, returnedCount: 20 });
  });
});
