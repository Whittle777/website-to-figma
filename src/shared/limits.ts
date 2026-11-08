// Hard bounds shared by the CLI and the Figma plugin. The plugin re-validates
// every import against these, so a hand-edited JSON file cannot exceed them.
export const LIMITS = {
  defaultPages: 10,
  hardMaxPages: 20,
  maxJsonBytes: 1_000_000,
  maxBlocksPerPage: 30,
  maxCardsPerBlock: 12,
  maxNavItems: 8,
  maxFooterItems: 8,
  maxTitleChars: 120,
  maxHeadingChars: 120,
  maxTextChars: 280,
  maxLabelChars: 40,
  maxUrlChars: 2048,
  maxNotes: 20,
  maxNoteChars: 200,
  maxDepth: 19,
  // Whole-document budgets bound the number of Figma nodes one import creates.
  maxTotalBlocks: 300,
  maxTotalCards: 160,
  // CLI-side extraction bounds.
  maxHtmlChars: 1_000_000,
  // node-html-parser is super-linear on deeply unclosed markup, so input is
  // cut at this many opening tags *before* parsing (measured: ~0.5s worst case).
  maxHtmlTags: 15_000,
  // Crawl extraction also runs in a worker that is killed after this deadline.
  extractDeadlineMs: 60_000,
  extractWorkerHeapMb: 512,
  maxHtmlNodes: 20_000,
  maxHtmlDepth: 64,
  maxMapLinks: 500,
} as const;
