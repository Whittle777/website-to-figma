// Transport-level tests of the REAL installed SDK (@mendable/firecrawl-js
// 4.52.0, real axios) against a LOOPBACK HTTP server. No external network, no
// real key: proves ONE total paid POST per scrape with our client settings.
// Control cases with the SDK defaults show the harness does detect retries.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Firecrawl from "@mendable/firecrawl-js";
import { createStateScrapeClient, executeStateRun, FIRECRAWL_API_URL, stateClientOptions, validateForExecution } from "../src/states/execute";
import { buildStatePreview, parseStatePlan } from "../src/states/plan";
import { initLedger, readLedger } from "../src/states/ledger";
import { syntheticStateResponse } from "../src/fixtures/statesSynthetic";

const KEY = "fc-LOOPBACKTESTKEY0000";
type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;
let server: Server;
let base = "";
let handler: Handler = () => {};
let posts: { path: string; auth: string | undefined; body: Record<string, unknown> }[] = [];
const dirs: string[] = [];
const savedNoProxy = process.env.NO_PROXY;

beforeAll(async () => {
  // keep axios from routing loopback through any configured proxy
  process.env.NO_PROXY = "127.0.0.1,localhost";
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.method === "POST") posts.push({ path: req.url ?? "", auth: req.headers.authorization, body: JSON.parse(body || "{}") });
      handler(req, res, body);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  if (savedNoProxy === undefined) delete process.env.NO_PROXY;
  else process.env.NO_PROXY = savedNoProxy;
  dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
});
beforeEach(() => {
  posts = [];
});

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
const PROCESSING = { success: false, code: "SCRAPE_TIMEOUT", error: "timeout", details: { state: "processing_continues", retryAfterSeconds: 1 } };
const ourOpts = { formats: ["rawHtml"], timeout: 1000, autoResume: false };

describe("real SDK with our client settings: exactly one POST", () => {
  it("502 (the only status the SDK retries) -> 1 POST; SDK default maxRetries 3 -> 3 POSTs (control)", async () => {
    handler = (_q, res) => json(res, 502, { success: false, error: "bad gateway" });
    const ours = await createStateScrapeClient(KEY, base);
    await expect(ours.scrape("https://example.com/", ourOpts)).rejects.toMatchObject({ status: 502 });
    expect(posts).toHaveLength(1);
    posts = [];
    const control = new Firecrawl({ apiKey: KEY, apiUrl: base, backoffFactor: 0.001 });
    await expect(control.scrape("https://example.com/", { formats: ["rawHtml"] })).rejects.toBeTruthy();
    expect(posts).toHaveLength(3);
  });

  it("500 -> 1 POST", async () => {
    handler = (_q, res) => json(res, 500, { success: false, error: "internal" });
    const ours = await createStateScrapeClient(KEY, base);
    await expect(ours.scrape("https://example.com/", ourOpts)).rejects.toMatchObject({ status: 500 });
    expect(posts).toHaveLength(1);
  });

  it("408 processing_continues: autoResume false -> 1 POST; SDK default re-POSTs (control)", { timeout: 20_000 }, async () => {
    handler = (_q, res) => json(res, 408, PROCESSING);
    const ours = await createStateScrapeClient(KEY, base);
    await expect(ours.scrape("https://example.com/", ourOpts)).rejects.toMatchObject({ status: 408 });
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body.autoResume).toBeUndefined(); // SDK-only, never sent
    posts = [];
    let n = 0;
    handler = (_q, res) => (n++ === 0 ? json(res, 408, PROCESSING) : json(res, 200, { success: true, data: { metadata: {} } }));
    const control = new Firecrawl({ apiKey: KEY, apiUrl: base, maxRetries: 1 });
    await control.scrape("https://example.com/", { formats: ["rawHtml"] });
    expect(posts).toHaveLength(2); // the SDK's own resume re-POST that autoResume false disables
  });

  it("no response (timeout) -> 1 POST, ambiguous error", { timeout: 20_000 }, async () => {
    handler = () => {}; // never answers; the SDK's HTTP timeout is timeout + 5000 with autoResume false
    const ours = await createStateScrapeClient(KEY, base);
    const t0 = Date.now();
    const err = await ours.scrape("https://example.com/", ourOpts).catch((e: unknown) => e);
    expect(err).toBeTruthy();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(5_500);
    expect(posts).toHaveLength(1);
  });

  it("connection reset -> 1 POST", async () => {
    handler = (req) => req.socket.destroy();
    const ours = await createStateScrapeClient(KEY, base);
    await expect(ours.scrape("https://example.com/", ourOpts)).rejects.toBeTruthy();
    expect(posts).toHaveLength(1);
  });

  it("the endpoint is pinned even when FIRECRAWL_API_URL is set (no request made)", () => {
    const prev = process.env.FIRECRAWL_API_URL;
    process.env.FIRECRAWL_API_URL = "https://attacker.example";
    try {
      expect(stateClientOptions(KEY).apiUrl).toBe(FIRECRAWL_API_URL);
      const fc = new Firecrawl(stateClientOptions(KEY)) as unknown as { http: { getApiUrl(): string } };
      expect(fc.http.getApiUrl()).toBe("https://api.firecrawl.dev");
      expect(stateClientOptions(KEY).maxRetries).toBe(1);
    } finally {
      if (prev === undefined) delete process.env.FIRECRAWL_API_URL;
      else process.env.FIRECRAWL_API_URL = prev;
    }
  });
});

describe("full executor through the real SDK over loopback", () => {
  const plan = {
    schema: "website-to-figma/state-plan",
    schemaVersion: 1,
    site: "https://example.com",
    pages: ["/", "/about"].map((p) => ({
      url: `https://example.com${p}`,
      states: [
        { name: "FAQ open", scope: "#faq", mutations: [{ mechanism: "details-open", selector: "#faq details" }] },
        { name: "Tab two", mutations: [{ mechanism: "attribute-set", selector: "#tab2", attribute: "aria-selected", value: "true" }] },
      ],
    })),
  };
  const setup = () => {
    const d = mkdtempSync(join(tmpdir(), "w2f-sdk-"));
    dirs.push(d);
    const ledgerPath = join(d, "ledger.json");
    initLedger(ledgerPath, 15, "prior");
    const validated = validateForExecution(plan, JSON.parse(JSON.stringify(buildStatePreview(parseStatePlan(plan)))));
    return { ledgerPath, validated, gates: { operatorCreditsPerRequest: 1, operatorReportedBalance: 900, confirmExistingCredits: true, confirmNoTopup: true, acknowledgeSyntheticModifications: true, ledgerPath } };
  };
  const resolver = async () => ["93.184.215.14"];

  it("success: one POST per page with exactly the previewed body (+ SDK origin tag)", async () => {
    const s = setup();
    handler = (_q, res, raw) => {
      const url = String(JSON.parse(raw).url);
      const d = JSON.parse(JSON.stringify((syntheticStateResponse() as any).data));
      d.metadata = { ...d.metadata, url, sourceURL: url, statusCode: 200, creditsUsed: 1 };
      json(res, 200, { success: true, data: d });
    };
    const r = await executeStateRun({ validated: s.validated, gates: s.gates, resolver, getApiKey: () => KEY, createClient: (k) => createStateScrapeClient(k, base) });
    expect(r.pages.map((p) => p.status)).toEqual(["accepted", "accepted"]);
    expect(posts.map((p) => p.path)).toEqual(["/v2/scrape", "/v2/scrape"]);
    expect(posts[0]!.auth).toBe(`Bearer ${KEY}`);
    const sent = { ...posts[0]!.body };
    expect(typeof sent.origin).toBe("string"); // SDK attribution tag (dist/index.js request())
    delete sent.origin;
    expect(sent).toEqual(s.validated.requests[0]!.preview.body);
    expect(readLedger(s.ledgerPath).entries.slice(1).map((e) => [e.status, e.reportedCredits])).toEqual([["succeeded", 1], ["succeeded", 1]]);
  });

  it("5xx on page 1 -> exactly ONE POST in total, ambiguous ledger entry, page 2 not attempted", async () => {
    const s = setup();
    handler = (_q, res) => json(res, 502, { success: false, error: "bad gateway" });
    const r = await executeStateRun({ validated: s.validated, gates: s.gates, resolver, getApiKey: () => KEY, createClient: (k) => createStateScrapeClient(k, base) });
    expect(posts).toHaveLength(1);
    expect(r.pages.map((p) => p.status)).toEqual(["ambiguous", "not-attempted"]);
    expect(readLedger(s.ledgerPath).entries.at(-1)!.status).toBe("ambiguous");
    expect(JSON.stringify(r)).not.toContain(KEY);
  });
});
