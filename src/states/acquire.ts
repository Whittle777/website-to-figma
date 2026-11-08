// Bounded acquisition of provider screenshot images for an ACCEPTED state run.
//
// Only URLs that the accepted run's response listed in actions.screenshots,
// associated with a state by action order, are eligible. This is a LOCAL
// fetch, so the full local URL + DNS guard applies with NO hosted exception.
// The connection is pinned to the validated addresses (custom lookup), every
// redirect hop is re-validated (https only, <=3 hops), the body is streamed
// with a hard byte cap, the content must be PNG/JPEG within pixel bounds, and
// its SHA-256 is recorded in an asset manifest. Anything that fails (e.g. a
// FakeIP resolver answering 198.18.0.0/15) is reported as an operator-local
// input requirement: download the image yourself and add it to the manifest.
import { createHash } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { isPublicAddress, parseHttpUrl, systemResolver, UnsafeUrlError, type Resolver } from "../security/urlGuard";
import { inspectImage } from "../shared/imageInfo";
import { LIMITS } from "../shared/limits";

export const ACQUIRE_LIMITS = { maxBytes: LIMITS.hifiMaxAssetBytes, maxRedirects: 3, timeoutMs: 30_000, maxWidth: LIMITS.hifiMaxImageDim, maxHeight: LIMITS.refTileMaxSourceHeight, maxPixels: LIMITS.refTileMaxSourcePixels } as const;

export class AcquireError extends Error {}

export interface TransportResponse {
  status: number;
  location: string | null;
  contentType: string | null;
  body: Uint8Array | null; // null for redirects
}
// Connects ONLY to `address` (already validated) for `url`'s host.
export interface ImageTransport {
  get(url: URL, address: { address: string; family: 4 | 6 }, limits: { maxBytes: number; timeoutMs: number }): Promise<TransportResponse>;
}

// Resolve and validate: every answer must be public unicast.
export async function pinnedAddress(url: URL, resolve: Resolver): Promise<{ address: string; family: 4 | 6 }> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) throw new UnsafeUrlError("IP-literal image URLs are not accepted");
  let addrs: string[];
  try {
    addrs = await resolve(host);
  } catch {
    throw new UnsafeUrlError(`could not resolve ${host}`);
  }
  if (!addrs.length) throw new UnsafeUrlError(`no addresses for ${host}`);
  const bad = addrs.find((a) => !isPublicAddress(a));
  if (bad) throw new UnsafeUrlError(`${host} resolves to non-public address ${bad} (a FakeIP/local resolver cannot be validated)`);
  const a = addrs[0]!;
  return { address: a, family: isIP(a) === 6 ? 6 : 4 };
}

export interface Acquired {
  url: string;
  finalUrl: string;
  bytes: Uint8Array;
  sha256: string;
  mime: string;
  width: number;
  height: number;
}

export async function acquireImage(raw: string, transport: ImageTransport, resolve: Resolver = systemResolver): Promise<Acquired> {
  let url = parseHttpUrl(raw);
  for (let hop = 0; hop <= ACQUIRE_LIMITS.maxRedirects; hop++) {
    if (url.protocol !== "https:") throw new UnsafeUrlError("only https image URLs are accepted");
    const addr = await pinnedAddress(url, resolve);
    const res = await transport.get(url, addr, { maxBytes: ACQUIRE_LIMITS.maxBytes, timeoutMs: ACQUIRE_LIMITS.timeoutMs });
    if (res.status >= 300 && res.status < 400) {
      if (!res.location) throw new AcquireError(`redirect ${res.status} without a location`);
      url = parseHttpUrl(new URL(res.location, url).toString());
      continue;
    }
    if (res.status !== 200 || !res.body) throw new AcquireError(`HTTP ${res.status}`);
    if (res.body.length > ACQUIRE_LIMITS.maxBytes) throw new AcquireError("image exceeds the byte bound");
    const ct = (res.contentType ?? "").toLowerCase().split(";")[0]!.trim();
    if (ct !== "image/png" && ct !== "image/jpeg") throw new AcquireError(`content type ${ct || "missing"} is not PNG/JPEG`);
    const info = inspectImage(res.body);
    if (!info || (info.mime !== "image/png" && info.mime !== "image/jpeg") || info.mime !== ct) throw new AcquireError("bytes are not the declared PNG/JPEG");
    if (info.width < 1 || info.height < 1 || info.width > ACQUIRE_LIMITS.maxWidth || info.height > ACQUIRE_LIMITS.maxHeight || info.width * info.height > ACQUIRE_LIMITS.maxPixels) throw new AcquireError(`image ${info.width}x${info.height}px is outside the pixel bounds`);
    return { url: raw, finalUrl: url.toString(), bytes: res.body, sha256: createHash("sha256").update(res.body).digest("hex"), mime: info.mime, width: info.width, height: info.height };
  }
  throw new AcquireError(`more than ${ACQUIRE_LIMITS.maxRedirects} redirects`);
}

// net.LookupFunction that only ever answers with the pre-validated address.
export function pinnedLookup(addr: { address: string; family: 4 | 6 }) {
  return (_host: string, opts: { all?: boolean } | undefined, cb: (...a: unknown[]) => void) => (opts && opts.all ? cb(null, [{ address: addr.address, family: addr.family }]) : cb(null, addr.address, addr.family));
}

// Default transport: node:https pinned to the validated address via `lookup`
// (TLS still verifies the certificate for the URL's hostname via SNI).
export const httpsTransport: ImageTransport = {
  get(url, addr, limits) {
    return new Promise((resolvePromise, reject) => {
      const req = httpsRequest(
        {
          host: url.hostname,
          servername: url.hostname,
          port: 443,
          path: `${url.pathname}${url.search}`,
          method: "GET",
          headers: { accept: "image/png,image/jpeg" },
          timeout: limits.timeoutMs,
          lookup: pinnedLookup(addr) as never,
        },
        (res) => {
          const status = res.statusCode ?? 0;
          const location = typeof res.headers.location === "string" ? res.headers.location : null;
          const contentType = typeof res.headers["content-type"] === "string" ? res.headers["content-type"] : null;
          if (status >= 300 && status < 400) {
            res.resume();
            resolvePromise({ status, location, contentType, body: null });
            return;
          }
          const declared = Number(res.headers["content-length"]);
          if (Number.isFinite(declared) && declared > limits.maxBytes) {
            req.destroy();
            reject(new AcquireError("declared content-length exceeds the byte bound"));
            return;
          }
          const chunks: Buffer[] = [];
          let total = 0;
          res.on("data", (c: Buffer) => {
            total += c.length;
            if (total > limits.maxBytes) {
              req.destroy();
              reject(new AcquireError("image exceeds the byte bound"));
              return;
            }
            chunks.push(c);
          });
          res.on("end", () => resolvePromise({ status, location, contentType, body: new Uint8Array(Buffer.concat(chunks)) }));
          res.on("error", reject);
        },
      );
      req.on("timeout", () => req.destroy(new AcquireError("image request timed out")));
      req.on("error", reject);
      req.end();
    });
  },
};
