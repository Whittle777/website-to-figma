import { describe, expect, it } from "vitest";
import type { CrawlJob, Document } from "@mendable/firecrawl-js";
import { assertHostedFirecrawlUrl, assertPublicHttpUrl, UnsafeUrlError } from "../src/security/urlGuard";
import { runCrawl, type CrawlClient } from "../src/crawl/firecrawl";

// FakeIP-style resolver: every name maps into 198.18.0.0/15.
function fakeIpDns() {
  const asked: string[] = [];
  const resolve = async (h: string) => {
    asked.push(h);
    return ["198.18.0.1"];
  };
  return { resolve, asked };
}

describe("hosted-only DNS exception for exactly simplecss.org", () => {
  it("hosted helper accepts exactly simplecss.org without any DNS lookup", async () => {
    const dns = fakeIpDns();
    for (const u of ["https://simplecss.org/", "http://simplecss.org/demo?x=1", "https://SimpleCSS.org/"]) {
      await expect(assertHostedFirecrawlUrl(u, dns.resolve)).resolves.toBeInstanceOf(URL);
    }
    expect(dns.asked).toEqual([]);
  });

  it("local DNS guard still rejects simplecss.org when it resolves into 198.18.0.0/15", async () => {
    const dns = fakeIpDns();
    await expect(assertPublicHttpUrl("https://simplecss.org/", dns.resolve)).rejects.toThrow(/non-public address 198\.18\.0\.1/);
    expect(dns.asked).toEqual(["simplecss.org"]);
  });

  it("does not extend to www, subdomains, trailing dot, look-alikes or other hosts", async () => {
    for (const u of [
      "https://www.simplecss.org/",
      "https://cdn.simplecss.org/",
      "https://simplecss.org./",
      "https://simplecss.org.evil.com/",
      "https://notsimplecss.org/",
      "https://example.com/",
    ]) {
      const dns = fakeIpDns();
      await expect(assertHostedFirecrawlUrl(u, dns.resolve)).rejects.toBeInstanceOf(UnsafeUrlError);
      expect(dns.asked.length).toBe(1);
    }
  });

  it("keeps every structural rule, and 198.18.0.0/15 literals are never safe", async () => {
    const dns = fakeIpDns();
    for (const u of [
      "http://198.18.0.1/",
      "http://198.19.255.254/",
      "http://[::ffff:198.18.0.1]/",
      "http://0.0.0.0/",
      "http://169.254.169.254/",
      "https://user:pw@simplecss.org/",
      "https://simplecss.org:8443/",
      "ftp://simplecss.org/",
      "javascript:alert(1)",
      "http://localhost/",
      "http://simplecss.local/",
    ]) {
      await expect(assertHostedFirecrawlUrl(u, dns.resolve)).rejects.toBeInstanceOf(UnsafeUrlError);
    }
    expect(dns.asked).toEqual([]);
  });
});

describe("crawl path with a FakeIP resolver (fake client, no network)", () => {
  const AFFIRM = { maxCredits: 1000, reportedBalance: 95_612_660, confirmExistingCredits: true, confirmNoTopup: true };
  const doc = (url: string): Document => ({ html: "<title>t</title><h1>h</h1>", metadata: { url, statusCode: 200 } });

  function fake(docs: Document[]) {
    const calls: string[] = [];
    const client: CrawlClient = {
      map: async () => {
        calls.push("map");
        return { links: [] };
      },
      startCrawl: async () => {
        calls.push("startCrawl");
        return { id: "j" };
      },
      getCrawlStatus: async () => {
        calls.push("status");
        return { id: "j", status: "completed", total: docs.length, completed: docs.length, data: docs } as CrawlJob;
      },
      cancelCrawl: async () => {
        calls.push("cancel");
        return true;
      },
      getCrawlErrors: async () => ({ errors: [], robotsBlocked: [] }),
    };
    return { client, calls };
  }
  const base = { limit: 10, timeoutSec: 10, apiKey: "test", sleep: async () => {}, useMap: false, ...AFFIRM };

  it("simplecss.org proceeds; same-domain, exclusion, query and literal guards still filter results", async () => {
    const dns = fakeIpDns();
    const f = fake([
      doc("https://simplecss.org/"),
      doc("https://simplecss.org/demo"),
      doc("https://simplecss.org/demo?theme=dark"),
      doc("https://simplecss.org/login/x"),
      doc("https://www.simplecss.org/about"),
      doc("https://other.example.com/"),
      doc("http://198.18.0.1/"),
    ]);
    const out = await runCrawl({ url: "https://simplecss.org/", client: f.client, resolver: dns.resolve, excludes: ["/login/"], ...base });
    expect(f.calls).toEqual(["startCrawl", "status"]);
    expect(out.pages.map((p) => p.path)).toEqual(["/", "/demo"]);
    const notes = out.crawl.notes.join("\n");
    expect(notes).toMatch(/excluded path \(fetched despite exclusion\)/);
    // www.simplecss.org and other.example.com are DNS-checked (-> 198.18, rejected); the literal is rejected structurally.
    expect(notes).toMatch(/3 page\(s\) dropped: final URL failed safety check/);
    expect(notes).toMatch(/1 duplicate URL\(s\) merged/);
    // Only the non-exempt hosts were looked up, never simplecss.org itself.
    expect(dns.asked).not.toContain("simplecss.org");
  });

  it("any other start host under FakeIP is refused before any Firecrawl request", async () => {
    for (const url of ["https://www.simplecss.org/", "https://example.com/"]) {
      const dns = fakeIpDns();
      const f = fake([]);
      await expect(runCrawl({ url, client: f.client, resolver: dns.resolve, ...base })).rejects.toBeInstanceOf(UnsafeUrlError);
      expect(f.calls).toEqual([]);
    }
  });
});
