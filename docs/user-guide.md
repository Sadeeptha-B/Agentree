# Agentree user guide

> Your agent chats branch all the time. Agentree lets you see the branches,
> and continue from any of them.

When you work with Claude Code or Codex in VS Code, a conversation rarely goes
in a straight line:

- you fork from an earlier message to try another idea;
- you edit a prompt and resend it;
- you rewind after a bad turn.

The chat panel only ever shows the path you're on, so the other paths quietly
disappear. Agentree draws the whole conversation as a **tree**, so you can:

- **see** every branch you've made, in one picture;
- **read** any branch, from the start up to any turn;
- **continue** from any turn, in the agent's own chat panel.

This guide shows you how to get the most out of it. It skips the internals;
those are in [AGENTS.md](../AGENTS.md).

---

## 1. Get it running (5 minutes)

You'll need VS Code, Node.js 20+, and git. From the repo folder:

```powershell
npm install
npm run build:vscode
cd vscode-ext
npm run package
code --install-extension agentree-0.2.0.vsix
```

Reload VS Code if it asks you to. Then:

> **Ctrl+Shift+P** → **Agentree: Open Conversation Trees**

Agentree opens in an editor tab. It finds your Claude Code and Codex history on
its own; there's nothing to configure.

> **Prefer a separate window?** Run `npm start` from the repo folder to open the
> desktop app. It has the same views and the same actions.

---

## 2. The idea in one picture

Every message is a dot. You are **blue** and the agent is **orange**. Time
flows downward. When a conversation splits, so does the tree.

```
                You: "Add drag-and-drop to the planner"
                 │
                Agent: "Two options: (A) native HTML5 DnD, (B) a library"
                 │
                You: "Go with A"
                 │
                Agent: implements A
                 │
        ┌────────┴──────────┐
        │                   ╎   ← long dashes: a NEW session starts here
  You: "Now add            You: "Actually, try B"      (you forked)
   keyboard support"        │
        │                  Agent: implements B
  Agent: …                  │
        ⋮  6                ◉   ← pulsing ring: the latest turn overall
        │
  Agent: "Done, tests pass"
```

There are three kinds of line:

| Line | Meaning |
|---|---|
| `│` **solid** | the conversation continues in the same session |
| `╎` **long dashes** | a **new session** begins here: a fork, or an edited and resent Codex prompt |
| `⋮ 6` **dotted, with a number** | 6 ordinary turns folded away to save space; click to unfold |

Other marks:

- A **hollow dot** is a message you typed while the agent was still working.
- A **pulsing ring** marks where the conversation is right now.

Agentree also gathers every fork of a conversation back into one entry, even
though each fork is technically a separate session. You see one tree, not five
unrelated chats.

---

## 3. A quick tour

### The conversation list

```
┌─────────────────┬────────────────────────────────────────────────────────────┐
│ Agentree        │  [ Filter by title, directory, or id… ]   158 conversations│
│                 │                                                            │
│ All convers. 158│  claude  66 files · 65 parsed · 60 listed · raw    ← health│
│ RECENT DIRS     │  codex  284 files · 123 parsed · 161 hidden · 93 listed    │
│  Agentree     2 │                                                            │
│  contenthub  48 │ ┌────────────────────────────────────────────────────────┐ │
│  digest       7 │ │ codex  Investigate MONE-62672 license recal            │ │
│  mono        78 │ │ ~\source\SitecoreRepos\contenthub · 60 turns           │ │
│  …              │ │ ⑂ 5  (5 sessions)  · 2h ago · 01a1353f                 │ │
│                 │ └────────────────────────────────────────────────────────┘ │
└─────────────────┴────────────────────────────────────────────────────────────┘
```

- **Left rail:** narrow the list to one project folder.
- **Search:** by title, folder, or session id.
- **`⑂ 5`:** this conversation branches in 5 places. Those are the
  interesting ones to open.
- **`5 sessions`:** five forks were joined into this one tree.
- **The status rows at the top** are a quick health check. "65 parsed" out of
  "66 files" is normal. If an agent ever shows lots of files and few parsed, it
  has probably changed how it saves chats. See §6.

The list updates live. Start a chat in VS Code and it appears within a moment.

### The tree

- **Drag** to move around, **scroll** to zoom, and click **fit** to see
  everything.
- **Click a dot** to select that turn. The path from the start to that turn
  lights up.
- **Click a dotted segment** (`⋮ 6`) to unfold the hidden turns. Click it again
  to fold them.
- **Esc** goes back to the list.

### The side panel

The panel always describes **the turn you selected** and **the session that
turn belongs to**:

```
CONVERSATION  codex · 5 sessions
SESSION  [fork]                    ← this turn lives in a forked session
  "…built in rules update"
  forked from "…clarifications"
  [open in Codex] [resume in terminal] [copy resume command] [copy id]

ASSISTANT · depth 22
  context 175k · 17% of window     ← how full the model's memory is here
  [copy node id] [mark dead end] [star] [label]
  [ ⑂ fork after this turn ]

  …the message itself…
  [view conversation up to here]
```

---

## 4. Everyday workflows

### Read a branch from the beginning

Select any turn and click **view conversation up to here**. You get the exact
conversation the agent "remembers" at that point, as one readable thread, with
no other branches mixed in.

*Use it to remind yourself what you'd established before a branch went
sideways, or to copy a good explanation out of an old branch.*

### Pick up where you left off

Select the last turn of the branch you want (its leaf), then:

- **open in Claude Code / Codex** to continue in the agent's own chat panel; or
- **resume in terminal** to run `claude --resume …` / `codex resume …` in the
  right folder.

Agentree resumes **that branch's session**, not whichever one happens to be
newest, because the buttons follow the turn you selected.

### Try a different approach from an earlier point

This is the core move:

1. Find the last turn where things were still going well. It's often the
   agent's answer just *before* the decision you regret.
2. Select it and click **⑂ fork after this turn**.
3. The new session opens in the chat panel. It knows everything up to that
   turn and nothing after it.
4. Type your new direction. The new branch grows in the tree as you go, joined
   by a dashed line.

```
   Agent: "Options A and B"   ← fork here
    │
    ├── You: "Go with A" … (an hour of trouble)
    ╎
    └── You: "Let's do B"      ← fresh start, same context
```

Nothing is deleted or changed: the original branch stays exactly as it was. If
the fork goes nowhere, mark it as a dead end and move on.

> **Fork in Agentree or in the chat panel?** Both work, and both show up in the
> tree. The chat panel is handy mid-conversation. Agentree is better when you
> want to go back *several* turns, because you can see exactly where you're
> landing.

### Keep a busy tree readable

| Action | Use it for |
|---|---|
| **label** | Name a branch ("approach B", "SQLite version"). The name is drawn in the tree. |
| **star** | Mark the answer you'll want to find again. |
| **mark dead end** | Dims the turn **and everything below it**. Click **revive** to undo. |

Annotations are stored only by Agentree, in `~/.agentree`. They never touch
your actual chats.

### Free up context by forking earlier

The panel shows **context** (for example "175k · 17% of window"): how much the
agent has to re-read on every message from that point on. When a long session
starts to feel slow or forgetful, fork from an earlier, leaner turn and carry
on from there. You keep the important setup and drop the detours.

---

## 5. Good to know

- **A brand-new fork appears in the tree after its first message.** Until then
  it's an exact copy, so there's nothing new to draw. It does count towards the
  "N sessions" shown on the conversation.
- **Codex forks take about 10 seconds.** Agentree asks Codex itself to make
  the fork, so it's a genuine Codex thread.
- **Codex prompt edits count as branches.** If you edited and resent a prompt
  in Codex, both versions appear, with a dashed line into the edited one.
- **Some turns can't be forked.** The panel tells you why:
  - turns from before a `/compact` in Claude;
  - messages sent while Claude was still working (hollow dots). Fork from the
    turn after one instead; that keeps the message.
- **Moved or deleted project folder?** Resuming still works; the terminal opens
  in your home folder instead.
- **Desktop app:** "open in Claude Code / Codex" switches to VS Code to open the
  session there. "Resume in terminal" opens a PowerShell window.

---

## 6. If something looks off

| You see | Try |
|---|---|
| A conversation is missing | Check the status rows. If a provider shows many files but few parsed, the agent changed its file format. Note the numbers and the agent's version and report it. |
| Two forks show up as separate conversations | Forks are joined by evidence copied into the fork. Claude sessions forked after a `/compact` may not carry it, which is a known gap. Each conversation's "N sessions" count shows what was joined. |
| "open in Claude Code" does nothing | The session may belong to a folder other than the one open in VS Code. Use **resume in terminal** instead. |
| `npm start` fails with `ipcMain` undefined | You're on an old checkout. Pull, then run `npm start` again (the launcher handles this now). |
| The desktop app has no Electron | Run `npm approve-scripts electron`, then `node node_modules/electron/install.js`. |

---

## Cheat sheet

```
Open:            Ctrl+Shift+P → "Agentree: Open Conversation Trees"
Navigate:        drag · scroll-zoom · fit · Esc = back to list
Unfold turns:    click a dotted ⋮ n segment
Lines:           solid = same session · long dash = new session (fork/edit)
Read a branch:   select turn → "view conversation up to here"
Continue:        select leaf → "open in Claude Code / Codex"
Branch off:      select turn → "⑂ fork after this turn"
Organise:        label · star · mark dead end (dims the whole subtree)
```
