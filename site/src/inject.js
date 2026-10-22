// Adds the Redline page layers to a document on its way out: the data the layers need, the stylesheet and the script.
// The layers live in public/_redline and are cached for a year, so their URLs carry a build id.
// The CLI can pass a new one at deploy time (--var BUILD:<id>); the fallback below is used when it does not.
const BUILD_FALLBACK = "7c3e91a4";

// JSON inside an inline script: "<" and the two line separators are escaped so a title can never close the script tag.
const scriptJson = (v) => JSON.stringify(v).replace(/</g, "\\u003c").replace(/[\u2028\u2029]/g, (c) => "\\u" + c.charCodeAt(0).toString(16));

export const buildId = (env) => encodeURIComponent(String(env.BUILD || BUILD_FALLBACK).slice(0, 40));

export function layerHtml(doc, env) {
  const build = buildId(env);
  const pdf = doc.pdf ? `/${doc.link}/${doc.pdf.split("/").map(encodeURIComponent).join("/")}` : null;
  const data = { slug: doc.link, title: doc.title, pdf, version: doc.version };
  return `<script>window.__REDLINE=${scriptJson(data)}</script>` +
    `<link rel="stylesheet" href="/_redline/redline.css?v=${build}">` +
    `<script src="/_redline/redline.js?v=${build}" defer></script>`;
}

// Adds the layers just before the last </body>, or at the end of the document when there is no body tag.
// Plain string work, so it runs the same on every runtime. The rewritten page has no fixed length or ETag, so those headers are dropped.
export async function injectPage(res, doc, env) {
  const tail = layerHtml(doc, env);
  const text = await res.text();
  const ends = [...text.matchAll(/<\/body\s*>/gi)];
  const at = ends.length ? ends[ends.length - 1].index : text.length;
  const h = new Headers(res.headers);
  for (const k of ["content-length", "etag", "last-modified", "content-range", "accept-ranges"]) h.delete(k);
  return new Response(text.slice(0, at) + tail + text.slice(at), { status: res.status, statusText: res.statusText, headers: h });
}
