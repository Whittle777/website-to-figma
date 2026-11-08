// Hosted state-run executor, ledger, output and acquisition tests. FAKE
// clients, resolvers and transports only: no network, no key, no account call.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildStatePreview } from "../src/states/plan";
import { assertRunGates, executeStateRun, StateRunPolicyError, validateForExecution, type RunGates, type StateScrapeClient } from "../src/states/execute";
import { initLedger, readLedger, reserveAttempt, resolveEntry, unresolved, withLedgerLock, LedgerError } from "../src/states/ledger";
import { createExclusiveDir, writeExclusive } from "../src/states/runFiles";
import { acquireImage, pinnedLookup, type ImageTransport } from "../src/states/acquire";
import { syntheticStateResponse } from "../src/fixtures/statesSynthetic";
import { syntheticPng } from "../src/fixtures/hifiSynthetic";
import { captureFromScrapeResponses } from "../src/hifi/adapter";
import { convertCapture, CaptureError } from "../src/hifi/convert";
import { parseStatePlan } from "../src/states/plan";

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "w2f-run-"));
  dirs.push(d);
  return d;
};
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const KEY = "fc-SECRETSECRETSECRET123";
const publicDns = (asked: string[] = []) => async (h: string) => {
  asked.push(h);
  return ["93.184.215.14"];
};
const fakeIpDns = (asked: string[] = []) => async (h: string) => {
  asked.push(h);
  return ["198.18.0.7"];
};

const plan = (site = "https://example.com", paths = ["/"]) => ({
  schema: "website-to-figma/state-plan",
  schemaVersion: 1,
  site,
  pages: paths.map((p) => ({
    url: `${site}${p}`,
    states: [
      { name: "FAQ open", scope: "#faq", mutations: [{ mechanism: "details-open", selector: "#faq details" }] },
      { name: "Tab two", mutations: [{ mechanism: "attribute-set", selector: "#tab2", attribute: "aria-selected", value: "true" }] },
    ],
  })),
});
const previewOf = (p: unknown) => clone(buildStatePreview(parseStatePlan(p)));

// Document as the SDK returns it (res.data.data), for a given page URL.
function doc(url: string, credits: number | null = 1): Record<string, any> {
  const d = clone((syntheticStateResponse() as any).data);
  d.metadata.url = url;
  d.metadata.sourceURL = url;
  d.metadata.statusCode = 200;
  if (credits !== null) d.metadata.creditsUsed = credits;
  for (const r of d.actions.javascriptReturns) if (r.value.measured) r.value.measured.url = url;
  return d;
}

function setup(p = plan(), opts: { prior?: number } = {}) {
  const dir = tmp();
  const ledgerPath = join(dir, "ledger.json");
  initLedger(ledgerPath, opts.prior ?? 15, "operator-attributed prior project spend (8 crawl + 7 scrapes)");
  const validated = validateForExecution(p, previewOf(p));
  const gates: RunGates = { operatorCreditsPerRequest: 1, operatorReportedBalance: 900, confirmExistingCredits: true, confirmNoTopup: true, acknowledgeSyntheticModifications: true, ledgerPath };
  return { dir, ledgerPath, validated, gates };
}

function fakeClient(responses: (url: string) => unknown, events: string[], ledgerPath?: string): { client: StateScrapeClient; calls: { url: string; options: Record<string, unknown> }[] } {
  const calls: { url: string; options: Record<string, unknown> }[] = [];
  return {
    calls,
    client: {
      async scrape(url, options) {
        events.push("scrape");
        // the paid attempt must already be persisted when the request is sent
        if (ledgerPath) events.push(`ledger-at-send:${readLedger(ledgerPath).entries.at(-1)!.status}`);
        calls.push({ url, options });
        const r = responses(url);
        if (r instanceof Error) throw r;
        return r;
      },
    },
  };
}

describe("pre-execution validation (no network, no key)", () => {
  it("accepts only the exact rebuilt preview", () => {
    const p = plan();
    const v = validateForExecution(p, previewOf(p));
    expect(v.requests).toHaveLength(1);
    expect(v.requests[0]!.preview.actionCount).toBe(14);
    expect(v.requests[0]!.requestSha256).toMatch(/^[0-9a-f]{64}$/);
    const tampered = (mut: (d: any) => void) => {
      const d = previewOf(p) as any;
      mut(d);
      return () => validateForExecution(p, d);
    };
    expect(tampered((d) => d.requests[0].body.formats.push("json"))).toThrow(StateRunPolicyError);
    expect(tampered((d) => d.requests[0].body.actions.push({ type: "click", selector: "#buy" }))).toThrow(/does not match/);
    expect(tampered((d) => (d.requests[0].body.proxy = "stealth"))).toThrow(/does not match/);
    expect(tampered((d) => (d.requests[0].body.threatProtection = { enabled: false }))).toThrow(/does not match/);
    expect(tampered((d) => (d.requests[0].body.actions[1].script += ";document.querySelector('a').click()"))).toThrow(/does not match/);
  });

  it("every missing operator gate refuses before any key/client/request", () => {
    const { validated, gates } = setup();
    for (const k of ["operatorCreditsPerRequest", "operatorReportedBalance", "confirmExistingCredits", "confirmNoTopup", "acknowledgeSyntheticModifications", "ledgerPath"] as const) {
      const g = { ...gates, [k]: undefined };
      expect(() => assertRunGates(validated, g)).toThrow(StateRunPolicyError);
    }
    expect(() => assertRunGates(validated, { ...gates, operatorReportedBalance: 0 })).toThrow(/exceeds the operator-reported balance/);
    expect(() => assertRunGates(validated, { ...gates, operatorCreditsPerRequest: 0 })).toThrow(/operator-credits-per-request/);
  });

  it("executeStateRun with a missing gate never asks for the key, builds a client, or resolves DNS", async () => {
    const { validated, gates } = setup();
    const events: string[] = [];
    await expect(
      executeStateRun({ validated, gates: { ...gates, confirmNoTopup: false }, resolver: publicDns(events), getApiKey: () => (events.push("key"), KEY), createClient: async () => (events.push("client"), fakeClient(() => doc("https://example.com/"), events).client) }),
    ).rejects.toThrow(StateRunPolicyError);
    expect(events).toEqual([]);
  });

  it("ledger projection over the 1000-credit local ceiling refuses before anything", async () => {
    const { validated, gates } = setup(plan(), { prior: 1000 });
    const events: string[] = [];
    await expect(executeStateRun({ validated, gates, resolver: publicDns(events), getApiKey: () => (events.push("key"), KEY) })).rejects.toThrow(/project budget ceiling .*not a provider cap/);
    expect(events).toEqual([]);
  });
});

describe("executor with a fake client (one attempt, ledger before/after)", () => {
  it("orders guard -> key -> client -> ledger attempt -> single request -> ledger result", async () => {
    const { validated, gates, ledgerPath } = setup();
    const events: string[] = [];
    const saved: Record<string, any>[] = [];
    const f = fakeClient(() => doc("https://example.com/"), events, ledgerPath);
    const res = await executeStateRun({ validated, gates, resolver: publicDns(events), getApiKey: () => (events.push("key"), KEY), createClient: async (k) => (events.push(`client:${k === KEY}`), f.client), save: (_i, w) => saved.push(w) });
    expect(events).toEqual(["example.com", "key", "client:true", "scrape", "ledger-at-send:attempting", "example.com"]);
    expect(f.calls).toHaveLength(1);
    const { url, options } = f.calls[0]!;
    expect(url).toBe("https://example.com/");
    expect(options).toMatchObject({ autoResume: false, formats: ["rawHtml"], proxy: "basic" });
    expect(options.url).toBeUndefined();
    expect(options.threatProtection).toBeUndefined();
    expect(res.pages[0]).toMatchObject({ status: "accepted", attempts: 1, retries: 0, reportedCreditsUsed: 1 });
    expect(res.pages[0]!.checkpoints.map((c) => c.step)).toEqual(["validated", "url-guard-passed", "ledger-attempt-recorded", "request-sent", "response-received", "response-accepted", "ledger-result-recorded", "saved"]);
    expect(res.pages[0]!.freeze).toMatchObject({ w2f: "freeze" });
    expect(res.pages[0]!.states.map((s) => [s.name, s.provenance, s.applied])).toEqual([["Default", "baseline", 0], ["FAQ open", "synthetic", 1], ["Tab two", "synthetic", 1]]);
    const l = readLedger(ledgerPath);
    expect(l.entries.map((e) => [e.status, e.reserved, e.reportedCredits])).toEqual([["prior", 15, 15], ["succeeded", 1, 1]]);
    // saved wrapper -> hifi-capture -> hifi with run provenance; no key anywhere
    expect(JSON.stringify(saved)).not.toContain(KEY);
    const cap = captureFromScrapeResponses([{ name: "page-0.response.json", json: saved[0] }], "run");
    const v2 = convertCapture({ capture: cap.capture, assets: [], assetWarnings: [] });
    expect(v2.pages[0]!.notes!.join(" ")).toMatch(/Hosted state run [0-9a-f]+: 1 request, attempts 1, no retries; .*request-specific credits 1/);
    expect(v2.pages[0]!.states!.variants.map((x) => x.provenance)).toEqual(["baseline", "synthetic", "synthetic"]);
  });

  it("no key after all guards: nothing sent, no ledger attempt", async () => {
    const { validated, gates, ledgerPath } = setup();
    const events: string[] = [];
    const res = await executeStateRun({ validated, gates, resolver: publicDns(), getApiKey: () => undefined, createClient: async () => (events.push("client"), fakeClient(() => null, events).client) });
    expect(events).toEqual([]);
    expect(res.pages[0]!.status).toBe("not-attempted");
    expect(readLedger(ledgerPath).entries).toHaveLength(1);
  });

  it("server error -> ambiguous, redacted, no retry, blocks later runs until resolved", async () => {
    const { validated, gates, ledgerPath } = setup(plan("https://example.com", ["/", "/about"]));
    const events: string[] = [];
    const f = fakeClient(() => Object.assign(new Error(`upstream 502 for key ${KEY} Authorization: Bearer ${KEY}`), { status: 502 }), events);
    const res = await executeStateRun({ validated, gates, resolver: publicDns(), getApiKey: () => KEY, createClient: async () => f.client });
    expect(f.calls).toHaveLength(1);
    expect(res.pages.map((p) => p.status)).toEqual(["ambiguous", "not-attempted"]);
    expect(res.stoppedEarly).toBe(true);
    expect(JSON.stringify(res)).not.toContain(KEY);
    expect(readFileSync(ledgerPath, "utf8")).not.toContain(KEY);
    const l = readLedger(ledgerPath);
    expect(l.entries.at(-1)!.status).toBe("ambiguous");
    expect(() => assertRunGates(validated, gates)).toThrow(/unresolved/);
    resolveEntry(ledgerPath, l.entries.at(-1)!.id, null, "reviewed at origin; credits unknown");
    expect(unresolved(readLedger(ledgerPath))).toEqual([]);
    // identical request is never repeated automatically
    await executeStateRun({ validated, gates, resolver: publicDns(), getApiKey: () => KEY, createClient: async () => f.client }).then((r) => expect(r.pages[0]!.reason).toMatch(/already attempted.*reviewed-continuation/));
    expect(f.calls).toHaveLength(1);
    // explicit reviewed continuation naming that entry is allowed
    const ok = fakeClient(() => doc("https://example.com/"), []);
    const r2 = await executeStateRun({ validated, gates: { ...gates, reviewedContinuation: l.entries.at(-1)!.id }, resolver: publicDns(), getApiKey: () => KEY, createClient: async () => ok.client });
    expect(r2.pages[0]!.status).toBe("accepted");
  });

  it("4xx -> failed (not retried); missing creditsUsed -> ambiguous stop, never settled at an assumed price", async () => {
    const a = setup();
    const f = fakeClient(() => Object.assign(new Error("bad request"), { status: 400 }), []);
    const r = await executeStateRun({ validated: a.validated, gates: a.gates, resolver: publicDns(), getApiKey: () => KEY, createClient: async () => f.client });
    expect(r.pages[0]!.status).toBe("failed");
    expect(readLedger(a.ledgerPath).entries.at(-1)!.status).toBe("failed");

    const b = setup(plan("https://example.com", ["/", "/about"]));
    const g = fakeClient((u) => doc(u, null), []);
    const r2 = await executeStateRun({ validated: b.validated, gates: b.gates, resolver: publicDns(), getApiKey: () => KEY, createClient: async () => g.client });
    expect(r2.pages.map((p) => p.status)).toEqual(["accepted", "not-attempted"]);
    expect(r2.pages[0]!.warnings.join()).toMatch(/credits are UNKNOWN/);
    expect(g.calls).toHaveLength(1);
    const e = readLedger(b.ledgerPath).entries.at(-1)!;
    expect([e.status, e.reportedCredits]).toEqual(["ambiguous", null]);
  });

  it("credit overrun is recorded, stops remaining pages and blocks later runs", async () => {
    const { validated, gates, ledgerPath } = setup(plan("https://example.com", ["/", "/about"]));
    const f = fakeClient((u) => doc(u, 5), []);
    const r = await executeStateRun({ validated, gates, resolver: publicDns(), getApiKey: () => KEY, createClient: async () => f.client });
    expect(r.pages.map((p) => p.status)).toEqual(["accepted", "not-attempted"]);
    expect(r.pages[0]!.warnings.join()).toMatch(/OVERRUN: provider reported 5 credits/);
    const e = readLedger(ledgerPath).entries.at(-1)!;
    expect(e).toMatchObject({ status: "succeeded", reportedCredits: 5, overrun: true });
    expect(() => assertRunGates(validated, gates)).toThrow(/unresolved/);
  });

  it("partial / out-of-order returns -> ambiguous, no per-state fallback or retry", async () => {
    const { validated, gates } = setup(plan("https://example.com", ["/", "/about"]));
    const partial = doc("https://example.com/");
    partial.actions.javascriptReturns = partial.actions.javascriptReturns.slice(0, 4);
    const f = fakeClient(() => partial, []);
    const r = await executeStateRun({ validated, gates, resolver: publicDns(), getApiKey: () => KEY, createClient: async () => f.client });
    expect(r.pages.map((p) => p.status)).toEqual(["ambiguous", "not-attempted"]);
    expect(r.pages[0]!.reason).toMatch(/expected 7 javascriptReturns, got 4/);
    expect(f.calls).toHaveLength(1);
    const swapped = doc("https://example.com/");
    [swapped.actions.javascriptReturns[2], swapped.actions.javascriptReturns[3]] = [swapped.actions.javascriptReturns[3], swapped.actions.javascriptReturns[2]];
    const s = setup();
    const r2 = await executeStateRun({ validated: s.validated, gates: s.gates, resolver: publicDns(), getApiKey: () => KEY, createClient: async () => fakeClient(() => swapped, []).client });
    expect(r2.pages[0]!.status).toBe("ambiguous");
  });

  it("redirected, off-site, non-2xx and FakeIP final URLs are rejected; exact hosted exceptions still apply", async () => {
    const cases: [string, (d: any) => void, RegExp][] = [
      ["redirect", (d) => (d.metadata.url = "https://example.com/elsewhere"), /redirected/],
      ["off-site", (d) => (d.metadata.url = "https://other.example.org/"), /another site|URL guard/],
      ["status", (d) => (d.metadata.statusCode = 404), /HTTP status 404/],
      ["no final", (d) => delete d.metadata.url, /no final URL/],
    ];
    for (const [, mut, re] of cases) {
      const s = setup();
      const d = doc("https://example.com/");
      mut(d);
      const r = await executeStateRun({ validated: s.validated, gates: s.gates, resolver: publicDns(), getApiKey: () => KEY, createClient: async () => fakeClient(() => d, []).client });
      expect(r.pages[0]!.status).toBe("rejected");
      expect(r.pages[0]!.reason).toMatch(re);
    }
    // non-exempt host under FakeIP: refused before key/request
    const s = setup();
    const events: string[] = [];
    const r = await executeStateRun({ validated: s.validated, gates: s.gates, resolver: fakeIpDns(), getApiKey: () => (events.push("key"), KEY) });
    expect(r.pages[0]!.reason).toMatch(/start URL failed the URL guard/);
    expect(events).toEqual([]);
    // bootstrapmade.com Bootslander (exact approved hosted exception) under FakeIP
    const bp = plan("https://bootstrapmade.com", ["/content/demo/Bootslander/"]);
    const b = setup(bp);
    const asked: string[] = [];
    const rb = await executeStateRun({ validated: b.validated, gates: b.gates, resolver: fakeIpDns(asked), getApiKey: () => KEY, createClient: async () => fakeClient(() => doc("https://bootstrapmade.com/content/demo/Bootslander/"), []).client });
    expect(rb.pages[0]!.status).toBe("accepted");
    expect(asked).toEqual([]);
    // www. variant is not exempt
    const wb = setup(plan("https://www.bootstrapmade.com", ["/"]));
    const rw = await executeStateRun({ validated: wb.validated, gates: wb.gates, resolver: fakeIpDns(), getApiKey: () => KEY });
    expect(rw.pages[0]!.status).toBe("rejected");
  });
});

describe("ledger and output file safety", () => {
  it("init never overwrites; files are 0600; symlinks and concurrent locks are refused", () => {
    const d = tmp();
    const p = join(d, "ledger.json");
    initLedger(p, 15, "prior");
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(() => initLedger(p, 0, "again")).toThrow(/already exists/);
    const link = join(d, "link.json");
    symlinkSync(p, link);
    expect(() => readLedger(link)).toThrow(/symlinks refused/);
    expect(() => withLedgerLock(p, () => withLedgerLock(p, () => 1))).toThrow(/locked/);
    expect(existsSync(`${p}.lock`)).toBe(false);
    expect(() => initLedger(join(d, "big.json"), 1001, "x")).toThrow(LedgerError);
  });

  it("a crash after the pre-send record leaves a blocking attempting entry", () => {
    const d = tmp();
    const p = join(d, "ledger.json");
    initLedger(p, 15, "prior");
    const e = reserveAttempt(p, { url: "https://example.com/", requestSha256: "a".repeat(64), reserved: 1, command: "states-run" });
    // (process dies here: no settle)
    expect(unresolved(readLedger(p)).map((x) => x.id)).toEqual([e.id]);
    expect(() => reserveAttempt(p, { url: "https://example.com/x", requestSha256: "b".repeat(64), reserved: 1, command: "states-run" })).toThrow(/unresolved/);
  });

  it("run output never overwrites existing files or directories", () => {
    const d = tmp();
    const run = createExclusiveDir(d, "state-run-x");
    expect(() => createExclusiveDir(d, "state-run-x")).toThrow(/already exists/);
    writeExclusive(join(run, "a.json"), "{}");
    expect(() => writeExclusive(join(run, "a.json"), "{}")).toThrow(/refusing to overwrite/);
    writeFileSync(join(d, "unrelated.txt"), "keep");
    expect(() => writeExclusive(join(d, "unrelated.txt"), "x")).toThrow();
    expect(readFileSync(join(d, "unrelated.txt"), "utf8")).toBe("keep");
  });
});

describe("bounded screenshot acquisition (fake transport only)", () => {
  const png = syntheticPng(64, 40, [0, 0, 0], [255, 255, 255]);
  const transport = (routes: Record<string, { status: number; location?: string; type?: string; body?: Uint8Array }>, seen: string[] = []): ImageTransport => ({
    async get(url, addr) {
      seen.push(`${url.toString()}@${addr.address}`);
      const r = routes[url.toString()] ?? { status: 404 };
      return { status: r.status, location: r.location ?? null, contentType: r.type ?? null, body: r.body ?? null };
    },
  });
  const SHOT = "https://shots.example.com/a.png";

  it("downloads a bounded PNG pinned to the validated address and hashes it", async () => {
    const seen: string[] = [];
    const a = await acquireImage(SHOT, transport({ [SHOT]: { status: 200, type: "image/png", body: png } }, seen), publicDns());
    expect(seen).toEqual([`${SHOT}@93.184.215.14`]);
    expect(a).toMatchObject({ mime: "image/png", width: 64, height: 40 });
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("re-guards every redirect hop and enforces type, bytes and hop limits", async () => {
    const priv = async (h: string) => (h === "internal.example.com" ? ["10.0.0.5"] : ["93.184.215.14"]);
    await expect(acquireImage(SHOT, transport({ [SHOT]: { status: 302, location: "https://internal.example.com/x.png" } }), priv)).rejects.toThrow(/non-public address 10\.0\.0\.5/);
    await expect(acquireImage(SHOT, transport({ [SHOT]: { status: 302, location: "http://shots.example.com/a.png" } }), publicDns())).rejects.toThrow(/only https/);
    const loop = { [SHOT]: { status: 302, location: SHOT } };
    await expect(acquireImage(SHOT, transport(loop), publicDns())).rejects.toThrow(/more than 3 redirects/);
    await expect(acquireImage(SHOT, transport({ [SHOT]: { status: 200, type: "text/html", body: png } }), publicDns())).rejects.toThrow(/not PNG\/JPEG/);
    await expect(acquireImage(SHOT, transport({ [SHOT]: { status: 200, type: "image/jpeg", body: png } }), publicDns())).rejects.toThrow(/not the declared/);
    await expect(acquireImage(SHOT, transport({ [SHOT]: { status: 200, type: "image/png", body: new Uint8Array(12_000_001) } }), publicDns())).rejects.toThrow(/byte bound/);
    await expect(acquireImage("https://198.51.100.7/a.png", transport({}), publicDns())).rejects.toThrow();
  });

  it("FakeIP answers fail closed with an operator-local requirement message", async () => {
    await expect(acquireImage(SHOT, transport({}), fakeIpDns())).rejects.toThrow(/FakeIP\/local resolver cannot be validated/);
  });

  it("pinned lookup only ever answers the validated address", () => {
    const out: unknown[] = [];
    pinnedLookup({ address: "93.184.215.14", family: 4 })("evil.example", { all: true }, (...a) => out.push(a));
    pinnedLookup({ address: "93.184.215.14", family: 4 })("evil.example", {}, (...a) => out.push(a));
    expect(out).toEqual([[null, [{ address: "93.184.215.14", family: 4 }]], [null, "93.184.215.14", 4]]);
  });
});

describe("sample plans", () => {
  it("committed previews equal the rebuilt previews; Bootslander is 1 page, baseline only, 6 actions", () => {
    for (const [planFile, previewFile] of [["samples/state-plan.example.json", "samples/state-plan.example.preview.json"], ["samples/state-plan.bootslander.json", "samples/state-plan.bootslander.preview.json"]]) {
      const v = validateForExecution(JSON.parse(readFileSync(planFile!, "utf8")), JSON.parse(readFileSync(previewFile!, "utf8")));
      expect(v.requests.length).toBe(1);
    }
    const b = validateForExecution(JSON.parse(readFileSync("samples/state-plan.bootslander.json", "utf8")), JSON.parse(readFileSync("samples/state-plan.bootslander.preview.json", "utf8")));
    expect(b.requests[0]!.preview.roles.map((r) => r.role)).toEqual(["wait", "freeze", "lazy", "state", "screenshot", "scrape"]);
    // forced AOS is a modification: acknowledgement required even without synthetic states
    const dir = tmp();
    initLedger(join(dir, "l.json"), 15, "prior");
    expect(() => assertRunGates(b, { operatorCreditsPerRequest: 1, operatorReportedBalance: 10, confirmExistingCredits: true, confirmNoTopup: true, ledgerPath: join(dir, "l.json") })).toThrow(/forced AOS/);
  });
});

describe("saved run wrappers in hifi-capture", () => {
  it("refuses non-accepted runs", () => {
    const w = { success: true, data: doc("https://example.com/"), w2fRun: { schema: "website-to-figma/state-run", schemaVersion: 1, status: "ambiguous", reason: "partial" } };
    expect(() => captureFromScrapeResponses([{ name: "p.json", json: w }], "x")).toThrow(CaptureError);
    expect(() => captureFromScrapeResponses([{ name: "p.json", json: { ...w, w2fRun: { status: "accepted" } } }], "x")).toThrow(/malformed/);
  });
});

describe("CLI holds (no key read, nothing sent)", () => {
  const cli = (args: string[], env: Record<string, string> = {}) => {
    try {
      return { code: 0, out: execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], { encoding: "utf8", env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] }) };
    } catch (e: any) {
      return { code: e.status as number, out: `${e.stdout}${e.stderr}` };
    }
  };
  it("states-run without --yes prints the exact plan and stop conditions, then HOLDS", () => {
    const d = tmp();
    const p = plan();
    writeFileSync(join(d, "plan.json"), JSON.stringify(p));
    writeFileSync(join(d, "preview.json"), JSON.stringify(previewOf(p)));
    initLedger(join(d, "ledger.json"), 15, "prior");
    const base = ["states-run", "--plan", join(d, "plan.json"), "--preview", join(d, "preview.json"), "--out", join(d, "out"), "--ledger", join(d, "ledger.json"), "--operator-credits-per-request", "1", "--operator-reported-balance", "900", "--confirm-existing-credits", "--confirm-no-topup", "--acknowledge-synthetic-modifications"];
    const r = cli(base, { FIRECRAWL_API_KEY: KEY });
    expect(r.code).toBe(3);
    expect(r.out).toMatch(/POST \/v2\/scrape https:\/\/example\.com\/: 14 actions/);
    expect(r.out).toMatch(/Stop conditions:/);
    expect(r.out).toMatch(/HOLD: nothing was sent and no key was read/);
    expect(r.out).not.toContain(KEY);
    expect(existsSync(join(d, "out"))).toBe(false);
    const missing = cli(base.filter((a) => a !== "--confirm-no-topup"), { FIRECRAWL_API_KEY: KEY });
    expect(missing.code).toBe(3);
    expect(missing.out).toMatch(/--confirm-no-topup/);
    expect(readLedger(join(d, "ledger.json")).entries).toHaveLength(1);
  }, 60_000);
});
