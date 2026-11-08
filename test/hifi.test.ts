import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { inspectImage, sha256Hex } from "../src/shared/imageInfo";
import { resolveFont, parseFontStack, genericOf } from "../src/shared/fonts";
import { parseImportJson, validateHifiDoc, type HifiDoc, type TextNode, type BoxNode, type ImageNode } from "../src/shared/hifiSchema";
import { CaptureError, convertCapture, graphemeCount, parseColor, parseRadius } from "../src/hifi/convert";
import { loadAssetManifest } from "../src/hifi/assets";
import { buildHifiFixture, syntheticAssets, syntheticCapture, syntheticPng } from "../src/fixtures/hifiSynthetic";
import { buildFixture } from "../src/fixtures/generate";
import { LIMITS } from "../src/shared/limits";

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const NBSP = "\u00a0";

describe("image headers and sha256 (sandbox-safe helpers)", () => {
  it("reads PNG, GIF and JPEG dimensions and rejects other formats", () => {
    expect(inspectImage(syntheticPng(33, 7, [0, 0, 0], [255, 255, 255]))).toEqual({ mime: "image/png", width: 33, height: 7 });
    expect(inspectImage(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 10, 0, 20, 0]))).toEqual({ mime: "image/gif", width: 10, height: 20 });
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0, 50, 0, 70, 3, 0, 0, 0]);
    expect(inspectImage(jpeg)).toEqual({ mime: "image/jpeg", width: 70, height: 50 });
    for (const bad of ["<svg xmlns='http://www.w3.org/2000/svg'/>", "<html><script>x</script>", "RIFF....WEBP"]) {
      expect(inspectImage(new TextEncoder().encode(bad))).toBeNull();
    }
  });

  it("sha256Hex matches node:crypto across block boundaries", () => {
    for (const n of [0, 1, 55, 56, 63, 64, 65, 1000, 70_000]) {
      const b = new Uint8Array(n).map((_, i) => (i * 31 + 7) & 0xff);
      expect(sha256Hex(b)).toBe(createHash("sha256").update(b).digest("hex"));
    }
  });
});

describe("font resolution with explicit fallback", () => {
  const avail = new Set(["Roboto|Regular", "Roboto|Bold", "Inter|Regular", "Inter|Bold", "Inter|Italic", "Roboto Mono|Regular"]);
  it("uses the first available measured family and flags substitutions", () => {
    const stack = parseFontStack('-apple-system, "Avenir Next", Roboto, sans-serif');
    expect(stack).toEqual(["-apple-system", "Avenir Next", "Roboto", "sans-serif"]);
    expect(resolveFont(stack, genericOf(stack), 700, false, avail)).toMatchObject({ family: "Roboto", style: "Bold", fallback: true });
    expect(resolveFont(["Roboto"], "sans", 400, false, avail)).toMatchObject({ family: "Roboto", style: "Regular", fallback: false });
    expect(resolveFont(["Consolas", "monospace"], "mono", 400, false, avail)).toMatchObject({ family: "Roboto Mono", fallback: true });
    expect(resolveFont(["Roboto"], "sans", 400, true, avail)).toMatchObject({ family: "Inter", style: "Italic", fallback: true });
    expect(resolveFont(["Roboto Mono"], "mono", 700, true, avail)).toMatchObject({ family: "Roboto Mono", style: "Regular", fallback: true });
    expect(resolveFont(["Nope"], "sans", 400, false, new Set())).toBeNull();
  });
});

describe("converter: measured capture -> schemaVersion 2", () => {
  const doc = buildHifiFixture();
  const home = doc.pages[0]!;
  const texts = home.nodes.filter((n): n is TextNode => n.kind === "text");
  const boxes = home.nodes.filter((n): n is BoxNode => n.kind === "box");
  const images = home.nodes.filter((n): n is ImageNode => n.kind === "image");

  it("keeps measured geometry, borders, per-corner radii and button roles", () => {
    const button = boxes.find((b) => b.role === "button")!;
    expect(button).toMatchObject({ x: 40, y: 160, w: 140, h: 44, fill: { hex: "#0d47a1", alpha: 1 }, border: { weight: 2, color: { hex: "#0a3278", alpha: 1 } }, radius: [5, 5, 8, 8], prov: "measured" });
    const send = texts.find((t) => t.text === "Send")!;
    expect(home.nodes[send.button]).toBe(button);
    // non-uniform border -> only measured edges, no empty base box
    expect(boxes.filter((b) => b.name.startsWith("blockquote"))).toEqual([expect.objectContaining({ name: "blockquote / border-left", x: 40, y: 230, w: 4, h: 60, fill: { hex: "#0d47a1", alpha: 1 } })]);
    // the nav link box is identical on both pages -> it lives in the shared nav component
    const nav = doc.components!.find((c) => c.kind === "nav")!;
    expect(nav.nodes.find((n) => n.kind === "box" && n.name === "a")).toMatchObject({ fill: null, border: { weight: 1 }, radius: [5, 5, 5, 5] });
  });

  it("keeps text runs, edge spaces as NBSP, graphemes, styles and provenance", () => {
    expect(texts.map((t) => t.text)).toContain(`A sentence with an${NBSP}`);
    expect(texts.map((t) => t.text)).toContain(`${NBSP}and code${NBSP}`);
    const emoji = texts.find((t) => t.text.startsWith("Hi"))!;
    expect(emoji.graphemes).toBe(13);
    expect(texts.find((t) => t.text === "x = 1")).toMatchObject({ generic: "mono", color: { hex: "#d81b60" } });
    expect(texts.find((t) => t.text === "inline link")).toMatchObject({ decoration: "underline" });
    expect(texts.find((t) => t.text === `${NBSP}and code${NBSP}`)).toMatchObject({ italic: true });
    expect(texts.find((t) => t.text === "Your email")).toMatchObject({ prov: "inferred", fit: false });
    expect(texts.filter((t) => t.prov === "inferred").map((t) => t.text)).toEqual(["Your email", "•", "3."]);
    expect(texts.filter((t) => t.prov === "inferred").every((t) => t.fit === false)).toBe(true);
  });

  it("binds image fills to hash-pinned asset bytes and shows missing ones", () => {
    const [photo, missing] = images;
    const asset = doc.assets.find((a) => a.id === photo!.assetId)!;
    expect(asset).toMatchObject({ kind: "image", mime: "image/png", width: 120, height: 72, sourceUrl: "https://example.com/img/photo.png" });
    expect(sha256Hex(new Uint8Array(Buffer.from(asset.dataBase64, "base64")))).toBe(asset.sha256);
    expect(missing!.assetId).toBeNull();
    expect(home.warnings.join("\n")).toMatch(/1 image\(s\) have no supplied asset bytes/);
    expect(home.warnings.join("\n")).toMatch(/1 inline SVG\(s\) omitted: unsupported SVG element <script>/);
    expect(home.nodes.filter((n) => n.kind === "svg")).toHaveLength(1);
    expect(doc.assets.find((a) => a.id === home.referenceAssetId)).toMatchObject({ kind: "reference", width: 800, height: 600 });
  });

  it("skips non-HTML pages, keeps branding page-level and validated", () => {
    expect(doc.pages.map((p) => p.path)).toEqual(["/", "/about"]);
    expect(doc.warnings).toContain("Skipped non-HTML page /feed.xml");
    expect(home.branding).toEqual({ colors: { primary: "#0d47a1", background: "#ffffff" }, fonts: ["Avenir Next"] });
  });

  it("truncates visibly at bounds and drops off-site or private pages", () => {
    const cap = clone(syntheticCapture()) as any;
    cap.pages[0].measured.elements[0].h = 50_000;
    cap.pages[0].measured.texts.push({ text: "deep", x: 10, y: 40_000, w: 40, h: 20, tag: "p", style: {} });
    cap.pages.push({ url: "https://other.example.org/x", measured: { viewport: { width: 100 }, elements: [], texts: [], images: [] } });
    const out = convertCapture({ capture: cap, assets: syntheticAssets(), assetWarnings: [] });
    // 50000px -> two segment pages; the deep text is preserved (segment-local y)
    expect(out.pages[0]).toMatchObject({ height: LIMITS.hifiMaxPageHeight, truncated: false, segment: { index: 0, count: 2, offsetY: 0, sourceHeight: 50_000 } });
    expect(out.pages[1]).toMatchObject({ path: "/", height: 20_000, segment: { index: 1, count: 2, offsetY: 30_000 }, parentId: "p0" });
    expect(out.pages[0]!.nodes.some((n) => n.kind === "text" && n.text === "deep")).toBe(false);
    expect(out.pages[1]!.nodes.find((n) => n.kind === "text" && n.text === "deep")).toMatchObject({ y: 10_000 });
    expect(out.pages[1]!.notes!.join(" ")).toMatch(/Segment 2\/2 of a 50000px document/);
    // the 100000px measured-coordinate bound (e.g. an expanded 1920x100000 action
    // viewport) splits into 4 segments with the deepest node preserved
    const huge = clone(syntheticCapture()) as any;
    huge.pages[0].measured.elements[0].h = 100_000;
    huge.pages[0].measured.texts.push({ text: "very deep", x: 10, y: 95_000, w: 40, h: 20, tag: "p", style: {} });
    const hout = convertCapture({ capture: huge, assets: syntheticAssets(), assetWarnings: [] });
    const segs = hout.pages.filter((p) => p.path === "/");
    expect(segs.map((p) => [p.height, p.segment!.offsetY])).toEqual([[30_000, 0], [30_000, 30_000], [30_000, 60_000], [10_000, 90_000]]);
    expect(segs[3]!.nodes.find((n) => n.kind === "text" && n.text === "very deep")).toMatchObject({ y: 5_000 });
    expect(segs.slice(1).every((p) => p.parentId === segs[0]!.id && p.referenceAssetId === null)).toBe(true);
    expect(out.warnings.join("\n")).toMatch(/Skipped https:\/\/other\.example\.org\/x: not on the same site/);
    for (const url of ["http://10.0.0.1/", "http://198.18.0.1/", "file:///etc/passwd", "https://u:p@example.com/"]) {
      const bad = clone(syntheticCapture()) as any;
      bad.pages[0].url = url;
      expect(() => convertCapture({ capture: bad, assets: [], assetWarnings: [] })).toThrow();
    }
  });

  it("rejects malformed captures and bounds input sizes", () => {
    expect(() => convertCapture({ capture: { schema: "x" }, assets: [], assetWarnings: [] })).toThrow(CaptureError);
    const noViewport = clone(syntheticCapture()) as any;
    delete noViewport.pages[0].measured.viewport;
    expect(() => convertCapture({ capture: noViewport, assets: [], assetWarnings: [] })).toThrow(/viewport.width: required/);
    const huge = clone(syntheticCapture()) as any;
    huge.pages[0].measured.texts = new Array(LIMITS.captureMaxTexts + 1).fill({});
    expect(() => convertCapture({ capture: huge, assets: [], assetWarnings: [] })).toThrow(/more than/);
  });

  it("parses only rgb()/rgba() colors and px radii", () => {
    expect(parseColor("rgb(13, 71, 161)")).toEqual({ hex: "#0d47a1", alpha: 1 });
    expect(parseColor("rgba(0, 0, 0, 0)")).toBeNull();
    expect(parseColor("rgb(10 20 30 / 50%)")).toEqual({ hex: "#0a141e", alpha: 0.5 });
    expect(parseColor("url(javascript:alert(1))")).toBeNull();
    expect(parseRadius("5px 10px")).toEqual([5, 10, 5, 10]);
    expect(parseRadius("50%")).toEqual([0, 0, 0, 0]);
    expect(graphemeCount("👨‍👩‍👧é")).toBe(2);
  });

  it("is deterministic and matches the committed synthetic sample", () => {
    expect(JSON.stringify(buildHifiFixture())).toBe(JSON.stringify(doc));
    expect(readFileSync("samples/hifi-synthetic.json", "utf8")).toBe(JSON.stringify(doc) + "\n");
  });
});

describe("offline asset manifest loader", () => {
  const dir = mkdtempSync(join(tmpdir(), "w2f-assets-"));
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(join(dir, "..", "w2f-outside.png"), { force: true });
  });
  const png = syntheticPng(20, 10, [1, 2, 3], [4, 5, 6]);
  const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
  mkdirSync(join(dir, "img"));
  writeFileSync(join(dir, "img/ok.png"), png);
  writeFileSync(join(dir, "img/big.png"), syntheticPng(4097, 1, [0, 0, 0], [0, 0, 0]));
  writeFileSync(join(dir, "img/icon.svg"), "<svg onload='x()'/>");
  writeFileSync(join(dir, "..", "w2f-outside.png"), png);
  symlinkSync(join(dir, "img/ok.png"), join(dir, "img/link.png"));
  const manifest = (assets: unknown[]) => {
    writeFileSync(join(dir, "m.json"), JSON.stringify({ schema: "website-to-figma/asset-manifest", schemaVersion: 1, assets }));
    return join(dir, "m.json");
  };

  it("accepts local, hash-matching PNG/JPEG/GIF within limits and rejects everything else visibly", () => {
    const big = new Uint8Array(readFileSync(join(dir, "img/big.png")));
    const svg = new Uint8Array(readFileSync(join(dir, "img/icon.svg")));
    const r = loadAssetManifest(
      manifest([
        { id: "ok", kind: "image", file: "img/ok.png", sha256: sha(png), sourceUrl: "https://example.com/ok.png" },
        { id: "badhash", kind: "image", file: "img/ok.png", sha256: "0".repeat(64) },
        { id: "escape", kind: "image", file: "../w2f-outside.png", sha256: sha(png) },
        { id: "abs", kind: "image", file: join(dir, "img/ok.png"), sha256: sha(png) },
        { id: "link", kind: "image", file: "img/link.png", sha256: sha(png) },
        { id: "svg", kind: "image", file: "img/icon.svg", sha256: sha(svg) },
        { id: "big", kind: "reference", file: "img/big.png", sha256: sha(big) },
        { id: "private", kind: "image", file: "img/ok.png", sha256: sha(png), sourceUrl: "http://169.254.169.254/latest" },
        { id: "fakeip", kind: "image", file: "img/ok.png", sha256: sha(png), sourceUrl: "http://198.18.0.1/x.png" },
      ]),
    );
    expect(r.assets.map((a) => a.operatorId)).toEqual(["ok"]);
    const w = r.warnings.join("\n");
    expect(w).toMatch(/badhash omitted: SHA-256 mismatch/);
    expect(w).toMatch(/escape omitted: file must be a relative path/);
    expect(w).toMatch(/abs omitted: file must be a relative path/);
    expect(w).toMatch(/link omitted: not a regular file \(symlinks are refused\)/);
    expect(w).toMatch(/svg omitted: not a PNG, JPEG or GIF/);
    expect(w).toMatch(/big omitted: 4097x1px exceeds Figma's 4096px image limit/);
    expect(w).toMatch(/private omitted: source URL rejected/);
    expect(w).toMatch(/fakeip omitted: source URL rejected/);
  });

  it("refuses assets reached through a symlinked directory", () => {
    const outside = mkdtempSync(join(tmpdir(), "w2f-outside-dir-"));
    writeFileSync(join(outside, "p.png"), png);
    symlinkSync(outside, join(dir, "linkdir"));
    try {
      const r = loadAssetManifest(manifest([{ id: "viadir", kind: "image", file: "linkdir/p.png", sha256: sha(png) }]));
      expect(r.assets).toEqual([]);
      expect(r.warnings.join("\n")).toMatch(/viadir omitted: file escapes the manifest directory/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects malformed manifests outright", () => {
    expect(() => loadAssetManifest(manifest([{ id: "x y", kind: "image", file: "a.png", sha256: "0".repeat(64) }]))).toThrow(CaptureError);
    writeFileSync(join(dir, "bad.json"), "{");
    expect(() => loadAssetManifest(join(dir, "bad.json"))).toThrow(/not valid UTF-8 JSON/);
  });
});

describe("import validation: v2 strict, v1 unchanged", () => {
  const good = buildHifiFixture();
  const reject = (mutate: (d: any) => void, pattern: RegExp) => {
    const d = clone(good) as any;
    mutate(d);
    const r = validateHifiDoc(d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join("\n")).toMatch(pattern);
  };

  it("accepts the converter output and rejects tampering", () => {
    expect(validateHifiDoc(good).ok).toBe(true);
    reject((d) => (d.pages[0].nodes[0].onclick = "x"), /unknown key "onclick"/);
    reject((d) => (d.pages[0].nodes[0].fill.hex = "red"), /expected #rrggbb/);
    reject((d) => (d.pages[0].nodes[0].kind = "bogus"), /expected box \| text \| image \| shape \| svg/);
    reject((d) => (d.pages[0].nodes.find((n: any) => n.kind === "text").button = 0), /must reference a button box/);
    reject((d) => (d.pages[0].nodes.find((n: any) => n.kind === "image").assetId = "a9"), /unknown asset/);
    reject((d) => (d.assets[0].dataBase64 += "AAAA"), /length does not match bytes/);
    reject((d) => (d.assets[0].mime = "image/svg+xml"), /expected one of/);
    reject((d) => (d.assets[0].width = 5000), /expected number 1\.\.4096/);
    reject((d) => (d.assets[0].sourceUrl = "javascript:alert(1)"), /http\(s\) URL/);
    reject((d) => (d.pages[0].height = 40_000), /expected number 1\.\.30000/);
    reject((d) => (d.pages[0].nodes = new Array(LIMITS.hifiMaxNodesPerPage + 1).fill(d.pages[0].nodes[0])), /more than 6000 items/);
  });

  it("dispatches by version; v1 keeps its 1 MB bound and validator", () => {
    const v1 = JSON.stringify(buildFixture(5));
    expect(parseImportJson(v1)).toMatchObject({ ok: true, version: 1 });
    expect(parseImportJson(JSON.stringify(good))).toMatchObject({ ok: true, version: 2 });
    expect(parseImportJson(v1.replace("{", "{" + " ".repeat(LIMITS.maxJsonBytes)))).toMatchObject({ ok: false, errors: [expect.stringMatching(/larger than 1000000 bytes/)] });
    expect(parseImportJson(JSON.stringify({ ...good, schemaVersion: 3 }))).toMatchObject({ ok: false });
    expect(parseImportJson("[".repeat(100))).toMatchObject({ ok: false, errors: [expect.stringMatching(/nested deeper/)] });
  });
});

describe("type-only guard", () => {
  it("HifiDoc type is exported for plugin use", () => {
    const d: HifiDoc = buildHifiFixture();
    expect(d.schemaVersion).toBe(2);
  });
});

describe("hardening (review)", () => {
  it("image header parsing never throws on hostile bytes and rejects malformed IHDR", () => {
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) & 0xff;
    const prefixes = [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], [0xff, 0xd8], [0x47, 0x49, 0x46, 0x38, 0x39, 0x61], []];
    for (let i = 0; i < 2000; i++) {
      const p = prefixes[i % prefixes.length]!;
      const b = new Uint8Array(p.length + (i % 64)).map((_, j) => (j < p.length ? p[j]! : rnd()));
      const info = inspectImage(b);
      if (info) expect(info.width >= 0 && info.width <= 0xffffffff && info.height >= 0).toBe(true);
    }
    const png = syntheticPng(4, 4, [0, 0, 0], [1, 1, 1]);
    const badLen = png.slice();
    badLen[11] = 14;
    expect(inspectImage(badLen)).toBeNull();
    expect(inspectImage(png.slice(0, 20))).toBeNull();
    const shortSof = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0, 4, 8, 0, 50, 0, 70, 0]);
    expect(inspectImage(shortSof)).toBeNull();
  });

  it("enforces the aggregate decoded-pixel budget in the validator", () => {
    const d = clone(buildHifiFixture()) as any;
    for (let i = 0; i < 7; i++) d.assets.push({ ...d.assets[0], id: `a${i + 2}`, width: 4096, height: 4096 });
    const r = validateHifiDoc(d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join("\n")).toMatch(/decoded pixels in total/);
  });

  it("node cap drops decorative boxes before any text (no whole-page text loss)", () => {
    const cap = clone(syntheticCapture()) as any;
    const m = cap.pages[0].measured;
    for (let i = 0; i < LIMITS.hifiMaxNodesPerPage + 500; i++) m.elements.push({ tag: "div", x: 1, y: 1 + (i % 500), w: 2, h: 1, style: { backgroundColor: "rgb(1, 2, 3)" } });
    const out = convertCapture({ capture: cap, assets: syntheticAssets(), assetWarnings: [] });
    const p = out.pages[0]!;
    expect(p.nodes.length).toBeLessThanOrEqual(LIMITS.hifiMaxNodesPerPage);
    const measuredTexts = (cap.pages[0].measured.texts as { text: string }[]).map((t) => t.text.trim());
    const kept = [...p.nodes, ...(out.components ?? []).flatMap((c) => c.nodes)].filter((n): n is TextNode => n.kind === "text").map((n) => n.text.replace(/\u00a0/g, " ").trim());
    for (const t of measuredTexts) expect(kept).toContain(t);
    expect(p.nodes.some((n) => n.kind === "box" && n.role === "button")).toBe(true);
    expect(p.truncated).toBe(true);
    expect(p.warnings.join("\n")).toMatch(/node\(s\) omitted by the node cap \(0 of them text runs\)/);
    const send = p.nodes.find((n): n is TextNode => n.kind === "text" && n.text === "Send")!;
    expect(p.nodes[send.button]).toMatchObject({ kind: "box", role: "button" });
  });

  it("matches reference screenshots by manifest pageUrl and reports pages without one", () => {
    const cap = clone(syntheticCapture()) as any;
    delete cap.pages[0].referenceAssetId;
    const assets = syntheticAssets().map((a) => (a.kind === "reference" ? { ...a, pageUrl: "https://example.com/" } : a));
    const out = convertCapture({ capture: cap, assets, assetWarnings: [] });
    expect(out.pages[0]!.referenceAssetId).not.toBeNull();
    expect(out.pages[1]!.warnings).toContain("No reference screenshot supplied for this page");
  });

  it("adapter: saved scrape responses (measure-dom shape) convert identically to a direct capture", async () => {
    const { captureFromScrapeResponses } = await import("../src/hifi/adapter");
    const direct = syntheticCapture() as any;
    const responses = direct.pages
      .filter((p: any) => p.url !== "https://example.com/feed.xml")
      .map((p: any, i: number) => ({
        name: `page${i}.json`,
        json: { success: true, data: { metadata: { url: p.url, contentType: "text/html", statusCode: 200 }, branding: p.branding, screenshot: "https://storage.example.com/shot.png", actions: { javascriptReturns: [{ type: "object", value: { url: p.url, ...p.measured } }] }, ...(p.html ? { rawHtml: p.html } : {}) } },
      }));
    const { capture, screenshotHints } = captureFromScrapeResponses(responses, HIFI_LABEL_FOR_TEST);
    expect(screenshotHints).toHaveLength(2);
    const viaAdapter = convertCapture({ capture: { ...capture, pages: capture.pages.map((p, i) => (i === 0 ? { ...p, referenceAssetId: "ref-home" } : p)) }, assets: syntheticAssets(), assetWarnings: [] });
    const expected = convertCapture({ capture: { ...direct, pages: direct.pages.filter((p: any) => !p.url.endsWith("feed.xml")) }, assets: syntheticAssets(), assetWarnings: [] });
    expect(viaAdapter.pages.map((p) => p.nodes)).toEqual(expected.pages.map((p) => p.nodes));
    expect(() => captureFromScrapeResponses([{ name: "x.json", json: { data: { rawHtml: "<p>" } } }], "x")).toThrow(/no measured DOM value/);
  });
});

const HIFI_LABEL_FOR_TEST = "SYNTHETIC adapter test";
