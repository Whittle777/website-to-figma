// Offline synthetic tests: tagged-return adapter, state/motion/media schema
// and converter. No network; example.com is never contacted.
import { describe, expect, it } from "vitest";
import { captureFromScrapeResponses } from "../src/hifi/adapter";
import { convertCapture } from "../src/hifi/convert";
import { validateHifiDoc, type HifiDoc, type HifiNode } from "../src/shared/hifiSchema";
import { cropNodes } from "../src/states/convertStates";
import { buildStatesFixture, syntheticStateAssets, syntheticStateResponse, STATES_FIXTURE_LABEL } from "../src/fixtures/statesSynthetic";
import { buildHifiFixture } from "../src/fixtures/hifiSynthetic";
import { STATE_LIMITS } from "../src/states/plan";

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const adapt = (json: unknown) => captureFromScrapeResponses([{ name: "r.json", json }], STATES_FIXTURE_LABEL);
const convert = (json: unknown, assets = syntheticStateAssets().filter((a) => a.operatorId !== "manual-menu")) =>
  convertCapture({ capture: adapt(json).capture, assets, assetWarnings: [], stateReactions: "click-cycle" });

describe("tagged-return adapter", () => {
  it("ties screenshots and scrapes to states by action order and lists hints only", () => {
    const r = adapt(syntheticStateResponse());
    const page = r.capture.pages[0] as Record<string, any>;
    expect(page.states.map((s: any) => [s.seq, s.name, s.provenance, s.screenshot])).toEqual([
      [0, "Default", "baseline", "action-order"],
      [1, "FAQ open", "synthetic", "action-order"],
      [2, "Tab two", "synthetic", "action-order"],
    ]);
    expect(page.measured.title).toBe("Synthetic States");
    expect(page.freeze.w2f).toBe("freeze");
    expect(r.screenshotHints.map((h) => [h.state, h.screenshotUrl, h.scrollY])).toEqual([
      ["Default", "https://example.com/shot-0.png", 60],
      ["FAQ open", "https://example.com/shot-1.png", 60],
      ["Tab two", "https://example.com/shot-2.png", 0],
    ]);
    expect(r.warnings).toEqual([]);
  });

  it("leaves screenshots unassociated when counts do not match", () => {
    const r = adapt(syntheticStateResponse({ dropScreenshot: true }));
    expect(r.screenshotHints).toEqual([]);
    expect(r.warnings.join()).toMatch(/2 screenshot\(s\) for 3 state return\(s\); screenshots NOT associated/);
    expect((r.capture.pages[0] as any).states.every((s: any) => s.screenshot === "unassociated")).toBe(true);
  });

  it("marks later states as possibly tainted when a revert failed", () => {
    const r = adapt(syntheticStateResponse({ failRevert: true }));
    expect(r.warnings.join()).toMatch(/revert of state 1 unconfirmed/);
    expect((r.capture.pages[0] as any).states[2].residueFromSeq).toBe(1);
  });

  it("drops a state return over the per-state byte bound", () => {
    const json = clone(syntheticStateResponse()) as any;
    json.data.actions.javascriptReturns[3].value.measured.title = "x".repeat(STATE_LIMITS.maxStateReturnChars);
    const r = adapt(json);
    expect(r.warnings.join()).toMatch(/state 1 return exceeds/);
    expect(r.warnings.join()).toMatch(/non-contiguous/);
  });

  it("plain measure-dom responses still adapt as before (backward compatible)", () => {
    const json = { data: { metadata: { url: "https://example.com/" }, actions: { javascriptReturns: [{ value: { viewport: { width: 800, height: 600 }, elements: [], texts: [] } }] } } };
    const r = adapt(json);
    expect((r.capture.pages[0] as any).states).toBeUndefined();
  });
});

describe("state variants in schema v2", () => {
  it("converts each state from its own measurement and labels provenance honestly", () => {
    const doc = buildStatesFixture();
    expect(validateHifiDoc(doc).ok).toBe(true);
    const s = doc.pages[0]!.states!;
    expect(s.reactions).toBe("click-cycle");
    expect(s.variants.map((v) => [v.name, v.provenance])).toEqual([["Default", "baseline"], ["FAQ open", "synthetic"], ["Tab two", "synthetic"]]);
    const [base, faq, tab] = s.variants;
    expect(base!.frame).toEqual({ x: 40, y: 100, w: 400, h: 80 }); // baseline uses the first state's scope
    expect(faq!.frame).toEqual({ x: 40, y: 100, w: 400, h: 140 });
    expect(tab!.frame).toEqual({ x: 0, y: 0, w: 800, h: 600 }); // no scope: viewport at screenshot scrollY
    expect(faq!.nodes.some((n) => n.kind === "text" && n.text === "Synthetic answer text.")).toBe(true);
    expect(base!.nodes.some((n) => n.kind === "text" && n.text === "Synthetic answer text.")).toBe(false);
    expect(faq!.notes.join(" ")).toMatch(/SYNTHETIC state: DOM modification .*not an observed original state/);
    expect(faq!.notes.join(" ")).toMatch(/No handler side-effect guarantee/);
    expect(tab!.notes.join(" ")).toMatch(/1 mutation\(s\) refused/);
    expect(base!.notes.join(" ")).toMatch(/Baseline/);
    expect(faq!.referenceAssetId).not.toBeNull();
    expect(faq!.screenshot).toEqual({ association: "action-order", scrollY: 60, viewportW: 800, viewportH: 600 });
    // nodes are frame-relative
    const q = faq!.nodes.find((n) => n.kind === "text" && n.text === "Synthetic question?")!;
    expect([q.x, q.y]).toEqual([16, 26]);
  });

  it("records freeze, motion and media honestly", () => {
    const p = buildStatesFixture().pages[0]!;
    expect(p.freeze!.notFrozen).toEqual(["JS timers", "requestAnimationFrame loops", "WebGL/canvas rendering"]);
    expect(p.freeze!.modifications[0]).toMatch(/forced \.aos-animate/);
    expect(p.freeze!.applied.find((a) => a.name === "force-aos-visible")!.count).toBe(2);
    expect(p.motion!.inaccessibleSheets).toBe(1);
    expect(p.warnings.join()).toMatch(/not readable \(cross-origin\)/);
    expect(p.media!.map((m) => [m.kind, m.still, m.webgl])).toEqual([["video", "operator-asset", null], ["canvas", "unavailable", true]]);
    const noPoster = convert(syntheticStateResponse(), syntheticStateAssets().filter((a) => a.operatorId === "shot-faq")).pages[0]!;
    expect(noPoster.media![0]!.still).toBe("poster-url-observed-not-downloaded");
    expect(noPoster.media![0]!.stillAssetId).toBeNull();
  });

  it("omits failed states instead of inventing them; manual screenshots fill free slots only", () => {
    const failed = convert(syntheticStateResponse({ errorState: true }), syntheticStateAssets()).pages[0]!;
    expect(failed.warnings.join()).toMatch(/State "FAQ open" omitted: browser step failed \(boom\)/);
    expect(failed.states!.variants.map((v) => [v.name, v.provenance])).toEqual([["Default", "baseline"], ["Tab two", "synthetic"], ["Menu open", "manual"]]);
    const manual = failed.states!.variants[2]!;
    expect(manual.nodes).toHaveLength(1);
    expect(manual.frame).toEqual({ x: 0, y: 0, w: 320, h: 240 });
    expect(manual.notes[0]).toMatch(/MANUAL state: operator-captured screenshot only; not measured/);
    const full = buildStatesFixture({ manual: true }).pages[0]!;
    expect(full.states!.variants).toHaveLength(3);
    expect(full.warnings.join()).toMatch(/Manual state "Menu open" omitted: 3-state limit reached/);
  });

  it("validator enforces the bounded state schema", () => {
    const doc = buildStatesFixture();
    const bad = (mut: (d: any) => void) => {
      const d = clone(doc) as any;
      mut(d);
      return validateHifiDoc(d);
    };
    expect(bad((d) => d.pages[0].states.variants.push(clone(d.pages[0].states.variants[1]))).ok).toBe(false); // 4 variants
    expect(bad((d) => d.pages[0].states.variants.reverse()).ok).toBe(false); // baseline not first
    expect(bad((d) => (d.pages[0].states.variants[2].name = "FAQ open")).ok).toBe(false); // duplicate
    expect(bad((d) => (d.pages[0].states.variants[1].provenance = "observed")).ok).toBe(false);
    expect(bad((d) => (d.pages[0].states.reactions = "on-hover")).ok).toBe(false);
    expect(bad((d) => (d.pages[0].states.variants[1].referenceAssetId = "a1")).ok).toBe(false); // image, not reference
    expect(bad((d) => (d.pages[0].media[1].stillAssetId = "a1")).ok).toBe(false); // still mismatch
    expect(bad((d) => (d.pages[0].media[0].poster = "javascript:alert(1)")).ok).toBe(false);
    expect(bad((d) => (d.pages[0].motion.rules[0].kind = "scroll")).ok).toBe(false);
    expect(bad((d) => (d.pages[0].freeze.extra = 1)).ok).toBe(false);
    // documents without the new fields stay valid
    expect(validateHifiDoc(buildHifiFixture()).ok).toBe(true);
  });

  it("cropNodes keeps intersecting nodes, drops clips and remaps button indices", () => {
    const btn: HifiNode = { kind: "box", name: "b", role: "button", x: 100, y: 100, w: 50, h: 20, fill: null, border: null, radius: [0, 0, 0, 0], opacity: 1, prov: "measured", clip: 0 };
    const out: HifiNode = { kind: "box", name: "o", role: "block", x: 0, y: 0, w: 10, h: 10, fill: null, border: null, radius: [0, 0, 0, 0], opacity: 1, prov: "measured" };
    const txt = { kind: "text", name: "t", text: "Go", graphemes: 2, fontStack: ["Inter"], generic: "sans", weight: 400, italic: false, size: 12, lineHeight: 14, color: { hex: "#000000", alpha: 1 }, decoration: "none", button: 1, prov: "measured", x: 105, y: 102, w: 20, h: 14 } as HifiNode;
    const r = cropNodes([out, btn, txt], { x: 90, y: 90, w: 100, h: 100 }, 10);
    expect(r.nodes.map((n) => n.name)).toEqual(["b", "t"]);
    expect((r.nodes[0] as any).clip).toBeUndefined();
    expect((r.nodes[1] as any).button).toBe(0);
    expect([r.nodes[0]!.x, r.nodes[0]!.y]).toEqual([10, 10]);
    expect(cropNodes([out, btn, txt], { x: 0, y: 0, w: 200, h: 200 }, 2).dropped).toBe(1);
  });

  it("reactions default to none and a single variant never gets reactions", () => {
    const json = clone(syntheticStateResponse()) as any;
    const doc: HifiDoc = convertCapture({ capture: adapt(json).capture, assets: [], assetWarnings: [] });
    expect(doc.pages[0]!.states!.reactions).toBe("none");
  });
});
