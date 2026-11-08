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

Hi-fi (schemaVersion 2), offline only:
`node website-to-figma.mjs hifi --capture capture.json --assets assets/manifest.json --out site-v2.json`
`node website-to-figma.mjs hifi-capture --scrape saved-response.json --out capture.json`
(offline adapter for saved scrape responses) and `node website-to-figma.mjs fixture hifi`. For the input formats, bounds and limits, see "Hi-fi
import" in the repository README. Nothing is fetched; assets are local, hash-pinned PNG/JPEG/GIF
files.


```sh
node website-to-figma.mjs fixture 5|10|20 [--out FILE]   # synthetic, offline, no key
node website-to-figma.mjs validate FILE
node website-to-figma.mjs crawl URL --no-map --limit N --max-credits N \
     --operator-reported-balance N --confirm-existing-credits --confirm-no-topup \
     [--exclude /prefix]... [--timeout S] [--out FILE] [--yes]
```

## Live crawl: operator prerequisites (checked by the operator, not by this CLI)

Before running a live crawl, the operator must have done both of these at the origin:
- **Checked the account balance** from the raw `GET /v2/team/credit-usage` response or the
  dashboard. The CLI makes **no** account, balance or settings API calls and verifies nothing.
- **Confirmed that no top-up or purchase is authorized** for this run.

The CLI refuses **before any Firecrawl request** (no key read, no DNS lookup, no API call) unless
all of these are given:

| Input | Meaning |
|---|---|
| `--no-map` | Required. Discovery via `map` is disabled. |
| `--limit N` | 1–10 pages. |
| `--max-credits N` | **Accepted-risk budget**. Must be at least the standard estimate. It's compared with Firecrawl's `creditsUsed` telemetry; if usage goes over it, the CLI sends a **best-effort cancel**. It is **not** a provider-enforced ceiling. |
| `--operator-reported-balance N` | A recent remaining-credit balance that the operator obtained and verified. It must be at least `--max-credits`. The CLI does **not** verify it. |
| `--confirm-existing-credits` | The operator affirms that existing credits cover the accepted-risk budget. |
| `--confirm-no-topup` | The operator affirms that no top-up or purchase is authorized for this run. |
| `--yes` | Required to actually start. |

Example with a generic URL; it's the operator's choice of target:

```sh
FIRECRAWL_API_KEY=... node website-to-figma.mjs crawl https://SITE.example/ --no-map --limit 10 \
  --exclude /login/ --max-credits 1000 --operator-reported-balance <BALANCE_VERIFIED_AT_ORIGIN> \
  --confirm-existing-credits --confirm-no-topup --yes
```

## URL safety exception (exactly `simplecss.org`, hosted Firecrawl only)

The start URL and every final URL Firecrawl reports must pass the full structural URL checks. For
every host except exactly `simplecss.org`, they must also pass a local DNS check: every answer must
be public unicast. For `simplecss.org`, the owner approved skipping only the local DNS-answer
lookup (2026-11-07), because the operator's resolver returns FakeIP addresses (`198.18.0.0/15`).

- **Scope:** no `www.`, subdomain, trailing-dot or look-alike variants, and no flag to extend it.
- **Still rejected:** `198.18.0.0/15` IP literals.
- **Risk:** for this host, private-address resolution, DNS rebinding and redirect hops rely
  solely on Firecrawl's documented Network protections (https://docs.firecrawl.dev/security).
  This tool has not verified those controls.

## Request settings (standard options only)

- **Crawl:**
  - `limit` at most 10, `sitemap: "skip"`, `allowSubdomains: false`, `allowExternalLinks: false`
  - `crawlEntireDomain: false`, `maxDiscoveryDepth: 3`
  - `ignoreQueryParameters: true`, `deduplicateSimilarURLs: true`, `regexOnFullURL: false`
  - `zeroDataRetention: false`
  - `excludePaths` as `^/?<prefix>(?:/.*)?$`
- **`scrapeOptions`:**
  - `formats: ["html"]`, `parsers: []`, `proxy: "basic"`
  - `lockdown: false`, `checkPromptInjection: false`, `redactPII: false`
  - **No `threatProtection` override**, so the team's threat policy applies unchanged.
- **Client:** a single attempt (`maxRetries: 1`) with a wall-clock wait limit per call.
- **Errors:** a 402 or 403 from `startCrawl` stops immediately. There's no retry and no cancel,
  because no job exists.
- **Sitemap:** with `sitemap: "skip"`, the crawler "uses HTML links only"
  (docs.firecrawl.dev/features/crawl). URLs listed only in the site's sitemap, including private
  addresses such as `0.0.0.0`, are not used for discovery.
- **After fetching:**
  - Every final URL (`metadata.url`) is re-checked: public unicast only, exact same site, not
    excluded.
  - Private addresses, other hosts and excluded paths are dropped.
  - Query variants collapse to one page.

## Credit semantics and what is NOT bounded

- **Standard estimate:** `limit × 1` credit, from the billing page: Crawl "1 credit / page".
  That's documented base pricing only. It is **not** a worst case and **not** a ceiling.
- **Threat protection:** this CLI sends no override. If the team has Normal mode enabled, scans
  are billed "+2 credits per URL scanned". That includes blocked links discovered mid-crawl and
  redirect destinations on different URLs (features/threat-protection). The org default is Off.
- **Redirects:** followed by Firecrawl from its own infrastructure. There's no documented
  redirect-chain cap. A local preflight can only observe redirects, not bound them.
- **Telemetry lag:** credits are billed "asynchronously as each page completes", so the
  `creditsUsed` check can lag. A cancel is best effort, and post-cancel billing is undocumented.
- **No CLI enforcement:** the balance, top-up and spend-limit settings are account state the CLI
  doesn't read or enforce. Billing docs: pay-as-you-go limit `0` means no card charges, and a
  per-API-key spend limit can deny a crawl with 402.

Docs: https://docs.firecrawl.dev/billing ·
https://docs.firecrawl.dev/api-reference/endpoint/crawl-post ·
https://docs.firecrawl.dev/api-reference/endpoint/credit-usage ·
https://docs.firecrawl.dev/features/crawl ·
https://docs.firecrawl.dev/features/threat-protection
