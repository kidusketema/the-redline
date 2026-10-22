// The Redline review site. Routes only; each part lives in its own file.
// It is a plain fetch handler, so the same code runs in a Cloudflare Worker, a Node server, a Vercel function and a Netlify function.
// It needs an env with: DB (D1-style database), FILES (KV-style file store), PUBLISH_KEY, DASHBOARD_TOKEN, and optionally BUILD and PUBLIC_URL.
//   /api/docs...      owner endpoints (publish key)
//   /api/export, /api/import   owner endpoints to move everything to another site
//   /api/<slug>/...   page endpoints: comments, pen marks, decisions, feedback, changes
//   /d/<token>/       dashboard
//   /<slug>/...       the documents
import { SLUG_RE, json, fail, withBase, isOwner, sameOrigin, safeEqual } from "./util.js";
import { loadDoc, isLive, createDoc, commitVersion, deleteDoc, relinkDoc, listDocs, feedback } from "./docs.js";
import { changesApi } from "./changes.js";
import { ensureSchema } from "./migrate.js";
import { uploadFile, serveFile } from "./files.js";
import { commentsApi } from "./comments.js";
import { inkApi } from "./ink.js";
import { decisionsApi } from "./decisions.js";
import { homePage, notFoundPage, dashboardPage } from "./dashboard.js";
import { exportApi, importApi } from "./portable.js";

const decode = (s) => { try { return decodeURIComponent(s); } catch { return null; } };

// /api/docs and everything below it. Needs the publish key.
async function ownerApi(request, env, url, rest) {
  if (!(await isOwner(request, env))) return fail(401, "The publish key is missing or wrong.");
  const method = request.method;

  if (rest.length === 0) {
    if (method === "GET") return json({ docs: await listDocs(env, url.origin) });
    if (method === "POST") return createDoc(request, env, url);
    return fail(405, "That method is not allowed here.");
  }
  const [slug, ...more] = rest;
  const doc = await loadDoc(env, slug);
  if (!doc) return fail(404, "There is no document with that slug.");

  if (more.length === 0 && method === "DELETE") return deleteDoc(env, doc);
  if (more.length === 1 && more[0] === "relink") return method === "POST" ? relinkDoc(env, url, doc) : fail(405, "That method is not allowed here.");
  if (more[0] === "v" && /^[1-9][0-9]{0,5}$/.test(more[1] || "")) {
    const version = Number(more[1]);
    if (more[2] === "commit" && more.length === 3 && method === "POST") return commitVersion(request, env, url, doc, version);
    if (more[2] === "files" && more.length > 3 && method === "PUT") {
      const path = decode(more.slice(3).join("/"));
      return path === null ? fail(400, "That file path is not valid.") : uploadFile(request, env, doc, version, path);
    }
  }
  return fail(404, "Not found.");
}

// /api/<slug>/<resource>: open to anyone with the link, so writes must come from the page itself.
async function pageApi(request, env, url, slug, resource, rest, seenOrigin) {
  const doc = await loadDoc(env, slug);
  if (!isLive(doc)) return fail(404, "There is no document with that slug.");
  if (request.method !== "GET" && !sameOrigin(request, url, seenOrigin)) return fail(403, "That request came from another site.");

  if (resource === "feedback" && rest.length === 0) return request.method === "GET" ? feedback(env, doc) : fail(405, "That method is not allowed here.");
  if (resource === "changes" && rest.length === 0) return request.method === "GET" ? changesApi(env, doc) : fail(405, "That method is not allowed here.");
  if (resource === "comments") return commentsApi(request, env, doc, rest);
  if (resource === "ink") return inkApi(request, env, doc, rest);
  if (resource === "decisions") return decisionsApi(request, env, url, doc, rest);
  return fail(404, "Not found.");
}

async function route(request, env, seenUrl) {
  // Behind a tunnel or proxy the address people use can differ from the one the server sees. Links in answers use the public one,
  // and a page on either address may write.
  let url = seenUrl;
  const seenOrigin = seenUrl.origin;
  if (env.PUBLIC_URL) {
    try { url = new URL(seenUrl.pathname + seenUrl.search, env.PUBLIC_URL); } catch { /* a bad value is ignored */ }
  }
  const path = url.pathname;
  const method = request.method;

  if (path === "/robots.txt") return new Response("User-agent: *\nDisallow: /\n", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  if (path === "/") return method === "GET" ? homePage() : notFoundPage();

  await ensureSchema(env); // a database made by an older version is brought up to date, once
  const parts = path.split("/").slice(1);
  if (parts[0] === "api") {
    if (parts[1] === "docs") return ownerApi(request, env, url, parts.slice(2));
    if (parts[1] === "export" || parts[1] === "import") {
      if (!(await isOwner(request, env))) return fail(401, "The publish key is missing or wrong.");
      if (parts.length !== 2) return fail(404, "Not found.");
      return parts[1] === "export" ? exportApi(request, env) : importApi(request, env);
    }
    if (SLUG_RE.test(parts[1] || "") && parts[2]) return pageApi(request, env, url, parts[1], parts[2], parts.slice(3), seenOrigin);
    return fail(404, "Not found.");
  }

  if (parts[0] === "d" && parts.length >= 2 && parts.length <= 3 && method === "GET") {
    const token = env.DASHBOARD_TOKEN;
    if (!token || token.length < 16 || !(await safeEqual(decode(parts[1]) || "", token))) return notFoundPage();
    if (parts.length === 2) return new Response(null, { status: 308, headers: { Location: `/d/${parts[1]}/` } });
    if (parts[2] !== "") return notFoundPage();
    return dashboardPage(await listDocs(env, url.origin));
  }

  if (SLUG_RE.test(parts[0]) && method === "GET") {
    const doc = await loadDoc(env, parts[0]);
    if (!isLive(doc)) return notFoundPage();
    if (parts.length === 1) return new Response(null, { status: 308, headers: { Location: `/${parts[0]}/${url.search}` } });
    const file = decode(parts.slice(1).join("/"));
    const res = file === null ? null : await serveFile(request, env, doc, file);
    return res || notFoundPage();
  }
  return notFoundPage();
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // HEAD is answered like GET with the body dropped.
    const head = request.method === "HEAD";
    if (head) request = new Request(request, { method: "GET" });
    let res;
    try {
      res = await route(request, env, url);
    } catch (err) {
      console.error("error", err && err.message);
      res = fail(500, "Something went wrong on the server.");
    }
    if (head && res.body) await res.body.cancel();
    return withBase(head ? new Response(null, res) : res);
  },
};
