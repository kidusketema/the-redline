// Comments on a document: a note on selected text, on a diagram, on a pin dropped on a picture, or on the whole document.
import { jsonText, fail, readJson, cleanStr, withRaw, stripControls } from "./util.js";

const MAX = { body: 4000, anchor_text: 1000, anchor_context: 2000, author_label: 60, note: 500 };
// open: needs work. fixed: whoever changed the page says it is dealt with (with a short note). done: the reader confirmed.
// The reader can send a fixed or done comment back to open.
export const STATUSES = ["open", "fixed", "done"];
const KINDS = ["", "text", "svg", "pin"];
const MAX_REQUEST_BYTES = 20000;
const MAX_COMMENTS_PER_DOC = 2000;
const MAX_COMMENT_BYTES_PER_DOC = 2_000_000;

// One row as JSON text. anchor_data was cleaned and stringified when it was written, so it is spliced in as it is.
// resolved (true once the reader confirmed) is kept for tools that only know the old yes/no. reopened: sent back after it was marked fixed.
export const commentText = (r) =>
  withRaw({
    id: r.id, doc_slug: r.doc_slug, anchor_kind: r.anchor_kind || "", anchor_text: r.anchor_text, anchor_context: r.anchor_context,
    body: r.body, author_label: r.author_label, created_at: r.created_at,
    status: r.status || "open", fix_note: r.fix_note || "", fixed_at: r.fixed_at || "", fixed_version: r.fixed_version || 0,
    reopened: (r.status || "open") === "open" && !!r.fixed_at, resolved: r.status === "done",
  }, "anchor_data", r.anchor_data || "null");

// The comments of one document, oldest first.
export async function commentsRows(env, slug) {
  const { results } = await env.DB.prepare("SELECT * FROM comments WHERE doc_slug = ?1 ORDER BY id ASC").bind(slug).all();
  return results;
}

// anchor_data is a small JSON object. Only known keys survive, strings are capped, numbers are clamped.
function cleanData(kind, raw) {
  if (raw === undefined || raw === null || raw === "") raw = null;
  if (typeof raw === "string") {
    if (raw.length > 2000) return { error: "anchor_data is too long" };
    try { raw = JSON.parse(raw); } catch { return { error: "anchor_data must be JSON" }; }
  }
  if (raw !== null && (typeof raw !== "object" || Array.isArray(raw))) return { error: "anchor_data must be an object" };
  const str = (v, n) => (typeof v === "string" ? stripControls(v).replace(/\s+/g, " ").trim().slice(0, n) : "");
  const num = (v) => (typeof v === "number" && isFinite(v) ? Math.round(Math.max(0, Math.min(100, v)) * 10) / 10 : null);
  if (kind === "svg") {
    if (!raw) return { value: "" };
    return { value: JSON.stringify({ fig: str(raw.fig, 40), cap: str(raw.cap, 100), label: str(raw.label, 140) }) };
  }
  if (kind === "pin") {
    if (!raw) return { error: "a pin needs anchor_data" };
    const t = str(raw.t, 40), x = num(raw.x), y = num(raw.y);
    if (!/^(svg|img)-[0-9]{1,4}$/.test(t)) return { error: "anchor_data.t must look like svg-3 or img-2" };
    if (x === null || y === null) return { error: "anchor_data.x and .y must be numbers (percent)" };
    return { value: JSON.stringify({ t, x, y, near: str(raw.near, 100), label: str(raw.label, 140), alt: str(raw.alt, 140) }) };
  }
  return { value: "" };
}

async function createComment(request, env, doc) {
  const slug = doc.slug;
  const parsed = await readJson(request, MAX_REQUEST_BYTES);
  if (parsed.error) return fail(parsed.status, parsed.error);
  const input = parsed.value;

  const out = {};
  for (const [name, opts] of [["anchor_text", {}], ["anchor_context", {}], ["body", { required: true }], ["author_label", {}]]) {
    const r = cleanStr(input[name], name, MAX[name], opts);
    if (r.error) return fail(400, r.error);
    out[name] = r.value;
  }
  const kind = input.anchor_kind === undefined || input.anchor_kind === null ? (out.anchor_text ? "text" : "") : input.anchor_kind;
  if (typeof kind !== "string" || !KINDS.includes(kind)) return fail(400, "anchor_kind must be one of: text, svg, pin");
  if (kind === "text" || kind === "svg") {
    if (!out.anchor_text) return fail(400, `anchor_text is required for a ${kind} comment`);
  } else if (kind === "pin") {
    out.anchor_text = "";
  } else {
    out.anchor_text = ""; out.anchor_context = "";
  }
  const data = cleanData(kind, input.anchor_data);
  if (data.error) return fail(400, data.error);
  out.anchor_data = data.value;

  const used = await env.DB.prepare(
    "SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(body || anchor_text || anchor_context || anchor_data || author_label)), 0) AS bytes FROM comments WHERE doc_slug = ?1",
  ).bind(slug).first();
  const size = out.body.length + out.anchor_text.length + out.anchor_context.length + out.anchor_data.length + out.author_label.length;
  if (used.n >= MAX_COMMENTS_PER_DOC || used.bytes + size > MAX_COMMENT_BYTES_PER_DOC) return fail(429, "There are too many comments on this document.");

  const created_at = new Date().toISOString();
  const row = await env.DB.prepare(
    "INSERT INTO comments (doc_slug, anchor_kind, anchor_text, anchor_context, anchor_data, body, author_label, created_at, status) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'open') RETURNING id",
  ).bind(slug, kind, out.anchor_text, out.anchor_context, out.anchor_data, out.body, out.author_label, created_at).first();
  return jsonText(`{"comment":${commentText({ id: row.id, doc_slug: slug, anchor_kind: kind, ...out, created_at, status: "open" })}}`, 201);
}

// /api/<link>/comments                         GET list, POST add
// /api/<link>/comments/<id>/status             POST {"status": "fixed" | "done" | "open", "note"?: "what changed"}
// /api/<link>/comments/<id>/resolve            the same call as it used to be: no body or {"resolved": true} means fixed, {"resolved": false} means open
export async function commentsApi(request, env, doc, rest) {
  const slug = doc.slug;
  if (rest.length === 0) {
    if (request.method === "GET") return jsonText(`{"comments":[${(await commentsRows(env, slug)).map(commentText).join(",")}]}`);
    if (request.method === "POST") return createComment(request, env, doc);
    return fail(405, "That method is not allowed here.");
  }
  if (rest.length === 2 && (rest[1] === "status" || rest[1] === "resolve") && /^[0-9]{1,12}$/.test(rest[0])) {
    if (request.method !== "POST") return fail(405, "That method is not allowed here.");
    const text = await request.text();
    if (text.length > 2000) return fail(413, "That request is too large.");
    let input = {};
    if (text.trim()) {
      try { input = JSON.parse(text); } catch { return fail(400, "The request body is not valid JSON."); }
      if (!input || typeof input !== "object" || Array.isArray(input)) return fail(400, "Expected a JSON object.");
    }
    let status;
    if (rest[1] === "status") status = input.status;
    else status = input.resolved === false ? "open" : "fixed";
    if (!STATUSES.includes(status)) return fail(400, "status must be one of: open, fixed, done");
    const note = cleanStr(input.note, "note", MAX.note);
    if (note.error) return fail(400, note.error);
    const now = new Date().toISOString();
    let row;
    const id = Number(rest[0]);
    if (status === "fixed") {
      row = await env.DB.prepare("UPDATE comments SET status = 'fixed', fix_note = ?1, fixed_at = ?2, fixed_version = ?3 WHERE id = ?4 AND doc_slug = ?5 RETURNING *")
        .bind(note.value, now, doc.version, id, slug).first();
    } else {
      // The reader's own answers: confirming the fix, or sending it back. The agent's note stays so it can be seen after a reopen.
      row = await env.DB.prepare("UPDATE comments SET status = ?1, status_at = ?2 WHERE id = ?3 AND doc_slug = ?4 RETURNING *")
        .bind(status, now, id, slug).first();
    }
    if (!row) return fail(404, "There is no such comment.");
    return jsonText(`{"comment":${commentText(row)}}`);
  }
  return fail(404, "Not found.");
}
