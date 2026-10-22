// The pieces under the site that let it run on more than one host: the two database shims, the two file stores, the export and import
// endpoints, the Node server's own behaviour, and the Vercel and Netlify entries called directly with Request objects.
// (test/site.mjs runs the full site suite against each target; this file covers what that suite does not.)
// Run: node --test test/adapters.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = join(ROOT, 'site');
const TMP = join(ROOT, 'test', '.tmp', 'laneA', 'adapters');
const siteRequire = createRequire(join(SITE, 'package.json'));
const load = (rel) => import(pathToFileURL(join(SITE, rel)).href);

const KEY = randomBytes(24).toString('hex');
const TOKEN = randomBytes(12).toString('hex');
const owner = { Authorization: `Bearer ${KEY}` };
const INDEX = '<!doctype html><html><head><title>t</title></head><body><h1>Hello</h1></body></html>';

before(() => { rmSync(TMP, { recursive: true, force: true }); mkdirSync(TMP, { recursive: true }); });

// A site in this process, called with Request objects. makeEnv builds DB and FILES for one of the three stores.
const calls = (app, env, base = 'http://site.test') => ({
  async raw(path, { method = 'GET', body, headers = {}, auth = true } = {}) {
    const isJson = body !== undefined && typeof body === 'object' && !(body instanceof Uint8Array);
    return app.fetch(new Request(base + path, {
      method, headers: { ...(auth ? owner : {}), ...(isJson ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: isJson ? JSON.stringify(body) : body,
    }), env);
  },
});

async function publish(site, files, title = 'A plan') {
  let r = await site.raw('/api/docs', { method: 'POST', body: { title, summary: 'S', project: 'P', tags: ['x', 'y'] } });
  assert.equal(r.status, 201);
  const made = await r.json();
  for (const [path, [bytes, type]] of Object.entries(files)) {
    r = await site.raw(`/api/docs/${made.slug}/v/1/files/${path}`, { method: 'PUT', body: bytes, headers: { 'Content-Type': type } });
    assert.equal(r.status, 200, `${path}: ${await r.clone().text()}`);
  }
  r = await site.raw(`/api/docs/${made.slug}/v/1/commit`, { method: 'POST', body: {} });
  assert.equal(r.status, 200);
  return made.slug;
}

async function addFeedback(site, slug) {
  const json = (path, body) => site.raw(path, { method: 'POST', body, auth: false });
  assert.equal((await json(`/api/${slug}/comments`, { body: 'Please fix <this>', anchor_text: 'Hello', anchor_context: 'a⟦Hello⟧b', author_label: 'Sam' })).status, 201);
  const second = await (await json(`/api/${slug}/comments`, { body: 'Whole page note' })).json();
  assert.equal((await json(`/api/${slug}/comments/${second.comment.id}/resolve`, {})).status, 200);
  assert.equal((await json(`/api/${slug}/ink`, { data: { a: { k: 'h1', t: 'Hello', i: 0 }, c: 'red', w: 30, p: [1, 2, 50, 3, 4, 60], tx: 'Hello', vw: 800 }, author_label: 'Sam' })).status, 201);
  assert.equal((await json(`/api/${slug}/decisions`, { item: 'doc', verdict: 'reject', note: 'no' })).status, 201);
  assert.equal((await json(`/api/${slug}/decisions`, { item: 'doc', verdict: 'approve', note: 'yes' })).status, 201);
}

// Strips what legitimately differs between two sites (row ids) so feedback can be compared.
const comparable = (fb) => JSON.stringify({
  doc: fb.doc,
  comments: fb.comments.map(({ id, ...r }) => r),
  ink: fb.ink.map(({ id, ...r }) => r),
  decisions: fb.decisions.map(({ id, ...r }) => r),
});

describe('schemas', () => {
  it('src/schema.js is the text of schema.sql and schema.postgres.sql (run node test/gen-schema.mjs after editing either)', async () => {
    const { SQLITE_SCHEMA, POSTGRES_SCHEMA } = await load('src/schema.js');
    assert.equal(SQLITE_SCHEMA, readFileSync(join(SITE, 'schema.sql'), 'utf8'));
    assert.equal(POSTGRES_SCHEMA, readFileSync(join(SITE, 'schema.postgres.sql'), 'utf8'));
  });

  it('both schemas define the same tables and columns', async () => {
    const { SQLITE_SCHEMA, POSTGRES_SCHEMA } = await load('src/schema.js');
    const shape = (sql) => Object.fromEntries([...sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\n\);/g)].map((m) => [
      m[1], m[2].split('\n').map((l) => /^\s{2}(\w+)\s/.exec(l)?.[1]).filter((c) => c && c !== 'PRIMARY').sort(),
    ]));
    const a = shape(SQLITE_SCHEMA), b = shape(POSTGRES_SCHEMA);
    delete b.file_bodies; // only the Postgres store keeps file bytes in a table
    assert.deepEqual(a, b);
  });
});

describe('SQLite and the file folder', () => {
  it('answers the D1 calls the site uses', async () => {
    const { openSqlite } = await load('src/stores/sqlite.js');
    const db = openSqlite(':memory:');
    const one = await db.prepare("INSERT INTO decisions (doc_slug, item, verdict, created_at) VALUES (?1, ?2, ?3, ?4) RETURNING id").bind('s', 'doc', 'approve', 'now').first();
    assert.equal(one.id, 1);
    assert.deepEqual(await db.prepare('SELECT item FROM decisions WHERE id = ?1').bind(99).first(), null);
    assert.deepEqual((await db.prepare('SELECT item, verdict FROM decisions').all()).results, [{ item: 'doc', verdict: 'approve' }]);
    assert.equal((await db.prepare('DELETE FROM decisions WHERE id = ?1').bind(1).run()).meta.changes, 1);
    await assert.rejects(db.batch([db.prepare("INSERT INTO decisions (doc_slug, item, verdict, created_at) VALUES ('a','b','c','d')"), db.prepare('INSERT INTO nope VALUES (1)')]));
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM decisions').first()).n, 0, 'a failed batch left rows behind');
  });

  it('stores files by key, streams them, and never confuses names that differ only by case or by odd characters', async () => {
    const { createDiskFiles } = await load('src/stores/disk.js');
    const root = join(TMP, 'disk');
    const files = createDiskFiles(root);
    const slug = 'a'.repeat(24);
    const key = (p) => `f/${slug}/1/${p}`;
    const names = ['A.png', 'a.png', 'dir/sub/file.txt', 'weird name?#%.txt', '.hidden', 'ünï.txt', 'x'.repeat(250) + '.bin'];
    for (const n of names) await files.put(key(n), new TextEncoder().encode('body of ' + n));
    for (const n of names) {
      assert.equal(new TextDecoder().decode(await files.get(key(n))), 'body of ' + n);
      assert.equal(await new Response(await files.get(key(n), 'stream')).text(), 'body of ' + n);
    }
    assert.equal(await files.get(key('missing')), null);
    const listed = files.listSync(`f/${slug}/`);
    assert.equal(listed.length, names.length);
    assert.ok(listed.includes(key('A.png')) && listed.includes(key('a.png')) && listed.includes(key('dir/sub/file.txt')));
    await files.put(key('a.png'), new Response('streamed').body);
    assert.equal(new TextDecoder().decode(await files.get(key('a.png'))), 'streamed');
    for (const n of names) await files.delete(key(n));
    assert.deepEqual(files.listSync('f/'), []);
    assert.ok(!existsSync(join(root, slug)), 'empty folders were left behind');
    await assert.rejects(files.get('f/../../etc/passwd'), /bad file key/);
  });
});

describe('Postgres through the injectable driver (PGlite, no socket)', () => {
  let pg, site, env;
  before(async () => {
    const { PGlite } = await import(pathToFileURL(siteRequire.resolve('@electric-sql/pglite')).href);
    const { createPgDb, createPgFiles, pgliteDriver, ensurePostgresSchema } = await load('src/stores/postgres.js');
    pg = await PGlite.create();
    const driver = pgliteDriver(pg);
    await ensurePostgresSchema(driver);
    await ensurePostgresSchema(driver); // safe twice
    const DB = createPgDb(driver);
    env = { DB, FILES: createPgFiles(DB), PUBLISH_KEY: KEY, DASHBOARD_TOKEN: TOKEN, BUILD: 'b' };
    site = calls((await load('src/app.js')).default, env);
  });
  after(() => pg && pg.close());

  it('turns ?1 into $1 and nothing else', async () => {
    const { createPgDb } = await load('src/stores/postgres.js');
    const seen = [];
    const db = createPgDb({ query: async (t, p) => { seen.push([t, p]); return []; }, transaction: async () => {}, exec: async () => {} });
    await db.prepare("SELECT * FROM docs WHERE slug = ?1 AND version = ?12").bind('a', 1).all().catch(() => {});
    assert.equal(seen[0][0], "SELECT * FROM docs WHERE slug = $1 AND version = $12");
    assert.throws(() => db.prepare('SELECT ?'), /without a number/);
  });

  it('publishes, serves with the layers, takes feedback and deletes', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const slug = await publish(site, { 'index.html': [INDEX, 'text/html'], 'img/p.png': [png, 'image/png'], 'big.bin': [randomBytes(300_000), 'application/octet-stream'] });
    const page = await site.raw(`/${slug}/`, { auth: false });
    assert.equal(page.status, 200);
    const text = await page.text();
    assert.ok(text.includes('__REDLINE') && text.indexOf('redline.js') < text.indexOf('</body>'));
    const img = Buffer.from(await (await site.raw(`/${slug}/img/p.png`, { auth: false })).arrayBuffer());
    assert.ok(img.equals(png));
    await addFeedback(site, slug);
    const fb = await (await site.raw(`/api/${slug}/feedback`, { auth: false })).json();
    assert.equal(fb.comments.length, 2);
    assert.equal(fb.comments[1].status, 'fixed');
    assert.equal(fb.decisions.length, 1);
    assert.equal(fb.decisions[0].verdict, 'approve');
    assert.equal(typeof fb.comments[0].id, 'number', 'ids must be numbers, not strings');
    const list = await (await site.raw('/api/docs')).json();
    assert.equal(list.docs[0].open_comments, 1);
    assert.equal(list.docs[0].ink_strokes, 1);
    assert.equal((await site.raw(`/api/docs/${slug}`, { method: 'DELETE' })).status, 200);
    assert.equal((await pg.query('SELECT COUNT(*)::int AS n FROM file_bodies')).rows[0].n, 0);
    assert.equal((await site.raw(`/${slug}/`, { auth: false })).status, 404);
  });
});

describe('export and import', () => {
  let from, to, fromEnv, toEnv, pg;
  before(async () => {
    const { openSqlite } = await load('src/stores/sqlite.js');
    const { createDiskFiles } = await load('src/stores/disk.js');
    const { PGlite } = await import(pathToFileURL(siteRequire.resolve('@electric-sql/pglite')).href);
    const { createPgDb, createPgFiles, pgliteDriver, ensurePostgresSchema } = await load('src/stores/postgres.js');
    const app = (await load('src/app.js')).default;
    fromEnv = { DB: openSqlite(':memory:'), FILES: createDiskFiles(join(TMP, 'export-from')), PUBLISH_KEY: KEY, DASHBOARD_TOKEN: TOKEN, BUILD: 'b' };
    pg = await PGlite.create();
    const driver = pgliteDriver(pg);
    await ensurePostgresSchema(driver);
    const DB = createPgDb(driver);
    toEnv = { DB, FILES: createPgFiles(DB), PUBLISH_KEY: KEY, DASHBOARD_TOKEN: TOKEN, BUILD: 'b' };
    from = calls(app, fromEnv);
    to = calls(app, toEnv, 'https://other.test');
  });
  after(() => pg && pg.close());

  it('need the publish key and the right method', async () => {
    for (const [path, method] of [['/api/export', 'GET'], ['/api/import', 'POST']]) {
      assert.equal((await from.raw(path, { method, auth: false, body: method === 'POST' ? { docs: [] } : undefined })).status, 401);
      assert.equal((await from.raw(path, { method, headers: { Authorization: 'Bearer nope-nope-nope-nope-nope' }, body: method === 'POST' ? { docs: [] } : undefined, auth: false })).status, 401);
    }
    assert.equal((await from.raw('/api/export', { method: 'POST', body: {} })).status, 405);
    assert.equal((await from.raw('/api/import')).status, 405);
    assert.equal((await from.raw('/api/export/extra')).status, 404);
  });

  it('moves a document, its files and all its feedback from SQLite to Postgres, with the same address', async () => {
    const slug = await publish(from, { 'index.html': [INDEX, 'text/html'], 'data/x.json': ['{"a":1}', 'application/json'], 'empty.txt': ['', 'text/plain'] }, 'Moving day');
    await addFeedback(from, slug);
    const other = await publish(from, { 'index.html': [INDEX + '<!-- other -->', 'text/html'] }, 'Second');
    const exported = await (await from.raw('/api/export')).json();
    assert.equal(exported.format, 'redline-export');
    assert.equal(exported.docs.length, 2);
    const doc = exported.docs.find((d) => d.slug === slug);
    assert.equal(doc.files.length, 3);
    assert.equal(doc.comments.length, 2);
    assert.equal(doc.decisions.length, 2, 'the whole answer history travels, not only the newest');

    const r = await to.raw('/api/import', { method: 'POST', body: exported });
    assert.equal(r.status, 200, await r.clone().text());
    assert.deepEqual((await r.json()).imported.map((x) => x.slug).sort(), [slug, other].sort());

    // Same address, same bytes, same feedback.
    const before = await (await from.raw(`/${slug}/`, { auth: false })).text();
    const after = await (await to.raw(`/${slug}/`, { auth: false })).text();
    assert.equal(after, before);
    assert.equal(await (await to.raw(`/${slug}/data/x.json`, { auth: false })).text(), '{"a":1}');
    const fbFrom = await (await from.raw(`/api/${slug}/feedback`, { auth: false })).json();
    const fbTo = await (await to.raw(`/api/${slug}/feedback`, { auth: false })).json();
    assert.equal(comparable(fbTo), comparable(fbFrom));
    const list = await (await to.raw('/api/docs')).json();
    assert.equal(list.docs.length, 2);
    // New feedback on the new site continues the numbering instead of colliding.
    const added = await to.raw(`/api/${slug}/comments`, { method: 'POST', body: { body: 'after the move' }, auth: false });
    assert.equal(added.status, 201);
  });

  it('is safe to repeat, and a request can carry one document or one file at a time', async () => {
    const slug = await publish(from, { 'index.html': [INDEX, 'text/html'], 'a.txt': ['aaa', 'text/plain'], 'b.txt': ['bbb', 'text/plain'] }, 'Chunks');
    await addFeedback(from, slug);
    const manifest = await (await from.raw(`/api/export?slug=${slug}&files=0`)).json();
    const d = manifest.docs[0];
    assert.ok(d.files.every((f) => f.data === undefined && f.size >= 0));
    // Details and feedback first (no files), then each file on its own.
    const shell = { ...d, files: [] };
    assert.equal((await to.raw('/api/import', { method: 'POST', body: { docs: [shell] } })).status, 200);
    assert.equal((await to.raw(`/${slug}/`, { auth: false })).status, 404, 'the page cannot show before its entry file arrives');
    for (const f of d.files) {
      const one = await (await from.raw(`/api/export?slug=${slug}&file=${encodeURIComponent(f.path)}`)).json();
      assert.equal(one.docs[0].files.length, 1);
      const { comments, ink, decisions, ...fileOnly } = one.docs[0];
      assert.equal((await to.raw('/api/import', { method: 'POST', body: { docs: [fileOnly] } })).status, 200);
    }
    assert.equal(await (await to.raw(`/${slug}/b.txt`, { auth: false })).text(), 'bbb');
    // Sending the whole thing again changes nothing: feedback is replaced, not doubled.
    const full = await (await from.raw(`/api/export?slug=${slug}`)).json();
    assert.equal((await to.raw('/api/import', { method: 'POST', body: full })).status, 200);
    assert.equal((await to.raw('/api/import', { method: 'POST', body: full })).status, 200);
    const fb = await (await to.raw(`/api/${slug}/feedback`, { auth: false })).json();
    assert.equal(fb.comments.length, 2);
    assert.equal(fb.ink.length, 1);
    assert.equal(comparable(fb), comparable(await (await from.raw(`/api/${slug}/feedback`, { auth: false })).json()));
  });

  it('a newer version replaces the old files', async () => {
    const slug = await publish(from, { 'index.html': [INDEX, 'text/html'], 'old.txt': ['old', 'text/plain'] }, 'Versions');
    await to.raw('/api/import', { method: 'POST', body: await (await from.raw(`/api/export?slug=${slug}`)).json() });
    let r = await from.raw('/api/docs', { method: 'POST', body: { slug, title: 'Versions' } });
    assert.equal((await r.json()).version, 2);
    await from.raw(`/api/docs/${slug}/v/2/files/index.html`, { method: 'PUT', body: INDEX + '<p>v2</p>', headers: { 'Content-Type': 'text/html' } });
    await from.raw(`/api/docs/${slug}/v/2/commit`, { method: 'POST', body: {} });
    r = await to.raw('/api/import', { method: 'POST', body: await (await from.raw(`/api/export?slug=${slug}`)).json() });
    assert.equal(r.status, 200);
    assert.ok((await (await to.raw(`/${slug}/`, { auth: false })).text()).includes('<p>v2</p>'));
    assert.equal((await to.raw(`/${slug}/old.txt`, { auth: false })).status, 404);
    assert.equal((await toEnv.DB.prepare('SELECT COUNT(*) AS n FROM file_bodies WHERE name LIKE ?1').bind(`f/${slug}/1/%`).first()).n, 0, 'version 1 bytes were kept');
  });

  it('refuses what it cannot trust, and says why', async () => {
    const good = { slug: 'b'.repeat(24), title: 'T', version: 1, files: [{ path: 'index.html', content_type: 'text/html', data: btoa(INDEX) }] };
    const bad = async (patch, text) => {
      const r = await to.raw('/api/import', { method: 'POST', body: { docs: [{ ...good, ...patch }] } });
      assert.equal(r.status, 400, JSON.stringify(patch));
      assert.match((await r.json()).error, text);
    };
    await bad({ slug: '../etc' }, /slug/);
    await bad({ title: '' }, /title/);
    await bad({ version: 0 }, /version/);
    await bad({ version: 'x' }, /version/);
    await bad({ files: [{ path: '../x', data: 'AA==' }] }, /path/);
    await bad({ files: [{ path: 'a.txt', data: '!!!' }] }, /base64/);
    await bad({ files: [{ path: 'a.txt' }] }, /no data/);
    await bad({ comments: [{ body: '' }] }, /no body/);
    await bad({ decisions: [{ item: 'doc', verdict: 'maybe' }] }, /verdict/);
    await bad({ ink: [{ data: 'not json' }] }, /JSON/);
    assert.equal((await to.raw('/api/import', { method: 'POST', body: 'not json', headers: { 'Content-Type': 'application/json' } })).status, 400);
    assert.equal((await to.raw('/api/import', { method: 'POST', body: { nothing: true } })).status, 400);
    assert.equal((await to.raw(`/${'b'.repeat(24)}/`, { auth: false })).status, 404, 'a refused import left something behind');
    assert.equal((await from.raw('/api/export?slug=nope')).status, 400);
    assert.equal((await from.raw(`/api/export?slug=${'c'.repeat(24)}`)).status, 404);
  });
});

describe('a database made before comment states, versions and relink', () => {
  const OLD_PAGE = '<!doctype html><html><body><section data-redline-decision="scope"><h2>Scope</h2><p>It ships in March.</p></section></body></html>';
  const NEW_PAGE = OLD_PAGE.replace('March', 'April');
  const S = 'm'.repeat(24);
  const now = '2026-10-01T10:00:00.000Z';

  // Rows exactly as the older code wrote them (no link, resolved instead of status, no version on answers and marks).
  async function seed(DB, FILES) {
    await DB.prepare("INSERT INTO docs (slug, title, version, staged, entry, created_at, updated_at) VALUES (?1, 'Old page', 2, 0, 'index.html', ?2, ?2)").bind(S, now).run();
    await DB.prepare("INSERT INTO files (slug, version, path, content_type, size) VALUES (?1, 2, 'index.html', 'text/html; charset=utf-8', ?2)").bind(S, OLD_PAGE.length).run();
    await FILES.put(`f/${S}/2/index.html`, new TextEncoder().encode(OLD_PAGE));
    for (const [body, resolved] of [['still open', 0], ['already handled', 1]]) {
      await DB.prepare("INSERT INTO comments (doc_slug, body, created_at, resolved) VALUES (?1, ?2, ?3, ?4)").bind(S, body, now, resolved).run();
    }
    await DB.prepare("INSERT INTO decisions (doc_slug, item, verdict, author_label, created_at) VALUES (?1, 'scope', 'approve', 'Sam', ?2)").bind(S, now).run();
    await DB.prepare("INSERT INTO ink (doc_slug, data, created_at, resolved) VALUES (?1, ?2, ?3, 0)")
      .bind(S, JSON.stringify({ a: { k: 'p', t: 'It ships in March.', i: 1 }, c: 'red', w: 30, p: [1, 2, 50], tx: '', vw: 900 }), now).run();
  }

  async function check(env) {
    const app = (await load('src/app.js')).default;
    const site = calls(app, env);
    // The first request brings the tables up to date; the old link is the id, so it keeps working.
    const page = await site.raw(`/${S}/`, { auth: false });
    assert.equal(page.status, 200);
    let fb = await (await site.raw(`/api/${S}/feedback`, { auth: false })).json();
    assert.deepEqual(fb.comments.map((c) => c.status), ['open', 'done'], 'resolved became confirmed');
    assert.equal(fb.decisions[0].version, 2, 'answers are taken to be on the live version');
    assert.equal(fb.decisions[0].stale, false);
    assert.equal(fb.ink[0].version, 2);
    assert.equal(fb.doc.slug, S);
    assert.equal((await (await site.raw('/api/docs')).json()).docs[0].slug, S);
    // Marked fixed and confirmed work on old rows.
    const fixed = await (await site.raw(`/api/${S}/comments/${fb.comments[0].id}/status`, { method: 'POST', body: { status: 'fixed', note: 'ok' }, auth: false })).json();
    assert.equal(fixed.comment.fixed_version, 2);
    // The next version: the old answer was given on the words that were live, so a change makes it stale.
    let r = await site.raw('/api/docs', { method: 'POST', body: { slug: S, title: 'Old page' } });
    assert.equal((await r.json()).version, 3);
    await site.raw(`/api/docs/${S}/v/3/files/index.html`, { method: 'PUT', body: NEW_PAGE, headers: { 'Content-Type': 'text/html' } });
    assert.equal((await site.raw(`/api/docs/${S}/v/3/commit`, { method: 'POST', body: {} })).status, 200);
    fb = await (await site.raw(`/api/${S}/feedback`, { auth: false })).json();
    assert.equal(fb.decisions[0].stale, true);
    assert.equal(fb.summary.decisions_to_redo, 1);
    const changes = await (await site.raw(`/api/${S}/changes`, { auth: false })).json();
    assert.deepEqual(changes.items.map((x) => [x.k, x.t]), [['changed', 'It ships in April.']]);
    // And a link change works on a migrated page.
    r = await site.raw(`/api/docs/${S}/relink`, { method: 'POST' });
    const moved = await r.json();
    assert.equal((await site.raw(`/${S}/`, { auth: false })).status, 404);
    assert.equal((await site.raw(`/${moved.slug}/`, { auth: false })).status, 200);
  }

  it('SQLite: brings the tables up to date on the first request and keeps every row', async () => {
    const { openSqlite } = await load('src/stores/sqlite.js');
    const { createDiskFiles } = await load('src/stores/disk.js');
    const { SQLITE_SCHEMA } = await load('src/schema.js');
    const DB = openSqlite(':memory:', { schema: false });
    DB.raw.exec(readFileSync(join(ROOT, 'test', 'fixtures', 'legacy-schema.sql'), 'utf8'));
    const FILES = createDiskFiles(join(TMP, 'migrate-sqlite'));
    await seed(DB, FILES);
    DB.raw.exec(SQLITE_SCHEMA); // what the server does on start: no change to tables that exist
    const env = { DB, FILES, PUBLISH_KEY: KEY, DASHBOARD_TOKEN: TOKEN, BUILD: 'b' };
    await check(env);
    const cols = DB.raw.prepare('PRAGMA table_info(comments)').all().map((c) => c.name);
    assert.ok(cols.includes('status') && !cols.includes('resolved'), cols.join());
    const { ensureSchema } = await load('src/migrate.js');
    await ensureSchema(env); // safe again
  });

  it('Postgres: the same, through PGlite', async () => {
    const { PGlite } = await import(pathToFileURL(siteRequire.resolve('@electric-sql/pglite')).href);
    const { createPgDb, createPgFiles, pgliteDriver, ensurePostgresSchema } = await load('src/stores/postgres.js');
    const pg = await PGlite.create();
    try {
      await pg.exec(readFileSync(join(ROOT, 'test', 'fixtures', 'legacy-schema.postgres.sql'), 'utf8'));
      const driver = pgliteDriver(pg);
      const DB = createPgDb(driver);
      const FILES = createPgFiles(DB);
      await seed(DB, FILES);
      await ensurePostgresSchema(driver);
      await check({ DB, FILES, PUBLISH_KEY: KEY, DASHBOARD_TOKEN: TOKEN, BUILD: 'b' });
      const cols = (await pg.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'comments'")).rows.map((r) => r.column_name);
      assert.ok(cols.includes('status') && !cols.includes('resolved'), cols.join());
    } finally { await pg.close(); }
  });
});

describe('reading a page into blocks and comparing two versions', () => {
  let B;
  before(async () => { B = await load('src/blocks.js'); });
  const texts = (html) => B.extractBlocks(html).blocks.map((b) => b.t);
  const para = (n) => Array.from({ length: n }, (_, i) => `<p>paragraph number ${i} with some words in it</p>`);

  it('reads text, decodes entities, collapses spaces and skips head, scripts, styles, templates and comments', () => {
    assert.deepEqual(texts('<html><head><title>T</title><style>p{}</style></head><body><script>var a="<p>no</p>"</script><p>Tom &amp; Jerry&nbsp;said &lt;hi&gt;</p></body></html>'), ['Tom & Jerry said <hi>']);
    assert.deepEqual(texts('<p>a   b\n c</p><p>  </p><!-- <p>hidden</p> --><template><p>t</p></template>'), ['a b c']);
  });

  it('copes with nested lists, optional end tags, table cells and text inside diagrams', () => {
    assert.deepEqual(texts('<ul><li>one<li>two <b>bold</b><ul><li>nested</li></ul></li></ul><p>a<p>b'), ['one', 'two bold', 'nested', 'a', 'b']);
    assert.deepEqual(texts('<svg><text>Send email</text><text>Region</text></svg><table><tr><td>x<td>y</table>'), ['Send email', 'Region', 'x', 'y']);
  });

  it('gives each decision section its own hash, which changes only when its own words do', () => {
    const one = B.extractBlocks('<section data-redline-decision="a"><h2>A</h2><p>one</p></section><section data-redline-decision="b"><p>two</p></section>');
    const two = B.extractBlocks('<section data-redline-decision="a"><h2>A</h2><p>ONE!</p></section><section data-redline-decision="b"><p>two</p></section>');
    assert.deepEqual(Object.keys(one.sections), ['a', 'b']);
    assert.notEqual(one.sections.a, two.sections.a);
    assert.equal(one.sections.b, two.sections.b);
    assert.notEqual(one.doc, two.doc);
  });

  it('marks edited blocks as changed (with the old words), added ones as new, and lists what was removed', () => {
    const before = B.extractBlocks(para(6).join('')).blocks;
    const edited = para(6);
    edited[2] = '<p>paragraph number 2 with some words in it, and more</p>';
    edited.push('<p>brand new closing remark entirely</p>');
    edited.splice(0, 1);
    const d = B.diffBlocks(before, B.extractBlocks(edited.join('')).blocks);
    assert.deepEqual(d.items.map((x) => [x.k, x.t]), [['changed', 'paragraph number 2 with some words in it, and more'], ['new', 'brand new closing remark entirely']]);
    assert.equal(d.items[0].w, 'paragraph number 2 with some words in it');
    assert.deepEqual(d.removed, [{ t: 'paragraph number 0 with some words in it' }]);
  });

  it('does not report a paragraph that only moved, and finds nothing between identical pages', () => {
    const before = B.extractBlocks(para(6).join('')).blocks;
    const moved = para(6);
    moved.splice(1, 0, moved.splice(4, 1)[0]);
    assert.deepEqual(B.diffBlocks(before, B.extractBlocks(moved.join('')).blocks), { items: [], removed: [] });
    assert.deepEqual(B.diffBlocks(before, before), { items: [], removed: [] });
  });

  it('stays quick and exact enough on a very large page', () => {
    const rows = Array.from({ length: 3000 }, (_, i) => `<p>row ${i} text ${i * 7}</p>`);
    const before = B.extractBlocks(rows.join('')).blocks;
    const after = rows.slice();
    after[1500] = '<p>CHANGED row</p>';
    after.push('<p>tail</p>');
    const t0 = Date.now();
    const d = B.diffBlocks(before, B.extractBlocks(after.join('')).blocks);
    assert.ok(Date.now() - t0 < 3000, 'diff took ' + (Date.now() - t0) + ' ms');
    assert.deepEqual(d.items.map((x) => [x.k, x.t]), [['changed', 'CHANGED row'], ['new', 'tail']]);
    assert.deepEqual(d.removed, []);
  });

  it('finds the block a pen mark was drawn on from its first words, however the page was re-spaced', () => {
    const blocks = B.extractBlocks(para(4).join('')).blocks;
    assert.equal(B.findAnchorBlock(blocks, 'Paragraph  number 3 with').t, 'paragraph number 3 with some words in it');
    assert.equal(B.findAnchorBlock(blocks, 'not on this page at all'), null);
  });
});

describe('the Node server', () => {
  let proc, base, dataDir;
  before(async () => {
    dataDir = join(TMP, 'node-server');
    proc = spawn(process.execPath, [join(SITE, 'node', 'server.mjs')], {
      env: { ...process.env, PORT: '0', REDLINE_DATA_DIR: dataDir, REDLINE_PUBLISH_KEY: KEY, REDLINE_DASHBOARD_TOKEN: TOKEN, REDLINE_PUBLIC_URL: '', DATABASE_URL: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stderr.on('data', () => {});
    const first = await new Promise((resolve, reject) => {
      let buf = '';
      proc.stdout.on('data', (d) => { buf += d; if (buf.includes('\n')) resolve(buf); });
      proc.on('exit', (c) => reject(new Error('stopped with ' + c)));
      setTimeout(() => reject(new Error('no ready line')), 15000).unref();
    });
    const lines = first.trim().split('\n');
    assert.equal(lines.length, 1, 'exactly one line on stdout');
    const ready = JSON.parse(lines[0]);
    assert.equal(ready.ready, true);
    assert.match(ready.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(ready.port, Number(new URL(ready.url).port));
    assert.equal(ready.storage, 'sqlite');
    base = ready.url;
  });
  after(() => proc && proc.kill('SIGKILL'));

  const get = (path) => new Promise((resolve, reject) => {
    // fetch() tidies "/../" away; a raw request shows what the server really does with it.
    const u = new URL(base);
    const req = httpRequest({ host: u.hostname, port: u.port, path, method: 'GET' }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });

  it('serves the page layers with long cache headers and keeps everything else out of the public folder', async () => {
    const js = await get('/_redline/redline.js');
    assert.equal(js.status, 200);
    assert.match(js.headers['content-type'], /javascript/);
    assert.equal(js.headers['cache-control'], 'public, max-age=31536000, immutable');
    assert.ok(js.body.equals(readFileSync(join(SITE, 'public', '_redline', 'redline.js'))));
    assert.match((await get('/_redline/redline.css')).headers['content-type'], /text\/css/);
    for (const p of ['/_redline/../src/app.js', '/_redline/%2e%2e/src/app.js', '/_redline/..%2fsrc%2fapp.js', '/_headers', '/_redline/', '/_redline/nope.js', '/src/app.js', '/package.json']) {
      const r = await get(p);
      assert.equal(r.status, 404, `${p} gave ${r.status}`);
      assert.ok(!r.body.includes('export default'), p);
    }
  });

  it('uses the layer build id from the files, so a changed file changes the address', async () => {
    const id = /\/_redline\/redline\.js\?v=([0-9a-f]{10})/;
    const r = await fetch(base + '/api/docs', { method: 'POST', headers: { ...owner, 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'T' }) });
    const { slug } = await r.json();
    await fetch(`${base}/api/docs/${slug}/v/1/files/index.html`, { method: 'PUT', headers: { ...owner, 'Content-Type': 'text/html' }, body: INDEX });
    await fetch(`${base}/api/docs/${slug}/v/1/commit`, { method: 'POST', headers: owner, body: '{}' });
    assert.match(await (await fetch(`${base}/${slug}/`)).text(), id);
  });

  it('answers HEAD without a body, and a dashboard token with awkward characters works encoded', async () => {
    const head = await fetch(base + '/robots.txt', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal((await head.text()), '');
    assert.equal((await fetch(`${base}/d/${TOKEN}/`)).status, 200);
    assert.equal((await fetch(`${base}/d/${TOKEN}`, { redirect: 'manual' })).status, 308);
    assert.equal((await fetch(`${base}/d/${'z'.repeat(24)}/`)).status, 404);
  });

  it('does not treat a path that starts with // as another host', async () => {
    const r = await get('//evil.example/x');
    assert.equal(r.status, 404);
  });

  it('keeps its keys when none are given: the data folder gets keys.json and a second start reuses it', async () => {
    const dir = join(TMP, 'keys');
    const { startServer } = await load('node/server.mjs');
    const env0 = { ...process.env };
    delete process.env.REDLINE_PUBLISH_KEY; delete process.env.REDLINE_DASHBOARD_TOKEN;
    const a = await startServer({ port: 0, dataDir: dir, databaseUrl: '' });
    const keys = JSON.parse(readFileSync(join(dir, 'keys.json'), 'utf8'));
    assert.equal(a.env.PUBLISH_KEY, keys.publish_key);
    assert.equal((await fetch(a.url + '/api/docs', { headers: { Authorization: 'Bearer ' + keys.publish_key } })).status, 200);
    await a.close();
    const b = await startServer({ port: 0, dataDir: dir, databaseUrl: '' });
    assert.equal(b.env.PUBLISH_KEY, keys.publish_key);
    await b.close();
    Object.assign(process.env, env0);
  });

  it('starts when launched through a symlinked path (macOS /var is /private/var)', async () => {
    const link = join(TMP, 'node-link');
    rmSync(link, { force: true });
    symlinkSync(join(SITE, 'node'), link);
    const line = await new Promise((resolve, reject) => {
      const p = spawn(process.execPath, [join(link, 'server.mjs')], { env: { ...process.env, PORT: '0', REDLINE_DATA_DIR: join(TMP, 'linked'), DATABASE_URL: '' }, stdio: ['ignore', 'pipe', 'ignore'] });
      p.stdout.on('data', (d) => { p.kill('SIGKILL'); resolve(String(d)); });
      p.on('exit', () => reject(new Error('it exited without printing a ready line')));
      setTimeout(() => { p.kill('SIGKILL'); reject(new Error('no ready line')); }, 15000).unref();
    });
    assert.equal(JSON.parse(line).ready, true);
  });

  it('says plainly when the port is taken', async () => {
    const taken = new URL(base).port;
    const r = await new Promise((resolve) => {
      const p = spawn(process.execPath, [join(SITE, 'node', 'server.mjs')], { env: { ...process.env, PORT: taken, REDLINE_DATA_DIR: join(TMP, 'busy'), DATABASE_URL: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let err = '';
      p.stderr.on('data', (d) => { err += d; });
      p.on('exit', (code) => resolve({ code, err }));
    });
    assert.equal(r.code, 1);
    assert.match(r.err, /port is already in use/);
  });
});

describe('the public address (REDLINE_PUBLIC_URL)', () => {
  it('puts the public address in links and accepts writes from either address', async () => {
    const { startServer } = await load('node/server.mjs');
    const s = await startServer({ port: 0, dataDir: join(TMP, 'public-url'), publishKey: KEY, dashboardToken: TOKEN, publicUrl: 'https://tunnel.example.org', databaseUrl: '' });
    try {
      const made = await (await fetch(s.url + '/api/docs', { method: 'POST', headers: { ...owner, 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'T' }) })).json();
      assert.equal(made.url, `https://tunnel.example.org/${made.slug}/`);
      await fetch(`${s.url}/api/docs/${made.slug}/v/1/files/index.html`, { method: 'PUT', headers: { ...owner, 'Content-Type': 'text/html' }, body: INDEX });
      const committed = await (await fetch(`${s.url}/api/docs/${made.slug}/v/1/commit`, { method: 'POST', headers: owner, body: '{}' })).json();
      assert.equal(committed.url, `https://tunnel.example.org/${made.slug}/`);
      const write = (origin) => fetch(`${s.url}/api/${made.slug}/comments`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ body: 'hi' }) });
      assert.equal((await write('https://tunnel.example.org')).status, 201);
      assert.equal((await write(s.url)).status, 201);
      assert.equal((await write('https://attacker.example')).status, 403);
    } finally { await s.close(); }
  });
});

describe('the Vercel and Netlify entries, called with Request objects', () => {
  let pgProc, dbUrl;
  before(async () => {
    pgProc = spawn(process.execPath, [join(ROOT, 'test', 'pg-server.mjs')], { stdio: ['ignore', 'pipe', 'inherit'] });
    const line = await new Promise((resolve, reject) => {
      let buf = '';
      pgProc.stdout.on('data', (d) => { buf += d; const m = /\{.*\}/.exec(buf); if (m) resolve(JSON.parse(m[0])); });
      pgProc.on('exit', () => reject(new Error('the test Postgres stopped')));
      setTimeout(() => reject(new Error('the test Postgres did not start')), 60000).unref();
    });
    dbUrl = `postgres://postgres:postgres@127.0.0.1:${line.pgPort}/postgres`;
  });
  after(() => pgProc && pgProc.kill('SIGKILL'));

  // The entries read process.env when they load, as they do on the host, so each is loaded with its own variables.
  async function loadEntry(rel, vars) {
    const saved = { ...process.env };
    for (const n of ['DATABASE_URL', 'POSTGRES_URL', 'NETLIFY_DB_URL', 'NETLIFY_DATABASE_URL']) delete process.env[n];
    Object.assign(process.env, vars);
    try { return await import(pathToFileURL(join(SITE, rel)).href + '?' + Math.random()); } finally { process.env = saved; }
  }

  async function walk(call, label) {
    const url = 'https://redline.example.app';
    const send = (path, init = {}) => call(new Request(url + path, init));
    assert.equal((await send('/api/docs')).status, 401, label);
    let r = await send('/api/docs', { method: 'POST', headers: { ...owner, 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'From ' + label }) });
    assert.equal(r.status, 201);
    const { slug } = await r.json();
    r = await send(`/api/docs/${slug}/v/1/files/index.html`, { method: 'PUT', headers: { ...owner, 'Content-Type': 'text/html' }, body: INDEX });
    assert.equal(r.status, 200);
    r = await send(`/api/docs/${slug}/v/1/files/img.bin`, { method: 'PUT', headers: { ...owner, 'Content-Type': 'application/octet-stream' }, body: new Uint8Array([0, 1, 2, 255, 254]) });
    assert.equal(r.status, 200);
    r = await send(`/api/docs/${slug}/v/1/commit`, { method: 'POST', headers: owner, body: '{}' });
    assert.equal((await r.json()).url, `${url}/${slug}/`);
    const page = await (await send(`/${slug}/`)).text();
    assert.ok(page.includes('__REDLINE') && page.includes('<h1>Hello</h1>'));
    assert.deepEqual([...new Uint8Array(await (await send(`/${slug}/img.bin`)).arrayBuffer())], [0, 1, 2, 255, 254]);
    r = await send(`/api/${slug}/comments`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url }, body: JSON.stringify({ body: 'works' }) });
    assert.equal(r.status, 201);
    assert.equal((await send(`/api/${slug}/comments`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: JSON.stringify({ body: 'no' }) })).status, 403);
    assert.equal((await (await send(`/api/${slug}/feedback`)).json()).comments.length, 1);
    assert.equal((await send(`/d/${TOKEN}/`)).status, 200);
    assert.equal((await send(`/api/export`, { headers: owner })).status, 200);
    return slug;
  }

  it('Vercel: api/index.mjs has the fetch handler shape and serves the whole site from Postgres', async () => {
    const entry = await loadEntry('api/index.mjs', { DATABASE_URL: dbUrl, REDLINE_PUBLISH_KEY: KEY, REDLINE_DASHBOARD_TOKEN: TOKEN, REDLINE_PG_POOL: '1' });
    assert.equal(typeof entry.default.fetch, 'function');
    await walk((req) => entry.default.fetch(req), 'vercel');
  });

  it('Vercel: POSTGRES_URL (what the Neon and Supabase integrations set) works as well as DATABASE_URL', async () => {
    const entry = await loadEntry('api/index.mjs', { POSTGRES_URL: dbUrl, REDLINE_PUBLISH_KEY: KEY, REDLINE_DASHBOARD_TOKEN: TOKEN, REDLINE_PG_POOL: '1' });
    assert.equal((await entry.default.fetch(new Request('https://x.app/api/docs', { headers: owner }))).status, 200);
  });

  it('Netlify: netlify/functions/redline.mjs takes every path except static files, and serves the whole site from Postgres', async () => {
    const entry = await loadEntry('netlify/functions/redline.mjs', { NETLIFY_DB_URL: dbUrl, REDLINE_PUBLISH_KEY: KEY, REDLINE_DASHBOARD_TOKEN: TOKEN, REDLINE_PG_POOL: '1' });
    assert.equal(typeof entry.default, 'function');
    assert.deepEqual(entry.config, { path: '/*', preferStatic: true });
    await walk((req) => entry.default(req, {}), 'netlify');
  });

  it('answers with a plain message, not a crash, when there is no database or it cannot be reached', async () => {
    const none = await loadEntry('api/index.mjs', { REDLINE_PUBLISH_KEY: KEY, REDLINE_DASHBOARD_TOKEN: TOKEN });
    let r = await none.default.fetch(new Request('https://x.app/api/docs', { headers: owner }));
    assert.equal(r.status, 503);
    assert.match((await r.json()).error, /No database is connected/);
    const dead = await loadEntry('api/index.mjs', { DATABASE_URL: 'postgres://u:p@127.0.0.1:1/db' });
    r = await dead.default.fetch(new Request('https://x.app/'));
    assert.equal(r.status, 503);
    assert.match((await r.json()).error, /could not reach its database/);
    const notPg = await loadEntry('api/index.mjs', { DATABASE_URL: 'mysql://nope' });
    assert.equal((await notPg.default.fetch(new Request('https://x.app/'))).status, 503);
  });

  it('a dashboard token with + / = characters (what Render generates) works when the link is encoded', async () => {
    const odd = 'ab+cd/ef=gh+ij/kl=mn+op/qr==';
    const entry = await loadEntry('api/index.mjs', { DATABASE_URL: dbUrl, REDLINE_PUBLISH_KEY: KEY, REDLINE_DASHBOARD_TOKEN: odd, REDLINE_PG_POOL: '1' });
    const r = await entry.default.fetch(new Request(`https://x.app/d/${encodeURIComponent(odd)}/`));
    assert.equal(r.status, 200);
    assert.equal((await entry.default.fetch(new Request('https://x.app/d/ab+cd/ef/'))).status, 404);
  });
});
