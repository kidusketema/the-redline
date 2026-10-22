// A throwaway Postgres for tests: PGlite (Postgres compiled to WebAssembly) behind a real TCP socket, so the site can connect with the
// postgres.js package exactly as it would to Supabase or Neon. A second small HTTP port lets a test run SQL directly (POST /sql).
// Prints one JSON line when ready: {"ready":true,"pgPort":N,"controlPort":N}
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SITE = join(dirname(fileURLToPath(import.meta.url)), "..", "site");
const require = createRequire(join(SITE, "package.json"));
const { PGlite } = await import(pathToFileURL(require.resolve("@electric-sql/pglite")).href);
const { PGLiteSocketServer } = await import(pathToFileURL(require.resolve("@electric-sql/pglite-socket")).href);

const db = await PGlite.create();
const socket = new PGLiteSocketServer({ db, port: Number(process.env.PG_PORT) || 0, host: "127.0.0.1", maxConnections: 20 });
await socket.start();
const pgPort = Number(/:(\d+)/.exec(socket.getServerConn())?.[1]);

const control = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try {
    const r = await db.query(Buffer.concat(chunks).toString("utf8"));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(r.rows, (_, v) => (typeof v === "bigint" ? Number(v) : v)));
  } catch (err) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: String(err && err.message) }));
  }
});
control.listen(0, "127.0.0.1", () => {
  console.log(JSON.stringify({ ready: true, pgPort, controlPort: control.address().port }));
});
