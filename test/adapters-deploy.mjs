// The deploy modules (cli/deploy/vercel.mjs, netlify.mjs, docker.mjs) against stand-ins for each host's command line tool.
// Each stand-in starts the real Node server when "deployed", so the module's final check (does the site answer with the key?) is real.
// Run: node --test test/adapters-deploy.mjs
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TMP = join(ROOT, 'test', '.tmp', 'laneA', 'deploy');
const DEPLOY = (name) => import(pathToFileURL(join(ROOT, 'cli', 'deploy', name + '.mjs')).href);

const state = (file) => JSON.parse(readFileSync(file, 'utf8'));
const killAll = (file) => {
  if (!existsSync(file)) return;
  for (const pid of state(file).pids || []) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
};
const answers = async (url, key) => (await fetch(url + '/api/docs', { headers: { Authorization: 'Bearer ' + key } })).status;

// Settings for one scenario: its own folder, its own state file, and the fake tool named by the module's environment variable.
function scenario(name, tool, extraEnv = {}) {
  const dir = join(TMP, name);
  // A fake site from an earlier run can still hold its data folder open; Windows refuses to delete it then.
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (e) { if (process.platform !== 'win32' || e.code !== 'EPERM') throw e; }
  mkdirSync(dir, { recursive: true });
  const stateFile = join(dir, 'state.json');
  const env = { ...process.env, ...tool, FAKE_STATE: stateFile, FAKE_DATA_DIR: dir, ...extraEnv };
  return { dir, stateFile, env, workDir: join(dir, 'work'), stateDir: dir, intervalMs: 100, waitMs: 15000, interactive: false };
}

const files = [];
before(() => mkdirSync(TMP, { recursive: true }));
after(() => { for (const f of files) killAll(f); });

describe('vercel', () => {
  it('links, saves the keys, deploys and returns an address that answers with the key', async () => {
    const s = scenario('vercel-ok', { REDLINE_VERCEL: join(ROOT, 'test', 'fake-vercel.mjs') });
    files.push(s.stateFile);
    const logs = [];
    const { deploy } = await DEPLOY('vercel');
    const r = await deploy({ ...s, name: 'my-redline', databaseUrl: 'postgres://fake:fake@db.example/x', log: (l) => logs.push(l) });
    assert.equal(r.host, 'vercel');
    assert.match(r.key, /^[0-9a-f]{48}$/);
    assert.match(r.dashboard, /^[a-z0-9]{24}$/);
    assert.equal(await answers(r.url, r.key), 200);
    assert.equal(await answers(r.url, 'wrong-wrong-wrong-wrong'), 401);
    const st = state(s.stateFile);
    assert.equal(st.project, 'my-redline');
    assert.equal(st.env.REDLINE_PUBLISH_KEY, r.key);
    assert.equal(st.env.REDLINE_DASHBOARD_TOKEN, r.dashboard);
    assert.equal(st.env.DATABASE_URL, 'postgres://fake:fake@db.example/x');
    assert.ok(st.calls.some((c) => c.startsWith('deploy --prod')));
    // Secrets never appear on a command line.
    assert.ok(!st.calls.join('\n').includes(r.key) && !st.calls.join('\n').includes('db.example'));
    assert.ok(logs.length >= 3);
  });

  it('keeps the key it is given, so a second deploy changes nothing for computers already signed in', async () => {
    const s = scenario('vercel-again', { REDLINE_VERCEL: join(ROOT, 'test', 'fake-vercel.mjs') });
    files.push(s.stateFile);
    const { deploy } = await DEPLOY('vercel');
    const first = await deploy({ ...s, databaseUrl: 'postgres://fake:x@db/x' });
    const second = await deploy({ ...s, databaseUrl: 'postgres://fake:x@db/x', key: first.key, dashboard: first.dashboard });
    assert.equal(second.key, first.key);
    assert.equal(second.dashboard, first.dashboard);
    assert.equal(await answers(second.url, first.key), 200);
  });

  it('adds a Neon database from the Marketplace when none is given and the user can answer questions', async () => {
    const s = scenario('vercel-neon', { REDLINE_VERCEL: join(ROOT, 'test', 'fake-vercel.mjs') });
    files.push(s.stateFile);
    const { deploy } = await DEPLOY('vercel');
    await deploy({ ...s, interactive: true });
    assert.deepEqual(state(s.stateFile).integrations, ['neon']);
  });

  it('stops with a plain message when there is no database and nobody to ask', async () => {
    const s = scenario('vercel-nodb', { REDLINE_VERCEL: join(ROOT, 'test', 'fake-vercel.mjs') });
    files.push(s.stateFile);
    const { deploy, } = await DEPLOY('vercel');
    await assert.rejects(deploy(s), (e) => /no database/i.test(e.message) && /database-url/.test(e.hint));
    assert.ok(!state(s.stateFile).calls.some((c) => c.startsWith('deploy')));
  });

  it('asks the user to sign in when needed, and says what to do when it cannot ask', async () => {
    const tool = { REDLINE_VERCEL: join(ROOT, 'test', 'fake-vercel.mjs') };
    const { deploy } = await DEPLOY('vercel');
    const quiet = scenario('vercel-out', tool, { FAKE_SIGNED_OUT: '1' });
    files.push(quiet.stateFile);
    await assert.rejects(deploy({ ...quiet, databaseUrl: 'postgres://fake:x@db/x' }), (e) => /not signed in/i.test(e.message) && /vercel login/.test(e.hint));
    const asking = scenario('vercel-login', tool, { FAKE_SIGNED_OUT: '1' });
    files.push(asking.stateFile);
    const r = await deploy({ ...asking, interactive: true, databaseUrl: 'postgres://fake:x@db/x' });
    assert.ok(state(asking.stateFile).calls.includes('login'));
    assert.equal(await answers(r.url, r.key), 200);
  });

  it('reports a site that is up but has no database', async () => {
    const s = scenario('vercel-503', { REDLINE_VERCEL: join(ROOT, 'test', 'fake-vercel.mjs') }, { FAKE_NO_DB: '1' });
    files.push(s.stateFile);
    const { deploy } = await DEPLOY('vercel');
    await assert.rejects(deploy({ ...s, databaseUrl: 'postgres://fake:x@db/x' }), (e) => /cannot find its database/i.test(e.message));
  });

  it('shows the last lines when Vercel fails, and rejects a bad name', async () => {
    const s = scenario('vercel-fail', { REDLINE_VERCEL: join(ROOT, 'test', 'fake-vercel.mjs') }, { FAKE_FAIL: 'deploy' });
    files.push(s.stateFile);
    const { deploy } = await DEPLOY('vercel');
    await assert.rejects(deploy({ ...s, databaseUrl: 'postgres://fake:x@db/x' }), (e) => /could not be put online/.test(e.message) && /something went wrong on Vercel/.test(e.message));
    await assert.rejects(deploy({ ...s, name: 'Bad Name!' }), /lowercase letters/);
  });

  it('stages only what the site needs: the Vercel config, the function, the layers, and no wrangler files', async () => {
    const s = scenario('vercel-stage', { REDLINE_VERCEL: join(ROOT, 'test', 'fake-vercel.mjs') });
    files.push(s.stateFile);
    const { deploy } = await DEPLOY('vercel');
    await deploy({ ...s, databaseUrl: 'postgres://fake:x@db/x' });
    for (const f of ['vercel.json', 'api/index.mjs', 'public/_redline/redline.js', 'src/app.js', 'src/stores/postgres.js', 'package.json']) assert.ok(existsSync(join(s.workDir, f)), f);
    for (const f of ['wrangler.template.jsonc', 'package-lock.json', 'node_modules']) assert.ok(!existsSync(join(s.workDir, f)), f + ' should not be staged');
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(s.workDir, 'package.json'), 'utf8')).dependencies), ['postgres']);
  });
});

describe('netlify', () => {
  const tool = { REDLINE_NETLIFY: join(ROOT, 'test', 'fake-netlify.mjs') };

  it('creates the project, saves the keys from a private file, deploys and returns an address that answers', async () => {
    const s = scenario('netlify-ok', tool);
    files.push(s.stateFile);
    const { deploy } = await DEPLOY('netlify');
    const r = await deploy({ ...s, databaseUrl: 'postgres://fake:fake@db.example/x', install: async () => 0 });
    assert.equal(r.host, 'netlify');
    assert.equal(await answers(r.url, r.key), 200);
    const st = state(s.stateFile);
    assert.equal(st.env.REDLINE_PUBLISH_KEY, r.key);
    assert.equal(st.env.DATABASE_URL, 'postgres://fake:fake@db.example/x');
    assert.ok(st.calls.some((c) => c.startsWith('deploy --prod --dir public --functions netlify/functions')));
    assert.ok(!st.calls.join('\n').includes(r.key), 'the key was on a command line');
    assert.ok(!existsSync(join(s.dir, 'redline.env')));
  });

  it('tries another project name when the first is taken, and reuses the project on a second deploy', async () => {
    const s = scenario('netlify-taken', tool, { FAKE_TAKEN: '1' });
    files.push(s.stateFile);
    const { deploy } = await DEPLOY('netlify');
    const first = await deploy({ ...s, databaseUrl: 'postgres://fake:x@db/x', install: async () => 0 });
    assert.equal(state(s.stateFile).sites.length, 1);
    const second = await deploy({ ...s, databaseUrl: 'postgres://fake:x@db/x', key: first.key, dashboard: first.dashboard, install: async () => 0 });
    assert.equal(state(s.stateFile).sites.length, 1, 'a second project was made');
    assert.equal(second.key, first.key);
  });

  it('uses Netlify Database when no address is given, and says what to do when the plan has none', async () => {
    const ok = scenario('netlify-db', tool);
    files.push(ok.stateFile);
    const { deploy } = await DEPLOY('netlify');
    await deploy({ ...ok, install: async () => 0 });
    assert.ok(state(ok.stateFile).calls.includes('database init --yes'));
    const none = scenario('netlify-nodb', tool, { FAKE_NO_DB_INIT: '1' });
    files.push(none.stateFile);
    await assert.rejects(deploy({ ...none, install: async () => 0 }), (e) => /database/i.test(e.message) && /database-url/.test(e.hint));
  });

  it('signs in when it can ask, and says how to sign in when it cannot', async () => {
    const { deploy } = await DEPLOY('netlify');
    const quiet = scenario('netlify-out', tool, { FAKE_SIGNED_OUT: '1' });
    files.push(quiet.stateFile);
    await assert.rejects(deploy({ ...quiet, databaseUrl: 'postgres://fake:x@db/x', install: async () => 0 }), (e) => /not signed in/i.test(e.message) && /netlify login/.test(e.hint));
    const asking = scenario('netlify-login', tool, { FAKE_SIGNED_OUT: '1' });
    files.push(asking.stateFile);
    const r = await deploy({ ...asking, interactive: true, databaseUrl: 'postgres://fake:x@db/x', install: async () => 0 });
    assert.ok(state(asking.stateFile).calls.includes('login'));
    assert.equal(await answers(r.url, r.key), 200);
  });

  it('stages the Netlify config and function', async () => {
    const s = scenario('netlify-stage', tool);
    files.push(s.stateFile);
    const { deploy } = await DEPLOY('netlify');
    await deploy({ ...s, databaseUrl: 'postgres://fake:x@db/x', install: async () => 0 });
    for (const f of ['netlify.toml', 'netlify/functions/redline.mjs', 'public/_headers', 'public/_redline/redline.css', 'src/runtime.js']) assert.ok(existsSync(join(s.workDir, f)), f);
  });
});

describe('docker', () => {
  const tool = { REDLINE_DOCKER: join(ROOT, 'test', 'fake-docker.mjs') };
  const port = () => 20000 + Math.floor(Math.random() * 20000);

  it('builds from a clean context, starts the container with the keys in an env file, and returns a working address', async () => {
    const s = scenario('docker-ok', tool);
    files.push(s.stateFile);
    const { deploy } = await DEPLOY('docker');
    const p = port();
    const r = await deploy({ ...s, port: p, name: 'redline', waitMs: 15000 });
    assert.equal(r.url, `http://localhost:${p}`);
    assert.equal(await answers(r.url, r.key), 200);
    const st = state(s.stateFile);
    assert.deepEqual(st.builds, ['redline-site:redline']);
    assert.equal(st.running.redline.volume, 'redline-data:/data');
    assert.ok(!st.calls.join('\n').includes(r.key), 'the key was on a command line');
    assert.ok(st.calls[0].startsWith('version'));
  });

  it('replaces an older container and keeps the same data volume', async () => {
    const s = scenario('docker-again', tool);
    files.push(s.stateFile);
    const { deploy } = await DEPLOY('docker');
    const p = port();
    const first = await deploy({ ...s, port: p });
    killAll(s.stateFile);
    const second = await deploy({ ...s, port: p, key: first.key, dashboard: first.dashboard });
    assert.equal(second.key, first.key);
    assert.ok(state(s.stateFile).calls.includes('rm -f redline'));
    assert.equal(await answers(second.url, first.key), 200);
  });

  it('explains a stopped Docker, a busy port and a bad port', async () => {
    const { deploy } = await DEPLOY('docker');
    const down = scenario('docker-down', tool, { FAKE_DOCKER_DOWN: '1' });
    await assert.rejects(deploy({ ...down, port: port() }), (e) => /not running/i.test(e.message) && /Docker Desktop/.test(e.hint));
    const busy = scenario('docker-busy', tool, { FAKE_PORT_TAKEN: '1' });
    files.push(busy.stateFile);
    await assert.rejects(deploy({ ...busy, port: 4848 }), (e) => /could not start/i.test(e.message) && /--port/.test(e.hint));
    await assert.rejects(deploy({ ...busy, port: 99999 }), /port must be/);
  });

  it('passes a Postgres address and a public address to the container', async () => {
    const s = scenario('docker-pg', tool);
    files.push(s.stateFile);
    const { deploy } = await DEPLOY('docker');
    const r = await deploy({ ...s, port: port(), databaseUrl: 'postgres://fake:x@db/x', publicUrl: 'https://redline.example.org' });
    assert.equal(await answers(r.url, r.key), 200);
  });
});

describe('files that hosts read', () => {
  it('Dockerfile, .dockerignore and render.yaml say what they should', () => {
    const docker = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');
    assert.match(docker, /FROM node:24/);
    assert.match(docker, /HOST=0\.0\.0\.0/);
    assert.match(docker, /REDLINE_DATA_DIR=\/data/);
    assert.match(docker, /CMD \["node", "node\/server\.mjs"\]/);
    const ignore = readFileSync(join(ROOT, '.dockerignore'), 'utf8');
    assert.match(ignore, /site\/node_modules/);
    const render = readFileSync(join(ROOT, 'render.yaml'), 'utf8');
    for (const part of ['runtime: docker', 'plan: free', 'REDLINE_PUBLISH_KEY', 'REDLINE_DASHBOARD_TOKEN', 'DATABASE_URL', 'healthCheckPath: /robots.txt']) assert.ok(render.includes(part), part);
  });

  it('vercel.json sends everything that is not a file to the function; netlify.toml publishes public/', () => {
    const v = JSON.parse(readFileSync(join(ROOT, 'site', 'vercel.json'), 'utf8'));
    assert.deepEqual(v.rewrites, [{ source: '/(.*)', destination: '/api' }]);
    assert.equal(v.outputDirectory, 'public');
    assert.ok(statSync(join(ROOT, 'site', v.outputDirectory, '_redline', 'redline.js')).isFile());
    const n = readFileSync(join(ROOT, 'site', 'netlify.toml'), 'utf8');
    assert.match(n, /publish = "public"/);
    assert.match(n, /functions = "netlify\/functions"/);
  });
});
