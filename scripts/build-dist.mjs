// Builds the self-contained CLI distributable:
//   cli/website-to-figma.mjs        single ESM file: CLI + bounded worker + all runtime deps
//   cli/THIRD_PARTY_NOTICES.txt     licenses of every bundled npm package (from the esbuild metafile)
//   cli/SHA256SUMS                  checksums of the two files above
// Runs on Node >= 20.12 with no node_modules. Deterministic for a given lockfile.
import { build } from "esbuild";
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
