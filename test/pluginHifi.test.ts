// Exercises the native hi-fi renderer against a minimal fake `figma` global
// that implements only the Plugin API calls the renderer uses. This checks
// renderer logic (verification order, fonts, structure, provenance, rollback
// contract); it is NOT a substitute for importing into real Figma.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildHifiFixture } from "../src/fixtures/hifiSynthetic";
import { buildStatesFixture } from "../src/fixtures/statesSynthetic";
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
let failReactions: boolean;
let nextId = 0;

function node(type: string): FakeNode {
  const n: FakeNode = {
    type,
    id: `${++nextId}:1`,
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
    async setVectorNetworkAsync(net: unknown) {
      n.network = net;
    },
    findOne(pred: (x: FakeNode) => boolean): FakeNode | null {
      const stack = [...n.children];
      while (stack.length) {
        const c = stack.shift()!;
        if (pred(c)) return c;
        stack.push(...c.children);
      }
      return null;
    },
    createInstance() {
      const clone = (src: FakeNode): FakeNode => {
        const c = node(src === n ? "INSTANCE" : src.type);
        c.name = src.name;
        c.fills = src.fills;
        c.strokes = src.strokes;
        for (const ch of src.children) (c.appendChild as (x: FakeNode) => void)(clone(ch));
        return c;
      };
      return clone(n);
    },
    async setReactionsAsync(r: unknown) {
      if (failReactions) throw new Error("simulated reaction failure");
      n.reactions = r;
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
  failReactions = false;
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
    createComponent: () => node("COMPONENT"),
    createEllipse: () => node("ELLIPSE"),
    createVector: () => node("VECTOR"),
    createNodeFromSvg: (markup: string) => {
      const f = node("FRAME");
      f.markup = markup;
      return f;
    },
    group: (nodes: FakeNode[]) => {
      const g = node("GROUP");
      g.children.push(...nodes);
      return g;
    },
    createFrame: () => node("FRAME"),
    combineAsVariants: (nodes: FakeNode[], parent: FakeNode) => {
      const set = node("COMPONENT_SET");
      for (const c of nodes) {
        if (c.type !== "COMPONENT") throw new Error("combineAsVariants: components only");
        if (c.parent) c.parent.children = c.parent.children.filter((x) => x !== c);
        (set.appendChild as (x: FakeNode) => void)(c);
      }
      (parent.appendChild as (x: FakeNode) => void)(set);
      return set;
    },
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
    expect(stats).toMatchObject({ pages: 2, images: 1, placeholders: 1, components: 2, instances: 4, edges: 1, svgs: 1, shapes: 1 });
    expect(stats.fontFallbacks).toBeGreaterThan(0);
    expect(stats.warnings.join("\n")).toMatch(/Font fallback used/);
    const section = sections[0]!;
    expect(section).toMatchObject({ type: "SECTION", x: 500 });
    const pageFrame = section.children.find((c) => c.name === "Page / / (editable, measured)")!;
    expect(pageFrame).toMatchObject({ type: "FRAME", width: 800, height: 600, clipsContent: true });
    const button = pageFrame.children.find((c) => c.name.startsWith("Button / Send [b"))!;
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
    // reference at its native pixel size (1:1), never rescaled to the page width
    const ref = section.children.find((c) => c.name === "Reference / /")!;
    expect(ref).toMatchObject({ x: 80 + 800 + 80, width: 800, height: 600 });
    // overflow clip frame holds the clipped code run
    const clip = pageFrame.children.find((c) => c.name === "Overflow clip / pre [c0]")!;
    expect(clip).toMatchObject({ type: "FRAME", clipsContent: true, x: 40, y: 440, width: 300, height: 50 });
    expect(clip.children.map((c) => c.characters)).toEqual(["const aVeryLongSyntheticLine = true;"]);
    // inferred list markers are right-aligned and never width-fitted
    const marker = pageFrame.children.find((c) => c.type === "TEXT" && c.characters === "3.")!;
    expect(marker).toMatchObject({ textAlignHorizontal: "RIGHT" });
    expect(JSON.parse(marker.data.w2f!)).toMatchObject({ prov: "inferred", fit: "not-fitted" });
    // radio checked center is an inferred ellipse; svg came from canonical sanitized markup
    expect(pageFrame.children.some((c) => c.type === "ELLIPSE" && c.name === "radio checked center (static approximation)")).toBe(true);
    expect(pageFrame.children.find((c) => c.name === "svg / sanitized vector")!.markup).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 16 16" width="16" height="16"><path d="M1 1 L15 1 L8 15 Z" fill="#212121"\/><\/svg>$/);
    // shared nav component + per-page instance overrides (inactive link color on /about)
    const about = section.children.find((c) => c.name === "Page / /about (editable, measured)")!;
    const navInstance = about.children.find((c) => c.type === "INSTANCE" && c.children.some((ch) => ch.name.startsWith("#1 ")))!;
    expect((navInstance.findOne as (p: (c: FakeNode) => boolean) => FakeNode | null)((c) => c.name.startsWith("#1 "))!.fills).toEqual([{ type: "SOLID", color: { r: 33 / 255, g: 33 / 255, b: 33 / 255 }, opacity: 1 }]);
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
    const send = page.children.find((c) => c.name.startsWith("Button / Send [b"))!.children[0]!;
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
    expect(notes.characters).toMatch(/Width fit skipped for 1 measured text run\(s\)/);
    expect(notes.characters).toMatch(/Warning: No reference screenshot supplied for this page/);
  });

  it("reassembles a tiled tall reference at its original offsets with tile provenance", { timeout: 60_000 }, async () => {
    const { tileReference } = await import("../src/hifi/tileReference");
    const { convertCapture } = await import("../src/hifi/convert");
    const { loadedFromBytes, syntheticPng } = await import("../src/fixtures/hifiSynthetic");
    const r = await tileReference(syntheticPng(200, 5000, [1, 1, 1], [9, 9, 9]));
    const doc = convertCapture({
      capture: { schema: "website-to-figma/capture", schemaVersion: 1, label: "SYNTHETIC", pages: [{ url: "https://example.com/", measured: { viewport: { width: 200 }, elements: [{ tag: "body", x: 0, y: 0, w: 200, h: 5000, style: {} }], texts: [], images: [] } }] },
      assets: [],
      assetWarnings: [],
      referenceTiles: [{ operatorId: "ref", pageUrl: "https://example.com/", sourceSha256: r.sourceSha256, width: r.width, height: r.height, tiles: r.tiles.map((t, i) => ({ y: t.y, h: t.h, asset: loadedFromBytes(`ref#tile${i}`, "reference", t.bytes, null) })) }],
    });
    tracked.length = 0;
    const sections: FakeNode[] = [];
    await buildHifiDoc(doc, track as never, sections as never, 0);
    const holder = sections[0]!.children.find((c) => c.name === "Reference / / (2 tiles)")!;
    expect(holder).toMatchObject({ type: "FRAME", width: 200, height: 5000, clipsContent: true });
    expect(holder.children.map((c) => [c.y, c.height, (c.fills as { imageHash: string }[])[0]!.imageHash])).toEqual([
      [0, 4096, expect.stringMatching(/^img-/)],
      [4096, 904, expect.stringMatching(/^img-/)],
    ]);
    expect(holder.children.map((c) => JSON.parse(c.data.w2f!).tileSha256)).toEqual(r.tiles.map((t) => t.sha256));
    expect(JSON.parse(holder.data.w2f!)).toMatchObject({ tiled: true, sourceSha256: r.sourceSha256 });
    expect(created.filter((n) => !tracked.includes(n))).toEqual([]);
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

describe("state variants, reactions and media (fake figma)", () => {
  it("combines native component variants with provenance and ON_CLICK -> CHANGE_TO reactions", async () => {
    tracked.length = 0;
    const sections: FakeNode[] = [];
    const stats = await buildHifiDoc(buildStatesFixture(), track as never, sections as never, 0);
    expect(stats).toMatchObject({ variantSets: 1, variants: 3, reactions: 3, media: 2 });
    const set = created.find((n) => n.type === "COMPONENT_SET")!;
    expect(set.name).toBe("States / /");
    expect(set.children.map((c) => c.name)).toEqual(["State=Default", "State=FAQ open", "State=Tab two"]);
    const [base, faq, tab] = set.children;
    expect(JSON.parse(faq!.data.w2f!)).toMatchObject({ provenance: "synthetic", screenshot: { association: "action-order", scrollY: 60 } });
    expect(JSON.parse(base!.data.w2f!).provenance).toBe("baseline");
    expect(faq!.description).toMatch(/not an observed original state/);
    expect(faq!.description).toMatch(/No handler side-effect guarantee/);
    expect(faq!).toMatchObject({ width: 400, height: 140, clipsContent: true });
    // hidden 1:1 provider screenshot placed where it was taken
    const shot = faq!.children.find((c) => c.name.startsWith("Reference screenshot / FAQ open"))!;
    expect(shot).toMatchObject({ visible: false, locked: true, x: -40, y: -40, width: 800, height: 600 });
    expect(faq!.children.some((c) => c.type === "TEXT" && c.characters === "Synthetic answer text.")).toBe(true);
    const dest = (c: FakeNode) => (c.reactions as any)[0];
    expect(dest(base!)).toEqual({ trigger: { type: "ON_CLICK" }, actions: [{ type: "NODE", destinationId: faq!.id, navigation: "CHANGE_TO", transition: null }] });
    expect(dest(faq!).actions[0].destinationId).toBe(tab!.id);
    expect(dest(tab!).actions[0].destinationId).toBe(base!.id);
    expect(created.filter((n) => !tracked.includes(n))).toEqual([]);
  });

  it("renders media as an operator still or a labelled placeholder, never as playing media", async () => {
    await buildHifiDoc(buildStatesFixture(), track as never, [], 0);
    const page = created.find((n) => n.name === "Page / / (editable, measured)")!;
    const still = page.children.find((c) => c.name.startsWith("MEDIA STILL / video"))!;
    expect((still.fills as any)[0].type).toBe("IMAGE");
    const ph = page.children.find((c) => c.name.startsWith("MEDIA PLACEHOLDER / canvas"))!;
    expect(ph.name).toMatch(/no still available; WebGL/);
    expect(JSON.parse(ph.data.w2f!)).toMatchObject({ media: "canvas", still: "unavailable", webgl: true });
    const notes = created.find((n) => n.name === "Notes / /")!;
    expect(notes.characters).toMatch(/NOT frozen: JS timers, requestAnimationFrame loops, WebGL\/canvas rendering/);
    expect(notes.characters).toMatch(/Freeze modification: forced \.aos-animate/);
  });

  it("no reactions unless requested", async () => {
    const stats = await buildHifiDoc(buildStatesFixture({ reactions: "none" }), track as never, [], 0);
    expect(stats.reactions).toBe(0);
    expect(created.filter((n) => n.type === "COMPONENT").every((c) => c.reactions === undefined)).toBe(true);
  });

  it("a reaction failure leaves every created node (variant set included) tracked for rollback", async () => {
    tracked.length = 0;
    failReactions = true;
    await expect(buildHifiDoc(buildStatesFixture(), track as never, [], 0)).rejects.toThrow(/simulated reaction failure/);
    expect(created.some((n) => n.type === "COMPONENT_SET")).toBe(true);
    expect(created.filter((n) => !tracked.includes(n))).toEqual([]);
    // the caller's rollback (code.ts buildV2) removes tracked nodes newest-first
    for (let i = tracked.length - 1; i >= 0; i--) if (!tracked[i]!.removed) (tracked[i]!.remove as () => void)();
    expect(created.every((n) => n.removed)).toBe(true);
  });

  it("a mid-variant failure is also fully tracked", async () => {
    tracked.length = 0;
    failOnText = 9;
    await expect(buildHifiDoc(buildStatesFixture(), track as never, [], 0)).rejects.toThrow(/simulated/);
    expect(created.filter((n) => !tracked.includes(n))).toEqual([]);
  });
});
