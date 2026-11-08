// Runs buildSiteMap for untrusted (crawled) HTML in a worker thread that is
// terminated after LIMITS.extractDeadlineMs or if it exceeds its heap limit.
import { Worker } from "node:worker_threads";
import { LIMITS } from "../shared/limits";
import { validateSiteMap, type SiteMapDoc } from "../shared/schema";
import type { BuildInput } from "./build";

// Set (via esbuild `define`) only in the single-file distributable, where the
// bundle re-spawns itself as the worker (see src/distEntry.ts).
declare const __W2F_SELF_WORKER__: boolean | undefined;
export const SELF_WORKER_FLAG = "w2fBuildWorker";

// From source (tsx / vitest) the .ts sibling runs with the tsx loader (a dev
// dependency); the esbuild bundle ships plain dist/buildWorker.js next to
// dist/cli.js; the single-file distributable uses its own file.
function workerSpec(): { url: URL; execArgv: string[]; workerData?: Record<string, boolean> } {
  const self = import.meta.url;
  if (typeof __W2F_SELF_WORKER__ !== "undefined" && __W2F_SELF_WORKER__) {
    return { url: new URL(self), execArgv: [], workerData: { [SELF_WORKER_FLAG]: true } };
  }
  return self.endsWith(".ts")
    ? { url: new URL("./buildWorker.ts", self), execArgv: ["--import", "tsx"] }
    : { url: new URL("./buildWorker.js", self), execArgv: [] };
}

export function buildSiteMapBounded(input: BuildInput, deadlineMs: number = LIMITS.extractDeadlineMs): Promise<SiteMapDoc> {
  return new Promise((resolve, reject) => {
    const spec = workerSpec();
    const worker = new Worker(spec.url, {
      execArgv: spec.execArgv,
      workerData: spec.workerData,
      resourceLimits: { maxOldGenerationSizeMb: LIMITS.extractWorkerHeapMb },
    });
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error(`Aborting: page extraction exceeded ${deadlineMs} ms. Nothing written.`))),
      deadlineMs,
    );
    worker.once("message", (msg: { ok: boolean; doc?: unknown; error?: string }) => {
      if (!msg.ok) return finish(() => reject(new Error(msg.error ?? "Extraction failed")));
      // Re-validate what crosses the thread boundary.
      const r = validateSiteMap(msg.doc);
      finish(() => (r.ok ? resolve(r.doc) : reject(new Error(`Worker output failed validation: ${r.errors[0]}`))));
    });
    worker.once("error", (err: unknown) => finish(() => reject(new Error(`Extraction worker failed: ${err instanceof Error ? err.message : String(err)}`))));
    worker.once("exit", (code) => finish(() => reject(new Error(`Extraction worker exited early (code ${code})`))));
    worker.postMessage(input);
  });
}
