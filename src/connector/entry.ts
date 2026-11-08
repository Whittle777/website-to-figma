// Connector job runner (bundled as an IIFE, global W2F). One job per script:
//   W2F.runJob(input, $fig, figma)
// Jobs: "root" (root frame, intro, shared components), "page" (page shell,
// optionally with all nodes and states), "nodes" (a phase-ordered batch of a
// page's nodes), "edges" (sitemap edges + final root size). Later jobs find
// earlier nodes by deterministic unique names (post-flush raw reads only).
import type { HifiDoc } from "../shared/hifiSchema";
import { allNodeLists, finishWarnings, newStats, pageFrameName, clipName, buttonName, renderComponents, renderEdges, renderIntro, renderNodes, renderPage, resolveFonts, type Ctx } from "../../plugin/src/render/renderer";
import { PlannedHost, type FigBuilder, type FigRaw, type FigWrapper } from "./plannedHost";

export interface JobInput {
  schema: "website-to-figma/connector-job";
  schemaVersion: 1;
  kind: "root" | "page" | "nodes" | "edges";
  rootName: string;
  originX: number;
  doc: HifiDoc; // pruned: no image bytes
  pageId?: string;
  withNodes?: boolean;
  // assetId -> existing Figma image hash (origin-supplied, sanctioned upload)
  imageHashes?: Record<string, string>;
  // node batch: the page carries ONLY these nodes; orig[i] is each node's index in the full page
  batch?: { phase: "unclipped" | "clipped" | "text"; orig: number[]; createClips: boolean; buttonLabels: Record<string, string | null>; buttonBoxes: Record<string, { x: number; y: number }> };
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
  const lists = input.kind === "root" ? (doc.components ?? []).map((c) => c.nodes) : page ? [page.nodes, ...(page.states?.variants ?? []).map((v) => v.nodes)] : [];
  const { byNode, failedLoads } = await resolveFonts(host, doc, lists.length ? lists : allNodeLists({ ...doc, pages: [] }));
  const c: Ctx<FigWrapper> = { host, doc, fonts: byNode, failedLoads, stats: newStats(doc) };
  const ids: Record<string, string> = {};
  let root: FigWrapper;
  if (input.kind === "root") {
    if (host.findUnique(input.rootName, "FRAME")) throw new Error(`a root named ${JSON.stringify(input.rootName)} already exists on this page; refusing to create a duplicate`);
    root = host.root({ name: input.rootName, x: input.originX, y: 0 });
    const y = await renderIntro(c, root);
    const comps = await renderComponents(c, root, y);
    await host.flush();
    for (const [id, w] of comps.components) ids[id] = w.node.id;
  } else {
    const found = host.findUnique(input.rootName, "FRAME");
    if (!found) throw new Error(`root ${JSON.stringify(input.rootName)} not found; run the root job first`);
    root = found;
    if (input.kind === "page") {
      if (!page) throw new Error(`page ${input.pageId} not in job input`);
      const components = new Map<string, FigWrapper>();
      for (const cm of doc.components ?? []) {
        const w = host.findIn(root, cm.name, "COMPONENT");
        if (w) components.set(cm.id, w);
      }
      const y = host.bottomOf(root) + 120;
      const r = await renderPage(c, root, page, y, components, { nodes: input.withNodes !== false });
      await host.flush();
      ids.frame = r.frame.node.id;
    } else if (input.kind === "nodes") {
      if (!page || !input.batch) throw new Error("nodes job needs pageId and batch");
      const frame = host.findIn(root, pageFrameName(page), "FRAME");
      if (!frame) throw new Error(`page frame ${JSON.stringify(pageFrameName(page))} not found; run its page job first`);
      const clips = page.clips ?? [];
      const b = input.batch;
      const bl = (o: number) => (Object.prototype.hasOwnProperty.call(b.buttonLabels, String(o)) ? b.buttonLabels[String(o)]! : null);
      // Resolve every earlier frame this batch needs BEFORE creating anything
      // (raw lookups only while nothing is pending).
      const local = new Set(b.orig);
      const clipMap = new Map<number, FigWrapper | null>();
      const btnMap = new Map<number, FigWrapper | null>();
      for (const n of page.nodes) {
        const ci = n.clip !== undefined && n.clip >= 0 ? n.clip : -1;
        if (ci >= 0 && !(b.createClips && b.phase === "clipped") && !clipMap.has(ci)) clipMap.set(ci, host.findIn(frame, clipName(clips[ci]!, ci), "FRAME"));
        if (n.kind === "text" && n.button >= 0 && !local.has(n.button) && !btnMap.has(n.button)) btnMap.set(n.button, host.findIn(frame, buttonName(bl(n.button), n.button, ""), "FRAME"));
      }
      await renderNodes(c, frame, page.nodes, clips, () => "", {
        phase: b.phase,
        createClips: b.createClips,
        orig: (i) => b.orig[i]!,
        buttonLabel: bl,
        buttonBox: (o) => b.buttonBoxes[String(o)] ?? null,
        findClip: (i) => clipMap.get(i) ?? null,
        findButton: (o) => btnMap.get(o) ?? null,
      });
      await host.flush();
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
  finishWarnings(c);
  return { kind: input.kind, rootId: root.node.id, created: host.created.length, unsupported: [...host.unsupported], warnings: c.stats.warnings.slice(0, 50), ids };
}
