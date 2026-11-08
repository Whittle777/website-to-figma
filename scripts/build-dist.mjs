// Builds the self-contained CLI distributable:
//   cli/website-to-figma.mjs        single ESM file: CLI + bounded worker + all runtime deps
//   cli/THIRD_PARTY_NOTICES.txt     licenses of every bundled npm package (from the esbuild metafile)
//   cli/SHA256SUMS                  checksums of the two files above
// Runs on Node >= 20.12 with no node_modules. Deterministic for a given lockfile.
import { build } from "esbuild";

// Escape raw C0 control characters (outside \t\n\r) that esbuild may emit
// inside string literals, so the published bundle is plain printable ASCII.
function escapeControls(file) {
  const src = readFileSync(file, "utf8");
  const out = src.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, (c) => "\\x" + c.charCodeAt(0).toString(16).padStart(2, "0"));
  if (out !== src) writeFileSync(file, out);
}
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isBuiltin as isBuiltinModule } from "node:module";

const OUT = "cli/website-to-figma.mjs";
mkdirSync("cli", { recursive: true });

const result = await build({
  entryPoints: ["src/distEntry.ts"],
  outfile: OUT,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  // Bundled CommonJS dependencies call require() for Node built-ins; give the
  // ESM bundle a real require.
  banner: {
    js: [
      "#!/usr/bin/env node",
      "// website-to-figma CLI (single-file build). Third-party licenses: THIRD_PARTY_NOTICES.txt",
      'import { createRequire as __w2fCreateRequire } from "node:module";',
      "const require = __w2fCreateRequire(import.meta.url);",
    ].join("\n"),
  },
  define: { __W2F_SELF_WORKER__: "true" },
  legalComments: "none",
  metafile: true,
  logLevel: "warning",
});

const code = readFileSync(OUT, "utf8");
// Every import esbuild left external must be a Node built-in (from the metafile,
// not a text scan).
const outImports = result.metafile.outputs[OUT]?.imports ?? [];
// `supports-color` is an optional require inside a try/catch in `debug`
// (node_modules/debug/src/node.js:29-32, via axios > https-proxy-agent); it is
// not installed and its absence is swallowed at runtime.
const OPTIONAL_TRY_REQUIRES = new Set(["supports-color"]);
const external = [...new Set(outImports.filter((i) => i.external).map((i) => i.path))].filter(
  (p) => !p.startsWith("node:") && !isBuiltinModule(p) && !OPTIONAL_TRY_REQUIRES.has(p),
);
if (external.length > 0) throw new Error(`Bundle still references non-builtin modules: ${external.join(", ")}`);
console.log(`External imports (all Node built-ins): ${[...new Set(outImports.filter((i) => i.external).map((i) => i.path))].sort().join(", ")}`);

// Third-party notices from the packages actually bundled.
const pkgDirs = new Set();
for (const input of Object.keys(result.metafile.inputs)) {
  const m = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input);
  if (m) pkgDirs.add(m[1]);
}
const entries = [];
for (const dir of [...pkgDirs].sort()) {
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const licenseFiles = readdirSync(dir).filter((f) => /^(licen[sc]e|copying|notice)(\.|-|$)/i.test(f)).sort();
  entries.push({ name: pkg.name, version: pkg.version, license: typeof pkg.license === "string" ? pkg.license : JSON.stringify(pkg.license ?? null), dir, licenseFiles });
}
const missing = entries.filter((e) => e.licenseFiles.length === 0);
let notices = [
  "THIRD-PARTY NOTICES for cli/website-to-figma.mjs",
  "",
  "This file bundles the npm packages listed below. Their license terms follow.",
  "website-to-figma's own source has no license chosen yet; this file grants none.",
  "",
  ...entries.map((e) => `- ${e.name}@${e.version} (${e.license})`),
  "",
];
for (const e of entries) {
  notices.push("=".repeat(78), `${e.name}@${e.version}  License: ${e.license}`, "=".repeat(78));
  if (e.licenseFiles.length === 0) {
    // Some packages carry their license only as a README section; copy it verbatim.
    const readme = existsSync(join(e.dir, "README.md")) ? readFileSync(join(e.dir, "README.md"), "utf8") : "";
    const at = readme.search(/^#*\s*Licen[sc]e\s*\n(?:-{3,}\s*\n)?/im);
    if (at >= 0) notices.push("--- README.md (License section, verbatim) ---", readme.slice(at).trimEnd(), "");
    else notices.push("(No license text is shipped in this package; license per its package.json field above.)", "");
  }
  for (const f of e.licenseFiles) notices.push(`--- ${f} ---`, readFileSync(join(e.dir, f), "utf8").trimEnd(), "");
}
writeFileSync("cli/THIRD_PARTY_NOTICES.txt", notices.join("\n") + "\n");

const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
writeFileSync("cli/SHA256SUMS", [`${sha(OUT)}  website-to-figma.mjs`, `${sha("cli/THIRD_PARTY_NOTICES.txt")}  THIRD_PARTY_NOTICES.txt`].join("\n") + "\n");

console.log(`Built ${OUT} (${code.length} bytes), ${entries.length} bundled packages${missing.length ? `, ${missing.length} without a license file: ${missing.map((e) => e.name).join(", ")}` : ""}`);
console.log(readFileSync("cli/SHA256SUMS", "utf8").trimEnd());
if (!existsSync("cli/README.md")) console.warn("cli/README.md missing");

// ---------------------------------------------------------------------------
// Native Figma development plugin package (public, code-only, deterministic):
//   plugin-dist/manifest.json  (placeholder id; main code.js, ui ui.html)
//   plugin-dist/code.js        (sandbox bundle built from plugin/src + src/shared)
//   plugin-dist/ui.html        (copied verbatim from plugin/src/ui.html)
//   plugin-dist/samples/       (SYNTHETIC samples only)
//   plugin-dist/THIRD_PARTY_NOTICES.txt, README.md, SHA256SUMS
const PD = "plugin-dist";
mkdirSync(`${PD}/samples`, { recursive: true });
const plugin = await build({
  entryPoints: ["plugin/src/code.ts"],
  charset: "ascii",
  outfile: `${PD}/code.js`,
  bundle: true,
  platform: "neutral",
  format: "iife",
  target: "es2020",
  legalComments: "none",
  metafile: true,
  logLevel: "warning",
});
escapeControls(`${PD}/code.js`);
const pluginInputs = Object.keys(plugin.metafile.inputs).sort();
const thirdParty = pluginInputs.filter((p) => p.includes("node_modules/"));
const pcode = readFileSync(`${PD}/code.js`, "utf8");
for (const forbidden of ["require(", "process.", "import(", "eval(", "new Function", "fetch(", "XMLHttpRequest", "createImageAsync"]) {
  if (pcode.includes(forbidden)) throw new Error(`${PD}/code.js contains forbidden token: ${forbidden}`);
}
writeFileSync(`${PD}/ui.html`, readFileSync("plugin/src/ui.html"));
const manifest = JSON.parse(readFileSync("plugin/manifest.json", "utf8"));
manifest.main = "code.js";
manifest.ui = "ui.html";
writeFileSync(`${PD}/manifest.json`, JSON.stringify(manifest, null, 2) + "\n");
for (const f of ["fixture-5.json", "hifi-synthetic.json", "hifi-states-synthetic.json"]) writeFileSync(`${PD}/samples/${f}`, readFileSync(`samples/${f}`));
writeFileSync(
  `${PD}/THIRD_PARTY_NOTICES.txt`,
  thirdParty.length
    ? `code.js bundles these third-party inputs:\n${thirdParty.join("\n")}\n`
    : "code.js and ui.html bundle no third-party packages (esbuild inputs are only this repository's plugin/src and src/shared sources).\nwebsite-to-figma's own source has no license chosen yet; this file grants none.\n",
);
writeFileSync(
  `${PD}/README.md`,
  [
    "# website-to-figma: native Figma development plugin (built package)",
    "",
    "Built by `npm run dist` from this commit's sources; not hand-edited. Bundled inputs:",
    "",
    ...pluginInputs.map((p) => `- \`${p}\``),
    "",
    "## Install (Figma desktop app)",
    "1. Plugins > Development > New plugin... (Figma generates a manifest with an `id`); copy that id",
    "   into `manifest.json` here, replacing `REPLACE-WITH-FIGMA-GENERATED-ID`.",
    "2. Import this folder's `manifest.json` from Figma's development plugin menu.",
    "3. Run it and choose a JSON file: `samples/fixture-5.json` (schemaVersion 1, low-fi) or",
    "   `samples/hifi-synthetic.json` (schemaVersion 2, measured hi-fi; SYNTHETIC, not a real site), or",
    "   `samples/hifi-states-synthetic.json` (SYNTHETIC state variants: combineAsVariants + ON_CLICK/CHANGE_TO).",
    "",
    "The plugin has `networkAccess: none`, validates everything before creating nodes, verifies each",
    "embedded image (length, SHA-256, PNG/JPEG/GIF header, <= 4096 px) and rolls back on failure.",
    "Not verified by importing into real Figma from this repository; not pixel-perfect; not affiliated",
    "with Figma. Integrity: compare files with `SHA256SUMS`.",
    "",
  ].join("\n"),
);
const pdFiles = ["manifest.json", "code.js", "ui.html", "README.md", "THIRD_PARTY_NOTICES.txt", "samples/fixture-5.json", "samples/hifi-synthetic.json", "samples/hifi-states-synthetic.json"];
writeFileSync(`${PD}/SHA256SUMS`, pdFiles.map((f) => `${sha(`${PD}/${f}`)}  ${f}`).join("\n") + "\n");
console.log(`Built ${PD}/ (${pcode.length} bytes code.js; third-party inputs: ${thirdParty.length})`);
console.log(readFileSync(`${PD}/SHA256SUMS`, "utf8").trimEnd());

// ---------------------------------------------------------------------------
// Connector ($fig) renderer bundle (public, code-only, deterministic): the
// SAME shared renderer (plugin/src/render) with the planned host
// (src/connector/plannedHost.ts). Embedded verbatim by `fig-plan` job scripts.
//   connector-dist/w2f-connector-renderer.js, README.md, SHA256SUMS
const CD = "connector-dist";
mkdirSync(CD, { recursive: true });
const conn = await build({
  entryPoints: ["src/connector/entry.ts"],
  charset: "ascii",
  outfile: `${CD}/w2f-connector-renderer.js`,
  bundle: true,
  minify: true,
  platform: "neutral",
  format: "iife",
  globalName: "W2F",
  target: "es2020",
  legalComments: "none",
  metafile: true,
  logLevel: "warning",
});
escapeControls(`${CD}/w2f-connector-renderer.js`);
const connInputs = Object.keys(conn.metafile.inputs).sort();
if (connInputs.some((p) => p.includes("node_modules/"))) throw new Error("connector bundle must not include third-party packages");
const ccode = readFileSync(`${CD}/w2f-connector-renderer.js`, "utf8");
for (const forbidden of ["require(", "process.", "import(", "eval(", "new Function", "fetch(", "XMLHttpRequest", "figma.create", "createImage", "combineAsVariants", "setVectorNetwork", "setPluginData"]) {
  if (ccode.includes(forbidden)) throw new Error(`${CD}/w2f-connector-renderer.js contains forbidden token: ${forbidden}`);
}
writeFileSync(
  `${CD}/README.md`,
  [
    "# website-to-figma connector renderer (planned $fig host)",
    "",
    "The same shared renderer as the native plugin (plugin/src/render), driven by a host that only uses",
    "the Figma connector's $fig plan constructors (frame, rectangle, text, svg, component, instance, ellipse,",
    "variants, get, done) and wrapper .append/.set/.query(...).set/.node. Raw reads, raw font loads and",
    "ON_CLICK -> CHANGE_TO reactions run only after `await $fig.done()`.",
    "",
    "Do not run this file directly: `website-to-figma fig-plan --doc site-v2.json --out DIR` writes",
    "ordered job scripts that embed this file verbatim plus one job input each.",
    "",
    "Not supported by this host (reported in every job result, never faked): image fills (placeholders",
    "with sha256 instead), pluginData provenance, vector networks (SVG polylines instead), edge grouping.",
    "UNVERIFIED here: the argument shape of $fig.variants(components, { name }). Not run against Figma.",
    "",
  ].join("\n"),
);
const cdFiles = ["w2f-connector-renderer.js", "README.md"];
writeFileSync(`${CD}/SHA256SUMS`, cdFiles.map((f) => `${sha(`${CD}/${f}`)}  ${f}`).join("\n") + "\n");
console.log(`Built ${CD}/ (${ccode.length} bytes renderer bundle)`);
console.log(readFileSync(`${CD}/SHA256SUMS`, "utf8").trimEnd());
