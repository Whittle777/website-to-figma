// Offline asset manifest loader. Reads ONLY local files named in an operator
// manifest, inside the manifest's directory; never downloads anything.
// Each asset must match its declared SHA-256, be PNG/JPEG/GIF (the formats
// figma.createImage accepts) and fit Figma's 4096 px limit. Rejected assets
// are omitted with a visible warning rather than failing the whole build.
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { LIMITS } from "../shared/limits";
import { inspectImage } from "../shared/imageInfo";
import { cleanText } from "../shared/text";
import { parseHttpUrl } from "../security/urlGuard";
import { CaptureError, type LoadedAsset, type RejectedReference } from "./convert";
import { readBoundedFile, readBoundedJson } from "./files";

const MAX_MANIFEST_BYTES = 1_000_000;

export function loadAssetManifest(manifestPath: string): { assets: LoadedAsset[]; warnings: string[]; rejectedReferences: RejectedReference[] } {
  const m = readBoundedJson(manifestPath, MAX_MANIFEST_BYTES, "asset manifest");
  const o = m as { schema?: unknown; schemaVersion?: unknown; assets?: unknown };
  if (o?.schema !== "website-to-figma/asset-manifest" || o.schemaVersion !== 1 || !Array.isArray(o.assets)) {
    throw new CaptureError('asset manifest: expected { schema: "website-to-figma/asset-manifest", schemaVersion: 1, assets: [...] }');
  }
  if (o.assets.length > LIMITS.hifiMaxAssets * 5) throw new CaptureError("asset manifest: too many entries");
  const root = realpathSync(dirname(resolve(manifestPath)));
  const assets: LoadedAsset[] = [];
  const warnings: string[] = [];
  const rejectedReferences: RejectedReference[] = [];
  let total = 0;
  let pixels = 0;
  const ids = new Set<string>();
  for (const [i, raw] of o.assets.entries()) {
    const a = raw as Record<string, unknown>;
    const id = typeof a?.id === "string" ? a.id : "";
    const reject = (why: string) => {
      if (warnings.length < LIMITS.hifiMaxWarnings) warnings.push(cleanText(`Asset ${id || `#${i}`} omitted: ${why}`, LIMITS.maxNoteChars));
    };
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(id) || ids.has(id)) throw new CaptureError(`asset manifest: assets[${i}].id must be unique [A-Za-z0-9._-]{1,64}`);
    ids.add(id);
    if (a.kind !== "image" && a.kind !== "reference") throw new CaptureError(`asset manifest: assets[${i}].kind must be image | reference`);
    const file = typeof a.file === "string" ? a.file : "";
    const declared = typeof a.sha256 === "string" ? a.sha256.toLowerCase() : "";
    if (!/^[0-9a-f]{64}$/.test(declared)) throw new CaptureError(`asset manifest: assets[${i}].sha256 must be hex SHA-256`);
    let pageUrl: string | null = null;
    if (a.pageUrl !== undefined && a.pageUrl !== null) {
      if (a.kind !== "reference") throw new CaptureError(`asset manifest: assets[${i}].pageUrl is only valid for kind "reference"`);
      try {
        pageUrl = parseHttpUrl(String(a.pageUrl)).toString();
      } catch (err) {
        reject(`page URL rejected (${err instanceof Error ? err.message : "invalid"})`);
        continue;
      }
    }
    let sourceUrl: string | null = null;
    if (a.sourceUrl !== undefined && a.sourceUrl !== null) {
      try {
        sourceUrl = parseHttpUrl(String(a.sourceUrl)).toString();
      } catch (err) {
        reject(`source URL rejected (${err instanceof Error ? err.message : "invalid"})`);
        continue;
      }
    }
    if (!file || isAbsolute(file) || file.includes("\\") || file.split("/").some((s) => s === ".." || s === "")) {
      reject("file must be a relative path inside the manifest directory");
      continue;
    }
    const full = resolve(root, file);
    if (!full.startsWith(root + sep)) {
      reject("file escapes the manifest directory");
      continue;
    }
    let bytes: Uint8Array;
    try {
      bytes = readBoundedFile(full, LIMITS.hifiMaxAssetBytes, root);
    } catch (err) {
      reject(err instanceof Error ? err.message : "unreadable");
      continue;
    }
    if (total + bytes.length > LIMITS.hifiMaxAssetsTotalBytes) {
      reject("total asset byte budget exceeded");
      continue;
    }
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== declared) {
      reject("SHA-256 mismatch");
      continue;
    }
    const info = inspectImage(bytes);
    if (!info) {
      reject("not a PNG, JPEG or GIF");
      continue;
    }
    if (info.width < 1 || info.height < 1 || info.width > LIMITS.hifiMaxImageDim || info.height > LIMITS.hifiMaxImageDim) {
      const why = `${info.width}x${info.height}px exceeds Figma's ${LIMITS.hifiMaxImageDim}px image limit (tiling would need an approved PNG codec dependency)`;
      reject(why);
      // Hash-verified header size is still evidence for width/height reconciliation.
      if (a.kind === "reference" && info.width >= 1 && info.height >= 1 && info.width <= 100_000 && info.height <= 1_000_000) {
        rejectedReferences.push({ operatorId: id, pageUrl, width: info.width, height: info.height, reason: why });
      }
      continue;
    }
    total += bytes.length;
    if (pixels + info.width * info.height > LIMITS.hifiMaxTotalPixels) {
      reject("total decoded-pixel budget exceeded");
      continue;
    }
    pixels += info.width * info.height;
    assets.push({ operatorId: id, kind: a.kind, mime: info.mime, width: info.width, height: info.height, sha256: actual, sourceUrl, pageUrl, bytes });
  }
  return { assets, warnings, rejectedReferences };
}
