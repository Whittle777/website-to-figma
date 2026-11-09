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

const navAndFooter = (activeColor: string, h: number) => ({
  elements: [
    { tag: "nav", id: "nav1", header: true, x: 0, y: 0, w: 800, h: 60, style: box({}) },
    { tag: "a", id: "nav-a", header: true, x: 40, y: 12, w: 80, h: 36, style: box({ ...border("1px", "rgb(13, 71, 161)"), borderRadius: "5px" }) },
    { tag: "footer", id: "foot1", footer: true, x: 0, y: h - 60, w: 800, h: 60, style: box({ backgroundColor: "rgb(245, 247, 255)" }) },
  ],
  texts: [
    { text: "Home", x: 58, y: 20, w: 44, h: 20, tag: "a", parent: "nav-a", header: true, style: st({ color: activeColor }) },
    { text: "Synthetic footer", x: 40, y: h - 40, w: 140, h: 20, tag: "p", parent: "foot1", footer: true, style: st({ color: "rgb(88, 88, 88)" }) },
  ],
});

export function syntheticCapture(): unknown {
  const homeShared = navAndFooter("rgb(13, 71, 161)", 600);
  const aboutShared = navAndFooter("rgb(33, 33, 33)", 400);
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
        html: '<html><body><ul><li data-w2f-id="li1">Synthetic list item</li></ul><ol start="3"><li data-w2f-id="li2">Third</li></ol></body></html>',
        measured: {
          viewport: { width: 800, height: 600 },
          title: "Synthetic Home",
          elements: [
            { tag: "body", x: 0, y: 0, w: 800, h: 600, style: box({ backgroundColor: "rgb(255, 255, 255)" }) },
            { tag: "header", x: 0, y: 60, w: 800, h: 60, style: box({ backgroundColor: "rgb(245, 247, 255)", borderBottomWidth: "1px", borderBottomColor: "rgb(137, 142, 164)" }) },
            ...homeShared.elements,
            { tag: "button", x: 40, y: 160, w: 140, h: 44, style: box({ backgroundColor: "rgb(13, 71, 161)", ...border("2px", "rgb(10, 50, 120)"), borderRadius: "5px 5px 8px 8px" }), control: { type: "submit" } },
            { tag: "input", x: 200, y: 160, w: 220, h: 44, style: box({ backgroundColor: "rgb(255, 255, 255)", ...border("1px", "rgb(137, 142, 164)"), borderRadius: "5px", paddingLeft: "10px", paddingTop: "10px", paddingRight: "10px", paddingBottom: "10px", fontSize: "16px", fontFamily: sans, color: "rgb(88, 88, 88)" }), control: { type: "text", value: "", placeholder: "Your email" } },
            { tag: "blockquote", x: 40, y: 230, w: 500, h: 60, style: box({ borderLeftWidth: "4px", borderLeftColor: "rgb(13, 71, 161)" }) },
            { tag: "li", id: "li1", x: 60, y: 360, w: 300, h: 24, style: box({ display: "list-item" }) },
            { tag: "li", id: "li2", x: 60, y: 390, w: 300, h: 24, style: box({ display: "list-item" }) },
            { tag: "input", id: "radio1", x: 440, y: 362, w: 20, h: 20, style: box({ backgroundColor: "rgb(13, 71, 161)", borderRadius: "100%" }), control: { type: "radio", checked: true } },
            { tag: "pre", id: "pre1", x: 40, y: 440, w: 300, h: 50, style: box({ backgroundColor: "rgb(245, 247, 255)", paddingBottom: "10px" }) },
          ],
          texts: [
            ...homeShared.texts,
            { text: "Synthetic Fixture", x: 40, y: 64, w: 360, h: 48, tag: "h1", style: st({ fontSize: "40px", fontWeight: "700" }) },
            { text: "Send", x: 88, y: 172, w: 44, h: 20, tag: "button", style: st({ color: "rgb(255, 255, 255)", fontWeight: "700" }) },
            { text: "A sentence with an ", x: 40, y: 320, w: 160, h: 26, tag: "p", style: st({}) },
            { text: "inline link", x: 200, y: 320, w: 80, h: 26, tag: "a", style: st({ color: "rgb(13, 71, 161)", textDecorationLine: "underline" }) },
            { text: " and code ", x: 280, y: 320, w: 76, h: 26, tag: "p", style: st({ fontStyle: "italic" }) },
            { text: "x = 1", x: 356, y: 320, w: 50, h: 26, tag: "code", code: true, style: st({ fontFamily: "Consolas, Menlo, monospace", color: "rgb(216, 27, 96)" }) },
            { text: "Hi 👋🏽 family 👨‍👩‍👧", x: 40, y: 250, w: 200, h: 26, tag: "blockquote", style: st({}) },
            { text: "Synthetic list item", x: 60, y: 362, w: 150, h: 22, tag: "li", parent: "li1", style: st({}) },
            { text: "Third", x: 60, y: 392, w: 40, h: 22, tag: "li", parent: "li2", style: st({}) },
            { text: "const aVeryLongSyntheticLine = true;", x: 50, y: 450, w: 420, h: 20, tag: "code", code: true, parent: "pre1", style: st({ fontFamily: "Consolas, monospace" }) },
          ],
          images: [
            { src: "https://example.com/img/photo.png", alt: "Synthetic photo", x: 560, y: 160, w: 200, h: 120, style: { borderRadius: "5px", objectFit: "cover" } },
            { src: "https://example.com/img/missing.png", alt: "Missing image", x: 560, y: 300, w: 200, h: 100, style: { borderRadius: "0px" } },
          ],
          svgs: [
            { x: 700, y: 130, w: 16, h: 16, color: "rgb(33, 33, 33)", html: '<svg class="icon" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" style="fill: currentColor"><path d="M1 1 L15 1 L8 15 Z" fill="currentColor"></path></svg>' },
            { x: 730, y: 130, w: 16, h: 16, color: "rgb(33, 33, 33)", html: '<svg viewBox="0 0 16 16"><script>alert(1)</script></svg>' },
          ],
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
          elements: [{ tag: "body", x: 0, y: 0, w: 800, h: 400, style: box({ backgroundColor: "rgb(255, 255, 255)" }) }, ...aboutShared.elements],
          texts: [...aboutShared.texts, { text: "About this synthetic fixture", x: 40, y: 140, w: 300, h: 30, tag: "h2", style: st({ fontSize: "26px", fontWeight: "700" }) }],
          images: [],
        },
      },
    ],
  };
}

export function syntheticAssets(): LoadedAsset[] {
  return [
    loadedFromBytes("photo", "image", syntheticPng(120, 72, [13, 71, 161], [245, 247, 255]), "https://example.com/img/photo.png"),
    loadedFromBytes("ref-home", "reference", syntheticPng(800, 600, [255, 255, 255], [230, 230, 230]), null),
  ];
}

export function buildHifiFixture(): HifiDoc {
  const doc = convertCapture({ capture: syntheticCapture(), assets: syntheticAssets(), assetWarnings: [] });
  return { ...doc, source: { mode: "fixture", label: HIFI_FIXTURE_LABEL } };
}

// SYNTHETIC JPEG-structured bytes for offline tests: SOI, APP0 (JFIF), SOF0 (size), SOS, filler scan
// data (no 0xFF bytes), EOI. Header-valid for inspectImage / SOI-EOI checks; NOT a decodable image.
export function syntheticJpeg(width: number, height: number, scanBytes = 64, fill = 0x55): Uint8Array {
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
  const sof0 = [0xff, 0xc0, 0x00, 0x11, 0x08, (height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01];
  const sos = [0xff, 0xda, 0x00, 0x0c, 0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00];
  const f = (fill & 0xff) === 0xff ? 0x55 : fill & 0xff; // 0xFF would start a marker
  const scan = new Array<number>(Math.max(1, scanBytes)).fill(f);
  return new Uint8Array([0xff, 0xd8, ...app0, ...sof0, ...sos, ...scan, 0xff, 0xd9]);
}
