// A stand-in for the Netlify CLI, for testing `deploy netlify` without a Netlify account. State is a JSON file named by FAKE_STATE.
// FAKE_SIGNED_OUT=1       status says not logged in until `login` runs
// FAKE_TAKEN=1            the first project name is already taken
// FAKE_NO_DB_INIT=1       `database init` fails (a plan without Netlify Database)
// Deploying starts the real Node server with the variables imported by `env:import`.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchSite, loadState, saveState } from './fake-host.mjs';

const file = process.env.FAKE_STATE;
const state = loadState(file, { signedIn: !process.env.FAKE_SIGNED_OUT, sites: [], env: {}, calls: [], pids: [], linked: null, taken: !!process.env.FAKE_TAKEN });
const args = process.argv.slice(2);
state.calls.push(args.join(' '));
const out = (t) => console.log(t);
const die = (t) => { console.error(t); saveState(file, state); process.exit(1); };
const flag = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);

const [cmd] = args;
if (cmd === 'status') {
  out(state.signedIn ? 'Current Netlify User\n Name: Sam Example' : 'Not logged in. Please log in to see site status.');
} else if (cmd === 'login') {
  state.signedIn = true;
  out('You are now logged into your Netlify account!');
} else if (cmd === 'sites:create') {
  if (!state.signedIn) die('Error: not logged in');
  if (state.taken) { state.taken = false; die('Error: Site name already taken (name must be unique)'); }
  const site = { id: 'site-' + (state.sites.length + 1), name: flag('--name') };
  state.sites.push(site);
  out(JSON.stringify({ id: site.id, name: site.name, ssl_url: `https://${site.name}.netlify.app` }));
} else if (cmd === 'link') {
  state.linked = flag('--id');
  out('Linked to ' + state.linked);
} else if (cmd === 'database') {
  if (process.env.FAKE_NO_DB_INIT) die('Error: Netlify Database is not available on this plan.');
  state.env.NETLIFY_DB_URL = 'postgres://fake:fake@db.example/netlify';
  out('Netlify Database is ready.');
} else if (cmd === 'env:import') {
  if (!state.linked) die('Error: not linked');
  for (const line of readFileSync(args[1], 'utf8').split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line);
    if (m) state.env[m[1]] = m[2];
  }
  out('Imported.');
} else if (cmd === 'deploy') {
  if (!state.linked) die('Error: not linked');
  const here = process.cwd();
  if (flag('--dir') !== 'public' || flag('--functions') !== 'netlify/functions') die('Error: unexpected folders');
  for (const f of ['netlify.toml', 'netlify/functions/redline.mjs', 'public/_redline/redline.js', 'src/app.js']) {
    if (!existsSync(join(here, f))) die('Error: ' + f + ' is missing from the project.');
  }
  if (JSON.parse(readFileSync(join(here, 'package.json'), 'utf8')).devDependencies) die('Error: the package.json should not have devDependencies.');
  if (!state.env.REDLINE_PUBLISH_KEY) die('Error: variables are missing.');
  const site = await launchSite(state.env, { dataDir: join(process.env.FAKE_DATA_DIR || here, '.fake-data') });
  state.pids.push(site.pid);
  out(JSON.stringify({ site_id: state.linked, deploy_id: 'd1', deploy_url: 'https://d1--x.netlify.app', url: site.url }));
} else {
  die('Error: the fake Netlify does not know "' + args.join(' ') + '".');
}
saveState(file, state);
