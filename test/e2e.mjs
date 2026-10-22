// The whole round trip on this computer, with no Cloudflare account: a local copy of the site (wrangler dev), the real CLI
// publishing the sample plan, headless Chrome marking it up like a reader on an iPad (a comment, a pen circle and a question
// mark, Approve), then `redline feedback --shots`, `list` and `resolve` reading it back.
// Then the page is fixed and published again: `resolve --note` marks the comment fixed, the reviewer presses "Looks good" in the
// page, feedback shows it confirmed, and an approval given before a section was edited is shown as needing another look.
// The flow runs twice: against a local copy of the site on Cloudflare's runtime (wrangler dev), and against the default a new user
// gets, where there is no saved site and the CLI starts the Node server on this computer itself.
// Run `npm install` in site/ once, then: node test/e2e.mjs
//   --mode wrangler|local  run only one of the two
//   --record <folder>  also save a PNG frame of the page every few hundred milliseconds while it is marked up (for the demo GIF)
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = join(ROOT, "site");
const modeAt = process.argv.indexOf("--mode");
const MODE = modeAt > 0 ? process.argv[modeAt + 1] : null; // null: run both, each in its own process
const LOCAL = MODE === "local";
if (!MODE && process.argv.indexOf("--record") < 0) {
  let bad = 0;
  for (const m of ["wrangler", "local"]) {
    console.log(`\n=== ${m === "local" ? "the default path: no saved site, the CLI starts the Node server" : "wrangler dev (Cloudflare's runtime)"} ===`);
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--mode", m], { stdio: "inherit" });
    if (r.status !== 0) bad++;
  }
  process.exit(bad ? 1 : 0);
}
const TMP = join(ROOT, "test", ".tmp", LOCAL ? "e2e-local" : "e2e");
const RUN = join(TMP, "run");
const STATE = join(TMP, "state");
const HOME = join(TMP, "home");
const SHOTS = join(TMP, "shots");
const WRANGLER = join(SITE, "node_modules", "wrangler", "bin", "wrangler.js");
const CLI = join(ROOT, "cli", "redline.mjs");
const CHROME = process.env.REDLINE_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const recordAt = process.argv.indexOf("--record");
const RECORD = recordAt > 0 ? process.argv[recordAt + 1] : null;

if (!LOCAL && !existsSync(WRANGLER)) { console.error("Run `npm install` in site/ first."); process.exit(2); }
if (!existsSync(CHROME)) { console.error("Needs Chrome (set REDLINE_CHROME to its path)."); process.exit(2); }

const KEY = randomBytes(24).toString("hex");
const DASHBOARD = randomBytes(12).toString("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve) => {
  const s = createServer();
  s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
});
const results = [];
function check(name, ok, detail = "") {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? "  " + detail : ""}`);
}

/* ---------- the site, on a free local port ---------- */
const wranglerEnv = { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1", NO_COLOR: "1" };
let server, chrome, base;
function stop() {
  for (const p of [server, chrome]) if (p && p.pid) { try { process.kill(-p.pid, "SIGKILL"); } catch { /* already gone */ } }
  if (LOCAL) { // the Node server the CLI started on its own
    try { process.kill(JSON.parse(readFileSync(join(HOME, "server.json"), "utf8")).pid, "SIGKILL"); } catch { /* never started, or already stopped */ }
  }
}
process.on("exit", stop);
process.on("SIGINT", () => { stop(); process.exit(130); });
setTimeout(() => { console.log("FAIL  the test took longer than 5 minutes"); stop(); process.exit(1); }, 300_000).unref();

async function startSite() {
  rmSync(TMP, { recursive: true, force: true });
  if (LOCAL) { mkdirSync(HOME, { recursive: true }); return; } // nothing to start: the first CLI command does it
  mkdirSync(RUN, { recursive: true });
  for (const p of ["src", "public", "schema.sql"]) cpSync(join(SITE, p), join(RUN, p), { recursive: true });
  symlinkSync(join(SITE, "node_modules"), join(RUN, "node_modules"));
  const template = readFileSync(join(SITE, "wrangler.template.jsonc"), "utf8");
  writeFileSync(join(RUN, "wrangler.jsonc"), template.replaceAll("__NAME__", "redline-e2e").replaceAll("__DATABASE_ID__", "00000000-0000-0000-0000-000000000000"));
  writeFileSync(join(RUN, ".dev.vars"), `PUBLISH_KEY=${KEY}\nDASHBOARD_TOKEN=${DASHBOARD}\nBUILD=e2e\n`);
  const schema = spawnSync("node", [WRANGLER, "d1", "execute", "redline-e2e", "--local", "--persist-to", STATE, "--file", "schema.sql"], { cwd: RUN, env: wranglerEnv, encoding: "utf8" });
  assert.equal(schema.status, 0, `schema failed: ${schema.stderr || schema.stdout}`);
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn("node", [WRANGLER, "dev", "--local", "--ip", "127.0.0.1", "--port", String(port), "--persist-to", STATE], { cwd: RUN, env: wranglerEnv, detached: true, stdio: "ignore" });
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(base + "/robots.txt", { signal: AbortSignal.timeout(3000) })).ok) return; } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error("The dev server did not start.");
}

// The CLI as a user runs it, pointed at the local site and a throwaway settings folder.
let localPort = 0;
function redline(...args) {
  const clean = { ...process.env };
  for (const k of Object.keys(clean)) if (k.startsWith("REDLINE_")) delete clean[k];
  const env = LOCAL
    ? { ...clean, REDLINE_HOME: HOME, REDLINE_PORT: String(localPort), REDLINE_CHROME: CHROME, NO_COLOR: "1" } // no saved site, no address: the default for a new user
    : { ...clean, REDLINE_HOME: HOME, REDLINE_URL: base, REDLINE_KEY: KEY, REDLINE_CHROME: CHROME, NO_COLOR: "1" };
  const r = spawnSync("node", [CLI, ...args], { env, encoding: "utf8", timeout: 120_000 });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

/* ---------- Chrome over the DevTools protocol ---------- */
let ws, msgId = 0;
const waiting = new Map();
const pageErrors = [];
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    waiting.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function js(expr) {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r.result.value;
}
let frame = 0;
const frameTimes = [];
const markers = {}; // which frame each step of the demo starts on, for adding captions to the GIF
async function startChrome() {
  const port = await freePort();
  const profile = mkdtempSync(join(tmpdir(), "redline-e2e-chrome-"));
  chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
    "--mute-audio", "--hide-scrollbars", "--window-size=820,1180", "about:blank"], { stdio: "ignore", detached: true });
  let target;
  for (let i = 0; i < 60 && !target; i++) {
    try { target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json(); } catch { await sleep(250); }
  }
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r));
  ws.addEventListener("message", (m) => {
    const d = JSON.parse(m.data);
    if (d.id && waiting.has(d.id)) { const w = waiting.get(d.id); waiting.delete(d.id); d.error ? w.reject(new Error(d.error.message)) : w.resolve(d.result); }
    else if (d.method === "Runtime.exceptionThrown") pageErrors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
    else if (d.method === "Page.screencastFrame") {
      writeFileSync(join(RECORD, `f${String(++frame).padStart(4, "0")}.png`), Buffer.from(d.params.data, "base64"));
      frameTimes.push(d.params.metadata.timestamp);
      send("Page.screencastFrameAck", { sessionId: d.params.sessionId }).catch(() => {});
    }
  });
  for (const d of ["Page", "Runtime"]) await send(`${d}.enable`);
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
  // An iPad Air (portrait for the test, landscape for the demo recording): touch screen, and the Pencil arrives as pointerType "pen".
  await send("Emulation.setDeviceMetricsOverride", RECORD ? { width: 1180, height: 820, deviceScaleFactor: 1, mobile: true } : { width: 820, height: 1180, deviceScaleFactor: 2, mobile: true });
  await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
}

const pause = (ms) => sleep(RECORD ? ms : Math.min(ms, 300));
async function tap(sel) {
  const c = await js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  if (!c) throw new Error("no element " + sel);
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: c[0], y: c[1], button: "left", buttons: 1, clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: c[0], y: c[1], button: "left", buttons: 0, clickCount: 1 });
}
// One Pencil stroke through the given points, with a little pressure change along the way.
async function pen(points) {
  const at = (i) => ({ x: points[i][0], y: points[i][1], pointerType: "pen", force: 0.25 + 0.15 * Math.sin((i / points.length) * Math.PI) });
  await send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", buttons: 1, clickCount: 1, ...at(0) });
  for (let i = 1; i < points.length; i++) {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", button: "left", buttons: 1, ...at(i) });
    if (RECORD) await sleep(14);
  }
  const last = points[points.length - 1];
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: last[0], y: last[1], button: "left", buttons: 0, clickCount: 1, pointerType: "pen" });
}
// Where a phrase sits on screen (the first time it appears inside an element matching sel), and selects it if asked.
const phrase = (sel, text, select) => js(`(() => { const w = document.createTreeWalker(document.querySelector(${JSON.stringify(sel)}), NodeFilter.SHOW_TEXT);
  for (let n; (n = w.nextNode());) { const i = n.nodeValue.indexOf(${JSON.stringify(text)}); if (i < 0) continue;
    const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + ${text.length});
    ${select ? "const s = getSelection(); s.removeAllRanges(); s.addRange(r);" : ""}
    const b = r.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; } return null; })()`);

/* ---------- the run ---------- */
try {
  await startSite();
  if (LOCAL) localPort = await freePort();
  if (RECORD) { rmSync(RECORD, { recursive: true, force: true }); mkdirSync(RECORD, { recursive: true }); }

  const pub = redline("publish", join(ROOT, "examples", "sample-plan.html"), "--title", "Plan: a weekly digest email", "--project", "Pantry Notes");
  const url = (pub.out.match(/http:\/\/(?:127\.0\.0\.1|localhost):\d+\/[a-z0-9]{24}\//) || [])[0];
  if (LOCAL) base = new URL(url).origin;
  check("redline publish prints the page link", pub.code === 0 && !!url, pub.out);
  const html = await (await fetch(url)).text();
  check("the live page carries the review tools and a PDF", html.includes("window.__REDLINE") && /"pdf":"\/[a-z0-9]{24}\/[^"]+\.pdf"/.test(html), html.slice(-600));

  await startChrome();
  await send("Page.navigate", { url });
  for (let i = 0; i < 40 && !(await js("!!document.querySelector('.rl-pdf')").catch(() => false)); i++) await sleep(150);
  await sleep(600);
  if (RECORD) await send("Page.startScreencast", { format: "png", everyNthFrame: 1 });
  await pause(1200);

  // A reader selects a phrase and comments on it.
  markers.comment = frame + 1;
  const anchor = "every Sunday";
  const sel = await phrase("main", anchor, true);
  check("the sample plan has the phrase the test comments on", !!sel);
  await pause(700);
  await tap(".rl-selbtn");
  await pause(500);
  await js(`document.querySelector('.rl-composer .rl-who input').value = 'Sam'; document.querySelector('.rl-composer textarea').focus(); 1`);
  for (const ch of "Could this go out Saturday morning instead?") { await send("Input.insertText", { text: ch }); if (RECORD) await sleep(35); }
  await pause(600);
  await tap(".rl-composer .rl-primary");
  await pause(1200);

  // Then circles a word with the Pencil and writes a question mark next to it.
  markers.pen = frame + 1;
  await js(`(() => { const w = document.createTreeWalker(document.querySelector('main'), NodeFilter.SHOW_TEXT);
    for (let n; (n = w.nextNode());) if (n.nodeValue.includes('3 percentage points')) { n.parentElement.scrollIntoView({ block: 'center' }); return 1; } })()`);
  await pause(1000);
  const word = await phrase("main", "3 percentage points", false);
  check("the sample plan has the phrase the test circles", !!word);
  const cx = word.x + word.w / 2, cy = word.y + word.h / 2, rx = word.w / 2 + 14, ry = word.h / 2 + 9;
  const ring = [];
  for (let i = 0; i <= 44; i++) { const a = -1.9 + (i / 44) * 2.15 * Math.PI; ring.push([cx + rx * Math.cos(a) + Math.sin(i) * 0.8, cy + ry * Math.sin(a)]); }
  await pen(ring);
  await pause(400);
  const qx = word.x + word.w + 34, qy = word.y - 6, q = [];
  // The hook of the question mark runs clockwise from its left side over the top to its bottom, then the stem drops.
  for (let i = 0; i <= 16; i++) { const a = Math.PI * 1.1 + (i / 16) * Math.PI * 1.4; q.push([qx + 8 * Math.cos(a), qy + 8 * Math.sin(a)]); }
  q.push([qx, qy + 12], [qx, qy + 17]);
  await pen(q);
  await pause(250);
  await pen([[qx, qy + 25], [qx + 0.6, qy + 25.8], [qx, qy + 26.4]]);
  await pause(1200);

  // And approves the first decision.
  markers.approve = frame + 1;
  await js(`document.querySelector('[data-redline-decision="weekly-cooks"]').scrollIntoView({ block: 'center' }); 1`);
  await pause(900);
  await tap('[data-redline-decision="weekly-cooks"] .rl-dec-btn[data-v="approve"]');
  await pause(1600);
  if (RECORD) {
    await send("Page.stopScreencast");
    // An ffmpeg concat list, so each frame is shown for as long as it was on screen.
    const lines = [];
    for (let i = 1; i <= frame; i++) lines.push(`file 'f${String(i).padStart(4, "0")}.png'`, `duration ${((frameTimes[i] ?? frameTimes[i - 1] + 1.5) - frameTimes[i - 1]).toFixed(3)}`);
    writeFileSync(join(RECORD, "frames.txt"), lines.join("\n") + `\nfile 'f${String(frame).padStart(4, "0")}.png'\n`);
    writeFileSync(join(RECORD, "markers.json"), JSON.stringify(markers));
    console.log(`Saved ${frame} frames to ${RECORD}`);
  }
  check("no script errors on the live page", pageErrors.length === 0, pageErrors.join(" | "));
  const ink = (await (await fetch(url.replace(/\/([a-z0-9]{24})\/$/, "/api/$1/ink"))).json()).ink;
  check("both pen marks and the dot were saved", ink.length === 3, `got ${ink.length}`);

  // Claude reads it all back.
  const fb = redline("feedback", url, "--shots", SHOTS);
  check("feedback shows the comment with its anchor", fb.out.includes("Saturday morning") && fb.out.includes(anchor), fb.out);
  check("feedback shows the decision", /approve/i.test(fb.out) && fb.out.includes("weekly-cooks"), fb.out);
  check("feedback groups the pen marks with the words they cover", /3 (pen )?(marks|strokes)/i.test(fb.out) && fb.out.includes("3 percentage points"), fb.out);
  const pngs = (fb.out.match(/\S+\.png/g) || []).filter((p) => existsSync(p));
  check("feedback --shots saves a screenshot of the marked spot", pngs.length >= 1 && pngs.every((p) => statSync(p).size > 5000), fb.out);
  console.log("\n" + fb.out.trim().split("\n").map((l) => "    " + l).join("\n") + "\n");

  const list = redline("list", "--json");
  let row = null;
  try { row = JSON.parse(list.out).find((d) => url.includes(d.slug)); } catch { /* checked below */ }
  check("redline list counts the feedback", !!row && row.open_comments === 1 && row.ink_strokes === 3 && row.new_feedback === true, list.out);

  const slug = url.match(/([a-z0-9]{24})\/$/)[1];
  const id = (JSON.parse(redline("feedback", url, "--json").out).comments[0] || {}).id;

  // The author fixes the page: the send day moves, and the head count in the section the reviewer approved changes.
  const v2file = join(TMP, "sample-plan-v2.html");
  const v1 = readFileSync(join(ROOT, "examples", "sample-plan.html"), "utf8");
  const v2 = v1.replace("One email every Sunday, in the morning.", "One email every Saturday, in the morning.").replace("Roughly 36,000 people", "Roughly 35,000 people");
  check("the sample plan has the sentences the fix edits", v2 !== v1 && v2.includes("every Saturday") && v2.includes("35,000"));
  writeFileSync(v2file, v2);
  const again = redline("publish", v2file, "--slug", slug, "--title", "Plan: a weekly digest email", "--project", "Pantry Notes");
  check("publishing again at the same link makes version 2", again.code === 0 && again.out.includes(slug) && /version 2/i.test(again.out), again.out);

  const res = redline("resolve", url, String(id), "--note", "Moved the send to Saturday morning.");
  const mid = JSON.parse(redline("feedback", url, "--json").out);
  const c1 = mid.comments.find((c) => c.id === id) || {};
  check("redline resolve --note marks the comment fixed, not done, and keeps the note", res.code === 0 && c1.status === "fixed" && c1.fix_note === "Moved the send to Saturday morning." && c1.fixed_version === 2, res.out + JSON.stringify(c1));
  const waiting = redline("feedback", url, "--changes");
  check("feedback says what is waiting for the reviewer", /Version 2\. Since version 1: 1 fixed and waiting for you/.test(waiting.out) && /1 decision needs another look/.test(waiting.out), waiting.out.slice(0, 500));
  check("feedback gives the note and the old approval as needing a fresh decision", waiting.out.includes("Moved the send to Saturday morning.") && /fresh decision/i.test(waiting.out), waiting.out);
  check("feedback --changes lists what changed", /every Saturday/.test(waiting.out) && /35,000/.test(waiting.out), waiting.out);
  console.log("\n" + waiting.out.trim().split("\n").slice(0, 14).map((l) => "    " + l).join("\n") + "\n");
  const listed = JSON.parse(redline("list", "--json").out).find((d) => url.includes(d.slug)) || {};
  check("redline list counts fixed separately from open", listed.open_comments === 0 && listed.fixed_comments === 1 && listed.done_comments === 0 && listed.stale_decisions === 1, JSON.stringify(listed).slice(0, 400));

  // The reviewer comes back to the new version: the changes open on their own, the fix is waiting, the old approval has gone stale.
  await send("Page.navigate", { url });
  for (let i = 0; i < 40 && !(await js("!!document.querySelector('.rl-chg-btn') && !!document.querySelector('.rl-pdf')").catch(() => false)); i++) await sleep(150);
  await sleep(1200);
  const auto = await js("({ on: document.querySelector('.rl-chg-btn').getAttribute('aria-pressed'), n: document.querySelectorAll('.rl-chg').length, ls: JSON.stringify(localStorage) })");
  check("the changes open by themselves for a reviewer who marked up version 1", auto.on === "true" && auto.n >= 2, JSON.stringify(auto));
  const decText = await js(`document.querySelector('[data-redline-decision="weekly-cooks"] .rl-dec-state').textContent`);
  check("the old approval says the section has changed since", /Approved .*on version 1\. This section has changed since\./.test(decText), decText);
  check("no decision button shows as chosen on the changed section", await js(`[...document.querySelectorAll('[data-redline-decision="weekly-cooks"] .rl-dec-btn')].every((b) => b.getAttribute('aria-pressed') === 'false')`));
  await tap(".rl-tab");
  await sleep(600);
  const panel = await js("document.querySelector('.rl-panel').innerText");
  check("the panel shows the fix note with Looks good and Not fixed", panel.includes("Moved the send to Saturday morning.") && /Looks good/.test(panel) && /Not fixed/.test(panel), panel.slice(0, 400));
  await js(`[...document.querySelectorAll('.rl-card.is-fixed .rl-acts button')].find((b) => b.textContent.trim() === 'Looks good').click(); 1`);
  await sleep(1200);
  const rawFeedback = (u) => fetch(u.replace(/\/([a-z0-9]{24})\/$/, "/api/$1/feedback")).then((r) => r.json());
  const done = await rawFeedback(url);
  check("pressing Looks good makes the comment done", (done.comments.find((c) => c.id === id) || {}).status === "done", JSON.stringify(done.summary));
  const confirmed = redline("feedback", url);
  check("feedback now counts it as confirmed", /1 confirmed/.test(confirmed.out) && !/1 fixed and waiting/.test(confirmed.out), confirmed.out.slice(0, 400));
  const listed2 = JSON.parse(redline("list", "--json").out).find((d) => url.includes(d.slug)) || {};
  check("redline list counts it as confirmed", listed2.fixed_comments === 0 && listed2.done_comments === 1, JSON.stringify(listed2).slice(0, 300));
  check("the old approval still needs another look until the reviewer decides again", done.summary.decisions_to_redo === 1 && done.decisions.every((d) => d.stale !== false || d.item !== "weekly-cooks"), JSON.stringify(done.summary));
  await js("document.querySelector('[data-redline-decision=\"weekly-cooks\"]').scrollIntoView({ block: 'center' }); 1");
  await sleep(500);
  await tap('[data-redline-decision="weekly-cooks"] .rl-dec-btn[data-v="approve"]');
  await sleep(1200);
  const redone = JSON.parse(redline("feedback", url, "--json").out);
  check("deciding again on version 2 clears the warning", redone.summary.decisions_to_redo === 0, JSON.stringify(redone.summary));
  check("no script errors on the second version", pageErrors.length === 0, pageErrors.join(" | "));

  // The owner can take the link back: a new link, the old one stops, and the marks stay.
  const moved = redline("relink", slug);
  const newUrl = (moved.out.match(/https?:\/\/[^\s/]+\/[a-z0-9]{24}\//) || [])[0];
  check("redline relink prints a new link", moved.code === 0 && !!newUrl && !newUrl.includes(slug), moved.out);
  if (newUrl) {
    check("the old link stops working", (await fetch(url)).status === 404);
    const kept = await rawFeedback(newUrl);
    check("comments, marks and decisions carry over to the new link", kept.comments.length === 1 && kept.ink.length === 3 && kept.decisions.length >= 1, JSON.stringify(kept.summary));
  }

  if (!LOCAL) {
    const dash = await fetch(`${base}/d/${DASHBOARD}/`);
    check("the dashboard lists the page", dash.ok && (await dash.text()).includes("weekly digest email"));
  } else {
    const stopped = redline("stop");
    check("redline stop stops the local site", stopped.code === 0, stopped.out);
    check("nothing answers on the local port any more", await fetch(base + "/robots.txt", { signal: AbortSignal.timeout(2000) }).then(() => false, () => true));
  }
} catch (e) {
  check("the run finished", false, e.stack || String(e));
} finally {
  stop();
}
const failed = results.filter((r) => !r).length;
console.log(failed ? `\n${failed} of ${results.length} checks failed.` : `\nAll ${results.length} checks passed.`);
process.exit(failed ? 1 : 0);
