// Exercises the native hi-fi renderer against a minimal fake `figma` global
// that implements only the Plugin API calls the renderer uses. This checks
// renderer logic (verification order, fonts, structure, provenance, rollback
// contract); it is NOT a substitute for importing into real Figma.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildHifiFixture } from "../src/fixtures/hifiSynthetic";
import { buildHifiDoc, verifyAssets } from "../plugin/src/hifi";
import type { HifiDoc } from "../src/shared/hifiSchema";

interface FakeNode {
  type: string;
  name: string;
  children: FakeNode[];
  parent: FakeNode | null;
  removed: boolean;
  data: Record<string, string>;
  [k: string]: unknown;
}

let created: FakeNode[];
let loadedFonts: string[];
let events: string[];
let failFonts: Set<string>;
let failOnText: number | null;
let textCount: number;

function node(type: string): FakeNode {
  const n: FakeNode = {
    type,
    name: "",
    children: [],
    parent: null,
    removed: false,
    data: {},
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    appendChild(c: FakeNode) {
      c.parent = n;
      n.children.push(c);
    },
    resize(w: number, h: number) {
      n.width = w;
      n.height = h;
    },
    resizeWithoutConstraints(w: number, h: number) {
      n.width = w;
      n.height = h;
    },
    setPluginData(k: string, v: string) {
      n.data[k] = v;
    },
    remove() {
      n.removed = true;
    },
  };
  if (type === "TEXT") {
    // width follows characters/fontSize like an auto-width text node would
    Object.defineProperty(n, "characters", {
      get: () => n._chars ?? "",
      set: (v: string) => {
        n._chars = v;
        n.width = [...v].length * ((n.fontSize as number) ?? 12) * 0.5;
        n.height = ((n.fontSize as number) ?? 12) * 1.2;
      },
    });
  }
  created.push(n);
  events.push(`create:${type}`);
  return n;
}

beforeEach(() => {
  created = [];
  loadedFonts = [];
  events = [];
  failFonts = new Set();
  failOnText = null;
  textCount = 0;
  (globalThis as unknown as { figma: unknown }).figma = {
    base64Decode: (s: string) => new Uint8Array(Buffer.from(s, "base64")),
    listAvailableFontsAsync: async () =>
      ["Inter|Regular", "Inter|Bold", "Inter|Italic", "Roboto|Regular", "Roboto|Bold", "Roboto Mono|Regular"].map((k) => {
        const [family, style] = k.split("|");
        return { fontName: { family, style } };
      }),
    loadFontAsync: async (f: { family: string; style: string }) => {
      const key = `${f.family}|${f.style}`;
      events.push(`load:${key}`);
      if (failFonts.has(key)) throw new Error("font failed");
      loadedFonts.push(key);
    },
    createImage: (b: Uint8Array) => ({ hash: `img-${b.length}` }),
    createSection: () => node("SECTION"),
    createFrame: () => node("FRAME"),
    createRectangle: () => node("RECTANGLE"),
    createText: () => {
      textCount++;
      if (failOnText !== null && textCount === failOnText) throw new Error("simulated mid-build failure");
      return node("TEXT");
    },
  };
});
afterEach(() => {
  delete (globalThis as unknown as { figma?: unknown }).figma;
});

const tracked: FakeNode[] = [];
const track = <T,>(n: T): T => {
  tracked.push(n as unknown as FakeNode);
  return n;
};
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe("native hi-fi renderer (fake figma)", () => {
  it("refuses tampered asset bytes before creating any node", async () => {
    const doc = clone(buildHifiFixture()) as HifiDoc;
    const b = Buffer.from(doc.assets[0]!.dataBase64, "base64");
    b[b.length - 1] = b[b.length - 1]! ^ 0xff;
    doc.assets[0]!.dataBase64 = b.toString("base64");
    await expect(buildHifiDoc(doc, track as never, [], 0)).rejects.toThrow(/SHA-256 mismatch/);
    expect(created).toEqual([]);
    const doc2 = clone(buildHifiFixture()) as HifiDoc;
    doc2.assets[0]!.width = 121;
    expect(() => verifyAssets(doc2)).toThrow(/image header does not match/);
  });

  it("builds editable frames, buttons, text, image fills, placeholders and references with provenance", async () => {
    tracked.length = 0;
    const sections: FakeNode[] = [];
    const stats = await buildHifiDoc(buildHifiFixture(), track as never, sections as never, 500);
    expect(stats).toMatchObject({ pages: 2, images: 1, placeholders: 1 });
    expect(stats.fontFallbacks).toBeGreaterThan(0);
    expect(stats.warnings.join("\n")).toMatch(/Font fallback used/);
    const section = sections[0]!;
    expect(section).toMatchObject({ type: "SECTION", x: 500 });
    const pageFrame = section.children.find((c) => c.name === "Page / / (editable, measured)")!;
    expect(pageFrame).toMatchObject({ type: "FRAME", width: 800, height: 600, clipsContent: true });
    const button = pageFrame.children.find((c) => c.name === "Button / Send")!;
    expect(button).toMatchObject({ type: "FRAME", strokeWeight: 2, strokeAlign: "INSIDE", topLeftRadius: 5, bottomRightRadius: 8 });
    const sendLabel = button.children.find((c) => c.type === "TEXT")!;
    expect(sendLabel).toMatchObject({ characters: "Send", x: 48, y: 12, fontName: { family: "Roboto", style: "Bold" } });
    const code = pageFrame.children.find((c) => c.type === "TEXT" && c.characters === "x = 1")!;
    expect(JSON.parse(code.data.w2f!)).toMatchObject({ prov: "measured", font: "Roboto Mono Regular", fallback: true });
    const inferred = pageFrame.children.find((c) => c.type === "TEXT" && c.characters === "Your email")!;
    expect(JSON.parse(inferred.data.w2f!).prov).toBe("inferred");
    const img = pageFrame.children.find((c) => c.name === "image / Synthetic photo")!;
    expect(img.fills).toEqual([{ type: "IMAGE", imageHash: "img-276", scaleMode: "FILL" }]);
    expect(pageFrame.children.some((c) => c.name === "MISSING IMAGE / image / Missing image")).toBe(true);
    const ref = section.children.find((c) => c.name === "Reference / /")!;
    expect(ref).toMatchObject({ x: 80 + 800 + 80, width: 800, height: 600 });
    const notes = section.children.find((c) => c.name === "Notes / /")!;
    expect(notes.characters).toMatch(/Warning: 1 image\(s\) have no supplied asset bytes/);
    expect(notes.characters).toMatch(/not responsive, not pixel-perfect/);
    expect(notes.characters).toMatch(/Branding \(page-level, not per-element\)/);
    expect(loadedFonts).toEqual(expect.arrayContaining(["Inter|Regular", "Roboto|Bold", "Roboto Mono|Regular", "Inter|Italic"]));
  });

  it("falls back when a listed font fails to load, reports it, and loads all fonts before creating nodes", async () => {
    failFonts.add("Roboto|Bold");
    const sections: FakeNode[] = [];
    const stats = await buildHifiDoc(buildHifiFixture(), track as never, sections as never, 0);
    const lastLoad = events.map((e, i) => (e.startsWith("load:") ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
    const firstCreate = events.findIndex((e) => e.startsWith("create:"));
    expect(lastLoad).toBeLessThan(firstCreate);
    const page = sections[0]!.children.find((c) => c.name === "Page / / (editable, measured)")!;
    const send = page.children.find((c) => c.name === "Button / Send")!.children[0]!;
    expect(send.fontName).toEqual({ family: "Inter", style: "Bold" });
    const notes = sections[0]!.children.find((c) => c.name === "Notes / /")!;
    expect(notes.characters).toMatch(/Font load failure: Roboto Bold failed to load/);
    expect(notes.characters).toMatch(/Font fallback \(\d+ runs?\): ".*" bold -> Inter Bold/);
    expect(stats.warnings.join("\n")).toMatch(/Font load failure: Roboto Bold failed to load/);
  });

  it("reports text runs whose measured width cannot be fitted", async () => {
    const baseline = await buildHifiDoc(buildHifiFixture(), track as never, [] as never, 0);
    const doc = clone(buildHifiFixture()) as HifiDoc;
    const t = doc.pages[1]!.nodes.find((n) => n.kind === "text")!;
    t.w = 5000;
    const sections: FakeNode[] = [];
    const stats = await buildHifiDoc(doc, track as never, sections as never, 0);
    expect(stats.unfitted).toBe(baseline.unfitted + 1);
    expect(stats.warnings.join("\n")).toMatch(/Width fit skipped for \d+ text run\(s\)/);
    const notes = sections[0]!.children.find((c) => c.name === "Notes / /about")!;
    expect(notes.characters).toMatch(/Width fit skipped for 1 text run\(s\)/);
    expect(notes.characters).toMatch(/Warning: No reference screenshot supplied for this page/);
  });

  it("tracks every node created before a mid-build failure, so the caller can roll back", async () => {
    tracked.length = 0;
    failOnText = 6;
    await expect(buildHifiDoc(buildHifiFixture(), track as never, [], 0)).rejects.toThrow(/simulated/);
    const untracked = created.filter((n) => !tracked.includes(n));
    expect(created.length).toBeGreaterThan(0);
    expect(untracked).toEqual([]);
  });
});
