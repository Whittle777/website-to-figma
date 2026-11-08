// Entry for the single-file distributable (cli/website-to-figma.mjs). The same
// file serves as the CLI and, when re-spawned by boundedBuild with the worker
// flag, as the bounded HTML-extraction worker.
import { isMainThread, workerData } from "node:worker_threads";
import { SELF_WORKER_FLAG } from "./normalize/boundedBuild";
import { TILE_WORKER_FLAG } from "./hifi/tileReference";

const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
if (major < 20 || (major === 20 && minor < 12)) {
  console.error(`website-to-figma requires Node.js >= 20.12 (found ${process.versions.node}).`);
  process.exit(1);
}

if (!isMainThread && (workerData as Record<string, unknown> | null)?.[SELF_WORKER_FLAG] === true) {
  await import("./normalize/buildWorker");
} else if (!isMainThread && (workerData as Record<string, unknown> | null)?.[TILE_WORKER_FLAG] === true) {
  await import("./hifi/tileWorker");
} else {
  await import("./cli");
}
