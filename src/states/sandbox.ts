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
// Page code (fixed, no inputs): from the preconnected page, reach the Browser
// (page.context().browser(), documented) and create ONE owned incognito
// context with serviceWorkers: "block" and the 1920x1080 viewport BEFORE any
// page exists; a context route guard (covers popups; new pages are closed);
// all three states on the SAME owned page; the owned context is closed in
// `finally` and the sandbox session is deleted in `finally`. The default
// preconnected page is never navigated. The main
// navigation to the EXACT raw URL is performed by the documented
// route.fetch({ maxRedirects: 0, maxRetries: 0, timeout }) and any 3xx is
// aborted BEFORE route.fulfill({ response }) - no redirected request is made;
// every other navigation is aborted; autoplay of the ONE validated Swiper is
// stopped (recorded MODIFICATION); three states of ONE region (#testimonials).
//
// Service workers: blocked by the owned context option (Playwright Browser
// docs). Hosted compatibility of browser.newContext inside the Firecrawl
// sandbox is NOT proven: the code fails closed if the Browser or newContext is
// unavailable (the session is still deleted). Also stated, not claimed away:
// remote-browser egress is the provider's (https://docs.firecrawl.dev/security:
// browser sessions egress outside Firecrawl's internal network); no local DNS
// applies to it and the hosted DNS exception is NOT expanded (IP-literal and
// local-name hosts and non-default ports are aborted; subresources are DENIED except the exact
// hostname bootstrapmade.com and data:/blob:; every http(s) request is fetched once without following
// redirects and a 3xx is never served, so blocked or redirected assets mark the capture
// incomplete); Swiper states rely on the
// known page's semantics (no side-effect-free promise); slideNext(0) states
// are not observed animation completions; creditsBilled is undocumented.
import { assertHostedFirecrawlUrl, systemResolver, type Resolver } from "../security/urlGuard";
import { inspectImage, sha256Hex } from "../shared/imageInfo";
import { canonicalJson, classify, redact, redactAll, sha256, StateRunPolicyError, withTimeout } from "./execute";
import { createInteractClient, INTERACT_API_URL, type InteractClient } from "./sandboxTransport";
import { readLedger, reserveAttempt, settleAttempt, settlePendingReconciliation, recordOp, committedCredits, unresolved, LedgerError } from "./ledger";

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
  // bounded wait (page.waitForFunction) for the page's own Swiper to bind to the source-verified element
  swiperReadyMs: 10_000,
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
// Conditions under which execution is REFUSED outright (no flag can bypass).
// (empty: the service-worker condition is addressed by the owned context with
// serviceWorkers: "block"; any future unsupported condition goes here)
export const SANDBOX_UNSUPPORTED: string[] = [];
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
// readiness: exactly one match AND the page's own Swiper instance bound to it (self-contained)
const W2F_SWIPER_BOUND = (sel) => { const els = document.querySelectorAll(sel); if (els.length !== 1) return false; const sw = els[0].swiper; return !!sw && typeof sw === "object" && sw.el === els[0] && typeof sw.slideNext === "function"; };
// read-only diagnostics (no page modification) recorded whether or not the Swiper bound
const W2F_SWIPER_DIAG = (sel) => {
  const els = Array.from(document.querySelectorAll(sel)); const el = els[0] || null;
  const src = (s) => { if (!s.src) return "(inline)"; try { const u = new URL(s.src); return u.host === location.host ? u.pathname.slice(0, 200) : u.protocol + "//" + u.host + "/(other host)"; } catch (e) { return "(invalid)"; } };
  return { matches: els.length, initializedClass: el ? el.classList.contains("swiper-initialized") : null, hasSwiperProp: el ? !!el.swiper : null, windowSwiperType: typeof window.Swiper, configPresent: el ? !!el.querySelector(".swiper-config") : null, slides: el ? el.querySelectorAll(".swiper-slide").length : null, readyState: document.readyState, scripts: Array.from(document.scripts).slice(0, 30).map(src) };
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
const W = ${JSON.stringify({ url: SANDBOX.url, host: "bootstrapmade.com", vw: SANDBOX.viewport.width, vh: SANDBOX.viewport.height, navTimeoutMs: SANDBOX.navTimeoutMs, settleMs: SANDBOX.settleMs, swiperReadyMs: SANDBOX.swiperReadyMs, stateWaitMs: SANDBOX.stateWaitMs, scope: SANDBOX.scope, swiper: SANDBOX.swiper, states: SANDBOX.states, maxPngBytes: SANDBOX.maxPngBytes, max: { maxElements: SANDBOX.maxElements, maxTexts: SANDBOX.maxTexts, maxImages: SANDBOX.maxImages } })};
${PAGE_FUNCS}
// stage = the step in progress when an error is thrown; routeInstalled says whether blocked/served/
// incomplete were OBSERVED by the guard (false => they are unobserved defaults, not evidence)
const out = { w2f: "sandbox", v: 1, error: null, stage: "start", routeInstalled: false, incomplete: false, ownedContext: null, ownedContextClosed: null, mainFetch: null, nav: null, env: null, swiperReady: null, autoplay: null, modifications: [], blocked: [], blockedTotal: 0, served: [], servedTotal: 0, pageErrors: [], consoleErrors: [], popupsClosed: 0, serviceWorker: null, states: [] };
let ctx = null;
try {
  // Reach the Browser through documented public APIs; never navigate the preconnected default page.
  if (typeof page === "undefined" || !page || typeof page.context !== "function") throw new Error("no Playwright page in this session");
  const browser = page.context().browser();
  if (!browser || typeof browser.newContext !== "function") throw new Error("Browser object unavailable: cannot create the owned context");
  // ONE owned incognito context: service-worker registration blocked, viewport fixed BEFORE any page exists.
  out.stage = "newContext";
  ctx = await browser.newContext({ serviceWorkers: "block", viewport: { width: W.vw, height: W.vh } });
  out.ownedContext = { serviceWorkers: "block", viewport: { width: W.vw, height: W.vh } };
  let own = null;
  // ONE structural URL policy for EVERY request and every hop (no DNS lookups here; the hosted DNS
  // exception is not expanded). Returns the refusal reason, or null when allowed.
  const policy = (raw, nav, main) => {
    let u = null; try { u = new URL(raw); } catch (e) { return "invalid-url"; }
    if (nav && !(main && raw === W.url)) return "navigation-not-exact-target"; // raw string, no normalization; popups/frames refused
    if (u.protocol === "data:" || u.protocol === "blob:") return nav ? "scheme" : null;
    if (u.protocol !== "http:" && u.protocol !== "https:") return "scheme";
    if (u.username || u.password) return "credentials";
    if (u.port !== "") return "non-default-port";
    const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (/^[0-9.]+$/.test(host) || host.includes(":")) return "ip-literal";
    if (host === "localhost" || /\.(local|internal|localhost|home\.arpa|test|lan)$/.test(host)) return "local-name";
    if (host !== W.host) return "third-party-host"; // subresources: DENY by default except the exact hostname
    return null;
  };
  const originOf = (raw) => { try { const u = new URL(raw); return u.protocol + "//" + u.host; } catch (e) { return "(invalid)"; } };
  const deny = (route, raw, nav, why, extra) => {
    if (!nav) out.incomplete = true; // a missing subresource: the capture is incomplete, never substituted
    out.blockedTotal++;
    if (out.blocked.length < 50) out.blocked.push({ origin: originOf(raw), why, ...(extra || {}) });
    return route.abort();
  };
  await ctx.route("**/*", async (route) => {
    const req = route.request(); const raw = req.url();
    let nav = false, main = false;
    try { nav = req.isNavigationRequest(); main = nav && !!own && req.frame() === own.mainFrame(); } catch (e) {}
    const why = policy(raw, nav, main);
    if (why) return deny(route, raw, nav, why);
    // data:/blob: never reach the network and cannot redirect.
    if (raw.startsWith("data:") || raw.startsWith("blob:")) return route.continue();
    // Every allowed http(s) request (main document AND subresources) is made exactly once by the guard
    // WITHOUT following redirects. A 3xx is aborted before anything is served, so no Location target is
    // ever requested; route.continue() is never used for network requests (its redirect hops would
    // bypass this handler).
    let resp = null;
    try { resp = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: W.navTimeoutMs }); } catch (e) { return deny(route, raw, nav, "fetch-error"); }
    const st = resp.status();
    if (main) out.mainFetch = { status: st, url: resp.url() };
    if (st >= 300 && st < 400) {
      let loc = null; try { const h = resp.headers(); loc = h && h.location ? new URL(h.location, raw).href : null; } catch (e) {}
      return deny(route, raw, nav, (main ? "main-document-redirect-" : "redirect-") + st, { location: loc ? originOf(loc) : null, locationPolicy: loc ? policy(loc, nav, main) || "allowed-but-not-followed" : "missing" });
    }
    if (resp.url() !== raw) return deny(route, raw, nav, "response-url-changed");
    out.servedTotal++;
    if (out.served.length < 60) { let path = "(invalid)"; try { path = new URL(raw).pathname.slice(0, 200); } catch (e) {} out.served.push({ path, status: st, nav }); }
    return route.fulfill({ response: resp });
  });
  out.routeInstalled = true;
  // WebSockets are not seen by context.route: every one is refused (never connected to a server).
  if (typeof ctx.routeWebSocket !== "function") throw new Error("context.routeWebSocket unavailable: cannot refuse WebSocket connections");
  out.stage = "routeWebSocket";
  await ctx.routeWebSocket(/.*/, (ws) => { out.blockedTotal++; if (out.blocked.length < 50) out.blocked.push({ origin: originOf(ws.url()), why: "websocket" }); out.incomplete = true; ws.close(); });
  out.stage = "newPage";
  own = await ctx.newPage();
  // page script errors are recorded (bounded) as diagnostics only
  own.on("pageerror", (e) => { if (out.pageErrors.length < 10) out.pageErrors.push(String((e && e.message) || e).slice(0, 300)); });
  own.on("console", (m) => { try { if (m.type() === "error" && out.consoleErrors.length < 10) out.consoleErrors.push(String(m.text()).slice(0, 300)); } catch (e) {} });
  ctx.on("page", (p) => { if (p !== own) { out.popupsClosed++; p.close().catch(() => {}); } });
  // Viewport set on the SAME page used for all three states, BEFORE navigation.
  await own.setViewportSize({ width: W.vw, height: W.vh });
  out.stage = "goto";
  const resp = await own.goto(W.url, { waitUntil: "load", timeout: W.navTimeoutMs });
  const chain = []; let r = resp ? resp.request() : null;
  while (r && chain.length < 10) { chain.unshift(r.url()); r = r.redirectedFrom(); }
  out.nav = { status: resp ? resp.status() : null, finalUrl: own.url(), chain };
  if (!out.mainFetch || out.mainFetch.status < 200 || out.mainFetch.status > 299) throw new Error("main document was not fetched with a 2xx by the route guard");
  if (own.url() !== W.url || chain.length !== 1 || chain[0] !== W.url) throw new Error("navigation left the exact target URL (redirect or rewrite)");
  out.stage = "settle";
  await own.waitForTimeout(W.settleMs);
  out.stage = "probe";
  out.env = await own.evaluate(W2F_PROBE);
  out.serviceWorker = await own.evaluate(() => !!(navigator.serviceWorker && navigator.serviceWorker.controller));
  if (out.serviceWorker) throw new Error("a service worker controls the page (its requests bypass routing)");
  if (out.env.innerWidth !== W.vw || out.env.innerHeight !== W.vh) throw new Error("viewport not applied: " + out.env.innerWidth + "x" + out.env.innerHeight);
  // Bounded readiness: wait (supported page.waitForFunction) until the page's OWN Swiper is bound to the
  // source-verified element; on timeout fail closed WITH read-only diagnostics.
  out.stage = "swiper-ready";
  const t0 = Date.now();
  try {
    await own.waitForFunction(W2F_SWIPER_BOUND, W.swiper, { timeout: W.swiperReadyMs, polling: 100 });
    out.swiperReady = { ready: true, waitedMs: Date.now() - t0, timeoutMs: W.swiperReadyMs };
  } catch (e) {
    out.swiperReady = { ready: false, waitedMs: Date.now() - t0, timeoutMs: W.swiperReadyMs, error: String((e && e.message) || e).slice(0, 200) };
  }
  try { out.swiperReady.diag = await own.evaluate(W2F_SWIPER_DIAG, W.swiper); } catch (e) { out.swiperReady.diag = { error: String((e && e.message) || e).slice(0, 200) }; }
  if (!out.swiperReady.ready) throw new Error("swiper not bound within " + W.swiperReadyMs + " ms (see swiperReady.diag)");
  out.stage = "autoplay";
  out.autoplay = await own.evaluate(W2F_SWIPER, { sel: W.swiper, op: "stop-autoplay" });
  if (!out.autoplay.valid) throw new Error("swiper refused: " + out.autoplay.reason);
  if (out.autoplay.before && out.autoplay.before.autoplayRunning) out.modifications.push("stopped autoplay of " + W.swiper + " via its own Swiper API (not the page's original behavior)");
  // All three states on the SAME owned page.
  for (let seq = 0; seq < W.states.length; seq++) {
    out.stage = "state-" + seq;
    let trigger = null;
    if (seq > 0) { trigger = await own.evaluate(W2F_SWIPER, { sel: W.swiper, op: "next" }); if (!trigger.valid) throw new Error("swiper refused: " + trigger.reason); }
    if (!(await own.evaluate(W2F_INTO_VIEW, W.scope))) throw new Error("scope not found");
    await own.waitForTimeout(W.stateWaitMs);
    const m = await own.evaluate(W2F_MEASURE, { scope: W.scope, ...W.max });
    if (!m.target) throw new Error("scope not found");
    const top = Math.max(0, m.target.viewTop);
    const clip = { x: 0, y: top, width: W.vw, height: Math.min(W.vh - top, Math.max(0, m.target.viewBottom - top)) };
    if (clip.height < 1) throw new Error("target not visible for the screenshot");
    const png = await own.screenshot({ type: "png", clip, timeout: 15000 });
    if (png.length > W.maxPngBytes) throw new Error("screenshot over the byte cap");
    out.states.push({ seq, name: W.states[seq], trigger, measured: m, clip, png: png.toString("base64") });
  }
} catch (e) {
  out.error = String((e && e.message) || e).slice(0, 300);
} finally {
  if (!out.error) out.stage = "done";
  if (ctx) { try { await ctx.close(); out.ownedContextClosed = true; } catch (e) { out.ownedContextClosed = false; } }
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
  hardHold: string[];
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
      "Billing per the docs: code-only 2 credits per browser-minute, 1-minute minimum; no provider hard cap. The local reservation is an allowance. A successful run is settled as PENDING RECONCILIATION: the actual charge must be verified from a documented account source (GET /v2/team/credit-usage remainingCredits delta, or the dashboard); creditsBilled (undocumented) is informational only.",
      "--project-remaining-credits is the origin-reported PROJECT remaining (e.g. 17 used of 1000), NOT a verified account balance.",
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
      "https://playwright.dev/docs/api/class-route#route-fetch (maxRedirects: 0, maxRetries: 0; then route.fulfill({ response }))",
      "https://playwright.dev/docs/api/class-browser#browser-new-context (serviceWorkers: 'block' blocks all registration of Service Workers; viewport)",
      "https://playwright.dev/docs/api/class-browsercontext (browser(); route(): not for Service-Worker-intercepted requests; newPage(); close(); 'page' event fires for popups)",
      "https://docs.firecrawl.dev/features/browser (CDP example uses browser.contexts()/newPage(); newContext/service workers not mentioned)",
      "https://docs.firecrawl.dev/security (Network protections: browser sessions incl. page subrequests egress outside Firecrawl's internal network)",
      "https://docs.firecrawl.dev/features/threat-protection (remote browser in-page navigations are not intercepted by Threat Protection)",
      "https://docs.firecrawl.dev/api-reference/endpoint/credit-usage (GET /v2/team/credit-usage remainingCredits: the documented account source for reconciliation)",
      "https://playwright.dev/docs/api/class-page#page-set-viewport-size (set before navigation)",
    ],
    hardHold: SANDBOX_UNSUPPORTED,
    gaps: [
      "Hosted compatibility is NOT proven: whether page.context().browser() and browser.newContext({ serviceWorkers: 'block', viewport }) are available inside the Firecrawl sandbox is not documented by Firecrawl; the code fails closed if not (the session is still deleted).",
      "`page` in execute is used only to reach the Browser; the Firecrawl examples use it without defining it, but the docs do not state it; missing => fail closed.",
      "Every request (main document and subresources) passes ONE structural policy: http/https (data:/blob: only for subresources), no credentials, no non-default port, no IP-literal or local-name host, exact hostname bootstrapmade.com (exact raw URL for the main navigation). Allowed http(s) requests are made once by route.fetch({ maxRedirects: 0, maxRetries: 0 }); any 3xx is aborted before anything is served, so no redirect hop is requested (an allowed asset behind a redirect is missing, not followed). route.continue() is used only for data:/blob:. WebSockets are refused via context.routeWebSocket (missing => fail closed). Any aborted subresource marks the capture incomplete.",
      "route.fetch requests are made by Playwright inside the hosted sandbox with the owned context's cookies, not by this tool; no DNS lookups are made by the policy and the hosted DNS exception is not expanded. Remote-browser egress is the provider's (docs/security, docs/features/threat-protection); this tool's local DNS guard covers only its own fetches.",
      "Swiper readiness: after goto + settle, page.waitForFunction (polling 100 ms, timeout 10 s) waits until the page's own Swiper instance is bound to the source-verified element (#testimonials .swiper.init-swiper); if it never binds the run fails closed with read-only diagnostics (stage, served/blocked requests, page errors, Swiper/script snapshot). Why an earlier run found it unbound is NOT determined.",
      "Failure diagnostics: whenever W2F_RESULT parses (success or failure) the observed browser fields are kept in the run record; unobserved fields are null (never false/[] defaults). A size-capped, PNG-elided, key-redacted copy of the raw execute output is saved privately as execute-raw.json.",
      "Swiper states rely on the known page's semantics; method names/selectors are not a safety guarantee; no side-effect-free promise. slideNext(0) states are not observed animation completions.",
      "creditsBilled is not in the current docs: informational only; the charge is reconciled from a documented account source.",
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
  // PROJECT remaining credits as reported by the origin (e.g. 983 of the 1000
  // budget). NOT a verified account balance: the documented account source is
  // GET /v2/team/credit-usage (remainingCredits), which this tool never calls.
  projectRemainingCredits?: number;
  confirmExistingCredits?: boolean;
  confirmNoTopup?: boolean;
  ledgerPath?: string;
  reviewedContinuation?: string;
}

export function assertSandboxGates(g: SandboxGates): { reservation: number; committed: number; remaining: number } {
  const missing: string[] = [];
  if (!Number.isInteger(g.operatorCreditsPerRequest) || (g.operatorCreditsPerRequest as number) < SANDBOX_WORST_CASE_CREDITS || (g.operatorCreditsPerRequest as number) > 100) missing.push(`--operator-credits-per-request N (>= the ${SANDBOX_WORST_CASE_CREDITS}-credit worst case for the full ttl; YOUR reservation, not a price)`);
  if (!Number.isInteger(g.projectRemainingCredits) || (g.projectRemainingCredits as number) < 0) missing.push("--project-remaining-credits N (origin-reported PROJECT remaining, not a verified account balance)");
  if (!g.confirmExistingCredits) missing.push("--confirm-existing-credits");
  if (!g.confirmNoTopup) missing.push("--confirm-no-topup");
  if (!g.ledgerPath) missing.push("--ledger FILE (local reservation allowance, not a provider cap)");
  if (missing.length) throw new StateRunPolicyError(`Refusing before any request: missing operator inputs:\n  ${missing.join("\n  ")}`);
  const reservation = g.operatorCreditsPerRequest as number;
  if (reservation > (g.projectRemainingCredits as number)) throw new StateRunPolicyError(`reservation ${reservation} exceeds the origin-reported project remaining ${g.projectRemainingCredits}`);
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
  // undocumented response field, informational only (never the trusted charge)
  creditsBilled: number | null;
  sessionDurationMs: number | null;
  chargeStatus: "pending_reconciliation" | "not-settled";
  // null = NOT OBSERVED (no W2F_RESULT, or the route guard was never installed); never a default
  incomplete: boolean | null;
  reservation: number;
  viewportSet: Obj | null;
  ownedContext: Obj | null;
  ownedContextClosed: boolean | null;
  mainFetch: Obj | null;
  popupsClosed: number | null;
  modifications: string[] | null;
  nav: Obj | null;
  env: Obj | null;
  autoplay: Obj | null;
  blocked: Obj[] | null;
  // in-browser diagnostics (null = not observed)
  observation: "none" | "w2f-result";
  stage: string | null;
  routeInstalled: boolean | null;
  blockedTotal: number | null;
  served: Obj[] | null;
  servedTotal: number | null;
  pageErrors: string[] | null;
  consoleErrors: string[] | null;
  swiperReady: Obj | null;
  serviceWorker: boolean | null;
  // private raw execute provenance (size-capped, PNG base64 elided, secrets redacted)
  rawExecute: { saved: boolean; chars: number | null } | null;
  states: SandboxStateOut[];
  // provenance of every error: the primary failure, cleanup (DELETE) errors and ledger write errors
  errors: { stage: string; kind: "primary" | "cleanup" | "ledger"; detail: string }[];
  warnings: string[];
}

const B64 = /^[A-Za-z0-9+/]*={0,2}$/;

// Strict, bounded parse of the execute output. Sizes are checked BEFORE any
// decode/allocation; PNG header (dimensions) is read before the bytes are kept.
// On failures AFTER the W2F_RESULT JSON parsed, `result` carries the in-browser diagnostics.
export function parseSandboxOutput(resp: unknown): { ok: true; result: Obj; pngs: Uint8Array[] } | { ok: false; status: "rejected" | "ambiguous"; reason: string; result?: Obj } {
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
  if (typeof result.error === "string" && result.error) return { ok: false, status: "rejected", reason: `in-browser step failed${typeof result.stage === "string" ? ` at stage ${result.stage.slice(0, 40)}` : ""}: ${result.error.slice(0, 200)}`, result };
  const states = Array.isArray(result.states) ? result.states : [];
  if (states.length !== SANDBOX.states.length) return { ok: false, status: "ambiguous", reason: `expected ${SANDBOX.states.length} states, got ${states.length}`, result };
  const pngs: Uint8Array[] = [];
  const maxB64 = Math.ceil(SANDBOX.maxPngBytes / 3) * 4;
  for (const [i, s] of states.entries()) {
    if (!isObj(s) || s.seq !== i || s.name !== SANDBOX.states[i] || typeof s.png !== "string") return { ok: false, status: "ambiguous", reason: `state ${i} malformed`, result };
    if (s.png.length > maxB64 || s.png.length % 4 !== 0 || !B64.test(s.png)) return { ok: false, status: "rejected", reason: `state ${i} PNG base64 invalid or over ${SANDBOX.maxPngBytes} bytes`, result };
    const bytes = new Uint8Array(Buffer.from(s.png, "base64"));
    const info = inspectImage(bytes);
    if (!info || info.mime !== "image/png") return { ok: false, status: "rejected", reason: `state ${i} is not a PNG`, result };
    if (info.width < 1 || info.height < 1 || info.width > SANDBOX.viewport.width || info.height > SANDBOX.viewport.height || info.width * info.height > SANDBOX.maxPngPixels) return { ok: false, status: "rejected", reason: `state ${i} PNG ${info.width}x${info.height} outside the pixel caps`, result };
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
    if (!reg || !t || t.selector !== SANDBOX.scope || !clip) return { ok: false, status: "ambiguous", reason: `state ${i} lacks its target measurement or clip`, result };
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : NaN);
    if (r0 && (Math.abs(n(reg.x) - n(r0.x)) > 2 || Math.abs(n(reg.w) - n(r0.w)) > 2 || Math.abs(n(reg.y) - n(r0.y)) > 100)) return { ok: false, status: "rejected", reason: `state ${i} measured a different region geometry`, result };
    const top = Math.max(0, n(t.viewTop));
    if (Math.abs(n(clip.y) - top) > 1 || n(clip.height) > n(t.viewBottom) - top + 1 || n(clip.width) !== SANDBOX.viewport.width) return { ok: false, status: "rejected", reason: `state ${i} clip is not the measured target`, result };
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
  // PRIVATE raw execute provenance (already capped/redacted) for the run directory
  saveRaw?: (text: string) => void;
  // ledger operations (default: the real ./ledger functions); injectable so ledger faults can be tested
  ledger?: Partial<SandboxLedgerOps>;
}

export interface SandboxLedgerOps {
  reserveAttempt: typeof reserveAttempt;
  recordOp: typeof recordOp;
  settleAttempt: typeof settleAttempt;
  settlePendingReconciliation: typeof settlePendingReconciliation;
}

export class SandboxHardHold extends StateRunPolicyError {}

// The ONLY execution entry point: refused while any unsupported condition holds.
export async function executeSandbox(o: SandboxExecuteOptions): Promise<SandboxRecord> {
  if (SANDBOX_UNSUPPORTED.length) throw new SandboxHardHold(`HARD HOLD (no override): ${SANDBOX_UNSUPPORTED.join("; ")}. Nothing was sent, no key was read, no ledger entry was written.`);
  return runSandboxLifecycle(o);
}

// Lifecycle implementation (offline-tested with fake clients/loopback; not
// reachable from the CLI while executeSandbox hard-holds).
const strs = (v: unknown, n: number, len: number) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, n).map((x) => x.slice(0, len)) : null);
const objs = (v: unknown, n: number) => (Array.isArray(v) ? v.filter(isObj).slice(0, n) : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

// Copy what the page code OBSERVED. Guard-derived fields (blocked/served/incomplete) count as
// observed only when the page reports routeInstalled === true; otherwise they stay null (unknown).
export function copyObserved(rec: SandboxRecord, r: Obj): void {
  rec.observation = "w2f-result";
  rec.stage = typeof r.stage === "string" ? r.stage.slice(0, 40) : null;
  rec.routeInstalled = typeof r.routeInstalled === "boolean" ? r.routeInstalled : null;
  const guard = rec.routeInstalled === true;
  rec.incomplete = guard && typeof r.incomplete === "boolean" ? r.incomplete : null;
  rec.blocked = guard ? objs(r.blocked, 50) : null;
  rec.blockedTotal = guard ? num(r.blockedTotal) : null;
  rec.served = guard ? objs(r.served, 60) : null;
  rec.servedTotal = guard ? num(r.servedTotal) : null;
  rec.viewportSet = isObj(r.viewportSet) ? r.viewportSet : null;
  rec.mainFetch = isObj(r.mainFetch) ? r.mainFetch : null;
  rec.ownedContext = isObj(r.ownedContext) ? r.ownedContext : null;
  rec.ownedContextClosed = typeof r.ownedContextClosed === "boolean" ? r.ownedContextClosed : null;
  rec.popupsClosed = num(r.popupsClosed);
  rec.modifications = strs(r.modifications, 10, 200);
  rec.nav = isObj(r.nav) ? r.nav : null;
  rec.env = isObj(r.env) ? r.env : null;
  rec.swiperReady = isObj(r.swiperReady) ? r.swiperReady : null;
  rec.autoplay = isObj(r.autoplay) ? r.autoplay : null;
  rec.serviceWorker = typeof r.serviceWorker === "boolean" ? r.serviceWorker : null;
  rec.pageErrors = strs(r.pageErrors, 10, 300);
  rec.consoleErrors = strs(r.consoleErrors, 10, 300);
}

export const RAW_EXECUTE_CAP = 200_000;
// PRIVATE raw execute provenance: known fields only, PNG base64 elided, each field capped, secrets
// redacted. Never parsed for decisions.
export function rawExecuteProvenance(resp: unknown, secrets: string[]): string {
  const o: Obj = { note: "PRIVATE raw execute provenance: PNG base64 elided, fields size-capped, secrets redacted" };
  const cap = (t: string, n: number) => (t.length > n ? `${t.slice(0, n)}...[truncated ${t.length - n} chars]` : t);
  const elide = (t: string) => t.replace(/"png":"([A-Za-z0-9+/=]{64,})"/g, (_m, b: string) => `"png":"<elided ${b.length} base64 chars>"`);
  if (!isObj(resp)) o.type = resp === null ? "null" : typeof resp;
  else {
    for (const k of ["success", "exitCode", "killed", "truncated"]) if (k in resp && (typeof resp[k] !== "object" || resp[k] === null)) o[k] = resp[k];
    for (const k of ["error", "stderr"]) if (typeof resp[k] === "string") ((o[`${k}Chars`] = (resp[k] as string).length), (o[k] = cap(resp[k] as string, 16_000)));
    for (const k of ["stdout", "result", "output"]) if (typeof resp[k] === "string") ((o[`${k}Chars`] = (resp[k] as string).length), (o[k] = cap(elide(resp[k] as string), 50_000)));
    o.otherKeys = Object.keys(resp).filter((k) => !["success", "exitCode", "killed", "truncated", "error", "stderr", "stdout", "result", "output"].includes(k)).slice(0, 20).map((k) => k.slice(0, 40));
  }
  return redactAll(JSON.stringify(o, null, 2), secrets).slice(0, RAW_EXECUTE_CAP);
}

export async function runSandboxLifecycle(o: SandboxExecuteOptions): Promise<SandboxRecord> {
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
    chargeStatus: "not-settled",
    incomplete: null,
    reservation: gate.reservation,
    viewportSet: null,
    ownedContext: null,
    ownedContextClosed: null,
    mainFetch: null,
    popupsClosed: null,
    modifications: null,
    nav: null,
    env: null,
    autoplay: null,
    blocked: null,
    observation: "none",
    stage: null,
    routeInstalled: null,
    blockedTotal: null,
    served: null,
    servedTotal: null,
    pageErrors: null,
    consoleErrors: null,
    swiperReady: null,
    serviceWorker: null,
    rawExecute: null,
    states: [],
    errors: [],
    warnings: [],
  };
  const log = (m: string) => o.log?.(`[sandbox] ${redact(m, secrets)}`);
  const L: SandboxLedgerOps = { reserveAttempt, recordOp, settleAttempt, settlePendingReconciliation, ...(o.ledger ?? {}) };
  const msg = (err: unknown) => redact(err instanceof Error ? err.message : String(err), secrets);
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
    entryId = L.reserveAttempt(ledgerPath, { url: SANDBOX_URL, requestSha256: o.validated.requestSha256, reserved: gate.reservation, command: "sandbox-run", continuationOf: o.gates.reviewedContinuation }, now).id;
  } catch (err) {
    rec.reason = err instanceof LedgerError ? err.message : String(err);
    return rec;
  }
  rec.ledgerEntryId = entryId;
  // Strict: a ledger write that must precede spending (throws => the op is NOT sent).
  const opStrict = (name: "create" | "execute" | "delete", status: "attempting" | "ok" | "failed" | "ambiguous", detail: string) => {
    try {
      L.recordOp(ledgerPath, entryId, { op: name, status, detail: redact(detail, secrets) }, now);
    } catch (err) {
      rec.errors.push({ stage: `${name}-${status}`, kind: "ledger", detail: `ledger write failed at ${name}-${status}: ${msg(err)}` });
      throw err;
    }
    log(`${name} ${status}${detail ? `: ${detail}` : ""}`);
  };
  // Safe: never throws; a ledger failure is kept in provenance (the entry stays blocking as last written).
  const ledgerSafe = (stage: string, f: () => void) => {
    try {
      f();
      return true;
    } catch (err) {
      const d = `ledger write failed at ${stage}: ${msg(err)}`;
      rec.errors.push({ stage, kind: "ledger", detail: d });
      rec.warnings.push(`${d}; the ledger entry stays as last durably written (blocking) and must be resolved manually`);
      log(d);
      return false;
    }
  };
  const op = (name: "create" | "execute" | "delete", status: "attempting" | "ok" | "failed" | "ambiguous", detail: string) =>
    ledgerSafe(`${name}-${status}`, () => {
      L.recordOp(ledgerPath, entryId, { op: name, status, detail: redact(detail, secrets) }, now);
      log(`${name} ${status}${detail ? `: ${detail}` : ""}`);
    });
  const primary = (stage: string, d: string) => {
    rec.errors.push({ stage, kind: "primary", detail: d });
    if (!rec.reason) rec.reason = d;
  };
  let overall: SandboxRecord["status"] = "ambiguous";
  // ---- create (one attempt; its "attempting" record must be durable BEFORE the request) ----
  try {
    opStrict("create", "attempting", `ttl ${SANDBOX.ttl}s activityTtl ${SANDBOX.activityTtl}s (units assumed seconds; operator-confirmed)`);
  } catch (err) {
    rec.status = "not-attempted";
    rec.reason = `ledger could not record the create attempt (nothing was sent): ${msg(err)}`;
    return rec;
  }
  let created: unknown;
  let createErr: unknown = null;
  try {
    created = await withTimeout(client.browser({ ...o.validated.preview.create }), SANDBOX_WALL_MS.create);
  } catch (err) {
    createErr = err;
  }
  // ANY valid session id (even with success !== true) means a session may exist: it is deleted below.
  // (an HTTP error body that still names a session id counts too)
  const idSource = createErr ? (isObj(createErr) && "body" in createErr ? (createErr as { body?: unknown }).body : null) : created;
  const id = isObj(idSource) && typeof idSource.id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(idSource.id) ? idSource.id : null;
  if (!id) {
    let k: "failed" | "ambiguous" = "ambiguous";
    let d: string;
    if (createErr) {
      k = classify(createErr) === "failed" ? "failed" : "ambiguous";
      d = `create ${k}: ${msg(createErr)}`;
    } else d = `create returned no usable session id (success ${isObj(created) ? String(created.success) : "?"})`;
    rec.ops.push({ op: "create", attempts: 1, status: k, detail: d });
    op("create", k, d);
    rec.status = k;
    primary("create", k === "ambiguous" ? `${d}; a session may exist without a known id (bounded only by its ttl); no automatic re-create` : d);
    ledgerSafe("settle", () => L.settleAttempt(ledgerPath, entryId, k, null, rec.reason!));
    return rec;
  }
  rec.sessionId = id;
  let cleanupOk = false;
  try {
    if (createErr || !isObj(created) || created.success !== true) {
      const k = createErr ? classify(createErr) : "ambiguous";
      const d = createErr ? `create ${k}: ${msg(createErr)}; the error response names session ${id}: not executed; the session is deleted` : `create returned session ${id} without success === true (success ${isObj(created) ? String(created.success) : "?"}); not executed; the session is deleted`;
      rec.ops.push({ op: "create", attempts: 1, status: k, detail: d });
      op("create", k, d);
      primary("create", `${d}; no automatic re-create`);
      return rec;
    }
    rec.ops.push({ op: "create", attempts: 1, status: "ok", detail: `session ${id}${typeof created.expiresAt === "string" ? ` expires ${created.expiresAt.slice(0, 40)}` : ""}` });
    // Without a durable record of the created session, nothing more is spent: execute is skipped.
    opStrict("create", "ok", `session ${id}`);
    // ---- execute (one attempt) ----
    opStrict("execute", "attempting", `node, timeout ${SANDBOX.executeTimeoutS}s`);
    let resp: unknown;
    try {
      resp = await withTimeout(client.browserExecute(id, { ...o.validated.preview.execute }), SANDBOX_WALL_MS.execute);
    } catch (err) {
      const k = classify(err);
      const d = `execute ${k}: ${msg(err)}`;
      rec.ops.push({ op: "execute", attempts: 1, status: k, detail: d });
      op("execute", k, d);
      overall = k === "failed" ? "failed" : "ambiguous";
      primary("execute", d);
      return rec;
    }
    try {
      const raw = rawExecuteProvenance(resp, secrets);
      o.saveRaw?.(raw);
      rec.rawExecute = { saved: !!o.saveRaw, chars: raw.length };
    } catch (err) {
      rec.rawExecute = { saved: false, chars: null };
      rec.warnings.push(`raw execute provenance not saved: ${msg(err)}`);
    }
    const parsed = parseSandboxOutput(resp);
    // in-browser diagnostics are kept on success AND on any failure where W2F_RESULT parsed
    if (parsed.result) copyObserved(rec, parsed.result);
    if (!parsed.ok) {
      rec.ops.push({ op: "execute", attempts: 1, status: parsed.status === "ambiguous" ? "ambiguous" : "ok", detail: parsed.reason });
      op("execute", parsed.status === "ambiguous" ? "ambiguous" : "ok", parsed.reason);
      overall = parsed.status;
      primary("execute", parsed.reason);
      return rec;
    }
    rec.ops.push({ op: "execute", attempts: 1, status: "ok", detail: "W2F_RESULT parsed; 3 states" });
    op("execute", "ok", "W2F_RESULT parsed; 3 states");
    const r = parsed.result;
    if (rec.incomplete) rec.warnings.push("capture INCOMPLETE: subresources were blocked (deny-by-default except exact bootstrapmade.com; redirects never followed; WebSockets refused)");
    if (rec.ownedContextClosed !== true) rec.warnings.push("the owned browser context was not confirmed closed (the session delete still runs)");
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
    if (rec.blocked?.length) rec.warnings.push(`${rec.blocked.length} request(s) aborted by the in-browser guard`);
    rec.warnings.push("states after slideNext(0) are measured after 0 ms transitions, not observed animation completions");
    overall = "accepted";
  } catch (err) {
    // any unexpected error (incl. a strict ledger write) is the primary error; the DELETE below still runs
    overall = "ambiguous";
    primary("lifecycle", `unexpected error after create: ${msg(err)}`);
  } finally {
    // ---- delete (exactly one attempt, always, for any known session id; ledger faults never skip it) ----
    op("delete", "attempting", `session ${id}`);
    let delDetail: string;
    let delStatus: "ok" | "failed" | "ambiguous";
    try {
      const del = await withTimeout(client.deleteBrowser(id), SANDBOX_WALL_MS.delete);
      const billed = isObj(del) && typeof del.creditsBilled === "number" && Number.isFinite(del.creditsBilled) && del.creditsBilled >= 0 ? Math.ceil(del.creditsBilled) : null;
      rec.creditsBilled = billed;
      rec.sessionDurationMs = isObj(del) && typeof del.sessionDurationMs === "number" ? del.sessionDurationMs : null;
      if (isObj(del) && del.success === true) {
        cleanupOk = true;
        delStatus = "ok";
        delDetail = `creditsBilled ${billed ?? "not reported"}; durationMs ${rec.sessionDurationMs ?? "?"}`;
      } else {
        delStatus = "ambiguous";
        delDetail = "delete did not report success";
        rec.errors.push({ stage: "delete", kind: "cleanup", detail: delDetail });
      }
    } catch (err) {
      delStatus = classify(err);
      delDetail = `delete ${delStatus}: ${msg(err)}`;
      rec.errors.push({ stage: "delete", kind: "cleanup", detail: delDetail });
    }
    rec.ops.push({ op: "delete", attempts: 1, status: delStatus, detail: delStatus === "ok" ? `creditsBilled ${rec.creditsBilled ?? "not reported"}` : delDetail });
    op("delete", delStatus, delDetail);
    if (!cleanupOk) {
      rec.warnings.push(`cleanup NOT confirmed for session ${id}: it may keep billing until its ttl; the ledger entry stays blocking until resolved (sandbox-cleanup or ledger resolve); nothing is re-created`);
      if (overall === "accepted") overall = "ambiguous";
    }
    if (rec.errors.some((e) => e.kind === "ledger") && overall === "accepted") overall = "ambiguous";
    rec.status = overall;
    const note = `${rec.status}${rec.reason ? `: ${rec.reason}` : ""}; response creditsBilled ${rec.creditsBilled ?? "absent"} (undocumented, informational); cleanup ${cleanupOk ? "confirmed" : "NOT confirmed"}`;
    if (cleanupOk && (overall === "accepted" || overall === "rejected")) {
      // No documented per-request charge: keep the reservation counted and require reconciliation.
      const settled = ledgerSafe("settle", () => L.settlePendingReconciliation(ledgerPath, entryId, `${note}; charge PENDING RECONCILIATION against GET /v2/team/credit-usage (remainingCredits delta) or the dashboard`));
      if (!settled) rec.status = "ambiguous"; // the durable entry is still "attempting" (blocking)
      else {
        rec.chargeStatus = "pending_reconciliation";
        rec.warnings.push(`charge pending reconciliation: verify the actual credits from a documented account source (GET /v2/team/credit-usage remainingCredits delta, or the dashboard), then: ledger resolve --id ${entryId} --credits N --note "<source>". New paid runs stay blocked until then; nothing is re-run automatically.`);
      }
      if (rec.creditsBilled !== null && rec.creditsBilled > gate.reservation) rec.warnings.push(`response creditsBilled ${rec.creditsBilled} exceeds the reservation ${gate.reservation} (undocumented field; reconcile before trusting it)`);
    } else {
      ledgerSafe("settle", () => L.settleAttempt(ledgerPath, entryId, overall === "failed" && cleanupOk ? "failed" : "ambiguous", null, note));
    }
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
  const ledgerErrors: string[] = [];
  const rec = (status: "attempting" | "ok" | "failed" | "ambiguous", detail: string) => {
    try {
      recordOp(o.ledgerPath, o.entryId, { op: "delete", status, detail }, o.now);
    } catch (err) {
      ledgerErrors.push(`ledger write failed (delete ${status}): ${redact(err instanceof Error ? err.message : String(err), [key])}`);
    }
  };
  rec("attempting", `manual cleanup of session ${created}`);
  let ok = false;
  let detail: string;
  try {
    const del = await withTimeout(client.deleteBrowser(created), SANDBOX_WALL_MS.delete);
    ok = isObj(del) && del.success === true;
    detail = `manual cleanup ${ok ? "ok" : "not confirmed"}; creditsBilled ${isObj(del) && typeof del.creditsBilled === "number" ? del.creditsBilled : "not reported"}`;
  } catch (err) {
    detail = redact(`manual cleanup ${classify(err)}: ${err instanceof Error ? err.message : String(err)}`, [key]);
  }
  rec(ok ? "ok" : detail.startsWith("manual cleanup failed") ? "failed" : "ambiguous", detail);
  return { ok, detail: ledgerErrors.length ? `${detail}; ${ledgerErrors.join("; ")}` : detail };
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
