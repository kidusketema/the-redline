# Using The Redline

## Reviewing a page

- Highlight any text to comment on it, including the text inside diagrams. Click a picture to drop a numbered pin.
- Draw on the page with a pen, a finger or a mouse. There are three pen sizes, a highlighter and an eraser.
- Press Approve, Reject or Not sure, on the whole page or on each section that needs a decision.
- Markdown files work as they are. HTML pages work too, so your agent can draw diagrams and charts for you to mark up.
- Every page has a Download PDF button, and you get a private dashboard of everything you have published.

Your agent reads it all back: each comment with the words it is attached to, each pen mark with the words it covers and a screenshot of the spot, and every decision. The screenshots need Google Chrome on the computer that runs `redline feedback`. Without Chrome, the agent still gets the words each mark covers, but not the drawing.

## New versions

When the agent sends the next version, the link stays the same. Each comment it fixed waits for you to press "Looks good" or "Not fixed", the Changes switch highlights what is different, and an approval on a section that has changed since is flagged for a fresh look.

<p align="center"><img src="revisions.png" alt="The comments panel on a new version: two comments marked fixed in version 2, each with the agent's note and Looks good and Not fixed buttons" width="100%"></p>

## Your phone or iPad

Run `redline phone` (or ask your agent to). It prints a link and a QR code; scan it with a device on the same Wi-Fi. Your computer has to stay awake while you review. `redline phone --off` turns it off again. To review from anywhere, or to send a page to someone else, put The Redline on a host ([hosting.md](hosting.md)).

## Apple Pencil

The Redline started as a tool for reviewing game design documents on an iPad Pro, so the pen got a lot of attention: pressure, palm rejection, and a hover dot that shows where the tip will land.

Writing works in Safari on any iPad. Your palm and fingers scroll the page while the Pencil draws. Hold the Pencil still for half a second to open the colours, and tap with two fingers to undo.

Safari doesn't pass double-tap, squeeze, barrel roll or haptics to websites, and every browser on iPad uses Safari's engine, so no web page can use them. On a 120 Hz iPad, ink is smoother if you open Settings, then Apps, Safari, Advanced, Feature Flags, and turn off "Prefer Page Rendering Updates near 60fps".

## Commands

Your agent runs these for you. To type them yourself, install the command with `npm install -g github:kidusketema/the-redline`.

| Command | What it does |
|---|---|
| `redline publish plan.md --title "Onboarding plan"` | Publish a Markdown or HTML file, or a folder, and print its link |
| `redline publish plan.md --slug <slug>` | Publish a new version at the same link |
| `redline feedback <link> --shots` | Print every comment, pen mark and decision, with a screenshot of each marked spot |
| `redline feedback <link> --changes` | Also list the text that changed since the version before |
| `redline resolve <link> <number> --note "Moved to Friday"` | Mark a comment fixed, with a note on what changed |
| `redline phone` | Show the link and QR code for your iPad or phone |
| `redline list` | Everything you have published, with what still needs an answer |
| `redline dashboard` | Print the link to your private dashboard |
| `redline deploy <host>` | Put the site on Vercel, Netlify, Cloudflare or Docker |
| `redline copy` | Copy the pages on this computer to your host |
| `redline relink <slug>` | Give a page a new link and turn the old one off |
| `redline delete <slug> --yes` | Delete a page and all its feedback |

`redline help` lists the rest.

## Updating and removing it

In Claude Code, run `claude plugin update redline@the-redline` in a terminal. With the npm command, run `npm install -g github:kidusketema/the-redline` again. If your site is on a host, run `redline deploy <host>` again; your pages and feedback stay.

To remove it from your computer, run `redline stop` and delete the `~/.redline` folder. On a host, delete the project and its database in that host's dashboard.
