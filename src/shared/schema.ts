// Versioned output format ("website-to-figma/site-map", schemaVersion 1) and a
// dependency-free strict validator. The same validator runs in the CLI before
// writing and in the Figma plugin sandbox before any node is created.
import { LIMITS } from "./limits";

export const SCHEMA_ID = "website-to-figma/site-map";
export const SCHEMA_VERSION = 1;

export type Block =
  | { type: "heading"; level: 1 | 2 | 3; text: string }
  | { type: "text"; text: string }
  | { type: "cards"; cards: Card[] };

export interface Card {
  title: string;
  text: string;
}

export interface NavBlock {
  items: string[];
}

export interface FooterBlock {
  items: string[];
  text: string;
}

export interface Page {
  id: string;
  url: string;
  path: string;
  title: string;
  parentId: string | null;
  depth: number;
  nav: NavBlock | null;
  footer: FooterBlock | null;
  blocks: Block[];
}

export type Source =
  | { mode: "fixture"; fixtureId: string; label: string }
  | { mode: "firecrawl"; startUrl: string };

export interface CrawlSummary {
  requestedLimit: number;
  hardCap: number;
  // Unique same-site URLs seen during discovery, or null if unknown.
  discoveredCount: number | null;
  returnedCount: number;
  // More same-site pages existed than were returned (cap reached).
  truncated: boolean;
  // Discovery or scraping did not finish cleanly (timeout, errors, drops).
  incomplete: boolean;
  notes: string[];
}

export interface SiteMapDoc {
  schema: typeof SCHEMA_ID;
  schemaVersion: typeof SCHEMA_VERSION;
  generator: { name: "website-to-figma"; version: string };
  source: Source;
  site: { origin: string; host: string };
  crawl: CrawlSummary;
  pages: Page[];
}

export type ValidationResult = { ok: true; doc: SiteMapDoc } | { ok: false; errors: string[] };

class Checker {
  errors: string[] = [];
  fail(path: string, msg: string): void {
    if (this.errors.length < 50) this.errors.push(`${path}: ${msg}`);
  }
  obj(v: unknown, path: string, keys: readonly string[]): v is Record<string, unknown> {
    if (typeof v !== "object" || v === null || Array.isArray(v)) {
      this.fail(path, "expected object");
      return false;
    }
    for (const k of Object.keys(v)) {
      if (!keys.includes(k)) this.fail(path, `unknown key "${k}"`);
    }
    for (const k of keys) {
      // Own properties only: never satisfied via the prototype chain.
      if (!Object.prototype.hasOwnProperty.call(v, k)) this.fail(path, `missing key "${k}"`);
    }
    return true;
  }
  str(v: unknown, path: string, max: number, allowEmpty = true): v is string {
    if (typeof v !== "string") {
      this.fail(path, "expected string");
      return false;
    }
    if (v.length > max) this.fail(path, `longer than ${max} chars`);
    if (!allowEmpty && v.length === 0) this.fail(path, "must not be empty");
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(v)) this.fail(path, "contains control characters");
    return true;
  }
  int(v: unknown, path: string, min: number, max: number): v is number {
    if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
      this.fail(path, `expected integer ${min}..${max}`);
      return false;
    }
    return true;
  }
  bool(v: unknown, path: string): v is boolean {
    if (typeof v !== "boolean") {
      this.fail(path, "expected boolean");
      return false;
    }
    return true;
  }
  arr(v: unknown, path: string, max: number): v is unknown[] {
    if (!Array.isArray(v)) {
      this.fail(path, "expected array");
      return false;
    }
    if (v.length > max) this.fail(path, `more than ${max} items`);
    return true;
  }
  httpUrl(v: unknown, path: string): void {
    if (!this.str(v, path, LIMITS.maxUrlChars, false)) return;
    if (!/^https?:\/\/[^\s/@]+(\/[^\s]*)?$/i.test(v)) this.fail(path, "expected http(s) URL without credentials");
  }
}

function checkLabels(c: Checker, v: unknown, path: string, maxItems: number): void {
  if (!c.arr(v, path, maxItems)) return;
  v.forEach((item, i) => c.str(item, `${path}[${i}]`, LIMITS.maxLabelChars, false));
}

function checkBlock(c: Checker, b: unknown, path: string): void {
  if (typeof b !== "object" || b === null || Array.isArray(b)) {
    c.fail(path, "expected object");
    return;
  }
  const type = (b as { type?: unknown }).type;
  if (type === "heading") {
    if (!c.obj(b, path, ["type", "level", "text"])) return;
    c.int(b.level, `${path}.level`, 1, 3);
    c.str(b.text, `${path}.text`, LIMITS.maxHeadingChars, false);
  } else if (type === "text") {
    if (!c.obj(b, path, ["type", "text"])) return;
    c.str(b.text, `${path}.text`, LIMITS.maxTextChars, false);
  } else if (type === "cards") {
    if (!c.obj(b, path, ["type", "cards"])) return;
    if (!c.arr(b.cards, `${path}.cards`, LIMITS.maxCardsPerBlock)) return;
    if (b.cards.length === 0) c.fail(`${path}.cards`, "must not be empty");
    b.cards.forEach((card, i) => {
      const p = `${path}.cards[${i}]`;
      if (!c.obj(card, p, ["title", "text"])) return;
      c.str(card.title, `${p}.title`, LIMITS.maxHeadingChars);
      c.str(card.text, `${p}.text`, LIMITS.maxTextChars);
    });
  } else {
    c.fail(`${path}.type`, "expected heading | text | cards");
  }
}

export function validateSiteMap(input: unknown): ValidationResult {
  const c = new Checker();
  const top = [
    "schema",
    "schemaVersion",
    "generator",
    "source",
    "site",
    "crawl",
    "pages",
  ] as const;
  if (!c.obj(input, "$", top)) return { ok: false, errors: c.errors };
  const d = input;
  if (d.schema !== SCHEMA_ID) c.fail("$.schema", `expected "${SCHEMA_ID}"`);
  if (d.schemaVersion !== SCHEMA_VERSION) c.fail("$.schemaVersion", `unsupported version (expected ${SCHEMA_VERSION})`);

  if (c.obj(d.generator, "$.generator", ["name", "version"])) {
    if (d.generator.name !== "website-to-figma") c.fail("$.generator.name", 'expected "website-to-figma"');
    c.str(d.generator.version, "$.generator.version", 32, false);
  }

  const src = d.source as Record<string, unknown> | null;
  if (typeof src === "object" && src !== null && src.mode === "fixture") {
    if (c.obj(src, "$.source", ["mode", "fixtureId", "label"])) {
      c.str(src.fixtureId, "$.source.fixtureId", 40, false);
      c.str(src.label, "$.source.label", 120, false);
    }
  } else if (typeof src === "object" && src !== null && src.mode === "firecrawl") {
    if (c.obj(src, "$.source", ["mode", "startUrl"])) c.httpUrl(src.startUrl, "$.source.startUrl");
  } else {
    c.fail("$.source.mode", 'expected "fixture" | "firecrawl"');
  }

  if (c.obj(d.site, "$.site", ["origin", "host"])) {
    c.httpUrl(d.site.origin, "$.site.origin");
    c.str(d.site.host, "$.site.host", 253, false);
  }

  if (c.obj(d.crawl, "$.crawl", [
    "requestedLimit",
    "hardCap",
    "discoveredCount",
    "returnedCount",
    "truncated",
    "incomplete",
    "notes",
  ])) {
    const k = d.crawl;
    c.int(k.requestedLimit, "$.crawl.requestedLimit", 1, LIMITS.hardMaxPages);
    if (k.hardCap !== LIMITS.hardMaxPages) c.fail("$.crawl.hardCap", `expected ${LIMITS.hardMaxPages}`);
    if (k.discoveredCount !== null) c.int(k.discoveredCount, "$.crawl.discoveredCount", 0, 1_000_000);
    c.int(k.returnedCount, "$.crawl.returnedCount", 0, LIMITS.hardMaxPages);
    c.bool(k.truncated, "$.crawl.truncated");
    c.bool(k.incomplete, "$.crawl.incomplete");
    if (c.arr(k.notes, "$.crawl.notes", LIMITS.maxNotes)) {
      k.notes.forEach((n, i) => c.str(n, `$.crawl.notes[${i}]`, LIMITS.maxNoteChars, false));
    }
  }

  if (c.arr(d.pages, "$.pages", LIMITS.hardMaxPages)) {
    if (d.pages.length === 0) c.fail("$.pages", "must contain at least one page");
    const ids = new Set<string>();
    const urls = new Set<string>();
    d.pages.forEach((p, i) => {
      const path = `$.pages[${i}]`;
      if (!c.obj(p, path, ["id", "url", "path", "title", "parentId", "depth", "nav", "footer", "blocks"])) return;
      if (c.str(p.id, `${path}.id`, 16, false)) {
        if (!/^p[0-9]{1,2}$/.test(p.id)) c.fail(`${path}.id`, 'expected "p<index>"');
        if (ids.has(p.id)) c.fail(`${path}.id`, "duplicate id");
        ids.add(p.id);
      }
      c.httpUrl(p.url, `${path}.url`);
      if (typeof p.url === "string") {
        if (urls.has(p.url)) c.fail(`${path}.url`, "duplicate url");
        urls.add(p.url);
      }
      if (c.str(p.path, `${path}.path`, LIMITS.maxUrlChars, false) && !p.path.startsWith("/")) {
        c.fail(`${path}.path`, 'must start with "/"');
      }
      c.str(p.title, `${path}.title`, LIMITS.maxTitleChars, false);
      if (p.parentId !== null) c.str(p.parentId, `${path}.parentId`, 16, false);
      c.int(p.depth, `${path}.depth`, 0, LIMITS.maxDepth);
      if (p.nav !== null && c.obj(p.nav, `${path}.nav`, ["items"])) {
        checkLabels(c, p.nav.items, `${path}.nav.items`, LIMITS.maxNavItems);
      }
      if (p.footer !== null && c.obj(p.footer, `${path}.footer`, ["items", "text"])) {
        checkLabels(c, p.footer.items, `${path}.footer.items`, LIMITS.maxFooterItems);
        c.str(p.footer.text, `${path}.footer.text`, LIMITS.maxTextChars);
      }
      if (c.arr(p.blocks, `${path}.blocks`, LIMITS.maxBlocksPerPage)) {
        p.blocks.forEach((b, j) => checkBlock(c, b, `${path}.blocks[${j}]`));
      }
    });

    // Tree integrity: exactly one root, parents exist and precede children,
    // depth = parent depth + 1. Pages are ordered so this also rules out cycles.
    if (c.errors.length === 0) {
      const pages = d.pages as Page[];
      const index = new Map(pages.map((p, i) => [p.id, i]));
      const roots = pages.filter((p) => p.parentId === null);
      if (roots.length !== 1 || pages[0]?.parentId !== null) c.fail("$.pages", "expected exactly one root page, first");
      pages.forEach((p, i) => {
        if (p.parentId === null) {
          if (p.depth !== 0) c.fail(`$.pages[${i}].depth`, "root depth must be 0");
          return;
        }
        const pi = index.get(p.parentId);
        if (pi === undefined || pi >= i) {
          c.fail(`$.pages[${i}].parentId`, "parent must be an earlier page");
          return;
        }
        if (p.depth !== pages[pi]!.depth + 1) c.fail(`$.pages[${i}].depth`, "must equal parent depth + 1");
      });
      let blocks = 0;
      let cards = 0;
      for (const p of pages) {
        blocks += p.blocks.length;
        for (const b of p.blocks) if (b.type === "cards") cards += b.cards.length;
      }
      if (blocks > LIMITS.maxTotalBlocks) c.fail("$.pages", `more than ${LIMITS.maxTotalBlocks} blocks in total`);
      if (cards > LIMITS.maxTotalCards) c.fail("$.pages", `more than ${LIMITS.maxTotalCards} cards in total`);
      const k = d.crawl as CrawlSummary;
      if (k.returnedCount !== pages.length) c.fail("$.crawl.returnedCount", "must equal pages.length");
      if (pages.length > k.requestedLimit) c.fail("$.pages", "more pages than requestedLimit");
    }
  }

  return c.errors.length === 0 ? { ok: true, doc: input as unknown as SiteMapDoc } : { ok: false, errors: c.errors };
}

// Parse untrusted JSON text with a byte bound before validating.
export function parseSiteMapJson(text: string): ValidationResult {
  if (typeof text !== "string") return { ok: false, errors: ["$: expected JSON text"] };
  // UTF-16 length never exceeds UTF-8 byte length, so check it first (cheap).
  if (text.length > LIMITS.maxJsonBytes || utf8Length(text) > LIMITS.maxJsonBytes) {
    return { ok: false, errors: [`$: larger than ${LIMITS.maxJsonBytes} bytes`] };
  }
  if (exceedsNesting(text, MAX_JSON_NESTING)) {
    return { ok: false, errors: [`$: nested deeper than ${MAX_JSON_NESTING} levels`] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, errors: ["$: not valid JSON"] };
  }
  return validateSiteMap(parsed);
}

// The schema nests at most 7 levels ($ > pages > page > blocks > block > cards > card).
export const MAX_JSON_NESTING = 12;

// Linear pre-parse scan of bracket depth outside strings, so pathological
// nesting is rejected before JSON.parse runs. No $ref/anchors exist in the
// format; JSON.parse output is a tree, so there are no cycles to follow.
export function exceedsNesting(text: string, max: number): boolean {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (c === 92 /* \\ */) i++;
      else if (c === 34 /* " */) inString = false;
    } else if (c === 34) inString = true;
    else if (c === 123 /* { */ || c === 91 /* [ */) {
      if (++depth > max) return true;
    } else if (c === 125 /* } */ || c === 93 /* ] */) depth--;
  }
  return false;
}

export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 0x80) n += 1;
    else if (code < 0x800) n += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}
