# Hosting The Redline

The Redline is one small program that can run in four places: your own computer or any server (Node), a Cloudflare Worker, a Vercel function and a Netlify function. Where the program runs is separate from where the data lives. This page lists what you need to know about each host.

Facts about hosts were checked against each host's own documentation in October 2026. Anything not yet tested on a real account is marked "not tried".

## What lives where

| Where it runs | Command | Data |
|---|---|---|
| Your computer | starts by itself the first time you publish | SQLite file and a folder of files in `~/.redline/data` |
| Cloudflare | `redline deploy cloudflare` | Cloudflare D1 (tables) and KV (files) |
| Vercel | `redline deploy vercel` | Postgres (Neon from the Vercel Marketplace, or Supabase) |
| Netlify | `redline deploy netlify` | Postgres (Netlify Database, or Supabase) |
| Railway, Render, Fly, Coolify, any server | `Dockerfile` in the repository | SQLite on a disk volume, or Postgres |

Postgres means one address, called `DATABASE_URL`. It works with Supabase, Neon, Railway, Render and any other Postgres. The site makes its own tables the first time it starts, so there is nothing to set up by hand.

## Settings

The same names everywhere, except on Cloudflare, where the two secrets are called `PUBLISH_KEY` and `DASHBOARD_TOKEN`.

| Name | What it does | Default |
|---|---|---|
| `REDLINE_PUBLISH_KEY` | The key that lets you publish and read feedback. | Made and saved in the data folder if missing (Node only) |
| `REDLINE_DASHBOARD_TOKEN` | The secret part of the dashboard link, `/d/<token>/`. | Same |
| `DATABASE_URL` | A Postgres address. When set, SQLite is not used. `POSTGRES_URL`, `NETLIFY_DB_URL` and `NETLIFY_DATABASE_URL` are read too. | none |
| `REDLINE_DATA_DIR` | Where SQLite and files go (Node, no Postgres). | `~/.redline/data` |
| `HOST`, `PORT` | Where the Node server listens. | `127.0.0.1`, `4848` |
| `REDLINE_PUBLIC_URL` | The address people use, when a tunnel or proxy sits in front. Links use it, and pages opened on it may write. | none |
| `REDLINE_PG_POOL` | How many database connections one process keeps. | 5 on Node, 1 on Vercel and Netlify |

A dashboard token can contain any characters, but the link must be encoded: `/d/` followed by `encodeURIComponent(token)`. Render's generated values contain `+`, `/` and `=`, so this matters there.

## Your computer

`node site/node/server.mjs` starts the server. When it is listening it prints one line, for example `{"ready":true,"url":"http://127.0.0.1:4848","port":4848,"host":"127.0.0.1","storage":"sqlite"}`. It stops on Ctrl-C or SIGTERM. It needs Node 22.13 or newer, because it uses the SQLite built into Node.

By default it listens on `127.0.0.1`, so only that computer can reach it. With `HOST=0.0.0.0` anyone on the same Wi-Fi who has a link can open it. A link includes a 24-character random address, and nothing else protects a page.

Requests that come through a proxy use `X-Forwarded-Proto` and `X-Forwarded-Host` for the address in links.

## Cloudflare

Unchanged. The Worker uses D1 and KV and is set up by `redline setup` (now `redline deploy cloudflare`).

Free plan limits that matter: 50 subrequests per request (so a document is cleaned up a few files at a time), 25 MB per file (the KV value limit), and at most 300 files and 60 MB per document.

## Vercel

How it works: `site/vercel.json` sends every address that is not a file to the function in `site/api/index.mjs`. The page layers in `site/public/_redline` are served as static files. The function writes to Postgres only; Vercel functions have no disk that lasts.

`redline deploy vercel` uses the Vercel command line tool. It copies the site to `~/.redline/vercel-site`, runs `vercel link`, saves the keys with `vercel env add`, and runs `vercel deploy --prod`. For the database it uses an address you give it (`--database-url`), one already on the project, or `vercel integration add neon`, which may ask you to accept Neon's terms in the terminal.

Facts:

- A function gets a standard `Request` and returns a `Response`: `export default { fetch(request) {} }` in a file under `api/`.
- The request or response body is limited to 4.5 MB. A bigger upload gets a 413 error from Vercel before it reaches the site. This is the smallest limit of any host.
- A function can run up to 300 seconds on the Hobby plan.
- The project address (`name.vercel.app`) is public. A deployment's own address can be behind Vercel sign-in, so the CLI looks for the project address.
- Neon and Supabase integrations set `POSTGRES_URL` and `DATABASE_URL`. The site reads either.

Deploy button (not tried): `https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fkidusketema%2Fthe-redline&root-directory=site&env=REDLINE_PUBLISH_KEY,REDLINE_DASHBOARD_TOKEN,DATABASE_URL&envDescription=Two%20long%20random%20secrets%20and%20a%20Postgres%20address&project-name=redline`. The button asks for the three values. It does not add a database by itself; add Neon from the project's Storage tab, or paste a Supabase address.

## Netlify

How it works: `site/netlify.toml` publishes `site/public` and runs `site/netlify/functions/redline.mjs` (a Functions v2 function) for every other path. The function's `config` is `path: "/*"` and `preferStatic: true`, so a file in `public` wins over the function.

`redline deploy netlify` uses the Netlify command line tool. It makes a project, writes the keys to a private `.env` file for `netlify env:import`, installs the site's one dependency, and runs `netlify deploy --prod --dir public --functions netlify/functions`. For the database it uses an address you give it, or `netlify database init --yes` (Netlify Database).

Facts:

- A request or response is limited to 6 MB. Binary uploads are base64-encoded on the way in, so the usable file size is about 4.5 MB. Streamed responses can be up to 20 MB.
- A function can run 60 seconds.
- Netlify Database is Postgres. It needs a credit-based plan. The Free plan gets 3 databases, 5 GB of storage and 48 compute units per billing period. We read the connection address from `NETLIFY_DB_URL` and `NETLIFY_DATABASE_URL`, but we could not confirm from Netlify's documents which one a deployed function receives (not tried). If the site answers "No database is connected yet", set `DATABASE_URL` to a Supabase or Neon address.

Deploy button (not tried): `https://app.netlify.com/start/deploy?repository=https://github.com/kidusketema/the-redline`. The `netlify.toml` at the top of the repository points it at `site/`. Set `REDLINE_PUBLISH_KEY`, `REDLINE_DASHBOARD_TOKEN` and `DATABASE_URL` in the site settings after the first deploy, then deploy again.

## Docker, Railway, Render, Fly, Coolify

The `Dockerfile` at the top of the repository builds the Node server on `node:24-slim`. It listens on `0.0.0.0:$PORT` (4848 unless the host sets `PORT`), keeps data in `/data`, and runs as root because hosts mount volumes as root.

`redline deploy docker` builds the image, replaces any container with the same name, mounts a volume called `<name>-data` at `/data`, and passes the keys in a private env file. Docker must be running. The Docker daemon was not running on the machine where this was written, so the image build is not tried here; the same steps (`npm ci --omit=dev`, then `node site/node/server.mjs`) were run by hand and work.

Per host:

- Railway: it finds the Dockerfile on its own. Add a volume mounted at `/data`. A volume holds 0.5 GB on the Free and Trial plans and 5 GB on Hobby. The Free plan includes $1 of usage a month and the Trial gives a one-time $5. For Postgres, add Railway's Postgres and set `DATABASE_URL` to its address.
- Render: press New Blueprint Instance and point it at the repository; `render.yaml` describes the service. A free Render web service has no disk and goes to sleep after 15 minutes without traffic (about a minute to wake), so use Postgres. Render's own free Postgres is deleted 30 days after it is made, so paste a Supabase or Neon address into `DATABASE_URL` for a site you want to keep. The service has 750 free hours a month.
- Fly: run `fly launch --no-deploy`, then `fly volumes create` and mount the volume at `/data` in `fly.toml`. Fly has no free plan. A new account gets a trial of 2 hours or 7 days. The smallest machine costs about $2.19 for 30 days of nonstop running and a volume costs $0.15 per GB per month. A volume attaches to one machine, so run one machine. Not tried.
- Coolify and other servers: build from the Dockerfile and mount a volume at `/data`. Not tried.

On any of these, SQLite on a volume gives the 25 MB per-file limit of the site itself. Check whether the host's proxy limits the size of a request.

## Biggest file per host

| Host | Biggest file you can publish |
|---|---|
| Your computer, Docker, Railway, Render, Fly | 25 MB (the site's own limit) |
| Cloudflare | 25 MB |
| Netlify | about 4.5 MB |
| Vercel | about 4.5 MB (the body limit; a little less for a file once encoded as JSON) |

Every host also stops at 300 files and 60 MB for one document. The copy command that moves a local site to a host sends data in batches under 3 MB, so a single file over about 3 MB cannot be copied to Vercel or Netlify. Publish it again from your computer instead; direct uploads take up to 4.5 MB there.

## Moving from your computer to a host

`GET /api/export` returns every live document as JSON: details, the live version's files (base64), comments, pen marks and every answer. `POST /api/import` takes the same JSON. Both need the publish key. Documents keep their address, so links stay the same.

- `GET /api/export?slug=<slug>` is one document. `files=0` leaves out the file bytes and lists each file's path, type and size. `file=<path>` returns just that file, for a big document that has to be moved a file at a time.
- A document in an import that has `comments`, `ink` or `decisions` replaces that list. One that leaves a key out keeps what the site has. Files are added or replaced, never removed. So sending the same export twice changes nothing.
- A new version number removes the files of older versions.
- On Cloudflare's free plan a request can touch about 20 files, so send documents with many files one at a time.

## Tests

`node test/site.mjs` runs the full site check against Cloudflare (wrangler). `--target sqlite` and `--target postgres` run it against the Node server on SQLite and on Postgres (a Postgres built for tests, reached with the same `postgres` package the real site uses). `node --test test/adapters.mjs test/adapters-deploy.mjs` covers the database layers, export and import, the Node server, the Vercel and Netlify entries called with plain requests, and the deploy modules with stand-in command line tools.
