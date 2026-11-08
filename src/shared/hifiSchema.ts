// schemaVersion 2: measured hi-fi pages (editable boxes/buttons/text/images
// from an operator-supplied measured DOM capture) plus embedded, hash-pinned
// raster assets. Strict, dependency-free, sandbox-safe. v1 documents keep
// their own validator and 1 MB bound unchanged (see parseImportJson).
import { LIMITS } from "./limits";
import { exceedsNesting, MAX_JSON_NESTING, SCHEMA_ID, utf8Length, validateSiteMap, type SiteMapDoc } from "./schema";
import type { GenericFamily } from "./fonts";
import type { ImageMime } from "./imageInfo";
import { isCanonicalSvg } from "./svgSanitize";

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

// Optional on every node: index into page.clips (a measured overflow
// container the node is clipped by), or -1 / absent for none.
interface Clippable {
  clip?: number;
}

export interface BoxNode extends Rect, Clippable {
  kind: "box";
  name: string;
  role: "block" | "button" | "control";
  fill: Paint | null;
  border: { weight: number; color: Paint } | null;
  radius: [number, number, number, number];
  opacity: number;
  prov: Provenance;
}

export interface TextNode extends Rect, Clippable {
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
  // optional: right-aligned inferred markers; fit=false disables width fitting
  // (inferred text has no measured run width to fit to)
  align?: "left" | "right";
  fit?: boolean;
}

export interface ImageNode extends Rect, Clippable {
  kind: "image";
  name: string;
  assetId: string | null;
  fit: "fill" | "fit";
  radius: [number, number, number, number];
  prov: Provenance;
}

// Static approximations of native control parts (always prov "inferred").
export interface ShapeNode extends Rect, Clippable {
  kind: "shape";
  name: string;
  shape: "ellipse" | "caret" | "grip";
  fill: Paint | null;
  stroke: { weight: number; color: Paint } | null;
  prov: Provenance;
}

// Sanitized vector markup (see svgSanitize.ts); geometry measured.
export interface SvgNode extends Rect, Clippable {
  kind: "svg";
  name: string;
  markup: string;
  prov: Provenance;
}

export type HifiNode = BoxNode | TextNode | ImageNode | ShapeNode | SvgNode;

export interface ClipGroup extends Rect {
  name: string;
}

export interface Instance {
  component: string;
  x: number;
  y: number;
  // per-node paint differences on this page (e.g. an active nav link)
  overrides: { index: number; fill?: Paint | null; color?: Paint }[];
}

export interface HifiComponent {
  id: string;
  kind: "nav" | "footer";
  name: string;
  w: number;
  h: number;
  nodes: HifiNode[];
}

export interface FontMapEntry {
  match: string;
  use: string;
}

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

// Interactive-state variants (optional; added with the offline state planner).
// "synthetic" = a declarative DOM modification measured in a hosted browser,
// NOT the page's observed original state; "manual" = an operator-captured
// screenshot only (no measurement); "baseline" = the unmodified page.
export interface StateVariant {
  name: string;
  provenance: "baseline" | "synthetic" | "manual";
  // page coordinates of this state's own measurement (manual: 0,0,w,h)
  frame: Rect;
  nodes: HifiNode[]; // relative to frame
  referenceAssetId: string | null;
  // how the provider screenshot was tied to this state, and where it was taken
  screenshot: { association: "action-order" | "unassociated" | "manual"; scrollY: number | null; viewportW: number | null; viewportH: number | null } | null;
  notes: string[];
}

export interface MediaItem extends Rect {
  kind: "video" | "canvas" | "lottie" | "iframe";
  poster: string | null; // observed poster URL (never downloaded)
  src: string | null; // observed http(s) source URL (never downloaded)
  webgl: boolean | null;
  stillAssetId: string | null; // operator-supplied local still matching the poster URL
  still: "operator-asset" | "poster-url-observed-not-downloaded" | "unavailable";
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
  // optional (added after the first v2 release; older v2 files omit them)
  notes?: string[];
  parentId?: string | null;
  clips?: ClipGroup[];
  instances?: Instance[];
  // INFERRED normalization applied on operator opt-in; node geometry on this
  // page = measured geometry transformed by this record.
  normalization?: { mode: "centered-dpr1"; measuredWidth: number; measuredHeight: number; offsetX: number; gutterPx: number; gutters: number };
  // tall reference screenshot reassembled from <=4096px tiles at their offsets
  referenceTiles?: { sourceSha256: string; sourceWidth: number; sourceHeight: number; tiles: { assetId: string; y: number; h: number }[] };
  states?: { reactions: "none" | "click-cycle"; variants: StateVariant[] };
  // freeze report: what was attempted/applied/unavailable; notFrozen is listed verbatim
  freeze?: { attempted: string[]; applied: { name: string; count: number }[]; unavailable: string[]; modifications: string[]; notFrozen: string[] };
  motion?: { rules: { selector: string; kind: "transition" | "animation" | "hover"; detail: string }[]; inaccessibleSheets: number };
  media?: MediaItem[];
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
  components?: HifiComponent[];
  fontMap?: FontMapEntry[];
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
  obj(v: unknown, p: string, keys: readonly string[], optional: readonly string[] = []): v is Record<string, unknown> {
    if (typeof v !== "object" || v === null || Array.isArray(v)) {
      this.fail(p, "expected object");
      return false;
    }
    for (const k of Object.keys(v)) if (!keys.includes(k) && !optional.includes(k)) this.fail(p, `unknown key "${k}"`);
    for (const k of keys) if (!Object.prototype.hasOwnProperty.call(v, k)) this.fail(p, `missing key "${k}"`);
    return true;
  }
  str(v: unknown, p: string, max: number, allowEmpty = true): v is string {
    if (typeof v !== "string") return this.fail(p, "expected string"), false;
    if (v.length > max) this.fail(p, `longer than ${max} chars`);
    if (!allowEmpty && v.length === 0) this.fail(p, "must not be empty");
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(v)) this.fail(p, "contains control characters");
    if (/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(v)) this.fail(p, "contains an unpaired UTF-16 surrogate");
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

function checkClip(c: C, n: Record<string, unknown>, p: string, clipCount: number) {
  if (n.clip !== undefined) c.int(n.clip, `${p}.clip`, -1, clipCount - 1);
}

function checkNode(c: C, n: unknown, p: string, nodeCount: number, assetIds: Set<string>, kinds: string[], clipCount: number) {
  const kind = (n as { kind?: unknown } | null)?.kind;
  if (kind === "box") {
    if (!c.obj(n, p, ["kind", "x", "y", "w", "h", "name", "role", "fill", "border", "radius", "opacity", "prov"], ["clip"])) return;
    checkClip(c, n, p, clipCount);
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
    if (!c.obj(n, p, ["kind", "x", "y", "w", "h", "name", "text", "graphemes", "fontStack", "generic", "weight", "italic", "size", "lineHeight", "color", "decoration", "button", "prov"], ["clip", "align", "fit"])) return;
    checkClip(c, n, p, clipCount);
    if (n.align !== undefined) c.oneOf(n.align, `${p}.align`, ["left", "right"]);
    if (n.fit !== undefined) c.bool(n.fit, `${p}.fit`);
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
    if (!c.obj(n, p, ["kind", "x", "y", "w", "h", "name", "assetId", "fit", "radius", "prov"], ["clip"])) return;
    checkClip(c, n, p, clipCount);
    checkRect(c, n, p);
    c.str(n.name, `${p}.name`, 120, false);
    if (n.assetId !== null && (typeof n.assetId !== "string" || !assetIds.has(n.assetId))) c.fail(`${p}.assetId`, "unknown asset");
    c.oneOf(n.fit, `${p}.fit`, ["fill", "fit"]);
    c.radius(n.radius, `${p}.radius`);
    c.oneOf(n.prov, `${p}.prov`, ["measured", "inferred"]);
  } else if (kind === "shape") {
    if (!c.obj(n, p, ["kind", "x", "y", "w", "h", "name", "shape", "fill", "stroke", "prov"], ["clip"])) return;
    checkClip(c, n, p, clipCount);
    checkRect(c, n, p);
    c.str(n.name, `${p}.name`, 120, false);
    c.oneOf(n.shape, `${p}.shape`, ["ellipse", "caret", "grip"]);
    if (n.fill !== null) c.paint(n.fill, `${p}.fill`);
    if (n.stroke !== null && c.obj(n.stroke, `${p}.stroke`, ["weight", "color"])) {
      c.num(n.stroke.weight, `${p}.stroke.weight`, 0, 100);
      c.paint(n.stroke.color, `${p}.stroke.color`);
    }
    c.oneOf(n.prov, `${p}.prov`, ["inferred"]);
  } else if (kind === "svg") {
    if (!c.obj(n, p, ["kind", "x", "y", "w", "h", "name", "markup", "prov"], ["clip"])) return;
    checkClip(c, n, p, clipCount);
    checkRect(c, n, p);
    c.str(n.name, `${p}.name`, 120, false);
    if (typeof n.markup !== "string" || n.markup.length > 40_000 || !isCanonicalSvg(n.markup)) c.fail(`${p}.markup`, "expected canonical sanitized SVG");
    c.oneOf(n.prov, `${p}.prov`, ["measured"]);
  } else {
    c.fail(`${p}.kind`, "expected box | text | image | shape | svg");
  }
}

function checkNodeList(c: C, nodes: unknown, p: string, max: number, assetIds: Set<string>, clipCount: number): number {
  if (!c.arr(nodes, p, max)) return 0;
  const kinds = nodes.map((n) => {
    const o = n as { kind?: unknown; role?: unknown } | null;
    return o?.kind === "box" && o.role === "button" ? "button" : String(o?.kind);
  });
  nodes.forEach((n, j) => checkNode(c, n, `${p}[${j}]`, nodes.length, assetIds, kinds, clipCount));
  return nodes.length;
}

export const STATE_NAME = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,39}$/;
export const MAX_VARIANT_NODES = 2_000;

function checkStatesEtc(c: C, pg: Record<string, unknown>, p: string, assetIds: Set<string>, assetsById: Map<string, { kind: unknown; width: unknown; height: unknown }>): number {
  let total = 0;
  if (pg.states !== undefined && c.obj(pg.states, `${p}.states`, ["reactions", "variants"])) {
    const st = pg.states;
    c.oneOf(st.reactions, `${p}.states.reactions`, ["none", "click-cycle"]);
    if (c.arr(st.variants, `${p}.states.variants`, 3)) {
      if (st.variants.length < 1) c.fail(`${p}.states.variants`, "expected 1..3 variants");
      const names = new Set<string>();
      st.variants.forEach((v, j) => {
        const q = `${p}.states.variants[${j}]`;
        if (!c.obj(v, q, ["name", "provenance", "frame", "nodes", "referenceAssetId", "screenshot", "notes"])) return;
        if (typeof v.name !== "string" || !STATE_NAME.test(v.name) || names.has(v.name.toLowerCase())) c.fail(`${q}.name`, "expected a unique state name");
        else names.add(v.name.toLowerCase());
        c.oneOf(v.provenance, `${q}.provenance`, ["baseline", "synthetic", "manual"]);
        if ((j === 0) !== (v.provenance === "baseline")) c.fail(`${q}.provenance`, "exactly the first variant must be the baseline");
        if (j === 0 && v.name !== "Default") c.fail(`${q}.name`, 'the baseline variant must be named "Default"');
        if (c.obj(v.frame, `${q}.frame`, ["x", "y", "w", "h"])) {
          checkRect(c, v.frame, `${q}.frame`);
          c.num(v.frame.w, `${q}.frame.w`, 1, LIMITS.hifiMaxPageWidth);
          c.num(v.frame.h, `${q}.frame.h`, 1, LIMITS.hifiMaxPageHeight);
        }
        total += checkNodeList(c, v.nodes, `${q}.nodes`, MAX_VARIANT_NODES, assetIds, 0);
        if (v.referenceAssetId !== null && (typeof v.referenceAssetId !== "string" || assetsById.get(v.referenceAssetId)?.kind !== "reference")) c.fail(`${q}.referenceAssetId`, "unknown reference asset");
        if (v.screenshot !== null && c.obj(v.screenshot, `${q}.screenshot`, ["association", "scrollY", "viewportW", "viewportH"])) {
          c.oneOf(v.screenshot.association, `${q}.screenshot.association`, ["action-order", "unassociated", "manual"]);
          for (const k of ["scrollY", "viewportW", "viewportH"] as const) if (v.screenshot[k] !== null) c.num(v.screenshot[k], `${q}.screenshot.${k}`, 0, COORD);
        }
        c.labels(v.notes, `${q}.notes`, 10);
      });
    }
  }
  if (pg.freeze !== undefined && c.obj(pg.freeze, `${p}.freeze`, ["attempted", "applied", "unavailable", "modifications", "notFrozen"])) {
    const f = pg.freeze;
    c.labels(f.attempted, `${p}.freeze.attempted`, 10);
    c.labels(f.unavailable, `${p}.freeze.unavailable`, 10);
    c.labels(f.modifications, `${p}.freeze.modifications`, 10);
    c.labels(f.notFrozen, `${p}.freeze.notFrozen`, 10);
    if (c.arr(f.applied, `${p}.freeze.applied`, 10)) {
      f.applied.forEach((a, j) => {
        if (!c.obj(a, `${p}.freeze.applied[${j}]`, ["name", "count"])) return;
        c.str(a.name, `${p}.freeze.applied[${j}].name`, 60, false);
        c.int(a.count, `${p}.freeze.applied[${j}].count`, 0, 100_000);
      });
    }
  }
  if (pg.motion !== undefined && c.obj(pg.motion, `${p}.motion`, ["rules", "inaccessibleSheets"])) {
    c.int(pg.motion.inaccessibleSheets, `${p}.motion.inaccessibleSheets`, 0, 1_000);
    if (c.arr(pg.motion.rules, `${p}.motion.rules`, 200)) {
      pg.motion.rules.forEach((r, j) => {
        const q = `${p}.motion.rules[${j}]`;
        if (!c.obj(r, q, ["selector", "kind", "detail"])) return;
        c.str(r.selector, `${q}.selector`, 200, false);
        c.oneOf(r.kind, `${q}.kind`, ["transition", "animation", "hover"]);
        c.str(r.detail, `${q}.detail`, 200);
      });
    }
  }
  if (pg.media !== undefined && c.arr(pg.media, `${p}.media`, 50)) {
    pg.media.forEach((m, j) => {
      const q = `${p}.media[${j}]`;
      if (!c.obj(m, q, ["kind", "x", "y", "w", "h", "poster", "src", "webgl", "stillAssetId", "still"])) return;
      c.oneOf(m.kind, `${q}.kind`, ["video", "canvas", "lottie", "iframe"]);
      checkRect(c, m, q);
      if (m.poster !== null) c.httpUrl(m.poster, `${q}.poster`);
      if (m.src !== null) c.httpUrl(m.src, `${q}.src`);
      if (m.webgl !== null) c.bool(m.webgl, `${q}.webgl`);
      c.oneOf(m.still, `${q}.still`, ["operator-asset", "poster-url-observed-not-downloaded", "unavailable"]);
      if ((m.still === "operator-asset") !== (m.stillAssetId !== null)) c.fail(`${q}.stillAssetId`, 'set exactly when still is "operator-asset"');
      if (m.stillAssetId !== null && (typeof m.stillAssetId !== "string" || assetsById.get(m.stillAssetId)?.kind !== "image")) c.fail(`${q}.stillAssetId`, "unknown image asset");
    });
  }
  return total;
}

export function validateHifiDoc(input: unknown): { ok: true; doc: HifiDoc } | { ok: false; errors: string[] } {
  const c = new C();
  if (!c.obj(input, "$", ["schema", "schemaVersion", "generator", "source", "site", "provenance", "assets", "pages", "warnings"], ["components", "fontMap"])) return { ok: false, errors: c.errors };
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
  const assetsById = new Map<string, { kind: unknown; width: unknown; height: unknown }>();
  let assetBytes = 0;
  let assetPixels = 0;
  if (c.arr(d.assets, "$.assets", LIMITS.hifiMaxAssets)) {
    d.assets.forEach((a, i) => {
      const p = `$.assets[${i}]`;
      if (!c.obj(a, p, ["id", "kind", "mime", "width", "height", "bytes", "sha256", "sourceUrl", "dataBase64"])) return;
      if (typeof a.id !== "string" || !/^a[0-9]{1,3}$/.test(a.id)) c.fail(`${p}.id`, 'expected "a<index>"');
      else if (assetIds.has(a.id)) c.fail(`${p}.id`, "duplicate id");
      else {
        assetIds.add(a.id);
        assetsById.set(a.id, { kind: a.kind, width: a.width, height: a.height });
      }
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
  const componentIds = new Set<string>();
  if (d.components !== undefined && c.arr(d.components, "$.components", 20)) {
    d.components.forEach((cm, i) => {
      const p = `$.components[${i}]`;
      if (!c.obj(cm, p, ["id", "kind", "name", "w", "h", "nodes"])) return;
      if (typeof cm.id !== "string" || !/^c[0-9]{1,2}$/.test(cm.id) || componentIds.has(cm.id)) c.fail(`${p}.id`, 'expected unique "c<index>"');
      else componentIds.add(cm.id);
      c.oneOf(cm.kind, `${p}.kind`, ["nav", "footer"]);
      c.str(cm.name, `${p}.name`, 120, false);
      c.num(cm.w, `${p}.w`, 1, LIMITS.hifiMaxPageWidth);
      c.num(cm.h, `${p}.h`, 1, LIMITS.hifiMaxPageHeight);
      total += checkNodeList(c, cm.nodes, `${p}.nodes`, 2_000, assetIds, 0);
    });
  }
  if (d.fontMap !== undefined && c.arr(d.fontMap, "$.fontMap", 16)) {
    d.fontMap.forEach((f, i) => {
      if (!c.obj(f, `$.fontMap[${i}]`, ["match", "use"])) return;
      c.str(f.match, `$.fontMap[${i}].match`, 100, false);
      c.str(f.use, `$.fontMap[${i}].use`, 100, false);
    });
  }
  if (c.arr(d.pages, "$.pages", LIMITS.hifiMaxPages)) {
    if (d.pages.length === 0) c.fail("$.pages", "must contain at least one page");
    const ids = new Set<string>();
    d.pages.forEach((pg, i) => {
      const p = `$.pages[${i}]`;
      if (!c.obj(pg, p, ["id", "url", "path", "title", "width", "height", "truncated", "referenceAssetId", "branding", "nodes", "warnings"], ["notes", "parentId", "clips", "instances", "normalization", "referenceTiles", "states", "freeze", "motion", "media"])) return;
      total += checkStatesEtc(c, pg, p, assetIds, assetsById);
      if (pg.referenceTiles !== undefined && c.obj(pg.referenceTiles, `${p}.referenceTiles`, ["sourceSha256", "sourceWidth", "sourceHeight", "tiles"])) {
        const rt = pg.referenceTiles;
        const q = `${p}.referenceTiles`;
        if (pg.referenceAssetId !== null) c.fail(q, "referenceAssetId must be null when tiles are used");
        if (typeof rt.sourceSha256 !== "string" || !SHA.test(rt.sourceSha256)) c.fail(`${q}.sourceSha256`, "expected lowercase hex sha256");
        const okW = c.int(rt.sourceWidth, `${q}.sourceWidth`, 1, LIMITS.hifiMaxImageDim);
        const okH = c.int(rt.sourceHeight, `${q}.sourceHeight`, 1, LIMITS.refTileMaxSourceHeight);
        if (c.arr(rt.tiles, `${q}.tiles`, LIMITS.refTileMaxTiles)) {
          if (rt.tiles.length < 2) c.fail(`${q}.tiles`, "expected at least 2 tiles");
          let next = 0;
          rt.tiles.forEach((t, j) => {
            const r = `${q}.tiles[${j}]`;
            if (!c.obj(t, r, ["assetId", "y", "h"])) return;
            if (!c.int(t.y, `${r}.y`, 0, LIMITS.refTileMaxSourceHeight) || !c.int(t.h, `${r}.h`, 1, LIMITS.refTileHeight)) return;
            if (t.y !== next) c.fail(`${r}.y`, "tiles must be contiguous from 0");
            next = (t.y as number) + (t.h as number);
            const a = typeof t.assetId === "string" ? assetsById.get(t.assetId) : undefined;
            if (!a || a.kind !== "reference") c.fail(`${r}.assetId`, "unknown reference asset");
            else if (okW && (a.width !== rt.sourceWidth || a.height !== t.h)) c.fail(`${r}.assetId`, "tile asset size does not match its rect");
          });
          if (okH && next !== rt.sourceHeight) c.fail(`${q}.tiles`, "tile heights must sum to sourceHeight");
        }
      }
      if (pg.normalization !== undefined && c.obj(pg.normalization, `${p}.normalization`, ["mode", "measuredWidth", "measuredHeight", "offsetX", "gutterPx", "gutters"])) {
        const nz = pg.normalization;
        c.oneOf(nz.mode, `${p}.normalization.mode`, ["centered-dpr1"]);
        c.num(nz.measuredWidth, `${p}.normalization.measuredWidth`, 1, 100_000);
        c.num(nz.measuredHeight, `${p}.normalization.measuredHeight`, 1, 1_000_000);
        c.num(nz.offsetX, `${p}.normalization.offsetX`, -100_000, 100_000);
        c.num(nz.gutterPx, `${p}.normalization.gutterPx`, 0, 25);
        c.int(nz.gutters, `${p}.normalization.gutters`, 0, 500);
      }
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
      if (pg.notes !== undefined) c.labels(pg.notes, `${p}.notes`, LIMITS.hifiMaxWarnings);
      if (pg.parentId !== undefined && pg.parentId !== null) c.str(pg.parentId, `${p}.parentId`, 8, false);
      let clipCount = 0;
      if (pg.clips !== undefined && c.arr(pg.clips, `${p}.clips`, 500)) {
        clipCount = pg.clips.length;
        pg.clips.forEach((cl, j) => {
          if (!c.obj(cl, `${p}.clips[${j}]`, ["x", "y", "w", "h", "name"])) return;
          checkRect(c, cl, `${p}.clips[${j}]`);
          c.str(cl.name, `${p}.clips[${j}].name`, 120, false);
        });
      }
      total += checkNodeList(c, pg.nodes, `${p}.nodes`, LIMITS.hifiMaxNodesPerPage, assetIds, clipCount);
      if (pg.instances !== undefined && c.arr(pg.instances, `${p}.instances`, 10)) {
        pg.instances.forEach((ins, j) => {
          const q = `${p}.instances[${j}]`;
          if (!c.obj(ins, q, ["component", "x", "y", "overrides"])) return;
          if (typeof ins.component !== "string" || !componentIds.has(ins.component)) c.fail(`${q}.component`, "unknown component");
          c.num(ins.x, `${q}.x`, -COORD, COORD);
          c.num(ins.y, `${q}.y`, -COORD, COORD);
          if (c.arr(ins.overrides, `${q}.overrides`, 2_000)) {
            ins.overrides.forEach((o, k) => {
              const r = `${q}.overrides[${k}]`;
              if (!c.obj(o, r, ["index"], ["fill", "color"])) return;
              c.int(o.index, `${r}.index`, 0, LIMITS.hifiMaxNodesPerPage);
              if (o.fill !== undefined && o.fill !== null) c.paint(o.fill, `${r}.fill`);
              if (o.color !== undefined) c.paint(o.color, `${r}.color`);
            });
          }
        });
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
