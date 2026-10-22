// The Redline as a Node server: on your own computer, in Docker, or on Railway, Render, Fly, Replit and any server.
//   node site/node/server.mjs
// Data goes in a SQLite file plus a folder of files under REDLINE_DATA_DIR (default ~/.redline/data), or in Postgres when DATABASE_URL is set.
// When it is listening it prints one line of JSON: {"ready":true,"url":"http://127.0.0.1:4848","port":4848}
//
//   REDLINE_PUBLISH_KEY, REDLINE_DASHBOARD_TOKEN   the secrets (made and saved in the data folder when missing)
//   REDLINE_DATA_DIR      where the data lives (SQLite mode)
//   DATABASE_URL          a Postgres address (Supabase, Neon, Railway, Render ...)
//   HOST (127.0.0.1)      PORT (4848)
//   REDLINE_PUBLIC_URL    the address people use when a tunnel or proxy is in front
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Readable } from "node:stream";
import app from "../src/app.js";
import { databaseUrl, postgresEnv, settingsFrom } from "../src/runtime.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, "..", "public");

const TYPES = { ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".map": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2" };
const BASE_HEADERS = { "X-Robots-Tag": "noindex, nofollow", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };

// A short id for the layer files, so a browser never keeps an old copy after an update (they are cached for a year).
function buildId(dir) {
  const hash = createHash("sha256");
  const root = join(dir, "_redline");
  if (existsSync(root)) for (const name of readdirSync(root).sort()) hash.update(name).update(readFileSync(join(root, name)));
  return hash.digest("hex").slice(0, 10);
}

// Keys: use what was given, else what an earlier run saved in the data folder, else make new ones and save them.
function secrets(dataDir, settings) {
  const file = join(dataDir, "keys.json");
  let saved = {};
  try { saved = JSON.parse(readFileSync(file, "utf8")); } catch { /* none yet */ }
  const out = { ...settings };
  let changed = false;
  if (!out.PUBLISH_KEY) { out.PUBLISH_KEY = saved.publish_key || randomBytes(24).toString("hex"); changed = changed || !saved.publish_key; }
  if (!out.DASHBOARD_TOKEN) { out.DASHBOARD_TOKEN = saved.dashboard_token || randomBytes(12).toString("hex"); changed = changed || !saved.dashboard_token; }
  if (changed) {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(file, JSON.stringify({ publish_key: out.PUBLISH_KEY, dashboard_token: out.DASHBOARD_TOKEN }, null, 2) + "\n", { mode: 0o600 });
    console.error(`The publish key or dashboard token was not set, so a new one was made and saved in ${file}.`);
  }
  return out;
}

// Opens the data: SQLite plus a folder, or Postgres.
async function openData({ dataDir, databaseUrl: pg, settings, pool }) {
  if (pg) {
    const env = await postgresEnv(pg, settings, { max: pool });
    return { env, storage: "postgres", close: env.close };
  }
  // Loaded only here: Vercel, Netlify and Workers never load node:sqlite.
  const { openSqlite } = await import("../src/stores/sqlite.js");
  const { createDiskFiles } = await import("../src/stores/disk.js");
  const DB = openSqlite(join(dataDir, "redline.db"));
  const FILES = createDiskFiles(join(dataDir, "files"));
  return { env: { ...settings, DB, FILES }, storage: "sqlite", close: async () => DB.close() };
}

function staticFile(url, method, publicDir) {
  if (!url.pathname.startsWith("/_redline/") || (method !== "GET" && method !== "HEAD")) return null;
  let rel;
  try { rel = decodeURIComponent(url.pathname.slice(1)); } catch { return null; }
  const file = normalize(join(publicDir, rel));
  if (!file.startsWith(join(publicDir, "_redline") + sep) || !existsSync(file) || !statSync(file).isFile()) return null;
  const body = readFileSync(file);
  return new Response(method === "HEAD" ? null : body, {
    headers: {
      ...BASE_HEADERS,
      "Content-Type": TYPES[extname(file)] || "application/octet-stream",
      "Content-Length": String(body.length),
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}

const first = (v) => (Array.isArray(v) ? v[0] : v || "").split(",")[0].trim();

function toRequest(req, fallbackHost) {
  const proto = first(req.headers["x-forwarded-proto"]) === "https" ? "https" : "http";
  const host = first(req.headers["x-forwarded-host"]) || req.headers.host || fallbackHost;
  const url = new URL(`${proto}://${host}${req.url}`); // joined as text so a path that starts with // stays a path
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const request = new Request(url, { method: req.method, headers, body: hasBody ? Readable.toWeb(req) : undefined, duplex: "half" });
  return { request, url };
}

async function send(res, response) {
  const headers = {};
  response.headers.forEach((v, k) => { headers[k] = v; });
  res.writeHead(response.status, response.statusText || undefined, headers);
  if (!response.body) return res.end();
  const stream = Readable.fromWeb(response.body);
  stream.on("error", () => res.destroy());
  stream.pipe(res);
}

export async function startServer(opts = {}) {
  const vars = process.env;
  const dataDir = opts.dataDir || vars.REDLINE_DATA_DIR || join(homedir(), ".redline", "data");
  const host = opts.host ?? vars.HOST ?? "127.0.0.1";
  const port = opts.port ?? (vars.PORT !== undefined && vars.PORT !== "" ? Number(vars.PORT) : 4848);
  const publicDir = opts.publicDir || PUBLIC_DIR;
  const pg = opts.databaseUrl !== undefined ? opts.databaseUrl : databaseUrl(vars);

  let settings = settingsFrom(vars, buildId(publicDir));
  for (const [key, name] of [["publishKey", "PUBLISH_KEY"], ["dashboardToken", "DASHBOARD_TOKEN"], ["publicUrl", "PUBLIC_URL"], ["build", "BUILD"]]) if (opts[key]) settings[name] = opts[key];
  settings = secrets(dataDir, settings);

  const data = await openData({ dataDir, databaseUrl: pg, settings, pool: opts.pool || Number(vars.REDLINE_PG_POOL) || 5 });

  const server = createServer(async (req, res) => {
    let parsed;
    try { parsed = toRequest(req, `${host}:${port}`); } catch {
      res.writeHead(400, { "Content-Type": "text/plain" });
      return res.end("Bad request");
    }
    try {
      const asset = staticFile(parsed.url, req.method, publicDir);
      await send(res, asset || (await app.fetch(parsed.request, data.env)));
    } catch (err) {
      console.error("error", err && err.message);
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Something went wrong on the server.");
    }
  });
  server.requestTimeout = 0; // a large upload on a slow link is not an attack
  server.keepAliveTimeout = 30_000;

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const actual = server.address().port;
  const shown = host === "0.0.0.0" || host === "::" || host === "" ? "127.0.0.1" : host;
  const url = `http://${shown.includes(":") ? `[${shown}]` : shown}:${actual}`;

  return {
    server, url, port: actual, host, storage: data.storage, dataDir, env: data.env,
    close: async () => {
      await new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); });
      await data.close();
    },
  };
}

// Run directly: start, print the ready line, stop on Ctrl-C or SIGTERM.
const realHref = (p) => { try { return pathToFileURL(realpathSync(p)).href; } catch { return pathToFileURL(p).href; } };
if (process.argv[1] && realHref(fileURLToPath(import.meta.url)) === realHref(process.argv[1])) {
  startServer().then((s) => {
    console.log(JSON.stringify({ ready: true, url: s.url, port: s.port, host: s.host, storage: s.storage }));
    const stop = () => { s.close().finally(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  }).catch((err) => {
    console.error(err && err.code === "EADDRINUSE" ? `That port is already in use (${err.message}).` : `The server could not start: ${err && err.message}`);
    process.exit(1);
  });
}
