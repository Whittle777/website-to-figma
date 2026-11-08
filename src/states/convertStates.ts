// Capture-page states/freeze/motion/media -> optional schema v2 page fields.
// Pure and offline. Every variant is converted from ITS OWN measurement by
// the normal converter (no normalization, no reference matching), then
// cropped to the state's frame. Synthetic variants are labelled synthetic
// (DOM modification, not the page's observed original state); failed or
// unmeasured states are omitted with a warning, never invented.
import { LIMITS } from "../shared/limits";
import { cleanText } from "../shared/text";
import { MAX_VARIANT_NODES, STATE_NAME, type HifiDoc, type HifiNode, type HifiPage, type MediaItem, type StateVariant } from "../shared/hifiSchema";
import { canonicalizeUrl } from "../normalize/canonicalize";
import { parseHttpUrl } from "../security/urlGuard";
import type { LoadedAsset } from "../hifi/convert";

type Obj = Record<string, unknown>;
type Rect = { x: number; y: number; w: number; h: number };
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const fin = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 100_000 ? v : null);
const note = (s: string) => cleanText(s, LIMITS.maxNoteChars);

export interface StateContext {
  rawPages: unknown[];
  pages: HifiPage[];
  assets: LoadedAsset[];
  assetIdFor: (a: LoadedAsset) => string | null; // null when the asset budget is full
  convertOne: (rawPage: Obj) => HifiDoc;
  reactions: "none" | "click-cycle";
  nodeBudget: number; // remaining whole-document node budget
  warn: (w: string) => void;
}

function rectOf(v: unknown): Rect | null {
  if (!isObj(v)) return null;
  const x = fin(v.x), y = fin(v.y), w = fin(v.w), h = fin(v.h);
  return x !== null && y !== null && w !== null && h !== null && w >= 1 && h >= 1 ? { x, y, w, h } : null;
}

function safeUrl(v: unknown): string | null {
  if (typeof v !== "string" || v.length === 0 || v.length > LIMITS.maxUrlChars) return null;
  try {
    return parseHttpUrl(v).toString();
  } catch {
    return null;
  }
}

// Nodes intersecting the frame, translated into frame space; clip groups are
// dropped (the variant frame clips) and button indices are remapped.
export function cropNodes(nodes: HifiNode[], frame: Rect, max: number): { nodes: HifiNode[]; dropped: number } {
  const keep: number[] = [];
  nodes.forEach((n, i) => {
    if (n.x < frame.x + frame.w && n.x + n.w > frame.x && n.y < frame.y + frame.h && n.y + n.h > frame.y) keep.push(i);
  });
  const kept = keep.slice(0, max);
  const index = new Map(kept.map((old, i) => [old, i]));
  const out = kept.map((i) => {
    const { clip: _clip, ...n } = nodes[i]! as HifiNode & { clip?: number };
    const moved = { ...n, x: n.x - frame.x, y: n.y - frame.y } as HifiNode;
    if (moved.kind === "text") moved.button = moved.button >= 0 ? (index.get(moved.button) ?? -1) : -1;
    return moved;
  });
  return { nodes: out, dropped: keep.length - kept.length };
}

function frameOf(st: Obj, fallbackW: number): Rect {
  const scope = rectOf(st.scope);
  if (scope) return { x: scope.x, y: scope.y, w: Math.min(scope.w, LIMITS.hifiMaxPageWidth), h: Math.min(scope.h, LIMITS.hifiMaxPageHeight) };
  const vp = isObj(st.viewport) ? st.viewport : {};
  const w = fin(vp.width) ?? fallbackW;
  const h = fin(vp.height) ?? 800;
  return { x: 0, y: fin(st.screenshotScrollY) ?? 0, w: Math.max(1, Math.min(w, LIMITS.hifiMaxPageWidth)), h: Math.max(1, Math.min(h, LIMITS.hifiMaxPageHeight)) };
}

export function attachStates(ctx: StateContext): void {
  let budget = ctx.nodeBudget;
  for (const raw of ctx.rawPages) {
    if (!isObj(raw) || typeof raw.url !== "string") continue;
    let canonical: string;
    try {
      canonical = canonicalizeUrl(parseHttpUrl(raw.url));
    } catch {
      continue;
    }
    const page = ctx.pages.find((p) => p.url === canonical);
    if (!page) continue;
    const pw = (msg: string) => {
      if (page.warnings.length < LIMITS.hifiMaxWarnings) page.warnings.push(note(msg));
    };
    const rawStates = Array.isArray(raw.states) ? raw.states.filter(isObj).slice(0, 3) : [];
    const stateRefs = ctx.assets.filter((a) => a.kind === "reference" && a.state && a.pageUrl && canonicalizeUrl(a.pageUrl) === canonical);

    if (rawStates.length || stateRefs.length) {
      const variants: StateVariant[] = [];
      const base = rawStates.find((s) => s.seq === 0) ?? null;
      const ordered = base ? [base, ...rawStates.filter((s) => s !== base && s.provenance === "synthetic")] : [];
      const firstScope = ordered.find((s) => rectOf(s.scope));
      for (const st of ordered) {
        const name = typeof st.name === "string" && STATE_NAME.test(st.name) ? st.name : null;
        const isBase = st === base;
        if (!name || (isBase && name !== "Default")) {
          pw(`State ${String(st.seq)} omitted: invalid name`);
          continue;
        }
        if (variants.some((v) => v.name.toLowerCase() === name.toLowerCase())) {
          pw(`State "${name}" omitted: duplicate name`);
          continue;
        }
        if (typeof st.error === "string" && st.error) {
          pw(`State "${name}" omitted: browser step failed (${st.error}); it reverted its own modifications`);
          continue;
        }
        if (!isObj(st.measured)) {
          pw(`State "${name}" omitted: no measurement`);
          continue;
        }
        let sub: HifiDoc;
        try {
          sub = ctx.convertOne({ url: raw.url, measured: st.measured, ...(typeof st.html === "string" ? { html: st.html } : {}) });
        } catch (err) {
          pw(`State "${name}" omitted: ${err instanceof Error ? err.message : "conversion failed"}`);
          continue;
        }
        const subPage = sub.pages[0]!;
        // A baseline without its own scope uses the first state's scope rect when given.
        const frame = frameOf(isBase && !rectOf(st.scope) && firstScope ? { ...st, scope: firstScope.scope } : st, subPage.width);
        const cropped = cropNodes(subPage.nodes, frame, Math.min(MAX_VARIANT_NODES, budget));
        // Re-home sub-document image assets onto the main document's asset list.
        const nodes = cropped.nodes.map((n) => {
          if (n.kind !== "image" || n.assetId === null) return n;
          const sha = sub.assets.find((a) => a.id === n.assetId)?.sha256;
          const loaded = sha ? ctx.assets.find((a) => a.sha256 === sha && a.kind === "image") : undefined;
          return { ...n, assetId: loaded ? ctx.assetIdFor(loaded) : null };
        });
        budget -= nodes.length;
        const notes: string[] = [];
        if (isBase) notes.push("Baseline: the page as measured, before any state modification");
        else {
          const applied = Array.isArray(st.applied) ? st.applied.filter(isObj).map((a) => `${String(a.mechanism)} ${String(a.selector)}`) : [];
          notes.push(`SYNTHETIC state: DOM modification (${applied.join("; ").slice(0, 120) || "none applied"}), not an observed original state`);
          notes.push("No handler side-effect guarantee: page observers/callbacks may have reacted to the modification");
          if (Array.isArray(st.refused) && st.refused.length) notes.push(`${st.refused.length} mutation(s) refused (unsafe or custom element, invalid selector)`);
          if (Array.isArray(st.missing) && st.missing.length) notes.push(`${st.missing.length} selector(s) matched nothing`);
          if (!applied.length) pw(`State "${name}": no modification applied; it may equal the baseline`);
        }
        if (typeof st.residueFromSeq === "number") notes.push(`Revert of state ${st.residueFromSeq} unconfirmed; may include its modifications`);
        if (st.truncated === true) notes.push("Measurement truncated by the per-state byte bound");
        if (cropped.dropped) notes.push(`${cropped.dropped} node(s) omitted by the variant node cap`);
        const ref = stateRefs.find((a) => a.state!.toLowerCase() === name.toLowerCase());
        const vp = isObj(st.viewport) ? st.viewport : {};
        const assoc = st.screenshot === "action-order" ? "action-order" : "unassociated";
        variants.push({
          name,
          provenance: isBase ? "baseline" : "synthetic",
          frame,
          nodes,
          referenceAssetId: ref ? ctx.assetIdFor(ref) : null,
          screenshot: { association: assoc, scrollY: fin(st.screenshotScrollY), viewportW: fin(vp.width), viewportH: fin(vp.height) },
          notes: notes.slice(0, 10).map(note),
        });
        if (ref && assoc !== "action-order") pw(`State "${name}": screenshot was not tied to this state by action order; check the operator's manifest label`);
      }
      // Manual (operator-captured) states: screenshot only, never measured.
      const plannedNames = new Set(rawStates.map((s) => (typeof s.name === "string" ? s.name.toLowerCase() : "")));
      for (const ref of stateRefs) {
        if (variants.some((v) => v.name.toLowerCase() === ref.state!.toLowerCase())) continue;
        // A screenshot named after a planned (failed/omitted) state is never relabelled as manual.
        if (plannedNames.has(ref.state!.toLowerCase())) {
          pw(`Screenshot for omitted state "${ref.state}" not used`);
          continue;
        }
        if (variants.length === 0) {
          pw(`Manual state "${ref.state}" omitted: no measured baseline variant on this page`);
          continue;
        }
        if (variants.length >= 3) {
          pw(`Manual state "${ref.state}" omitted: 3-state limit reached`);
          continue;
        }
        const id = ctx.assetIdFor(ref);
        if (!id) {
          pw(`Manual state "${ref.state}" omitted: asset budget full`);
          continue;
        }
        variants.push({
          name: ref.state!,
          provenance: "manual",
          frame: { x: 0, y: 0, w: ref.width, h: ref.height },
          nodes: [{ kind: "image", name: `Manual screenshot / ${ref.state}`, x: 0, y: 0, w: ref.width, h: ref.height, assetId: id, fit: "fill", radius: [0, 0, 0, 0], prov: "measured" }],
          referenceAssetId: null,
          screenshot: { association: "manual", scrollY: null, viewportW: null, viewportH: null },
          notes: [note("MANUAL state: operator-captured screenshot only; not measured, layers are not editable")],
        });
        budget -= 1;
      }
      if (variants.length) page.states = { reactions: variants.length > 1 ? ctx.reactions : "none", variants };
    }

    // Freeze report (from the freeze step), motion/media (from the baseline step).
    if (isObj(raw.freeze)) {
      const f = raw.freeze;
      const labels = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 10).map(note).filter(Boolean) : []);
      const applied = isObj(f.applied)
        ? Object.entries(f.applied)
            .slice(0, 10)
            .filter(([k, n]) => k.length > 0 && Number.isInteger(n) && (n as number) >= 0)
            .map(([k, n]) => ({ name: cleanText(k, 60), count: Math.min(n as number, 100_000) }))
        : [];
      page.freeze = { attempted: labels(f.attempted), applied, unavailable: labels(f.unavailable), modifications: labels(f.modifications), notFrozen: labels(f.notFrozen) };
      if (page.freeze.modifications.length) pw(`Freeze step modified the page: ${page.freeze.modifications.join("; ")}`);
    }
    const base = Array.isArray(raw.states) ? raw.states.find((s) => isObj(s) && s.seq === 0) : undefined;
    if (isObj(base) && isObj(base.motion)) {
      const m = base.motion;
      const rules = Array.isArray(m.rules)
        ? m.rules
            .filter(isObj)
            .filter((r) => (r.kind === "transition" || r.kind === "animation" || r.kind === "hover") && typeof r.selector === "string" && r.selector.trim())
            .slice(0, 200)
            .map((r) => ({ selector: cleanText(String(r.selector), 200) || "?", kind: r.kind as "transition" | "animation" | "hover", detail: cleanText(typeof r.detail === "string" ? r.detail : "", 200) }))
        : [];
      const inaccessible = Number.isInteger(m.inaccessibleSheets) ? Math.min(Math.max(0, m.inaccessibleSheets as number), 1_000) : 0;
      page.motion = { rules, inaccessibleSheets: inaccessible };
      if (inaccessible) pw(`${inaccessible} stylesheet(s) were not readable (cross-origin); their transitions/animations/hover rules are unknown`);
    }
    if (isObj(base) && Array.isArray(base.media)) {
      const media: MediaItem[] = [];
      for (const m of base.media.filter(isObj).slice(0, 50)) {
        const r = rectOf(m);
        if (!r || !["video", "canvas", "lottie", "iframe"].includes(String(m.kind))) continue;
        const poster = safeUrl(m.poster);
        const loaded = poster ? ctx.assets.find((a) => a.kind === "image" && a.sourceUrl === poster) : undefined;
        const stillId = loaded ? ctx.assetIdFor(loaded) : null;
        media.push({
          kind: m.kind as MediaItem["kind"],
          ...r,
          poster,
          src: safeUrl(m.src),
          webgl: typeof m.webgl === "boolean" ? m.webgl : null,
          stillAssetId: stillId,
          still: stillId ? "operator-asset" : poster ? "poster-url-observed-not-downloaded" : "unavailable",
        });
      }
      if (media.length) {
        page.media = media;
        const missing = media.filter((m) => m.still !== "operator-asset").length;
        if (missing) pw(`${missing} media item(s) (video/canvas/lottie/iframe) have no still image; shown as labelled placeholders`);
      }
    }
  }
}
