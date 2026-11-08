// Extract a low-fidelity structure (nav, footer, headings, text, card groups)
// from page HTML. HTML is parsed as inert data: nothing is executed, no
// resources are fetched, and only bounded plain text is kept.
import { parse, HTMLElement, NodeType, type Node } from "node-html-parser";
import { LIMITS } from "../shared/limits";
import { cleanText } from "../shared/text";
import type { Block, Card, FooterBlock, NavBlock } from "../shared/schema";

export interface ExtractedPage {
  title: string;
  nav: NavBlock | null;
  footer: FooterBlock | null;
  blocks: Block[];
  // Bounds hit while extracting (reported in crawl notes).
  truncated: boolean;
}

const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "IFRAME", "CANVAS", "OBJECT", "EMBED", "HEAD", "BUTTON", "FORM", "SELECT"]);
const MAX_TEXT_BLOCKS = 12;

interface Budget {
  nodes: number;
  hit: boolean;
}

function isElement(n: Node): n is HTMLElement {
  return n.nodeType === NodeType.ELEMENT_NODE;
}

function role(el: HTMLElement): string {
  return (el.getAttribute("role") ?? "").toLowerCase();
}

function isCard(el: HTMLElement): boolean {
  if (el.tagName === "ARTICLE") return true;
  const cls = (el.getAttribute("class") ?? "").toLowerCase().split(/\s+/);
  return cls.some((c) => c === "card" || /^card[-_]/.test(c) || /[-_]card$/.test(c));
}

// Bounded plain-text extraction (decoded entities, no markup).
function textOf(el: Node, max: number, budget: Budget, skipLinks = false, depth = 0): string {
  const parts: string[] = [];
  let len = 0;
  const walk = (n: Node, d: number) => {
    if (len > max * 2 || d > LIMITS.maxHtmlDepth) return;
    if (--budget.nodes < 0) {
      budget.hit = true;
      return;
    }
    if (n.nodeType === NodeType.TEXT_NODE) {
      const t = n.text;
      parts.push(t);
      len += t.length;
      return;
    }
    if (!isElement(n) || SKIP_TAGS.has(n.tagName)) return;
    if (skipLinks && n.tagName === "A") return;
    for (const c of n.childNodes) walk(c, d + 1);
  };
  walk(el, depth);
  return cleanText(parts.join(" "), max);
}

function linkLabels(el: HTMLElement, maxItems: number, budget: Budget): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (n: Node, d: number) => {
    if (out.length >= maxItems || d > LIMITS.maxHtmlDepth || !isElement(n) || SKIP_TAGS.has(n.tagName)) return;
    if (--budget.nodes < 0) {
      budget.hit = true;
      return;
    }
    if (n.tagName === "A") {
      const label = textOf(n, LIMITS.maxLabelChars, budget) || cleanText(n.getAttribute("aria-label") ?? "", LIMITS.maxLabelChars);
      if (label && !seen.has(label.toLowerCase())) {
        seen.add(label.toLowerCase());
        out.push(label);
      }
      return;
    }
    for (const c of n.childNodes) walk(c, d + 1);
  };
  walk(el, 0);
  return out;
}

function cardOf(el: HTMLElement, budget: Budget): Card {
  let title = "";
  let text = "";
  const walk = (n: Node, d: number) => {
    if ((title && text) || d > LIMITS.maxHtmlDepth || !isElement(n) || SKIP_TAGS.has(n.tagName)) return;
    if (--budget.nodes < 0) {
      budget.hit = true;
      return;
    }
    if (!title && /^H[2-6]$/.test(n.tagName)) {
      title = textOf(n, LIMITS.maxHeadingChars, budget);
      return;
    }
    if (!text && n.tagName === "P") {
      text = textOf(n, LIMITS.maxTextChars, budget);
      return;
    }
    for (const c of n.childNodes) walk(c, d + 1);
  };
  walk(el, 0);
  if (!title && !text) text = textOf(el, LIMITS.maxTextChars, budget);
  return { title, text };
}

// Index of the first opening tag beyond `max`, or -1. Linear scan run before
// the parser ever sees the input.
export function tagLimitIndex(html: string, max: number): number {
  let count = 0;
  for (let i = html.indexOf("<"); i !== -1 && i < html.length - 1; i = html.indexOf("<", i + 1)) {
    const c = html.charCodeAt(i + 1);
    const isLetter = (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
    if (isLetter && ++count > max) return i;
  }
  return -1;
}

export function extractPage(rawHtml: string, metadataTitle: string | undefined, fallbackTitle: string): ExtractedPage {
  let truncated = false;
  let html = rawHtml;
  if (html.length > LIMITS.maxHtmlChars) {
    html = html.slice(0, LIMITS.maxHtmlChars);
    truncated = true;
  }
  const cut = tagLimitIndex(html, LIMITS.maxHtmlTags);
  if (cut !== -1) {
    html = html.slice(0, cut);
    truncated = true;
  }
  const root = parse(html, {
    comment: false,
    blockTextElements: { script: false, noscript: false, style: false, pre: true },
  });
  const budget: Budget = { nodes: LIMITS.maxHtmlNodes, hit: false };

  let docTitle = "";
  let nav: NavBlock | null = null;
  let footer: FooterBlock | null = null;
  let firstH1 = "";
  const blocks: Block[] = [];
  let textBlocks = 0;
  const handledCardParents = new Set<HTMLElement>();

  const push = (b: Block) => {
    if (blocks.length < LIMITS.maxBlocksPerPage) blocks.push(b);
    else truncated = true;
  };

  const walk = (n: Node, d: number) => {
    if (!isElement(n)) return;
    if (d > LIMITS.maxHtmlDepth) {
      truncated = true;
      return;
    }
    if (--budget.nodes < 0) {
      budget.hit = true;
      return;
    }
    const tag = n.tagName;
    if (tag === "HEAD") {
      // Only <title> is read from <head>; everything else there is ignored.
      const t = n.childNodes.find((c): c is HTMLElement => isElement(c) && c.tagName === "TITLE");
      if (t && !docTitle) docTitle = textOf(t, LIMITS.maxTitleChars, budget);
      return;
    }
    if (tag === "TITLE") {
      if (!docTitle) docTitle = textOf(n, LIMITS.maxTitleChars, budget);
      return;
    }
    if (SKIP_TAGS.has(tag)) return;

    if (tag === "NAV" || role(n) === "navigation") {
      if (!nav) {
        const items = linkLabels(n, LIMITS.maxNavItems, budget);
        if (items.length > 0) nav = { items };
      }
      return;
    }
    if (tag === "FOOTER" || role(n) === "contentinfo") {
      if (!footer) {
        footer = {
          items: linkLabels(n, LIMITS.maxFooterItems, budget),
          text: textOf(n, 140, budget, true),
        };
      }
      return;
    }
    if (isCard(n)) {
      const parent = n.parentNode;
      if (parent && !handledCardParents.has(parent)) {
        handledCardParents.add(parent);
        const cards = parent.childNodes
          .filter((c): c is HTMLElement => isElement(c) && isCard(c))
          .slice(0, LIMITS.maxCardsPerBlock)
          .map((c) => cardOf(c, budget))
          .filter((c) => c.title || c.text);
        if (cards.length > 0) push({ type: "cards", cards });
      }
      return;
    }
    const h = /^H([1-3])$/.exec(tag);
    if (h) {
      const text = textOf(n, LIMITS.maxHeadingChars, budget);
      if (text) {
        if (h[1] === "1" && !firstH1) firstH1 = text;
        push({ type: "heading", level: Number(h[1]) as 1 | 2 | 3, text });
      }
      return;
    }
    if (tag === "P") {
      const text = textOf(n, LIMITS.maxTextChars, budget);
      if (text && textBlocks < MAX_TEXT_BLOCKS) {
        textBlocks++;
        push({ type: "text", text });
      }
      return;
    }
    for (const c of n.childNodes) walk(c, d + 1);
  };
  walk(root, 0);

  const title =
    cleanText(metadataTitle ?? "", LIMITS.maxTitleChars) || docTitle || firstH1 || cleanText(fallbackTitle, LIMITS.maxTitleChars) || "Untitled";
  return { title, nav, footer, blocks, truncated: truncated || budget.hit };
}
