// Conservative diagnostic sanitization applied BEFORE anything from a hosted
// browser run is persisted (sandbox.json, execute-raw.json) or logged.
// - known secrets (the API key) and fc- keys, authorization/bearer values
// - URL userinfo (user:password@), credential/session/token query values and
//   long opaque query/fragment values
// - CDP / DevTools / live-view / session / WebSocket URLs (removed whole)
// - key=value / key: value pairs whose key names a credential
// - JWT-shaped tokens
// Geometry, numbers, booleans and ordinary text are left as they are.

const SENSITIVE_KEY = /(^|[_-])(token|access[_-]?token|refresh[_-]?token|id[_-]?token|auth|authorization|bearer|api[_-]?key|apikey|key|secret|client[_-]?secret|password|passwd|pwd|pass|credential|credentials|session|sessionid|session[_-]?id|sid|sig|signature|jwt|code|ticket|cookie)$/i;
// object keys whose string value is never persisted (narrower: record fields such as sessionId,
// which is needed for cleanup and is not a credential, are kept)
const SENSITIVE_OBJ_KEY = /^(token|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|apikey|secret|client[_-]?secret|password|passwd|pwd|authorization|cookie|set-cookie|credentials?)$/i;
const SESSION_URL = /(^wss?:|^devtools:|^chrome-devtools:|\/devtools\/|\/json\/version|\/cdp\b|[?&/]cdp[=/]|live[-_]?view|liveview|\/session[s]?\/|[?&]session[_-]?id=|\/v[0-9]+\/(interact|browser)\/)/i;
const OPAQUE = /^[A-Za-z0-9_\-.~+/=%]{24,}$/;
const URL_RE = /\b[a-z][a-z0-9+.-]{1,15}:\/\/[^\s"'<>`\\]+/gi;

export const REDACTED = "[REDACTED]";

function sanitizeUrl(raw: string): string {
  // trailing punctuation is usually prose, not part of the URL
  const m = /^(.*?)([).,;:!\]]*)$/.exec(raw)!;
  const urlText = m[1]!;
  const tail = m[2] ?? "";
  if (SESSION_URL.test(urlText)) return `[REDACTED-SESSION-URL]${tail}`;
  let u: URL;
  try {
    u = new URL(urlText);
  } catch {
    // unparsable: still strip anything that looks like userinfo
    return urlText.replace(/\/\/[^/@\s]*@/, `//${REDACTED}@`) + tail;
  }
  // rebuilt ONLY when something is masked: non-secret URLs are kept byte-for-byte
  let changed = false;
  if (u.username || u.password) {
    u.username = REDACTED;
    u.password = "";
    changed = true;
  }
  if (u.search) {
    const p = new URLSearchParams(u.search);
    const out = new URLSearchParams();
    for (const [k, v] of p) {
      const mask = SENSITIVE_KEY.test(k) || OPAQUE.test(v);
      changed ||= mask;
      out.append(k, mask ? REDACTED : v);
    }
    if (changed) u.search = out.toString();
  }
  if (u.hash && (u.hash.includes("=") || OPAQUE.test(u.hash.slice(1)))) {
    u.hash = `#${REDACTED}`;
    changed = true;
  }
  return changed ? u.href.replace(/%5BREDACTED%5D/g, REDACTED) + tail : raw;
}

export function sanitizeString(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join(REDACTED);
  out = out.replace(URL_RE, (u) => sanitizeUrl(u));
  out = out.replace(/\bfc-[A-Za-z0-9_-]{8,}\b/g, REDACTED);
  out = out.replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, "[REDACTED-JWT]");
  out = out.replace(/\b(authorization|bearer)\b(\s*[:=]?\s*)(?!\[REDACTED)[^\s"',;]+/gi, `$1$2${REDACTED}`);
  out = out.replace(/(["']?)\b((?:access|refresh|id)?[_-]?token|api[_-]?key|apikey|secret|client[_-]?secret|password|passwd|pwd|session[_-]?id|sessionid|cookie|credentials?)\1(\s*[:=]\s*)(["']?)(?!\[REDACTED)[^\s"'&,;}]+/gi, `$1$2$1$3$4${REDACTED}`);
  return out;
}

export interface SanitizeLimits {
  maxString: number;
  maxArray: number;
  maxKeys: number;
  maxDepth: number;
}
export const RECORD_LIMITS: SanitizeLimits = { maxString: 20_000, maxArray: 5_000, maxKeys: 500, maxDepth: 12 };

// Recursive, bounded, JSON-safe copy with every string sanitized. Truncations are
// recorded in `truncations` (path + original size) instead of silently chopping.
export function sanitizeValue(v: unknown, secrets: readonly string[] = [], lim: SanitizeLimits = RECORD_LIMITS, truncations: string[] = [], path = "$", depth = 0): unknown {
  if (v === null || typeof v === "boolean") return v;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const s = sanitizeString(v, secrets);
    if (s.length <= lim.maxString) return s;
    truncations.push(`${path}: string ${s.length} chars kept ${lim.maxString}`);
    return s.slice(0, lim.maxString);
  }
  if (typeof v !== "object") return null; // undefined, function, symbol, bigint: not persisted
  if (depth >= lim.maxDepth) {
    truncations.push(`${path}: depth limit ${lim.maxDepth}`);
    return null;
  }
  if (Array.isArray(v)) {
    if (v.length > lim.maxArray) truncations.push(`${path}: array ${v.length} items kept ${lim.maxArray}`);
    return v.slice(0, lim.maxArray).map((x, i) => sanitizeValue(x, secrets, lim, truncations, `${path}[${i}]`, depth + 1));
  }
  const out: Record<string, unknown> = {};
  const keys = Object.keys(v as object);
  if (keys.length > lim.maxKeys) truncations.push(`${path}: ${keys.length} keys kept ${lim.maxKeys}`);
  for (const k of keys.slice(0, lim.maxKeys)) {
    const sk = sanitizeString(k, secrets).slice(0, 200);
    const val = (v as Record<string, unknown>)[k];
    // a value under a credential-named key is never kept verbatim
    out[sk] = SENSITIVE_OBJ_KEY.test(k) && typeof val === "string" && val !== "" ? REDACTED : sanitizeValue(val, secrets, lim, truncations, `${path}.${sk}`, depth + 1);
  }
  return out;
}
