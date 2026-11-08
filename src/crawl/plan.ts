// Pure, network-free crawl planning: validated exclusions, the exact request
// objects sent to Firecrawl, and a conservative credit bound. Everything here
// runs (and can refuse) before any Firecrawl request is made.
//
// Credit semantics relied on (docs.firecrawl.dev, checked for this version):
//  - /billing: Crawl "1 credit / page"; Map "1 credit / call"; enhanced proxy
//    or `auto` escalation "+0" ("An escalated retry is not charged separately");
//    surcharges (JSON +4, PDF parsing +1/PDF page, ZDR +1, lockdown, PII,
//    prompt-injection) only apply when those options are enabled; pages that
//    return no document bill 0; pages returned with an error status bill 1.
//  - /api-reference/endpoint/scrape: `parsers: []` returns a PDF as base64
//    "with a flat rate of 1 credit for the entire PDF"; parsers not listed are
//    off (image URLs then fail as unsupported).
//  - /api-reference/endpoint/crawl-post: proxy values basic|enhanced|auto,
//    default auto, "Billed at the same credit cost as basic"; threatProtection
//    `normal` is "+2 credits per URL scanned" (no documented default).
// So with the options pinned below, the documented worst case is
//   (map ? 1 : 0) + limit * 1.
import type { CrawlOptions, MapOptions, ScrapeOptions } from "@mendable/firecrawl-js";
import { LIMITS } from "../shared/limits";

export class CrawlPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CrawlPolicyError";
  }
}

export const MAX_EXCLUDES = 10;
export const CREDITS_PER_MAP_CALL = 1;
export const MAX_CREDITS_PER_PAGE = 1;

// Normalize a user path prefix ("/lessons/", "/faq") to "/lessons". Strict
// charset so the generated regex needs no exotic escaping.
export function normalizeExcludePrefix(raw: string): string {
  if (typeof raw !== "string" || !raw.startsWith("/")) throw new CrawlPolicyError(`--exclude must be a path starting with "/" (got ${JSON.stringify(raw)})`);
  if (raw.length > 200) throw new CrawlPolicyError("--exclude path is too long");
  if (!/^[A-Za-z0-9._~\-/]+$/.test(raw)) throw new CrawlPolicyError(`--exclude ${raw}: only letters, digits, "._~-/" are allowed`);
  if (raw.includes("//") || raw.split("/").some((s) => s === "." || s === "..")) {
    throw new CrawlPolicyError(`--exclude ${raw}: empty, "." or ".." segments are not allowed`);
  }
  const p = raw.replace(/\/+$/, "");
  if (p === "") throw new CrawlPolicyError('--exclude "/" would exclude the whole site');
  return p;
}

export function normalizeExcludes(raw: string[]): string[] {
  if (raw.length > MAX_EXCLUDES) throw new CrawlPolicyError(`At most ${MAX_EXCLUDES} --exclude values`);
  return [...new Set(raw.map(normalizeExcludePrefix))].sort();
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Firecrawl matches excludePaths as RE2 regexes against the URL pathname, but
// does not document anchoring or whether the leading "/" is included. This
// pattern is anchored at both ends and allows an optional leading slash, so it
// matches "/lessons", "/lessons/", "/lessons/x" (and "lessons/x") under
// search, prefix or full-match semantics, and never "/lessons-old".
export function excludeRegex(prefix: string): string {
  return `^/?${escapeRegex(prefix.slice(1))}(?:/.*)?$`;
}

// Local mirror of the same rule, applied to final URLs after fetching.
export function isExcludedPath(pathname: string, prefixes: string[]): boolean {
  return prefixes.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

// Standard-only scrape settings: HTML only, no parsers (no per-PDF-page
// billing), documented basic proxy, threat-protection scanning off, and no
// surcharge feature enabled.
export const SCRAPE_OPTIONS: Omit<ScrapeOptions, "toolDetail"> = {
  formats: ["html"],
  onlyMainContent: false,
  timeout: 20_000,
  blockAds: true,
  removeBase64Images: true,
  parsers: [],
  proxy: "basic",
  threatProtection: { mode: "off" },
};

export function buildCrawlRequest(limit: number, excludes: string[]): CrawlOptions {
  const req: CrawlOptions = {
    limit,
    allowSubdomains: false,
    allowExternalLinks: false,
    crawlEntireDomain: false,
    maxDiscoveryDepth: 3,
    sitemap: "include",
    ignoreQueryParameters: true,
    deduplicateSimilarURLs: true,
    regexOnFullURL: false,
    scrapeOptions: { ...SCRAPE_OPTIONS },
  };
  if (excludes.length > 0) req.excludePaths = excludes.map(excludeRegex);
  return req;
}

export function buildMapRequest(): MapOptions {
  return {
    limit: LIMITS.maxMapLinks,
    sitemap: "include",
    includeSubdomains: false,
    ignoreQueryParameters: true,
    timeout: 30_000,
    threatProtection: { mode: "off" },
  };
}

export function maxCreditBound(limit: number, useMap: boolean): number {
  return (useMap ? CREDITS_PER_MAP_CALL : 0) + limit * MAX_CREDITS_PER_PAGE;
}

// Refuses unless an explicit budget is given and the documented worst case fits.
export function assertCreditBudget(limit: number, useMap: boolean, maxCredits: number | undefined): number {
  const bound = maxCreditBound(limit, useMap);
  if (maxCredits === undefined) {
    throw new CrawlPolicyError(`Refusing: --max-credits is required for a live crawl (documented worst case for this run is ${bound})`);
  }
  if (!Number.isInteger(maxCredits) || maxCredits < 1) throw new CrawlPolicyError("--max-credits must be a positive integer");
  if (bound > maxCredits) {
    throw new CrawlPolicyError(
      `Refusing: documented worst case ${bound} credits (${useMap ? "1 map + " : ""}${limit} page(s) x ${MAX_CREDITS_PER_PAGE}) exceeds --max-credits ${maxCredits}`,
    );
  }
  return bound;
}
