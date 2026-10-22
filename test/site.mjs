// End-to-end test of the site, run against a local server (no account on any host is involved).
// Run `npm install` in site/ once, then one of:
//   node test/site.mjs                      the Cloudflare Worker under wrangler dev (D1 + KV)
//   node test/site.mjs --target sqlite      the Node server on a SQLite file and a folder
//   node test/site.mjs --target postgres    the Node server on Postgres (an in-process Postgres behind a real socket, reached with postgres.js)
// REDLINE_TEST_TARGET works too. Temporary files go in test/.tmp/laneA/<target>/.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = join(ROOT, "site");
const argTarget = process.argv.includes("--target") ? process.argv[process.argv.indexOf("--target") + 1] : "";
const TARGET = argTarget || process.env.REDLINE_TEST_TARGET || "wrangler";
if (!["wrangler", "sqlite", "postgres"].includes(TARGET)) { console.error(`Unknown target "${TARGET}". Use wrangler, sqlite or postgres.`); process.exit(2); }
const TMP = join(ROOT, "test", ".tmp", "laneA", TARGET);
const RUN = join(TMP, "run");
const STATE = join(TMP, "state");
const WRANGLER = join(SITE, "node_modules", "wrangler", "bin", "wrangler.js");
const DB_NAME = "redline-test";

if (TARGET === "wrangler" && !existsSync(WRANGLER)) { console.error("Run `npm install` in site/ first."); process.exit(2); }

const PUBLISH_KEY = randomBytes(24).toString("hex");
const DASHBOARD_TOKEN = randomBytes(12).toString("hex");

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on("error", reject);
  });
}

// A throwaway copy of site/ so nothing is written into the real folder.
function prepare() {
  for (const p of [RUN, STATE]) rmSync(p, { recursive: true, force: true });
  mkdirSync(join(RUN, "public"), { recursive: true });
  cpSync(join(SITE, "src"), join(RUN, "src"), { recursive: true });
  cpSync(join(SITE, "public"), join(RUN, "public"), { recursive: true });
  cpSync(join(SITE, "schema.sql"), join(RUN, "schema.sql"));
  symlinkSync(join(SITE, "node_modules"), join(RUN, "node_modules"));
  const template = readFileSync(join(SITE, "wrangler.template.jsonc"), "utf8");
  writeFileSync(join(RUN, "wrangler.jsonc"), template.replaceAll("__NAME__", DB_NAME).replaceAll("__DATABASE_ID__", "00000000-0000-0000-0000-000000000000").replaceAll("__KV_ID__", "redline-test-files"));
  writeFileSync(join(RUN, ".dev.vars"), `PUBLISH_KEY=${PUBLISH_KEY}\nDASHBOARD_TOKEN=${DASHBOARD_TOKEN}\nBUILD=testbuild\n`);
}

const wranglerEnv = { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1", NO_COLOR: "1" };

let pgControl = 0;
let pgProc;
function d1(sql) {
  if (TARGET === "sqlite") {
    const db = new DatabaseSync(join(STATE, "redline.db"));
    try {
      db.exec("PRAGMA busy_timeout = 5000");
      const st = db.prepare(sql);
      return /^\s*select/i.test(sql) ? st.all().map((r) => ({ ...r })) : (st.run(), []);
    } finally { db.close(); }
  }
  if (TARGET === "postgres") {
    const r = spawnSync("curl", ["-s", "-f", "-X", "POST", "--data-binary", sql, `http://127.0.0.1:${pgControl}/sql`], { encoding: "utf8" });
    assert.equal(r.status, 0, `postgres query failed: ${r.stderr || r.stdout}`);
    return JSON.parse(r.stdout);
  }
  const r = spawnSync("node", [WRANGLER, "d1", "execute", DB_NAME, "--local", "--persist-to", STATE, "--json", "--command", sql], { cwd: RUN, env: wranglerEnv, encoding: "utf8" });
  assert.equal(r.status, 0, `d1 query failed: ${r.stderr || r.stdout}`);
  return JSON.parse(r.stdout)[0].results;
}

// The keys in the local KV store that start with a prefix.
function kvKeys(prefix) {
  if (TARGET === "sqlite") return diskFiles.listSync(prefix).sort();
  if (TARGET === "postgres") return d1(`SELECT name FROM file_bodies WHERE name LIKE '${prefix.replace(/[%_]/g, "\\$&")}%' ORDER BY name`).map((r) => r.name);
  const r = spawnSync("node", [WRANGLER, "kv", "key", "list", "--binding", "FILES", "--local", "--persist-to", STATE, "--prefix", prefix], { cwd: RUN, env: wranglerEnv, encoding: "utf8" });
  assert.equal(r.status, 0, `kv list failed: ${r.stderr || r.stdout}`);
  return JSON.parse(r.stdout.slice(r.stdout.indexOf("["))).map((k) => k.name);
}

let server;
let base;
let diskFiles;
const logs = [];

// The Node server, started the way a person or a host would start it, with settings in environment variables.
async function startNode(extra) {
  rmSync(STATE, { recursive: true, force: true });
  mkdirSync(STATE, { recursive: true });
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env, PORT: String(port), HOST: "127.0.0.1", REDLINE_DATA_DIR: STATE, REDLINE_PUBLISH_KEY: PUBLISH_KEY, REDLINE_DASHBOARD_TOKEN: DASHBOARD_TOKEN,
    REDLINE_BUILD: "testbuild",
  };
  delete env.DATABASE_URL;
  Object.assign(env, extra);
  server = spawn("node", [join(SITE, "node", "server.mjs")], { cwd: ROOT, env, detached: true });
  server.stdout.on("data", (d) => logs.push(String(d)));
  server.stderr.on("data", (d) => logs.push(String(d)));
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(base + "/robots.txt", { signal: AbortSignal.timeout(3000) })).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("The Node server did not start.");
}

async function start() {
  if (TARGET === "sqlite") {
    const { createDiskFiles } = await import(pathToFileURL(join(SITE, "src", "stores", "disk.js")).href);
    diskFiles = createDiskFiles(join(STATE, "files"));
    return startNode({});
  }
  if (TARGET === "postgres") {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
    pgProc = spawn("node", [join(ROOT, "test", "pg-server.mjs")], { cwd: ROOT, detached: true });
    pgProc.stderr.on("data", (d) => logs.push(String(d)));
    const line = await new Promise((resolve, reject) => {
      let buf = "";
      pgProc.stdout.on("data", (d) => { buf += String(d); const m = /\{.*\}/.exec(buf); if (m) resolve(JSON.parse(m[0])); });
      pgProc.on("exit", () => reject(new Error("The test Postgres stopped: " + logs.join(""))));
      setTimeout(() => reject(new Error("The test Postgres did not start.")), 60000).unref();
    });
    pgControl = line.controlPort;
    // One connection: the in-process Postgres is a single session, so this keeps transactions apart.
    return startNode({ DATABASE_URL: `postgres://postgres:postgres@127.0.0.1:${line.pgPort}/postgres`, REDLINE_PG_POOL: "1" });
  }
  prepare();
  const schema = spawnSync("node", [WRANGLER, "d1", "execute", DB_NAME, "--local", "--persist-to", STATE, "--file", "schema.sql"], { cwd: RUN, env: wranglerEnv, encoding: "utf8" });
  assert.equal(schema.status, 0, `schema failed: ${schema.stderr || schema.stdout}`);
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn("node", [WRANGLER, "dev", "--local", "--ip", "127.0.0.1", "--port", String(port), "--persist-to", STATE], { cwd: RUN, env: wranglerEnv, detached: true });
  server.stdout.on("data", (d) => logs.push(String(d)));
  server.stderr.on("data", (d) => logs.push(String(d)));
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(base + "/robots.txt", { signal: AbortSignal.timeout(3000) })).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("The dev server did not start.");
}

function stop() {
  // wrangler starts child processes of its own, so the whole group is stopped.
  for (const p of [server, pgProc]) if (p && p.pid) { try { process.kill(-p.pid, "SIGKILL"); } catch { /* already gone */ } }
}
process.on("exit", stop);
setTimeout(() => { console.log("FAIL  the test took longer than 4 minutes"); stop(); process.exit(1); }, 240_000).unref();
process.on("SIGINT", () => { stop(); process.exit(130); });

// ---- helpers ------------------------------------------------------------------------------------------------------

const owner = { Authorization: `Bearer ${PUBLISH_KEY}` };
const api = async (path, { method = "GET", body, headers = {}, auth = true } = {}) => {
  const go = () => fetch(base + path, {
    method,
    headers: { ...(auth ? owner : {}), ...(body !== undefined && typeof body === "object" && !(body instanceof Uint8Array) ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body !== undefined && typeof body === "object" && !(body instanceof Uint8Array) ? JSON.stringify(body) : body,
    redirect: "manual",
  });
  // wrangler dev sometimes closes an idle connection just as the next request uses it; a read is safe to send again.
  try { return await go(); } catch (err) { if (method === "GET") return go(); throw err; }
};
const page = (path, { method = "POST", body, headers = {} } = {}) =>
  fetch(base + path, { method, headers: { "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });

const put = (slug, v, path, bytes, type) =>
  api(`/api/docs/${slug}/v/${v}/files/${path}`, { method: "PUT", body: bytes, headers: type ? { "Content-Type": type } : {} });

const results = [];
async function check(name, fn) {
  try { await fn(); results.push(true); console.log(`PASS  ${name}`); }
  catch (err) {
    results.push(false);
    console.log(`FAIL  ${name}\n      ${String(err && err.message).split("\n").join("\n      ")}${err && err.cause ? `\n      cause: ${err.cause.message || err.cause}` : ""}`);
  }
}

const TITLE = "Plan </script><b>bold & \"quoted\"";
const INDEX_V1 = "<!doctype html><html><head><title>v1</title></head><body><h1>Hello v1</h1><p>First paragraph.</p></body></html>";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const BIG = randomBytes(4_500_000);
let slug;
let version;

// ---- the checks ---------------------------------------------------------------------------------------------------

async function run() {
  await check("1. owner endpoints answer 401 without a key and with a wrong key", async () => {
    const wrong = { Authorization: "Bearer not-the-key-not-the-key-1234" };
    const cases = [
      ["/api/docs", "GET"], ["/api/docs", "POST"], ["/api/docs/aaaaaaaaaaaaaaaaaaaaaaaa", "DELETE"],
      ["/api/docs/aaaaaaaaaaaaaaaaaaaaaaaa/v/1/files/index.html", "PUT"], ["/api/docs/aaaaaaaaaaaaaaaaaaaaaaaa/v/1/commit", "POST"],
    ];
    for (const [path, method] of cases) {
      for (const headers of [{}, wrong]) {
        const r = await api(path, { method, auth: false, headers, body: method === "POST" ? { title: "x" } : undefined });
        assert.equal(r.status, 401, `${method} ${path} gave ${r.status}`);
        assert.ok((await r.json()).error);
      }
    }
  });

  await check("2. publish: create, upload files (one of 4.5 MB), commit, read back byte-exact", async () => {
    let r = await api("/api/docs", { method: "POST", body: { title: TITLE, summary: "A test", project: "Demo", tags: ["a", "b"] } });
    assert.equal(r.status, 201);
    const made = await r.json();
    assert.match(made.slug, /^[a-z0-9]{24}$/);
    assert.equal(made.version, 1);
    assert.equal(made.url, `${base}/${made.slug}/`);
    slug = made.slug; version = made.version;

    // Nothing is visible before the commit.
    assert.equal((await fetch(`${base}/${slug}/`)).status, 404);

    r = await put(slug, 1, "index.html", Buffer.from(INDEX_V1), "text/plain"); // a wrong type for .html must be ignored
    assert.deepEqual(await r.json(), { path: "index.html", bytes: INDEX_V1.length });
    r = await put(slug, 1, "img/pic.png", PNG, "image/png");
    assert.equal(r.status, 200);
    r = await put(slug, 1, "data/big.bin", BIG, "application/octet-stream");
    assert.deepEqual(await r.json(), { path: "data/big.bin", bytes: BIG.length });
    r = await put(slug, 1, "empty.txt", Buffer.alloc(0), "text/plain");
    assert.deepEqual(await r.json(), { path: "empty.txt", bytes: 0 });
    r = await put(slug, 1, "notes.txt", Buffer.from("plain notes")); // no Content-Type: the extension decides
    assert.equal(r.status, 200);

    // Bad paths are refused.
    assert.equal((await put(slug, 1, "a//b.txt", Buffer.from("x"))).status, 400);
    r = await api(`/api/docs/${slug}/v/1/files/a%2F..%2Fb.txt`, { method: "PUT", body: Buffer.from("x") });
    assert.equal(r.status, 400);

    r = await api(`/api/docs/${slug}/v/1/commit`, { method: "POST", body: {} });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).url, `${base}/${slug}/`);

    const get = async (p) => { const res = await fetch(`${base}/${slug}/${p}`); return { res, bytes: Buffer.from(await res.arrayBuffer()) }; };
    let g = await get("img/pic.png");
    assert.equal(g.res.status, 200); assert.equal(g.res.headers.get("content-type"), "image/png"); assert.ok(g.bytes.equals(PNG));
    g = await get("data/big.bin");
    assert.equal(g.res.status, 200); assert.equal(g.res.headers.get("content-type"), "application/octet-stream");
    assert.equal(g.bytes.length, BIG.length); assert.ok(g.bytes.equals(BIG), "the 4.5 MB file differs");
    g = await get("notes.txt");
    assert.equal(g.res.headers.get("content-type"), "text/plain; charset=utf-8"); assert.equal(g.bytes.toString(), "plain notes");
    g = await get("");
    assert.equal(g.res.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(g.res.headers.get("cache-control"), "no-cache");
    g = await get("empty.txt");
    assert.equal(g.res.status, 200); assert.equal(g.bytes.length, 0);
    g = await get("nope.html");
    assert.equal(g.res.status, 404);
  });

  await check("3. page has the escaped __REDLINE data, the layer tags and the security headers", async () => {
    const res = await fetch(`${base}/${slug}/`);
    const text = await res.text();
    assert.equal(res.status, 200);
    const m = /<script>window\.__REDLINE=(.*?)<\/script>/s.exec(text);
    assert.ok(m, "no __REDLINE script");
    assert.ok(!m[1].includes("</script"), "the title closed the script");
    const data = JSON.parse(m[1]);
    assert.deepEqual(data, { slug, title: TITLE, pdf: null, version: 1 });
    assert.ok(text.includes('<link rel="stylesheet" href="/_redline/redline.css?v=testbuild">'));
    assert.ok(text.includes('<script src="/_redline/redline.js?v=testbuild" defer></script>'));
    assert.ok(text.indexOf("__REDLINE") > text.indexOf("Hello v1") && text.indexOf("redline.js") < text.indexOf("</body>"), "layers belong at the end of body");
    assert.ok(text.includes("<h1>Hello v1</h1>"));
    assert.equal(res.headers.get("x-robots-tag"), "noindex, nofollow");
    assert.equal(res.headers.get("referrer-policy"), "no-referrer");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("cache-control"), "no-cache");
    const direct = await (await fetch(`${base}/${slug}/index.html`)).text();
    assert.ok(direct.includes("__REDLINE"), "index.html by name is the entry page too");

    const redirect = await fetch(`${base}/${slug}`, { redirect: "manual" });
    assert.ok([301, 302, 307, 308].includes(redirect.status));
    assert.equal(redirect.headers.get("location"), `/${slug}/`);
    const robots = await fetch(`${base}/robots.txt`);
    assert.equal(await robots.text(), "User-agent: *\nDisallow: /\n");
    assert.equal(robots.headers.get("x-robots-tag"), "noindex, nofollow");

    const home = await fetch(`${base}/`);
    const homeText = await home.text();
    assert.equal(home.status, 200);
    assert.ok(homeText.includes("A private review site running The Redline."));
    assert.ok(homeText.includes("https://github.com/kidusketema/the-redline"));
    assert.ok(!homeText.includes(slug));
    assert.equal(home.headers.get("referrer-policy"), "no-referrer");
  });

  let commentId, inkId;
  await check("4. comments, pen marks and decisions: create, list, resolve and reopen, delete, same-origin, bad input", async () => {
    const sameOrigin = { Origin: base };
    // comments
    let r = await page(`/api/${slug}/comments`, { body: { anchor_kind: "text", anchor_text: "First paragraph.", anchor_context: "x ⟦First paragraph.⟧ y", body: "Say more here.", author_label: "Sam" }, headers: sameOrigin });
    assert.equal(r.status, 201);
    const c = (await r.json()).comment;
    commentId = c.id;
    assert.equal(c.anchor_kind, "text"); assert.equal(c.status, "open"); assert.equal(c.resolved, false); assert.equal(c.author_label, "Sam");
    r = await page(`/api/${slug}/comments`, { body: { body: "A note on the whole page." } });
    assert.equal((await r.json()).comment.anchor_kind, "");
    r = await page(`/api/${slug}/comments`, { body: { anchor_kind: "pin", anchor_data: { t: "img-1", x: 12.34, y: 56, near: "the logo" }, body: "Pin." } });
    const pin = (await r.json()).comment;
    assert.deepEqual(pin.anchor_data, { t: "img-1", x: 12.3, y: 56, near: "the logo", label: "", alt: "" });
    r = await page(`/api/${slug}/comments`, { method: "GET" });
    assert.equal((await r.json()).comments.length, 3);
    // The old call still works: with no body it means "marked fixed", and {"resolved": false} sends it back.
    r = await page(`/api/${slug}/comments/${commentId}/resolve`, { body: {} });
    assert.equal((await r.json()).comment.status, "fixed");
    r = await page(`/api/${slug}/comments/${commentId}/status`, { body: { status: "done" } });
    assert.equal((await r.json()).comment.resolved, true);
    r = await page(`/api/${slug}/comments/${commentId}/resolve`, { body: { resolved: false } });
    const reopened = (await r.json()).comment;
    assert.equal(reopened.status, "open"); assert.equal(reopened.resolved, false); assert.equal(reopened.reopened, true);
    r = await page(`/api/${slug}/comments/999999/resolve`, { body: {} });
    assert.equal(r.status, 404);

    // pen marks
    const stroke = { a: { k: "p", t: "First paragraph.", i: 1 }, c: "blue", w: 30, p: [100, 200, 50, 300, 400, 60], tx: "First paragraph.", vw: 1024, m: { ty: "pen", hz: 240 } };
    r = await page(`/api/${slug}/ink`, { body: { data: stroke, author_label: "Sam" }, headers: sameOrigin });
    assert.equal(r.status, 201);
    const ink = (await r.json()).ink;
    inkId = ink.id;
    assert.equal(ink.data.c, "blue"); assert.equal(ink.data.m.ty, "pen"); assert.deepEqual(ink.data.p, stroke.p);
    r = await page(`/api/${slug}/ink`, { method: "GET" });
    assert.equal((await r.json()).ink.length, 1);

    // decisions
    r = await page(`/api/${slug}/decisions`, { body: { item: "doc", verdict: "unsure", note: "Maybe" }, headers: sameOrigin });
    assert.equal(r.status, 201);
    r = await page(`/api/${slug}/decisions`, { body: { item: "doc", verdict: "approve", note: "Yes", author_label: "Sam" } });
    assert.equal((await r.json()).decision.verdict, "approve");
    r = await page(`/api/${slug}/decisions`, { body: { item: "sec-1", verdict: "reject" } });
    assert.equal(r.status, 201);
    r = await page(`/api/${slug}/decisions`, { method: "GET" });
    const latest = (await r.json()).decisions;
    assert.deepEqual(latest.map((d) => [d.item, d.verdict]), [["doc", "approve"], ["sec-1", "reject"]]);
    r = await page(`/api/${slug}/decisions?all=1`, { method: "GET" });
    assert.equal((await r.json()).decisions.length, 3);

    // cross-origin writes are refused, and nothing is stored
    for (const [path, body] of [[`/api/${slug}/comments`, { body: "evil" }], [`/api/${slug}/ink`, { data: stroke }], [`/api/${slug}/decisions`, { item: "doc", verdict: "reject" }],
      [`/api/${slug}/comments/${commentId}/resolve`, {}]]) {
      r = await page(path, { body, headers: { Origin: "https://evil.example" } });
      assert.equal(r.status, 403, path);
    }
    r = await page(`/api/${slug}/ink/${inkId}`, { method: "DELETE", headers: { Origin: "https://evil.example" } });
    assert.equal(r.status, 403);
    assert.equal((await (await page(`/api/${slug}/comments`, { method: "GET" })).json()).comments.length, 3);

    // bad input: 400 with a reason
    const bad = [
      [`/api/${slug}/comments`, { body: "" }], [`/api/${slug}/comments`, { body: "x", anchor_kind: "bogus" }],
      [`/api/${slug}/comments`, { body: "x", anchor_kind: "text" }], [`/api/${slug}/comments`, { body: "x", anchor_kind: "pin", anchor_data: { t: "nope", x: 1, y: 1 } }],
      [`/api/${slug}/comments`, { body: "x".repeat(4001) }],
      [`/api/${slug}/ink`, { data: { a: { k: "p" }, p: [1, 2] } }], [`/api/${slug}/ink`, { data: "no" }],
      [`/api/${slug}/decisions`, { item: "doc", verdict: "maybe" }], [`/api/${slug}/decisions`, { item: "bad item!", verdict: "approve" }],
      [`/api/${slug}/decisions`, { item: "doc", verdict: "approve", note: "n".repeat(1001) }],
    ];
    for (const [path, body] of bad) {
      r = await page(path, { body });
      assert.equal(r.status, 400, `${path} ${JSON.stringify(body).slice(0, 60)} gave ${r.status}`);
      assert.ok(typeof (await r.json()).error === "string");
    }
    r = await fetch(`${base}/api/${slug}/comments`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{not json" });
    assert.equal(r.status, 400);

    // delete a pen mark
    r = await page(`/api/${slug}/ink/${inkId}`, { method: "DELETE" });
    assert.equal(r.status, 200);
    r = await page(`/api/${slug}/ink/${inkId}`, { method: "DELETE" });
    assert.equal(r.status, 404);
    assert.equal((await (await page(`/api/${slug}/ink`, { method: "GET" })).json()).ink.length, 0);
    // leave one mark for the later checks
    r = await page(`/api/${slug}/ink`, { body: { data: stroke } });
    assert.equal(r.status, 201);
    inkId = (await r.json()).ink.id;
  });

  const V2 = INDEX_V1.replace("Hello v1", "Hello v2");
  await check("9. an uncommitted version is never served", async () => {
    const r = await api("/api/docs", { method: "POST", body: { title: TITLE + " v2", slug } });
    assert.equal(r.status, 200);
    const made = await r.json();
    assert.equal(made.slug, slug); assert.equal(made.version, 2);
    await put(slug, 2, "index.html", Buffer.from(V2), "text/html");
    await put(slug, 2, "report.pdf", Buffer.from("%PDF-1.4 fake"), "application/pdf");
    // Version 1 is closed for upload now that 2 is staged, and 3 is not open yet.
    assert.equal((await put(slug, 1, "late.txt", Buffer.from("x"))).status, 409);
    assert.equal((await put(slug, 3, "early.txt", Buffer.from("x"))).status, 409);
    // The same path again replaces it.
    await put(slug, 2, "index.html", Buffer.from(V2), "text/html");
    assert.equal(d1(`SELECT COUNT(*) AS n FROM files WHERE slug='${slug}' AND version=2 AND path='index.html'`)[0].n, 1);

    const text = await (await fetch(`${base}/${slug}/`)).text();
    assert.ok(text.includes("Hello v1") && !text.includes("Hello v2"), "staged version leaked");
    assert.equal((await fetch(`${base}/${slug}/report.pdf`)).status, 404);
  });

  await check("5. re-publish with the slug keeps feedback, bumps the version and drops the old files", async () => {
    let r = await api(`/api/docs/${slug}/v/2/commit`, { method: "POST", body: { pdf: "missing.pdf" } });
    assert.equal(r.status, 400);
    r = await api(`/api/docs/${slug}/v/2/commit`, { method: "POST", body: { entry: "report.pdf" } });
    assert.equal(r.status, 400);
    r = await api(`/api/docs/${slug}/v/2/commit`, { method: "POST", body: { pdf: "report.pdf" } });
    assert.equal(r.status, 200);
    r = await api(`/api/docs/${slug}/v/2/commit`, { method: "POST", body: {} });
    assert.equal(r.status, 409, "committing twice");

    const text = await (await fetch(`${base}/${slug}/`)).text();
    assert.ok(text.includes("Hello v2") && !text.includes("Hello v1"));
    const data = JSON.parse(/window\.__REDLINE=(.*?)<\/script>/s.exec(text)[1]);
    assert.equal(data.version, 2); assert.equal(data.pdf, `/${slug}/report.pdf`); assert.equal(data.title, TITLE + " v2");
    assert.equal((await fetch(`${base}/${slug}/img/pic.png`)).status, 404, "old file still served");
    const pdf = await fetch(`${base}/${slug}/report.pdf`);
    assert.equal(pdf.headers.get("content-type"), "application/pdf");

    const versions = d1(`SELECT DISTINCT version FROM files WHERE slug='${slug}'`).map((x) => x.version);
    assert.deepEqual(versions, [2], "old version rows are still in the database");
    assert.deepEqual(kvKeys(`f/${slug}/`).sort(), [`f/${slug}/2/index.html`, `f/${slug}/2/report.pdf`], "old version bodies are still in KV");

    assert.equal((await (await page(`/api/${slug}/comments`, { method: "GET" })).json()).comments.length, 3);
    assert.equal((await (await page(`/api/${slug}/ink`, { method: "GET" })).json()).ink.length, 1);
    assert.equal((await (await page(`/api/${slug}/decisions`, { method: "GET" })).json()).decisions.length, 2);

    r = await api("/api/docs", { method: "POST", body: { title: "x", slug: "zzzzzzzzzzzzzzzzzzzzzzzz" } });
    assert.equal(r.status, 404, "re-publish of an unknown slug");
  });

  await check("6. GET /api/<slug>/feedback returns doc, comments, ink and decisions", async () => {
    const r = await fetch(`${base}/api/${slug}/feedback`);
    assert.equal(r.status, 200);
    const f = await r.json();
    assert.deepEqual(Object.keys(f).sort(), ["comments", "decisions", "doc", "ink", "summary"]);
    assert.equal(f.doc.slug, slug); assert.equal(f.doc.version, 2); assert.equal(f.doc.title, TITLE + " v2"); assert.deepEqual(f.doc.tags, ["a", "b"]);
    assert.equal(f.comments.length, 3); assert.equal(f.ink.length, 1); assert.equal(f.decisions.length, 2);
    assert.equal(f.ink[0].data.tx, "First paragraph.");
  });

  await check("7. GET /api/docs lists counts; the dashboard needs its token and escapes the title", async () => {
    let r = await api("/api/docs");
    assert.equal(r.status, 200);
    const { docs } = await r.json();
    assert.equal(docs.length, 1);
    const d = docs[0];
    assert.equal(d.slug, slug); assert.equal(d.title, TITLE + " v2"); assert.equal(d.project, "Demo"); assert.equal(d.version, 2);
    assert.equal(d.open_comments, 3); assert.equal(d.ink_strokes, 1);
    assert.deepEqual(d.decisions.map((x) => [x.item, x.verdict]), [["doc", "approve"], ["sec-1", "reject"]]);
    assert.equal(d.new_feedback, false, "feedback came before the second publish");
    // A second document, to be sure counts are per document and a never-committed one is not listed.
    const other = await (await api("/api/docs", { method: "POST", body: { title: "Other" } })).json();
    await api("/api/docs", { method: "POST", body: { title: "Never committed" } });
    await put(other.slug, 1, "index.html", Buffer.from("<p>no body tag</p>"), "text/html");
    await api(`/api/docs/${other.slug}/v/1/commit`, { method: "POST", body: {} });
    const noBody = await (await fetch(`${base}/${other.slug}/`)).text();
    assert.ok(noBody.startsWith("<p>no body tag</p><script>window.__REDLINE="), "layers go at the end when there is no body tag");
    await page(`/api/${other.slug}/comments`, { body: { body: "Hi" } });
    await page(`/api/${other.slug}/comments`, { body: { body: "Hi again" } });
    await page(`/api/${other.slug}/comments/1/resolve`, { body: {} }).catch(() => {});
    const list = (await (await api("/api/docs")).json()).docs;
    assert.equal(list.length, 2);
    const o = list.find((x) => x.slug === other.slug);
    assert.equal(o.new_feedback, true); assert.equal(o.ink_strokes, 0); assert.equal(o.decisions.length, 0);
    assert.equal(list[0].slug, other.slug, "newest activity first");
    assert.equal(list.find((x) => x.slug === slug).open_comments, 3);

    r = await fetch(`${base}/d/${"x".repeat(DASHBOARD_TOKEN.length)}/`);
    assert.equal(r.status, 404);
    assert.equal((await fetch(`${base}/d/${PUBLISH_KEY}/`)).status, 404);
    r = await fetch(`${base}/d/${DASHBOARD_TOKEN}/`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("referrer-policy"), "no-referrer");
    const text = await r.text();
    assert.ok(text.includes(`${"Plan &lt;/script&gt;&lt;b&gt;bold &amp; &quot;quoted&quot; v2"}`), "escaped title missing");
    assert.ok(!text.includes("</script><b>"), "raw title leaked into the dashboard");
    assert.ok(text.includes("Rejected") && text.includes("1 approved, 1 rejected") && text.includes("No decision yet") && text.includes("New feedback"));
    assert.ok(text.includes(`href="/${slug}/"`));
    assert.ok(!text.includes(PUBLISH_KEY));
    r = await fetch(`${base}/d/${DASHBOARD_TOKEN}`, { redirect: "manual" });
    assert.equal(r.headers.get("location"), `/d/${DASHBOARD_TOKEN}/`);
  });

  await check("8. unknown or deleted slugs answer 404 everywhere; DELETE removes the page and every row", async () => {
    const ghost = "q".repeat(24);
    for (const [p, method] of [[`/${ghost}/`, "GET"], [`/${ghost}`, "GET"], [`/${ghost}/x.png`, "GET"], [`/api/${ghost}/comments`, "GET"], [`/api/${ghost}/comments`, "POST"],
      [`/api/${ghost}/ink`, "GET"], [`/api/${ghost}/decisions`, "GET"], [`/api/${ghost}/feedback`, "GET"]]) {
      const r = await page(p, { method, body: method === "POST" ? { body: "x" } : undefined });
      assert.equal(r.status, 404, `${method} ${p}`);
    }
    const nope = await fetch(`${base}/${ghost}/`);
    assert.equal((await nope.text()).includes("This page doesn't exist or was removed."), true);
    assert.equal(nope.headers.get("x-robots-tag"), "noindex, nofollow");
    assert.equal((await api(`/api/docs/${ghost}`, { method: "DELETE" })).status, 404);
    assert.equal((await api(`/api/docs/${ghost}/v/1/commit`, { method: "POST", body: {} })).status, 404);
    assert.equal((await put(ghost, 1, "index.html", Buffer.from("x"))).status, 404);

    assert.ok(d1(`SELECT COUNT(*) AS n FROM files WHERE slug='${slug}'`)[0].n > 0);
    assert.equal(kvKeys(`f/${slug}/`).length, 2);
    const r = await api(`/api/docs/${slug}`, { method: "DELETE" });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).files_left, 0);
    assert.deepEqual(kvKeys(`f/${slug}/`), [], "KV bodies are still there");
    for (const p of [`/${slug}/`, `/${slug}/report.pdf`, `/api/${slug}/feedback`, `/api/${slug}/comments`]) assert.equal((await fetch(base + p)).status, 404, p);
    assert.equal((await page(`/api/${slug}/comments`, { body: { body: "late" } })).status, 404);
    for (const [table, col] of [["docs", "slug"], ["files", "slug"], ["comments", "doc_slug"], ["ink", "doc_slug"], ["decisions", "doc_slug"]]) {
      assert.equal(d1(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col}='${slug}'`)[0].n, 0, `${table} rows are still there`);
    }
    const left = (await (await api("/api/docs")).json()).docs;
    assert.equal(left.length, 1);
    const pageOnly = await fetch(`${base}/${left[0].slug}/`);
    assert.equal(pageOnly.status, 200);
  });

  // A small document published for the checks below.
  const publish = async (title, files) => {
    const made = await (await api("/api/docs", { method: "POST", body: { title } })).json();
    for (const [p, body, type] of files) assert.equal((await put(made.slug, made.version, p, body, type)).status, 200);
    assert.equal((await api(`/api/docs/${made.slug}/v/${made.version}/commit`, { method: "POST", body: {} })).status, 200);
    return made.slug;
  };

  await check("10. ranges answer 206 or 416, and an ETag gives 304", async () => {
    const s = await publish("Ranges", [["index.html", Buffer.from("<p>hi</p>"), "text/html"], ["clip.bin", BIG, "application/octet-stream"]]);
    const get = (path, headers) => fetch(`${base}/${s}/${path}`, { headers });
    let r = await get("clip.bin", { Range: "bytes=10-109" });
    assert.equal(r.status, 206);
    assert.equal(r.headers.get("content-range"), `bytes 10-109/${BIG.length}`);
    assert.equal(r.headers.get("accept-ranges"), "bytes");
    assert.ok(Buffer.from(await r.arrayBuffer()).equals(BIG.subarray(10, 110)));
    r = await get("clip.bin", { Range: "bytes=-100" });
    assert.equal(r.status, 206);
    assert.ok(Buffer.from(await r.arrayBuffer()).equals(BIG.subarray(BIG.length - 100)));
    r = await get("clip.bin", { Range: `bytes=${BIG.length - 10}-` });
    assert.equal(r.status, 206);
    assert.equal(r.headers.get("content-range"), `bytes ${BIG.length - 10}-${BIG.length - 1}/${BIG.length}`);
    r = await get("clip.bin", { Range: "bytes=0-0" });
    assert.equal((await r.arrayBuffer()).byteLength, 1);
    r = await get("clip.bin", { Range: `bytes=${BIG.length}-` });
    assert.equal(r.status, 416);
    assert.equal(r.headers.get("content-range"), `bytes */${BIG.length}`);
    r = await get("clip.bin");
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("accept-ranges"), "bytes");
    const etag = r.headers.get("etag");
    assert.match(etag, /^W\/"1-4500000"$/);
    await r.arrayBuffer();
    r = await get("clip.bin", { "If-None-Match": etag });
    assert.equal(r.status, 304);
    r = await get("clip.bin", { "If-None-Match": '"other"' });
    assert.equal(r.status, 200);
    await r.arrayBuffer();
    r = await get("", { "If-None-Match": (await get("")).headers.get("etag") });
    assert.equal(r.status, 304, "the entry page has an ETag too");
    r = await get("", { Range: "bytes=0-3" });
    assert.equal(r.status, 200, "the entry page ignores Range");
    assert.ok((await r.text()).includes("__REDLINE"));
  });

  await check("11. a failed attempt's files never go live, and old never-committed docs are cleaned up", async () => {
    const s = await publish("Staging", [["index.html", Buffer.from("<p>live</p>"), "text/html"]]);
    let r = await api("/api/docs", { method: "POST", body: { slug: s } });
    const first = (await r.json()).version;
    assert.equal(first, 2);
    await put(s, first, "index.html", Buffer.from("<p>failed attempt</p>"), "text/html");
    await put(s, first, "leftover.txt", Buffer.from("leftover"));
    // The publish is abandoned. A new attempt gets a new number and the old files are removed.
    r = await api("/api/docs", { method: "POST", body: { slug: s } });
    const second = (await r.json()).version;
    assert.ok(second > first);
    assert.deepEqual(kvKeys(`f/${s}/${first}/`), []);
    assert.equal(d1(`SELECT COUNT(*) AS n FROM files WHERE slug='${s}' AND version=${first}`)[0].n, 0);
    assert.equal((await put(s, first, "late.txt", Buffer.from("x"))).status, 409);
    await put(s, second, "index.html", Buffer.from("<p>second try</p>"), "text/html");
    assert.equal((await api(`/api/docs/${s}/v/${second}/commit`, { method: "POST", body: {} })).status, 200);
    assert.equal((await fetch(`${base}/${s}/leftover.txt`)).status, 404);
    assert.ok((await (await fetch(`${base}/${s}/`)).text()).includes("second try"));
    assert.deepEqual(kvKeys(`f/${s}/`), [`f/${s}/${second}/index.html`]);

    // A document that was created and never committed is removed an hour later, files included.
    const ghost = await (await api("/api/docs", { method: "POST", body: { title: "Never finished" } })).json();
    await put(ghost.slug, ghost.version, "index.html", Buffer.from("<p>x</p>"), "text/html");
    assert.equal(kvKeys(`f/${ghost.slug}/`).length, 1);
    d1(`UPDATE docs SET created_at='2020-01-01T00:00:00.000Z' WHERE slug='${ghost.slug}'`);
    await api("/api/docs", { method: "POST", body: { title: "Trigger" } });
    assert.equal(d1(`SELECT COUNT(*) AS n FROM docs WHERE slug='${ghost.slug}'`)[0].n, 0);
    assert.deepEqual(kvKeys(`f/${ghost.slug}/`), []);
    assert.equal(d1(`SELECT COUNT(*) AS n FROM files WHERE slug='${ghost.slug}'`)[0].n, 0);
  });

  await check("12. control characters are stripped from everything a reader sends", async () => {
    const s = await publish("Controls", [["index.html", Buffer.from("<p>x</p>"), "text/html"]]);
    const dirty = "a\u0000b\u001b[31mred\u009f\tkeep\nline\r\nend\u007f";
    const clean = "ab[31mred\tkeep\nline\nend";
    let r = await page(`/api/${s}/comments`, { body: { anchor_kind: "text", anchor_text: dirty + " anchor", anchor_context: dirty, body: dirty, author_label: dirty } });
    const c = (await r.json()).comment;
    assert.equal(c.body, clean); assert.equal(c.anchor_text, clean + " anchor"); assert.equal(c.anchor_context, clean); assert.equal(c.author_label, clean);
    r = await page(`/api/${s}/comments`, { body: { anchor_kind: "pin", anchor_data: { t: "img-1", x: 1, y: 2, near: dirty, label: dirty }, body: "pin" } });
    assert.equal((await r.json()).comment.anchor_data.near, "ab[31mred keep line end");
    r = await page(`/api/${s}/ink`, { body: { data: { a: { k: "p", t: dirty }, p: [1, 2, 3], tx: dirty }, author_label: dirty } });
    const ink = (await r.json()).ink;
    assert.equal(ink.data.tx, "ab[31mred keep line end"); assert.equal(ink.data.a.t, clean); assert.equal(ink.author_label, "ab[31mred keep line end");
    r = await page(`/api/${s}/decisions`, { body: { item: "doc", verdict: "approve", note: dirty, author_label: dirty } });
    const d = (await r.json()).decision;
    assert.equal(d.note, clean); assert.equal(d.author_label, clean);
    const stored = JSON.stringify(await (await fetch(`${base}/api/${s}/feedback`)).json());
    // JSON writes a control character as \u00xx, so none may appear in the stored feedback.
    assert.ok(!/\\u00(0[0-8bcdef]|1[0-9a-f]|7f|[89][0-9a-f])/i.test(stored), "a control character is still stored");
  });

  await check("13. per-document size caps for comments (2 MB) and pen marks (5 MB)", async () => {
    const s = await publish("Caps", [["index.html", Buffer.from("<p>x</p>"), "text/html"]]);
    const comment = { anchor_kind: "text", anchor_text: "a".repeat(1000), anchor_context: "c".repeat(2000), body: "b".repeat(4000), author_label: "n" };
    let n = 0, r;
    do { r = await page(`/api/${s}/comments`, { body: comment }); n++; } while (r.status === 201 && n < 400);
    assert.equal(r.status, 429); assert.ok(n > 250 && n < 300, `stopped after ${n} comments`);
    const points = []; for (let i = 0; i < 4000; i++) points.push(i, i, 50);
    const stroke = { a: { k: "p", t: "x", i: 0 }, p: points, c: "red", w: 30 };
    n = 0;
    do { r = await page(`/api/${s}/ink`, { body: { data: stroke } }); n++; } while (r.status === 201 && n < 400);
    assert.equal(r.status, 429); assert.ok(n > 60 && n < 200, `stopped after ${n} strokes`);
    // Small writes still work for other documents.
    const other = await publish("Caps other", [["index.html", Buffer.from("<p>x</p>"), "text/html"]]);
    assert.equal((await page(`/api/${other}/comments`, { body: { body: "fine" } })).status, 201);
  });

  await check("14. deleting a document with more files than one request can clear carries on until done", async () => {
    const made = await (await api("/api/docs", { method: "POST", body: { title: "Many files" } })).json();
    for (let i = 0; i < 40; i++) assert.equal((await put(made.slug, made.version, `f${i}.txt`, Buffer.from("x" + i))).status, 200);
    await put(made.slug, made.version, "index.html", Buffer.from("<p>x</p>"), "text/html");
    assert.equal((await api(`/api/docs/${made.slug}/v/${made.version}/commit`, { method: "POST", body: {} })).status, 200);
    assert.equal(kvKeys(`f/${made.slug}/`).length, 41);
    let r = await api(`/api/docs/${made.slug}`, { method: "DELETE" });
    assert.equal(r.status, 200);
    const first = await r.json();
    assert.equal(first.files_left, 6);
    assert.equal((await fetch(`${base}/${made.slug}/`)).status, 404, "hidden while files remain");
    assert.ok(!(await (await api("/api/docs")).json()).docs.some((d) => d.slug === made.slug));
    r = await api(`/api/docs/${made.slug}`, { method: "DELETE" });
    assert.equal((await r.json()).files_left, 0);
    assert.deepEqual(kvKeys(`f/${made.slug}/`), []);
    assert.equal(d1(`SELECT COUNT(*) AS n FROM docs WHERE slug='${made.slug}'`)[0].n, 0);
    assert.equal((await api(`/api/docs/${made.slug}`, { method: "DELETE" })).status, 404);
  });

  // ---- revisions: did it fix what I marked? -----------------------------------------------------------------------------

  const REV1 = '<!doctype html><html><head><title>Rev</title></head><body><h1>Plan</h1>' +
    '<section data-redline-decision="scope"><h2>Scope</h2><p>We will build the dashboard.</p><p>It ships in March.</p></section>' +
    '<section data-redline-decision="budget"><h2>Budget</h2><p>The budget is 30k.</p></section><p>Closing words that stay.</p></body></html>';
  const REV2 = '<!doctype html><html><head><title>Rev</title></head><body><h1>Plan</h1>' +
    '<section data-redline-decision="scope"><h2>Scope</h2><p>We will build the dashboard.</p><p>It ships in April.</p><p>A new risk appears.</p></section>' +
    '<section data-redline-decision="budget"><h2>Budget</h2><p>The budget is 30k.</p></section></body></html>';
  const republish = async (s, html) => {
    const made = await (await api("/api/docs", { method: "POST", body: { title: "Rev", slug: s } })).json();
    assert.equal((await put(s, made.version, "index.html", Buffer.from(html), "text/html")).status, 200);
    assert.equal((await api(`/api/docs/${s}/v/${made.version}/commit`, { method: "POST", body: {} })).status, 200);
    return made.version;
  };
  const stroke = (t) => ({ a: { k: "p", t, i: 1 }, c: "red", w: 30, p: [100, 200, 50, 300, 400, 60], tx: t.slice(0, 8), vw: 1000 });
  let rev, c1, c2, c3;

  await check("15. a comment goes open, fixed with a note, done, and back to open", async () => {
    rev = await publish("Rev", [["index.html", Buffer.from(REV1), "text/html"]]);
    const mk = async (body) => (await (await page(`/api/${rev}/comments`, { body: { body, author_label: "Sam" } })).json()).comment;
    [c1, c2, c3] = [await mk("Name a date"), await mk("Cut this"), await mk("Typo")];
    assert.equal(c1.status, "open"); assert.equal(c1.fix_note, ""); assert.equal(c1.reopened, false);

    const status = (id, body, headers) => page(`/api/${rev}/comments/${id}/status`, { body, headers });
    let r = await status(c1.id, { status: "fixed", note: "Put the date in the intro" });
    let c = (await r.json()).comment;
    assert.equal(c.status, "fixed"); assert.equal(c.fix_note, "Put the date in the intro"); assert.equal(c.fixed_version, 1);
    assert.match(c.fixed_at, /^\d{4}-\d\d-\d\dT/); assert.equal(c.resolved, false); assert.equal(c.reopened, false);

    r = await status(c1.id, { status: "done" });
    c = (await r.json()).comment;
    assert.equal(c.status, "done"); assert.equal(c.resolved, true); assert.equal(c.fix_note, "Put the date in the intro", "the note stays after the reader confirms");

    r = await status(c1.id, { status: "open" });
    c = (await r.json()).comment;
    assert.equal(c.status, "open"); assert.equal(c.reopened, true, "sent back after it was fixed"); assert.equal(c.fix_note, "Put the date in the intro");

    // The old call: no body is "fixed", with a note it keeps the note.
    r = await page(`/api/${rev}/comments/${c2.id}/resolve`, { body: { note: "Removed the slide" } });
    c = (await r.json()).comment;
    assert.equal(c.status, "fixed"); assert.equal(c.fix_note, "Removed the slide");
    // A comment that was never fixed and is sent back is not "reopened".
    await status(c3.id, { status: "done" });
    c = (await (await status(c3.id, { status: "open" })).json()).comment;
    assert.equal(c.reopened, false);
    await status(c3.id, { status: "done" });

    // Bad input and other people's comments.
    assert.equal((await status(c1.id, { status: "maybe" })).status, 400);
    assert.equal((await status(c1.id, {})).status, 400);
    assert.equal((await status(c1.id, { status: "fixed", note: "n".repeat(501) })).status, 400);
    assert.equal((await status(999999, { status: "done" })).status, 404);
    assert.equal((await status(c1.id, { status: "done" }, { Origin: "https://evil.example" })).status, 403);

    const list = (await (await page(`/api/${rev}/comments`, { method: "GET" })).json()).comments;
    assert.deepEqual(list.map((x) => x.status), ["open", "fixed", "done"]);
  });

  await check("16. the dashboard and the list count open, marked fixed and confirmed", async () => {
    const d = (await (await api("/api/docs")).json()).docs.find((x) => x.slug === rev);
    assert.equal(d.open_comments, 1); assert.equal(d.fixed_comments, 1); assert.equal(d.done_comments, 1);
    const text = await (await fetch(`${base}/d/${DASHBOARD_TOKEN}/`)).text();
    const row = text.slice(text.indexOf(`href="/${rev}/"`));
    assert.ok(row.slice(0, 1500).includes("1 marked fixed, 1 confirmed"), "the dashboard row does not show the states");
    const f = await (await fetch(`${base}/api/${rev}/feedback`)).json();
    assert.deepEqual(f.summary, { version: 1, since: null, open: 1, fixed: 1, done: 1, decisions_to_redo: 0, pen_marks_changed: 0 });
  });

  await check("17. a decision records the version and the name; changed text makes it stale; deciding again clears it", async () => {
    const decide = (item, verdict, who) => page(`/api/${rev}/decisions`, { body: { item, verdict, author_label: who } });
    let r = await decide("scope", "approve", "Sam");
    let dec = (await r.json()).decision;
    assert.equal(dec.version, 1); assert.equal(dec.author_label, "Sam"); assert.equal(dec.stale, false);
    assert.ok(!("text_hash" in dec), "the fingerprint is internal");
    await decide("budget", "approve", "Sam");
    await decide("doc", "approve", "Sam");
    await decide("elsewhere", "reject", "Sam"); // no such section on the page
    // Pen marks on two paragraphs, and answers from before the words were recorded.
    const pen = async (t) => (await (await page(`/api/${rev}/ink`, { body: { data: stroke(t), author_label: "Sam" } })).json()).ink;
    const marked = await pen("It ships in March.");
    await pen("The budget is 30k.");
    assert.equal(marked.version, 1); assert.equal(marked.stale, false);
    d1(`UPDATE decisions SET text_hash='' WHERE doc_slug='${rev}' AND item IN ('budget', 'doc')`);

    const before = await (await fetch(`${base}/api/${rev}/decisions`)).json();
    assert.ok(before.decisions.every((x) => x.stale === false), "nothing changed yet");

    const v2 = await republish(rev, REV2);
    assert.equal(v2, 2);
    const after = (await (await fetch(`${base}/api/${rev}/decisions`)).json()).decisions;
    const by = Object.fromEntries(after.map((x) => [x.item, x]));
    assert.equal(by.scope.stale, true, "the section's text changed");
    assert.equal(by.scope.version, 1); assert.equal(by.scope.verdict, "approve"); assert.equal(by.scope.author_label, "Sam");
    assert.equal(by.budget.stale, false, "the budget section did not change, even though its answer had no recorded words");
    assert.equal(by.doc.stale, true, "the whole page changed");
    assert.equal(by.elsewhere.stale, false, "an answer about nothing on the page is never stale");

    const f = await (await fetch(`${base}/api/${rev}/feedback`)).json();
    assert.equal(f.summary.version, 2); assert.equal(f.summary.since, 1); assert.equal(f.summary.decisions_to_redo, 2);
    assert.equal(f.decisions.find((x) => x.item === "scope").stale, true);
    const listed = (await (await api("/api/docs")).json()).docs.find((x) => x.slug === rev);
    assert.equal(listed.stale_decisions, 2);
    const dash = await (await fetch(`${base}/d/${DASHBOARD_TOKEN}/`)).text();
    assert.ok(dash.includes("2 need another look"));

    // Deciding again on the new text clears it, and records version 2.
    r = await decide("scope", "approve", "Ana");
    dec = (await r.json()).decision;
    assert.equal(dec.version, 2); assert.equal(dec.stale, false);
    const now = (await (await fetch(`${base}/api/${rev}/decisions`)).json()).decisions;
    assert.equal(now.find((x) => x.item === "scope").stale, false);
    assert.equal(now.find((x) => x.item === "scope").author_label, "Ana");
    // The history still holds the old answer with its version.
    const all = (await (await fetch(`${base}/api/${rev}/decisions?all=1`)).json()).decisions.filter((x) => x.item === "scope");
    assert.deepEqual(all.map((x) => [x.version, x.author_label]), [[1, "Sam"], [2, "Ana"]]);
  });

  await check("18. what changed: new, changed (with the old words) and removed blocks, from the stored versions", async () => {
    const ch = await (await fetch(`${base}/api/${rev}/changes`)).json();
    assert.equal(ch.available, true); assert.equal(ch.version, 2); assert.equal(ch.from, 1);
    assert.deepEqual(ch.items, [{ t: "It ships in April.", k: "changed", w: "It ships in March." }, { t: "A new risk appears.", k: "new" }]);
    assert.deepEqual(ch.removed, [{ t: "Closing words that stay." }]);
    // The first version has nothing to compare with.
    const first = await publish("Only one", [["index.html", Buffer.from(REV1), "text/html"]]);
    const none = await (await fetch(`${base}/api/${first}/changes`)).json();
    assert.deepEqual([none.available, none.items, none.removed, none.from], [false, [], [], null]);
    // The same text again changes nothing, and the answer given on version 2 still holds.
    const v3 = await republish(rev, REV2);
    assert.equal(v3, 3);
    const same = await (await fetch(`${base}/api/${rev}/changes`)).json();
    assert.deepEqual([same.available, same.from, same.items, same.removed], [true, 2, [], []]);
    const dec = (await (await fetch(`${base}/api/${rev}/decisions`)).json()).decisions;
    assert.equal(dec.find((x) => x.item === "scope").stale, false, "scope was decided again on version 2 and has not changed since");
    // Only the last two versions are kept.
    assert.deepEqual(d1(`SELECT version FROM version_blocks WHERE slug='${rev}' ORDER BY version`).map((r) => r.version), [2, 3]);
    assert.equal((await fetch(`${base}/api/${"q".repeat(24)}/changes`)).status, 404);
    assert.equal((await fetch(`${base}/api/${rev}/changes`, { method: "POST" })).status, 405);
  });

  await check("19. a pen mark on a paragraph that changed is flagged; one drawn on the new text is not", async () => {
    const ink = (await (await fetch(`${base}/api/${rev}/ink`)).json()).ink;
    assert.equal(ink.length, 2);
    const march = ink.find((m) => m.data.a.t === "It ships in March."), budget = ink.find((m) => m.data.a.t === "The budget is 30k.");
    assert.equal(march.stale, true, "the March paragraph is April now");
    assert.equal(budget.stale, false);
    const fresh = (await (await page(`/api/${rev}/ink`, { body: { data: stroke("It ships in April."), author_label: "Ana" } })).json()).ink;
    assert.equal(fresh.version, 3); assert.equal(fresh.stale, false);
    const f = await (await fetch(`${base}/api/${rev}/feedback`)).json();
    assert.equal(f.ink.filter((m) => m.stale).length, 1);
    assert.equal(f.summary.pen_marks_changed, 1);
    // A stroke whose paragraph cannot be found (a picture, say) is never called stale.
    const odd = (await (await page(`/api/${rev}/ink`, { body: { data: { ...stroke("zzz"), a: { k: "img", t: "", i: 0 } } } })).json()).ink;
    assert.equal(odd.stale, false);
  });

  await check("20. relink: a new random link, the old one stops, and everything carries over", async () => {
    const old = await publish("Relink me", [["index.html", Buffer.from(REV1), "text/html"], ["notes.txt", Buffer.from("notes"), "text/plain"]]);
    await page(`/api/${old}/comments`, { body: { body: "Stays", author_label: "Sam" } });
    await page(`/api/${old}/ink`, { body: { data: stroke("The budget is 30k.") } });
    await page(`/api/${old}/decisions`, { body: { item: "budget", verdict: "approve", author_label: "Sam" } });
    const internal = d1(`SELECT slug FROM docs WHERE link='${old}'`)[0].slug;

    assert.equal((await api(`/api/docs/${old}/relink`, { method: "POST", auth: false })).status, 401);
    assert.equal((await api(`/api/docs/${"q".repeat(24)}/relink`, { method: "POST" })).status, 404);
    assert.equal((await api(`/api/docs/${old}/relink`, { method: "GET" })).status, 405);
    const r = await api(`/api/docs/${old}/relink`, { method: "POST" });
    assert.equal(r.status, 200);
    const got = await r.json();
    assert.match(got.slug, /^[a-z0-9]{24}$/); assert.notEqual(got.slug, old); assert.equal(got.previous, old); assert.equal(got.url, `${base}/${got.slug}/`);

    for (const p of [`/${old}/`, `/${old}/notes.txt`, `/api/${old}/feedback`, `/api/${old}/comments`, `/api/${old}/changes`]) assert.equal((await fetch(base + p)).status, 404, `${p} still answers`);
    assert.equal((await page(`/api/${old}/comments`, { body: { body: "late" } })).status, 404);
    assert.equal((await api(`/api/docs/${old}`, { method: "DELETE" })).status, 404);

    const html = await (await fetch(`${base}/${got.slug}/`)).text();
    assert.equal(JSON.parse(/window\.__REDLINE=(.*?)<\/script>/s.exec(html)[1]).slug, got.slug);
    assert.equal(await (await fetch(`${base}/${got.slug}/notes.txt`)).text(), "notes");
    const f = await (await fetch(`${base}/api/${got.slug}/feedback`)).json();
    assert.equal(f.doc.slug, got.slug); assert.equal(f.comments.length, 1); assert.equal(f.ink.length, 1); assert.equal(f.decisions[0].stale, false);
    assert.equal(d1(`SELECT slug FROM docs WHERE link='${got.slug}'`)[0].slug, internal, "the id behind the link never changes");
    const listed = (await (await api("/api/docs")).json()).docs.map((x) => x.slug);
    assert.ok(listed.includes(got.slug) && !listed.includes(old));
    assert.ok((await (await fetch(`${base}/d/${DASHBOARD_TOKEN}/`)).text()).includes(`href="/${got.slug}/"`));

    // New feedback and new versions keep working at the new link, and a second relink moves it again.
    assert.equal((await page(`/api/${got.slug}/comments`, { body: { body: "After" } })).status, 201);
    assert.equal(await republish(got.slug, REV2), 2);
    const again = await (await api(`/api/docs/${got.slug}/relink`, { method: "POST" })).json();
    assert.equal((await fetch(`${base}/${got.slug}/`)).status, 404);
    assert.equal((await fetch(`${base}/${again.slug}/`)).status, 200);
    assert.equal((await (await fetch(`${base}/api/${again.slug}/comments`)).json()).comments.length, 2);

    // Deleting by the new link clears the files stored under the id.
    assert.equal((await api(`/api/docs/${again.slug}`, { method: "DELETE" })).status, 200);
    assert.deepEqual(kvKeys(`f/${internal}/`), []);
    for (const [table, col] of [["docs", "slug"], ["files", "slug"], ["comments", "doc_slug"], ["ink", "doc_slug"], ["decisions", "doc_slug"], ["version_blocks", "slug"]]) {
      assert.equal(d1(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col}='${internal}'`)[0].n, 0, `${table} rows are still there`);
    }
  });

  await check("21. the export carries the new fields and an import restores them under the same link", async () => {
    const exp = await (await api(`/api/export?slug=${rev}`)).json();
    const doc = exp.docs[0];
    assert.equal(doc.slug, rev);
    assert.deepEqual(doc.comments.map((x) => x.status), ["open", "fixed", "done"]);
    assert.equal(doc.comments[1].fix_note, "Removed the slide");
    assert.ok(doc.decisions.every((x) => "version" in x && "text_hash" in x));
    assert.ok(doc.ink.every((x) => "block_hash" in x && !("doc_slug" in x)));
    assert.deepEqual(doc.versions.map((x) => x.version), [2, 3]);
    // Importing an older export that only knows "resolved" maps it to confirmed.
    const legacy = { ...doc, slug: "legacy".padEnd(24, "x"), comments: [{ body: "old open", resolved: 0 }, { body: "old done", resolved: 1 }], decisions: [{ item: "doc", verdict: "approve" }], ink: [], versions: undefined };
    let r = await api("/api/import", { method: "POST", body: { docs: [legacy] } });
    assert.equal(r.status, 200, await r.clone().text());
    const back = await (await fetch(`${base}/api/${legacy.slug}/feedback`)).json();
    assert.deepEqual(back.comments.map((x) => x.status), ["open", "done"]);
    assert.equal(back.decisions[0].stale, false, "an answer with no recorded words is not stale");
    // Importing our own export again changes nothing and keeps the states.
    r = await api("/api/import", { method: "POST", body: { docs: [doc] } });
    assert.equal(r.status, 200);
    const same = await (await fetch(`${base}/api/${rev}/feedback`)).json();
    assert.deepEqual(same.comments.map((x) => x.status), ["open", "fixed", "done"]);
    assert.equal(same.decisions.find((x) => x.item === "scope").version, 2);
  });
}

// ---- main ---------------------------------------------------------------------------------------------------------

let failed = false;
try {
  await start();
  await run();
  failed = results.some((ok) => !ok);
} catch (err) {
  failed = true;
  console.log(`FAIL  setup: ${err && err.message}`);
  console.log(logs.join("").split("\n").slice(-30).join("\n"));
} finally {
  stop();
}
if (failed && process.env.REDLINE_TEST_LOGS) console.log(logs.join(""));
console.log(failed ? `\n${results.filter((x) => !x).length} check(s) FAILED` : `\nAll ${results.length} checks passed`);
process.exit(failed ? 1 : 0);
