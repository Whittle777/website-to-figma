// Generic, evidence-gated corrections applied to a measured capture before
// node conversion. Each correction is driven by observed data (measured boxes,
// the reference screenshot's own pixel size, the page's saved rawHtml) and is
// recorded as a page note; nothing site-specific is encoded here.
import { parse, HTMLElement, NodeType, type Node } from "node-html-parser";
import { LIMITS } from "../shared/limits";
import { cleanText } from "../shared/text";
import { tagLimitIndex } from "../normalize/extract";

type Obj = Record<string, unknown>;
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
const r3 = (n: number) => Math.round(n * 1000) / 1000;

// ---------------------------------------------------------------- G1 width
// Reconcile a capture measured at viewport width M with a reference screenshot
// T px wide (T < M). Evidence: T is the reference image's own pixel width. The
// mapping assumes the page centers fixed-width content (checked: anything that
// would fall outside the target band is counted and reported) and a device
// pixel ratio of 1.
export interface WidthMap {
  measured: number;
  target: number;
  offset: number;
  apply(b: Box): Box;
  counts: { fullBleed: number; marginAnchored: number; shifted: number; outside: number };
}

export function widthMap(measured: number, target: number): WidthMap {
  const off = (measured - target) / 2;
  const counts = { fullBleed: 0, marginAnchored: 0, shifted: 0, outside: 0 };
  return {
    measured,
    target,
    offset: off,
    counts,
    apply(b) {
      if (b.x <= 0.5 && b.x + b.w >= measured - 0.5) {
        counts.fullBleed++;
        return { ...b, x: 0, w: target };
      }
      if (b.x < off - 0.5 && b.x + b.w > off + target + 0.5) {
        counts.marginAnchored++;
        return { ...b, w: r3(b.w - (measured - target)) };
      }
      counts.shifted++;
      if (b.x < off - 0.5 || b.x + b.w > off + target + 0.5) counts.outside++;
      return { ...b, x: r3(b.x - off) };
    },
  };
}

// ---------------------------------------------------------------- G4 unicode
const HIGH = /[\ud800-\udbff]$/;
const LOW = /^[\udc00-\udfff]/;
const JOINER_ONLY = /^[\uFE0E\uFE0F\u200D\u20E3\u{1F3FB}-\u{1F3FF}]+$/u;
const LONE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

// Rejoin text fragments that a code-unit-based capture split inside a
// surrogate pair (or that left a bare variation selector / ZWJ / skin-tone
// modifier as its own run). Only adjacent fragments of the same parent on the
// same line are merged; leftovers that cannot be paired are removed and counted.
export function rejoinFragments(texts: Obj[]): { texts: Obj[]; repaired: number; removed: number } {
  const out: Obj[] = [];
  let repaired = 0;
  let removed = 0;
  for (const t of texts) {
    const prev = out[out.length - 1];
    const s = typeof t.text === "string" ? t.text : "";
    if (prev && typeof prev.text === "string" && prev.parent === t.parent && Math.abs(Number(prev.y) - Number(t.y)) < 1) {
      const p = prev.text;
      if ((HIGH.test(p) && LOW.test(s)) || JOINER_ONLY.test(s)) {
        const right = Math.max(Number(prev.x) + Number(prev.w), Number(t.x) + Number(t.w));
        prev.text = p + s;
        prev.w = r3(right - Number(prev.x));
        prev.h = Math.max(Number(prev.h), Number(t.h));
        repaired++;
        continue;
      }
    }
    out.push({ ...t });
  }
  for (const t of out) {
    if (typeof t.text !== "string") continue;
    const cleaned = t.text.replace(LONE, () => {
      removed++;
      return "";
    });
    t.text = cleaned;
  }
  return { texts: out.filter((t) => typeof t.text !== "string" || t.text.trim() !== ""), repaired, removed };
}

// ---------------------------------------------------------------- G2 overflow
const CONTAINER_TAGS = new Set(["pre", "figure", "div", "section", "article", "aside", "main", "blockquote", "details", "form", "fieldset"]);

export interface Container extends Box {
  tag: string;
  id: string;
}

const inside = (n: Box, c: Box) => n.x >= c.x - 0.5 && n.x < c.x + c.w && n.y >= c.y - 0.1 && n.y + n.h <= c.y + c.h + 0.1;

// Ancestor element ids of a captured item: from the saved rawHtml when present
// (observed DOM relationship); null when unknown (geometry fallback is used).
export function chainOf(o: Obj, facts: HtmlFacts | null): string[] | null {
  if (!facts) return null;
  const own = typeof o.id === "string" ? o.id : null;
  const parent = typeof o.parent === "string" ? o.parent : null;
  if (own && facts.ancestors.has(own)) return facts.ancestors.get(own)!;
  if (parent && facts.ancestors.has(parent)) return [...facts.ancestors.get(parent)!, parent];
  return null;
}

// Innermost container (index) that is an observed ancestor, else geometric.
export function memberOf(o: Obj, b: Box, containers: Container[], facts: HtmlFacts | null): number {
  const chain = chainOf(o, facts);
  if (chain) {
    for (let k = chain.length - 1; k >= 0; k--) {
      const i = containers.findIndex((c) => c.id === chain[k]);
      if (i >= 0) return i;
    }
    return -1;
  }
  return innermost(b, containers);
}

// Containers whose own content runs past their right edge. Each item is
// attributed to its innermost container: by observed DOM ancestry (rawHtml)
// when known for that item, else by geometric containment.
export function overflowContainers(elements: Obj[], items: Obj[], facts: HtmlFacts | null = null): Container[] {
  const cands = elements
    .filter((e) => CONTAINER_TAGS.has(String(e.tag)))
    .map((e) => ({ tag: String(e.tag), id: String(e.id ?? ""), x: Number(e.x), y: Number(e.y), w: Number(e.w), h: Number(e.h) }))
    .filter((c) => c.w > 0 && c.h > 0);
  const overflowing = new Set<Container>();
  for (const o of [...elements, ...items]) {
    const n = { x: Number(o.x), y: Number(o.y), w: Number(o.w), h: Number(o.h) };
    if (!Number.isFinite(n.x + n.y + n.w + n.h)) continue;
    let best: Container | null = null;
    const chain = chainOf(o, facts);
    if (chain) {
      for (let k = chain.length - 1; k >= 0 && !best; k--) best = cands.find((c) => c.id !== "" && c.id === chain[k]) ?? null;
    } else {
      for (const c of cands) {
        if (typeof o.id === "string" && o.id === c.id) continue;
        if (c.x === n.x && c.y === n.y && c.w === n.w && c.h === n.h) continue;
        if (!inside(n, c)) continue;
        if (!best || c.w * c.h < best.w * best.h) best = c;
      }
    }
    if (best && n.x + n.w > best.x + best.w + 0.5) overflowing.add(best);
  }
  return [...overflowing].sort((a, b) => a.y - b.y);
}

export function innermost(b: Box, containers: Container[]): number {
  let best = -1;
  containers.forEach((c, i) => {
    if (c.x === b.x && c.y === b.y && c.w === b.w && c.h === b.h) return;
    if (inside(b, c) && (best < 0 || c.w * c.h < containers[best]!.w * containers[best]!.h)) best = i;
  });
  return best;
}

// Hidden horizontal-scrollbar normalization. Evidence: the measured page is
// taller than the reference screenshot by delta, and delta / N (N overflowing
// containers) is a plausible scrollbar thickness. Then each overflowing
// container loses k px and everything below it moves up cumulatively.
export interface GutterFix {
  k: number;
  apply(b: Box): Box;
  containerHeight(c: Container): number;
}
export function gutterFix(containers: Container[], measuredHeight: number, referenceHeight: number | null): { fix: GutterFix | null; note: string | null } {
  if (containers.length === 0) return { fix: null, note: null };
  if (referenceHeight === null) {
    return { fix: null, note: `${containers.length} horizontally overflowing container(s) detected; no reference height to confirm hidden scrollbars, heights kept as measured` };
  }
  const delta = measuredHeight - referenceHeight;
  if (Math.abs(delta) < 1) return { fix: null, note: null }; // reference matches: nothing hidden to remove
  const k = delta / containers.length;
  if (!(k >= 5 && k <= 25)) {
    return { fix: null, note: `${containers.length} overflowing container(s); measured-vs-reference height delta ${r3(delta)}px is not consistent with hidden scrollbars, heights kept as measured` };
  }
  const bottoms = containers.map((c) => c.y + c.h);
  const shift = (y: number) => bottoms.filter((b) => b <= y + 0.1).length * k;
  return {
    fix: {
      k: r3(k),
      apply: (b) => ({ ...b, y: r3(b.y - shift(b.y)) }),
      containerHeight: (c) => r3(c.h - k),
    },
    note: `Removed ${containers.length} hidden horizontal-scrollbar gutter(s) of ${r3(k)}px (measured height ${r3(measuredHeight)}px vs reference ${referenceHeight}px); content below each moved up`,
  };
}

// ---------------------------------------------------------------- G3/G5 rawHtml facts
export interface HtmlFacts {
  li: Map<string, { marker: string; inNav: boolean }>;
  option: Map<string, string>;
  multiple: Set<string>;
  // element id -> ids of its ancestors that carry a data-w2f-id (nearest last)
  ancestors: Map<string, string[]>;
}

export function htmlFacts(raw: unknown): HtmlFacts | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  let html = raw.slice(0, LIMITS.maxHtmlChars);
  const cut = tagLimitIndex(html, LIMITS.maxHtmlTags);
  if (cut !== -1) html = html.slice(0, cut);
  const root = parse(html, { comment: false, blockTextElements: { script: false, noscript: false, style: false, pre: true } });
  const facts: HtmlFacts = { li: new Map(), option: new Map(), multiple: new Set(), ancestors: new Map() };
  let budget = LIMITS.maxHtmlNodes;
  const walk = (n: Node, depth: number, lists: HTMLElement[], inNav: boolean, chain: string[]) => {
    if (n.nodeType !== NodeType.ELEMENT_NODE || depth > LIMITS.maxHtmlDepth || --budget < 0) return;
    const el = n as HTMLElement;
    const tag = el.tagName;
    const id = el.getAttribute("data-w2f-id") ?? "";
    const nav = inNav || tag === "NAV" || tag === "MENU";
    if (id && /^[A-Za-z0-9_-]{1,20}$/.test(id)) facts.ancestors.set(id, chain);
    if (tag === "LI" && id && lists.length) {
      const list = lists[lists.length - 1]!;
      let marker: string;
      if (list.tagName === "OL") {
        const items = list.childNodes.filter((c): c is HTMLElement => c.nodeType === NodeType.ELEMENT_NODE && (c as HTMLElement).tagName === "LI");
        const start = Number(list.getAttribute("start") ?? "1");
        const ordinal = (Number.isFinite(start) ? start : 1) + items.indexOf(el);
        const explicit = Number(el.getAttribute("value"));
        marker = `${Number.isFinite(explicit) && el.getAttribute("value") !== undefined ? explicit : ordinal}.`;
      } else {
        const level = lists.filter((l) => l.tagName === "UL").length;
        marker = level <= 1 ? "•" : level === 2 ? "◦" : "▪";
      }
      facts.li.set(id, { marker, inNav: nav });
    }
    if (tag === "OPTION" && id) facts.option.set(id, cleanText(el.text, 200));
    if (tag === "SELECT" && id && el.getAttribute("multiple") !== undefined) facts.multiple.add(id);
    const nextLists = tag === "UL" || tag === "OL" ? [...lists, el] : lists;
    const nextChain = id && /^[A-Za-z0-9_-]{1,20}$/.test(id) ? [...chain, id] : chain;
    for (const c of el.childNodes) walk(c, depth + 1, nextLists, nav, nextChain);
  };
  walk(root, 0, [], false, []);
  return facts;
}

// ---------------------------------------------------------------- G9 sitemap
export function parentByPath(paths: string[]): (string | null)[] {
  const seg = (p: string) => new URL(p, "https://x.invalid").pathname.split("/").filter(Boolean);
  return paths.map((p, i) => {
    const mine = seg(p);
    let best = -1;
    let bestLen = -1;
    paths.forEach((q, j) => {
      if (j === i) return;
      const s = seg(q);
      if (s.length < mine.length && s.every((x, k) => x === mine[k]) && s.length > bestLen) {
        best = j;
        bestLen = s.length;
      }
    });
    return best >= 0 ? `p${best}` : null;
  });
}
