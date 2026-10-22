// A tiny stand-in for the Redline server, for testing the page layers without Cloudflare.
// Serves the fixture document with the same injection the real server adds, plus in-memory
// comments, ink and decisions endpoints that follow the same shapes as the real API.
//   node test/layers-stub.mjs --port 8790 [--pdf]
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(here, '..', 'site', 'public', '_redline');
const FIXTURE = join(here, 'fixtures', 'layers-doc.html');
export const SLUG = 'abcdefghijklmnopqrstuvwx';
const TITLE = 'Moving the nightly report to the new queue';
// A one-page PDF, just enough for a download to have something to fetch.
const PDF = Buffer.from('%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
  '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R/Size 4>>\n%%EOF\n');

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

export function startStub({ port = 0, pdf = false } = {}) {
  const state = { comments: [], ink: [], decisions: [], log: [], nextId: 1, changes: { version: 1, from: null, available: false, items: [], removed: [] } };
  const nid = () => state.nextId++;
  const now = () => new Date().toISOString();
  const label = (v) => String(v || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 60);

  function page(plain, big, version = 1) {
    const cfg = JSON.stringify({ slug: SLUG, title: TITLE, pdf: pdf ? `/${SLUG}/sample.pdf` : null, version }).replace(/</g, '\\u003c');
    const inject = `<script>window.__REDLINE=${cfg}</script><link rel="stylesheet" href="/_redline/redline.css?v=stub">` +
      '<script src="/_redline/redline.js?v=stub" defer></script>';
    let html = readFileSync(FIXTURE, 'utf8');
    if (big) { // ?big=N adds N distinct paragraphs, for load-time measurements
      let extra = '';
      for (let i = 1; i <= big; i++) extra += `<p class="big">Paragraph ${i}. The region job for batch ${i} reads its orders, formats the rows and writes them to the report table before the email job runs.</p>\n`;
      html = html.replace('</main>', extra + '</main>');
    }
    if (plain) html = html.replace(/ data-redline-decision="[^"]*"/g, ''); // a page with no decision sections: the layers add one bar for the whole document
    return html.includes('</body>') ? html.replace('</body>', inject + '</body>') : html + inject;
  }

  async function api(req, res, url) {
    const parts = url.pathname.split('/').filter(Boolean); // api, slug, kind, id?, action?
    if (parts[1] !== SLUG) return json(res, 404, { error: 'no such page' });
    const origin = req.headers.origin;
    if (req.method !== 'GET' && origin && new URL(origin).host !== req.headers.host) return json(res, 403, { error: 'wrong origin' });
    const kind = parts[2];
    const body = req.method === 'GET' || req.method === 'DELETE' ? '' : await readBody(req);
    let input = {};
    if (body) { try { input = JSON.parse(body); } catch { return json(res, 400, { error: 'invalid JSON' }); } }
    state.log.push({ method: req.method, path: url.pathname, body: input });

    if (kind === 'comments') {
      if (parts.length === 3 && req.method === 'GET') return json(res, 200, { comments: state.comments });
      if (parts.length === 3 && req.method === 'POST') {
        const text = String(input.body || '').trim();
        if (!text) return json(res, 400, { error: 'comment is empty' });
        const c = {
          id: nid(), anchor_kind: String(input.anchor_kind || ''), anchor_text: String(input.anchor_text || '').slice(0, 1000),
          anchor_context: String(input.anchor_context || '').slice(0, 2000), anchor_data: input.anchor_data ? JSON.stringify(input.anchor_data) : null,
          body: text.slice(0, 4000), author_label: label(input.author_label), created_at: now(), status: 'open', fix_note: '', fixed_at: null, fixed_version: null, reopened: false,
        };
        state.comments.push(c);
        return json(res, 201, { comment: c });
      }
      if (parts.length === 5 && parts[4] === 'status' && req.method === 'POST') {
        const c = state.comments.find((x) => String(x.id) === parts[3]);
        if (!c) return json(res, 404, { error: 'no such comment' });
        if (!['open', 'fixed', 'done'].includes(input.status)) return json(res, 400, { error: 'status must be open, fixed or done' });
        if (c.status === 'fixed' && input.status === 'open') c.reopened = true;
        c.status = input.status;
        if (input.status === 'fixed') { c.fix_note = String(input.note || '').slice(0, 500); c.fixed_version = state.changes.version; }
        return json(res, 200, { comment: c });
      }
      if (parts.length === 5 && parts[4] === 'resolve' && req.method === 'POST') {
        const c = state.comments.find((x) => String(x.id) === parts[3]);
        if (!c) return json(res, 404, { error: 'no such comment' });
        c.status = input.resolved === false ? 'open' : 'done';
        return json(res, 200, { comment: c });
      }
    }
    if (kind === 'changes' && parts.length === 3 && req.method === 'GET') return json(res, 200, state.changes);
    if (kind === 'ink') {
      if (parts.length === 3 && req.method === 'GET') return json(res, 200, { ink: state.ink });
      if (parts.length === 3 && req.method === 'POST') {
        const d = input.data;
        if (!d || !d.a || !Array.isArray(d.p) || d.p.length < 3 || d.p.length % 3) return json(res, 400, { error: 'data.p must hold x, y, pressure triples' });
        if (d.p.length / 3 > 4000) return json(res, 400, { error: 'stroke has too many points' });
        const row = { id: nid(), data: d, author_label: label(input.author_label), created_at: now(), version: state.changes.version, stale: false };
        state.ink.push(row);
        return json(res, 201, { ink: row });
      }
      if (parts.length === 4 && req.method === 'DELETE') {
        const i = state.ink.findIndex((x) => String(x.id) === parts[3]);
        if (i < 0) return json(res, 404, { error: 'no such mark' });
        state.ink.splice(i, 1);
        return json(res, 200, { deleted: Number(parts[3]) });
      }
    }
    if (kind === 'decisions' && parts.length === 3) {
      if (req.method === 'GET') {
        const latest = new Map();
        for (const d of state.decisions) latest.set(d.item, d);
        return json(res, 200, { decisions: [...latest.values()] });
      }
      if (req.method === 'POST') {
        if (!input.item || !['approve', 'reject', 'unsure'].includes(input.verdict)) return json(res, 400, { error: 'item and a valid verdict are required' });
        const d = { id: nid(), doc_slug: SLUG, item: String(input.item).slice(0, 80), verdict: input.verdict, note: String(input.note || '').slice(0, 1000),
          author_label: label(input.author_label), created_at: now(), version: state.changes.version, stale: false };
        state.decisions.push(d);
        return json(res, 201, { decision: d });
      }
    }
    return json(res, 404, { error: 'not found' });
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/__state') return json(res, 200, state);
      if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
      if (url.pathname === '/_redline/redline.js' || url.pathname === '/_redline/redline.css') {
        const file = url.pathname.endsWith('.js') ? 'redline.js' : 'redline.css';
        res.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript' : 'text/css', 'Cache-Control': 'no-store' });
        return res.end(readFileSync(join(PUBLIC, file)));
      }
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      if (url.pathname === `/${SLUG}`) { res.writeHead(302, { Location: `/${SLUG}/` }); return res.end(); }
      if (url.pathname === `/${SLUG}/`) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
        return res.end(page(url.searchParams.has('plain'), Math.min(500, Number(url.searchParams.get('big')) || 0), Math.max(1, Number(url.searchParams.get('v')) || 1)));
      }
      if (pdf && url.pathname === `/${SLUG}/sample.pdf`) {
        state.log.push({ method: 'GET', path: url.pathname, body: {} });
        res.writeHead(200, { 'Content-Type': 'application/pdf', 'Cache-Control': 'no-cache' });
        return res.end(PDF);
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    } catch (err) {
      json(res, 500, { error: String(err && err.message) });
    }
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const p = server.address().port;
      resolve({ port: p, url: `http://localhost:${p}/${SLUG}/`, state, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) });
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const pi = args.indexOf('--port');
  const port = pi >= 0 ? Number(args[pi + 1]) : 8790;
  const s = await startStub({ port, pdf: args.includes('--pdf') });
  console.log(`Serving ${s.url}`);
}
