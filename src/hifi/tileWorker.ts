// Worker entry: decode ONE preflighted reference PNG and re-encode it as
// <=tileHeight px PNG tiles. Runs under a hard deadline and heap limit set by
// the caller. The zlib stream is first inflated with maxOutputLength equal to
// the exact expected raw size, so a decompression bomb fails before pngjs.
import { parentPort } from "node:worker_threads";
import { inflateSync } from "node:zlib";
import { PNG } from "pngjs";
import { idatStream } from "./pngPreflight";

interface Req {
  bytes: Uint8Array;
  tileHeight: number;
  expectedRawBytes: number;
  width: number;
  height: number;
}

parentPort?.once("message", (req: Req) => {
  try {
    const raw = inflateSync(idatStream(req.bytes), { maxOutputLength: req.expectedRawBytes });
    if (raw.length !== req.expectedRawBytes) throw new Error(`image data inflates to ${raw.length} bytes, expected ${req.expectedRawBytes}`);
    const png = PNG.sync.read(Buffer.from(req.bytes.buffer, req.bytes.byteOffset, req.bytes.byteLength), { checkCRC: true });
    if (png.width !== req.width || png.height !== req.height || png.data.length !== req.width * req.height * 4) throw new Error("decoded size mismatch");
    const tiles: { y: number; h: number; bytes: Uint8Array }[] = [];
    for (let y = 0; y < png.height; y += req.tileHeight) {
      const h = Math.min(req.tileHeight, png.height - y);
      const data = png.data.subarray(y * png.width * 4, (y + h) * png.width * 4);
      const out = PNG.sync.write({ width: png.width, height: h, data } as PNG, { colorType: 6, inputColorType: 6, inputHasAlpha: true });
      tiles.push({ y, h, bytes: new Uint8Array(out) });
    }
    parentPort!.postMessage({ ok: true, tiles });
  } catch (err) {
    parentPort!.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});
