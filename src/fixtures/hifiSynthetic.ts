// SYNTHETIC hi-fi fixture: a hand-written measured capture and generated PNG
// bytes. Not captured from any real website; no network access. example.com
// is the IANA documentation domain and is never contacted.
import { deflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import { convertCapture, type LoadedAsset } from "../hifi/convert";
import { inspectImage } from "../shared/imageInfo";
import type { HifiDoc } from "../shared/hifiSchema";

export const HIFI_FIXTURE_LABEL = "SYNTHETIC HI-FI FIXTURE - not a real website";

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (const x of b) c = CRC[(c ^ x) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

// Deterministic RGB PNG (two-tone diagonal pattern).
export function syntheticPng(width: number, height: number, a: [number, number, number], b: [number, number, number]): Uint8Array {
  const raw = new Uint8Array((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const c = (x + y) % 20 < 10 ? a : b;
      raw.set(c, y * (width * 3 + 1) + 1 + x * 3);
    }
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", new Uint8Array(deflateSync(raw, { level: 9 }))), chunk("IEND", new Uint8Array())];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function loadedFromBytes(operatorId: string, kind: "image" | "reference", bytes: Uint8Array, sourceUrl: string | null): LoadedAsset {
  const info = inspectImage(bytes)!;
  return { operatorId, kind, mime: info.mime, width: info.width, height: info.height, sha256: createHash("sha256").update(bytes).digest("hex"), sourceUrl, bytes };
}

const sans = '-apple-system, "Avenir Next", Roboto, sans-serif';
const st = (o: Record<string, string>) => ({ fontFamily: sans, fontSize: "16px", fontWeight: "400", fontStyle: "normal", color: "rgb(33, 33, 33)", textDecorationLine: "none", ...o });
const box = (o: Record<string, string>) => ({ backgroundColor: "rgba(0, 0, 0, 0)", borderTopWidth: "0px", borderRightWidth: "0px", borderBottomWidth: "0px", borderLeftWidth: "0px", borderTopColor: "rgb(0, 0, 0)", borderRightColor: "rgb(0, 0, 0)", borderBottomColor: "rgb(0, 0, 0)", borderLeftColor: "rgb(0, 0, 0)", borderRadius: "0px", opacity: "1", display: "block", visibility: "visible", ...o });
const border = (w: string, c: string) => ({ borderTopWidth: w, borderRightWidth: w, borderBottomWidth: w, borderLeftWidth: w, borderTopColor: c, borderRightColor: c, borderBottomColor: c, borderLeftColor: c });

export function syntheticCapture(): unknown {
  return {
    schema: "website-to-figma/capture",
    schemaVersion: 1,
    label: HIFI_FIXTURE_LABEL,
    pages: [
      {
        url: "https://example.com/",
        contentType: "text/html; charset=utf-8",
        referenceAssetId: "ref-home",
        branding: { colors: { primary: "#0d47a1", background: "#fff", bogus: "red" }, fonts: [{ family: "Avenir Next" }] },
        measured: {
          viewport: { width: 800, height: 600 },
          title: "Synthetic Home",
          elements: [
            { tag: "body", x: 0, y: 0, w: 800, h: 600, style: box({ backgroundColor: "rgb(255, 255, 255)" }) },
            { tag: "header", x: 0, y: 0, w: 800, h: 120, style: box({ backgroundColor: "rgb(245, 247, 255)", borderBottomWidth: "1px", borderBottomColor: "rgb(137, 142, 164)" }) },
            { tag: "a", x: 40, y: 20, w: 80, h: 36, style: box({ ...border("1px", "rgb(13, 71, 161)"), borderRadius: "5px" }) },
            { tag: "button", x: 40, y: 160, w: 140, h: 44, style: box({ backgroundColor: "rgb(13, 71, 161)", ...border("2px", "rgb(10, 50, 120)"), borderRadius: "5px 5px 8px 8px" }), control: { type: "submit" } },
            { tag: "input", x: 200, y: 160, w: 220, h: 44, style: box({ backgroundColor: "rgb(255, 255, 255)", ...border("1px", "rgb(137, 142, 164)"), borderRadius: "5px", paddingLeft: "10px", paddingTop: "10px", paddingRight: "10px", paddingBottom: "10px", fontSize: "16px", fontFamily: sans, color: "rgb(88, 88, 88)" }), control: { type: "text", value: "", placeholder: "Your email" } },
            { tag: "blockquote", x: 40, y: 230, w: 500, h: 60, style: box({ borderLeftWidth: "4px", borderLeftColor: "rgb(13, 71, 161)" }) },
          ],
          texts: [
            { text: "Home", x: 58, y: 28, w: 44, h: 20, tag: "a", style: st({ color: "rgb(13, 71, 161)" }) },
            { text: "Synthetic Fixture", x: 40, y: 64, w: 360, h: 48, tag: "h1", style: st({ fontSize: "40px", fontWeight: "700" }) },
            { text: "Send", x: 88, y: 172, w: 44, h: 20, tag: "button", style: st({ color: "rgb(255, 255, 255)", fontWeight: "700" }) },
            { text: "A sentence with an ", x: 40, y: 320, w: 160, h: 26, tag: "p", style: st({}) },
            { text: "inline link", x: 200, y: 320, w: 80, h: 26, tag: "a", style: st({ color: "rgb(13, 71, 161)", textDecorationLine: "underline" }) },
            { text: " and code ", x: 280, y: 320, w: 76, h: 26, tag: "p", style: st({ fontStyle: "italic" }) },
            { text: "x = 1", x: 356, y: 320, w: 50, h: 26, tag: "code", code: true, style: st({ fontFamily: "Consolas, Menlo, monospace", color: "rgb(216, 27, 96)" }) },
            { text: "Hi 👋🏽 family 👨‍👩‍👧", x: 40, y: 250, w: 200, h: 26, tag: "blockquote", style: st({}) },
          ],
          images: [
            { src: "https://example.com/img/photo.png", alt: "Synthetic photo", x: 560, y: 160, w: 200, h: 120, style: { borderRadius: "5px", objectFit: "cover" } },
            { src: "https://example.com/img/missing.png", alt: "Missing image", x: 560, y: 300, w: 200, h: 100, style: { borderRadius: "0px" } },
          ],
          svgs: [{ x: 700, y: 20, w: 24, h: 24, html: "<svg></svg>" }],
        },
      },
      {
        url: "https://example.com/feed.xml",
        contentType: "application/rss+xml",
        measured: { viewport: { width: 800, height: 600 }, elements: [], texts: [], images: [] },
      },
      {
        url: "https://example.com/about",
        measured: {
          viewport: { width: 800, height: 400 },
          title: "Synthetic About",
          elements: [{ tag: "body", x: 0, y: 0, w: 800, h: 400, style: box({ backgroundColor: "rgb(255, 255, 255)" }) }],
          texts: [{ text: "About this synthetic fixture", x: 40, y: 40, w: 300, h: 30, tag: "h2", style: st({ fontSize: "26px", fontWeight: "700" }) }],
          images: [],
        },
      },
    ],
  };
}

export function syntheticAssets(): LoadedAsset[] {
  return [
    loadedFromBytes("photo", "image", syntheticPng(120, 72, [13, 71, 161], [245, 247, 255]), "https://example.com/img/photo.png"),
    loadedFromBytes("ref-home", "reference", syntheticPng(160, 120, [255, 255, 255], [230, 230, 230]), null),
  ];
}

export function buildHifiFixture(): HifiDoc {
  const doc = convertCapture({ capture: syntheticCapture(), assets: syntheticAssets(), assetWarnings: [] });
  return { ...doc, source: { mode: "fixture", label: HIFI_FIXTURE_LABEL } };
}
