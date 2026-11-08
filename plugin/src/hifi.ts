// Native renderer entry for schemaVersion 2 (measured hi-fi) documents. The
// rendering logic is the shared renderer (render/renderer.ts) driven by the
// native host (render/nativeHost.ts): real Plugin API calls only. No network:
// image bytes come from the validated document, are decoded with
// figma.base64Decode and re-verified (length, SHA-256, PNG/JPEG/GIF header,
// <= 4096 px) before ANY node is created.
import type { HifiDoc } from "../../src/shared/hifiSchema";
import { inspectImage, sha256Hex } from "../../src/shared/imageInfo";
import { NativeHost } from "./render/nativeHost";
import { renderDocument, type HifiStats } from "./render/renderer";

export type { HifiStats };

type Track = <T extends SceneNode>(n: T) => T;

// Verify every embedded asset before the canvas is touched.
export function verifyAssets(doc: HifiDoc): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
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

export async function buildHifiDoc(doc: HifiDoc, track: Track, created: SceneNode[], originX: number): Promise<HifiStats> {
  // 1) Verify all bytes before touching the canvas (fonts load inside renderDocument, also before any node).
  const bytes = verifyAssets(doc);
  const hashes = new Map<string, string>();
  for (const [id, b] of bytes) hashes.set(id, figma.createImage(b).hash);
  // Every created node goes through `track` (the caller's rollback list).
  const { stats, root } = await renderDocument(new NativeHost(track, hashes), doc, `website-to-figma · Hi-fi (measured) · ${doc.site.host}`, originX);
  created.push(root);
  return stats;
}
