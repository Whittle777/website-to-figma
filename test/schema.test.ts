import { describe, expect, it } from "vitest";
import { parseSiteMapJson, validateSiteMap } from "../src/shared/schema";
import { buildFixture } from "../src/fixtures/generate";
import { LIMITS } from "../src/shared/limits";

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe("validateSiteMap", () => {
  const good = buildFixture(5);

  it("accepts generated documents", () => {
    expect(validateSiteMap(good).ok).toBe(true);
  });

  const reject = (mutate: (d: any) => void, pattern: RegExp) => {
    const d = clone(good) as any;
    mutate(d);
    const r = validateSiteMap(d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join("\n")).toMatch(pattern);
  };

  it("rejects wrong schema id/version and unknown keys", () => {
    reject((d) => (d.schemaVersion = 2), /unsupported version/);
    reject((d) => (d.schema = "other"), /schema/);
    reject((d) => (d.extra = 1), /unknown key "extra"/);
    reject((d) => (d.pages[0].onclick = "x"), /unknown key "onclick"/);
  });

  it("rejects unsafe or malformed URLs and text", () => {
    reject((d) => (d.pages[1].url = "javascript:alert(1)"), /http\(s\) URL/);
    reject((d) => (d.pages[1].url = "https://u:p@fixture.example/"), /http\(s\) URL/);
    reject((d) => (d.pages[1].title = "x\u0000y"), /control characters/);
    reject((d) => (d.pages[1].title = "x".repeat(LIMITS.maxTitleChars + 1)), /longer than/);
  });

  it("enforces count bounds", () => {
    reject((d) => {
      d.pages = Array.from({ length: 21 }, (_, i) => ({ ...d.pages[0], id: `p${i}`, url: `https://fixture.example/${i}` }));
    }, /more than 20 items/);
    reject((d) => (d.pages[0].nav.items = Array(LIMITS.maxNavItems + 1).fill("x")), /more than/);
    reject((d) => (d.pages[0].blocks = Array(LIMITS.maxBlocksPerPage + 1).fill({ type: "text", text: "x" })), /more than/);
    reject((d) => (d.crawl.requestedLimit = 50), /requestedLimit/);
  });

  it("enforces whole-document node budgets", () => {
    const d = clone(buildFixture(20)) as any;
    for (const p of d.pages) p.blocks = Array(15).fill({ type: "cards", cards: Array(12).fill({ title: "t", text: "x" }) });
    const r = validateSiteMap(d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join("\n")).toMatch(/in total/);
  });

  it("enforces tree integrity", () => {
    reject((d) => (d.pages[2].parentId = "p4"), /earlier page/);
    reject((d) => (d.pages[2].parentId = "p9"), /earlier page/);
    reject((d) => (d.pages[1].parentId = null), /exactly one root/);
    reject((d) => (d.pages[1].depth = 3), /parent depth/);
    reject((d) => (d.pages[2].id = "p1"), /duplicate id/);
    reject((d) => (d.crawl.returnedCount = 4), /pages.length/);
  });

  it("parses untrusted text with a size bound", () => {
    expect(parseSiteMapJson("{").ok).toBe(false);
    expect(parseSiteMapJson(" ".repeat(LIMITS.maxJsonBytes + 1)).ok).toBe(false);
    expect(parseSiteMapJson("é".repeat(LIMITS.maxJsonBytes / 2 + 1)).ok).toBe(false);
    expect(parseSiteMapJson(JSON.stringify(good)).ok).toBe(true);
  });
});
