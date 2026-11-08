// Deterministic SYNTHETIC fixture sites (5 / 10 / 20 pages) on the reserved
// ".example" domain. They are not real websites and involve no network access.
// The raw input deliberately includes messy URL variants (tracking params,
// fragments, trailing slashes, http/www duplicates) and, for 10/20, off-site
// and look-alike hosts, so the normalization pipeline is exercised.
import { buildSiteMap, type RawPage } from "../normalize/build";
import type { SiteMapDoc } from "../shared/schema";

export const FIXTURE_SIZES = [5, 10, 20] as const;
export type FixtureSize = (typeof FIXTURE_SIZES)[number];
export const FIXTURE_ORIGIN = "https://fixture.example";
export const FIXTURE_LABEL = "SYNTHETIC FIXTURE - not a real website";

interface Spec {
  path: string;
  title: string;
  intro: string;
  cards?: [string, string][];
  docsNav?: boolean;
}

const SITE_NAV = ["Home", "About", "Pricing", "Blog", "Docs", "Contact"];
const DOCS_NAV = ["Docs home", "Getting started", "API reference", "Back to site"];
const FOOTER_LINKS = ["Privacy", "Terms", "Status", "Careers"];

const SPECS: Spec[] = [
  { path: "/", title: "Fixture Co - Home", intro: "A synthetic product homepage used to test wireframe generation.", cards: [["Fast", "Feature card one."], ["Simple", "Feature card two."], ["Local", "Feature card three."]] },
  { path: "/about", title: "About Fixture Co", intro: "Synthetic about page with a short company story." },
  { path: "/pricing", title: "Pricing", intro: "Three synthetic plans.", cards: [["Starter", "Plan card for individuals."], ["Team", "Plan card for small teams."], ["Scale", "Plan card for larger teams."]] },
  { path: "/contact", title: "Contact", intro: "Synthetic contact page." },
  { path: "/blog", title: "Blog", intro: "Synthetic blog index.", cards: [["Hello world", "First post teaser."], ["Release notes", "Second post teaser."]] },
  { path: "/blog/hello-world", title: "Hello world", intro: "Synthetic blog post body." },
  { path: "/blog/release-notes", title: "Release notes", intro: "Synthetic release notes post." },
  { path: "/docs", title: "Documentation", intro: "Synthetic docs landing page.", docsNav: true, cards: [["Getting started", "Install and run."], ["API reference", "Every endpoint."]] },
  { path: "/docs/getting-started", title: "Getting started", intro: "Synthetic setup guide.", docsNav: true },
  { path: "/docs/api", title: "API reference", intro: "Synthetic API overview.", docsNav: true },
  { path: "/careers", title: "Careers", intro: "Synthetic open roles.", cards: [["Designer", "Remote."], ["Engineer", "Remote."]] },
  { path: "/blog/design-systems", title: "Design systems", intro: "Synthetic long-form post." },
  { path: "/docs/api/auth", title: "Authentication", intro: "Synthetic auth docs.", docsNav: true },
  { path: "/docs/api/errors", title: "Errors", intro: "Synthetic error docs.", docsNav: true },
  { path: "/legal", title: "Legal", intro: "Synthetic legal index." },
  { path: "/legal/privacy", title: "Privacy", intro: "Synthetic privacy text." },
  { path: "/legal/terms", title: "Terms", intro: "Synthetic terms text." },
  { path: "/customers", title: "Customers", intro: "Synthetic customer stories.", cards: [["Acme", "Story teaser."], ["Globex", "Story teaser."], ["Initech", "Story teaser."]] },
  { path: "/customers/acme", title: "Acme story", intro: "Synthetic case study." },
  { path: "/customers/globex", title: "Globex story", intro: "Synthetic case study." },
  // Beyond the 20-page cap: present in the 20-page fixture input so truncation is real.
  { path: "/changelog", title: "Changelog", intro: "Synthetic changelog." },
  { path: "/status", title: "Status", intro: "Synthetic status page." },
];

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function pageHtml(s: Spec): string {
  const nav = (s.docsNav ? DOCS_NAV : SITE_NAV).map((l) => `<a href="#">${esc(l)}</a>`).join("");
  const cards = s.cards
    ? `<section class="grid">${s.cards.map(([t, d]) => `<div class="card"><h3>${esc(t)}</h3><p>${esc(d)}</p></div>`).join("")}</section>`
    : "";
  return [
    "<!doctype html><html><head>",
    `<title>${esc(s.title)}</title>`,
    "<script>window.shouldNeverRun = true;</script><style>body{}</style>",
    "</head><body>",
    `<header><nav>${nav}</nav></header>`,
    `<main><h1>${esc(s.title)}</h1><p>${esc(s.intro)}</p>`,
    "<h2>Section heading</h2><p>Synthetic paragraph content for layout.</p>",
    cards,
    "</main>",
    `<footer>${FOOTER_LINKS.map((l) => `<a href="#">${esc(l)}</a>`).join("")}<p>Fixture Co (synthetic fixture)</p></footer>`,
    "</body></html>",
  ].join("");
}

export function fixtureRawPages(size: FixtureSize): RawPage[] {
  const count = size === 20 ? SPECS.length : size;
  const specs = SPECS.slice(0, count);
  const pages: RawPage[] = specs.map((s) => ({ url: FIXTURE_ORIGIN + s.path, html: pageHtml(s) }));
  // Messy duplicates that canonicalization must merge.
  pages.push({ url: `${FIXTURE_ORIGIN}/about/?utm_source=newsletter&utm_medium=email#team`, html: pageHtml(SPECS[1]!) });
  pages.push({ url: "http://fixture.example/pricing/", html: pageHtml(SPECS[2]!) });
  pages.push({ url: "https://www.fixture.example/", html: pageHtml(SPECS[0]!) });
  if (size !== 5) {
    // Hosts that must NOT be treated as the same site.
    for (const url of ["https://blog.fixture.example/", "https://fixture.example.attacker.example/", "https://notfixture.example/"]) {
      pages.push({ url, html: pageHtml(SPECS[3]!) });
    }
  }
  return pages;
}

export function buildFixture(size: FixtureSize): SiteMapDoc {
  const count = size === 20 ? SPECS.length : size;
  return buildSiteMap({
    source: { mode: "fixture", fixtureId: `fixture-${size}`, label: FIXTURE_LABEL },
    startUrl: `${FIXTURE_ORIGIN}/`,
    limit: size,
    pages: fixtureRawPages(size),
    discoveredCount: count,
    incomplete: false,
    notes: [FIXTURE_LABEL],
  });
}
