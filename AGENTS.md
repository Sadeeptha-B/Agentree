# Agentree: design notes for agents working on this repo

Engineering notes on how Agentree parses, draws and forks agent
conversations: the transcript formats, the tree model, and the decisions
behind them. Read this before touching the parsers or the fork logic. Most
of what looks odd in the code exists because of a transcript reality
documented here. The user-facing overview and install steps live in
[README.md](README.md).

Facts marked **verified** were observed on real data or by running the
installed tool. Versions as of 2026-10: Claude Code extension 2.1.310 / CLI
2.1.296, Codex extension `openai.chatgpt` 26.1021 / codex-cli 0.162, VS Code
1.143 (Electron 43). The harnesses change their on-disk formats without notice.
When that happens, the welcome screen's health row is the first place it shows
(see "Fail loudly").

## Architecture

Electron, with **no HTTP server**. The renderer has no Node access, and
everything crosses the contextBridge as a handful of typed IPC calls:

```
assets/                        logo.png (transparent), sized variants, logo.icns
electron/main.ts               BrowserWindow + ipcMain handlers (filesystem lives here)
electron/preload.ts            contextBridge → window.agentree, and nothing else
electron/registry.ts           Provider interface; routes by "who owns this id"; health
electron/paths.ts              every root, lazily, honouring CLAUDE_CONFIG_DIR / CODEX_HOME / AGENTREE_HOME
electron/shell.ts              resume commands in the host shell's syntax (PowerShell / POSIX)
electron/health.ts             per-scan counters for the welcome screen's status rows
electron/transcripts.ts        Claude Code provider: parse, fork families, list/load
electron/providers/claude-fork.ts   Claude fork-at-turn (writes the extension's fork format)
electron/providers/codex.ts         Codex provider: paginated page graph, legacy rollouts
electron/providers/codex-appserver.ts  JSON-RPC client for `codex app-server` (thread/fork)
electron/providers/copilot.ts       Copilot CLI event logs → nodes, fork-by-copy
electron/providers/stitch.ts        key-based stitching of copy-forked sessions into one tree
electron/lineage.ts            fork-parentage sidecar (~/.agentree/lineage.json)
electron/meta.ts               sidecar annotation store (~/.agentree/meta/)
electron/watch.ts              live view: fs.watch + stat polling
shared/types.ts                node/session/health types + the IPC contract
shared/render.ts               lineage walks, branch counting, token math
src/tree-layout.ts             chain compression + tidy layout
src/components/                TreeCanvas (the SVG) · NodePanel · Toolbar · Welcome
vscode-ext/                    VS Code extension: same providers, same renderer
test/                          vitest suites + synthetic fixtures (test/fixtures/make-fixtures.mjs)
```

`contextIsolation: true`, `nodeIntegration: false`. A viewer that reads your
entire conversation history shouldn't also hand the page `require`.

### VS Code extension (the primary product)

The Electron split maps one-to-one onto a VS Code extension built from the
SAME sources by `build-vscode.mjs` (`npm run build:vscode`):

- The extension host bundles `electron/registry.ts`, `watch.ts` and `meta.ts`.
  Nothing below `main.ts`/`preload.ts` imports Electron. Keep it that way.
- The webview runs the unmodified renderer. `vscode-ext/src/shim.ts`
  implements the exact `window.agentree` surface over `postMessage`. It is
  loaded as a classic script before the module bundle, because `src/api.ts`
  reads `window.agentree` at module-eval time.
- `api.host` (`"vscode"` | `"electron"`) decides which actions the panel
  offers. Only the extension host implements:
  - `openNative`: Claude runs `claude-vscode.editor.open(sessionId)`, the
    command the Claude extension's own `vscode://anthropic.claude-code/open?session=`
    handler calls. Codex opens `${vscode.env.uriScheme}://openai.chatgpt/local/<threadId>`,
    because the Codex extension's URI handler forwards the path to its webview
    router, which routes threads at `/local/<id>`.
  - `resumeInTerminal`: an integrated terminal in the session's cwd, running
    the provider's resume argv.
- Host-side watchers are token-keyed like the ipcMain map and closed on panel
  dispose.
- The webview HTML links `index.css` by hand (Vite has no index.html to inject
  into), overrides the macOS traffic-light insets, and pins the theme vars to
  VS Code's `body.vscode-dark/-light` classes instead of the OS
  `prefers-color-scheme`.
- `onUpdateAvailable` is a no-op there; the extension updates through VS Code.

Package with `npm run package` inside `vscode-ext/`. F5 from the repo root
launches an extension-development host. `npm run typecheck` covers the
extension too (`tsc -p vscode-ext`).

## Harnesses, one tree model

Everything downstream of parsing (layout, chains, annotations, the panel)
sees only `TurnNode[]`. Each provider's job is to make a very different store
produce that one shape:

|                    | Claude Code | Codex | Copilot CLI |
|--------------------|-------------|-------|-------------|
| transcript         | JSONL, one record per content block | paginated JSONL pages, `.jsonl` or `.jsonl.zst` | JSONL event log per session dir |
| structure          | native DAG (`uuid`/`parentUuid`) | page graph via `history_base` (exact tree) | linear `id`/`parentId` event chain |
| a fork is          | a NEW file holding a copy of the active chain (no lineage field) | a NEW thread whose first page references the parent page | a copy-truncated session dir |
| other branches     | rewinds inside one file | prompt edits: a new page of the same thread | none |
| clean display text | must be cleaned (wrappers, ANSI, `ide_*`) | `item_completed` `UserMessage`/`AgentMessage`; strip the VS Code context preamble | `data.content` on `*.message` events |
| plumbing to avoid  | `<system-reminder>`, `<ide_*>`, command wrappers, task notifications, `api-request-blob` | `response_item` messages (`role: developer`/`user` harness injections) | `transformedContent` |
| usage              | `message.usage` per record | `token_usage_record` per response (input includes cached; converted) | not recorded per turn |
| resume             | `claude --resume <id>` | `codex resume <id>` | `copilot --resume=<id>` |
| fork after turn N  | Agentree writes the extension's fork format (`claude-fork.ts`) | `codex app-server` `thread/fork {threadId, lastTurnId}` | copy dir, truncate events.jsonl, rewrite ids |
| open in VS Code    | `claude-vscode.editor.open(id)` | `vscode://openai.chatgpt/local/<id>` | — |

**Invariant:** never modify a harness's transcripts or databases. Writes go
only to new files in the harness's own fork format, through the harness's own
API (`thread/fork`), or to Agentree's `~/.agentree/` sidecars.

## Codex: the page graph

Verified on 276 rollouts / 24 cuts.

```
~/.codex/sessions/Y/M/D/rollout-<localStamp>-<threadId>.jsonl[.zst]            a thread's first page
~/.codex/sessions/Y/M/D/rollout-<localStamp>-<threadId>_<pageId>.jsonl[.zst]   later pages
~/.codex/archived_sessions/…                                                  same, archived
~/.codex/session_index.jsonl                                                  {id, thread_name} lines, last wins
```

- Every record has `timestamp`, `ordinal`, `type` and `payload`. **Ordinals are
  global** and continue across pages.
- A non-first page's `session_meta` carries
  `history_base: {thread_id: <pageId>, end_ordinal_exclusive}`: "my history is
  that page's history before this ordinal, then my own records".
  - A **prompt edit** (`turn_trigger: "edit_user_message"`) starts a new page of
    the same thread, cut before the edited turn.
  - A **fork** starts a new thread whose first page is cut after the chosen
    turn. It also records `forked_from_id` / `forked_from_ordinal_exclusive`.
- **Every observed cut lands on a turn boundary**, and turn ids (UUIDv7) are
  shared by reference, never copied. So the tree is exact, with no matching:
  a page's first turn hangs off the last turn of its base with
  `firstOrdinal < cut` (recursively through the base's own base).
- Older pages are **zstd-compressed** (232 of 276 here). They are read with
  `zlib.zstdDecompressSync`, which exists in Node ≥ 22.15 / 23.8 and VS Code's
  Electron 43. It's feature-detected, and its absence is a health error.
- **Archived threads can be bases of live forks** (verified: an archived
  thread was the parent of two live ones), so `archived_sessions/` is always
  scanned. A family whose every thread is archived gets no list entry.
- A page whose base is no longer on disk becomes a separate root and raises a
  health warning (one such page on the target machine).
- `thread_source: "guardian_review"` (auto-review threads, the majority here)
  and subagent sources are Codex's own plumbing, so they're hidden and counted as
  "hidden" in health.
- Display stream: `event_msg` → `item_completed` →
  - `UserMessage` (`content[].text`). VS Code prefixes it with
    `# Context from my IDE setup: … ## My request:\n`, so keep the part after
    the heading. A second `UserMessage` inside one turn is steering typed
    mid-turn and is marked `midTurn`.
  - `AgentMessage` (`content[].text`, `phase` = `commentary` | `final_answer`).
    All of a turn's prose folds into one assistant node.
  - `Reasoning` (`summary_text`) becomes thinking. `CommandExecution`,
    `FileChange`, `McpToolCall`, `WebSearch`, `Extension`, `ImageView` and
    `Plan` become tool names.
- Item ids are NOT unique (`item-1`, `item-2`, … repeat per turn), so node
  ids are `<turnId>:<itemId>`. `lastRawId` is the turn id, i.e. the fork anchor.
- The `session_meta` first line embeds the full base instructions (30–100 KB+).
- Usage: `token_usage_record.payload.usage` per response is summed per turn,
  and the last one is kept as `lastUsage`. `input_tokens` includes the cached
  part, so it's stored as the Anthropic-shaped split.
- **Why not app-server for reading:** `thread/turns/list` returns only a
  thread's *active* path, so every prompt-edit branch is invisible.
  `thread/list` takes ~6 s, returns duplicate rows, and doesn't populate
  `forkedFromId` (only `thread/read` does). The raw page graph lists the same
  103 interactive threads app-server does (cross-checked), plus the branches.
- **Legacy rollouts** (pre-paginated, `event_msg` `user_message` /
  `agent_message`, forks as verbatim copied prefixes) are still parsed and
  stitched by content. They can't be forked through the API (no turn ids).

### Codex fork

`thread/fork {threadId, lastTurnId, excludeTurns: true}` through a
short-lived `codex app-server` (newline JSON-RPC: `initialize` →
`initialized` → request). Verified: the new thread has `forkedFromId` and
exactly the prefix turns. The binary is the one bundled with the Codex VS Code
extension (`~/.vscode/extensions/openai.chatgpt-*/bin/<plat>/codex(.exe)`,
newest first), then PATH (a `.cmd` shim on Windows needs the shell). It's
spawned without a shell, and stderr is ignored: an unrecognised `config.toml`
key logs an ERROR line that is harmless.

The thread passed is the one whose *current* history contains the turn. That
history is found by walking from the thread's newest page down its bases,
narrowing the cut at each step. A turn that survives only on a page a later
prompt edit cut away is forked by that page's file (`path` param) instead.
Exact protocol types for the installed version come from
`codex app-server generate-ts --out <dir>`.

## Claude Code

### The tree already exists inside one transcript

Claude Code writes one JSONL transcript per session, and every `user` /
`assistant` record carries `uuid` and `parentUuid`. A node with two children
*is* a branch (a rewind). The CLI just has no way to show you one.

### …and across transcripts: VS Code "Fork conversation"

Read from the extension's `forkSession` (2.1.310) and verified on 4 real pairs.
The extension's fork:

- writes a **new file** in the same project dir with a new `sessionId`;
- contains the parent chain ending at the chosen message, minus `progress`
  records, in order;
- gives every record a **fresh uuid** (parentUuid re-linked) but **keeps
  `message.id`, `promptId`, `requestId` and timestamps**, except that the last
  copied record is re-stamped with the fork time;
- appends `custom-title: "<title> (fork)"`;
- writes **no lineage field**.

So families are found by evidence the copy preserves. Every copy-fork starts
with the same **first assistant `message.id`** as its source. The API mints
that id once per response, so two independent sessions never share it, however
similar their opening prompts. Explicit lineage (`forkedFrom` on SDK/Agentree
forks, the lineage sidecar) also links families.

Within a family, the parent is decided by:

1. explicit lineage;
2. otherwise the count of `(fork)` suffixes in the title, then file creation
   time;
3. among the earlier members, the one sharing the longest key prefix along the
   member's active chain (a fork of a fork matches its direct parent best).

### Stitching (`stitch.ts`)

Structural, not positional. A child's node maps onto an existing tree node
when both carry the same **match key** and hang off the same tree node (or
are both roots). Matching can only extend down a path that matched so far, so
the first unmatched node is the divergence point. Everything below it is the
fork's own suffix, re-parented onto the last shared turn and marked
`crossSession` (drawn dashed). Rewinds inside either file survive, and a
parent that grew after the fork just keeps its extra turns.

- Keys: Claude uses `m:<message.id>` for replies and `u:<promptId>|<text gist>`
  for prompts. Legacy Codex and Copilot use role + text, which is safe there
  because the prefix is a byte copy.
- Stitching runs on **unmerged** per-message nodes. The same-role merge runs
  after it, because a merge boundary can differ between a parent (which
  branches mid-run) and its fork (which doesn't).
- The merge never folds across sessions. A fork's first turn stays its own
  node, and it is always structural in the layout (never buried in a chain).

### Fork after a turn (`claude-fork.ts`)

Agentree writes **the extension's own fork format** (above) plus
`forkedFrom: {sessionId, messageUuid}` on every copied record (the Agent SDK's
`forkSession` writes that field too), and records the link in the lineage
sidecar. It walks the physical `parentUuid` chain from the turn's **last** raw
record (`lastRawId`; a turn spans one record per content block). A compact
boundary has a null `parentUuid`, so the copy starts there, which is exactly
the history the CLI loads. It writes with `wx`, so nothing is overwritten.
File-history snapshots aren't copied: they're rebuilt from deltas Agentree
doesn't model, and a stale one would make "rewind code" restore the wrong
files. The fork is opened in the Claude panel.

Verified end-to-end: a fork taken after the first reply of a two-prompt session
resumed with `claude -p --resume <new>`. It knew the first question and had
never seen the second, and its new turn stitched in as a dashed branch of the
right node.

Refusals stay:

- `preCompact` turns, because the CLI loads only messages after the last
  `/compact`;
- `injected` interjections, which have no record;
- `midTurn` attachment nodes, which aren't message anchors (forks of later
  turns keep them).

The Agent SDK (`@anthropic-ai/claude-agent-sdk`) was deliberately not bundled.
Its licence is "all rights reserved" and the repo is MIT, and its session
functions are plain file operations whose output format is reproduced here.

**Superseded designs, for history.** Each one failed in a way worth remembering:

1. *Copy under a new id, no stitching*: every fork listed as an unrelated
   conversation.
2. *An explicit `last-prompt` pin appended at click time*: a still-open CLI
   appends its own non-explicit pointer on exit and clears the pin.
3. *`--resume-session-at` alone*: it is print-mode-only, and interactive resume
   silently continued from the tip.
4. *Pin + flag inside the emitted command* (`printf … >> transcript && claude …`):
   it worked interactively, but it wrote into the user's real transcript,
   depended on undocumented reducer behaviour, was POSIX-only, and couldn't be
   driven from the VS Code chat panel. 3,011 `last-prompt` records on the
   target machine, 0 explicit: the pin was never used there.

### One turn is many records

Claude Code writes **one record per content block**. A reply with thinking +
text + a tool call becomes three chained `assistant` records sharing one API
`message.id`. `transcripts.ts` groups by `message.id` and emits one node per
turn, merging the blocks. Some messages span 27 records.

### Record types

Seen on the target machine: `assistant`, `attachment`, `user`,
`api-request-blob`, `bridge-session`, `last-prompt`, `atis-latch`,
`ai-title`, `api-request`, `queue-operation`, `mode`, `file-history-delta`,
`file-history-snapshot`, `custom-title`, `cost-state`, `pr-link`, `system`,
`api-request-shape`, `frame-link`, `artifact-*`, `permission-mode`. Only
`user`/`assistant` (plus `queued_command` attachments) become nodes.
`api-request-blob` carries `message` content blocks but is **not** a turn.
The two-pass lineage tolerates any type, and unknown ones are counted in the
health row, not treated as errors.

- **Title:** last `custom-title` > last `ai-title` (the CLI's generated title)
  > first real prompt (computed before the same-role merge).
- **`entrypoint`** (`claude-vscode` | `cli`) is shown in the panel.
- The project-dir slug keeps the drive letter's case as written
  (`c--Users-…` and `C--Users-…` both occur). The cwd inside the transcript is
  authoritative.

### Plumbing is stripped, real markup is not

Records carry ANSI escapes from captured command output and Claude Code's own
wrapper markup. Those are cleaned:

- **dropped entirely:** `local-command-caveat`, `system-reminder`, and the VS
  Code extension's context blocks `ide_opened_file`, `ide_selection` and
  `ide_diagnostics`. Left in, "The user opened the file … in the IDE" became
  most sessions' titles;
- **unwrapped:** the rest (`command-name`, `local-command-stdout`,
  `bash-input`, …) keep their inner text and lose the tag.

The tag list is a deliberately short **allow-list**, not "strip anything
angle-bracketed". A corpus census found `<doc>` ×260, `<name>` ×90,
`<email>` ×102 and dozens more, all genuine content inside code samples and
quoted XML. Prose mentions in backticks survive, correctly. A record that is
*nothing but* wrappers is rebuilt from the trimmed inner values, because
unwrapping in place strands the pretty-printer's indentation.

### Only turns that said something get a node

A node must have text after the merge. That removes `user` records that exist
only to carry `tool_result` blocks, and `assistant` turns whose entire content
was a tool call or bare thinking. The filter runs **after** the per-message
merge. Uncaptioned screenshots are labelled `[image]`. `resolveParent`
re-links children to the nearest surviving ancestor, so dropping these doesn't
cost branch structure.

### Same-role runs fold into one turn

A linear run of consecutive same-role nodes becomes one node: an agent loop
(assistant → assistant → assistant), or a slash command's several user records.
It only merges where the parent has exactly one child, never across sessions,
and never into a fork's first turn. Usage is **summed** here, because each part
is a distinct API call. That's the opposite of the per-block merge, where every
record repeats one message's usage. Absorbed ids are retained so sidecar
annotations still resolve.

### Most "branches" were an artifact

Parallel tool calls produce a fake fork: the second `tool_use` block and the
first tool's result both hang off the same record. Merging turns AND dropping
tool results were both needed to stop counting those (one session showed ⑂9
when only 1 was real).

### Lineage gotcha

Claude Code interleaves other record types into the same parent chain.
Filtering to displayable turns without **re-linking across the gaps** leaves
most `parentUuid` pointers dangling, which collapsed a 378-node tree to about
seven reachable nodes. So there are two passes: build the full lineage from
every record that has a uuid, then resolve each kept node's parent to its
nearest surviving ancestor.

### Mid-turn messages (`/btw`), interjections and `/compact`

A message sent while Claude is working is recorded as a uuid-less
`queue-operation` pair and, on current CLIs, as a `queued_command`
**attachment** with a real uuid at the delivery point. Task notifications ride
the same queue and attachment type (`commandMode: "task-notification"`, null
origin) and are dropped. Agentree prefers attachments (`origin.kind: "human"`)
and falls back to queue-op reconstruction for old transcripts (deduped by
content), splicing each one **into** the chain, never beside it: an
interjection must not become a spurious branch point. Reconstructed ones
(`queued:<sid>:<n>` ids) are drawn hollow and can't be forked from.

`/compact` writes `system/compact_boundary` with `parentUuid: null` and the
real predecessor in `logicalParentUuid`. The parser follows that field, or a
compacted session shatters into a forest. The resume loader indexes only
messages after the LAST boundary, so earlier turns are marked `preCompact`.
The harness doesn't persist every piece of in-turn prose: if nothing was
recorded between two mid-turn messages, they merge into one node, which is a
faithful rendering of the file.

## Copilot CLI

Unchanged since July 2026 and untested on the target machine's current
version. Forks are copy-truncated session dirs, with the copied
`session.start`'s `sessionId` rewritten (left stale, the resumed CLI logs
under the PARENT's id). Parentage lives in `~/.agentree/lineage.json`, because
Copilot **regenerates workspace.yaml on every resume and drops unknown keys**.
VS Code **Copilot Chat** (`%APPDATA%/Code/User/workspaceStorage/*/chatSessions/*.jsonl`,
an op-log) is the next provider. See `docs/modernization-handoff.md` §3.3 for
its format notes.

## Fail loudly

Every provider scan fills a `HealthScan`: files seen, hidden (guardian,
subagent, empty), parsed, listed, format versions, and unknown record types
(Claude: top-level `type`; Codex: top-level type, `event_msg` payload type and
item type). The welcome screen shows one row per present provider. It warns
when fewer than half of the candidate files parse, and lists unknown types
behind a disclosure. A provider that throws doesn't take the others down
(`registry.ts` guards each one), and its row says it crashed. This row would
have flagged the 2026-09 Codex format change, which listed 0 sessions, on day
one.

## Chains

Conversation trees are caterpillars: one long spine with short stubs. Runs of
single-child turns collapse into one **chain** with a count badge, and a click
expands or collapses the whole run. Runs shorter than `MIN_CHAIN` (3) draw as
plain nodes. Effect on a real session: **89 turns → 5 drawn elements**.

Four things this got wrong first, all fixed and worth not re-introducing:

- **A chain must emit the node it terminates in**, or a collapsed run ends in
  empty space.
- **Don't keep the whole selected path uncompressed.** In a caterpillar that's
  nearly every node. The path is shown by edge highlighting instead.
- **Don't size a chain proportionally** to the turns it hides. The span is
  fixed (`CHAIN_ROWS`).
- **`fit` must add the chain span to the measured height**, or the tail clips.

## Layout

The layout is a tidy tree by **subtree extent**, not fixed columns. Two
subtrees never overlap, so two nodes in the same row never can either, which
is what lets a labelled node be a variable-width box. Node width comes from
`nodeWidth()`, deliberately generous because SVG can't measure text before
rendering. Fuzzed over 300 random trees: zero overlaps.

Structural nodes are **roots, branch points, leaves, annotated turns, and a
fork's first turn** (`crossSession`). Nothing else is structural.

**Selection is styling, never geometry.** `isStructural()` ignores the
selection, so clicking never re-lays out the tree. Auto-fit runs once per
session (via a ref), so after the first frame the viewport belongs to the user.

Edges into a `crossSession` node are dashed (`.edge.cross`), and the legend
explains them only when the tree has one.

## Live view

The tree follows the transcripts on disk.

- A session watch covers the **directory holding its family**: the Claude
  project dir, or the Codex/Copilot roots. A tree can grow through any
  member, or through a brand-new fork file. The welcome screen watches every
  root.
- The watch is on the *directory*, not the inode. A watch on a file goes deaf
  the moment the file is replaced.
- Codex and Copilot roots (`sessions/` and `archived_sessions/`) are also
  **stat-polled** every second. Codex appends were verified invisible to
  macOS FSEvents until the file closes, and the poll costs ~4 ms. The filter
  accepts `.jsonl`, `.jsonl.zst` and `.yaml`.
- Writes are debounced 250 ms, because one reply is a burst of appends.
- Reload keeps your place: `expanded` survives, and the selection follows the
  new tip only if it was already on the tip.

## Welcome screen

- A directory rail ("All conversations", then directories ranked by most
  recent conversation) and one flat list, newest interaction first, with one
  entry per fork family.
- Badges: `⑂ n` branch points, `N sessions` for a family.
- Health rows sit above the list.
- No refresh button (the watcher keeps it live) and no "only branched" filter.
- `updatedAt` is the newest timestamp on **any** record in any member. It
  isn't mtime (bookkeeping rewrites move that) and it isn't the newest
  displayed turn (which stands still through a long tool loop).

## Not dying under load

Two mechanisms, both born of a real incident (Electron at 100 GB RSS):

- **Summary caches** keyed by (mtime, size). Claude caches per-file summaries
  plus a family-meta cache keyed by every member's identity. Codex caches
  page parses and family metas. Only metadata and small Codex pages are cached,
  never Claude node arrays. Deleted files are evicted on each scan. Cold scan
  over ~340 transcripts is ~2.7 s; a warm one is ~14 ms.
- **Back-pressure** (`gate()` in `store.ts`): at most one refresh of a kind is
  in flight, and changes arriving mid-refresh coalesce into exactly one
  follow-up.

## Annotations

Labels, dead-end marks and stars live in `~/.agentree/meta/<sessionId>.json`,
keyed by node id, and never in the transcripts. A family's annotations are
written under the family root's id and read from **every** member's file, so
a family that gets re-rooted (a fork found later, a root deleted) keeps them.

## Windows

- Resume commands are emitted in the host shell's syntax by `shell.ts`:
  `Set-Location -LiteralPath '<cwd>'; claude --resume <id>` on win32
  (PowerShell 5.1 has no `&&`), and `cd '<cwd>' && …` elsewhere.
- `npm run dev:app` is a Node launcher (`scripts/dev-app.mjs`), not
  `VAR=value electron .`.
- `bin/agentree.cjs` and `scripts/install.sh` are POSIX-only.
- npm's allow-scripts policy can block Electron's binary download. Run
  `npm approve-scripts electron` or `node node_modules/electron/install.js`.
- With `core.autocrlf=true`, test fixtures are protected by
  `test/fixtures/.gitattributes` (`-text`).

## Tests

`npm test` (vitest) runs over synthetic fixtures generated by
`test/fixtures/make-fixtures.mjs`. Record shapes are copied from real
transcripts with the content replaced; no user data is committed. The suites
point providers at the fixtures through `CLAUDE_CONFIG_DIR` / `CODEX_HOME` /
`AGENTREE_HOME`, and the Claude suite works on a temp copy because it forks.

- **Claude:** ide-wrapper and api-request-blob handling, title precedence, an
  extension fork pair stitched at the right turn next to a rewind, a
  same-opening-prompt session that must not merge, and the fork writer's
  output (format, lineage, fork-of-fork).
- **Codex:** a `.zst` edit page, a fork through an archived thread, a
  guardian thread, a missing base, the IDE wrapper, steering, legacy stitching,
  and fork-target selection (by thread vs. by page file), with app-server
  mocked.
- **Shell quoting** on both platforms.

When a harness changes format, add a fixture for the new shape before changing
the parser.

## Notes

- Assistant output renders as Markdown via a small hand-written renderer
  (`src/markdown.tsx`) that emits React elements, never an HTML string, so no
  sanitiser is needed. Non-http schemes never become links. It recurses, so
  its regex is instantiated per call: a shared `/g` regex rewinds the outer
  cursor and hangs.
- Per-turn numbers (`context · prompt · % cached`) live in the panel. There are
  no overlay modes: a legend in the canvas corner decodes everything the tree
  encodes, and the tip breathes with a pulsed ring (static under
  `prefers-reduced-motion`).
- Marking a turn as a dead end dims it **and everything beneath it**.
- The app icon is generated from `logo.png` by `scripts/make-icon.py`. Re-run
  it if `logo.png` changes.

## Known gaps

- VS Code Copilot Chat isn't read yet (next phase; read-only, no fork API).
- Copilot CLI sessions from before `events.jsonl` aren't listed, and Copilot
  records no per-turn tokens.
- Whether the Claude extension's `editor.open` finds a session whose cwd is
  outside the open workspace is unverified. If it can't, use "resume in
  terminal".
- The Codex `vscode://openai.chatgpt/local/<id>` deep link is read from the
  extension's source but not yet confirmed visually.
- A Codex fork through app-server takes ~10 s (process startup + scan).
- Subagent turns are dimmed but not given their own lane.
- The Electron app isn't packaged (`npm start` only).
