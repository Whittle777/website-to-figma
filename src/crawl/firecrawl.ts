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
import type { CrawlErrorsResponse, CrawlJob, CrawlOptions, Document, MapData, MapOptions, PaginationConfig } from "@mendable/firecrawl-js";
import { assertHostedFirecrawlUrl, isSameSite, parseHttpUrl, siteKey, systemResolver, UnsafeUrlError, type Resolver } from "../security/urlGuard";
import { assertLimit, Notes, type RawPage } from "../normalize/build";
import { buildSiteMapBounded } from "../normalize/boundedBuild";
import { canonicalizeUrl } from "../normalize/canonicalize";
import { LIMITS } from "../shared/limits";
import type { SiteMapDoc } from "../shared/schema";
import { assertOperatorPrerequisites, buildCrawlRequest, buildMapRequest, CrawlPolicyError, isExcludedPath, LIVE_MAX_PAGES, normalizeExcludes, standardEstimate } from "./plan";

export interface CrawlClient {
  map(url: string, options?: MapOptions): Promise<MapData>;
  startCrawl(url: string, req?: CrawlOptions): Promise<{ id: string }>;
  getCrawlStatus(jobId: string, pagination?: PaginationConfig): Promise<CrawlJob>;
  cancelCrawl(jobId: string): Promise<boolean>;
  getCrawlErrors(jobId: string): Promise<CrawlErrorsResponse>;
  // Deliberately no account/balance/billing/settings methods: this CLI never
  // reads or writes account state.
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
  // Accepted-risk budget (credits). Compared with creditsUsed telemetry; not a
  // provider-enforced ceiling.
  maxCredits?: number;
  // Operator inputs, required and NOT verified by this CLI (see plan.ts).
  reportedBalance?: number;
  confirmExistingCredits?: boolean;
  confirmNoTopup?: boolean;
}

export const MAX_TIMEOUT_SEC = 300;
const POLL_MS = 3_000;

// Wall-clock bound per awaited SDK call (ms). The SDK's timeoutMs maps to an
// axios socket-inactivity timeout, which a slow-dripping response can outlast,
// so each call is also raced against our own timer. A timed-out request is not
// aborted underneath (the SDK takes no per-call signal); we stop waiting for it.
export const CALL_TIMEOUT_MS = { map: 45_000, start: 30_000, status: 60_000, cancel: 15_000, errors: 30_000 } as const;
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
  // apiUrl pinned: the SDK otherwise falls back to the FIRECRAWL_API_URL env var.
  return new Firecrawl({ apiKey, apiUrl: "https://api.firecrawl.dev", timeoutMs: 30_000, maxRetries: 1 });
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
      u = await assertHostedFirecrawlUrl(finalUrl, resolver, dnsCache);
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
  if (limit > LIVE_MAX_PAGES) throw new CrawlPolicyError(`Refusing: live crawls are limited to ${LIVE_MAX_PAGES} pages (got --limit ${limit})`);
  const excludes = normalizeExcludes(opts.excludes ?? []);
  const useMap = opts.useMap ?? true;
  if (useMap) throw new CrawlPolicyError("Refusing: discovery via map is disabled for live crawls; pass --no-map");
  return { limit, excludes, useMap, estimate: standardEstimate(limit, useMap), crawlRequest: buildCrawlRequest(limit, excludes) };
}

// Public entry point. Plan validation and the operator-prerequisite gate both
// run before any Firecrawl request; any refusal means zero API calls.
export async function runCrawl(opts: CrawlRunOptions): Promise<SiteMapDoc> {
  const plan = planCrawl(opts);
  assertOperatorPrerequisites(plan.limit, plan.useMap, opts);
  return executeCrawl(opts, plan);
}

// Performs the Firecrawl requests. Callers must have passed runCrawl's gates;
// exported so fake-client tests can cover the request/cleanup logic directly.
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

  const start = await assertHostedFirecrawlUrl(opts.url, resolver);
  const startUrl = canonicalizeUrl(start);
  if (isExcludedPath(new URL(startUrl).pathname, excludes)) {
    throw new CrawlPolicyError("Refusing: the start URL itself matches an --exclude prefix");
  }
  const client = opts.client ?? (await createClient(opts.apiKey));
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
  let started: { id: string };
  try {
    started = await withTimeout(client.startCrawl(startUrl, crawlRequest), ct.start, "startCrawl");
  } catch (err) {
    // No retry (single attempt) and no cancel: no job id exists to cancel.
    const status = (err as { status?: unknown })?.status;
    if (status === 402) throw new Error("Firecrawl refused the crawl with 402 (payment required / spend limit). Stopped; nothing retried or purchased.");
    if (status === 403) throw new Error("Firecrawl refused the crawl with 403 (team or key policy). Stopped; nothing retried.");
    throw err;
  }
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
      // so this can only stop further spend after the budget was exceeded.
      const budget = opts.maxCredits ?? bound;
      if (typeof job?.creditsUsed === "number" && job.creditsUsed > budget) {
        notes.add(`Firecrawl reported ${job.creditsUsed} credits used (> accepted-risk budget ${budget}); cancel requested (best effort)`);
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

  if (typeof job?.creditsUsed === "number") notes.add(`Firecrawl reported crawl creditsUsed: ${job.creditsUsed} (standard estimate ${bound}, accepted-risk budget ${opts.maxCredits ?? "n/a"}; neither is a provider ceiling)`);
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
