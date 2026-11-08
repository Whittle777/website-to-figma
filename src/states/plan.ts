// Offline state/motion PLANNER. Validates an operator state-plan file and
// builds exact Firecrawl /v2/scrape request PREVIEWS. It sends nothing, reads
// no key, resolves no DNS and has no executor: automatic state capture is NOT
// supported by this tool. Synthetic state modifications in a preview are for
// manual operator review only, with NO handler side-effect guarantee (see
// scripts.ts). Provider cost of these requests is unknown and not estimated.
import { parseHttpUrl } from "../security/urlGuard";
import { FREEZE_JS, REVERT_JS, SCROLL_JS, STATE_JS } from "./scripts";

export class StatePlanError extends Error {}

// Firecrawl docs (scrape actions): "up to 50 actions per request, and the
// combined wait time across all wait actions and waitFor must not exceed 60
// seconds". This tool's own budgets are stricter by default and also count
// Firecrawl source (apps/api/src/controllers/v2/types.ts): MAX_ACTIONS = 50,
// ACTIONS_MAX_WAIT_TIME = 60 s counted as waitFor + wait.milliseconds (a
// selector wait counts 1 s), wait.milliseconds must be a positive integer.
// All scripts here are synchronous and never sleep, so the provider's wait
// accounting is exactly our combined wait (in-script sleep is always 0).
export const STATE_LIMITS = {
  providerMaxActions: 50,
  providerMaxCombinedWaitMs: 60_000,
  defaultMaxActions: 20,
  defaultMaxCombinedWaitMs: 30_000,
  maxPages: 3,
  maxStatesPerPage: 3, // TOTAL, baseline included
  maxMutationsPerState: 5,
  maxManualPerPage: 5,
  maxSelectorChars: 200,
  maxNameChars: 40,
  maxPageWaitMs: 10_000,
  maxLazySteps: 10,
  maxLazyPx: 30_000,
  maxLazyStepWaitMs: 2_000,
  maxVisibilityMs: 5_000,
  // Request timeout = min(max, base + 2 x combined waits + per-state); the
  // combined wait never exceeds half of it (mirrors the provider's waitFor rule).
  requestTimeoutBaseMs: 20_000,
  requestTimeoutPerStateMs: 10_000,
  maxRequestTimeoutMs: 120_000,
  // SDK 4.52 with autoResume false uses timeout + 5000 as the HTTP timeout
  // (dist/index.js:564); our own wall clock adds a further margin.
  sdkTimeoutMarginMs: 5_000,
  wallClockMarginMs: 30_000,
  maxStateReturnChars: 6_000_000, // per measured state, enforced in-browser and by the adapter
} as const;

export type Mechanism = "details-open" | "attribute-set" | "class-add";
export interface Mutation {
  mechanism: Mechanism;
  selector: string;
  attribute?: string;
  value?: string | null;
  className?: string;
}
// Non-synthetic, narrowly scoped triggers (no clicks, no event dispatch):
//  - "scroll-reveal": the planned bounded scroll steps run immediately before
//    this state, so it records the page's OWN reaction to scrolling (e.g. AOS
//    scroll listeners). Provenance "scroll-triggered" (observed).
//  - "swiper-next": the page's own Swiper instance bound to exactly one
//    element (`el.swiper`, set by Swiper's mount) is advanced with
//    slideNext(0) - the same API its autoplay calls. Provenance "page-api":
//    an actual library state reached early via the page API, not a user
//    event; Swiper's own event listeners run.
export type StateTrigger = "scroll-reveal" | "swiper-next";
export type StateProvenance = "baseline" | "synthetic" | "scroll-triggered" | "page-api";
export interface PlannedState {
  name: string;
  scope: string | null;
  mutations: Mutation[];
  trigger?: StateTrigger;
  selector?: string;
}

export function provenanceOf(s: PlannedState): StateProvenance {
  if (s.trigger === "scroll-reveal") return "scroll-triggered";
  if (s.trigger === "swiper-next") return "page-api";
  return s.mutations.length ? "synthetic" : "baseline";
}
export interface ManualState {
  name: string;
  selector: string;
  reason: string;
}
export interface PlannedPage {
  url: string;
  waitMs: number;
  lazy: { steps: number; maxPx: number; stepWaitMs: number; visibilityMs: number };
  states: PlannedState[]; // [0] is the implicit baseline "Default"
  manual: ManualState[];
}
export interface StatePlan {
  site: string;
  forceAos: boolean;
  maxActions: number;
  maxCombinedWaitMs: number;
  pages: PlannedPage[];
}

const ATTRIBUTES = new Set(["open", "aria-expanded", "aria-selected", "aria-hidden", "hidden", "data-state"]);
const REFUSED_MECHANISMS: Record<string, string> = {
  click: "selectors do not prove that a click handler is safe (it may submit, log in, buy, navigate or open outbound links)",
  hover: "real :hover cannot be forced without a pointer event",
  focus: "focus handlers are not provably safe",
  write: "typing into inputs is never planned",
  press: "key presses are never planned",
  submit: "form submission is never planned",
  navigate: "navigation is never planned",
  executeJavascript: "arbitrary page JavaScript is never planned",
};
const NAME = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,39}$/;
const CLASS = /^[A-Za-z_-][A-Za-z0-9_-]{0,63}$/;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function keys(o: Obj, p: string, allowed: string[]) {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new StatePlanError(`${p}: unknown key "${k}"`);
}

function int(v: unknown, p: string, dflt: number, min: number, max: number): number {
  if (v === undefined) return dflt;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw new StatePlanError(`${p} must be an integer ${min}..${max}`);
  return v;
}

function selector(v: unknown, p: string): string {
  if (typeof v !== "string" || v.length === 0 || v.length > STATE_LIMITS.maxSelectorChars) throw new StatePlanError(`${p} must be a CSS selector of 1..${STATE_LIMITS.maxSelectorChars} chars`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\u2028\u2029]/.test(v)) throw new StatePlanError(`${p} contains control characters`);
  return v;
}

function name(v: unknown, p: string): string {
  if (typeof v !== "string" || !NAME.test(v)) throw new StatePlanError(`${p} must match ${NAME}`);
  return v;
}

function mutation(v: unknown, p: string): Mutation {
  if (!isObj(v)) throw new StatePlanError(`${p}: expected object`);
  const mech = v.mechanism;
  if (typeof mech === "string" && REFUSED_MECHANISMS[mech]) {
    throw new StatePlanError(`${p}: mechanism "${mech}" refused: ${REFUSED_MECHANISMS[mech]}. List it under the page's "manual" entries for an operator-captured screenshot instead.`);
  }
  const sel = selector(v.selector, `${p}.selector`);
  if (mech === "details-open") {
    keys(v, p, ["mechanism", "selector"]);
    return { mechanism: mech, selector: sel };
  }
  if (mech === "attribute-set") {
    keys(v, p, ["mechanism", "selector", "attribute", "value"]);
    if (typeof v.attribute !== "string" || !ATTRIBUTES.has(v.attribute)) throw new StatePlanError(`${p}.attribute must be one of ${[...ATTRIBUTES].join(", ")}`);
    if (v.value !== null && (typeof v.value !== "string" || v.value.length > 100 || /[\u0000-\u001f]/.test(v.value))) throw new StatePlanError(`${p}.value must be a string <= 100 chars or null (remove)`);
    return { mechanism: mech, selector: sel, attribute: v.attribute, value: v.value as string | null };
  }
  if (mech === "class-add") {
    keys(v, p, ["mechanism", "selector", "className"]);
    if (typeof v.className !== "string" || !CLASS.test(v.className)) throw new StatePlanError(`${p}.className must match ${CLASS}`);
    return { mechanism: mech, selector: sel, className: v.className };
  }
  throw new StatePlanError(`${p}.mechanism must be details-open | attribute-set | class-add`);
}

export function parseStatePlan(json: unknown): StatePlan {
  if (!isObj(json) || json.schema !== "website-to-figma/state-plan" || json.schemaVersion !== 1) {
    throw new StatePlanError('state plan: expected { schema: "website-to-figma/state-plan", schemaVersion: 1, site, pages: [...] }');
  }
  keys(json, "plan", ["schema", "schemaVersion", "site", "forceAos", "maxActions", "maxCombinedWaitMs", "pages"]);
  let site: URL;
  try {
    site = parseHttpUrl(String(json.site));
  } catch (err) {
    throw new StatePlanError(`plan.site rejected: ${err instanceof Error ? err.message : "invalid"}`);
  }
  if (json.forceAos !== undefined && typeof json.forceAos !== "boolean") throw new StatePlanError("plan.forceAos must be boolean");
  const maxActions = int(json.maxActions, "plan.maxActions", STATE_LIMITS.defaultMaxActions, 1, STATE_LIMITS.providerMaxActions);
  const maxCombinedWaitMs = int(json.maxCombinedWaitMs, "plan.maxCombinedWaitMs", STATE_LIMITS.defaultMaxCombinedWaitMs, 0, STATE_LIMITS.providerMaxCombinedWaitMs);
  if (!Array.isArray(json.pages) || json.pages.length === 0 || json.pages.length > STATE_LIMITS.maxPages) throw new StatePlanError(`plan.pages must hold 1..${STATE_LIMITS.maxPages} pages (one site)`);
  const seenUrls = new Set<string>();
  const pages = json.pages.map((raw, i): PlannedPage => {
    const p = `pages[${i}]`;
    if (!isObj(raw)) throw new StatePlanError(`${p}: expected object`);
    keys(raw, p, ["url", "waitMs", "lazy", "states", "manual"]);
    let url: URL;
    try {
      url = parseHttpUrl(String(raw.url));
    } catch (err) {
      throw new StatePlanError(`${p}.url rejected: ${err instanceof Error ? err.message : "invalid"}`);
    }
    if (url.origin !== site.origin) throw new StatePlanError(`${p}.url must be on the plan's single site ${site.origin}`);
    if (seenUrls.has(url.href)) throw new StatePlanError(`${p}.url repeats ${url.href}`);
    seenUrls.add(url.href);
    const lazyRaw = raw.lazy === undefined ? {} : raw.lazy;
    if (!isObj(lazyRaw)) throw new StatePlanError(`${p}.lazy: expected object`);
    keys(lazyRaw, `${p}.lazy`, ["steps", "maxPx", "stepWaitMs", "visibilityMs"]);
    const lazy = {
      steps: int(lazyRaw.steps, `${p}.lazy.steps`, 3, 0, STATE_LIMITS.maxLazySteps),
      maxPx: int(lazyRaw.maxPx, `${p}.lazy.maxPx`, 20_000, 0, STATE_LIMITS.maxLazyPx),
      stepWaitMs: int(lazyRaw.stepWaitMs, `${p}.lazy.stepWaitMs`, 500, 0, STATE_LIMITS.maxLazyStepWaitMs),
      visibilityMs: int(lazyRaw.visibilityMs, `${p}.lazy.visibilityMs`, 1_500, 0, STATE_LIMITS.maxVisibilityMs),
    };
    const rawStates = raw.states === undefined ? [] : raw.states;
    if (!Array.isArray(rawStates) || rawStates.length > STATE_LIMITS.maxStatesPerPage - 1) {
      throw new StatePlanError(`${p}.states: at most ${STATE_LIMITS.maxStatesPerPage - 1} synthetic states (the baseline "Default" counts toward the ${STATE_LIMITS.maxStatesPerPage}-state total)`);
    }
    const states: PlannedState[] = [{ name: "Default", scope: null, mutations: [] }];
    for (const [j, s] of rawStates.entries()) {
      const q = `${p}.states[${j}]`;
      if (!isObj(s)) throw new StatePlanError(`${q}: expected object`);
      keys(s, q, ["name", "scope", "mutations", "trigger", "selector"]);
      const n = name(s.name, `${q}.name`);
      if (states.some((x) => x.name.toLowerCase() === n.toLowerCase())) throw new StatePlanError(`${q}.name "${n}" is not unique (Default is reserved)`);
      const scope = s.scope === undefined || s.scope === null ? null : selector(s.scope, `${q}.scope`);
      if (s.trigger !== undefined) {
        if (s.trigger !== "scroll-reveal" && s.trigger !== "swiper-next") throw new StatePlanError(`${q}.trigger must be "scroll-reveal" or "swiper-next" (no other interaction is supported)`);
        if (s.mutations !== undefined) throw new StatePlanError(`${q}: a trigger state cannot also carry mutations`);
        if (states.some((x) => x.trigger === s.trigger)) throw new StatePlanError(`${q}: at most one "${s.trigger}" state per page`);
        if (s.trigger === "scroll-reveal") {
          if (s.selector !== undefined) throw new StatePlanError(`${q}.selector is only valid for "swiper-next"`);
          states.push({ name: n, scope, mutations: [], trigger: "scroll-reveal" });
        } else {
          const sel = selector(s.selector, `${q}.selector`);
          states.push({ name: n, scope: scope ?? sel, mutations: [], trigger: "swiper-next", selector: sel });
        }
        continue;
      }
      if (s.selector !== undefined) throw new StatePlanError(`${q}.selector is only valid for "swiper-next"`);
      if (!Array.isArray(s.mutations) || s.mutations.length === 0 || s.mutations.length > STATE_LIMITS.maxMutationsPerState) throw new StatePlanError(`${q}.mutations must hold 1..${STATE_LIMITS.maxMutationsPerState} entries`);
      states.push({ name: n, scope, mutations: s.mutations.map((m, k) => mutation(m, `${q}.mutations[${k}]`)) });
    }
    const rawManual = raw.manual === undefined ? [] : raw.manual;
    if (!Array.isArray(rawManual) || rawManual.length > STATE_LIMITS.maxManualPerPage) throw new StatePlanError(`${p}.manual: at most ${STATE_LIMITS.maxManualPerPage} entries`);
    const manual = rawManual.map((m, j): ManualState => {
      const q = `${p}.manual[${j}]`;
      if (!isObj(m)) throw new StatePlanError(`${q}: expected object`);
      keys(m, q, ["name", "selector", "reason"]);
      const reason = typeof m.reason === "string" ? m.reason.slice(0, 200) : "";
      return { name: name(m.name, `${q}.name`), selector: selector(m.selector, `${q}.selector`), reason };
    });
    // The baseline measures the same scope as the first scoped synthetic state
    // - except with a scroll-reveal state: then the baseline is the initial
    // top-of-page view, and scrolling a lower scope into view would itself
    // trigger scroll handlers, so it stays at the top (scope null).
    const reveal = states.find((x) => x.trigger === "scroll-reveal");
    states[0]!.scope = reveal ? null : (states.find((x) => x.scope)?.scope ?? null);
    if (reveal && lazy.steps === 0) throw new StatePlanError(`${p}: a "scroll-reveal" state needs lazy.steps >= 1`);
    if (states.length + manual.length > STATE_LIMITS.maxStatesPerPage) {
      throw new StatePlanError(`${p}: ${states.length} planned + ${manual.length} manual states exceed ${STATE_LIMITS.maxStatesPerPage} total (baseline included)`);
    }
    return {
      url: url.href,
      waitMs: int(raw.waitMs, `${p}.waitMs`, 2_000, 0, STATE_LIMITS.maxPageWaitMs),
      lazy,
      states,
      manual,
    };
  });
  return { site: site.origin, forceAos: json.forceAos === true, maxActions, maxCombinedWaitMs, pages };
}

// Placeholders are substituted exactly once with JSON literals.
function fill(script: string, values: Record<string, unknown>): string {
  return script.replace(/__([A-Z_]+)__/g, (m, k: string) => {
    if (!(k in values)) throw new Error(`unfilled script placeholder ${m}`);
    return JSON.stringify(values[k]);
  });
}

// Minimal request body. Vendor/account safety settings are NOT overridden:
// checkPromptInjection, redactPII, lockdown, threatProtection, blockAds,
// removeBase64Images, parsers and mobile are OMITTED so the provider/team
// defaults apply unchanged (Firecrawl source apps/api/src/controllers/v2/
// types.ts:861-872 lists their schema defaults). Only content/cost choices are
// sent: rawHtml only (no JSON/LLM formats), full page (onlyMainContent false)
// and the basic proxy (the schema default "auto" may escalate proxies).
export const STATE_SCRAPE_OPTIONS = {
  onlyMainContent: false,
  proxy: "basic",
} as const;
export interface StateRequestBody {
  url: string;
  formats: ["rawHtml"];
  timeout: number;
  actions: Obj[];
  onlyMainContent: false;
  proxy: "basic";
}

export type ActionRole = "wait" | "freeze" | "scroll" | "state" | "screenshot" | "scrape" | "revert";
export interface RequestPreview {
  pageUrl: string;
  sent: false;
  body: StateRequestBody;
  roles: { index: number; role: ActionRole; state?: string; seq?: number }[];
  actionCount: number;
  // sum of wait.milliseconds (= the provider's waitFor + wait accounting; no waitFor is sent)
  combinedWaitMs: number;
  timing: { requestTimeoutMs: number; sdkHttpTimeoutMs: number; wallClockMs: number; combinedWaitMs: number; inScriptSleepMs: 0 };
  states: { seq: number; name: string; provenance: StateProvenance; review: string | null; screenshotIndex: number; scrapeIndex: number }[];
  manual: ManualState[];
}

const REVIEW: Record<StateProvenance, string | null> = {
  baseline: null,
  synthetic: "SYNTHETIC modification (not the page's observed original state); operator review required: attribute/class/open changes can run page MutationObservers, toggle listeners or custom-element callbacks - no handler side-effect guarantee",
  "scroll-triggered": "OBSERVED page reaction to the planned provider scroll steps (page scroll listeners run, e.g. AOS); no DOM modification by this tool beyond the recorded freeze",
  "page-api": "PAGE-API state: the page's own Swiper instance (validated: exactly one element, el.swiper bound by Swiper) advanced with slideNext(0), the call its autoplay makes; not a user event; Swiper's own event listeners run; reverted with slidePrev(0)",
};

export function buildStateRequest(plan: StatePlan, page: PlannedPage): RequestPreview {
  const actions: Obj[] = [];
  const roles: RequestPreview["roles"] = [];
  const push = (role: ActionRole, action: Obj, extra: { state?: string; seq?: number } = {}) => {
    roles.push({ index: actions.length, role, ...extra });
    actions.push(action);
  };
  let waits = 0;
  const wait = (ms: number) => {
    if (ms <= 0) return; // provider requires a positive integer
    push("wait", { type: "wait", milliseconds: ms });
    waits += ms;
  };
  wait(page.waitMs);
  push("freeze", { type: "executeJavascript", script: fill(FREEZE_JS, { FORCE_AOS: plan.forceAos }) });
  // Lazy load: synchronous scroll steps, each followed by a provider wait; the
  // last wait is the visibility settle (at least the step wait). They run
  // before the first state, or - with a scroll-reveal state - immediately
  // before that state (so the baseline is the initial, unscrolled view).
  const n = page.lazy.steps;
  const scrollSteps = () => {
    for (let k = 1; k <= n; k++) {
      push("scroll", { type: "executeJavascript", script: fill(SCROLL_JS, { STEP: k, STEPS: n, MAX_PX: page.lazy.maxPx }) });
      wait(k === n ? Math.max(page.lazy.stepWaitMs, page.lazy.visibilityMs) : page.lazy.stepWaitMs);
    }
    if (n === 0) wait(page.lazy.visibilityMs);
  };
  const revealAt = page.states.findIndex((x) => x.trigger === "scroll-reveal");
  if (revealAt < 0) scrollSteps();
  const states: RequestPreview["states"] = [];
  let shots = 0;
  page.states.forEach((s, seq) => {
    if (seq === revealAt) scrollSteps();
    const provenance = provenanceOf(s);
    push("state", { type: "executeJavascript", script: fill(STATE_JS, { STATE: { seq, name: s.name, provenance, scope: s.scope, mutations: s.mutations, trigger: s.trigger ?? null, selector: s.selector ?? null }, MAX_RETURN_CHARS: STATE_LIMITS.maxStateReturnChars }) }, { state: s.name, seq });
    push("screenshot", { type: "screenshot", fullPage: false }, { state: s.name, seq });
    push("scrape", { type: "scrape" }, { state: s.name, seq });
    states.push({ seq, name: s.name, provenance, review: REVIEW[provenance], screenshotIndex: shots, scrapeIndex: shots });
    shots++;
    if (s.mutations.length || s.trigger === "swiper-next") push("revert", { type: "executeJavascript", script: fill(REVERT_JS, { SEQ: seq }) }, { state: s.name, seq });
  });
  if (actions.length > plan.maxActions) throw new StatePlanError(`${page.url}: ${actions.length} actions exceed the plan budget of ${plan.maxActions} (provider maximum ${STATE_LIMITS.providerMaxActions})`);
  if (waits > plan.maxCombinedWaitMs) throw new StatePlanError(`${page.url}: combined waits ${waits} ms exceed the plan budget of ${plan.maxCombinedWaitMs} ms (provider maximum ${STATE_LIMITS.providerMaxCombinedWaitMs} ms)`);
  const timeout = Math.min(STATE_LIMITS.maxRequestTimeoutMs, STATE_LIMITS.requestTimeoutBaseMs + 2 * waits + STATE_LIMITS.requestTimeoutPerStateMs * page.states.length);
  if (waits * 2 > timeout) throw new StatePlanError(`${page.url}: combined waits ${waits} ms exceed half of the ${timeout} ms request timeout`);
  return {
    pageUrl: page.url,
    sent: false,
    body: { url: page.url, formats: ["rawHtml"], timeout, actions, ...STATE_SCRAPE_OPTIONS },
    roles,
    actionCount: actions.length,
    combinedWaitMs: waits,
    timing: { requestTimeoutMs: timeout, sdkHttpTimeoutMs: timeout + STATE_LIMITS.sdkTimeoutMarginMs, wallClockMs: timeout + STATE_LIMITS.wallClockMarginMs, combinedWaitMs: waits, inScriptSleepMs: 0 },
    states,
    manual: page.manual,
  };
}

export interface StatePreviewDoc {
  schema: "website-to-figma/state-request-preview";
  schemaVersion: 1;
  sent: false;
  executor: "states-run (separate, gated)";
  notice: string[];
  site: string;
  budgets: { maxActions: number; maxCombinedWaitMs: number; maxPages: number; maxStatesPerPage: number; maxStateReturnChars: number };
  requests: RequestPreview[];
  manualRoute: string[];
}

export const PREVIEW_NOTICE = [
  "NOT SENT. Planning sends nothing. Execution is a separate, operator-gated command (states-run) that fails closed without explicit operator pricing, ledger and credit confirmations, and never retries.",
  "Synthetic states are DOM modifications (not observed original states) for manual operator review; no handler side-effect guarantee.",
  "Provider cost of these requests is UNKNOWN: Firecrawl documents 1 credit per scrape but no per-action/screenshot price; no estimate is given (only the operator's own asserted price is used, to reserve ledger budget).",
  "Screenshot URLs in a provider response expire (documented 24 h) and are never downloaded by this tool.",
  "Not frozen: JS timers, requestAnimationFrame loops, WebGL/canvas rendering. Cross-origin stylesheets cannot be read (reported as inaccessible).",
  "All scripts are synchronous (no async/sleep); every delay is a documented provider wait action. States are measured synchronously after the modification: page JS that reacts asynchronously is not awaited. Readiness (fonts, incomplete images) is observed and recorded, not waited for beyond the planned waits.",
];

export function buildStatePreview(plan: StatePlan): StatePreviewDoc {
  const requests = plan.pages.map((p) => buildStateRequest(plan, p));
  const manualRoute = plan.pages.flatMap((p) =>
    p.manual.map((m) => `${p.url} "${m.name}" (${m.selector}): ${m.reason || "handler safety unprovable"} -> capture manually in your own browser, then add the PNG to the asset manifest as kind "reference" with pageUrl and state "${m.name}"`),
  );
  return {
    schema: "website-to-figma/state-request-preview",
    schemaVersion: 1,
    sent: false,
    executor: "states-run (separate, gated)",
    notice: PREVIEW_NOTICE,
    site: plan.site,
    budgets: { maxActions: plan.maxActions, maxCombinedWaitMs: plan.maxCombinedWaitMs, maxPages: STATE_LIMITS.maxPages, maxStatesPerPage: STATE_LIMITS.maxStatesPerPage, maxStateReturnChars: STATE_LIMITS.maxStateReturnChars },
    requests,
    manualRoute,
  };
}
