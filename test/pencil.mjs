// Headless-Chrome test of the page layers: an iPad (pinch zoom, Apple Pencil, two-finger tap), a desktop and a phone.
// Starts its own stub server (test/layers-stub.mjs). Prints PASS or FAIL per check and exits 1 if any fail.
//   node test/pencil.mjs
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { startStub, SLUG } from './layers-stub.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SHOTS = join(here, '.tmp', 'shots');
const STAGE = mkdtempSync(join(tmpdir(), 'redline-shots-')); // shots are written here first, then copied, so another run clearing test/.tmp cannot lose them
const PROFILE = mkdtempSync(join(tmpdir(), 'redline-chrome-')); // outside the repo, so other test runs cannot clear it
const CHROME = process.env.REDLINE_CHROME || process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, ok, detail = '') {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
}
const freePort = () => new Promise((resolve) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});

/* ---------- Chrome over the DevTools protocol (Node's built-in WebSocket) ---------- */
const cdpPort = await freePort();
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${PROFILE}`, '--no-first-run',
  '--no-default-browser-check', '--mute-audio', '--window-size=820,1180', ...(process.env.CI ? ['--no-sandbox'] : []), 'about:blank'], { stdio: 'ignore' });
let ws, msgId = 0, errors = [];
const waiting = new Map();
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    waiting.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
function onEvent(d) {
  if (d.method === 'Runtime.exceptionThrown') errors.push('exception: ' + (d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text));
  else if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') errors.push('console.error: ' + d.params.args.map((a) => a.value ?? a.description).join(' '));
  else if (d.method === 'Log.entryAdded' && d.params.entry.level === 'error') errors.push('log: ' + d.params.entry.text + ' ' + (d.params.entry.url || ''));
}
async function js(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r.result.value;
}
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(STAGE, `${name}.png`), Buffer.from(r.data, 'base64'));
  shots.push(join(SHOTS, `${name}.png`));
}
const shots = [];

async function connect() {
  let target;
  for (let i = 0; i < 60 && !target; i++) {
    try { target = await (await fetch(`http://127.0.0.1:${cdpPort}/json/new?about:blank`, { method: 'PUT' })).json(); } catch { await sleep(250); }
  }
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  ws.addEventListener('message', (m) => {
    const d = JSON.parse(m.data);
    if (d.id && waiting.has(d.id)) { const w = waiting.get(d.id); waiting.delete(d.id); d.error ? w.reject(new Error(d.error.message)) : w.resolve(d.result); }
    else if (d.method) onEvent(d);
  });
  for (const d of ['Page', 'Runtime', 'Log']) await send(`${d}.enable`);
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
}

const VIEWPORTS = {
  desktop: { width: 1280, height: 800, dsf: 1, mobile: false, touch: false },
  ipad: { width: 820, height: 1180, dsf: 2, mobile: true, touch: true },
  phone: { width: 375, height: 812, dsf: 2, mobile: true, touch: true },
};
async function open(vp, url) {
  const v = VIEWPORTS[vp];
  await send('Emulation.setDeviceMetricsOverride', { width: v.width, height: v.height, deviceScaleFactor: v.dsf, mobile: v.mobile });
  await send('Emulation.setTouchEmulationEnabled', { enabled: v.touch, maxTouchPoints: v.touch ? 5 : 1 });
  await js('localStorage.clear()').catch(() => {});
  errors = [];
  await send('Page.navigate', { url });
  for (let i = 0; i < 40; i++) { if (await js(`document.readyState === 'complete' && !!document.querySelector('.rl-pdf')`).catch(() => false)) break; await sleep(150); }
  await sleep(700);
}

// Mouse press and release at the centre of an element (scrolled into view first). Only valid while the page is not zoomed.
async function click(sel) {
  const c = await js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; e.scrollIntoView({ block: 'center' });
    const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  if (!c) throw new Error('no element ' + sel);
  await sleep(150);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: c[0], y: c[1], button: 'left', buttons: 1, clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: c[0], y: c[1], button: 'left', buttons: 0, clickCount: 1 });
}
// A Pencil stroke: press, move along a wavy line, release.
async function penStroke(sx, sy, steps = 24) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: sx, y: sy, button: 'left', buttons: 1, clickCount: 1, pointerType: 'pen', force: 0.3 });
  for (let i = 1; i <= steps; i++) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: sx + i * 4, y: sy + Math.sin(i / 3) * 8, button: 'left', buttons: 1, pointerType: 'pen', force: 0.3 });
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: sx + steps * 4, y: sy, button: 'left', buttons: 0, clickCount: 1, pointerType: 'pen' });
}
// Where to aim the pointer so it lands on a paragraph in the visible area. DevTools mouse coordinates count in CSS pixels from the
// visual viewport's corner (they are not divided by the zoom), so the point is the client position minus the viewport offset.
const paragraphPoint = () => js(`(() => { const vv = visualViewport;
  for (const p of document.querySelectorAll('main p, main li, main figcaption')) { const r = p.getBoundingClientRect();
    const x0 = Math.max(r.left, vv.offsetLeft), x1 = Math.min(r.right, vv.offsetLeft + vv.width - 4);
    const y0 = Math.max(r.top, vv.offsetTop + 20), y1 = Math.min(r.bottom, vv.offsetTop + vv.height - 60);
    if (x1 - x0 > 110 && y1 - y0 > 8) return [Math.round(x0 + 8 - vv.offsetLeft), Math.round((y0 + y1) / 2 - vv.offsetTop)]; }
  return null; })()`);

function seed(state) {
  const base = { author_label: '', created_at: new Date(Date.now() - 600000).toISOString(), status: 'open', fix_note: '', fixed_at: null, fixed_version: null, reopened: false, anchor_kind: '', anchor_text: '', anchor_context: '', anchor_data: null };
  const add = (c) => state.comments.push({ ...base, id: state.nextId++, ...c });
  add({ anchor_kind: 'text', anchor_text: 'forty minutes', anchor_context: 'takes ⟦forty minutes⟧ and fails', body: 'Is this the average or the slowest night?', author_label: 'Dana' });
  add({ anchor_kind: 'svg', anchor_text: 'Send email', anchor_context: '⟦Send email⟧', anchor_data: JSON.stringify({ fig: 'svg-1', cap: 'The report flow', label: 'Diagram 1: The report flow' }),
    body: 'What happens if one region never reports?', author_label: 'Marco' });
  add({ anchor_kind: 'pin', anchor_context: 'Report header placeholder (image)', anchor_data: JSON.stringify({ t: 'img-1', x: 88, y: 50, near: '', label: 'Report header placeholder', alt: 'Report header placeholder' }),
    body: 'Use the new logo here.', author_label: 'Dana' });
  add({ body: 'Looks good overall. One question on retries.', author_label: 'Marco' });
  state.decisions.push({ id: state.nextId++, doc_slug: SLUG, item: 'approach', verdict: 'approve', note: 'Fine as long as the switch back works.', author_label: 'Dana', created_at: new Date(Date.now() - 300000).toISOString() });
}

// Where a corner control sits, in screen pixels from the visible edges, plus its visual size.
const CORNERS = `(() => { const vv = visualViewport, out = {};
  for (const [k, sel] of [['draw', '.rl-ink-main'], ['tab', '.rl-tab'], ['pdf', '.rl-pdf']]) {
    const r = document.querySelector(sel).getBoundingClientRect(), s = vv.scale;
    out[k] = { left: (r.left - vv.offsetLeft) * s, right: (vv.offsetLeft + vv.width - r.right) * s, bottom: (vv.offsetTop + vv.height - r.bottom) * s, w: r.width * s, h: r.height * s };
  } out.scale = vv.scale; return out; })()`;
const near = (a, b, tol = 3) => Math.abs(a - b) <= tol;

let stub, exitCode = 0;
try {
  stub = await startStub({ port: 0, pdf: true });
  await connect();

  /* ---- (f) no console errors, and screenshots, at three sizes ---- */
  for (const vp of ['desktop', 'ipad', 'phone']) {
    stub.state.comments.length = 0; stub.state.ink.length = 0; stub.state.decisions.length = 0;
    seed(stub.state);
    await open(vp, stub.url);
    await js(`window.scrollTo(0, 0)`);
    check(`no console errors on load (${vp})`, errors.length === 0, errors.join(' | '));
    await shot(`${vp}-1-unzoomed`);
    await click('.rl-tab');
    await sleep(500);
    await shot(`${vp}-2-panel`);
    const panelText = await js(`document.querySelector('.rl-panel').innerText`);
    check(`panel lists the seeded comments (${vp})`, /slowest night/.test(panelText) && /new logo/.test(panelText) && /retries/.test(panelText));
    await click('.rl-panel .rl-link');
    await sleep(300);
    await js(`window.scrollTo(0, 0)`);
    const p = await paragraphPoint();
    const before = stub.state.ink.length;
    await penStroke(p[0], p[1]);
    await sleep(900);
    check(`a pen stroke is saved (${vp})`, stub.state.ink.length === before + 1);
    await shot(`${vp}-3-stroke`);
    await click('.rl-ink-main');
    await sleep(300);
    const tb = await js(`(() => { const u = document.querySelector('.rl-ink-ui').getBoundingClientRect(), t = document.querySelector('.rl-tab').getBoundingClientRect();
      return { overlap: !(u.bottom <= t.top || u.top >= t.bottom || u.right <= t.left || u.left >= t.right), inside: u.left >= 0 && u.right <= innerWidth && u.top >= 0 }; })()`);
    check(`open pen toolbar stays on screen and clear of the Comments tab (${vp})`, !tb.overlap && tb.inside);
    await shot(`${vp}-4-draw-open`);
  }

  /* ---- (a) iPad pinch zoom: the three corner controls stay put at their normal size ---- */
  stub.state.comments.length = 0; stub.state.ink.length = 0; stub.state.decisions.length = 0;
  await open('ipad', stub.url);
  const flat = await js(CORNERS);
  await send('Input.synthesizePinchGesture', { x: 400, y: 500, scaleFactor: 2.5, gestureSourceType: 'touch' });
  await sleep(1300);
  let zoom = await js(CORNERS);
  // Headless Chrome on some Linux runners ignores the synthesized pinch. Ask for the same page scale directly before giving up.
  if (!near(zoom.scale, 2.5, 0.15)) {
    await send('Emulation.setPageScaleFactor', { pageScaleFactor: 2.5 }).catch(() => {});
    await sleep(800);
    zoom = await js(CORNERS);
  }
  await shot('ipad-4-zoomed');
  // Last resort, only on the Linux CI runner: skip the checks that need a zoomed page and say so.
  const noZoom = !near(zoom.scale, 2.5, 0.15) && !!process.env.CI && process.platform === 'linux';
  if (noZoom) {
    console.log(`SKIP  zoom checks (page is zoomed 2.5x, corner controls while zoomed and panned, pen hover dot while zoomed): headless Chrome on the Linux CI runner does not apply pinch zoom (scale ${zoom.scale})`);
  } else {
    check('page is zoomed 2.5x', near(zoom.scale, 2.5, 0.15), `scale ${zoom.scale}`);
    await send('Input.synthesizeScrollGesture', { x: 300, y: 400, xDistance: -150, yDistance: -250, gestureSourceType: 'touch', speed: 800 });
    await sleep(1300);
    const pan = await js(CORNERS);
    await shot('ipad-5-panned');
    const cmp = (a, b, edge) => ['w', 'h', edge, 'bottom'].every((k) => near(a[k], b[k]));
    for (const [name, key, edge] of [['Draw control', 'draw', 'right'], ['Comments tab', 'tab', 'right'], ['Download PDF button', 'pdf', 'left']]) {
      const ok = cmp(zoom[key], flat[key], edge) && cmp(pan[key], flat[key], edge);
      check(`${name} sits at its corner at normal size while zoomed and panned`, ok,
        `flat ${[flat[key][edge], flat[key].bottom, flat[key].w].map(Math.round)} zoomed ${[zoom[key][edge], zoom[key].bottom, zoom[key].w].map(Math.round)} panned ${[pan[key][edge], pan[key].bottom, pan[key].w].map(Math.round)}`);
    }
    check('Draw control stacks above the Comments tab', flat.draw.bottom >= flat.tab.bottom + flat.tab.h - 1 && pan.draw.bottom >= pan.tab.bottom + pan.tab.h - 1);

    /* ---- (b) pen hover dot under the pointer while zoomed ---- */
    await js(`window.__pm = null; document.addEventListener('pointermove', (e) => { window.__pm = [e.clientX, e.clientY]; }, true); 1`);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 150, y: 200, pointerType: 'pen', buttons: 0 });
    await sleep(300);
    const hv = await js(`(() => { const h = document.querySelector('.rl-ink-hover'), r = h.getBoundingClientRect(), s = visualViewport.scale;
      return { shown: getComputedStyle(h).display, dx: ((r.left + r.width / 2) - window.__pm[0]) * s, dy: ((r.top + r.height / 2) - window.__pm[1]) * s }; })()`);
    check('pen hover dot is centred on the pointer while zoomed', hv.shown === 'block' && Math.abs(hv.dx) <= 3 && Math.abs(hv.dy) <= 3, `dot off by ${hv.dx.toFixed(2)}, ${hv.dy.toFixed(2)} screen px`);
  }

  /* ---- (c) pen stroke is posted, and a two-finger tap undoes it (still zoomed) ---- */
  const pt = await paragraphPoint();
  const inkBefore = stub.state.ink.length;
  await penStroke(pt[0], pt[1]);
  await sleep(1000);
  const posted = stub.state.log.filter((l) => l.method === 'POST' && l.path === `/api/${SLUG}/ink`);
  check('pen stroke is drawn and posted while zoomed', stub.state.ink.length === inkBefore + 1 && posted.length >= 1 &&
    posted[posted.length - 1].body.data.p.length >= 9 && posted[posted.length - 1].body.data.m.ty === 'pen', `${posted.length} post(s)`);
  const drawn = await js(`document.querySelectorAll('.rl-ink-svg path').length`);
  await shot('ipad-6-zoomed-stroke');
  const delBefore = stub.state.log.filter((l) => l.method === 'DELETE').length;
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 300, y: 300, id: 1 }, { x: 360, y: 300, id: 2 }] });
  await sleep(80);
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(900);
  const dels = stub.state.log.filter((l) => l.method === 'DELETE');
  const drawnAfter = await js(`document.querySelectorAll('.rl-ink-svg path').length`);
  check('two-finger tap undoes the stroke (DELETE sent, stroke gone)', dels.length === delBefore + 1 && stub.state.ink.length === inkBefore && drawnAfter === drawn - 1,
    `paths ${drawn} -> ${drawnAfter}`);

  /* ---- (d) a text selection becomes a comment and shows in the panel ---- */
  stub.state.comments.length = 0;
  await open('ipad', stub.url);
  await js(`(() => { const w = document.createTreeWalker(document.querySelector('main'), NodeFilter.SHOW_TEXT);
    for (let n; (n = w.nextNode());) { const i = n.nodeValue.indexOf('forty minutes'); if (i >= 0) { const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + 13);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r); return true; } } return false; })()`);
  await sleep(700);
  check('selecting text shows the Comment button', await js(`getComputedStyle(document.querySelector('.rl-selbtn')).display !== 'none'`));
  await click('.rl-selbtn');
  await sleep(400);
  await js(`document.querySelector('.rl-composer .rl-who input').value = 'Dana'; document.querySelector('.rl-composer textarea').focus(); 1`);
  await send('Input.insertText', { text: 'Is this the average or the slowest night?' });
  await click('.rl-composer .rl-primary');
  await sleep(800);
  const cs = stub.state.comments;
  check('comment is created from the selection (stub saw it)', cs.length === 1 && cs[0].anchor_text === 'forty minutes' && cs[0].author_label === 'Dana' && /slowest night/.test(cs[0].body),
    JSON.stringify(cs[0] && { k: cs[0].anchor_kind, t: cs[0].anchor_text, a: cs[0].author_label }));
  check('the commented words are highlighted on the page', await js(`!!document.querySelector('mark.rl-hl')`));
  await click('.rl-tab');
  await sleep(400);
  check('the comment shows in the panel', /slowest night/.test(await js(`document.querySelector('.rl-panel').innerText`)));
  check('the name is remembered', await js(`localStorage.getItem('redline.author')`) === 'Dana');

  /* ---- (e) Approve on a decision section ---- */
  await click('.rl-panel .rl-link');
  await click('[data-redline-decision="approach"] .rl-dec-btn[data-v="approve"]');
  await sleep(700);
  const dec = stub.state.decisions;
  const shown = await js(`(() => { const b = document.querySelector('[data-redline-decision="approach"] .rl-dec'); return { pressed: b.querySelector('[data-v="approve"]').getAttribute('aria-pressed'),
    label: getComputedStyle(b.querySelector('[data-v="approve"]'), '::before').content, state: b.querySelector('.rl-dec-state').textContent, hidden: b.querySelector('.rl-dec-state').hidden }; })()`);
  check('Approve posts the decision for that section', dec.length === 1 && dec[0].item === 'approach' && dec[0].verdict === 'approve' && dec[0].author_label === 'Dana');
  check('Approve shows its label and the saved decision', shown.pressed === 'true' && /Approve/.test(shown.label) && /Approved/.test(shown.state) && !shown.hidden, JSON.stringify(shown));
  await shot('ipad-7-decision');
  await open('ipad', stub.url);
  check('the saved decision is shown again after a reload', await js(`document.querySelector('[data-redline-decision="approach"] [data-v="approve"]').getAttribute('aria-pressed')`) === 'true');
  check('the other section has no decision yet', await js(`document.querySelector('[data-redline-decision="rollout"] [data-v="approve"]').getAttribute('aria-pressed')`) === 'false');

  /* ---- whole-document bar when no section has the attribute ---- */
  await open('ipad', stub.url + '?plain');
  check('a page with no decision sections gets one whole-document bar', await js(`document.querySelectorAll('.rl-dec').length === 1 && !!document.querySelector('.rl-dec-doc')`));
  await click('.rl-dec-doc .rl-dec-btn[data-v="unsure"]');
  await sleep(600);
  check('the whole-document bar posts item "doc"', stub.state.decisions.some((d) => d.item === 'doc' && d.verdict === 'unsure'));

  /* ---- revisions: a second version with fixed comments, changed text, a stale pen mark and a stale decision ---- */
  const APPROACH = 'We keep the same report layout and the same recipients. Only the plumbing changes. The old script stays in place for one week behind a switch, so we can fall back by changing a single setting.';
  const NEWLI = 'Failed jobs retry three times and then raise an alert to the on-call channel.';
  const goto = async (url) => {
    errors = [];
    await send('Page.navigate', { url });
    for (let i = 0; i < 40; i++) { if (await js(`document.readyState === 'complete' && !!document.querySelector('.rl-pdf')`).catch(() => false)) break; await sleep(150); }
    await sleep(900);
  };
  const clickText = (sel, text) => js(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.textContent.trim() === ${JSON.stringify(text)}); if (!b) return false; b.click(); return true; })()`);
  const withVersion = (st) => {
    st.comments.length = 0; st.ink.length = 0; st.decisions.length = 0; st.log.length = 0;
    st.changes = { version: 2, from: 1, available: true, items: [{ t: APPROACH, k: 'changed', w: 'The old script stays in place for two weeks.' }, { t: NEWLI, k: 'new' }], removed: [{ t: 'The email is sent by hand every morning.' }] };
    const base = { author_label: 'Dana', created_at: new Date(Date.now() - 600000).toISOString(), anchor_kind: 'text', anchor_context: '', anchor_data: null, fix_note: '', fixed_at: null, fixed_version: null, reopened: false };
    const add = (c) => st.comments.push({ ...base, id: st.nextId++, ...c });
    add({ status: 'fixed', fix_note: 'Now says the slowest night.', fixed_version: 2, anchor_text: 'forty minutes', body: 'Is this the average or the slowest night?' });
    add({ status: 'fixed', fix_note: 'Added the limit.', fixed_version: 2, anchor_text: 'ten minute limit', body: 'What is the limit?' });
    add({ status: 'done', anchor_text: 'invoices', body: 'Which queue?' });
    add({ status: 'open', reopened: true, anchor_text: 'one week', body: 'Say why a week.' });
    st.ink.push({ id: st.nextId++, version: 1, stale: true, author_label: 'Dana', created_at: new Date().toISOString(),
      data: { a: { k: 'p', t: APPROACH, i: 0 }, m: { ty: 'pen' }, c: '#d33', w: 3, p: [10, 10, 0.5, 40, 12, 0.5, 80, 8, 0.5], vw: 900 } });
    st.decisions.push({ id: st.nextId++, doc_slug: SLUG, item: 'approach', verdict: 'approve', note: '', author_label: 'Sam', version: 1, stale: true, created_at: new Date(Date.now() - 300000).toISOString() });
  };

  await open('desktop', stub.url);
  check('a one-version page has no Changes button', await js(`!document.querySelector('.rl-chg-btn')`));
  check('opening version 1 is remembered, so a later version knows the reviewer has been here', await js(`localStorage.getItem('redline.seen.${SLUG}')`) === '1');

  withVersion(stub.state);
  await open('desktop', stub.url + '?v=2');
  check('no console errors on a second version', errors.length === 0, errors.join(' | '));
  check('the Changes button shows, off by default, with a count', await js(`(() => { const b = document.querySelector('.rl-chg-btn'); return !!b && b.getAttribute('aria-pressed') === 'false' && /3/.test(b.textContent) && !document.querySelector('.rl-chg'); })()`));
  await click('.rl-tab');
  await sleep(600);
  const rp = await js(`document.querySelector('.rl-panel').innerText`);
  const tabLabel = await js(`document.querySelector('.rl-tab').getAttribute('aria-label')`);
  check('the tab counts open and marked-fixed comments', /1 open, 2 marked fixed/.test(tabLabel), tabLabel);
  check('the panel has a section for comments marked fixed', /Marked fixed: is it\?/i.test(rp));
  check('a fixed comment shows the agent note and its version', /Now says the slowest night\./.test(rp) && /Marked fixed in version 2/.test(rp));
  const fixedBtns = await js(`[...document.querySelectorAll('.rl-card.is-fixed .rl-acts button')].map((b) => b.textContent.trim()).join('|')`);
  check('a fixed comment offers Looks good and Not fixed', fixedBtns === 'Looks good|Not fixed|Looks good|Not fixed', fixedBtns);
  check('a sent-back comment says so', /Sent back after it was marked fixed/.test(rp));
  check('confirmed comments sit in their own section', /Confirmed \(1\)/i.test(rp));
  check('a pen mark on changed text is listed', /Pen marks on text that changed/i.test(rp) && /This paragraph changed after you drew on it\./.test(rp) && /Erase this mark/.test(rp));
  await shot('desktop-9-revisions-panel');

  await clickText('.rl-card.is-fixed .rl-acts button', 'Looks good');
  await sleep(700);
  const sc = stub.state.comments;
  const posts = stub.state.log.filter((l) => l.method === 'POST' && /\/comments\/\d+\/status$/.test(l.path));
  check('Looks good sends the confirmed state', posts.length === 1 && posts[0].body.status === 'done' && sc[0].status === 'done', JSON.stringify(posts.map((p) => p.body)));
  check('the panel now counts that one as confirmed', await js(`/Confirmed \\(2\\)/i.test(document.querySelector('.rl-panel').innerText)`));
  await clickText('.rl-card.is-fixed .rl-acts button', 'Not fixed');
  await sleep(700);
  check('Not fixed sends it back to open', sc[1].status === 'open' && sc[1].reopened === true, JSON.stringify(sc[1]));

  const dtxt = await js(`document.querySelector('[data-redline-decision="approach"] .rl-dec-state').textContent`);
  check('an old approval says it is out of date', /Approved by Sam on version 1\. This section has changed since\./.test(dtxt), dtxt);
  check('no decision button shows as chosen on a changed section', await js(`[...document.querySelectorAll('[data-redline-decision="approach"] .rl-dec-btn')].every((b) => b.getAttribute('aria-pressed') === 'false' && !b.disabled)`));
  await shot('desktop-10-stale-decision');
  await click('[data-redline-decision="approach"] .rl-dec-btn[data-v="approve"]');
  await sleep(600);
  const again = stub.state.decisions[stub.state.decisions.length - 1];
  check('pressing a button decides again on this version', again.verdict === 'approve' && again.version === 2 && again.stale === false);

  await click('.rl-chg-btn');
  await sleep(500);
  const ch = await js(`({ on: document.querySelector('.rl-chg-btn').getAttribute('aria-pressed'), nNew: document.querySelectorAll('.rl-chg-new').length, nCh: document.querySelectorAll('.rl-chg-changed').length,
    box: (document.querySelector('.rl-chg-box') || {}).innerText || '', newTxt: (document.querySelector('.rl-chg-new') || {}).textContent || '' })`);
  check('the Changes toggle marks a new and a changed block', ch.on === 'true' && ch.nNew === 1 && ch.nCh === 1 && /Failed jobs retry/.test(ch.newTxt), JSON.stringify(ch));
  check('the Changes box lists the removed text', /Removed/i.test(ch.box) && /sent by hand every morning/.test(ch.box) && /1 changed, 1 new, 1 removed/.test(ch.box), ch.box);
  await shot('desktop-11-changes-on');
  await click('.rl-chg-btn');
  await sleep(300);
  check('toggling off clears the marks', await js(`!document.querySelector('.rl-chg') && document.querySelector('.rl-chg-box').hidden`));

  // The first visit to a newer version by someone who marked up before opens the changes by itself; nobody else gets that.
  const setSeen = (seen, marked) => js(`localStorage.setItem('redline.seen.${SLUG}', '${seen}'); ${marked ? `localStorage.setItem('redline.marked.${SLUG}', '1');` : `localStorage.removeItem('redline.marked.${SLUG}');`} 1`);
  await setSeen(1, true);
  await goto(stub.url + '?v=2');
  check('a reviewer who marked up version 1 sees the changes open on version 2', await js(`document.querySelector('.rl-chg-btn').getAttribute('aria-pressed') === 'true' && document.querySelectorAll('.rl-chg').length === 2`));
  await goto(stub.url + '?v=2');
  check('it does not open by itself the second time', await js(`document.querySelector('.rl-chg-btn').getAttribute('aria-pressed') === 'false'`));
  await setSeen(1, false);
  await goto(stub.url + '?v=2');
  check('a reviewer who never marked anything does not get it', await js(`document.querySelector('.rl-chg-btn').getAttribute('aria-pressed') === 'false'`));

  withVersion(stub.state);
  await open('phone', stub.url + '?v=2');
  await click('.rl-tab');
  await sleep(600);
  check('the fixed card fits on a phone', await js(`(() => { const c = document.querySelector('.rl-card.is-fixed'); if (!c) return false; const r = c.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; })()`));
  await shot('phone-5-revisions-panel');

  /* ---- Download PDF, hidden layers in print, nothing leaked ---- */
  await open('ipad', stub.url);
  const pdfBefore = stub.state.log.filter((l) => l.path.endsWith('sample.pdf')).length;
  await click('.rl-pdf');
  await sleep(800);
  check('Download PDF fetches the published PDF', stub.state.log.filter((l) => l.path.endsWith('sample.pdf')).length === pdfBefore + 1);
  const plain = await startStub({ port: 0, pdf: false });
  await open('ipad', plain.url);
  await js(`window.__printed = 0; window.print = () => { window.__printed++; }; 1`);
  await click('.rl-pdf');
  await sleep(300);
  check('Download PDF opens the print dialog when no PDF was published', await js(`window.__printed`) === 1);
  await js(`delete window.__printed; 1`);
  await plain.close();

  await js(`window.scrollTo(0, 0)`);
  await send('Emulation.setEmulatedMedia', { media: 'print' });
  const visible = await js(`[...document.querySelectorAll('.rl,.rl-ink-ui,.rl-ink-msg,.rl-ink-pal,.rl-ink-svg,.rl-dec')].filter((e) => getComputedStyle(e).display !== 'none').length`);
  check('print CSS hides every layer element', visible === 0, `${visible} still visible`);
  await send('Emulation.setEmulatedMedia', { media: '', features: [{ name: 'prefers-color-scheme', value: 'light' }] });

  const leaks = await js(`(() => { const f = document.createElement('iframe'); document.body.appendChild(f); const base = new Set(Object.getOwnPropertyNames(f.contentWindow)); f.remove();
    return Object.getOwnPropertyNames(window).filter((k) => !base.has(k) && !/^__REDLINE/.test(k)); })()`);
  check('no globals besides __REDLINE*', leaks.length === 0, leaks.join(','));
  const h1 = await js(`getComputedStyle(document.querySelector('main h1')).fontSize + '/' + getComputedStyle(document.querySelector('main p:not(.meta)')).fontSize`);
  check("the host page's own styles are untouched", h1 === '30px/17px', h1);

  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await click('.rl-tab');
  await sleep(500);
  await shot('ipad-8-dark-panel');
} catch (err) {
  console.log(`FAIL  test run crashed: ${err.stack || err}`);
  results.push(false);
} finally {
  try { ws && ws.close(); } catch { /* already closed */ }
  chrome.kill();
  try { await stub?.close(); } catch { /* already closed */ }
  await sleep(300);
  try { rmSync(PROFILE, { recursive: true, force: true }); } catch { /* best effort */ }
  mkdirSync(SHOTS, { recursive: true });
  cpSync(STAGE, SHOTS, { recursive: true });
  rmSync(STAGE, { recursive: true, force: true });
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  console.log('Screenshots:\n' + shots.join('\n'));
  exitCode = failed ? 1 : 0;
}
process.exit(exitCode);
