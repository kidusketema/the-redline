---
name: publish
description: Publish a Markdown file, an HTML file or a folder to your Redline site and print the review link.
argument-hint: <file-or-folder> [title]
disable-model-invocation: true
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/cli/redline.mjs *) Bash(node "${CLAUDE_PLUGIN_ROOT}/cli/redline.mjs" *)
---

Publish what the user pointed at: `$ARGUMENTS`

The first word is the file or folder: a `.md` or `.html` file, or a folder with an `index.html`, `index.md` or `README.md`. Anything after it is the title; if there is none, the page's own title is used (the first `# Heading` of a Markdown file, or the `<title>` of an HTML page).

Nothing needs setting up first. The site starts on this computer by itself, unless the user already put it on a host.

Run:

```
node "${CLAUDE_PLUGIN_ROOT}/cli/redline.mjs" publish <file-or-folder> --title "<title>"
```

Leave `--title` out when no title was given. Print the full link it returns on its own line so it is clickable, and tell the user to open it, mark it up, and tell you when they are done. If it also prints a Wi-Fi link, give them that one for their iPad or phone. If this page was published before and the user wants the same link, add `--slug <slug>`.

If the user wants to read it on an iPad or phone and no Wi-Fi link was printed, offer to run `redline phone`. It prints a link and a QR code, and anyone on the same Wi-Fi who has a link can open that page.
