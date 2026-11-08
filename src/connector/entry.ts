// Connector job runner (bundled as an IIFE, global W2F). One job per script:
//   W2F.runJob(input, $fig, figma)
// Every job is bounded. Job kinds:
//   root      root frame + title
//   label     one text block placed below existing content (intro/notes chunks)
//   component an empty shared component (nodes added by "nodes" jobs)
//   page      page shell: frame, instances, media, references (optionally nodes)
//   nodes     a phase-ordered batch of nodes appended into a page frame, a
//             shared component, or a state variant (optionally its description)
//   states    state components (empty), $fig.variants({ name }, children),
//             grid + resize and reactions after a flush
//   edges     sitemap edges + final root size
// Later jobs find earlier nodes by deterministic unique names using raw reads
// that run only while nothing is pending; new nodes go through $fig only.
import type { HifiDoc, HifiNode } from "../shared/hifiSchema";
import { buttonName, clipName, finishWarnings, label, newStats, pageFrameName, renderComponentShell, renderEdges, renderNodes, renderPage, renderPageDecorations, renderStates, resolveFonts, statesSetName, type Ctx } from "../../plugin/src/render/renderer";
import { PlannedHost, type FigBuilder, type FigRaw, type FigWrapper } from "./plannedHost";

export type NodesTarget = { type: "page"; pageId: string } | { type: "component"; componentId: string } | { type: "variant"; pageId: string; variant: string };

export interface JobInput {
  schema: "website-to-figma/connector-job";
  schemaVersion: 1;
  kind: "root" | "label" | "component" | "page" | "nodes" | "states" | "edges";
  rootName: string;
  originX: number;
  doc: HifiDoc; // pruned: only what this job renders; no image bytes
  pageId?: string;
  withNodes?: boolean;
  // batched pages: "shell" (frame + references) before node batches, "finish" (instances + media) after
  part?: "shell" | "finish";
  componentId?: string;
  label?: { text: string; size: number; bold: boolean; width?: number; name: string; gap: number };
  target?: NodesTarget;
  // node batch: `nodes` are ONLY this batch; orig[i] = index in the full list
  batch?: { phase: "unclipped" | "clipped" | "text"; orig: number[]; createClips: boolean; buttonLabels: Record<string, string | null>; buttonBoxes: Record<string, { x: number; y: number }>; nodes: HifiNode[]; description?: string };
  imageHashes?: Record<string, string>;
  // instance override targets: componentId -> node index -> exact child name/type (precomputed offline)
  childNames?: Record<string, Record<string, { name: string; type: string }>>;
}

export interface JobResult {
  kind: JobInput["kind"];
  rootId: string | null;
  created: number;
  unsupported: string[];
  warnings: string[];
  ids: Record<string, string>;
}

export async function runJob(input: JobInput, fig: FigBuilder, raw: FigRaw): Promise<JobResult> {
  if (input?.schema !== "website-to-figma/connector-job" || input.schemaVersion !== 1) throw new Error("not a website-to-figma connector job");
  const host = new PlannedHost(fig, raw, input.imageHashes ?? {});
  const doc = input.doc;
  const page = input.pageId ? doc.pages.find((p) => p.id === input.pageId) : undefined;
  const lists: HifiNode[][] = input.batch ? [input.batch.nodes] : page && input.kind === "page" && input.withNodes ? [page.nodes, ...(page.states?.variants ?? []).map((v) => v.nodes)] : [];
  const { byNode, failedLoads } = await resolveFonts(host, doc, lists);
  const c: Ctx<FigWrapper> = { host, doc, fonts: byNode, failedLoads, stats: newStats(doc) };
  const ids: Record<string, string> = {};
  const below = (r: FigWrapper, gap: number) => host.bottomOf(r) + gap;
  let root: FigWrapper;
  if (input.kind === "root") {
    if (host.findUnique(input.rootName, "FRAME")) throw new Error(`a root named ${JSON.stringify(input.rootName)} already exists on this page; refusing to create a duplicate`);
    root = host.root({ name: input.rootName, x: input.originX, y: 0 });
    await label(c, root, `Hi-fi import · ${doc.site.host}`, 28, true, 80, 40);
  } else {
    const found = host.findUnique(input.rootName, "FRAME");
    if (!found) throw new Error(`root ${JSON.stringify(input.rootName)} not found; run the root job first`);
    root = found;
    if (input.kind === "label") {
      const l = input.label!;
      await label(c, root, l.text, l.size, l.bold, 80, below(root, l.gap), l.width, l.name);
    } else if (input.kind === "component") {
      const cm = (doc.components ?? []).find((x) => x.id === input.componentId);
      if (!cm) throw new Error(`component ${input.componentId} not in job input`);
      if (host.findIn(root, cm.name, "COMPONENT")) throw new Error(`component ${JSON.stringify(cm.name)} already exists`);
      await renderComponentShell(c, root, cm, below(root, 30));
    } else if (input.kind === "page") {
      if (!page) throw new Error(`page ${input.pageId} not in job input`);
      const components = new Map<string, FigWrapper>();
      for (const cm of doc.components ?? []) {
        const w = host.findIn(root, cm.name, "COMPONENT");
        if (w) components.set(cm.id, w);
      }
      const childNames = new Map(Object.entries(input.childNames ?? {}).map(([cid, m]) => [cid, new Map(Object.entries(m).map(([i, v]) => [Number(i), v]))]));
      if (input.part === "finish") {
        const frame = host.findIn(root, pageFrameName(page), "FRAME");
        if (!frame) throw new Error(`page frame ${JSON.stringify(pageFrameName(page))} not found; run its shell job first`);
        await renderPageDecorations(c, frame, page, components, childNames);
      } else {
        const r = await renderPage(c, root, page, below(root, 24), components, { nodes: input.withNodes === true, notes: false, states: input.withNodes === true, decorations: input.part !== "shell", childNames });
        await host.flush();
        ids.frame = r.frame.node.id;
      }
    } else if (input.kind === "states") {
      if (!page?.states) throw new Error(`page ${input.pageId} has no states in job input`);
      await renderStates(c, root, page, below(root, 80), { nodes: false });
    } else if (input.kind === "nodes") {
      const t = input.target!;
      const b = input.batch!;
      let parent: FigWrapper | null = null;
      let clips = [] as NonNullable<NonNullable<typeof page>["clips"]>;
      let prefix = (_i: number) => "";
      let bprefix = (_o: number) => "";
      if (t.type === "page") {
        if (!page) throw new Error(`page ${t.pageId} not in job input`);
        parent = host.findIn(root, pageFrameName(page), "FRAME");
        clips = page.clips ?? [];
      } else if (t.type === "component") {
        const cm = (doc.components ?? []).find((x) => x.id === t.componentId);
        if (cm) parent = host.findIn(root, cm.name, "COMPONENT");
        prefix = (i) => `#${b.orig[i]} `;
        bprefix = (o) => `#${o} `;
      } else {
        if (!page) throw new Error(`page ${t.pageId} not in job input`);
        const set = host.findIn(root, statesSetName(page), "COMPONENT_SET");
        parent = set ? host.findIn(set, `State=${t.variant}`, "COMPONENT") : null;
      }
      if (!parent) throw new Error(`target ${JSON.stringify(t)} not found; run its earlier job first`);
      const bl = (o: number) => (Object.prototype.hasOwnProperty.call(b.buttonLabels, String(o)) ? b.buttonLabels[String(o)]! : null);
      const local = new Set(b.orig);
      const clipMap = new Map<number, FigWrapper | null>();
      const btnMap = new Map<number, FigWrapper | null>();
      // Resolve earlier frames BEFORE creating anything (raw reads only while nothing is pending).
      for (const n of b.nodes) {
        const ci = n.clip !== undefined && n.clip >= 0 ? n.clip : -1;
        if (ci >= 0 && clips[ci] && !(b.createClips && b.phase === "clipped") && !clipMap.has(ci)) clipMap.set(ci, host.findIn(parent, clipName(clips[ci]!, ci), "FRAME"));
        if (n.kind === "text" && n.button >= 0 && !local.has(n.button) && !btnMap.has(n.button)) btnMap.set(n.button, host.findIn(parent, buttonName(bl(n.button), n.button, bprefix(n.button)), "FRAME"));
      }
      if (b.description !== undefined) host.describe(parent, b.description);
      await renderNodes(c, parent, b.nodes, clips, prefix, {
        phase: b.phase,
        createClips: b.createClips,
        orig: (i) => b.orig[i]!,
        buttonLabel: bl,
        buttonBox: (o) => b.buttonBoxes[String(o)] ?? null,
        findClip: (i) => clipMap.get(i) ?? null,
        findButton: (o) => btnMap.get(o) ?? null,
      });
    } else {
      const frames = new Map<string, { node: FigWrapper; x: number; y: number; name: string }>();
      for (const p of doc.pages) {
        const f = host.findIn(root, pageFrameName(p), "FRAME");
        if (f) frames.set(p.id, { node: f, x: f.node.x, y: f.node.y, name: pageFrameName(p) });
      }
      await renderEdges(c, root, frames);
      await host.flush();
      await host.resizeRoot(root, Math.max(1300, ...(root.node.children ?? []).map((ch) => ch.x + ch.width + 80)), host.bottomOf(root) + 120);
    }
  }
  await host.flush();
  finishWarnings(c);
  return { kind: input.kind, rootId: root.node.id, created: host.created.length, unsupported: [...host.unsupported], warnings: c.stats.warnings.slice(0, 50), ids };
}
