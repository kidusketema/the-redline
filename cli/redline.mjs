#!/usr/bin/env node
// The Redline command line. No dependencies, Node 22 or newer (helpers live in ./lib, vendored libraries in ./vendor).
// Run `redline --help` for the commands.
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync,
  readFileSync, realpathSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import {
  CliError, REPO_ROOT, spawnTool, UsageError, configFile, normalizeUrl, randomToken, readConfig, readJson, recentFile, saveConfig, sleep,
  stateDir, stripAnsi, writePrivate,
} from './lib/common.mjs';
import {
  ensureServer, hasLocalSite, localSettings, saveLocal, serveForeground, stopServer, wifiUrl, lanAddress, readServerRecord,
} from './lib/local.mjs';
import { renderQr } from './lib/qr.mjs';
import { isRelativeLink, renderMarkdown } from './lib/markdown.mjs';

const WRANGLER_VERSION = '4.136.1';
const SLUG_RE = /^[a-z0-9]{24}$/;
const LIMITS = { files: 300, fileBytes: 25 * 1024 * 1024, totalBytes: 60 * 1024 * 1024 };

// ---------------------------------------------------------------- errors and output

// Page feedback is written by anyone with the link, so control characters (terminal escapes, bidi tricks) never reach the screen.
// Newlines and tabs stay.
const clean = (s) => String(s).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '');
const cleanDeep = (v) => {
  if (typeof v === 'string') return clean(v);
  if (Array.isArray(v)) return v.map(cleanDeep);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cleanDeep(x)]));
  return v;
};
const say = (line = '') => console.log(clean(line));
const when = (iso) => {
  const d = new Date(iso);
  return isNaN(d) ? String(iso || '') : d.toISOString().replace('T', ' ').slice(0, 16) + 'Z';
};
const plural = (n, one, many = one + 's') => n + ' ' + (n === 1 ? one : many);

// ---------------------------------------------------------------- config and state

// Temp folders live inside ~/.redline (private, and visible to sandboxed browsers such as Snap Chromium, which cannot see /tmp).
// Names are random, and anything over a day old is swept away.
function tempDir(prefix) {
  const root = join(stateDir(), 'tmp');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  for (const name of readdirSync(root)) {
    try { if (Date.now() - statSync(join(root, name)).mtimeMs > 24 * 3600 * 1000) rmSync(join(root, name), { recursive: true, force: true }); } catch { /* already gone */ }
  }
  return mkdtempSync(join(root, prefix));
}

// Where commands send their work. Environment variables win over the saved file, so a CI job or a second site can be used
// without touching it. Otherwise a saved host site is used when the mode is "remote" (or was never set, as in 0.1), and the
// site on this computer is used in every other case; it is started here if it is not running.
async function connection({ needKey = true } = {}) {
  const cfg = readConfig();
  if (process.env.REDLINE_URL || ((cfg.mode || 'remote') === 'remote' && cfg.url)) {
    const url = normalizeUrl(process.env.REDLINE_URL || cfg.url);
    const key = process.env.REDLINE_KEY || cfg.key || '';
    if (!url) throw new CliError('The saved site address is not a web address.', 'Run "redline login <url>" to save a good one.');
    if (needKey && !key) throw new CliError('This computer has the site address but not the key.', 'Run "redline login <url>" and paste the key from the computer where you ran setup.');
    return { url, key, cfg, local: false };
  }
  const server = await ensureServer();
  return { url: server.url, key: server.key, cfg: { ...cfg, dashboard: server.dashboard }, local: true, server };
}

export function parseSlug(arg) {
  if (!arg) return null;
  if (SLUG_RE.test(arg)) return arg;
  const m = /\/([a-z0-9]{24})(?:[/?#]|$)/.exec(arg);
  return m ? m[1] : null;
}

// A full link carries its own site address; a bare slug uses the saved site; no argument means the page published last.
async function target(arg) {
  const recent = readJson(recentFile());
  const given = arg || (recent && recent.slug);
  if (!given) throw new UsageError('Give a link or a slug. Nothing has been published from this computer yet.');
  const slug = parseSlug(given);
  if (!slug) throw new UsageError('That is not a Redline link or slug: ' + given);
  const origin = /^https?:\/\//i.test(given) ? new URL(given).origin : '';
  const base = origin || (!arg && recent && normalizeUrl(recent.url)) || (await connection({ needKey: false })).url;
  return { slug, base };
}

// ---------------------------------------------------------------- talking to the site

async function request(base, method, path, { key, json, body, contentType } = {}) {
  const headers = {};
  if (key) headers.Authorization = 'Bearer ' + key;
  let payload = body;
  if (json !== undefined) { payload = JSON.stringify(json); headers['Content-Type'] = 'application/json'; }
  else if (contentType) headers['Content-Type'] = contentType;
  let res;
  try {
    res = await fetch(base + path, { method, headers, body: payload, signal: AbortSignal.timeout(120000) });
  } catch {
    throw new CliError('Could not reach ' + base + '.', 'Check your internet connection and the site address, then try again.');
  }
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  if (!res.ok) {
    if (res.status === 401) throw new CliError('The site did not accept the key.', 'Run "redline login <url>" and paste the right key.');
    if (res.status === 404 && !(data && data.error)) throw new CliError('The site has no such page or document.', 'Check the link, or run "redline list" to see what is published.');
    throw new CliError(clean((data && data.error) || 'The site answered with an error (HTTP ' + res.status + ').'), 'Try again in a minute.');
  }
  return data;
}

const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');

// ---------------------------------------------------------------- argument parsing

function parseArgs(spec, argv) {
  const opts = {};
  const args = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { args.push(...argv.slice(i + 1)); break; }
    if (!a.startsWith('--')) { args.push(a); continue; }
    const eq = a.indexOf('=');
    const name = eq < 0 ? a.slice(2) : a.slice(2, eq);
    const type = spec.options[name];
    if (!type) throw new UsageError('Unknown option --' + name + '. Try "redline ' + spec.name + ' --help".');
    if (type === 'bool') { opts[name] = true; continue; }
    if (eq >= 0) { opts[name] = a.slice(eq + 1); continue; }
    const next = argv[i + 1];
    if (type === 'optional') {
      // `--shots [dir]`: a following word is the folder unless it looks like a link or slug.
      opts[name] = next !== undefined && !next.startsWith('--') && !parseSlug(next) ? argv[++i] : '';
    } else {
      if (next === undefined || next.startsWith('--')) throw new UsageError('--' + name + ' needs a value.');
      opts[name] = argv[++i];
    }
  }
  if (args.length < spec.min) throw new UsageError('Missing ' + spec.missing + '. Try "redline ' + spec.name + ' --help".');
  if (args.length > spec.max) throw new UsageError('Unexpected extra argument: ' + args[spec.max]);
  return { opts, args };
}

// ---------------------------------------------------------------- Chrome

export function findChrome() {
  if (process.env.REDLINE_CHROME) return existsSync(process.env.REDLINE_CHROME) ? process.env.REDLINE_CHROME : null;
  const fixed = [];
  if (process.platform === 'darwin') {
    for (const app of ['Google Chrome', 'Chromium', 'Microsoft Edge', 'Brave Browser']) fixed.push(`/Applications/${app}.app/Contents/MacOS/${app}`);
  } else if (process.platform === 'win32') {
    const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean);
    for (const r of roots) {
      fixed.push(join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'));
      fixed.push(join(r, 'Chromium', 'Application', 'chrome.exe'));
      fixed.push(join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    }
  } else {
    const names = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge'];
    for (const dir of (process.env.PATH || '').split(delimiter)) for (const n of names) fixed.push(join(dir, n));
  }
  return fixed.find((p) => existsSync(p)) || null;
}

const NO_CHROME = 'No Chrome, Chromium or Edge was found on this computer.';

function launchChrome(chrome, extra) {
  const profile = tempDir('chrome-');
  const args = ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions', '--mute-audio', `--user-data-dir=${profile}`, ...extra];
  // Chrome refuses to start as root without this (common in containers).
  if (typeof process.getuid === 'function' && process.getuid() === 0) args.push('--no-sandbox');
  const proc = spawn(chrome, args, { stdio: 'ignore' });
  let done = false;
  const exited = new Promise((r) => { proc.once('exit', r); proc.once('error', r); }).then(() => { done = true; });
  const cleanup = async () => {
    proc.kill();
    await Promise.race([exited, sleep(3000)]);
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
  return { exited, profile, cleanup, hasExited: () => done };
}

// Prints a local page to PDF the way a person would: headless Chrome, no header or footer.
async function makePdf(chrome, htmlFile) {
  const out = join(tempDir('pdf-'), 'page.pdf');
  const run = launchChrome(chrome, ['--no-pdf-header-footer', `--print-to-pdf=${out}`, pathToFileURL(htmlFile).href]);
  try {
    // Stop waiting when Chrome exits, or when the file is there and has stopped growing (Chrome can linger after writing it).
    let last = -1;
    await waitFor(async () => {
      if (run.hasExited()) return true;
      const size = existsSync(out) ? statSync(out).size : 0;
      const stable = size > 0 && size === last;
      last = size;
      return stable;
    }, 60000, 200);
    const data = existsSync(out) ? readFileSync(out) : null;
    return data && data.subarray(0, 4).toString() === '%PDF' ? data : null;
  } finally {
    await run.cleanup();
    rmSync(dirname(out), { recursive: true, force: true });
  }
}

// A tiny DevTools-protocol client over Node's built-in WebSocket, enough to open a page and take screenshots.
class Cdp {
  constructor(url) { this.url = url; this.n = 0; this.waiting = new Map(); }
  async open() {
    this.ws = new WebSocket(this.url);
    await new Promise((ok, bad) => { this.ws.addEventListener('open', ok); this.ws.addEventListener('error', () => bad(new Error('Could not talk to Chrome.'))); });
    this.ws.addEventListener('message', (m) => {
      const d = JSON.parse(m.data);
      const w = d.id && this.waiting.get(d.id);
      if (!w) return;
      this.waiting.delete(d.id);
      if (d.error) w.bad(new Error(d.error.message)); else w.ok(d.result);
    });
  }
  send(method, params = {}) {
    return new Promise((ok, bad) => {
      const id = ++this.n;
      this.waiting.set(id, { ok, bad });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('The page raised an error while it was being read.');
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch { /* already closed */ } }
}

async function waitFor(fn, ms, step = 250) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(step);
  }
}

// Opens the live page at the width the marks were drawn at and saves one PNG per group of marks.
async function shootGroups({ chrome, pageUrl, width, groups, dir }) {
  const run = launchChrome(chrome, ['--remote-debugging-port=0', '--hide-scrollbars', 'about:blank']);
  let cdp;
  try {
    const portFile = join(run.profile, 'DevToolsActivePort');
    const port = await waitFor(() => existsSync(portFile) && Number(readFileSync(portFile, 'utf8').split('\n')[0]), 20000);
    if (!port) throw new Error('Chrome did not start.');
    const tab = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
    cdp = new Cdp(tab.webSocketDebuggerUrl);
    await cdp.open();
    await cdp.send('Page.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 2, mobile: false });
    // Red ink reads best on the light version of a page, and twice the pixels keep small handwriting legible.
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    await cdp.send('Page.navigate', { url: pageUrl });
    const loaded = await waitFor(() => cdp.eval('document.readyState === "complete"'), 30000);
    if (!loaded) throw new Error('The page did not finish loading.');
    await cdp.eval('document.fonts ? document.fonts.ready.then(() => true) : true');
    const boxes = await waitFor(async () => {
      const b = await cdp.eval('window.__REDLINE_INK ? window.__REDLINE_INK.boxes() : []');
      return b && b.length ? b : null;
    }, 15000);
    if (!boxes) throw new Error('The pen marks never appeared on the page.');
    const byId = new Map(boxes.map((b) => [b.id, b]));
    const pageHeight = await cdp.eval('Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)');
    mkdirSync(dir, { recursive: true });
    const files = [];
    for (let i = 0; i < groups.length; i++) {
      const found = groups[i].marks.map((m) => byId.get(m.id)).filter(Boolean);
      if (!found.length) continue;
      const y0 = Math.max(0, Math.min(...found.map((b) => b.y)) - 90);
      const y1 = Math.min(pageHeight, Math.max(...found.map((b) => b.y + b.h)) + 90);
      const shot = await cdp.send('Page.captureScreenshot', {
        format: 'png', captureBeyondViewport: true,
        clip: { x: 0, y: y0, width, height: Math.max(120, y1 - y0), scale: 1 },
      });
      const file = join(dir, 'marks-' + String(i + 1).padStart(2, '0') + '.png');
      writeFileSync(file, Buffer.from(shot.data, 'base64'));
      files[i] = file;
    }
    return files;
  } finally {
    if (cdp) cdp.close();
    await run.cleanup();
  }
}

// ---------------------------------------------------------------- publishing

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.csv': 'text/csv; charset=utf-8',
  '.xml': 'application/xml', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.map': 'application/json',
};
const contentType = (file) => MIME[extname(file).toLowerCase()] || 'application/octet-stream';

// Every regular file under a folder, without dotfiles, node_modules or links (so nothing outside the folder sneaks in).
function walk(dir, prefix = '') {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith('.') || name === 'node_modules') continue;
    const abs = join(dir, name);
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) out.push(...walk(abs, prefix + name + '/'));
    else if (st.isFile()) out.push({ path: prefix + name, abs, size: st.size });
  }
  return out;
}

function checkLimits(files) {
  const total = files.reduce((n, f) => n + f.size, 0);
  const big = files.find((f) => f.size > LIMITS.fileBytes);
  if (big) throw new CliError(big.path + ' is larger than 25 MB.', 'Shrink it or leave it out of the folder.');
  if (files.length > LIMITS.files) throw new CliError('The page has ' + files.length + ' files; the limit is ' + LIMITS.files + '.', 'Publish a smaller folder.');
  if (total > LIMITS.totalBytes) throw new CliError('The files add up to more than 60 MB.', 'Shrink the images or leave some files out, or publish with --no-pdf.');
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|svg)$/i;
const MARKDOWN_EXT = /\.(md|markdown)$/i;

// The Markdown page of a folder: index.md, or README.md when there is none (any capitalisation).
function markdownEntry(dir) {
  const names = readdirSync(dir);
  for (const want of ['index.md', 'readme.md']) {
    const hit = names.find((n) => n.toLowerCase() === want && lstatSync(join(dir, n)).isFile());
    if (hit) return join(dir, hit);
  }
  return null;
}

// Renders Markdown to a page in a private temporary folder, next to the pictures it uses, and returns that folder.
// Pictures are found relative to the Markdown file. Only image files are picked up, so a document cannot pull in other files.
function stageMarkdown({ mdFile, baseDir, folderFiles, note }) {
  const stage = tempDir('md-');
  try {
    const assets = new Map(); // path on the site -> file on disk
    const outsideNames = new Map(); // a picture outside the folder gets one name however often it is used
    let missing = 0;
    const rewriteImage = (href) => {
      let rel = href.split(/[?#]/)[0];
      try { rel = decodeURI(rel); } catch { /* keep as written */ }
      const abs = resolve(baseDir, rel);
      let st;
      try { st = lstatSync(abs); } catch { missing++; return null; }
      if (!st.isFile() || !IMAGE_EXT.test(abs)) return null;
      let inside = relative(baseDir, abs).split(sep).join('/');
      if (inside.startsWith('..') || isAbsolute(inside) || inside.split('/').some((p) => p.startsWith('.'))) {
        if (!outsideNames.has(abs)) outsideNames.set(abs, 'images/' + (outsideNames.size + 1) + '-' + basename(abs));
        inside = outsideNames.get(abs);
      }
      assets.set(inside, abs);
      return encodePath(inside);
    };
    const fallbackTitle = basename(folderFiles ? baseDir : mdFile).replace(MARKDOWN_EXT, '');
    const page = renderMarkdown(readFileSync(mdFile, 'utf8'), { rewriteImage, fallbackTitle });
    if (missing) note(plural(missing, 'picture') + ' in the Markdown ' + (missing === 1 ? 'was' : 'were') + ' not found next to the file and will show as broken.');
    writeFileSync(join(stage, 'index.html'), page.html);
    const put = (path, abs) => { mkdirSync(dirname(join(stage, path)), { recursive: true }); cpSync(abs, join(stage, path)); };
    for (const f of folderFiles || []) if (f.abs !== mdFile) put(f.path, f.abs);
    for (const [path, abs] of assets) put(path, abs);
    return { stage, fallbackTitle, decisions: page.decisions };
  } catch (e) {
    rmSync(stage, { recursive: true, force: true });
    throw e;
  }
}

function collectFiles(input, note = () => {}) {
  const abs = resolve(input);
  if (!existsSync(abs)) throw new CliError('Nothing exists at ' + input + '.', 'Check the path and try again.');
  let files;
  let entryAbs;
  let fallbackTitle = basename(abs).replace(/\.html?$/i, '');
  let cleanup = () => {};
  if (lstatSync(abs).isDirectory()) {
    files = walk(abs);
    if (files.some((f) => f.path === 'index.html')) {
      entryAbs = join(abs, 'index.html');
    } else {
      const md = markdownEntry(abs);
      if (!md) throw new CliError('The folder ' + input + ' has no index.html, index.md or README.md.', 'Rename the main page to index.html (or index.md), or publish that one file.');
      const staged = stageMarkdown({ mdFile: md, baseDir: abs, folderFiles: files, note });
      cleanup = () => rmSync(staged.stage, { recursive: true, force: true });
      files = walk(staged.stage);
      entryAbs = join(staged.stage, 'index.html');
      fallbackTitle = staged.fallbackTitle;
    }
  } else if (MARKDOWN_EXT.test(abs)) {
    const staged = stageMarkdown({ mdFile: abs, baseDir: dirname(abs), note });
    cleanup = () => rmSync(staged.stage, { recursive: true, force: true });
    files = walk(staged.stage);
    entryAbs = join(staged.stage, 'index.html');
    fallbackTitle = staged.fallbackTitle;
  } else {
    if (!/\.html?$/i.test(abs)) throw new UsageError('Publish needs an .html or .md file, or a folder with an index.html or index.md.');
    files = [{ path: 'index.html', abs, size: lstatSync(abs).size }];
    entryAbs = abs;
  }
  try { checkLimits(files); } catch (e) { cleanup(); throw e; }
  return { files, entryAbs, fallbackTitle, cleanup };
}

function pageTitle(file) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(readFileSync(file, 'utf8'));
  return m ? m[1].replace(/\s+/g, ' ').trim() : '';
}

// Uploads a version, makes it live and checks the link answers. Returns {slug, version, url}.
async function publishDoc(options) {
  const { url: base, key, local, server } = await connection();
  const collected = collectFiles(options.input, options.note || say);
  try {
    const r = await publishCollected({ ...options, base, key, collected });
    return { ...r, local, server };
  } finally {
    collected.cleanup();
  }
}

async function publishCollected({ title, summary, project, tags, slug, pdf = true, note = say, base, key, collected }) {
  const { files, entryAbs, fallbackTitle } = collected;
  const docTitle = title || pageTitle(entryAbs) || fallbackTitle;

  let pdfName = null;
  let pdfData = null;
  if (pdf) {
    const chrome = findChrome();
    if (!chrome) {
      note(NO_CHROME + ' Publishing without a PDF; the Download PDF button will open the print dialog instead.');
    } else {
      note('Making a PDF of the page...');
      pdfData = await makePdf(chrome, entryAbs);
      if (pdfData) {
        const stem = docTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'page';
        pdfName = files.some((f) => f.path === stem + '.pdf') ? 'redline-' + stem + '.pdf' : stem + '.pdf';
        checkLimits([...files, { path: pdfName, size: pdfData.length }]); // the PDF counts toward the same limits
      } else {
        note('Chrome could not make a PDF of the page. Publishing without one.');
      }
    }
  }

  const tagList = tags ? String(tags).split(',').map((t) => t.trim()).filter(Boolean) : undefined;
  const created = await request(base, 'POST', '/api/docs', { key, json: { title: docTitle, summary, project, tags: tagList, slug } });
  const root = '/api/docs/' + created.slug + '/v/' + created.version;
  let uploaded = 0;
  for (const f of files) {
    await request(base, 'PUT', root + '/files/' + encodePath(f.path), { key, body: readFileSync(f.abs), contentType: contentType(f.path) });
    uploaded++;
  }
  if (pdfData) await request(base, 'PUT', root + '/files/' + encodePath(pdfName), { key, body: pdfData, contentType: 'application/pdf' });
  const done = await request(base, 'POST', root + '/commit', { key, json: { entry: 'index.html', pdf: pdfName || undefined } });

  const link = (done && done.url) || created.url || base + '/' + created.slug + '/';
  let status;
  try { status = (await fetch(link, { signal: AbortSignal.timeout(30000) })).status; } catch { status = 0; }
  if (status !== 200) throw new CliError('The page was uploaded, but its link did not open (' + (status || 'no answer') + ').', 'Wait a minute and open ' + link + ' again.');

  writePrivate(recentFile(), { slug: created.slug, url: base, title: docTitle, at: new Date().toISOString() });
  return { slug: created.slug, version: created.version, url: link, title: docTitle, files: uploaded, pdf: !!pdfData };
}

// ---------------------------------------------------------------- feedback

const COLOR_NAME = { red: 'red pen', blue: 'blue pen', black: 'black pen', hl: 'highlighter' };
const VERDICT = { approve: 'Approved', reject: 'Rejected', unsure: 'Not sure' };

const anchorData = (c) => {
  if (c.anchor_data && typeof c.anchor_data === 'object') return c.anchor_data;
  try { return c.anchor_data ? JSON.parse(c.anchor_data) : {}; } catch { return {}; }
};
const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim();

// Marks on the same block (paragraph, list item, heading, figure) form one group, in page order.
function groupInk(ink) {
  const groups = new Map();
  for (const m of ink) {
    const a = (m.data && m.data.a) || {};
    const key = a.k + '|' + a.i + '|' + a.t;
    if (!groups.has(key)) groups.set(key, { anchor: a, marks: [] });
    groups.get(key).marks.push(m);
  }
  return [...groups.values()].sort((x, y) => (x.anchor.i || 0) - (y.anchor.i || 0));
}

function latestDecisions(decisions) {
  const latest = new Map();
  for (const d of decisions) latest.set(d.item, d);
  return [...latest.values()];
}

// open: needs work. fixed: marked fixed, waiting for the reader to say so. done: the reader confirmed. (A site from before the three states
// only says resolved.)
const statusOf = (c) => c.status || (c.resolved ? 'done' : 'open');

// "Version 3. Since version 2: 2 fixed and waiting for you, 1 confirmed, 1 still open, 1 decision needs another look."
export function feedbackHeader(version, comments, decisions, ink) {
  const count = (s) => comments.filter((c) => statusOf(c) === s).length;
  const fixed = count('fixed'), done = count('done'), open = count('open');
  const redo = latestDecisions(decisions).filter((d) => d.stale).length;
  const moved = ink.filter((m) => m.stale).length;
  const parts = [];
  if (fixed) parts.push(fixed + ' fixed and waiting for you');
  if (done) parts.push(done + ' confirmed');
  if (open) parts.push(open + ' still open');
  if (redo) parts.push(redo + (redo === 1 ? ' decision needs' : ' decisions need') + ' another look');
  if (moved) parts.push(moved + (moved === 1 ? ' pen mark is' : ' pen marks are') + ' on text that changed');
  const head = version ? 'Version ' + version + '.' + (version > 1 ? ' Since version ' + (version - 1) + ':' : ' So far:') : 'Feedback:';
  return head + ' ' + (parts.length ? parts.join(', ') : 'nothing yet') + '.';
}

function printChanges(ch) {
  if (!ch || !ch.available) { say('\nChanges\n  Nothing to compare with: this is the first version, or the earlier one was published before changes were recorded.'); return; }
  say('\nChanges in version ' + ch.version + ' since version ' + ch.from + ': ' + plural(ch.items.length, 'block') + ' changed or new, ' + plural(ch.removed.length, 'block') + ' removed');
  for (const it of ch.items) {
    say('  ' + (it.k === 'new' ? 'new:     ' : 'changed: ') + '"' + oneLine(it.t) + '"');
    if (it.w) say('           was: "' + oneLine(it.w) + '"');
  }
  for (const r of ch.removed) say('  removed: "' + oneLine(r.t) + '"');
}

function printComment(c) {
  say('\n#' + c.id + '  ' + (c.author_label || 'Anonymous') + '  ' + when(c.created_at));
  const d = anchorData(c);
  const kind = c.anchor_kind || (c.anchor_text ? 'text' : 'general');
  if (kind === 'pin') {
    say('  on: pin at ' + d.x + '%, ' + d.y + '% of ' + (d.t || 'a picture') + (c.anchor_context || d.label ? ' - ' + (c.anchor_context || d.label) : ''));
  } else if (kind === 'svg') {
    say('  on: text in a diagram (' + (d.label || d.fig || 'unnamed') + '): "' + oneLine(c.anchor_text) + '"');
    if (c.anchor_context) say('  context: ' + oneLine(c.anchor_context));
  } else if (c.anchor_text) {
    say('  on: "' + oneLine(c.anchor_text) + '"');
    if (c.anchor_context) say('  context: ' + oneLine(c.anchor_context));
  } else {
    say('  on: (the whole document)');
  }
  say(String(c.body).split('\n').map((l) => '  > ' + l).join('\n'));
  if (statusOf(c) === 'fixed') {
    say('  marked fixed' + (c.fixed_version ? ' in version ' + c.fixed_version : '') + (c.fix_note ? ': "' + oneLine(c.fix_note) + '"' : '') + '. Waiting for the reader to confirm.');
  } else if (c.reopened) {
    say('  the reader sent this back after it was marked fixed' + (c.fix_note ? ' ("' + oneLine(c.fix_note) + '")' : '') + '. It is still open.');
  }
}

// How the device delivered Pencil input; saved with each stroke so the ink can be tuned against real hardware.
function pencilLine(ink) {
  const pen = ink.map((m) => m.data && m.data.m).filter((m) => m && m.ty === 'pen');
  if (!pen.length) return null;
  const mid = (k) => {
    const v = pen.map((m) => m[k]).filter((x) => x > 0).sort((a, b) => a - b);
    return v.length ? v[Math.floor(v.length / 2)] : 0;
  };
  return 'Pencil input: ' + pen.length + ' strokes, about ' + mid('hz') + ' samples/s, ' + mid('co') + ' per event, pressure ' +
    Math.min(...pen.map((m) => m.p0 || 100)) + '-' + Math.max(...pen.map((m) => m.p1)) + ', ' +
    pen.filter((m) => m.fr).length + ' with sub-pixel positions, ' + pen.filter((m) => m.cx).length + ' cut short by the browser, ' +
    pen.filter((m) => m.pm).length + ' drawn with the toolbar closed';
}

async function cmdFeedback({ opts, args }) {
  const { slug, base } = await target(args[0]);
  let since = null;
  if (opts.since !== undefined) {
    since = new Date(opts.since);
    if (isNaN(since)) throw new UsageError('--since needs a date like 2026-10-22 or 2026-10-22T14:00:00Z.');
  }
  const data = cleanDeep(await request(base, 'GET', '/api/' + slug + '/feedback'));
  const newer = (r) => !since || new Date(r.created_at) > since;
  // Comments that are marked fixed are always shown: they wait for the reader whatever their age. Confirmed ones are only counted.
  const everything = data.comments || [];
  const comments = everything.filter((c) => (statusOf(c) === 'open' && newer(c)) || statusOf(c) === 'fixed');
  const open = comments.filter((c) => statusOf(c) === 'open'), fixedList = comments.filter((c) => statusOf(c) === 'fixed');
  const ink = (data.ink || []).filter((m) => m.data && newer(m));
  const decisions = (data.decisions || []).filter((d) => newer(d) || d.stale);
  const groups = groupInk(ink);
  const doc = data.doc || { slug };
  const header = feedbackHeader(doc.version, everything, data.decisions || [], data.ink || []);
  const changes = opts.changes ? cleanDeep(await request(base, 'GET', '/api/' + slug + '/changes')) : null;

  let shots = [];
  let shotNote = '';
  if (opts.shots !== undefined && groups.length) {
    const chrome = findChrome();
    if (!chrome) {
      shotNote = '(screenshots skipped: ' + NO_CHROME + ' Install Google Chrome and try again.)';
    } else {
      const widths = {};
      for (const m of ink) if (m.data.vw) widths[m.data.vw] = (widths[m.data.vw] || 0) + 1;
      const width = Number(Object.keys(widths).sort((a, b) => widths[b] - widths[a])[0]) || 1280;
      const dir = opts.shots ? resolve(opts.shots) : tempDir('shots-');
      try { shots = await shootGroups({ chrome, pageUrl: base + '/' + slug + '/', width, groups, dir }); }
      catch (e) { shotNote = '(screenshots skipped: ' + e.message + ')'; }
    }
  }

  if (opts.json) {
    say(JSON.stringify({
      doc, comments, ink, decisions, summary: data.summary, ...(changes ? { changes } : {}),
      shots: shots.map((file, i) => file && { file, marks: groups[i].marks.map((m) => m.id) }).filter(Boolean),
    }, null, 2));
    if (shotNote) console.error(shotNote);
    return;
  }

  say((doc.title || slug) + '  [' + slug + ']' + (doc.version ? '  version ' + doc.version : '') + '  ' +
    plural(open.length, 'open comment') + ', ' + plural(ink.length, 'pen mark') + ' in ' + plural(groups.length, 'place') + ', ' +
    plural(latestDecisions(decisions).length, 'decision'));
  say(header);

  const latest = latestDecisions(decisions);
  if (latest.length) {
    say('\nDecisions');
    for (const d of latest) {
      say('  ' + (d.item === 'doc' ? 'Whole document' : 'Section "' + d.item + '"') + ': ' + (VERDICT[d.verdict] || d.verdict) +
        '  (' + (d.author_label || 'Anonymous') + ', ' + when(d.created_at) + (d.version ? ', on version ' + d.version : '') + ')');
      if (d.stale) say('    Needs a fresh decision: the text under it changed after this answer, so it does not cover what is there now.');
      if (d.note) say('    "' + oneLine(d.note) + '"');
    }
  }
  if (fixedList.length) { say('\nMarked fixed, waiting for the reader'); fixedList.forEach(printComment); }
  if (open.length) { say('\nComments'); open.forEach(printComment); }
  if (ink.length) {
    say('\nPen marks');
    const pencil = pencilLine(ink);
    if (pencil) say(pencil);
    groups.forEach((g, i) => {
      const a = g.anchor;
      const first = g.marks[0];
      const last = g.marks[g.marks.length - 1];
      const kinds = [...new Set(g.marks.map((m) => COLOR_NAME[m.data.c] || m.data.c))].join(', ');
      say('\n[' + (i + 1) + '] ' + plural(g.marks.length, 'stroke') + ' (' + kinds + ')  ' + (first.author_label || 'Anonymous') + '  ' +
        when(first.created_at) + (last !== first ? ' to ' + when(last.created_at).slice(11) : ''));
      say('  on ' + (['img', 'svg', 'figure'].includes(a.k) ? 'figure' : a.k) + ': "' + (a.t || '') + (a.t && a.t.length >= 80 ? '...' : '') + '"');
      for (const w of new Set(g.marks.map((m) => (m.data.tx || '').trim()).filter(Boolean))) say('  covers: "' + w + '"');
      if (g.marks.some((m) => m.stale)) say('  this paragraph changed after the reader drew on it');
      if (shots[i]) say('  screenshot: ' + shots[i]);
    });
  }
  if (!comments.length && !ink.length && !latest.length) say('\nNo feedback yet' + (since ? ' since ' + when(since.toISOString()) : '') + '.');
  if (changes) printChanges(changes);
  if (shotNote) say('\n' + shotNote);
  if (shots.length) say('\nLook at each screenshot: handwriting and arrows exist only in the picture.');
}

// ---------------------------------------------------------------- the other site commands

async function cmdPublish({ opts, args }) {
  const slug = opts.slug === undefined ? undefined : parseSlug(opts.slug);
  if (opts.slug !== undefined && !slug) throw new UsageError('--slug needs the page\'s slug or its link: ' + opts.slug);
  const r = await publishDoc({
    input: args[0], title: opts.title, summary: opts.summary, project: opts.project, tags: opts.tags, slug, pdf: !opts['no-pdf'],
  });
  say(slug ? 'Published version ' + r.version + ' at the same link.' : 'Published "' + r.title + '".');
  say(r.url);
  const wifi = r.local && r.server.network ? wifiUrl(r.url, r.server.port) : '';
  if (wifi) say('On your iPad or phone, on the same Wi-Fi:\n' + wifi);
}

async function cmdResolve({ opts, args }) {
  const { slug, base } = await target(args[0]);
  if (!/^[0-9]{1,12}$/.test(args[1])) throw new UsageError('The comment number must be a whole number, like 12.');
  if (opts.note !== undefined && (!opts.note.trim() || opts.note.length > 500)) throw new UsageError('--note needs a short note of what you changed (up to 500 characters).');
  // The older "resolve" call is used on purpose: sites from before the three states understand it too (and ignore the note).
  await request(base, 'POST', '/api/' + slug + '/comments/' + args[1] + '/resolve', { json: { resolved: true, ...(opts.note ? { note: opts.note.trim() } : {}) } });
  say('Marked comment #' + args[1] + ' as fixed. The reader sees it with' + (opts.note ? ' your note and' : '') + ' two buttons: Looks good, or Not fixed.');
}

async function cmdRelink({ args }) {
  const slug = parseSlug(args[0]);
  if (!slug) throw new UsageError('That is not a slug or link: ' + args[0]);
  const { url, key } = await connection();
  const r = await request(url, 'POST', '/api/docs/' + slug + '/relink', { key });
  const recent = readJson(recentFile());
  if (recent && recent.slug === slug) writePrivate(recentFile(), { ...recent, slug: r.slug });
  say('The page has a new link, and the old one no longer works.');
  say(r.url || url + '/' + r.slug + '/');
  say('Its comments, pen marks and decisions came with it. Send the new link to anyone who should still have it.');
}

async function cmdList({ opts }) {
  const { url, key } = await connection();
  const data = cleanDeep(await request(url, 'GET', '/api/docs', { key }));
  const docs = data.docs || [];
  if (opts.json) { say(JSON.stringify(docs, null, 2)); return; }
  if (!docs.length) { say('Nothing is published yet. Publish a page with "redline publish <file>".'); return; }
  for (const d of docs) {
    const decisions = (d.decisions || []).map((x) => (x.item === 'doc' ? 'whole document' : x.item) + ': ' + (VERDICT[x.verdict] || x.verdict) + (x.stale ? ' (needs another look)' : ''));
    say('\n' + d.title);
    say('  ' + url + '/' + d.slug + '/');
    say('  Updated ' + when(d.updated_at) + ', version ' + d.version);
    say('  ' + plural(d.open_comments || 0, 'open comment') + (d.fixed_comments ? ', ' + d.fixed_comments + ' marked fixed' : '') + (d.done_comments ? ', ' + d.done_comments + ' confirmed' : '') +
      ', ' + plural(d.ink_strokes || 0, 'pen mark') +
      (decisions.length ? ', ' + decisions.join('; ') : ', no decision yet'));
    if (d.new_feedback) say('  New feedback since the last publish');
  }
}

async function cmdDelete({ opts, args }) {
  const slug = parseSlug(args[0]);
  if (!slug) throw new UsageError('That is not a slug or link: ' + args[0]);
  if (!opts.yes) throw new UsageError('This permanently deletes the page, its comments, pen marks and decisions. Add --yes to go ahead.');
  const { url, key } = await connection();
  await request(url, 'DELETE', '/api/docs/' + slug, { key });
  say('Deleted ' + slug + '.');
}

async function cmdDashboard() {
  const { url, cfg, local, server } = await connection({ needKey: false });
  if (!cfg.dashboard) throw new CliError('This computer does not know the dashboard link.', 'Run "redline login --show" on the computer where you ran setup to get it.');
  say(url + '/d/' + encodeURIComponent(cfg.dashboard) + '/');
  const wifi = local && server.network ? wifiUrl(url + '/d/' + encodeURIComponent(cfg.dashboard) + '/', server.port) : '';
  if (wifi) say('On your iPad or phone, on the same Wi-Fi:\n' + wifi);
}

async function cmdOpen({ args }) {
  const { slug, base } = await target(args[0]);
  say(base + '/' + slug + '/');
  const rec = readServerRecord();
  const wifi = rec && rec.network && base === rec.url ? wifiUrl(base + '/' + slug + '/', rec.port) : '';
  if (wifi) say('On your iPad or phone, on the same Wi-Fi:\n' + wifi);
}

// Reads a line without showing it, for pasting the key.
function askHidden(question) {
  return new Promise((done) => {
    process.stdout.write(question);
    let value = '';
    const finish = () => { process.stdin.setRawMode(false); process.stdin.pause(); process.stdin.off('data', onData); process.stdout.write('\n'); };
    const onData = (chunk) => {
      for (const c of String(chunk)) {
        if (c === '\r' || c === '\n' || c === '\u0004') { finish(); return done(value.trim()); }
        if (c === '\u0003') { finish(); process.exit(130); }
        value = c === '\u007f' || c === '\b' ? value.slice(0, -1) : value + c;
      }
    };
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', onData);
  });
}

async function readAll(stream) {
  let text = '';
  for await (const chunk of stream) text += chunk;
  return text;
}

// The key never travels on the command line (it would sit in shell history): environment, then a pipe, then a hidden prompt.
async function readKey() {
  if (process.env.REDLINE_KEY) return process.env.REDLINE_KEY.trim();
  if (!process.stdin.isTTY) return (await readAll(process.stdin)).trim();
  return askHidden('Paste the key (nothing shows as you type) and press Enter: ');
}

async function cmdLogin({ opts, args }) {
  if (opts.show) {
    const found = await connection();
    const { key, cfg } = found;
    const url = found.local && found.server.network ? (wifiUrl(found.url + '/', found.server.port) || found.url).replace(/\/$/, '') : found.url;
    say('Site:      ' + url);
    say('Key:       ' + key);
    if (cfg.dashboard) say('Dashboard: ' + url + '/d/' + encodeURIComponent(cfg.dashboard) + '/');
    say('\nTo use this site from another computer:');
    say('  1. Run: redline login ' + url + (cfg.dashboard ? ' --dashboard <the dashboard link above>' : ''));
    say('  2. Paste the key above when it asks.');
    return;
  }
  if (args.length > 1) throw new UsageError('Do not type the key after the address: it would be saved in your shell history. Run "redline login <url>" and paste the key when asked.');
  if (!args.length) throw new UsageError('Give the site address: redline login <url>');
  const url = normalizeUrl(args[0]);
  if (!url) throw new UsageError('That is not a web address: ' + args[0]);
  const key = await readKey();
  if (!key) throw new UsageError('No key was given. Set REDLINE_KEY, pipe it in, or run this in a terminal and paste it.');
  await request(url, 'GET', '/api/docs', { key });
  const old = readConfig();
  const dash = opts.dashboard && (/\/d\/([a-z0-9]{24})/.exec(opts.dashboard) || [])[1] || (/^[a-z0-9]{24}$/.test(opts.dashboard || '') ? opts.dashboard : '');
  if (opts.dashboard && !dash) throw new UsageError('--dashboard needs the dashboard link or its 24-character token.');
  writePrivate(configFile(), { ...old, mode: 'remote', url, key, dashboard: dash || (old.url === url ? old.dashboard : '') || '' });
  say('Signed in to ' + url + '. The key is saved in ' + configFile() + '.');
}

// ---------------------------------------------------------------- setup and update

// All wrangler calls go through here. REDLINE_WRANGLER points at a replacement script (the tests use one).
function wranglerCommand(siteDir) {
  if (process.env.REDLINE_WRANGLER) return { cmd: process.execPath, pre: [process.env.REDLINE_WRANGLER], shell: false };
  const local = join(siteDir, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  if (existsSync(local)) return { cmd: process.execPath, pre: [local], shell: false };
  const win = process.platform === 'win32';
  return { cmd: win ? 'npx.cmd' : 'npx', pre: ['--yes', 'wrangler@' + WRANGLER_VERSION], shell: win };
}

function runProcess(cmd, args, { cwd, env, input, inherit = false, shell = false }) {
  return new Promise((done) => {
    const stdio = inherit ? 'inherit' : [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'];
    const proc = spawnTool(cmd, args, { cwd, env, stdio, shell });
    let out = '';
    if (!inherit) {
      proc.stdout.on('data', (d) => { out += d; });
      proc.stderr.on('data', (d) => { out += d; });
      if (input !== undefined) proc.stdin.end(input);
    }
    proc.on('error', (e) => done({ code: 1, out: String(e.message) }));
    proc.on('close', (code) => done({ code: code ?? 1, out: stripAnsi(out) }));
  });
}

function wranglerRunner(siteDir, account) {
  const w = wranglerCommand(siteDir);
  const env = { ...process.env, WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1', ...(account ? { CLOUDFLARE_ACCOUNT_ID: account } : {}) };
  return (args, opts = {}) => runProcess(w.cmd, [...w.pre, ...args], { cwd: siteDir, env, shell: w.shell, ...opts });
}

// Accounts are listed in a table: | Account Name | Account ID (32 hex characters) |
export function parseWhoami(text) {
  const clean = stripAnsi(text);
  const accounts = [];
  for (const line of clean.split('\n')) {
    const m = /^\s*[│|]\s*(.+?)\s*[│|]\s*([0-9a-f]{32})\s*[│|]/i.exec(line);
    if (m) accounts.push({ name: m[1], id: m[2].toLowerCase() });
  }
  const signedOut = /not authenticated|not logged in|not signed in/i.test(clean);
  return { signedOut, signedIn: !signedOut && (accounts.length > 0 || /logged in|you are logged/i.test(clean)), accounts };
}

// The deploy output lists the live address on its own line. Prefer workers.dev when several are printed.
export function parseDeployUrl(text) {
  const urls = stripAnsi(text).split('\n').map((l) => /^\s*(https?:\/\/[^\s]+?)\/?\s*$/.exec(l)).filter(Boolean).map((m) => m[1]);
  return urls.find((u) => /\.workers\.dev$/i.test(new URL(u).hostname)) || urls[0] || null;
}

// `d1 create` prints the new id as a TOML or JSON snippet; `d1 list --json` is the fallback.
export function parseDatabaseId(text) {
  const m = /database_id["']?\s*[=:]\s*["']([0-9a-f-]{36})["']/i.exec(stripAnsi(text));
  return m ? m[1] : null;
}
// `kv namespace create` prints a snippet with the 32-character namespace id; `kv namespace list` prints JSON rows {id, title}.
export function parseKvId(text) {
  const m = /\bid["']?\s*[=:]\s*["']([0-9a-f]{32})["']/i.exec(stripAnsi(text));
  return m ? m[1] : null;
}
export function parseKvList(text, title) {
  const rows = parseJsonArray(text);
  const row = rows && rows.find((r) => r.title === title);
  return row ? row.id || null : null;
}
function parseJsonArray(text) {
  const clean = stripAnsi(text);
  const start = clean.indexOf('[');
  if (start < 0) return null;
  try { return JSON.parse(clean.slice(start, clean.lastIndexOf(']') + 1)); } catch { return null; }
}
export function parseDatabaseList(text, name) {
  const rows = parseJsonArray(text);
  const row = rows && rows.find((r) => r.name === name);
  return row ? row.uuid || row.database_id || row.id || null : null;
}

const lastLines = (text, n = 4) => stripAnsi(text).split('\n').map((l) => l.trim()).filter(Boolean).slice(-n).join('\n');

function wranglerFailure(what, r, hint) {
  return new CliError(what + '\n' + lastLines(r.out), hint || 'Run "redline deploy cloudflare" again. If it fails the same way, send the lines above to whoever helps you.');
}

async function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question(question)).trim(); } finally { rl.close(); }
}

// The page layer files are cached for a year under ?v=<build>, so the build id must change whenever they do.
function buildId(siteDir) {
  const hash = createHash('sha256');
  for (const name of ['redline.js', 'redline.css']) {
    const file = join(siteDir, 'public', '_redline', name);
    if (existsSync(file)) hash.update(readFileSync(file));
  }
  return hash.digest('hex').slice(0, 10);
}

function copySite(siteDir) {
  const src = join(REPO_ROOT, 'site');
  if (!existsSync(join(src, 'wrangler.template.jsonc'))) throw new CliError('The site files are missing from this copy of The Redline (' + src + ').', 'Download The Redline again from GitHub.');
  mkdirSync(siteDir, { recursive: true });
  // Replace each top-level piece so files deleted upstream disappear, but keep node_modules and our wrangler.jsonc.
  for (const name of readdirSync(src)) {
    if (name === 'node_modules' || name === '.wrangler' || name === 'wrangler.jsonc') continue;
    rmSync(join(siteDir, name), { recursive: true, force: true });
    cpSync(join(src, name), join(siteDir, name), { recursive: true });
  }
}

async function siteAnswers(url, key) {
  try { return (await fetch(url + '/api/docs', { headers: { Authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(10000) })).ok; } catch { return false; }
}

async function cmdCloudflare({ opts }, { update = false } = {}) {
  const cfg = readConfig();
  const name = update ? cfg.worker : opts.name || 'redline';
  if (update && (!cfg.key || !cfg.worker)) throw new CliError('There is no Cloudflare site to update on this computer.', 'Run "redline deploy cloudflare" first.');
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(name)) throw new UsageError('The name must be lowercase letters, digits and dashes, starting with a letter.');
  if (process.stdout.isTTY && process.stdin.isTTY && !opts.yes && !update) {
    say('This makes your own private review site on Cloudflare. It is free and needs no card.');
    say('A browser window will ask you to sign in to Cloudflare (or create a free account).');
    const answer = await ask('Continue? [Y/n] ');
    if (/^n/i.test(answer)) { say('Stopped. Nothing was changed.'); return; }
  }

  const siteDir = join(stateDir(), 'site');
  say('Copying the site files to ' + siteDir + '...');
  copySite(siteDir);
  say("Installing the site's tools (the first time takes about a minute)...");
  const npm = await runProcess(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: siteDir, env: process.env, shell: process.platform === 'win32' });
  if (npm.code !== 0) throw wranglerFailure('Could not install the site\'s tools.', npm, 'Check your internet connection and try again.');

  // Sign in, and pick the account.
  say('Checking your Cloudflare sign-in...');
  let run = wranglerRunner(siteDir, process.env.CLOUDFLARE_ACCOUNT_ID);
  const first = await run(['whoami']);
  let who = parseWhoami(first.out);
  if (!who.signedIn && !who.signedOut) throw wranglerFailure('Could not ask Cloudflare who is signed in.', first, 'Check your internet connection and that Node 22 or newer is installed, then run "redline deploy cloudflare" again.');
  if (!who.signedIn) {
    say('Signing in to Cloudflare (a browser window will open)...');
    const login = await run(['login'], { inherit: true });
    if (login.code !== 0) throw new CliError('Cloudflare sign-in did not finish.', 'Run "redline deploy cloudflare" again and approve the sign-in in the browser window.');
    who = parseWhoami((await run(['whoami'])).out);
    if (!who.signedIn) throw new CliError('Signed in, but Cloudflare did not report an account.', 'Run "redline deploy cloudflare" again.');
  }
  let account = process.env.CLOUDFLARE_ACCOUNT_ID || '';
  if (!account) {
    const known = who.accounts.find((a) => a.id === cfg.account);
    if (known) account = known.id;
    else if (who.accounts.length === 1) account = who.accounts[0].id;
    else if (who.accounts.length > 1) {
      if (!process.stdin.isTTY || opts.yes) {
        throw new CliError('Your Cloudflare login has several accounts: ' + who.accounts.map((a) => a.name).join(', ') + '.', 'Set CLOUDFLARE_ACCOUNT_ID to the one you want (shown by "npx wrangler whoami") and run setup again.');
      }
      who.accounts.forEach((a, i) => say('  ' + (i + 1) + ') ' + a.name));
      const pick = Number(await ask('Which account should hold the site? Type its number: '));
      if (!who.accounts[pick - 1]) throw new CliError('That was not one of the numbers.', 'Run "redline deploy cloudflare" again and type a number from the list.');
      account = who.accounts[pick - 1].id;
    }
  }
  const accountName = (who.accounts.find((a) => a.id === account) || {}).name;
  say('Using the Cloudflare account' + (accountName ? ' "' + accountName + '"' : '') + '.');
  run = wranglerRunner(siteDir, account);

  // Pages and comments live in the database; the page files live in key-value storage. Reuse each by name, otherwise create it.
  // --no-update-config stops wrangler from asking to edit our config file.
  say('Setting up the database...');
  const listed = await run(['d1', 'list', '--json']);
  let databaseId = listed.code === 0 ? parseDatabaseList(listed.out, name) : null;
  if (databaseId) {
    say('Using the existing database ' + name);
  } else {
    const created = await run(['d1', 'create', name, '--no-update-config']);
    databaseId = parseDatabaseId(created.out);
    if (!databaseId) databaseId = parseDatabaseList((await run(['d1', 'list', '--json'])).out, name);
    if (!databaseId) throw wranglerFailure('Could not create the database ' + name + '.', created);
    say('Created database ' + name);
  }

  say('Setting up file storage...');
  const storage = name + '-files';
  const storageList = await run(['kv', 'namespace', 'list']);
  let storageId = storageList.code === 0 ? parseKvList(storageList.out, storage) : null;
  if (storageId) {
    say('Using the existing file storage ' + storage);
  } else {
    const created = await run(['kv', 'namespace', 'create', storage, '--no-update-config']);
    storageId = parseKvId(created.out);
    if (!storageId) storageId = parseKvList((await run(['kv', 'namespace', 'list'])).out, storage);
    if (!storageId) throw wranglerFailure('Could not create the file storage ' + storage + '.', created);
    say('Created file storage ' + storage);
  }

  const template = readFileSync(join(siteDir, 'wrangler.template.jsonc'), 'utf8');
  writeFileSync(join(siteDir, 'wrangler.jsonc'), template.replaceAll('__NAME__', name).replaceAll('__DATABASE_ID__', databaseId).replaceAll('__KV_ID__', storageId));

  say('Creating the database tables...');
  const schema = await run(['d1', 'execute', name, '--remote', '--file', 'schema.sql']);
  if (schema.code !== 0) throw wranglerFailure('Could not set up the database tables.', schema);

  // Secrets go in a private temp file, never on a command line. An existing key and dashboard token are always kept, so every
  // computer signed in to this site keeps working.
  const secrets = { PUBLISH_KEY: cfg.key || randomBytes(24).toString('hex'), DASHBOARD_TOKEN: cfg.dashboard || randomToken(24) };
  const secretsDir = tempDir('secrets-');
  const secretsFile = join(secretsDir, 'secrets.json');
  writeFileSync(secretsFile, JSON.stringify(secrets), { mode: 0o600 });
  let deployed;
  try {
    say('Putting the site online (this can take a minute or two)...');
    const build = ['--var', 'BUILD:' + buildId(siteDir)];
    deployed = await run(['deploy', ...build, '--secrets-file', secretsFile]);
    if (deployed.code !== 0 && /secrets-file/i.test(deployed.out) && /unknown|unrecognized|not a valid|unexpected/i.test(deployed.out)) {
      // An older wrangler without the flag: deploy first, then send the secrets.
      deployed = await run(['deploy', ...build]);
      if (deployed.code === 0) {
        const bulk = await run(['secret', 'bulk', secretsFile]);
        if (bulk.code !== 0) throw wranglerFailure('The site is online, but its key could not be saved.', bulk);
      }
    }
  } finally {
    rmSync(secretsDir, { recursive: true, force: true });
  }
  if (deployed.code !== 0) {
    if (/workers\.dev subdomain/i.test(deployed.out)) {
      throw new CliError('Your Cloudflare account has no workers.dev address yet.', 'Open dash.cloudflare.com, choose Workers & Pages, pick a free name when asked, then run "redline deploy cloudflare" again.');
    }
    throw wranglerFailure('The site could not be put online.', deployed);
  }

  // A saved address (for example a custom domain) stays if it still answers; the workers.dev address is the fallback.
  const sameSite = !cfg.worker || cfg.worker === name;
  const saved = sameSite ? normalizeUrl(cfg.url) : '';
  const deployedUrl = normalizeUrl(parseDeployUrl(deployed.out));
  const url = saved && await siteAnswers(saved, secrets.PUBLISH_KEY) ? saved : deployedUrl;
  if (!url) throw wranglerFailure('The site was deployed, but its address was not in the output.', deployed, 'Open dash.cloudflare.com, find the Worker "' + name + '", copy its address, and run "redline login <address>" with the key from ' + configFile() + '.');
  writePrivate(configFile(), { ...cfg, mode: 'remote', host: 'cloudflare', url, key: secrets.PUBLISH_KEY, dashboard: secrets.DASHBOARD_TOKEN, worker: name, database: name, kv: storageId, account });
  say('Site is live: ' + url);

  // A new workers.dev address can take a short while to resolve.
  say('Waiting for the address to start answering (up to 2 minutes)...');
  const ready = await waitFor(() => siteAnswers(url, secrets.PUBLISH_KEY), 120000, 3000);
  if (!ready) throw new CliError('The site was deployed but is not answering yet.', 'Wait a few minutes, then run "redline deploy cloudflare" again; nothing will be lost.');
  if (update) { say('Site updated. Your pages, comments and links are unchanged.'); return; }

  say('Publishing a sample plan to try it out...');
  const sample = await publishSample(cfg.sample);
  writePrivate(configFile(), { ...readConfig(), sample: sample.slug });
  say('\nAll set. Open these on any device:');
  say('  Sample plan: ' + sample.url);
  say('  Dashboard:   ' + url + '/d/' + secrets.DASHBOARD_TOKEN + '/');
  say('  Site:        ' + url + '/');
  say('\nKeep the dashboard link private. The key is saved in ' + configFile() + '; "redline login --show" shows how to use this site from another computer.');
}

// Setup run twice should not pile up sample pages, so the first one is reused.
async function publishSample(slug) {
  const input = join(REPO_ROOT, 'examples', 'sample-plan.html');
  try {
    return await publishDoc({ input, title: 'Sample plan: a weekly digest email', summary: 'A demo page. Try selecting text, drawing on it, and pressing Approve.', slug: slug || undefined });
  } catch (e) {
    if (!slug) throw e;
    return publishDoc({ input, title: 'Sample plan: a weekly digest email', summary: 'A demo page. Try selecting text, drawing on it, and pressing Approve.' });
  }
}

// ---------------------------------------------------------------- local mode, phone, hosts

const HOSTS = ['cloudflare', 'vercel', 'netlify', 'docker'];
const HOST_NAMES = { cloudflare: 'Cloudflare', vercel: 'Vercel', netlify: 'Netlify', docker: 'a server (Docker)' };

// `redline setup` with no target: the site runs on this computer. No account, nothing to install.
async function cmdSetupLocal() {
  const cfg = readConfig();
  const first = !hasLocalSite();
  const local = localSettings();
  saveConfig({ mode: 'local' });
  say(first ? 'Starting The Redline on this computer...' : 'The Redline runs on this computer.');
  const server = await ensureServer();
  say('Publishing a sample plan to try it out...');
  const sample = await publishSample(local.sample);
  saveLocal({ sample: sample.slug });
  say('\nAll set. The Redline is running on this computer. No account is needed.');
  say('  Sample plan: ' + sample.url);
  say('  Dashboard:   ' + server.url + '/d/' + encodeURIComponent(server.dashboard) + '/');
  say('\nTo open it on your iPad or phone (same Wi-Fi): redline phone');
  say('To get links that work anywhere, put it on a host: redline deploy vercel, netlify, cloudflare or docker');
  if (cfg.url && (cfg.mode || 'remote') === 'remote') {
    say('\nThis computer was using ' + cfg.url + '. Commands now use this computer instead; that site is untouched. To go back: redline login ' + cfg.url);
  }
}

function hostModuleDir() {
  return process.env.REDLINE_DEPLOY_DIR ? resolve(process.env.REDLINE_DEPLOY_DIR) : join(dirname(fileURLToPath(import.meta.url)), 'deploy');
}

// Runs cli/deploy/<host>.mjs, which drives the host's own command line and returns {url, key, dashboard}.
async function deployToHost(host, opts) {
  const file = join(hostModuleDir(), host + '.mjs');
  if (!existsSync(file)) throw new CliError('Deploying to ' + HOST_NAMES[host] + ' is not in this copy of The Redline.', 'Update The Redline and try again, or use "redline deploy cloudflare".');
  const mod = await import(pathToFileURL(file).href);
  if (typeof mod.deploy !== 'function') throw new CliError('The ' + host + ' deploy module is broken (it has no deploy function).', 'Update The Redline and try again.');
  const cfg = readConfig();
  const again = cfg.host === host; // running it again keeps the same key and dashboard link
  const result = await mod.deploy({
    name: opts.name, yes: !!opts.yes, databaseUrl: opts['database-url'], log: say, key: again ? cfg.key : undefined, dashboard: again ? cfg.dashboard : undefined,
    repoRoot: REPO_ROOT, siteDir: join(REPO_ROOT, 'site'), stateDir: stateDir(), env: process.env, say, ask,
    interactive: !!(process.stdin.isTTY && process.stdout.isTTY),
  });
  const url = normalizeUrl(result && result.url);
  const key = result && result.key;
  if (!url || !key) throw new CliError('The ' + host + ' deploy finished without a site address and key.', 'Run "redline deploy ' + host + '" again.');
  const dash = result.dashboard ? ((/\/d\/([a-z0-9]{24})/.exec(result.dashboard) || [])[1] || (/^[a-z0-9]{24}$/.test(result.dashboard) ? result.dashboard : '')) : '';
  saveConfig({ mode: 'remote', host, url, key, dashboard: dash });
  say('Site is live: ' + url);
  if (dash) say('Dashboard: ' + url + '/d/' + encodeURIComponent(dash) + '/');
  if (!await waitFor(() => siteAnswers(url, key), 60000, 3000)) say('The site is not answering yet. Give it a minute, then run "redline list" to check.');
  say('The key is saved in ' + configFile() + '. "redline login --show" shows how to use this site from another computer.');
}

async function cmdDeploy({ opts, args }) {
  const host = args[0];
  if (!HOSTS.includes(host)) throw new UsageError('Pick where to put the site: ' + HOSTS.join(', ') + '.');
  if (host === 'cloudflare') await cmdCloudflare({ opts });
  else await deployToHost(host, opts);
  if (opts['no-copy']) return;
  const found = await localPageCount();
  if (!found) return;
  const remote = readConfig();
  if (!opts.yes && opts.copy === undefined) {
    if (!(process.stdin.isTTY && process.stdout.isTTY)) {
      say('\nYou have ' + plural(found, 'page') + ' on this computer. Copy them, with their comments and pen marks, to the new site with: redline copy');
      return;
    }
    const answer = await ask('\nCopy the ' + plural(found, 'page') + ' on this computer, with their comments and pen marks, to the new site? [Y/n] ');
    if (/^n/i.test(answer)) { say('Not copied. You can do it later with: redline copy'); return; }
  }
  await copyLocalToRemote({ url: remote.url, key: remote.key });
}

// How many pages the site on this computer holds (zero when it was never used, without starting anything).
async function localPageCount() {
  if (!hasLocalSite() || !existsSync(join(stateDir(), 'data'))) return 0;
  const server = await ensureServer();
  const list = await request(server.url, 'GET', '/api/docs', { key: server.key });
  return (list.docs || []).length;
}

// Moves every page, version, file, comment, pen mark and decision from the site on this computer to the host site.
const IMPORT_BATCH_BYTES = 3 * 1024 * 1024;

async function copyLocalToRemote(remote) {
  const server = await ensureServer();
  say('Copying your pages to ' + remote.url + '...');
  // First the list of pages (files named but not sent), then each page: its files, then its comments, pen marks and decisions.
  // Hosts cap one request at about 4.5 MB, so a page with big files goes over in several requests.
  const listing = await request(server.url, 'GET', '/api/export?files=0', { key: server.key });
  const docs = (listing && listing.docs) || [];
  const sent = docs.length;
  const send = (docs1) => request(remote.url, 'POST', '/api/import', { key: remote.key, json: { format: 'redline-export', format_version: 1, docs: docs1 } });
  for (const doc of docs) {
    const { files = [], comments, ink, decisions, ...details } = doc;
    const lists = { comments, ink, decisions };
    const weight = (list) => list.reduce((n, x) => n + Math.ceil((x.size || 0) * 4 / 3), 0);
    if (weight(files) <= IMPORT_BATCH_BYTES) {
      const whole = await request(server.url, 'GET', '/api/export?slug=' + doc.slug, { key: server.key });
      await send([{ ...details, files: whole.docs[0].files, ...lists }]);
      continue;
    }
    const batches = [[]];
    let size = 0;
    for (const file of files) {
      const w = weight([file]);
      if (size + w > IMPORT_BATCH_BYTES && batches[batches.length - 1].length) { batches.push([]); size = 0; }
      batches[batches.length - 1].push(file);
      size += w;
    }
    for (const [i, batch] of batches.entries()) {
      const withBytes = [];
      for (const file of batch) {
        const one = await request(server.url, 'GET', '/api/export?slug=' + doc.slug + '&file=' + encodeURIComponent(file.path), { key: server.key });
        if (!one.docs[0].files.length) throw new CliError('The file ' + file.path + ' of ' + doc.title + ' could not be read from this computer.');
        withBytes.push(one.docs[0].files[0]);
      }
      await send([{ ...details, files: withBytes, ...(i === batches.length - 1 ? lists : {}) }]);
    }
  }
  const there = await request(remote.url, 'GET', '/api/docs', { key: remote.key });
  const count = (there.docs || []).length;
  if (count < sent) throw new CliError('Only ' + count + ' of ' + sent + ' pages arrived on the new site.', 'Run "redline copy" again; copying twice is safe.');
  const recent = readJson(recentFile());
  if (recent && recent.url === server.url) writePrivate(recentFile(), { ...recent, url: remote.url });
  say('Copied ' + plural(sent, 'page') + '. The same page links now work at ' + remote.url + '/<page>/ (links you shared from this computer stop working when it is off).');
  return sent;
}

async function cmdCopy() {
  const cfg = readConfig();
  const url = normalizeUrl(process.env.REDLINE_URL || cfg.url);
  const key = process.env.REDLINE_KEY || cfg.key;
  if (!url || !key) throw new CliError('There is no host site to copy to.', 'Put the site on a host first: redline deploy vercel, netlify, cloudflare or docker.');
  if (!hasLocalSite()) throw new CliError('Nothing is stored on this computer, so there is nothing to copy.');
  if (!await localPageCount()) { say('There are no pages on this computer to copy.'); return; }
  await copyLocalToRemote({ url, key });
}

function cmdStop() {
  return stopServer().then((r) => {
    say(r === 'stopped' ? 'Stopped the Redline server on this computer. Your pages are kept; they come back the next time you use The Redline.' :
      r === 'stale' ? 'The Redline server was not running any more.' : 'The Redline server is not running.');
  });
}

async function cmdServe({ opts }) {
  localSettings();
  if (opts.port !== undefined && !/^[0-9]{1,5}$/.test(opts.port)) throw new UsageError('--port needs a number like 4848.');
  say('Starting The Redline in this window. Press Ctrl+C to stop it.\nDashboard: use "redline dashboard" in another window.');
  const code = await serveForeground({ port: opts.port });
  if (code) throw new CliError('The server stopped with an error (' + code + ').');
}

// `redline phone`: let the iPad or phone on the same Wi-Fi reach the site on this computer.
async function cmdPhone({ opts, args }) {
  const cfg = readConfig();
  const usingHost = process.env.REDLINE_URL || ((cfg.mode || 'remote') === 'remote' && cfg.url);
  if (usingHost) {
    throw new CliError('This computer uses a site on a host (' + normalizeUrl(process.env.REDLINE_URL || cfg.url) + '), and that opens on any device already.', 'Phone mode is for the site on this computer. Run "redline setup" to use that one.');
  }
  if (opts.off) {
    saveLocal({ network: false });
    await ensureServer();
    say('The Redline is no longer shared on your Wi-Fi. Only this computer can open it.');
    return;
  }
  saveLocal({ network: true });
  const server = await ensureServer();
  const lan = lanAddress();
  if (!lan) {
    throw new CliError('This computer has no Wi-Fi or network address to share.', 'Connect to Wi-Fi and run "redline phone" again.');
  }
  let path;
  let what;
  if (opts.dashboard) {
    path = '/d/' + encodeURIComponent(server.dashboard) + '/';
    what = 'your dashboard';
  } else {
    const recent = readJson(recentFile());
    const slug = args[0] ? parseSlug(args[0]) : recent && recent.slug;
    if (args[0] && !slug) throw new UsageError('That is not a Redline link or slug: ' + args[0]);
    path = slug ? '/' + slug + '/' : '/d/' + encodeURIComponent(server.dashboard) + '/';
    what = slug ? (args[0] ? 'that page' : 'the page you published last') : 'your dashboard';
  }
  const link = 'http://' + lan + ':' + server.port + path;
  say('Your iPad or phone can open ' + what + ' while it is on the same Wi-Fi as this computer:\n');
  say('  ' + link + '\n');
  console.log(renderQr(link).split('\n').map((l) => '  ' + l).join('\n'));
  say('\nPoint the camera at the code to open the link.');
  say('Anyone on this Wi-Fi who has a link can open that page and mark it up. Keep this computer awake and on the network while you review.');
  say('To stop sharing: redline phone --off');
}

// ---------------------------------------------------------------- other coding agents

// The text between this marker and the end is the same in agents/redline.md and skills/redline/SKILL.md.
export const SHARED_MARKER = '## Before you start';

function sharedInstructions() {
  const file = join(REPO_ROOT, 'agents', 'redline.md');
  if (!existsSync(file)) throw new CliError('The agent instructions are missing from this copy of The Redline (' + file + ').', 'Download The Redline again from GitHub.');
  return readFileSync(file, 'utf8');
}

// How an agent should call this command line: the installed copy, or npx when this copy is a temporary download.
export function commandPrefix() {
  if (process.env.REDLINE_COMMAND) return process.env.REDLINE_COMMAND;
  if (REPO_ROOT.split(sep).includes('_npx')) return 'npx --yes github:kidusketema/the-redline';
  return 'node "' + join(REPO_ROOT, 'cli', 'redline.mjs') + '"';
}

export function codexSkill(prefix = commandPrefix()) {
  const body = sharedInstructions().replace('{{RUN}}', 'Run the command line like this: `' + prefix + ' <command>`. It is written `redline <command>` below.');
  return '---\nname: redline\ndescription: Use when the user wants to review, approve, comment on or mark up something you made (a plan, design, report, mock-up), asks for a review link, wants to read a long document on an iPad or phone, or says they left comments, pen marks or a decision on a page. Publishes the page to a Redline site and reads the feedback back.\nmetadata:\n  generated-by: the-redline\n  short-description: Publish pages for review and read the feedback\n---\n\n' + body;
}

async function cmdInstall({ opts, args }) {
  const what = args[0];
  if (what === 'agents') {
    const file = join(REPO_ROOT, 'agents', 'AGENTS.md');
    if (!existsSync(file)) throw new CliError('The AGENTS.md snippet is missing from this copy of The Redline (' + file + ').', 'Download The Redline again from GitHub.');
    process.stdout.write(readFileSync(file, 'utf8'));
    return;
  }
  if (what !== 'codex') throw new UsageError('Install for which agent? Try "redline install codex", or "redline install agents" to print instructions for any other agent.');
  const skills = opts.dir ? resolve(opts.dir) : join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'skills');
  const dir = join(skills, 'redline');
  const file = join(dir, 'SKILL.md');
  if (existsSync(file) && !/generated-by:\s*the-redline/.test(readFileSync(file, 'utf8')) && !opts.force) {
    throw new CliError(file + ' already exists and was not made by The Redline.', 'Move it away, or run again with --force to replace it.');
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, codexSkill());
  say('Installed the Redline skill for Codex: ' + file);
  say('Start a new Codex session and ask it to "publish this plan for review". It starts The Redline on this computer by itself.');
}

// ---------------------------------------------------------------- command table

const COMMANDS = {
  setup: {
    summary: 'Start The Redline on this computer (instant, no account), or put it on a host.',
    usage: 'redline setup [vercel|netlify|cloudflare|docker]',
    help: 'With no target, starts The Redline on this computer, publishes a sample plan and prints your links.\nNo account and nothing to install. With a target, the same as "redline deploy <target>".',
    options: { name: 'string', yes: 'bool', copy: 'bool', 'no-copy': 'bool', 'database-url': 'string' }, min: 0, max: 1, run: (p) => (p.args[0] ? cmdDeploy(p) : cmdSetupLocal()),
  },
  deploy: {
    summary: 'Put your site on a host: vercel, netlify, cloudflare or docker.',
    usage: 'redline deploy <vercel|netlify|cloudflare|docker> [--name <name>] [--database-url <address>] [--yes] [--no-copy]',
    help: 'Uses the host\'s own command line, which opens your browser to sign in the first time. Afterwards\nit offers to copy the pages you made on this computer, with their comments and pen marks, to the\nnew site. Running it again keeps your key and links.\n\nOptions:\n  --name <name>   Name for the site on the host (default: redline).\n  --yes           Do not ask questions; copy local pages too.\n  --no-copy       Do not copy the pages from this computer.\n  --database-url <address>   Postgres address to use, for hosts that need one (Vercel, Netlify).',
    options: { name: 'string', yes: 'bool', copy: 'bool', 'no-copy': 'bool', 'database-url': 'string' }, min: 1, max: 1, missing: 'where to deploy (vercel, netlify, cloudflare or docker)', run: cmdDeploy,
  },
  copy: {
    summary: 'Copy the pages on this computer to your host site.',
    usage: 'redline copy',
    help: 'Sends every page, version, picture, comment, pen mark and decision from the site on this computer\nto the site you put on a host. Safe to run twice.',
    options: {}, min: 0, max: 0, run: cmdCopy,
  },
  phone: {
    summary: 'Open your pages on an iPad or phone over the same Wi-Fi.',
    usage: 'redline phone [link|slug] [--dashboard] [--off]',
    help: 'Makes the site on this computer reachable from your Wi-Fi and prints a link and a QR code.\nWith no link it uses the page you published last. Anyone on the same Wi-Fi who has a link can\nopen it.\n\nOptions:\n  --dashboard   Show the link and code for your dashboard instead.\n  --off         Stop sharing on the Wi-Fi.',
    options: { dashboard: 'bool', off: 'bool' }, min: 0, max: 1, run: cmdPhone,
  },
  serve: {
    summary: 'Run the site on this computer in this window.',
    usage: 'redline serve [--port 4848]',
    help: 'Runs the local site until you press Ctrl+C. You rarely need this: the other commands start it\nin the background when they need it.',
    options: { port: 'string' }, min: 0, max: 0, run: cmdServe,
  },
  stop: {
    summary: 'Stop the site running on this computer.',
    usage: 'redline stop',
    help: 'Stops the background server. Your pages are kept and come back the next time you use The Redline.',
    options: {}, min: 0, max: 0, run: cmdStop,
  },
  install: {
    summary: 'Teach another coding agent to use The Redline (codex, agents).',
    usage: 'redline install codex [--dir <skills folder>] [--force]\n       redline install agents',
    help: '"codex" adds a Redline skill to Codex (in ~/.codex/skills, or $CODEX_HOME/skills).\n"agents" prints a short block you can paste into the AGENTS.md of any project.',
    options: { dir: 'string', force: 'bool' }, min: 1, max: 1, missing: 'which agent (codex or agents)', run: cmdInstall,
  },
  update: {
    summary: 'Put the latest site code on your Cloudflare site. Pages and comments are untouched.',
    usage: 'redline update',
    help: 'Redeploys the site from this copy of The Redline. Run "git pull" in the repo (or use the newest\nplugin) first. Only for sites made with "redline deploy cloudflare". Pages, comments and links stay as they are.',
    options: {}, min: 0, max: 0, run: (p) => cmdCloudflare(p, { update: true }),
  },
  login: {
    summary: 'Use a site you already have, from another computer.',
    usage: 'redline login <url> [--dashboard <link>]\n       redline login --show',
    help: 'Saves the site address and key on this computer after checking that they work. The key is\nnever typed on the command line: set REDLINE_KEY, pipe it in, or paste it when asked.\n"redline login --show" prints the address and key (the only place the key is ever shown),\nand the two steps to use the same site on another computer.\n\nOptions:\n  --show              Print the site address, key and how to sign in elsewhere.\n  --dashboard <link>  Also save the dashboard link (or its 24-character token).',
    options: { show: 'bool', dashboard: 'string' }, min: 0, max: 2, missing: 'the site address', run: cmdLogin,
  },
  publish: {
    summary: 'Publish a page or folder and print its link.',
    usage: 'redline publish <file.md | file.html | folder> [--title "..."] [--summary "..."] [--project "..."] [--tags a,b] [--slug <slug>] [--no-pdf]',
    help: 'Uploads one Markdown or HTML file, or a folder that has an index.html, index.md or README.md\n(dotfiles and node_modules are skipped). Markdown becomes a page in the style of the sample plan: the\nfirst # heading is the title, each ## heading starts a section, a <!-- redline:decision id --> comment\nin a section asks for a decision, and pictures next to the file are uploaded. If Chrome, Chromium or Edge is installed it also makes a PDF for the Download PDF\nbutton. Prints the link when the page is live.\n\nOptions:\n  --title <text>    Page title (default: the page\'s <title>).\n  --summary <text>  One line shown on the dashboard.\n  --project <text>  Group pages by project.\n  --tags a,b        Comma-separated tags.\n  --slug <slug>     Publish a new version at an existing link; comments and marks carry over.\n  --no-pdf          Skip the PDF.',
    options: { title: 'string', summary: 'string', project: 'string', tags: 'string', slug: 'string', 'no-pdf': 'bool' }, min: 1, max: 1, missing: 'the file or folder to publish', run: cmdPublish,
  },
  feedback: {
    summary: 'Print every comment, pen mark and decision on a page.',
    usage: 'redline feedback [link|slug] [--json] [--since <date>] [--changes] [--shots [folder]]',
    help: 'With no link, reads the page published most recently from this computer. The first lines say where\nthings stand: how many comments are marked fixed and waiting, confirmed or still open, and how many\ndecisions need another look because the text changed. Pen marks are grouped by paragraph with the\nwords they cover.\n\nOptions:\n  --json              Print the raw data as JSON.\n  --since <date>      Only feedback newer than this date (for example 2026-10-22T14:00:00Z).\n  --changes           Also list the blocks of text that changed since the version before.\n  --shots [folder]    Save one PNG per marked place, with the marks on it, and print each path.\n                      Needs Chrome, Chromium or Edge on this computer.',
    options: { json: 'bool', since: 'string', changes: 'bool', shots: 'optional' }, min: 0, max: 1, run: cmdFeedback,
  },
  resolve: {
    summary: 'Mark a comment as fixed, with a note of what you changed.',
    usage: 'redline resolve <link|slug> <comment-number> [--note "what you changed"]',
    help: 'Use it after you have acted on a comment. The reader sees the comment as marked fixed, with your\nnote, and presses Looks good or Not fixed. Only the reader confirms it.\n\nOptions:\n  --note <text>   A short note of what you changed (up to 500 characters).',
    options: { note: 'string' }, min: 2, max: 2, missing: 'the link and the comment number', run: cmdResolve,
  },
  relink: {
    summary: 'Give a page a new link; the old link stops working.',
    usage: 'redline relink <slug>',
    help: 'Use it when a link got to someone it should not have. The page keeps its comments, pen marks and\ndecisions. Needs the owner key, so it only works from the computer that made the site (or one you\nsigned in on).',
    options: {}, min: 1, max: 1, missing: 'the slug or link of the page', run: cmdRelink,
  },
  list: {
    summary: 'List every published page with its feedback counts.',
    usage: 'redline list [--json]',
    help: 'Shows each page with its link, open and fixed comments, pen marks and decisions.\n\nOptions:\n  --json   Print the raw list as JSON.',
    options: { json: 'bool' }, min: 0, max: 0, run: cmdList,
  },
  dashboard: {
    summary: 'Print the link to your dashboard of all pages.',
    usage: 'redline dashboard',
    help: 'The dashboard link is private. Anyone who has it can see the list of your pages.',
    options: {}, min: 0, max: 0, run: cmdDashboard,
  },
  open: {
    summary: 'Print the link for a page.',
    usage: 'redline open [link|slug]',
    help: 'Prints the full link. With no argument, the page published most recently from this computer.',
    options: {}, min: 0, max: 1, run: cmdOpen,
  },
  delete: {
    summary: 'Permanently delete a page and its feedback.',
    usage: 'redline delete <slug> --yes',
    help: 'Deletes the page, its files, comments, pen marks and decisions. This cannot be undone,\nso --yes is required.',
    options: { yes: 'bool' }, min: 1, max: 1, missing: 'the slug of the page to delete', run: cmdDelete,
  },
};
for (const [name, c] of Object.entries(COMMANDS)) c.name = name;

function generalHelp() {
  const rows = Object.values(COMMANDS).map((c) => '  ' + c.name.padEnd(11) + c.summary).join('\n');
  return 'The Redline: review what Claude makes, on any device.\n\nUsage: redline <command> [options]\n\nCommands:\n' + rows +
    '\n\nRun "redline <command> --help" for details.\nSettings live in ' + configFile() + '. REDLINE_URL and REDLINE_KEY override them.';
}

export async function main(argv) {
  if (Number(process.versions.node.split('.')[0]) < 22) {
    console.error('The Redline needs Node 22 or newer, and this is Node ' + process.versions.node + '.\nInstall the current version from nodejs.org and try again.');
    return 1;
  }
  const [name, ...rest] = argv;
  try {
    if (!name) { console.error(generalHelp()); return 2; }
    if (['--help', '-h', 'help'].includes(name)) {
      const c = name === 'help' && COMMANDS[rest[0]];
      say(c ? 'Usage: ' + c.usage + '\n\n' + c.summary + '\n\n' + c.help : generalHelp());
      return 0;
    }
    const cmd = COMMANDS[name];
    if (!cmd) throw new UsageError('Unknown command "' + name + '". Run "redline --help" to see the commands.');
    if (rest.includes('--help') || rest.includes('-h')) { say('Usage: ' + cmd.usage + '\n\n' + cmd.summary + '\n\n' + cmd.help); return 0; }
    const parsed = parseArgs(cmd, rest);
    await cmd.run(parsed);
    return 0;
  } catch (e) {
    if (e instanceof UsageError) { console.error(clean('Error: ' + e.message)); return 2; }
    if (e instanceof CliError || (e instanceof Error && typeof e.hint === 'string')) { console.error(clean('Error: ' + e.message + (e.hint ? '\n' + e.hint : ''))); return 1; }
    console.error(clean('Error: ' + (e && e.message ? e.message : e)));
    return 1;
  }
}

// Run only when started as a program (also through the npm bin symlink), not when the tests import the parsers.
const entry = process.argv[1] ? realpathSync(process.argv[1]) : '';
if (entry === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
