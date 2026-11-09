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
import Firecrawl from "@mendable/firecrawl-js";
import { buildSandboxPreview, createSandboxClient, executeSandbox, parseSandboxOutput, sandboxPreviewSha256, sandboxToCapture, validateSandboxPreview, cleanupSandbox, SANDBOX, SANDBOX_CODE, SANDBOX_URL, SANDBOX_WORST_CASE_CREDITS, type SandboxClient } from "../src/states/sandbox";
import { StateRunPolicyError } from "../src/states/execute";
import { initLedger, readLedger } from "../src/states/ledger";
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
function fakePage(o: { redirect?: boolean; ignoreViewport?: boolean; noSwiper?: boolean } = {}) {
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
  let routeHandler: ((r: any) => unknown) | null = null;
  const guard: string[] = [];
  const mainFrame = {};
  const req = (url: string, nav: boolean) => ({ url: () => url, isNavigationRequest: () => nav, frame: () => (nav ? mainFrame : {}) });
  const route = (url: string, nav: boolean) => routeHandler!({ request: () => req(url, nav), abort: () => guard.push(`abort ${url}`), continue: () => guard.push(`continue ${url}`) });
  const page = {
    route: async (_p: string, h: (r: any) => unknown) => {
      calls.push("route");
      routeHandler = h;
    },
    setViewportSize: async (s: { width: number; height: number }) => {
      calls.push(`viewport:${s.width}x${s.height}`);
      if (!o.ignoreViewport) {
        vw = s.width;
        vh = s.height;
      }
    },
    goto: async (url: string) => {
      calls.push(`goto:${url}`);
      route(url, true);
      // synthetic subresources and attempts the guard must refuse
      route("https://bootstrapmade.com/content/vendors/aos/aos.js", false);
      route("http://169.254.169.254/latest/meta-data", false);
      route("http://localhost:8080/x", false);
      route("https://evil.example/", true);
      route("file:///etc/passwd", false);
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
  return { page, calls, guard };
}
async function runCode(p: ReturnType<typeof fakePage>) {
  const lines: string[] = [];
  await new AsyncFunction("page", "console", SANDBOX_CODE)(p.page, { log: (s: string) => lines.push(s) });
  return { success: true, stdout: lines.join("\n"), exitCode: 0, killed: false, truncated: false };
}

describe("fixed sandbox preview", () => {
  it("creates with ttl/activityTtl only (no profile/location/blockAds override), node code, viewport before navigation", () => {
    const p = buildSandboxPreview();
    expect(p.create).toEqual({ ttl: 120, activityTtl: 60, streamWebView: false });
    expect(p.execute).toMatchObject({ language: "node", timeout: 90 });
    expect(p.reservation.worstCaseCredits).toBe(SANDBOX_WORST_CASE_CREDITS);
    expect(SANDBOX_WORST_CASE_CREDITS).toBe(4);
    const code = p.execute.code;
    expect(code.indexOf("page.setViewportSize")).toBeLessThan(code.indexOf("page.goto"));
    expect(code.indexOf("page.route")).toBeLessThan(code.indexOf("page.goto"));
    expect(code).toContain(JSON.stringify(SANDBOX_URL));
    for (const banned of ["realViewport", "profile", ".click(", ".fill(", "keyboard", ".type(", "prompt", "newPage", "addInitScript", "exposeFunction", "require(", "process.", "fetch(", "connectOverCDP"]) expect(code).not.toContain(banned);
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
    expect(p.calls.slice(0, 3)).toEqual(["route", "viewport:1920x1080", `goto:${SANDBOX_URL}`]);
    expect(p.calls).toContain("autoplay.stop");
    expect(p.calls.filter((c) => c.startsWith("slideNext"))).toEqual(["slideNext:0", "slideNext:0"]);
    expect(p.guard).toEqual([
      `continue ${SANDBOX_URL}`,
      "continue https://bootstrapmade.com/content/vendors/aos/aos.js",
      "abort http://169.254.169.254/latest/meta-data",
      "abort http://localhost:8080/x",
      "abort https://evil.example/",
      "abort file:///etc/passwd",
    ]);
    const r = parsed.result as any;
    expect(r.env).toMatchObject({ innerWidth: 1920, innerHeight: 1080 });
    expect(r.blocked.map((b: any) => b.why)).toEqual(["ip-literal", "local-name", "main-frame-navigation-off-target", "scheme"]);
    expect(r.states.map((s: any) => [s.seq, s.name, s.measured.target.selector, s.measured.region.y])).toEqual([[0, "Default", "#testimonials", 4000], [1, "Testimonial next", "#testimonials", 4000], [2, "Testimonial next 2", "#testimonials", 4000]]);
    expect(r.states.map((s: any) => s.measured.texts.find((t: any) => t.text.startsWith("Slide")).text)).toEqual(["Slide 0", "Slide 1", "Slide 2"]);
    expect(r.states[1].trigger).toMatchObject({ valid: true, moved: true, before: { realIndex: 0 }, after: { realIndex: 1 } });
    expect(r.states[0].measured.probe).toMatchObject({ scrollY: 4000, innerHeight: 1080 });
    expect(parsed.pngs).toHaveLength(3);
  });
  it("refuses a redirect chain, an unapplied viewport, and a missing Swiper (fail closed, still emits a result)", async () => {
    for (const [o, re] of [
      [{ redirect: true }, /navigation left the exact target URL/],
      [{ ignoreViewport: true }, /viewport not applied: 1920x100000/],
      [{ noSwiper: true }, /swiper refused: no Swiper instance bound/],
    ] as const) {
      const parsed = parseSandboxOutput(await runCode(fakePage(o)));
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.reason).toMatch(re);
    }
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
  return { d, ledgerPath, validated: validateSandboxPreview(clone(buildSandboxPreview())), gates: { operatorCreditsPerRequest: 4, operatorReportedBalance: 983, confirmExistingCredits: true, confirmNoTopup: true, confirmTtlSeconds: true, ledgerPath } };
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

describe("lifecycle (fake client): ledger before each op, one attempt each, delete always", () => {
  it("guard -> key -> client -> ledger -> create -> execute -> delete; accepted, creditsBilled recorded", async () => {
    const s = setup();
    const events: string[] = [];
    const asked: string[] = [];
    const pngs: number[] = [];
    const rec = await executeSandbox({ ...s, resolver: fakeIp(asked), getApiKey: () => (events.push("key"), KEY), createClient: async () => (events.push("client"), client(events, s.ledgerPath)), savePng: (i) => pngs.push(i) });
    expect(events).toEqual(["key", "client", `create {"ttl":120,"activityTtl":60,"streamWebView":false} [attempting/create:attempting]`, "execute sess_1 node [attempting/execute:attempting]", "delete sess_1 [attempting/delete:attempting]"]);
    expect(asked).toEqual([]); // exact bootstrapmade.com hosted exception: no local DNS
    expect(rec).toMatchObject({ status: "accepted", sessionId: "sess_1", creditsBilled: 1 });
    expect(rec.ops.map((o) => `${o.op}:${o.status}:${o.attempts}`)).toEqual(["create:ok:1", "execute:ok:1", "delete:ok:1"]);
    expect(pngs).toEqual([0, 1, 2]);
    const e = readLedger(s.ledgerPath).entries.at(-1)!;
    expect(e).toMatchObject({ status: "succeeded", reserved: 4, reportedCredits: 1, command: "sandbox-run" });
    expect(e.ops!.map((o) => `${o.op}:${o.status}`)).toEqual(["create:attempting", "create:ok", "execute:attempting", "execute:ok", "delete:attempting", "delete:ok"]);
    expect(JSON.stringify(rec)).not.toContain(KEY);
  });

  it("ambiguous create: no execute, no delete, no re-create; entry blocks", async () => {
    const s = setup();
    const events: string[] = [];
    const rec = await executeSandbox({ ...s, resolver: fakeIp(), getApiKey: () => KEY, createClient: async () => client(events, s.ledgerPath, { create: Object.assign(new Error(`upstream 502 ${KEY}`), { status: 502 }) }) });
    expect(events.map((x) => x.split(" ")[0])).toEqual(["create"]);
    expect(rec).toMatchObject({ status: "ambiguous", sessionId: null });
    expect(rec.reason).toMatch(/no automatic re-create/);
    expect(JSON.stringify(rec)).not.toContain(KEY);
    await expect(executeSandbox({ ...s, resolver: fakeIp(), getApiKey: () => KEY, createClient: async () => client([], s.ledgerPath) })).rejects.toThrow(/unresolved/);
  });

  it("execute error/killed/truncated: delete still runs once; outcome never retried", async () => {
    for (const ex of [Object.assign(new Error("gateway"), { status: 502 }), Object.assign(new Error("timeout"), { status: 408 }), { success: true, stdout: "", killed: true }, { success: true, stdout: "W2F_RESULT {", truncated: true }]) {
      const s = setup();
      const events: string[] = [];
      const rec = await executeSandbox({ ...s, resolver: fakeIp(), getApiKey: () => KEY, createClient: async () => client(events, s.ledgerPath, { execute: ex }) });
      expect(events.map((x) => x.split(" ")[0])).toEqual(["create", "execute", "delete"]);
      expect(rec.status).toBe("ambiguous");
      expect(readLedger(s.ledgerPath).entries.at(-1)!.status).toBe("ambiguous");
    }
  });

  it("failed cleanup: ambiguous and blocking; sandbox-cleanup sends exactly one DELETE for the recorded session", async () => {
    const s = setup();
    const events: string[] = [];
    const rec = await executeSandbox({ ...s, resolver: fakeIp(), getApiKey: () => KEY, createClient: async () => client(events, s.ledgerPath, { del: Object.assign(new Error("boom"), { status: 500 }) }) });
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

  it("missing creditsBilled => ambiguous; gates fail closed before key/client; reservation must cover the ttl worst case", async () => {
    const s = setup();
    const rec = await executeSandbox({ ...s, resolver: fakeIp(), getApiKey: () => KEY, createClient: async () => client([], s.ledgerPath, { del: { success: true } }) });
    expect(rec.warnings.join()).toMatch(/credits are UNKNOWN/);
    expect(readLedger(s.ledgerPath).entries.at(-1)!.status).toBe("ambiguous");
    const t = setup();
    const ev: string[] = [];
    for (const g of [{ confirmTtlSeconds: false }, { operatorCreditsPerRequest: 3 }, { confirmNoTopup: false }]) {
      await expect(executeSandbox({ ...t, gates: { ...t.gates, ...g }, getApiKey: () => (ev.push("key"), KEY) })).rejects.toThrow(StateRunPolicyError);
    }
    expect(ev).toEqual([]);
  });
});

// ---------------- real SDK over loopback ----------------
describe("real installed SDK over loopback: one attempt per lifecycle operation", () => {
  let server: Server;
  let base = "";
  const seen: string[] = [];
  let mode: Record<string, number | "hang"> = {};
  beforeAll(async () => {
    process.env.NO_PROXY = "127.0.0.1,localhost";
    server = createServer((req, res) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", async () => {
        const op = req.method === "DELETE" ? "delete" : req.url!.endsWith("/execute") ? "execute" : "create";
        seen.push(`${req.method} ${req.url}`);
        const m = mode[op];
        if (m === "hang") return;
        if (typeof m === "number") {
          res.writeHead(m, { "content-type": "application/json" });
          return res.end(JSON.stringify(m === 408 ? { success: false, code: "SCRAPE_TIMEOUT", details: { state: "processing_continues", retryAfterSeconds: 1 } } : { success: false, error: "x" }));
        }
        res.writeHead(200, { "content-type": "application/json" });
        if (op === "create") return res.end(JSON.stringify({ success: true, id: "sess_lb", expiresAt: "2026-11-08T23:59:00Z" }));
        if (op === "execute") return res.end(JSON.stringify(await goodExecute()));
        return res.end(JSON.stringify({ success: true, status: "destroyed", sessionDurationMs: 9000, creditsBilled: 1 }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  const run = async () => {
    const s = setup();
    return executeSandbox({ ...s, resolver: fakeIp(), getApiKey: () => KEY, createClient: (k) => createSandboxClient(k, base) });
  };

  it("happy path: exactly POST create, POST execute, DELETE, in order", async () => {
    seen.length = 0;
    mode = {};
    const rec = await run();
    expect(rec.status).toBe("accepted");
    expect(seen).toEqual(["POST /v2/browser", "POST /v2/browser/sess_lb/execute", "DELETE /v2/browser/sess_lb"]);
  });
  it("5xx/408 on each operation: one attempt each, no replay; create failure skips execute/delete", async () => {
    for (const [m, expected] of [
      [{ create: 502 }, ["POST /v2/browser"]],
      [{ create: 500 }, ["POST /v2/browser"]],
      [{ execute: 502 }, ["POST /v2/browser", "POST /v2/browser/sess_lb/execute", "DELETE /v2/browser/sess_lb"]],
      [{ execute: 408 }, ["POST /v2/browser", "POST /v2/browser/sess_lb/execute", "DELETE /v2/browser/sess_lb"]],
      [{ delete: 502 }, ["POST /v2/browser", "POST /v2/browser/sess_lb/execute", "DELETE /v2/browser/sess_lb"]],
    ] as const) {
      seen.length = 0;
      mode = { ...m };
      const rec = await run();
      expect(seen).toEqual(expected);
      expect(rec.status).toBe("ambiguous");
    }
  });
  it("timeouts are single attempts (real SDK, short client timeout)", { timeout: 30_000 }, async () => {
    seen.length = 0;
    mode = { create: "hang" };
    const fc = new Firecrawl({ apiKey: KEY, apiUrl: base, timeoutMs: 800, maxRetries: 1 });
    await expect(fc.browser({ ttl: 120 })).rejects.toBeTruthy();
    expect(seen).toEqual(["POST /v2/browser"]);
    seen.length = 0;
    mode = { execute: "hang" };
    await expect(fc.browserExecute("sess_lb", { code: "1", language: "node", timeout: 1 })).rejects.toBeTruthy();
    expect(seen).toEqual(["POST /v2/browser/sess_lb/execute"]);
    seen.length = 0;
    mode = { delete: "hang" };
    await expect(fc.deleteBrowser("sess_lb")).rejects.toBeTruthy();
    expect(seen).toEqual(["DELETE /v2/browser/sess_lb"]);
  });
});

describe("offline conversion: one region, valid 3-state group", () => {
  it("sandbox record -> capture -> hifi: 3 page-api/baseline variants of #testimonials with screenshots", async () => {
    const s = setup();
    const files: Record<number, Uint8Array> = {};
    const rec = await executeSandbox({ ...s, resolver: fakeIp(), getApiKey: () => KEY, createClient: async () => client([], s.ledgerPath), savePng: (i, b) => (files[i] = b) });
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
