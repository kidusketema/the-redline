// A D1-style database and a KV-style file store on Postgres, for Supabase, Neon, Vercel Postgres, Netlify Database, Railway, Render and any other Postgres.
//
// The site's SQL is written once for every database, so the only change made here is ?1 -> $1.
// All of it goes through a small "driver" with three methods, so a test can plug in an in-process Postgres (PGlite):
//   driver.query(text, params) -> Promise<array of row objects>
//   driver.transaction([{ text, params }, ...]) -> Promise   (all or nothing)
//   driver.exec(text) -> Promise   (several statements, no parameters)
import { POSTGRES_SCHEMA } from "../schema.js";

const MAX_BODY_BYTES = 26 * 1024 * 1024;

const dollars = (sql) => {
  const out = sql.replace(/\?(\d+)/g, "$$$1");
  if (/\?/.test(out)) throw new Error("This SQL has a ? without a number: " + sql);
  return out;
};

// Counts and sums can arrive as BigInt; the site only ever holds numbers it can count on.
const plain = (row) => {
  if (!row) return null;
  const out = {};
  for (const [k, v] of Object.entries(row)) out[k] = typeof v === "bigint" ? Number(v) : v;
  return out;
};

class Statement {
  // sql is already in $1 form after the first statement; bind() makes a copy with its arguments.
  constructor(driver, sql, args = []) { this.driver = driver; this.sql = sql; this.args = args; }
  bind(...args) { return new Statement(this.driver, this.sql, args); }
  get request() { return { text: this.sql, params: this.args }; }
  async all() { return { results: (await this.driver.query(this.sql, this.args)).map(plain) }; }
  async first() { return plain((await this.driver.query(this.sql, this.args))[0]); }
  async run() { await this.driver.query(this.sql, this.args); return { meta: {} }; }
}

export function createPgDb(driver) {
  return {
    driver,
    prepare: (sql) => new Statement(driver, dollars(sql)),
    exec: (sql) => driver.exec(sql),
    batch: async (statements) => { await driver.transaction(statements.map((s) => s.request)); },
  };
}

// File bodies live in the file_bodies table under the same keys Cloudflare KV uses.
export function createPgFiles(db) {
  return {
    async get(key, type = "arrayBuffer") {
      const row = await db.prepare("SELECT body FROM file_bodies WHERE name = ?1").bind(key).first();
      if (!row) return null;
      const bytes = new Uint8Array(row.body);
      if (type === "stream") return new Response(bytes).body;
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
    async put(key, value) {
      let bytes;
      if (value && typeof value.getReader === "function") {
        const parts = [];
        let total = 0;
        const reader = value.getReader();
        for (;;) {
          const { done, value: chunk } = await reader.read();
          if (done) break;
          total += chunk.byteLength;
          if (total > MAX_BODY_BYTES) { await reader.cancel(); throw new Error("file too large"); }
          parts.push(chunk);
        }
        bytes = new Uint8Array(total);
        let at = 0;
        for (const p of parts) { bytes.set(p, at); at += p.byteLength; }
      } else {
        bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : value;
      }
      await db.prepare("INSERT INTO file_bodies (name, body) VALUES (?1, ?2) ON CONFLICT (name) DO UPDATE SET body = excluded.body").bind(key, bytes).run();
    },
    async delete(key) {
      await db.prepare("DELETE FROM file_bodies WHERE name = ?1").bind(key).run();
    },
    async list(prefix = "f/") {
      const { results } = await db.prepare("SELECT name FROM file_bodies WHERE name LIKE ?1 ORDER BY name").bind(prefix.replace(/[\\%_]/g, "\\$&") + "%").all();
      return results.map((r) => r.name);
    },
  };
}

const schemaStatements = POSTGRES_SCHEMA.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").split(";").map((s) => s.trim()).filter(Boolean);
const applied = new WeakSet();

// Creates the tables if they are not there. Safe to call on every start: two sites starting at once wait for each other.
export async function ensurePostgresSchema(driver) {
  if (applied.has(driver)) return;
  await driver.transaction([{ text: "SELECT pg_advisory_xact_lock(7272727)", params: [] }, ...schemaStatements.map((text) => ({ text, params: [] }))]);
  applied.add(driver);
}

// The real thing: the postgres.js package (a dependency of site/ only).
export async function connectPostgres(url, { max = 1 } = {}) {
  const { default: postgres } = await import("postgres");
  const sql = postgres(url, {
    max,
    // Poolers such as Supabase's and Neon's work in transaction mode, which cannot keep named prepared statements.
    prepare: false,
    idle_timeout: 20,
    connect_timeout: 20,
    onnotice: () => {},
    // Counts come back as BigInt-sized numbers; ids and sizes here always fit in a JavaScript number.
    types: { int8: { to: 20, from: [20], serialize: (x) => String(x), parse: (x) => Number(x) } },
  });
  return {
    query: (text, params) => sql.unsafe(text, params),
    transaction: (list) => sql.begin((tx) => list.map((q) => (q.params.length ? tx.unsafe(q.text, q.params) : tx.unsafe(q.text)))),
    exec: (text) => sql.unsafe(text),
    close: () => sql.end({ timeout: 5 }),
  };
}

// A driver for an in-process PGlite database (used by the tests).
export function pgliteDriver(pg) {
  return {
    query: async (text, params) => (await pg.query(text, params)).rows,
    transaction: (list) => pg.transaction(async (tx) => { for (const q of list) await tx.query(q.text, q.params); }),
    exec: (text) => pg.exec(text),
    close: () => pg.close(),
  };
}
