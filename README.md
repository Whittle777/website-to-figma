# website-to-figma

Turn a **small** public website into editable, low-fidelity grey wireframes in Figma.

1. A local TypeScript/Node **CLI** maps and crawls up to 20 same-site pages with the official
   [Firecrawl](https://docs.firecrawl.dev) SDK and writes a versioned, validated JSON site map.
2. A **development Figma plugin** imports that JSON (file picker or paste) and builds real, editable
   frames, text, components and sitemap edges.

> Low-fidelity structure only: no pixel fidelity, no images or brand styling. This project is not
> affiliated with or endorsed by Figma or Firecrawl.

## Status

Early development. What has and has not been verified:

| Area | Status |
| --- | --- |
| CLI fixtures, normalization, caps, schema, URL safety, layout planning | Unit-tested (`npm test`) |
| CLI + plugin typecheck and build | `npm run typecheck`, `npm run build` |
| Firecrawl live crawl | **Never run yet.** It requires operator-confirmed account prerequisites, which the CLI doesn't verify. Request code is typed against `@mendable/firecrawl-js` 4.52.0 and tested with fake clients only. |
| Hi-fi (schemaVersion 2) converter and renderer | Unit-tested with synthetic captures and a fake `figma` object; **not** imported into real Figma from this repo. |
| Importing into Figma | **Not verified yet.** The plugin builds and typechecks against `@figma/plugin-typings`, but nobody has imported it into Figma from this repo yet. |

## Requirements

- Node.js 20.12+ (developed on Node 26)
- For `crawl` only: a Firecrawl API key
- For the plugin: the Figma **desktop app** (Figma's docs say plugin development requires it)

```sh
npm install
npm run build
```

## CLI

```sh
# Synthetic fixtures: offline, deterministic, no key. Clearly labeled as not a real website.
npx tsx src/cli.ts fixture 5            # or 10, 20  -> out/fixture-5.json

# Validate any site map JSON
npx tsx src/cli.ts validate samples/fixture-10.json

# Live crawl: refuses before any Firecrawl request unless the operator supplies the account
# prerequisites (verified by the operator at the origin, NOT by this CLI). See cli/README.md.
npx tsx src/cli.ts crawl https://SITE.example/ --no-map --limit 10 --exclude /login/ \
  --max-credits 1000 --operator-reported-balance N --confirm-existing-credits --confirm-no-topup --yes
```

After `npm run build` the same commands work as `node dist/cli.js ...`. A self-contained
single-file build (no `node_modules` needed, Node >= 20.12) is committed at
[`cli/website-to-figma.mjs`](cli/README.md). Rebuild it with `npm run dist`.

- **`crawl` never falls back to synthetic data.** If no key is set, it explains this, writes
  nothing and exits with code 2. Fixtures only come from the separate `fixture` command.
- **Limits:** default 10 pages, hard cap 20. `--limit 21` or higher is rejected, not silently
  reduced. The default timeout is 120s (max 300s). On timeout the crawl is cancelled and the
  partial results are marked `incomplete`.
- **Timeouts and cancellation:** the client is created with `maxRetries: 1` (a single attempt in
  SDK 4.52) and `timeoutMs: 30000`. In the SDK's axios Node adapter, `timeoutMs` acts as a
  socket-inactivity timeout, not a total-time limit. Each awaited SDK call is therefore also raced
  against a wall-clock timer: map 45s, startCrawl 30s, getCrawlStatus 60s, cancelCrawl 15s and
  getCrawlErrors 30s. When a timer fires, the CLI stops waiting, but the HTTP request underneath
  is not aborted, because the SDK takes no per-call abort signal. `--timeout` is checked between
  polls, so a run can exceed it by up to one status-call bound plus cleanup. There is no hard
  guarantee on total run time.
- **Cancelling is best effort:** a non-terminal exit (deadline, API error, call timeout or the
  first Ctrl-C) sends `cancelCrawl`, but Firecrawl may already have finished pages or may not
  honour the cancel. If `startCrawl` itself times out after the server created the job, no job ID
  is known and that job can't be cancelled from here. It is still limited to `--limit` pages.
- **Parsing bounds:** crawled HTML is cut to 1,000,000 characters and 15,000 opening tags
  *before* parsing, because `node-html-parser` is super-linear on deeply unclosed markup.
  Extraction then runs in a worker thread with a 60s deadline and a 512 MB heap limit. If either
  limit is hit, the run aborts and writes nothing.
- **Credits:** before any Firecrawl request, `crawl` requires all of these:
  - `--no-map` and `--limit` of 10 or less
  - an accepted-risk `--max-credits` budget
  - `--operator-reported-balance` (at least the budget)
  - `--confirm-existing-credits` and `--confirm-no-topup`

  The CLI verifies none of these account facts and makes no account API calls. The printed
  standard estimate (`limit × 1`) is not a worst case. The budget is compared with `creditsUsed`
  telemetry (best-effort cancel), not enforced by Firecrawl. No `threatProtection` override is
  sent, so team policy applies. Details are in [`cli/README.md`](cli/README.md).

### Output format (`schema: "website-to-figma/site-map"`, `schemaVersion: 1`)

```jsonc
{
  "schema": "website-to-figma/site-map", "schemaVersion": 1,
  "generator": { "name": "website-to-figma", "version": "0.1.0" },
  "source": { "mode": "firecrawl", "startUrl": "https://example.com/" },   // or { mode: "fixture", fixtureId, label }
  "site": { "origin": "https://example.com", "host": "example.com" },
  "crawl": {
    "requestedLimit": 10, "hardCap": 20,
    "discoveredCount": 37,      // unique same-site URLs seen by discovery, or null if unknown
    "returnedCount": 10,
    "truncated": true,          // more same-site pages were known than returned
    "incomplete": false,        // timeout / failures / dropped pages
    "notes": ["Cap reached: returned 10 of 37 known same-site pages (limit 10, hard cap 20)"]
  },
  "pages": [
    { "id": "p0", "url": "https://example.com/", "path": "/", "title": "...", "parentId": null, "depth": 0,
      "nav": { "items": ["Home", "About"] }, "footer": { "items": ["Privacy"], "text": "..." },
      "blocks": [ { "type": "heading", "level": 1, "text": "..." }, { "type": "text", "text": "..." },
                  { "type": "cards", "cards": [ { "title": "...", "text": "..." } ] } ] }
  ]
}
```

Before parsing, JSON text is limited to 1,000,000 bytes and 12 levels of nesting (checked with a
linear scan). The format has no `$ref` or anchors, and parsed JSON is a tree, so there are no
cycles. The validator (`src/shared/schema.ts`) is strict: it rejects unknown keys and enforces length and
count bounds plus tree integrity. Both the CLI and the plugin use the same validator.

## Hi-fi import (schemaVersion 2): measured pages with real text, buttons and images

The low-fidelity path (schemaVersion 1) is unchanged. The hi-fi path turns an **operator-supplied
measured DOM capture** into editable Figma content:
- real text runs with their measured fonts, sizes, colors and decoration
- boxes with fills, borders and per-corner radii
- buttons as editable frames that contain their editable labels
- image fills from local, hash-pinned bytes
- each page's screenshot placed beside it as a reference image

```sh
npx tsx src/cli.ts fixture hifi --out samples/hifi-synthetic.json   # synthetic sample, no network
# Optional adapter: locally saved scrape responses -> capture (offline; nothing fetched)
npx tsx src/cli.ts hifi-capture --scrape home.json --scrape about.json --label "my site" --out capture.json
npx tsx src/cli.ts hifi --capture capture.json --assets assets/manifest.json --out site-v2.json
npx tsx src/cli.ts validate site-v2.json                            # v1 and v2 both validate
```

**Input compatibility.** `hifi-capture` reads the measured value at
`data.actions.javascriptReturns[].value`. It must have `viewport`, `elements` and `texts`, plus
optional `url`, `title`, `images` and `svgs`, with the same field names as a measure-dom capture:
- element: `tag`, `x`, `y`, `w`, `h`, `style{…computed…}`, `control`
- text run: `text`, `x`, `y`, `w`, `h`, `tag`, `code`, `style`
- image: `src`, `alt`, box, `style`

`metadata.url`/`contentType` and `branding` are taken from the response when present. This path is
tested **only** with synthetic data in that shape. A prototype's derived `site.json` is **not** an
accepted input. Measured geometry is used as-is: if the measurement viewport differs from the
screenshot (for example 1920 vs 1280), the editable frame uses the measured width, and nothing is
translated or guessed.

- **Inputs** (offline; this repo adds **no** capture or download capability):
  - `capture.json` (`"schema": "website-to-figma/capture"`, `schemaVersion: 1`): per page, `url`,
    optional `contentType`, `referenceAssetId` and `branding`, and `measured`. `measured` holds
    `viewport.width`, element boxes with computed styles, grapheme-grouped text line fragments
    and images (`src`, `alt`, box, style).
  - `manifest.json` (`"schema": "website-to-figma/asset-manifest"`): `{ id, kind:
    "image"|"reference", file, sha256, sourceUrl?, pageUrl? }`. Each `file` is a path inside the
    manifest's directory. Images match capture `src` by `sourceUrl`. A reference matches a page by
    the capture's `referenceAssetId`, or by its `pageUrl`.
- **Provenance:**
  - Geometry, colors, borders, radii and text runs are **measured**.
  - Control label text is **inferred** from control values, and is marked as such.
  - At import, text width is **fitted** with bounded letter spacing.
  - Fonts are mapped to fonts available in Figma, and every substitution is reported.
  - Branding is shown as **page-level** metadata only. It is never treated as per-element styling.
- **Bounds and safety:**
  - Assets must be PNG, JPEG or GIF, up to 4096 px per side (Figma's documented `createImage`
    limit), 12 MB each and 48 MB in total, matching their SHA-256.
  - Assets are read only from regular files inside the manifest directory: no symlinks, no `..`
    and no absolute paths. Files are opened with `O_NOFOLLOW`, the parent path is
    realpath-checked, and the size is checked on the open descriptor with a bounded read.
    Every operator input file goes through the same bounded reader.
  - Decoded pixels across all assets are capped at 100M.
  - `sourceUrl` must pass the same structural URL guard as crawls, so private, reserved and
    `198.18.0.0/15` literals are rejected. Nothing is ever fetched.
  - The plugin decodes with `figma.base64Decode` and re-checks length, SHA-256 and image header
    before creating any node.
  - It uses only `figma.create*`, `createImage(bytes)` and `loadFontAsync`. The manifest still has
    `networkAccess: ["none"]`.
  - Inline SVG markup is **not** imported; it's counted in a warning.
  - Non-HTML pages (for example `feed.xml`) are skipped with a warning.
  - Pages are capped at 4096×30000 px and 6000 nodes per page (30000 total). Truncation is shown
    on the canvas.
  - The import file is limited to 72 MB. v1 keeps its own validator and 1 MB bound.
  - **Saved `rawHtml`:** used only for list, option and ancestry facts. It's bounded before
    parsing (1,000,000 characters, 15,000 opening tags, the depth and node budget), and nothing
    in it is executed or fetched.
  - **SVG:** numbers must be finite with magnitude at most 1e6, with at most 20,000 numbers and
    commands per attribute. `<?xml`, `data:`, `style`/`class` on shapes, and any unknown element or
    attribute reject the whole SVG. The plugin re-checks the canonical form before
    `createNodeFromSvg`, and the imported root is tracked for rollback; its descendants go with it.
- **Evidence-gated corrections:** each correction runs only when its evidence is present, and is
  recorded in the page notes:
  - **Default: measured geometry is kept.** If the measured page size differs from the reference
    screenshot's pixel size, a warning says so and nothing is moved.
  - **Opt-in `--normalize-reference centered-dpr1`.** By passing this flag the operator
    acknowledges two assumptions: the page centers fixed-width content, and the screenshot was
    taken at device pixel ratio 1. It applies two **inferred** normalizations:
    - **Width:** full-bleed boxes are stretched to the reference width, margin-anchored boxes are
      narrowed, and centered content is shifted by half the width difference. Boxes outside the
      target are counted.
    - **Hidden scrollbars:** if the measured page is taller than the reference by Δ, and Δ/N per
      horizontally overflowing container is 5–25 px, that amount is removed from each container
      and everything below moves up. Otherwise there's a warning.

    Each page records `normalization { mode, measuredWidth, measuredHeight, offsetX, gutterPx,
    gutters }` and an "INFERRED normalization" note, so the original measurement stays recoverable.
  - **Clip groups:** horizontally overflowing containers always become clip groups. This is
    observed overflow. References are always shown at their native pixel size, 1:1.
  - **Clip membership:** taken from the observed DOM ancestry in the saved `rawHtml`, with
    geometry as a fallback. Without `rawHtml`, cells that start outside their container can't be
    attributed.
  - **Text repair:** text fragments split inside a surrogate pair or grapheme cluster are rejoined
    from the adjacent runs. Unpairable leftovers are removed with a warning, and the validator
    rejects lone surrogates.
  - **List markers:** reconstructed only for `<li>` with measured `display: list-item`, using
    list type and ordinal from `rawHtml`. The glyph and offset are inferred, and nav lists are
    skipped.
  - **Controls:**
    - multi-select option rows use their measured rects plus labels from `rawHtml`
    - radios use their measured `%` radius
    - the checked-radio center, select caret and textarea grip are inferred static approximations
    - inferred labels are never width-fitted
  - **SVG:** inline SVGs pass through an allowlist sanitizer: `path`/`circle`/`ellipse`/`rect`/
    `line`/`poly*`/`g` only, numeric and colour attributes only, no scripts, styles, references,
    URLs, entities, text or `foreignObject`, at most 32 KB and 200 elements. Canonical markup is
    rebuilt and imported with `figma.createNodeFromSvg`. Anything else is omitted with the reason.
  - **Shared components:** identical nav/footer regions across pages (structure, text and geometry)
    become shared components. Each page gets instances, with paint differences as overrides.
    Sitemap edges follow the URL path hierarchy.
  - **Fonts:** the measured CSS stack order is honoured against the fonts installed in Figma. The
    browser's resolved OS font is never claimed. `--font-map monospace="Roboto Mono"`
    (repeatable, `MATCH=Family`) is an explicit operator choice and is reported as
    "operator font map" on the canvas.
- **Tall reference tiling (offline, `pngjs` 7.0.0, MIT):** applies only to REFERENCE PNGs up to
  4096 px wide and 65,536 px tall. Body images keep the 4096 px rule. The steps:
  1. **Preflight, before any decoder allocation:**
     - PNG signature, and a 13-byte IHDR first
     - valid bit depth and colour type, and no interlacing (interlaced data is inflated without an
       output bound by `pngjs`)
     - chunk lengths are checked against the file size, at most 10,000 chunks, IDAT present, IEND
       present
     - at most 40M source pixels, and the file size bound
  2. **Worker:** decoding runs in a worker with a 60 s deadline and heap caps. The IDAT stream is
     first inflated with `maxOutputLength` equal to the exact expected raw size, which stops
     decompression bombs and short data before `pngjs` decodes, with CRC checking on.
  3. **Tiles:** the image is sliced into tiles of at most 4096 px (at most 16), each re-encoded as
     PNG. Each tile is verified for offset, size, PNG header and SHA-256, then embedded like any
     other asset.
  4. **Record:** the page records `referenceTiles { sourceSha256, sourceWidth, sourceHeight,
     tiles[{ assetId, y, h }] }`. The validator requires contiguous tiles that sum to the source
     height, with tile assets matching their rects.
  5. **Reassembly:** the plugin places the tiles at their original offsets inside one reference
     frame, at native 1:1 size.
- **Reporting:** each page's notes on the canvas list:
  - font substitutions (measured stack → actual Figma font) and font-load failures
  - missing images (dashed `MISSING IMAGE` placeholders)
  - missing or rejected references, truncation, omitted SVGs
  - text runs whose width couldn't be fitted

  The node cap drops decorative boxes first and text last.
- **Native package:** `plugin-dist/` is built by `npm run dist` and committed. It has the manifest
  with a placeholder `id`, `code.js`, `ui.html`, synthetic samples, notices and `SHA256SUMS`.
- **Not done yet:**
  - This is an **absolute desktop snapshot**, not responsive auto-layout, and not pixel-perfect.
  - Browser fonts and emoji artwork differ.
  - Static controls aren't interactive.
  - Tall reference screenshots are tiled offline (see "Tall reference tiling"). JPEG references,
    references wider than 4096 px, and any body image over 4096 px are still rejected with a
    warning. A rejected reference's hash-verified size is still used as evidence.
  - Importing into real Figma has **not** been verified from this repo. The renderer is tested
    against a fake `figma` object only.

## Figma plugin (development)

```sh
npm run build        # -> plugin/dist/code.js, plugin/dist/ui.html
```

Setup in the Figma desktop app. Figma's manifest docs describe `id` as an ID that Figma
assigns, "typically obtained using the 'Create new Plugin' feature". So this repo ships an
obvious placeholder rather than an invented ID:

1. Go to **Plugins → Development → New plugin…** (wording from Figma's quickstart guide) and
   create a throwaway plugin. Figma generates a manifest with a new `"id"`.
2. Copy that `id` value into `plugin/manifest.json`, replacing `REPLACE-WITH-FIGMA-GENERATED-ID`.
   Don't commit your personal plugin ID unless you mean to.
3. Run `npm run build`, then use Figma's development menu to import `plugin/manifest.json`. The
   "Import plugin from manifest…" wording isn't covered by the docs checked here.
4. Run the plugin, choose a JSON file (for example `samples/fixture-10.json`) or paste one, and
   click **Import**.

What it creates on the current page, to the right of any existing content:

- **Components section.** Repeated structures become components:
  - a nav or footer used on 2+ pages with *identical* content (content signature)
  - cards with the same shape (title+text, title only or text only)
  Different navs (for example a docs sub-nav) get separate components. One-off structures stay
  plain frames.
- **Sitemap section**, placed separately below the components:
  - one auto-layout page frame per page (Inter Regular/Bold, loaded before text is set)
  - instances of the components above, with each card instance's own text overridden
  - sitemap edges drawn as vector polylines with arrow caps. `createConnector` is FigJam-only, so
    it is not used.
  - a note showing the source, truncated/incomplete flags and crawl notes

Plugin safety: `networkAccess.allowedDomains: ["none"]` and `documentAccess: "dynamic-page"`.
The UI only posts the JSON text. The main thread accepts just two message shapes and validates the
JSON before creating any node. If the build fails, partial output is removed. The UI renders
messages with `textContent` only, and nothing from the JSON is interpreted as HTML.

### Packaging

```sh
npm run package
# artifacts/website-to-figma-plugin/      manifest.json, dist/, samples/
# artifacts/website-to-figma-plugin.zip   same folder, zipped
```

`dist/`, `plugin/dist/`, `out/`, `artifacts/` and `.env` are git-ignored. The committed
`samples/fixture-{5,10,20}.json` are synthetic and regenerated by `npm run samples`, and a test
checks they are byte-identical to the generator output. A sample JSON shows the data format only.
It is not evidence of what Figma renders.

## Security model

URL checks (`src/security/urlGuard.ts`) run on the start URL and on every page's final URL:

- only `http:`/`https:` URLs; embedded credentials and non-default ports are rejected
- local/reserved names (`localhost`, `.local`, `.internal`, `.home.arpa`, `.test`, …) and
  single-label hosts are rejected
- IP literals and **every** local DNS answer must be public unicast. This is classified by
  [`ipaddr.js`](https://github.com/whitequark/ipaddr.js), which covers private, loopback,
  link-local (including `169.254.169.254`), CGNAT, ULA, multicast, reserved, and IPv4-mapped,
  NAT64, 6to4 and Teredo forms.
- **One owner-approved exception (2026-11-07):** for URLs sent to or returned by *hosted Firecrawl*
  whose hostname is exactly `simplecss.org`, the local DNS-answer lookup is skipped. That means
  only the crawl start URL and Firecrawl's reported final URLs. It does not cover `www.`,
  subdomains, a trailing dot or any other host. The operator's local resolver is a FakeIP proxy
  (`198.18.0.0/15`), so its answers say nothing about the hosted fetch.
  - All structural checks still apply: scheme, credentials, ports, IP literals (`198.18.0.0/15`
    literals are always rejected), local/reserved names, exact same-site matching, exclusions and
    query handling.
  - **Risk:** for this one hostname, whether it resolves to a private address, DNS rebinding and
    redirect hops all depend only on Firecrawl's own documented "Network protections"
    (https://docs.firecrawl.dev/security). This project has not independently verified those
    controls. Every other host, and any local fetch, keeps the full local DNS check.
- same-site means the same hostname, with one leading `www.` treated as equivalent. There is no
  suffix matching, so `evil.example.com` and `example.com.evil.net` are both different sites.

Final URLs come from Firecrawl's `metadata.url`, which the SDK describes as the "URL reported by
the selected scrape engine". It is checked separately from the requested `sourceURL`. Each crawled
document is shape-checked, because the SDK passes API JSON through without normalizing it.
Pages with no reported final URL, a non-public or off-site final URL, a 4xx/5xx status or no HTML are
dropped. Each drop sets `incomplete` and adds a note. If no page survives, the CLI aborts and
writes nothing.

**Limits of these checks:** Firecrawl fetches pages from its own infrastructure, using its own DNS
and redirect handling. This tool cannot see which IPs Firecrawl connected to or the intermediate
redirect hops. The checks are client-side filters on the URLs sent and received; they are not a
hosted SSRF control.

Page HTML is treated as inert data. It is parsed with `node-html-parser` and only bounded plain
text is kept. Scripts, styles and forms are skipped, and nothing is executed or fetched. Bounds
cover HTML size, depth and node count; text lengths; nav/footer/card/block counts per page and
document-wide; JSON bytes; pages; and edges.

The Firecrawl API key is only read by the local `crawl` command, from the environment or a
git-ignored `.env`. It is never written to output or logs.

## Development

```sh
npm run typecheck    # CLI (Node types) + plugin (Figma typings, ES2020 lib, no DOM/Node)
npm test             # vitest: fixtures, normalization/caps, schema, URL safety, layout
npm run build        # esbuild; the plugin is bundled for platform "neutral" so Node built-ins fail the build
```

## References (official docs checked while building)

- Firecrawl crawl: https://docs.firecrawl.dev/features/crawl
- Firecrawl map: https://docs.firecrawl.dev/features/map
- Figma plugin manifest: https://developers.figma.com/docs/plugins/manifest/
- How plugins run (sandbox vs UI iframe): https://developers.figma.com/docs/plugins/how-plugins-run/
- Libraries and bundling: https://developers.figma.com/docs/plugins/libraries-and-bundling/
- Plugin quickstart (desktop app requirement): https://developers.figma.com/docs/plugins/plugin-quickstart-guide/

## License

No license has been chosen yet.
