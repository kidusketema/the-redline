// Tests for local mode, phone mode, Markdown publishing, deploying to hosts and the Codex install.
// Run: node --test test/cli-local.mjs
// The local server is test/mock-site.mjs, used through REDLINE_SERVER_ENTRY, so these run without starting the real server.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockSite } from './mock-site.mjs';
import { findChrome } from '../cli/redline.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'cli', 'redline.mjs');
const MOCK_ENTRY = join(ROOT, 'test', 'mock-site.mjs');
const hasChrome = !!findChrome();

const temp = (label) => mkdtempSync(join(tmpdir(), 'redline-local-' + label + '-'));
const everything = []; // every byte the CLI printed, to prove no key shows up

function run(args, { env = {} } = {}) {
  const clean = { ...process.env };
  for (const k of Object.keys(clean)) if (k.startsWith('REDLINE_') || k === 'CODEX_HOME') delete clean[k];
  return new Promise((done) => {
    const child = execFile(process.execPath, [CLI, ...args], { env: { ...clean, ...env }, timeout: 180000 }, (err, stdout, stderr) => {
      everything.push(stdout, stderr);
      done({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr });
    });
    child.stdin.end('');
  });
}

const localHomes = [];
const localHome = (label) => { const h = temp(label); localHomes.push(h); return h; };
const localEnv = (home, extra = {}) => ({ REDLINE_HOME: home, REDLINE_SERVER_ENTRY: MOCK_ENTRY, REDLINE_PORT: '0', REDLINE_LAN_IP: '192.168.50.7', ...extra });
const record = (home) => JSON.parse(readFileSync(join(home, 'server.json'), 'utf8'));
const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const localConfig = (home) => JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
const lastLine = (r) => r.stdout.trim().split('\n').pop();
const slugOf = (r) => lastLine(r).split('/')[3];
const pageFiles = (s, slug) => s.docs.get(slug).versions.get(s.docs.get(slug).live);
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
const readyLine = (home) => JSON.parse(readFileSync(join(home, 'server.log'), 'utf8').split('\n').find((l) => l.startsWith('{')));

let page;
before(() => {
  page = join(temp('pages'), 'plan.html');
  writeFileSync(page, '<!doctype html><html><head><title>Plan for tests</title></head><body><h1>Plan</h1><p>Intro text here.</p></body></html>');
});

after(() => {
  const keys = [];
  for (const h of localHomes) {
    try { const rec = record(h); if (isAlive(rec.pid)) process.kill(rec.pid, 'SIGKILL'); } catch { /* no server */ }
    try { keys.push(localConfig(h).local.key); } catch { /* never used */ }
  }
  const joined = everything.join('\n');
  for (const k of keys) assert.ok(!joined.includes(k), 'a local key must never be printed');
});

describe('local mode', () => {
  let home;
  before(() => { home = localHome('local'); });

  test('the first publish starts the local server, makes keys, and a second command reuses it', async () => {
    const r = await run(['publish', page, '--no-pdf'], { env: localEnv(home) });
    assert.equal(r.code, 0, r.stderr);
    const url = lastLine(r);
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/[a-z0-9]{24}\/$/);
    assert.equal((await fetch(url)).status, 200);

    const cfg = localConfig(home);
    assert.match(cfg.local.key, /^[0-9a-f]{48}$/);
    assert.match(cfg.local.dashboard, /^[a-z0-9]{24}$/);
    if (process.platform !== 'win32') assert.equal(statSync(join(home, 'config.json')).mode & 0o777, 0o600);

    const rec = record(home);
    assert.ok(isAlive(rec.pid), 'the server keeps running after the command ends');
    assert.equal(rec.url, new URL(url).origin);
    assert.equal(rec.network, false);
    const ready = readyLine(home); // the server got the documented environment
    assert.equal(ready.host, '127.0.0.1');
    assert.equal(ready.data, join(home, 'data'));

    const again = await run(['list'], { env: localEnv(home) });
    assert.equal(again.code, 0, again.stderr);
    assert.match(again.stdout, /Plan for tests/);
    assert.equal(record(home).pid, rec.pid, 'the running server is reused');
  });

  test('feedback, open and dashboard work on the local site, with a bare slug', async () => {
    const list = JSON.parse((await run(['list', '--json'], { env: localEnv(home) })).stdout);
    assert.equal(list.length, 1);
    const slug = list[0].slug;
    const c = await fetch(record(home).url + '/api/' + slug + '/comments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: 'Local comment' }) });
    assert.equal(c.status, 200);
    const fb = await run(['feedback', slug], { env: localEnv(home) });
    assert.equal(fb.code, 0, fb.stderr);
    assert.match(fb.stdout, /Local comment/);
    const dash = await run(['dashboard'], { env: localEnv(home) });
    assert.match(dash.stdout.trim(), new RegExp('^http://127\\.0\\.0\\.1:\\d+/d/' + localConfig(home).local.dashboard + '/$'));
    assert.equal((await fetch(dash.stdout.trim())).status, 200);
  });

  test('stop ends the server; stop again says it is not running; the next command starts a fresh one', async () => {
    const rec = record(home);
    const stop = await run(['stop'], { env: localEnv(home) });
    assert.equal(stop.code, 0, stop.stderr);
    assert.match(stop.stdout, /Stopped/);
    assert.ok(!isAlive(rec.pid));
    assert.ok(!existsSync(join(home, 'server.json')));
    assert.match((await run(['stop'], { env: localEnv(home) })).stdout, /not running/);
    assert.equal((await run(['list'], { env: localEnv(home) })).code, 0);
    assert.notEqual(record(home).pid, rec.pid);
  });

  test('a server that died is replaced, not trusted', async () => {
    const rec = record(home);
    process.kill(rec.pid, 'SIGKILL');
    await sleepMs(300);
    const r = await run(['list'], { env: localEnv(home) });
    assert.equal(r.code, 0, r.stderr);
    assert.notEqual(record(home).pid, rec.pid);
    assert.ok(isAlive(record(home).pid));
  });

  test('a stale record whose process id now belongs to something else is never killed', async () => {
    const h = localHome('stale');
    await run(['publish', page, '--no-pdf'], { env: localEnv(h) });
    await run(['stop'], { env: localEnv(h) });
    const bystander = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    try {
      writeFileSync(join(h, 'server.json'), JSON.stringify({ pid: bystander.pid, port: 1, url: 'http://127.0.0.1:1', network: false, fingerprint: 'x' }));
      assert.match((await run(['stop'], { env: localEnv(h) })).stdout, /not running any more/);
      assert.ok(isAlive(bystander.pid), 'an unrelated process must survive');
    } finally { bystander.kill(); }
  });

  test('when the server code changes, the next command restarts it', async () => {
    const h = localHome('restart');
    const entry = join(temp('entry'), 'server.mjs');
    cpSync(MOCK_ENTRY, entry);
    const e = localEnv(h, { REDLINE_SERVER_ENTRY: entry });
    assert.equal((await run(['list'], { env: e })).code, 0);
    const first = record(h);
    assert.equal((await run(['list'], { env: e })).code, 0);
    assert.equal(record(h).pid, first.pid, 'unchanged code keeps the same server');
    writeFileSync(entry, readFileSync(entry, 'utf8') + '\n// a new version\n');
    assert.equal((await run(['list'], { env: e })).code, 0);
    const second = record(h);
    assert.notEqual(second.pid, first.pid);
    assert.ok(!isAlive(first.pid), 'the old server is stopped');
    assert.ok(isAlive(second.pid));
  });

  test('a server that cannot start is reported with its last words', async () => {
    const entry = join(temp('broken'), 'server.mjs');
    writeFileSync(entry, 'console.error("Boom: no database"); process.exit(1);');
    const r = await run(['list'], { env: localEnv(localHome('broken'), { REDLINE_SERVER_ENTRY: entry }) });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /did not start/);
    assert.match(r.stderr, /Boom: no database/);
  });

  test('setup with no target starts the local site, publishes a sample once, and points at hosts and phone', async () => {
    const h = localHome('setup-local');
    const r = await run(['setup'], { env: localEnv(h) });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Sample plan: http:\/\/127\.0\.0\.1:\d+\/[a-z0-9]{24}\//);
    assert.match(r.stdout, /Dashboard:   http:\/\/127\.0\.0\.1:\d+\/d\/[a-z0-9]{24}\//);
    assert.match(r.stdout, /redline phone/);
    assert.match(r.stdout, /redline deploy vercel, netlify, cloudflare or docker/);
    assert.equal(localConfig(h).mode, 'local');
    const sample = /Sample plan: \S+\/([a-z0-9]{24})\//.exec(r.stdout)[1];
    const again = await run(['setup'], { env: localEnv(h) });
    assert.match(again.stdout, new RegExp('Sample plan: \\S+/' + sample + '/'), 'the same sample is reused');
  });

  test('serve runs in the foreground, other commands reuse it, and Ctrl+C stops it', async () => {
    const h = localHome('serve');
    const clean = { ...process.env };
    for (const k of Object.keys(clean)) if (k.startsWith('REDLINE_')) delete clean[k];
    const child = spawn(process.execPath, [CLI, 'serve', '--port', '0'], { env: { ...clean, ...localEnv(h) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    const exited = new Promise((r) => child.once('exit', (code, sig) => r({ code, sig })));
    try {
      for (let i = 0; i < 100 && !existsSync(join(h, 'server.json')); i++) await sleepMs(100);
      assert.ok(existsSync(join(h, 'server.json')), 'serve records itself: ' + out);
      const rec = record(h);
      assert.equal(rec.foreground, true);
      assert.match(out, /"ready":true/);
      const r = await run(['list'], { env: localEnv(h) });
      assert.equal(r.code, 0, r.stderr);
      assert.equal(record(h).pid, rec.pid, 'the foreground server is reused');
      assert.equal((await run(['serve'], { env: localEnv(h) })).code, 1, 'a second server is refused');
    } finally {
      child.kill('SIGINT');
    }
    await exited;
    if (process.platform === 'win32') {
      // Windows ends a killed process without running its signal handlers, so serve cannot remove its own record.
      // What matters there: the record counts as stale (its pid is dead or the server is stopped) and "redline stop" clears it.
      await run(['stop'], { env: localEnv(h) });
    }
    assert.ok(!existsSync(join(h, 'server.json')), 'the record is removed when serve ends');
  });
});

describe('phone mode and the QR code', () => {
  let home;
  before(() => { home = localHome('phone'); });

  test('phone restarts the server on the Wi-Fi, prints the link and a QR code, and says who can open it', async () => {
    const pub = await run(['publish', page, '--no-pdf'], { env: localEnv(home) });
    const slug = slugOf(pub);
    const before = record(home);
    const r = await run(['phone'], { env: localEnv(home) });
    assert.equal(r.code, 0, r.stderr);
    const rec = record(home);
    assert.notEqual(rec.pid, before.pid, 'the server restarts to listen on the network');
    assert.equal(rec.network, true);
    assert.equal(localConfig(home).local.network, true);
    assert.equal(readyLine(home).host, '0.0.0.0');
    assert.ok(r.stdout.includes('http://192.168.50.7:' + rec.port + '/' + slug + '/'), r.stdout);
    assert.match(r.stdout, /Anyone on this Wi-Fi who has a link can open that page/);
    assert.match(r.stdout, /[\u2580\u2584\u2588]/);
    assert.match(r.stdout, /redline phone --off/);
  });

  test('the QR code encodes exactly the link', async () => {
    const { qrMatrix, renderQr } = await import('../cli/lib/qr.mjs');
    const text = 'http://192.168.50.7:4848/abcdefghij0123456789wxyz/';
    const m = qrMatrix(text);
    const lines = renderQr(text).split('\n');
    assert.equal(lines.length, Math.ceil(m.length / 2));
    // Read the picture back into modules and compare with the encoder's matrix.
    const back = [];
    for (const line of lines) {
      const cells = [...line.replace(/\u001b\[[0-9;]*m/g, '')];
      back.push(cells.map((c) => c === '\u2588' || c === '\u2580'), cells.map((c) => c === '\u2588' || c === '\u2584'));
    }
    assert.equal(back[0].length, m.length);
    for (let y = 0; y < m.length; y++) assert.deepEqual(back[y], m[y], 'row ' + y);
    assert.ok(m.slice(0, 3).every((row) => row.every((v) => !v)), 'a light border surrounds the code');
  });

  test('publish, open and dashboard show the Wi-Fi link while network mode is on', async () => {
    const pub = await run(['publish', page, '--no-pdf'], { env: localEnv(home) });
    assert.equal(pub.code, 0, pub.stderr);
    const rec = record(home);
    assert.match(pub.stdout, new RegExp('same Wi-Fi:\\nhttp://192\\.168\\.50\\.7:' + rec.port + '/[a-z0-9]{24}/'));
    assert.match((await run(['open'], { env: localEnv(home) })).stdout, /192\.168\.50\.7/);
    assert.match((await run(['dashboard'], { env: localEnv(home) })).stdout, /192\.168\.50\.7:\d+\/d\//);
  });

  test('phone --off returns to this computer only; publish then prints no Wi-Fi link', async () => {
    const r = await run(['phone', '--off'], { env: localEnv(home) });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(record(home).network, false);
    assert.equal(readyLine(home).host, '127.0.0.1');
    const pub = await run(['publish', page, '--no-pdf'], { env: localEnv(home) });
    assert.ok(!/Wi-Fi/.test(pub.stdout));
  });

  test('phone --dashboard shows the dashboard link', async () => {
    const r = await run(['phone', '--dashboard'], { env: localEnv(home) });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, new RegExp('http://192\\.168\\.50\\.7:\\d+/d/' + localConfig(home).local.dashboard + '/'));
    await run(['phone', '--off'], { env: localEnv(home) });
  });

  test('phone refuses when the site lives on a host, and says why', async () => {
    const r = await run(['phone'], { env: { REDLINE_HOME: temp('x'), REDLINE_URL: 'https://example.invalid', REDLINE_KEY: 'k' } });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /opens on any device already/);
  });
});

describe('Markdown publish', () => {
  let dir;
  let site;
  let ownHome;
  const env = () => ({ REDLINE_HOME: ownHome, REDLINE_URL: site.url, REDLINE_KEY: site.key });
  const md = (name, text) => { const f = join(dir, name); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, text); return f; };
  const publish = (input, extra = []) => run(['publish', input, '--no-pdf', ...extra], { env: env() });
  const html = (r) => pageFiles(site, slugOf(r)).get('index.html').data.toString();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

  before(async () => {
    site = await startMockSite();
    ownHome = temp('md-home');
    dir = temp('markdown');
    mkdirSync(join(dir, 'img'));
    writeFileSync(join(dir, 'img', 'chart.png'), png);
    writeFileSync(join(dir, 'secret.txt'), 'do not upload');
  });
  after(async () => { await site.close(); });

  test('renders a page in the sample style, with sections, a table and the title from the first heading', async () => {
    const f = md('plan.md', '# Plan: new onboarding\n\nWe want to change **one** thing.\n\n## Who gets it\n\n| Group | People |\n|---|---|\n| New users | 1,000 |\n\n## Cost\n\n- cheap\n- fast\n');
    const r = await publish(f);
    assert.equal(r.code, 0, r.stderr);
    const slug = slugOf(r);
    const h = html(r);
    assert.equal(site.docs.get(slug).title, 'Plan: new onboarding');
    assert.match(h, /<title>Plan: new onboarding<\/title>/);
    assert.match(h, /<h1>Plan: new onboarding<\/h1>/);
    assert.match(h, /<section class="intro">\s*<p>We want to change <strong>one<\/strong> thing\.<\/p>/);
    assert.match(h, /<section>\s*<h2>Who gets it<\/h2>/);
    assert.match(h, /<div class="scroll"><table>/);
    assert.match(h, /prefers-color-scheme: dark/);
    assert.deepEqual([...pageFiles(site, slug).keys()], ['index.html']);
    assert.match(pageFiles(site, slug).get('index.html').type, /text\/html/);
  });

  test('a redline:decision comment makes that section ask for a decision', async () => {
    const f = md('decide.md', '# Choices\n\n## Start date\n\n<!-- redline:decision start-date -->\n\nNovember 16 or December 7?\n\n## Background\n\nNo decision here.\n\n## Budget\n<!-- redline:decision budget -->\nWe need $5.\n');
    const h = html(await publish(f));
    assert.match(h, /<section data-redline-decision="start-date">\s*<h2>Start date<\/h2>/);
    assert.match(h, /<section data-redline-decision="budget">\s*<h2>Budget<\/h2>/);
    assert.match(h, /<section>\s*<h2>Background<\/h2>/);
    assert.equal((h.match(/data-redline-decision=/g) || []).length, 2);
  });

  test('the same decision id twice is an error', async () => {
    const f = md('twice.md', '# T\n\n## A\n<!-- redline:decision x -->\ntext\n\n## B\n<!-- redline:decision x -->\ntext\n');
    const r = await publish(f);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /"x" is used in two sections/);
  });

  test('relative pictures are uploaded with the page; pictures above the file are copied in; other files are left behind', async () => {
    const f = md('up/pics.md', '# Pics\n\n![A chart](../img/chart.png)\n\n![Same](../img/chart.png)\n\n![Local](local.png)\n\n![Secret](../secret.txt)\n\n![Remote](https://example.com/x.png)\n\n![Gone](nothere.png)\n\n<img src="local.png" alt="html image">\n');
    writeFileSync(join(dir, 'up', 'local.png'), png);
    const r = await publish(f);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /1 picture in the Markdown was not found/);
    const files = pageFiles(site, slugOf(r));
    assert.deepEqual([...files.keys()].sort(), ['images/1-chart.png', 'index.html', 'local.png']);
    assert.deepEqual(files.get('local.png').data, png);
    assert.equal(files.get('local.png').type, 'image/png');
    const h = files.get('index.html').data.toString();
    assert.match(h, /src="images\/1-chart\.png"/);
    assert.match(h, /src="local\.png"/);
    assert.match(h, /src="https:\/\/example\.com\/x\.png"/);
    assert.ok(!files.has('secret.txt'));
    assert.ok(!/images\/\d-secret/.test(h));
  });

  test('a folder with README.md or index.md publishes with its pictures; index.html wins over Markdown', async () => {
    const folder = join(dir, 'folder');
    mkdirSync(join(folder, 'img'), { recursive: true });
    writeFileSync(join(folder, 'img', 'chart.png'), png);
    writeFileSync(join(folder, 'README.md'), '# From readme\n\n![c](img/chart.png)\n');
    writeFileSync(join(folder, 'notes.txt'), 'extra');
    const r = await publish(folder);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual([...pageFiles(site, slugOf(r)).keys()].sort(), ['img/chart.png', 'index.html', 'notes.txt']);
    assert.match(html(r), /<h1>From readme<\/h1>/);

    writeFileSync(join(folder, 'index.md'), '# From index\n');
    assert.match(html(await publish(folder)), /<h1>From index<\/h1>/);

    writeFileSync(join(folder, 'index.html'), '<!doctype html><title>Hand made</title><p>hi</p>');
    const third = await publish(folder);
    assert.equal(site.docs.get(slugOf(third)).title, 'Hand made');
  });

  test('--title wins, a file with no heading is titled by its name, and --slug republishes at the same link', async () => {
    const f = md('no-heading.md', 'Just a paragraph.\n');
    const a = await publish(f);
    const slug = slugOf(a);
    assert.equal(site.docs.get(slug).title, 'no-heading');
    const b = await publish(f, ['--title', 'Custom title', '--slug', slug]);
    assert.equal(b.code, 0, b.stderr);
    assert.equal(lastLine(b), lastLine(a));
    assert.equal(site.docs.get(slug).title, 'Custom title');
    assert.equal(site.docs.get(slug).version, 2);
  });

  test('raw HTML in Markdown is kept, and the title is escaped', async () => {
    const f = md('raw.md', '# Raw <em>title</em> & more\n\nA <kbd>key</kbd> and 1 < 2.\n');
    const h = html(await publish(f));
    assert.match(h, /<kbd>key<\/kbd>/);
    assert.match(h, /<title>Raw title &amp; more<\/title>/);
  });

  test('temporary pages are cleaned up', () => {
    const tmp = join(ownHome, 'tmp');
    assert.deepEqual(existsSync(tmp) ? readdirSync(tmp).filter((n) => n.startsWith('md-')) : [], []);
  });

  test('a PDF is made from the rendered Markdown page', { skip: !hasChrome && 'no Chrome on this computer' }, async () => {
    const f = md('pdf.md', '# PDF test\n\nhello\n');
    const r = await run(['publish', f], { env: env() });
    assert.equal(r.code, 0, r.stderr);
    assert.ok([...pageFiles(site, slugOf(r)).keys()].some((p) => p.endsWith('.pdf')));
  });

  test('a file that is neither HTML nor Markdown is a usage error', async () => {
    assert.equal((await publish(md('notes.csv', 'a,b'))).code, 2);
  });
});

describe('deploying to a host and copying local pages over', () => {
  let home;
  let stubs;
  let remote;
  let slug;
  const stubEnv = (extra = {}) => localEnv(home, { REDLINE_DEPLOY_DIR: stubs, STUB_URL: remote.url, STUB_KEY: remote.key, STUB_LOG: join(stubs, 'calls.jsonl'), ...extra });
  const calls = () => (existsSync(join(stubs, 'calls.jsonl')) ? readFileSync(join(stubs, 'calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const comment = (h, s, body) => fetch(record(h).url + '/api/' + s + '/comments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body, anchor_text: 'Intro text' }) });

  before(async () => {
    remote = await startMockSite({ key: 'remote-key-0123456789abcdef0123456789abcdef' });
    home = localHome('deploy');
    stubs = temp('deploy-stubs');
    for (const host of ['vercel', 'netlify', 'docker']) {
      writeFileSync(join(stubs, host + '.mjs'), `import { appendFileSync } from 'node:fs';
export async function deploy(opts) {
  appendFileSync(process.env.STUB_LOG, JSON.stringify({ host: '${host}', name: opts.name, yes: opts.yes, key: opts.key, dashboard: opts.dashboard, hasSay: typeof opts.say, siteDir: opts.siteDir }) + '\\n');
  return { url: process.env.STUB_URL, key: process.env.STUB_KEY, dashboard: 'https://x/d/abcdefghij0123456789wxyz/' };
}
`);
    }
    const pub = await run(['publish', page, '--no-pdf'], { env: localEnv(home) });
    slug = slugOf(pub);
    await comment(home, slug, 'Carried over');
  });
  after(async () => { await remote.close(); });

  test('an unknown host is a usage error; a missing deploy module is a plain error', async () => {
    assert.equal((await run(['deploy', 'heroku'], { env: stubEnv() })).code, 2);
    assert.equal((await run(['deploy'], { env: stubEnv() })).code, 2);
    const r = await run(['deploy', 'vercel'], { env: stubEnv({ REDLINE_DEPLOY_DIR: temp('empty-stubs') }) });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Deploying to Vercel is not in this copy/);
  });

  test('without --yes and without a terminal, deploy saves the site and says how to copy the pages', async () => {
    const r = await run(['deploy', 'vercel', '--name', 'my-reviews'], { env: stubEnv() });
    assert.equal(r.code, 0, r.stderr);
    const c = calls().pop();
    assert.equal(c.host, 'vercel');
    assert.equal(c.name, 'my-reviews');
    assert.equal(c.hasSay, 'function');
    assert.match(c.siteDir, /site$/);
    const cfg = localConfig(home);
    assert.equal(cfg.mode, 'remote');
    assert.equal(cfg.host, 'vercel');
    assert.equal(cfg.url, remote.url);
    assert.equal(cfg.key, remote.key);
    assert.equal(cfg.dashboard, 'abcdefghij0123456789wxyz');
    assert.ok(cfg.local.key, 'the local site keeps its own key');
    assert.match(r.stdout, /Site is live: /);
    assert.match(r.stdout, /You have 1 page on this computer\. Copy them.*redline copy/);
    assert.equal(remote.docs.size, 0, 'nothing was copied yet');
    assert.ok(!r.stdout.includes(remote.key), 'the new key is not printed');
  });

  test('commands now talk to the host site, and phone mode is refused', async () => {
    const r = await run(['list'], { env: localEnv(home) });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Nothing is published yet/);
    assert.equal((await run(['phone'], { env: localEnv(home) })).code, 1);
  });

  test('redline copy moves pages, comments and files to the host site, and is safe to run twice', async () => {
    const r = await run(['copy'], { env: localEnv(home) });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Copied 1 page\./);
    assert.ok(remote.docs.has(slug));
    assert.equal(remote.docs.get(slug).title, 'Plan for tests');
    assert.match(pageFiles(remote, slug).get('index.html').data.toString(), /Intro text here/);
    assert.deepEqual(remote.comments.map((c) => c.body), ['Carried over']);
    assert.match((await run(['list'], { env: localEnv(home) })).stdout, /Plan for tests/);
    assert.equal((await run(['copy'], { env: localEnv(home) })).code, 0);
    assert.equal(remote.comments.length, 1, 'a second copy adds nothing twice');
    assert.equal(remote.requests.find((q) => q.path === '/api/import').auth, 'Bearer ' + remote.key, 'the import used the host key');
  });

  test('a page with big files goes over in several requests that each stay under the host limit, bytes intact', async () => {
    const h = localHome('big');
    const folder = temp('big-page');
    writeFileSync(join(folder, 'index.html'), '<!doctype html><title>Big page</title><p>big</p>');
    const a = Buffer.alloc(2 * 1024 * 1024, 7);
    const b = Buffer.alloc(2 * 1024 * 1024, 9);
    writeFileSync(join(folder, 'a.bin'), a);
    writeFileSync(join(folder, 'b.bin'), b);
    const s = slugOf(await run(['publish', folder, '--no-pdf'], { env: localEnv(h) }));
    await comment(h, s, 'On a big page');
    const dest = await startMockSite({ key: 'dest-key-0123456789abcdef0123456789abcdef' });
    try {
      const r = await run(['copy'], { env: { ...localEnv(h), REDLINE_URL: dest.url, REDLINE_KEY: dest.key } });
      assert.equal(r.code, 0, r.stderr);
      assert.ok(dest.imports >= 2, 'more than one request: ' + dest.imports);
      assert.ok(dest.importSizes.every((n) => n < 4.5 * 1024 * 1024), 'sizes: ' + dest.importSizes);
      const files = pageFiles(dest, s);
      assert.deepEqual(files.get('a.bin').data, a);
      assert.deepEqual(files.get('b.bin').data, b);
      assert.deepEqual(dest.comments.map((c) => c.body), ['On a big page']);
    } finally { await dest.close(); }
  });

  test('--yes deploys and copies in one go; --no-copy leaves the pages behind; a repeat keeps key and dashboard', async () => {
    const other = await startMockSite({ key: 'other-key-0123456789abcdef0123456789abcdef' });
    try {
      const h = localHome('deploy2');
      const s = slugOf(await run(['publish', page, '--no-pdf'], { env: localEnv(h) }));
      const e = localEnv(h, { REDLINE_DEPLOY_DIR: stubs, STUB_URL: other.url, STUB_KEY: other.key, STUB_LOG: join(stubs, 'calls.jsonl') });
      const skipped = await run(['deploy', 'netlify', '--yes', '--no-copy'], { env: e });
      assert.equal(skipped.code, 0, skipped.stderr);
      assert.equal(other.docs.size, 0);
      assert.equal(calls().pop().host, 'netlify');
      const done = await run(['setup', 'docker', '--yes'], { env: e }); // setup with a target is deploy
      assert.equal(done.code, 0, done.stderr);
      assert.equal(calls().pop().host, 'docker');
      assert.match(done.stdout, /Copied 1 page\./);
      assert.ok(other.docs.has(s));
      await run(['deploy', 'docker', '--yes', '--no-copy'], { env: e });
      const again = calls().pop();
      assert.equal(again.key, other.key);
      assert.equal(again.dashboard, 'abcdefghij0123456789wxyz');
      const open = await run(['open'], { env: e }); // the page published last now points at the host
      assert.equal(open.stdout.trim(), other.url + '/' + s + '/');
    } finally { await other.close(); }
  });

  test('copy with nothing on this computer, or no host site, says so', async () => {
    const empty = await run(['copy'], { env: { REDLINE_HOME: temp('nothing'), REDLINE_URL: remote.url, REDLINE_KEY: remote.key } });
    assert.equal(empty.code, 1);
    assert.match(empty.stderr, /nothing to copy/);
    const h = localHome('nohost');
    await run(['publish', page, '--no-pdf'], { env: localEnv(h) });
    const r = await run(['copy'], { env: localEnv(h) });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no host site/);
  });
});

describe('Codex and other agents', () => {
  const sharedFrom = (text) => text.slice(text.indexOf('## Before you start'));
  const noHome = () => ({ REDLINE_HOME: temp('x') });

  test('the Claude skill and the shared agent instructions say the same thing', () => {
    const shared = readFileSync(join(ROOT, 'agents', 'redline.md'), 'utf8');
    const skill = readFileSync(join(ROOT, 'skills', 'redline', 'SKILL.md'), 'utf8');
    assert.ok(shared.includes('## Before you start'));
    assert.equal(sharedFrom(skill), sharedFrom(shared));
    assert.ok(skill.includes('${CLAUDE_PLUGIN_ROOT}/cli/redline.mjs'));
    assert.ok(!skill.includes('{{RUN}}'));
    for (const word of ['redline phone', 'redline deploy', '.md', 'redline:decision']) assert.ok(skill.includes(word), word);
  });

  test('install codex writes a skill Codex can load, with a command that works from anywhere', async () => {
    const codex = temp('codex-home');
    const r = await run(['install', 'codex'], { env: { ...noHome(), CODEX_HOME: codex } });
    assert.equal(r.code, 0, r.stderr);
    const file = join(codex, 'skills', 'redline', 'SKILL.md');
    assert.ok(r.stdout.includes(file));
    const text = readFileSync(file, 'utf8');
    assert.match(text, /^---\nname: redline\ndescription: .+\n/);
    assert.match(text, /generated-by: the-redline/);
    assert.ok(text.includes('node "' + join(ROOT, 'cli', 'redline.mjs') + '" <command>'));
    assert.ok(!text.includes('{{RUN}}') && !text.includes('CLAUDE_PLUGIN_ROOT'));
    assert.equal(sharedFrom(text), sharedFrom(readFileSync(join(ROOT, 'agents', 'redline.md'), 'utf8')));
    assert.equal((await run(['install', 'codex'], { env: { ...noHome(), CODEX_HOME: codex } })).code, 0, 'running it again replaces our own file');
  });

  test('install codex --dir, a command override, and a file it did not make', async () => {
    const dir = temp('skills');
    const r = await run(['install', 'codex', '--dir', dir], { env: { ...noHome(), REDLINE_COMMAND: 'npx --yes github:kidusketema/the-redline' } });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(readFileSync(join(dir, 'redline', 'SKILL.md'), 'utf8').includes('`npx --yes github:kidusketema/the-redline <command>`'));
    writeFileSync(join(dir, 'redline', 'SKILL.md'), 'mine');
    const refused = await run(['install', 'codex', '--dir', dir], { env: noHome() });
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /was not made by The Redline/);
    assert.equal(readFileSync(join(dir, 'redline', 'SKILL.md'), 'utf8'), 'mine');
    assert.equal((await run(['install', 'codex', '--dir', dir, '--force'], { env: noHome() })).code, 0);
  });

  test('install agents prints the AGENTS.md block; an unknown agent is a usage error', async () => {
    const r = await run(['install', 'agents'], { env: noHome() });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, readFileSync(join(ROOT, 'agents', 'AGENTS.md'), 'utf8'));
    assert.match(r.stdout, /redline publish plan\.md/);
    assert.equal((await run(['install', 'vim'], { env: noHome() })).code, 2);
  });

  test('the setup skill asks one question and names the right commands', () => {
    const text = readFileSync(join(ROOT, 'skills', 'setup', 'SKILL.md'), 'utf8');
    assert.match(text, /Ask one question/);
    assert.match(text, /On this computer \(recommended\)/);
    for (const host of ['vercel', 'netlify', 'cloudflare', 'docker']) assert.ok(text.includes('cli/redline.mjs" deploy ' + host), host);
    assert.ok(text.includes('cli/redline.mjs" setup\n'));
  });
});
