// A stand-in for the Docker CLI, for testing `deploy docker` without a Docker daemon. State is a JSON file named by FAKE_STATE.
// FAKE_DOCKER_DOWN=1      every command fails like a stopped daemon
// FAKE_PORT_TAKEN=1       `run` fails because the port is in use
// `run` starts the real Node server with the variables from --env-file, listening on the host side of -p.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchSite, loadState, saveState } from './fake-host.mjs';

const file = process.env.FAKE_STATE;
const state = loadState(file, { calls: [], pids: [], builds: [], running: {} });
const args = process.argv.slice(2);
state.calls.push(args.join(' '));
const out = (t) => console.log(t);
const die = (t) => { console.error(t); saveState(file, state); process.exit(1); };
const flag = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);

if (process.env.FAKE_DOCKER_DOWN) die('Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?');
const [cmd] = args;
if (cmd === 'version') {
  out('27.0.0');
} else if (cmd === 'build') {
  const context = args[args.length - 1];
  for (const f of ['Dockerfile', 'site/src/app.js', 'site/node/server.mjs', 'site/package.json']) {
    if (!existsSync(join(context, f))) die('ERROR: failed to compute cache key: ' + f + ' not found');
  }
  if (existsSync(join(context, 'site', 'node_modules'))) die('ERROR: node_modules must not be in the build context');
  state.builds.push(flag('-t'));
  out('Successfully built');
} else if (cmd === 'rm') {
  delete state.running[args[args.length - 1]];
} else if (cmd === 'run') {
  if (process.env.FAKE_PORT_TAKEN) die('docker: Error response from daemon: Bind for 0.0.0.0:4848 failed: port is already allocated.');
  const vars = {};
  for (const line of readFileSync(flag('--env-file'), 'utf8').split('\n')) {
    const m = /^([A-Za-z_]+)=(.*)$/.exec(line);
    if (m) vars[m[1]] = m[2];
  }
  const port = Number(flag('-p').split(':')[0]);
  const site = await launchSite(vars, { port, dataDir: join(process.env.FAKE_DATA_DIR, 'volume-' + flag('-v').split(':')[0]) });
  state.pids.push(site.pid);
  state.running[flag('--name')] = { port, volume: flag('-v'), image: args[args.length - 1] };
  out('0123456789abcdef');
} else if (cmd === 'logs') {
  out('server started');
} else {
  die('the fake Docker does not know "' + args.join(' ') + '".');
}
saveState(file, state);
