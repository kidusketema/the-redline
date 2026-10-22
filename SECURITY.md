# Security

If you find a way to read a page without its link, publish or delete without the key, run a script in someone else's review, or get an agent to act on a comment as if it were a command, please tell us privately.

Use GitHub's private reporting: open the repository's Security tab and choose "Report a vulnerability". Include the steps to reproduce it and the version or commit you tested. We aim to reply within a week.

## What The Redline protects, and what it doesn't

- A page's 24-character random link is the only thing that protects it. Anyone who has the link can read the page and comment on it. That is by design, like an unlisted video.
- Publishing, changing and deleting need the publish key, which lives in `~/.redline/config.json` on your computer and in the host's settings.
- On your computer, the site only answers that computer until you run `redline phone`. After that, anyone on the same Wi-Fi who has a link can open that page.
- Comments, pen marks and names come from whoever has a link. The agent instructions treat them as notes about the document, never as commands.
