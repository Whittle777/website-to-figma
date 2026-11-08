// Browser-side scripts embedded in executeJavascript actions. They are literal
// strings so the exact bytes in a request preview are the bytes under test.
// Every script returns a tagged, bounded object
// (`w2f: "freeze" | "scroll" | "state" | "revert"`).
//
// ALL scripts are SYNCHRONOUS IIFE expressions - the same form as Firecrawl's
// own internal executeJavascript (branding) script,
// `(function name() { ...; return obj; })();` (firecrawl/firecrawl
// apps/api/src/scraper/scrapeURL/engines/fire-engine/brandingScript.ts), whose
// return arrives as actions.javascriptReturns[i] = { type: "object", value }
// (fire-engine/index.ts, transformers/index.ts). Whether the provider awaits a
// returned Promise is NOT documented, so no script is async and no script
// sleeps: every delay is a documented provider `wait` action.
//
// Scope: no script clicks, submits, focuses inputs, navigates, opens windows,
// fetches, or reads storage/cookies. State changes are DECLARATIVE DOM
// mutations from an operator allowlist (attribute set / class add /
// <details open>), labelled SYNTHETIC (not the page's observed original state)
// and reverted after measurement.
// NO HANDLER SIDE-EFFECT GUARANTEE: attribute/class/open changes can still run
// page code (MutationObservers, toggle listeners, custom-element
// attributeChangedCallback, CSS-driven behaviour). Custom elements and
// form/embedding elements are refused, and capture-phase `toggle` listeners
// are stopped at window, but page observers cannot be prevented. These scripts
// are therefore emitted only into NON-EXECUTED request previews for manual
// operator review; this tool has no executor for them.

// Freeze: report what was attempted / applied / unavailable. JS timers,
// requestAnimationFrame loops and WebGL/canvas rendering are NOT frozen.
export const FREEZE_JS = String.raw`(function w2fFreeze() {
  const r = { w2f: "freeze", attempted: [], applied: {}, unavailable: [], modifications: [], notFrozen: ["JS timers", "requestAnimationFrame loops", "WebGL/canvas rendering"] };
  const note = (k, n) => { r.attempted.push(k); if (n === null) r.unavailable.push(k); else r.applied[k] = n; };
  try {
    const s = document.createElement("style");
    s.setAttribute("data-w2f", "freeze");
    s.textContent = "*,*::before,*::after{animation-play-state:paused!important;animation-delay:0s!important;transition:none!important;scroll-behavior:auto!important;caret-color:transparent!important}";
    (document.head || document.documentElement).appendChild(s);
    note("css-animations-transitions", 1);
  } catch (e) { note("css-animations-transitions", null); }
  if (typeof document.getAnimations === "function") {
    let n = 0; for (const a of document.getAnimations().slice(0, 5000)) { try { a.pause(); n++; } catch (e) {} } note("web-animations", n);
  } else note("web-animations", null);
  let v = 0; for (const el of Array.from(document.querySelectorAll("video")).slice(0, 200)) { try { el.pause(); v++; } catch (e) {} } note("video-pause", v);
  let sw = 0; for (const el of Array.from(document.querySelectorAll(".swiper, .swiper-container")).slice(0, 50)) { const a = el.swiper && el.swiper.autoplay; if (a && typeof a.stop === "function") { try { a.stop(); sw++; } catch (e) {} } }
  note("swiper-autoplay-stop", sw); if (sw) r.modifications.push("stopped " + sw + " Swiper autoplay instance(s) via the page's own API");
  if (__FORCE_AOS__) {
    let n = 0; for (const el of Array.from(document.querySelectorAll("[data-aos]")).slice(0, 2000)) { if (!el.classList.contains("aos-animate")) { el.classList.add("aos-animate"); n++; } }
    note("force-aos-visible", n); r.modifications.push("forced .aos-animate on " + n + " element(s) (not the page's original visibility)");
  }
  return r;
})();`;

// One lazy-load scroll step (synchronous). Step k of n scrolls to an evenly
// spread position so the last step reaches the bottom (bounded by maxPx); the
// following provider `wait` action gives lazy content time to load. Reports
// the gap between positions: a gap larger than the viewport means some regions
// were never in view (lazy coverage partial).
export const SCROLL_JS = String.raw`(function w2fScroll() {
  const k = __STEP__, n = __STEPS__, maxPx = __MAX_PX__;
  const vh = window.innerHeight || 800;
  const maxY = Math.max(0, Math.min(maxPx, document.documentElement.scrollHeight - vh));
  const y = Math.round((maxY * k) / n);
  window.scrollTo(0, y);
  const gap = Math.round(maxY / n);
  return { w2f: "scroll", step: k, steps: n, y, scrollHeight: document.documentElement.scrollHeight, viewportHeight: vh, maxGapPx: gap, coverageComplete: gap <= vh, cappedByMaxPx: document.documentElement.scrollHeight - vh > maxPx };
})();`;

// Apply one declarative state (or the baseline), measure the page and the
// state's scope SYNCHRONOUSLY (layout is forced by getBoundingClientRect; CSS
// transitions/animations are already frozen), observe readiness (document
// readyState, font loading status, incomplete images - observation only, no
// waiting), and scroll the scope into view for the following screenshot.
// Page JS that reacts asynchronously to the modification is NOT awaited.
export const STATE_JS = String.raw`(function w2fState() {
  const STATE = __STATE__;
  const MAX = { elements: 20000, texts: 20000, images: 500, svgs: 200, rules: 200, media: 50, fixed: 50, match: 5 };
  const MAX_RETURN_CHARS = __MAX_RETURN_CHARS__;
  const out = { w2f: "state", seq: STATE.seq, name: STATE.name, provenance: STATE.mutations.length > 0 ? "synthetic" : "baseline", applied: [], missing: [], refused: [] };
  const ATTRS = { "open": ["details"], "aria-expanded": null, "aria-selected": null, "aria-hidden": null, "hidden": null, "data-state": null };
  window.__w2fRevert = [];
  const revertNow = () => { let n = 0; const list = window.__w2fRevert || []; window.__w2fRevert = []; for (const op of list.reverse()) { try { if (op[0] === "attr") { if (op[3] === null) op[1].removeAttribute(op[2]); else op[1].setAttribute(op[2], op[3]); } else op[1].classList.remove(op[2]); n++; } catch (e) {} } return n; };
  try {
  if (!window.__w2fToggleGuard) { window.__w2fToggleGuard = true; window.addEventListener("toggle", (e) => e.stopImmediatePropagation(), true); }
  for (const m of STATE.mutations) {
    let nodes = [];
    try { nodes = Array.from(document.querySelectorAll(m.selector)).slice(0, MAX.match); } catch (e) { out.refused.push({ selector: m.selector, reason: "invalid selector" }); continue; }
    if (!nodes.length) { out.missing.push(m.selector); continue; }
    for (const el of nodes) {
      const tag = el.tagName.toLowerCase();
      if (tag.includes("-") || el.hasAttribute("is")) { out.refused.push({ selector: m.selector, reason: "refused custom element <" + tag + ">" }); continue; }
      if (["script", "iframe", "frame", "form", "input", "textarea", "select", "button", "a", "object", "embed", "dialog", "video", "audio", "canvas"].includes(tag)) { out.refused.push({ selector: m.selector, reason: "refused element <" + tag + ">" }); continue; }
      if (m.mechanism === "details-open") {
        if (tag !== "details") { out.refused.push({ selector: m.selector, reason: "not a <details>" }); continue; }
        window.__w2fRevert.push(["attr", el, "open", el.getAttribute("open")]); el.setAttribute("open", "");
      } else if (m.mechanism === "attribute-set") {
        const allowed = ATTRS[m.attribute];
        if (allowed === undefined || (allowed && !allowed.includes(tag))) { out.refused.push({ selector: m.selector, reason: "attribute not allowlisted" }); continue; }
        window.__w2fRevert.push(["attr", el, m.attribute, el.getAttribute(m.attribute)]);
        if (m.value === null) el.removeAttribute(m.attribute); else el.setAttribute(m.attribute, m.value);
      } else if (m.mechanism === "class-add") {
        if (el.classList.contains(m.className)) continue;
        window.__w2fRevert.push(["class", el, m.className]); el.classList.add(m.className);
      } else { out.refused.push({ selector: m.selector, reason: "unknown mechanism" }); continue; }
      out.applied.push({ selector: m.selector, mechanism: m.mechanism });
    }
  }
  const imgsAll = Array.from(document.images).slice(0, 5000);
  const readiness = { readyState: document.readyState, fontsStatus: document.fonts ? document.fonts.status : null, images: imgsAll.length, imagesIncomplete: imgsAll.filter((i) => !i.complete).length, lazyImages: imgsAll.filter((i) => i.loading === "lazy").length };
  const bounds = (e) => { const b = e.getBoundingClientRect(); return { x: b.x + scrollX, y: b.y + scrollY, w: b.width, h: b.height }; };
  const props = ["backgroundColor","color","fontFamily","fontSize","fontWeight","fontStyle","lineHeight","textDecorationLine","borderTopWidth","borderRightWidth","borderBottomWidth","borderLeftWidth","borderTopColor","borderRightColor","borderBottomColor","borderLeftColor","borderRadius","opacity","display","visibility","position","paddingTop","paddingRight","paddingBottom","paddingLeft","objectFit"];
  const styles = (e) => { const c = getComputedStyle(e); const o = {}; for (const k of props) o[k] = c[k]; return o; };
  // Drop ids from any earlier state's measurement so per-state HTML ancestry is not stale.
  for (const e of document.querySelectorAll("[data-w2f-id]")) e.removeAttribute("data-w2f-id");
  const elements = [], images = [], svgs = [], fixed = [];
  let n = 0;
  for (const e of document.querySelectorAll("body, body *")) {
    if (elements.length >= MAX.elements) break;
    if (e.closest("svg") || ["SCRIPT","STYLE","NOSCRIPT","LINK","META","TEMPLATE"].includes(e.tagName)) continue;
    const b = bounds(e), s = styles(e); if (!b.w || !b.h || s.display === "none" || s.visibility === "hidden") continue;
    const id = "e" + n++; e.setAttribute("data-w2f-id", id);
    const item = { id, tag: e.tagName.toLowerCase(), ...b, style: s, header: !!e.closest("body > header"), footer: !!e.closest("body > footer") };
    if (["INPUT","TEXTAREA","SELECT","BUTTON"].includes(e.tagName)) item.control = { type: e.type || e.tagName.toLowerCase(), value: e.type === "password" ? "" : String(e.value || "").slice(0, 200), placeholder: String(e.placeholder || "").slice(0, 200), checked: !!e.checked, selected: e.tagName === "SELECT" && e.selectedOptions[0] ? e.selectedOptions[0].textContent.slice(0, 200) : null };
    if (e.tagName === "IMG" && images.length < MAX.images) images.push({ ...item, src: e.currentSrc || e.src, alt: e.alt });
    if ((s.position === "fixed" || s.position === "sticky") && fixed.length < MAX.fixed) fixed.push({ id, tag: item.tag, position: s.position, ...b });
    elements.push(item);
  }
  for (const e of Array.from(document.querySelectorAll("svg")).slice(0, MAX.svgs)) { const b = bounds(e); if (b.w && b.h && e.outerHTML.length <= 32000) svgs.push({ ...b, html: e.outerHTML, color: getComputedStyle(e).color }); }
  const texts = []; const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let t;
  const seg = typeof Intl !== "undefined" && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
  while ((t = walker.nextNode()) && texts.length < MAX.texts) {
    const p = t.parentElement; if (!p || p.closest("script,style,noscript,svg,textarea,select,option")) continue;
    const s = styles(p); if (s.visibility === "hidden" || s.display === "none") continue;
    const str = t.textContent; if (!str.trim()) continue;
    const parts = seg ? Array.from(seg.segment(str), (x) => [x.index, x.segment]) : Array.from(str).reduce((a, ch) => { const i = a.length ? a[a.length - 1][0] + a[a.length - 1][1].length : 0; a.push([i, ch]); return a; }, []);
    let last = null; const runs = [];
    for (const [i, g] of parts) { const r = document.createRange(); r.setStart(t, i); r.setEnd(t, i + g.length); const b = r.getBoundingClientRect(); if (!b.width || !b.height) continue; const x = b.x + scrollX, y = b.y + scrollY;
      if (last && Math.abs(last.y - y) < 1 && Math.abs(last.x + last.w - x) < 3) { last.text += g; last.w = x + b.width - last.x; last.h = Math.max(last.h, b.height); } else { last = { text: g, x, y, w: b.width, h: b.height }; runs.push(last); } }
    for (const r of runs) if (r.text.trim() && texts.length < MAX.texts) texts.push({ ...r, style: s, tag: p.tagName.toLowerCase(), parent: p.getAttribute("data-w2f-id"), code: !!p.closest("code,pre,kbd,samp") });
  }
  const motion = { rules: [], inaccessibleSheets: 0 };
  for (const sheet of Array.from(document.styleSheets).slice(0, 100)) {
    let rules; try { rules = sheet.cssRules; } catch (e) { motion.inaccessibleSheets++; continue; }
    for (const rule of Array.from(rules || []).slice(0, 5000)) {
      if (motion.rules.length >= MAX.rules || !rule.selectorText || !rule.style) continue;
      const tr = rule.style.transition || rule.style.transitionProperty, an = rule.style.animation || rule.style.animationName;
      if (tr) motion.rules.push({ selector: rule.selectorText.slice(0, 200), kind: "transition", detail: String(tr).slice(0, 200) });
      if (an) motion.rules.push({ selector: rule.selectorText.slice(0, 200), kind: "animation", detail: String(an).slice(0, 200) });
      if (/:hover/.test(rule.selectorText)) motion.rules.push({ selector: rule.selectorText.slice(0, 200), kind: "hover", detail: rule.style.cssText.slice(0, 200) });
    }
  }
  const media = [];
  const mediaOf = (sel, kind, extra) => { for (const e of Array.from(document.querySelectorAll(sel)).slice(0, MAX.media)) { const b = bounds(e); if (b.w && b.h && media.length < MAX.media) media.push({ kind, ...b, ...extra(e) }); } };
  mediaOf("video", "video", (e) => ({ poster: e.poster || null, src: (e.currentSrc || e.src || "").slice(0, 2048) || null }));
  mediaOf("canvas", "canvas", (e) => { let webgl = false; try { webgl = !!(e.getContext && (e.getContext("webgl2") || e.getContext("webgl"))); } catch (x) {} return { webgl }; });
  mediaOf("lottie-player, dotlottie-player, [data-animation-path]", "lottie", () => ({}));
  mediaOf("iframe", "iframe", (e) => ({ src: String(e.src || "").slice(0, 2048) || null }));
  let scope = null, shotY = 0;
  if (STATE.scope) { const s = document.querySelector(STATE.scope); if (s) { scope = bounds(s); window.scrollTo(0, Math.max(0, scope.y - 40)); shotY = window.scrollY || 0; } else out.missing.push(STATE.scope); }
  if (!scope) { window.scrollTo(0, 0); shotY = window.scrollY || 0; }
  const result = { ...out, readiness, scope, screenshotScrollY: shotY, viewport: { width: innerWidth, height: innerHeight }, measured: { url: location.href, viewport: { width: innerWidth, height: innerHeight }, title: document.title, elements, texts, images, svgs }, fixed, motion, media, truncated: false };
  // Byte bound: drop measurement tails (largest first) until the return fits.
  for (const k of ["texts", "elements", "svgs", "images"]) {
    while (JSON.stringify(result).length > MAX_RETURN_CHARS && result.measured[k].length) { result.measured[k].length = Math.floor(result.measured[k].length / 2); result.truncated = true; }
  }
  if (JSON.stringify(result).length > MAX_RETURN_CHARS) return { ...out, error: "return exceeds byte bound", reverted: revertNow() };
  return result;
  } catch (e) {
    // Apply/measure failed: revert immediately so later steps see the baseline.
    return { ...out, error: String(e && e.message || e).slice(0, 200), reverted: revertNow() };
  }
})();`;

// Undo the previous state's mutations (in reverse order).
export const REVERT_JS = String.raw`(function w2fRevert() {
  const list = window.__w2fRevert || []; let n = 0, failed = 0;
  try {
    for (const op of list.reverse()) { try { if (op[0] === "attr") { if (op[3] === null) op[1].removeAttribute(op[2]); else op[1].setAttribute(op[2], op[3]); } else if (op[0] === "class") op[1].classList.remove(op[2]); n++; } catch (e) { failed++; } }
  } finally { window.__w2fRevert = []; try { window.scrollTo(0, 0); } catch (e) {} }
  return { w2f: "revert", seq: __SEQ__, reverted: n, failed };
})();`;
