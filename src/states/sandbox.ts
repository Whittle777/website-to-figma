// ONE disposable Firecrawl Browser Sandbox experiment (code-only Playwright),
// fixed and reviewed; nothing here runs unless an operator passes every gate
// and --yes. Documented lifecycle (https://docs.firecrawl.dev/features/browser,
// public curl reference; transport in sandboxTransport.ts):
//   create  POST   /v2/interact               { ttl: 120, activityTtl: 60 }   (seconds; ttl 30-3600, activityTtl 10-3600)
//   execute POST   /v2/interact/{id}/execute  { code, language: "node", timeout }  (the page is preconnected)
//   delete  DELETE /v2/interact/{id}
// Each operation is ONE fetch (no retry/replay). Delete runs in `finally`
// whenever create returned an id. The ledger entry is written BEFORE create
// and every operation's attempt and outcome is persisted; an ambiguous
// create/execute or a failed/ambiguous cleanup leaves the entry blocking and
// nothing is re-created automatically. Billing per the docs: code-only 2
// credits per browser-minute, 1-minute minimum; there is no provider hard cap.
//
// Page code (fixed, no inputs): request guard; setViewportSize BEFORE any
// request to the target; a redirect PRE-CHECK of the exact target with
// Playwright's APIRequestContext (maxRedirects 0, refuse any 3xx); goto the
// exact URL; main-frame navigations allowed ONLY for the exact raw URL string
// (no normalization); redirect chain refused; viewport verified; Swiper
// autoplay stopped (recorded MODIFICATION); three states of ONE region
// (#testimonials): baseline, slideNext(0), slideNext(0).
//
// Precise gaps (an acceptance gate holds on them; they are not claimed away):
//  * page.route does not intercept server redirect hops; the pre-check
//    narrows but cannot eliminate a redirect between the pre-check and goto
//    (time-of-check/time-of-use). The post-navigation chain check DETECTS a
//    redirect; it does not prevent the redirected request (no SSRF prevention
//    is claimed after a redirect).
//  * Hostnames that RESOLVE to private addresses cannot be checked from page
//    code (the local DNS guard applies only to this tool's own fetches).
//  * Swiper: method names and selectors are not a safety guarantee; the
//    states rely on the known page's supplied HTML/JS semantics (autoplay,
//    loop, no `on` handlers) and are not promised side-effect free.
//  * slideNext(0) states are measured after 0 ms transitions: they are not
//    observed completions of real animated motion.
//  * creditsBilled on delete is not in the current docs: recorded only if
//    present; missing => ambiguous.
import { assertHostedFirecrawlUrl, systemResolver, type Resolver } from "../security/urlGuard";
import { inspectImage, sha256Hex } from "../shared/imageInfo";
import { canonicalJson, classify, redact, sha256, StateRunPolicyError, withTimeout } from "./execute";
import { createInteractClient, INTERACT_API_URL, type InteractClient } from "./sandboxTransport";
import { readLedger, reserveAttempt, settleAttempt, recordOp, committedCredits, unresolved, LedgerError } from "./ledger";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

export const SANDBOX_URL = "https://bootstrapmade.com/content/demo/Bootslander/";
export const SANDBOX = {
  url: SANDBOX_URL,
  viewport: { width: 1920, height: 1080 },
  // seconds (documented ranges: ttl 30-3600, activityTtl 10-3600)
  ttl: 120,
  activityTtl: 60,
  executeTimeoutS: 90,
  navTimeoutMs: 30_000,
  settleMs: 2_000,
  stateWaitMs: 800,
  scope: "#testimonials",
  swiper: "#testimonials .swiper.init-swiper",
  states: ["Default", "Testimonial next", "Testimonial next 2"],
  maxPngBytes: 1_500_000,
  maxPngPixels: 1920 * 1080,
  maxOutputChars: 6_500_000,
  maxElements: 800,
  maxTexts: 600,
  maxImages: 50,
} as const;
// Worst case if the session lives its whole ttl (2 credits per session-minute,
// code-only, per the operator-read pricing): NOT a provider cap.
export const SANDBOX_WORST_CASE_CREDITS = Math.ceil(SANDBOX.ttl / 60) * 2;
if (SANDBOX.ttl < 30 || SANDBOX.ttl > 3600 || SANDBOX.activityTtl < 10 || SANDBOX.activityTtl > 3600) throw new Error("sandbox ttl outside the documented ranges");
export const SANDBOX_WALL_MS = { create: 60_000, execute: SANDBOX.executeTimeoutS * 1000 + 30_000, delete: 60_000 };

// ---- fixed page-side functions (serialized by Playwright page.evaluate) ----
const PAGE_FUNCS = String.raw`
const W2F_PROBE = () => { const d = document.documentElement, b = document.body, vv = window.visualViewport; return { innerWidth: window.innerWidth, innerHeight: window.innerHeight, rootClientWidth: d.clientWidth, rootClientHeight: d.clientHeight, visualViewport: vv ? { width: vv.width, height: vv.height, scale: vv.scale, offsetTop: vv.offsetTop, pageTop: vv.pageTop } : null, scrollY: window.scrollY, documentHeight: Math.max(d.scrollHeight, b ? b.scrollHeight : 0), devicePixelRatio: window.devicePixelRatio, readyState: document.readyState }; };
const W2F_SWIPER = (a) => {
  const els = Array.from(document.querySelectorAll(a.sel));
  const el = els.length === 1 ? els[0] : null; const sw = el ? el.swiper : null;
  let reason = null;
  if (els.length !== 1) reason = "selector must match exactly one element (matched " + els.length + ")";
  else if (!el.classList.contains("swiper")) reason = "element is not a .swiper container";
  else if (el.closest("form, a, button")) reason = "element is inside a form, link or button";
  else if (!sw || typeof sw !== "object" || sw.el !== el || typeof sw.slideNext !== "function") reason = "no Swiper instance bound to this element";
  else if (sw.destroyed || sw.enabled === false) reason = "Swiper instance is destroyed or disabled";
  if (reason) return { valid: false, reason };
  const snap = () => ({ activeIndex: sw.activeIndex, realIndex: sw.realIndex, autoplayRunning: sw.autoplay ? !!sw.autoplay.running : null });
  const before = snap();
  if (a.op === "stop-autoplay") { if (sw.autoplay && typeof sw.autoplay.stop === "function" && sw.autoplay.running) sw.autoplay.stop(); }
  else if (a.op === "next") sw.slideNext(0);
  const after = snap();
  return { valid: true, reason: null, op: a.op, before, after, moved: after.realIndex !== before.realIndex || after.activeIndex !== before.activeIndex };
};
const W2F_INTO_VIEW = (sel) => { const e = document.querySelector(sel); if (!e) return false; e.scrollIntoView({ block: "start", inline: "nearest" }); return true; };
const W2F_MEASURE = (a) => {
  const t = document.querySelector(a.scope); if (!t) return { target: null };
  const sx = window.scrollX, sy = window.scrollY, tr = t.getBoundingClientRect();
  const region = { x: tr.left + sx, y: tr.top + sy, w: tr.width, h: tr.height };
  const hit = (b) => b.width > 0 && b.height > 0 && b.left + sx < region.x + region.w && b.right + sx > region.x && b.top + sy < region.y + region.h && b.bottom + sy > region.y;
  const props = ["backgroundColor","color","fontFamily","fontSize","fontWeight","fontStyle","lineHeight","textDecorationLine","borderTopWidth","borderRightWidth","borderBottomWidth","borderLeftWidth","borderTopColor","borderRightColor","borderBottomColor","borderLeftColor","borderRadius","opacity","display","visibility","position","paddingTop","paddingRight","paddingBottom","paddingLeft","objectFit"];
  const styles = (e) => { const c = getComputedStyle(e); const o = {}; for (const k of props) o[k] = c[k]; return o; };
  const elements = [], images = [], texts = [];
  for (const e of [t, ...t.querySelectorAll("*")]) {
    if (elements.length >= a.maxElements) break;
    if (e.closest("svg") || ["SCRIPT","STYLE","NOSCRIPT","TEMPLATE"].includes(e.tagName)) continue;
    const b = e.getBoundingClientRect(), s = styles(e);
    if (!hit(b) || s.display === "none" || s.visibility === "hidden") continue;
    const item = { tag: e.tagName.toLowerCase(), x: b.left + sx, y: b.top + sy, w: b.width, h: b.height, style: s };
    if (e.tagName === "IMG" && images.length < a.maxImages) images.push({ ...item, src: String(e.currentSrc || e.src || "").slice(0, 2048), alt: String(e.alt || "").slice(0, 200) });
    elements.push(item);
  }
  const seg = typeof Intl !== "undefined" && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
  const walker = document.createTreeWalker(t, NodeFilter.SHOW_TEXT); let n;
  while ((n = walker.nextNode()) && texts.length < a.maxTexts) {
    const p = n.parentElement; if (!p || p.closest("script,style,noscript,svg")) continue;
    const s = styles(p); if (s.display === "none" || s.visibility === "hidden") continue;
    const str = n.textContent || ""; if (!str.trim()) continue;
    const parts = seg ? Array.from(seg.segment(str), (x) => [x.index, x.segment]) : Array.from(str).map((ch, i) => [i, ch]);
    let last = null; const runs = [];
    for (const [i, g] of parts) { const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + g.length); const b = r.getBoundingClientRect(); if (!b.width || !b.height || !hit(b)) continue; const x = b.left + sx, y = b.top + sy;
      if (last && Math.abs(last.y - y) < 1 && Math.abs(last.x + last.w - x) < 3) { last.text += g; last.w = x + b.width - last.x; last.h = Math.max(last.h, b.height); } else { last = { text: g, x, y, w: b.width, h: b.height }; runs.push(last); } }
    for (const r of runs) if (r.text.trim() && texts.length < a.maxTexts) texts.push({ ...r, text: r.text.slice(0, 2000), style: s, tag: p.tagName.toLowerCase() });
  }
  // self-contained (Playwright serializes only this function): probe inlined
  const d = document.documentElement, bd = document.body, vv = window.visualViewport;
  const probe = { innerWidth: window.innerWidth, innerHeight: window.innerHeight, rootClientWidth: d.clientWidth, rootClientHeight: d.clientHeight, visualViewport: vv ? { width: vv.width, height: vv.height, scale: vv.scale, offsetTop: vv.offsetTop, pageTop: vv.pageTop } : null, scrollY: window.scrollY, documentHeight: Math.max(d.scrollHeight, bd ? bd.scrollHeight : 0), devicePixelRatio: window.devicePixelRatio, readyState: document.readyState };
  return { target: { selector: a.scope, viewTop: tr.top, viewBottom: tr.bottom, left: tr.left, width: tr.width, height: tr.height, documentY: tr.top + sy, inViewport: tr.top >= -1 && tr.bottom <= window.innerHeight + 1 }, region, probe, elements, texts, images };
};`;

export const SANDBOX_CODE = String.raw`// website-to-figma fixed sandbox code (reviewed; takes no inputs)
const W = ${JSON.stringify({ url: SANDBOX.url, vw: SANDBOX.viewport.width, vh: SANDBOX.viewport.height, navTimeoutMs: SANDBOX.navTimeoutMs, settleMs: SANDBOX.settleMs, stateWaitMs: SANDBOX.stateWaitMs, scope: SANDBOX.scope, swiper: SANDBOX.swiper, states: SANDBOX.states, maxPngBytes: SANDBOX.maxPngBytes, max: { maxElements: SANDBOX.maxElements, maxTexts: SANDBOX.maxTexts, maxImages: SANDBOX.maxImages } })};
${PAGE_FUNCS}
const out = { w2f: "sandbox", v: 1, error: null, viewportSet: null, precheck: null, nav: null, env: null, autoplay: null, modifications: [], blocked: [], states: [] };
try {
  if (typeof page === "undefined" || !page) throw new Error("no Playwright page in this session");
  await page.route("**/*", (route) => {
    const req = route.request(); let u = null; try { u = new URL(req.url()); } catch (e) {}
    let why = null;
    if (!u) why = "invalid-url";
    else {
      const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
      let nav = false; try { nav = req.isNavigationRequest() && req.frame() === page.mainFrame(); } catch (e) {}
      if (!["http:", "https:", "data:", "blob:"].includes(u.protocol)) why = "scheme";
      else if (u.username || u.password) why = "credentials";
      else if (/^[0-9.]+$/.test(host) || host.includes(":")) why = "ip-literal";
      else if (host === "localhost" || /\.(local|internal|localhost|home\.arpa|test|lan)$/.test(host)) why = "local-name";
      else if (nav && req.url() !== W.url) why = "main-frame-navigation-off-target"; // raw string, no normalization
    }
    if (why) { if (out.blocked.length < 50) out.blocked.push({ origin: u ? u.protocol + "//" + u.hostname : "(invalid)", why }); return route.abort(); }
    return route.continue();
  });
  await page.setViewportSize({ width: W.vw, height: W.vh });
  out.viewportSet = { width: W.vw, height: W.vh };
  // Redirect PRE-CHECK (no redirect followed): refuse the run on any 3xx.
  if (!page.request || typeof page.request.get !== "function") throw new Error("APIRequestContext unavailable: redirect pre-check not possible");
  const pre = await page.request.get(W.url, { maxRedirects: 0, timeout: W.navTimeoutMs });
  out.precheck = { status: pre.status(), url: pre.url() };
  if (pre.status() >= 300 && pre.status() < 400) throw new Error("target answered a redirect (" + pre.status() + ") in the pre-check; not navigating");
  if (pre.url() !== W.url) throw new Error("pre-check URL differs from the exact target");
  const resp = await page.goto(W.url, { waitUntil: "load", timeout: W.navTimeoutMs });
  const chain = []; let r = resp ? resp.request() : null;
  while (r && chain.length < 10) { chain.unshift(r.url()); r = r.redirectedFrom(); }
  out.nav = { status: resp ? resp.status() : null, finalUrl: page.url(), chain };
  if (page.url() !== W.url || chain.length !== 1 || chain[0] !== W.url) throw new Error("navigation left the exact target URL (redirect or rewrite)");
  await page.waitForTimeout(W.settleMs);
  out.env = await page.evaluate(W2F_PROBE);
  if (out.env.innerWidth !== W.vw || out.env.innerHeight !== W.vh) throw new Error("viewport not applied: " + out.env.innerWidth + "x" + out.env.innerHeight);
  out.autoplay = await page.evaluate(W2F_SWIPER, { sel: W.swiper, op: "stop-autoplay" });
  if (!out.autoplay.valid) throw new Error("swiper refused: " + out.autoplay.reason);
  if (out.autoplay.before && out.autoplay.before.autoplayRunning) out.modifications.push("stopped autoplay of " + W.swiper + " via its own Swiper API (not the page's original behavior)");
  for (let seq = 0; seq < W.states.length; seq++) {
    let trigger = null;
    if (seq > 0) { trigger = await page.evaluate(W2F_SWIPER, { sel: W.swiper, op: "next" }); if (!trigger.valid) throw new Error("swiper refused: " + trigger.reason); }
    if (!(await page.evaluate(W2F_INTO_VIEW, W.scope))) throw new Error("scope not found");
    await page.waitForTimeout(W.stateWaitMs);
    const m = await page.evaluate(W2F_MEASURE, { scope: W.scope, ...W.max });
    if (!m.target) throw new Error("scope not found");
    const top = Math.max(0, m.target.viewTop);
    const clip = { x: 0, y: top, width: W.vw, height: Math.min(W.vh - top, Math.max(0, m.target.viewBottom - top)) };
    if (clip.height < 1) throw new Error("target not visible for the screenshot");
    const png = await page.screenshot({ type: "png", clip, timeout: 15000 });
    if (png.length > W.maxPngBytes) throw new Error("screenshot over the byte cap");
    out.states.push({ seq, name: W.states[seq], trigger, measured: m, clip, png: png.toString("base64") });
  }
} catch (e) {
  out.error = String((e && e.message) || e).slice(0, 300);
}
console.log("W2F_RESULT " + JSON.stringify(out));`;

export interface SandboxPreview {
  schema: "website-to-figma/sandbox-preview";
  schemaVersion: 1;
  sent: false;
  purpose: string;
  notice: string[];
  create: { ttl: number; activityTtl: number };
  execute: { code: string; language: "node"; timeout: number };
  delete: { always: true };
  reservation: { worstCaseCredits: number; basis: string };
  timing: { createWallMs: number; executeWallMs: number; deleteWallMs: number };
  sources: string[];
  gaps: string[];
}

export function buildSandboxPreview(): SandboxPreview {
  return {
    schema: "website-to-figma/sandbox-preview",
    schemaVersion: 1,
    sent: false,
    purpose: `One disposable Browser Sandbox: viewport ${SANDBOX.viewport.width}x${SANDBOX.viewport.height} set BEFORE navigating to ${SANDBOX.url}; 3 same-region states of ${SANDBOX.scope} (baseline, Swiper next, Swiper next) measured and screenshotted on the same Playwright page.`,
    notice: [
      "NOT SENT. Paid execution (sandbox-run) HOLDS without --yes and runs at most once per lifecycle operation.",
      "Billing per the docs: code-only 2 credits per browser-minute, 1-minute minimum; no provider hard cap. The local reservation is an allowance. creditsBilled is recorded only if the delete response carries it (not in the current docs); missing => ambiguous.",
      "Synthetic proof only: no hosted run has been observed by this tool.",
    ],
    // Documented fields only; vendor/account defaults untouched; no profile.
    create: { ttl: SANDBOX.ttl, activityTtl: SANDBOX.activityTtl },
    execute: { code: SANDBOX_CODE, language: "node", timeout: SANDBOX.executeTimeoutS },
    delete: { always: true },
    reservation: { worstCaseCredits: SANDBOX_WORST_CASE_CREDITS, basis: `ceil(ttl ${SANDBOX.ttl} s / 60) x 2 credits per browser-minute (documented code-only rate); allowance, not a cap` },
    timing: { createWallMs: SANDBOX_WALL_MS.create, executeWallMs: SANDBOX_WALL_MS.execute, deleteWallMs: SANDBOX_WALL_MS.delete },
    sources: [
      "https://docs.firecrawl.dev/features/browser (create/execute/delete, ttl 30-3600 s default 600, activityTtl 10-3600 s default 300, preconnected page, code-only 2 credits/browser-minute, 1-minute minimum)",
      "https://playwright.dev/docs/api/class-page#page-route (route does not intercept redirect hops)",
      "https://playwright.dev/docs/api/class-apirequestcontext#api-request-context-get (maxRedirects: 0)",
      "https://playwright.dev/docs/api/class-page#page-set-viewport-size (set before navigation)",
    ],
    gaps: [
      "REDIRECT GAP (accepted only via --accept-redirect-gap): page.route does not see server redirect hops; the maxRedirects:0 pre-check refuses a 3xx before navigating, but a redirect introduced between the pre-check and goto would be followed by the browser. The chain check then detects it and the run is refused; the redirected request itself is NOT prevented.",
      "Hostnames that resolve to private addresses cannot be checked from page code.",
      "Swiper states rely on the known page's semantics; method names/selectors are not a safety guarantee; no side-effect-free promise. slideNext(0) states are not observed animation completions.",
      "creditsBilled is not in the current docs: recorded only if present; missing => ambiguous.",
    ],
  };
}

export const sandboxPreviewSha256 = (p: SandboxPreview = buildSandboxPreview()) => sha256(canonicalJson(p));

export function validateSandboxPreview(json: unknown): { preview: SandboxPreview; previewSha256: string; requestSha256: string } {
  const preview = buildSandboxPreview();
  if (canonicalJson(json) !== canonicalJson(preview)) throw new StateRunPolicyError("sandbox preview does not match the fixed reviewed sandbox; regenerate it with sandbox-plan and review that exact file");
  return { preview, previewSha256: sandboxPreviewSha256(preview), requestSha256: sha256(canonicalJson({ create: preview.create, execute: preview.execute })) };
}

export interface SandboxGates {
  operatorCreditsPerRequest?: number;
  operatorReportedBalance?: number;
  confirmExistingCredits?: boolean;
  confirmNoTopup?: boolean;
  acceptRedirectGap?: boolean;
  ledgerPath?: string;
  reviewedContinuation?: string;
}

export function assertSandboxGates(g: SandboxGates): { reservation: number; committed: number; remaining: number } {
  const missing: string[] = [];
  if (!Number.isInteger(g.operatorCreditsPerRequest) || (g.operatorCreditsPerRequest as number) < SANDBOX_WORST_CASE_CREDITS || (g.operatorCreditsPerRequest as number) > 100) missing.push(`--operator-credits-per-request N (>= the ${SANDBOX_WORST_CASE_CREDITS}-credit worst case for the full ttl; YOUR reservation, not a price)`);
  if (!Number.isInteger(g.operatorReportedBalance) || (g.operatorReportedBalance as number) < 0) missing.push("--operator-reported-balance N");
  if (!g.confirmExistingCredits) missing.push("--confirm-existing-credits");
  if (!g.confirmNoTopup) missing.push("--confirm-no-topup");
  if (!g.acceptRedirectGap) missing.push("--accept-redirect-gap (you reviewed the documented redirect gap: pre-check + chain refusal, no prevention of a redirect introduced after the pre-check)");
  if (!g.ledgerPath) missing.push("--ledger FILE (local reservation allowance, not a provider cap)");
  if (missing.length) throw new StateRunPolicyError(`Refusing before any request: missing operator inputs:\n  ${missing.join("\n  ")}`);
  const reservation = g.operatorCreditsPerRequest as number;
  if (reservation > (g.operatorReportedBalance as number)) throw new StateRunPolicyError(`reservation ${reservation} exceeds the operator-reported balance ${g.operatorReportedBalance}`);
  let l;
  try {
    l = readLedger(g.ledgerPath as string);
  } catch (err) {
    throw new StateRunPolicyError(err instanceof Error ? err.message : String(err));
  }
  const open = unresolved(l);
  if (open.length) throw new StateRunPolicyError(`ledger has unresolved paid attempt(s): ${open.map((e) => e.id).join(", ")}; resolve them first ("ledger resolve")`);
  const committed = committedCredits(l);
  if (committed + reservation > l.capCredits) throw new StateRunPolicyError(`ledger: ${committed} committed + ${reservation} reservation exceeds the ${l.capCredits}-credit local project budget ceiling (not a provider cap)`);
  return { reservation, committed, remaining: l.capCredits - committed };
}

// Minimal client surface (create/execute/delete only): the narrow documented transport.
export type SandboxClient = InteractClient;
export async function createSandboxClient(apiKey: string, apiUrl: string = INTERACT_API_URL): Promise<SandboxClient> {
  return createInteractClient(apiKey, { apiUrl });
}

export interface SandboxStateOut {
  seq: number;
  name: string;
  provenance: "baseline" | "page-api";
  trigger: Obj | null;
  measured: Obj;
  clip: { x: number; y: number; width: number; height: number };
  png: { sha256: string; width: number; height: number; bytes: number };
}
export interface SandboxRecord {
  schema: "website-to-figma/sandbox-run";
  schemaVersion: 1;
  runId: string;
  pageUrl: string;
  previewSha256: string;
  requestSha256: string;
  ledgerEntryId: string | null;
  sessionId: string | null;
  status: "accepted" | "rejected" | "failed" | "ambiguous" | "not-attempted";
  reason: string | null;
  ops: { op: "create" | "execute" | "delete"; attempts: 0 | 1; status: "ok" | "failed" | "ambiguous" | "skipped"; detail: string }[];
  creditsBilled: number | null;
  sessionDurationMs: number | null;
  reservation: number;
  viewportSet: Obj | null;
  precheck: Obj | null;
  modifications: string[];
  nav: Obj | null;
  env: Obj | null;
  autoplay: Obj | null;
  blocked: Obj[];
  states: SandboxStateOut[];
  warnings: string[];
}

const B64 = /^[A-Za-z0-9+/]*={0,2}$/;

// Strict, bounded parse of the execute output. Sizes are checked BEFORE any
// decode/allocation; PNG header (dimensions) is read before the bytes are kept.
export function parseSandboxOutput(resp: unknown): { ok: true; result: Obj; pngs: Uint8Array[] } | { ok: false; status: "rejected" | "ambiguous"; reason: string } {
  if (!isObj(resp)) return { ok: false, status: "ambiguous", reason: "execute response is not an object" };
  if (resp.success === false) return { ok: false, status: "rejected", reason: `execute reported failure: ${String(resp.error ?? "").slice(0, 200)}` };
  if (resp.truncated === true) return { ok: false, status: "ambiguous", reason: "execute output was truncated by the provider" };
  if (resp.killed === true) return { ok: false, status: "ambiguous", reason: "execute was killed (timeout)" };
  if (typeof resp.exitCode === "number" && resp.exitCode !== 0) return { ok: false, status: "rejected", reason: `execute exit code ${resp.exitCode}` };
  const text = [resp.stdout, resp.output, resp.result].find((x): x is string => typeof x === "string" && x.includes("W2F_RESULT "));
  if (!text) return { ok: false, status: "ambiguous", reason: "no W2F_RESULT line in the execute output" };
  if (text.length > SANDBOX.maxOutputChars) return { ok: false, status: "rejected", reason: `execute output ${text.length} chars exceeds ${SANDBOX.maxOutputChars}` };
  const at = text.lastIndexOf("W2F_RESULT ");
  const end = text.indexOf("\n", at);
  const line = text.slice(at + "W2F_RESULT ".length, end < 0 ? undefined : end);
  let result: unknown;
  try {
    result = JSON.parse(line);
  } catch {
    return { ok: false, status: "ambiguous", reason: "W2F_RESULT is not valid JSON (partial output?)" };
  }
  if (!isObj(result) || result.w2f !== "sandbox" || result.v !== 1) return { ok: false, status: "ambiguous", reason: "W2F_RESULT has the wrong schema" };
  if (typeof result.error === "string" && result.error) return { ok: false, status: "rejected", reason: `in-browser step failed: ${result.error.slice(0, 200)}` };
  const states = Array.isArray(result.states) ? result.states : [];
  if (states.length !== SANDBOX.states.length) return { ok: false, status: "ambiguous", reason: `expected ${SANDBOX.states.length} states, got ${states.length}` };
  const pngs: Uint8Array[] = [];
  const maxB64 = Math.ceil(SANDBOX.maxPngBytes / 3) * 4;
  for (const [i, s] of states.entries()) {
    if (!isObj(s) || s.seq !== i || s.name !== SANDBOX.states[i] || typeof s.png !== "string") return { ok: false, status: "ambiguous", reason: `state ${i} malformed` };
    if (s.png.length > maxB64 || s.png.length % 4 !== 0 || !B64.test(s.png)) return { ok: false, status: "rejected", reason: `state ${i} PNG base64 invalid or over ${SANDBOX.maxPngBytes} bytes` };
    const bytes = new Uint8Array(Buffer.from(s.png, "base64"));
    const info = inspectImage(bytes);
    if (!info || info.mime !== "image/png") return { ok: false, status: "rejected", reason: `state ${i} is not a PNG` };
    if (info.width < 1 || info.height < 1 || info.width > SANDBOX.viewport.width || info.height > SANDBOX.viewport.height || info.width * info.height > SANDBOX.maxPngPixels) return { ok: false, status: "rejected", reason: `state ${i} PNG ${info.width}x${info.height} outside the pixel caps` };
    pngs.push(bytes);
  }
  // SAME target identity + geometry across states; clip inside the target
  const regionOf = (s: Obj) => (isObj(s.measured) && isObj(s.measured.region) ? s.measured.region : null);
  const targetOf = (s: Obj) => (isObj(s.measured) && isObj(s.measured.target) ? s.measured.target : null);
  const r0 = regionOf(states[0] as Obj);
  for (const [i, s] of (states as Obj[]).entries()) {
    const reg = regionOf(s);
    const t = targetOf(s);
    const clip = isObj(s.clip) ? s.clip : null;
    if (!reg || !t || t.selector !== SANDBOX.scope || !clip) return { ok: false, status: "ambiguous", reason: `state ${i} lacks its target measurement or clip` };
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : NaN);
    if (r0 && (Math.abs(n(reg.x) - n(r0.x)) > 2 || Math.abs(n(reg.w) - n(r0.w)) > 2 || Math.abs(n(reg.y) - n(r0.y)) > 100)) return { ok: false, status: "rejected", reason: `state ${i} measured a different region geometry` };
    const top = Math.max(0, n(t.viewTop));
    if (Math.abs(n(clip.y) - top) > 1 || n(clip.height) > n(t.viewBottom) - top + 1 || n(clip.width) !== SANDBOX.viewport.width) return { ok: false, status: "rejected", reason: `state ${i} clip is not the measured target` };
  }
  return { ok: true, result, pngs };
}

export interface SandboxExecuteOptions {
  validated: { preview: SandboxPreview; previewSha256: string; requestSha256: string };
  gates: SandboxGates;
  getApiKey: () => string | undefined;
  createClient?: (apiKey: string) => Promise<SandboxClient>;
  resolver?: Resolver;
  now?: () => Date;
  runId?: string;
  log?: (m: string) => void;
  savePng?: (seq: number, bytes: Uint8Array) => void;
}

export async function executeSandbox(o: SandboxExecuteOptions): Promise<SandboxRecord> {
  const now = o.now ?? (() => new Date());
  const resolver = o.resolver ?? systemResolver;
  const gate = assertSandboxGates(o.gates);
  const secrets: string[] = [];
  const ledgerPath = o.gates.ledgerPath as string;
  const rec: SandboxRecord = {
    schema: "website-to-figma/sandbox-run",
    schemaVersion: 1,
    runId: o.runId ?? sha256(`${o.validated.previewSha256}:${now().toISOString()}:${Math.random()}`).slice(0, 16),
    pageUrl: SANDBOX_URL,
    previewSha256: o.validated.previewSha256,
    requestSha256: o.validated.requestSha256,
    ledgerEntryId: null,
    sessionId: null,
    status: "not-attempted",
    reason: null,
    ops: [],
    creditsBilled: null,
    sessionDurationMs: null,
    reservation: gate.reservation,
    viewportSet: null,
    precheck: null,
    modifications: [],
    nav: null,
    env: null,
    autoplay: null,
    blocked: [],
    states: [],
    warnings: [],
  };
  const log = (m: string) => o.log?.(`[sandbox] ${redact(m, secrets)}`);
  try {
    await assertHostedFirecrawlUrl(SANDBOX_URL, resolver);
  } catch (err) {
    rec.status = "rejected";
    rec.reason = `target URL failed the hosted URL guard: ${err instanceof Error ? err.message : "invalid"}`;
    return rec;
  }
  const key = o.getApiKey()?.trim();
  if (!key) {
    rec.reason = "FIRECRAWL_API_KEY is not set; nothing was sent and no ledger attempt was recorded";
    return rec;
  }
  secrets.push(key);
  let client: SandboxClient;
  try {
    client = await (o.createClient ?? createSandboxClient)(key);
  } catch (err) {
    rec.reason = redact(`client could not be created: ${err instanceof Error ? err.message : String(err)}`, secrets);
    return rec;
  }
  let entryId: string;
  try {
    entryId = reserveAttempt(ledgerPath, { url: SANDBOX_URL, requestSha256: o.validated.requestSha256, reserved: gate.reservation, command: "sandbox-run", continuationOf: o.gates.reviewedContinuation }, now).id;
  } catch (err) {
    rec.reason = err instanceof LedgerError ? err.message : String(err);
    return rec;
  }
  rec.ledgerEntryId = entryId;
  const op = (name: "create" | "execute" | "delete", status: "attempting" | "ok" | "failed" | "ambiguous", detail: string) => {
    recordOp(ledgerPath, entryId, { op: name, status, detail: redact(detail, secrets) }, now);
    log(`${name} ${status}${detail ? `: ${detail}` : ""}`);
  };
  const outcome = (err: unknown) => classify(err);
  let overall: SandboxRecord["status"] = "ambiguous";
  // ---- create (one attempt) ----
  op("create", "attempting", `ttl ${SANDBOX.ttl}s activityTtl ${SANDBOX.activityTtl}s (units assumed seconds; operator-confirmed)`);
  let created: unknown;
  try {
    created = await withTimeout(client.browser({ ...o.validated.preview.create }), SANDBOX_WALL_MS.create);
  } catch (err) {
    const k = outcome(err);
    const d = redact(`create ${k}: ${err instanceof Error ? err.message : String(err)}`, secrets);
    rec.ops.push({ op: "create", attempts: 1, status: k, detail: d });
    op("create", k, d);
    rec.status = k;
    rec.reason = k === "ambiguous" ? `${d}; a session may exist without a known id (bounded only by its ttl); no automatic re-create` : d;
    settleAttempt(ledgerPath, entryId, k === "failed" ? "failed" : "ambiguous", null, rec.reason);
    return rec;
  }
  const id = isObj(created) && typeof created.id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(created.id) ? created.id : null;
  if (!isObj(created) || created.success !== true || !id) {
    const d = `create returned no usable session id (success ${isObj(created) ? String(created.success) : "?"})`;
    rec.ops.push({ op: "create", attempts: 1, status: "ambiguous", detail: d });
    op("create", "ambiguous", d);
    rec.status = "ambiguous";
    rec.reason = `${d}; no automatic re-create`;
    settleAttempt(ledgerPath, entryId, "ambiguous", null, rec.reason);
    return rec;
  }
  rec.sessionId = id;
  rec.ops.push({ op: "create", attempts: 1, status: "ok", detail: `session ${id}${typeof created.expiresAt === "string" ? ` expires ${created.expiresAt.slice(0, 40)}` : ""}` });
  op("create", "ok", `session ${id}`);
  let cleanupOk = false;
  try {
    // ---- execute (one attempt) ----
    op("execute", "attempting", `node, timeout ${SANDBOX.executeTimeoutS}s`);
    let resp: unknown;
    try {
      resp = await withTimeout(client.browserExecute(id, { ...o.validated.preview.execute }), SANDBOX_WALL_MS.execute);
    } catch (err) {
      const k = outcome(err);
      const d = redact(`execute ${k}: ${err instanceof Error ? err.message : String(err)}`, secrets);
      rec.ops.push({ op: "execute", attempts: 1, status: k, detail: d });
      op("execute", k, d);
      overall = k === "failed" ? "failed" : "ambiguous";
      rec.reason = d;
      return rec;
    }
    const parsed = parseSandboxOutput(resp);
    if (!parsed.ok) {
      rec.ops.push({ op: "execute", attempts: 1, status: parsed.status === "ambiguous" ? "ambiguous" : "ok", detail: parsed.reason });
      op("execute", parsed.status === "ambiguous" ? "ambiguous" : "ok", parsed.reason);
      overall = parsed.status;
      rec.reason = parsed.reason;
      return rec;
    }
    rec.ops.push({ op: "execute", attempts: 1, status: "ok", detail: "W2F_RESULT parsed; 3 states" });
    op("execute", "ok", "W2F_RESULT parsed; 3 states");
    const r = parsed.result;
    rec.viewportSet = isObj(r.viewportSet) ? r.viewportSet : null;
    rec.precheck = isObj(r.precheck) ? r.precheck : null;
    rec.modifications = Array.isArray(r.modifications) ? r.modifications.filter((x): x is string => typeof x === "string").slice(0, 10).map((x) => x.slice(0, 200)) : [];
    rec.nav = isObj(r.nav) ? r.nav : null;
    rec.env = isObj(r.env) ? r.env : null;
    rec.autoplay = isObj(r.autoplay) ? r.autoplay : null;
    rec.blocked = Array.isArray(r.blocked) ? r.blocked.filter(isObj).slice(0, 50) : [];
    const states = r.states as Obj[];
    for (const [i, s] of states.entries()) {
      const bytes = parsed.pngs[i]!;
      const info = inspectImage(bytes)!;
      rec.states.push({ seq: i, name: SANDBOX.states[i]!, provenance: i === 0 ? "baseline" : "page-api", trigger: isObj(s.trigger) ? s.trigger : null, measured: isObj(s.measured) ? s.measured : {}, clip: isObj(s.clip) ? (s.clip as SandboxStateOut["clip"]) : { x: 0, y: 0, width: 0, height: 0 }, png: { sha256: sha256Hex(bytes), width: info.width, height: info.height, bytes: bytes.length } });
      o.savePng?.(i, bytes);
    }
    // honest distinctness: identical PNGs or unmoved Swiper are reported
    const shas = rec.states.map((s) => s.png.sha256);
    if (new Set(shas).size < shas.length) rec.warnings.push("some state screenshots are byte-identical (no visual distinctness)");
    for (const s of rec.states.slice(1)) if (s.trigger && s.trigger.moved !== true) rec.warnings.push(`state "${s.name}": Swiper did not move`);
    if (rec.blocked.length) rec.warnings.push(`${rec.blocked.length} request(s) aborted by the in-browser guard`);
    rec.warnings.push("states after slideNext(0) are measured after 0 ms transitions, not observed animation completions");
    overall = "accepted";
  } finally {
    // ---- delete (one attempt, always) ----
    op("delete", "attempting", `session ${id}`);
    try {
      const del = await withTimeout(client.deleteBrowser(id), SANDBOX_WALL_MS.delete);
      const billed = isObj(del) && typeof del.creditsBilled === "number" && Number.isFinite(del.creditsBilled) && del.creditsBilled >= 0 ? Math.ceil(del.creditsBilled) : null;
      rec.creditsBilled = billed;
      rec.sessionDurationMs = isObj(del) && typeof del.sessionDurationMs === "number" ? del.sessionDurationMs : null;
      if (isObj(del) && del.success === true) {
        cleanupOk = true;
        rec.ops.push({ op: "delete", attempts: 1, status: "ok", detail: `creditsBilled ${billed ?? "not reported"}` });
        op("delete", "ok", `creditsBilled ${billed ?? "not reported"}; durationMs ${rec.sessionDurationMs ?? "?"}`);
      } else {
        rec.ops.push({ op: "delete", attempts: 1, status: "ambiguous", detail: "delete did not report success" });
        op("delete", "ambiguous", "delete did not report success");
      }
    } catch (err) {
      const k = outcome(err);
      const d = redact(`delete ${k}: ${err instanceof Error ? err.message : String(err)}`, secrets);
      rec.ops.push({ op: "delete", attempts: 1, status: k, detail: d });
      op("delete", k, d);
    }
    if (!cleanupOk) {
      rec.warnings.push(`cleanup NOT confirmed for session ${id}: it may keep billing until its ttl; the ledger entry stays blocking until resolved (sandbox-cleanup or ledger resolve)`);
      if (overall === "accepted") overall = "ambiguous";
    }
    if (rec.creditsBilled === null) rec.warnings.push("delete reported no creditsBilled; credits are UNKNOWN (ledger entry left ambiguous)");
    rec.status = overall;
    const settled = cleanupOk && rec.creditsBilled !== null && (overall === "accepted" || overall === "rejected") ? "succeeded" : overall === "failed" && cleanupOk ? "failed" : "ambiguous";
    const e = settleAttempt(ledgerPath, entryId, settled, rec.creditsBilled, `${rec.status}${rec.reason ? `: ${rec.reason}` : ""}; creditsBilled ${rec.creditsBilled ?? "not reported"}; cleanup ${cleanupOk ? "confirmed" : "NOT confirmed"}`);
    if (e.overrun) rec.warnings.push(`OVERRUN: ${rec.creditsBilled} credits billed, above the reservation ${gate.reservation}; later runs blocked until resolved`);
  }
  return rec;
}

// One explicit DELETE for a recorded session whose cleanup was not confirmed.
export async function cleanupSandbox(o: { ledgerPath: string; entryId: string; getApiKey: () => string | undefined; createClient?: (k: string) => Promise<SandboxClient>; now?: () => Date }): Promise<{ ok: boolean; detail: string }> {
  const l = readLedger(o.ledgerPath);
  const e = l.entries.find((x) => x.id === o.entryId);
  if (!e || e.command !== "sandbox-run") throw new StateRunPolicyError(`no sandbox-run ledger entry ${o.entryId}`);
  const created = (e.ops ?? []).filter((x) => x.op === "create" && x.status === "ok").map((x) => /session ([A-Za-z0-9_-]{1,128})/.exec(x.detail)?.[1]).find(Boolean);
  if (!created) throw new StateRunPolicyError("the entry records no created session id; nothing to delete (a session with an unknown id is bounded only by its ttl)");
  if ((e.ops ?? []).some((x) => x.op === "delete" && x.status === "ok")) throw new StateRunPolicyError("cleanup already confirmed for this entry");
  const key = o.getApiKey()?.trim();
  if (!key) throw new StateRunPolicyError("FIRECRAWL_API_KEY is not set; nothing was sent");
  const client = await (o.createClient ?? createSandboxClient)(key);
  recordOp(o.ledgerPath, o.entryId, { op: "delete", status: "attempting", detail: `manual cleanup of session ${created}` }, o.now);
  try {
    const del = await withTimeout(client.deleteBrowser(created), SANDBOX_WALL_MS.delete);
    const ok = isObj(del) && del.success === true;
    const detail = `manual cleanup ${ok ? "ok" : "not confirmed"}; creditsBilled ${isObj(del) && typeof del.creditsBilled === "number" ? del.creditsBilled : "not reported"}`;
    recordOp(o.ledgerPath, o.entryId, { op: "delete", status: ok ? "ok" : "ambiguous", detail }, o.now);
    return { ok, detail };
  } catch (err) {
    const k = classify(err);
    const detail = redact(`manual cleanup ${k}: ${err instanceof Error ? err.message : String(err)}`, [key]);
    recordOp(o.ledgerPath, o.entryId, { op: "delete", status: k, detail }, o.now);
    return { ok: false, detail };
  }
}

// Offline: sandbox record -> capture + asset manifest for hifi (states of ONE
// region: same scope selector, same section geometry). PNGs are referenced as
// state screenshots positioned at the clip (frame top-left).
export function sandboxToCapture(rec: SandboxRecord, files: string[]): { capture: Obj; manifest: Obj } {
  if (rec.status !== "accepted" || rec.states.length !== SANDBOX.states.length) throw new StateRunPolicyError(`sandbox status ${rec.status}; only accepted runs with 3 states convert`);
  const st = rec.states.map((s) => {
    const m = s.measured;
    const target = isObj(m.target) ? m.target : {};
    const region = isObj(m.region) ? m.region : {};
    const probe = isObj(m.probe) ? m.probe : {};
    const measured = { url: SANDBOX_URL, viewport: { width: probe.innerWidth ?? SANDBOX.viewport.width, height: probe.innerHeight ?? SANDBOX.viewport.height }, documentHeight: probe.documentHeight ?? null, title: "Bootslander (sandbox region)", elements: m.elements ?? [], texts: m.texts ?? [], images: m.images ?? [], svgs: [] };
    return {
      seq: s.seq,
      name: s.name,
      provenance: s.provenance,
      scope: { x: region.x, y: region.y, w: region.w, h: region.h },
      screenshotScrollY: (typeof region.y === "number" ? region.y : 0),
      viewport: { width: probe.innerWidth, height: probe.innerHeight },
      documentHeight: probe.documentHeight ?? null,
      measured,
      verify: { scrollY: probe.scrollY ?? null, viewport: { width: probe.innerWidth, height: probe.innerHeight }, documentHeight: probe.documentHeight ?? null, expandedViewport: typeof probe.innerHeight === "number" ? probe.innerHeight > 4320 : false, target: { selector: target.selector ?? SANDBOX.scope, viewTop: target.viewTop ?? null, viewBottom: target.viewBottom ?? null, inViewport: target.inViewport === true, partiallyVisible: true } },
      screenshot: "action-order",
      applied: s.provenance === "page-api" ? [{ selector: SANDBOX.swiper, mechanism: "swiper-next" }] : [],
      refused: [],
      missing: [],
      trigger: s.trigger ? { kind: "swiper-next", ...s.trigger } : null,
      truncated: false,
      error: null,
      residueFromSeq: null,
    };
  });
  return {
    capture: { schema: "website-to-figma/capture", schemaVersion: 1, label: `sandbox run ${rec.runId} (one region: ${SANDBOX.scope})`, pages: [{ url: SANDBOX_URL, contentType: "text/html", measured: st[0]!.measured, states: st }] },
    manifest: { schema: "website-to-figma/asset-manifest", schemaVersion: 1, assets: rec.states.map((s, i) => ({ id: `sandbox-s${i}`, kind: "reference", file: files[i], sha256: s.png.sha256, pageUrl: SANDBOX_URL, state: s.name })) },
  };
}
