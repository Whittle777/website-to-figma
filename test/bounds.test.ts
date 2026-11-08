import { describe, expect, it } from "vitest";
import type { CrawlJob, Document } from "@mendable/firecrawl-js";
import { extractPage, tagLimitIndex } from "../src/normalize/extract";
import { buildSiteMapBounded } from "../src/normalize/boundedBuild";
import { runCrawl, type CrawlClient } from "../src/crawl/firecrawl";
import { parseSiteMapJson } from "../src/shared/schema";
import { buildFixture } from "../src/fixtures/generate";
import { LIMITS } from "../src/shared/limits";

describe("HTML parser preflight", () => {
  it("cuts input at the opening-tag limit before parsing", () => {
    expect(tagLimitIndex("<a><b></b><c>", 2)).toBe(10);
    expect(tagLimitIndex("< 1 <2 <a>", 1)).toBe(-1);
  });

  // Previously ~216 s (super-linear parse of 300k unclosed tags).
  it("handles 300k unclosed tags quickly", { timeout: 10_000 }, () => {
    const t = Date.now();
    const ex = extractPage("<div>".repeat(300_000), undefined, "/");
    expect(ex.truncated).toBe(true);
    expect(Date.now() - t).toBeLessThan(5_000);
  });
});

describe("bounded worker build", () => {
  const input = {
    source: { mode: "firecrawl" as const, startUrl: "https://example.com/" },
    startUrl: "https://example.com/",
    limit: 10,
    pages: [{ url: "https://example.com/", html: "<title>T</title><h1>H</h1>" }],
    discoveredCount: 1,
    incomplete: false,
    notes: [],
  };
  it("returns a validated document", { timeout: 20_000 }, async () => {
    const doc = await buildSiteMapBounded(input);
    expect(doc.pages[0]!.title).toBe("T");
  });
  it("aborts when the deadline passes", { timeout: 20_000 }, async () => {
    await expect(buildSiteMapBounded(input, 1)).rejects.toThrow(/exceeded 1 ms/);
  });
});

describe("JSON import preflight", () => {
  it("rejects excessive nesting before JSON.parse", () => {
    const r = parseSiteMapJson("[".repeat(LIMITS.maxJsonBytes / 2));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/nested deeper/);
  });
  it("rejects __proto__ keys and never satisfies keys via the prototype", () => {
    const good = JSON.stringify(buildFixture(5));
    const withProto = good.replace('"schema":', '"__proto__": {"x": 1}, "schema":');
    const r = parseSiteMapJson(withProto);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join("\n")).toMatch(/unknown key "__proto__"/);
    const missing = JSON.parse(good);
    delete missing.site;
    (Object.prototype as Record<string, unknown>).site = { origin: "https://x.example", host: "x.example" };
    try {
      const r2 = parseSiteMapJson(JSON.stringify(missing));
      expect(r2.ok).toBe(false);
    } finally {
      delete (Object.prototype as Record<string, unknown>).site;
    }
  });
});

describe("crawl job cleanup", () => {
  const publicDns = async () => ["93.184.215.14"];
  const doc: Document = { html: "<title>Home</title>", metadata: { url: "https://example.com/", statusCode: 200 } };
  const job = (status: CrawlJob["status"], data: Document[] = []): CrawlJob => ({ id: "j", status, total: data.length, completed: data.length, data });

  function fakeClient(statuses: Array<CrawlJob | Error>) {
    const calls = { cancel: 0, status: 0 };
    const client: CrawlClient = {
      map: async () => ({ links: [{ url: "https://example.com/" }] }),
      startCrawl: async () => ({ id: "j" }),
      getCrawlStatus: async () => {
        const next = statuses[Math.min(calls.status++, statuses.length - 1)]!;
        if (next instanceof Error) throw next;
        return next;
      },
      cancelCrawl: async () => {
        calls.cancel++;
        return true;
      },
      getCrawlErrors: async () => ({ errors: [], robotsBlocked: [] }),
    };
    return { client, calls };
  }
  const base = { url: "https://example.com/", limit: 5, timeoutSec: 10, apiKey: "test", resolver: publicDns, sleep: async () => {} };

  it("does not cancel a completed job", { timeout: 20_000 }, async () => {
    const { client, calls } = fakeClient([job("completed", [doc])]);
    const out = await runCrawl({ ...base, client });
    expect(calls.cancel).toBe(0);
    expect(out.pages).toHaveLength(1);
  });

  it("cancels when polling throws", async () => {
    const { client, calls } = fakeClient([new Error("network down")]);
    await expect(runCrawl({ ...base, client })).rejects.toThrow(/network down/);
    expect(calls.cancel).toBe(1);
  });

  it("cancels on deadline and marks partial results incomplete", { timeout: 20_000 }, async () => {
    let t = 0;
    const { client, calls } = fakeClient([job("scraping", [doc])]);
    const out = await runCrawl({ ...base, client, now: () => (t += 6_000) });
    expect(calls.cancel).toBe(1);
    expect(out.crawl.incomplete).toBe(true);
    expect(out.crawl.notes.join("\n")).toMatch(/timed out/);
  });

  it("cancels when aborted", async () => {
    const ac = new AbortController();
    const { client, calls } = fakeClient([job("scraping")]);
    const sleep = async () => ac.abort();
    await expect(runCrawl({ ...base, client, sleep, signal: ac.signal })).rejects.toThrow(/Aborted/);
    expect(calls.cancel).toBe(1);
  });

  it("survives a null status body until the deadline, then cancels", { timeout: 20_000 }, async () => {
    let t = 0;
    const { client, calls } = fakeClient([null as unknown as CrawlJob]);
    await expect(runCrawl({ ...base, client, now: () => (t += 6_000) })).rejects.toThrow(/no crawled page/);
    expect(calls.cancel).toBe(1);
  });

  it("bounds a hung status call with a wall-clock timeout, then cancels", { timeout: 20_000 }, async () => {
    const { client, calls } = fakeClient([job("scraping")]);
    client.getCrawlStatus = () => new Promise<CrawlJob>(() => {});
    await expect(runCrawl({ ...base, client, callTimeouts: { status: 50 } })).rejects.toThrow(/getCrawlStatus call did not finish within 50 ms/);
    expect(calls.cancel).toBe(1);
  });

  it("does not wait forever on a hung cancel call", { timeout: 20_000 }, async () => {
    const { client } = fakeClient([new Error("boom")]);
    client.cancelCrawl = () => new Promise<boolean>(() => {});
    await expect(runCrawl({ ...base, client, callTimeouts: { cancel: 50 } })).rejects.toThrow(/boom/);
  });

  it("aborts with nothing usable when API documents are malformed", async () => {
    const bad = [null, "x", { html: "<p>", metadata: null }, { html: 5, metadata: { url: 7 } }] as unknown as Document[];
    const { client } = fakeClient([job("completed", bad)]);
    await expect(runCrawl({ ...base, client })).rejects.toThrow(/no crawled page/);
  });
});
