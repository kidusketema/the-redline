// An in-memory stand-in for the Redline site, just enough of the API for the CLI tests.
// It is also a stand-in for site/node/server.mjs: run as a program (REDLINE_SERVER_ENTRY points here in the local-mode tests) it
// reads REDLINE_PUBLISH_KEY, REDLINE_DASHBOARD_TOKEN, PORT and HOST and prints {"ready":true,"url":...,"port":N} once it listens.
import { createServer } from 'node:http';
import { mkdirSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SLUG_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
const newSlug = () => Array.from({ length: 24 }, () => SLUG_CHARS[Math.floor(Math.random() * 36)]).join('');

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

export async function startMockSite({ key = 'test-key-0123456789abcdef0123456789abcdef', dashboard = null, port = 0, host = '127.0.0.1' } = {}) {
  const site = {
    key,
    dashboard,
    docs: new Map(), // slug -> { title, version, live, entry, pdf, versions: Map(version -> Map(path -> {type, data})) }
    comments: [], ink: [], decisions: [],
    requests: [],
    nextId: 1,
  };

  const send = (res, status, body, type = 'application/json; charset=utf-8') => {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };
  const fail = (res, status, error) => send(res, status, { error });
  const ownerOk = (req) => req.headers.authorization === 'Bearer ' + site.key;

  // The real page layer is a script; here a stub reports one box per stroke so screenshots have somewhere to look.
  const stub = (slug) => {
    const boxes = site.ink.filter((m) => m.doc_slug === slug).map((m, i) => ({ id: m.id, x: 40, y: 200 + i * 400, w: 600, h: 60 }));
    return '<script>window.__REDLINE_INK={boxes:function(){return ' + JSON.stringify(boxes) + '}}</script>';
  };

  const newestPerItem = (rows) => [...new Map(rows.map((r) => [r.item, r])).values()];

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    site.requests.push({ method: req.method, path: url.pathname, auth: req.headers.authorization || '' });
    const body = ['GET', 'HEAD', 'DELETE'].includes(req.method) ? Buffer.alloc(0) : await readBody(req);
    const json = () => { try { return JSON.parse(body.toString() || '{}'); } catch { return {}; } };

    if (parts[0] === '__secrets' && req.method === 'POST') { // the fake wrangler reports the secrets it was given
      const s = json();
      site.key = s.PUBLISH_KEY;
      site.dashboard = s.DASHBOARD_TOKEN;
      return send(res, 200, { ok: true });
    }

    if (parts[0] === 'd' && site.dashboard && parts[1] === site.dashboard) return send(res, 200, '<h1>Dashboard</h1>', 'text/html; charset=utf-8');

    if (parts[0] === 'api') {
      // Owner-only copy of everything, so a user can move from their computer to a host. Same shape as site/src/portable.js:
      // GET /api/export[?slug=S][&files=0][&file=path], POST /api/import with {docs: [...]}; lists replace, files add.
      if (parts[1] === 'export' && req.method === 'GET') {
        if (!ownerOk(req)) return fail(res, 401, 'Missing or wrong key');
        const q = url.searchParams;
        const only = q.get('file');
        const rows = [...site.docs.entries()].filter(([slug, d]) => d.live && (q.get('slug') === null || slug === q.get('slug')));
        if (q.get('slug') !== null && !rows.length) return fail(res, 404, 'There is no document with that slug.');
        const docs = rows.map(([slug, d]) => ({
          slug, title: d.title, summary: d.summary, project: d.project, tags: d.tags, version: d.version, entry: d.entry, pdf: d.pdf, created_at: d.created_at, updated_at: d.updated_at,
          files: [...d.versions.get(d.live).entries()].filter(([path]) => only === null || path === only).map(([path, f]) => (
            q.get('files') === '0' ? { path, content_type: f.type, size: f.data.length } : { path, content_type: f.type, size: f.data.length, data: f.data.toString('base64') })),
          comments: site.comments.filter((x) => x.doc_slug === slug), ink: site.ink.filter((x) => x.doc_slug === slug), decisions: site.decisions.filter((x) => x.doc_slug === slug),
        }));
        site.exports = (site.exports || 0) + 1;
        return send(res, 200, { format: 'redline-export', format_version: 1, docs });
      }
      if (parts[1] === 'import' && req.method === 'POST') {
        if (!ownerOk(req)) return fail(res, 401, 'Missing or wrong key');
        const b = json();
        if (!Array.isArray(b.docs)) return fail(res, 400, 'Expected {"docs": [...]} as written by /api/export.');
        const done = [];
        for (const d of b.docs) {
          if (!d.slug || !d.title || !d.version) return fail(res, 400, 'a document needs a slug, a title and a version');
          const old = site.docs.get(d.slug);
          const files = old && old.live === d.version ? old.versions.get(d.version) : new Map();
          for (const f of d.files || []) files.set(f.path, { type: f.content_type || '', data: Buffer.from(f.data, 'base64') });
          site.docs.set(d.slug, { title: d.title, summary: d.summary, project: d.project, tags: d.tags, version: d.version, live: d.version, entry: d.entry || 'index.html', pdf: d.pdf, created_at: d.created_at, updated_at: d.updated_at, versions: new Map([[d.version, files]]) });
          for (const [list, name] of [[site.comments, 'comments'], [site.ink, 'ink'], [site.decisions, 'decisions']]) {
            if (d[name] === undefined) continue;
            for (let i = list.length - 1; i >= 0; i--) if (list[i].doc_slug === d.slug) list.splice(i, 1);
            for (const r of d[name]) list.push({ ...r, id: site.nextId++, doc_slug: d.slug });
          }
          done.push({ slug: d.slug, files: (d.files || []).length });
        }
        site.imports = (site.imports || 0) + 1;
        (site.importSizes ||= []).push(body.length);
        return send(res, 200, { imported: done });
      }
      if (parts[1] === 'docs') {
        if (!ownerOk(req)) return fail(res, 401, 'Missing or wrong key');
        if (parts.length === 2 && req.method === 'GET') {
          const docs = [...site.docs.entries()].filter(([, d]) => d.live).map(([slug, d]) => {
            const mine = (list) => list.filter((x) => x.doc_slug === slug);
            const latest = new Map();
            for (const x of mine(site.decisions)) latest.set(x.item, x);
            const stamps = [...mine(site.comments), ...mine(site.ink), ...mine(site.decisions)].map((x) => x.created_at).sort();
            return {
              slug, title: d.title, project: d.project, version: d.version, updated_at: d.updated_at,
              open_comments: mine(site.comments).filter((c) => (c.status || (c.resolved ? 'done' : 'open')) === 'open').length, ink_strokes: mine(site.ink).length,
              fixed_comments: mine(site.comments).filter((c) => c.status === 'fixed').length, done_comments: mine(site.comments).filter((c) => (c.status || (c.resolved ? 'done' : '')) === 'done').length,
              decisions: [...latest.values()].map((x) => ({ item: x.item, verdict: x.verdict, stale: !!x.stale })), last_feedback_at: stamps[stamps.length - 1] || null, new_feedback: stamps.length > 0 && stamps[stamps.length - 1] > d.updated_at,
            };
          });
          return send(res, 200, { docs });
        }
        if (parts.length === 2 && req.method === 'POST') {
          const b = json();
          if (!b.title) return fail(res, 400, 'title is required');
          let slug = b.slug;
          let doc = slug && site.docs.get(slug);
          if (slug && !doc) return fail(res, 404, 'no such document');
          if (!slug) {
            slug = newSlug();
            doc = { version: 0, live: 0, entry: 'index.html', pdf: null, versions: new Map() };
            site.docs.set(slug, doc);
          }
          Object.assign(doc, { title: b.title, summary: b.summary || '', project: b.project || '', tags: b.tags || [] });
          const staged = doc.version + 1; // the next version after the live one, as on the real site
          doc.versions.set(staged, new Map());
          return send(res, 200, { slug, version: staged, url: `http://${req.headers.host}/${slug}/` });
        }
        const doc = site.docs.get(parts[2]);
        if (!doc) return fail(res, 404, 'no such document');
        if (parts.length === 4 && parts[3] === 'relink' && req.method === 'POST') {
          const next = newSlug();
          site.docs.delete(parts[2]);
          site.docs.set(next, doc);
          for (const list of [site.comments, site.ink, site.decisions]) for (const r of list) if (r.doc_slug === parts[2]) r.doc_slug = next;
          return send(res, 200, { slug: next, previous: parts[2], url: `http://${req.headers.host}/${next}/` });
        }
        if (parts.length === 3 && req.method === 'DELETE') {
          site.docs.delete(parts[2]);
          for (const list of [site.comments, site.ink, site.decisions]) for (let i = list.length - 1; i >= 0; i--) if (list[i].doc_slug === parts[2]) list.splice(i, 1);
          return send(res, 200, { ok: true });
        }
        if (parts[3] === 'v' && parts[5] === 'files' && req.method === 'PUT') {
          const files = Number(parts[4]) === doc.version + 1 && doc.versions.get(Number(parts[4]));
          if (!files) return fail(res, 409, 'that version is not waiting for files');
          const path = parts.slice(6).join('/');
          if ( !path || path.includes('..')) return fail(res, 400, 'bad path');
          files.set(path, { type: req.headers['content-type'] || '', data: body });
          return send(res, 200, { path, bytes: body.length });
        }
        if (parts[3] === 'v' && parts[5] === 'commit' && req.method === 'POST') {
          const version = Number(parts[4]);
          const files = version === doc.version + 1 && doc.versions.get(version);
          if (!files) return fail(res, 409, 'that version is not waiting to be committed');
          const b = json();
          const entry = b.entry || 'index.html';
          if (!files.has(entry) || !/html/.test(files.get(entry).type)) return fail(res, 400, 'the entry file must exist and be HTML');
          for (const v of [...doc.versions.keys()]) if (v !== version) doc.versions.delete(v);
          Object.assign(doc, { version, live: version, entry, pdf: b.pdf || null, updated_at: new Date().toISOString() });
          return send(res, 200, { url: `http://${req.headers.host}/${parts[2]}/` });
        }
        return fail(res, 404, 'not found');
      }

      // Page endpoints are public, like the page itself.
      const slug = parts[1];
      const doc = site.docs.get(slug);
      if (!doc || !doc.live) return fail(res, 404, 'unknown page');
      const mine = (list) => list.filter((x) => x.doc_slug === slug);
      if (parts[2] === 'feedback') {
        return send(res, 200, {
          doc: { slug, title: doc.title, version: doc.version, updated_at: doc.updated_at },
          comments: mine(site.comments), ink: mine(site.ink), decisions: newestPerItem(mine(site.decisions)),
        });
      }
      if (parts[2] === 'comments' && (parts[4] === 'resolve' || parts[4] === 'status') && req.method === 'POST') {
        const c = site.comments.find((x) => x.doc_slug === slug && String(x.id) === parts[3]);
        if (!c) return fail(res, 404, 'no such comment');
        const b = json();
        const status = parts[4] === 'status' ? b.status : b.resolved === false ? 'open' : 'fixed';
        (site.statusCalls ||= []).push({ id: c.id, path: parts[4], body: b });
        c.status = status;
        c.resolved = 0;
        if (status === 'fixed') Object.assign(c, { fix_note: b.note || '', fixed_at: new Date().toISOString(), fixed_version: doc.version });
        return send(res, 200, { comment: c });
      }
      if (parts[2] === 'changes' && req.method === 'GET') {
        return send(res, 200, (site.changes && site.changes[slug]) || { version: doc.version, from: doc.version > 1 ? doc.version - 1 : null, available: false, items: [], removed: [] });
      }
      if (parts[2] === 'comments' && parts.length === 3 && req.method === 'POST') { // a reader leaving a comment
        const b = json();
        const c = { id: site.nextId++, doc_slug: slug, author_label: 'Reader', created_at: new Date().toISOString(), anchor_kind: '', anchor_text: b.anchor_text || '', anchor_context: '', anchor_data: '', status: 'open', fix_note: '', body: b.body || '' };
        site.comments.push(c);
        return send(res, 200, { id: c.id });
      }
      if (parts[2] === 'comments' && req.method === 'GET') return send(res, 200, { comments: mine(site.comments) });
      if (parts[2] === 'ink' && req.method === 'GET') return send(res, 200, { ink: mine(site.ink) });
      if (parts[2] === 'decisions' && req.method === 'GET') return send(res, 200, { decisions: url.searchParams.get('all') ? mine(site.decisions) : newestPerItem(mine(site.decisions)) });
      return fail(res, 404, 'not found');
    }

    const slug = parts[0];
    const doc = site.docs.get(slug);
    if (!doc || !doc.live) return send(res, 404, 'Not found', 'text/plain');
    if (parts.length === 1 && !url.pathname.endsWith('/')) { res.writeHead(301, { Location: `/${slug}/` }); return res.end(); }
    const path = parts.length === 1 ? doc.entry : parts.slice(1).join('/');
    const file = doc.versions.get(doc.live).get(path);
    if (!file) return send(res, 404, 'Not found', 'text/plain');
    if (path === doc.entry) return send(res, 200, file.data.toString().replace(/<\/body>/i, stub(slug) + '</body>'), file.type);
    return send(res, 200, file.data, file.type);
  });

  await new Promise((ok) => server.listen(port, host, ok));
  site.port = server.address().port;
  site.url = 'http://127.0.0.1:' + site.port;
  site.close = () => new Promise((ok) => { server.close(ok); server.closeAllConnections(); });

  // Helpers that put feedback on a page, the way readers would.
  const row = (slug, extra) => ({ id: site.nextId++, doc_slug: slug, author_label: 'Reader', created_at: new Date().toISOString(), ...extra });
  site.addComment = (slug, c) => {
    const r = row(slug, { anchor_kind: '', anchor_text: '', anchor_context: '', anchor_data: '', ...c });
    if (r.status === undefined && r.resolved === undefined) r.status = 'open';
    site.comments.push(r);
    return r;
  };
  site.addInk = (slug, data, extra = {}) => { const r = row(slug, { data, resolved: 0, ...extra }); site.ink.push(r); return r; };
  site.addDecision = (slug, d) => { const r = row(slug, { note: '', ...d }); site.decisions.push(r); return r; };
  return site;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  if (process.env.REDLINE_DATA_DIR) mkdirSync(process.env.REDLINE_DATA_DIR, { recursive: true });
  const site = await startMockSite({
    key: process.env.REDLINE_PUBLISH_KEY || 'test-key', dashboard: process.env.REDLINE_DASHBOARD_TOKEN || null,
    port: Number(process.env.PORT || 4848), host: process.env.HOST || '127.0.0.1',
  });
  console.log(JSON.stringify({ ready: true, url: site.url, port: site.port, host: process.env.HOST || '127.0.0.1', data: process.env.REDLINE_DATA_DIR || '' }));
  process.on('SIGTERM', () => process.exit(0));
}
