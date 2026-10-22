// Brings a database made by an older Redline up to date, the first time the site answers a request. Safe to run on every start: each step first
// checks whether it is needed. A new database already has these columns (schema.sql), so on one this is a few quick reads and nothing else.
// It works the same on D1, SQLite and Postgres because the statements are plain SQL.
const STEPS = [
  { table: "docs", columns: [["link", "TEXT NOT NULL DEFAULT ''"]], after: ["UPDATE docs SET link = slug WHERE link = ''"] },
  {
    table: "comments",
    columns: [["status", "TEXT NOT NULL DEFAULT 'open'"], ["fix_note", "TEXT NOT NULL DEFAULT ''"], ["fixed_at", "TEXT NOT NULL DEFAULT ''"], ["fixed_version", "INTEGER NOT NULL DEFAULT 0"], ["status_at", "TEXT NOT NULL DEFAULT ''"]],
    // The old yes/no "resolved" meant the reader was done with it.
    after: { status: ["UPDATE comments SET status = 'done' WHERE resolved = 1", "ALTER TABLE comments DROP COLUMN resolved"] },
  },
  {
    table: "ink",
    columns: [["version", "INTEGER NOT NULL DEFAULT 0"], ["block_hash", "TEXT NOT NULL DEFAULT ''"]],
    after: { version: ["UPDATE ink SET version = COALESCE((SELECT version FROM docs WHERE docs.slug = ink.doc_slug), 0)"] },
  },
  {
    table: "decisions",
    columns: [["version", "INTEGER NOT NULL DEFAULT 0"], ["text_hash", "TEXT NOT NULL DEFAULT ''"]],
    after: { version: ["UPDATE decisions SET version = COALESCE((SELECT version FROM docs WHERE docs.slug = decisions.doc_slug), 0)"] },
  },
];

const VERSION_BLOCKS =
  "CREATE TABLE IF NOT EXISTS version_blocks (slug TEXT NOT NULL, version INTEGER NOT NULL, blocks TEXT NOT NULL, sections TEXT NOT NULL DEFAULT '', " +
  "changes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, PRIMARY KEY (slug, version))";

const pending = new WeakMap();

async function works(db, sql) {
  try { await db.prepare(sql).first(); return true; } catch { return false; }
}
async function attempt(db, sql) {
  try { await db.prepare(sql).run(); return true; } catch { return false; }
}

async function migrate(db) {
  if (!(await works(db, "SELECT slug FROM version_blocks LIMIT 1"))) await db.prepare(VERSION_BLOCKS).run();
  for (const step of STEPS) {
    const all = step.columns.map((c) => c[0]).join(", ");
    if (await works(db, `SELECT ${all} FROM ${step.table} LIMIT 1`)) continue;
    for (const [name, type] of step.columns) {
      if (await works(db, `SELECT ${name} FROM ${step.table} LIMIT 1`)) continue;
      // Another copy of the site may add the column at the same moment; whichever loses sees "already there" and moves on.
      await attempt(db, `ALTER TABLE ${step.table} ADD COLUMN ${name} ${type}`);
      const after = Array.isArray(step.after) ? (name === step.columns[0][0] ? step.after : []) : step.after[name] || [];
      for (const sql of after) await attempt(db, sql);
    }
  }
}

// Runs the steps once per database connection. Several requests arriving together wait for the same run.
export function ensureSchema(env) {
  const db = env.DB;
  if (!pending.has(db)) {
    pending.set(db, migrate(db).catch((err) => { pending.delete(db); throw err; }));
  }
  return pending.get(db);
}
