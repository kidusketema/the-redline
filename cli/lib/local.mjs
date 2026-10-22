// Local mode: the review site runs on this computer, started on demand.
// ~/.redline/server.json records the running server (pid, port, url, code fingerprint); ~/.redline/server.log holds its output.
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join, resolve } from 'node:path';
import {
  CliError, REPO_ROOT, randomToken, readConfig, readJson, saveConfig, serverFile, serverLog, sleep, stateDir, writePrivate,
} from './common.mjs';

const DEFAULT_PORT = 4848;

export const serverEntry = () => (process.env.REDLINE_SERVER_ENTRY ? resolve(process.env.REDLINE_SERVER_ENTRY) : join(REPO_ROOT, 'site', 'node', 'server.mjs'));
export const dataDir = () => join(stateDir(), 'data');

// The key and dashboard token for the local site are made once and kept in config.json under "local".
export function localSettings() {
  const cfg = readConfig();
  if (cfg.local && cfg.local.key && cfg.local.dashboard) return cfg.local;
  const local = { ...(cfg.local || {}), key: (cfg.local && cfg.local.key) || randomBytes(24).toString('hex'), dashboard: (cfg.local && cfg.local.dashboard) || randomToken(24) };
  saveConfig({ local });
  return local;
}
export const hasLocalSite = () => { const l = readConfig().local; return !!(l && l.key); };
export function saveLocal(patch) {
  const local = { ...localSettings(), ...patch };
  saveConfig({ local });
  return local;
}

// The address other devices on the Wi-Fi use to reach this computer.
export function lanAddress() {
  if (process.env.REDLINE_LAN_IP) return process.env.REDLINE_LAN_IP;
  const found = [];
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) found.push({ name, address: a.address });
  }
  const isPrivate = (ip) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
  const pick = found.find((f) => isPrivate(f.address) && /^(en|wl|eth|wlan)/i.test(f.name)) || found.find((f) => isPrivate(f.address)) || found[0];
  return pick ? pick.address : '';
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

async function answers(url, key) {
  try { return (await fetch(url + '/api/docs', { headers: { Authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(2500) })).ok; } catch { return false; }
}

// A short fingerprint of the server code, so a newer copy of The Redline replaces an older running server.
export function codeFingerprint(entry) {
  const hash = createHash('sha256');
  if (process.env.REDLINE_SERVER_ENTRY) {
    hash.update(readFileSync(entry));
    return hash.digest('hex').slice(0, 16);
  }
  const root = join(REPO_ROOT, 'site');
  const walk = (dir, prefix) => {
    for (const name of readdirSync(dir).sort()) {
      if (['node_modules', '.wrangler', 'wrangler.jsonc', '.vercel', '.netlify'].includes(name)) continue;
      const abs = join(dir, name);
      const st = statSync(abs);
      if (st.isDirectory()) walk(abs, prefix + name + '/');
      else if (st.isFile()) hash.update(prefix + name + '\0').update(readFileSync(abs));
    }
  };
  walk(root, '');
  return hash.digest('hex').slice(0, 16);
}

export const readServerRecord = () => readJson(serverFile());

async function waitForExit(pid, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (!alive(pid)) return true; await sleep(100); }
  return !alive(pid);
}

// Stops the recorded server, but only when it still answers with our key (a reused process id is never killed).
export async function stopServer() {
  const rec = readServerRecord();
  if (!rec) return 'none';
  const local = readConfig().local || {};
  let result = 'stale';
  if (alive(rec.pid) && local.key && await answers(rec.url, local.key)) {
    try { process.kill(rec.pid, 'SIGTERM'); } catch { /* already gone */ }
    if (!await waitForExit(rec.pid, 5000)) {
      try { process.kill(rec.pid, 'SIGKILL'); } catch { /* already gone */ }
      await waitForExit(rec.pid, 2000);
    }
    result = 'stopped';
  }
  rmSync(serverFile(), { force: true });
  return result;
}

function logTail(n = 6) {
  try { return readFileSync(serverLog(), 'utf8').split('\n').map((l) => l.trim()).filter(Boolean).slice(-n).join('\n'); } catch { return ''; }
}

function serverEnv(local, port) {
  const env = { ...process.env };
  delete env.DATABASE_URL; // local mode always keeps its data in files on this computer
  Object.assign(env, {
    REDLINE_PUBLISH_KEY: local.key, REDLINE_DASHBOARD_TOKEN: local.dashboard, REDLINE_DATA_DIR: dataDir(),
    PORT: String(port), HOST: local.network ? '0.0.0.0' : '127.0.0.1',
  });
  return env;
}

function findReady(text) {
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue;
    try { const j = JSON.parse(line); if (j && j.ready && j.port) return j; } catch { /* not the ready line */ }
  }
  return null;
}

async function startDetached(entry, local, port) {
  mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  const fd = openSync(serverLog(), 'w', 0o600);
  let child;
  try {
    child = spawn(process.execPath, [entry], { detached: true, stdio: ['ignore', fd, fd], env: serverEnv(local, port), windowsHide: true });
  } finally { closeSync(fd); }
  let exited = null;
  child.once('exit', (code) => { exited = code ?? 1; });
  child.once('error', (e) => { exited = 1; });
  const end = Date.now() + 20000;
  for (;;) {
    const ready = findReady(existsSync(serverLog()) ? readFileSync(serverLog(), 'utf8') : '');
    if (ready) { child.unref(); return { pid: child.pid, port: ready.port }; }
    if (exited !== null) return { failed: logTail() };
    if (Date.now() > end) { try { process.kill(child.pid); } catch { /* gone */ } return { failed: logTail() || 'It did not start within 20 seconds.' }; }
    await sleep(50);
  }
}

// Makes sure the local server is running with the current code and network setting, and returns how to reach it.
export async function ensureServer() {
  const entry = serverEntry();
  if (!existsSync(entry)) {
    throw new CliError('The local server is missing from this copy of The Redline (' + entry + ').', 'Download The Redline again from GitHub, or put your site on a host with "redline deploy".');
  }
  const local = localSettings();
  const fingerprint = codeFingerprint(entry);
  const network = !!local.network;
  const rec = readServerRecord();
  const describe = (r) => ({ url: r.url, port: r.port, key: local.key, dashboard: local.dashboard, network: !!r.network, started: false });

  if (rec && alive(rec.pid) && await answers(rec.url, local.key)) {
    if (rec.foreground || (rec.fingerprint === fingerprint && !!rec.network === network)) return describe(rec);
    await stopServer(); // the code or the network setting changed: restart
  } else if (rec) {
    rmSync(serverFile(), { force: true });
  }

  const wanted = process.env.REDLINE_PORT !== undefined ? Number(process.env.REDLINE_PORT) : (local.port || DEFAULT_PORT);
  let started = await startDetached(entry, local, wanted);
  if (started.failed !== undefined && wanted !== 0 && /EADDRINUSE|in use/i.test(started.failed)) started = await startDetached(entry, local, 0);
  if (started.failed !== undefined) {
    throw new CliError('The local server did not start.' + (started.failed ? '\n' + started.failed : ''), 'Run "redline serve" to see what it says, or put your site on a host with "redline deploy".');
  }
  const record = { pid: started.pid, port: started.port, url: 'http://127.0.0.1:' + started.port, network, fingerprint, startedAt: new Date().toISOString() };
  writePrivate(serverFile(), record);
  if (process.env.REDLINE_PORT === undefined && local.port !== started.port) saveLocal({ port: started.port });
  return { ...describe(record), started: true };
}

// `redline serve`: run the server in this terminal until it is stopped.
export async function serveForeground({ port } = {}) {
  const entry = serverEntry();
  if (!existsSync(entry)) throw new CliError('The local server is missing from this copy of The Redline (' + entry + ').', 'Download The Redline again from GitHub.');
  const local = localSettings();
  const rec = readServerRecord();
  if (rec && alive(rec.pid) && await answers(rec.url, local.key)) {
    throw new CliError('The local server is already running at ' + rec.url + '.', 'Run "redline stop" first if you want to run it in this window instead.');
  }
  const wanted = port !== undefined ? Number(port) : process.env.REDLINE_PORT !== undefined ? Number(process.env.REDLINE_PORT) : (local.port || DEFAULT_PORT);
  const child = spawn(process.execPath, [entry], { stdio: ['ignore', 'pipe', 'inherit'], env: serverEnv(local, wanted) });
  let announced = false;
  let buffer = '';
  child.stdout.on('data', (d) => {
    process.stdout.write(d);
    if (announced) return;
    buffer += d;
    const ready = findReady(buffer);
    if (ready) {
      announced = true;
      writePrivate(serverFile(), { pid: child.pid, port: ready.port, url: 'http://127.0.0.1:' + ready.port, network: !!local.network, foreground: true, fingerprint: codeFingerprint(entry), startedAt: new Date().toISOString() });
    }
  });
  const forward = (sig) => () => { try { child.kill(sig); } catch { /* gone */ } };
  process.on('SIGINT', forward('SIGINT'));
  process.on('SIGTERM', forward('SIGTERM'));
  const code = await new Promise((done) => { child.once('exit', (c) => done(c ?? 0)); child.once('error', () => done(1)); });
  const now = readServerRecord();
  if (now && now.pid === child.pid) rmSync(serverFile(), { force: true });
  return code;
}

// The same page address, as another device on the Wi-Fi would type it.
export function wifiUrl(url, port) {
  const lan = lanAddress();
  if (!lan) return '';
  const u = new URL(url);
  return 'http://' + lan + ':' + port + u.pathname + u.search + u.hash;
}
