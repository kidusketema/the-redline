<p align="center"><img src="docs/banner.png" alt="The Redline: your agent writes it, you mark it up, and it reads every comment, pen mark and approval" width="100%"></p>

**The Redline lets you review the plans, specs and reports your AI coding agent writes, on your laptop, phone or iPad. Circle problems, leave comments, and approve or reject sections. Your agent reads your feedback and makes the changes.**

It replaces reading a long plan in your terminal or chat and then typing out where each change goes ("in section 3, the second bullet about pricing…").

<p align="center"><img src="docs/demo.gif" alt="Marking up a plan: a text comment, a pen circle and a question mark, then Approve" width="100%"></p>

## How it works

1. Ask your agent (Claude Code, Codex or another) to send a plan, spec or report for review. It gives you a link.
2. Open the link. Highlight text to comment, draw on the page with a pen or your finger, and press Approve or Reject.
3. Tell your agent "I left feedback". It reads every comment, pen mark and decision, makes the changes, and updates the same link so you can check each fix.

Pages are served from your own computer with no sign-up, and your phone or iPad opens them over Wi-Fi. To share a page with people elsewhere, put The Redline on Vercel, Netlify, Cloudflare or your own server. It's free and open source.

## Who it's for

- You review on an iPad or a phone, or you think faster with a pen.
- You need a yes or no from someone outside your tools, like a client or a co-founder, and you want their answer to reach your agent.
- You switch between Claude accounts, or between Claude Code and Codex, and want every review in one place.

## Why not Claude's artifacts?

Claude Code can publish a page as an [artifact](https://code.claude.com/docs/en/artifacts). Artifacts are good for dashboards and sharing results with your team. The Redline is for reviewing a document and getting precise feedback back to your agent.

| | Claude artifacts | The Redline |
|---|---|---|
| Who can comment | People with a claude.ai account and access to the artifact. Public-link viewers can't. | Anyone with the link |
| Pen markup, and Approve or Reject on each section | No | Yes |
| Checking the fix | Claude can reply to and resolve threads | You confirm each fix, and a Changes switch shows what's different |
| Accounts | Needs a Pro, Max, Team or Enterprise login, and not an API key, Bedrock or Vertex. Each artifact lives in the account that published it. | Any Claude login or model provider, and Codex. Pages live on your computer or your own host. |

Facts about artifacts are from [Anthropic's documentation](https://code.claude.com/docs/en/artifacts), October 2026.

## Try it

You need Node.js 22.13 or newer. Google Chrome is optional; with it, your agent also gets a screenshot of each pen mark, and every page gets a PDF.

In Claude Code, run:

```
/plugin marketplace add kidusketema/the-redline
/plugin install redline@the-redline
```

Then ask for a review, for example "Send the onboarding plan for review". The first time, The Redline starts on your computer by itself and your agent replies with a link.

For Codex:

```
npm install -g github:kidusketema/the-redline
redline install codex
```

For any other agent, `redline install agents` prints a short block of instructions to paste into your `AGENTS.md`.

To review on an iPad or phone, run `redline phone` and scan the QR code with a device on the same Wi-Fi. Your computer has to stay awake while you review.

## What your agent gets back

Each comment with the words it is attached to, each pen mark with the words it covers (plus a screenshot of the spot when Chrome is installed), and every decision. When it sends the next version, each fixed comment waits for you to press "Looks good" or "Not fixed".

<p align="center"><img src="docs/feedback.png" alt="The output of redline feedback: the decision, the comment with the words it is attached to, and a screenshot of a circled phrase with a handwritten question mark" width="100%"></p>

## Put it on a host

For links that work anywhere, run `redline deploy vercel`, `redline deploy netlify` or `redline deploy cloudflare`, or use the `Dockerfile` on Railway, Render, Fly or any server. In Claude Code, `/redline:setup` walks you through it. Then `redline copy` moves the pages you already have, with their feedback. Databases, limits and details for each host are in [docs/hosting.md](docs/hosting.md).

## More

- [The guide](docs/guide.md): every command, the Apple Pencil, new versions, updating and removing it.
- [Privacy and security](SECURITY.md): each page lives at its own random link that anyone who has it can read and comment on, so share links like an unlisted video and don't publish secrets. The site has no analytics and makes no outside calls.
- [Contributing](CONTRIBUTING.md): issues and pull requests are welcome. Good first projects are support for another agent (Gemini CLI, OpenCode, Cursor), another host, and marking up a running web app.

## Similar tools

[Plannotator](https://github.com/backnotprop/plannotator) reviews agent plans and code diffs in your desktop browser, and works with more agents. The Redline is for reviewing away from the keyboard: on an iPad or phone, with a pen, at a link that stays the same across versions. [Agentation](https://github.com/benjitaylor/agentation) and [React Grab](https://github.com/aidenybai/react-grab) let you point at parts of a running React app, which The Redline doesn't do yet.

## License

MIT. Pen strokes are drawn with [perfect-freehand](https://github.com/steveruizok/perfect-freehand) by Steve Ruiz; [THIRD_PARTY.md](THIRD_PARTY.md) lists the other bundled libraries.
