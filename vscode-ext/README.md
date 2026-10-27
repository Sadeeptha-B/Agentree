<p align="center">
  <img src="https://raw.githubusercontent.com/serban-cercelescu/Agentree/main/assets/logo-256.png" alt="Agentree" width="96" height="96">
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
tree, with a dashed edge where each fork begins. Codex prompt edits show up as
branches too.

| Agent | Reads | Fork after a turn |
|-------|-------|-------------------|
| **Claude Code** (extension or CLI) | `~/.claude/projects` | new session in Claude Code's fork format, opened in the Claude Code panel |
| **OpenAI Codex** (extension or CLI) | `~/.codex/sessions` (+ `archived_sessions`, `.jsonl.zst`) | `thread/fork` through `codex app-server`, opened in the Codex panel |
| **GitHub Copilot CLI** | `~/.copilot/session-state` | copy-truncated session (command only) |

## Use

- **Welcome screen:** conversations newest first, a directory rail, search, and
  one health row per agent (files seen / parsed / listed).
- **Tree:** drag to pan, wheel to zoom, click a `⋯ n` chain to expand it.
  Dashed edges enter a fork or edit.
- **Panel:** for the selected turn's session you get **open in Claude Code /
  Codex**, **resume in terminal**, **⑂ fork after this turn** (opens the fork
  in the chat panel), and star / label / dead-end annotations.

## Privacy

Everything runs locally, with no network requests. Your transcripts are never
modified: annotations go to `~/.agentree/`, a Claude fork creates a new file,
and Codex makes Codex forks itself.

## Build

From the repository root: `npm install && npm run build:vscode`, then
`npm run package` in `vscode-ext/`, and install the `.vsix` with
`code --install-extension`.
