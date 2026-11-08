import { describe, expect, it } from "vitest";
import type { CrawlJob, CrawlOptions, Document } from "@mendable/firecrawl-js";
import {
  assertOperatorPrerequisites,
  buildCrawlRequest,
  buildMapRequest,
  CrawlPolicyError,
  excludeRegex,
  isExcludedPath,
  normalizeExcludePrefix,
  normalizeExcludes,
  standardEstimate,
} from "../src/crawl/plan";
import { countDiscovered, executeCrawl, planCrawl, processCrawlDocuments, runCrawl, type CrawlClient, type CrawlRunOptions } from "../src/crawl/firecrawl";
import { buildSiteMap } from "../src/normalize/build";

const execute = (o: CrawlRunOptions) => executeCrawl(o, planCrawl(o));
const EXCLUDES = ["/lessons/", "/faq/", "/login/"];
const AFFIRM = { maxCredits: 1000, reportedBalance: 95_613_091, confirmExistingCredits: true, confirmNoTopup: true };

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
  });
});

describe("request objects (built before any API call)", () => {
  it("pins HTML-only, standard options, sitemap skip, same-domain, no threat override", () => {
    const req = buildCrawlRequest(10, normalizeExcludes(EXCLUDES));
    expect(req).toEqual({
      limit: 10,
      allowSubdomains: false,
      allowExternalLinks: false,
      crawlEntireDomain: false,
      maxDiscoveryDepth: 3,
      sitemap: "skip",
      ignoreQueryParameters: true,
      deduplicateSimilarURLs: true,
      regexOnFullURL: false,
      zeroDataRetention: false,
      excludePaths: ["^/?faq(?:/.*)?$", "^/?lessons(?:/.*)?$", "^/?login(?:/.*)?$"],
      scrapeOptions: {
        formats: ["html"],
        onlyMainContent: false,
        timeout: 20_000,
        blockAds: true,
        removeBase64Images: true,
        parsers: [],
        proxy: "basic",
        lockdown: false,
        checkPromptInjection: false,
        redactPII: false,
      },
    });
    // Team threat policy is never overridden (neither "off" nor anything else).
    expect(JSON.stringify(req)).not.toContain("threatProtection");
    expect(JSON.stringify(buildMapRequest())).not.toContain("threatProtection");
    expect(buildMapRequest()).toMatchObject({ sitemap: "skip", includeSubdomains: false });
  });
});

describe("operator prerequisites (no verification, no API)", () => {
  it("reports a standard estimate that is not a worst case", () => {
    expect(standardEstimate(10, false)).toBe(10);
    expect(standardEstimate(10, true)).toBe(11);
  });

  it("refuses unless every operator input is present and consistent", () => {
    expect(assertOperatorPrerequisites(10, false, AFFIRM)).toBe(10);
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ maxCredits: undefined }, /--max-credits/],
      [{ maxCredits: 5 }, /standard estimate 10 credits already exceeds --max-credits 5/],
      [{ reportedBalance: undefined }, /--operator-reported-balance N is required/],
      [{ reportedBalance: 999 }, /reported balance 999 is below the accepted-risk budget 1000/],
      [{ confirmExistingCredits: false }, /--confirm-existing-credits/],
      [{ confirmNoTopup: undefined }, /--confirm-no-topup/],
    ];
    for (const [patch, msg] of cases) {
      expect(() => assertOperatorPrerequisites(10, false, { ...AFFIRM, ...patch })).toThrow(msg);
    }
  });
});

describe("runCrawl with fake client (no network)", () => {
  const publicDns = async () => ["93.184.215.14"];
  const site = "https://www.scrape.example.com";
  const page = (path: string, extra: Record<string, unknown> = {}): Document => ({
    html: `<title>${path}</title><h1>${path}</h1>`,
    metadata: { url: site + path, statusCode: 200, ...extra },
  });

  function fake(opts: { docs?: Document[]; creditsUsed?: number; startError?: unknown; status?: CrawlJob["status"] } = {}) {
    const calls: string[] = [];
    let crawlReq: CrawlOptions | undefined;
    const client: CrawlClient = {
      map: async () => {
        calls.push("map");
        return { links: [] };
      },
      startCrawl: async (_u, r) => {
        calls.push("startCrawl");
        crawlReq = r;
        if (opts.startError) throw opts.startError;
        return { id: "j" };
      },
      getCrawlStatus: async () => {
        calls.push("status");
        const data = opts.docs ?? [page("/")];
        return { id: "j", status: opts.status ?? "completed", total: data.length, completed: data.length, creditsUsed: opts.creditsUsed, data } as CrawlJob;
      },
      cancelCrawl: async () => {
        calls.push("cancel");
        return true;
      },
      getCrawlErrors: async () => {
        calls.push("errors");
        return { errors: [], robotsBlocked: [] };
      },
    };
    return { client, calls, req: () => crawlReq };
  }
  const base = { url: site + "/", limit: 10, timeoutSec: 10, apiKey: "test", resolver: publicDns, sleep: async () => {}, useMap: false, excludes: EXCLUDES };

  it("makes zero API calls and zero DNS lookups when any gate refuses", async () => {
    const f = fake();
    const dns: string[] = [];
    const resolver = async (h: string) => {
      dns.push(h);
      return ["93.184.215.14"];
    };
    const refusals: Partial<CrawlRunOptions>[] = [
      {},
      { ...AFFIRM, confirmNoTopup: false },
      { ...AFFIRM, confirmExistingCredits: false },
      { ...AFFIRM, reportedBalance: undefined },
      { ...AFFIRM, reportedBalance: 10 },
      { ...AFFIRM, useMap: true },
      { ...AFFIRM, limit: 11 },
      { ...AFFIRM, excludes: ["faq"] },
    ];
    for (const r of refusals) {
      await expect(runCrawl({ ...base, client: f.client, resolver, ...r })).rejects.toBeInstanceOf(CrawlPolicyError);
    }
    expect(f.calls).toEqual([]);
    expect(dns).toEqual([]);
  });

  it("with all affirmations: no map, no account calls, exact request, exclusions filtered locally", async () => {
    const f = fake({ docs: [page("/"), page("/pages"), page("/lessons/x"), page("/pages?page=2")] });
    const doc = await runCrawl({ ...base, client: f.client, ...AFFIRM });
    expect(f.calls).toEqual(["startCrawl", "status", "errors"]);
    expect(f.req()).toEqual(buildCrawlRequest(10, normalizeExcludes(EXCLUDES)));
    expect(doc.pages.map((p) => p.path)).toEqual(["/", "/pages"]);
    expect(doc.crawl.discoveredCount).toBeNull();
    expect(doc.crawl.notes.join("\n")).toMatch(/excluded path \(fetched despite exclusion\)/);
  });

  for (const status of [402, 403]) {
    it(`stops immediately on ${status} from startCrawl: one attempt, no retry, no cancel`, async () => {
      const f = fake({ startError: Object.assign(new Error("refused"), { status }) });
      await expect(runCrawl({ ...base, client: f.client, ...AFFIRM })).rejects.toThrow(new RegExp(`refused the crawl with ${status}`));
      expect(f.calls).toEqual(["startCrawl"]);
    });
  }

  it("compares creditsUsed telemetry to the accepted-risk budget and requests a best-effort cancel", async () => {
    const f = fake({ status: "scraping", creditsUsed: 1001 });
    const doc = await runCrawl({ ...base, client: f.client, ...AFFIRM });
    expect(f.calls).toEqual(["startCrawl", "status", "cancel", "errors"]);
    expect(doc.crawl.incomplete).toBe(true);
    expect(doc.crawl.notes.join("\n")).toMatch(/1001 credits used \(> accepted-risk budget 1000\); cancel requested \(best effort\)/);
  });

  it("reports creditsUsed telemetry without calling it a ceiling", async () => {
    const f = fake({ creditsUsed: 3 });
    const doc = await execute({ ...base, client: f.client, ...AFFIRM });
    expect(doc.crawl.notes.join("\n")).toMatch(/creditsUsed: 3 \(standard estimate 10, accepted-risk budget 1000; neither is a provider ceiling\)/);
  });
});

describe("exact same-domain and query behaviour", () => {
  it("counts discovery with exact host matching and collapsed query variants", () => {
    const start = new URL("https://scrape.example.com/");
    const links = ["https://scrape.example.com/a", "https://scrape.example.com/a?x=1", "https://www.scrape.example.com/b", "https://evil.scrape.example.com/c", "https://scrape.example.com.evil.net/d", "http://0.0.0.0/e"];
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

  it("drops excluded, private and off-site final URLs even if the server returned them", async () => {
    const dns = async (h: string) => (h === "s.example.com" ? ["93.184.215.14"] : ["10.0.0.1"]);
    const { pages, dropped } = await processCrawlDocuments(
      [
        { html: "<p>x</p>", metadata: { url: "https://s.example.com/login/" } },
        { html: "<p>y</p>", metadata: { url: "https://s.example.com/login-help" } },
        { html: "<p>z</p>", metadata: { url: "http://0.0.0.0/" } },
        { html: "<p>w</p>", metadata: { url: "https://cdn.s.example.com/" } },
      ],
      new URL("https://s.example.com/"),
      dns,
      ["/login"],
    );
    expect(pages.map((p) => p.url)).toEqual(["https://s.example.com/login-help"]);
    expect(dropped).toEqual({ "excluded path (fetched despite exclusion)": 1, "final URL failed safety check": 2 });
  });
});
