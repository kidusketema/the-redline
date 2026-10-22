// A stand-in for the Vercel CLI, for testing `deploy vercel` without a Vercel account. State is a JSON file named by FAKE_STATE.
// FAKE_SIGNED_OUT=1       whoami fails until `login` runs
// FAKE_NO_DB=1            the deployed site answers 503 "No database is connected yet."
// FAKE_FAIL=deploy        make that command fail
// Deploying starts the real Node server with the variables saved by `env add`, and prints its address like Vercel does.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchSite, loadState, saveState } from './fake-host.mjs';

const file = process.env.FAKE_STATE;
const state = loadState(file, { signedIn: !process.env.FAKE_SIGNED_OUT, project: null, env: {}, calls: [], pids: [], integrations: [] });
const args = process.argv.slice(2);
state.calls.push(args.join(' '));
const out = (t) => console.log(t);
const err = (t) => console.error(t);
const die = (t) => { err(t); saveState(file, state); process.exit(1); };
const stdin = () => { try { return readFileSync(0, 'utf8'); } catch { return ''; } };

const [cmd, sub] = args;
if (process.env.FAKE_FAIL === cmd) die('Error: something went wrong on Vercel.');

if (cmd === 'whoami') {
  if (!state.signedIn) die('Error: No existing credentials found. Please run `vercel login`.');
  out('sam-example');
} else if (cmd === 'login') {
  state.signedIn = true;
  out('Congratulations! You are now signed in.');
} else if (cmd === 'link') {
  if (!state.signedIn) die('Error: not signed in');
  state.project = args[args.indexOf('--project') + 1];
  out(`Linked to sam-example/${state.project} (created .vercel)`);
} else if (cmd === 'env' && sub === 'ls') {
  out('Environment Variables found for ' + state.project + ':\n' + Object.keys(state.env).map((n) => ' ' + n + '  Encrypted  Production').join('\n'));
} else if (cmd === 'env' && sub === 'add') {
  if (!state.project) die('Error: Your codebase isn\'t linked to a project on Vercel. Run `vercel link` to begin.');
  const value = stdin().replace(/\n$/, '');
  state.env[args[2]] = value;
} else if (cmd === 'integration' && sub === 'add') {
  state.integrations.push(args[2]);
  state.env.DATABASE_URL = 'postgres://fake:fake@neon.example/db';
  out('Neon database created and connected to the project.');
} else if (cmd === 'deploy') {
  if (!state.project) die('Error: not linked');
  const needs = ['REDLINE_PUBLISH_KEY', 'REDLINE_DASHBOARD_TOKEN'];
  if (needs.some((n) => !state.env[n])) die('Error: variables are missing.');
  // The project must be shaped the way Vercel expects.
  const here = process.cwd();
  for (const f of ['vercel.json', 'api/index.mjs', 'public/_redline/redline.js', 'src/app.js', 'package.json']) {
    try { readFileSync(join(here, f)); } catch { die('Error: ' + f + ' is missing from the project.'); }
  }
  if (JSON.parse(readFileSync(join(here, 'package.json'), 'utf8')).devDependencies) die('Error: the package.json should not have devDependencies.');
  const site = await launchSite(state.env, { dataDir: join(process.env.FAKE_DATA_DIR || here, '.fake-data'), noDatabase: !!process.env.FAKE_NO_DB });
  state.pids.push(site.pid);
  state.deployed = site.url;
  err('Inspect: https://vercel.com/sam-example/' + state.project + '/abc [2s]');
  err('Production: ' + site.url + ' [10s]');
  err('Aliased: ' + site.url + ' [11s]');
  out(site.url);
} else if (cmd === 'inspect') {
  out('Aliases\n  ╶ ' + state.deployed);
} else {
  die('Error: the fake Vercel does not know "' + args.join(' ') + '".');
}
saveState(file, state);
