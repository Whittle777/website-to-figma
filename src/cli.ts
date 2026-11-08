#!/usr/bin/env node
// website-to-figma CLI. Commands:
//   fixture <5|10|20> [--out FILE]                 synthetic, offline, no key
//   crawl <url> [--limit N] [--timeout S] [--out FILE] [--yes]
//   validate <FILE>
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { buildFixture, FIXTURE_SIZES, type FixtureSize } from "./fixtures/generate";
import { LIMITS } from "./shared/limits";
import { parseSiteMapJson, utf8Length, type SiteMapDoc } from "./shared/schema";
import { parseHttpUrl } from "./security/urlGuard";
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
  website-to-figma validate <FILE>
      Validate a site map JSON file against the current schema.`;

class UsageError extends Error {}

function parseFlags(args: string[]): { positional: string[]; flags: Map<string, string | true>; excludes: string[] } {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  const excludes: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--yes" || a === "--help" || a === "-h" || a === "--no-map" || a === "--confirm-existing-credits" || a === "--confirm-no-topup") {
      flags.set(a.replace(/^-+/, ""), true);
    } else if (a === "--limit" || a === "--timeout" || a === "--out" || a === "--max-credits" || a === "--exclude" || a === "--operator-reported-balance") {
      const v = args[++i];
      if (v === undefined) throw new UsageError(`${a} needs a value`);
      if (a === "--exclude") excludes.push(v);
      else flags.set(a.slice(2), v);
    } else if (a.startsWith("-")) throw new UsageError(`Unknown option ${a}`);
    else positional.push(a);
  }
  return { positional, flags, excludes };
}

function intFlag(v: string | true | undefined, name: string, fallback: number): number {
  if (v === undefined) return fallback;
  if (v === true || !/^\d+$/.test(v)) throw new UsageError(`--${name} must be a whole number`);
  return Number(v);
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
  const { positional, flags, excludes: rawExcludes } = parseFlags(rest);
  if (!cmd || cmd === "--help" || cmd === "-h" || flags.has("help")) {
    console.log(USAGE);
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
    const result = parseSiteMapJson(readFileSync(file, "utf8"));
    if (!result.ok) {
      console.error(`INVALID ${file}\n  ${result.errors.join("\n  ")}`);
      return 1;
    }
    console.log(`VALID ${file} (${result.doc.pages.length} pages, schemaVersion ${result.doc.schemaVersion})`);
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
    if (err instanceof CrawlPolicyError) {
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
