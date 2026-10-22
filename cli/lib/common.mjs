// Shared helpers for the command line: errors, the settings folder, config files.
import { spawn } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export class CliError extends Error {
  constructor(message, hint = '') { super(message); this.hint = hint; }
}
export class UsageError extends Error {}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const stripAnsi = (s) => String(s).replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');

export const stateDir = () => process.env.REDLINE_HOME || join(homedir(), '.redline');
export const configFile = () => join(stateDir(), 'config.json');
export const recentFile = () => join(stateDir(), 'recent.json');
export const serverFile = () => join(stateDir(), 'server.json');
export const serverLog = () => join(stateDir(), 'server.log');

export function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}
// The key is a password, so the file is private to the user (mode 600) and the folder too.
export function writePrivate(file, data) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  chmodSync(file, 0o600);
}
export const readConfig = () => readJson(configFile()) || {};
export const saveConfig = (patch) => { const next = { ...readConfig(), ...patch }; writePrivate(configFile(), next); return next; };

export function randomToken(length) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length }, () => chars[randomInt(chars.length)]).join('');
}

export function normalizeUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try { return new URL(s).origin; } catch { return ''; }
}

// cmd.exe quoting for one word of a command line (the .cmd shims for npx, wrangler and vercel parse it like any Windows program).
function quoteForCmd(word) {
  const text = String(word);
  if (text !== '' && /^[A-Za-z0-9_@%+=:,./\\-]+$/.test(text)) return text;
  return '"' + text.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
}

// spawn() for tools that may be .cmd shims on Windows. With shell: true Node warns (DEP0190) when given an args array,
// so the shell case builds one quoted command string instead. Without a shell it is a plain spawn.
export function spawnTool(cmd, args, options = {}) {
  if (!options.shell) return spawn(cmd, args, options);
  const line = [cmd, ...args].map(quoteForCmd).join(' ');
  return spawn(line, options);
}
