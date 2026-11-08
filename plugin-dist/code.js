"use strict";
(() => {
  var __defProp = Object.defineProperty;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

  // src/shared/limits.ts
  var LIMITS = {
    defaultPages: 10,
    hardMaxPages: 20,
    maxJsonBytes: 1e6,
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
    maxHtmlChars: 1e6,
    // node-html-parser is super-linear on deeply unclosed markup, so input is
    // cut at this many opening tags *before* parsing (measured: ~0.5s worst case).
    maxHtmlTags: 15e3,
    // Crawl extraction also runs in a worker that is killed after this deadline.
    extractDeadlineMs: 6e4,
    extractWorkerHeapMb: 512,
    maxHtmlNodes: 2e4,
    maxHtmlDepth: 64,
    maxMapLinks: 500,
    // Hi-fi (schemaVersion 2) import bounds. Assets travel as base64 inside the
    // JSON, so its byte bound is larger than v1's; everything else stays bounded.
    hifiMaxJsonBytes: 72e6,
    hifiMaxPages: 20,
    hifiMaxNodesPerPage: 6e3,
    hifiMaxNodesTotal: 3e4,
    hifiMaxAssets: 40,
    hifiMaxAssetBytes: 12e6,
    hifiMaxAssetsTotalBytes: 48e6,
    // figma.createImage: "Images have a maximum size of 4096 pixels (4K) in width and height."
    hifiMaxImageDim: 4096,
    // Aggregate decoded-pixel budget across all assets (Figma decodes them).
    hifiMaxTotalPixels: 1e8,
    // Tall REFERENCE PNGs only (body images keep the 4096px rule): decoded in a
    // bounded worker and re-encoded as <=4096px tiles.
    refTileHeight: 4096,
    refTileMaxSourceHeight: 65536,
    refTileMaxSourcePixels: 4e7,
    // <= 160 MB RGBA after decode
    refTileMaxTiles: 16,
    refTileMaxChunks: 1e4,
    refTileTimeoutMs: 6e4,
    refTileWorkerHeapMb: 512,
    hifiMaxPageWidth: 4096,
    hifiMaxPageHeight: 3e4,
    hifiMaxTextChars: 2e3,
    hifiMaxFontStack: 16,
    hifiMaxWarnings: 50,
    // Converter input bounds (untrusted operator capture).
    captureMaxElements: 2e4,
    captureMaxTexts: 2e4,
    captureMaxImages: 500
  };

  // src/shared/schema.ts
  var SCHEMA_ID = "website-to-figma/site-map";
  var SCHEMA_VERSION = 1;
  var Checker = class {
    constructor() {
      __publicField(this, "errors", []);
    }
    fail(path, msg) {
      if (this.errors.length < 50) this.errors.push(`${path}: ${msg}`);
    }
    obj(v, path, keys) {
      if (typeof v !== "object" || v === null || Array.isArray(v)) {
        this.fail(path, "expected object");
        return false;
      }
      for (const k of Object.keys(v)) {
        if (!keys.includes(k)) this.fail(path, `unknown key "${k}"`);
      }
      for (const k of keys) {
        if (!Object.prototype.hasOwnProperty.call(v, k)) this.fail(path, `missing key "${k}"`);
      }
      return true;
    }
    str(v, path, max, allowEmpty = true) {
      if (typeof v !== "string") {
        this.fail(path, "expected string");
        return false;
      }
      if (v.length > max) this.fail(path, `longer than ${max} chars`);
      if (!allowEmpty && v.length === 0) this.fail(path, "must not be empty");
      if (/[\u0000-\u001f\u007f]/.test(v)) this.fail(path, "contains control characters");
      return true;
    }
    int(v, path, min, max) {
      if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
        this.fail(path, `expected integer ${min}..${max}`);
        return false;
      }
      return true;
    }
    bool(v, path) {
      if (typeof v !== "boolean") {
        this.fail(path, "expected boolean");
        return false;
      }
      return true;
    }
    arr(v, path, max) {
      if (!Array.isArray(v)) {
        this.fail(path, "expected array");
        return false;
      }
      if (v.length > max) this.fail(path, `more than ${max} items`);
      return true;
    }
    httpUrl(v, path) {
      if (!this.str(v, path, LIMITS.maxUrlChars, false)) return;
      if (!/^https?:\/\/[^\s/@]+(\/[^\s]*)?$/i.test(v)) this.fail(path, "expected http(s) URL without credentials");
    }
  };
  function checkLabels(c, v, path, maxItems) {
    if (!c.arr(v, path, maxItems)) return;
    v.forEach((item, i) => c.str(item, `${path}[${i}]`, LIMITS.maxLabelChars, false));
  }
  function checkBlock(c, b, path) {
    if (typeof b !== "object" || b === null || Array.isArray(b)) {
      c.fail(path, "expected object");
      return;
    }
    const type = b.type;
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
  function validateSiteMap(input) {
    const c = new Checker();
    const top = [
      "schema",
      "schemaVersion",
      "generator",
      "source",
      "site",
      "crawl",
      "pages"
    ];
    if (!c.obj(input, "$", top)) return { ok: false, errors: c.errors };
    const d = input;
    if (d.schema !== SCHEMA_ID) c.fail("$.schema", `expected "${SCHEMA_ID}"`);
    if (d.schemaVersion !== SCHEMA_VERSION) c.fail("$.schemaVersion", `unsupported version (expected ${SCHEMA_VERSION})`);
    if (c.obj(d.generator, "$.generator", ["name", "version"])) {
      if (d.generator.name !== "website-to-figma") c.fail("$.generator.name", 'expected "website-to-figma"');
      c.str(d.generator.version, "$.generator.version", 32, false);
    }
    const src = d.source;
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
      "notes"
    ])) {
      const k = d.crawl;
      c.int(k.requestedLimit, "$.crawl.requestedLimit", 1, LIMITS.hardMaxPages);
      if (k.hardCap !== LIMITS.hardMaxPages) c.fail("$.crawl.hardCap", `expected ${LIMITS.hardMaxPages}`);
      if (k.discoveredCount !== null) c.int(k.discoveredCount, "$.crawl.discoveredCount", 0, 1e6);
      c.int(k.returnedCount, "$.crawl.returnedCount", 0, LIMITS.hardMaxPages);
      c.bool(k.truncated, "$.crawl.truncated");
      c.bool(k.incomplete, "$.crawl.incomplete");
      if (c.arr(k.notes, "$.crawl.notes", LIMITS.maxNotes)) {
        k.notes.forEach((n, i) => c.str(n, `$.crawl.notes[${i}]`, LIMITS.maxNoteChars, false));
      }
    }
    if (c.arr(d.pages, "$.pages", LIMITS.hardMaxPages)) {
      if (d.pages.length === 0) c.fail("$.pages", "must contain at least one page");
      const ids = /* @__PURE__ */ new Set();
      const urls = /* @__PURE__ */ new Set();
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
      if (c.errors.length === 0) {
        const pages = d.pages;
        const index = new Map(pages.map((p, i) => [p.id, i]));
        const roots = pages.filter((p) => p.parentId === null);
        if (roots.length !== 1 || pages[0]?.parentId !== null) c.fail("$.pages", "expected exactly one root page, first");
        pages.forEach((p, i) => {
          if (p.parentId === null) {
            if (p.depth !== 0) c.fail(`$.pages[${i}].depth`, "root depth must be 0");
            return;
          }
          const pi = index.get(p.parentId);
          if (pi === void 0 || pi >= i) {
            c.fail(`$.pages[${i}].parentId`, "parent must be an earlier page");
            return;
          }
          if (p.depth !== pages[pi].depth + 1) c.fail(`$.pages[${i}].depth`, "must equal parent depth + 1");
        });
        let blocks = 0;
        let cards = 0;
        for (const p of pages) {
          blocks += p.blocks.length;
          for (const b of p.blocks) if (b.type === "cards") cards += b.cards.length;
        }
        if (blocks > LIMITS.maxTotalBlocks) c.fail("$.pages", `more than ${LIMITS.maxTotalBlocks} blocks in total`);
        if (cards > LIMITS.maxTotalCards) c.fail("$.pages", `more than ${LIMITS.maxTotalCards} cards in total`);
        const k = d.crawl;
        if (k.returnedCount !== pages.length) c.fail("$.crawl.returnedCount", "must equal pages.length");
        if (pages.length > k.requestedLimit) c.fail("$.pages", "more pages than requestedLimit");
      }
    }
    return c.errors.length === 0 ? { ok: true, doc: input } : { ok: false, errors: c.errors };
  }
  var MAX_JSON_NESTING = 12;
  function exceedsNesting(text2, max) {
    let depth = 0;
    let inString = false;
    for (let i = 0; i < text2.length; i++) {
      const c = text2.charCodeAt(i);
      if (inString) {
        if (c === 92) i++;
        else if (c === 34) inString = false;
      } else if (c === 34) inString = true;
      else if (c === 123 || c === 91) {
        if (++depth > max) return true;
      } else if (c === 125 || c === 93) depth--;
    }
    return false;
  }
  function utf8Length(s) {
    let n = 0;
    for (let i = 0; i < s.length; i++) {
      const code = s.charCodeAt(i);
      if (code < 128) n += 1;
      else if (code < 2048) n += 2;
      else if (code >= 55296 && code <= 56319) {
        n += 4;
        i++;
      } else n += 3;
    }
    return n;
  }

  // src/shared/svgSanitize.ts
  var MAX_INPUT = 32e3;
  var MAX_ELEMENTS = 200;
  var MAX_PATH = 2e4;
  var MAX_NUMBERS = 2e4;
  var MAX_COMMANDS = 2e4;
  var MAX_ABS = 1e6;
  var NUM = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?$/i;
  var PATH_D = /^[MmLlHhVvCcSsQqTtAaZz0-9eE.,\s+-]+$/;
  var POINTS = /^[0-9eE.,\s+-]+$/;
  var HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
  var RGB = /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(?:,\s*(?:0|1|0?\.\d+)\s*)?\)$/i;
  var SHAPES = {
    path: { d: "d" },
    circle: { cx: "num", cy: "num", r: "num" },
    ellipse: { cx: "num", cy: "num", rx: "num", ry: "num" },
    rect: { x: "num", y: "num", width: "num", height: "num", rx: "num", ry: "num" },
    line: { x1: "num", y1: "num", x2: "num", y2: "num" },
    polyline: { points: "points" },
    polygon: { points: "points" }
  };
  var PAINT_ATTRS = /* @__PURE__ */ new Set(["fill", "stroke"]);
  var NUMERIC_PAINT_ATTRS = /* @__PURE__ */ new Set(["stroke-width", "opacity", "fill-opacity", "stroke-opacity"]);
  var ENUM_ATTRS = { "fill-rule": ["nonzero", "evenodd"], "clip-rule": ["nonzero", "evenodd"], "stroke-linecap": ["butt", "round", "square"], "stroke-linejoin": ["miter", "round", "bevel"] };
  var DROPPED_ROOT = /* @__PURE__ */ new Set(["class", "style", "id", "xmlns", "version", "aria-hidden", "role", "focusable", "data-w2f-id", "width", "height"]);
  var DROPPED = /* @__PURE__ */ new Set(["id", "aria-hidden", "data-w2f-id"]);
  function boundedNumbers(v, maxCount) {
    const nums = v.match(/-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?/gi) ?? [];
    if (nums.length > maxCount) return false;
    return nums.every((n) => {
      const x = Number(n);
      return Number.isFinite(x) && Math.abs(x) <= MAX_ABS;
    });
  }
  function paint(v, currentColor) {
    const s = v.trim();
    if (s === "none") return "none";
    if (s === "currentColor") return currentColor;
    if (HEX.test(s) || RGB.test(s)) return s.toLowerCase();
    return null;
  }
  function sanitizeSvg(input, width, height, currentColor) {
    if (typeof input !== "string" || input.length > MAX_INPUT) return { ok: false, reason: "SVG too large" };
    if (/<!|<\?|&|url\s*\(|javascript:|data:|href/i.test(input)) return { ok: false, reason: "SVG contains comments, entities, references or URLs" };
    const tokens = input.match(/<\/?[^<>]*>|[^<>]+/g) ?? [];
    if (tokens.join("") !== input) return { ok: false, reason: "malformed SVG markup" };
    let viewBox = null;
    const out = [];
    const stack = [];
    let count = 0;
    for (const tok of tokens) {
      if (!tok.startsWith("<")) {
        if (tok.trim()) return { ok: false, reason: "SVG contains text content" };
        continue;
      }
      if (tok.startsWith("</")) {
        const name2 = tok.slice(2, -1).trim();
        if (stack.pop() !== name2) return { ok: false, reason: "unbalanced SVG tags" };
        if (name2 === "g") out.push("</g>");
        continue;
      }
      const m = /^<([a-zA-Z]+)((?:\s+[a-zA-Z_:][\w:.-]*="[^"<>]*")*)\s*(\/?)>$/.exec(tok);
      if (!m) return { ok: false, reason: "unsupported SVG tag syntax" };
      const name = m[1];
      const selfClosing = m[3] === "/";
      if (++count > MAX_ELEMENTS) return { ok: false, reason: "too many SVG elements" };
      const attrs = [...m[2].matchAll(/([a-zA-Z_:][\w:.-]*)="([^"<>]*)"/g)].map((a) => [a[1], a[2]]);
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
      const kept = [];
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
          if (!ENUM_ATTRS[k].includes(v.trim())) return { ok: false, reason: `invalid ${k}` };
          kept.push(`${k}="${v.trim()}"`);
        } else if (!DROPPED.has(k)) return { ok: false, reason: `unsupported attribute ${name}.${k}` };
      }
      if (shape && !hasFill && currentColor) kept.push(`fill="${currentColor}"`);
      out.push(`<${name}${kept.length ? " " + kept.join(" ") : ""}${shape ? "/>" : ">"}`);
      if (!selfClosing && shape) stack.push(name);
      if (!selfClosing && !shape) stack.push("g");
      if (selfClosing && !shape) out.push("</g>");
    }
    if (stack.length !== 0) return { ok: false, reason: "unbalanced SVG tags" };
    if (!viewBox) return { ok: false, reason: "SVG has no viewBox" };
    if (count <= 1) return { ok: false, reason: "SVG has no shapes" };
    const w = Math.max(0.01, Math.round(width * 1e3) / 1e3);
    const h = Math.max(0.01, Math.round(height * 1e3) / 1e3);
    return { ok: true, markup: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="${w}" height="${h}">${out.join("")}</svg>`, elements: count - 1 };
  }
  function isCanonicalSvg(markup) {
    const m = /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="[^"]*" width="([^"]*)" height="([^"]*)">/.exec(markup);
    if (!m || !NUM.test(m[1]) || !NUM.test(m[2])) return false;
    const r = sanitizeSvg(markup, Number(m[1]), Number(m[2]), null);
    return r.ok && r.markup === markup;
  }

  // src/shared/hifiSchema.ts
  var HIFI_SCHEMA_VERSION = 2;
  var HEX2 = /^#[0-9a-f]{6}$/;
  var SHA = /^[0-9a-f]{64}$/;
  var B64 = /^[A-Za-z0-9+/]*={0,2}$/;
  var C = class {
    constructor() {
      __publicField(this, "errors", []);
    }
    fail(p, m) {
      if (this.errors.length < 50) this.errors.push(`${p}: ${m}`);
    }
    obj(v, p, keys, optional = []) {
      if (typeof v !== "object" || v === null || Array.isArray(v)) {
        this.fail(p, "expected object");
        return false;
      }
      for (const k of Object.keys(v)) if (!keys.includes(k) && !optional.includes(k)) this.fail(p, `unknown key "${k}"`);
      for (const k of keys) if (!Object.prototype.hasOwnProperty.call(v, k)) this.fail(p, `missing key "${k}"`);
      return true;
    }
    str(v, p, max, allowEmpty = true) {
      if (typeof v !== "string") return this.fail(p, "expected string"), false;
      if (v.length > max) this.fail(p, `longer than ${max} chars`);
      if (!allowEmpty && v.length === 0) this.fail(p, "must not be empty");
      if (/[\u0000-\u001f\u007f]/.test(v)) this.fail(p, "contains control characters");
      if (/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(v)) this.fail(p, "contains an unpaired UTF-16 surrogate");
      return true;
    }
    num(v, p, min, max) {
      if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) return this.fail(p, `expected number ${min}..${max}`), false;
      return true;
    }
    int(v, p, min, max) {
      if (!this.num(v, p, min, max)) return false;
      if (!Number.isInteger(v)) return this.fail(p, "expected integer"), false;
      return true;
    }
    bool(v, p) {
      if (typeof v !== "boolean") this.fail(p, "expected boolean");
    }
    arr(v, p, max) {
      if (!Array.isArray(v)) return this.fail(p, "expected array"), false;
      if (v.length > max) this.fail(p, `more than ${max} items`);
      return true;
    }
    oneOf(v, p, values) {
      if (!values.includes(v)) this.fail(p, `expected one of ${values.join("|")}`);
    }
    httpUrl(v, p) {
      if (!this.str(v, p, LIMITS.maxUrlChars, false)) return;
      if (!/^https?:\/\/[^\s/@]+(\/[^\s]*)?$/i.test(v)) this.fail(p, "expected http(s) URL without credentials");
    }
    paint(v, p) {
      if (!this.obj(v, p, ["hex", "alpha"])) return;
      if (typeof v.hex !== "string" || !HEX2.test(v.hex)) this.fail(`${p}.hex`, "expected #rrggbb");
      this.num(v.alpha, `${p}.alpha`, 0, 1);
    }
    radius(v, p) {
      if (this.arr(v, p, 4)) {
        if (v.length !== 4) this.fail(p, "expected 4 corner radii");
        v.forEach((r, i) => this.num(r, `${p}[${i}]`, 0, 1e4));
      }
    }
    labels(v, p, max) {
      if (this.arr(v, p, max)) v.forEach((x, i) => this.str(x, `${p}[${i}]`, LIMITS.maxNoteChars, false));
    }
  };
  var COORD = 1e5;
  function checkRect(c, n, p) {
    c.num(n.x, `${p}.x`, -COORD, COORD);
    c.num(n.y, `${p}.y`, -COORD, COORD);
    c.num(n.w, `${p}.w`, 0, COORD);
    c.num(n.h, `${p}.h`, 0, COORD);
  }
  function checkClip(c, n, p, clipCount) {
    if (n.clip !== void 0) c.int(n.clip, `${p}.clip`, -1, clipCount - 1);
  }
  function checkNode(c, n, p, nodeCount, assetIds, kinds, clipCount) {
    const kind = n?.kind;
    if (kind === "box") {
      if (!c.obj(n, p, ["kind", "x", "y", "w", "h", "name", "role", "fill", "border", "radius", "opacity", "prov"], ["clip"])) return;
      checkClip(c, n, p, clipCount);
      checkRect(c, n, p);
      c.str(n.name, `${p}.name`, 120, false);
      c.oneOf(n.role, `${p}.role`, ["block", "button", "control"]);
      if (n.fill !== null) c.paint(n.fill, `${p}.fill`);
      if (n.border !== null && c.obj(n.border, `${p}.border`, ["weight", "color"])) {
        c.num(n.border.weight, `${p}.border.weight`, 0, 1e3);
        c.paint(n.border.color, `${p}.border.color`);
      }
      c.radius(n.radius, `${p}.radius`);
      c.num(n.opacity, `${p}.opacity`, 0, 1);
      c.oneOf(n.prov, `${p}.prov`, ["measured", "inferred"]);
    } else if (kind === "text") {
      if (!c.obj(n, p, ["kind", "x", "y", "w", "h", "name", "text", "graphemes", "fontStack", "generic", "weight", "italic", "size", "lineHeight", "color", "decoration", "button", "prov"], ["clip", "align", "fit"])) return;
      checkClip(c, n, p, clipCount);
      if (n.align !== void 0) c.oneOf(n.align, `${p}.align`, ["left", "right"]);
      if (n.fit !== void 0) c.bool(n.fit, `${p}.fit`);
      checkRect(c, n, p);
      c.str(n.name, `${p}.name`, 120, false);
      c.str(n.text, `${p}.text`, LIMITS.hifiMaxTextChars, false);
      c.int(n.graphemes, `${p}.graphemes`, 1, LIMITS.hifiMaxTextChars);
      if (c.arr(n.fontStack, `${p}.fontStack`, LIMITS.hifiMaxFontStack)) n.fontStack.forEach((f, i) => c.str(f, `${p}.fontStack[${i}]`, 100, false));
      c.oneOf(n.generic, `${p}.generic`, ["sans", "serif", "mono"]);
      c.num(n.weight, `${p}.weight`, 1, 1e3);
      c.bool(n.italic, `${p}.italic`);
      c.num(n.size, `${p}.size`, 1, 500);
      c.num(n.lineHeight, `${p}.lineHeight`, 1, 2e3);
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
      if (typeof n.markup !== "string" || n.markup.length > 4e4 || !isCanonicalSvg(n.markup)) c.fail(`${p}.markup`, "expected canonical sanitized SVG");
      c.oneOf(n.prov, `${p}.prov`, ["measured"]);
    } else {
      c.fail(`${p}.kind`, "expected box | text | image | shape | svg");
    }
  }
  function checkNodeList(c, nodes, p, max, assetIds, clipCount) {
    if (!c.arr(nodes, p, max)) return 0;
    const kinds = nodes.map((n) => {
      const o = n;
      return o?.kind === "box" && o.role === "button" ? "button" : String(o?.kind);
    });
    nodes.forEach((n, j) => checkNode(c, n, `${p}[${j}]`, nodes.length, assetIds, kinds, clipCount));
    return nodes.length;
  }
  function validateHifiDoc(input) {
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
    const assetIds = /* @__PURE__ */ new Set();
    const assetsById = /* @__PURE__ */ new Map();
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
          assetPixels += a.width * a.height;
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
    const componentIds = /* @__PURE__ */ new Set();
    if (d.components !== void 0 && c.arr(d.components, "$.components", 20)) {
      d.components.forEach((cm, i) => {
        const p = `$.components[${i}]`;
        if (!c.obj(cm, p, ["id", "kind", "name", "w", "h", "nodes"])) return;
        if (typeof cm.id !== "string" || !/^c[0-9]{1,2}$/.test(cm.id) || componentIds.has(cm.id)) c.fail(`${p}.id`, 'expected unique "c<index>"');
        else componentIds.add(cm.id);
        c.oneOf(cm.kind, `${p}.kind`, ["nav", "footer"]);
        c.str(cm.name, `${p}.name`, 120, false);
        c.num(cm.w, `${p}.w`, 1, LIMITS.hifiMaxPageWidth);
        c.num(cm.h, `${p}.h`, 1, LIMITS.hifiMaxPageHeight);
        total += checkNodeList(c, cm.nodes, `${p}.nodes`, 2e3, assetIds, 0);
      });
    }
    if (d.fontMap !== void 0 && c.arr(d.fontMap, "$.fontMap", 16)) {
      d.fontMap.forEach((f, i) => {
        if (!c.obj(f, `$.fontMap[${i}]`, ["match", "use"])) return;
        c.str(f.match, `$.fontMap[${i}].match`, 100, false);
        c.str(f.use, `$.fontMap[${i}].use`, 100, false);
      });
    }
    if (c.arr(d.pages, "$.pages", LIMITS.hifiMaxPages)) {
      if (d.pages.length === 0) c.fail("$.pages", "must contain at least one page");
      const ids = /* @__PURE__ */ new Set();
      d.pages.forEach((pg, i) => {
        const p = `$.pages[${i}]`;
        if (!c.obj(pg, p, ["id", "url", "path", "title", "width", "height", "truncated", "referenceAssetId", "branding", "nodes", "warnings"], ["notes", "parentId", "clips", "instances", "normalization", "referenceTiles"])) return;
        if (pg.referenceTiles !== void 0 && c.obj(pg.referenceTiles, `${p}.referenceTiles`, ["sourceSha256", "sourceWidth", "sourceHeight", "tiles"])) {
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
              next = t.y + t.h;
              const a = typeof t.assetId === "string" ? assetsById.get(t.assetId) : void 0;
              if (!a || a.kind !== "reference") c.fail(`${r}.assetId`, "unknown reference asset");
              else if (okW && (a.width !== rt.sourceWidth || a.height !== t.h)) c.fail(`${r}.assetId`, "tile asset size does not match its rect");
            });
            if (okH && next !== rt.sourceHeight) c.fail(`${q}.tiles`, "tile heights must sum to sourceHeight");
          }
        }
        if (pg.normalization !== void 0 && c.obj(pg.normalization, `${p}.normalization`, ["mode", "measuredWidth", "measuredHeight", "offsetX", "gutterPx", "gutters"])) {
          const nz = pg.normalization;
          c.oneOf(nz.mode, `${p}.normalization.mode`, ["centered-dpr1"]);
          c.num(nz.measuredWidth, `${p}.normalization.measuredWidth`, 1, 1e5);
          c.num(nz.measuredHeight, `${p}.normalization.measuredHeight`, 1, 1e6);
          c.num(nz.offsetX, `${p}.normalization.offsetX`, -1e5, 1e5);
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
              if (typeof v !== "string" || !HEX2.test(v)) c.fail(`${p}.branding.colors.${k}`, "expected #rrggbb");
            }
          }
          c.labels(pg.branding.fonts, `${p}.branding.fonts`, 10);
        }
        c.labels(pg.warnings, `${p}.warnings`, LIMITS.hifiMaxWarnings);
        if (pg.notes !== void 0) c.labels(pg.notes, `${p}.notes`, LIMITS.hifiMaxWarnings);
        if (pg.parentId !== void 0 && pg.parentId !== null) c.str(pg.parentId, `${p}.parentId`, 8, false);
        let clipCount = 0;
        if (pg.clips !== void 0 && c.arr(pg.clips, `${p}.clips`, 500)) {
          clipCount = pg.clips.length;
          pg.clips.forEach((cl, j) => {
            if (!c.obj(cl, `${p}.clips[${j}]`, ["x", "y", "w", "h", "name"])) return;
            checkRect(c, cl, `${p}.clips[${j}]`);
            c.str(cl.name, `${p}.clips[${j}].name`, 120, false);
          });
        }
        total += checkNodeList(c, pg.nodes, `${p}.nodes`, LIMITS.hifiMaxNodesPerPage, assetIds, clipCount);
        if (pg.instances !== void 0 && c.arr(pg.instances, `${p}.instances`, 10)) {
          pg.instances.forEach((ins, j) => {
            const q = `${p}.instances[${j}]`;
            if (!c.obj(ins, q, ["component", "x", "y", "overrides"])) return;
            if (typeof ins.component !== "string" || !componentIds.has(ins.component)) c.fail(`${q}.component`, "unknown component");
            c.num(ins.x, `${q}.x`, -COORD, COORD);
            c.num(ins.y, `${q}.y`, -COORD, COORD);
            if (c.arr(ins.overrides, `${q}.overrides`, 2e3)) {
              ins.overrides.forEach((o, k) => {
                const r = `${q}.overrides[${k}]`;
                if (!c.obj(o, r, ["index"], ["fill", "color"])) return;
                c.int(o.index, `${r}.index`, 0, LIMITS.hifiMaxNodesPerPage);
                if (o.fill !== void 0 && o.fill !== null) c.paint(o.fill, `${r}.fill`);
                if (o.color !== void 0) c.paint(o.color, `${r}.color`);
              });
            }
          });
        }
      });
      if (total > LIMITS.hifiMaxNodesTotal) c.fail("$.pages", `more than ${LIMITS.hifiMaxNodesTotal} nodes in total`);
    }
    return c.errors.length === 0 ? { ok: true, doc: input } : { ok: false, errors: c.errors };
  }
  function parseImportJson(text2) {
    if (typeof text2 !== "string") return { ok: false, errors: ["$: expected JSON text"] };
    if (text2.length > LIMITS.hifiMaxJsonBytes || utf8Length(text2) > LIMITS.hifiMaxJsonBytes) {
      return { ok: false, errors: [`$: larger than ${LIMITS.hifiMaxJsonBytes} bytes`] };
    }
    if (exceedsNesting(text2, MAX_JSON_NESTING)) return { ok: false, errors: [`$: nested deeper than ${MAX_JSON_NESTING} levels`] };
    let parsed;
    try {
      parsed = JSON.parse(text2);
    } catch {
      return { ok: false, errors: ["$: not valid JSON"] };
    }
    const version = parsed?.schemaVersion;
    if (version === 1) {
      if (utf8Length(text2) > LIMITS.maxJsonBytes) return { ok: false, errors: [`$: larger than ${LIMITS.maxJsonBytes} bytes`] };
      const r = validateSiteMap(parsed);
      return r.ok ? { ok: true, version: 1, doc: r.doc } : r;
    }
    if (version === HIFI_SCHEMA_VERSION) {
      const r = validateHifiDoc(parsed);
      return r.ok ? { ok: true, version: 2, doc: r.doc } : r;
    }
    return { ok: false, errors: ["$.schemaVersion: unsupported version (expected 1 or 2)"] };
  }

  // src/shared/fonts.ts
  var GENERIC_KEYWORDS = /* @__PURE__ */ new Set(["sans-serif", "serif", "monospace", "system-ui", "ui-sans-serif", "ui-serif", "ui-monospace", "cursive", "fantasy", "-apple-system", "blinkmacsystemfont"]);
  var GENERIC_FALLBACKS = {
    sans: ["Inter", "Roboto", "Arial"],
    serif: ["Noto Serif", "Georgia", "Times New Roman", "Inter"],
    mono: ["Roboto Mono", "Source Code Pro", "Courier New", "Inter"]
  };
  function styleName(weight, italic) {
    const bold = weight >= 600;
    if (bold && italic) return "Bold Italic";
    if (bold) return "Bold";
    return italic ? "Italic" : "Regular";
  }
  function mappedFamily(stack, generic, rules) {
    if (!rules?.length) return null;
    const first = stack.find((f) => !GENERIC_KEYWORDS.has(f.toLowerCase()))?.toLowerCase();
    const aliases = { sans: ["sans", "sans-serif"], serif: ["serif"], mono: ["mono", "monospace"] };
    return rules.find((r) => first && r.match.toLowerCase() === first || aliases[generic].includes(r.match.toLowerCase())) ?? null;
  }
  function resolveFont(stack, generic, weight, italic, available, rule) {
    const wanted = styleName(weight, italic);
    const concrete = stack.filter((f) => !GENERIC_KEYWORDS.has(f.toLowerCase()));
    const first = concrete[0];
    if (rule) {
      for (const style of [wanted, "Regular"]) {
        if (available.has(`${rule.use}|${style}`)) {
          return { family: rule.use, style, fallback: rule.use !== first || style !== wanted, reason: `operator font map: ${rule.match} -> ${rule.use}${style !== wanted ? ` (style ${wanted} unavailable)` : ""}` };
        }
      }
    }
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

  // src/shared/imageInfo.ts
  function u32be(b, i) {
    return (b[i] << 24 >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
  }
  function inspectImage(b) {
    if (b.length >= 24 && b[0] === 137 && b[1] === 80 && b[2] === 78 && b[3] === 71 && b[4] === 13 && b[5] === 10 && b[6] === 26 && b[7] === 10) {
      if (u32be(b, 8) !== 13 || b[12] !== 73 || b[13] !== 72 || b[14] !== 68 || b[15] !== 82) return null;
      return { mime: "image/png", width: u32be(b, 16), height: u32be(b, 20) };
    }
    if (b.length >= 10 && b[0] === 71 && b[1] === 73 && b[2] === 70 && b[3] === 56 && (b[4] === 55 || b[4] === 57) && b[5] === 97) {
      return { mime: "image/gif", width: b[6] | b[7] << 8, height: b[8] | b[9] << 8 };
    }
    if (b.length >= 4 && b[0] === 255 && b[1] === 216) {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 255) return null;
        const m = b[i + 1];
        if (m === 216 || m === 1 || m >= 208 && m <= 215) {
          i += 2;
          continue;
        }
        const len = b[i + 2] << 8 | b[i + 3];
        if (len < 2) return null;
        if (m >= 192 && m <= 207 && m !== 196 && m !== 200 && m !== 204) {
          if (len < 8) return null;
          return { mime: "image/jpeg", height: b[i + 5] << 8 | b[i + 6], width: b[i + 7] << 8 | b[i + 8] };
        }
        i += 2 + len;
      }
      return null;
    }
    return null;
  }
  var K = new Uint32Array([
    1116352408,
    1899447441,
    3049323471,
    3921009573,
    961987163,
    1508970993,
    2453635748,
    2870763221,
    3624381080,
    310598401,
    607225278,
    1426881987,
    1925078388,
    2162078206,
    2614888103,
    3248222580,
    3835390401,
    4022224774,
    264347078,
    604807628,
    770255983,
    1249150122,
    1555081692,
    1996064986,
    2554220882,
    2821834349,
    2952996808,
    3210313671,
    3336571891,
    3584528711,
    113926993,
    338241895,
    666307205,
    773529912,
    1294757372,
    1396182291,
    1695183700,
    1986661051,
    2177026350,
    2456956037,
    2730485921,
    2820302411,
    3259730800,
    3345764771,
    3516065817,
    3600352804,
    4094571909,
    275423344,
    430227734,
    506948616,
    659060556,
    883997877,
    958139571,
    1322822218,
    1537002063,
    1747873779,
    1955562222,
    2024104815,
    2227730452,
    2361852424,
    2428436474,
    2756734187,
    3204031479,
    3329325298
  ]);
  function sha256Hex(data) {
    const h = new Uint32Array([1779033703, 3144134277, 1013904242, 2773480762, 1359893119, 2600822924, 528734635, 1541459225]);
    const bitLen = data.length * 8;
    const padded = new Uint8Array(data.length + 9 + 63 >> 6 << 6);
    padded.set(data);
    padded[data.length] = 128;
    const hi = Math.floor(bitLen / 4294967296);
    const lo = bitLen >>> 0;
    const n = padded.length;
    padded[n - 8] = hi >>> 24;
    padded[n - 7] = hi >>> 16 & 255;
    padded[n - 6] = hi >>> 8 & 255;
    padded[n - 5] = hi & 255;
    padded[n - 4] = lo >>> 24;
    padded[n - 3] = lo >>> 16 & 255;
    padded[n - 2] = lo >>> 8 & 255;
    padded[n - 1] = lo & 255;
    const w = new Uint32Array(64);
    for (let off = 0; off < n; off += 64) {
      for (let i = 0; i < 16; i++) w[i] = u32be(padded, off + i * 4);
      for (let i = 16; i < 64; i++) {
        const a2 = w[i - 15];
        const b2 = w[i - 2];
        const s0 = (a2 >>> 7 | a2 << 25) ^ (a2 >>> 18 | a2 << 14) ^ a2 >>> 3;
        const s1 = (b2 >>> 17 | b2 << 15) ^ (b2 >>> 19 | b2 << 13) ^ b2 >>> 10;
        w[i] = w[i - 16] + s0 + w[i - 7] + s1 >>> 0;
      }
      let [a, b, c, d, e, f, g, hh] = [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7]];
      for (let i = 0; i < 64; i++) {
        const S1 = (e >>> 6 | e << 26) ^ (e >>> 11 | e << 21) ^ (e >>> 25 | e << 7);
        const ch = e & f ^ ~e & g;
        const t1 = hh + S1 + ch + K[i] + w[i] >>> 0;
        const S0 = (a >>> 2 | a << 30) ^ (a >>> 13 | a << 19) ^ (a >>> 22 | a << 10);
        const maj = a & b ^ a & c ^ b & c;
        const t2 = S0 + maj >>> 0;
        hh = g;
        g = f;
        f = e;
        e = d + t1 >>> 0;
        d = c;
        c = b;
        b = a;
        a = t1 + t2 >>> 0;
      }
      h[0] = h[0] + a >>> 0;
      h[1] = h[1] + b >>> 0;
      h[2] = h[2] + c >>> 0;
      h[3] = h[3] + d >>> 0;
      h[4] = h[4] + e >>> 0;
      h[5] = h[5] + f >>> 0;
      h[6] = h[6] + g >>> 0;
      h[7] = h[7] + hh >>> 0;
    }
    return [...h].map((x) => x.toString(16).padStart(8, "0")).join("");
  }

  // plugin/src/hifi.ts
  var LABEL_FONT = { family: "Inter", style: "Regular" };
  var LABEL_BOLD = { family: "Inter", style: "Bold" };
  var MAX_LETTER_SPACING_RATIO = 0.25;
  function solid(p) {
    const n = parseInt(p.hex.slice(1), 16);
    return { type: "SOLID", color: { r: (n >> 16 & 255) / 255, g: (n >> 8 & 255) / 255, b: (n & 255) / 255 }, opacity: p.alpha };
  }
  function radii(n, r) {
    n.topLeftRadius = r[0];
    n.topRightRadius = r[1];
    n.bottomRightRadius = r[2];
    n.bottomLeftRadius = r[3];
  }
  function verifyAssets(doc) {
    const out = /* @__PURE__ */ new Map();
    for (const a of doc.assets) {
      const bytes = figma.base64Decode(a.dataBase64);
      if (bytes.length !== a.bytes) throw new Error(`Asset ${a.id}: decoded length ${bytes.length} != ${a.bytes}`);
      if (sha256Hex(bytes) !== a.sha256) throw new Error(`Asset ${a.id}: SHA-256 mismatch`);
      const info = inspectImage(bytes);
      if (!info || info.mime !== a.mime || info.width !== a.width || info.height !== a.height) throw new Error(`Asset ${a.id}: image header does not match its declared type/size`);
      out.set(a.id, bytes);
    }
    return out;
  }
  async function resolveFonts(doc) {
    const available = new Set((await figma.listAvailableFontsAsync()).map((f) => `${f.fontName.family}|${f.fontName.style}`));
    for (const f of [LABEL_FONT, LABEL_BOLD]) {
      try {
        await figma.loadFontAsync(f);
      } catch {
        throw new Error("Could not load Inter Regular/Bold for labels. Nothing was created.");
      }
    }
    const loaded = /* @__PURE__ */ new Set(["Inter|Regular", "Inter|Bold"]);
    const failedLoads = [];
    const byNode = /* @__PURE__ */ new Map();
    for (let round = 0; round < 6; round++) {
      const needed = /* @__PURE__ */ new Map();
      for (const list of [...doc.pages.map((p) => p.nodes), ...(doc.components ?? []).map((c) => c.nodes)]) {
        for (const n of list) {
          if (n.kind !== "text") continue;
          const r = resolveFont(n.fontStack, n.generic, n.weight, n.italic, available, mappedFamily(n.fontStack, n.generic, doc.fontMap));
          if (!r) throw new Error(`No loadable font for "${n.fontStack.join(", ")}" (not even Inter). Nothing was created.`);
          byNode.set(n, r);
          const key = `${r.family}|${r.style}`;
          if (!loaded.has(key)) needed.set(key, { family: r.family, style: r.style });
        }
      }
      if (needed.size === 0) return { byNode, failedLoads };
      for (const [key, font] of needed) {
        try {
          await figma.loadFontAsync(font);
          loaded.add(key);
        } catch {
          available.delete(key);
          if (failedLoads.length < 10) failedLoads.push(`${font.family} ${font.style} failed to load`);
        }
      }
    }
    throw new Error("Font resolution did not settle. Nothing was created.");
  }
  function label(track2, parent, chars, size, bold, x, y, width) {
    const t = track2(figma.createText());
    parent.appendChild(t);
    t.fontName = bold ? LABEL_BOLD : LABEL_FONT;
    t.characters = chars;
    t.fontSize = size;
    t.x = x;
    t.y = y;
    if (width) {
      t.resize(width, t.height);
      t.textAutoResize = "HEIGHT";
    }
    return t;
  }
  function buildBox(track2, parent, b, buttonLabel, off, prefix) {
    const n = b.role === "button" ? track2(figma.createFrame()) : track2(figma.createRectangle());
    parent.appendChild(n);
    n.name = `${prefix}${b.role === "button" ? `Button / ${buttonLabel ?? "untitled"}` : b.name}`;
    n.x = b.x - off.x;
    n.y = b.y - off.y;
    n.resize(Math.max(0.01, b.w), Math.max(0.01, b.h));
    n.fills = b.fill ? [solid(b.fill)] : [];
    if (b.border) {
      n.strokes = [solid(b.border.color)];
      n.strokeWeight = b.border.weight;
      n.strokeAlign = "INSIDE";
    } else n.strokes = [];
    radii(n, b.radius);
    n.opacity = b.opacity;
    if (n.type === "FRAME") n.clipsContent = false;
    n.setPluginData("w2f", JSON.stringify({ prov: b.prov, role: b.role }));
    return n;
  }
  function buildImage(track2, parent, im, hashes, off, prefix) {
    const r = track2(figma.createRectangle());
    parent.appendChild(r);
    r.x = im.x - off.x;
    r.y = im.y - off.y;
    r.resize(Math.max(0.01, im.w), Math.max(0.01, im.h));
    radii(r, im.radius);
    const hash = im.assetId ? hashes.get(im.assetId) : void 0;
    if (hash) {
      r.name = `${prefix}${im.name}`;
      r.fills = [{ type: "IMAGE", imageHash: hash, scaleMode: im.fit === "fit" ? "FIT" : "FILL" }];
      r.setPluginData("w2f", JSON.stringify({ prov: im.prov, assetId: im.assetId }));
      return true;
    }
    r.name = `${prefix}MISSING IMAGE / ${im.name}`;
    r.fills = [{ type: "SOLID", color: { r: 0.93, g: 0.93, b: 0.93 } }];
    r.strokes = [{ type: "SOLID", color: { r: 0.8, g: 0.2, b: 0.2 } }];
    r.strokeWeight = 1;
    r.dashPattern = [6, 4];
    r.setPluginData("w2f", JSON.stringify({ prov: im.prov, missing: true }));
    return false;
  }
  async function buildShape(track2, parent, sh, off, prefix) {
    const name = `${prefix}${sh.name}`;
    if (sh.shape === "ellipse") {
      const e = track2(figma.createEllipse());
      parent.appendChild(e);
      e.name = name;
      e.x = sh.x - off.x;
      e.y = sh.y - off.y;
      e.resize(Math.max(0.01, sh.w), Math.max(0.01, sh.h));
      e.fills = sh.fill ? [solid(sh.fill)] : [];
      e.strokes = sh.stroke ? [solid(sh.stroke.color)] : [];
      if (sh.stroke) e.strokeWeight = sh.stroke.weight;
      e.setPluginData("w2f", JSON.stringify({ prov: sh.prov, approximation: true }));
      return;
    }
    const v = track2(figma.createVector());
    parent.appendChild(v);
    v.name = name;
    const { w, h } = sh;
    if (sh.shape === "caret") {
      await v.setVectorNetworkAsync({
        vertices: [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w / 2, y: h }],
        segments: [{ start: 0, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 0 }],
        regions: [{ windingRule: "NONZERO", loops: [[0, 1, 2]] }]
      });
      v.fills = sh.fill ? [solid(sh.fill)] : [];
      v.strokes = [];
    } else {
      await v.setVectorNetworkAsync({
        vertices: [{ x: w * 0.2, y: h }, { x: w, y: h * 0.2 }, { x: w * 0.5, y: h }, { x: w, y: h * 0.5 }, { x: w * 0.8, y: h }, { x: w, y: h * 0.8 }],
        segments: [{ start: 0, end: 1 }, { start: 2, end: 3 }, { start: 4, end: 5 }],
        regions: []
      });
      v.fills = [];
      v.strokes = sh.stroke ? [solid(sh.stroke.color)] : [];
      if (sh.stroke) v.strokeWeight = sh.stroke.weight;
    }
    v.x = sh.x - off.x;
    v.y = sh.y - off.y;
    v.setPluginData("w2f", JSON.stringify({ prov: sh.prov, approximation: true }));
  }
  function buildSvg(track2, parent, sv, off, prefix) {
    if (!isCanonicalSvg(sv.markup)) return false;
    const f = track2(figma.createNodeFromSvg(sv.markup));
    parent.appendChild(f);
    f.name = `${prefix}${sv.name}`;
    f.x = sv.x - off.x;
    f.y = sv.y - off.y;
    f.setPluginData("w2f", JSON.stringify({ prov: sv.prov, sanitized: true }));
    return true;
  }
  function buildText(track2, parent, t, font, offset, prefix) {
    const n = track2(figma.createText());
    parent.appendChild(n);
    n.name = `${prefix}${t.name}`;
    n.fontName = { family: font.family, style: font.style };
    n.characters = t.text;
    n.fontSize = t.size;
    n.lineHeight = { unit: "PIXELS", value: t.lineHeight };
    n.fills = [solid(t.color)];
    n.textDecoration = t.decoration === "underline" ? "UNDERLINE" : t.decoration === "strike" ? "STRIKETHROUGH" : "NONE";
    n.x = t.x - offset.x;
    n.y = t.y - offset.y;
    if (t.align === "right") {
      n.textAutoResize = "HEIGHT";
      n.resize(Math.max(1, t.w), n.height);
      n.textAlignHorizontal = "RIGHT";
    } else n.textAutoResize = "WIDTH_AND_HEIGHT";
    let result = "not-fitted";
    if (t.prov === "measured" && t.fit !== false && t.align !== "right" && t.graphemes > 1 && t.w > 0) {
      const ls = (t.w - n.width) / (t.graphemes - 1);
      if (Math.abs(ls) <= t.size * MAX_LETTER_SPACING_RATIO) {
        n.letterSpacing = { unit: "PIXELS", value: ls };
        result = "fitted";
      } else result = "unfitted";
    }
    n.setPluginData("w2f", JSON.stringify({ prov: t.prov, fit: result, font: `${font.family} ${font.style}`, fallback: font.fallback, reason: font.reason, measuredStack: t.fontStack }));
    return result;
  }
  async function renderNodes(track2, parent, nodes, clipGroups, fonts, hashes, stats, prefix) {
    const zero = { x: 0, y: 0 };
    const clipFrames = [];
    const buttonFrames = /* @__PURE__ */ new Map();
    let unfitted = 0;
    const clipOf = (n) => n.clip !== void 0 && n.clip >= 0 ? n.clip : -1;
    const place = async (n, i, target, off) => {
      if (n.kind === "box") {
        const labelText = n.role === "button" ? nodes.find((t) => t.kind === "text" && t.button === i)?.text.trim() ?? null : null;
        const built = buildBox(track2, target, n, labelText, off, prefix(i));
        if (built.type === "FRAME") buttonFrames.set(i, built);
      } else if (n.kind === "image") {
        if (buildImage(track2, target, n, hashes, off, prefix(i))) stats.images++;
        else stats.placeholders++;
      } else if (n.kind === "shape") {
        await buildShape(track2, target, n, off, prefix(i));
        stats.shapes++;
      } else if (n.kind === "svg") {
        if (buildSvg(track2, target, n, off, prefix(i))) stats.svgs++;
      }
    };
    for (const [i, n] of nodes.entries()) if (n.kind !== "text" && clipOf(n) < 0) await place(n, i, parent, zero);
    for (const c of clipGroups) {
      const f = track2(figma.createFrame());
      parent.appendChild(f);
      f.name = c.name;
      f.x = c.x;
      f.y = c.y;
      f.resize(Math.max(0.01, c.w), Math.max(0.01, c.h));
      f.fills = [];
      f.clipsContent = true;
      clipFrames.push(f);
    }
    for (const [i, n] of nodes.entries()) {
      const ci = clipOf(n);
      if (n.kind !== "text" && ci >= 0) await place(n, i, clipFrames[ci], clipGroups[ci]);
    }
    for (const [i, n] of nodes.entries()) {
      if (n.kind !== "text") continue;
      const font = fonts.get(n);
      const button = n.button >= 0 ? buttonFrames.get(n.button) : void 0;
      const ci = clipOf(n);
      const box = n.button >= 0 ? nodes[n.button] : null;
      const target = button ?? (ci >= 0 ? clipFrames[ci] : parent);
      const off = button && box ? { x: box.x, y: box.y } : ci >= 0 ? clipGroups[ci] : zero;
      const r = buildText(track2, target, n, font, off, prefix(i));
      if (r === "fitted") stats.fitted++;
      if (r === "unfitted") unfitted++;
      if (font.fallback) stats.fontFallbacks++;
    }
    stats.nodes += nodes.length;
    return unfitted;
  }
  function fontLines(nodes, fonts) {
    const subs = /* @__PURE__ */ new Map();
    for (const n of nodes) {
      if (n.kind !== "text") continue;
      const f = fonts.get(n);
      if (f.fallback) {
        const k = `"${n.fontStack.join(", ") || "(none)"}" ${n.weight >= 600 ? "bold" : "regular"}${n.italic ? " italic" : ""} -> ${f.family} ${f.style}${f.reason.startsWith("operator font map") ? " (operator font map)" : ""}`;
        subs.set(k, (subs.get(k) ?? 0) + 1);
      }
    }
    const lines = [...subs].slice(0, 8).map(([k, count]) => `Font fallback (${count} run${count === 1 ? "" : "s"}): ${k}`);
    if (subs.size > 8) lines.push(`Font fallback: ${subs.size - 8} more substitution(s) not listed`);
    return lines;
  }
  async function buildPage(track2, section, page, y, fonts, hashes, doc, failedLoads, stats, componentNodes) {
    const x0 = 80;
    const ref = page.referenceAssetId ? doc.assets.find((a) => a.id === page.referenceAssetId) : void 0;
    const notes = [
      `${page.title} \u2014 ${page.url}`,
      `Measured absolute desktop snapshot (${page.width}\xD7${page.height}px). Editable, not responsive, not pixel-perfect.`,
      ...page.truncated ? ["TRUNCATED: see warnings below."] : [],
      ...(page.notes ?? []).map((n) => `Note: ${n}`),
      ...page.warnings.map((w) => `Warning: ${w}`),
      ...fontLines(page.nodes, fonts),
      ...failedLoads.map((f) => `Font load failure: ${f}`),
      ...page.instances?.length ? [`Shared components: ${page.instances.length} instance(s) (${page.instances.map((i) => `${i.component}${i.overrides.length ? ` with ${i.overrides.length} override(s)` : ""}`).join(", ")})`] : [],
      ...page.branding ? [`Branding (page-level, not per-element): ${Object.entries(page.branding.colors).map(([k, v]) => `${k} ${v}`).join(", ")}${page.branding.fonts.length ? `; fonts ${page.branding.fonts.join(", ")}` : ""}`] : []
    ];
    const head = label(track2, section, notes.join("\n"), 14, false, x0, y, Math.max(600, page.width));
    head.name = `Notes / ${page.path}`;
    const top = y + head.height + 24;
    const frame = track2(figma.createFrame());
    section.appendChild(frame);
    frame.name = `Page / ${page.path} (editable, measured)`;
    frame.x = x0;
    frame.y = top;
    frame.resize(page.width, page.height);
    frame.fills = [];
    frame.clipsContent = true;
    frame.setPluginData("w2f", JSON.stringify({ url: page.url, truncated: page.truncated }));
    const unfitted = await renderNodes(track2, frame, page.nodes, page.clips ?? [], fonts, hashes, stats, () => "");
    for (const ins of page.instances ?? []) {
      const comp = componentNodes.get(ins.component);
      if (!comp) continue;
      const inst = track2(comp.createInstance());
      frame.appendChild(inst);
      inst.x = ins.x;
      inst.y = ins.y;
      for (const o of ins.overrides) {
        const target = inst.findOne((n) => n.name.startsWith(`#${o.index} `));
        if (!target || !("fills" in target)) continue;
        if (o.fill !== void 0) target.fills = o.fill ? [solid(o.fill)] : [];
        if (o.color) {
          if (target.type === "TEXT") target.fills = [solid(o.color)];
          else target.strokes = [solid(o.color)];
        }
      }
      stats.instances++;
    }
    if (unfitted) {
      head.characters = head.characters + `
Width fit skipped for ${unfitted} measured text run(s) (difference too large); natural width kept.`;
      stats.unfitted += unfitted;
    }
    let bottom = top + page.height;
    if (ref) {
      const rx = x0 + page.width + 80;
      label(track2, section, `Reference screenshot (image, not editable; ${ref.width}\xD7${ref.height}px at 1:1)`, 14, true, rx, top - 24);
      const r = track2(figma.createRectangle());
      section.appendChild(r);
      r.name = `Reference / ${page.path}`;
      r.x = rx;
      r.y = top;
      r.resize(ref.width, ref.height);
      r.fills = [{ type: "IMAGE", imageHash: hashes.get(ref.id), scaleMode: "FILL" }];
      r.setPluginData("w2f", JSON.stringify({ reference: true, sha256: ref.sha256 }));
      bottom = Math.max(bottom, top + ref.height);
    } else if (page.referenceTiles) {
      const rt = page.referenceTiles;
      const rx = x0 + page.width + 80;
      label(track2, section, `Reference screenshot (image, not editable; ${rt.sourceWidth}\xD7${rt.sourceHeight}px at 1:1, ${rt.tiles.length} tiles)`, 14, true, rx, top - 24);
      const holder = track2(figma.createFrame());
      section.appendChild(holder);
      holder.name = `Reference / ${page.path} (${rt.tiles.length} tiles)`;
      holder.x = rx;
      holder.y = top;
      holder.resize(rt.sourceWidth, rt.sourceHeight);
      holder.fills = [];
      holder.clipsContent = true;
      holder.setPluginData("w2f", JSON.stringify({ reference: true, tiled: true, sourceSha256: rt.sourceSha256 }));
      for (const [i, t] of rt.tiles.entries()) {
        const asset = doc.assets.find((a) => a.id === t.assetId);
        const r = track2(figma.createRectangle());
        holder.appendChild(r);
        r.name = `Reference tile ${i + 1}/${rt.tiles.length} (y ${t.y})`;
        r.x = 0;
        r.y = t.y;
        r.resize(rt.sourceWidth, t.h);
        r.fills = [{ type: "IMAGE", imageHash: hashes.get(asset.id), scaleMode: "FILL" }];
        r.setPluginData("w2f", JSON.stringify({ referenceTile: i, y: t.y, h: t.h, tileSha256: asset.sha256, sourceSha256: rt.sourceSha256 }));
      }
      bottom = Math.max(bottom, top + rt.sourceHeight);
    }
    return { bottom, frame };
  }
  async function edge(track2, section, from, to) {
    const gx = 40;
    const pts = [
      { x: from.x, y: from.y + 20 },
      { x: gx, y: from.y + 20 },
      { x: gx, y: to.y + 20 },
      { x: to.x, y: to.y + 20 }
    ];
    const minX = Math.min(...pts.map((p) => p.x));
    const minY = Math.min(...pts.map((p) => p.y));
    const v = track2(figma.createVector());
    section.appendChild(v);
    v.name = `Sitemap edge / ${from.name} -> ${to.name}`;
    await v.setVectorNetworkAsync({
      vertices: pts.map((p, i) => i === pts.length - 1 ? { x: p.x - minX, y: p.y - minY, strokeCap: "ARROW_LINES" } : { x: p.x - minX, y: p.y - minY }),
      segments: [{ start: 0, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 3 }],
      regions: []
    });
    v.x = minX;
    v.y = minY;
    v.strokes = [{ type: "SOLID", color: { r: 0.6, g: 0.6, b: 0.6 } }];
    v.strokeWeight = 2;
    v.fills = [];
    return v;
  }
  async function buildHifiDoc(doc, track2, created, originX) {
    const bytes = verifyAssets(doc);
    const { byNode, failedLoads } = await resolveFonts(doc);
    const hashes = /* @__PURE__ */ new Map();
    for (const [id, b] of bytes) hashes.set(id, figma.createImage(b).hash);
    const stats = { pages: 0, nodes: 0, images: 0, placeholders: 0, fontFallbacks: 0, fitted: 0, unfitted: 0, shapes: 0, svgs: 0, components: 0, instances: 0, edges: 0, warnings: [...doc.warnings] };
    const section = track2(figma.createSection());
    created.push(section);
    section.name = `website-to-figma \xB7 Hi-fi (measured) \xB7 ${doc.site.host}`;
    section.x = originX;
    section.y = 0;
    const intro = [
      `Source: ${doc.source.label} (${doc.source.mode}). ${doc.provenance.notes.join(" ")}`,
      ...doc.fontMap?.length ? [`Operator font map: ${doc.fontMap.map((f) => `${f.match} -> ${f.use}`).join(", ")}`] : [],
      ...doc.warnings.map((w) => `Warning: ${w}`),
      "Not affiliated with Figma or the site owner. Not pixel-perfect."
    ];
    const title = label(track2, section, `Hi-fi import \xB7 ${doc.site.host}`, 28, true, 80, 40);
    const info = label(track2, section, intro.join("\n"), 14, false, 80, 40 + title.height + 8, 1200);
    let y = info.y + info.height + 60;
    let maxRight = 1300;
    const componentNodes = /* @__PURE__ */ new Map();
    if (doc.components?.length) {
      label(track2, section, "Shared components (identical structure on 2+ pages; per-page paint differences are instance overrides)", 14, true, 80, y);
      y += 30;
      for (const c of doc.components) {
        const comp = track2(figma.createComponent());
        section.appendChild(comp);
        comp.name = c.name;
        comp.x = 80;
        comp.y = y;
        comp.resize(Math.max(1, c.w), Math.max(1, c.h));
        comp.fills = [];
        comp.clipsContent = false;
        await renderNodes(track2, comp, c.nodes, [], byNode, hashes, stats, (i) => `#${i} `);
        componentNodes.set(c.id, comp);
        stats.components++;
        y += c.h + 60;
        maxRight = Math.max(maxRight, 80 + c.w + 80);
      }
      y += 60;
    }
    const frames = /* @__PURE__ */ new Map();
    for (const page of doc.pages) {
      const r = await buildPage(track2, section, page, y, byNode, hashes, doc, failedLoads, stats, componentNodes);
      frames.set(page.id, r.frame);
      y = r.bottom + 120;
      const ref = page.referenceAssetId ? doc.assets.find((a) => a.id === page.referenceAssetId) : void 0;
      maxRight = Math.max(maxRight, 80 + page.width + 80 + (ref ? ref.width : page.referenceTiles ? page.referenceTiles.sourceWidth : 0) + 80);
      stats.pages++;
    }
    const edges = [];
    for (const page of doc.pages) {
      const from = page.parentId ? frames.get(page.parentId) : void 0;
      const to = frames.get(page.id);
      if (from && to) edges.push(await edge(track2, section, from, to));
    }
    if (edges.length) {
      const g = track2(figma.group(edges, section, 0));
      g.name = "Sitemap edges (vectors, URL path hierarchy)";
      stats.edges = edges.length;
    }
    section.resizeWithoutConstraints(maxRight, y);
    if (stats.fontFallbacks) stats.warnings.push(`Font fallback used for ${stats.fontFallbacks} text run(s); see each page's notes`);
    for (const f of failedLoads) stats.warnings.push(`Font load failure: ${f}`);
    if (stats.unfitted) stats.warnings.push(`Width fit skipped for ${stats.unfitted} text run(s)`);
    for (const p of doc.pages) if (p.truncated) stats.warnings.push(`Page ${p.path} is truncated; see its notes`);
    if (stats.placeholders) stats.warnings.push(`${stats.placeholders} image(s) shown as MISSING IMAGE placeholders`);
    return stats;
  }

  // src/shared/text.ts
  function fnv1a(input) {
    let h = 2166136261;
    for (let i = 0; i < input.length; i++) {
      h ^= input.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16).padStart(8, "0");
  }

  // src/shared/layout.ts
  function navSignature(nav) {
    return "nav-" + fnv1a(["nav", ...nav.items].join("\x1f"));
  }
  function footerSignature(footer) {
    return "footer-" + fnv1a(["footer", ...footer.items, "\x1e", footer.text].join("\x1f"));
  }
  function cardShape(card) {
    if (card.title && card.text) return "title+text";
    return card.title ? "title" : "text";
  }
  function group(pages, get, sig) {
    const groups = /* @__PURE__ */ new Map();
    const byPage = /* @__PURE__ */ new Map();
    for (const p of pages) {
      const content = get(p);
      if (!content) continue;
      const s = sig(content);
      byPage.set(p.id, s);
      const g = groups.get(s);
      if (g) g.pageIds.push(p.id);
      else groups.set(s, { signature: s, content, pageIds: [p.id], isComponent: false });
    }
    const list = [...groups.values()];
    for (const g of list) g.isComponent = g.pageIds.length >= 2;
    return { list, byPage };
  }
  function planComponents(pages) {
    const navs = group(pages, (p) => p.nav, navSignature);
    const footers = group(pages, (p) => p.footer, footerSignature);
    const counts = /* @__PURE__ */ new Map();
    for (const p of pages) {
      for (const b of p.blocks) {
        if (b.type !== "cards") continue;
        for (const c of b.cards) counts.set(cardShape(c), (counts.get(cardShape(c)) ?? 0) + 1);
      }
    }
    const order = ["title+text", "title", "text"];
    const cardShapes = order.filter((s) => counts.has(s)).map((shape) => ({ shape, count: counts.get(shape), isComponent: counts.get(shape) >= 2 }));
    return { navs: navs.list, footers: footers.list, cardShapes, navByPage: navs.byPage, footerByPage: footers.byPage };
  }
  var COLUMN_GAP = 160;
  var ROW_GAP = 80;
  var ANCHOR_Y = 40;
  function placeSitemap(pages, sizes, origin) {
    const children = /* @__PURE__ */ new Map();
    for (const p of pages) {
      if (p.parentId === null) continue;
      const list = children.get(p.parentId) ?? [];
      list.push(p);
      children.set(p.parentId, list);
    }
    const maxDepth = pages.reduce((m, p) => Math.max(m, p.depth), 0);
    const colWidth = new Array(maxDepth + 1).fill(0);
    for (const p of pages) colWidth[p.depth] = Math.max(colWidth[p.depth], sizeOf(sizes, p.id).w);
    const colX = [];
    let x = origin.x;
    for (let d = 0; d <= maxDepth; d++) {
      colX.push(x);
      x += colWidth[d] + COLUMN_GAP;
    }
    const frames = /* @__PURE__ */ new Map();
    const cursor = new Array(maxDepth + 1).fill(origin.y);
    const visit = (p, parentY) => {
      const s = sizeOf(sizes, p.id);
      const y = Math.max(cursor[p.depth], parentY);
      frames.set(p.id, { x: colX[p.depth], y, w: s.w, h: s.h });
      cursor[p.depth] = y + s.h + ROW_GAP;
      for (const c of children.get(p.id) ?? []) visit(c, y);
    };
    const root = pages.find((p) => p.parentId === null);
    if (root) visit(root, origin.y);
    const edges = [];
    for (const p of pages) {
      if (p.parentId === null) continue;
      const a = frames.get(p.parentId);
      const b = frames.get(p.id);
      if (!a || !b) continue;
      const start = { x: a.x + a.w, y: a.y + Math.min(ANCHOR_Y, a.h / 2) };
      const end = { x: b.x, y: b.y + Math.min(ANCHOR_Y, b.h / 2) };
      const midX = colX[p.depth] - COLUMN_GAP / 2;
      const raw = [start, { x: midX, y: start.y }, { x: midX, y: end.y }, end];
      edges.push({ from: p.parentId, to: p.id, points: raw.filter((pt, i) => i === 0 || pt.x !== raw[i - 1].x || pt.y !== raw[i - 1].y) });
    }
    let maxX = origin.x;
    let maxY = origin.y;
    for (const r of frames.values()) {
      maxX = Math.max(maxX, r.x + r.w);
      maxY = Math.max(maxY, r.y + r.h);
    }
    return { frames, edges, bounds: { x: origin.x, y: origin.y, w: maxX - origin.x, h: maxY - origin.y } };
  }
  function sizeOf(sizes, id) {
    const s = sizes.get(id);
    if (!s || !(s.w > 0) || !(s.h > 0)) throw new Error(`Missing size for page ${id}`);
    return s;
  }
  function placeRow(sizes, origin, maxWidth, gap = 60) {
    const rects = [];
    let x = origin.x;
    let y = origin.y;
    let rowH = 0;
    for (const s of sizes) {
      if (x > origin.x && x + s.w > origin.x + maxWidth) {
        x = origin.x;
        y += rowH + gap;
        rowH = 0;
      }
      rects.push({ x, y, w: s.w, h: s.h });
      x += s.w + gap;
      rowH = Math.max(rowH, s.h);
    }
    let maxX = origin.x;
    let maxY = origin.y;
    for (const r of rects) {
      maxX = Math.max(maxX, r.x + r.w);
      maxY = Math.max(maxY, r.y + r.h);
    }
    return { rects, bounds: { x: origin.x, y: origin.y, w: maxX - origin.x, h: maxY - origin.y } };
  }

  // plugin/src/code.ts
  var PAGE_W = 480;
  var PAD = 16;
  var INNER_W = PAGE_W - PAD * 2;
  var CARD_W = 136;
  var SECTION_PAD = 80;
  var AREA_GAP = 240;
  var FONT_REGULAR = { family: "Inter", style: "Regular" };
  var FONT_BOLD = { family: "Inter", style: "Bold" };
  var grey = (v) => ({ type: "SOLID", color: { r: v, g: v, b: v } });
  var BG = grey(1);
  var PANEL = grey(0.9);
  var BLOCK = grey(0.82);
  var INK = grey(0.25);
  var MUTED = grey(0.5);
  var LINE = grey(0.6);
  var tracked = null;
  function track(node) {
    tracked?.push(node);
    return node;
  }
  function post(msg) {
    figma.ui.postMessage(msg);
  }
  figma.showUI(__html__, { width: 400, height: 480, themeColors: true });
  var busy = false;
  function readMessage(raw) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const m = raw;
    const keys = Object.keys(m);
    if (m.type === "close" && keys.length === 1) return { type: "close" };
    if (m.type === "import" && keys.length === 2 && typeof m.json === "string" && m.json.length <= LIMITS.hifiMaxJsonBytes) {
      return { type: "import", json: m.json };
    }
    return null;
  }
  figma.ui.onmessage = async (raw) => {
    const msg = readMessage(raw);
    if (!msg) {
      post({ type: "error", text: "Ignored an unexpected message from the plugin UI." });
      return;
    }
    if (msg.type === "close") {
      if (busy) {
        post({ type: "error", text: "An import is running; close is disabled until it finishes." });
        return;
      }
      figma.closePlugin();
      return;
    }
    if (busy) {
      post({ type: "error", text: "An import is already running." });
      return;
    }
    busy = true;
    try {
      const result = parseImportJson(msg.json);
      if (!result.ok) {
        post({ type: "error", text: "JSON rejected by the website-to-figma schema validator. Nothing was created.", details: result.errors.slice(0, 12) });
        return;
      }
      if (result.version === 2) {
        post({ type: "status", text: "Valid hi-fi document. Verifying images, loading fonts and building frames..." });
        const h = await buildV2(result.doc);
        post({
          type: "done",
          text: `Created ${h.pages} hi-fi page(s): ${h.nodes} measured node(s), ${h.images} image fill(s), ${h.placeholders} missing-image placeholder(s), ${h.fitted} width-fitted text run(s).`,
          details: h.warnings
        });
        return;
      }
      post({ type: "status", text: "Valid. Loading fonts and building frames..." });
      const stats = await build(result.doc);
      post({
        type: "done",
        text: `Created ${stats.pages} page frame(s), ${stats.components} component(s), ${stats.instances} instance(s) and ${stats.edges} edge(s).`,
        details: stats.warnings
      });
    } catch (err) {
      post({ type: "error", text: `Import failed: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      busy = false;
    }
  };
  function text(chars, size, bold = false, color = INK) {
    const t = track(figma.createText());
    t.fontName = bold ? FONT_BOLD : FONT_REGULAR;
    t.characters = chars;
    t.fontSize = size;
    t.fills = [color];
    return t;
  }
  function appendFill(parent, child) {
    parent.appendChild(child);
    child.layoutSizingHorizontal = "FILL";
    if (child.type === "TEXT") child.textAutoResize = "HEIGHT";
  }
  function autoLayout(node, dir, spacing, pad, fill) {
    node.layoutMode = dir;
    node.itemSpacing = spacing;
    node.paddingTop = node.paddingBottom = node.paddingLeft = node.paddingRight = pad;
    node.fills = fill ? [fill] : [];
    node.clipsContent = false;
  }
  function placeholder(name, w, h) {
    const r = track(figma.createRectangle());
    r.name = name;
    r.resize(w, h);
    r.fills = [BLOCK];
    return r;
  }
  function fillNav(node, nav) {
    autoLayout(node, "HORIZONTAL", 12, 8, PANEL);
    node.counterAxisAlignItems = "CENTER";
    node.resize(INNER_W, 32);
    node.primaryAxisSizingMode = "FIXED";
    node.counterAxisSizingMode = "AUTO";
    node.appendChild(placeholder("Logo", 24, 16));
    for (const item of nav.items) {
      const t = text(item, 11);
      t.name = "Nav item";
      node.appendChild(t);
    }
  }
  function fillFooter(node, footer) {
    autoLayout(node, "VERTICAL", 6, 10, PANEL);
    node.resize(INNER_W, 40);
    node.counterAxisSizingMode = "FIXED";
    node.primaryAxisSizingMode = "AUTO";
    if (footer.items.length > 0) {
      const row = track(figma.createFrame());
      node.appendChild(row);
      row.name = "Footer links";
      autoLayout(row, "HORIZONTAL", 10, 0, null);
      row.layoutSizingHorizontal = "FILL";
      row.layoutSizingVertical = "HUG";
      row.layoutWrap = "WRAP";
      row.counterAxisSpacing = 4;
      for (const item of footer.items) row.appendChild(text(item, 10, false, MUTED));
    }
    if (footer.text) {
      const t = text(footer.text, 10, false, MUTED);
      t.name = "Footer text";
      appendFill(node, t);
    }
  }
  function fillCard(node, shape, card) {
    autoLayout(node, "VERTICAL", 4, 8, PANEL);
    node.resize(CARD_W, 60);
    node.counterAxisSizingMode = "FIXED";
    node.primaryAxisSizingMode = "AUTO";
    node.strokes = [LINE];
    node.strokeWeight = 1;
    const img = placeholder("Image", CARD_W - 16, 48);
    appendFill(node, img);
    if (shape !== "text") {
      const t = text(card.title || "Card title", 11, true);
      t.name = "Card title";
      appendFill(node, t);
    }
    if (shape !== "title") {
      const t = text(card.text || "Card text", 10, false, MUTED);
      t.name = "Card text";
      appendFill(node, t);
    }
  }
  function existingContentRight() {
    let right = -Infinity;
    for (const n of figma.currentPage.children) {
      if ("x" in n && "width" in n) right = Math.max(right, n.x + n.width);
    }
    return Number.isFinite(right) ? right + AREA_GAP : 0;
  }
  function sectionTitle(section, title, subtitle) {
    const h = text(title, 24, true);
    h.name = "Area title";
    section.appendChild(h);
    h.x = SECTION_PAD;
    h.y = SECTION_PAD / 2;
    const s = text(subtitle, 12, false, MUTED);
    s.name = "Area note";
    section.appendChild(s);
    s.resize(1100, s.height);
    s.textAutoResize = "HEIGHT";
    s.x = SECTION_PAD;
    s.y = h.y + h.height + 8;
    return s.y + s.height + 40;
  }
  async function buildV2(doc) {
    const created = [];
    const all = [];
    tracked = all;
    try {
      const stats = await buildHifiDoc(doc, track, created, existingContentRight());
      figma.currentPage.selection = created;
      figma.viewport.scrollAndZoomIntoView(created);
      return stats;
    } catch (err) {
      for (let i = all.length - 1; i >= 0; i--) {
        const n = all[i];
        try {
          if (!n.removed) n.remove();
        } catch {
        }
      }
      throw err;
    } finally {
      tracked = null;
    }
  }
  async function build(doc) {
    try {
      await Promise.all([figma.loadFontAsync(FONT_REGULAR), figma.loadFontAsync(FONT_BOLD)]);
    } catch {
      throw new Error("Could not load Inter Regular/Bold. Nothing was created.");
    }
    const warnings = [];
    const created = [];
    const all = [];
    tracked = all;
    try {
      return await buildInner(doc, warnings, created);
    } catch (err) {
      for (let i = all.length - 1; i >= 0; i--) {
        const n = all[i];
        try {
          if (!n.removed) n.remove();
        } catch {
        }
      }
      throw err;
    } finally {
      tracked = null;
    }
  }
  async function buildInner(doc, warnings, created) {
    const plan = planComponents(doc.pages);
    const host = doc.site.host;
    const originX = existingContentRight();
    const sourceLabel = doc.source.mode === "fixture" ? `${doc.source.label} (${doc.source.fixtureId})` : `Firecrawl crawl of ${doc.source.startUrl}`;
    const k = doc.crawl;
    const crawlLine = `${k.returnedCount} page(s), limit ${k.requestedLimit}, discovered ${k.discoveredCount ?? "unknown"}, truncated: ${k.truncated}, incomplete: ${k.incomplete}.`;
    if (k.truncated) warnings.push("Source JSON is truncated (page cap reached).");
    if (k.incomplete) warnings.push("Source JSON is marked incomplete; see notes in the Sitemap area.");
    const navComponents = /* @__PURE__ */ new Map();
    const footerComponents = /* @__PURE__ */ new Map();
    const cardComponents = /* @__PURE__ */ new Map();
    const componentNodes = [];
    let componentsBottom = 0;
    const anyComponents = plan.navs.some((g) => g.isComponent) || plan.footers.some((g) => g.isComponent) || plan.cardShapes.some((g) => g.isComponent);
    if (anyComponents) {
      const section = track(figma.createSection());
      created.push(section);
      section.name = `website-to-figma \xB7 Components (generated, low-fi) \xB7 ${host}`;
      section.x = originX;
      section.y = 0;
      const top2 = sectionTitle(
        section,
        "Components (generated by website-to-figma)",
        "Only structures that repeat with identical content (nav, footer) or identical shape (card) become components. Low-fidelity placeholders, not pixel-accurate."
      );
      let i = 0;
      for (const g of plan.navs) {
        if (!g.isComponent) continue;
        const c = track(figma.createComponent());
        section.appendChild(c);
        c.name = `Nav ${String.fromCharCode(65 + i++)} \xB7 ${g.content.items.length} links \xB7 used on ${g.pageIds.length} pages \xB7 ${g.signature}`;
        fillNav(c, g.content);
        navComponents.set(g.signature, c);
        componentNodes.push(c);
      }
      i = 0;
      for (const g of plan.footers) {
        if (!g.isComponent) continue;
        const c = track(figma.createComponent());
        section.appendChild(c);
        c.name = `Footer ${String.fromCharCode(65 + i++)} \xB7 used on ${g.pageIds.length} pages \xB7 ${g.signature}`;
        fillFooter(c, g.content);
        footerComponents.set(g.signature, c);
        componentNodes.push(c);
      }
      for (const g of plan.cardShapes) {
        if (!g.isComponent) continue;
        const c = track(figma.createComponent());
        section.appendChild(c);
        c.name = `Card \xB7 ${g.shape} \xB7 ${g.count} uses`;
        fillCard(c, g.shape, { title: "", text: "" });
        cardComponents.set(g.shape, c);
        componentNodes.push(c);
      }
      const row = placeRow(
        componentNodes.map((c) => ({ w: c.width, h: c.height })),
        { x: SECTION_PAD, y: top2 },
        1400
      );
      componentNodes.forEach((c, idx) => {
        c.x = row.rects[idx].x;
        c.y = row.rects[idx].y;
      });
      const width = Math.max(row.bounds.x + row.bounds.w, 1180) + SECTION_PAD;
      section.resizeWithoutConstraints(width, row.bounds.y + row.bounds.h + SECTION_PAD);
      componentsBottom = section.y + section.height;
    }
    const sitemap = track(figma.createSection());
    created.push(sitemap);
    sitemap.name = `website-to-figma \xB7 Sitemap \xB7 ${host}`;
    sitemap.x = originX;
    sitemap.y = anyComponents ? componentsBottom + AREA_GAP : 0;
    const notes = k.notes.length > 0 ? ` Notes: ${k.notes.join(" | ")}` : "";
    const top = sectionTitle(
      sitemap,
      `Sitemap \xB7 ${host}`,
      `Source: ${sourceLabel}. ${crawlLine}${notes} Low-fidelity wireframes generated from page structure; not pixel-accurate. Not affiliated with Figma or the site owner.`
    );
    let instances = 0;
    const frames = /* @__PURE__ */ new Map();
    for (const page of doc.pages) {
      const f = buildPageFrame(sitemap, page, plan.navByPage.get(page.id), plan.footerByPage.get(page.id), navComponents, footerComponents, cardComponents);
      instances += f.instances;
      frames.set(page.id, f.frame);
    }
    const sizes = /* @__PURE__ */ new Map();
    for (const [id, f] of frames) sizes.set(id, { w: f.width, h: f.height });
    const placement = placeSitemap(doc.pages, sizes, { x: SECTION_PAD, y: top });
    for (const [id, r] of placement.frames) {
      const f = frames.get(id);
      f.x = r.x;
      f.y = r.y;
    }
    const vectors = [];
    for (const e of placement.edges) {
      const v = track(figma.createVector());
      sitemap.appendChild(v);
      v.name = `Edge ${e.from} \u2192 ${e.to}`;
      const minX = Math.min(...e.points.map((p) => p.x));
      const minY = Math.min(...e.points.map((p) => p.y));
      const last = e.points.length - 1;
      await v.setVectorNetworkAsync({
        vertices: e.points.map((p, i) => i === last ? { x: p.x - minX, y: p.y - minY, strokeCap: "ARROW_LINES" } : { x: p.x - minX, y: p.y - minY }),
        segments: e.points.slice(1).map((_, i) => ({ start: i, end: i + 1 })),
        regions: []
      });
      v.x = minX;
      v.y = minY;
      v.strokes = [LINE];
      v.strokeWeight = 2;
      v.fills = [];
      vectors.push(v);
    }
    if (vectors.length > 0) {
      const g = track(figma.group(vectors, sitemap, 0));
      g.name = "Sitemap edges (vectors)";
    }
    sitemap.resizeWithoutConstraints(
      Math.max(placement.bounds.x + placement.bounds.w, 1180) + SECTION_PAD,
      placement.bounds.y + placement.bounds.h + SECTION_PAD
    );
    figma.currentPage.selection = created;
    figma.viewport.scrollAndZoomIntoView(created);
    return { pages: frames.size, components: componentNodes.length, instances, edges: vectors.length, warnings };
  }
  function buildPageFrame(parent, page, navSig, footerSig, navComponents, footerComponents, cardComponents) {
    let instances = 0;
    const f = track(figma.createFrame());
    parent.appendChild(f);
    f.name = `${page.path} \xB7 ${page.title}`;
    autoLayout(f, "VERTICAL", 12, PAD, BG);
    f.resize(PAGE_W, 200);
    f.counterAxisSizingMode = "FIXED";
    f.primaryAxisSizingMode = "AUTO";
    f.strokes = [LINE];
    f.strokeWeight = 1;
    const label2 = text(page.path, 10, false, MUTED);
    label2.name = "Page path";
    appendFill(f, label2);
    if (page.nav) {
      const comp = navSig ? navComponents.get(navSig) : void 0;
      if (comp) {
        appendFill(f, track(comp.createInstance()));
        instances++;
      } else {
        const n = track(figma.createFrame());
        f.appendChild(n);
        n.name = "Nav (unique on this page)";
        fillNav(n, page.nav);
        n.layoutSizingHorizontal = "FILL";
      }
    }
    for (const b of page.blocks) instances += appendBlock(f, b, cardComponents);
    if (page.footer) {
      const comp = footerSig ? footerComponents.get(footerSig) : void 0;
      if (comp) {
        appendFill(f, track(comp.createInstance()));
        instances++;
      } else {
        const n = track(figma.createFrame());
        f.appendChild(n);
        n.name = "Footer (unique on this page)";
        fillFooter(n, page.footer);
        n.layoutSizingHorizontal = "FILL";
      }
    }
    return { frame: f, instances };
  }
  function setInstanceText(inst, name, value) {
    const t = inst.findOne((n) => n.type === "TEXT" && n.name === name);
    if (t) t.characters = value;
  }
  function appendBlock(f, b, cardComponents) {
    if (b.type === "heading") {
      const t = text(b.text, b.level === 1 ? 20 : b.level === 2 ? 15 : 13, true);
      t.name = `H${b.level}`;
      appendFill(f, t);
      return 0;
    }
    if (b.type === "text") {
      const t = text(b.text, 11, false, MUTED);
      t.name = "Text";
      appendFill(f, t);
      return 0;
    }
    let instances = 0;
    const row = track(figma.createFrame());
    f.appendChild(row);
    row.name = `Cards (${b.cards.length})`;
    autoLayout(row, "HORIZONTAL", 8, 0, null);
    row.layoutSizingHorizontal = "FILL";
    row.layoutSizingVertical = "HUG";
    row.layoutWrap = "WRAP";
    row.counterAxisSpacing = 8;
    for (const card of b.cards) {
      const shape = cardShape(card);
      const comp = cardComponents.get(shape);
      if (comp) {
        const inst = track(comp.createInstance());
        row.appendChild(inst);
        if (shape !== "text") setInstanceText(inst, "Card title", card.title);
        if (shape !== "title") setInstanceText(inst, "Card text", card.text);
        instances++;
      } else {
        const n = track(figma.createFrame());
        row.appendChild(n);
        n.name = "Card";
        fillCard(n, shape, card);
      }
    }
    return instances;
  }
})();
