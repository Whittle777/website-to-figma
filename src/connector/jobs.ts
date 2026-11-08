// Offline connector job planner (CLI side; makes NO Figma calls). Turns a
// validated schemaVersion 2 document into ordered, size-bounded connector
// scripts that each embed the pinned renderer bundle verbatim plus ONE small
// job input. Every job is checked against the limit while planning; if any
// job cannot fit, planning throws and nothing is written. Image bytes are
// never embedded (asset metadata only; fills only via an origin hash map).
import { createHash } from "node:crypto";
import type { HifiDoc, HifiNode, HifiPage } from "../shared/hifiSchema";
import type { JobInput, NodesTarget } from "./entry";
import { buttonLabelOf, componentChildNames, notesName, pageNotes, newStats } from "../../plugin/src/render/renderer";

export const DEFAULT_MAX_JOB_CHARS = 40_000;

export interface PlannedJob {
  file: string;
  kind: JobInput["kind"];
  pageId: string | null;
  chars: number;
  sha256: string;
  script: string;
  note: string;
}

export class JobPlanError extends Error {}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export function docKey(doc: HifiDoc): string {
  return sha(JSON.stringify({ ...doc, assets: doc.assets.map((a) => a.sha256) })).slice(0, 12);
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

const clipOf = (n: HifiNode) => (n.clip !== undefined && n.clip >= 0 ? n.clip : -1);

export function planConnectorJobs(doc: HifiDoc, bundle: string, opts: { maxJobChars?: number; originX?: number; imageHashesBySha?: Record<string, string> } = {}): { jobs: PlannedJob[]; rootName: string; key: string } {
  const max = opts.maxJobChars ?? DEFAULT_MAX_JOB_CHARS;
  if (bundle.length + 2_000 > max) throw new JobPlanError(`--max-job-chars ${max} leaves no room: the renderer bundle alone is ${bundle.length} chars`);
  const key = docKey(doc);
  const rootName = `website-to-figma · Hi-fi (measured) · ${doc.site.host} [w2f ${key}]`;
  const bySha = opts.imageHashesBySha ?? {};
  const jobs: PlannedJob[] = [];
  const base = { schema: "website-to-figma/connector-job" as const, schemaVersion: 1 as const, rootName, originX: opts.originX ?? 0 };
  // A minimal document: only what one job renders (no warnings, no image bytes).
  const mini = (pages: HifiPage[], components: HifiDoc["components"], assetIds: Set<string>): HifiDoc => ({
    ...doc,
    warnings: [],
    provenance: { ...doc.provenance, notes: [] },
    assets: doc.assets.filter((a) => assetIds.has(a.id)).map((a) => ({ ...a, dataBase64: "" })),
    pages,
    components: components && components.length ? components : undefined,
  });
  const make = (input: JobInput, note: string): PlannedJob => {
    const mapped: Record<string, string> = {};
    for (const a of input.doc.assets) if (bySha[a.sha256]) mapped[a.id] = bySha[a.sha256]!;
    const full: JobInput = Object.keys(mapped).length ? { ...input, imageHashes: mapped } : input;
    const script = `${bundle}\nreturn await W2F.runJob(${JSON.stringify(full)}, $fig, figma);\n`;
    const file = `job-${String(jobs.length + 1).padStart(3, "0")}-${input.kind}${input.pageId ? `-${input.pageId}` : ""}.js`;
    return { file, kind: input.kind, pageId: input.pageId ?? null, chars: script.length, sha256: sha(script), script, note };
  };
  const push = (j: PlannedJob) => {
    if (j.chars > max) throw new JobPlanError(`${j.file} (${j.note}) needs ${j.chars} chars, over --max-job-chars ${max} (renderer bundle ${bundle.length}); nothing was written`);
    jobs.push(j);
  };
  const shellPage = (p: HifiPage): HifiPage => ({ ...p, nodes: [], warnings: [], notes: [], states: undefined, branding: null });

  // Text blocks: greedily packed lines, one label job per chunk.
  const labels = (lines: string[], o: { size: number; bold: boolean; width?: number; name: string; gap: number }, note: string) => {
    let chunk: string[] = [];
    let part = 0;
    const emit = () => {
      if (!chunk.length) return;
      push(make({ ...base, kind: "label", doc: mini([], undefined, new Set()), label: { ...o, text: chunk.join("\n"), name: part ? `${o.name} (cont. ${part})` : o.name, gap: part ? 4 : o.gap } }, `${note}${part ? ` (cont. ${part})` : ""}`));
      part++;
      chunk = [];
    };
    for (const line of lines) {
      const probe = make({ ...base, kind: "label", doc: mini([], undefined, new Set()), label: { ...o, text: [...chunk, line].join("\n"), name: o.name, gap: o.gap } }, note);
      if (probe.chars > max && chunk.length) emit();
      chunk.push(line);
    }
    emit();
  };

  // Node batches for one target, phase-ordered to keep z-order; each batch
  // halves until it fits. A single node that cannot fit is a clear error.
  const nodeBatches = (all: HifiNode[], target: NodesTarget, page: HifiPage | null, componentsMeta: HifiDoc["components"], firstDescription: string | undefined, label: string) => {
    let description = firstDescription;
    const phases: { phase: "unclipped" | "clipped" | "text"; idx: number[] }[] = [
      { phase: "unclipped", idx: [] },
      { phase: "clipped", idx: [] },
      { phase: "text", idx: [] },
    ];
    all.forEach((n, i) => phases[n.kind === "text" ? 2 : clipOf(n) >= 0 ? 1 : 0]!.idx.push(i));
    const hasClips = (page?.clips?.length ?? 0) > 0 && target.type === "page";
    let clipsCreated = false;
    const build = (phase: "unclipped" | "clipped" | "text", orig: number[]) => {
      const nodes = orig.map((i) => all[i]!);
      const buttonLabels: Record<string, string | null> = {};
      const buttonBoxes: Record<string, { x: number; y: number }> = {};
      const assets = new Set<string>();
      nodes.forEach((n, k) => {
        if (n.kind === "box" && n.role === "button") buttonLabels[String(orig[k])] = buttonLabelOf(all, orig[k]!);
        if (n.kind === "text" && n.button >= 0) {
          buttonLabels[String(n.button)] = buttonLabelOf(all, n.button);
          buttonBoxes[String(n.button)] = { x: all[n.button]!.x, y: all[n.button]!.y };
        }
        if (n.kind === "image" && n.assetId) assets.add(n.assetId);
      });
      const createClips = phase === "clipped" && hasClips && !clipsCreated;
      return make(
        { ...base, kind: "nodes", pageId: page?.id, target, doc: mini(page ? [shellPage(page)] : [], componentsMeta, assets), batch: { phase, orig, createClips, buttonLabels, buttonBoxes, nodes, ...(description !== undefined ? { description } : {}) } },
        `${label} ${phase} nodes ${orig[0] ?? "-"}..${orig[orig.length - 1] ?? "-"}`,
      );
    };
    for (const ph of phases) {
      if (ph.phase === "clipped" && hasClips && ph.idx.length === 0) {
        push(build("clipped", []));
        clipsCreated = true;
        continue;
      }
      let start = 0;
      while (start < ph.idx.length) {
        let end = Math.min(ph.idx.length, start + 200);
        let job = build(ph.phase, ph.idx.slice(start, end));
        while (job.chars > max && end - start > 1) {
          end = start + Math.max(1, Math.floor((end - start) / 2));
          job = build(ph.phase, ph.idx.slice(start, end));
        }
        if (job.chars > max) {
          const n = all[ph.idx[start]!]!;
          throw new JobPlanError(`${label}: node ${ph.idx[start]} (${n.kind} "${n.name}") alone needs ${job.chars} chars, over --max-job-chars ${max}; raise the limit (nothing was written)`);
        }
        push(job);
        description = undefined;
        if (ph.phase === "clipped") clipsCreated = true;
        start = end;
      }
    }
    if (description !== undefined) push(build("text", [])); // description only (no nodes)
  };

  // 1) root + intro
  push(make({ ...base, kind: "root", doc: mini([], undefined, new Set()) }, "root frame and title"));
  const intro = [
    `Source: ${doc.source.label} (${doc.source.mode}). ${doc.provenance.notes.join(" ")}`,
    ...(doc.fontMap?.length ? [`Operator font map: ${doc.fontMap.map((f) => `${f.match} -> ${f.use}`).join(", ")}`] : []),
    ...doc.warnings.map((w) => `Warning: ${w}`),
    "Not affiliated with Figma or the site owner. Not pixel-perfect.",
  ];
  labels(intro, { size: 14, bold: false, width: 1200, name: "Intro", gap: 8 }, "intro");

  // 2) shared components: empty shells, then their nodes
  const compMeta = (doc.components ?? []).map((c) => ({ ...c, nodes: [] as HifiNode[] }));
  if (doc.components?.length) {
    labels(["Shared components (identical structure on 2+ pages; per-page paint differences are instance overrides)"], { size: 14, bold: true, name: "Shared components", gap: 60 }, "components heading");
    for (const cm of doc.components) {
      push(make({ ...base, kind: "component", componentId: cm.id, doc: mini([], [{ ...cm, nodes: [] }], new Set()) }, `component ${cm.name}`));
      nodeBatches(cm.nodes, { type: "component", componentId: cm.id }, null, [{ ...cm, nodes: [] }], undefined, `component ${cm.name}`);
    }
  }
  const allChildNames = componentChildNames(doc);

  // 3) pages: notes labels, shell, node batches, states, variant nodes
  const notesCtx = { host: null as never, doc, fonts: new Map(), failedLoads: [], stats: newStats(doc) };
  for (const page of doc.pages) {
    const tag = `page ${page.path}${page.segment ? ` part ${page.segment.index + 1}` : ""}`;
    labels(pageNotes(notesCtx, page), { size: 14, bold: false, width: Math.max(600, page.width), name: notesName(page), gap: 120 }, `${tag} notes`);
    const used = new Set<string>();
    if (page.referenceAssetId) used.add(page.referenceAssetId);
    for (const t of page.referenceTiles?.tiles ?? []) used.add(t.assetId);
    for (const m of page.media ?? []) if (m.stillAssetId) used.add(m.stillAssetId);
    const comps = (page.instances ?? []).map((i) => compMeta.find((c) => c.id === i.component)!).filter(Boolean);
    const childNames: Record<string, Record<string, { name: string; type: string }>> = {};
    for (const ins of page.instances ?? []) for (const o of ins.overrides) {
      const n = allChildNames.get(ins.component)?.get(o.index);
      if (n) (childNames[ins.component] ??= {})[String(o.index)] = n;
    }
    const shellIn = (withNodes: boolean, part?: "shell" | "finish"): JobInput => {
      const p = withNodes ? { ...page, warnings: [], notes: [] } : part === "shell" ? { ...shellPage(page), instances: undefined, media: undefined } : shellPage(page);
      const assets = new Set(used);
      if (withNodes) {
        for (const n of page.nodes) if (n.kind === "image" && n.assetId) assets.add(n.assetId);
        for (const v of page.states?.variants ?? []) {
          if (v.referenceAssetId) assets.add(v.referenceAssetId);
          for (const n of v.nodes) if (n.kind === "image" && n.assetId) assets.add(n.assetId);
        }
      }
      return { ...base, kind: "page", pageId: page.id, withNodes, ...(part ? { part } : {}), doc: mini([p], part === "shell" ? undefined : comps, assets), ...(part === "shell" ? {} : { childNames }) };
    };
    const whole = make(shellIn(true), `${tag} (frame, nodes, states)`);
    if (whole.chars <= max) {
      push(whole);
      continue;
    }
    push(make(shellIn(false, "shell"), `${tag} shell (frame, references)`));
    nodeBatches(page.nodes, { type: "page", pageId: page.id }, page, undefined, undefined, tag);
    if (page.instances?.length || page.media?.length) push(make(shellIn(false, "finish"), `${tag} instances and media (above nodes)`));
    if (page.states) {
      const st = page.states;
      const refs = new Set(st.variants.map((v) => v.referenceAssetId).filter((x): x is string => !!x));
      const statesPage: HifiPage = { ...shellPage(page), states: { ...st, variants: st.variants.map((v) => ({ ...v, nodes: [], notes: [] })) } };
      push(make({ ...base, kind: "states", pageId: page.id, doc: mini([statesPage], undefined, refs) }, `${tag} states (variants, grid, reactions)`));
      for (const v of st.variants) nodeBatches(v.nodes, { type: "variant", pageId: page.id, variant: v.name }, page, undefined, v.notes.join("\n"), `${tag} State=${v.name}`);
    }
  }

  // 4) edges + final size
  push(make({ ...base, kind: "edges", doc: mini(doc.pages.map((p) => ({ ...shellPage(p), instances: undefined, media: undefined, clips: undefined, referenceTiles: undefined, referenceAssetId: null })), undefined, new Set()) }, "sitemap edges and final root size"));
  return { jobs, rootName, key };
}
