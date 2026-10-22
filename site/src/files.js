// File storage and serving. The bytes of a file live in a file store under f/<slug>/<version>/<path> (Workers KV, a folder on disk,
// or a Postgres table); the database keeps its type and size.
// (D1 hands binary data to a Worker as a JSON list of numbers, which costs far too much CPU on the free plan.)
// A version is never changed once it is live, so a cached KV value can never be stale.
import { fail, json } from "./util.js";
import { injectPage, buildId } from "./inject.js";

export const MAX_FILE_BYTES = 25 * 1024 * 1024; // KV's limit for one value
export const MAX_FILES_PER_VERSION = 300;
export const MAX_VERSION_BYTES = 60 * 1024 * 1024;
const MAX_PATH_CHARS = 300;

const HTML_TYPE = "text/html; charset=utf-8";
const MIME_BY_EXT = {
  html: HTML_TYPE, htm: HTML_TYPE,
  glb: "model/gltf-binary", gltf: "model/gltf+json", ktx2: "image/ktx2", hdr: "image/vnd.radiance", exr: "image/aces", wasm: "application/wasm",
  mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", mov: "video/quicktime", mp3: "audio/mpeg", ogg: "audio/ogg", oga: "audio/ogg",
  wav: "audio/wav", m4a: "audio/mp4", aac: "audio/aac", flac: "audio/flac", webp: "image/webp", avif: "image/avif", png: "image/png",
  jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", svg: "image/svg+xml", ico: "image/x-icon", json: "application/json; charset=utf-8",
  js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8", woff: "font/woff", woff2: "font/woff2",
  ttf: "font/ttf", otf: "font/otf", txt: "text/plain; charset=utf-8", csv: "text/csv; charset=utf-8", vtt: "text/vtt; charset=utf-8",
  pdf: "application/pdf", map: "application/json; charset=utf-8", xml: "application/xml; charset=utf-8",
};

function mimeFor(path) {
  const m = /\.([a-z0-9]+)$/i.exec(path);
  return m ? MIME_BY_EXT[m[1].toLowerCase()] || "" : "";
}

// The uploaded Content-Type is trusted, except that HTML is always served as UTF-8 HTML and a missing or generic type falls back to the extension.
export function contentTypeFor(path, header) {
  const ext = mimeFor(path);
  if (ext === HTML_TYPE) return HTML_TYPE;
  const given = (header || "").trim();
  const usable = /^[\w.+-]+\/[\w.+-]+(\s*;[^\r\n]*)?$/.test(given) && given.length <= 120 && !/^application\/octet-stream/i.test(given);
  return usable ? given : ext || "application/octet-stream";
}

// A relative path with no empty, "." or ".." parts. Returns the path or null.
export function cleanPath(raw) {
  if (!raw || raw.length > MAX_PATH_CHARS || /[\u0000-\u001f\\]/.test(raw) || raw.startsWith("/")) return null;
  const parts = raw.split("/");
  return parts.every((p) => p && p !== "." && p !== "..") ? raw : null;
}

// Reads the request body, giving up as soon as it is larger than max.
async function readBody(request, max) {
  const declared = Number(request.headers.get("Content-Length"));
  if (declared > max) return null;
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const parts = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { await reader.cancel(); return null; }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.byteLength; }
  return out;
}

export const fileKey = (slug, version, path) => `f/${slug}/${version}/${path}`;

// PUT /api/docs/<slug>/v/<version>/files/<path>: one file per request. Uploading a path again replaces it.
export async function uploadFile(request, env, doc, version, rawPath) {
  if (version !== doc.staged) return fail(409, `Version ${version} is not open for upload. Start a new version first.`);
  const path = cleanPath(rawPath);
  if (!path) return fail(400, `The path must be relative, without "..", and at most ${MAX_PATH_CHARS} characters.`);

  // KV needs the length up front: a stream is passed straight through when the client said how long it is.
  const declared = Number(request.headers.get("Content-Length"));
  let value, size;
  if (request.headers.has("Content-Length") && Number.isInteger(declared) && declared >= 0) {
    if (declared > MAX_FILE_BYTES) return fail(413, "That file is larger than 25 MB.");
    value = declared === 0 ? new Uint8Array(0) : request.body;
    size = declared;
  } else {
    value = await readBody(request, MAX_FILE_BYTES);
    if (!value) return fail(413, "That file is larger than 25 MB.");
    size = value.byteLength;
  }

  const used = await env.DB.prepare("SELECT COUNT(*) AS files, COALESCE(SUM(size), 0) AS bytes FROM files WHERE slug = ?1 AND version = ?2 AND path != ?3")
    .bind(doc.slug, version, path).first();
  if (used.files >= MAX_FILES_PER_VERSION) return fail(413, `A document can hold at most ${MAX_FILES_PER_VERSION} files.`);
  if (used.bytes + size > MAX_VERSION_BYTES) return fail(413, "A document can hold at most 60 MB of files.");

  const type = contentTypeFor(path, request.headers.get("Content-Type"));
  await env.FILES.put(fileKey(doc.slug, version, path), value);
  await env.DB.prepare("INSERT INTO files (slug, version, path, content_type, size) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT (slug, version, path) DO UPDATE SET content_type = excluded.content_type, size = excluded.size")
    .bind(doc.slug, version, path, type, size).run();
  await dropFiles(env, doc.slug, deadVersions(doc), SWEEP_ON_UPLOAD);
  return json({ path, bytes: size });
}

// Free-plan Workers allow 50 subrequests per request and every KV call counts, so deletes are done a few at a time.
export const SWEEP_ON_UPLOAD = 10;

// Versions that are neither live nor open for upload. Their files are never served and can be deleted at any time.
// (Numbers come from the database, never from a request.)
export const deadVersions = (doc) => `version != ${Number(doc.version)} AND version != ${Number(doc.staged)}`;

// Deletes up to `limit` stored files of one document, from KV and D1, that match a condition on the files table.
// Returns how many it removed; when that equals `limit` there may be more.
export async function dropFiles(env, slug, where, limit) {
  if (limit <= 0) return 0;
  const { results } = await env.DB.prepare(`SELECT version, path FROM files WHERE slug = ?1 AND ${where} LIMIT ${Number(limit)}`).bind(slug).all();
  if (!results.length) return 0;
  await Promise.all(results.map((r) => env.FILES.delete(fileKey(slug, r.version, r.path))));
  const pairs = results.map((_, i) => `(version = ?${i * 2 + 2} AND path = ?${i * 2 + 3})`).join(" OR ");
  await env.DB.prepare(`DELETE FROM files WHERE slug = ?1 AND (${pairs})`)
    .bind(slug, ...results.flatMap((r) => [r.version, r.path])).run();
  return results.length;
}

// One range of "bytes=a-b", "bytes=a-" or "bytes=-n". Returns null (no usable range: send the whole file), "bad" (out of range) or {start, end}.
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec((header || "").trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start, end;
  if (m[1] === "") { start = Math.max(0, size - Number(m[2])); end = size - 1; }
  else { start = Number(m[1]); end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1); }
  return start >= size || start > end ? "bad" : { start, end };
}

const matchesEtag = (header, etag) => !!header && header.split(",").some((t) => t.trim() === "*" || t.trim().replace(/^W\//, "") === etag.replace(/^W\//, ""));

// Serves one stored file of the live version. The entry page also gets the Redline layers. Returns null when there is no such file.
export async function serveFile(request, env, doc, rawPath) {
  const wanted = rawPath === "" ? doc.entry : rawPath.endsWith("/") ? rawPath + "index.html" : rawPath;
  if (!cleanPath(wanted)) return null;
  const row = await env.DB.prepare("SELECT content_type, size FROM files WHERE slug = ?1 AND version = ?2 AND path = ?3").bind(doc.slug, doc.version, wanted).first();
  if (!row) return null;

  const isEntry = wanted === doc.entry && /^text\/html/i.test(row.content_type);
  // The entry page is rewritten on the way out, so its tag also changes with the layer build.
  const etag = `W/"${doc.version}-${row.size}${isEntry ? "-" + buildId(env) : ""}"`;
  const headers = { "Content-Type": row.content_type, "Cache-Control": "no-cache", ETag: etag, "Accept-Ranges": "bytes" };
  if (matchesEtag(request.headers.get("If-None-Match"), etag)) return new Response(null, { status: 304, headers });

  const key = fileKey(doc.slug, doc.version, wanted);
  const range = isEntry ? null : parseRange(request.headers.get("Range"), row.size);
  if (range === "bad") return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${row.size}` } });
  if (range) {
    const buf = await env.FILES.get(key, "arrayBuffer");
    if (!buf) return null;
    const part = buf.slice(range.start, range.end + 1);
    return new Response(part, { status: 206, headers: { ...headers, "Content-Range": `bytes ${range.start}-${range.end}/${row.size}`, "Content-Length": String(part.byteLength) } });
  }
  const stream = await env.FILES.get(key, "stream");
  if (!stream) return null;
  if (!isEntry) return new Response(stream, { headers: { ...headers, "Content-Length": String(row.size) } });
  const res = await injectPage(new Response(stream, { headers }), doc, env);
  res.headers.set("ETag", etag);
  return res;
}
