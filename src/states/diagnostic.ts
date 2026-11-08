// Minimal VIEWPORT DIAGNOSTIC (one hosted request, fixed shape). It answers
// one question: does a documented screenshot action `viewport` resize the
// page's layout viewport persistently for later actions, and can the page
// then scroll? It is NOT a general script runner: the request body, the 9
// actions and the read-only probe scripts are fixed constants; only an exact
// rebuilt preview is accepted. No internal flags (realViewport), no device or
// top-level viewport fields, no Swiper/AOS/freeze, no extra formats.
//
// Probe semantics (keep distinct):
//   innerWidth/innerHeight        layout viewport size the page sees
//   root clientWidth/clientHeight documentElement client box (layout, minus scrollbars)
//   visualViewport.*              visual viewport (pinch-zoom/offsets)
//   documentHeight                max(documentElement.scrollHeight, body.scrollHeight)
// A screenshot's PNG size is the CROP; it is compared, never assumed equal,
// to the above. Image differences alone do not prove scrolling (animated pages).
//
// Execution (paid) shares the state-run safeguards: exact preview, operator
// gates checked before the key is read, hosted URL guard (exact approved DNS
// exceptions only), ledger attempt persisted BEFORE the single POST and the
// result AFTER, SDK maxRetries 1 + autoResume false, no replay or fallback,
// missing credits / partial results => ambiguous stop.
import { assertHostedFirecrawlUrl, isSameSite, parseHttpUrl, systemResolver, type Resolver } from "../security/urlGuard";
import { canonicalizeUrl } from "../normalize/canonicalize";
import { LIMITS } from "../shared/limits";
import { canonicalJson, classify, createStateScrapeClient, redact, sha256, StateRunPolicyError, withTimeout, type StateScrapeClient } from "./execute";
import { readLedger, reserveAttempt, settleAttempt, committedCredits, unresolved, LedgerError } from "./ledger";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

export const DIAG_URL = "https://bootstrapmade.com/content/demo/Bootslander/";
export const DIAG_SCREENSHOT = { type: "screenshot", fullPage: false, viewport: { width: 1920, height: 1080 } } as const;
export const DIAG_TIMEOUT_MS = 60_000;
export const DIAG_WALL_MS = DIAG_TIMEOUT_MS + 30_000;
export const DIAG_TAGS = ["P0", "P1", "scroll", "P2", "P3"] as const;

// Read-only synchronous probe (no DOM writes). `tag` is a fixed literal.
const rect = `(s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { top: r.top, left: r.left, width: r.width, height: r.height, bottom: r.bottom, documentY: r.top + (window.scrollY || 0) }; }`;
export function probeScript(tag: "P0" | "P1" | "P2" | "P3"): string {
  return `(function w2fDiagProbe() { const d = document.documentElement, b = document.body, vv = window.visualViewport, rect = ${rect}; return { w2f: "diag-probe", tag: ${JSON.stringify(tag)}, innerWidth: window.innerWidth, innerHeight: window.innerHeight, rootClientWidth: d.clientWidth, rootClientHeight: d.clientHeight, visualViewport: vv ? { width: vv.width, height: vv.height, scale: vv.scale, offsetTop: vv.offsetTop, pageTop: vv.pageTop } : null, scrollY: window.scrollY, documentHeight: Math.max(d.scrollHeight, b ? b.scrollHeight : 0), devicePixelRatio: window.devicePixelRatio, readyState: document.readyState, features: rect("#features"), hero: rect("#hero") }; })();`;
}
export const SCROLL_REPORT_SCRIPT = `(function w2fDiagScroll() { window.scrollTo(0, 3000); return { w2f: "diag-scroll", requested: 3000, scrollY: window.scrollY, innerHeight: window.innerHeight, documentHeight: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0) }; })();`;

export type DiagRole = "wait" | "probe" | "screenshot" | "scroll";
export interface DiagnosticPreview {
  schema: "website-to-figma/diagnostic-preview";
  schemaVersion: 1;
  sent: false;
  purpose: string;
  notice: string[];
  body: { url: string; formats: ["rawHtml"]; onlyMainContent: false; proxy: "basic"; timeout: number; actions: Obj[] };
  roles: { index: number; role: DiagRole; tag?: string }[];
  actionCount: 9;
  combinedWaitMs: 3000;
  screenshots: 2;
  timing: { requestTimeoutMs: number; sdkHttpTimeoutMs: number; wallClockMs: number };
}

export function buildDiagnosticPreview(): DiagnosticPreview {
  const actions: Obj[] = [
    { type: "wait", milliseconds: 2000 },
    { type: "executeJavascript", script: probeScript("P0") },
    { ...DIAG_SCREENSHOT, viewport: { ...DIAG_SCREENSHOT.viewport } },
    { type: "executeJavascript", script: probeScript("P1") },
    { type: "executeJavascript", script: SCROLL_REPORT_SCRIPT },
    { type: "wait", milliseconds: 1000 },
    { type: "executeJavascript", script: probeScript("P2") },
    { ...DIAG_SCREENSHOT, viewport: { ...DIAG_SCREENSHOT.viewport } },
    { type: "executeJavascript", script: probeScript("P3") },
  ];
  const roles: DiagnosticPreview["roles"] = [
    { index: 0, role: "wait" },
    { index: 1, role: "probe", tag: "P0" },
    { index: 2, role: "screenshot", tag: "S1" },
    { index: 3, role: "probe", tag: "P1" },
    { index: 4, role: "scroll", tag: "scroll" },
    { index: 5, role: "wait" },
    { index: 6, role: "probe", tag: "P2" },
    { index: 7, role: "screenshot", tag: "S2" },
    { index: 8, role: "probe", tag: "P3" },
  ];
  return {
    schema: "website-to-figma/diagnostic-preview",
    schemaVersion: 1,
    sent: false,
    purpose: "Viewport diagnostic: does a screenshot action viewport (1920x1080) resize the layout viewport persistently, and can the page then scroll? One page, one request.",
    notice: [
      "NOT SENT. Paid execution (diag-run) is a separate operator-gated command that HOLDS without --yes.",
      "Provider cost is UNKNOWN beyond the documented 1 credit per scrape: screenshot/action/scan pricing is not published. The local ledger is a reservation allowance, not a provider cap.",
      "Probes are read-only. The only page effect is window.scrollTo(0, 3000).",
      "PNG size is the screenshot crop; compare it to innerHeight, root clientHeight, visualViewport and document height without assuming they are equal. Image differences alone do not prove scrolling.",
    ],
    body: { url: DIAG_URL, formats: ["rawHtml"], onlyMainContent: false, proxy: "basic", timeout: DIAG_TIMEOUT_MS, actions },
    roles,
    actionCount: 9,
    combinedWaitMs: 3000,
    screenshots: 2,
    timing: { requestTimeoutMs: DIAG_TIMEOUT_MS, sdkHttpTimeoutMs: DIAG_TIMEOUT_MS + 5_000, wallClockMs: DIAG_WALL_MS },
  };
}

export function diagnosticPreviewSha256(p: DiagnosticPreview = buildDiagnosticPreview()): string {
  return sha256(canonicalJson(p));
}

// Exact preview only (canonical JSON equality with the rebuilt constant).
export function validateDiagnosticPreview(json: unknown): { preview: DiagnosticPreview; previewSha256: string; requestSha256: string } {
  const preview = buildDiagnosticPreview();
  if (canonicalJson(json) !== canonicalJson(preview)) throw new StateRunPolicyError("diagnostic preview does not match the fixed reviewed diagnostic; regenerate it with diag-plan and review that exact file");
  return { preview, previewSha256: diagnosticPreviewSha256(preview), requestSha256: sha256(canonicalJson(preview.body)) };
}

export interface DiagGates {
  operatorCreditsPerRequest?: number;
  operatorReportedBalance?: number;
  confirmExistingCredits?: boolean;
  confirmNoTopup?: boolean;
  ledgerPath?: string;
  reviewedContinuation?: string;
}

export function assertDiagnosticGates(g: DiagGates): { perRequest: number; committed: number; remaining: number } {
  const missing: string[] = [];
  if (!Number.isInteger(g.operatorCreditsPerRequest) || (g.operatorCreditsPerRequest as number) < 1 || (g.operatorCreditsPerRequest as number) > 100) missing.push("--operator-credits-per-request N (1..100; YOUR asserted reservation, not a price)");
  if (!Number.isInteger(g.operatorReportedBalance) || (g.operatorReportedBalance as number) < 0) missing.push("--operator-reported-balance N");
  if (!g.confirmExistingCredits) missing.push("--confirm-existing-credits");
  if (!g.confirmNoTopup) missing.push("--confirm-no-topup");
  if (!g.ledgerPath) missing.push("--ledger FILE (local project ledger; reservation allowance, not a provider cap)");
  if (missing.length) throw new StateRunPolicyError(`Refusing before any request: missing operator inputs:\n  ${missing.join("\n  ")}`);
  const perRequest = g.operatorCreditsPerRequest as number;
  if (perRequest > (g.operatorReportedBalance as number)) throw new StateRunPolicyError(`operator-asserted reservation ${perRequest} exceeds the operator-reported balance ${g.operatorReportedBalance}`);
  let l;
  try {
    l = readLedger(g.ledgerPath as string);
  } catch (err) {
    throw new StateRunPolicyError(err instanceof Error ? err.message : String(err));
  }
  const open = unresolved(l);
  if (open.length) throw new StateRunPolicyError(`ledger has unresolved paid attempt(s): ${open.map((e) => e.id).join(", ")}; resolve them first ("ledger resolve")`);
  const committed = committedCredits(l);
  if (committed + perRequest > l.capCredits) throw new StateRunPolicyError(`ledger: ${committed} committed + ${perRequest} reservation exceeds the ${l.capCredits}-credit local project budget ceiling (not a provider cap)`);
  return { perRequest, committed, remaining: l.capCredits - committed };
}

export interface DiagProbe {
  tag: string;
  innerWidth: number | null;
  innerHeight: number | null;
  rootClientWidth: number | null;
  rootClientHeight: number | null;
  visualViewport: { width: number; height: number; scale: number; offsetTop: number; pageTop: number } | null;
  scrollY: number | null;
  documentHeight: number | null;
  devicePixelRatio: number | null;
  readyState: string | null;
  features: Obj | null;
  hero: Obj | null;
}
export interface DiagnosticRecord {
  schema: "website-to-figma/diagnostic-run";
  schemaVersion: 1;
  runId: string;
  pageUrl: string;
  previewSha256: string;
  requestSha256: string;
  ledgerEntryId: string | null;
  attempts: 0 | 1;
  retries: 0;
  status: "accepted" | "rejected" | "failed" | "ambiguous" | "not-attempted";
  reason: string | null;
  operatorCreditsPerRequest: number;
  reportedCreditsUsed: number | null;
  checkpoints: { at: string; step: string; detail: string }[];
  probes: DiagProbe[];
  scroll: { requested: number; scrollY: number | null; innerHeight: number | null; documentHeight: number | null } | null;
  // provider screenshot URLs in action order (S1 after P0, S2 after P2); never downloaded here
  screenshots: string[];
  warnings: string[];
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

function parseProbe(v: Obj): DiagProbe {
  const vv = isObj(v.visualViewport) ? v.visualViewport : null;
  return {
    tag: String(v.tag),
    innerWidth: num(v.innerWidth),
    innerHeight: num(v.innerHeight),
    rootClientWidth: num(v.rootClientWidth),
    rootClientHeight: num(v.rootClientHeight),
    visualViewport: vv ? { width: num(vv.width) ?? 0, height: num(vv.height) ?? 0, scale: num(vv.scale) ?? 0, offsetTop: num(vv.offsetTop) ?? 0, pageTop: num(vv.pageTop) ?? 0 } : null,
    scrollY: num(v.scrollY),
    documentHeight: num(v.documentHeight),
    devicePixelRatio: num(v.devicePixelRatio),
    readyState: typeof v.readyState === "string" ? v.readyState.slice(0, 20) : null,
    features: isObj(v.features) ? v.features : null,
    hero: isObj(v.hero) ? v.hero : null,
  };
}

// Post-response validation: same URL rules as state runs; exactly 5 tagged
// returns in order (P0, P1, scroll, P2, P3) and exactly 2 screenshot URLs.
export async function validateDiagnosticResponse(doc: unknown, resolver: Resolver): Promise<{ status: "accepted" | "rejected" | "ambiguous"; reason: string | null; probes: DiagProbe[]; scroll: DiagnosticRecord["scroll"]; screenshots: string[] }> {
  const empty = { probes: [] as DiagProbe[], scroll: null, screenshots: [] as string[] };
  const reject = (status: "rejected" | "ambiguous", reason: string) => ({ status, reason, ...empty });
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
  const want = parseHttpUrl(DIAG_URL);
  const got = parseHttpUrl(finalUrl);
  if (!isSameSite(got, want) || canonicalizeUrl(got) !== canonicalizeUrl(want)) return reject("rejected", `final URL ${canonicalizeUrl(got)} is not the diagnostic page (redirects are not accepted)`);
  if (typeof meta.statusCode === "number" && (meta.statusCode < 200 || meta.statusCode > 299)) return reject("rejected", `HTTP status ${meta.statusCode}`);
  if (typeof meta.contentType === "string" && !meta.contentType.toLowerCase().startsWith("text/html")) return reject("rejected", `content type ${meta.contentType.slice(0, 60)}`);
  const actions = isObj(doc.actions) ? doc.actions : null;
  const returns = actions && Array.isArray(actions.javascriptReturns) ? actions.javascriptReturns : null;
  const shots = actions && Array.isArray(actions.screenshots) ? actions.screenshots : null;
  if (!returns || returns.length !== DIAG_TAGS.length) return reject("ambiguous", `expected ${DIAG_TAGS.length} javascriptReturns, got ${returns ? returns.length : "none"} (partial probes)`);
  const probes: DiagProbe[] = [];
  let scroll: DiagnosticRecord["scroll"] = null;
  for (const [i, tag] of DIAG_TAGS.entries()) {
    const v = isObj(returns[i]) ? (returns[i] as Obj).value : undefined;
    if (tag === "scroll") {
      if (!isObj(v) || v.w2f !== "diag-scroll") return reject("ambiguous", `javascriptReturns[${i}] is not the scroll report`);
      scroll = { requested: 3000, scrollY: num(v.scrollY), innerHeight: num(v.innerHeight), documentHeight: num(v.documentHeight) };
    } else {
      if (!isObj(v) || v.w2f !== "diag-probe" || v.tag !== tag) return reject("ambiguous", `javascriptReturns[${i}] is not probe ${tag}`);
      probes.push(parseProbe(v));
    }
  }
  if (!shots || shots.length !== 2 || !shots.every((s) => typeof s === "string" && s.length <= LIMITS.maxUrlChars)) return reject("ambiguous", `expected 2 screenshot URLs, got ${shots ? shots.length : "none"}`);
  return { status: "accepted", reason: null, probes, scroll, screenshots: shots as string[] };
}

export interface DiagExecuteOptions {
  validated: { previewSha256: string; requestSha256: string; preview: DiagnosticPreview };
  gates: DiagGates;
  getApiKey: () => string | undefined;
  createClient?: (apiKey: string) => Promise<StateScrapeClient>;
  resolver?: Resolver;
  now?: () => Date;
  runId?: string;
  log?: (m: string) => void;
  save?: (wrapper: Obj) => void;
}

export async function executeDiagnostic(o: DiagExecuteOptions): Promise<DiagnosticRecord> {
  const now = o.now ?? (() => new Date());
  const resolver = o.resolver ?? systemResolver;
  const gate = assertDiagnosticGates(o.gates);
  const secrets: string[] = [];
  const rec: DiagnosticRecord = {
    schema: "website-to-figma/diagnostic-run",
    schemaVersion: 1,
    runId: o.runId ?? sha256(`${o.validated.previewSha256}:${now().toISOString()}:${Math.random()}`).slice(0, 16),
    pageUrl: DIAG_URL,
    previewSha256: o.validated.previewSha256,
    requestSha256: o.validated.requestSha256,
    ledgerEntryId: null,
    attempts: 0,
    retries: 0,
    status: "not-attempted",
    reason: null,
    operatorCreditsPerRequest: gate.perRequest,
    reportedCreditsUsed: null,
    checkpoints: [],
    probes: [],
    scroll: null,
    screenshots: [],
    warnings: [],
  };
  const cp = (step: string, detail = "") => {
    rec.checkpoints.push({ at: now().toISOString(), step, detail: redact(detail, secrets) });
    o.log?.(`[diagnostic] ${step}${detail ? `: ${redact(detail, secrets)}` : ""}`);
  };
  cp("validated", `request sha256 ${o.validated.requestSha256}; 9 actions; 2 screenshots; combined waits 3000 ms`);
  try {
    await assertHostedFirecrawlUrl(DIAG_URL, resolver);
  } catch (err) {
    rec.status = "rejected";
    rec.reason = `start URL failed the URL guard: ${err instanceof Error ? err.message : "invalid"}`;
    cp("guard-failed", rec.reason);
    return rec;
  }
  cp("url-guard-passed");
  const key = o.getApiKey()?.trim();
  if (!key) {
    rec.reason = "FIRECRAWL_API_KEY is not set; nothing was sent and no ledger attempt was recorded";
    cp("no-key", rec.reason);
    return rec;
  }
  secrets.push(key);
  let client: StateScrapeClient;
  try {
    client = await (o.createClient ?? createStateScrapeClient)(key);
  } catch (err) {
    rec.reason = redact(`client could not be created: ${err instanceof Error ? err.message : String(err)}`, secrets);
    cp("client-failed", rec.reason);
    return rec;
  }
  let entryId: string;
  try {
    entryId = reserveAttempt(o.gates.ledgerPath as string, { url: DIAG_URL, requestSha256: o.validated.requestSha256, reserved: gate.perRequest, command: "diag-run", continuationOf: o.gates.reviewedContinuation }, now).id;
  } catch (err) {
    rec.reason = err instanceof LedgerError ? err.message : String(err);
    cp("ledger-refused", rec.reason);
    return rec;
  }
  rec.ledgerEntryId = entryId;
  cp("ledger-attempt-recorded", `entry ${entryId}; reserved ${gate.perRequest} (operator-asserted)`);
  const { url, ...opts } = o.validated.preview.body;
  let doc: unknown;
  let outcome: "ok" | "failed" | "ambiguous" = "ok";
  rec.attempts = 1;
  try {
    cp("request-sent", "attempt 1 of 1 (no retries, autoResume false)");
    doc = await withTimeout(client.scrape(url, { ...opts, autoResume: false }), DIAG_WALL_MS);
    cp("response-received");
  } catch (err) {
    outcome = classify(err);
    rec.reason = redact(`request ${outcome}: ${err instanceof Error ? err.message : String(err)}`, secrets);
    cp(outcome === "failed" ? "request-failed" : "request-ambiguous", rec.reason);
  }
  const reported = isObj(doc) && isObj(doc.metadata) && typeof doc.metadata.creditsUsed === "number" && Number.isInteger(doc.metadata.creditsUsed) && doc.metadata.creditsUsed >= 0 ? doc.metadata.creditsUsed : null;
  rec.reportedCreditsUsed = reported;
  if (outcome === "ok") {
    const v = await validateDiagnosticResponse(doc, resolver);
    rec.status = v.status;
    rec.reason = v.reason;
    rec.probes = v.probes;
    rec.scroll = v.scroll;
    rec.screenshots = v.screenshots;
    cp(`response-${v.status}`, v.reason ?? "5 probes/report, 2 screenshot URLs");
    if (reported === null) rec.warnings.push("response reported no request-specific creditsUsed; credits are UNKNOWN (ledger entry left ambiguous)");
  } else rec.status = outcome;
  try {
    const e = settleAttempt(o.gates.ledgerPath as string, entryId, rec.status === "accepted" || rec.status === "rejected" ? "succeeded" : rec.status === "failed" ? "failed" : "ambiguous", reported, `${rec.status}${rec.reason ? `: ${rec.reason}` : ""}; request-specific creditsUsed ${reported ?? "not reported"}`);
    cp("ledger-result-recorded", `ledger status ${e.status}${e.overrun ? " OVERRUN" : ""}; reported creditsUsed ${reported ?? "not reported"}`);
    if (e.overrun) rec.warnings.push(`OVERRUN: provider reported ${reported} credits, above the reservation ${gate.perRequest}; later paid runs blocked until resolved`);
  } catch (err) {
    rec.warnings.push(`ledger result not recorded: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (doc !== undefined && o.save) {
    o.save({ success: true, data: doc, w2fDiagnostic: rec });
    cp("saved");
  }
  return rec;
}

// ---------------------------------------------------------------------------
// Interpretation (offline). Images are optional: { width, height } of the two
// downloaded PNGs (S1, S2). Conclusions are evidence categories, not proofs.
export interface DiagnosticFindings {
  viewportExpandedAtP0: boolean | null;
  resizeAfterS1: "persisted" | "not-persisted" | "unknown";
  scrollMoved: "yes" | "no" | "unknown";
  resizeAfterS2: "persisted" | "not-persisted" | "unknown";
  crops: { shot: "S1" | "S2"; width: number; height: number; matches: string[] }[];
  conclusion: "screenshot-viewport-resizes-and-persists" | "screenshot-viewport-does-not-persist" | "inconclusive";
  notes: string[];
}

const MAX_SCREENSHOT_VIEWPORT_H = 4320;

export function interpretDiagnostic(rec: Pick<DiagnosticRecord, "probes" | "scroll">, images: ({ width: number; height: number } | null)[] = []): DiagnosticFindings {
  const p = (t: string) => rec.probes.find((x) => x.tag === t);
  const [P0, P1, P2, P3] = [p("P0"), p("P1"), p("P2"), p("P3")];
  const notes: string[] = [];
  const near = (a: number | null | undefined, b: number) => a !== null && a !== undefined && Math.abs(a - b) <= 2;
  const resized = (q?: DiagProbe) => (!q || q.innerHeight === null ? "unknown" : near(q.innerHeight, 1080) && near(q.innerWidth, 1920) ? "persisted" : "not-persisted");
  const expanded = P0 && P0.innerHeight !== null ? P0.innerHeight > MAX_SCREENSHOT_VIEWPORT_H : null;
  const r1 = resized(P1);
  const r2 = resized(P3);
  const sy = rec.scroll?.scrollY ?? P2?.scrollY ?? null;
  const scrollMoved: DiagnosticFindings["scrollMoved"] = sy === null ? "unknown" : sy >= 2990 ? "yes" : sy <= 1 ? "no" : "yes";
  if (sy !== null && sy > 1 && sy < 2990) notes.push(`scrollY ${sy} moved but short of 3000 (document height ${rec.scroll?.documentHeight ?? "?"} may cap it)`);
  if (P0 && P0.innerHeight !== null && P0.rootClientHeight !== null && Math.abs(P0.innerHeight - P0.rootClientHeight) > 2) notes.push(`P0 innerHeight ${P0.innerHeight} != root clientHeight ${P0.rootClientHeight} (layout box excludes scrollbars; keep distinct)`);
  if (P0?.visualViewport && P0.innerHeight !== null && Math.abs(P0.visualViewport.height - P0.innerHeight) > 2) notes.push(`P0 visualViewport.height ${P0.visualViewport.height} != innerHeight ${P0.innerHeight}`);
  const crops: DiagnosticFindings["crops"] = [];
  (["S1", "S2"] as const).forEach((shot, i) => {
    const img = images[i];
    if (!img) return;
    const before = i === 0 ? P0 : P2;
    const after = i === 0 ? P1 : P3;
    const matches: string[] = [];
    for (const [label, q] of [["before", before], ["after", after]] as const) {
      if (!q) continue;
      if (near(q.innerHeight, img.height)) matches.push(`${label}.innerHeight`);
      if (near(q.rootClientHeight, img.height)) matches.push(`${label}.rootClientHeight`);
      if (q.visualViewport && near(q.visualViewport.height, img.height)) matches.push(`${label}.visualViewport.height`);
      if (near(q.documentHeight, img.height)) matches.push(`${label}.documentHeight`);
    }
    crops.push({ shot, width: img.width, height: img.height, matches });
  });
  if (crops.length) notes.push("PNG size is the crop; matching a probe height is evidence of which box was captured, not of position. Image differences alone do not prove scrolling (animated page).");
  let conclusion: DiagnosticFindings["conclusion"] = "inconclusive";
  if (r1 === "persisted" && scrollMoved === "yes") conclusion = "screenshot-viewport-resizes-and-persists";
  else if (r1 === "not-persisted" && expanded === true && scrollMoved === "no") conclusion = "screenshot-viewport-does-not-persist";
  return { viewportExpandedAtP0: expanded, resizeAfterS1: r1, scrollMoved, resizeAfterS2: r2, crops, conclusion, notes };
}
