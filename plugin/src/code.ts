// Figma plugin main thread (sandbox: no DOM, no network, no Node). Receives
// JSON text from the UI iframe, validates it with the shared strict validator,
// then builds low-fidelity editable wireframes on the current page:
//   1. a "Components" section (repeated nav/footer/card structures), and
//   2. a separate "Sitemap" section below it (page frames + vector edges),
// both placed to the right of any existing content so nothing overlaps.
import { LIMITS } from "../../src/shared/limits";
import { type Block, type Card, type FooterBlock, type NavBlock, type Page, type SiteMapDoc } from "../../src/shared/schema";
import { parseImportJson, type HifiDoc } from "../../src/shared/hifiSchema";
import { buildHifiDoc, type HifiStats } from "./hifi";
import { cardShape, placeRow, placeSitemap, planComponents, type CardShape, type Size } from "../../src/shared/layout";

const PAGE_W = 480;
const PAD = 16;
const INNER_W = PAGE_W - PAD * 2;
const CARD_W = 136;
const SECTION_PAD = 80;
const AREA_GAP = 240;

const FONT_REGULAR: FontName = { family: "Inter", style: "Regular" };
const FONT_BOLD: FontName = { family: "Inter", style: "Bold" };

const grey = (v: number): SolidPaint => ({ type: "SOLID", color: { r: v, g: v, b: v } });
const BG = grey(1);
const PANEL = grey(0.9);
const BLOCK = grey(0.82);
const INK = grey(0.25);
const MUTED = grey(0.5);
const LINE = grey(0.6);

// Every node this import creates is recorded so a failed build can remove all
// of it, including nodes not yet attached to a section.
let tracked: SceneNode[] | null = null;
function track<T extends SceneNode>(node: T): T {
  tracked?.push(node);
  return node;
}

type UiMessage = { type: "status" | "error" | "done"; text: string; details?: string[] };

function post(msg: UiMessage): void {
  figma.ui.postMessage(msg);
}

figma.showUI(__html__, { width: 400, height: 480, themeColors: true });

let busy = false;

// Only two message shapes are accepted from the UI; everything else is ignored.
function readMessage(raw: unknown): { type: "import"; json: string } | { type: "close" } | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const m = raw as Record<string, unknown>;
  const keys = Object.keys(m);
  if (m.type === "close" && keys.length === 1) return { type: "close" };
  if (m.type === "import" && keys.length === 2 && typeof m.json === "string" && m.json.length <= LIMITS.hifiMaxJsonBytes) {
    return { type: "import", json: m.json };
  }
  return null;
}

figma.ui.onmessage = async (raw: unknown) => {
  const msg = readMessage(raw);
  if (!msg) {
    post({ type: "error", text: "Ignored an unexpected message from the plugin UI." });
    return;
  }
  if (msg.type === "close") {
    // Never close mid-import: rollback must be able to run if the build fails.
    if (busy) {
      post({ type: "error", text: "An import is running; close is disabled until it finishes." });
      return;
    }
    figma.closePlugin();
    return;
  }
  if (busy) {
    post({ type: "error", text: "An import is already running." });
    return;
  }
  busy = true;
  try {
    const result = parseImportJson(msg.json);
    if (!result.ok) {
      post({ type: "error", text: "JSON rejected by the website-to-figma schema validator. Nothing was created.", details: result.errors.slice(0, 12) });
      return;
    }
    if (result.version === 2) {
      post({ type: "status", text: "Valid hi-fi document. Verifying images, loading fonts and building frames..." });
      const h = await buildV2(result.doc);
      post({
        type: "done",
        text: `Created ${h.pages} hi-fi page(s): ${h.nodes} measured node(s), ${h.images} image fill(s), ${h.placeholders} missing-image placeholder(s), ${h.fitted} width-fitted text run(s).`,
        details: h.warnings,
      });
      return;
    }
    post({ type: "status", text: "Valid. Loading fonts and building frames..." });
    const stats = await build(result.doc);
    post({
      type: "done",
      text: `Created ${stats.pages} page frame(s), ${stats.components} component(s), ${stats.instances} instance(s) and ${stats.edges} edge(s).`,
      details: stats.warnings,
    });
  } catch (err) {
    post({ type: "error", text: `Import failed: ${err instanceof Error ? err.message : String(err)}` });
  } finally {
    busy = false;
  }
};

// ---------- node helpers ----------

function text(chars: string, size: number, bold = false, color: SolidPaint = INK): TextNode {
  const t = track(figma.createText());
  t.fontName = bold ? FONT_BOLD : FONT_REGULAR;
  t.characters = chars;
  t.fontSize = size;
  t.fills = [color];
  return t;
}

// Append to an auto-layout parent and stretch horizontally. Sizing must be set
// after appendChild (FILL is only valid for auto-layout children).
function appendFill(parent: FrameNode | ComponentNode, child: SceneNode & LayoutMixin): void {
  parent.appendChild(child);
  child.layoutSizingHorizontal = "FILL";
  if (child.type === "TEXT") child.textAutoResize = "HEIGHT";
}

function autoLayout(node: FrameNode | ComponentNode, dir: "VERTICAL" | "HORIZONTAL", spacing: number, pad: number, fill: SolidPaint | null): void {
  node.layoutMode = dir;
  node.itemSpacing = spacing;
  node.paddingTop = node.paddingBottom = node.paddingLeft = node.paddingRight = pad;
  node.fills = fill ? [fill] : [];
  node.clipsContent = false;
}

function placeholder(name: string, w: number, h: number): RectangleNode {
  const r = track(figma.createRectangle());
  r.name = name;
  r.resize(w, h);
  r.fills = [BLOCK];
  return r;
}

// ---------- structure builders (used for both components and plain frames) ----------

function fillNav(node: FrameNode | ComponentNode, nav: NavBlock): void {
  autoLayout(node, "HORIZONTAL", 12, 8, PANEL);
  node.counterAxisAlignItems = "CENTER";
  node.resize(INNER_W, 32);
  node.primaryAxisSizingMode = "FIXED";
  node.counterAxisSizingMode = "AUTO";
  node.appendChild(placeholder("Logo", 24, 16));
  for (const item of nav.items) {
    const t = text(item, 11);
    t.name = "Nav item";
    node.appendChild(t);
  }
}

function fillFooter(node: FrameNode | ComponentNode, footer: FooterBlock): void {
  autoLayout(node, "VERTICAL", 6, 10, PANEL);
  node.resize(INNER_W, 40);
  node.counterAxisSizingMode = "FIXED";
  node.primaryAxisSizingMode = "AUTO";
  if (footer.items.length > 0) {
    const row = track(figma.createFrame());
    node.appendChild(row);
    row.name = "Footer links";
    autoLayout(row, "HORIZONTAL", 10, 0, null);
    // Fixed (FILL) width first, then hug height, then wrapping.
    row.layoutSizingHorizontal = "FILL";
    row.layoutSizingVertical = "HUG";
    row.layoutWrap = "WRAP";
    row.counterAxisSpacing = 4;
    for (const item of footer.items) row.appendChild(text(item, 10, false, MUTED));
  }
  if (footer.text) {
    const t = text(footer.text, 10, false, MUTED);
    t.name = "Footer text";
    appendFill(node, t);
  }
}

function fillCard(node: FrameNode | ComponentNode, shape: CardShape, card: Card): void {
  autoLayout(node, "VERTICAL", 4, 8, PANEL);
  node.resize(CARD_W, 60);
  node.counterAxisSizingMode = "FIXED";
  node.primaryAxisSizingMode = "AUTO";
  node.strokes = [LINE];
  node.strokeWeight = 1;
  const img = placeholder("Image", CARD_W - 16, 48);
  appendFill(node, img);
  if (shape !== "text") {
    const t = text(card.title || "Card title", 11, true);
    t.name = "Card title";
    appendFill(node, t);
  }
  if (shape !== "title") {
    const t = text(card.text || "Card text", 10, false, MUTED);
    t.name = "Card text";
    appendFill(node, t);
  }
}

// ---------- build ----------

interface BuildStats {
  pages: number;
  components: number;
  instances: number;
  edges: number;
  warnings: string[];
}

function existingContentRight(): number {
  let right = -Infinity;
  for (const n of figma.currentPage.children) {
    if ("x" in n && "width" in n) right = Math.max(right, n.x + n.width);
  }
  return Number.isFinite(right) ? right + AREA_GAP : 0;
}

function sectionTitle(section: SectionNode, title: string, subtitle: string): number {
  const h = text(title, 24, true);
  h.name = "Area title";
  section.appendChild(h);
  h.x = SECTION_PAD;
  h.y = SECTION_PAD / 2;
  const s = text(subtitle, 12, false, MUTED);
  s.name = "Area note";
  section.appendChild(s);
  s.resize(1100, s.height);
  s.textAutoResize = "HEIGHT";
  s.x = SECTION_PAD;
  s.y = h.y + h.height + 8;
  return s.y + s.height + 40;
}

// schemaVersion 2: same rollback contract as v1 (every created node tracked
// and removed newest-first on failure). Asset bytes and fonts are verified and
// loaded inside buildHifiDoc before any node is created.
async function buildV2(doc: HifiDoc): Promise<HifiStats> {
  const created: SceneNode[] = [];
  const all: SceneNode[] = [];
  tracked = all;
  try {
    const stats = await buildHifiDoc(doc, track, created, existingContentRight());
    figma.currentPage.selection = created;
    figma.viewport.scrollAndZoomIntoView(created);
    return stats;
  } catch (err) {
    for (let i = all.length - 1; i >= 0; i--) {
      const n = all[i]!;
      try {
        if (!n.removed) n.remove();
      } catch {
        // keep removing the rest
      }
    }
    throw err;
  } finally {
    tracked = null;
  }
}

async function build(doc: SiteMapDoc): Promise<BuildStats> {
  try {
    await Promise.all([figma.loadFontAsync(FONT_REGULAR), figma.loadFontAsync(FONT_BOLD)]);
  } catch {
    throw new Error("Could not load Inter Regular/Bold. Nothing was created.");
  }
  const warnings: string[] = [];
  const created: SceneNode[] = [];
  const all: SceneNode[] = [];
  tracked = all;
  try {
    return await buildInner(doc, warnings, created);
  } catch (err) {
    // Leave no half-built output behind: remove newest first; children of an
    // already-removed parent report `removed` and are skipped.
    for (let i = all.length - 1; i >= 0; i--) {
      const n = all[i]!;
      try {
        if (!n.removed) n.remove();
      } catch {
        // keep removing the rest
      }
    }
    throw err;
  } finally {
    tracked = null;
  }
}

async function buildInner(doc: SiteMapDoc, warnings: string[], created: SceneNode[]): Promise<BuildStats> {
  const plan = planComponents(doc.pages);
  const host = doc.site.host;
  const originX = existingContentRight();
  const sourceLabel = doc.source.mode === "fixture" ? `${doc.source.label} (${doc.source.fixtureId})` : `Firecrawl crawl of ${doc.source.startUrl}`;
  const k = doc.crawl;
  const crawlLine = `${k.returnedCount} page(s), limit ${k.requestedLimit}, discovered ${k.discoveredCount ?? "unknown"}, truncated: ${k.truncated}, incomplete: ${k.incomplete}.`;
  if (k.truncated) warnings.push("Source JSON is truncated (page cap reached).");
  if (k.incomplete) warnings.push("Source JSON is marked incomplete; see notes in the Sitemap area.");

  // ---- Components area ----
  const navComponents = new Map<string, ComponentNode>();
  const footerComponents = new Map<string, ComponentNode>();
  const cardComponents = new Map<CardShape, ComponentNode>();
  const componentNodes: ComponentNode[] = [];
  let componentsBottom = 0;

  const anyComponents = plan.navs.some((g) => g.isComponent) || plan.footers.some((g) => g.isComponent) || plan.cardShapes.some((g) => g.isComponent);
  if (anyComponents) {
    const section = track(figma.createSection());
    created.push(section);
    section.name = `website-to-figma · Components (generated, low-fi) · ${host}`;
    section.x = originX;
    section.y = 0;
    const top = sectionTitle(
      section,
      "Components (generated by website-to-figma)",
      "Only structures that repeat with identical content (nav, footer) or identical shape (card) become components. Low-fidelity placeholders, not pixel-accurate.",
    );
    let i = 0;
    for (const g of plan.navs) {
      if (!g.isComponent) continue;
      const c = track(figma.createComponent());
      section.appendChild(c);
      c.name = `Nav ${String.fromCharCode(65 + i++)} · ${g.content.items.length} links · used on ${g.pageIds.length} pages · ${g.signature}`;
      fillNav(c, g.content);
      navComponents.set(g.signature, c);
      componentNodes.push(c);
    }
    i = 0;
    for (const g of plan.footers) {
      if (!g.isComponent) continue;
      const c = track(figma.createComponent());
      section.appendChild(c);
      c.name = `Footer ${String.fromCharCode(65 + i++)} · used on ${g.pageIds.length} pages · ${g.signature}`;
      fillFooter(c, g.content);
      footerComponents.set(g.signature, c);
      componentNodes.push(c);
    }
    for (const g of plan.cardShapes) {
      if (!g.isComponent) continue;
      const c = track(figma.createComponent());
      section.appendChild(c);
      c.name = `Card · ${g.shape} · ${g.count} uses`;
      fillCard(c, g.shape, { title: "", text: "" });
      cardComponents.set(g.shape, c);
      componentNodes.push(c);
    }
    const row = placeRow(
      componentNodes.map((c) => ({ w: c.width, h: c.height })),
      { x: SECTION_PAD, y: top },
      1400,
    );
    componentNodes.forEach((c, idx) => {
      c.x = row.rects[idx]!.x;
      c.y = row.rects[idx]!.y;
    });
    const width = Math.max(row.bounds.x + row.bounds.w, 1180) + SECTION_PAD;
    section.resizeWithoutConstraints(width, row.bounds.y + row.bounds.h + SECTION_PAD);
    componentsBottom = section.y + section.height;
  }

  // ---- Sitemap area ----
  const sitemap = track(figma.createSection());
  created.push(sitemap);
  sitemap.name = `website-to-figma · Sitemap · ${host}`;
  sitemap.x = originX;
  sitemap.y = anyComponents ? componentsBottom + AREA_GAP : 0;
  const notes = k.notes.length > 0 ? ` Notes: ${k.notes.join(" | ")}` : "";
  const top = sectionTitle(
    sitemap,
    `Sitemap · ${host}`,
    `Source: ${sourceLabel}. ${crawlLine}${notes} Low-fidelity wireframes generated from page structure; not pixel-accurate. Not affiliated with Figma or the site owner.`,
  );

  let instances = 0;
  const frames = new Map<string, FrameNode>();
  for (const page of doc.pages) {
    const f = buildPageFrame(sitemap, page, plan.navByPage.get(page.id), plan.footerByPage.get(page.id), navComponents, footerComponents, cardComponents);
    instances += f.instances;
    frames.set(page.id, f.frame);
  }
  const sizes = new Map<string, Size>();
  for (const [id, f] of frames) sizes.set(id, { w: f.width, h: f.height });
  const placement = placeSitemap(doc.pages, sizes, { x: SECTION_PAD, y: top });
  for (const [id, r] of placement.frames) {
    const f = frames.get(id)!;
    f.x = r.x;
    f.y = r.y;
  }

  const vectors: VectorNode[] = [];
  for (const e of placement.edges) {
    const v = track(figma.createVector());
    sitemap.appendChild(v);
    v.name = `Edge ${e.from} → ${e.to}`;
    const minX = Math.min(...e.points.map((p) => p.x));
    const minY = Math.min(...e.points.map((p) => p.y));
    const last = e.points.length - 1;
    await v.setVectorNetworkAsync({
      vertices: e.points.map((p, i) => (i === last ? { x: p.x - minX, y: p.y - minY, strokeCap: "ARROW_LINES" as const } : { x: p.x - minX, y: p.y - minY })),
      segments: e.points.slice(1).map((_, i) => ({ start: i, end: i + 1 })),
      regions: [],
    });
    v.x = minX;
    v.y = minY;
    v.strokes = [LINE];
    v.strokeWeight = 2;
    v.fills = [];
    vectors.push(v);
  }
  if (vectors.length > 0) {
    const g = track(figma.group(vectors, sitemap, 0));
    g.name = "Sitemap edges (vectors)";
  }
  sitemap.resizeWithoutConstraints(
    Math.max(placement.bounds.x + placement.bounds.w, 1180) + SECTION_PAD,
    placement.bounds.y + placement.bounds.h + SECTION_PAD,
  );

  figma.currentPage.selection = created;
  figma.viewport.scrollAndZoomIntoView(created);
  return { pages: frames.size, components: componentNodes.length, instances, edges: vectors.length, warnings };
}

function buildPageFrame(
  parent: SectionNode,
  page: Page,
  navSig: string | undefined,
  footerSig: string | undefined,
  navComponents: Map<string, ComponentNode>,
  footerComponents: Map<string, ComponentNode>,
  cardComponents: Map<CardShape, ComponentNode>,
): { frame: FrameNode; instances: number } {
  let instances = 0;
  const f = track(figma.createFrame());
  parent.appendChild(f);
  f.name = `${page.path} · ${page.title}`;
  autoLayout(f, "VERTICAL", 12, PAD, BG);
  f.resize(PAGE_W, 200);
  f.counterAxisSizingMode = "FIXED";
  f.primaryAxisSizingMode = "AUTO";
  f.strokes = [LINE];
  f.strokeWeight = 1;

  const label = text(page.path, 10, false, MUTED);
  label.name = "Page path";
  appendFill(f, label);

  if (page.nav) {
    const comp = navSig ? navComponents.get(navSig) : undefined;
    if (comp) {
      appendFill(f, track(comp.createInstance()));
      instances++;
    } else {
      const n = track(figma.createFrame());
      f.appendChild(n);
      n.name = "Nav (unique on this page)";
      fillNav(n, page.nav);
      n.layoutSizingHorizontal = "FILL";
    }
  }

  for (const b of page.blocks) instances += appendBlock(f, b, cardComponents);

  if (page.footer) {
    const comp = footerSig ? footerComponents.get(footerSig) : undefined;
    if (comp) {
      appendFill(f, track(comp.createInstance()));
      instances++;
    } else {
      const n = track(figma.createFrame());
      f.appendChild(n);
      n.name = "Footer (unique on this page)";
      fillFooter(n, page.footer);
      n.layoutSizingHorizontal = "FILL";
    }
  }
  return { frame: f, instances };
}

function setInstanceText(inst: InstanceNode, name: string, value: string): void {
  const t = inst.findOne((n) => n.type === "TEXT" && n.name === name) as TextNode | null;
  if (t) t.characters = value;
}

function appendBlock(f: FrameNode, b: Block, cardComponents: Map<CardShape, ComponentNode>): number {
  if (b.type === "heading") {
    const t = text(b.text, b.level === 1 ? 20 : b.level === 2 ? 15 : 13, true);
    t.name = `H${b.level}`;
    appendFill(f, t);
    return 0;
  }
  if (b.type === "text") {
    const t = text(b.text, 11, false, MUTED);
    t.name = "Text";
    appendFill(f, t);
    return 0;
  }
  let instances = 0;
  const row = track(figma.createFrame());
  f.appendChild(row);
  row.name = `Cards (${b.cards.length})`;
  autoLayout(row, "HORIZONTAL", 8, 0, null);
  row.layoutSizingHorizontal = "FILL";
  row.layoutSizingVertical = "HUG";
  row.layoutWrap = "WRAP";
  row.counterAxisSpacing = 8;
  for (const card of b.cards) {
    const shape = cardShape(card);
    const comp = cardComponents.get(shape);
    if (comp) {
      const inst = track(comp.createInstance());
      row.appendChild(inst);
      if (shape !== "text") setInstanceText(inst, "Card title", card.title);
      if (shape !== "title") setInstanceText(inst, "Card text", card.text);
      instances++;
    } else {
      const n = track(figma.createFrame());
      row.appendChild(n);
      n.name = "Card";
      fillCard(n, shape, card);
    }
  }
  return instances;
}
