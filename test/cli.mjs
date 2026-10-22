// Tests for the command line, run against an in-memory copy of the site. Run: node --test test/cli.mjs
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockSite } from './mock-site.mjs';
import { findChrome, parseDatabaseId, parseDatabaseList, parseDeployUrl, parseKvId, parseKvList, parseSlug, parseWhoami } from '../cli/redline.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'cli', 'redline.mjs');
const FAKE_WRANGLER = join(ROOT, 'test', 'fake-wrangler.mjs');
const hasChrome = !!findChrome();
if (!hasChrome) console.log('NOTE: no Chrome, Chromium or Edge found; the PDF and screenshot checks are skipped.');

const temp = (label) => mkdtempSync(join(tmpdir(), 'redline-test-' + label + '-'));
const everything = []; // every byte the CLI printed, to prove the key never shows up

function run(args, { env = {}, input } = {}) {
  const clean = { ...process.env };
  for (const k of Object.keys(clean)) if (k.startsWith('REDLINE_') || k === 'CLOUDFLARE_ACCOUNT_ID') delete clean[k];
  return new Promise((done) => {
    const child = execFile(process.execPath, [CLI, ...args], { env: { ...clean, ...env }, timeout: 180000 }, (err, stdout, stderr) => {
      if (!args.includes('--show')) everything.push(stdout, stderr); // `login --show` is the one place the key is meant to appear
      done({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr });
    });
    child.stdin.end(input || '');
  });
}

let site;
let ownerKey; // the mock's key changes when setup tests install new secrets
let home;
let page; // a local html file used by the publish tests
const env = () => ({ REDLINE_HOME: home, REDLINE_URL: site.url, REDLINE_KEY: site.key });

before(async () => {
  site = await startMockSite();
  ownerKey = site.key;
  home = temp('home');
  page = join(temp('pages'), 'plan.html');
  writeFileSync(page, '<!doctype html><html><head><title>Plan for tests</title></head><body style="min-height:2000px"><h1>Plan</h1><p>Intro text here.</p></body></html>');
});
after(async () => {
  await site.close();
  const joined = everything.join('\n');
  assert.ok(!joined.includes(ownerKey), 'the key must never be printed');
});

describe('help and exit codes', () => {
  for (const c of ['setup', 'deploy', 'copy', 'phone', 'serve', 'stop', 'install', 'update', 'login', 'publish', 'feedback', 'resolve', 'relink', 'list', 'dashboard', 'open', 'delete']) {
    test(`${c} --help`, async () => {
      const r = await run([c, '--help']);
      assert.equal(r.code, 0);
      assert.match(r.stdout, new RegExp('Usage: redline ' + c));
    });
  }
  test('no command prints help and exits 2', async () => {
    const r = await run([]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /Commands:/);
  });
  test('unknown command and unknown option exit 2', async () => {
    assert.equal((await run(['frobnicate'])).code, 2);
    assert.equal((await run(['list', '--nope'], { env: env() })).code, 2);
  });
  test('missing arguments exit 2', async () => {
    const r = await run(['publish'], { env: env() });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /file or folder/);
  });
  test('no site configured and no local server in this copy exits 1 and says what to do', async () => {
    const r = await run(['list'], { env: { REDLINE_HOME: temp('empty'), REDLINE_SERVER_ENTRY: join(temp('nowhere'), 'server.mjs') } });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /local server is missing/);
    assert.match(r.stderr, /redline deploy/);
  });
  test('a saved site address without a key says what to do', async () => {
    const home = temp('nokey');
    writeFileSync(join(home, 'config.json'), JSON.stringify({ url: site.url }));
    const r = await run(['list'], { env: { REDLINE_HOME: home } });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /redline login/);
  });
  test('a wrong key exits 1 without printing it', async () => {
    const r = await run(['list'], { env: { ...env(), REDLINE_KEY: 'definitely-wrong-key' } });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /did not accept the key/);
    assert.ok(!r.stdout.includes('definitely-wrong-key') && !r.stderr.includes('definitely-wrong-key'));
  });
});

describe('parsers', () => {
  test('parseSlug takes a slug or a link', () => {
    const slug = 'abcdefghij0123456789wxyz';
    assert.equal(parseSlug(slug), slug);
    assert.equal(parseSlug(`https://x.workers.dev/${slug}/`), slug);
    assert.equal(parseSlug(`http://127.0.0.1:8787/${slug}?a=1`), slug);
    assert.equal(parseSlug('nope'), null);
  });
  test('parseWhoami reads accounts and sign-in state', () => {
    const table = '\u001b[1m ⛅️ wrangler 4.136.1\u001b[0m\n👋 You are logged in with an OAuth Token.\n┌────┬────┐\n│ Account Name │ Account ID │\n├────┼────┤\n│ Sam\'s Account │ 0123456789abcdef0123456789abcdef │\n└────┴────┘';
    const w = parseWhoami(table);
    assert.equal(w.signedIn, true);
    assert.deepEqual(w.accounts, [{ name: "Sam's Account", id: '0123456789abcdef0123456789abcdef' }]);
    assert.equal(parseWhoami('You are not authenticated. Please run `wrangler login`.').signedIn, false);
  });
  test('parseDeployUrl prefers the workers.dev line', () => {
    const text = 'Uploaded redline (2 sec)\n\u001b[32mDeployed redline triggers (1 sec)\u001b[0m\n  https://reviews.example.com\n  https://redline.sam.workers.dev\nCurrent Version ID: 1';
    assert.equal(parseDeployUrl(text), 'https://redline.sam.workers.dev');
    assert.equal(parseDeployUrl('nothing here'), null);
  });
  test('parseDatabaseId reads TOML and JSON snippets', () => {
    const id = '11111111-2222-4333-8444-555555555555';
    assert.equal(parseDatabaseId(`[[d1_databases]]\nbinding = "DB"\ndatabase_id = "${id}"`), id);
    assert.equal(parseDatabaseId(`{ "database_id": "${id}" }`), id);
    assert.equal(parseDatabaseId('no id'), null);
  });
  test('parseKvId and parseKvList read what wrangler 4 prints for key-value namespaces', () => {
    const id = '0123456789abcdef0123456789abcdef';
    const created = '🌀 Creating namespace with title "redline-files"\n✨ Success!\nTo access your new KV Namespace in your Worker, add the following snippet to your configuration file:\n{\n  "kv_namespaces": [\n    {\n      "binding": "redline_files",\n      "id": "' + id + '"\n    }\n  ]\n}';
    assert.equal(parseKvId(created), id);
    assert.equal(parseKvId('[[kv_namespaces]]\nbinding = "redline_files"\nid = "' + id + '"'), id);
    assert.equal(parseKvId('database_id = "11111111-2222-4333-8444-555555555555"'), null);
    const list = JSON.stringify([{ id: 'ffffffffffffffffffffffffffffffff', title: 'other' }, { id, title: 'redline-files', supports_url_encoding: true }], null, 2);
    assert.equal(parseKvList(list, 'redline-files'), id);
    assert.equal(parseKvList(list, 'nope'), null);
  });
  test('parseDatabaseList finds a database by name', () => {
    const list = JSON.stringify([{ uuid: 'aaaaaaaa-0000-4000-8000-000000000000', name: 'other' }, { uuid: 'bbbbbbbb-0000-4000-8000-000000000000', name: 'redline' }]);
    assert.equal(parseDatabaseList(list, 'redline'), 'bbbbbbbb-0000-4000-8000-000000000000');
    assert.equal(parseDatabaseList(list, 'missing'), null);
  });
});

describe('publish', () => {
  test('a single file', async () => {
    const r = await run(['publish', page, '--no-pdf', '--summary', 'A test', '--tags', 'a, b'], { env: env() });
    assert.equal(r.code, 0, r.stderr);
    const url = r.stdout.trim().split('\n').pop();
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/[a-z0-9]{24}\/$/);
    const slug = url.split('/')[3];
    const doc = site.docs.get(slug);
    assert.equal(doc.title, 'Plan for tests'); // taken from the page's <title>
    assert.deepEqual(doc.tags, ['a', 'b']);
    assert.deepEqual([...doc.versions.get(1).keys()], ['index.html']);
    assert.equal(doc.pdf, null);
    assert.ok(site.requests.filter((q) => q.method === 'PUT').every((q) => q.auth === 'Bearer ' + site.key));
  });

  test('a folder skips dotfiles and node_modules and keeps subfolders', async () => {
    const dir = temp('folder');
    mkdirSync(join(dir, 'img'));
    mkdirSync(join(dir, 'sub'));
    mkdirSync(join(dir, 'node_modules'));
    mkdirSync(join(dir, '.git'));
    writeFileSync(join(dir, 'index.html'), '<html><body><img src="img/a.png"></body></html>');
    writeFileSync(join(dir, 'style.css'), 'body{}');
    writeFileSync(join(dir, 'img', 'a.png'), Buffer.from([137, 80, 78, 71]));
    writeFileSync(join(dir, 'sub', 'page.html'), '<p>x</p>');
    writeFileSync(join(dir, '.env'), 'SECRET=1');
    writeFileSync(join(dir, 'node_modules', 'x.js'), '1');
    writeFileSync(join(dir, '.git', 'config'), '1');
    const r = await run(['publish', dir, '--title', 'Folder test', '--no-pdf'], { env: env() });
    assert.equal(r.code, 0, r.stderr);
    const slug = r.stdout.trim().split('/').slice(-2)[0];
    const files = site.docs.get(slug).versions.get(1);
    assert.deepEqual([...files.keys()].sort(), ['img/a.png', 'index.html', 'style.css', 'sub/page.html']);
    assert.equal(files.get('style.css').type, 'text/css; charset=utf-8');
    assert.equal(files.get('img/a.png').type, 'image/png');
    assert.equal(site.docs.get(slug).title, 'Folder test');
  });

  test('a folder without index.html fails', async () => {
    const dir = temp('noindex');
    writeFileSync(join(dir, 'other.html'), '<p>x</p>');
    const r = await run(['publish', dir, '--title', 'x'], { env: env() });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no index\.html/);
  });

  test('a file that is not HTML is a usage error', async () => {
    const f = join(temp('txt'), 'notes.txt');
    writeFileSync(f, 'hi');
    assert.equal((await run(['publish', f], { env: env() })).code, 2);
  });

  test('makes a PDF with local Chrome and uploads it', { skip: !hasChrome && 'no Chrome on this computer' }, async () => {
    const r = await run(['publish', page, '--title', 'PDF Test'], { env: env() });
    assert.equal(r.code, 0, r.stderr);
    const slug = r.stdout.trim().split('/').slice(-2)[0];
    const doc = site.docs.get(slug);
    assert.equal(doc.pdf, 'pdf-test.pdf');
    assert.equal(doc.versions.get(1).get('pdf-test.pdf').data.subarray(0, 4).toString(), '%PDF');
  });

  test('the PDF counts toward the 300 file limit, and temp files stay in the Redline folder', { skip: !hasChrome && 'no Chrome on this computer' }, async () => {
    const dir = temp('many');
    writeFileSync(join(dir, 'index.html'), '<title>Many</title><p>x</p>');
    mkdirSync(join(dir, 'f'));
    for (let i = 0; i < 299; i++) writeFileSync(join(dir, 'f', i + '.txt'), 'x');
    const h = temp('limit-home');
    const e = { ...env(), REDLINE_HOME: h };
    assert.equal((await run(['publish', dir, '--no-pdf'], { env: e })).code, 0); // exactly 300 files
    const withPdf = await run(['publish', dir], { env: e }); // the PDF makes 301
    assert.equal(withPdf.code, 1);
    assert.match(withPdf.stderr, /limit is 300/);
    const left = existsSync(join(h, 'tmp')) ? readdirSync(join(h, 'tmp')) : [];
    assert.deepEqual(left, [], 'Chrome profile and PDF folders are removed');
  });

  test('--slug publishes a new version at the same link and keeps feedback', async () => {
    const first = await run(['publish', page, '--no-pdf'], { env: env() });
    const slug = first.stdout.trim().split('/').slice(-2)[0];
    site.addComment(slug, { body: 'Keep me' });
    const second = await run(['publish', page, '--no-pdf', '--slug', first.stdout.trim().split('\n').pop(), '--title', 'Plan v2'], { env: env() }); // a full link works as the slug
    assert.equal(second.code, 0, second.stderr);
    assert.match(second.stdout, /version 2 at the same link/);
    assert.ok(second.stdout.includes('/' + slug + '/'));
    assert.equal(site.docs.get(slug).version, 2);
    assert.equal(site.comments.filter((c) => c.doc_slug === slug).length, 1);
  });
});

describe('feedback', () => {
  let slug;
  let link;
  before(async () => {
    const r = await run(['publish', page, '--no-pdf', '--title', 'Feedback test'], { env: env() });
    link = r.stdout.trim().split('\n').pop();
    slug = link.split('/')[3];
    const early = new Date(Date.now() - 3600 * 1000).toISOString();
    site.addComment(slug, { body: 'Too vague.\nName a date.', anchor_kind: 'text', anchor_text: 'Intro   text', anchor_context: 'the ⟦Intro text⟧ here', author_label: 'Ana', created_at: early });
    site.addComment(slug, { body: 'Is this box needed?', anchor_kind: 'svg', anchor_text: 'Email service', anchor_data: JSON.stringify({ fig: 1, label: 'Figure 1' }), author_label: 'Ana' });
    site.addComment(slug, { body: 'Crop this', anchor_kind: 'pin', anchor_data: { x: 40, y: 60, t: 'img', label: 'chart' }, anchor_context: 'the chart', author_label: 'Ben' });
    site.addComment(slug, { body: 'General note on the whole thing', author_label: 'Ben' });
    site.addComment(slug, { body: 'Already handled', resolved: 1 });
    const meta = { ty: 'pen', hz: 240, co: 2, fr: 1, p0: 10, p1: 80, cx: 0, pm: 1 };
    const stroke = (extra) => ({ a: { k: 'p', t: 'Intro text here.', i: 2 }, c: 'red', w: 30, p: [0, 0, 50, 100, 100, 60], tx: 'Intro text', vw: 900, m: meta, ...extra });
    site.addInk(slug, stroke({}), { author_label: 'Ana' });
    site.addInk(slug, stroke({ c: 'hl' }), { author_label: 'Ana' });
    site.addInk(slug, { a: { k: 'svg', t: 'Figure 1', i: 5 }, c: 'blue', w: 30, p: [0, 0, 50, 90, 90, 50], tx: '', vw: 900 }, { author_label: 'Ben' });
    site.addDecision(slug, { item: 'doc', verdict: 'approve', author_label: 'Ana', created_at: early });
    site.addDecision(slug, { item: 'doc', verdict: 'reject', note: 'Needs a date first', author_label: 'Ana' });
    site.addDecision(slug, { item: 'scope', verdict: 'unsure', author_label: 'Ben' });
  });

  test('prints decisions, comments and pen marks as text', async () => {
    const r = await run(['feedback', link], { env: env() });
    assert.equal(r.code, 0, r.stderr);
    const out = r.stdout;
    assert.match(out, /Feedback test {2}\[[a-z0-9]{24}\] {2}version 1 {2}4 open comments, 3 pen marks in 2 places, 2 decisions/);
    assert.match(out, /^Version 1\. So far: 1 confirmed, 4 still open\.$/m);
    assert.match(out, /Whole document: Rejected {2}\(Ana,/); // the later decision wins
    assert.ok(!out.includes('Whole document: Approved'));
    assert.match(out, /"Needs a date first"/);
    assert.match(out, /Section "scope": Not sure/);
    assert.match(out, /on: "Intro text"\n {2}context: the ⟦Intro text⟧ here\n {2}> Too vague\.\n {2}> Name a date\./);
    assert.match(out, /on: text in a diagram \(Figure 1\): "Email service"/);
    assert.match(out, /on: pin at 40%, 60% of img - the chart/);
    assert.match(out, /on: \(the whole document\)/);
    assert.ok(!out.includes('Already handled'));
    assert.match(out, /Pencil input: 2 strokes, about 240 samples\/s, 2 per event, pressure 10-80, 2 with sub-pixel positions, 0 cut short by the browser, 2 drawn with the toolbar closed/);
    assert.match(out, /\[1\] 2 strokes \(red pen, highlighter\) {2}Ana/);
    assert.match(out, /on p: "Intro text here\."\n {2}covers: "Intro text"/);
    assert.match(out, /\[2\] 1 stroke \(blue pen\) {2}Ben/);
    assert.match(out, /on figure: "Figure 1"/);
  });

  test('control characters from readers never reach the screen', async () => {
    const sneaky = 'Looks fine\u001b[31m RED\u001b[0m\u0007 \u202eevil\r\ttabbed';
    site.addComment(slug, { body: sneaky, author_label: 'Eve\u001b]0;pwned\u0007' });
    for (const args of [['feedback', slug], ['feedback', slug, '--json']]) {
      const r = await run(args, { env: env() });
      assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202e]/.test(r.stdout), 'no control characters in ' + args.join(' '));
      assert.ok(r.stdout.includes('Looks fine'));
    }
    site.comments.pop(); // leave the other tests' counts alone
  });

  test('--json prints the raw data', async () => {
    const r = await run(['feedback', slug, '--json'], { env: env() });
    const data = JSON.parse(r.stdout);
    assert.equal(data.comments.length, 4);
    assert.equal(data.ink.length, 3);
    assert.equal(data.decisions.length, 2); // newest per item, like the real site
    assert.equal(data.doc.title, 'Feedback test');
  });

  test('--since leaves out older feedback', async () => {
    const r = await run(['feedback', slug, '--json', '--since', new Date(Date.now() - 60000).toISOString()], { env: env() });
    const data = JSON.parse(r.stdout);
    assert.ok(!data.comments.some((c) => c.body.startsWith('Too vague')));
    assert.equal(data.decisions.length, 2);
    assert.equal((await run(['feedback', slug, '--since', 'yesterday-ish'], { env: env() })).code, 2);
  });

  test('with no link it uses the page published last', async () => {
    const home2 = temp('recent');
    const e = { ...env(), REDLINE_HOME: home2 };
    const pub = await run(['publish', page, '--no-pdf', '--title', 'Recent one'], { env: e });
    assert.equal(pub.code, 0, pub.stderr);
    const r = await run(['feedback'], { env: e });
    assert.match(r.stdout, /Recent one/);
    assert.match(r.stdout, /No feedback yet/);
  });

  test('an unknown page is a plain error', async () => {
    const r = await run(['feedback', 'zzzzzzzzzzzzzzzzzzzzzzzz'], { env: env() });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /unknown page/);
  });

  test('--shots saves one picture per marked place', { skip: !hasChrome && 'no Chrome on this computer' }, async () => {
    const dir = join(temp('shots'), 'out');
    const r = await run(['feedback', link, '--shots', dir], { env: env() });
    assert.equal(r.code, 0, r.stderr);
    const files = [...r.stdout.matchAll(/screenshot: (.+\.png)/g)].map((m) => m[1]);
    assert.equal(files.length, 2);
    for (const f of files) {
      assert.ok(existsSync(f), f);
      const png = readFileSync(f);
      assert.equal(png.subarray(1, 4).toString(), 'PNG');
      assert.equal(png.readUInt32BE(16), 1800); // 900 px wide as drawn, at twice the pixels
      assert.ok(png.readUInt32BE(20) >= 120);
    }
    assert.match(r.stdout, /Look at each screenshot/);
  });
});

describe('resolve, list, delete', () => {
  let slug;
  let commentId;
  before(async () => {
    const r = await run(['publish', page, '--no-pdf', '--title', 'Housekeeping'], { env: env() });
    slug = r.stdout.trim().split('/').slice(-2)[0];
    commentId = site.addComment(slug, { body: 'Fix the intro' }).id;
    site.addInk(slug, { a: { k: 'p', t: 'x', i: 0 }, c: 'red', w: 30, p: [0, 0, 50, 1, 1, 50], tx: '', vw: 900 });
    site.addDecision(slug, { item: 'doc', verdict: 'approve' });
  });

  test('resolve marks the comment fixed, with the note, and feedback shows it waiting for the reader', async () => {
    const r = await run(['resolve', slug, String(commentId), '--note', 'Rewrote the intro with a date'], { env: env() });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, new RegExp('#' + commentId + ' as fixed'));
    assert.deepEqual(site.statusCalls.at(-1).body, { resolved: true, note: 'Rewrote the intro with a date' });
    const fb = JSON.parse((await run(['feedback', slug, '--json'], { env: env() })).stdout);
    assert.equal(fb.comments.length, 1);
    assert.equal(fb.comments[0].status, 'fixed');
    assert.equal(fb.comments[0].fix_note, 'Rewrote the intro with a date');
    const text = (await run(['feedback', slug], { env: env() })).stdout;
    assert.match(text, /^Version 1\. So far: 1 fixed and waiting for you\.$/m);
    assert.match(text, /Marked fixed, waiting for the reader\n\n#\d+ /);
    assert.match(text, /marked fixed in version 1: "Rewrote the intro with a date"\. Waiting for the reader to confirm\./);
    assert.equal((await run(['resolve', slug, 'abc'], { env: env() })).code, 2);
    assert.equal((await run(['resolve', slug, String(commentId), '--note', '  '], { env: env() })).code, 2);
    // Without a note it still works.
    const bare = await run(['resolve', slug, String(commentId)], { env: env() });
    assert.equal(bare.code, 0, bare.stderr);
    assert.deepEqual(site.statusCalls.at(-1).body, { resolved: true });
  });

  test('list shows counts and decisions', async () => {
    const r = await run(['list'], { env: env() });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Housekeeping\n {2}http:\/\/127\.0\.0\.1:\d+\/[a-z0-9]{24}\//);
    assert.match(r.stdout, /0 open comments, 1 marked fixed, 1 pen mark, whole document: Approved\n {2}New feedback since the last publish/);
    const json = JSON.parse((await run(['list', '--json'], { env: env() })).stdout);
    assert.ok(Array.isArray(json) && json.some((d) => d.slug === slug));
  });

  test('open prints the full link', async () => {
    const r = await run(['open', slug], { env: env() });
    assert.equal(r.stdout.trim(), site.url + '/' + slug + '/');
  });

  test('delete needs --yes', async () => {
    const refused = await run(['delete', slug], { env: env() });
    assert.equal(refused.code, 2);
    assert.match(refused.stderr, /--yes/);
    assert.ok(site.docs.has(slug));
    const done = await run(['delete', slug, '--yes'], { env: env() });
    assert.equal(done.code, 0, done.stderr);
    assert.ok(!site.docs.has(slug));
    assert.equal(site.ink.filter((m) => m.doc_slug === slug).length, 0);
  });
});

describe('revisions: fixed, confirmed, changed text, new links', () => {
  let slug;
  let link;
  before(async () => {
    const first = await run(['publish', page, '--no-pdf', '--title', 'Revisions'], { env: env() });
    link = first.stdout.trim().split('\n').pop();
    slug = link.split('/')[3];
    for (let v = 2; v <= 3; v++) assert.equal((await run(['publish', page, '--no-pdf', '--slug', slug], { env: env() })).code, 0);
    assert.equal(site.docs.get(slug).version, 3);
    site.addComment(slug, { body: 'Name the owner', status: 'fixed', fix_note: 'Added Sam as owner', fixed_version: 3 });
    site.addComment(slug, { body: 'Cut the second slide', status: 'fixed', fix_note: '', fixed_version: 3 });
    site.addComment(slug, { body: 'Typo in heading', status: 'done' });
    site.addComment(slug, { body: 'Still wrong', status: 'open', reopened: true, fix_note: 'Reworded', fixed_at: new Date().toISOString() });
    site.addDecision(slug, { item: 'scope', verdict: 'approve', author_label: 'Ana', version: 2, stale: true });
    site.addDecision(slug, { item: 'budget', verdict: 'approve', author_label: 'Ana', version: 3, stale: false });
    site.addInk(slug, { a: { k: 'p', t: 'Intro text here.', i: 2 }, c: 'red', w: 30, p: [0, 0, 50, 100, 100, 60], tx: 'Intro', vw: 900 }, { stale: true });
    site.addInk(slug, { a: { k: 'p', t: 'Other', i: 3 }, c: 'red', w: 30, p: [0, 0, 50, 100, 100, 60], tx: '', vw: 900 }, { stale: false });
  });

  test('the header says where things stand', async () => {
    const r = await run(['feedback', slug], { env: env() });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^Version 3\. Since version 2: 2 fixed and waiting for you, 1 confirmed, 1 still open, 1 decision needs another look, 1 pen mark is on text that changed\.$/m);
    assert.match(r.stdout, /Marked fixed, waiting for the reader/);
    assert.match(r.stdout, /marked fixed in version 3: "Added Sam as owner"\. Waiting for the reader to confirm\./);
    assert.match(r.stdout, /the reader sent this back after it was marked fixed \("Reworded"\)\. It is still open\./);
    assert.match(r.stdout, /Section "scope": Approved {2}\(Ana, [^)]*on version 2\)\n {4}Needs a fresh decision: the text under it changed/);
    assert.ok(!/Section "budget".*\n {4}Needs a fresh decision/.test(r.stdout), 'a current decision is not flagged');
    assert.match(r.stdout, /on p: "Intro text here\."\n {2}covers: "Intro"\n {2}this paragraph changed after the reader drew on it/);
    assert.ok(!/on p: "Other"\n(.*\n)*? {2}this paragraph changed/.test(r.stdout.split('Pen marks')[1].split('\n[2]')[1] || ''), 'the untouched mark is not flagged');
  });

  test('--json carries the states and the flags', async () => {
    const data = JSON.parse((await run(['feedback', slug, '--json'], { env: env() })).stdout);
    assert.deepEqual(data.comments.map((c) => c.status).sort(), ['fixed', 'fixed', 'open']); // confirmed ones are only counted
    assert.equal(data.decisions.find((d) => d.item === 'scope').stale, true);
    assert.equal(data.ink.filter((m) => m.stale).length, 1);
  });

  test('--changes lists what changed since the version before', async () => {
    const none = await run(['feedback', slug, '--changes'], { env: env() });
    assert.match(none.stdout, /Changes\n {2}Nothing to compare with/);
    site.changes = { [slug]: { version: 3, from: 2, available: true, items: [{ t: 'The new budget is 40k', k: 'changed', w: 'The budget is 30k' }, { t: 'A brand new risk', k: 'new' }], removed: [{ t: 'An old caveat' }] } };
    const r = await run(['feedback', slug, '--changes'], { env: env() });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Changes in version 3 since version 2: 2 blocks changed or new, 1 block removed\n {2}changed: "The new budget is 40k"\n {11}was: "The budget is 30k"\n {2}new: {5}"A brand new risk"\n {2}removed: "An old caveat"/);
    const json = JSON.parse((await run(['feedback', slug, '--changes', '--json'], { env: env() })).stdout);
    assert.equal(json.changes.items.length, 2);
  });

  test('list counts the states and flags answers that need another look', async () => {
    const r = await run(['list'], { env: env() });
    assert.match(r.stdout, new RegExp(slug + '/\\n.*version 3\\n {2}1 open comment, 2 marked fixed, 1 confirmed, 2 pen marks, scope: Approved \\(needs another look\\); budget: Approved'));
  });

  test('relink gives the page a new link and says the old one stops working', async () => {
    const r = await run(['relink', link], { env: env() });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /new link, and the old one no longer works/);
    const next = r.stdout.trim().split('\n').find((l) => l.startsWith(site.url + '/'));
    assert.ok(next && !next.includes(slug), next);
    const newSlug = next.split('/')[3];
    assert.match(newSlug, /^[a-z0-9]{24}$/);
    assert.equal(site.docs.has(slug), false);
    assert.equal(site.comments.filter((c) => c.doc_slug === newSlug).length >= 4, true, 'comments came along');
    assert.equal((await run(['feedback', slug], { env: env() })).code, 1);
    assert.equal((await run(['feedback', newSlug], { env: env() })).code, 0);
    // Owner key only.
    assert.equal((await run(['relink', newSlug], { env: { ...env(), REDLINE_KEY: 'wrong-key-wrong-key-wrong' } })).code, 1);
    assert.equal((await run(['relink', 'not-a-link'], { env: env() })).code, 2);
  });
});

describe('config, login and environment', () => {
  test('login takes the key from the environment, a pipe or a prompt, never the command line', async () => {
    const h = temp('login');
    const bad = await run(['login', site.url], { env: { REDLINE_HOME: h, REDLINE_KEY: 'wrong-key' } });
    assert.equal(bad.code, 1);
    assert.ok(!existsSync(join(h, 'config.json')));

    // A key typed after the address would end up in shell history, so it is refused.
    const argv = await run(['login', site.url, site.key], { env: { REDLINE_HOME: h } });
    assert.equal(argv.code, 2);
    assert.match(argv.stderr, /shell history/);
    assert.ok(!existsSync(join(h, 'config.json')));

    const ok = await run(['login', site.url + '/', '--dashboard', site.url + '/d/abcdefghij0123456789wxyz/'], { env: { REDLINE_HOME: h, REDLINE_KEY: site.key } });
    assert.equal(ok.code, 0, ok.stderr);
    const file = join(h, 'config.json');
    if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
    const cfg = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(cfg.url, site.url);
    assert.equal(cfg.key, site.key);
    assert.equal(cfg.dashboard, 'abcdefghij0123456789wxyz');
    assert.ok(!ok.stdout.includes(site.key));

    // The saved file alone is enough for the other commands.
    assert.equal((await run(['list'], { env: { REDLINE_HOME: h } })).code, 0);
    const dash = await run(['dashboard'], { env: { REDLINE_HOME: h } });
    assert.equal(dash.stdout.trim(), site.url + '/d/abcdefghij0123456789wxyz/');

    const piped = temp('login-pipe');
    const viaPipe = await run(['login', site.url], { env: { REDLINE_HOME: piped }, input: site.key + '\n' });
    assert.equal(viaPipe.code, 0, viaPipe.stderr);
    assert.equal(JSON.parse(readFileSync(join(piped, 'config.json'), 'utf8')).key, site.key);

    const show = await run(['login', '--show'], { env: { REDLINE_HOME: h } });
    assert.match(show.stdout, new RegExp('^Site: +' + site.url.replace(/[.]/g, '\\.') + '\\nKey: +' + site.key + '\\n', 'm'));
    assert.match(show.stdout, /1\. Run: redline login http\S+/);
    assert.match(show.stdout, /2\. Paste the key above/);
    assert.ok(!/redline login \S+ [0-9a-f]{20,}/.test(show.stdout), 'the key must not be part of a command line');
  });

  test('dashboard without a token says what to do', async () => {
    const r = await run(['dashboard'], { env: { REDLINE_HOME: temp('nodash'), REDLINE_URL: site.url, REDLINE_KEY: site.key } });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /login --show/);
  });

  test('REDLINE_URL and REDLINE_KEY override the saved file', async () => {
    const h = temp('override');
    writeFileSync(join(h, 'config.json'), JSON.stringify({ url: 'http://127.0.0.1:1', key: 'stale-key' }));
    assert.equal((await run(['list'], { env: { REDLINE_HOME: h } })).code, 1);
    const r = await run(['list'], { env: { REDLINE_HOME: h, REDLINE_URL: site.url, REDLINE_KEY: site.key } });
    assert.equal(r.code, 0, r.stderr);
  });
});

describe('setup with a fake wrangler', () => {
  let repo;
  let hSetup;
  let stateFile;
  const baseEnv = () => ({
    REDLINE_HOME: hSetup, REDLINE_WRANGLER: FAKE_WRANGLER, FAKE_WRANGLER_STATE: stateFile, FAKE_WRANGLER_URL: site.url,
  });
  const cliCopy = () => join(repo, 'cli', 'redline.mjs');
  const state = () => JSON.parse(readFileSync(stateFile, 'utf8'));
  const runCopy = (args, e) => new Promise((done) => {
    const clean = { ...process.env };
    for (const k of Object.keys(clean)) if (k.startsWith('REDLINE_') || k === 'CLOUDFLARE_ACCOUNT_ID') delete clean[k];
    const child = execFile(process.execPath, [cliCopy(), ...args], { env: { ...clean, ...e }, timeout: 180000 }, (err, stdout, stderr) => {
      everything.push(stdout, stderr);
      done({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr });
    });
    child.stdin.end();
  });

  before(() => {
    // A pretend checkout: the real CLI and sample page next to a tiny site folder, so setup copies something.
    repo = temp('repo');
    mkdirSync(join(repo, 'cli'));
    mkdirSync(join(repo, 'examples'));
    mkdirSync(join(repo, 'site', 'src'), { recursive: true });
    cpSync(join(ROOT, 'cli'), join(repo, 'cli'), { recursive: true });
    cpSync(join(ROOT, 'examples', 'sample-plan.html'), join(repo, 'examples', 'sample-plan.html'));
    writeFileSync(join(repo, 'site', 'package.json'), JSON.stringify({ name: 'fake-site', version: '0.0.0', private: true }));
    writeFileSync(join(repo, 'site', 'schema.sql'), 'CREATE TABLE IF NOT EXISTS docs (slug TEXT);');
    writeFileSync(join(repo, 'site', 'src', 'worker.js'), 'export default {};');
    writeFileSync(join(repo, 'site', 'wrangler.template.jsonc'), '{ "name": "__NAME__", "d1_databases": [{ "binding": "DB", "database_name": "__NAME__", "database_id": "__DATABASE_ID__" }], "kv_namespaces": [{ "binding": "FILES", "id": "__KV_ID__" }] }');
    hSetup = temp('setup-home');
    stateFile = join(temp('wrangler-state'), 'state.json');
  });

  test('first run: signs in, creates everything, saves a private config, publishes the sample', async () => {
    const r = await runCopy(['deploy', 'cloudflare', '--yes'], baseEnv());
    assert.equal(r.code, 0, r.stderr + r.stdout);
    for (const line of ['Signing in to Cloudflare (a browser window will open)...', 'Setting up the database...', 'Created database redline', 'Created file storage redline-files', 'Creating the database tables...', 'Putting the site online', 'Waiting for the address', 'Site is live: ' + site.url, 'Publishing a sample plan']) {
      assert.ok(r.stdout.includes(line), 'missing line: ' + line + '\n' + r.stdout);
    }
    const cfg = JSON.parse(readFileSync(join(hSetup, 'config.json'), 'utf8'));
    if (process.platform !== 'win32') assert.equal(statSync(join(hSetup, 'config.json')).mode & 0o777, 0o600);
    assert.equal(cfg.url, site.url);
    assert.match(cfg.key, /^[0-9a-f]{48}$/);
    assert.match(cfg.dashboard, /^[a-z0-9]{24}$/);
    assert.equal(cfg.worker, 'redline');
    assert.equal(cfg.account, '0123456789abcdef0123456789abcdef');
    assert.ok(!r.stdout.includes(cfg.key) && !r.stderr.includes(cfg.key));
    assert.ok(r.stdout.includes('/d/' + cfg.dashboard + '/'));

    const s = state();
    assert.equal(s.secrets.PUBLISH_KEY, cfg.key); // the key reached wrangler through the secrets file
    assert.ok(!s.calls.some((c) => c.includes(cfg.key)), 'the key must not be on a command line');
    assert.equal(s.schemaApplied, 1);
    assert.match(s.build, /^BUILD:[0-9a-f]{10}$/); // the page-layer cache id travels with every deploy
    const wranglerConfig = readFileSync(join(hSetup, 'site', 'wrangler.jsonc'), 'utf8');
    assert.ok(wranglerConfig.includes(s.databases[0].id));
    assert.equal(s.namespaces[0].title, 'redline-files');
    assert.ok(wranglerConfig.includes(s.namespaces[0].id));
    assert.equal(cfg.kv, s.namespaces[0].id);
    assert.ok(!s.calls.some((c) => /^(d1|kv namespace) create/.test(c) && !c.includes('--no-update-config')));
    assert.ok(!wranglerConfig.includes('__'));
    assert.equal(site.docs.size >= 1, true);
    const sampleSlug = JSON.parse(readFileSync(join(hSetup, 'config.json'), 'utf8')).sample;
    assert.ok(site.docs.has(sampleSlug));
  });

  test('second run keeps the key, dashboard, database and sample link', async () => {
    const before1 = JSON.parse(readFileSync(join(hSetup, 'config.json'), 'utf8'));
    const r = await runCopy(['deploy', 'cloudflare', '--yes'], baseEnv());
    assert.equal(r.code, 0, r.stderr + r.stdout);
    assert.ok(r.stdout.includes('Using the existing database redline'));
    assert.ok(!r.stdout.includes('Signing in to Cloudflare'));
    const after1 = JSON.parse(readFileSync(join(hSetup, 'config.json'), 'utf8'));
    assert.equal(after1.key, before1.key);
    assert.equal(after1.dashboard, before1.dashboard);
    assert.equal(after1.sample, before1.sample);
    const s = state();
    assert.equal(s.databases.length, 1);
    assert.equal(s.namespaces.length, 1);
    assert.ok(r.stdout.includes('Using the existing file storage redline-files'));
    assert.equal(s.deploys, 2);
    assert.equal(s.calls.filter((c) => c.startsWith('d1 create')).length, 1);
    assert.equal(site.docs.get(after1.sample).version, 2);
  });

  test('update redeploys without touching data', async () => {
    const r = await runCopy(['update'], baseEnv());
    assert.equal(r.code, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /Site updated/);
    assert.equal(state().deploys, 3);
  });

  test('setup on a second computer after login keeps the existing key and dashboard', async () => {
    const first = JSON.parse(readFileSync(join(hSetup, 'config.json'), 'utf8'));
    const h2 = temp('second-computer');
    writeFileSync(join(h2, 'config.json'), JSON.stringify({ url: first.url, key: first.key, dashboard: first.dashboard })); // what `redline login` leaves
    const r = await runCopy(['deploy', 'cloudflare', '--yes'], { ...baseEnv(), REDLINE_HOME: h2 });
    assert.equal(r.code, 0, r.stderr + r.stdout);
    const cfg = JSON.parse(readFileSync(join(h2, 'config.json'), 'utf8'));
    assert.equal(cfg.key, first.key);
    assert.equal(cfg.dashboard, first.dashboard);
    assert.equal(state().secrets.PUBLISH_KEY, first.key);
    assert.equal(state().databases.length, 1);
    assert.equal(state().namespaces.length, 1);
  });

  test('update keeps a saved address that still answers, and falls back to the deployed one when it is dead', async () => {
    const saved = JSON.parse(readFileSync(join(hSetup, 'config.json'), 'utf8'));
    const keepHome = temp('update-keep');
    writeFileSync(join(keepHome, 'config.json'), JSON.stringify(saved));
    const kept = await runCopy(['update'], { ...baseEnv(), REDLINE_HOME: keepHome, FAKE_WRANGLER_PRINT_URL: 'https://redline.sam-example.workers.dev' });
    assert.equal(kept.code, 0, kept.stderr + kept.stdout);
    assert.ok(kept.stdout.includes('Site is live: ' + site.url));
    assert.equal(JSON.parse(readFileSync(join(keepHome, 'config.json'), 'utf8')).url, site.url);

    const deadHome = temp('update-dead');
    writeFileSync(join(deadHome, 'config.json'), JSON.stringify({ ...saved, url: 'http://127.0.0.1:1' }));
    const moved = await runCopy(['update'], { ...baseEnv(), REDLINE_HOME: deadHome });
    assert.equal(moved.code, 0, moved.stderr + moved.stdout);
    assert.equal(JSON.parse(readFileSync(join(deadHome, 'config.json'), 'utf8')).url, site.url);
  });

  test('an older wrangler without --secrets-file still gets the secrets', async () => {
    const h = temp('old-home');
    const st = join(temp('old-state'), 'state.json');
    const r = await runCopy(['deploy', 'cloudflare', '--yes'], { ...baseEnv(), REDLINE_HOME: h, FAKE_WRANGLER_STATE: st, FAKE_WRANGLER_OLD: '1' });
    assert.equal(r.code, 0, r.stderr + r.stdout);
    const s = JSON.parse(readFileSync(st, 'utf8'));
    assert.ok(s.calls.some((c) => c.startsWith('secret bulk')));
    assert.ok(s.calls.filter((c) => c.startsWith('deploy')).every((c) => c.includes('--var BUILD:')));
    assert.equal(s.secrets.PUBLISH_KEY, JSON.parse(readFileSync(join(h, 'config.json'), 'utf8')).key);
  });

  test('several Cloudflare accounts: fails with a plain hint, then works when one is chosen', async () => {
    const h = temp('multi-home');
    const st = join(temp('multi-state'), 'state.json');
    const e = { ...baseEnv(), REDLINE_HOME: h, FAKE_WRANGLER_STATE: st, FAKE_WRANGLER_ACCOUNTS: '2' };
    const refused = await runCopy(['deploy', 'cloudflare', '--yes'], e);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /CLOUDFLARE_ACCOUNT_ID/);
    const ok = await runCopy(['deploy', 'cloudflare', '--yes'], { ...e, CLOUDFLARE_ACCOUNT_ID: 'fedcba9876543210fedcba9876543210' });
    assert.equal(ok.code, 0, ok.stderr + ok.stdout);
    assert.equal(JSON.parse(readFileSync(join(h, 'config.json'), 'utf8')).account, 'fedcba9876543210fedcba9876543210');
  });

  test('a failing step prints what failed and exits 1', async () => {
    const h = temp('fail-home');
    const r = await runCopy(['deploy', 'cloudflare', '--yes'], { ...baseEnv(), REDLINE_HOME: h, FAKE_WRANGLER_STATE: join(temp('fail-state'), 'state.json'), FAKE_WRANGLER_FAIL: 'deploy' });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /^Error: The site could not be put online\.\n.*Cloudflare API failed/s);
    assert.match(r.stderr, /Run "redline deploy cloudflare" again/);
    assert.ok(!existsSync(join(h, 'config.json')));
  });

  test('wrangler missing entirely is reported, not mistaken for a sign-out', async () => {
    const r = await runCopy(['deploy', 'cloudflare', '--yes'], { ...baseEnv(), REDLINE_HOME: temp('nowrangler-home'), REDLINE_WRANGLER: join(temp('nowhere'), 'missing.mjs') });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Could not ask Cloudflare who is signed in/);
  });

  test('a bad site name is a usage error', async () => {
    assert.equal((await runCopy(['deploy', 'cloudflare', '--name', 'Bad Name'], baseEnv())).code, 2);
  });

  after(() => {
    for (const d of [repo]) rmSync(d, { recursive: true, force: true });
  });
});
