// Narrow HTTP transport for the documented Firecrawl Browser Sandbox API
// (https://docs.firecrawl.dev/features/browser, public curl reference):
//   create  POST   /v2/interact               { ttl, activityTtl }
//   execute POST   /v2/interact/{id}/execute  { code, language }
//   delete  DELETE /v2/interact/{id}
// The newest published SDK (4.52.0) still calls /v2/browser, so the SDK is not
// used here. Exactly one fetch per operation (no retry, no replay), a per-op
// abort timeout, redirects rejected (`redirect: "error"`), streamed response
// byte caps enforced BEFORE parsing, endpoint pinned (no env override), no
// extra body fields. Errors carry `status` when an HTTP status was received.
export const INTERACT_API_URL = "https://api.firecrawl.dev";
export const INTERACT_LIMITS = {
  createBytes: 64_000,
  executeBytes: 8_000_000,
  deleteBytes: 64_000,
  createMs: 60_000,
  executeMs: 120_000, // execute timeout 90 s + margin
  deleteMs: 60_000,
} as const;

export class TransportError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    // parsed JSON body of a non-2xx response (kept so a session id in it is never lost)
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "TransportError";
  }
}

export interface InteractClient {
  browser(body: Record<string, unknown>): Promise<unknown>;
  browserExecute(id: string, body: Record<string, unknown>): Promise<unknown>;
  deleteBrowser(id: string): Promise<unknown>;
}

const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function createInteractClient(apiKey: string, opts: { apiUrl?: string; fetchImpl?: typeof fetch; limits?: Partial<typeof INTERACT_LIMITS> } = {}): InteractClient {
  const apiUrl = (opts.apiUrl ?? INTERACT_API_URL).replace(/\/$/, "");
  const doFetch = opts.fetchImpl ?? fetch;
  const L = { ...INTERACT_LIMITS, ...(opts.limits ?? {}) };
  const call = async (method: "POST" | "DELETE", path: string, body: Record<string, unknown> | undefined, timeoutMs: number, maxBytes: number): Promise<unknown> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      let res: Response;
      try {
        res = await doFetch(`${apiUrl}${path}`, {
          method,
          headers: { authorization: `Bearer ${apiKey}`, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}),
          redirect: "error",
          signal: ctrl.signal,
        });
      } catch (err) {
        throw new TransportError(ctrl.signal.aborted ? `${method} ${path}: no response within ${timeoutMs} ms` : `${method} ${path}: ${err instanceof Error ? err.message : "network error"} (redirects are rejected)`);
      }
      const declared = Number(res.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > maxBytes) {
        ctrl.abort();
        throw new TransportError(`${method} ${path}: response ${declared} bytes exceeds the ${maxBytes}-byte cap`, res.status);
      }
      const chunks: Uint8Array[] = [];
      let total = 0;
      if (res.body) {
        const reader = res.body.getReader();
        for (;;) {
          let r: { done: boolean; value?: Uint8Array };
          try {
            r = await reader.read();
          } catch {
            throw new TransportError(`${method} ${path}: response body interrupted${ctrl.signal.aborted ? " (timeout)" : ""}`, res.status);
          }
          if (r.done) break;
          total += r.value!.length;
          if (total > maxBytes) {
            ctrl.abort();
            throw new TransportError(`${method} ${path}: response exceeds the ${maxBytes}-byte cap`, res.status);
          }
          chunks.push(r.value!);
        }
      }
      const text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        throw new TransportError(`${method} ${path}: response is not JSON (HTTP ${res.status})`, res.status);
      }
      if (!res.ok) {
        const msg = json && typeof json === "object" && typeof (json as { error?: unknown }).error === "string" ? (json as { error: string }).error.slice(0, 200) : "";
        throw new TransportError(`${method} ${path}: HTTP ${res.status}${msg ? ` ${msg}` : ""}`, res.status, json);
      }
      return json;
    } finally {
      clearTimeout(timer);
    }
  };
  const id = (s: string) => {
    if (!SESSION_ID.test(s)) throw new TransportError("invalid session id");
    return s;
  };
  return {
    browser: (body) => call("POST", "/v2/interact", body, L.createMs, L.createBytes),
    browserExecute: (s, body) => call("POST", `/v2/interact/${id(s)}/execute`, body, L.executeMs, L.executeBytes),
    deleteBrowser: (s) => call("DELETE", `/v2/interact/${id(s)}`, undefined, L.deleteMs, L.deleteBytes),
  };
}
