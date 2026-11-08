// Offline tiling of a tall REFERENCE screenshot PNG into <=4096px tiles
// (figma.createImage's documented limit). Preflight in the main thread (no
// decoder allocation), decode/encode in a worker with a hard deadline and heap
// caps, then verify every tile (size, contiguity, PNG header, SHA-256).
import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import { LIMITS } from "../shared/limits";
import { inspectImage } from "../shared/imageInfo";
import { pngPreflight } from "./pngPreflight";

declare const __W2F_SELF_WORKER__: boolean | undefined;
export const TILE_WORKER_FLAG = "w2fTileWorker";

export interface Tile {
  y: number;
  h: number;
  bytes: Uint8Array;
  sha256: string;
}
export interface TileResult {
  sourceSha256: string;
  width: number;
  height: number;
  tiles: Tile[];
}

function spec(): { url: URL; execArgv: string[]; workerData?: Record<string, boolean> } {
  const self = import.meta.url;
  if (typeof __W2F_SELF_WORKER__ !== "undefined" && __W2F_SELF_WORKER__) return { url: new URL(self), execArgv: [], workerData: { [TILE_WORKER_FLAG]: true } };
  return self.endsWith(".ts") ? { url: new URL("./tileWorker.ts", self), execArgv: ["--import", "tsx"] } : { url: new URL("./tileWorker.js", self), execArgv: [] };
}

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

export function tileReference(bytes: Uint8Array, opts: { timeoutMs?: number; heapMb?: number } = {}): Promise<TileResult> {
  const facts = pngPreflight(bytes, LIMITS.hifiMaxAssetBytes);
  const tileH = LIMITS.refTileHeight;
  const count = Math.ceil(facts.height / tileH);
  if (count > LIMITS.refTileMaxTiles) return Promise.reject(new Error(`would need ${count} tiles (max ${LIMITS.refTileMaxTiles})`));
  const timeoutMs = opts.timeoutMs ?? LIMITS.refTileTimeoutMs;
  return new Promise((resolve, reject) => {
    const s = spec();
    const worker = new Worker(s.url, {
      execArgv: s.execArgv,
      workerData: s.workerData,
      resourceLimits: { maxOldGenerationSizeMb: opts.heapMb ?? LIMITS.refTileWorkerHeapMb, maxYoungGenerationSizeMb: 64, stackSizeMb: 4 },
    });
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new Error(`reference tiling exceeded ${timeoutMs} ms`))), timeoutMs);
    worker.once("message", (msg: { ok: boolean; error?: string; tiles?: { y: number; h: number; bytes: Uint8Array }[] }) => {
      finish(() => {
        if (!msg?.ok || !Array.isArray(msg.tiles)) return reject(new Error(`reference tiling failed: ${msg?.error ?? "no result"}`));
        try {
          if (msg.tiles.length !== count) throw new Error("unexpected tile count");
          const tiles: Tile[] = msg.tiles.map((t, i) => {
            const b = new Uint8Array(t.bytes);
            const expectH = Math.min(tileH, facts.height - i * tileH);
            const info = inspectImage(b);
            if (t.y !== i * tileH || t.h !== expectH || !info || info.mime !== "image/png" || info.width !== facts.width || info.height !== expectH) throw new Error(`tile ${i} failed verification`);
            if (b.length > LIMITS.hifiMaxAssetBytes) throw new Error(`tile ${i} larger than ${LIMITS.hifiMaxAssetBytes} bytes`);
            return { y: t.y, h: t.h, bytes: b, sha256: sha(b) };
          });
          resolve({ sourceSha256: sha(bytes), width: facts.width, height: facts.height, tiles });
        } catch (err) {
          reject(err);
        }
      });
    });
    worker.once("error", (err: unknown) => finish(() => reject(new Error(`reference tiling worker failed: ${err instanceof Error ? err.message : String(err)}`))));
    worker.once("exit", (code) => finish(() => reject(new Error(`reference tiling worker exited early (code ${code})`))));
    worker.postMessage({ bytes, tileHeight: tileH, expectedRawBytes: facts.expectedRawBytes, width: facts.width, height: facts.height });
  });
}
