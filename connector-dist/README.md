# website-to-figma connector renderer (planned $fig host)

The same shared renderer as the native plugin (plugin/src/render), driven by a host that only uses
the Figma connector's $fig plan constructors (frame, rectangle, text, svg, component, instance, ellipse,
variants, get, done) and wrapper .append/.set/.query(...).set/.node. Raw reads, raw font loads and
ON_CLICK -> CHANGE_TO reactions run only after `await $fig.done()`.

Do not run this file directly: `website-to-figma fig-plan --doc site-v2.json --out DIR` writes
ordered job scripts that embed this file verbatim plus one job input each.

Not supported by this host (reported in every job result, never faked): image fills (placeholders
with sha256 instead), pluginData provenance, vector networks (SVG polylines instead), edge grouping.
$fig.variants is called with the figma-use signature: $fig.variants({ name }, components). Not run against Figma.
