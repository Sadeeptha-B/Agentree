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
one tree. Rewinds inside a Claude session and Codex prompt edits are branches
too.

Supported harnesses:

| Agent | Where it reads | What becomes a branch | Fork after a turn |
|-------|----------------|-----------------------|-------------------|
| **Claude Code** (VS Code extension or CLI) | `~/.claude/projects` | rewinds inside a session; "Fork conversation" copies | new session in Claude Code's own fork format, opened in the Claude Code panel |
| **OpenAI Codex** (VS Code extension or CLI) | `~/.codex/sessions`, `~/.codex/archived_sessions` | forks and prompt edits (`.jsonl` and `.jsonl.zst` pages) | `codex app-server` `thread/fork` at the end of a whole turn, opened in the Codex panel |
| **GitHub Copilot CLI** | `~/.copilot/session-state` | copy-truncated forks | copy-truncated session (command only) |

VS Code Copilot Chat isn't supported yet.

## Features

- **One list for every harness**, newest first and filterable by project directory.
  It updates live as agents write, and each fork family is one entry with a
  "N sessions" badge.
- **Tree view.** Long linear runs collapse into chains and branch points stay
  visible. A **dashed edge** marks where a fork (a new session) or a Codex
  prompt edit (a new branch of the same thread) begins. The current tip pulses.
- **Fork after a turn.** Inside VS Code the fork opens straight in the Claude
  Code or Codex chat panel, and it joins the tree as soon as it has a turn of
  its own. Your existing transcripts are never modified. Turns that can't be
  forked say why in the panel instead of offering the button.
- **Open / resume any session.** Use "open in Claude Code / Codex", "resume in
  terminal", or copy a resume command written for your shell (PowerShell on
  Windows, POSIX elsewhere). These continue the session's *current* path; to
  continue an older branch of it, fork at that branch's last turn.
- **Read the conversation.** Any turn renders as Markdown, with its thinking and
  tool calls. "View conversation up to here" shows the displayed turns from
  the root down to it (the agent's own context also held tool output, files
  and instructions that aren't drawn).
- **Annotate.** Star turns, label branches, and mark dead ends, which dims the
  whole abandoned subtree. Annotations live in `~/.agentree/`, never in your
  transcripts.
- **Health row.** The welcome screen shows per-harness counts: files seen,
  parsed, hidden, failed, listed, and unknown record types. A file that should
  have been a conversation but couldn't be understood counts as *failed* and
  raises a warning, so if an agent changes its on-disk format, you see it
  there.

## Using it in VS Code

### Install

Requirements: **VS Code 1.101+** (Windows, macOS or Linux), and to build it
[Node.js](https://nodejs.org) 22.15+ and git. The VS Code floor is a runtime
requirement: the extension runs on VS Code's own bundled Node, and reading
Codex's compressed history needs the zstd support that arrived with VS Code
1.101 (Electron 35, Node 22.15). Installing a newer system Node doesn't change
that.

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

New to Agentree? The **[user guide](docs/user-guide.md)** walks through the
ideas and the workflows that matter, with examples. What follows is the
short version.

1. Run **Agentree: Open Conversation Trees** from the Command Palette
   (Ctrl/Cmd+Shift+P).
2. **Welcome screen:** pick a conversation. The left rail filters by project
   directory, the agent chips above the list filter by agent, and the search
   box filters by title (forks' titles too), directory or id. Badges: `⑂ n` is
   the number of branch points, and `N sessions` means a fork family, whose
   forks are named under its title; click one to open the tree on that fork.
   The provider rows above the list are the health check.
3. **Tree:** drag to pan, wheel to zoom, and use `fit` to re-frame. Click a
   collapsed chain (a dotted line with an `n` count, meaning n hidden turns) to
   expand it. Solid edges are turns within one session; long-dashed edges
   enter a fork (tagged with the fork's name) or a Codex edited branch. Esc
   goes back to the list.
4. **Panel (right):** "Session" is the session the selected turn belongs to,
   and which session it was forked from ("probably forked from" when the
   harness recorded nothing and Agentree inferred the direction). From there:
   - **open in Claude Code / Codex** opens that session in its chat panel, at
     the end of its current path — which isn't necessarily the branch you
     selected, if the session has several;
   - **resume in terminal** opens an integrated terminal in the session's
     folder and runs `claude --resume <id>` / `codex resume <id>`, with the
     same meaning;
   - **⑂ fork after this turn** creates a new session holding everything up
     to and including the selected turn, and opens it in the chat panel.
     Continue there; the new branch appears in the tree as you go. This is
     also how you continue an older branch;
   - **star**, **label** and **mark dead end** annotate the turn.

Some turns can't be forked, and the panel says why instead of offering the
button:

- **Claude:** turns from before the session's last `/compact`, and mid-turn
  messages (fork the turn after one; that keeps it).
- **Codex:** Codex forks whole turns, so only a turn's last reply is a fork
  point, not its prompt or the commentary before a mid-turn message. A turn
  that a prompt edit replaced can be forked only while some fork of the thread
  still holds it (Agentree then forks through that thread); otherwise fork the
  turn before the edit and resend the prompt.

## Desktop app (Electron)

The same app in its own window, with the same list, tree, panel and forks.

```sh
npm install        # also builds the app
npm start          # or: npm link, then `agentree` from any terminal
```

If npm warns that "packages have install scripts not yet covered by
allowScripts", Electron's binary wasn't downloaded. Run
`npm approve-scripts electron` and then `node node_modules/electron/install.js`
once. `npm run dev` starts the hot-reload setup (Windows included).

The desktop panel has the same actions as the extension, with two
differences:

- **open in Claude Code / Codex (VS Code)** hands the session to VS Code
  through the extensions' deep links (`vscode://anthropic.claude-code/open?session=…`,
  `vscode://openai.chatgpt/local/…`), so VS Code and the extension must be
  installed.
- **resume in terminal** opens a new OS terminal window in the session's
  folder: PowerShell on Windows, Terminal.app on macOS, or the first available
  emulator on Linux.

After a fork, the desktop app shows the same buttons instead of switching to
VS Code on its own.

Windows uses the native window frame. On macOS the title bar is inset into
the app. The launchers clear `ELECTRON_RUN_AS_NODE`, which shells started from
inside VS Code inherit and which would otherwise make Electron run as plain
Node.

At launch the app checks whether the branch it was built from, on the GitHub
repo it was built from (its git `origin`), has moved past the running build.
If it has, a banner offers `git pull` + `npm install` in your shell's syntax.
An unpushed branch is never reported.

`scripts/install.sh` (the one-line `curl | sh` installer) is POSIX-only and
installs from this fork. On Windows, use the steps above.

## Configuration

The gear on the welcome screen opens the settings, stored in
`~/.agentree/settings.json` and shared by the desktop app and the extension:
the sort order (last message or tool activity, or last file change), which
agents to scan, whether to list archived Codex conversations, whether to
remember the view (compress chains, directory and agent filters), whether a
new fork opens in the chat panel, the data locations below, and (desktop
only) the launch update check. Settings change what you see and where data
lives, never how a transcript is read.

The environment variables still work, and win over the settings:

| Variable | Effect |
|---|---|
| `CLAUDE_CONFIG_DIR` | Claude Code's config root (default `~/.claude`) — the same variable the CLI honours |
| `CODEX_HOME` | Codex's root (default `~/.codex`) — same as Codex |
| `COPILOT_HOME` | Copilot CLI's root (default `~/.copilot`) |
| `AGENTREE_HOME` | Where Agentree keeps annotations, fork lineage and its settings (default `~/.agentree`). Environment only |
| `AGENTREE_CODEX_BIN` | codex binary used for forks. By default Agentree uses the one bundled with the Codex VS Code extension, then the one on `PATH` |
| `AGENTREE_NO_UPDATE_CHECK=1` | Desktop app: skip the launch-time GitHub version check |

## Privacy

Agentree runs entirely on your machine. It needs no API keys or accounts and
sends no telemetry. It never edits your transcripts:

- annotations go to `~/.agentree/`;
- a Claude fork *creates* a new transcript file next to the original;
- a Codex fork is made by Codex itself (`codex app-server`).

The only network request is the desktop app's launch-time version check
against the GitHub repo it was built from, which you can turn off as shown
above. The VS Code extension makes none.

## Development

```sh
npm test             # vitest over synthetic fixtures in test/fixtures (Node 22.15+: zstd)
npm run typecheck    # app, Electron main, and the VS Code extension
npm run fixtures     # regenerate the fixtures after changing make-fixtures.mjs
```

[AGENTS.md](AGENTS.md) holds the design notes: how each harness stores
conversations, and why the parsers and fork logic look the way they do.

## Credits

Agentree was created by [Serban Cercelescu](https://github.com/serban-cercelescu/Agentree).
This fork modernizes it for today's Claude Code and Codex VS Code extensions.
MIT licensed; see [LICENSE](LICENSE).
