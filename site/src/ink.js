// Pen marks ("ink"): strokes drawn on a document with an Apple Pencil, pen, mouse or finger, one row per stroke.
// Each stroke is anchored to the paragraph, heading, list item or figure it starts on, so it stays next to
// what was marked when the same link is re-published.
import { json, jsonText, fail, readJson, withRaw, stripControls } from "./util.js";
import { loadVersion, anchorHash, inkIsStale } from "./versions.js";

const MAX_INK_BYTES = 60000;
const MAX_INK_PER_DOC = 5000;
const MAX_INK_BYTES_PER_DOC = 5_000_000;
const MAX_POINTS = 4000;
const COLORS = ["red", "blue", "black", "hl"];

// One row as JSON text. data was cleaned and stringified when it was written, so it is spliced in as it is.
// version is the version of the page the stroke was drawn on; stale is true when the paragraph it was drawn on has changed since.
export const inkText = (r) =>
  withRaw({
    id: r.id, doc_slug: r.doc_slug, author_label: r.author_label, created_at: r.created_at, resolved: !!r.resolved,
    version: r.version || 0, stale: !!r.stale,
  }, "data", r.data);

// A stroke is { a: anchor, c: colour, w: width, p: [x, y, pressure, x, y, pressure, ...], tx: words it covers, vw: window width }.
// Coordinates are integers in ten-thousandths of the anchor block's width, measured from its top-left corner; pressure is 0..100.
function cleanStroke(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "data must be an object" };
  const a = raw.a;
  if (!a || typeof a !== "object") return { error: "data.a (anchor) is required" };
  const anchor = {
    k: String(a.k || "").slice(0, 12).toLowerCase().replace(/[^a-z0-9]/g, ""),
    t: stripControls(String(a.t || "")).slice(0, 120),
    i: Number.isFinite(a.i) ? Math.max(0, Math.min(100000, Math.round(a.i))) : 0,
  };
  const c = COLORS.includes(raw.c) ? raw.c : "red";
  const w = Number.isFinite(raw.w) ? Math.max(1, Math.min(2000, Math.round(raw.w))) : 30;
  if (!Array.isArray(raw.p) || raw.p.length < 3 || raw.p.length % 3 !== 0) return { error: "data.p must hold x, y, pressure triples" };
  if (raw.p.length / 3 > MAX_POINTS) return { error: "stroke has too many points" };
  const p = [];
  for (const v of raw.p) {
    if (!Number.isFinite(v)) return { error: "data.p must be numbers" };
    p.push(Math.max(-200000, Math.min(2000000, Math.round(v))));
  }
  const tx = stripControls(String(raw.tx || "")).replace(/\s+/g, " ").slice(0, 300); // the words the stroke covers, as drawn
  const vw = Number.isFinite(raw.vw) ? Math.max(200, Math.min(8000, Math.round(raw.vw))) : 0; // window width when drawn
  const m = cleanMeta(raw.m);
  return { value: JSON.stringify(m ? { a: anchor, c, w, p, tx, vw, m } : { a: anchor, c, w, p, tx, vw }) };
}

// How the browser delivered the stroke, for checking real Pencil input later: ty pointer type, hz samples per second, co samples per event,
// fr 1 when positions had fractions of a pixel, p0/p1 lowest and highest pressure (0..100), cx 1 when the stroke was cut short (pointercancel),
// pm 1 when drawn with the toolbar closed (Pencil mode).
function cleanMeta(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const num = (v, max, step = 1) => (Number.isFinite(v) ? Math.max(0, Math.min(max, Math.round(v / step) * step)) : 0);
  return {
    ty: ["pen", "mouse", "touch"].includes(raw.ty) ? raw.ty : "",
    hz: num(raw.hz, 2000), co: Math.round(num(raw.co, 100, 0.1) * 10) / 10,
    fr: raw.fr ? 1 : 0, p0: num(raw.p0, 100), p1: num(raw.p1, 100), cx: raw.cx ? 1 : 0, pm: raw.pm ? 1 : 0,
  };
}

// The open pen marks of one document.
export async function inkRows(env, slug) {
  const { results } = await env.DB.prepare("SELECT * FROM ink WHERE doc_slug = ?1 AND resolved = 0 ORDER BY id ASC").bind(slug).all();
  return results;
}

// /api/<link>/ink       GET list, POST add one stroke
// /api/<link>/ink/<id>  DELETE (undo, eraser)
// The caller has already checked that the document is live and that a write is same-origin.
export async function inkApi(request, env, doc, rest) {
  const slug = doc.slug;
  if (rest.length === 0) {
    if (request.method === "GET") {
      const live = await loadVersion(env, doc);
      return jsonText(`{"ink":[${(await inkRows(env, slug)).map((r) => inkText({ ...r, stale: inkIsStale(r, live) })).join(",")}]}`);
    }
    if (request.method !== "POST") return fail(405, "That method is not allowed here.");
    const body = await readJson(request, MAX_INK_BYTES);
    if (body.error) return fail(body.status, body.error);
    const data = cleanStroke(body.value.data);
    if (data.error) return fail(400, data.error);
    const author = stripControls(String(body.value.author_label || "")).replace(/\s+/g, " ").trim().slice(0, 60);
    const used = await env.DB.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(data)), 0) AS bytes FROM ink WHERE doc_slug = ?1").bind(slug).first();
    if (used.n >= MAX_INK_PER_DOC || used.bytes + data.value.length > MAX_INK_BYTES_PER_DOC) return fail(429, "There are too many pen marks on this document.");
    const created_at = new Date().toISOString();
    // The paragraph the stroke sits on is remembered by a hash of its words, so a later edit to it can be noticed.
    const block = anchorHash(await loadVersion(env, doc), JSON.parse(data.value).a.t);
    const row = await env.DB.prepare("INSERT INTO ink (doc_slug, data, author_label, created_at, resolved, version, block_hash) VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6) RETURNING id")
      .bind(slug, data.value, author, created_at, doc.version, block).first();
    return jsonText(`{"ink":${inkText({ id: row.id, doc_slug: slug, data: data.value, author_label: author, created_at, resolved: 0, version: doc.version })}}`, 201);
  }
  if (rest.length === 1 && /^[0-9]{1,12}$/.test(rest[0])) {
    if (request.method !== "DELETE") return fail(405, "That method is not allowed here.");
    const gone = await env.DB.prepare("DELETE FROM ink WHERE id = ?1 AND doc_slug = ?2 RETURNING id").bind(Number(rest[0]), slug).first();
    if (!gone) return fail(404, "There is no such pen mark.");
    return json({ deleted: Number(rest[0]) });
  }
  return fail(404, "Not found.");
}
