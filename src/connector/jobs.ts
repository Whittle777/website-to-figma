// Offline connector job planner (CLI side; makes NO Figma calls). Turns a
// validated schemaVersion 2 document into ordered, size-bounded connector
// scripts that each embed the pinned renderer bundle verbatim plus one job
// input. Image bytes are never embedded (the connector host cannot fill
// images); asset metadata (size, sha256) is kept for placeholders.
import { createHash } from "node:crypto";
import type { HifiDoc, HifiNode, HifiPage } from "../shared/hifiSchema";
import { buttonLabelOf } from "../../plugin/src/render/renderer";
import type { JobInput } from "./entry";

export const DEFAULT_MAX_JOB_CHARS = 50_000;

export interface PlannedJob {
  file: string;
  kind: JobInput["kind"];
  pageId: string | null;
  chars: number;
  sha256: string;
  script: string;
  note: string;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function prune(doc: HifiDoc, pages: HifiPage[], keepComponents: boolean): HifiDoc {
  const used = new Set<string>();
  const nodeAssets = (nodes: HifiNode[]) => {
    for (const n of nodes) if (n.kind === "image" && n.assetId) used.add(n.assetId);
  };
  if (keepComponents) for (const c of doc.components ?? []) nodeAssets(c.nodes);
  for (const p of pages) {
    nodeAssets(p.nodes);
    for (const v of p.states?.variants ?? []) nodeAssets(v.nodes);
    for (const m of p.media ?? []) if (m.stillAssetId) used.add(m.stillAssetId);
    if (p.referenceAssetId) used.add(p.referenceAssetId);
    for (const t of p.referenceTiles?.tiles ?? []) used.add(t.assetId);
    for (const v of p.states?.variants ?? []) if (v.referenceAssetId) used.add(v.referenceAssetId);
  }
  return {
    ...doc,
    assets: doc.assets.filter((a) => used.has(a.id)).map((a) => ({ ...a, dataBase64: "" })),
    pages,
    ...(keepComponents && doc.components ? { components: doc.components } : { components: undefined }),
  };
}

export function docKey(doc: HifiDoc): string {
  return sha(JSON.stringify({ ...doc, assets: doc.assets.map((a) => a.sha256) })).slice(0, 12);
}

// Phase order keeps the native z-order: unclipped non-text, clipped non-text, text.
function phaseIndices(page: HifiPage): { phase: "unclipped" | "clipped" | "text"; indices: number[] }[] {
  const clipOf = (n: HifiNode) => (n.clip !== undefined && n.clip >= 0 ? n.clip : -1);
  const un: number[] = [];
  const cl: number[] = [];
  const tx: number[] = [];
  page.nodes.forEach((n, i) => (n.kind === "text" ? tx : clipOf(n) >= 0 ? cl : un).push(i));
  return [
    { phase: "unclipped" as const, indices: un },
    { phase: "clipped" as const, indices: cl },
    { phase: "text" as const, indices: tx },
  ];
}

// Origin-supplied mapping: asset sha256 -> EXISTING Figma image hash.
export function parseImageHashMap(json: unknown): Record<string, string> {
  const o = json as { schema?: unknown; schemaVersion?: unknown; hashes?: unknown };
  if (o?.schema !== "website-to-figma/connector-image-hashes" || o.schemaVersion !== 1 || typeof o.hashes !== "object" || o.hashes === null || Array.isArray(o.hashes)) {
    throw new Error('image hash map: expected { schema: "website-to-figma/connector-image-hashes", schemaVersion: 1, hashes: { "<asset sha256>": "<40-hex Figma image hash>" } }');
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(o.hashes as Record<string, unknown>)) {
    if (!/^[0-9a-f]{64}$/.test(k) || typeof v !== "string" || !/^[0-9a-f]{40}$/.test(v)) throw new Error(`image hash map: invalid entry ${JSON.stringify(k)}`);
    out[k] = v;
  }
  return out;
}

export function planConnectorJobs(doc: HifiDoc, bundle: string, opts: { maxJobChars?: number; originX?: number; imageHashesBySha?: Record<string, string> } = {}): { jobs: PlannedJob[]; rootName: string; key: string } {
  const max = opts.maxJobChars ?? DEFAULT_MAX_JOB_CHARS;
  const key = docKey(doc);
  const rootName = `website-to-figma · Hi-fi (measured) · ${doc.site.host} [w2f ${key}]`;
  const jobs: PlannedJob[] = [];
  const mk = (input: JobInput, note: string): PlannedJob => {
    const bySha = opts.imageHashesBySha ?? {};
    const mapped: Record<string, string> = {};
    for (const a of input.doc.assets) if (bySha[a.sha256]) mapped[a.id] = bySha[a.sha256]!;
    if (Object.keys(mapped).length) input = { ...input, imageHashes: mapped };
    const script = `${bundle}\nreturn await W2F.runJob(${JSON.stringify(input)}, $fig, figma);\n`;
    const n = jobs.length + 1;
    const file = `job-${String(n).padStart(3, "0")}-${input.kind}${input.pageId ? `-${input.pageId}` : ""}${input.batch ? `-${input.batch.phase}` : ""}.js`;
    return { file, kind: input.kind, pageId: input.pageId ?? null, chars: script.length, sha256: sha(script), script, note };
  };
  const base = { schema: "website-to-figma/connector-job" as const, schemaVersion: 1 as const, rootName, originX: opts.originX ?? 0 };
  const push = (j: PlannedJob) => {
    if (j.chars > max) throw new Error(`${j.file}: ${j.chars} chars exceeds --max-job-chars ${max} (the renderer bundle alone is ${bundle.length})`);
    jobs.push(j);
  };
  push(mk({ ...base, kind: "root", doc: prune(doc, [], true) }, "root frame, intro, shared components"));
  for (const page of doc.pages) {
    const d = prune(doc, [page], true);
    const whole = mk({ ...base, kind: "page", pageId: page.id, withNodes: true, doc: d }, `page ${page.path}${page.segment ? ` part ${page.segment.index + 1}` : ""} (shell, nodes, states)`);
    if (whole.chars <= max) {
      push(whole);
      continue;
    }
    // Shell (notes, frame, instances, media, references, states) then node batches.
    // the shell carries no nodes (font fallback lines for this page are then omitted from its notes)
    const shellPage = { ...page, nodes: [] as HifiNode[] };
    push(mk({ ...base, kind: "page", pageId: page.id, withNodes: false, doc: prune(doc, [shellPage], true) }, `page ${page.path} shell`));
    let firstClipped = true;
    for (const ph of phaseIndices(page)) {
      // clip frames are created by the first clipped batch: emit one even when
      // only text is clipped
      if (ph.phase === "clipped" && ph.indices.length === 0 && (page.clips?.length ?? 0) > 0) {
        push(mk({ ...base, kind: "nodes", pageId: page.id, doc: prune(doc, [{ ...page, nodes: [], states: undefined, instances: undefined, media: undefined }], false), batch: { phase: "clipped", orig: [], createClips: true, buttonLabels: {}, buttonBoxes: {} } }, `page ${page.path} clip frames`));
        firstClipped = false;
        continue;
      }
      let start = 0;
      while (start < ph.indices.length) {
        // grow the batch while it fits
        let end = Math.min(ph.indices.length, start + 400);
        let job: PlannedJob;
        for (;;) {
          const orig = ph.indices.slice(start, end);
          const sub = orig.map((i) => page.nodes[i]!);
          const buttonLabels: Record<string, string | null> = {};
          const buttonBoxes: Record<string, { x: number; y: number }> = {};
          for (const [k, n] of sub.entries()) {
            if (n.kind === "box" && n.role === "button") buttonLabels[String(orig[k])] = buttonLabelOf(page.nodes, orig[k]!);
            if (n.kind === "text" && n.button >= 0) {
              const box = page.nodes[n.button]!;
              buttonLabels[String(n.button)] = buttonLabelOf(page.nodes, n.button);
              buttonBoxes[String(n.button)] = { x: box.x, y: box.y };
            }
          }
          const batchPage = { ...page, nodes: sub, states: undefined, instances: undefined, media: undefined };
          job = mk({ ...base, kind: "nodes", pageId: page.id, doc: prune(doc, [batchPage], false), batch: { phase: ph.phase, orig, createClips: ph.phase === "clipped" && firstClipped, buttonLabels, buttonBoxes } }, `page ${page.path} ${ph.phase} nodes ${start}-${end - 1}`);
          if (job.chars <= max || end - start <= 1) break;
          end = start + Math.max(1, Math.floor((end - start) / 2));
        }
        push(job);
        if (ph.phase === "clipped") firstClipped = false;
        start = end;
      }
    }
  }
  push(mk({ ...base, kind: "edges", doc: prune(doc, doc.pages.map((p) => ({ ...p, nodes: [], states: undefined })), false) }, "sitemap edges and final root size"));
  return { jobs, rootName, key };
}
