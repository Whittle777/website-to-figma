#!/usr/bin/env node
// website-to-figma CLI. Commands:
//   fixture <5|10|20> [--out FILE]                 synthetic, offline, no key
//   crawl <url> [--limit N] [--timeout S] [--out FILE] [--yes]
//   validate <FILE>
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
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
    if (a === "--yes" || a === "--help" || a === "-h" || a === "--no-map" || a === "--confirm-existing-credits" || a === "--confirm-no-topup") {
      flags.set(a.replace(/^-+/, ""), true);
    } else if (a === "--limit" || a === "--timeout" || a === "--out" || a === "--max-credits" || a === "--exclude" || a === "--operator-reported-balance" || a === "--capture" || a === "--assets" || a === "--scrape" || a === "--label" || a === "--font-map" || a === "--normalize-reference" || a === "--plan" || a === "--state-reactions") {
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
    if (err instanceof CrawlPolicyError || err instanceof StatePlanError) {
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
