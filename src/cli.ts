#!/usr/bin/env node
// website-to-figma CLI. Commands:
//   fixture <5|10|20> [--out FILE]                 synthetic, offline, no key
//   crawl <url> [--limit N] [--timeout S] [--out FILE] [--yes]
//   validate <FILE>
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { buildFixture, FIXTURE_SIZES, type FixtureSize } from "./fixtures/generate";
import { LIMITS } from "./shared/limits";
import { utf8Length, type SiteMapDoc } from "./shared/schema";
import { parseImportJson, type HifiDoc } from "./shared/hifiSchema";
import { buildHifiFixture } from "./fixtures/hifiSynthetic";
import { buildStatesFixture } from "./fixtures/statesSynthetic";
import { CaptureError, convertCapture, type TiledReference } from "./hifi/convert";
import { tileReference } from "./hifi/tileReference";
import { loadAssetManifest } from "./hifi/assets";
import { readBoundedFile, readBoundedJson } from "./hifi/files";
import { captureFromScrapeResponses } from "./hifi/adapter";
import { parseHttpUrl } from "./security/urlGuard";
import { buildStatePreview, parseStatePlan, StatePlanError } from "./states/plan";
import { assertRunGates, executeStateRun, StateRunPolicyError, STOP_CONDITIONS, validateForExecution, sha256 } from "./states/execute";
import { initLedger, ledgerSummary, LedgerError, readLedger, recordManual, resolveEntry } from "./states/ledger";
import { createExclusiveDir, OutputError, writeExclusive } from "./states/runFiles";
import { acquireImage, httpsTransport } from "./states/acquire";
import { createHash } from "node:crypto";
import { buildDiagnosticPreview, diagnosticPreviewSha256, executeDiagnostic, interpretDiagnostic, validateDiagnosticPreview, DIAG_URL, type DiagnosticRecord } from "./states/diagnostic";
import { inspectImage } from "./shared/imageInfo";
import { SANDBOX_UNSUPPORTED, assertSandboxGates, buildSandboxPreview, cleanupSandbox, executeSandbox, sanitizeRecord, sandboxPreviewSha256, sandboxToCapture, validateSandboxPreview, SANDBOX, SANDBOX_WORST_CASE_CREDITS, type SandboxRecord } from "./states/sandbox";
import { planConnectorJobs, parseImageHashMap, DEFAULT_MAX_JOB_CHARS, JobPlanError } from "./connector/jobs";
import { adaptTaggedReturns } from "./states/adapt";
import { assertLimit } from "./normalize/build";
import { MAX_TIMEOUT_SEC, planCrawl, runCrawl } from "./crawl/firecrawl";
import { assertOperatorPrerequisites, CrawlPolicyError, normalizeExcludes, standardEstimate } from "./crawl/plan";

const USAGE = `Usage:
  website-to-figma fixture <5|10|20> [--out FILE]
      Write a deterministic SYNTHETIC fixture site map (no network, no key).
  website-to-figma crawl <url> --no-map --limit N(<=10) --max-credits N
        --operator-reported-balance N --confirm-existing-credits --confirm-no-topup
        [--exclude /path]... [--timeout SECONDS] [--out FILE] [--yes]
      Live Firecrawl crawl (HTML links only; sitemap skipped; same site only).
      Refuses before any Firecrawl request unless every operator input is
      given. The CLI does NOT verify the balance or top-up settings and makes
      no account API calls; the operator must have checked them at the origin.
      --max-credits is an accepted-risk budget compared with creditsUsed
      telemetry (best-effort cancel), not a provider-enforced ceiling. The
      printed standard estimate (limit x 1) is not a worst case.
  website-to-figma fixture hifi [--out FILE]
      Write a SYNTHETIC hi-fi (schemaVersion 2) sample with generated images.
  website-to-figma fixture hifi-states [--out FILE]
      Write a SYNTHETIC sample with state variants, freeze/motion/media records.
  website-to-figma hifi --capture FILE [--assets MANIFEST] [--font-map MATCH=Family]...
                        [--normalize-reference centered-dpr1] [--state-reactions click-cycle] --out FILE
      Offline: convert an operator-supplied measured DOM capture plus local,
      SHA-256-pinned PNG/JPEG/GIF assets into a schemaVersion 2 import file.
      Never fetches anything.
  website-to-figma hifi-capture --scrape FILE [--scrape FILE]... [--label TEXT] --out FILE
      Offline adapter: locally saved scrape responses whose measured DOM is in
      data.actions.javascriptReturns[].value -> capture format. Never fetches.
  website-to-figma states-plan --plan FILE --out FILE
      Offline PLANNER only: validate a state plan (1 site, <=3 pages, <=3 states
      per page incl. baseline, declarative synthetic mutations only) and write
      exact Firecrawl request PREVIEWS. Sends NOTHING; there is no executor, so
      automatic state capture is unsupported. Provider cost is unknown.
  website-to-figma states-run --plan FILE --preview FILE --out DIR --ledger FILE
        --operator-credits-per-request N --operator-reported-balance N
        --confirm-existing-credits --confirm-no-topup
        [--acknowledge-synthetic-modifications] [--reviewed-continuation LEDGER_ID] [--yes]
      PAID hosted execution of the exact reviewed previews: ONE request per page,
      one attempt, no retries. Without --yes it prints the exact request plan and
      stop conditions and HOLDS (nothing sent, key not read). N is YOUR asserted
      reservation, not a price; provider cost is unknown and may exceed it. The
      ledger is a local 1000-credit project budget ceiling, NOT a provider cap.
  website-to-figma states-screenshots --run RUN_DIR --out DIR [--yes]
      Bounded local download of an ACCEPTED run's state screenshots (full local
      DNS guard, pinned address, re-checked redirects, byte/pixel bounds, SHA-256
      manifest). Without --yes it lists targets and HOLDS. Failures => download
      manually and add to the asset manifest.
  website-to-figma ledger init|show|resolve|record --ledger FILE [...]
      init --prior-credits N --note TEXT | resolve --id ID --credits N|unknown --note TEXT
      | record --credits N --note TEXT (other attributable project spend)
  website-to-figma fig-plan --doc site-v2.json --renderer connector-dist/w2f-connector-renderer.js
        [--renderer-sha256 HEX] [--max-job-chars N (default 40000)] [--image-hashes MAP.json] --out DIR
      Offline: write ordered Figma-connector job scripts ($fig plan constructors only) that embed the
      SAME shared renderer as the native plugin. Makes NO Figma calls; run the jobs yourself, in order.
  website-to-figma diag-plan --out FILE
      Offline: write the fixed viewport-diagnostic preview (1 page, 9 actions, 2 screenshots, 4 probes).
  website-to-figma diag-run --preview FILE --out DIR --ledger FILE --operator-credits-per-request N
        --operator-reported-balance N --confirm-existing-credits --confirm-no-topup [--yes]
      PAID: the exact diagnostic request, one POST, one attempt; HOLDS without --yes.
  website-to-figma diag-screenshots --run RUN_DIR --out DIR [--yes]
      Guarded local download of an accepted diagnostic's 2 screenshot URLs only; HOLDS without --yes.
  website-to-figma diag-interpret --run RUN_DIR [--images MANIFEST]
      Offline interpretation of probes (and PNG crop sizes if downloaded).
  website-to-figma sandbox-plan --out FILE
      Offline: the fixed Browser Sandbox preview (viewport before navigation; 3 same-region states).
  website-to-figma sandbox-run --preview FILE --out DIR --ledger FILE --operator-credits-per-request N
        --project-remaining-credits N --confirm-existing-credits --confirm-no-topup [--yes]
      (--project-remaining-credits: origin-reported PROJECT remaining, NOT a verified account balance)
      PAID: create -> execute -> delete (always), one attempt each (documented /v2/interact); HOLDS
      without --yes. Runs in ONE owned browser context (serviceWorkers "block"), closed in finally.
  website-to-figma sandbox-cleanup --ledger FILE --id LEDGER_ID [--yes]
      One explicit DELETE for a recorded session whose cleanup was not confirmed; HOLDS without --yes.
  website-to-figma sandbox-convert --run RUN_DIR --out DIR
      Offline: accepted sandbox run -> capture.json + manifest.json for hifi.
  website-to-figma validate <FILE>
      Validate a site map JSON file (schemaVersion 1 or 2).`;

class UsageError extends Error {}

function parseFlags(args: string[]): { positional: string[]; flags: Map<string, string | true>; excludes: string[]; scrapes: string[]; fontMaps: string[] } {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  const excludes: string[] = [];
  const scrapes: string[] = [];
  const fontMaps: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--yes" || a === "--help" || a === "-h" || a === "--no-map" || a === "--confirm-existing-credits" || a === "--confirm-no-topup" || a === "--acknowledge-synthetic-modifications") {
      flags.set(a.replace(/^-+/, ""), true);
    } else if (a === "--limit" || a === "--timeout" || a === "--out" || a === "--max-credits" || a === "--exclude" || a === "--operator-reported-balance" || a === "--capture" || a === "--assets" || a === "--scrape" || a === "--label" || a === "--font-map" || a === "--normalize-reference" || a === "--plan" || a === "--state-reactions" || a === "--preview" || a === "--ledger" || a === "--operator-credits-per-request" || a === "--reviewed-continuation" || a === "--run" || a === "--prior-credits" || a === "--note" || a === "--id" || a === "--credits" || a === "--doc" || a === "--renderer" || a === "--renderer-sha256" || a === "--max-job-chars" || a === "--image-hashes" || a === "--images" || a === "--project-remaining-credits") {
      const v = args[++i];
      if (v === undefined) throw new UsageError(`${a} needs a value`);
      if (a === "--exclude") excludes.push(v);
      else if (a === "--scrape") scrapes.push(v);
      else if (a === "--font-map") fontMaps.push(v);
      else flags.set(a.slice(2), v);
    } else if (a.startsWith("-")) throw new UsageError(`Unknown option ${a}`);
    else positional.push(a);
  }
  return { positional, flags, excludes, scrapes, fontMaps };
}

function intFlag(v: string | true | undefined, name: string, fallback: number): number {
  if (v === undefined) return fallback;
  if (v === true || !/^\d+$/.test(v)) throw new UsageError(`--${name} must be a whole number`);
  return Number(v);
}

function writeHifi(doc: HifiDoc, out: string): string {
  const text = JSON.stringify(doc) + "\n";
  if (utf8Length(text) > LIMITS.hifiMaxJsonBytes) throw new Error(`Output exceeds ${LIMITS.hifiMaxJsonBytes} bytes; not written`);
  const path = resolve(out);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

function hifiSummary(doc: HifiDoc, path: string): string {
  const lines = [`Wrote ${path} (schemaVersion 2, ${doc.source.mode}: ${doc.source.label})`, `  assets: ${doc.assets.length} (${doc.assets.map((a) => `${a.id} ${a.kind} ${a.width}x${a.height} sha256 ${a.sha256.slice(0, 12)}`).join("; ") || "none"})`];
  for (const p of doc.pages) {
    lines.push(`  ${p.path}: ${p.nodes.length} nodes, ${p.width}x${p.height}, reference ${p.referenceAssetId ?? "none"}${p.truncated ? ", TRUNCATED" : ""}`);
    if (p.states) lines.push(`    states (${p.states.reactions}): ${p.states.variants.map((v) => `${v.name} [${v.provenance}, ${v.nodes.length} nodes]`).join(", ")}`);
    for (const w of p.warnings) lines.push(`    warning: ${w}`);
  }
  for (const w of doc.warnings) lines.push(`  warning: ${w}`);
  return lines.join("\n");
}

function writeDoc(doc: SiteMapDoc, out: string): string {
  const text = JSON.stringify(doc, null, 2) + "\n";
  if (utf8Length(text) > LIMITS.maxJsonBytes) throw new Error(`Output exceeds ${LIMITS.maxJsonBytes} bytes; not written`);
  const path = resolve(out);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

function summary(doc: SiteMapDoc, path: string): string {
  const k = doc.crawl;
  const lines = [
    `Wrote ${path}`,
    `  source: ${doc.source.mode === "fixture" ? `${doc.source.fixtureId} (${doc.source.label})` : doc.source.startUrl}`,
    `  pages: ${k.returnedCount} (limit ${k.requestedLimit}, hard cap ${k.hardCap}, discovered ${k.discoveredCount ?? "unknown"})`,
    `  truncated: ${k.truncated}  incomplete: ${k.incomplete}`,
  ];
  for (const n of k.notes) lines.push(`  note: ${n}`);
  return lines.join("\n");
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const { positional, flags, excludes: rawExcludes, scrapes, fontMaps } = parseFlags(rest);
  if (!cmd || cmd === "--help" || cmd === "-h" || flags.has("help")) {
    console.log(USAGE);
    return 0;
  }

  if (cmd === "fixture" && positional[0] === "hifi") {
    const doc = buildHifiFixture();
    const out = typeof flags.get("out") === "string" ? (flags.get("out") as string) : "out/hifi-synthetic.json";
    console.log(hifiSummary(doc, writeHifi(doc, out)));
    return 0;
  }

  if (cmd === "fixture" && positional[0] === "hifi-states") {
    const doc = buildStatesFixture();
    const out = typeof flags.get("out") === "string" ? (flags.get("out") as string) : "out/hifi-states-synthetic.json";
    console.log(hifiSummary(doc, writeHifi(doc, out)));
    return 0;
  }

  if (cmd === "hifi-capture") {
    const out = flags.get("out");
    if (scrapes.length === 0 || typeof out !== "string") throw new UsageError("hifi-capture needs --scrape FILE (repeatable) and --out FILE");
    const label = typeof flags.get("label") === "string" ? (flags.get("label") as string) : "operator capture";
    const responses = scrapes.map((f) => ({ name: f, json: readBoundedJson(f, LIMITS.hifiMaxJsonBytes, f) }));
    const { capture, screenshotHints, warnings } = captureFromScrapeResponses(responses, label);
    const text = JSON.stringify(capture) + "\n";
    if (utf8Length(text) > LIMITS.hifiMaxJsonBytes) throw new CaptureError("capture output too large; not written");
    const path = resolve(out);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    console.log(`Wrote ${path} (${capture.pages.length} page(s); nothing fetched)`);
    for (const h of screenshotHints) console.log(`  screenshot URL present for ${h.pageUrl}${h.state ? ` state "${h.state}" (scrollY ${h.scrollY ?? "unknown"})` : ""} (NOT downloaded; add local bytes to the asset manifest with kind "reference", pageUrl${h.state ? " and state" : ""})`);
    for (const w of warnings) console.log(`  warning: ${w}`);
    return 0;
  }

  if (cmd === "states-plan") {
    const planPath = flags.get("plan");
    const out = flags.get("out");
    if (typeof planPath !== "string" || typeof out !== "string") throw new UsageError("states-plan needs --plan FILE and --out FILE");
    const preview = buildStatePreview(parseStatePlan(readBoundedJson(planPath, 1_000_000, "state plan")));
    const path = resolve(out);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(preview, null, 2) + "\n");
    console.log(`Wrote ${path} (request PREVIEWS only; NOTHING was sent)`);
    for (const r of preview.requests) {
      console.log(`  ${r.pageUrl}: ${r.actionCount} actions (budget ${preview.budgets.maxActions}), combined waits ${r.combinedWaitMs} ms (budget ${preview.budgets.maxCombinedWaitMs}), states ${r.states.map((s) => `${s.name} [${s.provenance}]`).join(", ")}`);
    }
    for (const m of preview.manualRoute) console.log(`  manual: ${m}`);
    for (const n of preview.notice) console.log(`  note: ${n}`);
    return 0;
  }

  if (cmd === "ledger") {
    const path = flags.get("ledger");
    const sub = positional[0];
    if (typeof path !== "string" || !sub) throw new UsageError("ledger needs a subcommand (init|show|resolve|record) and --ledger FILE");
    const note = typeof flags.get("note") === "string" ? (flags.get("note") as string) : "";
    if (sub === "init") {
      const l = initLedger(path, intFlag(flags.get("prior-credits"), "prior-credits", 0), note);
      console.log(ledgerSummary(l));
    } else if (sub === "show") {
      console.log(ledgerSummary(readLedger(path)));
    } else if (sub === "resolve") {
      const id = flags.get("id");
      const c = flags.get("credits");
      if (typeof id !== "string" || typeof c !== "string") throw new UsageError("ledger resolve needs --id ID --credits N|unknown");
      const e = resolveEntry(path, id, c === "unknown" ? null : intFlag(c, "credits", 0), note);
      console.log(`Resolved ${e.id}: counted ${e.resolvedCredits}`);
    } else if (sub === "record") {
      const e = recordManual(path, intFlag(flags.get("credits"), "credits", 0), note);
      console.log(`Recorded ${e.id}: ${e.reserved} credits`);
    } else throw new UsageError(`unknown ledger subcommand ${sub}`);
    return 0;
  }

  if (cmd === "states-run") {
    const planPath = flags.get("plan");
    const previewPath = flags.get("preview");
    const out = flags.get("out");
    if (typeof planPath !== "string" || typeof previewPath !== "string" || typeof out !== "string") throw new UsageError("states-run needs --plan FILE --preview FILE --out DIR");
    // 1) exact preview + semantic validation, 2) operator gates + ledger (no key, no network)
    const validated = validateForExecution(readBoundedJson(planPath, 1_000_000, "state plan"), readBoundedJson(previewPath, 20_000_000, "preview"));
    const optInt = (k: string) => (flags.get(k) === undefined ? undefined : intFlag(flags.get(k), k, 0));
    const gates = {
      operatorCreditsPerRequest: optInt("operator-credits-per-request"),
      operatorReportedBalance: optInt("operator-reported-balance"),
      confirmExistingCredits: flags.has("confirm-existing-credits"),
      confirmNoTopup: flags.has("confirm-no-topup"),
      acknowledgeSyntheticModifications: flags.has("acknowledge-synthetic-modifications"),
      ledgerPath: typeof flags.get("ledger") === "string" ? (flags.get("ledger") as string) : undefined,
      reviewedContinuation: typeof flags.get("reviewed-continuation") === "string" ? (flags.get("reviewed-continuation") as string) : undefined,
    };
    const g = assertRunGates(validated, gates);
    console.log(`Exact request plan (preview sha256 ${validated.previewSha256}); ONE request per page, one attempt each, no retries:`);
    for (const r of validated.requests) {
      const p = r.preview;
      console.log(`  POST /v2/scrape ${p.pageUrl}: ${p.actionCount} actions [${p.roles.map((x) => x.role).join(",")}], combined waits ${p.combinedWaitMs} ms, states ${p.states.map((s) => `${s.name}(${s.provenance})`).join(", ")}, request sha256 ${r.requestSha256}`);
    }
    console.log(`Operator-asserted reservation: ${g.perRequest} x ${validated.requests.length} = ${g.projected} (NOT a price; provider cost unknown and may exceed it). Ledger committed ${g.committed}, remaining local allowance ${g.remaining} of the 1000-credit project budget ceiling (not a provider cap).`);
    console.log("Stop conditions:");
    for (const c of STOP_CONDITIONS) console.log(`  - ${c}`);
    if (!flags.has("yes")) {
      console.log("HOLD: nothing was sent and no key was read. Re-run with --yes to execute.");
      return 3;
    }
    const runId = sha256(`${validated.previewSha256}:${Date.now()}:${Math.random()}`).slice(0, 16);
    const runDir = createExclusiveDir(out, `state-run-${runId}`);
    const result = await executeStateRun({
      validated,
      gates,
      runId,
      getApiKey: () => {
        if (existsSync(".env")) process.loadEnvFile(".env");
        return process.env.FIRECRAWL_API_KEY;
      },
      save: (i, wrapper) => writeExclusive(join(runDir, `page-${i}.response.json`), JSON.stringify(wrapper) + "\n"),
      log: (m) => console.error(m),
    });
    writeExclusive(join(runDir, "run.json"), JSON.stringify({ runId: result.runId, previewSha256: result.previewSha256, stoppedEarly: result.stoppedEarly, pages: result.pages }, null, 2) + "\n");
    console.log(`Wrote ${runDir} (PRIVATE: contains raw page content; never commit it)`);
    for (const p of result.pages) console.log(`  ${p.pageUrl}: ${p.status}${p.reason ? ` (${p.reason})` : ""}; credits reported ${p.reportedCreditsUsed ?? "NOT reported"}${p.warnings.length ? `; ${p.warnings.join("; ")}` : ""}`);
    return result.pages.every((p) => p.status === "accepted") && !result.stoppedEarly ? 0 : 4;
  }

  if (cmd === "states-screenshots") {
    const runDir = flags.get("run");
    const out = flags.get("out");
    if (typeof runDir !== "string" || typeof out !== "string") throw new UsageError("states-screenshots needs --run RUN_DIR --out DIR");
    const files = readdirSync(runDir).filter((f) => /^page-[0-2]\.response\.json$/.test(f)).sort();
    const targets: { pageUrl: string; state: string; seq: number; url: string; page: number }[] = [];
    for (const f of files) {
      const w = readBoundedJson(join(runDir, f), LIMITS.hifiMaxJsonBytes, f) as Record<string, any>;
      if (w?.w2fRun?.status !== "accepted" || typeof w?.data !== "object") {
        console.log(`  skipped ${f}: run status ${String(w?.w2fRun?.status)}`);
        continue;
      }
      const t = adaptTaggedReturns(w.data, f);
      const pageUrl = String(w.w2fRun.pageUrl);
      for (const h of t?.screenshotHints ?? []) targets.push({ pageUrl, state: h.state, seq: h.seq, url: h.screenshotUrl, page: Number(f.slice(5, 6)) });
    }
    console.log(`${targets.length} associated screenshot URL(s) from accepted runs:`);
    for (const t of targets) console.log(`  ${t.pageUrl} "${t.state}": ${t.url.slice(0, 120)}`);
    if (!flags.has("yes")) {
      console.log("HOLD: nothing downloaded. Re-run with --yes (local fetch; full local DNS guard, no hosted exception).");
      return 3;
    }
    const dir = createExclusiveDir(out, `screenshots-${Date.now()}`);
    const assets: Record<string, unknown>[] = [];
    let failed = 0;
    for (const t of targets) {
      try {
        const a = await acquireImage(t.url, httpsTransport);
        const file = `p${t.page}-s${t.seq}.${a.mime === "image/png" ? "png" : "jpg"}`;
        writeExclusive(join(dir, file), a.bytes);
        assets.push({ id: `state-p${t.page}-s${t.seq}`, kind: "reference", file, sha256: a.sha256, pageUrl: t.pageUrl, state: t.state });
        console.log(`  saved ${file} ${a.width}x${a.height} sha256 ${a.sha256}`);
      } catch (err) {
        failed++;
        console.log(`  NOT downloaded (${err instanceof Error ? err.message : String(err)}): operator-local input required: download ${t.pageUrl} "${t.state}" yourself and add it to the asset manifest (kind "reference", pageUrl, state).`);
      }
    }
    writeExclusive(join(dir, "manifest.json"), JSON.stringify({ schema: "website-to-figma/asset-manifest", schemaVersion: 1, assets }, null, 2) + "\n");
    console.log(`Wrote ${dir} (PRIVATE; ${assets.length} saved, ${failed} need manual download)`);
    return failed ? 4 : 0;
  }

  if (cmd === "sandbox-plan") {
    const out = flags.get("out");
    if (typeof out !== "string") throw new UsageError("sandbox-plan needs --out FILE");
    const preview = buildSandboxPreview();
    const path = resolve(out);
    mkdirSync(dirname(path), { recursive: true });
    writeExclusive(path, JSON.stringify(preview, null, 2) + "\n");
    console.log(`Wrote ${path} (sandbox PREVIEW; NOTHING sent). Canonical preview sha256 ${sandboxPreviewSha256(preview)}`);
    return 0;
  }

  if (cmd === "sandbox-run") {
    const previewPath = flags.get("preview");
    const out = flags.get("out");
    if (typeof previewPath !== "string" || typeof out !== "string") throw new UsageError("sandbox-run needs --preview FILE --out DIR");
    const validated = validateSandboxPreview(readBoundedJson(previewPath, 2_000_000, "sandbox preview"));
    const optInt = (k: string) => (flags.get(k) === undefined ? undefined : intFlag(flags.get(k), k, 0));
    const gates = {
      operatorCreditsPerRequest: optInt("operator-credits-per-request"),
      projectRemainingCredits: optInt("project-remaining-credits"),
      confirmExistingCredits: flags.has("confirm-existing-credits"),
      confirmNoTopup: flags.has("confirm-no-topup"),
      ledgerPath: typeof flags.get("ledger") === "string" ? (flags.get("ledger") as string) : undefined,
      reviewedContinuation: typeof flags.get("reviewed-continuation") === "string" ? (flags.get("reviewed-continuation") as string) : undefined,
    };
    const g = assertSandboxGates(gates);
    console.log(`Exact sandbox lifecycle (preview sha256 ${validated.previewSha256}; request sha256 ${validated.requestSha256}), one attempt per operation, no replay:`);
    console.log(`  create  POST https://api.firecrawl.dev/v2/interact { ttl ${SANDBOX.ttl}, activityTtl ${SANDBOX.activityTtl} } (seconds; no profile; vendor defaults kept)`);
    console.log(`  execute POST https://api.firecrawl.dev/v2/interact/{id}/execute { language node, timeout ${SANDBOX.executeTimeoutS}, fixed reviewed code } -> browser.newContext({ serviceWorkers "block", viewport ${SANDBOX.viewport.width}x${SANDBOX.viewport.height} }), context route guard, newPage, goto ${SANDBOX.url}; 3 states of ${SANDBOX.scope} on that page; context closed in finally`);
    console.log("  delete  DELETE https://api.firecrawl.dev/v2/interact/{id} (always, in finally)");
    console.log("Main document: route.fetch({ maxRedirects: 0, maxRetries: 0 }) then route.fulfill; any 3xx aborted before fulfilling (no redirected request). Other navigations, popups' navigations, IP-literal/local hosts and non-http(s) schemes aborted.");
    if (SANDBOX_UNSUPPORTED.length) {
      console.log(`HARD HOLD (no override; refused even with --yes): ${SANDBOX_UNSUPPORTED.join("; ")}. Nothing was sent and no key was read.`);
      return 3;
    }
    console.log(`Reservation ${g.reservation} (worst case for the full ttl: ${SANDBOX_WORST_CASE_CREDITS}; local allowance, NOT a provider cap). Ledger committed ${g.committed}, remaining local allowance ${g.remaining}. Project remaining (origin-reported, NOT a verified account balance): ${gates.projectRemainingCredits}.`);
    console.log("Accounting: a successful run is settled PENDING RECONCILIATION; verify the actual charge from GET /v2/team/credit-usage (remainingCredits delta) or the dashboard, then `ledger resolve`. creditsBilled is undocumented and informational only. No automatic re-run.");
    console.log("Every request and hop: one structural policy (http/https, no credentials, no non-default port, no IP-literal/local host, exact hostname bootstrapmade.com; data:/blob: subresources only); http(s) fetched once by route.fetch({ maxRedirects: 0, maxRetries: 0 }) and any 3xx aborted unserved (redirects never followed); WebSockets refused. Any blocked subresource marks the capture incomplete.");
    console.log("Stops: preview mismatch; missing gate; unresolved (incl. pending reconciliation)/duplicate/over-ceiling ledger; create ambiguous (no re-create) or failed; execute error/killed/truncated/partial/oversize; in-browser redirect/viewport/swiper/service-worker/owned-context refusal; delete not confirmed (blocking).");
    console.log("Not proven: hosted availability of page.context().browser() / browser.newContext inside the Firecrawl sandbox (fails closed; the session is still deleted).");
    if (!flags.has("yes")) {
      console.log("HOLD: nothing was sent and no key was read. Re-run with --yes only after origin review.");
      return 3;
    }
    const runDir = createExclusiveDir(out, `sandbox-run-${sha256(`${validated.previewSha256}:${Date.now()}`).slice(0, 12)}`);
    const rec: SandboxRecord = await executeSandbox({
      validated,
      gates,
      getApiKey: () => {
        if (existsSync(".env")) process.loadEnvFile(".env");
        return process.env.FIRECRAWL_API_KEY;
      },
      savePng: (seq, bytes) => writeExclusive(join(runDir, `state-${seq}.png`), bytes),
      saveRaw: (text) => writeExclusive(join(runDir, "execute-raw.json"), text + "\n"),
      log: (m) => console.error(m),
    });
    // final persistence boundary (the lifecycle already sanitized with the key; this re-check is key-less)
    writeExclusive(join(runDir, "sandbox.json"), JSON.stringify(sanitizeRecord(rec), null, 2) + "\n");
    console.log(`Wrote ${runDir} (PRIVATE). status ${rec.status}${rec.reason ? ` (${rec.reason})` : ""}; charge ${rec.chargeStatus}; response creditsBilled ${rec.creditsBilled ?? "absent"} (undocumented, informational)${rec.incomplete ? "; capture INCOMPLETE" : rec.incomplete === null ? "; completeness NOT OBSERVED" : ""}${rec.stage ? `; in-browser stage ${rec.stage}` : ""}${rec.rawExecute?.saved ? "; raw execute provenance: execute-raw.json" : ""}`);
    for (const w of rec.warnings) console.log(`  warning: ${w}`);
    return rec.status === "accepted" ? 0 : 4;
  }

  if (cmd === "sandbox-cleanup") {
    const ledgerPath = flags.get("ledger");
    const id = flags.get("id");
    if (typeof ledgerPath !== "string" || typeof id !== "string") throw new UsageError("sandbox-cleanup needs --ledger FILE --id LEDGER_ID");
    if (!flags.has("yes")) {
      console.log(`HOLD: would send ONE DELETE for the session recorded in ledger entry ${id}. Re-run with --yes.`);
      return 3;
    }
    const r = await cleanupSandbox({ ledgerPath, entryId: id, getApiKey: () => {
      if (existsSync(".env")) process.loadEnvFile(".env");
      return process.env.FIRECRAWL_API_KEY;
    } });
    console.log(r.detail);
    return r.ok ? 0 : 4;
  }

  if (cmd === "sandbox-convert") {
    const runDir = flags.get("run");
    const out = flags.get("out");
    if (typeof runDir !== "string" || typeof out !== "string") throw new UsageError("sandbox-convert needs --run RUN_DIR --out DIR");
    const rec = readBoundedJson(join(runDir, "sandbox.json"), 30_000_000, "sandbox record") as SandboxRecord;
    if (rec?.schema !== "website-to-figma/sandbox-run") throw new UsageError("not a sandbox run record");
    const dir = createExclusiveDir(out, `sandbox-capture-${rec.runId}`);
    const files = rec.states.map((s) => `state-${s.seq}.png`);
    for (const f of files) writeExclusive(join(dir, f), readBoundedFile(join(runDir, f), SANDBOX.maxPngBytes));
    const { capture, manifest } = sandboxToCapture(rec, files);
    writeExclusive(join(dir, "capture.json"), JSON.stringify(capture) + "\n");
    writeExclusive(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    console.log(`Wrote ${dir}: capture.json + manifest.json (PRIVATE). Next: hifi --capture ${join(dir, "capture.json")} --assets ${join(dir, "manifest.json")} --out site-v2.json`);
    return 0;
  }

  if (cmd === "diag-plan") {
    const out = flags.get("out");
    if (typeof out !== "string") throw new UsageError("diag-plan needs --out FILE");
    const preview = buildDiagnosticPreview();
    const path = resolve(out);
    mkdirSync(dirname(path), { recursive: true });
    writeExclusive(path, JSON.stringify(preview, null, 2) + "\n");
    console.log(`Wrote ${path} (diagnostic PREVIEW; NOTHING sent). Canonical preview sha256 ${diagnosticPreviewSha256(preview)}`);
    return 0;
  }

  if (cmd === "diag-run") {
    const previewPath = flags.get("preview");
    const out = flags.get("out");
    if (typeof previewPath !== "string" || typeof out !== "string") throw new UsageError("diag-run needs --preview FILE --out DIR");
    const validated = validateDiagnosticPreview(readBoundedJson(previewPath, 1_000_000, "diagnostic preview"));
    const optInt = (k: string) => (flags.get(k) === undefined ? undefined : intFlag(flags.get(k), k, 0));
    const gates = {
      operatorCreditsPerRequest: optInt("operator-credits-per-request"),
      operatorReportedBalance: optInt("operator-reported-balance"),
      confirmExistingCredits: flags.has("confirm-existing-credits"),
      confirmNoTopup: flags.has("confirm-no-topup"),
      ledgerPath: typeof flags.get("ledger") === "string" ? (flags.get("ledger") as string) : undefined,
      reviewedContinuation: typeof flags.get("reviewed-continuation") === "string" ? (flags.get("reviewed-continuation") as string) : undefined,
    };
    const { assertDiagnosticGates } = await import("./states/diagnostic");
    const g = assertDiagnosticGates(gates);
    console.log(`Exact diagnostic request (preview sha256 ${validated.previewSha256}; request sha256 ${validated.requestSha256}): ONE POST /v2/scrape ${DIAG_URL}, one attempt, no retries`);
    console.log(`  actions: ${validated.preview.roles.map((r) => (r.tag ? `${r.role}:${r.tag}` : r.role)).join(", ")}; combined waits 3000 ms; screenshots fullPage false, viewport 1920x1080`);
    console.log(`Operator-asserted reservation ${g.perRequest} (NOT a price; cost unknown). Ledger committed ${g.committed}, remaining local allowance ${g.remaining} (not a provider cap).`);
    console.log("Stops: preview mismatch; missing gate; unresolved/duplicate/over-ceiling ledger; URL guard/redirect/non-2xx/non-HTML; SDK error (4xx failed, else ambiguous; never retried); partial probes or != 2 screenshots (ambiguous); missing request credits (ambiguous); overrun recorded.");
    if (!flags.has("yes")) {
      console.log("HOLD: nothing was sent and no key was read. Re-run with --yes only after origin review.");
      return 3;
    }
    const runDir = createExclusiveDir(out, `diag-run-${sha256(`${validated.previewSha256}:${Date.now()}`).slice(0, 12)}`);
    const rec = await executeDiagnostic({
      validated,
      gates,
      getApiKey: () => {
        if (existsSync(".env")) process.loadEnvFile(".env");
        return process.env.FIRECRAWL_API_KEY;
      },
      save: (w) => writeExclusive(join(runDir, "diagnostic.response.json"), JSON.stringify(w) + "\n"),
      log: (m) => console.error(m),
    });
    writeExclusive(join(runDir, "diagnostic.json"), JSON.stringify(rec, null, 2) + "\n");
    console.log(`Wrote ${runDir} (PRIVATE). status ${rec.status}${rec.reason ? ` (${rec.reason})` : ""}; credits reported ${rec.reportedCreditsUsed ?? "NOT reported"}`);
    return rec.status === "accepted" ? 0 : 4;
  }

  if (cmd === "diag-screenshots" || cmd === "diag-interpret") {
    const runDir = flags.get("run");
    if (typeof runDir !== "string") throw new UsageError(`${cmd} needs --run RUN_DIR`);
    const rec = readBoundedJson(join(runDir, "diagnostic.json"), 2_000_000, "diagnostic record") as DiagnosticRecord;
    if (rec?.schema !== "website-to-figma/diagnostic-run" || rec.schemaVersion !== 1) throw new UsageError("not a diagnostic run record");
    if (rec.status !== "accepted" || !Array.isArray(rec.screenshots) || rec.screenshots.length !== 2) throw new UsageError(`diagnostic status ${rec.status}; screenshots are linked only for accepted runs with exactly 2 screenshots`);
    if (cmd === "diag-interpret") {
      const imgs = flags.get("images");
      let images: ({ width: number; height: number } | null)[] = [];
      if (typeof imgs === "string") {
        const m = readBoundedJson(imgs, 1_000_000, "screenshot manifest") as { assets?: { id: string; width?: number; height?: number }[] };
        images = ["diag-S1", "diag-S2"].map((id) => {
          const a = m.assets?.find((x) => x.id === id);
          return a && typeof a.width === "number" && typeof a.height === "number" ? { width: a.width, height: a.height } : null;
        });
      }
      console.log(JSON.stringify(interpretDiagnostic(rec, images), null, 2));
      return 0;
    }
    const out = flags.get("out");
    if (typeof out !== "string") throw new UsageError("diag-screenshots needs --out DIR");
    for (const [i, u] of rec.screenshots.entries()) console.log(`  S${i + 1}: ${String(u).slice(0, 120)}`);
    if (!flags.has("yes")) {
      console.log("HOLD: nothing downloaded. Re-run with --yes (local fetch; full local DNS guard, no hosted exception).");
      return 3;
    }
    const dir = createExclusiveDir(out, `diag-screenshots-${rec.runId}`);
    const assets: Record<string, unknown>[] = [];
    let failed = 0;
    for (const [i, u] of rec.screenshots.entries()) {
      try {
        const a = await acquireImage(u, httpsTransport);
        const info = inspectImage(a.bytes);
        const file = `diag-S${i + 1}.${a.mime === "image/png" ? "png" : "jpg"}`;
        writeExclusive(join(dir, file), a.bytes);
        assets.push({ id: `diag-S${i + 1}`, file, sha256: a.sha256, width: info?.width ?? a.width, height: info?.height ?? a.height, runId: rec.runId, requestSha256: rec.requestSha256 });
        console.log(`  saved ${file} ${a.width}x${a.height} sha256 ${a.sha256}`);
      } catch (err) {
        failed++;
        console.log(`  S${i + 1} NOT downloaded (${err instanceof Error ? err.message : String(err)}): download it manually and add { id: "diag-S${i + 1}", width, height, sha256 } to the manifest.`);
      }
    }
    writeExclusive(join(dir, "manifest.json"), JSON.stringify({ schema: "website-to-figma/diagnostic-screenshots", schemaVersion: 1, runId: rec.runId, assets }, null, 2) + "\n");
    console.log(`Wrote ${dir} (PRIVATE; ${assets.length} saved, ${failed} need manual download)`);
    return failed ? 4 : 0;
  }

  if (cmd === "fig-plan") {
    const docPath = flags.get("doc");
    const renderer = flags.get("renderer");
    const out = flags.get("out");
    if (typeof docPath !== "string" || typeof renderer !== "string" || typeof out !== "string") throw new UsageError("fig-plan needs --doc FILE --renderer FILE --out DIR");
    const parsed = parseImportJson(new TextDecoder().decode(readBoundedFile(docPath, LIMITS.hifiMaxJsonBytes)));
    if (!parsed.ok) throw new UsageError(`--doc is not a valid import file:\n  ${parsed.errors.slice(0, 10).join("\n  ")}`);
    if (parsed.version !== 2) throw new UsageError("--doc must be a schemaVersion 2 (hi-fi) document");
    const bundle = new TextDecoder().decode(readBoundedFile(renderer, 2_000_000));
    const bundleSha = createHash("sha256").update(bundle).digest("hex");
    const pinned = flags.get("renderer-sha256");
    if (typeof pinned === "string" && pinned.toLowerCase() !== bundleSha) throw new UsageError(`renderer sha256 ${bundleSha} does not match --renderer-sha256 ${pinned}`);
    if (!/^("use strict";)?var W2F=/.test(bundle)) throw new UsageError("--renderer is not the website-to-figma connector renderer bundle");
    const maxChars = intFlag(flags.get("max-job-chars"), "max-job-chars", DEFAULT_MAX_JOB_CHARS);
    const hashFile = flags.get("image-hashes");
    const imageHashesBySha = typeof hashFile === "string" ? parseImageHashMap(readBoundedJson(hashFile, 1_000_000, "image hash map")) : undefined;
    const plan = planConnectorJobs(parsed.doc, bundle, { maxJobChars: maxChars, imageHashesBySha });
    const mappedCount = imageHashesBySha ? parsed.doc.assets.filter((a) => imageHashesBySha[a.sha256]).length : 0;
    const dir = createExclusiveDir(out, `fig-plan-${plan.key}-${Date.now()}`);
    for (const j of plan.jobs) writeExclusive(join(dir, j.file), j.script);
    const manifest = {
      schema: "website-to-figma/connector-plan",
      schemaVersion: 1,
      rootName: plan.rootName,
      docKey: plan.key,
      rendererSha256: bundleSha,
      maxJobChars: maxChars,
      run: "Run each job's script with the Figma connector, strictly in this order; stop at the first error. Each job returns { rootId, ids, created, unsupported, warnings }.",
      imageFills: mappedCount ? `${mappedCount} asset(s) mapped to origin-supplied existing Figma image hashes (IMAGE paints); others are placeholders` : "none mapped: every image is a labelled placeholder (supply --image-hashes from a sanctioned upload to fill them)",
      notSupported: ["image fills without an origin-supplied hash mapping", "pluginData provenance", "vector networks (SVG polylines)", "edge grouping"],
      unverified: ["these jobs have not been run against Figma; geometry is validated only by synthetic fake-connector tests"],
      jobs: plan.jobs.map((j) => ({ file: j.file, kind: j.kind, pageId: j.pageId, chars: j.chars, sha256: j.sha256, note: j.note })),
    };
    writeExclusive(join(dir, "jobs.json"), JSON.stringify(manifest, null, 2) + "\n");
    console.log(`Wrote ${dir}: ${plan.jobs.length} job(s), renderer sha256 ${bundleSha}; NO Figma calls were made`);
    for (const j of plan.jobs) console.log(`  ${j.file} (${j.chars} chars) ${j.note}`);
    return 0;
  }

  if (cmd === "hifi") {
    const capturePath = flags.get("capture");
    const manifestPath = flags.get("assets");
    const out = flags.get("out");
    if (typeof capturePath !== "string" || typeof out !== "string") throw new UsageError("hifi needs --capture FILE and --out FILE");
    const capture = readBoundedJson(capturePath, LIMITS.hifiMaxJsonBytes, "capture");
    const loaded = typeof manifestPath === "string" ? loadAssetManifest(manifestPath) : { assets: [], warnings: [], rejectedReferences: [], tallReferences: [] };
    // Tall reference PNGs: bounded offline tiling (worker); failures keep size evidence only.
    const referenceTiles: TiledReference[] = [];
    for (const t of loaded.tallReferences) {
      try {
        const r = await tileReference(t.bytes);
        referenceTiles.push({
          operatorId: t.operatorId,
          pageUrl: t.pageUrl,
          sourceSha256: r.sourceSha256,
          width: r.width,
          height: r.height,
          tiles: r.tiles.map((tile, i) => ({ y: tile.y, h: tile.h, asset: { operatorId: `${t.operatorId}#tile${i}`, kind: "reference", mime: "image/png", width: r.width, height: tile.h, sha256: tile.sha256, sourceUrl: null, pageUrl: null, bytes: tile.bytes } })),
        });
      } catch (err) {
        const reason = `tiling failed: ${err instanceof Error ? err.message : String(err)}`;
        loaded.warnings.push(`Asset ${t.operatorId} omitted: ${reason}`);
        loaded.rejectedReferences.push({ operatorId: t.operatorId, pageUrl: t.pageUrl, width: t.width, height: t.height, reason });
      }
    }
    const fontMap = fontMaps.map((f) => {
      const m = /^([^=]{1,100})=([^=]{1,100})$/.exec(f);
      if (!m) throw new UsageError(`--font-map must be MATCH=Figma Family (got ${JSON.stringify(f)})`);
      return { match: m[1]!.trim(), use: m[2]!.trim() };
    });
    if (fontMap.length > 16) throw new UsageError("at most 16 --font-map entries");
    const norm = flags.get("normalize-reference");
    if (norm !== undefined && norm !== "centered-dpr1") throw new UsageError('--normalize-reference accepts only "centered-dpr1"');
    const reactions = flags.get("state-reactions");
    if (reactions !== undefined && reactions !== "click-cycle") throw new UsageError('--state-reactions accepts only "click-cycle"');
    const doc = convertCapture({ capture, assets: loaded.assets, assetWarnings: loaded.warnings, rejectedReferences: loaded.rejectedReferences, referenceTiles, fontMap, normalizeReference: norm === "centered-dpr1" ? "centered-dpr1" : undefined, stateReactions: reactions === "click-cycle" ? "click-cycle" : "none" });
    console.log(hifiSummary(doc, writeHifi(doc, out)));
    return 0;
  }

  if (cmd === "fixture") {
    const size = Number(positional[0]);
    if (!FIXTURE_SIZES.includes(size as FixtureSize)) throw new UsageError("fixture size must be 5, 10 or 20");
    const doc = buildFixture(size as FixtureSize);
    const out = typeof flags.get("out") === "string" ? (flags.get("out") as string) : `out/fixture-${size}.json`;
    console.log(summary(doc, writeDoc(doc, out)));
    return 0;
  }

  if (cmd === "validate") {
    const file = positional[0];
    if (!file) throw new UsageError("validate needs a file path");
    const result = parseImportJson(new TextDecoder().decode(readBoundedFile(file, LIMITS.hifiMaxJsonBytes)));
    if (!result.ok) {
      console.error(`INVALID ${file}\n  ${result.errors.join("\n  ")}`);
      return 1;
    }
    console.log(`VALID ${file} (${result.doc.pages.length} pages, schemaVersion ${result.version})`);
    return 0;
  }

  if (cmd === "crawl") {
    const url = positional[0];
    if (!url) throw new UsageError("crawl needs a URL");
    const limit = assertLimit(intFlag(flags.get("limit"), "limit", LIMITS.defaultPages));
    const timeoutSec = intFlag(flags.get("timeout"), "timeout", 120);
    if (timeoutSec < 10 || timeoutSec > MAX_TIMEOUT_SEC) throw new UsageError(`--timeout must be 10..${MAX_TIMEOUT_SEC}`);
    parseHttpUrl(url);

    // Credit/exclusion policy is checked before the key is even looked at.
    const excludes = normalizeExcludes(rawExcludes);
    const useMap = !flags.has("no-map");
    const maxCreditsFlag = flags.get("max-credits");
    const maxCredits = maxCreditsFlag === undefined ? undefined : intFlag(maxCreditsFlag, "max-credits", 0);
    const balanceFlag = flags.get("operator-reported-balance");
    const reportedBalance = balanceFlag === undefined ? undefined : intFlag(balanceFlag, "operator-reported-balance", 0);
    const confirmExistingCredits = flags.has("confirm-existing-credits");
    const confirmNoTopup = flags.has("confirm-no-topup");
    console.error(
      `Standard estimate (NOT a worst case or ceiling): ${useMap ? "map 1 + " : ""}${limit} page(s) x 1 = ${standardEstimate(limit, useMap)} credit(s). ` +
        `Accepted-risk budget: ${maxCredits ?? "missing"} (telemetry + best-effort cancel only).\n` +
        `Exclusions (sent as excludePaths before fetching): ${excludes.length > 0 ? excludes.join(", ") : "none"}.`,
    );
    // Gates run before the key is read and before any Firecrawl request.
    planCrawl({ url, limit, timeoutSec, apiKey: "", excludes, useMap });
    assertOperatorPrerequisites(limit, useMap, { maxCredits, reportedBalance, confirmExistingCredits, confirmNoTopup });
    console.error(`Operator affirmations accepted as given (not verified here): reported balance ${reportedBalance}, existing credits, no top-up.`);

    if (existsSync(".env")) process.loadEnvFile(".env");
    const apiKey = process.env.FIRECRAWL_API_KEY?.trim();
    if (!apiKey) {
      console.error(
        "FIRECRAWL_API_KEY is not set, so no crawl was run and nothing was written.\n" +
          "Set it in your environment or in a git-ignored .env file (see .env.example).\n" +
          "To try the tool without a key, run the separate synthetic command: website-to-figma fixture 5",
      );
      return 2;
    }
    if (!flags.has("yes")) {
      console.error(
        "This would spend Firecrawl credits (the estimate above is not a guarantee). Re-run with --yes to proceed.",
      );
      return 3;
    }
    // First Ctrl-C aborts polling and cancels the remote job; a second exits.
    const abort = new AbortController();
    const onSigint = () => {
      if (abort.signal.aborted) process.exit(130);
      console.error("Interrupt: cancelling remote crawl (Ctrl-C again to force quit)...");
      abort.abort();
    };
    process.on("SIGINT", onSigint);
    let doc: SiteMapDoc;
    try {
      doc = await runCrawl({
        url,
        limit,
        timeoutSec,
        apiKey,
        excludes,
        useMap,
        maxCredits,
        reportedBalance,
        confirmExistingCredits,
        confirmNoTopup,
        signal: abort.signal,
        log: (m) => console.error(m),
      });
    } finally {
      process.off("SIGINT", onSigint);
    }
    const host = new URL(doc.site.origin).hostname.replace(/[^a-z0-9.-]/gi, "_");
    const out = typeof flags.get("out") === "string" ? (flags.get("out") as string) : `out/${host}.json`;
    console.log(summary(doc, writeDoc(doc, out)));
    return 0;
  }

  throw new UsageError(`Unknown command "${cmd}"`);
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    if (err instanceof CrawlPolicyError || err instanceof StatePlanError || err instanceof StateRunPolicyError || err instanceof LedgerError || err instanceof OutputError || err instanceof JobPlanError) {
      console.error(err.message);
      process.exit(3);
    }
    if (err instanceof UsageError) {
      console.error(`${err.message}\n\n${USAGE}`);
      process.exit(64);
    }
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
