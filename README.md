<p align="center">
  <img src="assets/logo-256.png" alt="Agentree" width="96" height="96">
</p>

<h1 align="center">Agentree</h1>

<p align="center">
  See your coding-agent conversations as trees. Fork them anywhere.
</p>

---

<p align="center">
  <img src="assets/screenshot.png" alt="Agentree showing a branched Claude Code session: the conversation tree on the left, the selected turn's details and fork actions on the right" width="900">
</p>

**Agentree** reads the session files your coding agents already keep on disk
and draws each conversation as an interactive tree: every prompt, reply and
branch, across all your projects, in one place. It runs as a **VS Code
extension** (the main way to use it) or as a standalone desktop app.

It shows the branches the agents' own UIs hide. When you fork a conversation
from a message in the Claude Code or Codex chat panel, the fork becomes a new
session; Agentree finds those sessions and stitches the whole family back into
one tree. Codex prompt edits are branches too, and they're drawn the same way.

Supported harnesses:

| Agent | Where it reads | What becomes a branch | Fork after a turn |
|-------|----------------|-----------------------|-------------------|
| **Claude Code** (VS Code extension or CLI) | `~/.claude/projects` | rewinds inside a session; "Fork conversation" copies | new session in Claude Code's own fork format, opened in the Claude Code panel |
| **OpenAI Codex** (VS Code extension or CLI) | `~/.codex/sessions`, `~/.codex/archived_sessions` | forks and prompt edits (`.jsonl` and `.jsonl.zst` pages) | `codex app-server` `thread/fork`, opened in the Codex panel |
| **GitHub Copilot CLI** | `~/.copilot/session-state` | copy-truncated forks | copy-truncated session (command only) |

VS Code Copilot Chat isn't supported yet.

## Features

- **One list for every harness**, newest first and filterable by project directory.
  It updates live as agents write, and each fork family is one entry with a
  "N sessions" badge.
- **Tree view.** Long linear runs collapse into chains and branch points stay
  visible. A **dashed edge** marks where a branch moves into a different
  session (a fork, or a Codex prompt edit). The current tip pulses.
- **Fork after any turn.** Inside VS Code the fork opens straight in the Claude
  Code or Codex chat panel, and it joins the tree as soon as it has a turn of
  its own. Your existing transcripts are never modified.
- **Open / resume any session.** Use "open in Claude Code / Codex", "resume in
  terminal", or copy a resume command written for your shell (PowerShell on
  Windows, POSIX elsewhere).
- **Read the conversation.** Any turn renders as Markdown, with its thinking and
  tool calls. "View conversation up to here" shows the whole prefix.
- **Annotate.** Star turns, label branches, and mark dead ends, which dims the
  whole abandoned subtree. Annotations live in `~/.agentree/`, never in your
  transcripts.
- **Health row.** The welcome screen shows per-harness counts: files seen,
  parsed, hidden, listed, and unknown record types. If an agent changes its
  on-disk format, you see it there.

## Using it in VS Code

### Install

Requirements: VS Code 1.90+ (Windows, macOS or Linux), [Node.js](https://nodejs.org) 20+, git.

```sh
git clone <this repo> Agentree
cd Agentree
npm install
npm run build:vscode
cd vscode-ext
npm run package                                 # → agentree-<version>.vsix
code --install-extension agentree-0.2.0.vsix
```

Reload VS Code if it asks. To hack on it, open the repo in VS Code and press
**F5**. That launches an Extension Development Host with the extension loaded
from `vscode-ext/dist`, so re-run `npm run build:vscode` after each change.

### Everyday use

1. Run **Agentree: Open Conversation Trees** from the Command Palette
   (Ctrl/Cmd+Shift+P).
2. **Welcome screen:** pick a conversation. The left rail filters by project
   directory and the search box filters by title, directory or id. Badges:
   `⑂ n` is the number of branch points, and `N sessions` means a fork family.
   The provider rows above the list are the health check.
3. **Tree:** drag to pan, wheel to zoom, and use `fit` to re-frame. Click a
   collapsed chain (`⋯ n`) to expand it. Solid edges are turns within one
   session; dashed edges enter a fork or a Codex prompt edit. Esc goes back to
   the list.
4. **Panel (right):** "Session" is the session the selected turn belongs to.
   From there:
   - **open in Claude Code / Codex** opens that session in its chat panel;
   - **resume in terminal** opens an integrated terminal in the session's
     folder and runs `claude --resume <id>` / `codex resume <id>`;
   - **⑂ fork after this turn** creates a new session holding everything up
     to and including the selected turn, and opens it in the chat panel.
     Continue there; the new branch appears in the tree as you go;
   - **star**, **label** and **mark dead end** annotate the turn.

A few turns can't be forked. Claude refuses turns from before a `/compact`
and mid-turn messages it never recorded; the panel explains why. A Codex turn
that was later replaced by a prompt edit can still be forked: Agentree forks
from that branch's own page.

## Desktop app (Electron)

```sh
npm install
npm run build
npm start
```

On some npm setups, Electron's postinstall download is blocked ("packages have
install scripts not yet covered by allowScripts"). Run
`npm approve-scripts electron` (or `node node_modules/electron/install.js`),
then `npm start`. `npm run dev` starts the hot-reload setup on every OS. The
desktop app shows copyable resume/fork commands instead of opening VS Code
panels.

`scripts/install.sh` and `bin/agentree.cjs` (the one-line installer and the
`agentree` launcher) are **POSIX-only** and install from the upstream
repository. On Windows, use the steps above.

## Configuration

| Variable | Effect |
|---|---|
| `CLAUDE_CONFIG_DIR` | Claude Code's config root (default `~/.claude`) — the same variable the CLI honours |
| `CODEX_HOME` | Codex's root (default `~/.codex`) — same as Codex |
| `AGENTREE_HOME` | Where Agentree keeps annotations and fork lineage (default `~/.agentree`) |
| `AGENTREE_CODEX_BIN` | codex binary used for forks. By default Agentree uses the one bundled with the Codex VS Code extension, then the one on `PATH` |
| `AGENTREE_NO_UPDATE_CHECK=1` | Desktop app: skip the launch-time GitHub version check |

## Privacy

Agentree runs entirely on your machine. It needs no API keys or accounts and
sends no telemetry. It never edits your transcripts:

- annotations go to `~/.agentree/`;
- a Claude fork *creates* a new transcript file next to the original;
- a Codex fork is made by Codex itself (`codex app-server`).

The only network request is the desktop app's launch-time version check
against GitHub, which you can turn off as shown above. The VS Code extension
makes none.

## Development

```sh
npm test             # vitest over synthetic fixtures in test/fixtures
npm run typecheck    # app, Electron main, and the VS Code extension
npm run fixtures     # regenerate the fixtures after changing make-fixtures.mjs
```

[AGENTS.md](AGENTS.md) holds the design notes: how each harness stores
conversations, and why the parsers and fork logic look the way they do.
