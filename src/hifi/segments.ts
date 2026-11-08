// Split pages taller than the per-frame bound (30000 px) into at most
// LIMITS.hifiMaxPageSegments consecutive segment pages, so measured nodes far
// down a document (e.g. a state target at y 75000) stay editable instead of
// being truncated. Pure and bounded: node arrays are partitioned, never
// copied per pixel; coordinates become segment-local; button/clip indices are
// remapped per segment. State variants, references and freeze/motion records
// stay with segment 0; media items move to the segment holding their top.
import { LIMITS } from "../shared/limits";
import { cleanText } from "../shared/text";
import type { HifiNode, HifiPage } from "../shared/hifiSchema";

const SEG = LIMITS.hifiMaxPageHeight;

function segOf(y: number, count: number): number {
  return Math.min(count - 1, Math.max(0, Math.floor(y / SEG)));
}

export function splitTallPage(page: HifiPage): HifiPage[] {
  if (page.height <= SEG) return [page];
  const count = Math.min(LIMITS.hifiMaxPageSegments, Math.ceil(page.height / SEG));
  const clips = page.clips ?? [];
  const clipSeg = clips.map((c) => segOf(c.y, count));
  const out: HifiPage[] = [];
  for (let k = 0; k < count; k++) {
    const y0 = k * SEG;
    const h = Math.min(SEG, page.height - y0);
    const keep: number[] = [];
    page.nodes.forEach((n, i) => {
      if (segOf(n.y, count) === k) keep.push(i);
    });
    const index = new Map(keep.map((old, j) => [old, j]));
    const segClips = clips.map((c, ci) => ({ c, ci })).filter((x) => clipSeg[x.ci] === k);
    const clipIndex = new Map(segClips.map((x, j) => [x.ci, j]));
    let spanning = 0;
    const nodes: HifiNode[] = keep.map((i) => {
      const n = { ...page.nodes[i]!, y: page.nodes[i]!.y - y0 } as HifiNode;
      if (n.y + n.h > h) spanning++;
      if (n.clip !== undefined && n.clip >= 0) {
        const c = clipIndex.get(n.clip);
        if (c === undefined) delete (n as { clip?: number }).clip;
        else n.clip = c;
      }
      if (n.kind === "text") n.button = n.button >= 0 ? (index.get(n.button) ?? -1) : -1;
      return n;
    });
    const note = cleanText(`Segment ${k + 1}/${count} of a ${Math.round(page.height)}px document (y ${y0}-${y0 + h}); split because page frames are bounded at ${SEG}px${spanning ? `; ${spanning} node(s) extend past this segment and are clipped` : ""}`, LIMITS.maxNoteChars);
    const seg: HifiPage = {
      ...page,
      title: cleanText(`${page.title} (part ${k + 1}/${count})`, LIMITS.maxTitleChars),
      height: h,
      truncated: k === count - 1 ? page.truncated : false,
      nodes,
      warnings: k === 0 ? page.warnings : [],
      notes: [...(k === 0 ? (page.notes ?? []) : []), note].slice(0, LIMITS.hifiMaxWarnings),
      segment: { index: k, count, offsetY: y0, sourceHeight: page.height },
    };
    if (segClips.length) seg.clips = segClips.map((x) => ({ ...x.c, y: x.c.y - y0 }));
    else delete seg.clips;
    const inst = (page.instances ?? []).filter((x) => segOf(x.y, count) === k).map((x) => ({ ...x, y: x.y - y0 }));
    if (inst.length) seg.instances = inst;
    else delete seg.instances;
    const media = (page.media ?? []).filter((m) => segOf(m.y, count) === k).map((m) => ({ ...m, y: m.y - y0 }));
    if (media.length) seg.media = media;
    else delete seg.media;
    if (k > 0) {
      seg.referenceAssetId = null;
      delete seg.referenceTiles;
      delete seg.states;
      delete seg.freeze;
      delete seg.motion;
      delete seg.normalization;
    }
    out.push(seg);
  }
  return out;
}

// Split every tall page, renumber ids (p0..) and remap parent ids; later
// segments hang off their first segment in the sitemap. Bounded by hifiMaxPages.
export function splitTallPages(pages: HifiPage[], warn: (w: string) => void): HifiPage[] {
  const out: { page: HifiPage; oldId: string; first: boolean }[] = [];
  for (const p of pages) {
    const segs = splitTallPage(p);
    segs.forEach((s, i) => out.push({ page: s, oldId: p.id, first: i === 0 }));
  }
  if (out.length > LIMITS.hifiMaxPages) {
    warn(`Page segments exceed the ${LIMITS.hifiMaxPages}-page bound; ${out.length - LIMITS.hifiMaxPages} trailing segment(s) omitted`);
    out.length = LIMITS.hifiMaxPages;
  }
  const newId = new Map<string, string>();
  out.forEach((x, i) => {
    if (x.first) newId.set(x.oldId, `p${i}`);
  });
  return out.map((x, i) => ({
    ...x.page,
    id: `p${i}`,
    parentId: x.first ? (x.page.parentId ? (newId.get(x.page.parentId) ?? null) : null) : (newId.get(x.oldId) ?? null),
  }));
}
