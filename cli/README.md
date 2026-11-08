# website-to-figma CLI: single-file build

`website-to-figma.mjs` is the full CLI as one ES module. It includes the bounded HTML-extraction
worker (the file re-spawns itself as a worker thread) and every runtime npm dependency, including
`@mendable/firecrawl-js`. It needs **Node.js >= 20.12** and nothing else: no `npm install` and no
`node_modules`. Licenses of the bundled packages are in `THIRD_PARTY_NOTICES.txt`. No license has
been chosen for website-to-figma itself yet.

Rebuild from a checkout with `npm ci && npm run dist`. The build is deterministic for the
committed lockfile. Check `SHA256SUMS` after downloading:

```sh
shasum -a 256 website-to-figma.mjs   # compare with SHA256SUMS
node website-to-figma.mjs --help
```

## Commands

```sh
node website-to-figma.mjs fixture 5|10|20 [--out FILE]   # synthetic, offline, no key: works
node website-to-figma.mjs validate FILE                   # works
node website-to-figma.mjs crawl URL --max-credits N [--limit N] [--exclude /prefix]... [--no-map] ...
```

## `crawl` always refuses right now (fail closed)

A live crawl needs a strict credit ceiling (`--max-credits`). **No documented, enforceable
Firecrawl crawl credit ceiling exists**, so the CLI refuses every bounded-budget crawl, for any
`--max-credits` value. It refuses **before any Firecrawl request**: before the API key is read,
before the balance endpoint, and before map or crawl. There is no flag to override this or to
treat the estimate as a cap. The refusal comes from `STRICT_CREDIT_CEILING_SUPPORTED = false` in
`src/crawl/plan.ts`. That can only change in a reviewed code change once a documented, enforceable
provider ceiling exists.

Example, with exit code 3 and no network activity:

```
$ node website-to-figma.mjs crawl https://www.scrapethissite.com --limit 10 --no-map \
    --exclude /lessons/ --exclude /faq/ --exclude /login/ --max-credits 20 --yes
Standard estimate (NOT a guarantee): 10 page(s) x 1 = 10 credit(s).
Exclusions (would be sent as excludePaths): /faq, /lessons, /login.
Refusing before any Firecrawl request: a strict credit ceiling cannot be guaranteed for crawls. ...
```

Why a strict ceiling can't be guaranteed:
- **No credit cap.** Neither the crawl API nor SDK 4.52 offers one; `limit` caps *pages*. SDK
  4.52's only `maxCredits` option is in the agent API.
- **Threat protection.** It costs "+2 credits per URL scanned" in `normal` mode. Teams with
  enforced threat protection "may raise the mode per request but never lower it" (SDK typings), so
  `threatProtection: { mode: "off" }` doesn't guarantee the base price. For 10 pages that could
  mean about 30 credits.
- **Top-ups.** Pay-as-you-go adds credits and charges the card "when your credit balance reaches
  zero". Concurrent use of the same account can drain the balance during a run, so a client-side
  balance check can't rule out new charges.
- **Balance endpoint.** The docs don't say whether `GET /team/credit-usage` bills.

## What stays implemented (planned and validated, not executed)

These run locally and refuse invalid input before anything else:
- `--limit` 1–20. Values above 20 are rejected, not reduced.
- `--exclude` path prefixes: `[A-Za-z0-9._~-/]` only, no `.`/`..` segments, not `/`, at most 10.
- The start URL safety check, which runs only when the request path is reachable.
- The standard estimate: `(--no-map ? 0 : 1) + limit × 1`.

The request the CLI *would* send, built and tested but unreachable while the gate refuses:
- Optional map with `includeSubdomains: false` and `threatProtection: { mode: "off" }`.
- Crawl with `allowSubdomains: false`, `allowExternalLinks: false`, `crawlEntireDomain: false`,
  `ignoreQueryParameters: true` and `regexOnFullURL: false`.
- `excludePaths` as `^/?<prefix>(?:/.*)?$`, which behaves the same however Firecrawl anchors the
  pattern or treats the leading slash.
- `scrapeOptions`: `formats: ["html"]`, `parsers: []`, `proxy: "basic"`,
  `threatProtection: { mode: "off" }`, and no surcharge features.
- After fetching: final-URL safety, exact same-site and exclusion re-checks, query-variant
  collapsing, `creditsUsed` reported as telemetry only, and best-effort cancel.

## Credit semantics, from the official docs

Pages: https://docs.firecrawl.dev/billing ·
https://docs.firecrawl.dev/api-reference/endpoint/crawl-post ·
https://docs.firecrawl.dev/api-reference/endpoint/scrape ·
https://docs.firecrawl.dev/api-reference/endpoint/credit-usage ·
https://docs.firecrawl.dev/features/crawl

- **Billing:**
  - Crawl costs "1 credit / page" and map costs "1 credit / call".
  - Enhanced or `auto` proxy escalation costs "+0".
  - A returned document costs 1 credit, even with a 403/404; no document costs 0.
  - Surcharges apply only when enabled, and they stack.
  - Credits are billed "asynchronously as each page completes".
  - Pay-as-you-go top-ups happen at zero balance; the docs say "Set your limit to `0`, and
    pay-as-you-go turns off".
- **Scrape:** with `parsers: []`, a PDF is returned as base64 "with a flat rate of 1 credit for
  the entire PDF".
- **Crawl API:**
  - `proxy` is `basic|enhanced|auto` (default `auto`), and enhanced is "Billed at the same credit
    cost as basic".
  - `threatProtection` `normal` costs "+2 credits per URL scanned" and has no documented default.
  - `limit` is the "Maximum number of pages to crawl".
- **Credit usage:** `GET /team/credit-usage` returns `remainingCredits`. Whether the call itself
  bills isn't documented.
- **Crawl guide:** `excludePaths` are RE2 regexes on the URL pathname. Billing after a cancel isn't
  covered.
