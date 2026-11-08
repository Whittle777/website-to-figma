import { describe, expect, it } from "vitest";
import { canonicalizeUrl } from "../src/normalize/canonicalize";
import { assertLimit, buildSiteMap, type RawPage } from "../src/normalize/build";
import { extractPage } from "../src/normalize/extract";
import { LIMITS } from "../src/shared/limits";

describe("canonicalizeUrl", () => {
  it.each([
    ["https://Example.COM/About/?utm_source=x&b=2&a=1#team", "https://example.com/About?a=1&b=2"],
    ["https://example.com", "https://example.com/"],
    ["https://example.com//docs//api/", "https://example.com/docs/api"],
    ["http://example.com:80/x?gclid=1&fbclid=2", "http://example.com/x"],
    ["https://example.com./", "https://example.com/"],
  ])("%s -> %s", (input, expected) => {
    expect(canonicalizeUrl(input)).toBe(expected);
  });
});

const page = (url: string, title = "T"): RawPage => ({ url, html: `<title>${title}</title><h1>${title}</h1>` });

describe("limits and caps", () => {
  it("defaults to 10, hard cap 20, rejects >20 instead of silently reducing", () => {
    expect(LIMITS.defaultPages).toBe(10);
    expect(LIMITS.hardMaxPages).toBe(20);
    expect(assertLimit(20)).toBe(20);
    expect(() => assertLimit(21)).toThrow(/hard cap/);
    expect(() => assertLimit(0)).toThrow();
    expect(() => assertLimit(2.5)).toThrow();
  });

  const base = { source: { mode: "fixture" as const, fixtureId: "t", label: "test" }, startUrl: "https://s.example/", incomplete: false, notes: [] };

  it("dedupes canonical variants and reports truncation truthfully", () => {
    const pages = [
      page("https://s.example/"),
      page("https://www.s.example/#top"),
      page("http://s.example/a/"),
      page("https://s.example/a?utm_campaign=z"),
      page("https://s.example/b"),
      page("https://s.example/c"),
      page("https://evil.s.example/"),
    ];
    const doc = buildSiteMap({ ...base, limit: 2, pages, discoveredCount: null });
    expect(doc.pages.map((p) => p.path)).toEqual(["/", "/a"]);
    expect(doc.crawl).toMatchObject({ requestedLimit: 2, returnedCount: 2, truncated: true, incomplete: true, discoveredCount: null });
    expect(doc.crawl.notes.join("\n")).toMatch(/Cap reached: returned 2 of 4\+/);
    expect(doc.crawl.notes.join("\n")).toMatch(/1 page\(s\) dropped: final URL not on the start site/);
  });

  it("treats discovery counts above returned pages as truncated", () => {
    const doc = buildSiteMap({ ...base, limit: 10, pages: [page("https://s.example/")], discoveredCount: 37 });
    expect(doc.crawl).toMatchObject({ truncated: true, discoveredCount: 37, returnedCount: 1 });
  });

  it("is not truncated when everything known was returned", () => {
    const doc = buildSiteMap({ ...base, limit: 10, pages: [page("https://s.example/"), page("https://s.example/x")], discoveredCount: 2 });
    expect(doc.crawl).toMatchObject({ truncated: false, incomplete: false });
  });

  it("builds a path tree with nearest existing ancestor as parent", () => {
    const doc = buildSiteMap({
      ...base,
      limit: 10,
      pages: [page("https://s.example/docs/api/auth"), page("https://s.example/docs"), page("https://s.example/"), page("https://s.example/blog/post")],
      discoveredCount: 4,
    });
    const byPath = new Map(doc.pages.map((p) => [p.path, p]));
    expect(byPath.get("/docs/api/auth")!.parentId).toBe(byPath.get("/docs")!.id);
    expect(byPath.get("/blog/post")!.parentId).toBe("p0");
    expect(byPath.get("/docs/api/auth")!.depth).toBe(2);
  });
});

describe("extractPage", () => {
  it("keeps only bounded plain text and never script/style content", () => {
    const html = `<title>Hi</title><script>alert("x")</script><style>.a{}</style>
      <nav><a>One</a><a>Two</a><a>One</a></nav>
      <h1>Hello <b>world</b></h1><p>${"word ".repeat(200)}</p>
      <div class="cards"><div class="card"><h3>A</h3><p>a</p></div><div class="card"><h3>B</h3></div></div>
      <footer><a>Privacy</a><p>&copy; Co</p></footer>`;
    const ex = extractPage(html, undefined, "/");
    expect(ex.title).toBe("Hi");
    expect(ex.nav).toEqual({ items: ["One", "Two"] });
    expect(ex.footer).toEqual({ items: ["Privacy"], text: "© Co" });
    expect(ex.blocks[0]).toEqual({ type: "heading", level: 1, text: "Hello world" });
    const text = ex.blocks[1];
    expect(text?.type === "text" && text.text.length).toBeLessThanOrEqual(LIMITS.maxTextChars);
    expect(ex.blocks[2]).toEqual({ type: "cards", cards: [{ title: "A", text: "a" }, { title: "B", text: "" }] });
    expect(JSON.stringify(ex)).not.toMatch(/alert|\.a\{\}/);
  });

  it("reads <title> from <head> (distinct from <h1>) and prefers reported metadata title", () => {
    const html = "<!doctype html><html><head><meta charset=utf-8><title>Doc title</title></head><body><h1>Other</h1></body></html>";
    expect(extractPage(html, undefined, "/").title).toBe("Doc title");
    expect(extractPage(html, "Meta title", "/").title).toBe("Meta title");
    expect(extractPage("<body><h1>Only h1</h1></body>", undefined, "/x").title).toBe("Only h1");
    expect(extractPage("<body></body>", undefined, "/x").title).toBe("/x");
  });

  it("bounds oversized and deeply nested HTML", () => {
    const deep = "<div>".repeat(500) + "<h1>deep</h1>" + "</div>".repeat(500);
    expect(extractPage(deep, undefined, "/").truncated).toBe(true);
    const huge = "<p>x</p>".repeat(LIMITS.maxHtmlChars / 8 + 10);
    const ex = extractPage(huge, undefined, "/");
    expect(ex.truncated).toBe(true);
    expect(ex.blocks.length).toBeLessThanOrEqual(LIMITS.maxBlocksPerPage);
  });
});

describe("underfill", () => {
  it("marks results incomplete when merges leave fewer pages than the limit and more may exist", () => {
    const doc = buildSiteMap({
      source: { mode: "firecrawl", startUrl: "https://s.example/" },
      startUrl: "https://s.example/",
      limit: 3,
      pages: [page("https://s.example/"), page("https://www.s.example/"), page("http://s.example/a")],
      discoveredCount: null,
      incomplete: false,
      notes: [],
    });
    expect(doc.pages).toHaveLength(2);
    expect(doc.crawl.incomplete).toBe(true);
    expect(doc.crawl.notes.join("\n")).toMatch(/Underfilled: 2 of limit 3/);
  });
});
