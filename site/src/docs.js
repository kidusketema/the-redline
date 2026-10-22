// The documents themselves: create, publish a new version, list with counts, delete, and the combined feedback call.
import { json, jsonText, fail, readJson, parseJson, cleanStr, randomSlug, SLUG_RE } from "./util.js";
import { dropFiles, deadVersions } from "./files.js";
import { commentsRows, commentText } from "./comments.js";
import { inkRows, inkText } from "./ink.js";
import { listDecisions, latestDecisionsByDoc } from "./decisions.js";
import { loadVersion, recordCommit, isStale, inkIsStale } from "./versions.js";

const MAX_REQUEST_BYTES = 20000;
const MAX_TAGS = 10;
// Free-plan Workers allow 50 subrequests per request and every KV and D1 call counts, so file clean-up is done a few at a time.
const DROP_OLD_STAGED = 15;
const DROP_STALE_DOCS = 15;
const DROP_ON_DELETE = 35;
const DROP_ON_COMMIT = 20;
const STALE_AFTER_MS = 60 * 60 * 1000;

// A document is found by its link, the 24 characters in its address. The link can change (redline relink); doc.slug, the id that every
// other table and every stored file uses, never does. Anything that goes back to a reader or a caller says "slug" for the link.
export async function loadDoc(env, link) {
  if (typeof link !== "string" || !SLUG_RE.test(link)) return null;
  return env.DB.prepare("SELECT * FROM docs WHERE link = ?1").bind(link).first();
}

// A document is visible to readers once its first version has been committed.
export const isLive = (doc) => !!doc && doc.version >= 1;

const tagList = (s) => (s ? s.split(",") : []);

function cleanTags(v) {
  if (v === undefined || v === null || v === "") return { value: "" };
  const list = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : null;
  if (!list) return { error: "tags must be a list of words or a comma-separated string" };
  const tags = [];
  for (const t of list) {
    if (typeof t !== "string") return { error: "tags must be words" };
    const clean = t.replace(/[\s,]+/g, " ").trim();
    if (clean.length > 30) return { error: "a tag is too long (max 30 characters)" };
    if (clean && !tags.includes(clean)) tags.push(clean);
  }
  if (tags.length > MAX_TAGS) return { error: `too many tags (max ${MAX_TAGS})` };
  return { value: tags.join(",") };
}

// Documents that were created but never committed (a failed publish, or a delete that is still clearing files) are removed an hour later.
async function purgeStale(env) {
  const cutoff = new Date(Date.now() - STALE_AFTER_MS).toISOString();
  const { results } = await env.DB.prepare("SELECT slug FROM docs WHERE version = 0 AND created_at < ?1 LIMIT 3").bind(cutoff).all();
  let room = DROP_STALE_DOCS;
  for (const { slug } of results) {
    const dropped = await dropFiles(env, slug, "1 = 1", room);
    room -= dropped;
    if (room > 0) await env.DB.prepare("DELETE FROM docs WHERE slug = ?1").bind(slug).run(); // every file is gone
    else break;
  }
}

// POST /api/docs: a new document, or with a slug a new version of an existing one. The new version is staged until commit.
// Staged version numbers only go up, so files left by an earlier failed attempt can never become part of a later one.
export async function createDoc(request, env, url) {
  const parsed = await readJson(request, MAX_REQUEST_BYTES);
  if (parsed.error) return fail(parsed.status, parsed.error);
  const input = parsed.value;
  const fields = {};
  for (const [name, max] of [["title", 200], ["summary", 1000], ["project", 100]]) {
    const r = cleanStr(input[name], name, max);
    if (r.error) return fail(400, r.error);
    fields[name] = r.value;
  }
  const tags = cleanTags(input.tags);
  if (tags.error) return fail(400, tags.error);
  const now = new Date().toISOString();

  let slug, link, version, status = 200;
  if (input.slug !== undefined && input.slug !== null) {
    const doc = typeof input.slug === "string" ? await loadDoc(env, input.slug) : null;
    if (!doc) return fail(404, "There is no document with that slug.");
    slug = doc.slug;
    link = doc.link;
    version = Math.max(doc.version, doc.staged) + 1;
    // Only fields that were sent change. updated_at moves at commit, not here.
    await env.DB.prepare("UPDATE docs SET title = ?2, summary = ?3, project = ?4, tags = ?5, staged = ?6 WHERE slug = ?1")
      .bind(slug, fields.title || doc.title, "summary" in input ? fields.summary : doc.summary,
        "project" in input ? fields.project : doc.project, "tags" in input ? tags.value : doc.tags, version).run();
    if (doc.staged) await dropFiles(env, slug, `version = ${Number(doc.staged)}`, DROP_OLD_STAGED);
  } else {
    if (!fields.title) return fail(400, "title is required");
    slug = link = randomSlug();
    version = 1;
    status = 201;
    await env.DB.prepare("INSERT INTO docs (slug, link, title, summary, project, tags, version, staged, entry, created_at, updated_at) VALUES (?1, ?1, ?2, ?3, ?4, ?5, 0, 1, 'index.html', ?6, ?6)")
      .bind(slug, fields.title, fields.summary, fields.project, tags.value, now).run();
  }
  await purgeStale(env);
  return json({ slug: link, version, url: `${url.origin}/${link}/` }, status);
}

// POST /api/docs/<slug>/v/<version>/commit: makes the staged version live and removes every other version's files.
export async function commitVersion(request, env, url, doc, version) {
  if (version !== doc.staged) return fail(409, `Version ${version} is not waiting to be published.`);
  let input = {};
  const text = await request.text();
  if (text.trim()) {
    const parsed = parseJson(text, MAX_REQUEST_BYTES);
    if (parsed.error) return fail(parsed.status, parsed.error);
    input = parsed.value;
  }
  const entry = input.entry === undefined || input.entry === null ? "index.html" : input.entry;
  const pdf = input.pdf === undefined || input.pdf === null || input.pdf === "" ? null : input.pdf;
  if (typeof entry !== "string" || (pdf !== null && typeof pdf !== "string")) return fail(400, "entry and pdf must be file paths");

  const have = async (path) =>
    env.DB.prepare("SELECT content_type FROM files WHERE slug = ?1 AND version = ?2 AND path = ?3").bind(doc.slug, version, path).first();
  const entryFile = await have(entry);
  if (!entryFile) return fail(400, `The entry file ${entry} was not uploaded to this version.`);
  if (!/^text\/html/i.test(entryFile.content_type)) return fail(400, `The entry file ${entry} is not an HTML file.`);
  if (pdf !== null && !(await have(pdf))) return fail(400, `The PDF ${pdf} was not uploaded to this version.`);

  await env.DB.prepare("UPDATE docs SET version = ?2, staged = 0, entry = ?3, pdf = ?4, updated_at = ?5 WHERE slug = ?1")
    .bind(doc.slug, version, entry, pdf, new Date().toISOString()).run();
  // The new version's words (and what changed since the last one) are recorded while its files are still here and the old ones are not yet gone.
  await recordCommit(env, doc, version, entry);
  await dropFiles(env, doc.slug, deadVersions({ version, staged: 0 }), DROP_ON_COMMIT);
  return json({ url: `${url.origin}/${doc.link}/` });
}

// DELETE /api/docs/<slug>. A document with more files than one request can delete stays hidden and answers files_left > 0;
// calling DELETE again carries on, and anything still left is removed by purgeStale an hour later.
export async function deleteDoc(env, doc) {
  const slug = doc.slug;
  const dropped = await dropFiles(env, slug, "1 = 1", DROP_ON_DELETE);
  if (dropped === DROP_ON_DELETE) {
    const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM files WHERE slug = ?1").bind(slug).first();
    if (left.n > 0) {
      await env.DB.batch([
        env.DB.prepare("DELETE FROM comments WHERE doc_slug = ?1").bind(slug),
        env.DB.prepare("DELETE FROM ink WHERE doc_slug = ?1").bind(slug),
        env.DB.prepare("DELETE FROM decisions WHERE doc_slug = ?1").bind(slug),
        env.DB.prepare("DELETE FROM version_blocks WHERE slug = ?1").bind(slug),
        env.DB.prepare("UPDATE docs SET version = 0, staged = 0, created_at = '1970-01-01T00:00:00.000Z' WHERE slug = ?1").bind(slug),
      ]);
      return json({ deleted: doc.link, files_left: left.n });
    }
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM comments WHERE doc_slug = ?1").bind(slug),
    env.DB.prepare("DELETE FROM ink WHERE doc_slug = ?1").bind(slug),
    env.DB.prepare("DELETE FROM decisions WHERE doc_slug = ?1").bind(slug),
    env.DB.prepare("DELETE FROM version_blocks WHERE slug = ?1").bind(slug),
    env.DB.prepare("DELETE FROM docs WHERE slug = ?1").bind(slug),
  ]);
  return json({ deleted: doc.link, files_left: 0 });
}


// POST /api/docs/<link>/relink: the page gets a new random link and the old one stops working. Comments, pen marks, answers and files are
// untouched, because they belong to the document's id, not to its link.
export async function relinkDoc(env, url, doc) {
  let link = "";
  for (let i = 0; i < 5 && !link; i++) {
    const tryLink = randomSlug();
    const taken = await env.DB.prepare("SELECT slug FROM docs WHERE link = ?1 OR slug = ?1").bind(tryLink).first();
    if (!taken) link = tryLink;
  }
  if (!link) return fail(500, "Could not make a new link. Try again.");
  await env.DB.prepare("UPDATE docs SET link = ?2 WHERE slug = ?1").bind(doc.slug, link).run();
  return json({ slug: link, previous: doc.link, url: `${url.origin}/${link}/` });
}

// Every live document with its counts, newest activity first. A handful of queries in all, however many documents there are.
export async function listDocs(env, origin) {
  const [docs, comments, ink, decisions, blocks] = await Promise.all([
    env.DB.prepare("SELECT * FROM docs WHERE version >= 1").all(),
    env.DB.prepare(
      "SELECT doc_slug, SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open, SUM(CASE WHEN status = 'fixed' THEN 1 ELSE 0 END) AS fixed, " +
      "SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done, MAX(created_at) AS last, MAX(status_at) AS changed FROM comments GROUP BY doc_slug",
    ).all(),
    env.DB.prepare("SELECT doc_slug, COUNT(*) AS n, MAX(created_at) AS last FROM ink WHERE resolved = 0 GROUP BY doc_slug").all(),
    latestDecisionsByDoc(env),
    env.DB.prepare("SELECT b.slug, b.version, b.sections FROM version_blocks b JOIN docs d ON d.slug = b.slug AND d.version = b.version WHERE d.version >= 1").all(),
  ]);
  const commentBy = new Map(comments.results.map((r) => [r.doc_slug, r]));
  const inkBy = new Map(ink.results.map((r) => [r.doc_slug, r]));
  const liveBy = new Map(blocks.results.map((r) => [r.slug, liveSections(r)]));
  const out = docs.results.map((d) => {
    const c = commentBy.get(d.slug), i = inkBy.get(d.slug), live = liveBy.get(d.slug) || null;
    const dec = (decisions.get(d.slug) || []).map(({ text_hash, ...x }) => ({ ...x, stale: isStale({ ...x, text_hash }, live) }));
    const times = [c && c.last, c && c.changed, i && i.last, ...dec.map((x) => x.created_at)].filter(Boolean);
    const last = times.length ? times.reduce((a, b) => (a > b ? a : b)) : null;
    return {
      slug: d.link, title: d.title, summary: d.summary, project: d.project, tags: tagList(d.tags), version: d.version, pdf: d.pdf,
      url: `${origin}/${d.link}/`, created_at: d.created_at, updated_at: d.updated_at,
      open_comments: c ? c.open : 0, fixed_comments: c ? c.fixed : 0, done_comments: c ? c.done : 0,
      ink_strokes: i ? i.n : 0, decisions: dec, stale_decisions: dec.filter((x) => x.stale).length,
      last_feedback_at: last, new_feedback: !!last && last > d.updated_at,
    };
  });
  const activity = (d) => (d.last_feedback_at && d.last_feedback_at > d.updated_at ? d.last_feedback_at : d.updated_at);
  return out.sort((a, b) => (activity(b) > activity(a) ? 1 : activity(b) < activity(a) ? -1 : 0));
}

function liveSections(row) {
  try {
    const s = JSON.parse(row.sections || "{}");
    return { version: row.version, blocks: [], sections: s.s || {}, doc: s.d || "" };
  } catch { return null; }
}

// How the feedback stands, in numbers: the same counts the CLI header and the dashboard show.
export function summarize(version, comments, decisions, ink) {
  const count = (s) => comments.filter((c) => c.status === s).length;
  return {
    version, since: version > 1 ? version - 1 : null,
    open: count("open"), fixed: count("fixed"), done: count("done"),
    decisions_to_redo: decisions.filter((d) => d.stale).length,
    pen_marks_changed: ink.filter((m) => m.stale).length,
  };
}

// GET /api/<link>/feedback: everything Claude needs to read in one call. Stored comment and pen JSON is spliced in as text.
export async function feedback(env, doc) {
  const live = await loadVersion(env, doc);
  const [comments, ink, decisions] = await Promise.all([commentsRows(env, doc.slug), inkRows(env, doc.slug), listDecisions(env, doc, false, live)]);
  const marks = ink.map((r) => ({ ...r, stale: inkIsStale(r, live) }));
  const info = {
    slug: doc.link, title: doc.title, summary: doc.summary, project: doc.project, tags: tagList(doc.tags),
    version: doc.version, pdf: doc.pdf, created_at: doc.created_at, updated_at: doc.updated_at,
  };
  const body = `{"doc":${JSON.stringify(info)},"comments":[${comments.map(commentText).join(",")}],"ink":[${marks.map(inkText).join(",")}],` +
    `"decisions":${JSON.stringify(decisions)},"summary":${JSON.stringify(summarize(doc.version, comments, decisions, marks))}}`;
  return jsonText(body);
}
