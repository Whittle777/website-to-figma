import { describe, expect, it } from "vitest";
import type { Document } from "@mendable/firecrawl-js";
import { assertPublicHttpUrl, isPublicAddress, isSameSite, parseHttpUrl, UnsafeUrlError, type Resolver } from "../src/security/urlGuard";
import { processCrawlDocuments } from "../src/crawl/firecrawl";

const fakeDns =
  (table: Record<string, string[]>): Resolver =>
  async (host) => {
    if (!(host in table)) throw new Error("ENOTFOUND");
    return table[host]!;
  };

describe("parseHttpUrl", () => {
  it.each([
    ["ftp://example.com/", /http\(s\)/],
    ["file:///etc/passwd", /http\(s\)/],
    ["javascript:alert(1)", /http\(s\)/],
    ["data:text/html,hi", /http\(s\)/],
    ["https://user:pass@example.com/", /credentials/],
    ["https://user@example.com/", /credentials/],
    ["https://example.com:8443/", /ports/],
    ["http://localhost/", /Single-label/],
    ["http://app.localhost/", /localhost/],
    ["http://printer.local/", /local/],
    ["http://db.internal/", /internal/],
    ["http://intranet/", /Single-label/],
    ["not a url", /valid/],
  ])("rejects %s", (url, msg) => {
    expect(() => parseHttpUrl(url)).toThrow(msg);
  });

  // WHATWG URL normalizes numeric/hex/short IPv4 forms before we classify them.
  it.each([
    "http://127.0.0.1/",
    "http://127.1/",
    "http://2130706433/",
    "http://0x7f000001/",
    "http://0177.0.0.1/",
    "http://0.0.0.0/",
    "http://10.1.2.3/",
    "http://172.16.0.1/",
    "http://192.168.1.1/",
    "http://100.64.0.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://224.0.0.1/",
    "http://255.255.255.255/",
    "http://[::1]/",
    "http://[::]/",
    "http://[fd00::1]/",
    "http://[fe80::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:7f00:1]/",
    "http://[::ffff:169.254.169.254]/",
    "http://[64:ff9b::a9fe:a9fe]/",
    "http://[2002:7f00:1::]/",
    "http://[2001::1]/",
  ])("rejects non-public IP literal %s", (url) => {
    expect(() => parseHttpUrl(url)).toThrow(UnsafeUrlError);
  });

  it("accepts public http(s) URLs", () => {
    expect(parseHttpUrl("https://example.com/a?b=1").hostname).toBe("example.com");
    expect(parseHttpUrl("http://93.184.215.14/").hostname).toBe("93.184.215.14");
    expect(parseHttpUrl("https://[2606:4700::1111]/").hostname).toBe("[2606:4700::1111]");
  });
});

describe("isPublicAddress", () => {
  it("classifies addresses via ipaddr.js ranges", () => {
    expect(isPublicAddress("8.8.8.8")).toBe(true);
    expect(isPublicAddress("2606:4700::1111")).toBe(true);
    expect(isPublicAddress("::ffff:8.8.8.8")).toBe(true);
    expect(isPublicAddress("::ffff:10.0.0.1")).toBe(false);
    expect(isPublicAddress("fe80::1%en0")).toBe(false);
    expect(isPublicAddress("garbage")).toBe(false);
  });
});

describe("assertPublicHttpUrl (DNS)", () => {
  it("rejects hosts resolving to private, metadata or mapped addresses", async () => {
    const dns = fakeDns({
      "rebind.example.com": ["93.184.215.14", "127.0.0.1"],
      "meta.example.com": ["169.254.169.254"],
      "mapped.example.com": ["::ffff:192.168.0.10"],
      "ula.example.com": ["fd12:3456::1"],
      "empty.example.com": [],
    });
    for (const host of ["rebind", "meta", "mapped", "ula", "empty", "missing"]) {
      await expect(assertPublicHttpUrl(`https://${host}.example.com/`, dns)).rejects.toBeInstanceOf(UnsafeUrlError);
    }
  });

  it("accepts hosts whose every answer is public", async () => {
    const dns = fakeDns({ "ok.example.com": ["93.184.215.14", "2606:2800:21f:cb07:6820:80da:af6b:8b2c"] });
    await expect(assertPublicHttpUrl("https://ok.example.com/", dns)).resolves.toBeInstanceOf(URL);
  });
});

describe("isSameSite", () => {
  const start = new URL("https://example.com/");
  it.each([
    ["https://example.com/about", true],
    ["https://www.example.com/", true],
    ["http://EXAMPLE.com./x", true],
    ["https://evil.example.com/", false],
    ["https://example.com.evil.net/", false],
    ["https://notexample.com/", false],
    ["https://www.www.example.com/", false],
  ])("%s -> %s", (url, same) => {
    expect(isSameSite(new URL(url), start)).toBe(same);
  });
});

describe("processCrawlDocuments (final URL handling)", () => {
  const start = new URL("https://example.com/");
  const dns = fakeDns({ "example.com": ["93.184.215.14"], "www.example.com": ["93.184.215.14"], "internal.example.com": ["10.0.0.5"], "other.org": ["93.184.215.14"] });
  const doc = (meta: Record<string, unknown>, html = "<h1>x</h1>"): Document => ({ html, metadata: meta });

  it("uses metadata.url (final) not sourceURL (requested), and drops unknowable or unsafe finals", async () => {
    const { pages, dropped } = await processCrawlDocuments(
      [
        doc({ sourceURL: "https://example.com/a", url: "https://www.example.com/a", statusCode: 200 }),
        doc({ sourceURL: "https://example.com/b" }),
        doc({ sourceURL: "https://example.com/c", url: "https://internal.example.com/c" }),
        doc({ sourceURL: "https://example.com/d", url: "https://other.org/d" }),
        doc({ sourceURL: "https://example.com/e", url: "http://169.254.169.254/" }),
        doc({ sourceURL: "https://example.com/f", url: "https://example.com/f", statusCode: 404 }),
        doc({ sourceURL: "https://example.com/g", url: "https://example.com/g" }, ""),
      ],
      start,
      dns,
    );
    expect(pages.map((p) => p.url)).toEqual(["https://www.example.com/a"]);
    expect(dropped).toEqual({
      "final URL not reported": 1,
      "final URL failed safety check": 2,
      "final URL on a different site": 1,
      "HTTP 4xx page": 1,
      "no HTML returned": 1,
    });
  });
});
