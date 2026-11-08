// Packages the development plugin for hand-off:
//   artifacts/website-to-figma-plugin/        manifest.json, dist/, samples/
//   artifacts/website-to-figma-plugin.zip     same folder, zipped (macOS/Linux `zip`)
// Run `npm run build` first (the npm script does this).
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";

const out = "artifacts/website-to-figma-plugin";
for (const f of ["plugin/dist/code.js", "plugin/dist/ui.html"]) {
  if (!existsSync(f)) throw new Error(`Missing ${f}; run npm run build`);
}
rmSync("artifacts", { recursive: true, force: true });
mkdirSync(`${out}/dist`, { recursive: true });
cpSync("plugin/manifest.json", `${out}/manifest.json`);
cpSync("plugin/dist", `${out}/dist`, { recursive: true });
cpSync("samples", `${out}/samples`, { recursive: true });
execFileSync("zip", ["-qrX", "website-to-figma-plugin.zip", "website-to-figma-plugin"], { cwd: "artifacts", stdio: "inherit" });
console.log(`Packaged ${out}/ and artifacts/website-to-figma-plugin.zip`);
