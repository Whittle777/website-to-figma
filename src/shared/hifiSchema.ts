// schemaVersion 2: measured hi-fi pages (editable boxes/buttons/text/images
// from an operator-supplied measured DOM capture) plus embedded, hash-pinned
// raster assets. Strict, dependency-free, sandbox-safe. v1 documents keep
// their own validator and 1 MB bound unchanged (see parseImportJson).
import { LIMITS } from "./limits";
import { exceedsNesting, MAX_JSON_NESTING, SCHEMA_ID, utf8Length, validateSiteMap, type SiteMapDoc } from "./schema";
import type { GenericFamily } from "./fonts";
import type { ImageMime } from "./imageInfo";

export const HIFI_SCHEMA_VERSION = 2;

// measured = observed in the capture; inferred = derived by the converter
// (e.g. control label text); fitted = adjusted at import to match a measured width.
export type Provenance = "measured" | "inferred";

export interface Paint {
  hex: string; // #rrggbb
  alpha: number; // 0..1
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface BoxNode extends Rect {
  kind: "box";
  name: string;
  role: "block" | "button" | "control";
  fill: Paint | null;
  border: { weight: number; color: Paint } | null;
  radius: [number, number, number, number];
  opacity: number;
  prov: Provenance;
}

export interface TextNode extends Rect {
  kind: "text";
  name: string;
  text: string;
  graphemes: number;
  fontStack: string[];
  generic: GenericFamily;
  weight: number;
  italic: boolean;
  size: number;
  lineHeight: number;
  color: Paint;
  decoration: "none" | "underline" | "strike";
  // index into page.nodes of the button box that contains this text, or -1
  button: number;
  prov: Provenance;
}

export interface ImageNode extends Rect {
  kind: "image";
  name: string;
  assetId: string | null;
  fit: "fill" | "fit";
  radius: [number, number, number, number];
  prov: Provenance;
}

export type HifiNode = BoxNode | TextNode | ImageNode;

export interface HifiAsset {
  id: string;
  kind: "image" | "reference";
  mime: ImageMime;
  width: number;
  height: number;
  bytes: number;
  sha256: string;
  sourceUrl: string | null;
  dataBase64: string;
}

export interface HifiPage {
  id: string;
  url: string;
  path: string;
  title: string;
  width: number;
  height: number;
  truncated: boolean;
  referenceAssetId: string | null;
  branding: { colors: Record<string, string>; fonts: string[] } | null;
  nodes: HifiNode[];
  warnings: string[];
}

export interface HifiDoc {
  schema: typeof SCHEMA_ID;
  schemaVersion: typeof HIFI_SCHEMA_VERSION;
  generator: { name: "website-to-figma"; version: string };
  source: { mode: "capture" | "fixture"; label: string };
  site: { origin: string; host: string };
  provenance: { layout: "measured-dom"; notes: string[] };
  assets: HifiAsset[];
  pages: HifiPage[];
  warnings: string[];
}

export type ImportResult = { ok: true; version: 1; doc: SiteMapDoc } | { ok: true; version: 2; doc: HifiDoc } | { ok: false; errors: string[] };

const HEX = /^#[0-9a-f]{6}$/;
const SHA = /^[0-9a-f]{64}$/;
const B64 = /^[A-Za-z0-9+/]*={0,2}$/;

class C {
  errors: string[] = [];
  fail(p: string, m: string) {
    if (this.errors.length < 50) this.errors.push(`${p}: ${m}`);
  }
  obj(v: unknown, p: string, keys: readonly string[]): v is Record<string, unknown> {
    if (typeof v !== "object" || v === null || Array.isArray(v)) {
      this.fail(p, "expected object");
      return false;
    }
    for (const k of Object.keys(v)) if (!keys.includes(k)) this.fail(p, `unknown key "${k}"`);
    for (const k of keys) if (!Object.prototype.hasOwnProperty.call(v, k)) this.fail(p, `missing key "${k}"`);
    return true;
  }
  str(v: unknown, p: string, max: number, allowEmpty = true): v is string {
    if (typeof v !== "string") return this.fail(p, "expected string"), false;
    if (v.length > max) this.fail(p, `longer than ${max} chars`);
    if (!allowEmpty && v.length === 0) this.fail(p, "must not be empty");
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(v)) this.fail(p, "contains control characters");
    return true;
  }
  num(v: unknown, p: string, min: number, max: number): v is number {
    if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) return this.fail(p, `expected number ${min}..${max}`), false;
    return true;
  }
  int(v: unknown, p: string, min: number, max: number): v is number {
    if (!this.num(v, p, min, max)) return false;
    if (!Number.isInteger(v)) return this.fail(p, "expected integer"), false;
    return true;
  }
  bool(v: unknown, p: string) {
    if (typeof v !== "boolean") this.fail(p, "expected boolean");
  }
  arr(v: unknown, p: string, max: number): v is unknown[] {
    if (!Array.isArray(v)) return this.fail(p, "expected array"), false;
    if (v.length > max) this.fail(p, `more than ${max} items`);
    return true;
  }
  oneOf(v: unknown, p: string, values: readonly unknown[]) {
    if (!values.includes(v)) this.fail(p, `expected one of ${values.join("|")}`);
  }
  httpUrl(v: unknown, p: string) {
    if (!this.str(v, p, LIMITS.maxUrlChars, false)) return;
    if (!/^https?:\/\/[^\s/@]+(\/[^\s]*)?$/i.test(v)) this.fail(p, "expected http(s) URL without credentials");
  }
  paint(v: unknown, p: string) {
    if (!this.obj(v, p, ["hex", "alpha"])) return;
    if (typeof v.hex !== "string" || !HEX.test(v.hex)) this.fail(`${p}.hex`, "expected #rrggbb");
    this.num(v.alpha, `${p}.alpha`, 0, 1);
  }
  radius(v: unknown, p: string) {
    if (this.arr(v, p, 4)) {
      if (v.length !== 4) this.fail(p, "expected 4 corner radii");
      v.forEach((r, i) => this.num(r, `${p}[${i}]`, 0, 10_000));
    }
  }
  labels(v: unknown, p: string, max: number) {
    if (this.arr(v, p, max)) v.forEach((x, i) => this.str(x, `${p}[${i}]`, LIMITS.maxNoteChars, false));
  }
}

const COORD = 100_000;

function checkRect(c: C, n: Record<string, unknown>, p: string) {
  c.num(n.x, `${p}.x`, -COORD, COORD);
  c.num(n.y, `${p}.y`, -COORD, COORD);
  c.num(n.w, `${p}.w`, 0, COORD);
  c.num(n.h, `${p}.h`, 0, COORD);
}

function checkNode(c: C, n: unknown, p: string, nodeCount: number, assetIds: Set<string>, kinds: string[]) {
  const kind = (n as { kind?: unknown } | null)?.kind;
  if (kind === "box") {
    if (!c.obj(n, p, ["kind", "x", "y", "w", "h", "name", "role", "fill", "border", "radius", "opacity", "prov"])) return;
    checkRect(c, n, p);
    c.str(n.name, `${p}.name`, 120, false);
    c.oneOf(n.role, `${p}.role`, ["block", "button", "control"]);
    if (n.fill !== null) c.paint(n.fill, `${p}.fill`);
    if (n.border !== null && c.obj(n.border, `${p}.border`, ["weight", "color"])) {
      c.num(n.border.weight, `${p}.border.weight`, 0, 1_000);
      c.paint(n.border.color, `${p}.border.color`);
    }
    c.radius(n.radius, `${p}.radius`);
    c.num(n.opacity, `${p}.opacity`, 0, 1);
    c.oneOf(n.prov, `${p}.prov`, ["measured", "inferred"]);
  } else if (kind === "text") {
    if (!c.obj(n, p, ["kind", "x", "y", "w", "h", "name", "text", "graphemes", "fontStack", "generic", "weight", "italic", "size", "lineHeight", "color", "decoration", "button", "prov"])) return;
    checkRect(c, n, p);
    c.str(n.name, `${p}.name`, 120, false);
    c.str(n.text, `${p}.text`, LIMITS.hifiMaxTextChars, false);
    c.int(n.graphemes, `${p}.graphemes`, 1, LIMITS.hifiMaxTextChars);
    if (c.arr(n.fontStack, `${p}.fontStack`, LIMITS.hifiMaxFontStack)) n.fontStack.forEach((f, i) => c.str(f, `${p}.fontStack[${i}]`, 100, false));
    c.oneOf(n.generic, `${p}.generic`, ["sans", "serif", "mono"]);
    c.num(n.weight, `${p}.weight`, 1, 1000);
    c.bool(n.italic, `${p}.italic`);
    c.num(n.size, `${p}.size`, 1, 500);
    c.num(n.lineHeight, `${p}.lineHeight`, 1, 2_000);
    c.paint(n.color, `${p}.color`);
    c.oneOf(n.decoration, `${p}.decoration`, ["none", "underline", "strike"]);
    if (c.int(n.button, `${p}.button`, -1, nodeCount - 1) && n.button >= 0 && kinds[n.button] !== "button") {
      c.fail(`${p}.button`, "must reference a button box");
    }
    c.oneOf(n.prov, `${p}.prov`, ["measured", "inferred"]);
  } else if (kind === "image") {
    if (!c.obj(n, p, ["kind", "x", "y", "w", "h", "name", "assetId", "fit", "radius", "prov"])) return;
    checkRect(c, n, p);
    c.str(n.name, `${p}.name`, 120, false);
    if (n.assetId !== null && (typeof n.assetId !== "string" || !assetIds.has(n.assetId))) c.fail(`${p}.assetId`, "unknown asset");
    c.oneOf(n.fit, `${p}.fit`, ["fill", "fit"]);
    c.radius(n.radius, `${p}.radius`);
    c.oneOf(n.prov, `${p}.prov`, ["measured", "inferred"]);
  } else {
    c.fail(`${p}.kind`, "expected box | text | image");
  }
}

export function validateHifiDoc(input: unknown): { ok: true; doc: HifiDoc } | { ok: false; errors: string[] } {
  const c = new C();
  if (!c.obj(input, "$", ["schema", "schemaVersion", "generator", "source", "site", "provenance", "assets", "pages", "warnings"])) return { ok: false, errors: c.errors };
  const d = input;
  if (d.schema !== SCHEMA_ID) c.fail("$.schema", `expected "${SCHEMA_ID}"`);
  if (d.schemaVersion !== HIFI_SCHEMA_VERSION) c.fail("$.schemaVersion", "expected 2");
  if (c.obj(d.generator, "$.generator", ["name", "version"])) {
    if (d.generator.name !== "website-to-figma") c.fail("$.generator.name", 'expected "website-to-figma"');
    c.str(d.generator.version, "$.generator.version", 32, false);
  }
  if (c.obj(d.source, "$.source", ["mode", "label"])) {
    c.oneOf(d.source.mode, "$.source.mode", ["capture", "fixture"]);
    c.str(d.source.label, "$.source.label", 200, false);
  }
  if (c.obj(d.site, "$.site", ["origin", "host"])) {
    c.httpUrl(d.site.origin, "$.site.origin");
    c.str(d.site.host, "$.site.host", 253, false);
  }
  if (c.obj(d.provenance, "$.provenance", ["layout", "notes"])) {
    c.oneOf(d.provenance.layout, "$.provenance.layout", ["measured-dom"]);
    c.labels(d.provenance.notes, "$.provenance.notes", LIMITS.maxNotes);
  }
  c.labels(d.warnings, "$.warnings", LIMITS.hifiMaxWarnings);

  const assetIds = new Set<string>();
  let assetBytes = 0;
  let assetPixels = 0;
  if (c.arr(d.assets, "$.assets", LIMITS.hifiMaxAssets)) {
    d.assets.forEach((a, i) => {
      const p = `$.assets[${i}]`;
      if (!c.obj(a, p, ["id", "kind", "mime", "width", "height", "bytes", "sha256", "sourceUrl", "dataBase64"])) return;
      if (typeof a.id !== "string" || !/^a[0-9]{1,3}$/.test(a.id)) c.fail(`${p}.id`, 'expected "a<index>"');
      else if (assetIds.has(a.id)) c.fail(`${p}.id`, "duplicate id");
      else assetIds.add(a.id);
      c.oneOf(a.kind, `${p}.kind`, ["image", "reference"]);
      c.oneOf(a.mime, `${p}.mime`, ["image/png", "image/jpeg", "image/gif"]);
      if (c.int(a.width, `${p}.width`, 1, LIMITS.hifiMaxImageDim) && c.int(a.height, `${p}.height`, 1, LIMITS.hifiMaxImageDim)) {
        assetPixels += (a.width as number) * (a.height as number);
      }
      if (c.int(a.bytes, `${p}.bytes`, 1, LIMITS.hifiMaxAssetBytes)) assetBytes += a.bytes;
      if (typeof a.sha256 !== "string" || !SHA.test(a.sha256)) c.fail(`${p}.sha256`, "expected lowercase hex sha256");
      if (a.sourceUrl !== null) c.httpUrl(a.sourceUrl, `${p}.sourceUrl`);
      if (typeof a.dataBase64 !== "string" || !B64.test(a.dataBase64)) c.fail(`${p}.dataBase64`, "expected base64");
      else if (typeof a.bytes === "number" && a.dataBase64.length !== Math.ceil(a.bytes / 3) * 4) c.fail(`${p}.dataBase64`, "length does not match bytes");
    });
    if (assetBytes > LIMITS.hifiMaxAssetsTotalBytes) c.fail("$.assets", `more than ${LIMITS.hifiMaxAssetsTotalBytes} bytes in total`);
    if (assetPixels > LIMITS.hifiMaxTotalPixels) c.fail("$.assets", `more than ${LIMITS.hifiMaxTotalPixels} decoded pixels in total`);
  }

  let total = 0;
  if (c.arr(d.pages, "$.pages", LIMITS.hifiMaxPages)) {
    if (d.pages.length === 0) c.fail("$.pages", "must contain at least one page");
    const ids = new Set<string>();
    d.pages.forEach((pg, i) => {
      const p = `$.pages[${i}]`;
      if (!c.obj(pg, p, ["id", "url", "path", "title", "width", "height", "truncated", "referenceAssetId", "branding", "nodes", "warnings"])) return;
      if (typeof pg.id !== "string" || !/^p[0-9]{1,2}$/.test(pg.id) || ids.has(pg.id)) c.fail(`${p}.id`, 'expected unique "p<index>"');
      else ids.add(pg.id);
      c.httpUrl(pg.url, `${p}.url`);
      if (c.str(pg.path, `${p}.path`, LIMITS.maxUrlChars, false) && !pg.path.startsWith("/")) c.fail(`${p}.path`, 'must start with "/"');
      c.str(pg.title, `${p}.title`, LIMITS.maxTitleChars, false);
      c.num(pg.width, `${p}.width`, 1, LIMITS.hifiMaxPageWidth);
      c.num(pg.height, `${p}.height`, 1, LIMITS.hifiMaxPageHeight);
      c.bool(pg.truncated, `${p}.truncated`);
      if (pg.referenceAssetId !== null && (typeof pg.referenceAssetId !== "string" || !assetIds.has(pg.referenceAssetId))) c.fail(`${p}.referenceAssetId`, "unknown asset");
      if (pg.branding !== null && c.obj(pg.branding, `${p}.branding`, ["colors", "fonts"])) {
        const colors = pg.branding.colors;
        if (typeof colors !== "object" || colors === null || Array.isArray(colors)) c.fail(`${p}.branding.colors`, "expected object");
        else {
          const entries = Object.entries(colors);
          if (entries.length > 20) c.fail(`${p}.branding.colors`, "more than 20 entries");
          for (const [k, v] of entries) {
            if (!/^[A-Za-z][A-Za-z0-9]{0,31}$/.test(k)) c.fail(`${p}.branding.colors`, "invalid key");
            if (typeof v !== "string" || !HEX.test(v)) c.fail(`${p}.branding.colors.${k}`, "expected #rrggbb");
          }
        }
        c.labels(pg.branding.fonts, `${p}.branding.fonts`, 10);
      }
      c.labels(pg.warnings, `${p}.warnings`, LIMITS.hifiMaxWarnings);
      const nodes = pg.nodes;
      if (c.arr(nodes, `${p}.nodes`, LIMITS.hifiMaxNodesPerPage)) {
        total += nodes.length;
        const kinds = nodes.map((n) => {
          const o = n as { kind?: unknown; role?: unknown } | null;
          return o?.kind === "box" && o.role === "button" ? "button" : String(o?.kind);
        });
        nodes.forEach((n, j) => checkNode(c, n, `${p}.nodes[${j}]`, nodes.length, assetIds, kinds));
      }
    });
    if (total > LIMITS.hifiMaxNodesTotal) c.fail("$.pages", `more than ${LIMITS.hifiMaxNodesTotal} nodes in total`);
  }
  return c.errors.length === 0 ? { ok: true, doc: input as unknown as HifiDoc } : { ok: false, errors: c.errors };
}

// Single entry point for untrusted import text. Version 1 keeps its original
// 1 MB bound and validator; version 2 uses the hi-fi bounds above.
export function parseImportJson(text: string): ImportResult {
  if (typeof text !== "string") return { ok: false, errors: ["$: expected JSON text"] };
  if (text.length > LIMITS.hifiMaxJsonBytes || utf8Length(text) > LIMITS.hifiMaxJsonBytes) {
    return { ok: false, errors: [`$: larger than ${LIMITS.hifiMaxJsonBytes} bytes`] };
  }
  if (exceedsNesting(text, MAX_JSON_NESTING)) return { ok: false, errors: [`$: nested deeper than ${MAX_JSON_NESTING} levels`] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, errors: ["$: not valid JSON"] };
  }
  const version = (parsed as { schemaVersion?: unknown } | null)?.schemaVersion;
  if (version === 1) {
    if (utf8Length(text) > LIMITS.maxJsonBytes) return { ok: false, errors: [`$: larger than ${LIMITS.maxJsonBytes} bytes`] };
    const r = validateSiteMap(parsed);
    return r.ok ? { ok: true, version: 1, doc: r.doc } : r;
  }
  if (version === HIFI_SCHEMA_VERSION) {
    const r = validateHifiDoc(parsed);
    return r.ok ? { ok: true, version: 2, doc: r.doc } : r;
  }
  return { ok: false, errors: ["$.schemaVersion: unsupported version (expected 1 or 2)"] };
}
