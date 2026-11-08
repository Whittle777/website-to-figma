// Offline adapter: locally saved scrape-response JSON (a hosted-browser
// measurement returned via an executeJavascript action, i.e.
// data.actions.javascriptReturns[i].value) -> "website-to-figma/capture" v1.
// The measured value is expected to have the measure-dom shape: url, viewport,
// title, elements[], texts[], images[], svgs[]. Nothing is fetched: screenshot
// URLs in the responses are only listed as hints for the operator's manifest.
import { LIMITS } from "../shared/limits";
import { CaptureError } from "./convert";
import { adaptTaggedReturns } from "../states/adapt";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

export interface AdaptedCapture {
  capture: { schema: "website-to-figma/capture"; schemaVersion: 1; label: string; pages: Obj[] };
  // page URL -> screenshot URL present in the response (NOT downloaded)
  screenshotHints: { pageUrl: string; screenshotUrl: string; state?: string; scrollY?: number | null }[];
  warnings: string[];
}

function measuredOf(data: Obj): Obj | null {
  const actions = isObj(data.actions) ? data.actions : null;
  const returns = actions && Array.isArray(actions.javascriptReturns) ? actions.javascriptReturns : [];
  for (const r of returns.slice(0, 20)) {
    const v = isObj(r) ? r.value : undefined;
    if (isObj(v) && v.w2f === undefined && Array.isArray(v.elements) && Array.isArray(v.texts) && isObj(v.viewport)) return v;
  }
  return null;
}

export function captureFromScrapeResponses(responses: { name: string; json: unknown }[], label: string): AdaptedCapture {
  if (responses.length === 0) throw new CaptureError("hifi-capture: at least one --scrape file is required");
  if (responses.length > LIMITS.hifiMaxPages * 5) throw new CaptureError("hifi-capture: too many --scrape files");
  const pages: Obj[] = [];
  const screenshotHints: AdaptedCapture["screenshotHints"] = [];
  const warnings: string[] = [];
  for (const { name, json } of responses) {
    const root = isObj(json) ? json : null;
    const data = root && isObj(root.data) ? root.data : root;
    if (!data) throw new CaptureError(`${name}: expected a JSON object`);
    // Tagged state-plan returns (baseline + synthetic states) take precedence.
    const tagged = adaptTaggedReturns(data, name);
    if (tagged) warnings.push(...tagged.warnings);
    const measured = tagged ? tagged.baseline : measuredOf(data);
    if (!measured) throw new CaptureError(`${name}: no measured DOM value (data.actions.javascriptReturns[].value with viewport/elements/texts)`);
    const meta = isObj(data.metadata) ? data.metadata : {};
    const url = [measured.url, meta.url, meta.sourceURL].find((u): u is string => typeof u === "string" && u.length > 0);
    if (!url) throw new CaptureError(`${name}: no page URL (measured.url or metadata.url)`);
    const page: Obj = { url, measured };
    if (tagged) {
      page.states = tagged.states;
      if (tagged.freeze) page.freeze = tagged.freeze;
      if (tagged.lazy) page.lazy = tagged.lazy;
      for (const h of tagged.screenshotHints) screenshotHints.push({ pageUrl: url, ...h });
    }
    if (typeof meta.contentType === "string") page.contentType = meta.contentType;
    if (isObj(data.branding)) page.branding = data.branding;
    // Saved rawHtml (bounded) lets the converter recover list structure and option labels.
    if (typeof data.rawHtml === "string" && data.rawHtml.length <= LIMITS.maxHtmlChars) page.html = data.rawHtml;
    pages.push(page);
    if (typeof data.screenshot === "string" && !tagged) screenshotHints.push({ pageUrl: url, screenshotUrl: data.screenshot.slice(0, LIMITS.maxUrlChars) });
  }
  return { capture: { schema: "website-to-figma/capture", schemaVersion: 1, label: label.slice(0, 200) || "operator capture", pages }, screenshotHints, warnings: warnings.slice(0, LIMITS.hifiMaxWarnings) };
}
