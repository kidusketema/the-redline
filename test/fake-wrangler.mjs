// A stand-in for wrangler that prints what the real one prints (banner, colour codes, tables), for testing `redline setup`
// without a Cloudflare account. State lives in the JSON file named by FAKE_WRANGLER_STATE.
// FAKE_WRANGLER_URL    address the site really answers on; secrets are reported to it, and it is printed after a deploy
// FAKE_WRANGLER_PRINT_URL  print this address after a deploy instead (a site with a custom domain)
// FAKE_WRANGLER_OLD=1  behave like a wrangler that has no `deploy --secrets-file`
// FAKE_WRANGLER_ACCOUNTS=2  list two accounts
// FAKE_WRANGLER_FAIL=deploy  make that command fail with a Cloudflare error
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const stateFile = process.env.FAKE_WRANGLER_STATE;
const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : { signedIn: false, databases: [], namespaces: [], calls: [], deploys: 0 };
const save = () => writeFileSync(stateFile, JSON.stringify(state, null, 2));
const args = process.argv.slice(2);
state.calls.push(args.join(' '));

const BANNER = '\u001b[1m ⛅️ wrangler 4.136.1\u001b[0m\n───────────────────';
const ACCOUNTS = [
  { name: "Sam Example's Account", id: '0123456789abcdef0123456789abcdef' },
  { name: 'Second Team', id: 'fedcba9876543210fedcba9876543210' },
].slice(0, Number(process.env.FAKE_WRANGLER_ACCOUNTS || 1));

function out(text) { console.log(text); }
function die(text) { console.error(text); save(); process.exit(1); }

const [cmd, sub] = args;
if (process.env.FAKE_WRANGLER_FAIL === cmd) die('✘ [ERROR] A request to the Cloudflare API failed. [code: 10000]');

if (cmd === 'whoami') {
  out(BANNER);
  if (!state.signedIn) out('You are not authenticated. Please run `wrangler login`.');
  else {
    out('Getting User settings...\n👋 You are logged in with an OAuth Token, associated with the email sam@example.com.');
    out('┌──────────────────────────┬──────────────────────────────────┐\n│ Account Name             │ Account ID                       │\n├──────────────────────────┼──────────────────────────────────┤');
    out(ACCOUNTS.map((a) => `│ ${a.name.padEnd(24)} │ ${a.id} │`).join('\n├──────────────────────────┼──────────────────────────────────┤\n'));
    out('└──────────────────────────┴──────────────────────────────────┘');
  }
} else if (cmd === 'login') {
  state.signedIn = true;
  out('Attempting to login via OAuth...\nOpening a link in your default browser: https://dash.cloudflare.com/oauth2/auth?response_type=code&client_id=fake\nSuccessfully logged in.');
} else if (cmd === 'd1' && sub === 'list') {
  out(JSON.stringify(state.databases.map((d) => ({ uuid: d.id, name: d.name, version: 'production', created_at: '2026-10-22T10:00:00.000Z' })), null, 2));
} else if (cmd === 'd1' && sub === 'create') {
  const name = args[2];
  if (state.databases.some((d) => d.name === name)) die(`✘ [ERROR] A database with that name already exists [code: 7502]`);
  const id = randomUUID();
  state.databases.push({ name, id });
  out(`${BANNER}\n✅ Successfully created DB '${name}' in region WEUR\nCreated your new D1 database.\n\n{\n  "d1_databases": [\n    {\n      "binding": "DB",\n      "database_name": "${name}",\n      "database_id": "${id}"\n    }\n  ]\n}`);
} else if (cmd === 'kv' && sub === 'namespace' && args[2] === 'list') {
  // Real wrangler prints the list as JSON, with no banner.
  out(JSON.stringify(state.namespaces.map((n) => ({ id: n.id, title: n.title, supports_url_encoding: true })), null, '  '));
} else if (cmd === 'kv' && sub === 'namespace' && args[2] === 'create') {
  const title = args[3];
  if (state.namespaces.some((n) => n.title === title)) die(`✘ [ERROR] A KV namespace with the title "${title}" already exists.`);
  const id = randomUUID().replaceAll('-', '');
  state.namespaces.push({ title, id });
  out(`${BANNER}\n🌀 Creating namespace with title "${title}"\n✨ Success!\nTo access your new KV Namespace in your Worker, add the following snippet to your configuration file:\n{\n  "kv_namespaces": [\n    {\n      "binding": "${title.replace(/[^a-zA-Z0-9]+/g, '_')}",\n      "id": "${id}"\n    }\n  ]\n}`);
} else if (cmd === 'd1' && sub === 'execute') {
  const config = join(process.cwd(), 'wrangler.jsonc');
  if (!existsSync(config)) die('✘ [ERROR] No wrangler config found, so the database name cannot be resolved.');
  if (!args.includes('--remote')) die('✘ [ERROR] The fake only supports --remote.');
  const file = args[args.indexOf('--file') + 1];
  if (!file || !existsSync(join(process.cwd(), file))) die('✘ [ERROR] The SQL file was not found.');
  state.schemaApplied = (state.schemaApplied || 0) + 1;
  out(`${BANNER}\n🌀 Executing on remote database ${args[2]}:\n🚣 Executed 9 commands in 0.8ms`);
} else if (cmd === 'deploy') {
  const config = join(process.cwd(), 'wrangler.jsonc');
  if (!existsSync(config)) die('✘ [ERROR] Missing entry-point to Worker script or to assets directory');
  if (/__[A-Z_]+__/.test(readFileSync(config, 'utf8'))) die('✘ [ERROR] The config still has placeholders.');
  let secrets = null;
  const i = args.indexOf('--secrets-file');
  if (i >= 0) {
    if (process.env.FAKE_WRANGLER_OLD) die('✘ [ERROR] Unknown arguments: secrets-file');
    secrets = JSON.parse(readFileSync(args[i + 1], 'utf8'));
  }
  if (secrets) state.secrets = secrets;
  const v = args.indexOf('--var');
  state.build = v >= 0 ? args[v + 1] : null;
  state.deploys++;
  const url = process.env.FAKE_WRANGLER_PRINT_URL || process.env.FAKE_WRANGLER_URL || 'https://redline.sam-example.workers.dev';
  out(`${BANNER}\nTotal Upload: 142.31 KiB / gzip: 31.02 KiB\nWorker Startup Time: 14 ms\nYour Worker has access to the following bindings:\n- D1 Databases:\n  - DB: redline\nUploaded redline (2.84 sec)\n\u001b[32mDeployed redline triggers (1.12 sec)\u001b[0m\n  ${url}\nCurrent Version ID: 7a1c0f9e-0000-4000-8000-000000000000`);
  if (secrets) await report(secrets);
} else if (cmd === 'secret' && sub === 'bulk') {
  state.secrets = JSON.parse(readFileSync(args[2], 'utf8'));
  out(`${BANNER}\n🌀 Creating the secrets for the Worker "redline"\n✨ 2 secrets successfully uploaded`);
  await report(state.secrets);
} else {
  die(`✘ [ERROR] The fake wrangler does not know "${args.join(' ')}".`);
}
save();

// A real deploy makes the secrets live on the site; the test's mock site learns them the same way.
async function report(secrets) {
  if (process.env.FAKE_WRANGLER_URL) {
    await fetch(process.env.FAKE_WRANGLER_URL + '/__secrets', { method: 'POST', body: JSON.stringify(secrets) });
  }
}
