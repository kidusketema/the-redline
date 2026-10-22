// Shared by fake-vercel.mjs, fake-netlify.mjs and fake-docker.mjs: stands in for "the host runs the site" by starting the real Node server
// with the variables the deploy module saved, and reports where it is listening.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function loadState(file, initial) {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : initial;
}
export function saveState(file, state) {
  writeFileSync(file, JSON.stringify(state, null, 2));
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = createNetServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}

// Starts site/node/server.mjs detached and waits for its ready line. A DATABASE_URL that is only a placeholder is dropped,
// so the site uses SQLite in a throwaway folder.
export async function launchSite(vars, { port, dataDir, noDatabase = false } = {}) {
  port = port || (await freePort());
  if (noDatabase) {
    // A site that is up but has no database, the way the real entries answer.
    const code = `require('http').createServer((q,s)=>{s.writeHead(503,{'Content-Type':'application/json'});s.end(JSON.stringify({error:'No database is connected yet.'}))}).listen(${port},'127.0.0.1')`;
    const proc = spawn(process.execPath, ['-e', code], { detached: true, stdio: 'ignore' });
    proc.unref();
    await new Promise((r) => setTimeout(r, 300));
    return { url: `http://127.0.0.1:${port}`, pid: proc.pid };
  }
  const env = { ...process.env, ...vars, PORT: String(port), HOST: '127.0.0.1', REDLINE_DATA_DIR: dataDir };
  for (const name of ['DATABASE_URL', 'POSTGRES_URL', 'NETLIFY_DB_URL', 'NETLIFY_DATABASE_URL']) if (/^postgres:\/\/fake/.test(env[name] || '')) delete env[name];
  const proc = spawn(process.execPath, [join(ROOT, 'site', 'node', 'server.mjs')], { detached: true, env, stdio: ['ignore', 'pipe', 'ignore'] });
  proc.unref();
  const line = await new Promise((resolve, reject) => {
    let buf = '';
    proc.stdout.on('data', (d) => { buf += d; const m = /\{.*\}/.exec(buf); if (m) resolve(JSON.parse(m[0])); });
    proc.on('exit', () => reject(new Error('the site stopped')));
    setTimeout(() => reject(new Error('the site did not start')), 20000).unref();
  });
  proc.stdout.destroy();
  return { url: line.url, pid: proc.pid };
}
