// redline deploy docker: builds the site as a container image and runs it with Docker on this machine (or the one DOCKER_HOST points at).
// The data lives in a Docker volume, so it survives restarts and new versions. Railway, Render, Fly and Coolify build the same Dockerfile
// themselves; see docs/hosting.md.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  DeployError, REPO_ROOT, lastLines, makeKeys, makeRunner, secretFile, stateDir, toolCommand, waitForSite,
} from './common.mjs';

export async function deploy(opts = {}) {
  const log = opts.log || opts.say || (() => {});
  const env = opts.env || process.env;
  const name = opts.name || 'redline';
  if (!/^[a-z][a-z0-9_.-]{0,39}$/.test(name)) throw new DeployError('The name must be lowercase letters, digits and dashes, starting with a letter.');
  const port = Number(opts.port || 4848);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new DeployError('The port must be a number from 1 to 65535.');
  const keys = makeKeys(opts);
  const root = opts.repoRoot || REPO_ROOT;
  const run = makeRunner(toolCommand({ envVar: 'REDLINE_DOCKER', bin: 'docker', env }), { env });
  const fail = (what, r, hint) => new DeployError(what + '\n' + lastLines(r.out), hint || 'Run this again. If it fails the same way, send the lines above to whoever helps you.');

  const up = await run(['version', '--format', '{{.Server.Version}}']);
  if (up.code !== 0) throw new DeployError('Docker is not running.', 'Install Docker Desktop (docker.com), open it, wait until it says it is running, then run this again.');

  if (!existsSync(join(root, 'Dockerfile')) || !existsSync(join(root, 'site', 'src', 'app.js'))) {
    throw new DeployError(`The Dockerfile or the site files are missing from this copy of The Redline (${root}).`, 'Download The Redline again from GitHub.');
  }
  // Only what the image needs goes to Docker as its build context.
  const context = opts.workDir || join(stateDir(opts), 'docker-site');
  rmSync(context, { recursive: true, force: true });
  mkdirSync(context, { recursive: true });
  cpSync(join(root, 'Dockerfile'), join(context, 'Dockerfile'));
  const skip = new Set(['node_modules', '.wrangler', 'wrangler.jsonc', '.dev.vars', '.vercel', '.netlify']);
  mkdirSync(join(context, 'site'));
  for (const entry of readdirSync(join(root, 'site'))) if (!skip.has(entry)) cpSync(join(root, 'site', entry), join(context, 'site', entry), { recursive: true });

  const image = `redline-site:${name}`;
  log('Building the image (the first time takes a minute or two)...');
  const built = await run(['build', '-t', image, context]);
  if (built.code !== 0) throw fail('Docker could not build the site.', built);

  // Same name, same data volume: an old container is replaced and nothing is lost.
  await run(['rm', '-f', name]);
  const vars = { REDLINE_PUBLISH_KEY: keys.key, REDLINE_DASHBOARD_TOKEN: keys.dashboard };
  if (opts.databaseUrl) vars.DATABASE_URL = opts.databaseUrl;
  if (opts.publicUrl) vars.REDLINE_PUBLIC_URL = opts.publicUrl;
  const envFile = secretFile('redline.env', Object.entries(vars).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
  log('Starting it...');
  let started;
  try {
    started = await run([
      'run', '-d', '--name', name, '--restart', 'unless-stopped', '-p', `${port}:4848`, '-v', `${name}-data:/data`, '--env-file', envFile.file, image,
    ]);
  } finally { envFile.remove(); }
  if (started.code !== 0) {
    const taken = /port is already allocated|address already in use/i.test(started.out);
    throw fail('Docker could not start the site.', started, taken ? `Something else is using port ${port}. Run this again with --port <another number>.` : undefined);
  }

  const url = `http://localhost:${port}`;
  log('Waiting for the site to start answering...');
  const found = await waitForSite([url], keys.key, { timeoutMs: opts.waitMs ?? 60000, intervalMs: opts.intervalMs ?? 1000 });
  if (!found) {
    const logs = await run(['logs', '--tail', '8', name]);
    throw new DeployError('The container started but the site is not answering.\n' + lastLines(logs.out, 6), `Look at the lines above, or run "docker logs ${name}".`);
  }
  return { url: found.url, key: keys.key, dashboard: keys.dashboard, host: 'docker', container: name };
}
