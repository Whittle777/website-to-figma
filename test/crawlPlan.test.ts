import { describe, expect, it } from "vitest";
import type { CrawlJob, CrawlOptions, Document, MapOptions } from "@mendable/firecrawl-js";
import {
  assertCreditBudget,
  buildCrawlRequest,
  buildMapRequest,
  CrawlPolicyError,
  excludeRegex,
  isExcludedPath,
  standardEstimate,
  STRICT_CREDIT_CEILING_SUPPORTED,
  normalizeExcludePrefix,
  normalizeExcludes,
} from "../src/crawl/plan";
import { countDiscovered, executeCrawl, planCrawl, processCrawlDocuments, runCrawl, type CrawlClient, type CrawlRunOptions } from "../src/crawl/firecrawl";

const execute = (o: CrawlRunOptions) => executeCrawl(o, planCrawl(o));
import { buildSiteMap } from "../src/normalize/build";

const EXCLUDES = ["/lessons/", "/faq/", "/login/"];

describe("exclusion prefixes", () => {
  it("normalizes and validates", () => {
    expect(normalizeExcludes(EXCLUDES)).toEqual(["/faq", "/lessons", "/login"]);
    expect(normalizeExcludePrefix("/a/b/")).toBe("/a/b");
    for (const bad of ["lessons", "/", "//x", "/a/../b", "/a b", "/a?x=1", "/a.*", "/(x)", "/x|y"]) {
      expect(() => normalizeExcludePrefix(bad)).toThrow(CrawlPolicyError);
    }
    expect(() => normalizeExcludes(Array.from({ length: 11 }, (_, i) => `/p${i}`))).toThrow(/At most/);
  });

  it("maps to anchored regexes that behave the same under search or full-match, with or without a leading slash", () => {
    const re = excludeRegex("/lessons");
    expect(re).toBe("^/?lessons(?:/.*)?$");
    const rx = new RegExp(re);
    for (const path of ["/lessons", "/lessons/", "/lessons/page/2", "lessons/x"]) expect(rx.test(path)).toBe(true);
    for (const path of ["/lessons-old", "/x/lessons", "/lesson", "/", "/pages/lessons"]) expect(rx.test(path)).toBe(false);
    expect(excludeRegex("/a.b")).toBe("^/?a\\.b(?:/.*)?$");
  });

  it("local final-URL rule matches the same paths", () => {
    const p = normalizeExcludes(EXCLUDES);
    expect(isExcludedPath("/lessons", p)).toBe(true);
    expect(isExcludedPath("/faq/q1", p)).toBe(true);
    expect(isExcludedPath("/login-help", p)).toBe(false);
    expect(isExcludedPath("/pages/simple", p)).toBe(false);
  });
});

describe("request objects (built before any API call)", () => {
  it("pins standard-only, same-domain, query-collapsing crawl settings", () => {
    const req = buildCrawlRequest(10, normalizeExcludes(EXCLUDES));
    expect(req).toEqual({
      limit: 10,
      allowSubdomains: false,
      allowExternalLinks: false,
      crawlEntireDomain: false,
      maxDiscoveryDepth: 3,
      sitemap: "include",
      ignoreQueryParameters: true,
      deduplicateSimilarURLs: true,
      regexOnFullURL: false,
      excludePaths: ["^/?faq(?:/.*)?$", "^/?lessons(?:/.*)?$", "^/?login(?:/.*)?$"],
      scrapeOptions: {
        formats: ["html"],
        onlyMainContent: false,
        timeout: 20_000,
        blockAds: true,
        removeBase64Images: true,
        parsers: [],
        proxy: "basic",
        threatProtection: { mode: "off" },
      },
    });
    expect(buildCrawlRequest(10, [])).not.toHaveProperty("excludePaths");
    expect(buildMapRequest()).toMatchObject({ includeSubdomains: false, ignoreQueryParameters: true, threatProtection: { mode: "off" } });
  });
});

describe("strict credit gate (fail closed)", () => {
  it("reports a standard estimate separately from any guarantee", () => {
    expect(standardEstimate(10, true)).toBe(11);
    expect(standardEstimate(10, false)).toBe(10);
  });

  it("has no enforceable provider ceiling, so every bounded budget is refused", () => {
    expect(STRICT_CREDIT_CEILING_SUPPORTED).toBe(false);
    expect(() => assertCreditBudget(10, true, undefined)).toThrow(/--max-credits is required/);
    expect(() => assertCreditBudget(10, true, 0)).toThrow(CrawlPolicyError);
    expect(() => assertCreditBudget(20, true, 20)).toThrow(/standard estimate 21 credits already exceeds --max-credits 20/);
    for (const max of [10, 20, 1000]) {
      expect(() => assertCreditBudget(10, false, max)).toThrow(/strict credit ceiling cannot be guaranteed/);
      expect(() => assertCreditBudget(10, false, max)).toThrow(/Standard estimate, not a guarantee: 10 credits/);
    }
  });

  it("runCrawl makes zero Firecrawl calls (not even the balance read) for any --max-credits", async () => {
    const calls: string[] = [];
    const spy = (name: string) => async () => {
      calls.push(name);
      throw new Error(`unexpected ${name}`);
    };
    const client = {
      getCreditUsage: spy("credits"),
      map: spy("map"),
      startCrawl: spy("startCrawl"),
      getCrawlStatus: spy("status"),
      cancelCrawl: spy("cancel"),
      getCrawlErrors: spy("errors"),
    } as unknown as CrawlClient;
    const resolverCalls: string[] = [];
    const resolver = async (h: string) => {
      resolverCalls.push(h);
      return ["93.184.215.14"];
    };
    const common = { url: "https://www.scrape.example.com/", limit: 10, timeoutSec: 10, apiKey: "unused", client, resolver, useMap: false, excludes: EXCLUDES };
    for (const maxCredits of [undefined, 9, 10, 20, 1000]) {
      await expect(runCrawl({ ...common, maxCredits })).rejects.toBeInstanceOf(CrawlPolicyError);
    }
    expect(calls).toEqual([]);
    expect(resolverCalls).toEqual([]);
  });
});

describe("internal request flow via executeCrawl (fake client, no network)", () => {
  const publicDns = async () => ["93.184.215.14"];
  const site = "https://www.scrape.example.com";
  const page = (path: string, extra: Record<string, unknown> = {}): Document => ({
    html: `<title>${path}</title><h1>${path}</h1>`,
    metadata: { url: site + path, statusCode: 200, ...extra },
  });

  function fake(opts: { remaining?: unknown; creditsFail?: boolean; docs?: Document[]; creditsUsed?: number } = {}) {
    const calls: string[] = [];
    let crawlReq: CrawlOptions | undefined;
    let mapReq: MapOptions | undefined;
    const client: CrawlClient = {
      getCreditUsage: async () => {
        calls.push("credits");
        if (opts.creditsFail) throw new Error("401");
        return { remainingCredits: opts.remaining as number };
      },
      map: async (_u, o) => {
        calls.push("map");
        mapReq = o;
        return { links: ["/", "/pages", "/lessons/1", "/faq", "/pages?page=2", "https://evil.scrape.example.com/"].map((p) => ({ url: p.startsWith("http") ? p : site + p })) };
      },
      startCrawl: async (_u, r) => {
        calls.push("startCrawl");
        crawlReq = r;
        return { id: "j" };
      },
      getCrawlStatus: async () => {
        calls.push("status");
        const data = opts.docs ?? [page("/")];
        return { id: "j", status: "completed", total: data.length, completed: data.length, creditsUsed: opts.creditsUsed, data } as CrawlJob;
      },
      cancelCrawl: async () => {
        calls.push("cancel");
        return true;
      },
      getCrawlErrors: async () => ({ errors: [], robotsBlocked: [] }),
    };
    return { client, calls, req: () => crawlReq, mapReq: () => mapReq };
  }
  const base = { url: site + "/", limit: 10, timeoutSec: 10, apiKey: "test", resolver: publicDns, sleep: async () => {} };

  it("refuses before any client call when the budget is missing or too small", async () => {
    for (const maxCredits of [undefined, 10]) {
      const f = fake({ remaining: 100 });
      await expect(runCrawl({ ...base, client: f.client, maxCredits })).rejects.toBeInstanceOf(CrawlPolicyError);
      expect(f.calls).toEqual([]);
    }
  });

  it("refuses when an exclusion is invalid or covers the start URL, before any client call", async () => {
    const f = fake({ remaining: 100 });
    await expect(runCrawl({ ...base, client: f.client, maxCredits: 20, excludes: ["faq"] })).rejects.toThrow(/must be a path/);
    await expect(execute({ ...base, url: site + "/faq", client: f.client, maxCredits: 20, excludes: ["/faq"] })).rejects.toThrow(/start URL/);
    expect(f.calls).toEqual([]);
  });

  it("refuses after only the balance read when the balance is short, unknown or unreadable", async () => {
    for (const f of [fake({ remaining: 10 }), fake({ remaining: undefined }), fake({ remaining: "100" }), fake({ creditsFail: true })]) {
      await expect(execute({ ...base, client: f.client, maxCredits: 20 })).rejects.toBeInstanceOf(CrawlPolicyError);
      expect(f.calls).toEqual(["credits"]);
    }
  });

  it("sends exclusions in the crawl request and filters excluded/off-site final URLs locally", async () => {
    const f = fake({ remaining: 100, docs: [page("/"), page("/pages"), page("/lessons/x"), page("/pages?page=2"), page("/faq")] });
    const doc = await execute({ ...base, client: f.client, maxCredits: 20, excludes: EXCLUDES });
    expect(f.calls.slice(0, 3)).toEqual(["credits", "map", "startCrawl"]);
    expect(f.req()?.excludePaths).toEqual(["^/?faq(?:/.*)?$", "^/?lessons(?:/.*)?$", "^/?login(?:/.*)?$"]);
    expect(f.req()?.scrapeOptions).toMatchObject({ parsers: [], proxy: "basic", threatProtection: { mode: "off" } });
    expect(doc.pages.map((p) => p.path)).toEqual(["/", "/pages"]);
    const notes = doc.crawl.notes.join("\n");
    expect(notes).toMatch(/2 page\(s\) dropped: excluded path \(fetched despite exclusion\)/);
    expect(notes).toMatch(/1 duplicate URL\(s\) merged/);
    // map count: "/", "/pages" (query variant collapsed); excluded and subdomain links not counted.
    expect(doc.crawl.discoveredCount).toBe(2);
    expect(f.mapReq()).toMatchObject({ includeSubdomains: false });
  });

  it("--no-map skips discovery entirely and reports the count as unknown", async () => {
    const f = fake({ remaining: 10 });
    const doc = await execute({ ...base, client: f.client, maxCredits: 10, useMap: false });
    expect(f.calls).not.toContain("map");
    expect(f.calls[0]).toBe("credits");
    expect(doc.crawl.discoveredCount).toBeNull();
    expect(doc.crawl.notes.join("\n")).toMatch(/Discovery skipped/);
  });

  it("reports creditsUsed telemetry without treating it as a ceiling", async () => {
    const f = fake({ remaining: 100, creditsUsed: 3 });
    const doc = await execute({ ...base, client: f.client, maxCredits: 20 });
    expect(doc.crawl.notes.join("\n")).toMatch(/creditsUsed: 3 \(standard estimate for this run: 11\)/);
  });
});

describe("exact same-domain and query behaviour", () => {
  it("counts discovery with exact host matching and collapsed query variants", () => {
    const start = new URL("https://scrape.example.com/");
    const links = ["https://scrape.example.com/a", "https://scrape.example.com/a?x=1", "https://www.scrape.example.com/b", "https://evil.scrape.example.com/c", "https://scrape.example.com.evil.net/d"];
    expect(countDiscovered({ links: links.map((url) => ({ url })) }, start)).toBe(2);
  });

  it("collapses query variants only when asked, preferring the query-less URL", () => {
    const pages = [
      { url: "https://s.example/", html: "<title>r</title>" },
      { url: "https://s.example/list?page=2", html: "<title>p2</title>" },
      { url: "https://s.example/list", html: "<title>p1</title>" },
    ];
    const common = { source: { mode: "firecrawl" as const, startUrl: "https://s.example/" }, startUrl: "https://s.example/", limit: 10, pages, discoveredCount: 2, incomplete: false, notes: [] };
    expect(buildSiteMap({ ...common, ignoreQueryVariants: true }).pages.map((p) => [p.path, p.title])).toEqual([
      ["/", "r"],
      ["/list", "p1"],
    ]);
    expect(buildSiteMap(common).pages.map((p) => p.path)).toEqual(["/", "/list", "/list?page=2"]);
  });

  it("drops excluded final URLs with the local rule even if the server fetched them", async () => {
    const { pages, dropped } = await processCrawlDocuments(
      [{ html: "<p>x</p>", metadata: { url: "https://s.example.com/login/" } }, { html: "<p>y</p>", metadata: { url: "https://s.example.com/login-help" } }],
      new URL("https://s.example.com/"),
      async () => ["93.184.215.14"],
      ["/login"],
    );
    expect(pages.map((p) => p.url)).toEqual(["https://s.example.com/login-help"]);
    expect(dropped).toEqual({ "excluded path (fetched despite exclusion)": 1 });
  });
});
