// Viewport diagnostic: fixed 9-action/2-screenshot/4-probe request. Offline
// only: jsdom probes, fake clients and a REAL-SDK loopback server. No live
// provider, key, account or Figma calls.
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JSDOM, VirtualConsole } from "jsdom";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildDiagnosticPreview, diagnosticPreviewSha256, executeDiagnostic, interpretDiagnostic, probeScript, SCROLL_REPORT_SCRIPT, validateDiagnosticPreview, DIAG_URL } from "../src/states/diagnostic";
import { createStateScrapeClient, StateRunPolicyError, type StateScrapeClient } from "../src/states/execute";
import { initLedger, readLedger } from "../src/states/ledger";

const KEY = "fc-DIAGTESTKEY000000";
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "w2f-diag-"));
  dirs.push(d);
  return d;
};
const fakeIp = (asked: string[] = []) => async (h: string) => (asked.push(h), ["198.18.0.9"]);

function probe(tag: string, innerHeight: number, scrollY = 0) {
  return { w2f: "diag-probe", tag, innerWidth: 1920, innerHeight, rootClientWidth: 1905, rootClientHeight: innerHeight, visualViewport: { width: 1920, height: innerHeight, scale: 1, offsetTop: 0, pageTop: scrollY }, scrollY, documentHeight: 100000, devicePixelRatio: 1, readyState: "complete", features: { top: 70813 - scrollY, left: 0, width: 1920, height: 390, bottom: 71203 - scrollY, documentY: 70813 }, hero: { top: -scrollY, left: 0, width: 1920, height: 70000, bottom: 70000 - scrollY, documentY: 0 } };
}
function response(o: { persist?: boolean; credits?: number | null; drop?: "probe" | "shot" } = {}) {
  const h1 = o.persist ? 1080 : 100000;
  const sy = o.persist ? 3000 : 0;
  const returns = [probe("P0", 100000), probe("P1", h1), { w2f: "diag-scroll", requested: 3000, scrollY: sy, innerHeight: h1, documentHeight: 100000 }, probe("P2", h1, sy), probe("P3", h1, sy)].map((value) => ({ type: "object", value }));
  if (o.drop === "probe") returns.pop();
  const screenshots = ["https://shots.example.com/s1.png", "https://shots.example.com/s2.png"];
  if (o.drop === "shot") screenshots.pop();
  const metadata: Record<string, unknown> = { url: DIAG_URL, sourceURL: DIAG_URL, statusCode: 200, contentType: "text/html" };
  if (o.credits !== null) metadata.creditsUsed = o.credits ?? 1;
  return { metadata, rawHtml: "<html></html>", actions: { javascriptReturns: returns, screenshots, scrapes: [] } };
}
function setup() {
  const d = tmp();
  const ledgerPath = join(d, "ledger.json");
  initLedger(ledgerPath, 16, "operator-attributed prior project spend");
  return { ledgerPath, validated: validateDiagnosticPreview(clone(buildDiagnosticPreview())), gates: { operatorCreditsPerRequest: 1, operatorReportedBalance: 984, confirmExistingCredits: true, confirmNoTopup: true, ledgerPath } };
}

afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("fixed diagnostic preview", () => {
  it("is exactly 9 actions, 2 viewport screenshots, 4 probes + scroll report, 3000 ms of waits", () => {
    const p = buildDiagnosticPreview();
    expect(p.body.url).toBe("https://bootstrapmade.com/content/demo/Bootslander/");
    expect(Object.keys(p.body).sort()).toEqual(["actions", "formats", "onlyMainContent", "proxy", "timeout", "url"]);
    expect(p.body).toMatchObject({ formats: ["rawHtml"], onlyMainContent: false, proxy: "basic", timeout: 60_000 });
    expect(p.body.actions.map((a) => a.type)).toEqual(["wait", "executeJavascript", "screenshot", "executeJavascript", "executeJavascript", "wait", "executeJavascript", "screenshot", "executeJavascript"]);
    expect(p.body.actions.filter((a) => a.type === "screenshot")).toEqual([
      { type: "screenshot", fullPage: false, viewport: { width: 1920, height: 1080 } },
      { type: "screenshot", fullPage: false, viewport: { width: 1920, height: 1080 } },
    ]);
    expect(p.body.actions.filter((a) => a.type === "wait").map((a) => a.milliseconds)).toEqual([2000, 1000]);
    expect(p.roles.map((r) => r.tag ?? r.role)).toEqual(["wait", "P0", "S1", "P1", "scroll", "wait", "P2", "S2", "P3"]);
    const all = JSON.stringify(p);
    // no internal/device/top-level viewport fields, no extra waits/formats/state machinery (devicePixelRatio is a probe READ)
    for (const banned of ["realViewport", "\"device", "\"mobile", "waitFor", "fullPage\":true", "swiper", "aos", "freeze", "threatProtection"]) expect(all.toLowerCase()).not.toContain(banned.toLowerCase());
    for (const a of p.body.actions.filter((x) => x.type === "executeJavascript")) {
      expect(a.script).toMatch(/^\(function w2fDiag(Probe|Scroll)\(\) \{[\s\S]*\}\)\(\);$/);
      expect(a.script).not.toMatch(/\basync\b|\bawait\b|setTimeout|Promise|fetch|click|setAttribute|appendChild|innerHTML|classList/);
    }
    expect(diagnosticPreviewSha256()).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects any deviation from the exact preview (no validator bypass)", () => {
    const bad = (mut: (p: any) => void) => {
      const p = clone(buildDiagnosticPreview()) as any;
      mut(p);
      return () => validateDiagnosticPreview(p);
    };
    expect(bad((p) => p.body.actions.push({ type: "screenshot", fullPage: false }))).toThrow(StateRunPolicyError);
    expect(bad((p) => (p.body.actions[2].viewport.height = 100000))).toThrow(/does not match/);
    expect(bad((p) => (p.body.actions[2].fullPage = true))).toThrow(/does not match/);
    expect(bad((p) => (p.body.actions[1].realViewport = true))).toThrow(/does not match/);
    expect(bad((p) => (p.body.actions[1].script = "(function(){ document.querySelector('a').click(); })();"))).toThrow(/does not match/);
    expect(bad((p) => (p.body.url = "https://www.bootstrapmade.com/content/demo/Bootslander/"))).toThrow(/does not match/);
    expect(bad((p) => (p.body.formats = ["rawHtml", "screenshot"]))).toThrow(/does not match/);
  });
});

describe("probe scripts in jsdom (synchronous, read-only)", () => {
  it("report layout viewport, root client box, visual viewport and document height separately", () => {
    const d = new JSDOM(`<!doctype html><html><body><section id="hero"></section><section id="features"></section></body></html>`, { runScripts: "outside-only", virtualConsole: new VirtualConsole(), url: DIAG_URL });
    const w = d.window as any;
    Object.defineProperty(w, "innerHeight", { value: 100000 });
    Object.defineProperty(w.document.documentElement, "clientHeight", { get: () => 99985 });
    Object.defineProperty(w.document.documentElement, "scrollHeight", { get: () => 100000 });
    w.visualViewport = { width: 1920, height: 1080, scale: 1, offsetTop: 0, pageTop: 0 };
    w.scrollTo = () => {};
    const before = w.document.documentElement.outerHTML;
    const r = w.eval(probeScript("P0"));
    expect(r).not.toBeInstanceOf(w.Promise);
    expect(r).toMatchObject({ w2f: "diag-probe", tag: "P0", innerHeight: 100000, rootClientHeight: 99985, visualViewport: { height: 1080 }, documentHeight: 100000 });
    expect(typeof r.readyState).toBe("string");
    expect(Object.keys(r.features)).toEqual(["top", "left", "width", "height", "bottom", "documentY"]);
    expect(w.document.documentElement.outerHTML).toBe(before); // read-only
    expect(w.eval(SCROLL_REPORT_SCRIPT)).toMatchObject({ w2f: "diag-scroll", requested: 3000 });
  });
});

describe("execution with a fake client (one POST, ledger before/after, stops)", () => {
  const client = (doc: () => unknown, events: string[], ledgerPath?: string): StateScrapeClient => ({
    async scrape(url, options) {
      events.push(`scrape:${url}:${options.autoResume}`);
      if (ledgerPath) events.push(`ledger:${readLedger(ledgerPath).entries.at(-1)!.status}`);
      const d = doc();
      if (d instanceof Error) throw d;
      return d;
    },
  });

  it("guard -> key -> client -> ledger attempt -> single POST -> accepted record (exempt host, no DNS)", async () => {
    const s = setup();
    const events: string[] = [];
    const asked: string[] = [];
    const saved: any[] = [];
    const rec = await executeDiagnostic({ ...s, resolver: fakeIp(asked), getApiKey: () => (events.push("key"), KEY), createClient: async () => (events.push("client"), client(() => response({ persist: true }), events, s.ledgerPath)), save: (w) => saved.push(w) });
    expect(events).toEqual(["key", "client", `scrape:${DIAG_URL}:false`, "ledger:attempting"]);
    expect(asked).toEqual([]);
    expect(rec).toMatchObject({ status: "accepted", attempts: 1, retries: 0, reportedCreditsUsed: 1 });
    expect(rec.probes.map((p) => p.tag)).toEqual(["P0", "P1", "P2", "P3"]);
    expect(rec.screenshots).toHaveLength(2);
    expect(readLedger(s.ledgerPath).entries.at(-1)).toMatchObject({ status: "succeeded", reportedCredits: 1, command: "diag-run" });
    expect(JSON.stringify(saved)).not.toContain(KEY);
  });

  it("missing gate: nothing happens; partial probes / one screenshot / no credits / 5xx: ambiguous, never retried", async () => {
    const s0 = setup();
    const ev: string[] = [];
    await expect(executeDiagnostic({ ...s0, gates: { ...s0.gates, confirmNoTopup: false }, getApiKey: () => (ev.push("key"), KEY) })).rejects.toThrow(/confirm-no-topup/);
    expect(ev).toEqual([]);
    for (const [o, re] of [
      [{ drop: "probe" as const }, /expected 5 javascriptReturns, got 4/],
      [{ drop: "shot" as const }, /expected 2 screenshot URLs, got 1/],
    ] as const) {
      const s = setup();
      const e: string[] = [];
      const r = await executeDiagnostic({ ...s, resolver: fakeIp(), getApiKey: () => KEY, createClient: async () => client(() => response(o), e) });
      expect(r.status).toBe("ambiguous");
      expect(r.reason).toMatch(re);
      expect(e.filter((x) => x.startsWith("scrape"))).toHaveLength(1);
    }
    const s1 = setup();
    const r1 = await executeDiagnostic({ ...s1, resolver: fakeIp(), getApiKey: () => KEY, createClient: async () => client(() => response({ credits: null }), []) });
    expect(r1.warnings.join()).toMatch(/credits are UNKNOWN/);
    expect(readLedger(s1.ledgerPath).entries.at(-1)!.status).toBe("ambiguous");
    const s2 = setup();
    const e2: string[] = [];
    const r2 = await executeDiagnostic({ ...s2, resolver: fakeIp(), getApiKey: () => KEY, createClient: async () => client(() => Object.assign(new Error(`502 for ${KEY}`), { status: 502 }), e2) });
    expect(r2.status).toBe("ambiguous");
    expect(e2.filter((x) => x.startsWith("scrape"))).toHaveLength(1);
    expect(JSON.stringify(r2)).not.toContain(KEY);
    // the identical request is never repeated automatically
    await expect(executeDiagnostic({ ...s2, resolver: fakeIp(), getApiKey: () => KEY, createClient: async () => client(() => response(), []) })).rejects.toThrow(/unresolved/);
  });

  it("a redirected final URL is rejected", async () => {
    const s = setup();
    const d = response() as any;
    d.metadata.url = "https://bootstrapmade.com/content/demo/Other/";
    const r = await executeDiagnostic({ ...s, resolver: fakeIp(), getApiKey: () => KEY, createClient: async () => client(() => d, []) });
    expect(r).toMatchObject({ status: "rejected" });
    expect(r.reason).toMatch(/not the diagnostic page/);
  });
});

describe("real installed SDK over loopback (one POST)", () => {
  let server: Server;
  let base = "";
  let posts: any[] = [];
  let mode: "ok" | "502" = "ok";
  beforeAll(async () => {
    process.env.NO_PROXY = "127.0.0.1,localhost";
    server = createServer((req, res) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => {
        posts.push(JSON.parse(b || "{}"));
        res.writeHead(mode === "ok" ? 200 : 502, { "content-type": "application/json" });
        res.end(JSON.stringify(mode === "ok" ? { success: true, data: response({ persist: false }) } : { success: false, error: "bad gateway" }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });

  it("success: exactly one POST whose body equals the preview body (+ SDK origin)", async () => {
    posts = [];
    mode = "ok";
    const s = setup();
    const rec = await executeDiagnostic({ ...s, resolver: fakeIp(), getApiKey: () => KEY, createClient: (k) => createStateScrapeClient(k, base) });
    expect(rec.status).toBe("accepted");
    expect(posts).toHaveLength(1);
    const { origin, ...sent } = posts[0];
    expect(typeof origin).toBe("string");
    expect(sent).toEqual(s.validated.preview.body);
  });

  it("502: exactly one POST, ambiguous", async () => {
    posts = [];
    mode = "502";
    const s = setup();
    const rec = await executeDiagnostic({ ...s, resolver: fakeIp(), getApiKey: () => KEY, createClient: (k) => createStateScrapeClient(k, base) });
    expect(rec.status).toBe("ambiguous");
    expect(posts).toHaveLength(1);
  });
});

describe("offline interpretation (evidence categories, not proofs)", () => {
  const rec = (persist: boolean) => {
    const r = response({ persist }) as any;
    const v = r.actions.javascriptReturns.map((x: any) => x.value);
    const probes = v.filter((x: any) => x.w2f === "diag-probe").map((x: any) => ({ ...x }));
    const s = v.find((x: any) => x.w2f === "diag-scroll");
    return { probes, scroll: { requested: 3000, scrollY: s.scrollY, innerHeight: s.innerHeight, documentHeight: s.documentHeight } };
  };
  it("persisting resize + scroll", () => {
    const f = interpretDiagnostic(rec(true), [{ width: 1920, height: 1080 }, { width: 1920, height: 1080 }]);
    expect(f).toMatchObject({ viewportExpandedAtP0: true, resizeAfterS1: "persisted", scrollMoved: "yes", conclusion: "screenshot-viewport-resizes-and-persists" });
    expect(f.crops[0]!.matches).toContain("after.innerHeight");
    expect(f.notes.join(" ")).toMatch(/do not prove scrolling/);
  });
  it("no persistence, no scroll; crop matches no probe height", () => {
    const f = interpretDiagnostic(rec(false), [{ width: 1920, height: 1080 }, null]);
    expect(f).toMatchObject({ resizeAfterS1: "not-persisted", scrollMoved: "no", conclusion: "screenshot-viewport-does-not-persist" });
    expect(f.crops).toEqual([{ shot: "S1", width: 1920, height: 1080, matches: [] }]);
  });
  it("missing data is inconclusive", () => {
    expect(interpretDiagnostic({ probes: [], scroll: null }).conclusion).toBe("inconclusive");
  });
});

describe("CLI (offline): plan writes the preview; run HOLDS without --yes", () => {
  it("diag-plan + diag-run HOLD", () => {
    const d = tmp();
    const cli = (args: string[]) => {
      try {
        return { code: 0, out: execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], { encoding: "utf8", env: { ...process.env, FIRECRAWL_API_KEY: KEY }, stdio: ["ignore", "pipe", "pipe"] }) };
      } catch (e: any) {
        return { code: e.status as number, out: `${e.stdout}${e.stderr}` };
      }
    };
    expect(cli(["diag-plan", "--out", join(d, "preview.json")]).out).toContain(diagnosticPreviewSha256());
    expect(JSON.parse(readFileSync(join(d, "preview.json"), "utf8"))).toEqual(buildDiagnosticPreview());
    initLedger(join(d, "ledger.json"), 16, "prior");
    const r = cli(["diag-run", "--preview", join(d, "preview.json"), "--out", join(d, "runs"), "--ledger", join(d, "ledger.json"), "--operator-credits-per-request", "1", "--operator-reported-balance", "984", "--confirm-existing-credits", "--confirm-no-topup"]);
    expect(r.code).toBe(3);
    expect(r.out).toMatch(/HOLD: nothing was sent and no key was read/);
    expect(r.out).not.toContain(KEY);
    expect(existsSync(join(d, "runs"))).toBe(false);
  }, 60_000);
});
