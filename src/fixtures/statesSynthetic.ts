// SYNTHETIC state fixture: a hand-written saved scrape response in the shape a
// state-plan request preview would produce (tagged executeJavascript returns,
// one screenshot + scrape per state). Not captured from any website; never
// sent; example.com (IANA documentation domain) is never contacted.
import { captureFromScrapeResponses } from "../hifi/adapter";
import { convertCapture } from "../hifi/convert";
import type { HifiDoc } from "../shared/hifiSchema";
import { loadedFromBytes, syntheticPng } from "./hifiSynthetic";

export const STATES_FIXTURE_LABEL = "SYNTHETIC STATE FIXTURE - not a real website";

const sans = "Inter, sans-serif";
const st = (o: Record<string, string> = {}) => ({ fontFamily: sans, fontSize: "16px", fontWeight: "400", fontStyle: "normal", color: "rgb(33, 33, 33)", textDecorationLine: "none", ...o });
const box = (o: Record<string, string> = {}) => ({ backgroundColor: "rgba(0, 0, 0, 0)", borderTopWidth: "0px", borderRightWidth: "0px", borderBottomWidth: "0px", borderLeftWidth: "0px", borderTopColor: "rgb(0, 0, 0)", borderRightColor: "rgb(0, 0, 0)", borderBottomColor: "rgb(0, 0, 0)", borderLeftColor: "rgb(0, 0, 0)", borderRadius: "0px", opacity: "1", display: "block", visibility: "visible", ...o });

function measured(open: "none" | "faq" | "tab") {
  const faqH = open === "faq" ? 120 : 60;
  return {
    url: "https://example.com/",
    viewport: { width: 800, height: 600 },
    title: "Synthetic States",
    elements: [
      { id: "e0", tag: "body", x: 0, y: 0, w: 800, h: 700, style: box({ backgroundColor: "rgb(255, 255, 255)" }) },
      { id: "e1", tag: "section", x: 40, y: 100, w: 400, h: faqH + 20, style: box() },
      { id: "e2", tag: "details", x: 40, y: 110, w: 400, h: faqH, style: box({ backgroundColor: open === "faq" ? "rgb(232, 240, 254)" : "rgb(245, 245, 245)", borderRadius: "6px" }) },
      { id: "e3", tag: "div", x: 480, y: 100, w: 120, h: 40, style: box({ backgroundColor: open === "tab" ? "rgb(13, 71, 161)" : "rgb(220, 220, 220)" }) },
    ],
    texts: [
      { text: "Synthetic question?", x: 56, y: 126, w: 160, h: 20, tag: "summary", parent: "e2", style: st({ fontWeight: "700" }) },
      ...(open === "faq" ? [{ text: "Synthetic answer text.", x: 56, y: 170, w: 180, h: 20, tag: "p", parent: "e2", style: st() }] : []),
      { text: "Tab two", x: 500, y: 110, w: 60, h: 20, tag: "div", parent: "e3", style: st({ color: open === "tab" ? "rgb(255, 255, 255)" : "rgb(33, 33, 33)" }) },
    ],
    images: [],
    svgs: [],
  };
}

const motion = { rules: [{ selector: ".btn", kind: "transition", detail: "opacity 0.2s" }, { selector: ".btn:hover", kind: "hover", detail: "opacity: 0.5;" }], inaccessibleSheets: 1 };
const media = [
  { kind: "video", x: 40, y: 400, w: 320, h: 180, poster: "https://example.com/poster.png", src: "https://example.com/clip.mp4" },
  { kind: "canvas", x: 400, y: 400, w: 200, h: 180, webgl: true },
];

export function syntheticStateResponse(opts: { dropScreenshot?: boolean; failRevert?: boolean; errorState?: boolean } = {}): unknown {
  const state = (seq: number, name: string, open: "none" | "faq" | "tab", scope: { x: number; y: number; w: number; h: number } | null, applied: unknown[]) => ({
    w2f: "state",
    seq,
    name,
    provenance: seq === 0 ? "baseline" : "synthetic",
    applied,
    missing: [],
    refused: seq === 2 ? [{ selector: "x-menu", reason: "refused custom element <x-menu>" }] : [],
    scope,
    screenshotScrollY: scope ? Math.max(0, scope.y - 40) : 0,
    viewport: { width: 800, height: 600 },
    measured: measured(open),
    fixed: [],
    motion,
    media,
    truncated: false,
  });
  const faqScope = { x: 40, y: 100, w: 400, h: 80 };
  const states = [
    state(0, "Default", "none", faqScope, []),
    opts.errorState ? { w2f: "state", seq: 1, name: "FAQ open", provenance: "synthetic", applied: [], missing: [], refused: [], error: "boom", reverted: 1 } : state(1, "FAQ open", "faq", { ...faqScope, h: 140 }, [{ selector: "#faq details", mechanism: "details-open" }]),
    state(2, "Tab two", "tab", null, [{ selector: "#tab2", mechanism: "attribute-set" }]),
  ];
  const shots = ["https://example.com/shot-0.png", "https://example.com/shot-1.png", "https://example.com/shot-2.png"];
  return {
    success: true,
    data: {
      metadata: { url: "https://example.com/", contentType: "text/html; charset=utf-8" },
      rawHtml: "<html><body></body></html>",
      actions: {
        javascriptReturns: [
          { type: "object", value: { w2f: "freeze", attempted: ["css-animations-transitions", "web-animations", "video-pause", "swiper-autoplay-stop", "force-aos-visible"], applied: { "css-animations-transitions": 1, "web-animations": 3, "video-pause": 1, "swiper-autoplay-stop": 0, "force-aos-visible": 2 }, unavailable: [], modifications: ["forced .aos-animate on 2 element(s) (not the page's original visibility)"], notFrozen: ["JS timers", "requestAnimationFrame loops", "WebGL/canvas rendering"] } },
          { type: "object", value: { w2f: "lazy", steps: 2, scrolledTo: 1200, reachedBottom: true, capped: false } },
          { type: "object", value: states[0] },
          { type: "object", value: states[1] },
          { type: "object", value: { w2f: "revert", seq: 1, reverted: opts.errorState ? 0 : 1, failed: opts.failRevert ? 1 : 0 } },
          { type: "object", value: states[2] },
          { type: "object", value: { w2f: "revert", seq: 2, reverted: 1, failed: 0 } },
        ],
        screenshots: opts.dropScreenshot ? shots.slice(0, 2) : shots,
        scrapes: [0, 1, 2].map(() => ({ url: "https://example.com/", html: "<html><body></body></html>" })),
      },
    },
  };
}

export function syntheticStateAssets() {
  return [
    loadedFromBytes("poster", "image", syntheticPng(32, 18, [20, 20, 20], [200, 200, 200]), "https://example.com/poster.png"),
    { ...loadedFromBytes("shot-faq", "reference", syntheticPng(800, 600, [255, 255, 255], [232, 240, 254]), null), pageUrl: "https://example.com/", state: "FAQ open" },
    { ...loadedFromBytes("manual-menu", "reference", syntheticPng(320, 240, [250, 250, 250], [13, 71, 161]), null), pageUrl: "https://example.com/", state: "Menu open" },
  ];
}

export function buildStatesFixture(opts: { reactions?: "none" | "click-cycle"; manual?: boolean } = {}): HifiDoc {
  const { capture } = captureFromScrapeResponses([{ name: "synthetic-states.json", json: syntheticStateResponse() }], STATES_FIXTURE_LABEL);
  const assets = syntheticStateAssets().filter((a) => opts.manual || a.operatorId !== "manual-menu");
  const doc = convertCapture({ capture, assets, assetWarnings: [], stateReactions: opts.reactions ?? "click-cycle" });
  return { ...doc, source: { mode: "fixture", label: STATES_FIXTURE_LABEL } };
}
