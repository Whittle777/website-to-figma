// Offline parsing of tagged executeJavascript returns (see scripts.ts) from a
// locally saved scrape response. Nothing is fetched: screenshot URLs are only
// listed as hints (they expire, and this tool never downloads them).
//
// Association: each planned state has exactly one screenshot and one scrape
// action, in state order. data.actions.screenshots[i] / scrapes[i] are tied to
// state seq i ONLY when every state 0..n-1 returned and the screenshot (and
// scrape) counts equal n; otherwise screenshots stay unassociated.
import { LIMITS } from "../shared/limits";
import { STATE_LIMITS } from "./plan";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

export interface AdaptedStates {
  baseline: Obj | null;
  // capture-page fields (bounded, still untrusted: the converter re-checks)
  states: Obj[];
  freeze: Obj | null;
  lazy: Obj | null;
  warnings: string[];
  screenshotHints: { state: string; seq: number; screenshotUrl: string; scrollY: number | null }[];
}

export function adaptTaggedReturns(data: Obj, name: string): AdaptedStates | null {
  const actions = isObj(data.actions) ? data.actions : null;
  const returns = actions && Array.isArray(actions.javascriptReturns) ? actions.javascriptReturns.slice(0, STATE_LIMITS.providerMaxActions) : [];
  const values = returns.map((r) => (isObj(r) ? r.value : undefined)).filter(isObj);
  if (!values.some((v) => v.w2f === "state")) return null;
  const warnings: string[] = [];
  const out: AdaptedStates = { baseline: null, states: [], freeze: null, lazy: null, warnings, screenshotHints: [] };
  const reverts = new Map<number, Obj>();
  const bySeq = new Map<number, Obj>();
  for (const v of values) {
    if (v.w2f === "freeze" && !out.freeze) out.freeze = v;
    else if (v.w2f === "lazy" && !out.lazy) out.lazy = v;
    else if (v.w2f === "scroll") out.lazy = { w2f: "lazy", steps: v.steps, finalY: v.y, coverageComplete: v.coverageComplete === true && (out.lazy?.coverageComplete ?? true) !== false };
    else if (v.w2f === "revert" && typeof v.seq === "number") reverts.set(v.seq, v);
    else if (v.w2f === "state" && typeof v.seq === "number" && Number.isInteger(v.seq) && v.seq >= 0 && v.seq < STATE_LIMITS.maxStatesPerPage) {
      if (bySeq.has(v.seq)) {
        warnings.push(`${name}: duplicate state seq ${v.seq} ignored`);
        continue;
      }
      // Per-state byte bound (also enforced in-browser).
      if (JSON.stringify(v).length > STATE_LIMITS.maxStateReturnChars) {
        warnings.push(`${name}: state ${v.seq} return exceeds ${STATE_LIMITS.maxStateReturnChars} chars; omitted`);
        continue;
      }
      bySeq.set(v.seq, v);
    }
  }
  const n = bySeq.size;
  const contiguous = [...Array(n).keys()].every((i) => bySeq.has(i));
  const shots = actions && Array.isArray(actions.screenshots) ? actions.screenshots : [];
  const scrapes = actions && Array.isArray(actions.scrapes) ? actions.scrapes : [];
  const associated = contiguous && shots.length === n && shots.every((s) => typeof s === "string");
  const htmlAssociated = contiguous && scrapes.length === n;
  if (!associated) warnings.push(`${name}: ${shots.length} screenshot(s) for ${n} state return(s)${contiguous ? "" : " (non-contiguous seq)"}; screenshots NOT associated with states`);
  if (!htmlAssociated && scrapes.length) warnings.push(`${name}: ${scrapes.length} scrape(s) for ${n} state return(s); per-state HTML NOT associated`);

  // A failed or missing revert taints every later state (possible residue).
  let tainted: number | null = null;
  for (const seq of [...bySeq.keys()].sort((a, b) => a - b)) {
    const s = bySeq.get(seq)!;
    const synthetic = s.provenance === "synthetic";
    const st: Obj = {
      seq,
      name: typeof s.name === "string" ? s.name.slice(0, 40) : `State ${seq}`,
      provenance: seq === 0 ? "baseline" : synthetic ? "synthetic" : "invalid",
      scope: isObj(s.scope) ? s.scope : null,
      screenshotScrollY: typeof s.screenshotScrollY === "number" ? s.screenshotScrollY : null,
      viewport: isObj(s.viewport) ? s.viewport : null,
      measured: isObj(s.measured) ? s.measured : null,
      applied: Array.isArray(s.applied) ? s.applied.slice(0, 25) : [],
      refused: Array.isArray(s.refused) ? s.refused.slice(0, 25) : [],
      missing: Array.isArray(s.missing) ? s.missing.slice(0, 25) : [],
      truncated: s.truncated === true,
      error: typeof s.error === "string" ? s.error.slice(0, 200) : null,
      residueFromSeq: tainted,
      screenshot: associated ? "action-order" : "unassociated",
    };
    if (seq > 0 && !synthetic) warnings.push(`${name}: state ${seq} is not labelled synthetic; omitted`);
    if (htmlAssociated) {
      const sc = scrapes[seq];
      const html = isObj(sc) ? sc.html : undefined;
      if (typeof html === "string" && html.length <= LIMITS.maxHtmlChars) st.html = html;
    }
    if (seq === 0) {
      out.baseline = isObj(s.measured) ? s.measured : null;
      if (isObj(s.motion)) st.motion = s.motion;
      if (Array.isArray(s.media)) st.media = s.media.slice(0, 50);
    }
    if (associated) out.screenshotHints.push({ state: st.name as string, seq, screenshotUrl: String(shots[seq]).slice(0, LIMITS.maxUrlChars), scrollY: st.screenshotScrollY as number | null });
    if (seq === 0 || synthetic) out.states.push(st);
    if (synthetic) {
      const rv = reverts.get(seq);
      if (!rv || rv.failed !== 0 || (s.error === undefined && typeof rv.reverted === "number" && Array.isArray(s.applied) && rv.reverted < s.applied.length)) {
        if (seq < Math.max(...bySeq.keys())) warnings.push(`${name}: revert of state ${seq} unconfirmed; later states may include its modifications`);
        tainted ??= seq;
      }
    }
  }
  return out;
}
