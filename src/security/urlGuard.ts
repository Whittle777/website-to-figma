// URL safety checks for the local CLI.
//
// What this does: rejects non-http(s) URLs, embedded credentials, non-default
// ports, local/reserved hostnames, and any host whose IP literal or *local* DNS
// answers fall outside public unicast space (via ipaddr.js range classification,
// which also covers IPv4-mapped / NAT64 / 6to4 / Teredo IPv6 forms).
//
// What this does NOT do: Firecrawl fetches pages from its own infrastructure,
// with its own resolver and redirect handling. These checks cannot see or
// control that, so they are a pre-flight and post-hoc filter on URLs we send
// and receive, not a hosted SSRF control.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";

export type Resolver = (host: string) => Promise<string[]>;

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

const BLOCKED_SUFFIXES = [
  "localhost",
  "local",
  "localdomain",
  "internal",
  "home.arpa",
  "lan",
  "onion",
  "test",
  "invalid",
  "example",
];

const DNS_TIMEOUT_MS = 5_000;

export const systemResolver: Resolver = async (host) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new UnsafeUrlError(`DNS lookup timed out for ${host}`)), DNS_TIMEOUT_MS);
  });
  try {
    const answers = await Promise.race([lookup(host, { all: true, verbatim: true }), timeout]);
    return answers.map((a) => a.address);
  } finally {
    clearTimeout(timer);
  }
};

// True only for globally routable unicast addresses. Everything ipaddr.js
// classifies otherwise (private, loopback, linkLocal incl. 169.254.169.254
// metadata, carrierGradeNat, uniqueLocal, multicast, reserved, ipv4Mapped
// pointing at a non-public v4, rfc6052/6to4/teredo, unspecified, ...) is rejected.
export function isPublicAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  if (!ipaddr.isValid(bare)) return false;
  let parsed: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    // process() unwraps IPv4-mapped IPv6 (::ffff:a.b.c.d) to plain IPv4.
    parsed = ipaddr.process(bare);
  } catch {
    return false;
  }
  return parsed.range() === "unicast";
}

export function siteKey(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
}

// Same site = identical hostname, treating a single leading "www." as
// equivalent. Deliberately no suffix matching: "evil.example.com",
// "example.com.evil.net" and "notexample.com" are all different sites.
export function isSameSite(a: URL, b: URL): boolean {
  return siteKey(a.hostname) === siteKey(b.hostname);
}

// Syntax-level checks that need no network.
export function parseHttpUrl(raw: string): URL {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) {
    throw new UnsafeUrlError("URL must be a non-empty string of at most 2048 characters");
  }
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new UnsafeUrlError("Not a valid absolute URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UnsafeUrlError(`Only http(s) URLs are allowed (got ${url.protocol})`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new UnsafeUrlError("URLs with embedded credentials are not allowed");
  }
  if (url.port !== "") {
    throw new UnsafeUrlError("Non-default ports are not allowed");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (host.length === 0) throw new UnsafeUrlError("Missing hostname");
  if (isIP(host) !== 0) {
    if (!isPublicAddress(host)) throw new UnsafeUrlError(`Address ${host} is not public unicast`);
    return url;
  }
  if (!host.includes(".")) throw new UnsafeUrlError("Single-label hostnames are not allowed");
  for (const suffix of BLOCKED_SUFFIXES) {
    if (host === suffix || host.endsWith(`.${suffix}`)) {
      throw new UnsafeUrlError(`Reserved/local hostname suffix ".${suffix}" is not allowed`);
    }
  }
  return url;
}

// Owner-approved (2026-11-07) narrow exception: for URLs handed to or returned
// by HOSTED Firecrawl only, the local DNS-answer lookup is omitted for this
// exact hostname (no www, subdomain, trailing-dot or suffix variants). The
// local resolver there is a FakeIP proxy (198.18.0.0/15), so its answers say
// nothing about the hosted fetch. All structural checks still apply. Local
// fetches and every other host keep the full DNS check.
const HOSTED_DNS_CHECK_EXEMPT_HOSTNAME = "simplecss.org";

// For hosted Firecrawl requests (start URL and returned final URLs) only.
export async function assertHostedFirecrawlUrl(
  raw: string,
  resolve: Resolver = systemResolver,
  cache?: Map<string, Promise<void>>,
): Promise<URL> {
  const url = parseHttpUrl(raw);
  if (url.hostname === HOSTED_DNS_CHECK_EXEMPT_HOSTNAME) return url;
  return assertPublicHttpUrl(raw, resolve, cache);
}

// Full check: syntax plus local DNS. Every answer must be public; a single
// private answer rejects the host (mixed answers are a rebinding red flag).
export async function assertPublicHttpUrl(
  raw: string,
  resolve: Resolver = systemResolver,
  cache?: Map<string, Promise<void>>,
): Promise<URL> {
  const url = parseHttpUrl(raw);
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (isIP(host) !== 0) return url;
  const check = async () => {
    let addrs: string[];
    try {
      addrs = await resolve(host);
    } catch (err) {
      if (err instanceof UnsafeUrlError) throw err;
      throw new UnsafeUrlError(`Could not resolve ${host}`);
    }
    if (addrs.length === 0) throw new UnsafeUrlError(`No addresses for ${host}`);
    const bad = addrs.find((a) => !isPublicAddress(a));
    if (bad !== undefined) throw new UnsafeUrlError(`${host} resolves to non-public address ${bad}`);
  };
  if (cache) {
    let pending = cache.get(host);
    if (!pending) {
      pending = check();
      cache.set(host, pending);
    }
    await pending;
  } else {
    await check();
  }
  return url;
}
