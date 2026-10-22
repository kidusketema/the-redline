// What each published version said, kept as small lists of text blocks (see blocks.js). The files of an old version are deleted when a new one
// goes live, so this is what is left to compare with: it answers "what changed", "did the text under this decision change" and
// "did the paragraph this pen mark was drawn on change".
import { extractBlocks, diffBlocks, packBlocks, unpackBlocks, findAnchorBlock } from "./blocks.js";
import { fileKey } from "./files.js";

const parseJson = (text, fallback) => { try { return text ? JSON.parse(text) : fallback; } catch { return fallback; } };

function fromRow(row) {
  const s = parseJson(row.sections, {});
  return {
    version: row.version, blocks: unpackBlocks(row.blocks), sections: s.s || {}, doc: s.d || "",
    changes: row.changes ? parseJson(row.changes, null) : null,
  };
}

// Reads the stored blocks of one version. For the live version of a page that has none yet (published before this existed),
// they are worked out from the stored entry file, once, and kept. Returns null when there is nothing to read.
export async function loadVersion(env, doc, version = doc.version) {
  if (!doc || version < 1) return null;
  const row = await env.DB.prepare("SELECT * FROM version_blocks WHERE slug = ?1 AND version = ?2").bind(doc.slug, version).first();
  if (row) return fromRow(row);
  if (version !== doc.version) return null;
  const made = await readEntry(env, doc, version);
  if (!made) return null;
  await storeVersion(env, doc, version, made, null);
  return { version, blocks: made.blocks, sections: made.sections, doc: made.doc, changes: null };
}

async function readEntry(env, doc, version) {
  try {
    const buf = await env.FILES.get(fileKey(doc.slug, version, doc.entry), "arrayBuffer");
    if (!buf) return null;
    return extractBlocks(new TextDecoder().decode(buf));
  } catch {
    return null; // reading the words is an extra: the page works without it
  }
}

async function storeVersion(env, doc, version, made, changes) {
  await env.DB.prepare(
    "INSERT INTO version_blocks (slug, version, blocks, sections, changes, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6) " +
    "ON CONFLICT (slug, version) DO UPDATE SET blocks = excluded.blocks, sections = excluded.sections, changes = excluded.changes",
  ).bind(doc.slug, version, packBlocks(made.blocks), JSON.stringify({ d: made.doc, s: made.sections }), changes ? JSON.stringify(changes) : "", new Date().toISOString()).run();
}

// Called while a new version goes live. `old` is the document as it was (its live version is the one being replaced); the new version's files are
// still stored. Records the new version's blocks and what changed from the old one, keeps only the last two versions, and fixes the text each
// older answer was given on. Never fails the publish.
export async function recordCommit(env, old, version, entry) {
  try {
    const before = old.version >= 1 ? await loadVersion(env, old) : null;
    const made = await readEntry(env, { ...old, entry }, version);
    if (!made) return;
    let changes = null;
    if (before) changes = { from: before.version, ...diffBlocks(before.blocks, made.blocks) };
    await storeVersion(env, old, version, made, changes);
    await env.DB.prepare("DELETE FROM version_blocks WHERE slug = ?1 AND version < ?2").bind(old.slug, version - 1).run();
    // Answers from before the words were recorded get the words of the version they were given on (the one that was live until now).
    if (before) {
      const open = await env.DB.prepare("SELECT DISTINCT item FROM decisions WHERE doc_slug = ?1 AND text_hash = ''").bind(old.slug).all();
      for (const { item } of open.results) {
        const h = hashFor(before, item);
        if (h) await env.DB.prepare("UPDATE decisions SET text_hash = ?1 WHERE doc_slug = ?2 AND item = ?3 AND text_hash = ''").bind(h, old.slug, item).run();
      }
    }
  } catch (err) {
    console.error("versions", err && err.message);
  }
}

// The hash of the words under one decision item: a section by its id, "doc" for the whole page. "" when the page has no such section.
export function hashFor(v, item) {
  if (!v) return "";
  if (Object.prototype.hasOwnProperty.call(v.sections, item)) return v.sections[item];
  return item === "doc" ? v.doc : "";
}

// True when a decision was made on words that are not the words on the page now. A decision with no recorded words is never called stale.
export function isStale(decision, live) {
  if (!live || !decision.text_hash) return false;
  const now = hashFor(live, decision.item);
  return !!now && now !== decision.text_hash;
}

// True when the paragraph a pen mark was drawn on is not on the page any more as it was.
export function inkIsStale(mark, live) {
  return !!live && !!mark.block_hash && !live.blocks.some((b) => b.h === mark.block_hash);
}

// The hash of the block a stroke's anchor points at, to store with the stroke.
export function anchorHash(live, anchorText) {
  const b = live && findAnchorBlock(live.blocks, anchorText);
  return b ? b.h : "";
}
