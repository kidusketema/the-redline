---
name: setup
description: Set up The Redline, on this computer (instant, no account) or on a host you already use (Vercel, Netlify, Cloudflare or a server).
disable-model-invocation: true
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/cli/redline.mjs *) Bash(node "${CLAUDE_PLUGIN_ROOT}/cli/redline.mjs" *)
---

Set up The Redline for the user.

Ask one question, and wait for the answer before running anything:

> Where should your review site run?
> 1. On this computer (recommended). It is instant and needs no account. Your iPad or phone can open it over the same Wi-Fi.
> 2. On a host you already use: Vercel, Netlify, Cloudflare or a server. Links then work anywhere, even when this computer is off.

If the user already named a place when they ran the command, skip the question.

## On this computer

Run:

```
node "${CLAUDE_PLUGIN_ROOT}/cli/redline.mjs" setup
```

It starts the site in the background, publishes a sample plan and prints the links. Give the user the sample plan link and the dashboard link as clickable lines. Then offer `redline phone`, which prints a Wi-Fi link and a QR code for an iPad or phone. Tell them plainly that anyone on the same Wi-Fi who has a link can open that page.

## On a host

Tell them what is about to happen: the host's own sign-in opens in a browser, the site goes into their account on that host, and nothing is stored anywhere else. Then run the command for the host they picked:

```
node "${CLAUDE_PLUGIN_ROOT}/cli/redline.mjs" deploy vercel --yes
node "${CLAUDE_PLUGIN_ROOT}/cli/redline.mjs" deploy netlify --yes
node "${CLAUDE_PLUGIN_ROOT}/cli/redline.mjs" deploy cloudflare --yes
node "${CLAUDE_PLUGIN_ROOT}/cli/redline.mjs" deploy docker --yes
```

Use `docker` for a server of their own (Railway, Render, Fly, a VPS). Deploying can take more than two minutes, and the Bash tool stops commands after two minutes by default. Run it with the Bash `timeout` set to 600000 (ten minutes), or in the background, and watch its output until it ends. Each slow step prints one plain line first, so a quiet gap does not mean it is stuck. Do not start a second copy while one is running.

With `--yes` it also copies any pages the user already made on this computer, with their comments and pen marks, to the new site. When it succeeds, give the user the site link and dashboard link it prints as clickable lines.

If it fails, show the one-sentence advice it printed and do what it says. Running the same command again is safe: it keeps the existing key, links and data.

If they have several Cloudflare accounts, the command asks which one. When it cannot ask, it tells the user to set `CLOUDFLARE_ACCOUNT_ID`; help them find the account id with `npx wrangler whoami`.
