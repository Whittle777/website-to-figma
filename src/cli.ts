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
import { MAX_TIMEOUT_SEC, runCrawl } from "./crawl/firecrawl";

const USAGE = `Usage:
  website-to-figma fixture <5|10|20> [--out FILE]
      Write a deterministic SYNTHETIC fixture site map (no network, no key).
  website-to-figma crawl <url> [--limit N] [--timeout SECONDS] [--out FILE] [--yes]
      Map + crawl a real public site with Firecrawl. Needs FIRECRAWL_API_KEY
      (environment or a git-ignored .env). Uses Firecrawl credits, so it only
      runs with --yes. Default limit ${LIMITS.defaultPages}, hard cap ${LIMITS.hardMaxPages}.
  website-to-figma validate <FILE>
      Validate a site map JSON file against the current schema.`;

class UsageError extends Error {}

function parseFlags(args: string[]): { positional: string[]; flags: Map<string, string | true> } {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--yes" || a === "--help" || a === "-h") flags.set(a.replace(/^-+/, ""), true);
    else if (a === "--limit" || a === "--timeout" || a === "--out") {
      const v = args[++i];
      if (v === undefined) throw new UsageError(`${a} needs a value`);
      flags.set(a.slice(2), v);
    } else if (a.startsWith("-")) throw new UsageError(`Unknown option ${a}`);
    else positional.push(a);
  }
  return { positional, flags };
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
  const { positional, flags } = parseFlags(rest);
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
        `This would call Firecrawl map (1 credit) and crawl up to ${limit} page(s) (about 1 credit per page, per Firecrawl docs).\n` +
          "Re-run with --yes to proceed.",
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
      doc = await runCrawl({ url, limit, timeoutSec, apiKey, signal: abort.signal, log: (m) => console.error(m) });
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
    if (err instanceof UsageError) {
      console.error(`${err.message}\n\n${USAGE}`);
      process.exit(64);
    }
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
