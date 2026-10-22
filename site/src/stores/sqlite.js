// A D1-style database on a SQLite file, using Node's built-in node:sqlite (Node 22.13 or newer).
//   db.prepare(sql).bind(...args).all() -> { results }   .first() -> row or null   .run() -> { meta: { changes } }
//   db.batch([statements]) runs them in one transaction.   db.exec(sql) runs several statements.
// The site's SQL uses numbered parameters (?1, ?2) and nothing that is specific to one database.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SQLITE_SCHEMA } from "../schema.js";

const plain = (row) => (row ? { ...row } : null);

class Statement {
  constructor(db, sql, args = []) { this.db = db; this.sql = sql; this.args = args; }
  bind(...args) { return new Statement(this.db, this.sql, args); }
  async all() { return { results: this.allSync() }; }
  async first() { return this.firstSync(); }
  async run() { return this.runSync(); }
  allSync() { return this.db.prepare(this.sql).all(...this.args).map(plain); }
  firstSync() { return plain(this.db.prepare(this.sql).get(...this.args)); }
  runSync() {
    const info = this.db.prepare(this.sql).run(...this.args);
    return { meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
  }
}

export function openSqlite(file, { schema = true } = {}) {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const raw = new DatabaseSync(file);
  raw.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;");
  if (schema) raw.exec(SQLITE_SCHEMA);
  return {
    raw,
    prepare: (sql) => new Statement(raw, sql),
    exec: async (sql) => { raw.exec(sql); },
    // Every statement runs without waiting, so no other request can slip in between BEGIN and COMMIT.
    batch: async (statements) => {
      raw.exec("BEGIN");
      try {
        const out = statements.map((s) => s.runSync());
        raw.exec("COMMIT");
        return out;
      } catch (err) {
        raw.exec("ROLLBACK");
        throw err;
      }
    },
    close: () => raw.close(),
  };
}
