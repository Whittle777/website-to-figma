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
| Interactive states / motion | **Planner plus gated executor; never run live.** `states-plan` writes request previews and sends nothing. `states-run` executes exactly those previews, one hosted request per page with one attempt. It is tested only with fake clients. There is **no click or real-interaction support**: only declarative synthetic DOM modifications, which are labelled synthetic and carry **no handler side-effect guarantee**. Provider cost is **unknown**. The local ledger is an operator-asserted allowance, **not a provider credit cap**. |
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

## Interactive states and motion (planner + gated hosted executor)

> **Limitations, stated up front**
> - **Never run live from this repo.** The executor (`states-run`) is code plus fake-client tests
>   only. No live request, key read or account call was made while building it.
> - **No real interactions.** A selector does not prove that a click handler is safe: it could
>   submit a form, log in, make a purchase, follow an outbound link or navigate. So `click`,
>   `hover`, `focus`, typing, key presses, submit, navigation and arbitrary JavaScript are
>   refused. Put such states under `manual` and capture them yourself. Actual interactive
>   behaviour is **unsupported**.
> - **Synthetic, not observed.** The only states are declarative DOM modifications:
>   - `details-open`
>   - `attribute-set`, limited to `open` on `<details>`, `aria-expanded`, `aria-selected`,
>     `aria-hidden`, `hidden` and `data-state`
>   - `class-add`
>
>   Optional forced AOS visibility (`forceAos`) is also a modification. All of these are labelled
>   **synthetic** everywhere, never as observed original states.
> - **No handler side-effect guarantee.** Attribute, class and `open` changes can still run page
>   code: MutationObservers, `toggle` listeners and custom-element callbacks. The scripts do what
>   they can:
>   - refuse custom elements and form, link, button, embedding and media elements
>   - stop `toggle` in the capture phase
>   - revert after measuring (including on error)
>
>   Page observers cannot be prevented. The operator must pass
>   `--acknowledge-synthetic-modifications`.
> - **Cost unknown.** Firecrawl documents 1 credit per scrape (cached results still cost 1) and +4
>   for JSON mode. It publishes no price for actions, screenshots or multiple screenshots, and
>   threat-scan and redirect charges are unresolved. This tool sets **no price**:
>   `--operator-credits-per-request` is the operator's own asserted reservation, and actual
>   charges may exceed it.
> - **The ledger is not a hard cap.** It is a local file holding a 1000-credit *project budget
>   ceiling*: an operator-asserted reservation and accepted-risk allowance. It gives no pre-send
>   guarantee and is not a provider-enforced cap.
> - **Freeze is partial.** CSS animations and transitions, Web Animations, `<video>` and Swiper
>   autoplay are paused where present. JS timers, `requestAnimationFrame` loops and WebGL/canvas
>   rendering are **not** frozen.
> - **No async JavaScript.** Firecrawl's docs and the open-source code do not say whether
>   `executeJavascript` awaits promises; that happens inside the closed fire-engine. So every
>   script is a **synchronous** IIFE, the same form as Firecrawl's own branding script, and every
>   delay is a documented provider `wait` action. States are measured synchronously after the
>   modification, so page JS that reacts asynchronously is **not** awaited. Readiness (fonts,
>   incomplete images) is observed and recorded, not waited for. If returns are missing or out of
>   order, the run stops as *ambiguous* and is never retried.
> - **Not run live.** The source-verified behaviour above comes from reading the code, the docs
>   and loopback transport tests of the installed SDK. No real hosted capture has been executed.
> - **Bounds.**
>   - 1 site, ≤ 3 pages, and ≤ 3 states per page *including* the baseline and manual states.
>   - ≤ 50 actions per request (default budget 20). Every wait, freeze, lazy/visibility-settle,
>     state, screenshot, scrape and revert step counts.
>   - Combined waits ≤ 60 s (default 30 s), including in-script sleeps and the visibility settle.
>   - Each state's measurement is ≤ 6,000,000 chars, and screenshots are viewport-only.

### Supported and unsupported interactions

The real multi-state UI goal is **unfinished**. Baseline and synthetic states are a partial
substitute.

| Interaction | Status |
| --- | --- |
| Baseline (unmodified page) after a fixed wait and freeze | Supported (observed). With a scroll-reveal state it is the initial, unscrolled view. |
| `scroll-reveal`: the page's own reaction to the planned provider scroll steps (e.g. AOS scroll listeners) | Supported as **scroll-triggered** (observed page reaction; no DOM edit by this tool beyond the recorded freeze) |
| `swiper-next`: the page's own Swiper instance, bound to exactly one validated `.swiper` element (`el.swiper`), advanced with `slideNext(0)`, the call its autoplay makes; reverted with `slidePrev(0)` | Supported as **page-api** (actual library state reached via the page API, not a user event; Swiper's listeners run). Refused if the selector is ambiguous, the instance is unbound/foreign/destroyed, or the element is inside a form, link or button. Omitted if the slider did not move. |
| `<details open>`, an allowlisted `aria-*` / `hidden` / `data-state` attribute, or a CSS class on declared elements | Supported as **synthetic** DOM modification; no handler side-effect guarantee |
| Forced AOS visibility | Supported as a recorded modification |
| Click, hover, focus, keyboard, typing, form submit, login, purchase, outbound link, navigation, arbitrary JS | **Unsupported** (refused); operator-captured `manual` screenshots only |
| JS-driven menus, tabs, modals or carousels that need their own event handlers | **Unsupported**. Supporting them would need a separate security decision on executing page handlers, which has not been made. |
| Async page reactions after a modification; timers, `requestAnimationFrame`, WebGL | Not awaited, not frozen; reported |

### 1. Plan and review (offline)

```sh
website-to-figma states-plan --plan samples/state-plan.bootslander.json --out preview.json
```

**Request shape.** The preview is the exact `POST /v2/scrape` body for each page. Its keys are
exactly `url`, `formats: ["rawHtml"]`, `onlyMainContent: false`, `proxy: "basic"`, `timeout` and
`actions`. The SDK adds its own `origin` attribution tag.

**Omitted options.** No vendor or account safety option is sent: `threatProtection`,
`checkPromptInjection`, `redactPII`, `lockdown`, `blockAds`, `removeBase64Images`, `parsers`,
`mobile` and `waitFor` are omitted, so provider and team defaults apply unchanged. Firecrawl's
schema defaults are listed in `apps/api/src/controllers/v2/types.ts:861-872`. `proxy: "basic"` is
a cost and routing choice: the schema default `auto` may escalate.

**Actions.** In order:
1. `wait` (page settle)
2. freeze (sync)
3. *n* × (sync `scrollTo` step, then `wait`); the last `wait` is the visibility settle
4. for each state:
   1. sync **apply**: the mutation or trigger, then `scrollIntoView` of the state's scope, or the
      top for the baseline
   2. provider `wait` (`settleMs`)
   3. sync **measure + verify**
   4. `screenshot` (viewport)
   5. `scrape`
   6. sync revert, for synthetic and page-api states

**Verify record.** Each state records scrollY, the CSS viewport, the document height, and the
target's viewport-relative bounds. A provider *action* viewport taller than the largest documented
screenshot viewport (7680×4320) is flagged as **expanded**. A private hosted run observed
1920×100000, with `scrollY` stuck at 0 and every screenshot showing the page top. When the
viewport is expanded, screenshot position is marked **unverifiable**, and the converter treats it
like this:
- **Viewport vs document.** The CSS viewport is kept separate from the document height and a
  warning is added (vh-based layout may be distorted).
- **Variant crop.** Each variant is cropped in local coordinates before any height bound, so deep
  targets keep their editable nodes.
- **Tall pages.** Pages taller than 30,000 px are split into at most 4 segment pages.
- **Identical screenshots.** Byte-identical state screenshots are flagged `distinct: false` and
  are never presented as distinct visual states.

The screenshot `viewport` option is documented only as "Max viewport resolution is 7680×4320". Its
effect on layout is undocumented, so it is not used. Firecrawl's `scroll` action does not scroll a
target into view: in `scrape-replay.ts` it scrolls by `innerHeight` or by a mouse wheel.

**Timing.** The combined wait is exactly the provider's accounting: the sum of
`wait.milliseconds`, with in-script sleep always 0. Firecrawl source
`apps/api/src/controllers/v2/types.ts:251-268,347-356` sets `MAX_ACTIONS = 50` and a 60 s total
wait.
- **`timeout`:** `min(120000, 20000 + 2 × waits + 10000 × states)`. Waits never exceed half of it.
- **SDK HTTP timeout:** `timeout + 5000`, because `autoResume` is `false` (SDK
  `dist/index.js:564`).
- **Wall clock:** `timeout + 30000`.

**Result mapping.** Firecrawl source `fire-engine/index.ts:617-648,687-693` maps the response like
this:

| Response field | Contents | Used for |
| --- | --- | --- |
| `actions.javascriptReturns[i] = {type, value}` | The *i*-th `executeJavascript`, in order: freeze, each scroll, then per state the state and its revert | Tagged `value.w2f` provenance |
| `actions.screenshots[j]` | URL for state *j* | Viewport screenshot |
| `actions.scrapes[j] = {url, html}` | HTML for state *j* | Per-state rawHtml |
| `metadata.url` | Final URL | URL guard (no redirects accepted) |
| `metadata.statusCode`, `metadata.contentType` | Page status and type | 2xx HTML check |
| `metadata.creditsUsed` | Request-specific credits | Ledger record (missing means ambiguous) |

The provider returns screenshots as URLs only. Inline screenshot bytes are not supported:
`rawBase64` is the page file and cannot be combined with other formats (`types.ts:493,836`). So
images come from the bounded local download or manual input.

### 2. Execute (paid, gated; one request per page)

```sh
website-to-figma ledger init --ledger ledger.json --prior-credits 15 --note "operator-attributed prior project spend"
website-to-figma states-run --plan PLAN --preview preview.json --out private-runs --ledger ledger.json \
  --operator-credits-per-request N --operator-reported-balance N --confirm-existing-credits \
  --confirm-no-topup --acknowledge-synthetic-modifications          # prints plan + stop conditions, HOLDS
#   ... add --yes only after review
```

**Order.** Every step below completes before the API key is requested:
1. The preview file must equal the plan's rebuilt preview byte for byte (canonical JSON).
2. Every request is re-validated semantically.
3. Every operator gate is checked.
4. The ledger is checked: no unresolved, ambiguous or overrun entry, no identical earlier request
   (unless `--reviewed-continuation <entry id>`), and room within the ceiling.
5. The hosted URL guard runs. The exact `simplecss.org` and `bootstrapmade.com` DNS exceptions
   still apply, along with every structural rule.

**One attempt.** This is source-verified in the installed `@mendable/firecrawl-js` 4.52.0
`dist/index.js`, and proven by loopback transport tests of the real SDK
(`test/sdkTransport.test.ts`):
- **Retries.** `HttpClient.request` loops `for (attempt = 0; attempt < maxRetries; …)` (`:85`),
  and its only retry is HTTP 502 while `attempt < maxRetries - 1` (`:103,:111`). `maxRetries: 1`
  therefore means exactly one POST.
- **Resume.** `scrape()` re-POSTs on `408 SCRAPE_TIMEOUT processing_continues` only when
  `autoResume !== false` (`:584-585`). `autoResume` is SDK-only and never sent (`:560`).
- **Endpoint.** The endpoint is pinned to `https://api.firecrawl.dev`, because the SDK otherwise
  falls back to `FIRECRAWL_API_URL` (`:2467`). The crawl client gets the same pin; no other crawl
  setting changed.
- **No fallbacks.** There is no one-request-per-state fallback, and no retry or duplicate after a
  partial or ambiguous response.

**Ledger.** The paid attempt is written *before* sending and the result *after*. A crash leaves an
`attempting` entry that blocks every later paid request until `ledger resolve`.
- Only request-specific `metadata.creditsUsed` is recorded. Account-wide deltas are never used.
- If no `creditsUsed` is reported, the entry stays **ambiguous** and is never settled at an assumed
  price. The remaining pages are stopped.
- If `creditsUsed` exceeds the reservation, an **overrun** is recorded. The remaining pages are
  stopped, and later runs are blocked until the operator resolves it.

**Responses.** A response is accepted only when:
- the final URL passes the hosted URL guard, is on the same site, and equals the requested URL
  (redirects are refused)
- the status is 2xx and the content is HTML
- every tagged return, screenshot and scrape is present and in order

Each page records checkpoints, the applied freeze, per-state applied, refused and missing counts,
and revert results.

**Files.** Output goes to a new owner-only run directory (`0700` directory, `0600` files,
`O_EXCL`, symlinks refused, never overwritten). It holds raw page content, so keep it private and
never commit it. The ledger is written atomically and locked. The API key is never written or
printed, and error text is redacted.

**Stop conditions:**
- the preview does not match or fails validation
- a gate is missing
- the ledger is unresolved, would be exceeded, or already holds the same request
- a URL guard fails, or the page redirected, went off-site, returned non-2xx or was not HTML
- SDK error: 4xx means failed; timeout, network, 5xx and 408 mean ambiguous
- tagged returns, screenshots or scrapes are missing or out of order
- `creditsUsed` is missing or above the reservation
- an earlier page was not accepted

### 3. Screenshots (bounded local download, optional)

```sh
website-to-figma states-screenshots --run private-runs/state-run-<id> --out private-assets   # lists, HOLDS
#   ... add --yes to download
```

- **Eligible URLs.** Only screenshot URLs listed by an *accepted* run and tied to a state by action
  order are fetched.
- **Guard.** This is a local fetch, so the full local URL and DNS guard applies, with **no hosted
  exception**. The connection is pinned to the validated address. Each redirect is re-checked
  (https only, ≤ 3 hops).
- **Bounds.** The image is limited to 12 MB, must be PNG or JPEG, and must fit ≤ 4096 px wide,
  ≤ 65,536 px tall and ≤ 40M pixels. Its SHA-256 is written to an asset manifest
  (`kind: "reference"`, `pageUrl`, `state`).
- **Failures.** Under a FakeIP resolver every download fails closed. Download the images yourself
  and add them to the manifest. Screenshot URLs expire after 24 h.

### 4. Convert

- `hifi-capture --scrape private-runs/state-run-<id>/page-0.response.json` accepts only
  `accepted` runs. It carries run provenance (request hash, attempts, request-specific credits)
  into page notes.
- `hifi` builds the optional schema v2 `states`, `freeze`, `motion` and `media` fields:
  - Each state is converted from its own measurement.
  - Failed states are omitted.
  - Media stills come only from operator-local images.
- The plugin builds native component variants (`State=<name>`) with `figma.combineAsVariants`.
  `--state-reactions click-cycle` optionally adds `ON_CLICK` → `CHANGE_TO` reactions, and any
  failure rolls back the whole import.

Samples:
- `website-to-figma fixture hifi-states` (synthetic).
- `samples/state-plan.example.json`: 3 synthetic states, 19 actions.
- `samples/state-plan.bootslander.json`: 1 page, 3 states, 18 actions.
  - `Default`, the initial view before any scrolling.
  - `AOS revealed`, scroll-triggered (scope `#features`).
  - `Testimonial next`, page-api via `#testimonials .swiper.init-swiper`.

**Bootslander analysis.** Its selectors and semantics were checked against the public HTML and JS
(a normal public GET, not executed):
- **Swiper.** The page has exactly one `.init-swiper`, with no links, forms, buttons or inputs
  inside it. It is created by `new Swiper(el, config)` on `load` with loop, autoplay 5 s and
  clickable bullets, and no `on` handlers. Swiper 11.2.10's mount binds `el.swiper`. `slideNext`
  only does `loopFix` (reorders slides) plus `slideTo`.
- **Scroll handlers.** These only toggle classes: AOS (`once: true, mirror: false`, 99 ms
  throttled scroll listener), header `scrolled`, `.scroll-top.active` and navmenu scrollspy.
- **Not live.** None of this has been executed live.

## Figma connector adapter ($fig): same renderer, planned host

The native plugin and the connector adapter share **one renderer** (`plugin/src/render/`). The two
hosts differ only in how nodes are made:
- `NativeHost` uses `figma.create*`.
- `PlannedHost` (`src/connector/`) uses only the connector's `$fig` plan constructors: `frame`,
  `rectangle`, `text`, `svg`, `component`, `instance`, `ellipse`, `variants`, `get` and `done`,
  plus the wrapper's `.append`, `.set`, `.query(...).set` and `.node`.

`PlannedHost` follows these rules:
- **Post-flush only.** Raw reads (width, height, child lookup, available fonts), raw font loads and
  `ON_CLICK` → `CHANGE_TO` reactions happen only after `await $fig.done()`. Reading while plan
  nodes are pending throws.
- **Variants.** `$fig.variants` does not position variants, so they are laid out on an explicit
  grid and the set is resized after a flush.

```sh
website-to-figma fig-plan --doc site-v2.json --renderer connector-dist/w2f-connector-renderer.js \
  --renderer-sha256 <pinned sha256> [--max-job-chars 40000] [--image-hashes map.json] --out fig-jobs
```

`fig-plan` writes ordered job scripts and a `jobs.json` manifest, and makes **no Figma calls**:
- **Jobs.** Each job embeds the pinned renderer bundle verbatim plus one small job input. Every
  job is checked against `--max-job-chars` (default 40,000) while planning. If any job cannot fit
  (for example, a single SVG node that is too large), planning stops with a clear error and
  **nothing is written**. Job kinds:
  - `root`, then intro and notes `label` chunks
  - one empty `component` per shared component, then its node batches
  - per page: `page` shell (frame and references), node batches in phase order (unclipped, clip
    frames, clipped, text), then instances and media above them
  - `states`: empty components, `$fig.variants({ name }, children)`, the grid and reactions
  - per-variant node batches, which also set the description
  - `edges`

  Small pages still render in a single `page` job.
- **Order.** Run them yourself through the connector, in order. Later jobs find earlier frames by
  deterministic unique names (`[bN]` and `[cN]` keys, plus `[w2f <docKey>]` on the root).
- **Images.** Image fills are applied only when you supply `--image-hashes`. It maps asset sha256
  to an **existing** Figma image hash that the origin obtained through a sanctioned upload route,
  and those images get a standard `IMAGE` paint. Otherwise images become labelled placeholders.
  There is no fetch, no image creation and no invented hash.

Not supported and reported in every job result, never faked:
- `pluginData` provenance (kept in names, descriptions and results instead)
- vector networks (generated SVG polylines are used instead)
- edge grouping

`$fig.variants` is called with the figma-use signature, options first and children second:
`$fig.variants({ name }, components)`. The jobs have **not** been run against Figma. They are
tested only with a fake connector that enforces that signature and the plan and flush semantics.
Only those synthetic tests validate geometry; nothing here shows the variants are correct in a
live file.

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
- **Two owner-approved exceptions (`simplecss.org` 2026-11-07, `bootstrapmade.com` 2026-11-08):**
  for URLs sent to or returned by *hosted Firecrawl* whose hostname is exactly `simplecss.org` or
  exactly `bootstrapmade.com`, the local DNS-answer lookup is skipped. That means only the crawl
  start URL and Firecrawl's reported final URLs. It does not cover `www.`, subdomains, a trailing
  dot, IP literals or any other host, and never applies to a local fetch. The operator's local
  resolver is a FakeIP proxy (`198.18.0.0/15`), so its answers say nothing about the hosted fetch.
  - All structural checks still apply: scheme, credentials, ports, IP literals (`198.18.0.0/15`
    literals are always rejected), local/reserved names, exact same-site matching, exclusions and
    query handling.
  - **Risk:** for these two hostnames, whether they resolve to a private address, DNS rebinding and
    redirect hops all depend only on Firecrawl's own documented "Network protections"
    (https://docs.firecrawl.dev/security). This project has not independently verified those
    controls. Every other host, and any local fetch, keeps the full local DNS check.
  - The first planned state/motion candidate is `https://bootstrapmade.com/content/demo/Bootslander/`
    (`samples/state-plan.bootslander.json`; nothing has been fetched or sent for it).
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
