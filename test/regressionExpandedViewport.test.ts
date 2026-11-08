// SYNTHETIC regression for a defect seen in an offline review of a private
// hosted run (shapes and numbers only; no site content, no private data):
// the provider's action viewport was 1920x100000 (scrollY stayed 0), state
// targets sat at y 70813.59375 and 75540.140625, all three viewport
// screenshots were byte-identical, and conversion kept only 12 nodes with a
// lone body box per variant. This fixture reproduces that shape.
import { describe, expect, it } from "vitest";
import { captureFromScrapeResponses } from "../src/hifi/adapter";
import { convertCapture } from "../src/hifi/convert";
import { loadedFromBytes, syntheticPng } from "../src/fixtures/hifiSynthetic";
import { validateHifiDoc } from "../src/shared/hifiSchema";

const LABEL = "SYNTHETIC EXPANDED-VIEWPORT REGRESSION - not a real website";
const URL0 = "https://example.com/";
const VW = 1920;
const VH = 100_000;
const AOS = { x: 0, y: 70813.59375, w: 1920, h: 390 };
const SWIPER = { x: 0, y: 75540.140625, w: 1920, h: 488.296875 };

const style = (o: Record<string, string> = {}) => ({ backgroundColor: "rgba(0, 0, 0, 0)", color: "rgb(33, 33, 33)", fontFamily: "Inter, sans-serif", fontSize: "16px", fontWeight: "400", fontStyle: "normal", lineHeight: "20px", textDecorationLine: "none", borderTopWidth: "0px", borderRightWidth: "0px", borderBottomWidth: "0px", borderLeftWidth: "0px", borderTopColor: "rgb(0, 0, 0)", borderRightColor: "rgb(0, 0, 0)", borderBottomColor: "rgb(0, 0, 0)", borderLeftColor: "rgb(0, 0, 0)", borderRadius: "0px", opacity: "1", display: "block", visibility: "visible", ...o });

function measured(variant: "base" | "aos" | "next") {
  const aosOpacity = variant === "base" ? "0" : "1";
  return {
    url: URL0,
    viewport: { width: VW, height: VH },
    documentHeight: VH,
    title: "Synthetic expanded viewport",
    elements: [
      { id: "e0", tag: "body", x: 0, y: 0, w: VW, h: VH, style: style({ backgroundColor: "rgb(255, 255, 255)" }) },
      // a 100vh hero: distorted to the expanded viewport height
      { id: "e1", tag: "section", x: 0, y: 0, w: VW, h: 70_000, style: style({ backgroundColor: "rgb(20, 40, 90)" }) },
      { id: "e2", tag: "section", ...AOS, style: style({ backgroundColor: "rgb(245, 247, 255)" }) },
      { id: "e3", tag: "div", x: 200, y: AOS.y + 40, w: 400, h: 300, style: style({ backgroundColor: "rgb(13, 71, 161)", opacity: aosOpacity }) },
      { id: "e4", tag: "section", ...SWIPER, style: style({ backgroundColor: "rgb(30, 30, 30)" }) },
      { id: "e5", tag: "div", x: 560, y: SWIPER.y + 40, w: 800, h: 400, style: style({ backgroundColor: "rgb(60, 60, 60)" }) },
    ],
    texts: [
      { text: "Hero", x: 100, y: 200, w: 80, h: 40, tag: "h1", parent: "e1", style: style({ color: "rgb(255, 255, 255)", fontSize: "32px" }) },
      { text: "Feature one", x: 220, y: AOS.y + 60, w: 120, h: 20, tag: "h3", parent: "e3", style: style({ color: "rgb(255, 255, 255)" }) },
      { text: variant === "next" ? "Second testimonial" : "First testimonial", x: 600, y: SWIPER.y + 80, w: 200, h: 20, tag: "h3", parent: "e5", style: style({ color: "rgb(255, 255, 255)" }) },
    ],
    images: [],
    svgs: [],
  };
}

const verify = (scope: typeof AOS | null) => ({ scrollY: 0, viewport: { width: VW, height: VH }, documentHeight: VH, expandedViewport: true, target: scope ? { selector: "#t", viewTop: scope.y, viewBottom: scope.y + scope.h, inViewport: false, partiallyVisible: false } : null });

function response() {
  const st = (seq: number, name: string, provenance: string, m: ReturnType<typeof measured>, scope: typeof AOS | null) => [
    { type: "object", value: { w2f: "apply", seq, name, provenance, applied: provenance === "page-api" ? [{ selector: "#t .swiper", mechanism: "swiper-next" }] : [], refused: [], missing: [], trigger: provenance === "page-api" ? { kind: "swiper-next", valid: true, moved: true, before: { realIndex: 0 }, after: { realIndex: 1 }, listeners: [] } : null, error: null, scrollY: 0 } },
    { type: "object", value: { w2f: "state", seq, name, provenance, missing: [], scope, verify: verify(scope), screenshotScrollY: 0, viewport: { width: VW, height: VH }, documentHeight: VH, measured: m, readiness: { readyState: "complete", fontsStatus: "loaded", images: 0, imagesIncomplete: 0, lazyImages: 0 }, truncated: false } },
  ];
  const shots = ["https://example.com/s0.png", "https://example.com/s1.png", "https://example.com/s2.png"];
  return {
    success: true,
    data: {
      metadata: { url: URL0, statusCode: 200, contentType: "text/html", creditsUsed: 1 },
      actions: {
        javascriptReturns: [
          { type: "object", value: { w2f: "freeze", attempted: [], applied: {}, unavailable: [], modifications: [], notFrozen: ["JS timers", "requestAnimationFrame loops", "WebGL/canvas rendering"] } },
          ...st(0, "Default", "baseline", measured("base"), AOS),
          ...[1, 2, 3].map((k) => ({ type: "object", value: { w2f: "scroll", step: k, steps: 3, y: 0, coverageComplete: false } })),
          ...st(1, "AOS revealed", "scroll-triggered", measured("aos"), AOS),
          ...st(2, "Testimonial next", "page-api", measured("next"), SWIPER),
          { type: "object", value: { w2f: "revert", seq: 2, reverted: 1, failed: 0 } },
        ],
        screenshots: shots,
        scrapes: shots.map(() => ({ url: URL0, html: "<html><body></body></html>" })),
      },
    },
  };
}

describe(LABEL, () => {
  // three byte-identical 1920x1080 screenshots (the observed defect)
  const shot = syntheticPng(1920, 1080, [20, 40, 90], [20, 40, 90]);
  const assets = ["Default", "AOS revealed", "Testimonial next"].map((state, i) => ({ ...loadedFromBytes(`shot-${i}`, "reference", shot, null), pageUrl: URL0, state }));
  const cap = captureFromScrapeResponses([{ name: "synthetic.json", json: response() }], LABEL);
  const doc = convertCapture({ capture: cap.capture, assets, assetWarnings: [] });

  it("separates the expanded CSS viewport from the document and keeps deep nodes (segments)", () => {
    expect(validateHifiDoc(doc).ok).toBe(true);
    const segs = doc.pages.filter((p) => p.url === URL0);
    expect(segs.map((p) => p.height)).toEqual([30_000, 30_000, 30_000, 10_000]);
    expect(segs[0]!.warnings.join(" ")).toMatch(/viewport 1920x100000 is taller than any documented screenshot viewport/);
    const deep = segs[2]!.nodes.filter((n) => n.kind === "text").map((n) => (n as { text: string }).text);
    expect(deep).toEqual(expect.arrayContaining(["Feature one", "First testimonial"]));
    expect(segs.reduce((n, p) => n + p.nodes.length, 0)).toBeGreaterThan(5);
  });

  it("variants are cropped in local coordinates with their target nodes (not a lone body box)", () => {
    const vs = doc.pages[0]!.states!.variants;
    expect(vs.map((v) => [v.name, v.provenance, Math.round(v.frame.y)])).toEqual([["Default", "baseline", 70814], ["AOS revealed", "scroll-triggered", 70814], ["Testimonial next", "page-api", 75540]]);
    for (const v of vs) expect(v.nodes.length).toBeGreaterThan(1);
    const text = (i: number) => vs[i]!.nodes.filter((n) => n.kind === "text").map((n) => (n as { text: string }).text);
    expect(text(1)).toContain("Feature one");
    expect(text(2)).toEqual(["Second testimonial"]);
    const t = vs[2]!.nodes.find((n) => n.kind === "text")!;
    expect([t.x, Math.round(t.y)]).toEqual([600, 80]); // frame-local
    // AOS: opacity 0 in the baseline, 1 after the scroll trigger (measured difference)
    const card = (i: number) => vs[i]!.nodes.find((n) => n.kind === "box" && Math.round(n.y) === 40 && n.w === 400) as { opacity: number } | undefined;
    expect(card(1)?.opacity).toBe(1);
  });

  it("never presents identical or unverifiable screenshots as distinct visual states", () => {
    const vs = doc.pages[0]!.states!.variants;
    expect(vs.every((v) => v.screenshot?.distinct === false)).toBe(true);
    expect(vs.every((v) => v.screenshot?.verified === "unverifiable-expanded-viewport")).toBe(true);
    const w = doc.pages[0]!.warnings.join(" ");
    expect(w).toMatch(/byte-identical \(sha256 [0-9a-f]{16}\.\.\.\): no visual distinctness/);
    expect(w).toMatch(/screenshot position unverifiable \(expanded action viewport\)/);
  });
});
