// Firecrawl-backed discovery (map) + bounded crawl. The API key stays in this
// local process; the SDK is imported lazily so fixture/validate never load it.
//
// Return shapes checked against @mendable/firecrawl-js 4.52.0 typings
// (MapData.links: SearchResultWeb[]; CrawlJob { status, total, completed,
// data: Document[] }; Document.metadata.url = "URL reported by the selected
// scrape engine", metadata.sourceURL = "URL requested for the scrape").
//
// Security model: we only trust a page if Firecrawl reports its final URL
// (metadata.url). Pages without one are dropped. The final URL must pass the
// same syntax + local-DNS checks as the start URL and be on the same site. We
// cannot observe the IPs Firecrawl actually connected to or its redirect
// chain; that is outside this tool's control.
import type { CrawlErrorsResponse, CrawlJob, CrawlOptions, CreditUsage, Document, MapData, MapOptions, PaginationConfig } from "@mendable/firecrawl-js";
import { assertPublicHttpUrl, isSameSite, parseHttpUrl, siteKey, systemResolver, UnsafeUrlError, type Resolver } from "../security/urlGuard";
import { assertLimit, Notes, type RawPage } from "../normalize/build";
import { buildSiteMapBounded } from "../normalize/boundedBuild";
import { canonicalizeUrl } from "../normalize/canonicalize";
import { LIMITS } from "../shared/limits";
import type { SiteMapDoc } from "../shared/schema";
import { assertCreditBudget, buildCrawlRequest, buildMapRequest, CrawlPolicyError, isExcludedPath, normalizeExcludes, standardEstimate } from "./plan";

export interface CrawlClient {
  map(url: string, options?: MapOptions): Promise<MapData>;
  startCrawl(url: string, req?: CrawlOptions): Promise<{ id: string }>;
  getCrawlStatus(jobId: string, pagination?: PaginationConfig): Promise<CrawlJob>;
  cancelCrawl(jobId: string): Promise<boolean>;
  getCrawlErrors(jobId: string): Promise<CrawlErrorsResponse>;
  getCreditUsage(): Promise<CreditUsage>;
}

export interface CrawlRunOptions {
  url: string;
  limit: number;
  timeoutSec: number;
  apiKey: string;
  resolver?: Resolver;
  client?: CrawlClient;
  log?: (msg: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  signal?: AbortSignal;
  callTimeouts?: Partial<CallTimeouts>;
  // Path prefixes ("/lessons") excluded before fetching (server-side
  // excludePaths) and again locally on final URLs.
  excludes?: string[];
  // Discovery via map (1 credit). false = crawl only; total count unknown.
  useMap?: boolean;
  // Required. While no enforceable provider ceiling exists, runCrawl refuses
  // before any request for every value (see plan.ts STRICT_CREDIT_CEILING_SUPPORTED).
  maxCredits?: number;
}

export const MAX_TIMEOUT_SEC = 300;
const POLL_MS = 3_000;

// Wall-clock bound per awaited SDK call (ms). The SDK's timeoutMs maps to an
// axios socket-inactivity timeout, which a slow-dripping response can outlast,
// so each call is also raced against our own timer. A timed-out request is not
// aborted underneath (the SDK takes no per-call signal); we stop waiting for it.
export const CALL_TIMEOUT_MS = { credits: 30_000, map: 45_000, start: 30_000, status: 60_000, cancel: 15_000, errors: 30_000 } as const;
type CallTimeouts = { [K in keyof typeof CALL_TIMEOUT_MS]: number };

export class CallTimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`Firecrawl ${label} call did not finish within ${ms} ms`);
    this.name = "CallTimeoutError";
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new CallTimeoutError(label, ms)), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

async function createClient(apiKey: string): Promise<CrawlClient> {
  const { default: Firecrawl } = await import("@mendable/firecrawl-js");
  // maxRetries is the total attempt count in SDK 4.52 (1 = no retries);
  // timeoutMs becomes the axios (socket-inactivity) request timeout.
  return new Firecrawl({ apiKey, timeoutMs: 30_000, maxRetries: 1 });
}

function underStartPath(u: URL, start: URL): boolean {
  if (start.pathname === "/") return true;
  const base = start.pathname.replace(/\/$/, "");
  return u.pathname === base || u.pathname.startsWith(base + "/");
}

// Count unique same-site URLs from map output (syntax-checked only; these are
// unverified discovery hints, never fetched by us).
export function countDiscovered(map: MapData, start: URL, excludes: string[] = []): number {
  const keys = new Set<string>();
  for (const link of (map.links ?? []).slice(0, LIMITS.maxMapLinks)) {
    if (typeof link?.url !== "string") continue;
    try {
      const u = parseHttpUrl(link.url);
      if (!isSameSite(u, start) || !underStartPath(u, start)) continue;
      const c = new URL(canonicalizeUrl(u));
      if (isExcludedPath(c.pathname, excludes)) continue;
      // Query variants count once, matching ignoreQueryParameters on the crawl.
      keys.add(siteKey(c.hostname) + c.pathname);
    } catch {
      // ignore unusable links
    }
  }
  return keys.size;
}

// Keep only documents whose reported final URL is known, safe and same-site.
export async function processCrawlDocuments(
  docs: Document[],
  start: URL,
  resolver: Resolver,
  excludes: string[] = [],
): Promise<{ pages: RawPage[]; dropped: Record<string, number> }> {
  const pages: RawPage[] = [];
  const dropped: Record<string, number> = {};
  const drop = (reason: string) => {
    dropped[reason] = (dropped[reason] ?? 0) + 1;
  };
  const dnsCache = new Map<string, Promise<void>>();
  // The SDK passes API JSON through unnormalized, so every field is checked.
  for (const doc of docs.slice(0, LIMITS.hardMaxPages * 2)) {
    if (typeof doc !== "object" || doc === null) {
      drop("malformed document");
      continue;
    }
    const meta: Record<string, unknown> = typeof doc.metadata === "object" && doc.metadata !== null ? doc.metadata : {};
    const finalUrl = meta.url;
    if (typeof finalUrl !== "string" || finalUrl.length === 0) {
      drop("final URL not reported");
      continue;
    }
    let u: URL;
    try {
      u = await assertPublicHttpUrl(finalUrl, resolver, dnsCache);
    } catch (err) {
      drop(err instanceof UnsafeUrlError ? "final URL failed safety check" : "final URL unusable");
      continue;
    }
    if (!isSameSite(u, start)) {
      drop("final URL on a different site");
      continue;
    }
    // Post-fetch defence only: if this triggers, the page was already fetched
    // (and billed) despite the server-side excludePaths.
    if (isExcludedPath(new URL(canonicalizeUrl(u)).pathname, excludes)) {
      drop("excluded path (fetched despite exclusion)");
      continue;
    }
    if (typeof meta.statusCode === "number" && meta.statusCode >= 400) {
      drop(`HTTP ${meta.statusCode >= 500 ? "5xx" : "4xx"} page`);
      continue;
    }
    if (typeof doc.html !== "string" || doc.html.length === 0) {
      drop("no HTML returned");
      continue;
    }
    pages.push({ url: u.toString(), html: doc.html, metadataTitle: typeof meta.title === "string" ? meta.title : undefined });
  }
  return { pages, dropped };
}

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

function abortError(): Error {
  return new Error("Aborted by user; remote crawl cancel requested. Nothing written.");
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface CrawlPlan {
  limit: number;
  excludes: string[];
  useMap: boolean;
  // Standard estimate from documented per-call/per-page prices. NOT a guarantee.
  estimate: number;
  crawlRequest: CrawlOptions;
}

// Network-free validation of a crawl request (no credit gate).
export function planCrawl(opts: CrawlRunOptions): CrawlPlan {
  const limit = assertLimit(opts.limit);
  if (!Number.isInteger(opts.timeoutSec) || opts.timeoutSec < 10 || opts.timeoutSec > MAX_TIMEOUT_SEC) {
    throw new RangeError(`--timeout must be an integer between 10 and ${MAX_TIMEOUT_SEC} seconds`);
  }
  const excludes = normalizeExcludes(opts.excludes ?? []);
  const useMap = opts.useMap ?? true;
  return { limit, excludes, useMap, estimate: standardEstimate(limit, useMap), crawlRequest: buildCrawlRequest(limit, excludes) };
}

// Public entry point. The strict credit gate runs before any Firecrawl request
// (including the balance read) and, while STRICT_CREDIT_CEILING_SUPPORTED is
// false, always refuses. There is no flag that turns it into an estimate.
export async function runCrawl(opts: CrawlRunOptions): Promise<SiteMapDoc> {
  const plan = planCrawl(opts);
  assertCreditBudget(plan.limit, plan.useMap, opts.maxCredits);
  return executeCrawl(opts, plan);
}

// Performs the Firecrawl requests. Not reachable from runCrawl or the CLI while
// the strict gate refuses; exported only so fake-client tests can cover the
// request, cleanup and filtering logic.
export async function executeCrawl(opts: CrawlRunOptions, plan: CrawlPlan): Promise<SiteMapDoc> {
  const { limit, excludes, useMap, crawlRequest } = plan;
  const bound = plan.estimate;
  const resolver = opts.resolver ?? systemResolver;
  const log = opts.log ?? (() => {});
  const sleep = opts.sleep ?? ((ms: number) => abortableSleep(ms, opts.signal));
  const now = opts.now ?? Date.now;
  const notes = new Notes();
  let incomplete = false;
  const ct: CallTimeouts = { ...CALL_TIMEOUT_MS, ...opts.callTimeouts };

  const start = await assertPublicHttpUrl(opts.url, resolver);
  const startUrl = canonicalizeUrl(start);
  if (isExcludedPath(new URL(startUrl).pathname, excludes)) {
    throw new CrawlPolicyError("Refusing: the start URL itself matches an --exclude prefix");
  }
  const client = opts.client ?? (await createClient(opts.apiKey));
  if (opts.signal?.aborted) throw abortError();

  // 0) Balance gate (GET /team/credit-usage; not listed as a billed endpoint on
  //    the billing page, but its cost is not documented either). Refuses unless
  //    the existing balance covers the standard estimate, so the run should
  //    not need a pay-as-you-go top-up (barring concurrent use of the account).
  let remaining: unknown;
  try {
    remaining = (await withTimeout(client.getCreditUsage(), ct.credits, "getCreditUsage"))?.remainingCredits;
  } catch {
    throw new CrawlPolicyError("Refusing: could not read the remaining credit balance. No crawl started.");
  }
  if (typeof remaining !== "number" || !Number.isFinite(remaining) || remaining < bound) {
    throw new CrawlPolicyError(`Refusing: remaining credits ${String(remaining)} < standard estimate ${bound}. No crawl started.`);
  }
  log(`Credit preflight: standard estimate ${bound}, remaining ${remaining}`);
  if (opts.signal?.aborted) throw abortError();

  // 1) Optional discovery (1 credit per call per Firecrawl docs), bounded to
  //    maxMapLinks results. Used only to report how many same-site URLs exist.
  let discoveredCount: number | null = null;
  if (useMap) {
    try {
      log("Mapping site (discovery)...");
      const map = await withTimeout(client.map(startUrl, buildMapRequest()), ct.map, "map");
      discoveredCount = countDiscovered(map, start, excludes);
    } catch {
      notes.add("Discovery (map) failed; total page count unknown");
    }
  } else {
    notes.add("Discovery skipped (--no-map): total page count unknown, so truncation cannot be determined");
  }
  if (opts.signal?.aborted) throw abortError();

  // 2) Bounded crawl. The server-side job is capped by `limit` (<= 20 pages)
  //    and maxDiscoveryDepth; locally we enforce our own deadline. Any exit
  //    before a terminal status (timeout, error, Ctrl-C) cancels the job.
  log(`Starting crawl (limit ${limit})...`);
  // If this call times out after the server created the job, no id is known
  // and the job cannot be cancelled from here (it remains bounded by `limit`).
  const started = await withTimeout(client.startCrawl(startUrl, crawlRequest), ct.start, "startCrawl");
  const id = typeof started?.id === "string" ? started.id : "";
  if (!id) throw new Error("Firecrawl did not return a crawl job id");

  const deadline = now() + opts.timeoutSec * 1000;
  let job: CrawlJob | null = null;
  let terminal = false;
  try {
    for (;;) {
      if (opts.signal?.aborted) throw abortError();
      job = await withTimeout(client.getCrawlStatus(id, { autoPaginate: true, maxPages: 5, maxResults: limit }), ct.status, "getCrawlStatus");
      log(`  status=${String(job?.status)} completed=${String(job?.completed)} total=${String(job?.total)}`);
      if (TERMINAL.has(job?.status)) {
        terminal = true;
        break;
      }
      // Usage telemetry, not a ceiling: credits are billed per completed page,
      // so this can only stop further spend after the bound was exceeded.
      if (typeof job?.creditsUsed === "number" && job.creditsUsed > bound) {
        notes.add(`Firecrawl reported ${job.creditsUsed} credits used (> standard estimate ${bound}); cancelled`);
        incomplete = true;
        break;
      }
      if (now() >= deadline) {
        notes.add(`Crawl timed out after ${opts.timeoutSec}s; cancelled and kept partial results`);
        incomplete = true;
        break;
      }
      await sleep(POLL_MS);
    }
  } finally {
    if (!terminal) {
      // Best effort: the API may already have finished or may not honour it.
      try {
        await withTimeout(client.cancelCrawl(id), ct.cancel, "cancelCrawl");
      } catch {
        notes.add("Cancel request failed; the remote job may continue up to its page limit");
      }
    }
  }
  const data: Document[] = Array.isArray(job?.data) ? job.data : [];
  const status = typeof job?.status === "string" ? job.status : "unknown";
  if (status !== "completed") {
    notes.add(`Crawl job ended with status "${status === "scraping" ? "scraping (cancelled by deadline)" : status}"`);
    incomplete = true;
  }
  if (typeof job?.total === "number" && job.total > data.length) incomplete = true;

  try {
    const errs = await withTimeout(client.getCrawlErrors(id), ct.errors, "getCrawlErrors");
    const nErr = Array.isArray(errs?.errors) ? errs.errors.length : 0;
    const nRobots = Array.isArray(errs?.robotsBlocked) ? errs.robotsBlocked.length : 0;
    if (nErr > 0) notes.add(`${nErr} page(s) failed to scrape`);
    if (nRobots > 0) notes.add(`${nRobots} URL(s) blocked by robots.txt`);
    if (nErr + nRobots > 0) incomplete = true;
  } catch {
    notes.add("Could not fetch crawl error report");
  }

  if (typeof job?.creditsUsed === "number") notes.add(`Firecrawl reported crawl creditsUsed: ${job.creditsUsed} (standard estimate for this run: ${bound})`);
  const { pages, dropped } = await processCrawlDocuments(data, start, resolver, excludes);
  for (const [reason, n] of Object.entries(dropped).sort()) {
    notes.add(`${n} page(s) dropped: ${reason}`);
    incomplete = true;
  }
  if (pages.length === 0) {
    throw new Error("Aborting: no crawled page had a reported, safe, same-site final URL. Nothing written.");
  }

  // Untrusted HTML is parsed in a worker with a hard deadline and heap limit.
  return buildSiteMapBounded({
    source: { mode: "firecrawl", startUrl },
    startUrl,
    limit,
    pages,
    discoveredCount,
    incomplete,
    notes: notes.list(),
    ignoreQueryVariants: true,
  });
}
