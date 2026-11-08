# website-to-figma: native Figma development plugin (built package)

Built by `npm run dist` from this commit's sources; not hand-edited. Bundled inputs:

- `plugin/src/code.ts`
- `plugin/src/hifi.ts`
- `src/shared/fonts.ts`
- `src/shared/hifiSchema.ts`
- `src/shared/imageInfo.ts`
- `src/shared/layout.ts`
- `src/shared/limits.ts`
- `src/shared/schema.ts`
- `src/shared/text.ts`

## Install (Figma desktop app)
1. Plugins > Development > New plugin... (Figma generates a manifest with an `id`); copy that id
   into `manifest.json` here, replacing `REPLACE-WITH-FIGMA-GENERATED-ID`.
2. Import this folder's `manifest.json` from Figma's development plugin menu.
3. Run it and choose a JSON file: `samples/fixture-5.json` (schemaVersion 1, low-fi) or
   `samples/hifi-synthetic.json` (schemaVersion 2, measured hi-fi; SYNTHETIC, not a real site).

The plugin has `networkAccess: none`, validates everything before creating nodes, verifies each
embedded image (length, SHA-256, PNG/JPEG/GIF header, <= 4096 px) and rolls back on failure.
Not verified by importing into real Figma from this repository; not pixel-perfect; not affiliated
with Figma. Integrity: compare files with `SHA256SUMS`.
