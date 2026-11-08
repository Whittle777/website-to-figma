// Builds the CLI bundle (dist/cli.js) and the Figma plugin (plugin/dist/).
// The plugin main thread is bundled for platform "neutral" so any accidental
// Node built-in import fails the build instead of shipping to the sandbox.
import { build } from "esbuild";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";

await build({
  entryPoints: ["src/cli.ts", "src/normalize/buildWorker.ts"],
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
  outfile: "plugin/dist/code.js",
  bundle: true,
  platform: "neutral",
  format: "iife",
  target: "es2020",
  logLevel: "warning",
});
copyFileSync("plugin/src/ui.html", "plugin/dist/ui.html");

const code = readFileSync("plugin/dist/code.js", "utf8");
for (const forbidden of ["require(", "process.", "import(", "eval(", "new Function"]) {
  if (code.includes(forbidden)) throw new Error(`plugin/dist/code.js contains forbidden token: ${forbidden}`);
}
console.log(`Built dist/cli.js, dist/buildWorker.js, plugin/dist/code.js (${code.length} bytes), plugin/dist/ui.html`);
