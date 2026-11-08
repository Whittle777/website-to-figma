// Synthetic regressions for defects found in an offline visual QA of a real
// conversion (shapes only; no site content). Each test reproduces the defect
// shape and asserts the evidence-gated correction or the explicit warning.
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { convertCapture, type LoadedAsset } from "../src/hifi/convert";
import { loadAssetManifest } from "../src/hifi/assets";
import { loadedFromBytes, syntheticPng } from "../src/fixtures/hifiSynthetic";
import { isCanonicalSvg, sanitizeSvg } from "../src/shared/svgSanitize";
import { validateHifiDoc, type BoxNode, type HifiDoc, type ShapeNode, type TextNode } from "../src/shared/hifiSchema";
import { mappedFamily, resolveFont } from "../src/shared/fonts";

const z = { backgroundColor: "rgba(0, 0, 0, 0)", display: "block", visibility: "visible", opacity: "1", borderRadius: "0px" };
const bx = (o: Record<string, string> = {}) => ({ ...z, borderTopWidth: "0px", borderRightWidth: "0px", borderBottomWidth: "0px", borderLeftWidth: "0px", ...o });
const tx = (o: Record<string, string> = {}) => ({ fontFamily: "Roboto, sans-serif", fontSize: "16px", fontWeight: "400", fontStyle: "normal", color: "rgb(33, 33, 33)", textDecorationLine: "none", ...o });
const refPng = (w: number, h: number) => loadedFromBytes("ref", "reference", syntheticPng(w, h, [255, 255, 255], [250, 250, 250]), null);
const page = (measured: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ schema: "website-to-figma/capture", schemaVersion: 1, label: "SYNTHETIC regression", pages: [{ url: "https://example.com/", referenceAssetId: "ref", measured, ...extra }] });
const conv = (capture: unknown, assets: LoadedAsset[] = [], extra: Partial<Parameters<typeof convertCapture>[0]> = {}): HifiDoc => convertCapture({ capture, assets, assetWarnings: [], ...extra });
const texts = (d: HifiDoc, i = 0) => d.pages[i]!.nodes.filter((n): n is TextNode => n.kind === "text");

describe("G1: measured 1920px viewport vs 1280px reference", () => {
  const measured = {
    viewport: { width: 1920, height: 100000 },
    elements: [
      { tag: "body", x: 0, y: 0, w: 1920, h: 400, style: bx({ backgroundColor: "rgb(255, 255, 255)" }) },
      { tag: "header", x: 0, y: 0, w: 1920, h: 120, style: bx({ backgroundColor: "rgb(245, 247, 255)" }) },
      { tag: "nav", x: 8, y: 0, w: 1904, h: 60, style: bx({ backgroundColor: "rgb(240, 240, 240)" }) },
      { tag: "main", x: 600, y: 120, w: 720, h: 200, style: bx({ backgroundColor: "rgb(250, 250, 250)" }) },
    ],
    texts: [{ text: "Centered", x: 600, y: 140, w: 100, h: 20, tag: "p", style: tx() }],
    images: [],
  };
  it("maps full-bleed, margin-anchored and centered boxes to the reference width, and shows the reference at 1:1", () => {
    const d = conv(page(measured), [refPng(1280, 400)], { normalizeReference: "centered-dpr1" });
    const p = d.pages[0]!;
    const box = (name: string) => p.nodes.find((n): n is BoxNode => n.kind === "box" && n.name === name)!;
    expect(p.width).toBe(1280);
    expect(box("header")).toMatchObject({ x: 0, w: 1280 });
    expect(box("nav")).toMatchObject({ x: 8, w: 1264 });
    expect(box("main")).toMatchObject({ x: 280, w: 720 });
    expect(texts(d)[0]).toMatchObject({ x: 280 });
    expect(p.notes!.join("\n")).toMatch(/INFERRED normalization \(opt-in centered-dpr1\): width 1920px -> 1280px; 2 full-bleed stretched, 1 margin-anchored narrowed, 2 shifted -320px/);
    expect(p.normalization).toEqual({ mode: "centered-dpr1", measuredWidth: 1920, measuredHeight: 400, offsetX: -320, gutterPx: 0, gutters: 0 });
    expect(d.assets.find((a) => a.id === p.referenceAssetId)).toMatchObject({ width: 1280, height: 400 });
  });
  it("uses a rejected (too tall) reference's verified size as evidence without importing it", () => {
    const d = conv(page(measured), [], { normalizeReference: "centered-dpr1", rejectedReferences: [{ operatorId: "ref", pageUrl: null, width: 1280, height: 15902, reason: "1280x15902px exceeds Figma's 4096px image limit" }] });
    const p = d.pages[0]!;
    expect(p.width).toBe(1280);
    expect(p.referenceAssetId).toBeNull();
    expect(p.warnings.join("\n")).toMatch(/Reference screenshot \(1280x15902px\) not imported: .*4096px.*its size is still used as evidence/);
  });
  it("by default keeps measured geometry and warns about the size mismatch (no silent inference)", () => {
    const d = conv(page(measured), [refPng(1280, 380)]);
    const p = d.pages[0]!;
    expect(p.width).toBe(1920);
    expect(p.normalization).toBeUndefined();
    expect(p.nodes.find((n): n is BoxNode => n.kind === "box" && n.name === "main")).toMatchObject({ x: 600 });
    expect(p.warnings.join("\n")).toMatch(/Measured width 1920px differs from the reference's 1280px; measured geometry kept \(opt in with --normalize-reference centered-dpr1\)/);
    expect(p.warnings.join("\n")).toMatch(/Measured height 400px differs from the reference's 380px; measured geometry kept/);
  });
  it("keeps the measured width without a reference, and says so", () => {
    const d = conv({ ...page(measured), pages: [{ url: "https://example.com/", measured }] });
    expect(d.pages[0]!.width).toBe(1920);
    expect(d.pages[0]!.notes!.join("\n")).toMatch(/No reference screenshot size available; measured width 1920px kept/);
  });
  it("loader reports a too-tall reference's size for evidence (bounded, hash-verified)", () => {
    const dir = mkdtempSync(join(tmpdir(), "w2f-tall-"));
    try {
      const png = syntheticPng(100, 4097, [0, 0, 0], [1, 1, 1]);
      writeFileSync(join(dir, "tall.png"), png);
      writeFileSync(join(dir, "m.json"), JSON.stringify({ schema: "website-to-figma/asset-manifest", schemaVersion: 1, assets: [{ id: "tall", kind: "reference", file: "tall.png", sha256: createHash("sha256").update(png).digest("hex"), pageUrl: "https://example.com/" }] }));
      const r = loadAssetManifest(join(dir, "m.json"));
      expect(r.assets).toEqual([]);
      expect(r.rejectedReferences).toEqual([expect.objectContaining({ operatorId: "tall", width: 100, height: 4097, pageUrl: "https://example.com/" })]);
      expect(r.warnings.join("\n")).toMatch(/tiling would need an approved PNG codec dependency/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("G2: overflow clipping and hidden horizontal-scrollbar gutters", () => {
  const pre = (id: string, y: number) => ({ tag: "pre", id, x: 0, y, w: 300, h: 80, style: bx({ backgroundColor: "rgb(245, 247, 255)" }) });
  const code = (y: number) => ({ text: "x".repeat(60), x: 10, y, w: 500, h: 20, tag: "code", code: true, style: tx({ fontFamily: "monospace" }) });
  const measured = {
    viewport: { width: 400, height: 1000 },
    elements: [{ tag: "body", x: 0, y: 0, w: 400, h: 600, style: bx({ backgroundColor: "rgb(255, 255, 255)" }) }, pre("a", 100), pre("b", 250), pre("c", 400)],
    texts: [code(110), code(260), code(410), { text: "After all blocks", x: 10, y: 560, w: 120, h: 20, tag: "p", style: tx() }],
    images: [],
  };
  it("removes delta/N per overflowing container only when the reference height confirms it", () => {
    const d = conv(page(measured), [refPng(400, 555)], { normalizeReference: "centered-dpr1" }); // 600 - 3 x 15
    const p = d.pages[0]!;
    expect(p.height).toBe(555);
    expect(p.clips!.map((c) => [c.y, c.h])).toEqual([
      [100, 65],
      [235, 65],
      [370, 65],
    ]);
    const t = texts(d);
    expect(t.find((n) => n.text === "After all blocks")).toMatchObject({ y: 515 });
    expect(t.filter((n) => n.generic === "mono").map((n) => [n.y, n.clip])).toEqual([
      [110, 0],
      [245, 1],
      [380, 2],
    ]);
    expect(p.notes!.join("\n")).toMatch(/INFERRED normalization \(opt-in centered-dpr1\): Removed 3 hidden horizontal-scrollbar gutter\(s\) of 15px \(measured height 600px vs reference 555px\)/);
    expect(p.normalization).toMatchObject({ measuredHeight: 600, gutterPx: 15, gutters: 3 });
    const plain = conv(page(measured), [refPng(400, 555)]);
    expect(plain.pages[0]!.height).toBe(600);
    expect(plain.pages[0]!.clips).toHaveLength(3);
    expect(plain.pages[0]!.warnings.join("\n")).toMatch(/Measured height 600px differs from the reference's 555px \(3 horizontally overflowing container\(s\) may hold hidden scrollbars\); measured geometry kept/);
  });
  it("keeps measured heights and warns when the delta is not plausible or there is no reference", () => {
    const bad = conv(page(measured), [refPng(400, 200)], { normalizeReference: "centered-dpr1" });
    expect(bad.pages[0]!.height).toBe(600);
    expect(bad.pages[0]!.warnings.join("\n")).toMatch(/not consistent with hidden scrollbars, heights kept as measured/);
    const none = conv({ ...page(measured), pages: [{ url: "https://example.com/", measured }] }, [], { normalizeReference: "centered-dpr1" });
    expect(none.pages[0]!.warnings.join("\n")).toMatch(/3 horizontally overflowing container\(s\) detected; no reference height/);
    expect(none.pages[0]!.clips).toHaveLength(3);
  });
});

describe("G2: clip membership from observed DOM ancestry", () => {
  const measured = {
    viewport: { width: 400, height: 400 },
    elements: [
      { tag: "body", id: "b", x: 0, y: 0, w: 400, h: 300, style: bx() },
      { tag: "figure", id: "fig", x: 0, y: 50, w: 200, h: 100, style: bx() },
      { tag: "td", id: "c1", x: 10, y: 60, w: 150, h: 30, style: bx({ backgroundColor: "rgb(250, 250, 250)" }) },
      { tag: "td", id: "c2", x: 260, y: 60, w: 120, h: 30, style: bx({ backgroundColor: "rgb(250, 250, 250)" }) },
    ],
    texts: [{ text: "far cell", x: 270, y: 65, w: 80, h: 20, tag: "td", parent: "c2", style: tx() }],
    images: [],
  };
  const html = '<body data-w2f-id="b"><figure data-w2f-id="fig"><table><tr><td data-w2f-id="c1">a</td><td data-w2f-id="c2">far cell</td></tr></table></figure></body>';
  it("clips cells that start beyond the container's right edge when rawHtml gives their ancestry", () => {
    const d = conv(page(measured, { html }), [refPng(400, 300)]);
    const p = d.pages[0]!;
    expect(p.clips).toHaveLength(1);
    const far = p.nodes.filter((n) => n.x >= 260);
    expect(far.length).toBe(2);
    expect(far.every((n) => n.clip === 0)).toBe(true);
  });
  it("without rawHtml, geometry cannot attribute cells that start outside the container (documented limit)", () => {
    const d = conv(page(measured), [refPng(400, 300)]);
    const p = d.pages[0]!;
    expect(p.clips ?? []).toHaveLength(0);
    expect(p.nodes.filter((n) => n.x >= 260).every((n) => n.clip === undefined)).toBe(true);
  });
});

describe("G4: surrogate pairs split across captured runs", () => {
  const measured = {
    viewport: { width: 400, height: 400 },
    elements: [{ tag: "body", x: 0, y: 0, w: 400, h: 200, style: bx() }],
    texts: [
      { text: "Wave \ud83d", x: 0, y: 10, w: 60, h: 20, tag: "p", parent: "p1", style: tx() },
      { text: "\ude42", x: 60, y: 10, w: 18, h: 20, tag: "p", parent: "p1", style: tx() },
      { text: "Heart ❤", x: 0, y: 40, w: 60, h: 20, tag: "p", parent: "p2", style: tx() },
      { text: "️", x: 60, y: 40, w: 1, h: 20, tag: "p", parent: "p2", style: tx() },
      { text: "Orphan \ud83c", x: 0, y: 70, w: 70, h: 20, tag: "p", parent: "p3", style: tx() },
      { text: "Other line", x: 0, y: 100, w: 70, h: 20, tag: "p", parent: "p4", style: tx() },
    ],
    images: [],
  };
  it("rejoins adjacent fragments, removes unpairable ones visibly, and never emits lone surrogates", () => {
    const d = conv(page(measured), [refPng(400, 200)]);
    const t = texts(d).map((n) => n.text);
    expect(t).toContain("Wave 🙂");
    expect(t).toContain("Heart ❤️");
    expect(t).toContain("Orphan\u00a0");
    for (const x of t) expect(x).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
    expect(texts(d).find((n) => n.text === "Wave 🙂")).toMatchObject({ x: 0, w: 78, graphemes: 6 });
    expect(d.pages[0]!.notes!.join("\n")).toMatch(/Rejoined 2 text fragment\(s\)/);
    expect(d.pages[0]!.warnings.join("\n")).toMatch(/1 unpaired UTF-16 surrogate\(s\) had no adjacent partner/);
  });
  it("the v2 validator rejects lone surrogates in any text", () => {
    const d = JSON.parse(JSON.stringify(conv(page(measured), [refPng(400, 200)])));
    d.pages[0].nodes.find((n: { kind: string }) => n.kind === "text").text = "bad \ud83d";
    const r = validateHifiDoc(d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join("\n")).toMatch(/unpaired UTF-16 surrogate/);
  });
});

describe("G3: list markers only from rawHtml structure + measured list-item display", () => {
  const li = (id: string, y: number, display = "list-item") => ({ tag: "li", id, x: 100, y, w: 200, h: 24, style: bx({ display }) });
  const t = (parent: string, y: number) => ({ text: `item ${parent}`, x: 100, y, w: 80, h: 22, tag: "li", parent, style: tx() });
  const measured = {
    viewport: { width: 400, height: 400 },
    elements: [{ tag: "body", x: 0, y: 0, w: 400, h: 300, style: bx() }, li("a", 10), li("b", 40), li("c", 70), li("d", 100, "block"), li("e", 130)],
    texts: [t("a", 12), t("b", 42), t("c", 72), t("d", 102), t("e", 132)],
    images: [],
  };
  const html = '<ul><li data-w2f-id="a">x<ul><li data-w2f-id="b">y</li></ul></li></ul><ol start="7"><li data-w2f-id="c">z</li><li data-w2f-id="d">w</li></ol><nav><ul><li data-w2f-id="e">n</li></ul></nav>';
  it("adds disc / nested circle / ordinal markers, skips non-list-item display and nav lists", () => {
    const d = conv(page(measured, { html }), [refPng(400, 300)]);
    const markers = texts(d).filter((n) => n.name.startsWith("list marker"));
    expect(markers.map((m) => m.text)).toEqual(["•", "◦", "7."]);
    expect(markers.every((m) => m.prov === "inferred" && m.fit === false && m.align === "right" && m.x + m.w < 100)).toBe(true);
  });
  it("warns instead of guessing when rawHtml is absent", () => {
    const d = conv(page(measured), [refPng(400, 300)]);
    expect(texts(d).some((n) => n.name.startsWith("list marker"))).toBe(false);
    expect(d.pages[0]!.warnings.join("\n")).toMatch(/5 list item\(s\): no rawHtml in the capture/);
  });
});

describe("G5: native control parts", () => {
  const ctl = (tag: string, id: string, x: number, y: number, w: number, h: number, control: Record<string, unknown>, style: Record<string, string> = {}) => ({ tag, id, x, y, w, h, style: bx({ backgroundColor: "rgb(255, 255, 255)", borderTopWidth: "1px", borderRightWidth: "1px", borderBottomWidth: "1px", borderLeftWidth: "1px", borderTopColor: "rgb(137, 142, 164)", borderRightColor: "rgb(137, 142, 164)", borderBottomColor: "rgb(137, 142, 164)", borderLeftColor: "rgb(137, 142, 164)", fontSize: "16px", color: "rgb(33, 33, 33)", ...style }), control });
  const measured = {
    viewport: { width: 400, height: 600 },
    elements: [
      { tag: "body", x: 0, y: 0, w: 400, h: 500, style: bx() },
      ctl("select", "s1", 10, 10, 80, 40, { type: "select-one", selected: "Choose" }, { paddingLeft: "8px", paddingTop: "8px" }),
      ctl("select", "s2", 10, 60, 60, 100, { type: "select-multiple", selected: null }),
      { tag: "option", id: "o1", x: 12, y: 62, w: 50, h: 23, style: bx({ fontSize: "16px", color: "rgb(33, 33, 33)" }) },
      { tag: "option", id: "o2", x: 12, y: 85, w: 50, h: 23, style: bx({ fontSize: "16px", color: "rgb(33, 33, 33)" }) },
      { tag: "option", id: "o3", x: 12, y: 108, w: 50, h: 23, style: bx({ fontSize: "16px" }) },
      ctl("input", "r1", 10, 180, 20, 20, { type: "radio", checked: true }, { borderRadius: "100%", backgroundColor: "rgb(13, 71, 161)" }),
      ctl("input", "r2", 10, 210, 20, 20, { type: "radio", checked: false }, { borderRadius: "100%" }),
      ctl("textarea", "ta", 10, 240, 300, 100, { type: "textarea", value: "" }),
    ],
    texts: [],
    images: [],
  };
  const html = '<select data-w2f-id="s2" multiple><option data-w2f-id="o1">Alpha</option><option data-w2f-id="o2">Beta</option><option data-w2f-id="o3"></option></select>';
  const d = conv(page(measured, { html }), [refPng(400, 500)]);
  const nodes = d.pages[0]!.nodes;
  it("uses measured OPTION rects with rawHtml labels, never width-fitted; warns for empty labels", () => {
    const opts = texts(d).filter((n) => n.name.startsWith("option label"));
    expect(opts.map((o) => [o.text, o.y, o.fit, o.prov])).toEqual([
      ["Alpha", 62, false, "inferred"],
      ["Beta", 85, false, "inferred"],
    ]);
    expect(d.pages[0]!.warnings.join("\n")).toMatch(/1 option row\(s\) have no label in the saved rawHtml/);
    expect(texts(d).some((n) => n.name === "control label (select-multiple)")).toBe(false);
  });
  it("draws select caret, textarea grip, circular radios and a checked center as inferred static parts", () => {
    const shapes = nodes.filter((n): n is ShapeNode => n.kind === "shape");
    expect(shapes.map((s) => s.shape).sort()).toEqual(["caret", "ellipse", "grip"]);
    expect(shapes.every((s) => s.prov === "inferred" && /static approximation/.test(s.name))).toBe(true);
    const radios = nodes.filter((n): n is BoxNode => n.kind === "box" && n.role === "control" && n.w === 20);
    expect(radios.map((r) => r.radius)).toEqual([
      [10, 10, 10, 10],
      [10, 10, 10, 10],
    ]);
    expect(texts(d).find((n) => n.name === "control label (select-one)")).toMatchObject({ text: "Choose", fit: false, prov: "inferred" });
  });
});

describe("G6: bounded SVG sanitizer", () => {
  const ok = '<svg class="i" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg" style="width: 1em; fill: currentColor;"><path d="M0 0 L512 0 L256 512 Z" fill="currentColor"></path></svg>';
  it("rebuilds canonical markup from allowlisted primitives", () => {
    const r = sanitizeSvg(ok, 16, 16, "#212121");
    expect(r).toEqual({ ok: true, elements: 1, markup: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="16" height="16"><path d="M0 0 L512 0 L256 512 Z" fill="#212121"/></svg>' });
    if (r.ok) expect(isCanonicalSvg(r.markup)).toBe(true);
    expect(sanitizeSvg('<svg viewBox="0 0 10 10"><g fill="#fff"><circle cx="5" cy="5" r="4"/><rect x="1" y="1" width="2" height="2"/></g></svg>', 10, 10, null)).toMatchObject({ ok: true, elements: 3 });
  });
  it.each([
    ['<svg viewBox="0 0 1 1"><script>alert(1)</script></svg>', /<script>/],
    ['<svg viewBox="0 0 1 1"><style>*{}</style></svg>', /<style>/],
    ['<svg viewBox="0 0 1 1"><foreignObject></foreignObject></svg>', /foreignObject/],
    ['<svg viewBox="0 0 1 1"><image href="https://x/y.png"/></svg>', /references or URLs/],
    ['<svg viewBox="0 0 1 1"><use xlink:href="#a"/></svg>', /references or URLs/],
    ['<svg viewBox="0 0 1 1"><path d="M0 0" fill="url(#g)"/></svg>', /references or URLs/],
    ['<svg viewBox="0 0 1 1"><path d="M0 0" onload="x()"/></svg>', /unsupported attribute path.onload/],
    ['<svg viewBox="0 0 1 1"><!-- c --><path d="M0 0"/></svg>', /comments/],
    ['<svg viewBox="0 0 1 1"><path d="M0 0 &amp;"/></svg>', /entities/],
    ['<svg viewBox="0 0 1 1"><text>hi</text></svg>', /<text>/],
    ['<svg viewBox="0 0 1 1"><path d="M0 0;alert(1)"/></svg>', /invalid path data/],
    ['<svg viewBox="0 0 1 1"><path d="M0 0" transform="rotate(1)"/></svg>', /unsupported attribute/],
    ['<svg viewBox="0 0 1 1"><svg viewBox="0 0 1 1"><path d="M0 0"/></svg></svg>', /nested or repeated/],
    ['<svg><path d="M0 0"/></svg>', /no viewBox/],
    [`<svg viewBox="0 0 1 1">${'<path d="M0 0"/>'.repeat(201)}</svg>`, /too many SVG elements/],
    ['<svg viewBox="0 0 1 1"><path d="M0 0" fill="javascript:x"/></svg>', /references or URLs/],
    ['<?xml version="1.0"?><svg viewBox="0 0 1 1"><path d="M0 0"/></svg>', /comments, entities/],
    ['<svg viewBox="0 0 1 1"><path d="M0 0" fill="data:x"/></svg>', /references or URLs/],
    ['<svg viewBox="0 0 1 1"><path d="M0 0 L1e400 0"/></svg>', /invalid path data/],
    ['<svg viewBox="0 0 1 1"><circle cx="9e9" cy="0" r="1"/></svg>', /invalid number/],
    ['<svg viewBox="0 0 0 1"><path d="M0 0"/></svg>', /invalid viewBox/],
    ['<svg viewBox="0 0 1 1"><path style="fill:red" d="M0 0"/></svg>', /references|unsupported|dropped/],
    [`<svg viewBox="0 0 1 1"><path d="M0 0${" L1 1".repeat(20_001)}"/></svg>`, /too large|invalid path data/],
  ])("rejects %s", (svg, reason) => {
    const r = sanitizeSvg(svg, 10, 10, "#000000");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(reason);
  });
  it("the validator only accepts canonical sanitized markup", () => {
    expect(isCanonicalSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1" width="1" height="1"><path d="M0 0" fill="#000000" onload="x"/></svg>')).toBe(false);
  });
});

describe("G9: shared nav/footer components and sitemap parents", () => {
  const shared = (h: number, linkColor: string) => ({
    elements: [
      { tag: "nav", id: "n", x: 0, y: 0, w: 400, h: 50, style: bx() },
      { tag: "a", id: "l", x: 10, y: 10, w: 60, h: 30, style: bx({ borderTopWidth: "1px", borderRightWidth: "1px", borderBottomWidth: "1px", borderLeftWidth: "1px", borderTopColor: linkColor, borderRightColor: linkColor, borderBottomColor: linkColor, borderLeftColor: linkColor }) },
      { tag: "footer", id: "f", x: 0, y: h - 40, w: 400, h: 40, style: bx({ backgroundColor: "rgb(245, 247, 255)" }) },
    ],
    texts: [
      { text: "Home", x: 20, y: 15, w: 40, h: 20, tag: "a", style: tx({ color: linkColor }) },
      { text: "Footer", x: 10, y: h - 30, w: 50, h: 20, tag: "p", style: tx() },
    ],
  });
  const mk = (path: string, h: number, color: string) => {
    const s = shared(h, color);
    return { url: `https://example.com${path}`, measured: { viewport: { width: 400 }, elements: [{ tag: "body", x: 0, y: 0, w: 400, h, style: bx() }, ...s.elements], texts: [...s.texts, { text: `Body ${path}`, x: 10, y: 60, w: 80, h: 20, tag: "p", style: tx() }], images: [] } };
  };
  it("creates components for identical structures with paint overrides, and URL-path parents", () => {
    const d = conv({ schema: "website-to-figma/capture", schemaVersion: 1, label: "SYNTHETIC", pages: [mk("/", 300, "rgb(13, 71, 161)"), mk("/blog", 200, "rgb(33, 33, 33)"), mk("/blog/post", 250, "rgb(33, 33, 33)")] });
    expect(d.components!.map((c) => [c.kind, c.nodes.length])).toEqual([
      ["nav", 2],
      ["footer", 2],
    ]);
    expect(d.pages.map((p) => p.instances!.length)).toEqual([2, 2, 2]);
    const navOverrides = d.pages.map((p) => p.instances![0]!.overrides);
    expect(navOverrides[0]).toEqual([]);
    expect(navOverrides[1]).toEqual([
      { index: 0, color: { hex: "#212121", alpha: 1 } },
      { index: 1, color: { hex: "#212121", alpha: 1 } },
    ]);
    expect(d.pages.map((p) => p.parentId)).toEqual([null, "p0", "p1"]);
    expect(d.pages.every((p) => p.nodes.every((n) => !(n.kind === "text" && (n.text === "Home" || n.text === "Footer"))))).toBe(true);
    expect(validateHifiDoc(d).ok).toBe(true);
  });
});

describe("G7: explicit operator font map", () => {
  const avail = new Set(["Roboto Mono|Regular", "Ubuntu Mono|Regular", "Roboto|Regular", "Inter|Regular"]);
  const stack = ["Consolas", "Ubuntu Mono", "monospace"];
  it("honors the observed stack by default and applies only an explicit operator mapping", () => {
    expect(resolveFont(stack, "mono", 400, false, avail)).toMatchObject({ family: "Ubuntu Mono", fallback: true });
    const rule = mappedFamily(stack, "mono", [{ match: "monospace", use: "Roboto Mono" }]);
    expect(resolveFont(stack, "mono", 400, false, avail, rule)).toMatchObject({ family: "Roboto Mono", reason: "operator font map: monospace -> Roboto Mono" });
    expect(mappedFamily(["Roboto", "sans-serif"], "sans", [{ match: "monospace", use: "Roboto Mono" }])).toBeNull();
  });
});

afterAll(() => undefined);
