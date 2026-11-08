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
  // Hi-fi (schemaVersion 2) import bounds. Assets travel as base64 inside the
  // JSON, so its byte bound is larger than v1's; everything else stays bounded.
  hifiMaxJsonBytes: 72_000_000,
  hifiMaxPages: 20,
  hifiMaxNodesPerPage: 6_000,
  hifiMaxNodesTotal: 30_000,
  hifiMaxAssets: 40,
  hifiMaxAssetBytes: 12_000_000,
  hifiMaxAssetsTotalBytes: 48_000_000,
  // figma.createImage: "Images have a maximum size of 4096 pixels (4K) in width and height."
  hifiMaxImageDim: 4096,
  // Aggregate decoded-pixel budget across all assets (Figma decodes them).
  hifiMaxTotalPixels: 100_000_000,
  hifiMaxPageWidth: 4096,
  hifiMaxPageHeight: 30_000,
  hifiMaxTextChars: 2_000,
  hifiMaxFontStack: 16,
  hifiMaxWarnings: 50,
  // Converter input bounds (untrusted operator capture).
  captureMaxElements: 20_000,
  captureMaxTexts: 20_000,
  captureMaxImages: 500,
} as const;
