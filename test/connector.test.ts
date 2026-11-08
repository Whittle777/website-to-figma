// Connector ($fig) adapter tests: the BUNDLED shared renderer runs inside a
// fake connector environment. The fake $fig enforces plan semantics (nodes
// exist only after done(); .node before a flush throws); the fake raw `figma`
// throws on any create*/mutation access. No real Figma calls anywhere.
import { buildSync } from "esbuild";
import { describe, expect, it } from "vitest";
import { buildStatesFixture } from "../src/fixtures/statesSynthetic";
import { buildHifiFixture } from "../src/fixtures/hifiSynthetic";
import { planConnectorJobs, parseImageHashMap } from "../src/connector/jobs";
import { PlannedHost } from "../src/connector/plannedHost";
import { NativeHost } from "../plugin/src/render/nativeHost";
import { renderDocument, pageFrameName } from "../plugin/src/render/renderer";
import { validateHifiDoc, type HifiDoc, type HifiNode } from "../src/shared/hifiSchema";

// SYNTHETIC large document (no real site content): many base nodes, buttons,
// a clip group, long warnings/notes, 30/30/15-node variants, a 60-node shared
// component with instance overrides.
function largeDoc(o: { hugeSvg?: boolean; heavyMeta?: boolean } = {}): HifiDoc {
  const base = buildStatesFixture({ reactions: "click-cycle" });
  const page = base.pages[0]!;
  const paint = { hex: "#212121", alpha: 1 };
  const text = (i: number, x: number, y: number, button = -1, clip?: number): HifiNode => ({ kind: "text", name: `p / synthetic run ${i}`, text: `Synthetic text run number ${i} with some length to it`, graphemes: 50, fontStack: ["-apple-system", "BlinkMacSystemFont", "Segoe UI", "Roboto", "sans-serif"], generic: "sans", weight: 400, italic: false, size: 16, lineHeight: 24, color: paint, decoration: "none", button, prov: "measured", x, y, w: 380, h: 24, ...(clip !== undefined ? { clip } : {}) });
  const box = (i: number, x: number, y: number, role: "block" | "button" = "block", clip?: number): HifiNode => ({ kind: "box", name: `div / synthetic block ${i}`, role, x, y, w: 300, h: 40, fill: { hex: "#f5f7ff", alpha: 1 }, border: { weight: 1, color: { hex: "#898ea4", alpha: 1 } }, radius: [4, 4, 4, 4], opacity: 1, prov: "measured", ...(clip !== undefined ? { clip } : {}) });
  const nodes: HifiNode[] = [];
  for (let i = 0; i < 140; i++) nodes.push(box(i, 20 + (i % 3) * 320, 20 + Math.floor(i / 3) * 60));
  for (let i = 0; i < 20; i++) nodes.push(box(1000 + i, 20, 3000 + i * 50, "button"));
  for (let i = 0; i < 20; i++) nodes.push(text(2000 + i, 30, 3010 + i * 50, 140 + i));
  for (let i = 0; i < 10; i++) nodes.push(box(3000 + i, 10, 4000 + i * 30, "block", 0));
  for (let i = 0; i < 10; i++) nodes.push(text(4000 + i, 10, 4005 + i * 30, -1, 0));
  for (let i = 0; i < 220; i++) nodes.push(text(i, 20 + (i % 2) * 400, 20 + Math.floor(i / 2) * 26));
  if (o.hugeSvg) {
    const d = "M0 0 " + Array.from({ length: 2600 }, (_, k) => `L${k % 16} ${(k * 7) % 16}`).join(" ");
    nodes.push({ kind: "svg", name: "svg / huge", x: 0, y: 0, w: 16, h: 16, markup: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16"><path d="${d}"/></svg>`, prov: "measured" });
  }
  const variantNodes = (n: number, tag: string): HifiNode[] => Array.from({ length: n }, (_, i) => (i % 2 ? text(5000 + i, 10, 10 + i * 20) : box(5000 + i, 10, 10 + i * 20)) as HifiNode).map((x) => ({ ...x, name: `${x.name} ${tag}` }));
  const warn = Array.from({ length: 50 }, (_, i) => `Synthetic warning ${i}: ${"lorem ipsum dolor sit amet ".repeat(6).slice(0, 170)}`);
  const navNodes: HifiNode[] = Array.from({ length: 60 }, (_, i) => (i % 2 ? text(6000 + i, 10 + i * 10, 20) : box(6000 + i, 10 + i * 10, 10)) as HifiNode);
  const states = page.states!;
  // long UNRENDERED page metadata (only notes text reads it): 155 motion rules, long freeze, branding, normalization
  const heavy = o.heavyMeta
    ? {
        motion: { rules: Array.from({ length: 155 }, (_, i) => ({ selector: `.synthetic-${i} ${"x".repeat(180)}`.slice(0, 200), kind: (["transition", "animation", "hover"] as const)[i % 3], detail: `opacity ${i}ms ease ${"y".repeat(180)}`.slice(0, 200) })), inaccessibleSheets: 3 },
        freeze: { attempted: ["css-animations-transitions", "web-animations", "video-pause", "swiper-autoplay-stop", "force-aos-visible"], applied: [{ name: "css-animations-transitions", count: 1 }, { name: "web-animations", count: 40 }], unavailable: [], modifications: Array.from({ length: 10 }, (_, i) => `synthetic modification ${i} ${"z".repeat(160)}`), notFrozen: ["JS timers", "requestAnimationFrame loops", "WebGL/canvas rendering"] },
        branding: { colors: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`c${i}`, "#123456"])), fonts: ["Synthetic Sans", "Synthetic Mono"] },
        normalization: { mode: "centered-dpr1" as const, measuredWidth: 1920, measuredHeight: 5000, offsetX: -320, gutterPx: 0, gutters: 0 },
      }
    : {};
  return {
    ...base,
    warnings: warn.slice(0, 50),
    components: [{ id: "c0", kind: "nav", name: "Shared / nav (big)", w: 800, h: 60, nodes: navNodes }],
    pages: [
      {
        ...page,
        height: 5000,
        nodes,
        clips: [{ x: 0, y: 3990, w: 300, h: 320, name: "Overflow clip / pre" }],
        warnings: warn,
        notes: warn.slice(0, 20),
        ...heavy,
        instances: [{ component: "c0", x: 0, y: 0, overrides: [{ index: 1, color: { hex: "#0d47a1", alpha: 1 } }, { index: 2, fill: null }] }],
        states: { ...states, variants: states.variants.map((v, i) => ({ ...v, nodes: variantNodes([30, 30, 15][i]!, v.name), notes: Array.from({ length: 10 }, (_, k) => `Synthetic variant note ${k}: ${"x".repeat(150)}`) })) },
      },
    ],
  } as HifiDoc;
}

const bundle = buildSync({ entryPoints: ["src/connector/entry.ts"], bundle: true, minify: true, platform: "neutral", format: "iife", globalName: "W2F", target: "es2020", charset: "ascii", legalComments: "none", write: false }).outputFiles[0]!.text;

// ---------------- fake connector environment ----------------
interface FNode { id: string; type: string; name: string; x: number; y: number; width: number; height: number; props: Record<string, any>; children: FNode[]; parent: FNode | null; reactions?: unknown[] }
function fakeConnector(fonts = ["Inter|Regular", "Inter|Bold", "Roboto|Regular", "Roboto|Bold", "Roboto Mono|Regular"]) {
  let next = 0;
  const page: FNode = { id: "0:1", type: "PAGE", name: "Page", x: 0, y: 0, width: 0, height: 0, props: {}, children: [], parent: null };
  const pending: W[] = [];
  const log: string[] = [];
  let doneCalls = 0;
  const all = new Map<string, FNode>();
  class W {
    n: FNode | null = null;
    parentW: W | null = null;
    kids: W[] = [];
    constructor(public type: string, public props: Record<string, any>, existing?: FNode) {
      if (existing) this.n = existing;
      else pending.push(this);
    }
    append(c: W) {
      c.parentW = this;
      if (this.n && c.n) attach(this.n, c.n);
      else this.kids.push(c);
    }
    set(p: Record<string, any>) {
      Object.assign(this.props, p);
      if (this.n) apply(this.n, p);
    }
    query(sel: string) {
      const m = /^(\w+)\[name="(.*)"\]$/.exec(sel);
      if (!m) throw new Error(`fake $fig: unsupported selector ${sel}`);
      if (!this.n) throw new Error("query before flush");
      const hit = find(this.n, (x) => x.type === m[1] && x.name === m[2]);
      return { set: (p: Record<string, any>) => { if (hit) apply(hit, p); log.push(`override:${m[2]}:${hit ? "hit" : "miss"}`); } };
    }
    get node(): any {
      if (!this.n) throw new Error(`fake $fig: .node read before $fig.done() (${this.type} ${this.props.name})`);
      const n = this.n;
      return { get id() { return n.id; }, get width() { return n.width; }, get height() { return n.height; }, get x() { return n.x; }, get y() { return n.y; }, get name() { return n.name; }, get children() { return n.children; }, async setReactionsAsync(r: unknown[]) { n.reactions = r; log.push(`reactions:${n.name}`); } };
    }
  }
  const find = (root: FNode, pred: (n: FNode) => boolean): FNode | null => {
    for (const c of root.children) {
      if (pred(c)) return c;
      const f = find(c, pred);
      if (f) return f;
    }
    return null;
  };
  const attach = (p: FNode, c: FNode) => {
    if (c.parent) c.parent.children = c.parent.children.filter((x) => x !== c);
    c.parent = p;
    p.children.push(c);
  };
  const apply = (n: FNode, p: Record<string, any>) => {
    Object.assign(n.props, p);
    for (const k of ["name", "x", "y", "width", "height"] as const) if (p[k] !== undefined) (n as any)[k] = p[k];
    if (p.characters !== undefined && n.type === "TEXT" && n.props.textAutoResize !== "HEIGHT") n.width = [...String(p.characters)].length * (n.props.fontSize ?? 12) * 0.5;
  };
  const materialize = (w: W) => {
    const p = w.props;
    const n: FNode = { id: `${++next}:1`, type: w.type, name: p.name ?? "", x: p.x ?? 0, y: p.y ?? 0, width: p.width ?? 100, height: p.height ?? 100, props: { ...p }, children: [], parent: null };
    if (w.type === "TEXT") {
      const lines = String(p.characters).split("\n");
      if (p.textAutoResize !== "HEIGHT") n.width = Math.max(...lines.map((l) => [...l].length)) * (p.fontSize ?? 12) * 0.5;
      n.height = lines.length * (p.fontSize ?? 12) * 1.2;
    }
    all.set(n.id, n);
    w.n = n;
  };
  const fig = {
    frame: (p: any) => new W("FRAME", { ...p }),
    rectangle: (p: any) => new W("RECTANGLE", { ...p }),
    text: (p: any) => new W("TEXT", { ...p }),
    svg: (markup: string, p: any) => new W("FRAME", { ...p, markup }),
    component: (p: any) => new W("COMPONENT", { ...p }),
    ellipse: (p: any) => new W("ELLIPSE", { ...p }),
    instance: (id: string, p: any) => {
      const comp = all.get(id);
      if (!comp || comp.type !== "COMPONENT") throw new Error(`fake $fig: instance of unknown component ${id}`);
      const w = new W("INSTANCE", { ...p, name: comp.name, width: comp.width, height: comp.height });
      (w as any).cloneOf = comp;
      return w;
    },
    // Official figma-use signature only: $fig.variants(options, children).
    variants: (...args: unknown[]) => {
      const [opts, comps] = args as [any, W[]];
      if (args.length !== 2 || typeof opts !== "object" || opts === null || Array.isArray(opts) || typeof opts.name !== "string") throw new Error("fake $fig.variants: expected (options, children) with options.name");
      if (!Array.isArray(comps) || comps.length === 0 || comps.some((c) => !(c instanceof W) || c.type !== "COMPONENT")) throw new Error("fake $fig.variants: children must be $fig.component wrappers");
      const w = new W("COMPONENT_SET", { ...opts });
      (w as any).members = comps;
      log.push(`variants:${opts.name}:${comps.length}`);
      return w;
    },
    get: (id: string) => {
      const n = all.get(id);
      if (!n) throw new Error(`fake $fig.get: unknown ${id}`);
      return new W(n.type, n.props, n);
    },
    done: async () => {
      doneCalls++;
      const batch = pending.splice(0);
      for (const w of batch) materialize(w);
      for (const w of batch) {
        const clone = (w as any).cloneOf as FNode | undefined;
        if (clone) {
          const deep = (src: FNode, dst: FNode) => {
            for (const c of src.children) {
              const k: FNode = { ...c, id: `${++next}:1`, props: { ...c.props }, children: [], parent: null };
              all.set(k.id, k);
              attach(dst, k);
              deep(c, k);
            }
          };
          deep(clone, w.n!);
        }
        for (const k of w.kids) if (k.n) attach(w.n!, k.n);
        w.kids = [];
        if (!w.parentW && !w.n!.parent) attach(page, w.n!);
        if (w.parentW && w.parentW.n && !w.n!.parent) attach(w.parentW.n, w.n!);
        const members = (w as any).members as W[] | undefined;
        if (members) for (const m of members) attach(w.n!, m.n!);
      }
    },
  };
  const raw = new Proxy(
    {
      listAvailableFontsAsync: async () => fonts.map((k) => ({ fontName: { family: k.split("|")[0], style: k.split("|")[1] } })),
      loadFontAsync: async () => {},
      currentPage: { findAll: (pred: (n: FNode) => boolean) => { const out: FNode[] = []; const walk = (n: FNode) => { for (const c of n.children) { if (pred(c)) out.push(c); walk(c); } }; walk(page); return out; } },
    } as Record<string, unknown>,
    { get(t, k) { if (typeof k === "string" && !(k in t)) throw new Error(`fake figma: raw API "${k}" is not available in the connector`); return t[k as string]; } },
  );
  const run = async (script: string) => {
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
    return new AsyncFunction("$fig", "figma", script)(fig, raw);
  };
  return { page, run, log, all, doneCalls: () => doneCalls };
}

// ---------------- fake native environment (same renderer, native host) ----------------
function nativeRender(doc: HifiDoc) {
  const created: any[] = [];
  const node = (type: string): any => {
    const n: any = { type, name: "", x: 0, y: 0, width: 100, height: 100, children: [], parent: null, data: {}, id: `${created.length + 1}:9` };
    n.appendChild = (c: any) => { if (c.parent) c.parent.children = c.parent.children.filter((x: any) => x !== c); c.parent = n; n.children.push(c); };
    n.resize = (w: number, h: number) => { n.width = w; n.height = h; };
    n.resizeWithoutConstraints = n.resize;
    n.setPluginData = (k: string, v: string) => (n.data[k] = v);
    n.setVectorNetworkAsync = async () => {};
    n.setReactionsAsync = async (r: unknown) => (n.reactions = r);
    n.findOne = (p: any) => { const st = [...n.children]; while (st.length) { const c = st.shift(); if (p(c)) return c; st.push(...c.children); } return null; };
    n.createInstance = () => { const clone = (s: any): any => { const c = node(s === n ? "INSTANCE" : s.type); c.name = s.name; if (s !== n) { c.x = s.x; c.y = s.y; c.width = s.width; c.height = s.height; } for (const ch of s.children) c.appendChild(clone(ch)); return c; }; return clone(n); };
    if (type === "TEXT") Object.defineProperty(n, "characters", { get: () => n._c ?? "", set: (v: string) => { n._c = v; const lines = v.split("\n"); n.width = Math.max(...lines.map((l) => [...l].length)) * (n.fontSize ?? 12) * 0.5; n.height = lines.length * (n.fontSize ?? 12) * 1.2; } });
    created.push(n);
    return n;
  };
  (globalThis as any).figma = {
    listAvailableFontsAsync: async () => ["Inter|Regular", "Inter|Bold", "Roboto|Regular", "Roboto|Bold", "Roboto Mono|Regular"].map((k) => ({ fontName: { family: k.split("|")[0], style: k.split("|")[1] } })),
    loadFontAsync: async () => {},
    createSection: () => node("SECTION"), createFrame: () => node("FRAME"), createRectangle: () => node("RECTANGLE"), createText: () => node("TEXT"), createEllipse: () => node("ELLIPSE"), createVector: () => node("VECTOR"), createComponent: () => node("COMPONENT"),
    createNodeFromSvg: () => node("FRAME"),
    combineAsVariants: (comps: any[], parent: any) => { const s = node("COMPONENT_SET"); for (const c of comps) s.appendChild(c); parent.appendChild(s); return s; },
    group: (ns: any[], parent: any) => { const g = node("GROUP"); for (const c of ns) g.appendChild(c); parent.appendChild(g); return g; },
  };
  return renderDocument(new NativeHost(<T,>(n: T) => n, new Map()), doc, "root", 0).finally(() => delete (globalThis as any).figma);
}

// Structural signature of a page frame subtree: names and geometry, in z-order.
function signature(root: { children: any[] }, depth = 0): string[] {
  const out: string[] = [];
  for (const c of root.children) {
    const t = c.type === "VECTOR" ? "PATH" : c.type;
    const isPath = c.name.startsWith("Sitemap edge") || /caret|grip/.test(c.name);
    out.push(`${"  ".repeat(depth)}${isPath ? "PATH" : t} ${c.name} @${Math.round(c.x)},${Math.round(c.y)}`);
    out.push(...signature(c, depth + 1));
  }
  return out;
}
const findName = (root: { children: any[] }, name: string): any => {
  for (const c of root.children) {
    if (c.name === name) return c;
    const f = findName(c, name);
    if (f) return f;
  }
  return null;
};

async function runAll(doc: HifiDoc, maxJobChars?: number, imageHashesBySha?: Record<string, string>) {
  const env = fakeConnector();
  const plan = planConnectorJobs(doc, bundle, { maxJobChars, imageHashesBySha });
  const results: any[] = [];
  for (const j of plan.jobs) results.push(await env.run(j.script));
  return { env, plan, results };
}

describe("connector adapter: same renderer, planned $fig host (fake connector)", () => {
  it("runs the bundled renderer with $fig only; never touches figma.create*", async () => {
    const doc = buildStatesFixture();
    const { env, plan, results } = await runAll(doc);
    expect(plan.jobs[0]!.kind).toBe("root");
    expect(plan.jobs.at(-1)!.kind).toBe("edges");
    expect(plan.jobs.every((j) => j.chars <= 40_000 && j.script.startsWith(bundle))).toBe(true);
    expect(results[0].rootId).toMatch(/:1$/);
    const root = env.page.children.find((n) => n.name === plan.rootName)!;
    expect(root.type).toBe("FRAME");
    const frame = findName(root, pageFrameName(doc.pages[0]!));
    expect(frame).toMatchObject({ type: "FRAME", width: 800, height: 700 });
    expect(results.flatMap((r) => r.unsupported).join(" ")).toMatch(/pluginData provenance/);
  });

  it("produces the same page structure (names, geometry, z-order) as the native host", async () => {
    for (const doc of [buildHifiFixture(), buildStatesFixture()]) {
      const native = await nativeRender(doc);
      const { env, plan } = await runAll(doc);
      const croot = env.page.children.find((n) => n.name === plan.rootName)!;
      for (const p of doc.pages) {
        const nf = findName(native.root as any, pageFrameName(p));
        const cf = findName(croot, pageFrameName(p));
        // image nodes differ only in placeholder naming (no image hashes here); normalize
        const norm = (s: string[]) => s.map((l) => l.replace(/IMAGE PLACEHOLDER \(fill unavailable\) \/ /, "").replace(/ @/, " @"));
        expect(norm(signature(cf))).toEqual(norm(signature(nf)).map((l) => l));
      }
    }
  });

  it("builds native variants via $fig.variants, grids them after a flush, and adds reactions only post-flush", async () => {
    const { env, plan } = await runAll(buildStatesFixture({ reactions: "click-cycle" }));
    expect(env.log).toContain("variants:States / /:3");
    const root = env.page.children.find((n) => n.name === plan.rootName)!;
    const set = findName(root, "States / /");
    expect(set.type).toBe("COMPONENT_SET");
    expect(set.children.map((c: any) => c.name)).toEqual(["State=Default", "State=FAQ open", "State=Tab two"]);
    const xs = set.children.map((c: any) => c.x);
    expect(xs[0]).toBe(0);
    expect(xs[1]).toBe(set.children[0].width + 40);
    expect(set.width).toBe(set.children.reduce((n: number, c: any) => n + c.width, 0) + 80);
    const [a, b, c] = set.children;
    expect(a.reactions).toEqual([{ trigger: { type: "ON_CLICK" }, actions: [{ type: "NODE", destinationId: b.id, navigation: "CHANGE_TO", transition: null }] }]);
    expect(c.reactions[0].actions[0].destinationId).toBe(a.id);
  });

  it("batches large pages into phase-ordered jobs with identical results", async () => {
    const doc = buildHifiFixture();
    const whole = await runAll(doc, 400_000);
    const small = await runAll(doc, bundle.length + 7_000);
    expect(small.plan.jobs.length).toBeGreaterThan(whole.plan.jobs.length);
    expect(small.plan.jobs.some((j) => j.kind === "nodes")).toBe(true);
    expect(small.plan.jobs.every((j) => j.chars <= bundle.length + 7_000)).toBe(true);
    const sig = (r: Awaited<ReturnType<typeof runAll>>) => {
      const root = r.env.page.children.find((n) => n.name === r.plan.rootName)!;
      return doc.pages.map((p) => signature(findName(root, pageFrameName(p))).sort());
    };
    expect(sig(small)).toEqual(sig(whole));
    // z-order within the home frame: unclipped boxes, then clip frames, then texts
    const root = small.env.page.children.find((n) => n.name === small.plan.rootName)!;
    const home = findName(root, pageFrameName(doc.pages[0]!));
    const types = home.children.map((c: any) => c.type);
    expect(types.lastIndexOf("RECTANGLE")).toBeLessThan(types.indexOf("TEXT"));
    const clipAt = home.children.findIndex((c: any) => c.name.startsWith("Overflow clip / pre [c0]"));
    expect(clipAt).toBeGreaterThan(-1);
    expect(clipAt).toBeLessThan(types.indexOf("TEXT"));
    expect(findName(home, "Overflow clip / pre [c0]").children.some((c: any) => c.type === "TEXT")).toBe(true);
  });

  it("fills images only from an origin-supplied existing-hash mapping; otherwise labelled placeholders", async () => {
    const doc = buildHifiFixture();
    const photo = doc.assets.find((a) => a.kind === "image")!;
    const plain = await runAll(doc);
    const r0 = plain.env.page.children.find((n) => n.name === plain.plan.rootName)!;
    expect(findName(r0, "IMAGE PLACEHOLDER (fill unavailable) / image / Synthetic photo")).toBeTruthy();
    const hashes = parseImageHashMap({ schema: "website-to-figma/connector-image-hashes", schemaVersion: 1, hashes: { [photo.sha256]: "a".repeat(40) } });
    const mapped = await runAll(doc, undefined, hashes);
    const r1 = mapped.env.page.children.find((n) => n.name === mapped.plan.rootName)!;
    const img = findName(r1, "image / Synthetic photo");
    expect(img.props.fills).toEqual([{ type: "IMAGE", imageHash: "a".repeat(40), scaleMode: "FILL" }]);
    expect(() => parseImageHashMap({ schema: "website-to-figma/connector-image-hashes", schemaVersion: 1, hashes: { [photo.sha256]: "not-a-hash" } })).toThrow(/invalid entry/);
    expect(() => new PlannedHost({} as never, {} as never, { a0: "xyz" })).toThrow(/40-hex/);
  });

  it("the fake connector rejects the old (children, options) argument order", async () => {
    const env = fakeConnector();
    await expect(env.run(`const c = $fig.component({ name: "A", width: 1, height: 1 }); $fig.variants([c], { name: "X" });`)).rejects.toThrow(/expected \(options, children\)/);
    await env.run(`const c = $fig.component({ name: "A", width: 1, height: 1 }); $fig.variants({ name: "X" }, [c]); await $fig.done();`);
    expect(env.log).toContain("variants:X:1");
  });

  it("a large synthetic document: every job fits 40000 (and 50000), structure equals native, variants and descriptions intact", async () => {
    const doc = largeDoc();
    expect(validateHifiDoc(doc).ok).toBe(true);
    const native = await nativeRender(doc);
    for (const max of [40_000, 50_000]) {
      const { env, plan, results } = await runAll(doc, max);
      expect(plan.jobs.every((j) => j.chars <= max)).toBe(true);
      expect(plan.jobs.filter((j) => j.kind === "nodes").length).toBeGreaterThan(5);
      expect(plan.jobs.some((j) => j.kind === "states")).toBe(true);
      expect(results.every((r) => r.rootId === results[0].rootId)).toBe(true);
      const croot = env.page.children.find((n) => n.name === plan.rootName)!;
      const p0 = doc.pages[0]!;
      // exact z-order and geometry inside the page frame
      expect(signature(findName(croot, pageFrameName(p0)))).toEqual(signature(findName(native.root as any, pageFrameName(p0))));
      // variants: same children subtrees, official signature, descriptions applied by batches
      const cset = findName(croot, "States / /");
      const nset = findName(native.root as any, "States / /");
      expect(cset.children.map((c: any) => c.name)).toEqual(nset.children.map((c: any) => c.name));
      for (const [i, v] of cset.children.entries()) {
        expect(signature(v)).toEqual(signature(nset.children[i]));
        expect(v.props.description).toBe(doc.pages[0]!.states!.variants[i]!.notes.join("\n"));
      }
      expect(env.log).toContain("variants:States / /:3");
      // shared component nodes and instance overrides
      const nav = findName(croot, "Shared / nav (big)");
      expect(nav.children.length).toBe(60);
      expect(env.log.filter((l) => l.startsWith("override:")).every((l) => l.endsWith(":hit"))).toBe(true);
    }
  });

  it("long unrendered metadata (155 motion rules, freeze, branding) still fits 40000; source doc untouched; provenance kept in notes", async () => {
    const doc = largeDoc({ heavyMeta: true });
    expect(validateHifiDoc(doc).ok).toBe(true);
    expect(JSON.stringify(doc.pages[0]!.motion).length).toBeGreaterThan(50_000);
    const before = JSON.stringify(doc);
    const { env, plan } = await runAll(doc, 40_000);
    expect(JSON.stringify(doc)).toBe(before); // no mutation of the source document
    expect(plan.jobs.every((j) => j.chars <= 40_000)).toBe(true);
    // only label jobs (notes text) carry the motion/freeze provenance lines
    const notesText = plan.jobs.filter((j) => j.kind === "label").map((j) => j.script).join("\n");
    expect(notesText).toMatch(/Motion \(static notes, not animated\): 155 transition\/animation\/hover rule\(s\); 3 unreadable stylesheet\(s\)/);
    expect(notesText).toMatch(/Freeze modification: synthetic modification 9/);
    for (const j of plan.jobs.filter((x) => x.kind !== "label")) expect(j.script).not.toMatch(/synthetic-154|synthetic modification 9/);
    const native = await nativeRender(doc);
    const croot = env.page.children.find((n) => n.name === plan.rootName)!;
    expect(signature(findName(croot, pageFrameName(doc.pages[0]!)))).toEqual(signature(findName(native.root as any, pageFrameName(doc.pages[0]!))));
  });

  it("refuses to plan when one node cannot fit; nothing is written", () => {
    const doc = largeDoc({ hugeSvg: true });
    expect(() => planConnectorJobs(doc, bundle, { maxJobChars: 40_000 })).toThrow(/alone needs \d+ chars, over --max-job-chars 40000/);
    expect(() => planConnectorJobs(doc, bundle, { maxJobChars: bundle.length + 100 })).toThrow(/leaves no room/);
    expect(planConnectorJobs(doc, bundle, { maxJobChars: 80_000 }).jobs.length).toBeGreaterThan(3);
  });

  it("refuses duplicate roots and reads before flush", async () => {
    const doc = buildStatesFixture();
    const env = fakeConnector();
    const plan = planConnectorJobs(doc, bundle);
    await env.run(plan.jobs[0]!.script);
    await expect(env.run(plan.jobs[0]!.script)).rejects.toThrow(/already exists/);
    const host = new PlannedHost({ text: () => ({ append() {}, set() {}, query() { return { set() {} }; }, get node(): never { throw new Error("pending"); } }), frame: () => ({ append() {} }) } as never, {} as never);
    const parent = { append() {} } as never;
    const t = host.text(parent, { name: "t", x: 0, y: 0, characters: "x", font: { family: "Inter", style: "Regular" }, size: 12, color: null });
    expect(() => host.width(t)).toThrow(/pending; flush first/);
  });
});
