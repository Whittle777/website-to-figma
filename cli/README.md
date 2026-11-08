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
node website-to-figma.mjs fixture 5|10|20 [--out FILE]   # synthetic, offline, no key
node website-to-figma.mjs validate FILE
node website-to-figma.mjs crawl URL --max-credits N [--limit N] [--exclude /prefix]... [--no-map] \
     [--timeout S] [--out FILE] [--yes]
```

Example: at most 10 ordinary pages on one site, three sections excluded, no discovery call:

```sh
node website-to-figma.mjs crawl https://www.scrapethissite.com \
  --limit 10 --no-map --exclude /lessons/ --exclude /faq/ --exclude /login/ --max-credits 20 --yes
```

`crawl` reads `FIRECRAWL_API_KEY` from the environment, or from `./.env` if that file exists.
It never prints the key.

## What `crawl` enforces, and when

**Before any Firecrawl request (local, no network):**
- `--limit` must be 1–20. Anything above 20 is rejected, not reduced.
- `--exclude` values must be path prefixes made of `[A-Za-z0-9._~-/]`, with no `.`/`..` segments
  and not `/` itself. At most 10. The start URL must not be excluded.
- **Credit preflight:** `--max-credits` is required. The documented worst case is
  `(--no-map ? 0 : 1) + limit × 1`. If it exceeds `--max-credits`, the CLI refuses with exit
  code 3. For the example above the worst case is 10.
- The start URL must pass the URL safety checks: http(s) only, no credentials or non-default
  ports, and a public unicast IP literal or public local-DNS answers.

**First API request: balance gate.** `GET /v2/team/credit-usage` is read through the SDK's
`getCreditUsage()`. If `remainingCredits` is missing, unreadable or below the worst case, the run
is refused and no map or crawl request is made. This is meant to keep the run within existing
credits, so a pay-as-you-go top-up should not be triggered. See the limits below.

**Requests that can spend credits, with standard settings only:**
- Map, unless `--no-map`, called with `includeSubdomains: false`, `ignoreQueryParameters: true`
  and `threatProtection: { mode: "off" }`.
- Crawl, called with:
  - `limit`, `allowSubdomains: false`, `allowExternalLinks: false`, `crawlEntireDomain: false`
  - `maxDiscoveryDepth: 3`, `sitemap: "include"`
  - `ignoreQueryParameters: true`, `deduplicateSimilarURLs: true`, `regexOnFullURL: false`
  - `excludePaths`, sent before any fetch
  - `scrapeOptions`: `formats: ["html"]`, `parsers: []`, `proxy: "basic"`,
    `threatProtection: { mode: "off" }`, and no surcharge features (no JSON, PII redaction,
    prompt-injection check, lockdown or zero data retention)
- Each exclusion is sent as `^/?<prefix>(?:/.*)?$`, for example `^/?lessons(?:/.*)?$`.
  Firecrawl matches `excludePaths` as RE2 regexes against the pathname but does not document
  anchoring or the leading slash. This form gives the same result either way and does not match
  `/lessons-old`.

**After pages are fetched (post-spend, cannot un-spend):**
- Final URLs (`metadata.url`) are checked again: safety, exact same-site, and the local exclusion
  rule. A page that was excluded but fetched anyway is dropped and noted.
- Query variants (`/a?page=2` and `/a`) collapse to one page.
- `creditsUsed` from crawl status is **telemetry, not a ceiling**. If it goes above the worst
  case, the CLI asks Firecrawl to cancel (best effort) and marks the result incomplete.

## Credit semantics (docs.firecrawl.dev, as read when this build was made)

- `/billing`: Crawl "1 credit / page"; Map "1 credit / call". Enhanced proxy or `auto`
  escalation costs "+0" ("An escalated retry is not charged separately"). A page Firecrawl
  returns as a document costs 1 credit, even with a 403/404 status; no document costs 0.
  Surcharges (JSON +4, PDF parsing +1/PDF page, ZDR +1, PII +4, prompt-injection +4, lockdown)
  apply only when enabled. Credits are billed "asynchronously as each page completes".
- `/api-reference/endpoint/scrape`: with `parsers: []`, "the PDF file is returned in base64
  encoding with a flat rate of 1 credit for the entire PDF". Parsers not in the list are off, so
  image URLs fail as unsupported.
- `/api-reference/endpoint/crawl-post`: `proxy` is `basic|enhanced|auto` (default `auto`), and
  enhanced is "Billed at the same credit cost as basic". `threatProtection` `normal` is
  "+2 credits per URL scanned" (enterprise feature, no documented default). `limit` is the
  "Maximum number of pages to crawl".

**So the documented worst case for `--limit 10 --no-map` is 10 credits, and 11 with map.** That
is a figure derived from the docs, not a hard ceiling enforced by Firecrawl. No crawl-level credit
cap exists in the API or SDK 4.52; the only `maxCredits` option belongs to the agent API.

## Limits on these guarantees

- The balance gate prevents a top-up only if no other job uses the same account at the same
  time. The billing docs say pay-as-you-go top-ups trigger when the balance reaches zero. The only
  absolute protection is an account setting: set the pay-as-you-go limit to 0 ("pay-as-you-go
  turns off").
- The docs don't say whether `GET /team/credit-usage` costs credits. It isn't listed among billed
  endpoints.
- Teams with enforced threat protection "may raise the mode per request but never lower it" (SDK
  typings), so +2 per URL could still apply on such accounts.
- The docs don't say whether pages already in progress are billed after a cancel. Cancelling is
  best effort.
- Server-side retry billing is documented only for enhanced-proxy escalation (+0). The client makes
  a single attempt (`maxRetries: 1`), and each SDK call has a wall-clock wait limit.
- How `excludePaths` is anchored is undocumented. The pattern form above is built to be safe
  either way, but this has not been verified against the live API.
- Firecrawl fetches from its own infrastructure. The local URL checks can't control its DNS or
  redirect hops.
