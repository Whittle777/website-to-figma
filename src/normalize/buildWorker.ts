// Worker entry: builds the site map off the main thread so the caller can
// enforce a hard deadline and heap limit on HTML parsing/extraction.
import { parentPort } from "node:worker_threads";
import { buildSiteMap, type BuildInput } from "./build";

parentPort?.once("message", (input: BuildInput) => {
  try {
    parentPort!.postMessage({ ok: true, doc: buildSiteMap(input) });
  } catch (err) {
    parentPort!.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});
