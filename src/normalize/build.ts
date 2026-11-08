// Turn a list of fetched pages (fixture or Firecrawl) into a validated
// SiteMapDoc: same-site filter, canonicalize, dedupe, deterministic order,
// truthful cap, path-based sitemap tree, structure extraction.
import { LIMITS } from "../shared/limits";
import { cleanText } from "../shared/text";
import { SCHEMA_ID, SCHEMA_VERSION, validateSiteMap, type Block, type Page, type SiteMapDoc, type Source } from "../shared/schema";
import { canonicalizeUrl, displayPath } from "./canonicalize";
import { extractPage } from "./extract";
import { isSameSite, siteKey } from "../security/urlGuard";

export const GENERATOR_VERSION = "0.1.0";

export interface RawPage {
  // Final URL of the fetched page (after any redirects), already checked by the caller.
  url: string;
  html: string;
  metadataTitle?: string;
}

export interface BuildInput {
  source: Source;
  startUrl: string;
  limit: number;
  pages: RawPage[];
  // Unique same-site URLs seen by discovery (map), or null if unknown.
  discoveredCount: number | null;
  incomplete: boolean;
  notes: string[];
  // Treat "/a?x=1" and "/a" as one page (matches Firecrawl's
  // ignoreQueryParameters). Default false keeps fixture behaviour unchanged.
  ignoreQueryVariants?: boolean;
}

export class Notes {
  private items: string[] = [];
  add(note: string): void {
    const n = cleanText(note, LIMITS.maxNoteChars);
    if (n && !this.items.includes(n) && this.items.length < LIMITS.maxNotes) this.items.push(n);
  }
  list(): string[] {
    return [...this.items];
  }
}

export function assertLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError("--limit must be a positive integer");
  if (limit > LIMITS.hardMaxPages) {
    throw new RangeError(`--limit ${limit} exceeds the hard cap of ${LIMITS.hardMaxPages} pages (not silently reduced)`);
  }
  return limit;
}

interface Candidate {
  canonical: string;
  key: string;
  segments: string[];
  hasQuery: boolean;
  raw: RawPage;
}

function dedupeKey(canonical: string, ignoreQuery = false): string {
  const u = new URL(canonical);
  return siteKey(u.hostname) + u.pathname + (ignoreQuery ? "" : u.search);
}

function segmentsOf(canonical: string): string[] {
  return new URL(canonical).pathname.split("/").filter(Boolean);
}

function isPrefix(prefix: string[], of: string[]): boolean {
  return prefix.length <= of.length && prefix.every((s, i) => s === of[i]);
}

export function buildSiteMap(input: BuildInput): SiteMapDoc {
  const limit = assertLimit(input.limit);
  const notes = new Notes();
  input.notes.forEach((n) => notes.add(n));
  let incomplete = input.incomplete;

  const start = new URL(canonicalizeUrl(input.startUrl));
  const byKey = new Map<string, Candidate>();
  let offSite = 0;
  let duplicates = 0;
  for (const raw of input.pages) {
    let canonical: string;
    try {
      canonical = canonicalizeUrl(raw.url);
    } catch {
      offSite++;
      continue;
    }
    const u = new URL(canonical);
    if ((u.protocol !== "http:" && u.protocol !== "https:") || !isSameSite(u, start)) {
      offSite++;
      continue;
    }
    const ignoreQuery = input.ignoreQueryVariants === true;
    const key = dedupeKey(canonical, ignoreQuery);
    const existing = byKey.get(key);
    if (existing) {
      duplicates++;
      if (ignoreQuery && existing.hasQuery && u.search === "") {
        // Prefer the query-less variant of a path.
        existing.canonical = canonical;
        existing.hasQuery = false;
        existing.raw = raw;
      } else if (existing.canonical.startsWith("http:") && canonical.startsWith("https:")) {
        // Prefer the https variant deterministically.
        existing.canonical = canonical;
      }
      continue;
    }
    byKey.set(key, { canonical, key, segments: segmentsOf(canonical), hasQuery: u.search !== "", raw });
  }
  if (offSite > 0) {
    notes.add(`${offSite} page(s) dropped: final URL not on the start site`);
    incomplete = true;
  }
  if (duplicates > 0) notes.add(`${duplicates} duplicate URL(s) merged after canonicalization`);

  const startKey = dedupeKey(start.toString(), input.ignoreQueryVariants === true);
  const sorted = [...byKey.values()].sort((a, b) => {
    if (a.key === startKey) return -1;
    if (b.key === startKey) return 1;
    if (a.segments.length !== b.segments.length) return a.segments.length - b.segments.length;
    if (a.hasQuery !== b.hasQuery) return a.hasQuery ? 1 : -1;
    return a.canonical < b.canonical ? -1 : a.canonical > b.canonical ? 1 : 0;
  });
  if (sorted.length === 0) throw new Error("No usable same-site pages to build a site map from");
  if (sorted[0]!.key !== startKey) {
    notes.add("Start URL itself was not returned; shallowest page used as root");
    incomplete = true;
  }

  const unique = sorted.length;
  const kept = sorted.slice(0, limit);
  const discovered = input.discoveredCount === null ? null : Math.max(input.discoveredCount, unique);
  const truncated = unique > limit || (discovered !== null && discovered > kept.length);
  if (truncated) {
    notes.add(
      `Cap reached: returned ${kept.length} of ${discovered ?? unique}${discovered === null ? "+" : ""} known same-site pages (limit ${limit}, hard cap ${LIMITS.hardMaxPages})`,
    );
  }

  // Underfill: the crawler spent its page budget on URLs that merged or were
  // dropped here, so fewer than `limit` pages remain while more may exist.
  const mayHaveMore = discovered === null || discovered > kept.length;
  if (discovered === null && kept.length === limit) {
    notes.add(`Returned exactly the limit (${limit}); total page count unknown, so more pages may exist`);
  }
  if (kept.length < limit && (duplicates > 0 || offSite > 0) && mayHaveMore) {
    incomplete = true;
    notes.add(`Underfilled: ${kept.length} of limit ${limit} after merging/dropping URLs; more same-site pages may exist`);
  }

  const pages: Page[] = [];
  let extractionTruncated = 0;
  let blockBudget: number = LIMITS.maxTotalBlocks;
  let cardBudget: number = LIMITS.maxTotalCards;
  let budgetTrimmed = false;
  kept.forEach((c, i) => {
    let parentIndex: number | null = null;
    if (i > 0) {
      parentIndex = 0;
      let best = -1;
      for (let j = 1; j < i; j++) {
        const p = kept[j]!;
        const proper = p.segments.length < c.segments.length && isPrefix(p.segments, c.segments);
        const sameWithQuery = c.hasQuery && !p.hasQuery && p.segments.length === c.segments.length && isPrefix(p.segments, c.segments);
        if ((proper || sameWithQuery) && p.segments.length > best) {
          best = p.segments.length;
          parentIndex = j;
        }
      }
    }
    const path = displayPath(c.canonical);
    const ex = extractPage(c.raw.html, c.raw.metadataTitle, path);
    if (ex.truncated) extractionTruncated++;
    const blocks: Block[] = [];
    for (const b of ex.blocks) {
      if (blockBudget <= 0) {
        budgetTrimmed = true;
        break;
      }
      if (b.type === "cards") {
        const cards = b.cards.slice(0, Math.max(0, cardBudget));
        if (cards.length < b.cards.length) budgetTrimmed = true;
        if (cards.length === 0) continue;
        cardBudget -= cards.length;
        blocks.push({ type: "cards", cards });
      } else blocks.push(b);
      blockBudget--;
    }
    const parent = parentIndex === null ? null : pages[parentIndex]!;
    pages.push({
      id: `p${i}`,
      url: c.canonical,
      path,
      title: ex.title,
      parentId: parent ? parent.id : null,
      depth: parent ? parent.depth + 1 : 0,
      nav: ex.nav,
      footer: ex.footer,
      blocks,
    });
  });
  if (budgetTrimmed) notes.add("Document-wide block/card budget reached; later content omitted");
  if (extractionTruncated > 0) notes.add(`${extractionTruncated} page(s) hit HTML extraction bounds; content shortened`);

  const doc: SiteMapDoc = {
    schema: SCHEMA_ID,
    schemaVersion: SCHEMA_VERSION,
    generator: { name: "website-to-figma", version: GENERATOR_VERSION },
    source: input.source,
    site: { origin: start.origin, host: start.hostname },
    crawl: {
      requestedLimit: limit,
      hardCap: LIMITS.hardMaxPages,
      discoveredCount: discovered,
      returnedCount: pages.length,
      truncated,
      incomplete,
      notes: notes.list(),
    },
    pages,
  };
  const result = validateSiteMap(doc);
  if (!result.ok) throw new Error(`Internal error: built document failed validation:\n${result.errors.join("\n")}`);
  return result.doc;
}
