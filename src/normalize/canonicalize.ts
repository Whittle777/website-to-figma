// Deterministic URL canonicalization used for dedupe, caps and page identity.
const TRACKING_PARAMS = new Set(["gclid", "fbclid", "dclid", "msclkid", "mc_cid", "mc_eid", "_ga", "_gl", "ref", "ref_src"]);

export function canonicalizeUrl(input: string | URL): string {
  const url = new URL(input.toString());
  url.hash = "";
  url.username = "";
  url.password = "";
  url.hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  // URL already drops default ports; keep explicit non-default ones visible.
  const kept = [...url.searchParams.entries()]
    .filter(([k]) => !k.toLowerCase().startsWith("utm_") && !TRACKING_PARAMS.has(k.toLowerCase()))
    .sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : av > bv ? 1 : 0) : a < b ? -1 : 1));
  url.search = "";
  for (const [k, v] of kept) url.searchParams.append(k, v);
  let path = url.pathname.replace(/\/{2,}/g, "/");
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  url.pathname = path;
  return url.toString();
}

// Path plus query, used for display and parent inference.
export function displayPath(canonical: string): string {
  const u = new URL(canonical);
  return u.pathname + u.search;
}
