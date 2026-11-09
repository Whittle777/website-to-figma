// Hosted Firecrawl state-run EXECUTOR (reusable; injectable client).
//
// Executes exactly the reviewed request previews from `states-plan`: ONE
// /v2/scrape request per page with sequential documented actions (wait,
// executeJavascript, screenshot, scrape), in plan order, at most once each.
//
// Fail-closed contract:
//  - Pre-execution semantic validation: the operator's preview file must equal
//    the preview rebuilt from the plan, byte for byte (canonical JSON), and
//    every request is re-checked independently (formats exactly ["rawHtml"],
//    no JSON/LLM options, basic proxy, no vendor/account safety setting sent
//    at all (threatProtection, checkPromptInjection, redactPII, lockdown...), only
//    wait/executeJavascript/screenshot/scrape actions, known scripts only,
//    <=50 actions, combined waits <=60 s, <=3 pages, <=3 states per page).
//  - Paid gates: operator-asserted credits per request (a reservation /
//    accepted-risk allowance, not a price), operator-reported balance,
//    existing-credit and no-top-up confirmations, acknowledgement of synthetic
//    DOM modifications, and the shared local ledger (1000-credit project
//    budget ceiling). The ledger is NOT a provider-enforced cap and there is no
//    pre-send guarantee: action/screenshot/scan/redirect charges are unknown,
//    actual credits may exceed the reservation, and an overrun stops all
//    further pages and blocks later runs until resolved.
//  - Order: every gate, URL guard and ledger check completes BEFORE the API
//    key is requested (getApiKey callback) and before a client exists.
//  - One attempt: SDK maxRetries 1 (total attempts) and autoResume false (no
//    SDK re-POST on 408 processing_continues). No fallback to one request per
//    state, no retry or duplicate after a partial or ambiguous response; the
//    run stops and only a manually reviewed continuation may follow.
//  - The ledger records the attempt BEFORE sending and the result AFTER.
//  - Final URL must pass the hosted URL guard (exact simplecss.org /
//    bootstrapmade.com DNS exceptions only), be same-site, and equal the
//    requested URL after canonicalization (redirects are not accepted).
//  - The API key is never written or logged; error text is redacted.
import { createHash } from "node:crypto";
import { assertHostedFirecrawlUrl, isSameSite, parseHttpUrl, systemResolver, type Resolver } from "../security/urlGuard";
import { canonicalizeUrl } from "../normalize/canonicalize";
import { LIMITS } from "../shared/limits";
import { buildStatePreview, parseStatePlan, STATE_LIMITS, type RequestPreview, type StatePlan, type StatePreviewDoc } from "./plan";
import { reserveAttempt, settleAttempt, readLedger, committedCredits, unresolved, LedgerError } from "./ledger";

export class StateRunPolicyError extends Error {}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

// Minimal client surface: one scrape call. No account/billing methods.
export interface StateScrapeClient {
  scrape(url: string, options: Obj): Promise<unknown>;
}

// The SDK falls back to the FIRECRAWL_API_URL environment variable when no
// apiUrl is given (dist/index.js:2467), which could send the key elsewhere, so
// the official endpoint is pinned. `apiUrl` is overridable ONLY for the
// loopback transport tests.
export const FIRECRAWL_API_URL = "https://api.firecrawl.dev";

// SDK 4.52 semantics (installed dist/index.js):
//  - HttpClient.request: `for (let attempt = 0; attempt < this.maxRetries; ...)`
//    (:85) and the only retry is HTTP 502 while `attempt < this.maxRetries - 1`
//    (:103, :111). maxRetries 1 => exactly one POST.
//  - scrape(): re-POSTs on 408 SCRAPE_TIMEOUT processing_continues only when
//    `autoResume !== false` (:584-585); with autoResume false the HTTP timeout
//    is `timeout + 5000` (:564). autoResume is SDK-only, never sent (:560).
export function stateClientOptions(apiKey: string, apiUrl: string = FIRECRAWL_API_URL) {
  return { apiKey, apiUrl, timeoutMs: STATE_LIMITS.maxRequestTimeoutMs + STATE_LIMITS.sdkTimeoutMarginMs, maxRetries: 1 };
}

export async function createStateScrapeClient(apiKey: string, apiUrl: string = FIRECRAWL_API_URL): Promise<StateScrapeClient> {
  const { default: Firecrawl } = await import("@mendable/firecrawl-js");
  const fc = new Firecrawl(stateClientOptions(apiKey, apiUrl));
  return { scrape: (url, options) => fc.scrape(url, options as never) as Promise<unknown> };
}

// Canonical JSON (sorted keys) for exact preview comparison and hashing.
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}
export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join("[REDACTED]");
  return out.replace(/\bfc-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]").replace(/(authorization|bearer)\s*[:=]?\s*\S+/gi, "$1 [REDACTED]").slice(0, 500);
}

// Exactly these keys: no vendor/account safety setting is ever sent (see plan.ts).
const ALLOWED_BODY_KEYS = ["url", "formats", "timeout", "actions", "onlyMainContent", "proxy"];
const ALLOWED_ACTIONS = ["wait", "executeJavascript", "screenshot", "scrape"];
const FORBIDDEN_SCRIPT = /\.click\s*\(|\.submit\s*\(|requestSubmit|\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|location\s*(\.\w+\s*)?=|location\.(assign|replace)|window\.open|history\.(push|replace)State|localStorage|sessionStorage|document\.cookie|indexedDB|\.dispatchEvent\s*\(|\.focus\s*\(/;

export interface ValidatedRun {
  plan: StatePlan;
  preview: StatePreviewDoc;
  previewSha256: string;
  requests: { preview: RequestPreview; requestSha256: string; synthetic: boolean }[];
}

// Pre-execution semantic validation (no network, no key).
export function validateForExecution(planJson: unknown, previewJson: unknown): ValidatedRun {
  const plan = parseStatePlan(planJson);
  const rebuilt = buildStatePreview(plan);
  const want = canonicalJson(rebuilt);
  if (canonicalJson(previewJson) !== want) throw new StateRunPolicyError("preview file does not match the preview rebuilt from the plan; re-run states-plan, review the new preview, and pass that exact file");
  if (rebuilt.requests.length < 1 || rebuilt.requests.length > STATE_LIMITS.maxPages) throw new StateRunPolicyError(`1..${STATE_LIMITS.maxPages} pages required`);
  const site = parseHttpUrl(plan.site);
  const requests = rebuilt.requests.map((r) => {
    const b = r.body as unknown as Obj;
    const fail = (m: string) => {
      throw new StateRunPolicyError(`${r.pageUrl}: ${m}`);
    };
    for (const k of Object.keys(b)) if (!ALLOWED_BODY_KEYS.includes(k)) fail(`request option "${k}" is not allowed`);
    if (canonicalJson(b.formats) !== '["rawHtml"]') fail("formats must be exactly [\"rawHtml\"] (JSON/LLM formats are refused)");
    if (b.proxy !== "basic" || b.onlyMainContent !== false) fail("only the reviewed options are allowed");
    if (b.timeout !== r.timing.requestTimeoutMs || (b.timeout as number) > STATE_LIMITS.maxRequestTimeoutMs) fail("unexpected timeout");
    if (!isSameSite(parseHttpUrl(String(b.url)), site) || canonicalizeUrl(parseHttpUrl(String(b.url))) !== canonicalizeUrl(parseHttpUrl(r.pageUrl))) fail("request URL is not the planned same-site page");
    const actions = b.actions as Obj[];
    if (actions.length > plan.maxActions || actions.length > STATE_LIMITS.providerMaxActions) fail("too many actions");
    let waits = 0;
    for (const a of actions) {
      if (!ALLOWED_ACTIONS.includes(String(a.type))) fail(`action type "${String(a.type)}" is not allowed`);
      if (a.type === "wait") {
        if (a.selector !== undefined || typeof a.milliseconds !== "number" || !Number.isInteger(a.milliseconds) || a.milliseconds < 1) fail("only fixed positive-integer waits are allowed");
        waits += a.milliseconds as number;
      }
      if (a.type === "screenshot" && (a.fullPage !== false || a.viewport !== undefined || a.quality !== undefined)) fail("only viewport screenshots without overrides are allowed");
      if (a.type === "executeJavascript" && (typeof a.script !== "string" || FORBIDDEN_SCRIPT.test(a.script as string) || !/w2f/.test(a.script as string))) fail("script is not one of the reviewed scripts");
    }
    if (waits !== r.combinedWaitMs || waits > STATE_LIMITS.providerMaxCombinedWaitMs || waits > plan.maxCombinedWaitMs || waits * 2 > (b.timeout as number)) fail("combined waits exceed the budget");
    if (actions.some((a) => a.type === "executeJavascript" && /\basync\b|\bawait\b|setTimeout|setInterval|Promise/.test(a.script as string))) fail("scripts must be synchronous");
    if (r.states.length > STATE_LIMITS.maxStatesPerPage) fail("too many states");
    // modifies = any synthetic DOM modification or page-API trigger (needs acknowledgement)
    return { preview: r, requestSha256: sha256(canonicalJson(b)), synthetic: r.states.some((s) => s.provenance === "synthetic" || s.provenance === "page-api") };
  });
  return { plan, preview: rebuilt, previewSha256: sha256(want), requests };
}

export interface RunGates {
  operatorCreditsPerRequest?: number;
  operatorReportedBalance?: number;
  confirmExistingCredits?: boolean;
  confirmNoTopup?: boolean;
  acknowledgeSyntheticModifications?: boolean;
  ledgerPath?: string;
  reviewedContinuation?: string;
}

// Paid-execution gates (no network, no key). Returns the operator-asserted
// projection; never a price published by this tool.
export function assertRunGates(v: ValidatedRun, g: RunGates): { perRequest: number; projected: number; committed: number; remaining: number } {
  const missing: string[] = [];
  if (!Number.isInteger(g.operatorCreditsPerRequest) || (g.operatorCreditsPerRequest as number) < 1 || (g.operatorCreditsPerRequest as number) > 100) missing.push("--operator-credits-per-request N (1..100; YOUR asserted price per request; provider cost is unknown and this tool sets no price)");
  if (!Number.isInteger(g.operatorReportedBalance) || (g.operatorReportedBalance as number) < 0) missing.push("--operator-reported-balance N");
  if (!g.confirmExistingCredits) missing.push("--confirm-existing-credits");
  if (!g.confirmNoTopup) missing.push("--confirm-no-topup");
  if ((v.plan.forceAos || v.requests.some((r) => r.synthetic)) && !g.acknowledgeSyntheticModifications) missing.push("--acknowledge-synthetic-modifications (synthetic DOM changes / forced AOS visibility / page-API Swiper advance; no handler side-effect guarantee)");
  if (!g.ledgerPath) missing.push("--ledger FILE (shared local project ledger; 1000-credit budget ceiling, not a provider cap)");
  if (missing.length) throw new StateRunPolicyError(`Refusing before any request: missing operator inputs:\n  ${missing.join("\n  ")}`);
  const perRequest = g.operatorCreditsPerRequest as number;
  const projected = perRequest * v.requests.length;
  if (projected > (g.operatorReportedBalance as number)) throw new StateRunPolicyError(`operator-asserted projection ${projected} exceeds the operator-reported balance ${g.operatorReportedBalance}`);
  let l;
  try {
    l = readLedger(g.ledgerPath as string);
  } catch (err) {
    throw new StateRunPolicyError(err instanceof Error ? err.message : String(err));
  }
  const committed = committedCredits(l);
  const open = unresolved(l);
  if (open.length) throw new StateRunPolicyError(`ledger has unresolved paid attempt(s): ${open.map((e) => e.id).join(", ")}; resolve them first ("ledger resolve")`);
  if (committed + projected > l.capCredits) throw new StateRunPolicyError(`ledger: ${committed} committed + ${projected} operator-asserted reservation exceeds the ${l.capCredits}-credit project budget ceiling (local allowance, not a provider cap)`);
  return { perRequest, projected, committed, remaining: l.capCredits - committed };
}

export type PageStatus = "accepted" | "rejected" | "failed" | "ambiguous" | "not-attempted";
export interface Checkpoint {
  at: string;
  step: string;
  detail: string;
}
export interface PageRun {
  schema: "website-to-figma/state-run";
  schemaVersion: 1;
  runId: string;
  pageUrl: string;
  previewSha256: string;
  requestSha256: string;
  ledgerEntryId: string | null;
  attempts: 0 | 1;
  retries: 0;
  status: PageStatus;
  reason: string | null;
  operatorCreditsPerRequest: number;
  reportedCreditsUsed: number | null;
  checkpoints: Checkpoint[];
  freeze: Obj | null;
  lazy: Obj | null;
  // observed (not awaited) at the baseline measurement
  readiness: Obj | null;
  states: { seq: number; name: string; provenance: string; applied: number; refused: number; missing: number; error: string | null; reverted: number | null; revertFailed: number | null; trigger: Obj | null }[];
  warnings: string[];
}

export interface ExecuteOptions {
  validated: ValidatedRun;
  gates: RunGates;
  // Called only after every gate, the URL guard and the ledger checks pass.
  getApiKey: () => string | undefined;
  // Called once, after getApiKey; default creates the SDK client.
  createClient?: (apiKey: string) => Promise<StateScrapeClient>;
  resolver?: Resolver;
  now?: () => Date;
  runId?: string;
  log?: (m: string) => void;
  // Called with each page's (redacted) response wrapper to persist it.
  save?: (pageIndex: number, wrapper: Obj) => void;
}

export interface RunResult {
  runId: string;
  previewSha256: string;
  pages: PageRun[];
  stoppedEarly: boolean;
}

export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`scrape did not finish within ${ms} ms (wall clock)`), { w2fTimeout: true })), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

// Error classification for ONE attempt. 4xx (other than 408/429-free) = the
// request was refused ("failed"); everything else (timeouts, network, 5xx,
// 408) = outcome unknown ("ambiguous"). Neither is ever retried.
export function classify(err: unknown): "failed" | "ambiguous" {
  const status = isObj(err) && typeof err.status === "number" ? err.status : isObj(err) && isObj(err.response) && typeof err.response.status === "number" ? err.response.status : null;
  if (status !== null && status >= 400 && status < 500 && status !== 408) return "failed";
  return "ambiguous";
}

// Post-response validation. Returns accepted, or rejected/ambiguous + reason.
export async function validateStateResponse(doc: unknown, r: RequestPreview, resolver: Resolver): Promise<{ status: "accepted" | "rejected" | "ambiguous"; reason: string | null; run: Pick<PageRun, "freeze" | "lazy" | "readiness" | "states" | "warnings"> }> {
  const out: Pick<PageRun, "freeze" | "lazy" | "readiness" | "states" | "warnings"> = { freeze: null, lazy: null, readiness: null, states: [], warnings: [] };
  const reject = (status: "rejected" | "ambiguous", reason: string) => ({ status, reason, run: out });
  if (!isObj(doc)) return reject("ambiguous", "response is not an object");
  if (JSON.stringify(doc).length > LIMITS.hifiMaxJsonBytes) return reject("rejected", "response exceeds the byte bound");
  const meta = isObj(doc.metadata) ? doc.metadata : {};
  const finalUrl = typeof meta.url === "string" ? meta.url : null;
  if (!finalUrl) return reject("rejected", "no final URL reported (metadata.url)");
  try {
    await assertHostedFirecrawlUrl(finalUrl, resolver);
  } catch (err) {
    return reject("rejected", `final URL failed the URL guard: ${err instanceof Error ? err.message : "invalid"}`);
  }
  const requested = parseHttpUrl(r.pageUrl);
  const final = parseHttpUrl(finalUrl);
  if (!isSameSite(final, requested)) return reject("rejected", "final URL is on another site");
  if (canonicalizeUrl(final) !== canonicalizeUrl(requested)) return reject("rejected", `redirected to ${canonicalizeUrl(final)}; redirects are not accepted`);
  if (typeof meta.statusCode === "number" && (meta.statusCode < 200 || meta.statusCode > 299)) return reject("rejected", `HTTP status ${meta.statusCode}`);
  if (typeof meta.contentType === "string" && !meta.contentType.toLowerCase().startsWith("text/html")) return reject("rejected", `content type ${meta.contentType.slice(0, 60)}`);
  const actions = isObj(doc.actions) ? doc.actions : null;
  const returns = actions && Array.isArray(actions.javascriptReturns) ? actions.javascriptReturns : null;
  const shots = actions && Array.isArray(actions.screenshots) ? actions.screenshots : null;
  const scrapes = actions && Array.isArray(actions.scrapes) ? actions.scrapes : null;
  const jsRoles = r.roles.filter((x) => x.role === "freeze" || x.role === "scroll" || x.role === "apply" || x.role === "state" || x.role === "revert");
  const scrolls: Obj[] = [];
  // Each planned executeJavascript must have returned its tagged object, in order.
  if (!returns || returns.length !== jsRoles.length) return reject("ambiguous", `expected ${jsRoles.length} javascriptReturns, got ${returns ? returns.length : "none"} (possibly a partial run or unawaited async script)`);
  for (const [i, role] of jsRoles.entries()) {
    const v = isObj(returns[i]) ? (returns[i] as Obj).value : undefined;
    if (!isObj(v) || v.w2f !== role.role) return reject("ambiguous", `javascriptReturns[${i}] is not the expected "${role.role}" result`);
    if ((role.role === "apply" || role.role === "state" || role.role === "revert") && v.seq !== role.seq) return reject("ambiguous", `javascriptReturns[${i}] has seq ${String(v.seq)}, expected ${role.seq}`);
    if (role.role === "freeze") out.freeze = v;
    if (role.role === "scroll") scrolls.push(v);
  }
  if (scrolls.length) {
    const last = scrolls[scrolls.length - 1]!;
    out.lazy = { steps: scrolls.length, finalY: last.y ?? null, scrollHeight: last.scrollHeight ?? null, maxGapPx: last.maxGapPx ?? null, coverageComplete: scrolls.every((x) => x.coverageComplete === true), cappedByMaxPx: scrolls.some((x) => x.cappedByMaxPx === true) };
    if (out.lazy.coverageComplete !== true) out.warnings.push("lazy-load coverage partial: scroll steps were further apart than the viewport");
  }
  if (!shots || shots.length !== r.states.length || !shots.every((s) => typeof s === "string" && s.length <= LIMITS.maxUrlChars)) return reject("ambiguous", `expected ${r.states.length} screenshots`);
  if (!scrapes || scrapes.length !== r.states.length) return reject("ambiguous", `expected ${r.states.length} scrapes`);
  for (const s of r.states) {
    const measuredV = (returns.find((x) => isObj(x) && isObj(x.value) && x.value.w2f === "state" && x.value.seq === s.seq) as Obj).value as Obj;
    const applyV = (returns.find((x) => isObj(x) && isObj(x.value) && x.value.w2f === "apply" && x.value.seq === s.seq) as Obj).value as Obj;
    // apply results (applied/refused/trigger/error) merged with the measurement
    const v: Obj = { ...measuredV, applied: applyV.applied, refused: applyV.refused, trigger: applyV.trigger, error: (typeof applyV.error === "string" && applyV.error) || measuredV.error, missing: [...(Array.isArray(applyV.missing) ? applyV.missing : []), ...(Array.isArray(measuredV.missing) ? measuredV.missing : [])] };
    const rv = returns.find((x) => isObj(x) && isObj(x.value) && x.value.w2f === "revert" && x.value.seq === s.seq) as Obj | undefined;
    const rvv = rv && isObj(rv.value) ? rv.value : null;
    if (v.name !== s.name) return reject("ambiguous", `state ${s.seq} returned name ${String(v.name)}`);
    if (v.provenance !== s.provenance) return reject("ambiguous", `state ${s.seq} provenance mismatch`);
    const err = typeof v.error === "string" ? v.error.slice(0, 200) : null;
    out.states.push({ seq: s.seq, name: s.name, provenance: s.provenance, applied: Array.isArray(v.applied) ? v.applied.length : 0, refused: Array.isArray(v.refused) ? v.refused.length : 0, missing: Array.isArray(v.missing) ? v.missing.length : 0, error: err, reverted: rvv && typeof rvv.reverted === "number" ? rvv.reverted : null, revertFailed: rvv && typeof rvv.failed === "number" ? rvv.failed : null, trigger: isObj(v.trigger) ? v.trigger : null });
    if (s.provenance === "page-api") {
      const t = isObj(v.trigger) ? v.trigger : null;
      if (!t || t.valid !== true) out.warnings.push(`state "${s.name}": page-API trigger refused (${t && typeof t.reason === "string" ? t.reason : "no trigger report"}); this variant equals the pre-trigger page`);
      else if (t.moved !== true) out.warnings.push(`state "${s.name}": Swiper did not move`);
    }
    const vf = isObj(v.verify) ? v.verify : null;
    if (vf && vf.expandedViewport === true) out.warnings.push(`state "${s.name}": action viewport ${isObj(vf.viewport) ? `${String(vf.viewport.width)}x${String(vf.viewport.height)}` : "?"} is taller than any documented screenshot viewport; screenshot position cannot be verified (likely shows the page top)`);
    else if (vf && isObj(vf.target) && vf.target.inViewport !== true) out.warnings.push(`state "${s.name}": target ${String(vf.target.selector)} was not fully inside the viewport after scrolling (viewTop ${String(vf.target.viewTop)})`);
    if (s.seq === 0 && isObj(v.readiness)) {
      out.readiness = v.readiness;
      if (typeof v.readiness.imagesIncomplete === "number" && v.readiness.imagesIncomplete > 0) out.warnings.push(`${v.readiness.imagesIncomplete} image(s) still incomplete at baseline measurement`);
      if (v.readiness.fontsStatus === "loading") out.warnings.push("web fonts still loading at baseline measurement");
    }
    if (err) out.warnings.push(`state "${s.name}" failed in the browser (${err}); it reverted itself`);
    if ((s.provenance === "synthetic" || s.provenance === "page-api") && Array.isArray(v.applied) && v.applied.length === 0) out.warnings.push(`state "${s.name}": no modification applied`);
    if (rvv && rvv.failed !== 0) out.warnings.push(`state "${s.name}": revert reported ${String(rvv.failed)} failure(s)`);
  }
  if (out.freeze && Array.isArray(out.freeze.modifications) && out.freeze.modifications.length) out.warnings.push(`freeze modified the page: ${out.freeze.modifications.map(String).join("; ").slice(0, 160)}`);
  return { status: "accepted", reason: null, run: out };
}

export async function executeStateRun(o: ExecuteOptions): Promise<RunResult> {
  const now = o.now ?? (() => new Date());
  const log = o.log ?? (() => {});
  const resolver = o.resolver ?? systemResolver;
  const runId = o.runId ?? sha256(`${o.validated.previewSha256}:${now().toISOString()}:${Math.random()}`).slice(0, 16);
  const gate = assertRunGates(o.validated, o.gates);
  const secrets: string[] = [];
  const pages: PageRun[] = [];
  let stopped = false;
  let client: StateScrapeClient | null = null;
  for (const [i, req] of o.validated.requests.entries()) {
    const r = req.preview;
    const run: PageRun = {
      schema: "website-to-figma/state-run",
      schemaVersion: 1,
      runId,
      pageUrl: r.pageUrl,
      previewSha256: o.validated.previewSha256,
      requestSha256: req.requestSha256,
      ledgerEntryId: null,
      attempts: 0,
      retries: 0,
      status: "not-attempted",
      reason: null,
      operatorCreditsPerRequest: gate.perRequest,
      reportedCreditsUsed: null,
      checkpoints: [],
      freeze: null,
      lazy: null,
      readiness: null,
      states: [],
      warnings: [],
    };
    pages.push(run);
    const cp = (step: string, detail = "") => {
      run.checkpoints.push({ at: now().toISOString(), step, detail: redact(detail, secrets) });
      log(`[${r.pageUrl}] ${step}${detail ? `: ${redact(detail, secrets)}` : ""}`);
    };
    if (stopped) {
      run.reason = "run stopped before this page (earlier page not accepted); manual reviewed continuation only";
      continue;
    }
    cp("validated", `request sha256 ${req.requestSha256}; ${r.actionCount} actions; combined waits ${r.combinedWaitMs} ms`);
    try {
      await assertHostedFirecrawlUrl(r.pageUrl, resolver);
    } catch (err) {
      run.status = "rejected";
      run.reason = `start URL failed the URL guard: ${err instanceof Error ? err.message : "invalid"}`;
      cp("guard-failed", run.reason);
      stopped = true;
      continue;
    }
    cp("url-guard-passed");
    // All guards complete: only now is the key requested and a client created.
    if (!client) {
      const key = o.getApiKey()?.trim();
      if (!key) {
        run.reason = "FIRECRAWL_API_KEY is not set; nothing was sent and no ledger attempt was recorded";
        cp("no-key", run.reason);
        stopped = true;
        continue;
      }
      secrets.push(key);
      try {
        client = await (o.createClient ?? createStateScrapeClient)(key);
      } catch (err) {
        run.reason = redact(`client could not be created: ${err instanceof Error ? err.message : String(err)}`, secrets);
        cp("client-failed", run.reason);
        stopped = true;
        continue;
      }
    }
    let entryId: string;
    try {
      entryId = reserveAttempt(o.gates.ledgerPath as string, { url: r.pageUrl, requestSha256: req.requestSha256, reserved: gate.perRequest, command: "states-run", continuationOf: o.gates.reviewedContinuation }, now).id;
    } catch (err) {
      run.reason = err instanceof LedgerError ? err.message : String(err);
      cp("ledger-refused", run.reason);
      stopped = true;
      continue;
    }
    run.ledgerEntryId = entryId;
    cp("ledger-attempt-recorded", `entry ${entryId}; reserved ${gate.perRequest} (operator-asserted)`);
    const { url, ...opts } = r.body as unknown as Obj;
    let doc: unknown;
    let outcome: "ok" | "failed" | "ambiguous" = "ok";
    run.attempts = 1;
    try {
      cp("request-sent", "attempt 1 of 1 (no retries, autoResume false)");
      doc = await withTimeout(client.scrape(String(url), { ...opts, autoResume: false }), r.timing.wallClockMs);
      cp("response-received");
    } catch (err) {
      outcome = classify(err);
      run.reason = redact(`request ${outcome}: ${err instanceof Error ? err.message : String(err)}`, secrets);
      cp(outcome === "failed" ? "request-failed" : "request-ambiguous", run.reason);
    }
    const reported = isObj(doc) && isObj(doc.metadata) && typeof doc.metadata.creditsUsed === "number" && Number.isInteger(doc.metadata.creditsUsed) && doc.metadata.creditsUsed >= 0 ? doc.metadata.creditsUsed : null;
    run.reportedCreditsUsed = reported;
    if (outcome === "ok") {
      const v = await validateStateResponse(doc, r, resolver);
      run.status = v.status;
      run.reason = v.reason;
      Object.assign(run, v.run);
      cp(`response-${v.status}`, v.reason ?? `${run.states.length} state(s); freeze ${run.freeze ? "reported" : "missing"}`);
    } else {
      run.status = outcome;
    }
    // Missing request-specific credits: never settled at an assumed price.
    if (outcome === "ok" && reported === null) {
      run.warnings.push("response reported no request-specific creditsUsed; credits are UNKNOWN (ledger entry left ambiguous; remaining pages stopped)");
      stopped = true;
    }
    try {
      const e = settleAttempt(o.gates.ledgerPath as string, entryId, run.status === "accepted" || run.status === "rejected" ? "succeeded" : run.status === "failed" ? "failed" : "ambiguous", reported, `${run.status}${run.reason ? `: ${run.reason}` : ""}; request-specific creditsUsed ${reported ?? "not reported"}`);
      cp("ledger-result-recorded", `ledger status ${e.status}${e.overrun ? " OVERRUN" : ""}; reported creditsUsed ${reported ?? "not reported"}`);
    } catch (err) {
      run.warnings.push(`ledger result not recorded: ${err instanceof Error ? err.message : String(err)}`);
      stopped = true;
    }
    if (doc !== undefined && o.save) {
      o.save(i, { success: true, data: doc, w2fRun: run });
      cp("saved");
    }
    if (run.status !== "accepted") stopped = true;
    if (reported !== null && reported > gate.perRequest) {
      run.warnings.push(`OVERRUN: provider reported ${reported} credits for this request, above the operator-asserted reservation ${gate.perRequest}; recorded in the ledger; remaining pages stopped and later runs blocked until resolved`);
      stopped = true;
    }
  }
  return { runId, previewSha256: o.validated.previewSha256, pages, stoppedEarly: stopped };
}

// Exact stop conditions (also printed by the CLI before any request).
export const STOP_CONDITIONS = [
  "preview file differs from the plan's rebuilt preview, or any request fails semantic validation",
  "any operator gate missing: asserted credits/request, reported balance, existing-credit and no-top-up confirmations, synthetic acknowledgement, ledger",
  "ledger: unresolved attempting/ambiguous/overrun entry, identical request already attempted (without --reviewed-continuation), or the 1000-credit local project budget ceiling would be exceeded by the operator-asserted reservation (local allowance only, NOT a provider cap; no pre-send guarantee)",
  "FIRECRAWL_API_KEY absent after all guards -> nothing sent, no ledger attempt",
  "projection (asserted credits x pages) exceeds the operator-reported balance",
  "start or final URL fails the hosted URL guard; final URL off-site or redirected; non-2xx status; non-HTML content",
  "SDK error: 4xx -> failed, timeout/network/5xx/408 -> ambiguous; never retried",
  "missing/out-of-order tagged javascriptReturns, screenshots or scrapes -> ambiguous (no retry, no per-state fallback)",
  "response without request-specific creditsUsed -> ledger entry ambiguous, remaining pages stopped (never settled at an assumed price)",
  "request-specific creditsUsed above the operator-asserted reservation -> OVERRUN recorded, remaining pages stopped, later runs blocked until resolved",
  "any page not accepted -> remaining pages not attempted; continuation only after manual review",
];
