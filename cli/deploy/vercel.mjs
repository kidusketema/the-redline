// redline deploy vercel: puts the site on the user's own Vercel account with the Vercel CLI.
//   - the site's files are copied to a working folder and linked to a Vercel project
//   - the database is a Postgres address: given with databaseUrl, already on the project, or a new Neon database from the Vercel Marketplace
//   - the publish key and dashboard token are saved as project variables, then `vercel deploy --prod` runs
// REDLINE_VERCEL can name a script to run in place of the Vercel CLI (the tests use one).
// Vercel caps a request body at 4.5 MB, so one file or comment bigger than that cannot be uploaded to this host.
import { join } from 'node:path';
import {
  DeployError, REPO_ROOT, POSTGRES_HELP, lastLines, makeKeys, makeRunner, stageSite, stateDir, toolCommand, unique, waitForSite, writeState,
} from './common.mjs';

const PACKAGE = 'vercel@latest';
const urlsIn = (text) => [...text.matchAll(/https:\/\/[a-z0-9][a-z0-9.-]*\.vercel\.app\b/gi)].map((m) => m[0]);

export async function deploy(opts = {}) {
  const log = opts.log || opts.say || (() => {});
  const env = opts.env || process.env;
  const name = opts.name || 'redline';
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(name)) throw new DeployError('The name must be lowercase letters, digits and dashes, starting with a letter.');
  const interactive = opts.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const dir = opts.workDir || join(stateDir(opts), 'vercel-site');
  const keys = makeKeys(opts);

  log('Copying the site files...');
  stageSite(opts.siteDir || join(opts.repoRoot || REPO_ROOT, 'site'), dir);
  const run = makeRunner(toolCommand({ envVar: 'REDLINE_VERCEL', bin: 'vercel', npx: PACKAGE, env }), { cwd: dir, env });
  const fail = (what, r, hint) => new DeployError(what + '\n' + lastLines(r.out), hint || 'Run this again. If it fails the same way, send the lines above to whoever helps you.');

  let who = await run(['whoami']);
  if (who.code !== 0) {
    if (!interactive) throw new DeployError('You are not signed in to Vercel.', 'Run "npx vercel login" once, or set VERCEL_TOKEN, then run this again.');
    log('A browser window will ask you to sign in to Vercel (or create a free account).');
    await run(['login'], { inherit: true });
    who = await run(['whoami']);
    if (who.code !== 0) throw fail('Vercel did not sign in.', who, 'Run "npx vercel login", then run this again.');
  }

  log('Creating the Vercel project "' + name + '"...');
  const linked = await run(['link', '--yes', '--project', name]);
  if (linked.code !== 0) throw fail('Could not create the Vercel project.', linked);

  // The database: an address we were given, one already on the project, or a new one from the Marketplace.
  if (opts.databaseUrl) {
    log('Saving the database address...');
    const saved = await run(['env', 'add', 'DATABASE_URL', 'production', '--sensitive', '--yes', '--force'], { input: opts.databaseUrl });
    if (saved.code !== 0) throw fail('Could not save the database address.', saved);
  } else {
    const have = await run(['env', 'ls', 'production']);
    if (!/\b(DATABASE_URL|POSTGRES_URL)\b/.test(have.out)) {
      if (!interactive) throw new DeployError('This Vercel project has no database yet.', POSTGRES_HELP);
      log('Adding a free Postgres database (Neon) from the Vercel Marketplace. Vercel may ask you to accept terms.');
      const added = await run(['integration', 'add', 'neon', '--name', name + '-db'], { inherit: true });
      if (added.code !== 0) throw new DeployError('Vercel could not add a database.', POSTGRES_HELP);
    }
  }

  log('Saving the keys...');
  for (const [variable, value] of [['REDLINE_PUBLISH_KEY', keys.key], ['REDLINE_DASHBOARD_TOKEN', keys.dashboard]]) {
    const saved = await run(['env', 'add', variable, 'production', '--sensitive', '--yes', '--force'], { input: value });
    if (saved.code !== 0) throw fail('Could not save the site key.', saved);
  }

  log('Putting the site online (this can take a minute or two)...');
  const deployed = await run(['deploy', '--prod', '--yes']);
  if (deployed.code !== 0) throw fail('The site could not be put online.', deployed);
  const deploymentUrl = deployed.stdout.trim().split('\n').pop().trim();

  // The deployment's own address can be behind Vercel's sign-in; the project address (name.vercel.app) is public.
  const inspected = await run(['inspect', deploymentUrl]);
  const printed = unique(urlsIn(deployed.out));
  const aliases = unique(urlsIn(inspected.out)).filter((u) => !deploymentUrl.startsWith(u));
  const aliased = [...deployed.out.matchAll(/Aliased:\s*(https?:\/\/\S+)/g)].map((m) => m[1]);
  const candidates = unique([...aliases, ...aliased, deploymentUrl, ...printed]);
  if (!candidates.length) throw fail('The site was deployed, but its address was not in the output.', deployed, 'Open vercel.com, find the project "' + name + '", copy its address, and run "redline login <address>" with your key.');

  log('Waiting for the site to start answering (up to 2 minutes)...');
  const found = await waitForSite(candidates, keys.key, { timeoutMs: opts.waitMs ?? 120000, intervalMs: opts.intervalMs ?? 3000 });
  if (found && found.noDatabase) throw new DeployError('The site is online but cannot find its database: ' + found.noDatabase, POSTGRES_HELP);
  if (!found) throw new DeployError('The site was deployed but is not answering yet.', 'Wait a few minutes and run this again; nothing will be lost. If the address asks you to sign in to Vercel, turn off Deployment Protection for production in the project settings.');

  writeState(dir, { host: 'vercel', name, url: found.url });
  return { url: found.url, key: keys.key, dashboard: keys.dashboard, host: 'vercel', project: name };
}
