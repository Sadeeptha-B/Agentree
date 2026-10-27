<p align="center">
  <img src="https://raw.githubusercontent.com/Sadeeptha-B/Agentree/main/assets/logo-256.png" alt="Agentree" width="96" height="96">
</p>

<h1 align="center">Agentree</h1>

<p align="center">
  See your coding-agent conversations as trees. Fork them anywhere.
</p>

---

**Agentree** reads the session files your coding agents already keep on disk
and draws each conversation as an interactive tree: every prompt, reply and
branch, across all your projects. Run **Agentree: Open Conversation Trees**
from the Command Palette.

When you "fork from a message" in the Claude Code or Codex chat panel, the fork
becomes a separate session. Agentree stitches every such family back into one
tree, with a dashed edge where each fork begins. Claude rewinds and Codex
prompt edits show up as branches too.

Requires VS Code 1.101 or newer (for the zstd support Codex's compressed
history needs).

| Agent | Reads | Fork after a turn |
|-------|-------|-------------------|
| **Claude Code** (extension or CLI) | `~/.claude/projects` | new session in Claude Code's fork format, opened in the Claude Code panel |
| **OpenAI Codex** (extension or CLI) | `~/.codex/sessions` (+ `archived_sessions`, `.jsonl.zst`) | `thread/fork` through `codex app-server` at the end of a whole turn, opened in the Codex panel |
| **GitHub Copilot CLI** | `~/.copilot/session-state` | copy-truncated session (command only) |

## Use

- **Welcome screen:** conversations newest first, a directory rail, search, and
  one health row per agent (files seen / parsed / failed / listed).
- **Tree:** drag to pan, wheel to zoom, click a dotted `n` chain to expand it.
  Long-dashed edges enter a fork or an edited branch.
- **Panel:** for the selected turn's session you get **open in Claude Code /
  Codex** and **resume in terminal** (both continue the session's current
  path), **⑂ fork after this turn** (opens the fork in the chat panel; the way
  to continue any other branch), and star / label / dead-end annotations. A
  turn that can't be forked says why.

## Privacy

Everything runs locally, with no network requests. Your transcripts are never
modified: annotations go to `~/.agentree/`, a Claude fork creates a new file,
and Codex makes Codex forks itself.

## Build

From the repository root: `npm install && npm run build:vscode`, then
`npm run package` in `vscode-ext/`, and install the `.vsix` with
`code --install-extension`.
