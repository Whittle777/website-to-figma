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
import { inspectImage, jpegHasSoiEoi, sha256Hex } from "../shared/imageInfo";
import { canonicalJson, classify, sha256, StateRunPolicyError, withTimeout } from "./execute";
import { safeSlice, sanitizeString, sanitizeValue, utf8Bytes } from "./sanitize";
import { writeExclusive } from "./runFiles";
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
  // Execute budget (provider timeout is executeTimeoutS 90, a documented request field; not raised):
  // ONE local in-browser deadline covers setup, navigation, waits, evaluations and screenshots; the
  // owned-context close is a separate bounded single attempt after it; the rest is headroom for
  // serialization/console output and provider overhead: 72 + 5 = 77 s of 90 s (13 s headroom).
  localDeadlineMs: 72_000,
  closeBoundMs: 5_000,
  screenshotMs: 8_000,
  navTimeoutMs: 25_000,
  settleMs: 2_000,
  // bounded wait (page.waitForFunction) for the page's own Swiper to bind to the source-verified element
  swiperReadyMs: 8_000,
  // cap for each MAIN-WORLD Swiper call (diag, stop-autoplay, each slideNext); they resolve on the
  // first evaluation (the page functions always return a non-null object)
  swiperOpMs: 1_500,
  stateWaitMs: 800,
  // bounded wait for a stable slider position after an INSTANT scrollIntoView (per state)
  frameStableMs: 1_000,
  framePollMs: 100,
  scope: "#testimonials",
  swiper: "#testimonials .swiper.init-swiper",
  states: ["Default", "Testimonial next", "Testimonial next 2"],
  // state screenshots are JPEG (run 34a4f0464337: the photo-background PNGs alone exceeded the emit
  // budget); target ~60-100 KB each, hard cap per image below
  imageType: "jpeg",
  jpegQuality: 85,
  maxImageBytes: 250_000,
  maxImagePixels: 1920 * 1080,
  // the provider truncated execute stdout at exactly 1,048,576 chars (run 0cdd8852fb33, observed, not
  // documented); the page code emits at most maxEmitChars (headroom) or omits PNGs and fails closed
  maxOutputChars: 1_048_576,
  maxEmitChars: 900_000,
  // trimmed measurement dump (kept: geometry + computed styles of what intersects the scope)
  maxElements: 300,
  maxTexts: 250,
  maxImages: 20,
  maxTextChars: 500,
} as const;
// Worst case if the session lives its whole ttl (2 credits per session-minute,
// code-only, per the operator-read pricing): NOT a provider cap.
// Conditions under which execution is REFUSED outright (no flag can bypass).
// (empty: the service-worker condition is addressed by the owned context with
// serviceWorkers: "block"; any future unsupported condition goes here)
export const SANDBOX_UNSUPPORTED: string[] = [];
export const SANDBOX_WORST_CASE_CREDITS = Math.ceil(SANDBOX.ttl / 60) * 2;
// nominal step caps must fit inside the local deadline (overhead is covered by the deadline itself)
export const SANDBOX_NOMINAL_MS = SANDBOX.navTimeoutMs + SANDBOX.settleMs + SANDBOX.swiperReadyMs + SANDBOX.swiperOpMs * (2 + (SANDBOX.states.length - 1)) + SANDBOX.states.length * (SANDBOX.stateWaitMs + SANDBOX.frameStableMs + SANDBOX.screenshotMs);
if (SANDBOX_NOMINAL_MS >= SANDBOX.localDeadlineMs) throw new Error("sandbox step caps exceed the local deadline");
if (SANDBOX.localDeadlineMs + SANDBOX.closeBoundMs >= SANDBOX.executeTimeoutS * 1000 - 10_000) throw new Error("local deadline + close bound leave under 10 s of headroom");
if (SANDBOX.ttl < 30 || SANDBOX.ttl > 3600 || SANDBOX.activityTtl < 10 || SANDBOX.activityTtl > 3600) throw new Error("sandbox ttl outside the documented ranges");
export const SANDBOX_WALL_MS = { create: 60_000, execute: SANDBOX.executeTimeoutS * 1000 + 30_000, delete: 60_000 };

// ---- fixed page-side functions (serialized by Playwright page.evaluate) ----
const PAGE_FUNCS = String.raw`
const W2F_PROBE = () => { const d = document.documentElement, b = document.body, vv = window.visualViewport; return { innerWidth: window.innerWidth, innerHeight: window.innerHeight, rootClientWidth: d.clientWidth, rootClientHeight: d.clientHeight, visualViewport: vv ? { width: vv.width, height: vv.height, scale: vv.scale, offsetTop: vv.offsetTop, pageTop: vv.pageTop } : null, scrollY: window.scrollY, documentHeight: Math.max(d.scrollHeight, b ? b.scrollHeight : 0), devicePixelRatio: window.devicePixelRatio, readyState: document.readyState }; };
// Reads el.swiper (a page-JS expando): MUST run in the page's MAIN world (see mainWorld()). Always
// returns a non-null object, so waitForFunction resolves on its first evaluation (applied once).
const W2F_SWIPER = (a) => { try {
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
} catch (e) { return { valid: false, reason: "page function threw: " + String((e && e.message) || e).slice(0, 200) }; } };
// readiness: exactly one match AND the page's own Swiper instance bound to it (self-contained)
const W2F_SWIPER_BOUND = (sel) => { const els = document.querySelectorAll(sel); if (els.length !== 1) return false; const sw = els[0].swiper; return !!sw && typeof sw === "object" && sw.el === els[0] && typeof sw.slideNext === "function"; };
// read-only diagnostics (no page modification) recorded whether or not the Swiper bound
// run in BOTH worlds (main via waitForFunction, evaluate world via page.evaluate) to record which sees
// el.swiper / window.Swiper; always a non-null object
const W2F_SWIPER_DIAG = (sel) => { try {
  const els = Array.from(document.querySelectorAll(sel)); const el = els[0] || null;
  const src = (s) => { if (!s.src) return "(inline)"; try { const u = new URL(s.src); return u.host === location.host ? u.pathname.slice(0, 200) : u.protocol + "//" + u.host + "/(other host)"; } catch (e) { return "(invalid)"; } };
  return { matches: els.length, initializedClass: el ? el.classList.contains("swiper-initialized") : null, hasSwiperProp: el ? !!el.swiper : null, windowSwiperType: typeof window.Swiper, configPresent: el ? !!el.querySelector(".swiper-config") : null, slides: el ? el.querySelectorAll(".swiper-slide").length : null, readyState: document.readyState, scripts: Array.from(document.scripts).slice(0, 30).map(src) };
} catch (e) { return { error: "page function threw: " + String((e && e.message) || e).slice(0, 200) }; } };
// INSTANT scroll (never smooth): the position is then confirmed stable by polling W2F_VIEW_RECT
const W2F_INTO_VIEW = (sel) => { const e = document.querySelector(sel); if (!e) return false; e.scrollIntoView({ block: "start", inline: "nearest", behavior: "instant" }); return true; };
// DOM-only: viewport rect of exactly one element (null otherwise)
const W2F_VIEW_RECT = (sel) => { const els = document.querySelectorAll(sel); if (els.length !== 1) return null; const r = els[0].getBoundingClientRect(); return { top: r.top, left: r.left, bottom: r.bottom, right: r.right, width: r.width, height: r.height, inViewport: r.top >= -1 && r.left >= -1 && r.bottom <= window.innerHeight + 1 && r.right <= window.innerWidth + 1 }; };
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
    for (const r of runs) if (r.text.trim() && texts.length < a.maxTexts) texts.push({ ...r, text: r.text.slice(0, a.maxTextChars), style: s, tag: p.tagName.toLowerCase() });
  }
  // self-contained (Playwright serializes only this function): probe inlined
  const d = document.documentElement, bd = document.body, vv = window.visualViewport;
  const probe = { innerWidth: window.innerWidth, innerHeight: window.innerHeight, rootClientWidth: d.clientWidth, rootClientHeight: d.clientHeight, visualViewport: vv ? { width: vv.width, height: vv.height, scale: vv.scale, offsetTop: vv.offsetTop, pageTop: vv.pageTop } : null, scrollY: window.scrollY, documentHeight: Math.max(d.scrollHeight, bd ? bd.scrollHeight : 0), devicePixelRatio: window.devicePixelRatio, readyState: document.readyState };
  // the screenshot box (the slider): exactly one match, viewport coordinates
  const ce = a.clipSel ? document.querySelectorAll(a.clipSel) : []; const cr = ce.length === 1 ? ce[0].getBoundingClientRect() : null;
  const clipTarget = cr ? { selector: a.clipSel, viewLeft: cr.left, viewTop: cr.top, width: cr.width, height: cr.height, viewBottom: cr.bottom, inViewport: cr.top >= -1 && cr.left >= -1 && cr.bottom <= window.innerHeight + 1 && cr.right <= window.innerWidth + 1 } : null;
  return { target: { selector: a.scope, viewTop: tr.top, viewBottom: tr.bottom, left: tr.left, width: tr.width, height: tr.height, documentY: tr.top + sy, inViewport: tr.top >= -1 && tr.bottom <= window.innerHeight + 1 }, clipTarget, region, probe, elements, texts, images };
};`;

export const SANDBOX_CODE = String.raw`// website-to-figma fixed sandbox code (reviewed; takes no inputs)
const W = ${JSON.stringify({ url: SANDBOX.url, host: "bootstrapmade.com", vw: SANDBOX.viewport.width, vh: SANDBOX.viewport.height, localDeadlineMs: SANDBOX.localDeadlineMs, closeBoundMs: SANDBOX.closeBoundMs, screenshotMs: SANDBOX.screenshotMs, navTimeoutMs: SANDBOX.navTimeoutMs, settleMs: SANDBOX.settleMs, swiperReadyMs: SANDBOX.swiperReadyMs, swiperOpMs: SANDBOX.swiperOpMs, stateWaitMs: SANDBOX.stateWaitMs, frameStableMs: SANDBOX.frameStableMs, framePollMs: SANDBOX.framePollMs, maxEmitChars: SANDBOX.maxEmitChars, scope: SANDBOX.scope, swiper: SANDBOX.swiper, states: SANDBOX.states, imageType: SANDBOX.imageType, jpegQuality: SANDBOX.jpegQuality, maxImageBytes: SANDBOX.maxImageBytes, max: { maxElements: SANDBOX.maxElements, maxTexts: SANDBOX.maxTexts, maxImages: SANDBOX.maxImages, maxTextChars: SANDBOX.maxTextChars } })};
${PAGE_FUNCS}
// stage = the step in progress when an error is thrown; routeInstalled says whether blocked/served/
// incomplete were OBSERVED by the guard (false => they are unobserved defaults, not evidence)
// listenersInstalled: pageErrors/consoleErrors/popupsClosed/modifications are observations only once true
const out = { w2f: "sandbox", v: 1, error: null, stage: "start", routeInstalled: false, listenersInstalled: false, deadline: { localDeadlineMs: W.localDeadlineMs, hit: false, at: null, elapsedMs: null }, close: { attempted: false, ok: null, timedOut: false, boundMs: W.closeBoundMs, ms: null }, incomplete: false, ownedContext: null, ownedContextClosed: null, mainFetch: null, nav: null, env: null, swiperReady: null, autoplay: null, modifications: [], blocked: [], blockedTotal: 0, served: [], servedTotal: 0, pageErrors: [], consoleErrors: [], popupsClosed: 0, serviceWorker: null, states: [] };
let ctx = null;
// ONE local deadline for the whole capture path. Every Playwright call is raced against the time left
// (and its own timeout option is capped to it); past the deadline nothing new is started.
const T0 = Date.now();
const left = () => W.localDeadlineMs - (Date.now() - T0);
const tmo = (cap) => Math.max(1, Math.min(cap, left()));
const deadlineErr = (what) => { out.deadline.hit = true; out.deadline.at = what; return new Error("local deadline " + W.localDeadlineMs + " ms reached during " + what); };
const within = async (what, thunk, cap) => {
  const ms = Math.min(cap === undefined ? Infinity : cap, left());
  if (ms <= 0) throw deadlineErr(what);
  const pr = Promise.resolve().then(thunk); pr.catch(() => {});
  let t = null;
  const timer = new Promise((_, rej) => { t = setTimeout(() => rej(deadlineErr(what)), ms); });
  try { return await Promise.race([pr, timer]); } finally { clearTimeout(t); }
};
try {
  // Reach the Browser through documented public APIs; never navigate the preconnected default page.
  if (typeof page === "undefined" || !page || typeof page.context !== "function") throw new Error("no Playwright page in this session");
  const browser = page.context().browser();
  if (!browser || typeof browser.newContext !== "function") throw new Error("Browser object unavailable: cannot create the owned context");
  // ONE owned incognito context: service-worker registration blocked, viewport fixed BEFORE any page exists.
  out.stage = "newContext";
  ctx = await within("newContext", () => browser.newContext({ serviceWorkers: "block", viewport: { width: W.vw, height: W.vh } }));
  out.ownedContext = { serviceWorkers: "block", viewport: { width: W.vw, height: W.vh } };
  let own = null;
  // MAIN-WORLD call for page-JS state (el.swiper, window.Swiper): page.waitForFunction runs its
  // predicate in the page's main world (the path that saw el.swiper in the hosted run, where
  // page.evaluate did not). The predicate returns a JSON object (truthy), so it resolves on the first
  // evaluation; the value is read with JSHandle.jsonValue() and the handle disposed. Bounded by the
  // local deadline.
  const mainWorld = async (what, fn, arg, cap) => {
    const h = await within(what, () => own.waitForFunction(fn, arg, { timeout: tmo(cap), polling: 100 }), cap);
    try { return await within(what + "-value", () => h.jsonValue()); } finally { try { await h.dispose(); } catch (e) {} }
  };
  // bounded: poll the slider's viewport rect until two consecutive reads agree (or frameStableMs /
  // the poll cap is reached -> not stable); every call stays inside the local deadline
  const stableFrame = async () => {
    const t0 = Date.now(); const maxPolls = Math.ceil(W.frameStableMs / W.framePollMs) + 1; let prev = null, polls = 0;
    for (;;) {
      const r = await within("frame-stable", () => own.evaluate(W2F_VIEW_RECT, W.swiper)); polls++;
      if (!r) throw new Error("slider not found for framing");
      if (prev && Math.abs(r.top - prev.top) < 0.5 && Math.abs(r.left - prev.left) < 0.5) return { top: r.top, left: r.left, inViewport: r.inViewport, polls, ms: Date.now() - t0, stable: true };
      prev = r;
      if (polls >= maxPolls || Date.now() - t0 >= W.frameStableMs) return { top: r.top, left: r.left, inViewport: r.inViewport, polls, ms: Date.now() - t0, stable: false };
      await within("frame-stable-wait", () => own.waitForTimeout(tmo(W.framePollMs)));
    }
  };
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
  await within("route", () => ctx.route("**/*", async (route) => {
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
    if (left() <= 0) return deny(route, raw, nav, "local-deadline");
    try { resp = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: tmo(W.navTimeoutMs) }); } catch (e) { return deny(route, raw, nav, "fetch-error"); }
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
  }));
  out.routeInstalled = true;
  // WebSockets are not seen by context.route: every one is refused (never connected to a server).
  if (typeof ctx.routeWebSocket !== "function") throw new Error("context.routeWebSocket unavailable: cannot refuse WebSocket connections");
  out.stage = "routeWebSocket";
  await within("routeWebSocket", () => ctx.routeWebSocket(/.*/, (ws) => { out.blockedTotal++; if (out.blocked.length < 50) out.blocked.push({ origin: originOf(ws.url()), why: "websocket" }); out.incomplete = true; ws.close(); }));
  out.stage = "newPage";
  own = await within("newPage", () => ctx.newPage());
  // page script errors are recorded (bounded) as diagnostics only
  own.on("pageerror", (e) => { if (out.pageErrors.length < 10) out.pageErrors.push(String((e && e.message) || e).slice(0, 300)); });
  own.on("console", (m) => { try { if (m.type() === "error" && out.consoleErrors.length < 10) out.consoleErrors.push(String(m.text()).slice(0, 300)); } catch (e) {} });
  ctx.on("page", (p) => { if (p !== own) { out.popupsClosed++; p.close().catch(() => {}); } });
  out.listenersInstalled = true;
  // Viewport set on the SAME page used for all three states, BEFORE navigation.
  await within("setViewportSize", () => own.setViewportSize({ width: W.vw, height: W.vh }));
  out.stage = "goto";
  const resp = await within("goto", () => own.goto(W.url, { waitUntil: "load", timeout: tmo(W.navTimeoutMs) }));
  const chain = []; let r = resp ? resp.request() : null;
  while (r && chain.length < 10) { chain.unshift(r.url()); r = r.redirectedFrom(); }
  out.nav = { status: resp ? resp.status() : null, finalUrl: own.url(), chain };
  if (!out.mainFetch || out.mainFetch.status < 200 || out.mainFetch.status > 299) throw new Error("main document was not fetched with a 2xx by the route guard");
  if (own.url() !== W.url || chain.length !== 1 || chain[0] !== W.url) throw new Error("navigation left the exact target URL (redirect or rewrite)");
  out.stage = "settle";
  await within("settle", () => own.waitForTimeout(tmo(W.settleMs)));
  out.stage = "probe";
  out.env = await within("probe", () => own.evaluate(W2F_PROBE));
  out.serviceWorker = await within("serviceWorker", () => own.evaluate(() => !!(navigator.serviceWorker && navigator.serviceWorker.controller)));
  if (out.serviceWorker) throw new Error("a service worker controls the page (its requests bypass routing)");
  if (out.env.innerWidth !== W.vw || out.env.innerHeight !== W.vh) throw new Error("viewport not applied: " + out.env.innerWidth + "x" + out.env.innerHeight);
  // Bounded readiness: wait (supported page.waitForFunction) until the page's OWN Swiper is bound to the
  // source-verified element; on timeout fail closed WITH read-only diagnostics.
  out.stage = "swiper-ready";
  const t0 = Date.now();
  try {
    await within("swiper-ready", () => own.waitForFunction(W2F_SWIPER_BOUND, W.swiper, { timeout: tmo(W.swiperReadyMs), polling: 100 }));
    out.swiperReady = { ready: true, waitedMs: Date.now() - t0, timeoutMs: W.swiperReadyMs };
  } catch (e) {
    out.swiperReady = { ready: false, waitedMs: Date.now() - t0, timeoutMs: W.swiperReadyMs, error: String((e && e.message) || e).slice(0, 200) };
  }
  if (out.deadline.hit) throw new Error("local deadline " + W.localDeadlineMs + " ms reached during swiper-ready");
  // dual-world diagnostics: which JS world sees el.swiper / window.Swiper (DOM is shared by both)
  const diag = { mainWorld: null, evaluateWorld: null, evaluateIsolated: null };
  try { diag.mainWorld = await mainWorld("swiper-diag-main", W2F_SWIPER_DIAG, W.swiper, W.swiperOpMs); } catch (e) { diag.mainWorld = { error: String((e && e.message) || e).slice(0, 200) }; }
  try { diag.evaluateWorld = await within("swiper-diag-evaluate", () => own.evaluate(W2F_SWIPER_DIAG, W.swiper)); } catch (e) { diag.evaluateWorld = { error: String((e && e.message) || e).slice(0, 200) }; }
  if (diag.mainWorld && diag.evaluateWorld && typeof diag.mainWorld.hasSwiperProp === "boolean" && typeof diag.evaluateWorld.hasSwiperProp === "boolean") diag.evaluateIsolated = diag.mainWorld.hasSwiperProp && !diag.evaluateWorld.hasSwiperProp;
  out.swiperReady.diag = diag;
  if (out.deadline.hit) throw new Error("local deadline " + W.localDeadlineMs + " ms reached during swiper-diag");
  if (!out.swiperReady.ready) throw new Error("swiper not bound within " + W.swiperReadyMs + " ms (see swiperReady.diag)");
  // fail closed: readiness passed in the main world, so the main-world diag MUST see the instance
  if (!diag.mainWorld || diag.mainWorld.hasSwiperProp !== true) throw new Error("readiness passed but the main-world diag cannot see el.swiper (see swiperReady.diag)");
  out.stage = "autoplay";
  out.autoplay = await mainWorld("autoplay", W2F_SWIPER, { sel: W.swiper, op: "stop-autoplay" }, W.swiperOpMs);
  if (!out.autoplay.valid) throw new Error("swiper refused: " + out.autoplay.reason);
  if (out.autoplay.before && out.autoplay.before.autoplayRunning) out.modifications.push("stopped autoplay of " + W.swiper + " via its own Swiper API (not the page's original behavior)");
  // All three states on the SAME owned page.
  for (let seq = 0; seq < W.states.length; seq++) {
    out.stage = "state-" + seq;
    let trigger = null;
    if (seq > 0) { trigger = await mainWorld("swiper-next", W2F_SWIPER, { sel: W.swiper, op: "next" }, W.swiperOpMs); if (!trigger.valid) throw new Error("swiper refused: " + trigger.reason); }
    if (!(await within("into-view", () => own.evaluate(W2F_INTO_VIEW, W.scope)))) throw new Error("scope not found");
    await within("state-wait", () => own.waitForTimeout(tmo(W.stateWaitMs)));
    // EVERY state (incl. state 0) needs a stable, fully in-viewport slider before measuring
    const framing = await stableFrame();
    if (!framing.stable) throw new Error("slider position not stable within " + W.frameStableMs + " ms");
    if (!framing.inViewport) throw new Error("slider not fully in the viewport after a stable scroll (viewTop " + Math.round(framing.top) + ")");
    const m = await within("measure", () => own.evaluate(W2F_MEASURE, { scope: W.scope, clipSel: W.swiper, ...W.max }));
    if (!m.target) throw new Error("scope not found");
    if (!m.clipTarget) throw new Error("slider not found for the screenshot");
    if (!m.clipTarget.inViewport) throw new Error("slider not fully in the viewport at measurement (viewTop " + Math.round(m.clipTarget.viewTop) + ")");
    // screenshot = the slider box (intersected with the viewport), not a full-width strip
    const ct = m.clipTarget; const cx = Math.max(0, ct.viewLeft), cy = Math.max(0, ct.viewTop);
    const clip = { x: cx, y: cy, width: Math.min(W.vw, ct.viewLeft + ct.width) - cx, height: Math.min(W.vh, ct.viewBottom) - cy };
    if (clip.width < 1 || clip.height < 1) throw new Error("target not visible for the screenshot");
    const img = await within("screenshot", () => own.screenshot({ type: W.imageType, quality: W.jpegQuality, clip, timeout: tmo(W.screenshotMs) }));
    if (img.length > W.maxImageBytes) throw new Error("screenshot over the byte cap (" + img.length + " > " + W.maxImageBytes + ")");
    out.states.push({ seq, name: W.states[seq], trigger, framing, measured: m, clip, imgType: W.imageType, imgBytes: img.length, img: img.toString("base64") });
  }
} catch (e) {
  out.error = String((e && e.message) || e).slice(0, 300);
} finally {
  if (!out.error) out.stage = "done";
  out.deadline.elapsedMs = Date.now() - T0;
  // the owned context is closed exactly once, OUTSIDE the capture deadline, bounded by closeBoundMs
  if (ctx) {
    out.close.attempted = true; const c0 = Date.now(); let ct = null;
    try {
      const r = await Promise.race([ctx.close().then(() => "closed"), new Promise((res) => { ct = setTimeout(() => res("timeout"), W.closeBoundMs); })]);
      out.close.ok = r === "closed"; out.close.timedOut = r === "timeout"; out.ownedContextClosed = r === "closed";
    } catch (e) { out.close.ok = false; out.ownedContextClosed = false; }
    finally { clearTimeout(ct); out.close.ms = Date.now() - c0; }
  }
}
// OUTPUT BUDGET: the provider truncates stdout (observed at 1,048,576 chars). The serialized line is
// measured HERE (max of UTF-16 length and UTF-8 bytes) against W.maxEmitChars. Over budget: whole
// images are dropped from the LAST state backwards, so the kept images are the longest prefix in state
// order (0, then 1, then 2) that fits; omitted ones are reported with their sizes and the run fails
// closed (never success with any image omitted). Still over with no images: measurements omitted;
// then a minimal record. The emitted line is ALWAYS complete, valid JSON within the budget.
const W2F_EMIT = () => {
  const P = "W2F_RESULT ";
  const size = (t) => P.length + Math.max(t.length, typeof Buffer !== "undefined" ? Buffer.byteLength(t, "utf8") : t.length * 3);
  out.budget = { maxEmitChars: W.maxEmitChars, measuredChars: null, imagesOmitted: 0, keptImageSeqs: null, omittedImages: null, measurementsOmitted: false };
  let line = JSON.stringify(out);
  out.budget.measuredChars = size(line);
  line = JSON.stringify(out);
  if (size(line) <= W.maxEmitChars) return P + line;
  const base = out.error;
  const omitted = [];
  for (let k = out.states.length - 1; k >= 0; k--) {
    const st = out.states[k];
    if (typeof st.img !== "string") continue;
    omitted.unshift({ seq: st.seq, bytes: st.imgBytes, base64Chars: st.img.length });
    st.img = null; st.imgOmitted = true;
    out.budget.imagesOmitted = omitted.length;
    out.budget.omittedImages = omitted;
    out.budget.keptImageSeqs = out.states.filter((x) => typeof x.img === "string").map((x) => x.seq);
    out.error = (base ? base + "; " : "") + "result line over the " + W.maxEmitChars + "-char output budget (" + out.budget.measuredChars + "): " + omitted.length + " image(s) omitted (kept states [" + out.budget.keptImageSeqs.join(",") + "]), capture rejected";
    line = JSON.stringify(out);
    if (size(line) <= W.maxEmitChars) return P + line;
  }
  out.budget.measurementsOmitted = true;
  for (const st of out.states) st.measured = null;
  line = JSON.stringify(out);
  if (size(line) <= W.maxEmitChars) return P + line;
  line = JSON.stringify({ w2f: "sandbox", v: 1, error: String(out.error).slice(0, 300), stage: out.stage, budget: out.budget, states: [] });
  if (size(line) <= W.maxEmitChars) return P + line;
  return P + JSON.stringify({ w2f: "sandbox", v: 1, error: "result line over the output budget", states: [] });
};
console.log(W2F_EMIT());`;

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
      "JS worlds: on the hosted browser page.evaluate was observed NOT to see el.swiper / window.Swiper while page.waitForFunction did (run da1ae3f40f44; isolated-world evaluate is a hypothesis, not confirmed by docs). Every read of page-JS state (readiness, diag, stop-autoplay, slideNext) therefore runs through page.waitForFunction (main world) + JSHandle.jsonValue(); the page functions always return a non-null object, so each resolves on its first evaluation. DOM-only steps (probe, into-view, measure, screenshots) stay on page.evaluate. The diag runs in both worlds and records evaluateIsolated; the run fails closed if the main-world diag cannot see el.swiper after readiness. No undocumented evaluate flag is used.",
      "Output budget: the provider truncated execute stdout at exactly 1,048,576 chars in run 0cdd8852fb33 (observed, not documented). The page code measures the serialized result line itself (max of UTF-16 length and UTF-8 bytes) against 900,000. State screenshots are JPEG quality 85 (run 34a4f0464337: photo-background PNGs alone exceeded the budget), each <= 250,000 bytes, validated by JPEG magic (SOI), end-of-image (EOI), SOF dimensions and pixel caps. Over budget, WHOLE images are dropped from the last state backwards, so the kept images are the longest prefix in state order that fits; omitted ones are reported with sizes and the run is REJECTED (kept images are validated and saved as evidence only, never converted); then measurements, then a minimal record, so the emitted line is always complete JSON. The result line is located line-anchored. Measurement dump trimmed (300 elements, 250 text runs of <= 500 chars, 20 images).",
      "Screenshots are the slider box (#testimonials .swiper.init-swiper) intersected with the viewport, validated against the measured box and the measured scope target; conversion shifts each state so the clip's left edge is x 0 and uses the clip box as the variant frame (the renderer places reference images at page x 0). Framing: scrollIntoView behavior instant, then a bounded poll (1 s, 100 ms) until the slider's viewport position is unchanged between reads; every state, incl. state 0, must have the slider fully in the viewport, else fail closed.",
      "Swiper readiness: after goto + settle, page.waitForFunction (polling 100 ms, timeout 10 s) waits until the page's own Swiper instance is bound to the source-verified element (#testimonials .swiper.init-swiper); if it never binds the run fails closed with read-only diagnostics (stage, served/blocked requests, page errors, Swiper/script snapshot). Why an earlier run found it unbound is NOT determined.",
      "Failure diagnostics: a well-formed W2F_RESULT is recovered even when the execute envelope fails (success false, killed, truncated, nonzero exit); the run stays rejected/ambiguous. Observed browser fields are kept; unobserved fields are null (guard fields need routeInstalled, page/listener fields need listenersInstalled). Everything persisted or printed (sandbox.json, execute-raw.json, every ledger write via the ledger's single serializer, CLI logs and errors) is sanitized first: API keys, complete Authorization values (scheme + credential), URL userinfo, credential/session/token and long opaque query values, CDP/DevTools/live-view/session/WebSocket URLs, credential key=value pairs, JWTs. execute-raw.json is always valid JSON within 200,000 UTF-8 bytes (serialized size) with explicit per-field truncation metadata. States-run/diagnostic response files are NOT sanitized (they keep signed screenshot URLs needed for the later download step).",
      "Timing: ONE cooperative local deadline (72 s) covers setup, navigation, waits, evaluations and screenshots (each Playwright call is raced against the time left and its own timeout capped to it); the owned-context close is a separate single attempt bounded to 5 s; 13 s of the documented 90 s execute timeout remain for serialization and provider overhead. The record keeps localDeadline, ownedContextClose, providerKilled and transportTimedOut separately. Not a hard bound: synchronous work in the sandbox's Node process cannot be pre-empted, and the provider's own kill is outside this code.",
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
  // instant-scroll stability evidence for this state (null = not observed)
  framing: Obj | null;
  measured: Obj;
  clip: { x: number; y: number; width: number; height: number };
  image: { mime: "image/jpeg"; sha256: string; width: number; height: number; bytes: number };
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
  // distinct limits (none is claimed as a hard bound on the provider):
  // localDeadline = cooperative in-browser capture deadline (W2F_RESULT); ownedContextClose = the
  // separate bounded close; providerKilled = execute envelope `killed` (provider timeout);
  // transportTimedOut = this tool's client-side wait for the execute response ran out.
  timing: {
    limits: { localDeadlineMs: number; closeBoundMs: number; providerExecuteTimeoutS: number; transportExecuteWallMs: number };
    localDeadline: Obj | null;
    ownedContextClose: Obj | null;
    providerKilled: boolean | null;
    transportTimedOut: boolean | null;
  };
  // private raw execute provenance (size-capped, PNG base64 elided, secrets redacted)
  rawExecute: { saved: boolean; chars: number | null } | null;
  // in-browser output budget as reported by the page code (null = not observed)
  budget: Obj | null;
  // validated images KEPT by a rejected over-budget run (state-order prefix); evidence only, never a
  // success and never converted
  partialImages: { seq: number; mime: "image/jpeg"; sha256: string; width: number; height: number; bytes: number }[] | null;
  states: SandboxStateOut[];
  // provenance of every error: the primary failure, cleanup (DELETE) errors and ledger write errors
  errors: { stage: string; kind: "primary" | "cleanup" | "ledger"; detail: string }[];
  warnings: string[];
}

const B64 = /^[A-Za-z0-9+/]*={0,2}$/;

// Strict, bounded parse of the execute output. Sizes are checked BEFORE any
// decode/allocation; PNG header (dimensions) is read before the bytes are kept.
// Recover a well-formed W2F_RESULT line (diagnostics only) from any execute output, bounded.
function recoverW2fResult(resp: Obj): { result: Obj | null; why: string | null } {
  const text = [resp.stdout, resp.output, resp.result].find((x): x is string => typeof x === "string" && x.includes("W2F_RESULT "));
  if (!text) return { result: null, why: "no W2F_RESULT line in the execute output" };
  if (text.length > SANDBOX.maxOutputChars) return { result: null, why: `execute output ${text.length} chars exceeds ${SANDBOX.maxOutputChars}` };
  // the LAST line that STARTS with the prefix (the prefix may also occur inside JSON string values)
  const at = text.startsWith("W2F_RESULT ") && !text.includes("\nW2F_RESULT ") ? 0 : text.lastIndexOf("\nW2F_RESULT ") + 1;
  if (at < 0 || !text.startsWith("W2F_RESULT ", at)) return { result: null, why: "no W2F_RESULT line in the execute output" };
  const end = text.indexOf("\n", at);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(at + "W2F_RESULT ".length, end < 0 ? undefined : end));
  } catch {
    return { result: null, why: "W2F_RESULT is not valid JSON (partial output?)" };
  }
  if (!isObj(parsed) || parsed.w2f !== "sandbox" || parsed.v !== 1) return { result: null, why: "W2F_RESULT has the wrong schema" };
  return { result: parsed, why: null };
}

// Envelope failures (success false, truncated, killed, nonzero exit) still reject/ambiguous, but
// any well-formed W2F_RESULT is returned as `result` so its diagnostics are kept.
// One state image (base64 from the page code): bounded base64, <= maxImageBytes, JPEG magic (SOI) AND
// end-of-image (EOI), JPEG header (SOFn) dimensions within the viewport / pixel caps.
export function validateStateImage(b64: unknown, i: number): { ok: true; bytes: Uint8Array; width: number; height: number } | { ok: false; reason: string } {
  const maxB64 = Math.ceil(SANDBOX.maxImageBytes / 3) * 4;
  if (typeof b64 !== "string" || b64.length > maxB64 || b64.length % 4 !== 0 || !B64.test(b64)) return { ok: false, reason: `state ${i} image base64 invalid or over ${SANDBOX.maxImageBytes} bytes` };
  const bytes = new Uint8Array(Buffer.from(b64, "base64"));
  if (bytes.length > SANDBOX.maxImageBytes) return { ok: false, reason: `state ${i} image over ${SANDBOX.maxImageBytes} bytes` };
  const info = inspectImage(bytes);
  if (!info || info.mime !== "image/jpeg") return { ok: false, reason: `state ${i} is not a JPEG` };
  if (!jpegHasSoiEoi(bytes)) return { ok: false, reason: `state ${i} JPEG is truncated (no SOI/EOI)` };
  if (info.width < 1 || info.height < 1 || info.width > SANDBOX.viewport.width || info.height > SANDBOX.viewport.height || info.width * info.height > SANDBOX.maxImagePixels) return { ok: false, reason: `state ${i} JPEG ${info.width}x${info.height} outside the pixel caps` };
  return { ok: true, bytes, width: info.width, height: info.height };
}

export function parseSandboxOutput(resp: unknown): { ok: true; result: Obj; images: Uint8Array[] } | { ok: false; status: "rejected" | "ambiguous"; reason: string; result?: Obj } {
  if (!isObj(resp)) return { ok: false, status: "ambiguous", reason: "execute response is not an object" };
  const rec = recoverW2fResult(resp);
  const kept = rec.result ? { result: rec.result } : {};
  const note = rec.result ? " (W2F_RESULT diagnostics recovered)" : "";
  if (resp.success === false) return { ok: false, status: "rejected", reason: `execute reported failure: ${String(resp.error ?? "").slice(0, 200)}${note}`, ...kept };
  if (resp.truncated === true) return { ok: false, status: "ambiguous", reason: `execute output was truncated by the provider${note}`, ...kept };
  if (resp.killed === true) return { ok: false, status: "ambiguous", reason: `execute was killed (provider timeout)${note}`, ...kept };
  if (typeof resp.exitCode === "number" && resp.exitCode !== 0) return { ok: false, status: "rejected", reason: `execute exit code ${resp.exitCode}${note}`, ...kept };
  if (!rec.result) return { ok: false, status: rec.why!.includes("exceeds") ? "rejected" : "ambiguous", reason: rec.why! };
  const result = rec.result;
  if (typeof result.error === "string" && result.error) return { ok: false, status: "rejected", reason: `in-browser step failed${typeof result.stage === "string" ? ` at stage ${result.stage.slice(0, 40)}` : ""}: ${result.error.slice(0, 200)}`, result };
  const states = Array.isArray(result.states) ? result.states : [];
  if (states.length !== SANDBOX.states.length) return { ok: false, status: "ambiguous", reason: `expected ${SANDBOX.states.length} states, got ${states.length}`, result };
  const images: Uint8Array[] = [];
  for (const [i, s] of states.entries()) {
    if (!isObj(s) || s.seq !== i || s.name !== SANDBOX.states[i] || typeof s.img !== "string") return { ok: false, status: "ambiguous", reason: `state ${i} malformed`, result };
    const v = validateStateImage(s.img, i);
    if (!v.ok) return { ok: false, status: "rejected", reason: v.reason, result };
    images.push(v.bytes);
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
    // the clip must be the measured slider box (exactly one element, fully in the viewport), inside the
    // measured scope target, and equal to that box intersected with the viewport (±1 px)
    const ct = isObj((s.measured as Obj).clipTarget) ? ((s.measured as Obj).clipTarget as Obj) : null;
    if (!ct || ct.selector !== SANDBOX.swiper) return { ok: false, status: "ambiguous", reason: `state ${i} lacks the measured slider box`, result };
    if (ct.inViewport !== true) return { ok: false, status: "rejected", reason: `state ${i} slider box was not fully in the viewport`, result };
    const ctL = n(ct.viewLeft), ctT = n(ct.viewTop), ctR = ctL + n(ct.width), ctB = n(ct.viewBottom);
    if (!(ctL >= n(t.left) - 1 && ctT >= n(t.viewTop) - 1 && ctR <= n(t.left) + n(t.width) + 1 && ctB <= n(t.viewBottom) + 1)) return { ok: false, status: "rejected", reason: `state ${i} slider box is outside the measured target`, result };
    const ex = Math.max(0, ctL), ey = Math.max(0, ctT);
    const want = { x: ex, y: ey, width: Math.min(SANDBOX.viewport.width, ctR) - ex, height: Math.min(SANDBOX.viewport.height, ctB) - ey };
    const off = (["x", "y", "width", "height"] as const).some((k) => !(Math.abs(n(clip[k]) - want[k]) <= 1));
    if (off || want.width < 1 || want.height < 1 || n(clip.x) + n(clip.width) > SANDBOX.viewport.width + 1 || n(clip.y) + n(clip.height) > SANDBOX.viewport.height + 1) return { ok: false, status: "rejected", reason: `state ${i} clip is not the measured slider box`, result };
  }
  return { ok: true, result, images };
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
  // state image writer (JPEG bytes, already validated); also used for the kept prefix of a rejected
  // over-budget run (partial evidence; the run stays rejected)
  saveImage?: (seq: number, bytes: Uint8Array) => void;
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
const redact500 = (t: string, secrets: readonly string[]) => sanitizeString(t, secrets).slice(0, 500);
// Over-budget runs keep the longest state-order prefix of whole images. Those are validated with the
// same rules as a successful run and saved as evidence; the run stays rejected (never converted).
function savePartialImages(rec: SandboxRecord, r: Obj, save?: (seq: number, bytes: Uint8Array) => void): void {
  const budget = isObj(r.budget) ? r.budget : null;
  if (!budget || typeof budget.imagesOmitted !== "number" || budget.imagesOmitted < 1 || !Array.isArray(r.states)) return;
  const kept: NonNullable<SandboxRecord["partialImages"]> = [];
  for (const [i, s] of (r.states as unknown[]).slice(0, SANDBOX.states.length).entries()) {
    if (!isObj(s) || s.seq !== i || typeof s.img !== "string") break; // prefix only
    const v = validateStateImage(s.img, i);
    if (!v.ok) {
      rec.warnings.push(`partial image ${i} not kept: ${v.reason}`);
      break;
    }
    kept.push({ seq: i, mime: "image/jpeg", sha256: sha256Hex(v.bytes), width: v.width, height: v.height, bytes: v.bytes.length });
    save?.(i, v.bytes);
  }
  rec.partialImages = kept;
  rec.warnings.push(`over the in-browser output budget: kept ${kept.length} whole image(s) in state order as evidence, ${budget.imagesOmitted} omitted; the run is REJECTED (never a success with an omitted image)`);
}

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
  // listener-derived fields are observations only once the page and its listeners existed
  const listeners = r.listenersInstalled === true;
  rec.popupsClosed = listeners ? num(r.popupsClosed) : null;
  rec.modifications = listeners ? strs(r.modifications, 10, 200) : null;
  rec.nav = isObj(r.nav) ? r.nav : null;
  rec.env = isObj(r.env) ? r.env : null;
  rec.swiperReady = isObj(r.swiperReady) ? r.swiperReady : null;
  rec.autoplay = isObj(r.autoplay) ? r.autoplay : null;
  rec.serviceWorker = typeof r.serviceWorker === "boolean" ? r.serviceWorker : null;
  rec.pageErrors = listeners ? strs(r.pageErrors, 10, 300) : null;
  rec.consoleErrors = listeners ? strs(r.consoleErrors, 10, 300) : null;
  rec.timing.localDeadline = isObj(r.deadline) ? r.deadline : null;
  rec.budget = isObj(r.budget) ? r.budget : null;
  rec.timing.ownedContextClose = isObj(r.close) ? r.close : null;
}

// cap on the SERIALIZED UTF-8 BYTES of execute-raw.json (not JS string length)
export const RAW_EXECUTE_CAP_BYTES = 200_000;
// the serialized JSON is kept to cap - 1 bytes so the final writer's trailing newline still fits
const RAW_EXECUTE_JSON_MAX_BYTES = RAW_EXECUTE_CAP_BYTES - 1;
const RAW_FIELD_BUDGET: Record<string, number> = { stdout: 50_000, result: 50_000, output: 50_000, error: 16_000, stderr: 16_000 };
// PRIVATE raw execute provenance. Order: PNG base64 elided -> sanitized (secrets, URL userinfo,
// token/session query values, CDP/live-view/session URLs) -> bounded per field with explicit
// truncation metadata -> serialized ONCE. Always valid JSON within RAW_EXECUTE_CAP_BYTES (budgets shrink
// until the serialized UTF-8 byte length fits; the serialized text is never chopped; field text is
// never split inside a surrogate pair). Never parsed for decisions.
export function rawExecuteProvenance(resp: unknown, secrets: readonly string[]): string {
  const prepared: Record<string, { originalChars: number; pngElided: number; text: string }> = {};
  const envelope: Obj = {};
  let otherKeys: string[] = [];
  let type: string | null = null;
  if (!isObj(resp)) type = resp === null ? "null" : typeof resp;
  else {
    for (const k of ["success", "exitCode", "killed", "truncated"]) {
      const v = resp[k];
      if (v === null || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) envelope[k] = v;
      else if (typeof v === "string") envelope[k] = sanitizeString(v, secrets).slice(0, 200);
    }
    for (const k of Object.keys(RAW_FIELD_BUDGET)) {
      const v = resp[k];
      if (typeof v !== "string") continue;
      let pngElided = 0;
      const elided = v.replace(/"(png|img)":"([A-Za-z0-9+/=]{64,})"/g, (_m, k: string, b64: string) => (pngElided++, `"${k}":"<elided ${b64.length} base64 chars>"`));
      prepared[k] = { originalChars: v.length, pngElided, text: sanitizeString(elided, secrets) };
    }
    otherKeys = Object.keys(resp).filter((k) => !(k in RAW_FIELD_BUDGET) && !["success", "exitCode", "killed", "truncated"].includes(k)).slice(0, 20).map((k) => sanitizeString(k, secrets).slice(0, 40));
  }
  for (let scale = 1; ; scale /= 2) {
    const fields: Obj = {};
    for (const [k, f] of Object.entries(prepared)) {
      const budget = Math.floor(RAW_FIELD_BUDGET[k]! * scale);
      const kept = safeSlice(f.text, budget);
      fields[k] = { originalChars: f.originalChars, pngElided: f.pngElided, sanitizedChars: f.text.length, keptChars: kept.length, truncated: kept.length < f.text.length, text: kept };
    }
    const doc = { schema: "website-to-figma/execute-raw", schemaVersion: 1, note: "PRIVATE raw execute provenance: image base64 elided, sanitized (keys, Authorization values, URL userinfo, token/session query values, CDP/live-view/session URLs), bounded per field (keptChars of sanitizedChars); the whole file is within capBytes UTF-8 bytes", capBytes: RAW_EXECUTE_CAP_BYTES, budgetScale: scale, ...(type ? { type } : {}), envelope, fields, otherKeys };
    const text = JSON.stringify(doc, null, 2);
    if (utf8Bytes(text) <= RAW_EXECUTE_JSON_MAX_BYTES) return text;
    if (scale < 1 / 1024) return JSON.stringify({ schema: "website-to-figma/execute-raw", schemaVersion: 1, capBytes: RAW_EXECUTE_CAP_BYTES, error: "provenance did not fit the cap at the minimum budget; fields omitted", envelope, fieldSizes: Object.fromEntries(Object.entries(prepared).map(([k, f]) => [k, f.originalChars])) });
  }
}

// Persistence boundary: every string in the record (reason, errors, warnings, page/console errors,
// nav/swiperReady/measured nested values) is sanitized; geometry and flags are kept.
export function sanitizeRecord(rec: SandboxRecord, secrets: readonly string[] = []): SandboxRecord {
  const truncations: string[] = [];
  const out = sanitizeValue(rec, secrets, undefined, truncations) as SandboxRecord;
  if (truncations.length) out.warnings = [...(out.warnings ?? []), `record sanitization truncated: ${truncations.slice(0, 10).join("; ")}`];
  return out;
}

export async function runSandboxLifecycle(o: SandboxExecuteOptions): Promise<SandboxRecord> {
  const secrets: string[] = [];
  return sanitizeRecord(await lifecycleInner(o, secrets), secrets);
}

async function lifecycleInner(o: SandboxExecuteOptions, secrets: string[]): Promise<SandboxRecord> {
  const now = o.now ?? (() => new Date());
  const resolver = o.resolver ?? systemResolver;
  const gate = assertSandboxGates(o.gates);
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
    timing: { limits: { localDeadlineMs: SANDBOX.localDeadlineMs, closeBoundMs: SANDBOX.closeBoundMs, providerExecuteTimeoutS: SANDBOX.executeTimeoutS, transportExecuteWallMs: SANDBOX_WALL_MS.execute }, localDeadline: null, ownedContextClose: null, providerKilled: null, transportTimedOut: null },
    rawExecute: null,
    budget: null,
    partialImages: null,
    states: [],
    errors: [],
    warnings: [],
  };
  const log = (m: string) => o.log?.(`[sandbox] ${redact500(m, secrets)}`);
  const base: SandboxLedgerOps = { reserveAttempt, recordOp, settleAttempt, settlePendingReconciliation, ...(o.ledger ?? {}) };
  // Every ledger write from this lifecycle passes through the secret-aware sanitizer FIRST (the
  // ledger layer sanitizes again, without the key list, at its own serializer).
  const sz = (t: string) => sanitizeString(t, secrets);
  const L: SandboxLedgerOps = {
    reserveAttempt: base.reserveAttempt,
    recordOp: (path, id, x, n) => base.recordOp(path, id, { ...x, op: sz(x.op), detail: sz(x.detail) }, n),
    settleAttempt: (path, id, st, credits, note) => base.settleAttempt(path, id, st, credits, sz(note)),
    settlePendingReconciliation: (path, id, note) => base.settlePendingReconciliation(path, id, sz(note)),
  };
  const msg = (err: unknown) => redact500(err instanceof Error ? err.message : String(err), secrets);
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
    rec.reason = redact500(`client could not be created: ${err instanceof Error ? err.message : String(err)}`, secrets);
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
      L.recordOp(ledgerPath, entryId, { op: name, status, detail: redact500(detail, secrets) }, now);
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
      L.recordOp(ledgerPath, entryId, { op: name, status, detail: redact500(detail, secrets) }, now);
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
      rec.timing.transportTimedOut = (isObj(err) && err.w2fTimeout === true) || /no response within/.test(err instanceof Error ? err.message : "");
      rec.ops.push({ op: "execute", attempts: 1, status: k, detail: d });
      op("execute", k, d);
      overall = k === "failed" ? "failed" : "ambiguous";
      primary("execute", d);
      return rec;
    }
    rec.timing.transportTimedOut = false;
    rec.timing.providerKilled = isObj(resp) && typeof resp.killed === "boolean" ? resp.killed : null;
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
    if (!parsed.ok && parsed.result) savePartialImages(rec, parsed.result, o.saveImage);
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
      const bytes = parsed.images[i]!;
      const info = inspectImage(bytes)!;
      rec.states.push({ seq: i, name: SANDBOX.states[i]!, provenance: i === 0 ? "baseline" : "page-api", trigger: isObj(s.trigger) ? s.trigger : null, framing: isObj(s.framing) ? s.framing : null, measured: isObj(s.measured) ? s.measured : {}, clip: isObj(s.clip) ? (s.clip as SandboxStateOut["clip"]) : { x: 0, y: 0, width: 0, height: 0 }, image: { mime: "image/jpeg", sha256: sha256Hex(bytes), width: info.width, height: info.height, bytes: bytes.length } });
      o.saveImage?.(i, bytes);
    }
    // honest distinctness: identical PNGs or unmoved Swiper are reported
    const shas = rec.states.map((s) => s.image.sha256);
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

// The ONLY writer of execute-raw.json: JSON + "\n", and the bytes ON DISK never exceed
// RAW_EXECUTE_CAP_BYTES (refused otherwise; nothing is chopped).
export function writeExecuteRawFile(path: string, json: string): void {
  const data = Buffer.from(`${json}\n`, "utf8");
  if (data.length > RAW_EXECUTE_CAP_BYTES) throw new StateRunPolicyError(`execute-raw.json would be ${data.length} bytes (cap ${RAW_EXECUTE_CAP_BYTES}); not written`);
  writeExclusive(path, data);
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
      recordOp(o.ledgerPath, o.entryId, { op: "delete", status, detail: sanitizeString(detail, [key]) }, o.now);
    } catch (err) {
      ledgerErrors.push(`ledger write failed (delete ${status}): ${redact500(err instanceof Error ? err.message : String(err), [key])}`);
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
    detail = redact500(`manual cleanup ${classify(err)}: ${err instanceof Error ? err.message : String(err)}`, [key]);
  }
  rec(ok ? "ok" : detail.startsWith("manual cleanup failed") ? "failed" : "ambiguous", detail);
  return { ok, detail: ledgerErrors.length ? `${detail}; ${ledgerErrors.join("; ")}` : detail };
}

// Offline: sandbox record -> capture + asset manifest for hifi (states of ONE
// region: same scope selector, same section geometry). PNGs are referenced as
// state screenshots positioned at the clip (frame top-left; coordinates shifted so the clip's
// document x is 0, see below). `region` (the section) is kept in the record for validation.
export function sandboxToCapture(rec: SandboxRecord, files: string[]): { capture: Obj; manifest: Obj } {
  if (rec.status !== "accepted" || rec.states.length !== SANDBOX.states.length) throw new StateRunPolicyError(`sandbox status ${rec.status}; only accepted runs with 3 states convert`);
  const st = rec.states.map((s) => {
    const m = s.measured;
    const target = isObj(m.target) ? m.target : {};
    const region = isObj(m.region) ? m.region : {};
    const probe = isObj(m.probe) ? m.probe : {};
    // The screenshot is the slider box. The renderer places a state's reference image at page x 0 and
    // y = screenshotScrollY, so the state is shifted horizontally by the clip's document x and the
    // variant frame is the clip box: image and layers then share one coordinate system.
    const clip = s.clip;
    const docX = clip.x + (typeof probe.scrollX === "number" ? probe.scrollX : 0);
    const docY = clip.y + (typeof probe.scrollY === "number" ? probe.scrollY : 0);
    const shiftX = (list: unknown) => (Array.isArray(list) ? list.map((o) => (isObj(o) && typeof o.x === "number" ? { ...o, x: o.x - docX } : o)) : []);
    const measured = { url: SANDBOX_URL, viewport: { width: probe.innerWidth ?? SANDBOX.viewport.width, height: probe.innerHeight ?? SANDBOX.viewport.height }, documentHeight: probe.documentHeight ?? null, title: "Bootslander (sandbox region)", elements: shiftX(m.elements), texts: shiftX(m.texts), images: shiftX(m.images), svgs: [] };
    return {
      seq: s.seq,
      name: s.name,
      provenance: s.provenance,
      scope: { x: 0, y: docY, w: clip.width, h: clip.height },
      screenshotScrollY: docY,
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
    manifest: { schema: "website-to-figma/asset-manifest", schemaVersion: 1, assets: rec.states.map((s, i) => ({ id: `sandbox-s${i}`, kind: "reference", file: files[i], sha256: s.image.sha256, pageUrl: SANDBOX_URL, state: s.name })) },
  };
}
