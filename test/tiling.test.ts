// G8: offline tiling of tall reference PNGs (synthetic images only).
import { createHash } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";
import { pngPreflight, PngPreflightError } from "../src/hifi/pngPreflight";
import { tileReference } from "../src/hifi/tileReference";
import { convertCapture, type LoadedAsset } from "../src/hifi/convert";
import { loadedFromBytes, syntheticPng } from "../src/fixtures/hifiSynthetic";
import { validateHifiDoc } from "../src/shared/hifiSchema";
import { LIMITS } from "../src/shared/limits";

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const be32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
};
const chunk = (type: string, data: Buffer) => Buffer.concat([be32(data.length), Buffer.from(type, "latin1"), data, be32(crc32(Buffer.concat([Buffer.from(type, "latin1"), data])))]);
const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ihdr = (w: number, h: number, depth = 8, color = 2, interlace = 0) => {
  const d = Buffer.alloc(13);
  d.writeUInt32BE(w, 0);
  d.writeUInt32BE(h, 4);
  d[8] = depth;
  d[9] = color;
  d[12] = interlace;
  return chunk("IHDR", d);
};
const png = (...chunks: Buffer[]) => new Uint8Array(Buffer.concat([SIG, ...chunks]));
const iend = () => chunk("IEND", Buffer.alloc(0));

describe("tall reference tiling", () => {
  const src = syntheticPng(300, 9000, [10, 20, 30], [200, 210, 220]);
  it("splits into <=4096px tiles with contiguous offsets, a remainder last tile, hashes, and exact pixels", { timeout: 60_000 }, async () => {
    const r = await tileReference(src);
    expect(r).toMatchObject({ width: 300, height: 9000, sourceSha256: sha(src) });
    expect(r.tiles.map((t) => [t.y, t.h])).toEqual([
      [0, 4096],
      [4096, 4096],
      [8192, 808],
    ]);
    const whole = PNG.sync.read(Buffer.from(src));
    for (const t of r.tiles) {
      expect(t.sha256).toBe(sha(t.bytes));
      const dec = PNG.sync.read(Buffer.from(t.bytes));
      expect([dec.width, dec.height]).toEqual([300, t.h]);
      expect(Buffer.compare(dec.data, whole.data.subarray(t.y * 300 * 4, (t.y + t.h) * 300 * 4))).toBe(0);
    }
  });

  it("rejects hostile structure before any decoder allocation", () => {
    const idat = chunk("IDAT", deflateSync(Buffer.alloc(10 * (1 + 30))));
    const cases: [Uint8Array, RegExp][] = [
      [new TextEncoder().encode("<svg/>".repeat(10)), /not a PNG/],
      [png(chunk("IHDR", Buffer.alloc(14)), idat, iend()), /13-byte IHDR/],
      [png(ihdr(10, 10, 8, 2, 1), idat, iend()), /interlaced/],
      [png(ihdr(10, 10, 7, 2), idat, iend()), /bit depth/],
      [png(ihdr(5000, 10), idat, iend()), /outside reference tiling limits/],
      [png(ihdr(10, 70_000), idat, iend()), /outside reference tiling limits/],
      [png(ihdr(4096, 10_000), idat, iend()), /source pixels/],
      [png(ihdr(10, 10), Buffer.concat([be32(0x7fffffff), Buffer.from("IDAT")]), iend()), /chunk length exceeds file|truncated/],
      [png(ihdr(10, 10), ...Array.from({ length: LIMITS.refTileMaxChunks + 1 }, () => chunk("tEXt", Buffer.alloc(0))), idat, iend()), /too many chunks/],
      [png(ihdr(10, 10), idat), /missing IEND/],
      [png(ihdr(10, 10), iend()), /no image data/],
      [png(ihdr(10, 10), ihdr(10, 10), idat, iend()), /duplicate IHDR/],
    ];
    for (const [b, re] of cases) expect(() => pngPreflight(b, LIMITS.hifiMaxAssetBytes)).toThrow(re);
    expect(() => pngPreflight(src, 1000)).toThrow(PngPreflightError);
  });

  it("stops a decompression bomb and short data in the worker before pngjs", { timeout: 60_000 }, async () => {
    const w = 100;
    const h = 5000; // raw = 5000 * (1 + 300) = 1.5 MB expected
    const bomb = png(ihdr(w, h), chunk("IDAT", deflateSync(Buffer.alloc(60_000_000), { level: 9 })), iend());
    await expect(tileReference(bomb)).rejects.toThrow(/reference tiling failed: .*(Cannot create a Buffer|buffer|larger|maxOutputLength|exceed)/i);
    const short = png(ihdr(w, h), chunk("IDAT", deflateSync(Buffer.alloc(1000))), iend());
    await expect(tileReference(short)).rejects.toThrow(/inflates to 1000 bytes, expected 1505000/);
  });

  it("enforces CRC and the worker deadline", { timeout: 60_000 }, async () => {
    const bad = Buffer.from(src);
    const idatAt = bad.indexOf(Buffer.from("IDAT"));
    const len = bad.readUInt32BE(idatAt - 4);
    bad.writeUInt8(bad.readUInt8(idatAt + 4 + len) ^ 0xff, idatAt + 4 + len); // corrupt IDAT CRC
    await expect(tileReference(new Uint8Array(bad))).rejects.toThrow(/reference tiling failed/);
    await expect(tileReference(src, { timeoutMs: 1 })).rejects.toThrow(/exceeded 1 ms/);
  });
});

describe("tiled reference in the v2 document", () => {
  const measured = { viewport: { width: 300 }, elements: [{ tag: "body", x: 0, y: 0, w: 300, h: 9000, style: {} }], texts: [], images: [] };
  const capture = { schema: "website-to-figma/capture", schemaVersion: 1, label: "SYNTHETIC tiling", pages: [{ url: "https://example.com/", measured }] };
  const build = async () => {
    const src = syntheticPng(300, 9000, [1, 2, 3], [4, 5, 6]);
    const r = await tileReference(src);
    const tiles = r.tiles.map((t, i) => ({ y: t.y, h: t.h, asset: { ...loadedFromBytes(`ref#tile${i}`, "reference", t.bytes, null) } as LoadedAsset }));
    return { r, doc: convertCapture({ capture, assets: [], assetWarnings: [], referenceTiles: [{ operatorId: "ref", pageUrl: "https://example.com/", sourceSha256: r.sourceSha256, width: r.width, height: r.height, tiles }] }) };
  };
  it("records source hash, tile assets and offsets; the validator enforces contiguity and sizes", { timeout: 60_000 }, async () => {
    const { r, doc } = await build();
    const p = doc.pages[0]!;
    expect(p.referenceAssetId).toBeNull();
    expect(p.referenceTiles).toMatchObject({ sourceSha256: r.sourceSha256, sourceWidth: 300, sourceHeight: 9000 });
    expect(p.referenceTiles!.tiles.map((t) => [t.y, t.h])).toEqual([
      [0, 4096],
      [4096, 4096],
      [8192, 808],
    ]);
    expect(p.notes!.join("\n")).toMatch(/Reference 300x9000px tiled offline into 3 PNG tile\(s\) of <=4096px/);
    expect(validateHifiDoc(doc).ok).toBe(true);
    const bad = (mut: (d: any) => void, re: RegExp) => {
      const d = JSON.parse(JSON.stringify(doc));
      mut(d);
      const v = validateHifiDoc(d);
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.errors.join("\n")).toMatch(re);
    };
    bad((d) => (d.pages[0].referenceTiles.tiles[1].y = 4000), /contiguous/);
    bad((d) => (d.pages[0].referenceTiles.tiles[2].h = 800), /size does not match|sum to sourceHeight/);
    bad((d) => (d.pages[0].referenceTiles.sourceHeight = 9001), /sum to sourceHeight/);
    bad((d) => (d.pages[0].referenceAssetId = d.pages[0].referenceTiles.tiles[0].assetId), /must be null/);
  });
});
