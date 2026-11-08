// Structural PNG preflight run BEFORE any decoder allocation. Walks every chunk
// with overflow-safe bounds, requires a 13-byte IHDR first, a known bit depth /
// color type combination, no interlacing (pngjs inflates interlaced data
// without an output bound), at least one IDAT and an IEND. Returns the exact
// raw (filtered, decompressed) byte size the image data must inflate to.
import { LIMITS } from "../shared/limits";

export class PngPreflightError extends Error {}

export interface PngFacts {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  idatBytes: number;
  chunks: number;
  expectedRawBytes: number;
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const DEPTHS: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const u32 = (b: Uint8Array, i: number) => ((b[i]! << 24) >>> 0) + (b[i + 1]! << 16) + (b[i + 2]! << 8) + b[i + 3]!;

export function pngPreflight(b: Uint8Array, maxBytes: number): PngFacts {
  if (b.length > maxBytes) throw new PngPreflightError(`PNG larger than ${maxBytes} bytes`);
  if (b.length < 8 + 25 + 12 || !SIG.every((v, i) => b[i] === v)) throw new PngPreflightError("not a PNG");
  let off = 8;
  let chunks = 0;
  let idatBytes = 0;
  let ihdr: PngFacts | null = null;
  let sawIend = false;
  while (off < b.length) {
    if (off + 12 > b.length) throw new PngPreflightError("truncated chunk header");
    const len = u32(b, off);
    const type = String.fromCharCode(b[off + 4]!, b[off + 5]!, b[off + 6]!, b[off + 7]!);
    if (!/^[A-Za-z]{4}$/.test(type)) throw new PngPreflightError("invalid chunk type");
    if (len > b.length - off - 12) throw new PngPreflightError("chunk length exceeds file");
    if (++chunks > LIMITS.refTileMaxChunks) throw new PngPreflightError("too many chunks");
    if (chunks === 1) {
      if (type !== "IHDR" || len !== 13) throw new PngPreflightError("first chunk must be a 13-byte IHDR");
      const d = off + 8;
      const width = u32(b, d);
      const height = u32(b, d + 4);
      const bitDepth = b[d + 8]!;
      const colorType = b[d + 9]!;
      if (b[d + 10] !== 0 || b[d + 11] !== 0) throw new PngPreflightError("unsupported compression/filter method");
      if (b[d + 12] !== 0) throw new PngPreflightError("interlaced PNG references are not supported");
      if (!(colorType in CHANNELS) || !DEPTHS[colorType]!.includes(bitDepth)) throw new PngPreflightError("invalid bit depth / color type");
      if (width < 1 || height < 1 || width > LIMITS.hifiMaxImageDim || height > LIMITS.refTileMaxSourceHeight) {
        throw new PngPreflightError(`dimensions ${width}x${height} outside reference tiling limits (width <= ${LIMITS.hifiMaxImageDim}, height <= ${LIMITS.refTileMaxSourceHeight})`);
      }
      if (width * height > LIMITS.refTileMaxSourcePixels) throw new PngPreflightError(`more than ${LIMITS.refTileMaxSourcePixels} source pixels`);
      const rowBytes = Math.ceil((width * CHANNELS[colorType]! * bitDepth) / 8) + 1;
      ihdr = { width, height, bitDepth, colorType, idatBytes: 0, chunks: 0, expectedRawBytes: rowBytes * height };
    } else if (type === "IHDR") {
      throw new PngPreflightError("duplicate IHDR");
    }
    if (type === "IDAT") {
      if (sawIend) throw new PngPreflightError("IDAT after IEND");
      idatBytes += len;
    }
    if (type === "IEND") {
      sawIend = true;
      off += 12 + len;
      break;
    }
    off += 12 + len;
  }
  if (!ihdr) throw new PngPreflightError("missing IHDR");
  if (!sawIend) throw new PngPreflightError("missing IEND");
  if (idatBytes === 0) throw new PngPreflightError("no image data");
  return { ...ihdr, idatBytes, chunks };
}

// Concatenated IDAT payloads (the zlib stream), extracted with the same bounds.
export function idatStream(b: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [];
  let off = 8;
  let total = 0;
  while (off + 12 <= b.length) {
    const len = u32(b, off);
    const type = String.fromCharCode(b[off + 4]!, b[off + 5]!, b[off + 6]!, b[off + 7]!);
    if (len > b.length - off - 12) break;
    if (type === "IDAT") {
      parts.push(b.subarray(off + 8, off + 8 + len));
      total += len;
    }
    if (type === "IEND") break;
    off += 12 + len;
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
