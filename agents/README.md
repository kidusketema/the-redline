# Instructions for coding agents

These files teach a coding agent to publish pages to The Redline and read the feedback back. Claude Code gets the same text through the plugin in `skills/redline/SKILL.md`.

| File | What it is |
|---|---|
| `redline.md` | The full instructions. It is the single source for the Codex skill and for `skills/redline/SKILL.md`. |
| `AGENTS.md` | A short block to paste into the `AGENTS.md` of any project, for agents that read that file. |

## Codex

Run `redline install codex`. It writes `SKILL.md` into `~/.codex/skills/redline/` (or `$CODEX_HOME/skills/redline/`), which is where Codex looks for skills. Start a new Codex session afterwards. The skill tells Codex how to run the command line, so it works without `redline` being on the path.

To put the skill in another folder, run `redline install codex --dir <skills folder>`.

## Other agents

Run `redline install agents` to print the `AGENTS.md` block, then paste it into your project's `AGENTS.md`. Any agent that can run shell commands can use it. The only requirement is Node.js 22 or newer.

## Keeping the files in sync

Everything from the heading "Before you start" down is identical in `redline.md` and `skills/redline/SKILL.md`. Edit `redline.md`, then copy that part across. The tests fail if the two drift apart.
