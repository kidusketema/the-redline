-- The Redline database for Postgres. Safe to run more than once. The site runs it for you at startup.
-- Same tables as schema.sql; only the id columns and the file bodies differ.

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

CREATE TABLE IF NOT EXISTS files (
  slug         TEXT NOT NULL,
  version      INTEGER NOT NULL,
  path         TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size         INTEGER NOT NULL,
  PRIMARY KEY (slug, version, path)
);

-- The bytes of each file, under the key f/<slug>/<version>/<path>.
CREATE TABLE IF NOT EXISTS file_bodies (
  name TEXT PRIMARY KEY,
  body BYTEA NOT NULL
);

CREATE TABLE IF NOT EXISTS comments (
  id             BIGSERIAL PRIMARY KEY,
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

CREATE TABLE IF NOT EXISTS ink (
  id           BIGSERIAL PRIMARY KEY,
  doc_slug     TEXT NOT NULL,
  data         TEXT NOT NULL,
  author_label TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL,
  resolved     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ink_by_doc ON ink (doc_slug, id);

CREATE TABLE IF NOT EXISTS decisions (
  id           BIGSERIAL PRIMARY KEY,
  doc_slug     TEXT NOT NULL,
  item         TEXT NOT NULL,
  verdict      TEXT NOT NULL,
  note         TEXT NOT NULL DEFAULT '',
  author_label TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS decisions_by_doc ON decisions (doc_slug, item, id);
