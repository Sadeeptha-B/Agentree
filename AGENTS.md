# Agentree: design notes for agents working on this repo

Engineering notes on how Agentree parses, draws and forks agent
conversations: the transcript formats, the tree model, and the decisions
behind them. Read this before touching the parsers or the fork logic. Most
of what looks odd in the code exists because of a transcript reality
documented here. The user-facing overview and install steps live in
[README.md](README.md).

Facts marked **verified** were observed on real data or by running the
installed tool; **source** means read from shipped vendor code but not
executed; anything unmarked that matters is called out as unverified. Versions
as of 2026-10-27: Claude Code extension 2.1.310 / CLI 2.1.296, Codex extension
`openai.chatgpt` 26.1021 (its bundled codex-cli is 0.164.0-alpha.11.1; rollouts
on disk span 0.145–0.164), VS Code 1.143 (Electron 43). The harnesses change their on-disk formats without notice.
When that happens, the welcome screen's health row is the first place it shows
(see "Fail loudly").

## Architecture

Electron, with **no HTTP server**. The renderer has no Node access, and
everything crosses the contextBridge as a handful of typed IPC calls. The
host (Electron main, or the VS Code extension host) does no transcript work
itself: every call that reads or writes a store runs in a **backend worker
thread**.

```
assets/                        logo.png (transparent), sized variants, logo.icns
electron/main.ts               BrowserWindow + ipcMain handlers; forwards store calls to the backend
electron/preload.ts            contextBridge → window.agentree, and nothing else
electron/backend.ts            the table of store calls the worker serves (list, load, annotate, fork, health, watch targets)
electron/worker.ts             worker-thread entry serving backend.ts (bundled as worker.cjs)
electron/backend-client.ts     host-side handle on the worker: async proxy, restart on crash
electron/registry.ts           Provider interface; routes by "who owns this id"; health; annotate; watch targets
electron/paths.ts              every root, lazily: environment variable > settings > default
electron/settings.ts           ~/.agentree/settings.json: validated per field, cached by stat
electron/shell.ts              resume argv per harness + commands in the host shell's syntax (PowerShell / POSIX)
electron/native.ts             vscode:// deep links into the Claude Code / Codex extensions
electron/terminal.ts           desktop "resume in terminal": a new OS terminal window
electron/update.ts             desktop launch-time update check against the build's own origin
electron/health.ts             per-scan counters for the welcome screen's status rows
electron/transcripts.ts        Claude Code provider: parse, fork families, list/load
electron/providers/claude-fork.ts   Claude fork-at-turn (writes the extension's fork format)
electron/providers/codex.ts         Codex provider: paginated page graph, legacy rollouts
electron/providers/codex-appserver.ts  JSON-RPC client for `codex app-server` (thread/fork)
electron/providers/copilot.ts       Copilot CLI event logs → nodes, fork-by-copy
electron/providers/stitch.ts        key-based stitching of copy-forked sessions into one tree
electron/lineage.ts            fork-parentage sidecar (~/.agentree/lineage.json)
electron/meta.ts               sidecar annotation store (~/.agentree/meta/), alias-aware read/write
electron/watch.ts              live view: fs.watch + stat polling of targets the backend resolved
shared/types.ts                node/session/health types + the IPC contract
shared/render.ts               lineage walks, branch counting, token math
src/tree-layout.ts             chain compression + tidy layout
src/components/                TreeCanvas (the SVG) · NodePanel · Toolbar · Welcome · Settings
src/list.ts                    welcome-list rules: filters, rail, search, fork names
vscode-ext/                    VS Code extension: same providers, same renderer
test/                          vitest suites, synthetic fixtures (test/fixtures/make-fixtures.mjs), a fake codex app-server
```

`contextIsolation: true`, `nodeIntegration: false`. A viewer that reads your
entire conversation history shouldn't also hand the page `require`.

### The backend worker

A cold scan decompresses every Codex page and parses every Claude transcript:
about 2.6–4.8 s on the target machine (warm: ~20 ms, from the caches). On the
host thread that froze the whole VS Code extension host, or the Electron
window. So `backend.ts` runs in a `worker_threads` worker, built as
`worker.cjs` next to each host bundle. The worker owns the parse caches; the
host keeps only what must live there: IPC, `fs.watch`/stat polling, opening
terminals and deep links. Verified: during a 4 s cold scan driven through
`backend-client.ts`, a 50 ms timer on the host thread kept firing (71 of 83
expected ticks; before, none).

- The host never imports a provider. `backend-client.ts` imports backend.ts
  for its **type** only, and resume argv lives in `shell.ts` so the host can
  build terminal commands without loading parsers. `grep` the built
  `main.cjs` / `extension.cjs` for a parser symbol if in doubt.
- Watch targets are resolved in the worker (finding a session's files can mean
  a scan) and watched on the host (`watchLater`).
- A worker that dies fails the calls in flight and is restarted on the next one.
  Calls belong to the worker **generation** they were sent to: a dying worker
  emits `error` and then `exit`, and a retry made on the first event already
  lives on the replacement, so each worker fails only its own pending calls.
  `dispose` is final.

### VS Code extension (the primary product)

The Electron split maps one-to-one onto a VS Code extension built from the
SAME sources by `build-vscode.mjs` (`npm run build:vscode`):

- The extension host bundles `backend-client.ts`, `watch.ts`, `shell.ts`,
  `native.ts`; its `worker.cjs` bundles the registry and every provider.
  Nothing below `main.ts`/`preload.ts` imports Electron. Keep it that way.
- **Minimum VS Code is 1.101**: the first release on Electron 35 / Node
  22.15, the first Node with `zlib.zstdDecompressSync`. The extension host
  runs VS Code's bundled Node, never the system one, so an older VS Code can't
  read compressed Codex pages however new the installed Node is.
- The webview runs the unmodified renderer. `vscode-ext/src/shim.ts`
  implements the exact `window.agentree` surface over `postMessage`. It is
  loaded as a classic script before the module bundle, because `src/api.ts`
  reads `window.agentree` at module-eval time.
- Both hosts implement the same two hand-off actions, each in its own way:

  | | VS Code extension | Desktop app (Electron main) |
  |---|---|---|
  | `openNative` | Claude: `claude-vscode.editor.open(sessionId)` in-process. Codex: `openExternal(${uriScheme}://openai.chatgpt/local/<id>)` | `shell.openExternal(nativeLink(ref))`, the same `vscode://` deep links. Windows routes them to `Code.exe --open-url` |
  | `resumeInTerminal` | integrated terminal in the session's cwd | a new OS terminal window (`terminal.ts`) |

  The links come from the extensions' own URI handlers.
  `anthropic.claude-code` handles `/open?session=<id>` by calling
  `claude-vscode.primaryEditor.open`. `openai.chatgpt` forwards the path to
  its webview router, which routes threads at `/local/<id>`. A session whose
  cwd no longer exists resumes from the home directory; the CLIs still find
  it by id.
- `api.host` (`"vscode"` | `"electron"`) only tunes wording and one
  behaviour: in VS Code a fresh fork opens itself in the chat panel, while the
  desktop app shows the buttons instead of switching apps unasked.
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

## One node, several identities

A drawn `TurnNode` stands for three different things at once, and the fields
keep them apart, because each answers a different question:

| Layer | Field | Answers |
|---|---|---|
| **message** (semantic) | `stableIds` | which message is this, in every copy? Claude `m:<message.id>` / `u:<promptId>|<digest>`, Codex `<turnId>:<itemId>`; text-only evidence (no prompt id, Copilot, legacy Codex) is qualified by its parent's identity. Keys annotations, carries a selection across a re-rooted reload |
| **occurrence** (physical) | `sourceSessionId`, `occurrences` | which sessions hold it, under which id? The drawn one, plus every other member's copy |
| **vendor turn** | `turnId` | which unit of work can a fork cut after? (Codex turn; Claude records are each an anchor) |
| **display group** | `absorbedIds`, `lastRawId`, `forkBlocked` | what the same-role merge folded together, and the ONE anchor a fork after it uses |
| **edge** | `branchKind` | how the branch into it was made: `fork` (a new session) or `edit` (a Codex prompt edit, same thread) |

The rule that ties them: **display grouping never has authority over a fork
cut.** The merge never folds across vendor turns, and a merged node's anchor
and verdict are its LAST part's — so an enabled "fork after this turn"
always includes every message the node shows and nothing after it. (The
first version fell back to an earlier anchorable part and silently forked
before a shown mid-turn message or second prompt; two such nodes existed in
the owner's Codex history.) Physical file locators live on the session
(`MemberInfo.files`), not on occurrences: a session stored in several files
is read as one record set, so every anchor resolves whichever file holds
it (see "One session, several folders").

## Harnesses, one tree model

Everything downstream of parsing (layout, chains, annotations, the panel)
sees only `TurnNode[]`. Each provider's job is to make a very different store
produce that one shape:

|                    | Claude Code | Codex | Copilot CLI |
|--------------------|-------------|-------|-------------|
| transcript         | JSONL, one record per content block | paginated JSONL pages, `.jsonl` or `.jsonl.zst` | JSONL event log per session dir |
| structure          | native DAG (`uuid`/`parentUuid`) | page graph via `history_base` (exact tree) | linear `id`/`parentId` event chain |
| a fork is          | a NEW file holding a copy of one chain (no lineage field) | a NEW thread whose first page references the parent page (0.153–0.162 also wrote copied prefixes) | a copy-truncated session dir |
| other branches     | rewinds inside one file | prompt edits: a new page of the same thread | none |
| clean display text | must be cleaned (wrappers, ANSI, `ide_*`) | `item_completed` `UserMessage`/`AgentMessage`; strip the VS Code context preamble | `data.content` on `*.message` events |
| plumbing to avoid  | `<system-reminder>`, `<ide_*>`, command wrappers, task notifications, `api-request-blob` | `response_item` messages (`role: developer`/`user` harness injections) | `transformedContent` |
| usage              | `message.usage` per record | `token_usage_record` per response (input includes cached; converted) | not recorded per turn |
| resume             | `claude --resume <id>` | `codex resume <id>` | `copilot --resume=<id>` |
| fork after turn N  | Agentree writes the extension's fork format (`claude-fork.ts`) | `codex app-server` `thread/fork {threadId, lastTurnId}`, whole turns only | copy dir, truncate events.jsonl, rewrite ids |
| open in VS Code    | `claude-vscode.editor.open(id)` | `vscode://openai.chatgpt/local/<id>` | — |

**Invariant:** never modify a harness's transcripts or databases. Writes go
only to new files in the harness's own fork format, through the harness's own
API (`thread/fork`), or to Agentree's `~/.agentree/` sidecars.

## Codex: the page graph

Verified on 286 rollouts / 25 cuts.

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
- **Every observed cut lands on a turn boundary.** So the tree is exact, with
  no matching: a page's first turn hangs off the last turn of its base with
  `firstOrdinal < cut` (recursively through the base's own base).
- **History encoding and event vocabulary vary independently**, and are read
  independently. Codex 0.153–0.162 also wrote forks of paginated threads as
  **copied prefixes**: `forked_from_id`, no `history_base`, and the parent's
  turns physically repeated (verified: 7 such forks on the target machine,
  their copied turn ids and items identical to the parent's). With the item
  vocabulary the copy aligns on turn ids: a turn already placed is drawn once,
  and the first own turn after a prefix copied from another thread gets the
  fork edge. Pages are placed in page-id order (UUIDv7 = creation order), so a
  source is always placed before its copies. Explicit `forked_from_id`
  joins families whatever the encoding.
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
- A page holding turn records that yield no turn counts as **failed** in
  health (an item vocabulary nobody taught the parser), not as parsed. It
  stays in the graph, since other pages may continue it.
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
  part, so it's stored as the Anthropic-shaped split. A record that arrives
  before the turn's first prose (a tools-only response; 5 of 6,040 on the
  target machine) is held and added to the first reply.
- Names come from `session_index.jsonl`. A rename touches only that file, so
  its identity is part of every family-meta cache key, and the live view
  stat-polls it.
- **Why not app-server for reading:** `thread/turns/list` returns only a
  thread's *active* path, so every prompt-edit branch is invisible.
  `thread/list` takes ~6 s, returns duplicate rows, and doesn't populate
  `forkedFromId` (only `thread/read` does). The raw page graph lists the same
  103 interactive threads app-server does (cross-checked), plus the branches.
- **Legacy rollouts** (pre-paginated, `event_msg` `user_message` /
  `agent_message`, forks as verbatim copied prefixes) are still parsed and
  stitched by content. They can't be forked through the API (no turn ids),
  and their nodes say so (`forkBlocked`).

### Codex fork

`thread/fork {threadId, lastTurnId, excludeTurns: true}` through a
short-lived `codex app-server` (newline JSON-RPC: `initialize` →
`initialized` → request). `lastTurnId` is **inclusive of the whole turn**:
Codex cannot cut inside one. Verified: the new thread has `forkedFromId` and
exactly the prefix turns.

What can be forked, and through which thread, is decided when the tree is
built, not on click:

- **Only a turn's last node is an anchor.** Every other node of the turn (its
  prompt, commentary before a steering message, the steering message itself)
  carries `forkBlocked` explaining that a fork there would include the rest
  of the turn. Nodes carry `turnId`, and the display merge never folds two
  turns together (an aborted prompt and its replacement stay two nodes), so
  this holds for every drawn node — a test checks it over every fixture
  family.
- **Through a thread whose current history holds the turn.** A thread's
  current history is walked from its newest page down its bases — across
  threads, since a fork continues into its parent's pages — narrowing the cut
  at each step. The thread that placed the turn is preferred; otherwise any
  thread holding it, e.g. a fork of it. Verified on codex-cli 0.164 in a
  scratch `CODEX_HOME` holding copies of a real fork pair: `thread/fork` on
  the fork thread with a `lastTurnId` it only inherits via `history_base`
  produced a thread whose `thread/turns/list` was exactly that turn.
  "Newest page = current head" agreed with app-server's active turn sets on
  all ten multi-page threads of the target machine (its `thread/read` `path`
  is not a usable check: it names a different file for all ten).
- **A turn no thread holds** (cut away by a prompt edit, with no fork keeping
  it) is refused with an explanation. The API's fork-by-`path` can't reach
  it: on 0.164 it needs the `experimentalApi` capability, and even with it
  the server rejects any page that isn't the thread's head ("stale path …
  omit path and resume by thread id"). Agentree doesn't send `path`, and
  writing a rollout itself would break the "Codex forks are made by Codex"
  decision. The binary is the one bundled with the Codex VS Code
extension (`~/.vscode/extensions/openai.chatgpt-*/bin/<plat>/codex(.exe)`,
newest first), then PATH. It's spawned without a shell (except a `.cmd`
shim, quoted, through cmd.exe; `AGENTREE_CODEX_BIN` follows the same rule),
and stderr is ignored: an
unrecognised `config.toml` key logs an ERROR line that is harmless. A server
that exits, or whose stdin errors, fails every outstanding request at once
instead of leaving it to the 60 s timeout (`test/appserver.test.ts` drives the
real client against a fake server).

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
- contains the chain ending at the chosen message, minus `progress`
  records, in order. The chain follows `logicalParentUuid` across a
  `/compact` boundary (`getTranscript(message, true)`) **[source]**, so it
  includes the pre-compact history; the boundary keeps `parentUuid: null`
  and its `logicalParentUuid` still points at the **parent's** uuid;
- gives every record a **fresh uuid** (parentUuid re-linked) but **keeps
  `message.id`, `promptId`, `requestId` and timestamps**, except that the last
  copied record is re-stamped with the fork time;
- appends `custom-title: "<title> (fork)"`;
- writes **no lineage field**.

So families are found by evidence the copy preserves: two files that share
**any assistant `message.id`** are one family. The API mints that id once per
response, so independent sessions never share one, however similar their
opening prompts. *Any*, not the first: a fork copies the branch it was taken
on, which need not include the file's earliest reply (a regenerated first
answer). On the target machine the any-id rule gives exactly the same
families as the first-id rule did (no false merges; ~7,000 ids in all).
Explicit lineage (`forkedFrom` on SDK/Agentree forks, the lineage sidecar)
also links families. Grouping runs once over **every project folder**:
message ids are global, and a fork taken after a repo moved lives in another
folder than its source.

### One session, several folders

A moved or renamed repo leaves the session's transcript in the old project
folder and continues it, under the **same session id**, in the new one.
Verified on the target machine: an 11.8 MB copy in the old folder whose 838
uuids are all in the 23.5 MB copy in the new one (a record-for-record
prefix). Session ids are therefore indexed across folders before grouping,
and one id's copies are resolved by uuid containment (`resolveSource`):

- a copy whose uuids are all in another copy is a **shadow**: never parsed,
  counted as hidden in health, but kept in the cache signatures and watched,
  so a shadow that grows is re-resolved;
- copies neither of which contains the other **diverged** (same prefix, a
  different suffix each). They are read as the union of their records, the
  oldest-activity copy first, then each other copy from its first new uuid.
  Uuids are shared, so the union is exact and both continuations draw.

Never pick a copy by recency or size: that silently drops a real branch.
The fork writer reads the same union and writes next to the newest copy that
holds the anchor. Project attribution (the rail, the filter) uses the
session's last cwd, not the folder a copy happens to sit in.

Shared message ids prove two files share history; they say nothing about
**direction**, and the extension's own forks record none. Within a family the
parent is decided in three steps, none of which can contradict the one
before:

1. **Explicit lineage**, validated: an edge that would close a cycle is
   dropped.
2. **An order** with every explicit ancestor before its descendants; inside
   that, **chronologically by file creation** — a fork's file is created
   after its source's, and renaming can't change that. Only among files
   created within a second of each other (a copied or restored directory,
   `SAME_BATCH_MS`) does the count of `(fork)` title suffixes decide.
   (Title-first ordering let a renamed grandchild become its own parent's
   parent even with intact creation times.)
3. **Overlap.** A member without explicit lineage takes the earlier member
   whose tree holds the most of its history: `overlap()` in `stitch.ts`
   maps the member onto the candidate with the stitcher's own rule, over
   **every branch of both**, not just the newest chain. A parent that rewound
   after being forked from still overlaps its child fully.

Every edge points backwards in that order, so parentage is a forest. Each
member's link carries its evidence (`MemberInfo.parentEvidence`): `explicit`
or `inferred`, and the panel says "probably forked from" for the latter. A
wrong inference is not cosmetic: it decides which member owns the turns
between the two fork points (`sourceSessionId`, so what "open" and "fork"
act on) and where the dashed edge goes. It needs a batch-created directory
AND a renamed title; it can't be ruled out, which is why it's labelled.

### Stitching (`stitch.ts`)

Structural, not positional. A child's node maps onto an existing tree node
when both carry the same **match key** and hang off the same tree node (or
are both roots). Matching can only extend down a path that matched so far, so
the first unmatched node is the divergence point. Everything below it is the
fork's own suffix, re-parented onto the last shared turn and marked
`branchKind: "fork"` (drawn dashed). Rewinds inside either file survive, and a
parent that grew after the fork just keeps its extra turns.

- Keys: Claude uses `m:<message.id>` for replies and
  `u:<promptId>|<digest of the whole text>` for prompts. Never the
  timestamp, which a fork re-stamps on its last record; never an opening
  gist, which merged two prompts sharing a long preamble and hung one's
  answer under the other. Without a `promptId` (older transcripts) two
  prompts merge only if they are the same text under the same matched
  parent — then they ARE indistinguishable, and the branch shows at their
  replies. Legacy Codex and Copilot use role + whole-text digest, safe there
  because the prefix is a byte copy.
- A copy that merges into an existing node is recorded as an **occurrence**
  (`{sessionId, id}`), not dropped.
- Stitching runs on **unmerged** per-message nodes. The same-role merge runs
  after it, because a merge boundary can differ between a parent (which
  branches mid-run) and its fork (which doesn't).
- The merge never folds across sessions. A fork's first turn stays its own
  node, and it is always structural in the layout (never buried in a chain).

### Fork after a turn (`claude-fork.ts`)

Agentree writes **the extension's own fork format** (above) plus
`forkedFrom: {sessionId, messageUuid}` on every copied record (the Agent SDK's
`forkSession` writes that field too), and records the link in the lineage
sidecar. Mirroring the extension: it walks the **logical** chain from the
turn's **last** raw record (`lastRawId`; a turn spans one record per content
block), crossing a compact boundary through `logicalParentUuid`; the
boundary's `parentUuid` stays null so the CLI still resumes from the
summary; a `queued_command` attachment's `source_uuid` is remapped; a
`model_refusal_fallback` record gets `neutralizedByFork`; the source's
`summary` for the anchor is carried over. It writes with `wx`, so nothing
is overwritten.

Parser and writer share ONE ancestry rule, `resolveLineage()`: a boundary's
stale `logicalParentUuid` (one that isn't in the file) resolves to the
record written just before it, because copies are written in chain order.
Without that, a fork of a compacted session parses as two roots and its
history is drawn twice; and when only the parser had it, a fork OF such a
fork walked the raw field, stopped at the stale reference, and dropped the
whole pre-compact history. One deliberate difference from the extension:
Agentree's copy repoints the boundary's `logicalParentUuid` at the copy of
the pre-compact tip, so its own forks are self-contained. A test forks every
forkable node of every fixture family and checks that the fork alone draws
exactly the selected path, and that an unchanged fork adds no node.
File-history snapshots aren't copied: they're rebuilt from deltas Agentree
doesn't model, and a stale one would make "rewind code" restore the wrong
files. The fork is opened in the Claude panel.

Verified end-to-end: a fork taken after the first reply of a two-prompt session
resumed with `claude -p --resume <new>`. It knew the first question and had
never seen the second, and its new turn stitched in as a dashed branch of the
right node. **Not verified**: resuming a fork of a compacted session, or of a
turn ending in a `tool_use` (the extension's own fork has the same shape, so
both are expected to behave as the extension's do).

Refusals are decided at parse time and carried on the node as `forkBlocked`
(the panel shows the reason and disables the button; the writer refuses with
the same text):

- `preCompact` turns: Claude Code resumes a compacted session from its
  summary, and a copy ending before the boundary would ask it to reload the
  uncompacted history. Whether that works is untested, so it's refused;
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
  authoritative, and it's the **last** one a `user`/`assistant` record
  carries: a moved repo keeps one session id, and the session continues
  (and resumes) in the new folder. Codex likewise takes the newest page's
  last `turn_context.cwd`. One folder is recorded as `c:\…`, `C:\…` and
  `/c/…` (Git Bash), with or without a trailing separator, so paths are
  compared by `cwdKey()` (shared/render.ts) and displayed as recorded.

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
never across vendor turns (`turnId`), and never into a fork's first turn. The
merged node's fork anchor and `forkBlocked` are its **last** part's, so a run
ending in a mid-turn attachment is unforkable as a whole ("fork the turn
after it"). Usage is **summed** here, because each part
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
subagent, bookkeeping-only), parsed, **failed**, listed, format versions, and
unknown record types (Claude: top-level `type`; Codex: top-level type,
`event_msg` payload type and item type). Every file lands in exactly one of
hidden / parsed / failed. **Failed** means it should have been a session and
wasn't: unreadable, no parseable line, or conversation records (Claude
`user`/`assistant`, Codex turn records) that yielded no turn — which is what
a changed record shape looks like. Keeping it apart from "hidden" is the
point: before, a wholly malformed file counted as an intentionally empty one
and raised nothing. The welcome screen shows one row per present provider. It
warns about any failed file, warns harder when fewer than half of
parsed + failed succeed, and lists unknown types behind a disclosure. Zero
failed on the target machine's 358 files. A Claude session stored in several
project folders raises a warning naming how many, and how many diverged. A provider that throws doesn't take the others down
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
rendering. `src/tree-layout.test.ts` fuzzes 300 random trees (labels, fork
tags, marks, open and closed chains) and checks that no two drawn elements
(`elementBounds`) overlap.

**Fork tags.** A fork's first turn (`branchKind: "fork"`) carries a small tag
above it with its session's title (`forkTags`), so the tree says *which* chat
a dashed edge starts. The tag's width is part of `nodeWidth()`, and it sits
inside the node's row band: its top is 26px up at most, the row above ends
29px up. A chain's pill ends just above a tagged chain tail's tag; the chain's
dotted line, like an edge, may pass behind it (the tag is opaque). A user
label on the node replaces the tag, and a ★/✕ mark moves inside the tag. A
Codex prompt edit (`edit`) gets no tag: it's the same thread. The tooltip
names the fork in full and says "probably forked from" when the parent was
inferred.

Structural nodes are **roots, branch points, leaves, annotated turns, and a
fork's first turn** (any `branchKind`). Nothing else is structural.

**Selection is styling, never geometry.** `isStructural()` ignores the
selection, so clicking never re-lays out the tree. Auto-fit runs once per
session (via a ref), so after the first frame the viewport belongs to the user.

Edges into a node with a `branchKind` are **long-dashed** (`.edge.cross`), and the
legend explains them only when the tree has one. Collapsed chains are
**dotted** (round caps), so "turns hidden here" and "a new session starts here"
can't be mistaken for each other. They looked alike when both were short
dashes.

## Live view

The tree follows the transcripts on disk.

- A session watch covers the **directories holding its family**: every
  Claude project dir a member (or a copy of one) lives in, or the
  Codex/Copilot roots. A tree can grow through any
  member, or through a brand-new fork file. The welcome screen watches every
  root.
- The watch is on the *directory*, not the inode. A watch on a file goes deaf
  the moment the file is replaced.
- Watch targets are resolved by the backend worker and watched on the host
  (`watchLater`). A failed resolution (worker restarting) is retried with
  back-off, and once the watch is live it fires one change to reconcile
  anything written between the read and the watch.
- The renderer drops results for a view that's gone: every open/close bumps a
  view generation, and a reload that resolves after a close is discarded.
- A family can lose its root (its transcript deleted) while a fork survives.
  The reload then asks for the selected turn's session and every other
  member it knew, adopts whichever now roots the family, and carries the
  selection over by `stableIds`. Closing a tree refreshes the list.
- Codex and Copilot roots (`sessions/` and `archived_sessions/`) are also
  **stat-polled** every second, and so is Codex's `session_index.jsonl`
  (renames). Codex appends were verified invisible to
  macOS FSEvents until the file closes, and the poll costs ~4 ms. The filter
  accepts `.jsonl`, `.jsonl.zst` and `.yaml`.
- Writes are debounced 250 ms, because one reply is a burst of appends.
- Reload keeps your place: `expanded` survives, and the selection follows the
  new tip only if it was already on the tip.

## Welcome screen

- A directory rail ("All conversations", then directories, by `cwdKey`, ranked by most
  recent conversation) and one flat list, newest interaction first, with one
  entry per fork family.
- Badges: `⑂ n` branch points, `N sessions` for a family.
- A family card names its other chats (`SessionMeta.forks`, newest activity
  first, three then "+N"); a fork's own title is often the descriptive one.
  The search matches fork titles and ids too, and a matched fork moves to
  the front of that line, highlighted. A family counts under every member's
  directory, so a fork made in another repo shows there as well (owner's
  choice).
- Clicking a fork name, or opening a card whose search hit only a fork,
  opens the tree **focused** on that member: the selection lands on
  `MemberInfo.tipId`, the newest leaf among the turns the member holds. The
  provider decides "holds": Claude and Copilot by `sourceSessionId` or an
  occurrence, Codex by the thread's current history (a fork by reference
  copies nothing, so it has no occurrences). A fork with no turn of its own
  lands on the turn it was forked at.
- Health rows sit above the list. Their provider chips are the agent filter
  (one agent, or all; `providerFilter` in the store). It combines with the
  directory filter and the search, and the rail counts only what it lets
  through. The rules live in `src/list.ts`, testable without a DOM.
- Cards are keyed by `provider:id`, and `registry.listAllSessions` drops a
  second entry with the same identity (keeping the newer, logging the other).
  A provider that regresses into duplicates must not reach the screen: two
  cards with one React key left stale cards above a filtered list.
- No refresh button (the watcher keeps it live) and no "only branched" filter.
- Two times per session and member, both from record timestamps (never
  mtime, which bookkeeping rewrites move). The list sorts by `activeAt`.
  - `activeAt`, last conversational activity. It isn't the newest
    *displayed* turn, which stands still through a long tool loop; tool
    records count. Claude: any `user`/`assistant` record (tool-only replies
    and tool results included), `queued_command` attachments and
    `compact_boundary`. Codex: any `item_started`/`item_completed` event,
    of any item type (legacy: prose events and tool calls). Copilot:
    `user.*`, `assistant.*`, `tool.*`, `external_tool.*`, `subagent.*`
    events. **Verified:** the Codex extension re-stamps threads it merely
    loads with `thread_settings_applied`, `task_*`, `token_count`,
    `token_usage_record` and a `response_item`; five threads idle for days
    looked minutes old when sorted by every record.
  - `touchedAt`, the newest timestamp on **any** record ("last file
    change"), shown in the card's tooltip.

## Settings

`~/.agentree/settings.json`, edited from the panel behind the welcome
screen's gear, read and written only by the backend worker
(`getSettings` / `setSettings` in `methods`), so both hosts share one
implementation and one file. **A setting changes what you see or where data
lives, never how a transcript is interpreted**: no setting touches the
parsers, stitching, fork rules or health thresholds.

- Scan settings are applied in the worker: agents turned off are not
  scanned, listed, opened or watched (`registry.enabled`); all-archived Codex
  families can be listed (`archived` on the entry); data locations go
  environment variable > setting > default (`paths.ts`, `configuredPath`).
  `AGENTREE_HOME` is environment-only: the settings live in it.
- View settings are applied in the renderer: the sort time, remembered view
  state (compress, directory and agent filters, saved debounced) and whether
  a new fork opens in the chat panel (unset: VS Code yes, desktop no).
- The file is validated field by field, so a hand-broken file falls back
  per field, and cached by (mtime, size), so a write from the other host's
  worker is picked up. Writes are atomic per file, like the sidecars.
- A change refreshes the list, reloads an open tree, and bumps
  `settingsRev`, which re-subscribes every watch: watch targets are resolved
  once, so a moved root needs a new watch. The parse caches are keyed by
  absolute path and evicted per scan, so they rebind by themselves (the Codex
  name-index stamp includes its path for the same reason).

## Not dying under load

The backend worker (above) keeps scans off the host thread. Two more
mechanisms, both born of a real incident (Electron at 100 GB RSS):

- **Summary caches** keyed by (mtime, size). Claude caches per-file summaries
  (including each file's assistant message ids, for grouping) plus a
  family-meta cache keyed by every member's identity. Codex caches page parses
  and family metas (keyed by pages + the name index). Only metadata and small
  Codex pages are cached, never Claude node arrays. Deleted files are evicted
  on each scan. Cold scan over ~360 transcripts is 2.6–4.8 s; a warm one is
  ~20 ms.
- **Back-pressure** (`gate()` in `store.ts`): at most one refresh of a kind is
  in flight, and changes arriving mid-refresh coalesce into exactly one
  follow-up.

## Annotations

Labels, dead-end marks and stars live in `~/.agentree/meta/<sessionId>.json`,
never in the transcripts. A family's identity isn't stable — it gains members
when a fork is found, its root changes when the original is deleted, and one
turn has a different uuid in every file holding it — so annotations are keyed
by the turn's **semantic identity** (`stableIds`), not by a uuid:

- **writing** (`registry.annotate` → `writeAnnotation`) loads the family and
  writes the patch into **every member's** file under the node's stable ids:
  one atomic replacement per sidecar, however many ids;
- **reading** (`applyAnnotations`) checks every member's file for any of
  them.

**Migration (v1 → v2).** Sidecars written before stable ids key entries by
raw uuid, usually in the root's file only. Reading still finds those through
the node's own, merged-in and copied ids, and the first time one is found it
is carried forward under the stable ids into every member's file. That is the
whole migration: lazy, idempotent (a node with a v2 entry never looks for
v1), no version flag needed because the key spaces can't collide. Writes also
patch any v1 entry they find, so a cleared label can't resurface. A v1 entry
whose source transcript was deleted before Agentree ever loaded the family
with this version has nothing on disk to map to, and is not recovered.

Sidecar writes are atomic per file, not across processes: the desktop app and
the extension writing the same sidecar at the same moment can lose one side's
change. A cleared field travels as `null` (the VS Code bridge drops
`undefined`).

## Windows

- Resume commands are emitted in the host shell's syntax by `shell.ts`:
  `Set-Location -LiteralPath '<cwd>'; claude --resume <id>` on win32
  (PowerShell 5.1 has no `&&`), and `cd '<cwd>' && …` elsewhere.
- **`ELECTRON_RUN_AS_NODE=1` leaks into shells started from inside VS Code**
  (its extension host sets it, and agent tools' shells inherit it). Under it,
  `electron.exe` runs as plain Node and the app dies on `ipcMain` being
  undefined. Every launcher strips it: `npm start` / `npm run dev:app` go
  through `scripts/electron.mjs`, and `bin/agentree.cjs` does the same. Never
  put a bare `electron .` back in package.json.
- The window keeps the native frame on Windows/Linux (`hiddenInset` there
  means no window controls at all). The preload stamps
  `<html data-platform>`, and CSS drops the macOS traffic-light insets
  elsewhere.
- "Resume in terminal" waits for the launcher's `spawn` (or `error`) event
  before answering, so a missing terminal is reported instead of silently
  doing nothing.
- "Resume in terminal" on Windows runs `cmd /d /c start "" /D "<cwd>" powershell.exe -NoExit -Command "<argv>"`
  with `windowsVerbatimArguments`. Node's `detached` maps to
  `DETACHED_PROCESS`, which gives a console program *no* console, so a direct
  spawn never appears (verified). `start` gives it a new window. It was
  verified with a cwd containing a space and `&`.
- The desktop update check follows the build's own `origin` and branch
  (stamped into `dist-electron/build-info.json`), so a fork compares against
  itself and a feature branch against itself — never offering a `git pull`
  that wouldn't bring the update. It offers `git pull` + `npm install` in the
  host shell's syntax.
- `scripts/install.sh` is POSIX-only. `bin/agentree.cjs` is plain Node and
  works anywhere `npm link` does.
- npm's allow-scripts policy can block Electron's binary download. Run
  `npm approve-scripts electron` and then `node node_modules/electron/install.js`.
- With `core.autocrlf=true`, test fixtures are protected by
  `test/fixtures/.gitattributes` (`-text`).

## Tests

`npm test` (vitest) runs over synthetic fixtures generated by
`test/fixtures/make-fixtures.mjs`. Record shapes are copied from real
transcripts with the content replaced; no user data is committed. The suites
point providers at the fixtures through `CLAUDE_CONFIG_DIR` / `CODEX_HOME` /
`AGENTREE_HOME`, and the Claude suite works on a temp copy because it forks.

Assertions are on exact ancestry and tree invariants (unique ids, no
dangling parent, one root per path), not session counts.

- **Claude:** ide-wrapper and api-request-blob handling, title precedence, an
  extension fork pair stitched at the right turn next to a rewind, a
  same-opening-prompt session that must not merge, a parent that rewinds after
  its child was forked, a renamed explicit descendant (no cycle), a fork taken
  on a regenerated first answer, a native fork of a compacted session (stale
  logical parent), a malformed file (failed, not hidden), annotation aliases
  and survival of a deleted root, and the fork writer's output (format,
  lineage, fork-of-fork, logical chain across /compact, a prompt without
  `promptId` as the endpoint, pre-compact refusal).
- **Codex:** a `.zst` edit page, a fork through an archived thread, a
  guardian thread, a missing base, a copied-prefix fork in the item
  vocabulary, early usage, a rename in the index, an unknown item vocabulary
  (failed), the IDE wrapper, steering, legacy stitching, and fork anchors
  (whole turns only, refusal of cut-away turns, routing through a fork that
  still holds the turn), with app-server mocked.
- **Pipeline invariants:** every enabled Claude fork in every fixture family
  is made and checked (the fork alone draws exactly the selected path; the
  family gains no node or root); every enabled Codex node ends its own turn.
  Plus a merged node ending in a mid-turn attachment, two prompts sharing a
  long preamble, a renamed grandchild with intact creation order, a fork of a
  compacted fork, an aborted Codex prompt, and a pre-upgrade annotation that
  outlives its root.
- **Backend client:** a real worker (`test/fake-worker.cjs`) that crashes;
  the retry on its replacement must survive the old worker's late `exit`;
  disposal is final.
- **Renderer store** (`src/store.test.ts`, in `src/` for the DOM config):
  a reload resolving after close, a family whose root was deleted, and
  cleared fields sent as `null`.
- **App-server client:** the real client against `test/fake-codex` — the
  request shape, a JSON-RPC error, a server exiting mid-request, and on
  Windows a `.cmd` override with a space in its path. The synthetic rollouts
  are parser fixtures only: the real app-server doesn't accept them as
  complete rollouts, so its fork behaviour was verified by hand on copied real
  rollouts (see "Codex fork").
- **Shell quoting** on both platforms; **desktop hand-off**: deep links and the
  per-OS terminal launch (Windows `start` quoting, AppleScript escaping, Linux
  emulator choice, missing-cwd fallback).

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
- A Claude fork written into a project folder no member uses yet (made from
  a CLI in another repo) joins an open tree on the next change in a member's
  folder, or when the tree is reopened; the list picks it up at once.
- Inferred fork direction (above) can be wrong for a batch-copied directory
  with renamed titles; it's labelled, not prevented.
- **Open / resume act on a session, not a branch.** Several branches can live
  in one session (Claude rewinds, Codex prompt edits); opening it continues
  its current path. Continuing an older branch means forking at its leaf.
- A Codex turn cut away by a prompt edit, that no fork still holds, can't be
  forked (see "Codex fork").
- Forking before a Claude `/compact` is refused rather than tried.
- Claude forks don't copy file-history snapshots, so "rewind code" in an
  Agentree-made fork has nothing to restore (a deliberate choice; the
  extension's own fork does copy them).
- Whether the Claude extension's `editor.open` finds a session whose cwd is
  outside the open workspace is unverified. If it can't, use "resume in
  terminal".
- The Codex `vscode://openai.chatgpt/local/<id>` deep link is read from the
  extension's source but not yet confirmed visually.
- A Codex fork through app-server takes ~10 s (process startup + scan).
- Subagent turns are dimmed but not given their own lane.
- The Electron app isn't packaged as an installer (`npm start`, or `agentree`
  after `npm link`).
