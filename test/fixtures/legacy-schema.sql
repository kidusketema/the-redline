-- The Redline database. Safe to run more than once.

-- One row per document. version is the live version; 0 means nothing has been published yet.
-- staged is the version open for upload (0 when none). It only ever goes up, so a failed attempt's files can never go live.
CREATE TABLE IF NOT EXISTS docs (
  slug       TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  summary    TEXT NOT NULL DEFAULT '',
  project    TEXT NOT NULL DEFAULT '',
  tags       TEXT NOT NULL DEFAULT '',
  version    INTEGER NOT NULL DEFAULT 0,
  staged     INTEGER NOT NULL DEFAULT 0,
  entry      TEXT NOT NULL DEFAULT 'index.html',
  pdf        TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- What each stored file is. The bytes themselves are in Workers KV under the key f/<slug>/<version>/<path>.
CREATE TABLE IF NOT EXISTS files (
  slug         TEXT NOT NULL,
  version      INTEGER NOT NULL,
  path         TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size         INTEGER NOT NULL,
  PRIMARY KEY (slug, version, path)
);

-- anchor_kind: 'text' | 'svg' | 'pin', or '' for a note on the whole document.
-- anchor_context is written as <before>⟦<anchor>⟧<after> so the page can pick the right match.
-- anchor_data is a JSON object for 'svg' and 'pin', '' otherwise.
CREATE TABLE IF NOT EXISTS comments (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_slug       TEXT NOT NULL,
  anchor_kind    TEXT NOT NULL DEFAULT '',
  anchor_text    TEXT NOT NULL DEFAULT '',
  anchor_context TEXT NOT NULL DEFAULT '',
  anchor_data    TEXT NOT NULL DEFAULT '',
  body           TEXT NOT NULL,
  author_label   TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL,
  resolved       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS comments_by_doc ON comments (doc_slug, id);

-- Pen marks, one row per stroke. data is JSON: {a: anchor block, c: colour, w: width, p: [x, y, pressure, ...], tx, vw, m}.
CREATE TABLE IF NOT EXISTS ink (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_slug     TEXT NOT NULL,
  data         TEXT NOT NULL,
  author_label TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL,
  resolved     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ink_by_doc ON ink (doc_slug, id);

-- Approve / Reject / Not sure. item is 'doc' for the whole document or a section id from the page.
-- Answers are never overwritten: the newest row per item is the current one.
CREATE TABLE IF NOT EXISTS decisions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_slug     TEXT NOT NULL,
  item         TEXT NOT NULL,
  verdict      TEXT NOT NULL,
  note         TEXT NOT NULL DEFAULT '',
  author_label TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS decisions_by_doc ON decisions (doc_slug, item, id);
