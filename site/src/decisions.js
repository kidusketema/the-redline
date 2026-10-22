// Approve / Reject / Not sure. Answers are never overwritten: each one is a new row and the newest per item is current.
import { json, fail, readJson, cleanStr } from "./util.js";
import { loadVersion, hashFor, isStale } from "./versions.js";

const VERDICTS = ["approve", "reject", "unsure"];
const MAX_NOTE = 1000;
const MAX_LABEL = 60;
const MAX_REQUEST_BYTES = 4000;
const MAX_DECISIONS_PER_DOC = 3000;
const ITEM_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;

// version is the version of the page the answer was given on. text_hash is a fingerprint of the words it was given on (kept, not shown).
// stale is added by the caller: true when those words have changed since, so the answer no longer covers what is on the page.
const rowOut = (r) => ({
  id: r.id, item: r.item, verdict: r.verdict, note: r.note, author_label: r.author_label, created_at: r.created_at, version: r.version || 0, text_hash: r.text_hash || "",
});
const shown = (r, live) => {
  const { text_hash, ...out } = rowOut(r);
  return { ...out, stale: isStale(r, live) };
};

// The newest decision for each item of one document (all = true: the whole history).
export async function listDecisions(env, doc, all = false, live) {
  const sql = all
    ? "SELECT * FROM decisions WHERE doc_slug = ?1 ORDER BY id ASC"
    : "SELECT * FROM decisions d WHERE doc_slug = ?1 AND id = (SELECT MAX(id) FROM decisions WHERE doc_slug = d.doc_slug AND item = d.item) ORDER BY id ASC";
  const { results } = await env.DB.prepare(sql).bind(doc.slug).all();
  if (live === undefined) live = await loadVersion(env, doc);
  return results.map((r) => shown(r, live));
}

// The newest decision per item for every document, in one query.
export async function latestDecisionsByDoc(env) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM decisions d WHERE id = (SELECT MAX(id) FROM decisions WHERE doc_slug = d.doc_slug AND item = d.item) ORDER BY id ASC",
  ).all();
  const bySlug = new Map();
  for (const r of results) {
    if (!bySlug.has(r.doc_slug)) bySlug.set(r.doc_slug, []);
    bySlug.get(r.doc_slug).push(rowOut(r)); // still carries text_hash: the caller works out which are stale
  }
  return bySlug;
}

// /api/<link>/decisions  GET newest per item (?all=1 for the history), POST {item, verdict, note?, author_label?}
// A new answer records the version it was given on and a fingerprint of the words under it (the section, or the whole page).
export async function decisionsApi(request, env, url, doc, rest) {
  const slug = doc.slug;
  if (rest.length) return fail(404, "Not found.");
  if (request.method === "GET") return json({ decisions: await listDecisions(env, doc, url.searchParams.get("all") === "1") });
  if (request.method !== "POST") return fail(405, "That method is not allowed here.");

  const parsed = await readJson(request, MAX_REQUEST_BYTES);
  if (parsed.error) return fail(parsed.status, parsed.error);
  const input = parsed.value;
  const item = typeof input.item === "string" ? input.item.trim() : "";
  if (!ITEM_RE.test(item)) return fail(400, "item must be a short id (letters, digits, . _ : -)");
  if (!VERDICTS.includes(input.verdict)) return fail(400, `verdict must be one of: ${VERDICTS.join(", ")}`);
  const note = cleanStr(input.note, "note", MAX_NOTE);
  if (note.error) return fail(400, note.error);
  const label = cleanStr(input.author_label, "author_label", MAX_LABEL);
  if (label.error) return fail(400, label.error);

  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM decisions WHERE doc_slug = ?1").bind(slug).first();
  if (count.n >= MAX_DECISIONS_PER_DOC) return fail(429, "There are too many answers on this document.");
  const created_at = new Date().toISOString();
  const text_hash = hashFor(await loadVersion(env, doc), item);
  const row = await env.DB.prepare("INSERT INTO decisions (doc_slug, item, verdict, note, author_label, created_at, version, text_hash) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) RETURNING id")
    .bind(slug, item, input.verdict, note.value, label.value, created_at, doc.version, text_hash).first();
  return json({ decision: shown({ id: row.id, item, verdict: input.verdict, note: note.value, author_label: label.value, created_at, version: doc.version, text_hash }, null) }, 201);
}
