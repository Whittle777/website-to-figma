// Pure, network-free crawl planning: validated exclusions, the exact request
// objects sent to Firecrawl, a standard (non-hard) credit estimate, and the
// operator-prerequisite gate. Everything here runs (and can refuse) before any
// Firecrawl request is made.
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
//    `normal` is "+2 credits per URL scanned" (features/threat-protection: org
//    default Off; this CLI sends no override, so team policy applies).
// So with the options pinned below, the STANDARD ESTIMATE is
//   (map ? 1 : 0) + limit * 1
// which is neither a worst case nor a provider-enforced ceiling.
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
// billing), documented basic proxy, and every surcharge feature explicitly
// off. No threatProtection override is sent, so the team's own threat policy
// applies unchanged (its scans, if enabled, are billed by Firecrawl and are
// NOT included in the standard estimate).
export const SCRAPE_OPTIONS: Omit<ScrapeOptions, "toolDetail"> = {
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
};

// Live crawls are limited to this many pages (the schema hard cap of 20 still
// applies to fixtures and validation).
export const LIVE_MAX_PAGES = 10;

export function buildCrawlRequest(limit: number, excludes: string[]): CrawlOptions {
  const req: CrawlOptions = {
    limit,
    allowSubdomains: false,
    allowExternalLinks: false,
    crawlEntireDomain: false,
    maxDiscoveryDepth: 3,
    // "skip" uses HTML links only (docs: features/crawl): the site's sitemap,
    // including any private/odd hosts it lists, is never used for discovery.
    sitemap: "skip",
    ignoreQueryParameters: true,
    deduplicateSimilarURLs: true,
    regexOnFullURL: false,
    zeroDataRetention: false,
    scrapeOptions: { ...SCRAPE_OPTIONS },
  };
  if (excludes.length > 0) req.excludePaths = excludes.map(excludeRegex);
  return req;
}

export function buildMapRequest(): MapOptions {
  return {
    limit: LIMITS.maxMapLinks,
    sitemap: "skip",
    includeSubdomains: false,
    ignoreQueryParameters: true,
    timeout: 30_000,
  };
}

// Standard estimate: documented base prices only ((map ? 1 : 0) + limit x 1).
// NOT a worst case and NOT a ceiling: team threat-protection scans, redirects
// re-checked by such scans, and any server-side behaviour outside the pinned
// options are not bounded by it.
export function standardEstimate(limit: number, useMap: boolean): number {
  return (useMap ? CREDITS_PER_MAP_CALL : 0) + limit * MAX_CREDITS_PER_PAGE;
}

// Operator-supplied account prerequisites. The CLI makes NO account/balance
// API call and verifies none of this; the operator must have obtained and
// checked the balance themselves (raw, at the origin) before affirming.
export interface OperatorAffirmation {
  // Accepted-risk budget in credits: compared against creditsUsed telemetry
  // (best-effort cancel). Not a provider-enforced ceiling.
  maxCredits?: number;
  // Recent remaining-credit balance as reported by the operator (unverified).
  reportedBalance?: number;
  confirmExistingCredits?: boolean;
  confirmNoTopup?: boolean;
}

// Refuses before any Firecrawl request unless every operator input is present
// and consistent. Returns the standard estimate.
export function assertOperatorPrerequisites(limit: number, useMap: boolean, a: OperatorAffirmation): number {
  const estimate = standardEstimate(limit, useMap);
  const { maxCredits, reportedBalance } = a;
  if (maxCredits === undefined) throw new CrawlPolicyError(`Refusing: --max-credits (accepted-risk budget) is required (standard estimate ${estimate}, not a guarantee)`);
  if (!Number.isInteger(maxCredits) || maxCredits < 1) throw new CrawlPolicyError("--max-credits must be a positive integer");
  if (estimate > maxCredits) throw new CrawlPolicyError(`Refusing: standard estimate ${estimate} credits already exceeds --max-credits ${maxCredits}`);
  if (reportedBalance === undefined) {
    throw new CrawlPolicyError("Refusing: --operator-reported-balance N is required (a recent remaining-credit balance the operator obtained and verified; this CLI does not check it)");
  }
  if (!Number.isInteger(reportedBalance) || reportedBalance < 0) throw new CrawlPolicyError("--operator-reported-balance must be a non-negative integer");
  if (reportedBalance < maxCredits) {
    throw new CrawlPolicyError(`Refusing: operator-reported balance ${reportedBalance} is below the accepted-risk budget ${maxCredits}`);
  }
  if (a.confirmExistingCredits !== true || a.confirmNoTopup !== true) {
    throw new CrawlPolicyError(
      "Refusing: the operator must affirm both --confirm-existing-credits (existing credits cover the accepted-risk budget) and " +
        "--confirm-no-topup (no top-up or purchase is authorized for this run). This CLI does not verify either.",
    );
  }
  return estimate;
}
