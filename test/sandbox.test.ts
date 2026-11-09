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
import { buildSandboxPreview, createSandboxClient, executeSandbox, runSandboxLifecycle, SandboxHardHold, SANDBOX_UNSUPPORTED, parseSandboxOutput, sandboxPreviewSha256, sandboxToCapture, validateSandboxPreview, cleanupSandbox, SANDBOX, SANDBOX_CODE, SANDBOX_URL, SANDBOX_WORST_CASE_CREDITS, type SandboxClient } from "../src/states/sandbox";
import { StateRunPolicyError } from "../src/states/execute";
import { createInteractClient } from "../src/states/sandboxTransport";
import { initLedger, readLedger, resolveEntry, unresolved } from "../src/states/ledger";
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
function fakePage(o: { redirect?: boolean; ignoreViewport?: boolean; noSwiper?: boolean; main3xx?: boolean; serviceWorker?: boolean; popup?: boolean; noBrowser?: boolean; newContextThrows?: boolean } = {}) {
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
  if (!o.noSwiper) el.swiper = { el, activeIndex: 0, realIndex: 0, destroyed: false, enabled: true, autoplay: { running: true, stop() { this.running = false; calls.push("autoplay.stop"); } }, slideNext(speed: number) { calls.push(`slideNext:${speed}`); idx++; this.activeIndex = idx; this.realIndex = idx; w.document.getElementById("slide").textContent = `Slide ${idx}`; } };
  if (o.serviceWorker) w.navigator.serviceWorker = { controller: {} };
  let routeHandler: ((r: any) => Promise<unknown> | unknown) | null = null;
  let pageHandler: ((p: any) => void) | null = null;
  const guard: string[] = [];
  const network: string[] = []; // every request actually made upstream by route.fetch
  const mainFrame = {};
  const req = (url: string, nav: boolean, main = true) => ({ url: () => url, isNavigationRequest: () => nav, frame: () => (nav && main ? mainFrame : {}) });
  const route = async (url: string, nav: boolean, main = true) => {
    let outcome = "none";
    await routeHandler!({
      request: () => req(url, nav, main),
      abort: () => (guard.push(`abort ${url}`), (outcome = "abort")),
      continue: () => (guard.push(`continue ${url}`), (outcome = "continue")),
      fetch: async (opts: { maxRedirects: number; maxRetries: number }) => {
        calls.push(`route.fetch:${url}:maxRedirects=${opts.maxRedirects}:maxRetries=${opts.maxRetries}`);
        network.push(url); // maxRedirects 0: the Location target is never requested
        return { status: () => (o.main3xx ? 301 : 200), url: () => url, headers: () => (o.main3xx ? { location: "https://elsewhere.example/" } : {}) };
      },
      fulfill: (f: { response: { status: () => number } }) => (guard.push(`fulfill ${url} ${f.response.status()}`), (outcome = "fulfill")),
    });
    return outcome;
  };
  // the OWNED context (created by browser.newContext) and its single page
  const ownedContext = {
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
    },
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
      if ((await route(url, true)) === "abort") throw new Error("net::ERR_FAILED (main document aborted by route)");
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
      const first = { url: () => "https://bootstrapmade.com/old", redirectedFrom: () => null };
      const final = { url: () => url, redirectedFrom: () => (o.redirect ? first : null) };
      return { status: () => 200, request: () => final };
    },
    url: () => SANDBOX_URL,
    mainFrame: () => mainFrame,
    waitForTimeout: async () => {},
    // like Playwright: only the function SOURCE crosses into the page (no closure/outer helpers)
    evaluate: async (fn: (a: unknown) => unknown, arg: unknown) => w.eval(`(${fn.toString()})`)(JSON.parse(JSON.stringify(arg ?? null))),
    screenshot: async (s: { clip: { width: number; height: number } }) => {
      calls.push(`screenshot:${s.clip.width}x${Math.round(s.clip.height)}`);
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
    expect(code).toContain("await ctx.close()");
    expect(code).toContain("route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: W.navTimeoutMs })");
    expect(code.indexOf("route.fetch(")).toBeLessThan(code.indexOf("route.fulfill("));
    for (const gone of ["page.request", "accept-redirect-gap", "launch(", "page.goto", "page.setViewportSize", "persistent", "storageState"]) expect(code).not.toContain(gone);
    expect(code.indexOf("own.setViewportSize")).toBeLessThan(code.indexOf("own.goto"));
    expect(code.indexOf("ctx.newPage")).toBeLessThan(code.indexOf("own.setViewportSize"));
    expect(code).toContain('"host":"bootstrapmade.com"');
    expect(p.hardHold).toEqual([]);
    expect(SANDBOX_UNSUPPORTED).toEqual([]);
    expect(code).toContain(JSON.stringify(SANDBOX_URL));
    for (const banned of ["realViewport", "profile", ".click(", ".fill(", "keyboard", ".type(", "prompt", "addInitScript", "exposeFunction", "require(", "process.", "connectOverCDP"]) expect(code).not.toContain(banned);
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
    expect(p.calls.slice(0, 6)).toEqual([`newContext:{"serviceWorkers":"block","viewport":{"width":1920,"height":1080}}`, "context.route", "newPage", "viewport:1920x1080", `goto:${SANDBOX_URL}`, `route.fetch:${SANDBOX_URL}:maxRedirects=0:maxRetries=0`]);
    expect(p.calls.at(-1)).toBe("context.close");
    expect(p.calls).not.toContain("DEFAULT-PAGE-NAVIGATED");
    expect(p.network).toEqual([SANDBOX_URL]); // exactly one upstream main-document request, no pre-check duplicate
    expect(p.calls).toContain("autoplay.stop");
    expect(p.calls.filter((c) => c.startsWith("slideNext"))).toEqual(["slideNext:0", "slideNext:0"]);
    expect(p.guard).toEqual([
      `fulfill ${SANDBOX_URL} 200`,
      "abort https://bootstrapmade.com/popup",
      "continue https://bootstrapmade.com/content/vendors/aos/aos.js",
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
    ]);
    const r = parsed.result as any;
    expect(r.env).toMatchObject({ innerWidth: 1920, innerHeight: 1080 });
    expect(r.blocked.map((b: any) => b.why)).toEqual(["navigation-not-exact-target", "third-party-host", "third-party-host", "third-party-host", "ip-literal", "local-name", "navigation-not-exact-target", "navigation-not-exact-target", "navigation-not-exact-target", "scheme"]);
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
      [{ noSwiper: true }, /swiper refused: no Swiper instance bound/],
    ] as const) {
      const parsed = parseSandboxOutput(await runCode(fakePage(o)));
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.reason).toMatch(re);
    }
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
describe("documented /v2/interact transport over loopback: one fetch per lifecycle operation", () => {
  let server: Server;
  let base = "";
  const seen: { line: string; auth?: string; body: string }[] = [];
  let mode: Record<string, number | "hang" | "redirect" | "huge"> = {};
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
