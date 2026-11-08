// Offline planner + browser-script tests. Scripts are evaluated in jsdom
// (synthetic markup only); nothing is fetched or sent.
import { JSDOM, VirtualConsole } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildStatePreview, buildStateRequest, parseStatePlan, STATE_LIMITS, StatePlanError, type StatePlan } from "../src/states/plan";
import { FREEZE_JS, REVERT_JS, SCROLL_JS, STATE_JS } from "../src/states/scripts";

const SITE = "https://example.com";
const basePlan = (extra: Record<string, unknown> = {}, pageExtra: Record<string, unknown> = {}) => ({
  schema: "website-to-figma/state-plan",
  schemaVersion: 1,
  site: SITE,
  ...extra,
  pages: [
    {
      url: `${SITE}/`,
      states: [
        { name: "FAQ open", scope: "#faq", mutations: [{ mechanism: "details-open", selector: "#faq details" }] },
        { name: "Tab two", mutations: [{ mechanism: "attribute-set", selector: "#tab2", attribute: "aria-selected", value: "true" }, { mechanism: "class-add", selector: "#panel2", className: "is-active" }] },
      ],
      manual: [] as unknown[],
      ...pageExtra,
    },
  ],
});

const fill = (s: string, v: Record<string, unknown>) => s.replace(/__([A-Z_]+)__/g, (_m, k: string) => JSON.stringify(v[k]));

function dom(html: string) {
  const d = new JSDOM(`<!doctype html><html><head></head><body>${html}</body></html>`, { runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: new VirtualConsole(), url: "https://example.com/" });
  const w = d.window as unknown as Record<string, any>;
  // jsdom has no layout: give every element and range a fixed non-zero box.
  const rect = () => ({ x: 10, y: 20, width: 30, height: 40, top: 20, left: 10, right: 40, bottom: 60 });
  w.Element.prototype.getBoundingClientRect = rect;
  // ranges: one 8px-wide glyph per offset on a single line, so runs rejoin
  w.Range.prototype.getBoundingClientRect = function (this: { startOffset: number }) {
    const x = 10 + this.startOffset * 8;
    return { x, y: 20, width: 8, height: 16, top: 20, left: x, right: x + 8, bottom: 36 };
  };
  w.scrollTo = () => {};
  return { d, w, run: (script: string) => w.eval(script) as unknown };
}

const stateScript = (state: Record<string, unknown>, maxChars: number = STATE_LIMITS.maxStateReturnChars) => fill(STATE_JS, { STATE: { seq: 1, scope: null, ...state }, MAX_RETURN_CHARS: maxChars });

afterEach(() => vi.restoreAllMocks());

describe("state plan validation (offline)", () => {
  it("accepts declarative mechanisms and adds the implicit baseline", () => {
    const p = parseStatePlan(basePlan());
    expect(p.pages[0]!.states.map((s) => s.name)).toEqual(["Default", "FAQ open", "Tab two"]);
    expect(p.maxActions).toBe(20);
    expect(p.maxCombinedWaitMs).toBe(30_000);
    expect(p.forceAos).toBe(false);
    expect(p.pages[0]!.states[0]!.scope).toBe("#faq");
  });

  it("counts manual states toward the 3-state total", () => {
    expect(() => parseStatePlan(basePlan({}, { manual: [{ name: "M1", selector: "#a", reason: "r" }, { name: "M2", selector: "#b", reason: "r" }] }))).toThrow(/exceed 3 total/);
  });

  it("refuses clicks and other unprovable interactions, pointing to the manual route", () => {
    for (const mech of ["click", "hover", "focus", "write", "press", "submit", "navigate", "executeJavascript"]) {
      const plan = basePlan({}, { states: [{ name: "X", mutations: [{ mechanism: mech, selector: "#a" }] }] });
      expect(() => parseStatePlan(plan)).toThrow(StatePlanError);
      expect(() => parseStatePlan(plan)).toThrow(/manual/);
    }
  });

  it("enforces <=3 states per page including baseline, <=3 pages, one site", () => {
    const three = [1, 2, 3].map((i) => ({ name: `S${i}`, mutations: [{ mechanism: "details-open", selector: "details" }] }));
    expect(() => parseStatePlan(basePlan({}, { states: three }))).toThrow(/baseline/);
    const pages = [0, 1, 2, 3].map((i) => ({ url: `${SITE}/p${i}` }));
    expect(() => parseStatePlan({ ...basePlan(), pages })).toThrow(/1\.\.3 pages/);
    expect(() => parseStatePlan({ ...basePlan(), pages: [{ url: "https://other.example.org/" }] })).toThrow(/single site/);
    expect(() => parseStatePlan({ ...basePlan(), pages: [{ url: `${SITE}/` }, { url: `${SITE}/` }] })).toThrow(/repeats/);
    expect(() => parseStatePlan({ ...basePlan(), pages: [{ url: "http://127.0.0.1/" }], site: "http://127.0.0.1" })).toThrow(/rejected/);
  });

  it("rejects non-allowlisted attributes, bad class names, unknown keys and over-budget settings", () => {
    const bad = (m: Record<string, unknown>) => basePlan({}, { states: [{ name: "X", mutations: [m] }] });
    expect(() => parseStatePlan(bad({ mechanism: "attribute-set", selector: "a", attribute: "onclick", value: "x" }))).toThrow(/attribute/);
    expect(() => parseStatePlan(bad({ mechanism: "attribute-set", selector: "a", attribute: "href", value: "x" }))).toThrow(/attribute/);
    expect(() => parseStatePlan(bad({ mechanism: "class-add", selector: "a", className: "a b" }))).toThrow(/className/);
    expect(() => parseStatePlan(bad({ mechanism: "details-open", selector: "a", extra: 1 }))).toThrow(/unknown key/);
    expect(() => parseStatePlan(bad({ mechanism: "details-open", selector: "a " }))).toThrow(/control/);
    expect(() => parseStatePlan(basePlan({ maxActions: 51 }))).toThrow(/maxActions/);
    expect(() => parseStatePlan(basePlan({ maxCombinedWaitMs: 60_001 }))).toThrow(/maxCombinedWaitMs/);
    expect(() => parseStatePlan(basePlan({}, { waitMs: 10_001 }))).toThrow(/waitMs/);
  });
});

describe("request previews (nothing sent)", () => {
  it("builds exact, bounded previews and never calls fetch", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const doc = buildStatePreview(parseStatePlan(basePlan()));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(doc.sent).toBe(false);
    expect(doc.executor).toBe("states-run (separate, gated)");
    expect(doc.notice.join(" ")).toMatch(/NOT SENT.*never retries/);
    expect(doc.notice.join(" ")).toMatch(/cost .* UNKNOWN/i);
    const r = doc.requests[0]!;
    // wait, freeze, 3 x (sync scroll + provider wait), then per state: state+screenshot+scrape (+revert)
    expect(r.roles.map((x) => x.role)).toEqual(["wait", "freeze", "scroll", "wait", "scroll", "wait", "scroll", "wait", "state", "screenshot", "scrape", "state", "screenshot", "scrape", "revert", "state", "screenshot", "scrape", "revert"]);
    expect(r.actionCount).toBe(19);
    expect(r.actionCount).toBeLessThanOrEqual(STATE_LIMITS.providerMaxActions);
    // exactly the provider's accounting: sum of wait.milliseconds; no in-script sleep
    const waitSum = r.body.actions.filter((a) => a.type === "wait").reduce((n, a) => n + (a.milliseconds as number), 0);
    expect(r.combinedWaitMs).toBe(2000 + 500 + 500 + 1500);
    expect(waitSum).toBe(r.combinedWaitMs);
    expect(r.body.actions.filter((a) => a.type === "wait").every((a) => Number.isInteger(a.milliseconds) && (a.milliseconds as number) >= 1)).toBe(true);
    expect(r.timing).toEqual({ requestTimeoutMs: 20_000 + 2 * 4500 + 3 * 10_000, sdkHttpTimeoutMs: 64_000, wallClockMs: 89_000, combinedWaitMs: 4500, inScriptSleepMs: 0 });
    expect(r.body.timeout).toBe(59_000);
    expect(r.combinedWaitMs * 2).toBeLessThanOrEqual(r.body.timeout);
    // minimal body: rawHtml only, basic proxy; NO vendor/account safety option is sent
    expect(r.body.formats).toEqual(["rawHtml"]);
    expect(Object.keys(r.body).sort()).toEqual(["actions", "formats", "onlyMainContent", "proxy", "timeout", "url"]);
    for (const k of ["checkPromptInjection", "redactPII", "lockdown", "threatProtection", "blockAds", "removeBase64Images", "parsers", "mobile", "waitFor"]) expect(k in r.body).toBe(false);
    expect(r.states.map((s) => [s.name, s.provenance, s.screenshotIndex])).toEqual([["Default", "baseline", 0], ["FAQ open", "synthetic", 1], ["Tab two", "synthetic", 2]]);
    expect(r.states[1]!.review).toMatch(/no handler side-effect guarantee/);
    expect(r.body.actions.every((a) => ["wait", "executeJavascript", "screenshot", "scrape"].includes(a.type as string))).toBe(true);
    for (const a of r.body.actions) {
      if (a.type !== "executeJavascript") continue;
      const script = a.script as string;
      expect(script).not.toMatch(/__[A-Z_]+__/);
      // synchronous IIFE expression, same form as the provider's own branding script
      expect(script).toMatch(/^\(function w2f[A-Za-z]+\(\) \{[\s\S]*\}\)\(\);$/);
      expect(script).not.toMatch(/\basync\b|\bawait\b|setTimeout|setInterval|Promise/);
      expect(script).not.toMatch(/\.click\(|\.submit\(|fetch\(|XMLHttpRequest|location\s*=|window\.open|localStorage|document\.cookie/);
      expect(() => new Function(`return ${script}`)).not.toThrow();
    }
    expect(doc.manualRoute).toEqual([]);
    const withManual = buildStatePreview(parseStatePlan(basePlan({}, { states: [], manual: [{ name: "Menu open", selector: "#burger", reason: "JS click handler" }] })));
    expect(withManual.manualRoute[0]).toMatch(/Menu open.*capture manually/);
  });

  it("refuses requests over the action or combined-wait budget", () => {
    const plan: StatePlan = parseStatePlan(basePlan({ maxActions: 10 }));
    expect(() => buildStateRequest(plan, plan.pages[0]!)).toThrow(/19 actions exceed/);
    const slow = parseStatePlan(basePlan({ maxCombinedWaitMs: 5_000 }, { waitMs: 4_000 }));
    expect(() => buildStateRequest(slow, slow.pages[0]!)).toThrow(/combined waits/);
  });
});

describe("browser scripts in jsdom (synthetic markup)", () => {
  it("freeze reports attempted/applied/unavailable and records AOS forcing only when asked", () => {
    const { w, run } = dom('<div class="swiper"></div><div data-aos="fade"></div><video></video>');
    let stopped = 0;
    (w.document.querySelector(".swiper") as any).swiper = { autoplay: { stop: () => stopped++ } };
    w.HTMLMediaElement.prototype.pause = () => {};
    const r = run(fill(FREEZE_JS, { FORCE_AOS: false })) as any;
    expect(r.w2f).toBe("freeze");
    expect(r.attempted).toContain("css-animations-transitions");
    expect(r.notFrozen).toEqual(["JS timers", "requestAnimationFrame loops", "WebGL/canvas rendering"]);
    expect(stopped).toBe(1);
    expect(r.modifications.join()).toMatch(/Swiper/);
    expect(r.modifications.join()).not.toMatch(/aos/);
    expect(w.document.querySelector("[data-aos]").classList.contains("aos-animate")).toBe(false);
    const forced = run(fill(FREEZE_JS, { FORCE_AOS: true })) as any;
    expect(forced.applied["force-aos-visible"]).toBe(1);
    expect(forced.modifications.join()).toMatch(/forced \.aos-animate on 1 element/);
  });

  it("applies declarative synthetic mutations, labels provenance, and reverts exactly", async () => {
    const { w, run } = dom('<section id="faq"><details><summary>Q</summary><p>A</p></details></section><div id="tab2" aria-selected="false">T</div><div id="panel2" class="panel">P</div>');
    let toggles = 0;
    w.document.querySelector("details").addEventListener("toggle", () => toggles++);
    const r = (await run(stateScript({ name: "Mixed", scope: "#faq", mutations: [{ mechanism: "details-open", selector: "#faq details" }, { mechanism: "attribute-set", selector: "#tab2", attribute: "aria-selected", value: "true" }, { mechanism: "class-add", selector: "#panel2", className: "is-active" }] }))) as any;
    expect(r.provenance).toBe("synthetic");
    expect(r.seq).toBe(1);
    expect(r.applied).toHaveLength(3);
    expect(r.refused).toEqual([]);
    expect(r.scope).toEqual({ x: 10, y: 20, w: 30, h: 40 });
    expect(r.measured.elements.length).toBeGreaterThan(0);
    expect(w.document.querySelector("details").hasAttribute("open")).toBe(true);
    expect(w.document.querySelector("#tab2").getAttribute("aria-selected")).toBe("true");
    await new Promise((res) => setTimeout(res, 10));
    expect(toggles).toBe(0); // page toggle listener not reached (capture-phase stop)
    const rv = run(fill(REVERT_JS, { SEQ: 1 })) as any;
    expect(rv).toEqual({ w2f: "revert", seq: 1, reverted: 3, failed: 0 });
    expect(w.document.querySelector("details").hasAttribute("open")).toBe(false);
    expect(w.document.querySelector("#tab2").getAttribute("aria-selected")).toBe("false");
    expect(w.document.querySelector("#panel2").className).toBe("panel");
  });

  it("clears stale measurement ids from an earlier state", async () => {
    const { w, run } = dom('<p id="a">A</p><p id="b">B</p>');
    await run(stateScript({ name: "Default", mutations: [] }));
    expect(w.document.getElementById("b").getAttribute("data-w2f-id")).not.toBeNull();
    w.document.getElementById("b").style.display = "none";
    await run(stateScript({ name: "Default", mutations: [] }));
    expect(w.document.getElementById("b").hasAttribute("data-w2f-id")).toBe(false);
  });

  it("baseline is labelled baseline, not synthetic", async () => {
    const { run } = dom("<p>Hello</p>");
    const r = (await run(stateScript({ name: "Default", mutations: [] }))) as any;
    expect(r.provenance).toBe("baseline");
    expect(r.measured.texts.map((t: any) => t.text)).toContain("Hello");
  });

  it("refuses custom elements, customized built-ins, form/link/embedding elements and invalid selectors", async () => {
    const { w, run } = dom('<x-menu id="cm"></x-menu><div is="fancy-div" id="isdiv"></div><button id="b"></button><form id="f"></form><a id="l" href="/x">x</a><iframe id="i"></iframe>');
    const muts = ["#cm", "#isdiv", "#b", "#f", "#l", "#i"].map((selector) => ({ mechanism: "class-add", selector, className: "open" }));
    const r = (await run(stateScript({ name: "Bad", mutations: [...muts, { mechanism: "class-add", selector: "[[", className: "open" }] }))) as any;
    expect(r.applied).toEqual([]);
    expect(r.refused.map((x: any) => x.reason)).toEqual([
      "refused custom element <x-menu>",
      "refused custom element <div>",
      "refused element <button>",
      "refused element <form>",
      "refused element <a>",
      "refused element <iframe>",
      "invalid selector",
    ]);
    for (const id of ["cm", "isdiv", "b", "f", "l", "i"]) expect(w.document.getElementById(id).classList.contains("open")).toBe(false);
  });

  it("refuses non-allowlisted attributes at runtime too (defence in depth)", async () => {
    const { w, run } = dom('<div id="d"></div><span id="s"></span>');
    const r = (await run(stateScript({ name: "X", mutations: [{ mechanism: "attribute-set", selector: "#d", attribute: "onclick", value: "x" }, { mechanism: "attribute-set", selector: "#s", attribute: "open", value: "" }] }))) as any;
    expect(r.applied).toEqual([]);
    expect(r.refused).toHaveLength(2);
    expect(w.document.getElementById("d").hasAttribute("onclick")).toBe(false);
  });

  it("reverts immediately when measurement throws", async () => {
    const { w, run } = dom("<details id=d><summary>s</summary></details>");
    w.getComputedStyle = () => {
      throw new Error("boom");
    };
    const r = (await run(stateScript({ name: "X", mutations: [{ mechanism: "details-open", selector: "#d" }] }))) as any;
    expect(r.error).toBe("boom");
    expect(r.reverted).toBe(1);
    expect(w.document.getElementById("d").hasAttribute("open")).toBe(false);
    expect((run(fill(REVERT_JS, { SEQ: 1 })) as any).reverted).toBe(0);
  });

  it("bounds the per-state return size", async () => {
    const { run } = dom(Array.from({ length: 400 }, (_, i) => `<p>Paragraph number ${i}</p>`).join(""));
    const full = (await run(stateScript({ name: "Default", mutations: [] }))) as any;
    const cap = 40_000;
    expect(JSON.stringify(full).length).toBeGreaterThan(cap);
    const r = (await run(stateScript({ name: "Default", mutations: [] }, cap))) as any;
    expect(r.truncated).toBe(true);
    expect(JSON.stringify(r).length).toBeLessThanOrEqual(cap);
    const tiny = (await run(stateScript({ name: "Default", mutations: [] }, 100))) as any;
    expect(tiny.error).toMatch(/byte bound/);
  });

  it("reports motion rules, inaccessible stylesheets and media honestly", async () => {
    const { w, run } = dom('<style>.btn{transition:opacity .2s}.btn:hover{opacity:.5}@keyframes k{from{opacity:0}}.spin{animation:k 1s}</style><video poster="https://example.com/p.png"></video><canvas></canvas><iframe src="https://example.com/embed"></iframe>');
    const real = w.document.styleSheets;
    Object.defineProperty(w.document, "styleSheets", { get: () => [...Array.from(real), { get cssRules() { throw new w.DOMException("cross-origin", "SecurityError"); } }] });
    const r = (await run(stateScript({ name: "Default", mutations: [] }))) as any;
    expect(r.motion.inaccessibleSheets).toBe(1);
    expect(r.motion.rules.map((x: any) => x.kind).sort()).toEqual(["animation", "hover", "transition"]);
    expect(r.media.map((m: any) => m.kind)).toEqual(["video", "canvas", "iframe"]);
    expect(r.media[0].poster).toBe("https://example.com/p.png");
    expect(r.media[1].webgl).toBe(false);
  });

  it("scroll steps are synchronous, evenly spread to the bottom, and report coverage", () => {
    const { w, run } = dom("<div></div>");
    Object.defineProperty(w.document.documentElement, "scrollHeight", { get: () => 4000 });
    w.innerHeight = 800;
    let y = -1;
    w.scrollTo = (_x: number, yy: number) => (y = yy);
    const steps = [1, 2, 3].map((k) => run(fill(SCROLL_JS, { STEP: k, STEPS: 3, MAX_PX: 20_000 })) as any);
    expect(steps.map((r) => r.y)).toEqual([1067, 2133, 3200]);
    expect(y).toBe(3200);
    expect(steps[2]).toMatchObject({ w2f: "scroll", step: 3, steps: 3, maxGapPx: 1067, coverageComplete: false, cappedByMaxPx: false });
    const capped = run(fill(SCROLL_JS, { STEP: 1, STEPS: 1, MAX_PX: 1000 })) as any;
    expect(capped).toMatchObject({ y: 1000, cappedByMaxPx: true });
  });

  it("state measurement is synchronous and records readiness without waiting", () => {
    const { w, run } = dom('<img src="https://example.com/never.png"><p>Hi</p>');
    Object.defineProperty(w.HTMLImageElement.prototype, "complete", { get: () => false });
    const r = run(stateScript({ name: "Default", mutations: [] })) as any;
    expect(r).not.toBeInstanceOf(w.Promise);
    expect(r.w2f).toBe("state");
    expect(r.readiness).toMatchObject({ images: 1, imagesIncomplete: 1 });
  });

});
