// redline deploy netlify: puts the site on the user's own Netlify account with the Netlify CLI.
//   - the site's files are copied to a working folder and a Netlify project is made for them
//   - the database is a Postgres address (databaseUrl), or Netlify Database when the account has it
//   - the publish key and dashboard token are saved as project variables, then `netlify deploy --prod` runs
// REDLINE_NETLIFY can name a script to run in place of the Netlify CLI (the tests use one).
// Netlify caps a request body at about 6 MB (about 4.5 MB of file once encoded), so a bigger file cannot be uploaded to this host.
import { join } from 'node:path';
import { spawnTool } from '../lib/common.mjs';
import {
  DeployError, REPO_ROOT, POSTGRES_HELP, lastLines, makeKeys, makeRunner, randomToken, readState, secretFile, stageSite, stateDir, toolCommand, waitForSite, writeState,
} from './common.mjs';

const PACKAGE = 'netlify-cli@latest';

function jsonIn(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

function install(dir, env) {
  return new Promise((done) => {
    const win = process.platform === 'win32';
    const proc = spawnTool(win ? 'npm.cmd' : 'npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: dir, env, stdio: 'ignore', shell: win });
    proc.on('error', () => done(1));
    proc.on('close', (code) => done(code ?? 1));
  });
}

export async function deploy(opts = {}) {
  const log = opts.log || opts.say || (() => {});
  const env = opts.env || process.env;
  const name = opts.name || 'redline';
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(name)) throw new DeployError('The name must be lowercase letters, digits and dashes, starting with a letter.');
  const interactive = opts.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const dir = opts.workDir || join(stateDir(opts), 'netlify-site');
  const keys = makeKeys(opts);

  log('Copying the site files...');
  stageSite(opts.siteDir || join(opts.repoRoot || REPO_ROOT, 'site'), dir);
  const run = makeRunner(toolCommand({ envVar: 'REDLINE_NETLIFY', bin: 'netlify', npx: PACKAGE, env }), { cwd: dir, env });
  const fail = (what, r, hint) => new DeployError(what + '\n' + lastLines(r.out), hint || 'Run this again. If it fails the same way, send the lines above to whoever helps you.');

  let status = await run(['status']);
  if (status.code !== 0 || /not logged in|not signed in|no user/i.test(status.out)) {
    if (!interactive && !env.NETLIFY_AUTH_TOKEN) throw new DeployError('You are not signed in to Netlify.', 'Run "npx netlify login" once, or set NETLIFY_AUTH_TOKEN, then run this again.');
    if (interactive) {
      log('A browser window will ask you to sign in to Netlify (or create a free account).');
      await run(['login'], { inherit: true });
      status = await run(['status']);
      if (status.code !== 0 || /not logged in|not signed in|no user/i.test(status.out)) throw fail('Netlify did not sign in.', status, 'Run "npx netlify login", then run this again.');
    }
  }

  // The project. A rerun reuses the one made the first time.
  let saved = readState(dir);
  let siteId = saved.host === 'netlify' ? saved.siteId : '';
  let siteName = saved.siteName || '';
  if (!siteId) {
    log('Creating the Netlify project...');
    for (let attempt = 0; attempt < 4 && !siteId; attempt++) {
      const candidate = attempt === 0 && opts.exactName ? name : `${name}-${randomToken(6)}`;
      const created = await run(['sites:create', '--name', candidate, '--disable-linking', '--json']);
      const info = jsonIn(created.stdout);
      if (created.code === 0 && info && (info.id || info.site_id)) { siteId = info.id || info.site_id; siteName = info.name || candidate; }
      else if (!/already|taken|unique|in use/i.test(created.out)) throw fail('Could not create the Netlify project.', created);
    }
    if (!siteId) throw new DeployError('Could not find a free Netlify project name.', 'Run this again with --name <something else>.');
  }
  writeState(dir, { host: 'netlify', siteId, siteName });
  const linked = await run(['link', '--id', siteId]);
  if (linked.code !== 0) throw fail('Could not link the Netlify project.', linked);

  const vars = { REDLINE_PUBLISH_KEY: keys.key, REDLINE_DASHBOARD_TOKEN: keys.dashboard };
  if (opts.databaseUrl) vars.DATABASE_URL = opts.databaseUrl;
  else {
    log('Setting up Netlify Database...');
    const db = await run(['database', 'init', '--yes']);
    if (db.code !== 0) throw new DeployError('Netlify could not set up a database for this project.', POSTGRES_HELP);
  }

  // Variables go in a private file that is deleted straight after, not on the command line.
  log('Saving the keys...');
  const dotenv = secretFile('redline.env', Object.entries(vars).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
  try {
    const imported = await run(['env:import', dotenv.file, '--site', siteId]);
    if (imported.code !== 0) throw fail('Could not save the site key.', imported);
  } finally { dotenv.remove(); }

  log("Installing the site's tools...");
  const installed = await (opts.install ? opts.install(dir) : install(dir, env));
  if (installed) throw new DeployError('Could not install the site\'s tools.', 'Check your internet connection and run this again.');

  log('Putting the site online (this can take a minute or two)...');
  const deployed = await run(['deploy', '--prod', '--dir', 'public', '--functions', 'netlify/functions', '--site', siteId, '--json']);
  if (deployed.code !== 0) throw fail('The site could not be put online.', deployed);
  const info = jsonIn(deployed.stdout) || {};
  const urls = [info.url, info.ssl_url, info.site_url, info.deploy_url].filter((u) => typeof u === 'string');
  if (!urls.length) throw fail('The site was deployed, but its address was not in the output.', deployed, 'Open app.netlify.com, find the project, copy its address, and run "redline login <address>" with your key.');

  log('Waiting for the site to start answering (up to 2 minutes)...');
  const found = await waitForSite(urls, keys.key, { timeoutMs: opts.waitMs ?? 120000, intervalMs: opts.intervalMs ?? 3000 });
  if (found && found.noDatabase) {
    throw new DeployError('The site is online but cannot find its database: ' + found.noDatabase, POSTGRES_HELP);
  }
  if (!found) throw new DeployError('The site was deployed but is not answering yet.', 'Wait a few minutes and run this again; nothing will be lost.');

  writeState(dir, { host: 'netlify', siteId, siteName, url: found.url });
  return { url: found.url, key: keys.key, dashboard: keys.dashboard, host: 'netlify', project: siteName };
}
