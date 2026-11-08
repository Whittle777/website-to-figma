// Pure font resolution: measured CSS font stack -> a font actually available
// in Figma. The browser-resolved OS font is never claimed; any substitution is
// reported as a fallback so it can be shown on the canvas.

export type GenericFamily = "sans" | "serif" | "mono";

export interface ResolvedFont {
  family: string;
  style: string;
  // true when the font is not the first concrete family of the measured stack
  // or the requested style was unavailable.
  fallback: boolean;
  reason: string;
}

const GENERIC_KEYWORDS = new Set(["sans-serif", "serif", "monospace", "system-ui", "ui-sans-serif", "ui-serif", "ui-monospace", "cursive", "fantasy", "-apple-system", "blinkmacsystemfont"]);

// Fallbacks used only when no family from the measured stack is available.
const GENERIC_FALLBACKS: Record<GenericFamily, string[]> = {
  sans: ["Inter", "Roboto", "Arial"],
  serif: ["Noto Serif", "Georgia", "Times New Roman", "Inter"],
  mono: ["Roboto Mono", "Source Code Pro", "Courier New", "Inter"],
};

export function parseFontStack(css: string): string[] {
  return css
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, "").trim())
    .filter((s) => s.length > 0 && s.length <= 100)
    .slice(0, 16);
}

export function genericOf(stack: string[]): GenericFamily {
  const lower = stack.map((s) => s.toLowerCase());
  if (lower.some((s) => s === "monospace" || s === "ui-monospace" || /mono|consolas|courier|menlo|monaco/.test(s))) return "mono";
  if (lower.includes("serif") || lower.includes("ui-serif")) return "serif";
  return "sans";
}

export function styleName(weight: number, italic: boolean): string {
  const bold = weight >= 600;
  if (bold && italic) return "Bold Italic";
  if (bold) return "Bold";
  return italic ? "Italic" : "Regular";
}

// `available` holds "Family|Style" keys (from figma.listAvailableFontsAsync).
export function resolveFont(stack: string[], generic: GenericFamily, weight: number, italic: boolean, available: Set<string>): ResolvedFont | null {
  const wanted = styleName(weight, italic);
  const concrete = stack.filter((f) => !GENERIC_KEYWORDS.has(f.toLowerCase()));
  const first = concrete[0];
  const candidates = [...concrete, ...GENERIC_FALLBACKS[generic]];
  for (const family of candidates) {
    if (available.has(`${family}|${wanted}`)) {
      const fallback = family !== first;
      return { family, style: wanted, fallback, reason: fallback ? `measured stack "${stack.join(", ")}" -> ${family}` : "first family of measured stack" };
    }
  }
  for (const family of candidates) {
    if (available.has(`${family}|Regular`)) {
      return { family, style: "Regular", fallback: true, reason: `style ${wanted} unavailable; ${family} Regular used` };
    }
  }
  return null;
}
