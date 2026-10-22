// Moving everything between sites: GET /api/export and POST /api/import. Both need the publish key.
// The export keeps the same addresses: each document comes back with its own slug (the 24 characters of its link), so links keep working on the new site.
//
//   GET /api/export                 every live document: details, the live version's files (as base64), comments, pen marks, answers
//   GET /api/export?slug=<slug>     one document
//   GET /api/export?files=0         same, but files are listed (path, type, size) without their bytes
//   GET /api/export?slug=<s>&file=<path>   one document with just that one file, bytes included
//   POST /api/import                 the same JSON back. Documents with the same slug are updated.
//
// A document that has "comments", "ink" or "decisions" in the import replaces that list; one that leaves the key out keeps what it has.
// Files in the import are added or replaced; files already stored are kept. So a big document can be sent in several requests:
// the details and feedback first, then one file at a time (hosts cap a request at about 4.5 MB).
import { json, fail, SLUG_RE, cleanStr, stripControls, randomSlug } from "./util.js";
import { STATUSES } from "./comments.js";
import { cleanPath, contentTypeFor, dropFiles, deadVersions, fileKey, MAX_FILE_BYTES, MAX_FILES_PER_VERSION, MAX_VERSION_BYTES } from "./files.js";

const MAX_IMPORT_BYTES = 80 * 1024 * 1024;
const MAX_DOCS_PER_IMPORT = 200;
const LIMITS = { comments: 2000, ink: 5000, decisions: 3000 };

export function toBase64(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(out);
}

function fromBase64(text) {
  let bin;
  try { bin = atob(text); } catch { return null; }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function exportDoc(env, doc, { withBytes, only }) {
  const [files, comments, ink, decisions, versions] = await Promise.all([
    env.DB.prepare("SELECT path, content_type, size FROM files WHERE slug = ?1 AND version = ?2 ORDER BY path").bind(doc.slug, doc.version).all(),
    env.DB.prepare("SELECT * FROM comments WHERE doc_slug = ?1 ORDER BY id ASC").bind(doc.slug).all(),
    env.DB.prepare("SELECT * FROM ink WHERE doc_slug = ?1 ORDER BY id ASC").bind(doc.slug).all(),
    env.DB.prepare("SELECT * FROM decisions WHERE doc_slug = ?1 ORDER BY id ASC").bind(doc.slug).all(),
    env.DB.prepare("SELECT version, blocks, sections, changes FROM version_blocks WHERE slug = ?1 ORDER BY version ASC").bind(doc.slug).all(),
  ]);
  // The id a row belongs to is this site's own business; the other site makes its own.
  const bare = (rows) => rows.map(({ doc_slug, ...r }) => r);
  const list = [];
  for (const f of files.results) {
    if (only !== null && f.path !== only) continue;
    const entry = { path: f.path, content_type: f.content_type, size: f.size };
    if (withBytes) {
      const buf = await env.FILES.get(fileKey(doc.slug, doc.version, f.path), "arrayBuffer");
      if (!buf) continue;
      entry.data = toBase64(new Uint8Array(buf));
    }
    list.push(entry);
  }
  const { title, summary, project, tags, version, entry, pdf, created_at, updated_at } = doc;
  return {
    slug: doc.link, title, summary, project, tags, version, entry, pdf, created_at, updated_at, files: list,
    comments: bare(comments.results), ink: bare(ink.results), decisions: bare(decisions.results), versions: versions.results,
  };
}

export async function exportApi(request, env) {
  if (request.method !== "GET") return fail(405, "That method is not allowed here.");
  const q = new URL(request.url).searchParams;
  const slug = q.get("slug");
  const only = q.get("file");
  let docs;
  if (slug !== null) {
    if (!SLUG_RE.test(slug)) return fail(400, "That slug is not valid.");
    const doc = await env.DB.prepare("SELECT * FROM docs WHERE link = ?1 AND version >= 1").bind(slug).first();
    if (!doc) return fail(404, "There is no document with that slug.");
    docs = [doc];
  } else {
    docs = (await env.DB.prepare("SELECT * FROM docs WHERE version >= 1 ORDER BY created_at ASC").all()).results;
  }
  const withBytes = q.get("files") !== "0";
  const out = [];
  for (const d of docs) out.push(await exportDoc(env, d, { withBytes, only }));
  return json({ format: "redline-export", format_version: 1, exported_at: new Date().toISOString(), docs: out });
}

// ---- import ------------------------------------------------------------------------------------------------------------

const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const text = (v, max) => (typeof v === "string" ? stripControls(v).slice(0, max) : "");
const when = (v, fallback) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(v) && v.length <= 30 ? v : fallback);

function checkDoc(raw, index) {
  const where = `docs[${index}]`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: `${where} must be an object` };
  if (typeof raw.slug !== "string" || !SLUG_RE.test(raw.slug)) return { error: `${where}.slug must be 24 lower-case letters and digits` };
  const title = cleanStr(raw.title, "title", 200, { required: true });
  if (title.error) return { error: `${where}: ${title.error}` };
  if (!isInt(raw.version, 1, 999999)) return { error: `${where}.version must be a whole number from 1` };
  const entry = raw.entry === undefined || raw.entry === null ? "index.html" : cleanPath(raw.entry);
  const pdf = raw.pdf === undefined || raw.pdf === null || raw.pdf === "" ? null : cleanPath(raw.pdf);
  if (!entry || (raw.pdf && !pdf)) return { error: `${where}: entry and pdf must be file paths` };
  const now = new Date().toISOString();
  const doc = {
    slug: raw.slug, title: title.value, summary: text(raw.summary, 1000), project: text(raw.project, 100), tags: text(raw.tags, 400).replace(/\s*,\s*/g, ","),
    version: raw.version, entry, pdf, created_at: when(raw.created_at, now), updated_at: when(raw.updated_at, now),
  };

  const files = [];
  if (raw.files !== undefined) {
    if (!Array.isArray(raw.files) || raw.files.length > MAX_FILES_PER_VERSION) return { error: `${where}.files must be a list of at most ${MAX_FILES_PER_VERSION}` };
    for (const f of raw.files) {
      const path = f && typeof f.path === "string" ? cleanPath(f.path) : null;
      if (!path) return { error: `${where}: a file has no valid path` };
      if (typeof f.data !== "string") return { error: `${where}: ${path} has no data` };
      const bytes = fromBase64(f.data);
      if (!bytes) return { error: `${where}: ${path} is not valid base64` };
      if (bytes.byteLength > MAX_FILE_BYTES) return { error: `${where}: ${path} is larger than 25 MB` };
      files.push({ path, bytes, type: contentTypeFor(path, typeof f.content_type === "string" ? f.content_type : "") });
    }
  }

  const lists = {};
  for (const name of ["comments", "ink", "decisions"]) {
    if (raw[name] === undefined) continue;
    if (!Array.isArray(raw[name]) || raw[name].length > LIMITS[name]) return { error: `${where}.${name} must be a list of at most ${LIMITS[name]}` };
    lists[name] = [];
    for (const r of raw[name]) {
      if (!r || typeof r !== "object" || Array.isArray(r)) return { error: `${where}.${name} holds something that is not an object` };
      const created_at = when(r.created_at, now);
      const author_label = text(r.author_label, 60);
      if (name === "comments") {
        if (typeof r.body !== "string" || !r.body.trim()) return { error: `${where}.comments: a comment has no body` };
        lists.comments.push({
          anchor_kind: ["", "text", "svg", "pin"].includes(r.anchor_kind) ? r.anchor_kind : "", anchor_text: text(r.anchor_text, 1000),
          anchor_context: text(r.anchor_context, 2000), anchor_data: text(r.anchor_data, 2000), body: text(r.body, 4000), author_label, created_at,
          // An export from before comments had three states says resolved: true when the reader was done with it.
          status: STATUSES.includes(r.status) ? r.status : r.resolved ? "done" : "open", fix_note: text(r.fix_note, 500),
          fixed_at: when(r.fixed_at, ""), fixed_version: isInt(r.fixed_version, 0, 999999) ? r.fixed_version : 0, status_at: when(r.status_at, ""),
        });
      } else if (name === "ink") {
        if (typeof r.data !== "string" || r.data.length > 60000) return { error: `${where}.ink: a stroke has no data or is too large` };
        try { JSON.parse(r.data); } catch { return { error: `${where}.ink: stroke data is not JSON` }; }
        lists.ink.push({
          data: r.data, author_label, created_at, resolved: r.resolved ? 1 : 0,
          version: isInt(r.version, 0, 999999) ? r.version : 0, block_hash: text(r.block_hash, 40),
        });
      } else {
        if (typeof r.item !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(r.item) || !["approve", "reject", "unsure"].includes(r.verdict)) {
          return { error: `${where}.decisions: an answer has a bad item or verdict` };
        }
        lists.decisions.push({
          item: r.item, verdict: r.verdict, note: text(r.note, 1000), author_label, created_at,
          version: isInt(r.version, 0, 999999) ? r.version : 0, text_hash: text(r.text_hash, 40),
        });
      }
    }
  }

  // What earlier versions said, so "what changed" and "has this paragraph changed" keep working after a move. Optional.
  let versions;
  if (raw.versions !== undefined) {
    if (!Array.isArray(raw.versions) || raw.versions.length > 3) return { error: `${where}.versions must be a list of at most 3` };
    versions = [];
    for (const v of raw.versions) {
      if (!v || !isInt(v.version, 1, 999999) || typeof v.blocks !== "string" || v.blocks.length > 2_000_000) return { error: `${where}.versions holds a bad entry` };
      versions.push({ version: v.version, blocks: v.blocks, sections: typeof v.sections === "string" ? v.sections.slice(0, 200000) : "", changes: typeof v.changes === "string" ? v.changes.slice(0, 400000) : "" });
    }
  }
  return { doc, files, lists, versions };
}

export async function importApi(request, env) {
  if (request.method !== "POST") return fail(405, "That method is not allowed here.");
  const declared = Number(request.headers.get("Content-Length"));
  if (declared > MAX_IMPORT_BYTES) return fail(413, "That import is too large. Send one document, or one file, at a time.");
  const raw = await request.text();
  if (raw.length > MAX_IMPORT_BYTES) return fail(413, "That import is too large. Send one document, or one file, at a time.");
  let body;
  try { body = JSON.parse(raw); } catch { return fail(400, "The request body is not valid JSON."); }
  if (!body || typeof body !== "object" || !Array.isArray(body.docs)) return fail(400, 'Expected {"docs": [...]} as written by /api/export.');
  if (body.docs.length > MAX_DOCS_PER_IMPORT) return fail(413, `Send at most ${MAX_DOCS_PER_IMPORT} documents at a time.`);

  const checked = [];
  for (let i = 0; i < body.docs.length; i++) {
    const c = checkDoc(body.docs[i], i);
    if (c.error) return fail(400, c.error);
    checked.push(c);
  }

  const done = [];
  for (const { doc: given, files, lists, versions } of checked) {
    // The document is known by its link. Its id on this site is the link too, unless something else already uses that id.
    const existing = await env.DB.prepare("SELECT * FROM docs WHERE link = ?1").bind(given.slug).first();
    let id = existing ? existing.slug : given.slug;
    if (!existing && (await env.DB.prepare("SELECT slug FROM docs WHERE slug = ?1").bind(id).first())) id = randomSlug();
    const doc = { ...given, slug: id, link: given.slug };
    // Bytes first, so a document never goes live pointing at files that are not there.
    let kept = 0, keptBytes = 0;
    if (files.length) {
      const have = await env.DB.prepare("SELECT path, size FROM files WHERE slug = ?1 AND version = ?2").bind(doc.slug, doc.version).all();
      const incoming = new Set(files.map((f) => f.path));
      for (const r of have.results) if (!incoming.has(r.path)) { kept++; keptBytes += r.size; }
      const total = files.reduce((n, f) => n + f.bytes.byteLength, 0);
      if (kept + files.length > MAX_FILES_PER_VERSION || keptBytes + total > MAX_VERSION_BYTES) return fail(413, `${doc.slug}: a document can hold at most ${MAX_FILES_PER_VERSION} files and 60 MB.`);
    }
    for (const f of files) {
      await env.FILES.put(fileKey(doc.slug, doc.version, f.path), f.bytes);
      await env.DB.prepare("INSERT INTO files (slug, version, path, content_type, size) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT (slug, version, path) DO UPDATE SET content_type = excluded.content_type, size = excluded.size")
        .bind(doc.slug, doc.version, f.path, f.type, f.bytes.byteLength).run();
    }

    await env.DB.prepare(
      "INSERT INTO docs (slug, link, title, summary, project, tags, version, staged, entry, pdf, created_at, updated_at) VALUES (?1, ?11, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?8, ?9, ?10) " +
      "ON CONFLICT (slug) DO UPDATE SET title = excluded.title, summary = excluded.summary, project = excluded.project, tags = excluded.tags, version = excluded.version, " +
      "staged = CASE WHEN docs.staged > excluded.version THEN docs.staged ELSE 0 END, entry = excluded.entry, pdf = excluded.pdf, created_at = excluded.created_at, updated_at = excluded.updated_at",
    ).bind(doc.slug, doc.title, doc.summary, doc.project, doc.tags, doc.version, doc.entry, doc.pdf, doc.created_at, doc.updated_at, doc.link).run();
    if (existing && existing.version !== doc.version) {
      await dropFiles(env, doc.slug, deadVersions({ version: doc.version, staged: existing.staged > doc.version ? existing.staged : 0 }), 30);
    }
    if (versions) {
      await env.DB.prepare("DELETE FROM version_blocks WHERE slug = ?1").bind(doc.slug).run();
      for (const v of versions) {
        await env.DB.prepare("INSERT INTO version_blocks (slug, version, blocks, sections, changes, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
          .bind(doc.slug, v.version, v.blocks, v.sections, v.changes, doc.updated_at).run();
      }
    } else if (existing && existing.version !== doc.version) {
      await env.DB.prepare("DELETE FROM version_blocks WHERE slug = ?1").bind(doc.slug).run(); // worked out again from the files when next needed
    }

    const statements = [];
    const slug = doc.slug;
    if (lists.comments) {
      statements.push(env.DB.prepare("DELETE FROM comments WHERE doc_slug = ?1").bind(slug));
      for (const c of lists.comments) {
        statements.push(env.DB.prepare("INSERT INTO comments (doc_slug, anchor_kind, anchor_text, anchor_context, anchor_data, body, author_label, created_at, status, fix_note, fixed_at, fixed_version, status_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)")
          .bind(slug, c.anchor_kind, c.anchor_text, c.anchor_context, c.anchor_data, c.body, c.author_label, c.created_at, c.status, c.fix_note, c.fixed_at, c.fixed_version, c.status_at));
      }
    }
    if (lists.ink) {
      statements.push(env.DB.prepare("DELETE FROM ink WHERE doc_slug = ?1").bind(slug));
      for (const r of lists.ink) {
        statements.push(env.DB.prepare("INSERT INTO ink (doc_slug, data, author_label, created_at, resolved, version, block_hash) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")
          .bind(slug, r.data, r.author_label, r.created_at, r.resolved, r.version, r.block_hash));
      }
    }
    if (lists.decisions) {
      statements.push(env.DB.prepare("DELETE FROM decisions WHERE doc_slug = ?1").bind(slug));
      for (const r of lists.decisions) {
        statements.push(env.DB.prepare("INSERT INTO decisions (doc_slug, item, verdict, note, author_label, created_at, version, text_hash) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)")
          .bind(slug, r.item, r.verdict, r.note, r.author_label, r.created_at, r.version, r.text_hash));
      }
    }
    if (statements.length) await env.DB.batch(statements);
    done.push({
      slug: doc.link, files: files.length, comments: lists.comments ? lists.comments.length : null, ink: lists.ink ? lists.ink.length : null, decisions: lists.decisions ? lists.decisions.length : null,
    });
  }
  return json({ imported: done });
}
