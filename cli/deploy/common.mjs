// Shared by the deploy modules (vercel.mjs, netlify.mjs, docker.mjs). No dependencies, Node 22 or newer.
// Each module exports deploy(opts) and returns { url, key, dashboard }. It drives the host's own command line tool,
// the way `redline setup` drives wrangler, and never puts a secret on a command line when the tool has another way to take it.
import { spawnSync } from 'node:child_process';
import { randomBytes, randomInt } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnTool } from '../lib/common.mjs';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Same shape as the CLI's own errors: a plain message and, when there is one, the next thing to try.
export class DeployError extends Error {
  constructor(message, hint = '') { super(message); this.hint = hint; }
}

export const stripAnsi = (s) => String(s).replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const lastLines = (text, n = 4) => stripAnsi(text).split('\n').map((l) => l.trim()).filter(Boolean).slice(-n).join('\n');

export function randomToken(length) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length }, () => chars[randomInt(chars.length)]).join('');
}

// An existing key and dashboard token are kept, so every computer signed in to the site keeps working.
export function makeKeys(opts) {
  return { key: opts.key || randomBytes(24).toString('hex'), dashboard: opts.dashboard || randomToken(24) };
}

export function stateDir(opts = {}) {
  return opts.stateDir || join(homedir(), '.redline');
}

// How to start a host's tool: a script named by an environment variable (the tests use fakes), else the tool on the PATH, else npx.
export function toolCommand({ envVar, bin, npx, env = process.env }) {
  if (envVar && env[envVar]) return { cmd: process.execPath, pre: [env[envVar]], shell: false };
  const win = process.platform === 'win32';
  const found = spawnSync(win ? 'where' : 'which', [bin], { stdio: 'ignore' });
  if (found.status === 0) return { cmd: bin, pre: [], shell: win };
  if (!npx) throw new DeployError(`${bin} is not installed.`, `Install ${bin} and run this again.`);
  return { cmd: win ? 'npx.cmd' : 'npx', pre: ['--yes', npx], shell: win };
}

// Runs a tool and collects what it prints. inherit: true hands the terminal to it (a login, a question it asks).
export function makeRunner(tool, { cwd, env = process.env } = {}) {
  return (args, { input, inherit = false, cwd: here = cwd, extraEnv } = {}) => new Promise((done) => {
    const stdio = inherit ? 'inherit' : [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'];
    const proc = spawnTool(tool.cmd, [...tool.pre, ...args], { cwd: here, env: { ...env, NO_COLOR: '1', ...extraEnv }, stdio, shell: tool.shell });
    let stdout = '', stderr = '';
    if (!inherit) {
      proc.stdout.on('data', (d) => { stdout += d; });
      proc.stderr.on('data', (d) => { stderr += d; });
      if (input !== undefined) proc.stdin.end(input);
    }
    proc.on('error', (e) => done({ code: 1, stdout: '', stderr: String(e.message), out: String(e.message) }));
    proc.on('close', (code) => done({ code: code ?? 1, stdout: stripAnsi(stdout), stderr: stripAnsi(stderr), out: stripAnsi(stdout + stderr) }));
  });
}

// Copies site/ into a folder the host tool can deploy. Keeps what the tool wrote there before (.vercel, .netlify, node_modules).
export function stageSite(siteDir, dest) {
  if (!existsSync(join(siteDir, 'src', 'app.js'))) {
    throw new DeployError(`The site files are missing from this copy of The Redline (${siteDir}).`, 'Download The Redline again from GitHub.');
  }
  mkdirSync(dest, { recursive: true });
  const keep = new Set(['.vercel', '.netlify', 'node_modules', '.redline-deploy.json']);
  for (const name of readdirSync(dest)) if (!keep.has(name)) rmSync(join(dest, name), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  const skip = new Set(['node_modules', '.wrangler', 'wrangler.jsonc', 'wrangler.template.jsonc', '.dev.vars', 'package-lock.json', '.vercel', '.netlify']);
  for (const name of readdirSync(siteDir)) if (!skip.has(name)) cpSync(join(siteDir, name), join(dest, name), { recursive: true });
  // Only what the running site needs; Cloudflare's tools and the test tools stay out.
  const pkg = JSON.parse(readFileSync(join(siteDir, 'package.json'), 'utf8'));
  writeFileSync(join(dest, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version, private: true, type: 'module', engines: pkg.engines, dependencies: pkg.dependencies }, null, 2) + '\n');
}

export function readState(dir) {
  try { return JSON.parse(readFileSync(join(dir, '.redline-deploy.json'), 'utf8')); } catch { return {}; }
}
export function writeState(dir, state) {
  const file = join(dir, '.redline-deploy.json');
  writeFileSync(file, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
}

// A private temporary file for secrets; call the returned remove() when the tool is done with it.
export function secretFile(name, text) {
  const dir = join(tmpdir(), 'redline-' + randomBytes(6).toString('hex'));
  mkdirSync(dir, { mode: 0o700 });
  const file = join(dir, name);
  writeFileSync(file, text, { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch { /* not supported on this system */ }
  return { file, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

// Asks a site whether it is up and accepts the key. Returns 'ok', 'no-database' (the site runs but has no database) or 'no'.
export async function siteState(url, key) {
  try {
    const res = await fetch(url.replace(/\/+$/, '') + '/api/docs', { headers: { Authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(10000) });
    if (res.ok) return 'ok';
    if (res.status === 503) {
      const body = await res.json().catch(() => ({}));
      if (/database/i.test(String(body.error || ''))) return 'no-database';
    }
  } catch { /* not answering yet */ }
  return 'no';
}

// Tries each address until one answers (a new address can take a short while to resolve).
export async function waitForSite(urls, key, { timeoutMs = 120000, intervalMs = 3000 } = {}) {
  const end = Date.now() + timeoutMs;
  do {
    for (const url of urls) {
      const state = await siteState(url, key);
      if (state === 'ok') return { url };
      if (state === 'no-database') return { noDatabase: url }; // the site answered and says it has no database; waiting will not fix that
    }
    if (Date.now() >= end) break;
    await sleep(intervalMs);
  } while (Date.now() < end);
  return null;
}

export const unique = (list) => [...new Set(list.filter(Boolean).map((u) => u.replace(/\/+$/, '')))];

export const POSTGRES_HELP = 'Make a free Postgres database (Supabase, Neon or your host), copy its connection address, and run this again with --database-url <address>.';
