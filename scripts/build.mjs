// Builds the CLI bundle (dist/cli.js) and the Figma plugin (plugin/dist/).
// The plugin main thread is bundled for platform "neutral" so any accidental
// Node built-in import fails the build instead of shipping to the sandbox.
import { build } from "esbuild";

// Escape raw C0 control characters (outside \t\n\r) that esbuild may emit
// inside string literals, so the published bundle is plain printable ASCII.
function escapeControls(file) {
  const src = readFileSync(file, "utf8");
  const out = src.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, (c) => "\\x" + c.charCodeAt(0).toString(16).padStart(2, "0"));
  if (out !== src) writeFileSync(file, out);
}
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

await build({
  entryPoints: ["src/cli.ts", "src/normalize/buildWorker.ts", "src/hifi/tileWorker.ts"],
  outdir: "dist",
  entryNames: "[name]",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  packages: "external",
  logLevel: "warning",
});

mkdirSync("plugin/dist", { recursive: true });
await build({
  entryPoints: ["plugin/src/code.ts"],
  charset: "ascii",
  outfile: "plugin/dist/code.js",
  bundle: true,
  platform: "neutral",
  format: "iife",
  target: "es2020",
  logLevel: "warning",
});
escapeControls("plugin/dist/code.js");
copyFileSync("plugin/src/ui.html", "plugin/dist/ui.html");

const code = readFileSync("plugin/dist/code.js", "utf8");
for (const forbidden of ["require(", "process.", "import(", "eval(", "new Function"]) {
  if (code.includes(forbidden)) throw new Error(`plugin/dist/code.js contains forbidden token: ${forbidden}`);
}
console.log(`Built dist/cli.js, dist/buildWorker.js, plugin/dist/code.js (${code.length} bytes), plugin/dist/ui.html`);
