// Bounded allowlist SVG sanitizer (pure, sandbox-safe). Accepts only simple
// vector primitives and rebuilds canonical markup from parsed values, so the
// output can never carry scripts, styles, event handlers, external references
// (href/url()), entities, foreignObject, text, images or comments. Anything
// outside the allowlist rejects the WHOLE SVG (the caller reports it).
const MAX_INPUT = 32_000;
const MAX_ELEMENTS = 200;
const MAX_PATH = 20_000;
const MAX_NUMBERS = 20_000; // numbers per path/points attribute
const MAX_COMMANDS = 20_000; // path commands per d attribute
const MAX_ABS = 1e6; // every coordinate / number must be finite and |n| <= 1e6

const NUM = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?$/i;
const PATH_D = /^[MmLlHhVvCcSsQqTtAaZz0-9eE.,\s+-]+$/;
const POINTS = /^[0-9eE.,\s+-]+$/;
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const RGB = /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(?:,\s*(?:0|1|0?\.\d+)\s*)?\)$/i;

// tag -> attribute -> kind of value
const SHAPES: Record<string, Record<string, "num" | "d" | "points">> = {
  path: { d: "d" },
  circle: { cx: "num", cy: "num", r: "num" },
  ellipse: { cx: "num", cy: "num", rx: "num", ry: "num" },
  rect: { x: "num", y: "num", width: "num", height: "num", rx: "num", ry: "num" },
  line: { x1: "num", y1: "num", x2: "num", y2: "num" },
  polyline: { points: "points" },
  polygon: { points: "points" },
};
const PAINT_ATTRS = new Set(["fill", "stroke"]);
const NUMERIC_PAINT_ATTRS = new Set(["stroke-width", "opacity", "fill-opacity", "stroke-opacity"]);
const ENUM_ATTRS: Record<string, string[]> = { "fill-rule": ["nonzero", "evenodd"], "clip-rule": ["nonzero", "evenodd"], "stroke-linecap": ["butt", "round", "square"], "stroke-linejoin": ["miter", "round", "bevel"] };
// Attributes dropped (never copied to output) rather than rejected. The root
// <svg> may carry presentation-only class/style (e.g. icon sizing); children
// may not: style or class on a shape rejects the whole SVG.
const DROPPED_ROOT = new Set(["class", "style", "id", "xmlns", "version", "aria-hidden", "role", "focusable", "data-w2f-id", "width", "height"]);
const DROPPED = new Set(["id", "aria-hidden", "data-w2f-id"]);

// Finite, bounded numbers only (also rejects NaN/Infinity spellings).
function boundedNumbers(v: string, maxCount: number): boolean {
  const nums = v.match(/-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?/gi) ?? [];
  if (nums.length > maxCount) return false;
  return nums.every((n) => {
    const x = Number(n);
    return Number.isFinite(x) && Math.abs(x) <= MAX_ABS;
  });
}

export type SvgResult = { ok: true; markup: string; elements: number } | { ok: false; reason: string };

function paint(v: string, currentColor: string | null): string | null {
  const s = v.trim();
  if (s === "none") return "none";
  if (s === "currentColor") return currentColor;
  if (HEX.test(s) || RGB.test(s)) return s.toLowerCase();
  return null;
}

// width/height: the measured box in CSS px; currentColor: measured CSS color
// (#rrggbb) or null (then currentColor paint is rejected).
export function sanitizeSvg(input: string, width: number, height: number, currentColor: string | null): SvgResult {
  if (typeof input !== "string" || input.length > MAX_INPUT) return { ok: false, reason: "SVG too large" };
  if (/<!|<\?|&|url\s*\(|javascript:|data:|href/i.test(input)) return { ok: false, reason: "SVG contains comments, entities, references or URLs" };
  const tokens = input.match(/<\/?[^<>]*>|[^<>]+/g) ?? [];
  if (tokens.join("") !== input) return { ok: false, reason: "malformed SVG markup" };
  let viewBox: string | null = null;
  const out: string[] = [];
  const stack: string[] = [];
  let count = 0;
  for (const tok of tokens) {
    if (!tok.startsWith("<")) {
      if (tok.trim()) return { ok: false, reason: "SVG contains text content" };
      continue;
    }
    if (tok.startsWith("</")) {
      const name = tok.slice(2, -1).trim();
      if (stack.pop() !== name) return { ok: false, reason: "unbalanced SVG tags" };
      if (name === "g") out.push("</g>");
      continue;
    }
    const m = /^<([a-zA-Z]+)((?:\s+[a-zA-Z_:][\w:.-]*="[^"<>]*")*)\s*(\/?)>$/.exec(tok);
    if (!m) return { ok: false, reason: "unsupported SVG tag syntax" };
    const name = m[1]!;
    const selfClosing = m[3] === "/";
    if (++count > MAX_ELEMENTS) return { ok: false, reason: "too many SVG elements" };
    const attrs: [string, string][] = [...m[2]!.matchAll(/([a-zA-Z_:][\w:.-]*)="([^"<>]*)"/g)].map((a) => [a[1]!, a[2]!]);
    if (name === "svg") {
      if (stack.length !== 0 || out.length !== 0) return { ok: false, reason: "nested or repeated <svg>" };
      for (const [k, v] of attrs) {
        if (k === "viewBox") {
          const parts = v.trim().split(/[\s,]+/);
          if (parts.length !== 4 || !parts.every((p) => NUM.test(p)) || !boundedNumbers(v, 4) || !(Number(parts[2]) > 0 && Number(parts[3]) > 0)) return { ok: false, reason: "invalid viewBox" };
          viewBox = parts.join(" ");
        } else if (!DROPPED_ROOT.has(k)) return { ok: false, reason: `unsupported <svg> attribute ${k}` };
      }
      if (selfClosing) return { ok: false, reason: "empty SVG" };
      stack.push("svg");
      continue;
    }
    if (stack.length === 0) return { ok: false, reason: "content outside <svg>" };
    const shape = SHAPES[name];
    if (!shape && name !== "g") return { ok: false, reason: `unsupported SVG element <${name}>` };
    const kept: string[] = [];
    let hasFill = false;
    for (const [k, v] of attrs) {
      const kind = shape?.[k];
      if (kind === "num") {
        if (!NUM.test(v.trim()) || !boundedNumbers(v, 1)) return { ok: false, reason: `invalid number in ${name}.${k}` };
        kept.push(`${k}="${v.trim()}"`);
      } else if (kind === "d") {
        if (v.length > MAX_PATH || !PATH_D.test(v) || !boundedNumbers(v, MAX_NUMBERS) || (v.match(/[a-z]/gi) ?? []).filter((ch) => ch !== "e" && ch !== "E").length > MAX_COMMANDS) {
          return { ok: false, reason: "invalid path data" };
        }
        kept.push(`d="${v.replace(/\s+/g, " ").trim()}"`);
      } else if (kind === "points") {
        if (v.length > MAX_PATH || !POINTS.test(v) || !boundedNumbers(v, MAX_NUMBERS)) return { ok: false, reason: "invalid points" };
        kept.push(`points="${v.replace(/\s+/g, " ").trim()}"`);
      } else if (PAINT_ATTRS.has(k)) {
        const p = paint(v, currentColor);
        if (p === null) return { ok: false, reason: `unsupported paint ${k}` };
        if (k === "fill") hasFill = true;
        kept.push(`${k}="${p}"`);
      } else if (NUMERIC_PAINT_ATTRS.has(k)) {
        if (!NUM.test(v.trim()) || !boundedNumbers(v, 1)) return { ok: false, reason: `invalid ${k}` };
        kept.push(`${k}="${v.trim()}"`);
      } else if (ENUM_ATTRS[k]) {
        if (!ENUM_ATTRS[k]!.includes(v.trim())) return { ok: false, reason: `invalid ${k}` };
        kept.push(`${k}="${v.trim()}"`);
      } else if (!DROPPED.has(k)) return { ok: false, reason: `unsupported attribute ${name}.${k}` };
    }
    // Inherited CSS fill is not reproduced; default unpainted shapes to the
    // measured text color when known (browser default for currentColor icons).
    if (shape && !hasFill && currentColor) kept.push(`fill="${currentColor}"`);
    out.push(`<${name}${kept.length ? " " + kept.join(" ") : ""}${shape ? "/>" : ">"}`);
    if (!selfClosing && shape) stack.push(name);
    if (!selfClosing && !shape) stack.push("g");
    if (selfClosing && !shape) out.push("</g>");
  }
  if (stack.length !== 0) return { ok: false, reason: "unbalanced SVG tags" };
  if (!viewBox) return { ok: false, reason: "SVG has no viewBox" };
  if (count <= 1) return { ok: false, reason: "SVG has no shapes" };
  const w = Math.max(0.01, Math.round(width * 1000) / 1000);
  const h = Math.max(0.01, Math.round(height * 1000) / 1000);
  return { ok: true, markup: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="${w}" height="${h}">${out.join("")}</svg>`, elements: count - 1 };
}

// Validator helper: canonical markup must re-sanitize to itself.
export function isCanonicalSvg(markup: string): boolean {
  const m = /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="[^"]*" width="([^"]*)" height="([^"]*)">/.exec(markup);
  if (!m || !NUM.test(m[1]!) || !NUM.test(m[2]!)) return false;
  const r = sanitizeSvg(markup, Number(m[1]), Number(m[2]), null);
  return r.ok && r.markup === markup;
}
