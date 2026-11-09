// Browser Sandbox experiment: fixed preview, the fixed page code run against a
// FAKE Playwright page (jsdom), lifecycle with fake clients and the REAL SDK
// over loopback. No provider, key, account or Figma calls.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JSDOM, VirtualConsole } from "jsdom";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { copyObserved, rawExecuteProvenance, RAW_EXECUTE_CAP_BYTES, sanitizeRecord, SANDBOX_WALL_MS } from "../src/states/sandbox";
import { initLedger as lInit, recordManual, reserveAttempt, recordOp as lRecordOp, settleAttempt as lSettle, settlePendingReconciliation as lPending, serializeLedger } from "../src/states/ledger";
import { readFileSync } from "node:fs";
import { sanitizeString } from "../src/states/sanitize";
import { redact as legacyRedact } from "../src/states/execute";
import { buildSandboxPreview, createSandboxClient, executeSandbox, runSandboxLifecycle, SandboxHardHold, SANDBOX_UNSUPPORTED, parseSandboxOutput, sandboxPreviewSha256, sandboxToCapture, validateSandboxPreview, cleanupSandbox, SANDBOX, SANDBOX_CODE, SANDBOX_URL, SANDBOX_WORST_CASE_CREDITS, type SandboxClient } from "../src/states/sandbox";
import { StateRunPolicyError } from "../src/states/execute";
import { createInteractClient } from "../src/states/sandboxTransport";
import { initLedger, readLedger, resolveEntry, unresolved, recordOp as realRecordOp, settleAttempt as realSettleAttempt, settlePendingReconciliation as realSettlePending } from "../src/states/ledger";
import { hostedDnsExemptHostnames } from "../src/security/urlGuard";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { syntheticPng } from "../src/fixtures/hifiSynthetic";
import { captureFromScrapeResponses } from "../src/hifi/adapter";
import { convertCapture } from "../src/hifi/convert";
import { validateHifiDoc } from "../src/shared/hifiSchema";

const KEY = "fc-SANDBOXTESTKEY00000";
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "w2f-sbx-"));
  dirs.push(d);
  return d;
};
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const fakeIp = (asked: string[] = []) => async (h: string) => (asked.push(h), ["198.18.0.9"]);
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

// ---------------- fake Playwright page over jsdom ----------------
// Fake UPSTREAM servers (url -> response). Routing follows Playwright's documented semantics:
// route.continue() lets the browser follow redirects WITHOUT calling the route handler again for the
// hops ("the handler will only be called for the first url if the response is a redirect"), while
// route.fetch({ maxRedirects }) follows at most maxRedirects hops and returns the last response.
// `network` records every request that actually reached an upstream server.
const UPSTREAM: Record<string, { status: number; location?: string }> = {
  "https://bootstrapmade.com/content/vendors/redirector.js": { status: 302, location: "https://evil.example/payload.js" },
  "https://bootstrapmade.com/content/vendors/moved.js": { status: 301, location: "/content/vendors/moved-here.js" },
};
function fakePage(o: { redirect?: boolean; ignoreViewport?: boolean; noSwiper?: boolean; main3xx?: boolean; serviceWorker?: boolean; popup?: boolean; noBrowser?: boolean; newContextThrows?: boolean; noRouteWebSocket?: boolean; subresources?: string[]; swiperBindAfterMs?: number; pageError?: string; hangAt?: "goto" | "screenshot"; closeHangs?: boolean } = {}) {
  const calls: string[] = [];
  const html = `<!doctype html><html><body><section id="hero">Hero</section><section id="testimonials"><div class="swiper init-swiper"><div class="swiper-wrapper"><div class="swiper-slide"><h3 id="slide">Slide 0</h3></div></div></div></section></body></html>`;
  const d = new JSDOM(html, { runScripts: "outside-only", virtualConsole: new VirtualConsole(), url: SANDBOX_URL });
  const w = d.window as any;
  let vw = 1920;
  let vh = 100_000;
  let scrollY = 0;
  Object.defineProperty(w, "innerWidth", { get: () => vw });
  Object.defineProperty(w, "innerHeight", { get: () => vh });
  Object.defineProperty(w, "scrollY", { get: () => scrollY });
  Object.defineProperty(w, "scrollX", { get: () => 0 });
  Object.defineProperty(w.document.documentElement, "scrollHeight", { get: () => 6000 });
  // document geometry: #testimonials at y 4000 (h 500); everything inside it is laid out in that band
  const docRect = (el: any) => (el.id === "hero" ? { x: 0, y: 0, w: 1920, h: 800 } : el.closest?.("#testimonials") ? { x: el.id === "testimonials" ? 0 : 300, y: el.id === "testimonials" ? 4000 : 4100, w: el.id === "testimonials" ? 1920 : 600, h: el.id === "testimonials" ? 500 : 40 } : { x: 0, y: 0, w: 1920, h: 6000 });
  const toView = (r: { x: number; y: number; w: number; h: number }) => ({ x: r.x, y: r.y - scrollY, left: r.x, top: r.y - scrollY, width: r.w, height: r.h, right: r.x + r.w, bottom: r.y - scrollY + r.h });
  w.Element.prototype.getBoundingClientRect = function () {
    return toView(docRect(this));
  };
  w.Element.prototype.scrollIntoView = function () {
    scrollY = docRect(this).y;
  };
  w.Range.prototype.getBoundingClientRect = function (this: any) {
    const base = docRect(this.startContainer.parentElement);
    const x = base.x + this.startOffset * 8;
    return toView({ x, y: base.y, w: 8, h: 16 });
  };
  const el = w.document.querySelector(".swiper");
  let idx = 0;
  const sw: any = o.noSwiper ? null : { el, activeIndex: 0, realIndex: 0, destroyed: false, enabled: true, autoplay: { running: true, stop() { this.running = false; calls.push("autoplay.stop"); } }, slideNext(speed: number) { calls.push(`slideNext:${speed}`); idx++; this.activeIndex = idx; this.realIndex = idx; w.document.getElementById("slide").textContent = `Slide ${idx}`; } };
  // the page's own init binds el.swiper immediately, after a delay (async init), or never (noSwiper)
  const bindAt = o.swiperBindAfterMs ?? 0;
  if (sw && bindAt === 0) el.swiper = sw;
  const pageEvents: Record<string, (x: any) => void> = {};
  if (o.serviceWorker) w.navigator.serviceWorker = { controller: {} };
  let routeHandler: ((r: any) => Promise<unknown> | unknown) | null = null;
  let pageHandler: ((p: any) => void) | null = null;
  const guard: string[] = [];
  const network: string[] = []; // every request actually made upstream by route.fetch
  const mainFrame = {};
  const req = (url: string, nav: boolean, main = true) => ({ url: () => url, isNavigationRequest: () => nav, frame: () => (nav && main ? mainFrame : {}) });
  const upstream = (url: string) => (o.main3xx && url === SANDBOX_URL ? { status: 301, location: "https://elsewhere.example/" } : (UPSTREAM[url] ?? { status: 200 }));
  // one upstream exchange per hop; follows at most `max` redirects (Infinity = browser behavior)
  const follow = (url: string, max: number) => {
    let u = url;
    let r = (network.push(u), upstream(u));
    for (let hops = 0; r.status >= 300 && r.status < 400 && r.location && hops < max; hops++) {
      u = new URL(r.location, u).href;
      r = (network.push(u), upstream(u));
    }
    return { u, r };
  };
  const route = async (url: string, nav: boolean, main = true) => {
    let outcome = "none";
    await routeHandler!({
      request: () => req(url, nav, main),
      abort: () => (guard.push(`abort ${url}`), (outcome = "abort")),
      // the browser makes the request itself and follows redirects; hops are NOT re-routed
      continue: () => (guard.push(`continue ${url}`), url.startsWith("data:") || url.startsWith("blob:") || follow(url, Infinity), (outcome = "continue")),
      fetch: async (opts: { maxRedirects: number; maxRetries: number }) => {
        calls.push(`route.fetch:${url}:maxRedirects=${opts.maxRedirects}:maxRetries=${opts.maxRetries}`);
        const { u, r } = follow(url, opts.maxRedirects);
        return { status: () => r.status, url: () => u, headers: () => (r.location ? { location: r.location } : {}) };
      },
      fulfill: (f: { response: { status: () => number } }) => (guard.push(`fulfill ${url} ${f.response.status()}`), (outcome = "fulfill")),
    });
    return outcome;
  };
  let wsHandler: ((ws: any) => void) | null = null;
  // the OWNED context (created by browser.newContext) and its single page
  const ownedContext: any = {
    route: async (_p: string, h: (r: any) => unknown) => {
      calls.push("context.route");
      routeHandler = h;
    },
    on: (ev: string, h: (p: any) => void) => {
      if (ev === "page") pageHandler = h;
    },
    newPage: async () => {
      calls.push("newPage");
      return page;
    },
    close: async () => {
      calls.push("context.close");
      if (o.closeHangs) await new Promise(() => {});
    },
  };
  if (!o.noRouteWebSocket)
    ownedContext.routeWebSocket = async (_p: RegExp, h: (ws: any) => void) => {
      calls.push("context.routeWebSocket");
      wsHandler = h;
    };
  const browser = {
    newContext: async (opts: { serviceWorkers: string; viewport: { width: number; height: number } }) => {
      calls.push(`newContext:${JSON.stringify(opts)}`);
      if (o.newContextThrows) throw new Error("newContext not permitted");
      if (!o.ignoreViewport) {
        vw = opts.viewport.width;
        vh = opts.viewport.height;
      }
      return ownedContext;
    },
  };
  // the preconnected DEFAULT page: only used to reach the Browser; must never navigate
  const defaultPage = {
    context: () => ({ browser: () => (o.noBrowser ? null : browser) }),
    goto: async () => calls.push("DEFAULT-PAGE-NAVIGATED"),
  };
  const page = {
    setViewportSize: async (v: { width: number; height: number }) => {
      calls.push(`viewport:${v.width}x${v.height}`);
      if (!o.ignoreViewport) {
        vw = v.width;
        vh = v.height;
      }
    },
    goto: async (url: string) => {
      calls.push(`goto:${url}`);
      if (o.hangAt === "goto") await new Promise(() => {});
      if ((await route(url, true)) === "abort") throw new Error("net::ERR_FAILED (main document aborted by route)");
      if (o.pageError) pageEvents.pageerror?.(new Error(o.pageError));
      if (o.subresources) {
        for (const sub of o.subresources) await route(sub, false);
        return { status: () => 200, request: () => ({ url: () => url, redirectedFrom: () => null }) };
      }
      if (o.popup) pageHandler?.({ close: async () => calls.push("popup.close") });
      await route("https://bootstrapmade.com/popup", true, false); // a popup/frame navigation
      // synthetic subresources and attempts the guard must refuse
      await route("https://bootstrapmade.com/content/vendors/aos/aos.js", false);
      await route("https://fonts.googleapis.com/css?family=Synthetic", false); // third-party: denied
      await route("https://www.bootstrapmade.com/x.js", false); // subdomain: denied (exact host only)
      await route("https://bootstrapmade.com./x.js", false); // trailing dot: denied
      await route("data:image/png;base64,AAAA", false); // data: allowed
      await route("http://169.254.169.254/latest/meta-data", false);
      await route("http://localhost:8080/x", false);
      await route("https://evil.example/", true);
      await route("https://bootstrapmade.com/content/demo/Bootslander", true); // missing slash: raw string differs
      await route("https://BOOTSTRAPMADE.com/content/demo/Bootslander/", true); // case variant: raw string differs
      await route("file:///etc/passwd", false);
      await route("https://bootstrapmade.com:8443/asset.js", false); // non-default port: denied
      await route("https://bootstrapmade.com/content/vendors/redirector.js", false); // allowed first hop, 302 cross-host
      wsHandler?.({ url: () => "wss://bootstrapmade.com/live", close: () => calls.push("ws.close") });
      const first = { url: () => "https://bootstrapmade.com/old", redirectedFrom: () => null };
      const final = { url: () => url, redirectedFrom: () => (o.redirect ? first : null) };
      return { status: () => 200, request: () => final };
    },
    url: () => SANDBOX_URL,
    mainFrame: () => mainFrame,
    on: (ev: string, h: (x: any) => void) => {
      pageEvents[ev] = h;
    },
    // like Playwright: the predicate SOURCE is evaluated in the page, polled until truthy or timeout
    // (virtual clock); timeout error text as Playwright reports it
    waitForFunction: async (fn: (a: unknown) => unknown, arg: unknown, opts: { timeout: number; polling: number }) => {
      calls.push(`waitForFunction:timeout=${opts.timeout}:polling=${opts.polling}`);
      for (let t = 0; t <= opts.timeout; t += opts.polling) {
        if (sw && bindAt > 0 && t >= bindAt) el.swiper = sw;
        if (w.eval(`(${fn.toString()})`)(JSON.parse(JSON.stringify(arg ?? null)))) return { t };
      }
      throw new Error(`page.waitForFunction: Timeout ${opts.timeout}ms exceeded.`);
    },
    waitForTimeout: async () => {},
    // like Playwright: only the function SOURCE crosses into the page (no closure/outer helpers)
    evaluate: async (fn: (a: unknown) => unknown, arg: unknown) => w.eval(`(${fn.toString()})`)(JSON.parse(JSON.stringify(arg ?? null))),
    screenshot: async (s: { clip: { width: number; height: number } }) => {
      calls.push(`screenshot:${s.clip.width}x${Math.round(s.clip.height)}`);
      if (o.hangAt === "screenshot") await new Promise(() => {});
      return Buffer.from(syntheticPng(s.clip.width, Math.max(1, Math.round(s.clip.height)), [idx * 40, 30, 60], [200, 200, 200]));
    },
  };
  return { page: defaultPage, calls, guard, network };
}
async function runCode(p: ReturnType<typeof fakePage>) {
  const lines: string[] = [];
  await new AsyncFunction("page", "console", SANDBOX_CODE)(p.page, { log: (s: string) => lines.push(s) });
  return { success: true, stdout: lines.join("\n"), exitCode: 0, killed: false, truncated: false };
}

describe("fixed sandbox preview", () => {
  it("creates with ttl/activityTtl only (no profile/location/blockAds override), node code, viewport before navigation", () => {
    const p = buildSandboxPreview();
    expect(p.create).toEqual({ ttl: 120, activityTtl: 60 });
    expect(p.sources[0]).toMatch(/^https:\/\/docs\.firecrawl\.dev\/features\/browser/);
    expect(p.execute).toMatchObject({ language: "node", timeout: 90 });
    expect(p.reservation.worstCaseCredits).toBe(SANDBOX_WORST_CASE_CREDITS);
    expect(SANDBOX_WORST_CASE_CREDITS).toBe(4);
    const code = p.execute.code;
    expect(code).toContain(`browser.newContext({ serviceWorkers: "block", viewport: { width: W.vw, height: W.vh } })`);
    expect(code.indexOf("browser.newContext")).toBeLessThan(code.indexOf("ctx.route"));
    expect(code.indexOf("ctx.route")).toBeLessThan(code.indexOf("ctx.newPage"));
    expect(code.indexOf("ctx.newPage")).toBeLessThan(code.indexOf("own.goto"));
    expect(code).toContain("ctx.close()");
    expect(code).toContain("route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: tmo(W.navTimeoutMs) })");
    expect(code.indexOf("route.fetch(")).toBeLessThan(code.indexOf("route.fulfill("));
    for (const gone of ["page.request", "accept-redirect-gap", "launch(", "page.goto", "page.setViewportSize", "persistent", "storageState"]) expect(code).not.toContain(gone);
    expect(code.indexOf("own.setViewportSize")).toBeLessThan(code.indexOf("own.goto"));
    expect(code.indexOf("ctx.newPage")).toBeLessThan(code.indexOf("own.setViewportSize"));
    expect(code).toContain('"host":"bootstrapmade.com"');
    expect(p.hardHold).toEqual([]);
    expect(SANDBOX_UNSUPPORTED).toEqual([]);
    expect(code).toContain(JSON.stringify(SANDBOX_URL));
    for (const banned of ["realViewport", "profile", ".click(", ".fill(", "keyboard", "own.type(", "page.type(", "prompt", "addInitScript", "exposeFunction", "require(", "process.", "connectOverCDP"]) expect(code).not.toContain(banned);
    // the only fetch capability is route.fetch of the exact main document; exactly one owned context and page
    expect(code.match(/fetch\(/g)).toHaveLength(1);
    expect(code.match(/newContext\(/g)).toHaveLength(1);
    expect(code.match(/newPage\(/g)).toHaveLength(1);
    expect(sandboxPreviewSha256()).toMatch(/^[0-9a-f]{64}$/);
  });
  it("accepts only the exact preview", () => {
    const bad = (mut: (q: any) => void) => {
      const q = clone(buildSandboxPreview()) as any;
      mut(q);
      return () => validateSandboxPreview(q);
    };
    expect(bad((q) => (q.create.profile = { name: "x" }))).toThrow(StateRunPolicyError);
    expect(bad((q) => (q.create.ttl = 3600))).toThrow(/does not match/);
    expect(bad((q) => (q.execute.code += "\nawait page.click('a');"))).toThrow(/does not match/);
    expect(bad((q) => (q.execute.language = "bash"))).toThrow(/does not match/);
  });
});

describe("the fixed page code against a fake Playwright page", () => {
  it("route guard, viewport BEFORE goto, 3 same-region states with clipped PNGs and Swiper provenance", async () => {
    const p = fakePage();
    const raw = await runCode(p);
    const parsed = parseSandboxOutput(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(p.calls.slice(0, 7)).toEqual([`newContext:{"serviceWorkers":"block","viewport":{"width":1920,"height":1080}}`, "context.route", "context.routeWebSocket", "newPage", "viewport:1920x1080", `goto:${SANDBOX_URL}`, `route.fetch:${SANDBOX_URL}:maxRedirects=0:maxRetries=0`]);
    expect(p.calls.at(-1)).toBe("context.close");
    expect(p.calls).not.toContain("DEFAULT-PAGE-NAVIGATED");
    // every upstream request: exactly once each, all on the exact host, never a redirect target
    expect(p.network).toEqual([SANDBOX_URL, "https://bootstrapmade.com/content/vendors/aos/aos.js", "https://bootstrapmade.com/content/vendors/redirector.js"]);
    expect(p.calls).toContain("ws.close");
    expect(p.calls).toContain("autoplay.stop");
    expect(p.calls.filter((c) => c.startsWith("slideNext"))).toEqual(["slideNext:0", "slideNext:0"]);
    expect(p.guard).toEqual([
      `fulfill ${SANDBOX_URL} 200`,
      "abort https://bootstrapmade.com/popup",
      "fulfill https://bootstrapmade.com/content/vendors/aos/aos.js 200",
      "abort https://fonts.googleapis.com/css?family=Synthetic",
      "abort https://www.bootstrapmade.com/x.js",
      "abort https://bootstrapmade.com./x.js",
      "continue data:image/png;base64,AAAA",
      "abort http://169.254.169.254/latest/meta-data",
      "abort http://localhost:8080/x",
      "abort https://evil.example/",
      "abort https://bootstrapmade.com/content/demo/Bootslander",
      "abort https://BOOTSTRAPMADE.com/content/demo/Bootslander/",
      "abort file:///etc/passwd",
      "abort https://bootstrapmade.com:8443/asset.js",
      "abort https://bootstrapmade.com/content/vendors/redirector.js",
    ]);
    const r = parsed.result as any;
    expect(r.env).toMatchObject({ innerWidth: 1920, innerHeight: 1080 });
    expect(r.blocked.map((b: any) => b.why)).toEqual(["navigation-not-exact-target", "third-party-host", "third-party-host", "third-party-host", "ip-literal", "non-default-port", "navigation-not-exact-target", "navigation-not-exact-target", "navigation-not-exact-target", "scheme", "non-default-port", "redirect-302", "websocket"]);
    expect(r.blocked.find((b: any) => b.why === "redirect-302")).toEqual({ origin: "https://bootstrapmade.com", why: "redirect-302", location: "https://evil.example", locationPolicy: "third-party-host" });
    expect(r.incomplete).toBe(true);
    expect(r.mainFetch).toEqual({ status: 200, url: SANDBOX_URL });
    expect(r).toMatchObject({ ownedContext: { serviceWorkers: "block", viewport: { width: 1920, height: 1080 } }, ownedContextClosed: true });
    expect(r.modifications[0]).toMatch(/stopped autoplay of #testimonials \.swiper\.init-swiper via its own Swiper API/);
    expect(r.states.map((s: any) => [s.seq, s.name, s.measured.target.selector, s.measured.region.y])).toEqual([[0, "Default", "#testimonials", 4000], [1, "Testimonial next", "#testimonials", 4000], [2, "Testimonial next 2", "#testimonials", 4000]]);
    expect(r.states.map((s: any) => s.measured.texts.find((t: any) => t.text.startsWith("Slide")).text)).toEqual(["Slide 0", "Slide 1", "Slide 2"]);
    expect(r.states[1].trigger).toMatchObject({ valid: true, moved: true, before: { realIndex: 0 }, after: { realIndex: 1 } });
    expect(r.states[0].measured.probe).toMatchObject({ scrollY: 4000, innerHeight: 1080 });
    expect(parsed.pngs).toHaveLength(3);
  });
  it("refuses a redirect chain, an unapplied viewport, and a missing Swiper (fail closed, still emits a result)", async () => {
    for (const [o, re] of [
      [{ redirect: true }, /navigation left the exact target URL/],
      [{ main3xx: true }, /main document aborted by route/],
      [{ serviceWorker: true }, /a service worker controls the page/],
      [{ noBrowser: true }, /Browser object unavailable/],
      [{ newContextThrows: true }, /newContext not permitted/],
      [{ ignoreViewport: true }, /viewport not applied: 1920x100000/],
      [{ noSwiper: true }, /at stage swiper-ready: swiper not bound within 8000 ms/],
      [{ noRouteWebSocket: true }, /context.routeWebSocket unavailable/],
    ] as const) {
      const parsed = parseSandboxOutput(await runCode(fakePage(o)));
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.reason).toMatch(re);
    }
  });
  it("an allowed first hop that 302s to another host is aborted unserved: the Location target is NEVER requested", async () => {
    const p = fakePage({ subresources: ["https://bootstrapmade.com/content/vendors/redirector.js", "https://bootstrapmade.com/content/vendors/moved.js"] });
    const parsed = parseSandboxOutput(await runCode(p));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(p.network).toEqual([SANDBOX_URL, "https://bootstrapmade.com/content/vendors/redirector.js", "https://bootstrapmade.com/content/vendors/moved.js"]);
    expect(p.network.some((u) => u.includes("evil.example") || u.includes("moved-here"))).toBe(false);
    expect(p.guard).toEqual([`fulfill ${SANDBOX_URL} 200`, "abort https://bootstrapmade.com/content/vendors/redirector.js", "abort https://bootstrapmade.com/content/vendors/moved.js"]);
    const r = parsed.result as any;
    // the Location is reviewed against the full policy and reported; even an allowed same-host Location is not followed
    expect(r.blocked).toEqual([
      { origin: "https://bootstrapmade.com", why: "redirect-302", location: "https://evil.example", locationPolicy: "third-party-host" },
      { origin: "https://bootstrapmade.com", why: "redirect-301", location: "https://bootstrapmade.com", locationPolicy: "allowed-but-not-followed" },
    ]);
    expect(r.incomplete).toBe(true);
    expect(p.calls.filter((c) => c.startsWith("route.fetch"))).toEqual([SANDBOX_URL, "https://bootstrapmade.com/content/vendors/redirector.js", "https://bootstrapmade.com/content/vendors/moved.js"].map((u) => `route.fetch:${u}:maxRedirects=0:maxRetries=0`));
  });
  it("mutation check: the same fake DOES leak the cross-host hop if allowed assets used route.continue() (the original defect)", async () => {
    const at = SANDBOX_CODE.indexOf("    let resp = null;");
    expect(at).toBeGreaterThan(0);
    const mutant = SANDBOX_CODE.slice(0, at) + "    if (!main) return route.continue();\n" + SANDBOX_CODE.slice(at);
    const p = fakePage({ subresources: ["https://bootstrapmade.com/content/vendors/redirector.js"] });
    const lines: string[] = [];
    await new AsyncFunction("page", "console", mutant)(p.page, { log: (x: string) => lines.push(x) });
    expect(p.network).toContain("https://evil.example/payload.js");
  });
  it("non-default ports, credentials and IP literals are aborted for subresources (no request made); default ports are allowed", async () => {
    const subs = ["https://bootstrapmade.com:8443/asset.js", "https://bootstrapmade.com:80/a.js", "http://bootstrapmade.com:443/a.js", "https://u:p@bootstrapmade.com/a.js", "https://[::1]/a.js", "https://127.0.0.1/a.js", "https://2130706433/a.js", "https://bootstrapmade.com:443/ok.js", "http://bootstrapmade.com:80/ok2.js"];
    const p = fakePage({ subresources: subs });
    const parsed = parseSandboxOutput(await runCode(p));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect((parsed.result as any).blocked.map((b: any) => b.why)).toEqual(["non-default-port", "non-default-port", "non-default-port", "credentials", "ip-literal", "ip-literal", "ip-literal"]);
    // only the two default-port URLs reached upstream (the raw URL as requested)
    expect(p.network).toEqual([SANDBOX_URL, "https://bootstrapmade.com:443/ok.js", "http://bootstrapmade.com:80/ok2.js"]);
    expect(p.network.some((u) => /8443|127\.0\.0\.1|::1|u:p@/.test(u))).toBe(false);
  });
  it("a redirect hop to a non-default port is reviewed and never requested", async () => {
    UPSTREAM["https://bootstrapmade.com/content/porthop.js"] = { status: 307, location: "https://bootstrapmade.com:8443/x.js" };
    const p = fakePage({ subresources: ["https://bootstrapmade.com/content/porthop.js"] });
    const parsed = parseSandboxOutput(await runCode(p));
    expect(parsed.ok && (parsed.result as any).blocked).toEqual([{ origin: "https://bootstrapmade.com", why: "redirect-307", location: "https://bootstrapmade.com:8443", locationPolicy: "non-default-port" }]);
    expect(p.network).toEqual([SANDBOX_URL, "https://bootstrapmade.com/content/porthop.js"]);
  });
  it("a main-document 3xx is aborted BEFORE fulfil: the redirect target is never requested", async () => {
    const p = fakePage({ main3xx: true });
    const res = parseSandboxOutput(await runCode(p));
    expect(res.ok).toBe(false);
    expect(p.network).toEqual([SANDBOX_URL]);
    expect(p.guard).toEqual([`abort ${SANDBOX_URL}`]);
    expect(p.calls.some((c) => c.includes("elsewhere"))).toBe(false);
  });
  it("the owned context is closed in finally even when a step fails", async () => {
    for (const o of [{ main3xx: true }, { noSwiper: true }, { ignoreViewport: true }]) {
      const p = fakePage(o);
      const r = parseSandboxOutput(await runCode(p));
      expect(r.ok).toBe(false);
      expect(p.calls.at(-1)).toBe("context.close");
    }
    const nb = fakePage({ noBrowser: true });
    await runCode(nb);
    expect(nb.calls.filter((c) => c.startsWith("newContext") || c === "context.close")).toEqual([]);
  });
  it("popups are closed", async () => {
    const p = fakePage({ popup: true });
    const raw = await runCode(p);
    expect(p.calls).toContain("popup.close");
    const parsed = parseSandboxOutput(raw);
    expect(parsed.ok && (parsed.result as any).popupsClosed).toBe(1);
  });

  it("bounds output and PNGs before decoding", async () => {
    const good = await runCode(fakePage());
    expect(parseSandboxOutput({ ...good, truncated: true })).toMatchObject({ ok: false, status: "ambiguous" });
    expect(parseSandboxOutput({ ...good, killed: true })).toMatchObject({ ok: false, status: "ambiguous" });
    expect(parseSandboxOutput({ ...good, stdout: good.stdout.slice(0, 500) })).toMatchObject({ ok: false, status: "ambiguous" });
    expect(parseSandboxOutput({ ...good, stdout: "W2F_RESULT " + "x".repeat(SANDBOX.maxOutputChars) })).toMatchObject({ ok: false, status: "rejected" });
    const r = JSON.parse(good.stdout.slice(good.stdout.indexOf("W2F_RESULT ") + 11));
    const big = clone(r);
    big.states[0].png = "A".repeat(Math.ceil(SANDBOX.maxPngBytes / 3) * 4 + 4);
    expect(parseSandboxOutput({ ...good, stdout: "W2F_RESULT " + JSON.stringify(big) })).toMatchObject({ ok: false, reason: expect.stringMatching(/over 1500000 bytes/) });
    const notPng = clone(r);
    notPng.states[0].png = Buffer.from("GIF89a-not-a-png!!!").toString("base64");
    expect(parseSandboxOutput({ ...good, stdout: "W2F_RESULT " + JSON.stringify(notPng) })).toMatchObject({ ok: false });
    const moved = clone(r);
    moved.states[2].measured.region.y += 5000;
    expect(parseSandboxOutput({ ...good, stdout: "W2F_RESULT " + JSON.stringify(moved) })).toMatchObject({ ok: false, reason: expect.stringMatching(/different region geometry/) });
    const badClip = clone(r);
    badClip.states[1].clip.y += 50;
    expect(parseSandboxOutput({ ...good, stdout: "W2F_RESULT " + JSON.stringify(badClip) })).toMatchObject({ ok: false, reason: expect.stringMatching(/clip is not the measured target/) });
    const tooTall = clone(r);
    tooTall.states[0].png = Buffer.from(syntheticPng(1920, 1200, [0, 0, 0], [1, 1, 1])).toString("base64");
    expect(parseSandboxOutput({ ...good, stdout: "W2F_RESULT " + JSON.stringify(tooTall) })).toMatchObject({ ok: false, reason: expect.stringMatching(/outside the pixel caps/) });
  });
});

// ---------------- lifecycle with fake clients ----------------
function setup() {
  const d = tmp();
  const ledgerPath = join(d, "ledger.json");
  initLedger(ledgerPath, 17, "origin-attributed prior project spend");
  return { d, ledgerPath, validated: validateSandboxPreview(clone(buildSandboxPreview())), gates: { operatorCreditsPerRequest: 4, projectRemainingCredits: 983, confirmExistingCredits: true, confirmNoTopup: true, ledgerPath } };
}
const goodExecute = async () => runCode(fakePage());
function client(events: string[], ledgerPath: string, o: { create?: unknown; execute?: unknown; del?: unknown } = {}): SandboxClient {
  const lastOp = () => {
    const e = readLedger(ledgerPath).entries.at(-1)!;
    return `${e.status}/${e.ops?.at(-1)?.op}:${e.ops?.at(-1)?.status}`;
  };
  const res = async (v: unknown, dflt: () => unknown) => {
    const x = v === undefined ? await dflt() : typeof v === "function" ? await (v as () => unknown)() : v;
    if (x instanceof Error) throw x;
    return x;
  };
  return {
    async browser(a) {
      events.push(`create ${JSON.stringify(a)} [${lastOp()}]`);
      return res(o.create, () => ({ success: true, id: "sess_1", expiresAt: "2026-11-08T23:59:00Z" }));
    },
    async browserExecute(id, a) {
      events.push(`execute ${id} ${String((a as any).language)} [${lastOp()}]`);
      return res(o.execute, goodExecute);
    },
    async deleteBrowser(id) {
      events.push(`delete ${id} [${lastOp()}]`);
      return res(o.del, () => ({ success: true, status: "destroyed", sessionDurationMs: 21000, creditsBilled: 1 }));
    },
  };
}

describe("execution entry point", () => {
  it("no unsupported condition remains: executeSandbox runs the gated lifecycle (fake client)", async () => {
    const s = setup();
    const rec = await executeSandbox({ ...s, resolver: fakeIp(), getApiKey: () => KEY, createClient: async () => client([], s.ledgerPath) });
    expect(rec.status).toBe("accepted");
    expect(rec.ownedContextClosed).toBe(true);
    void SandboxHardHold;
  });
});

describe("lifecycle (fake client): ledger before each op, one attempt each, delete always", () => {
  it("guard -> key -> client -> ledger -> create -> execute -> delete; accepted, creditsBilled recorded", async () => {
    const s = setup();
    const events: string[] = [];
    const asked: string[] = [];
    const pngs: number[] = [];
    const rec = await runSandboxLifecycle({ ...s, resolver: fakeIp(asked), getApiKey: () => (events.push("key"), KEY), createClient: async () => (events.push("client"), client(events, s.ledgerPath)), savePng: (i) => pngs.push(i) });
    expect(events).toEqual(["key", "client", `create {"ttl":120,"activityTtl":60} [attempting/create:attempting]`, "execute sess_1 node [attempting/execute:attempting]", "delete sess_1 [attempting/delete:attempting]"]);
    expect(asked).toEqual([]); // exact bootstrapmade.com hosted exception: no local DNS
    expect(rec).toMatchObject({ status: "accepted", sessionId: "sess_1", creditsBilled: 1, chargeStatus: "pending_reconciliation", incomplete: true });
    expect(rec.ops.map((o) => `${o.op}:${o.status}:${o.attempts}`)).toEqual(["create:ok:1", "execute:ok:1", "delete:ok:1"]);
    expect(pngs).toEqual([0, 1, 2]);
    const e = readLedger(s.ledgerPath).entries.at(-1)!;
    // undocumented creditsBilled is NOT the trusted charge: reservation stays counted, pending reconciliation
    expect(e).toMatchObject({ status: "succeeded", reserved: 4, reportedCredits: null, chargeStatus: "pending_reconciliation", command: "sandbox-run" });
    expect(e.note).toMatch(/response creditsBilled 1 \(undocumented, informational\).*PENDING RECONCILIATION against GET \/v2\/team\/credit-usage/);
    expect(rec.warnings.join()).toMatch(/ledger resolve --id /);
    expect(e.ops!.map((o) => `${o.op}:${o.status}`)).toEqual(["create:attempting", "create:ok", "execute:attempting", "execute:ok", "delete:attempting", "delete:ok"]);
    expect(JSON.stringify(rec)).not.toContain(KEY);
  });

  it("ambiguous create: no execute, no delete, no re-create; entry blocks", async () => {
    const s = setup();
    const events: string[] = [];
    const rec = await runSandboxLifecycle({ ...s, resolver: fakeIp(), getApiKey: () => KEY, createClient: async () => client(events, s.ledgerPath, { create: Object.assign(new Error(`upstream 502 ${KEY}`), { status: 502 }) }) });
    expect(events.map((x) => x.split(" ")[0])).toEqual(["create"]);
    expect(rec).toMatchObject({ status: "ambiguous", sessionId: null });
    expect(rec.reason).toMatch(/no automatic re-create/);
    expect(JSON.stringify(rec)).not.toContain(KEY);
    await expect(runSandboxLifecycle({ ...s, resolver: fakeIp(), getApiKey: () => KEY, createClient: async () => client([], s.ledgerPath) })).rejects.toThrow(/unresolved/);
  });

  it("execute error/killed/truncated: delete still runs once; outcome never retried", async () => {
    for (const ex of [Object.assign(new Error("gateway"), { status: 502 }), Object.assign(new Error("timeout"), { status: 408 }), { success: true, stdout: "", killed: true }, { success: true, stdout: "W2F_RESULT {", truncated: true }]) {
      const s = setup();
      const events: string[] = [];
      const rec = await runSandboxLifecycle({ ...s, resolver: fakeIp(), getApiKey: () => KEY, createClient: async () => client(events, s.ledgerPath, { execute: ex }) });
      expect(events.map((x) => x.split(" ")[0])).toEqual(["create", "execute", "delete"]);
      expect(rec.status).toBe("ambiguous");
      expect(readLedger(s.ledgerPath).entries.at(-1)!.status).toBe("ambiguous");
    }
  });

  it("failed cleanup: ambiguous and blocking; sandbox-cleanup sends exactly one DELETE for the recorded session", async () => {
    const s = setup();
    const events: string[] = [];
    const rec = await runSandboxLifecycle({ ...s, resolver: fakeIp(), getApiKey: () => KEY, createClient: async () => client(events, s.ledgerPath, { del: Object.assign(new Error("boom"), { status: 500 }) }) });
    expect(rec.status).toBe("ambiguous");
    expect(rec.warnings.join()).toMatch(/cleanup NOT confirmed for session sess_1/);
    const entry = readLedger(s.ledgerPath).entries.at(-1)!;
    expect(entry.status).toBe("ambiguous");
    const ev2: string[] = [];
    const r = await cleanupSandbox({ ledgerPath: s.ledgerPath, entryId: entry.id, getApiKey: () => KEY, createClient: async () => client(ev2, s.ledgerPath) });
    expect(r.ok).toBe(true);
    expect(ev2.map((x) => x.split(" ").slice(0, 2).join(" "))).toEqual(["delete sess_1"]);
    await expect(cleanupSandbox({ ledgerPath: s.ledgerPath, entryId: entry.id, getApiKey: () => KEY, createClient: async () => client([], s.ledgerPath) })).rejects.toThrow(/already confirmed/);
  });

  it("pending reconciliation blocks new paid runs (no auto re-run) until reconciled from a documented source; absent creditsBilled is never 0", async () => {
    const s = setup();
    const rec = await runSandboxLifecycle({ ...s, resolver: fakeIp(), getApiKey: () => KEY, createClient: async () => client([], s.ledgerPath, { del: { success: true } }) });
    expect(rec).toMatchObject({ status: "accepted", creditsBilled: null, chargeStatus: "pending_reconciliation" });
    const e = readLedger(s.ledgerPath).entries.at(-1)!;
    expect(e).toMatchObject({ reportedCredits: null, chargeStatus: "pending_reconciliation" });
    expect(e.note).toMatch(/response creditsBilled absent/);
    expect(unresolved(readLedger(s.ledgerPath)).map((x) => x.id)).toEqual([e.id]);
    await expect(runSandboxLifecycle({ ...s, resolver: fakeIp(), getApiKey: () => KEY, createClient: async () => client([], s.ledgerPath) })).rejects.toThrow(/unresolved/);
    expect(() => resolveEntry(s.ledgerPath, e.id, null, "guess")).toThrow(/pending reconciliation: pass the actual --credits N/);
    resolveEntry(s.ledgerPath, e.id, 2, "GET /v2/team/credit-usage remainingCredits delta");
    const r2 = readLedger(s.ledgerPath).entries.at(-1)!;
    expect(r2).toMatchObject({ chargeStatus: "reconciled", resolvedCredits: 2 });
    expect(unresolved(readLedger(s.ledgerPath))).toEqual([]);
    const t = setup();
    const ev: string[] = [];
    for (const g of [{ confirmExistingCredits: false }, { operatorCreditsPerRequest: 3 }, { confirmNoTopup: false }, { projectRemainingCredits: undefined }]) {
      await expect(runSandboxLifecycle({ ...t, gates: { ...t.gates, ...g }, getApiKey: () => (ev.push("key"), KEY) })).rejects.toThrow(StateRunPolicyError);
    }
    expect(ev).toEqual([]);
  });
});

// ---------------- narrow documented transport over loopback ----------------
describe("cleanup is never skipped once a session id is known (ledger faults injected around the REAL ledger)", () => {
  // wraps the real recordOp/settle functions and throws only at the chosen stage
  const faulty = (stage: string) => {
    const boom = () => {
      throw new Error(`EIO synthetic ledger fault at ${stage}`);
    };
    return {
      recordOp: ((path: string, id: string, x: { op: string; status: string; detail: string }, now?: () => Date) => (`${x.op}-${x.status}` === stage ? boom() : realRecordOp(path, id, x as any, now))) as typeof realRecordOp,
      settleAttempt: ((...a: Parameters<typeof realSettleAttempt>) => (stage === "settle" ? boom() : realSettleAttempt(...a))) as typeof realSettleAttempt,
      settlePendingReconciliation: ((...a: Parameters<typeof realSettlePending>) => (stage === "settle" ? boom() : realSettlePending(...a))) as typeof realSettlePending,
    };
  };
  for (const [stage, executed, status] of [
    ["create-ok", false, "ambiguous"],
    ["execute-attempting", false, "ambiguous"],
    ["execute-ok", true, "ambiguous"],
    ["delete-attempting", true, "ambiguous"],
    ["delete-ok", true, "ambiguous"],
    ["settle", true, "ambiguous"],
  ] as const) {
    it(`ledger throws at ${stage}: exactly ONE DELETE, primary + ledger errors kept, entry stays blocking`, async () => {
      const s = setup();
      const events: string[] = [];
      const rec = await runSandboxLifecycle({ ...s, resolver: fakeIp(), getApiKey: () => KEY, createClient: async () => client(events, s.ledgerPath), ledger: faulty(stage) });
      expect(events.filter((e) => e.startsWith("create"))).toHaveLength(1);
      expect(events.filter((e) => e.startsWith("execute"))).toHaveLength(executed ? 1 : 0);
      expect(events.filter((e) => e.startsWith("delete"))).toEqual([expect.stringMatching(/^delete sess_1 /)]);
      expect(rec.status).toBe(status);
      expect(rec.errors.some((e) => e.kind === "ledger" && e.detail.includes(`EIO synthetic ledger fault at ${stage}`))).toBe(true);
      if (stage === "create-ok" || stage === "execute-attempting") expect(rec.errors.find((e) => e.kind === "primary")!.detail).toMatch(/unexpected error after create: EIO synthetic ledger fault/);
      expect(rec.ops.filter((x) => x.op === "delete").map((x) => x.status)).toEqual(["ok"]);
      // durable: the entry is never left looking settled; it blocks new paid runs
      const e = readLedger(s.ledgerPath).entries.at(-1)!;
      expect(["attempting", "ambiguous"]).toContain(e.status);
      expect(e.chargeStatus).toBeUndefined();
      expect(unresolved(readLedger(s.ledgerPath)).map((x) => x.id)).toEqual([e.id]);
    });
  }
  it("ledger throws at create-attempting: NOTHING is sent (no create, no delete)", async () => {
    const s = setup();
    const events: string[] = [];
    const rec = await runSandboxLifecycle({ ...s, resolver: fakeIp(), getApiKey: () => KEY, createClient: async () => client(events, s.ledgerPath), ledger: faulty("create-attempting") });
    expect(events).toEqual([]);
    expect(rec).toMatchObject({ status: "not-attempted", sessionId: null });
    expect(rec.reason).toMatch(/nothing was sent/);
  });
  it("execute and delete BOTH fail: primary and cleanup errors are both preserved; no re-create", async () => {
    const s = setup();
    const events: string[] = [];
    const rec = await runSandboxLifecycle({ ...s, resolver: fakeIp(), getApiKey: () => KEY, createClient: async () => client(events, s.ledgerPath, { execute: new Error("socket hang up"), del: new Error("ECONNRESET") }) });
    expect(events.map((e) => e.split(" ")[0])).toEqual(["create", "execute", "delete"]);
    expect(rec.errors.map((e) => `${e.kind}:${e.stage}`)).toEqual(["primary:execute", "cleanup:delete"]);
    expect(rec.errors[0]!.detail).toMatch(/socket hang up/);
    expect(rec.errors[1]!.detail).toMatch(/ECONNRESET/);
    expect(rec.status).toBe("ambiguous");
  });
  it("manual sandbox-cleanup: a ledger fault before the DELETE never skips it (one DELETE)", async () => {
    const s = setup();
    const rec = await runSandboxLifecycle({ ...s, resolver: fakeIp(), getApiKey: () => KEY, createClient: async () => client([], s.ledgerPath, { del: { success: false } }) });
    const events: string[] = [];
    const { chmodSync } = await import("node:fs");
    const dir = join(s.ledgerPath, "..");
    chmodSync(dir, 0o500); // REAL filesystem fault: ledger writes fail
    try {
      const r = await cleanupSandbox({ ledgerPath: s.ledgerPath, entryId: rec.ledgerEntryId!, getApiKey: () => KEY, createClient: async () => client(events, s.ledgerPath) });
      expect(events.filter((e) => e.startsWith("delete"))).toHaveLength(1);
      expect(r.ok).toBe(true);
      expect(r.detail).toMatch(/ledger write failed \(delete attempting\)/);
    } finally {
      chmodSync(dir, 0o700);
    }
  });
});

describe("documented /v2/interact transport over loopback: one fetch per lifecycle operation", () => {
  let server: Server;
  let base = "";
  const seen: { line: string; auth?: string; body: string }[] = [];
  let mode: Record<string, number | "hang" | "redirect" | "huge" | "nonsuccess-id" | "5xx-id"> = {};
  beforeAll(async () => {
    server = createServer((req, res) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", async () => {
        const op = req.method === "DELETE" ? "delete" : req.url!.endsWith("/execute") ? "execute" : "create";
        seen.push({ line: `${req.method} ${req.url}`, auth: req.headers.authorization, body: b });
        const m = mode[op];
        if (m === "hang") return;
        if (m === "redirect") {
          res.writeHead(302, { location: "http://127.0.0.1:1/elsewhere" });
          return res.end();
        }
        if (m === "nonsuccess-id" || m === "5xx-id") {
          res.writeHead(m === "5xx-id" ? 502 : 200, { "content-type": "application/json" });
          return res.end(JSON.stringify({ success: false, id: "sess_lb", error: "partial" }));
        }
        if (m === "huge") {
          res.writeHead(200, { "content-type": "application/json" });
          return res.end(JSON.stringify({ success: true, id: "x".repeat(100_000) }));
        }
        if (typeof m === "number") {
          res.writeHead(m, { "content-type": "application/json" });
          return res.end(JSON.stringify({ success: false, error: "x" }));
        }
        res.writeHead(200, { "content-type": "application/json" });
        if (op === "create") return res.end(JSON.stringify({ success: true, id: "sess_lb" }));
        if (op === "execute") return res.end(JSON.stringify(await goodExecute()));
        return res.end(JSON.stringify({ success: true, creditsBilled: 1 }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  const run = async (limits?: Record<string, number>) => {
    const s = setup();
    return runSandboxLifecycle({ ...s, resolver: fakeIp(), getApiKey: () => KEY, createClient: async (k) => createInteractClient(k, { apiUrl: base, limits }) });
  };

  it("happy path: exactly the documented POST create, POST execute, DELETE with documented bodies only", async () => {
    seen.length = 0;
    mode = {};
    const rec = await run();
    expect(rec.status).toBe("accepted");
    expect(seen.map((x) => x.line)).toEqual(["POST /v2/interact", "POST /v2/interact/sess_lb/execute", "DELETE /v2/interact/sess_lb"]);
    expect(seen.every((x) => x.auth === `Bearer ${KEY}`)).toBe(true);
    expect(JSON.parse(seen[0]!.body)).toEqual({ ttl: 120, activityTtl: 60 });
    expect(Object.keys(JSON.parse(seen[1]!.body)).sort()).toEqual(["code", "language", "timeout"]);
    expect(seen[2]!.body).toBe("");
    expect(JSON.stringify(rec)).not.toContain(KEY);
  });

  it("5xx/408/redirect/oversize on each operation: one request each, no replay; create failure skips execute/delete", async () => {
    const C = "POST /v2/interact", E = "POST /v2/interact/sess_lb/execute", D = "DELETE /v2/interact/sess_lb";
    for (const [m, expected, status] of [
      [{ create: 502 }, [C], "ambiguous"],
      [{ create: 400 }, [C], "failed"],
      [{ create: "redirect" }, [C], "ambiguous"],
      [{ create: "huge" }, [C], "ambiguous"],
      [{ execute: 502 }, [C, E, D], "ambiguous"],
      [{ execute: 408 }, [C, E, D], "ambiguous"],
      [{ execute: "redirect" }, [C, E, D], "ambiguous"],
      [{ delete: 500 }, [C, E, D], "ambiguous"],
      [{ delete: "redirect" }, [C, E, D], "ambiguous"],
    ] as const) {
      seen.length = 0;
      mode = { ...m } as typeof mode;
      const rec = await run();
      expect(seen.map((x) => x.line)).toEqual(expected);
      expect(rec.status).toBe(status);
    }
  });

  it("create without success but WITH a valid session id (HTTP 200 success:false, or 5xx body naming the id): no execute, exactly ONE DELETE, no re-create", async () => {
    const C = "POST /v2/interact", D = "DELETE /v2/interact/sess_lb";
    for (const m of ["nonsuccess-id", "5xx-id"] as const) {
      seen.length = 0;
      mode = { create: m };
      const rec = await run();
      expect(seen.map((x) => x.line)).toEqual([C, D]);
      expect(rec).toMatchObject({ status: "ambiguous", sessionId: "sess_lb" });
      expect(rec.ops.map((x) => `${x.op}:${x.status}`)).toEqual([`create:ambiguous`, "delete:ok"]);
      expect(rec.errors.map((e) => `${e.kind}:${e.stage}`)).toEqual(["primary:create"]);
      expect(rec.reason).toMatch(/session sess_lb/);
    }
  });

  it("DELETE transport errors are recorded (cleanup provenance, blocking ledger) and nothing is re-created", async () => {
    for (const m of [500, "redirect", 400] as const) {
      seen.length = 0;
      mode = { delete: m };
      const s = setup();
      const rec = await runSandboxLifecycle({ ...s, resolver: fakeIp(), getApiKey: () => KEY, createClient: async (k) => createInteractClient(k, { apiUrl: base }) });
      expect(seen.map((x) => x.line)).toEqual(["POST /v2/interact", "POST /v2/interact/sess_lb/execute", "DELETE /v2/interact/sess_lb"]);
      expect(rec.status).toBe("ambiguous");
      expect(rec.errors.filter((e) => e.kind === "cleanup").map((e) => e.detail).join()).toMatch(/delete (failed|ambiguous): DELETE \/v2\/interact\/sess_lb/);
      const e = readLedger(s.ledgerPath).entries.at(-1)!;
      expect(e.status).toBe("ambiguous");
      expect(e.ops!.filter((x) => x.op === "delete").map((x) => x.status)).toEqual(["attempting", m === 400 ? "failed" : "ambiguous"]);
      expect(unresolved(readLedger(s.ledgerPath)).map((x) => x.id)).toEqual([e.id]);
    }
  });

  it("timeouts are single attempts (short per-op limits)", { timeout: 30_000 }, async () => {
    for (const [op, expected] of [
      ["create", ["POST /v2/interact"]],
      ["execute", ["POST /v2/interact", "POST /v2/interact/sess_lb/execute", "DELETE /v2/interact/sess_lb"]],
      ["delete", ["POST /v2/interact", "POST /v2/interact/sess_lb/execute", "DELETE /v2/interact/sess_lb"]],
    ] as const) {
      seen.length = 0;
      mode = { [op]: "hang" };
      const rec = await run({ createMs: 400, executeMs: 400, deleteMs: 400 });
      expect(seen.map((x) => x.line)).toEqual(expected);
      expect(rec.status).toBe("ambiguous");
    }
  });
});

describe("offline conversion: one region, valid 3-state group", () => {
  it("sandbox record -> capture -> hifi: 3 page-api/baseline variants of #testimonials with screenshots", async () => {
    const s = setup();
    const files: Record<number, Uint8Array> = {};
    const rec = await runSandboxLifecycle({ ...s, resolver: fakeIp(), getApiKey: () => KEY, createClient: async () => client([], s.ledgerPath), savePng: (i, b) => (files[i] = b) });
    const { capture, manifest } = sandboxToCapture(rec, ["state-0.png", "state-1.png", "state-2.png"]);
    const assets = (manifest.assets as any[]).map((a, i) => ({ operatorId: a.id, kind: "reference" as const, mime: "image/png" as const, width: rec.states[i]!.png.width, height: rec.states[i]!.png.height, sha256: a.sha256, sourceUrl: null, pageUrl: SANDBOX_URL, state: a.state, bytes: files[i]! }));
    const cap = captureFromScrapeResponses([{ name: "x", json: { data: { metadata: { url: SANDBOX_URL }, actions: { javascriptReturns: [{ value: { viewport: { width: 1920, height: 1080 }, elements: [], texts: [] } }] } } } }], "x");
    void cap;
    const doc = convertCapture({ capture, assets, assetWarnings: [] });
    expect(validateHifiDoc(doc).ok).toBe(true);
    const vs = doc.pages[0]!.states!.variants;
    expect(vs.map((v) => [v.name, v.provenance])).toEqual([["Default", "baseline"], ["Testimonial next", "page-api"], ["Testimonial next 2", "page-api"]]);
    expect(vs.every((v) => v.referenceAssetId !== null)).toBe(true);
    expect(vs.map((v) => v.nodes.filter((n) => n.kind === "text").map((n: any) => n.text).find((t: string) => t.startsWith("Slide")))).toEqual(["Slide 0", "Slide 1", "Slide 2"]);
    expect(doc.pages[0]!.warnings.join()).not.toMatch(/suppressed/);
  });
});

describe("retained restrictions and CLI HOLD", () => {
  it("the hosted DNS exception is NOT expanded by the sandbox (still exactly two hosts)", () => {
    expect(hostedDnsExemptHostnames().sort()).toEqual(["bootstrapmade.com", "simplecss.org"]);
    expect(SANDBOX_CODE).not.toMatch(/simplecss|require\(|import\(|\bdns\.|\.lookup\(|resolve[46]\(|resolveAny/);
  });
  it("sandbox-run HOLDS without --yes (exit 3, no key read, no run dir) and states the accounting semantics", () => {
    const d = tmp();
    const run = (args: string[]) => {
      try {
        return { code: 0, out: execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], { encoding: "utf8", env: { ...process.env, FIRECRAWL_API_KEY: KEY }, stdio: ["ignore", "pipe", "pipe"] }) };
      } catch (e: any) {
        return { code: e.status as number, out: `${e.stdout}${e.stderr}` };
      }
    };
    run(["sandbox-plan", "--out", join(d, "s.json")]);
    initLedger(join(d, "l.json"), 17, "origin-reported actual spend");
    const r = run(["sandbox-run", "--preview", join(d, "s.json"), "--out", join(d, "runs"), "--ledger", join(d, "l.json"), "--operator-credits-per-request", "4", "--project-remaining-credits", "983", "--confirm-existing-credits", "--confirm-no-topup"]);
    expect(r.code).toBe(3);
    expect(r.out).toMatch(/Project remaining \(origin-reported, NOT a verified account balance\): 983/);
    expect(r.out).toMatch(/PENDING RECONCILIATION/);
    expect(r.out).toMatch(/HOLD: nothing was sent and no key was read/);
    expect(r.out).not.toContain(KEY);
    expect(existsSync(join(d, "runs"))).toBe(false);
    const old = run(["sandbox-run", "--preview", join(d, "s.json"), "--out", join(d, "runs"), "--ledger", join(d, "l.json"), "--operator-credits-per-request", "4", "--operator-reported-balance", "983", "--confirm-existing-credits", "--confirm-no-topup"]);
    expect(old.code).toBe(3);
    expect(old.out).toMatch(/--project-remaining-credits N/);
  }, 60_000);
});

describe("Swiper readiness (bounded page.waitForFunction on the source-verified selector)", () => {
  it("waits for the page's own async Swiper init, then proceeds on the same page (no extra mechanism)", async () => {
    const p = fakePage({ swiperBindAfterMs: 3000 });
    const parsed = parseSandboxOutput(await runCode(p));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const r = parsed.result as any;
    expect(p.calls).toContain(`waitForFunction:timeout=${SANDBOX.swiperReadyMs}:polling=100`);
    expect(SANDBOX.swiperReadyMs).toBe(8_000);
    expect(SANDBOX.swiper).toBe("#testimonials .swiper.init-swiper"); // unchanged (source-verified)
    expect(r.swiperReady).toMatchObject({ ready: true, timeoutMs: 8_000, diag: { matches: 1, hasSwiperProp: true } });
    expect(r.stage).toBe("done");
    // readiness wait happens after settle and before the autoplay stop / first state
    const iw = p.calls.findIndex((c) => c.startsWith("waitForFunction"));
    expect(iw).toBeGreaterThan(p.calls.findIndex((c) => c.startsWith("goto:")));
    expect(iw).toBeLessThan(p.calls.indexOf("autoplay.stop"));
  });
  it("never bound: fails closed at the bounded timeout WITH read-only diagnostics; no state, no screenshot, context closed", async () => {
    const p = fakePage({ noSwiper: true, pageError: "Swiper is not defined" });
    const parsed = parseSandboxOutput(await runCode(p));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.status).toBe("rejected");
    expect(parsed.reason).toBe("in-browser step failed at stage swiper-ready: swiper not bound within 8000 ms (see swiperReady.diag)");
    const r = parsed.result as any;
    expect(r.swiperReady).toMatchObject({ ready: false, timeoutMs: 8_000, error: "page.waitForFunction: Timeout 8000ms exceeded." });
    expect(r.swiperReady.diag).toMatchObject({ matches: 1, hasSwiperProp: false, initializedClass: false, windowSwiperType: "undefined", slides: 1 });
    expect(r.pageErrors).toEqual(["Swiper is not defined"]);
    expect(r.routeInstalled).toBe(true);
    expect(r.served.map((x: any) => x.path)).toContain("/content/vendors/aos/aos.js");
    expect(p.calls.some((c) => c.startsWith("slideNext") || c.startsWith("screenshot") || c === "autoplay.stop")).toBe(false);
    expect(p.calls.at(-1)).toBe("context.close");
  });
});

describe("failure diagnostics are preserved (never discarded, never defaulted)", () => {
  const w2f = (o: Record<string, unknown>) => ({ success: true, exitCode: 0, killed: false, stdout: "some log\nW2F_RESULT " + JSON.stringify({ w2f: "sandbox", v: 1, states: [], ...o }) });
  const lifecycle = async (execute: unknown) => {
    const s = setup();
    const events: string[] = [];
    const raws: string[] = [];
    const rec = await runSandboxLifecycle({ ...s, resolver: fakeIp(), getApiKey: () => KEY, createClient: async () => client(events, s.ledgerPath, { execute }), saveRaw: (t) => raws.push(t) });
    return { rec, events, raws, s };
  };
  it("synthetic W2F_RESULT with error + blocked/incomplete/env/autoplay: all observed fields kept on reject; errors[] primary", async () => {
    const { rec, events, raws } = await lifecycle(
      w2f({ error: "swiper refused: no Swiper instance bound to this element", stage: "autoplay", routeInstalled: true, incomplete: true, blocked: [{ origin: "https://fonts.googleapis.com", why: "third-party-host" }], blockedTotal: 7, served: [{ path: "/content/vendors/swiper/swiper-bundle.min.js", status: 200, nav: false }], servedTotal: 12, env: { innerWidth: 1920, innerHeight: 1080 }, autoplay: { valid: false, reason: "no Swiper instance bound to this element" }, mainFetch: { status: 200, url: SANDBOX_URL }, nav: { status: 200, finalUrl: SANDBOX_URL, chain: [SANDBOX_URL] }, ownedContext: { serviceWorkers: "block" }, ownedContextClosed: true, serviceWorker: false, listenersInstalled: true, modifications: [], pageErrors: ["TypeError: x"], consoleErrors: [], popupsClosed: 0, swiperReady: { ready: true } }),
    );
    expect(rec.status).toBe("rejected");
    expect(rec).toMatchObject({
      observation: "w2f-result",
      stage: "autoplay",
      routeInstalled: true,
      incomplete: true,
      blocked: [{ origin: "https://fonts.googleapis.com", why: "third-party-host" }],
      blockedTotal: 7,
      servedTotal: 12,
      env: { innerWidth: 1920, innerHeight: 1080 },
      autoplay: { valid: false, reason: "no Swiper instance bound to this element" },
      mainFetch: { status: 200 },
      ownedContext: { serviceWorkers: "block" },
      ownedContextClosed: true,
      serviceWorker: false,
      pageErrors: ["TypeError: x"],
      swiperReady: { ready: true },
    });
    expect(rec.errors[0]).toEqual({ stage: "execute", kind: "primary", detail: "in-browser step failed at stage autoplay: swiper refused: no Swiper instance bound to this element" });
    expect(rec.states).toEqual([]);
    expect(events.filter((e) => e.startsWith("delete"))).toHaveLength(1);
    expect(raws).toHaveLength(1);
    expect(rec.rawExecute).toEqual({ saved: true, chars: raws[0]!.length });
    expect(raws[0]).toContain("swiper refused: no Swiper instance bound");
  });
  it("the REAL page code's failure output (never-bound Swiper) is preserved end to end", async () => {
    const { rec } = await lifecycle(await runCode(fakePage({ noSwiper: true, pageError: "Swiper is not defined" })));
    expect(rec).toMatchObject({ status: "rejected", stage: "swiper-ready", routeInstalled: true, incomplete: true, swiperReady: { ready: false, diag: { hasSwiperProp: false } }, pageErrors: ["Swiper is not defined"] });
    expect(rec.blocked!.length).toBeGreaterThan(0);
    expect(rec.env).toMatchObject({ innerWidth: 1920, innerHeight: 1080 });
  });
  it("defaults are NOT written as observations: guard never installed, legacy result shape, no W2F_RESULT, execute transport error", async () => {
    // newContext failed: the page's own defaults (incomplete false, blocked []) are not evidence
    const a = await lifecycle(w2f({ error: "Browser object unavailable", stage: "start", routeInstalled: false, incomplete: false, blocked: [], served: [] }));
    expect(a.rec).toMatchObject({ status: "rejected", observation: "w2f-result", stage: "start", routeInstalled: false, incomplete: null, blocked: null, served: null, blockedTotal: null, env: null, autoplay: null });
    // legacy shape (no routeInstalled), like the consumed run's output: unknown, not "complete"
    const b = await lifecycle(w2f({ error: "swiper refused: no Swiper instance bound to this element", incomplete: false, blocked: [] }));
    expect(b.rec).toMatchObject({ routeInstalled: null, incomplete: null, blocked: null, stage: null });
    // no parsable result: nothing observed; raw provenance still saved
    const c = await lifecycle({ success: true, exitCode: 0, stdout: "garbage only" });
    expect(c.rec).toMatchObject({ status: "ambiguous", observation: "none", incomplete: null, blocked: null, popupsClosed: null, modifications: null });
    expect(c.raws[0]).toContain("garbage only");
    // execute transport error: no response, no raw, nothing observed
    const d = await lifecycle(new Error("socket hang up"));
    expect(d.rec).toMatchObject({ observation: "none", rawExecute: null, incomplete: null, blocked: null });
    expect(d.raws).toEqual([]);
  });
  it("raw provenance is ALWAYS valid JSON within the cap, with explicit truncation metadata, PNG elision and key redaction", () => {
    const png = "A".repeat(500_000);
    const raw = rawExecuteProvenance({ success: true, exitCode: 0, stdout: `${KEY} W2F_RESULT {"states":[{"png":"${png}"}]}` + " log".repeat(30_000), stderr: "e".repeat(40_000), weird: 1 }, [KEY]);
    expect(Buffer.byteLength(raw, "utf8")).toBeLessThanOrEqual(RAW_EXECUTE_CAP_BYTES);
    const j = JSON.parse(raw);
    expect(raw).not.toContain(KEY);
    expect(raw).not.toContain("A".repeat(100));
    expect(j).toMatchObject({ schema: "website-to-figma/execute-raw", schemaVersion: 1, capBytes: RAW_EXECUTE_CAP_BYTES, envelope: { success: true, exitCode: 0 }, otherKeys: ["weird"] });
    expect(j.fields.stdout).toMatchObject({ pngElided: 1, truncated: true, keptChars: 50_000 });
    expect(j.fields.stdout.text).toContain("<elided 500000 base64 chars>");
    expect(j.fields.stderr).toMatchObject({ originalChars: 40_000, truncated: true, keptChars: 16_000 });
  });
  it("raw provenance stays valid JSON for adversarial content (escape-heavy text shrinks budgets, never chops JSON)", () => {
    for (const nasty of ['"'.repeat(200_000), "\u0001".repeat(200_000), "\\".repeat(100_000) + '"}]', "\u2028😀".repeat(80_000)]) {
      const raw = rawExecuteProvenance({ stdout: nasty, stderr: nasty, error: nasty, result: nasty, output: nasty }, [KEY]);
      expect(Buffer.byteLength(raw, "utf8")).toBeLessThanOrEqual(RAW_EXECUTE_CAP_BYTES);
      const j = JSON.parse(raw);
      expect(j.schema).toBe("website-to-figma/execute-raw");
      if (j.fields) for (const f of Object.values(j.fields) as any[]) expect(f.keptChars).toBe(f.text.length);
    }
    for (const x of [null, 5, "str", undefined]) expect(() => JSON.parse(rawExecuteProvenance(x, []))).not.toThrow();
  });
  it("copyObserved ignores malformed types (no coercion into observations)", () => {
    const rec = { observation: "none", timing: {} } as any;
    copyObserved(rec, { routeInstalled: "yes", listenersInstalled: true, incomplete: "true", blocked: "x", env: 5, pageErrors: [1, "ok"] });
    expect(rec).toMatchObject({ routeInstalled: null, incomplete: null, blocked: null, env: null, pageErrors: ["ok"] });
  });
});

// ---------------- review 6bc32dda findings ----------------
const SECRETS = ["hunter2", "SEKRET123TOKEN", "SESSIONID777", "LIVEVIEWTOKEN42", "sk_live_ABC999", "QUERYOPAQUEVALUE0123456789ABCDEF"];
const PLANTED = `Failed https://u:hunter2@bootstrapmade.com/x.js?token=SEKRET123TOKEN&ver=2 cdp ws://10.0.0.5:9222/devtools/browser/SESSIONID777 view https://liveview.firecrawl.dev/s/LIVEVIEWTOKEN42 api_key=sk_live_ABC999 img https://bootstrapmade.com/i.png?x=QUERYOPAQUEVALUE0123456789ABCDEF ${KEY}`;
const w2fLine = (o: Record<string, unknown>) => "W2F_RESULT " + JSON.stringify({ w2f: "sandbox", v: 1, states: [], ...o });
const runWith = async (execute: unknown) => {
  const s = setup();
  const events: string[] = [];
  const raws: string[] = [];
  const rec = await runSandboxLifecycle({ ...s, resolver: fakeIp(), getApiKey: () => KEY, createClient: async () => client(events, s.ledgerPath, { execute }), saveRaw: (t) => raws.push(t) });
  return { rec, events, raws };
};

describe("FINDING1: centralized sanitization before persistence (raw AND structured record)", () => {
  it("URL password, query token, CDP/live-view session URLs, api_key and the key are removed from execute-raw.json AND sandbox.json (pageErrors, nested nav/swiperReady, reason/errors)", async () => {
    const exec = await runCode(fakePage({ noSwiper: true, pageError: PLANTED }));
    exec.stdout = exec.stdout.replace(/"finalUrl":"[^"]*"/, `"finalUrl":"https://u:hunter2@bootstrapmade.com/?token=SEKRET123TOKEN"`);
    const { rec, raws } = await runWith({ ...exec, stderr: PLANTED, error: PLANTED });
    const persisted = JSON.stringify(sanitizeRecord(rec)); // exactly what the CLI writes
    for (const out of [JSON.stringify(rec), persisted, raws[0]!]) {
      for (const sec of [...SECRETS, KEY]) expect(out).not.toContain(sec);
      expect(out).toContain("[REDACTED-SESSION-URL]");
    }
    expect(rec.pageErrors![0]).toMatch(/^Failed https:\/\/\[REDACTED\]@bootstrapmade\.com\/x\.js\?token=\[REDACTED\]&ver=2 cdp \[REDACTED-SESSION-URL\] view \[REDACTED-SESSION-URL\] api_key=\[REDACTED\]/);
    expect((rec.nav as any).finalUrl).toBe("https://[REDACTED]@bootstrapmade.com/?token=[REDACTED]");
    // useful non-secret diagnostics survive unchanged
    expect(rec).toMatchObject({ stage: "swiper-ready", routeInstalled: true, env: { innerWidth: 1920, innerHeight: 1080 }, swiperReady: { ready: false, diag: { matches: 1, hasSwiperProp: false } } });
    expect(rec.blocked!.map((b: any) => b.origin)).toContain("https://fonts.googleapis.com");
    expect(rec.served!.map((x: any) => x.path)).toContain("/content/vendors/aos/aos.js");
    expect(JSON.parse(raws[0]!).fields.stderr.text).toContain("[REDACTED-SESSION-URL]");
  });
  it("MUTATION: without the new sanitizer the planted secrets remain (old redact, unsanitized record, raw JSON)", async () => {
    // the previous redaction (execute.ts redact) misses URL userinfo/query tokens/session URLs
    const old = legacyRedact(PLANTED, [KEY]);
    for (const sec of SECRETS) expect(old).toContain(sec);
    // the structured record BEFORE the persistence boundary still holds them
    const rec: any = { observation: "none", timing: {} };
    copyObserved(rec, { routeInstalled: true, listenersInstalled: true, pageErrors: [PLANTED], nav: { finalUrl: "https://u:hunter2@x.com/" } });
    const before = JSON.stringify(rec);
    for (const sec of SECRETS) expect(before).toContain(sec);
    const after = JSON.stringify(sanitizeRecord(rec, [KEY]));
    for (const sec of SECRETS) expect(after).not.toContain(sec);
    // and the new sanitizer covers each planted form individually
    for (const sec of SECRETS) expect(sanitizeString(PLANTED, [KEY])).not.toContain(sec);
  });
  it("non-secret URLs and text are kept byte-for-byte", () => {
    for (const t of ["GET https://bootstrapmade.com/content/demo/Bootslander/ 200", "https://fonts.googleapis.com", "https://bootstrapmade.com/a.js?ver=5.1.3", "/content/vendors/swiper/swiper-bundle.min.js", "swiper not bound within 8000 ms"]) expect(sanitizeString(t, [KEY])).toBe(t);
  });
});

describe("FINDING3: envelope failures keep a recoverable W2F_RESULT (still rejected/ambiguous)", () => {
  const diag = { error: "swiper refused", stage: "autoplay", routeInstalled: true, listenersInstalled: true, incomplete: true, blocked: [{ origin: "https://fonts.googleapis.com", why: "third-party-host" }], env: { innerWidth: 1920, innerHeight: 1080 }, pageErrors: ["TypeError: y"] };
  for (const [env, status, re] of [
    [{ success: false, error: "execution failed" }, "rejected", /^execute reported failure: execution failed \(W2F_RESULT diagnostics recovered\)/],
    [{ success: true, killed: true }, "ambiguous", /^execute was killed \(provider timeout\) \(W2F_RESULT diagnostics recovered\)/],
    [{ success: true, exitCode: 1 }, "rejected", /^execute exit code 1 \(W2F_RESULT diagnostics recovered\)/],
    [{ success: true, truncated: true }, "ambiguous", /^execute output was truncated by the provider \(W2F_RESULT diagnostics recovered\)/],
  ] as const) {
    it(`${JSON.stringify(env)} + valid W2F_RESULT: ${status}, diagnostics kept`, async () => {
      const { rec } = await runWith({ ...env, stdout: "log\n" + w2fLine(diag) });
      expect(rec.status).toBe(status);
      expect(rec.reason).toMatch(re);
      expect(rec).toMatchObject({ observation: "w2f-result", stage: "autoplay", incomplete: true, blocked: [{ why: "third-party-host" }], env: { innerWidth: 1920 }, pageErrors: ["TypeError: y"] });
    });
  }
  it("a truncated, partial W2F_RESULT is not recovered (nothing invented)", async () => {
    const { rec } = await runWith({ success: true, truncated: true, stdout: w2fLine(diag).slice(0, 60) });
    expect(rec).toMatchObject({ status: "ambiguous", observation: "none", blocked: null, incomplete: null, pageErrors: null });
  });
  it("early newContext failure: page/listener fields stay null (unknown), not [] / 0", async () => {
    const { rec } = await runWith(await runCode(fakePage({ newContextThrows: true })));
    expect(rec).toMatchObject({ status: "rejected", observation: "w2f-result", stage: "newContext", routeInstalled: false, pageErrors: null, consoleErrors: null, modifications: null, popupsClosed: null, blocked: null, served: null, incomplete: null });
  });
  it("a W2F_RESULT without listenersInstalled (pre-listener/legacy) never yields [] or 0 observations", async () => {
    const { rec } = await runWith({ success: true, exitCode: 0, stdout: w2fLine({ error: "x", routeInstalled: true, pageErrors: [], consoleErrors: [], modifications: [], popupsClosed: 0 }) });
    expect(rec).toMatchObject({ pageErrors: null, consoleErrors: null, modifications: null, popupsClosed: null });
  });
});

describe("FINDING4: one local in-browser deadline; bounded single close; deadline kinds distinguished", () => {
  const withConst = (k: string, from: number, to: number) => {
    const needle = `"${k}":${from}`;
    expect(SANDBOX_CODE).toContain(needle);
    return SANDBOX_CODE.replace(needle, `"${k}":${to}`);
  };
  const runMut = async (p: ReturnType<typeof fakePage>, code: string) => {
    const lines: string[] = [];
    await new AsyncFunction("page", "console", code)(p.page, { log: (x: string) => lines.push(x) });
    return { success: true, stdout: lines.join("\n"), exitCode: 0, killed: false };
  };
  it("budget: nominal step caps fit inside the local deadline; deadline + close bound leave >= 10 s of the documented 90 s", () => {
    const nominal = SANDBOX.navTimeoutMs + SANDBOX.settleMs + SANDBOX.swiperReadyMs + SANDBOX.states.length * (SANDBOX.stateWaitMs + SANDBOX.screenshotMs);
    expect(nominal).toBe(61_400);
    expect(nominal).toBeLessThan(SANDBOX.localDeadlineMs);
    expect(SANDBOX.localDeadlineMs + SANDBOX.closeBoundMs).toBe(77_000);
    expect(SANDBOX.executeTimeoutS).toBe(90); // not raised
    expect(SANDBOX.executeTimeoutS * 1000 - SANDBOX.localDeadlineMs - SANDBOX.closeBoundMs).toBeGreaterThanOrEqual(10_000);
  });
  for (const hangAt of ["goto", "screenshot"] as const) {
    it(`a hang at ${hangAt} hits the local deadline: capture stops, context still closed once, W2F_RESULT emitted`, async () => {
      const p = fakePage({ hangAt });
      const t0 = Date.now();
      const res = parseSandboxOutput(await runMut(p, withConst("localDeadlineMs", SANDBOX.localDeadlineMs, 300)));
      expect(Date.now() - t0).toBeLessThan(5_000);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.reason).toMatch(new RegExp(`local deadline 300 ms reached during ${hangAt}`));
      const r = res.result as any;
      expect(r.deadline).toMatchObject({ localDeadlineMs: 300, hit: true, at: hangAt });
      expect(r.close).toMatchObject({ attempted: true, ok: true, timedOut: false });
      expect(r.states).toEqual([]);
      expect(p.calls.filter((c) => c === "context.close")).toHaveLength(1);
      expect(p.calls.at(-1)).toBe("context.close");
    });
  }
  it("a hanging context close is bounded separately (one attempt) and reported, result still emitted", async () => {
    const p = fakePage({ closeHangs: true, hangAt: "goto" });
    const code = withConst("closeBoundMs", SANDBOX.closeBoundMs, 100).replace(`"localDeadlineMs":${SANDBOX.localDeadlineMs}`, `"localDeadlineMs":200`);
    const res = parseSandboxOutput(await runMut(p, code));
    expect(res.ok).toBe(false);
    const r = (res as any).result;
    expect(r.close).toMatchObject({ attempted: true, ok: false, timedOut: true, boundMs: 100 });
    expect(r.ownedContextClosed).toBe(false);
    expect(p.calls.filter((c) => c === "context.close")).toHaveLength(1);
  });
  it("record separates localDeadline / ownedContextClose / providerKilled / transportTimedOut", async () => {
    const local = await runWith({ success: true, exitCode: 0, killed: false, stdout: w2fLine({ error: "local deadline 72000 ms reached during goto", stage: "goto", deadline: { localDeadlineMs: 72000, hit: true, at: "goto", elapsedMs: 72001 }, close: { attempted: true, ok: true, timedOut: false, boundMs: 5000, ms: 12 } }) });
    expect(local.rec.timing).toMatchObject({ limits: { localDeadlineMs: 72_000, closeBoundMs: 5_000, providerExecuteTimeoutS: 90, transportExecuteWallMs: SANDBOX_WALL_MS.execute }, localDeadline: { hit: true, at: "goto" }, ownedContextClose: { ok: true }, providerKilled: false, transportTimedOut: false });
    const killed = await runWith({ success: true, killed: true, stdout: "" });
    const unknown = await runWith({ success: true, exitCode: 0, stdout: w2fLine({ error: "x" }) });
    expect(unknown.rec.timing.providerKilled).toBeNull(); // absent envelope field = unknown, not false
    expect(killed.rec.timing).toMatchObject({ providerKilled: true, transportTimedOut: false, localDeadline: null });
    const transport = await runWith(Object.assign(new Error("execute did not finish within 120000 ms (wall clock)"), { w2fTimeout: true }));
    expect(transport.rec.timing).toMatchObject({ transportTimedOut: true, providerKilled: null, localDeadline: null });
    expect(transport.events.filter((e) => e.startsWith("delete"))).toHaveLength(1); // session DELETE still once
  });
});

// ---------------- review 4633ca1c findings ----------------
const BEARER = "SENTINELBEARERTOKEN0123456789";
const BEARER_FORMS = [`Authorization: Bearer ${BEARER}`, `{"authorization":"Bearer ${BEARER}"}`, `{\\"Authorization\\":\\"Bearer ${BEARER}\\"}`, `curl -H 'authorization: bearer ${BEARER}'`, `proxy-authorization=Basic ${Buffer.from("u:SENTINELBASICPW").toString("base64")}`];
const ALL_SENTINELS = [...SECRETS, BEARER, Buffer.from("u:SENTINELBASICPW").toString("base64"), KEY];
const PLANTED2 = `${PLANTED} ${BEARER_FORMS.join(" ")}`;
const noSentinel = (text: string) => {
  for (const sec of ALL_SENTINELS) expect(text, `leaked ${sec}`).not.toContain(sec);
};

describe("FINDING2: Authorization scheme + credential fully redacted (raw AND structured)", () => {
  it("every Bearer/Basic form is removed from execute-raw.json, sandbox.json and nested structured fields", async () => {
    const stdout = "log " + BEARER_FORMS.join("\n") + "\n" + w2fLine({ error: `fetch failed ${BEARER_FORMS[1]}`, stage: "goto", routeInstalled: true, listenersInstalled: true, pageErrors: BEARER_FORMS, consoleErrors: [BEARER_FORMS[0]], nav: { note: BEARER_FORMS[0], headers: { authorization: `Bearer ${BEARER}` } } });
    const { rec, raws } = await runWith({ success: true, exitCode: 0, killed: false, stdout, stderr: BEARER_FORMS.join(" "), error: BEARER_FORMS[2] });
    noSentinel(JSON.stringify(rec));
    noSentinel(JSON.stringify(sanitizeRecord(rec)));
    noSentinel(raws[0]!);
    expect(rec.pageErrors![0]).toBe("Authorization: [REDACTED]");
    expect((rec.nav as any).headers.authorization).toBe("[REDACTED]");
    for (const f of BEARER_FORMS) expect(sanitizeString(f)).toContain("[REDACTED]");
  });
  it("MUTATION: the previous Authorization rule leaves the credential (scheme only replaced)", () => {
    const previousRule = (t: string) => t.replace(/\b(authorization|bearer)\b(\s*[:=]?\s*)(?!\[REDACTED)[^\s"',;]+/gi, "$1$2[REDACTED]");
    expect(previousRule(BEARER_FORMS[0]!)).toContain(BEARER);
    expect(sanitizeString(BEARER_FORMS[0]!)).not.toContain(BEARER);
  });
});

describe("FINDING1: every ledger persistence path is sanitized before disk", () => {
  const fileText = (p: string) => readFileSync(p, "utf8");
  it("init / manual / reserve (url) / op detail / settle / pending settlement / resolve: no sentinel on disk; schema intact", () => {
    const d = tmp();
    const lp = join(d, "l.json");
    lInit(lp, 17, `prior ${PLANTED2}`);
    recordManual(lp, 1, `manual ${PLANTED2}`);
    const a = reserveAttempt(lp, { url: "https://u:hunter2@bootstrapmade.com/?token=SEKRET123TOKEN", requestSha256: "a".repeat(64), reserved: 1, command: "sandbox-run" });
    lRecordOp(lp, a.id, { op: "execute", status: "ok", detail: `detail ${PLANTED2}` });
    lSettle(lp, a.id, "failed", null, `settle ${PLANTED2}`);
    const b = reserveAttempt(lp, { url: SANDBOX_URL, requestSha256: "b".repeat(64), reserved: 1, command: "sandbox-run" });
    lPending(lp, b.id, `pending ${PLANTED2}`);
    resolveEntry(lp, b.id, 1, `resolve ${PLANTED2}`);
    const text = fileText(lp);
    noSentinel(text);
    expect(text).toContain("[REDACTED-SESSION-URL]");
    const l = readLedger(lp); // still parses with the strict schema
    expect(l.entries.map((e) => e.status)).toEqual(["prior", "manual", "failed", "succeeded"]);
    expect(l.entries[3]!.chargeStatus).toBe("reconciled");
    expect(l.entries[0]!.reserved).toBe(17);
  });
  it("lifecycle: an in-browser error carrying secrets reaches reason -> settlement note sanitized BEFORE the ledger call AND on disk", async () => {
    const s = setup();
    const seen: string[] = [];
    const capture = {
      recordOp: ((p: string, id: string, x: any, n?: () => Date) => (seen.push(x.detail), realRecordOp(p, id, x, n))) as typeof realRecordOp,
      settleAttempt: ((p: string, id: string, st: any, c: any, note: string) => (seen.push(note), realSettleAttempt(p, id, st, c, note))) as typeof realSettleAttempt,
      settlePendingReconciliation: ((p: string, id: string, note: string) => (seen.push(note), realSettlePending(p, id, note))) as typeof realSettlePending,
    };
    const rec = await runSandboxLifecycle({ ...s, resolver: fakeIp(), getApiKey: () => KEY, createClient: async () => client([], s.ledgerPath, { execute: { success: true, exitCode: 0, killed: false, stdout: w2fLine({ error: `boom ${PLANTED2}`, stage: "goto" }) } }), ledger: capture });
    expect(rec.status).toBe("rejected");
    expect(seen.some((x) => x.includes("boom"))).toBe(true); // the settlement note did carry the error
    for (const x of seen) noSentinel(x); // ...sanitized before the ledger function was called
    noSentinel(readFileSync(s.ledgerPath, "utf8"));
  });
  it("lifecycle: create error / execute transport error / delete error details are sanitized on disk", async () => {
    for (const o of [{ create: new Error(`create ${PLANTED2}`) }, { execute: new Error(`exec ${PLANTED2}`) }, { del: new Error(`del ${PLANTED2}`) }]) {
      const s = setup();
      await runSandboxLifecycle({ ...s, resolver: fakeIp(), getApiKey: () => KEY, createClient: async () => client([], s.ledgerPath, o) });
      noSentinel(readFileSync(s.ledgerPath, "utf8"));
    }
  });
  it("MUTATION: the previous ledger serializer (plain JSON.stringify) would persist the planted note", () => {
    const l: any = { schema: "website-to-figma/credit-ledger", schemaVersion: 1, capCredits: 1000, entries: [{ id: "x", at: "t", command: "manual", url: null, requestSha256: null, reserved: 1, reportedCredits: 1, status: "manual", note: PLANTED2 }] };
    const previous = JSON.stringify(l, null, 2);
    for (const sec of SECRETS) expect(previous).toContain(sec);
    noSentinel(serializeLedger(l));
  });
  it("CLI top-level error output is sanitized", () => {
    const d = tmp();
    initLedger(join(d, "l.json"), 17, "x");
    let out = "";
    try {
      execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", "ledger", "resolve", "--ledger", join(d, "l.json"), "--id", `Bearer ${BEARER} https://u:hunter2@x.example/`, "--credits", "1"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (e: any) {
      out = `${e.stdout}${e.stderr}`;
      expect(e.status).toBe(3);
    }
    expect(out).toMatch(/no ledger entry/);
    expect(out).not.toContain(BEARER);
    expect(out).not.toContain("hunter2");
  }, 60_000);
});

describe("FINDING3: execute-raw.json is capped in serialized UTF-8 BYTES and always valid JSON", () => {
  const LONE_HIGH = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/;
  for (const [name, unit] of [["4-byte emoji (surrogate pairs)", "😀"], ["3-byte CJK", "漢"], ["2-byte latin", "é"], ["mixed + escapes", '😀"\\\u0001漢']] as const) {
    it(`${name}: bytes <= cap, parses, truncation metadata, no split surrogate`, () => {
      const big = unit.repeat(150_000);
      const raw = rawExecuteProvenance({ success: false, stdout: big, result: big, output: big, stderr: big, error: big }, [KEY]);
      expect(Buffer.byteLength(raw, "utf8")).toBeLessThanOrEqual(RAW_EXECUTE_CAP_BYTES);
      const j = JSON.parse(raw);
      expect(j.capBytes).toBe(RAW_EXECUTE_CAP_BYTES);
      for (const f of Object.values(j.fields) as any[]) {
        expect(f.truncated).toBe(true);
        expect(f.keptChars).toBe(f.text.length);
        expect(f.keptChars).toBeLessThan(f.sanitizedChars);
        expect(LONE_HIGH.test(f.text)).toBe(false);
      }
    });
  }
  it("lone surrogates in input still serialize to valid JSON within the byte cap", () => {
    const raw = rawExecuteProvenance({ stdout: "\uD800x\uDC00".repeat(100_000), stderr: "a\uDBFF" }, []);
    expect(Buffer.byteLength(raw, "utf8")).toBeLessThanOrEqual(RAW_EXECUTE_CAP_BYTES);
    expect(() => JSON.parse(raw)).not.toThrow();
  });
  it("MUTATION: a char-length check alone would accept a file far over the byte cap", () => {
    const text = JSON.stringify({ t: "😀".repeat(60_000) });
    expect(text.length).toBeLessThanOrEqual(RAW_EXECUTE_CAP_BYTES); // passes a char check
    expect(Buffer.byteLength(text, "utf8")).toBeGreaterThan(RAW_EXECUTE_CAP_BYTES); // but is ~240 KB
  });
});

describe("persistence audit guard (complements the behavioral tests above)", () => {
  it("ledger.ts has exactly two disk writers for the ledger and both use serializeLedger", () => {
    const src = readFileSync("src/states/ledger.ts", "utf8");
    expect(src.match(/writeSync\(fd, serializeLedger\(l\)\)/g)).toHaveLength(2);
    expect(src).not.toMatch(/writeSync\(fd, JSON\.stringify/);
  });
  it("sandbox-run writes sandbox.json from sanitizeRecord and prints from the same sanitized object", () => {
    const src = readFileSync("src/cli.ts", "utf8");
    expect(src).toContain('const safe = sanitizeRecord(rec); // same sanitized record for disk AND terminal');
    expect(src).toContain('writeExclusive(join(runDir, "sandbox.json"), JSON.stringify(safe, null, 2)');
  });
});
