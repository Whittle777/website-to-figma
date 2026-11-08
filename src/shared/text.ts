// Collapse whitespace, drop control characters, and clamp length. Used on all
// page-derived text: scraped content is data, never markup or instructions.
export function cleanText(input: string, maxChars: number): string {
  // eslint-disable-next-line no-control-regex
  const collapsed = input.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxChars) return collapsed;
  return collapsed.slice(0, Math.max(0, maxChars - 1)).trimEnd() + "…";
}

// 32-bit FNV-1a, hex. Deterministic and runtime-agnostic (works in the Figma
// sandbox, which has no Node crypto).
export function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
