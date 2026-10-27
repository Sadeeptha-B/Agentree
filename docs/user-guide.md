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
- **continue** from (almost) any turn, in the agent's own chat panel.

This guide shows you how to get the most out of it. It skips the internals;
those are in [AGENTS.md](../AGENTS.md).

---

## 1. Get it running (5 minutes)

You'll need VS Code 1.101 or newer, Node.js 22.15+, and git. From the repo
folder:

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
        │                   ╎   ← long dashes: a fork starts here
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
| `╎` **long dashes** | a **fork** begins here (a new session), or an **edited and resent Codex prompt** (a new branch of the same thread) |
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
│ All convers. 158│  claude  66 files · 66 parsed · 61 listed · raw    ← health│
│ RECENT DIRS     │  codex  286 files · 124 parsed · 162 hidden · 87 listed    │
│  Agentree     2 │                                                            │
│  shop-api    48 │ ┌────────────────────────────────────────────────────────┐ │
│  notes        7 │ │ codex  Investigate the flaky checkout test             │ │
│  platform    78 │ │ ~\source\shop-api · 60 turns                           │ │
│  …              │ │ ⑂ 5  (5 sessions)  · 2h ago · 01a1353f                 │ │
│                 │ └────────────────────────────────────────────────────────┘ │
└─────────────────┴────────────────────────────────────────────────────────────┘
```

- **Left rail:** narrow the list to one project folder.
- **Search:** by title, folder, or session id.
- **`⑂ 5`:** this conversation branches in 5 places. Those are the
  interesting ones to open.
- **`5 sessions`:** five forks were joined into this one tree.
- **The status rows at the top** are a quick health check. "Hidden" files are
  the agent's own bookkeeping (Codex's automatic reviews, for example) and are
  normal. **"Failed"** files are ones that should have been conversations but
  couldn't be read; the row then turns into a warning. If you see that, the
  agent has probably changed how it saves chats. See §6.

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
  "…retry the payment step"
  forked from "…flaky checkout test"
  [open in Codex] [resume in terminal] [copy resume command] [copy id]

ASSISTANT · depth 22
  context 175k · 17% of window     ← how full the model's memory is here
  [copy node id] [mark dead end] [star] [label]
  [ ⑂ fork after this turn ]

  …the message itself…
  [view conversation up to here]
```

**"forked from" or "probably forked from"?** Codex records which thread a
fork came from, and so does Agentree when it makes a Claude fork. The Claude
Code panel's own "Fork conversation" records nothing: Agentree can tell the
two chats share history, and works out which came first from when their
files were created. The panel says "probably" when that's how it knows.

---

## 4. Everyday workflows

### Read a branch from the beginning

Select any turn and click **view conversation up to here**. You get every
message on the path from the start down to that turn, as one readable thread,
with no other branches mixed in. (The agent's actual memory at that point held
more than is drawn: tool output, file contents and its own instructions.)

*Use it to remind yourself what you'd established before a branch went
sideways, or to copy a good explanation out of an old branch.*

### Pick up where you left off

Select a turn on the branch you want, then:

- **open in Claude Code / Codex** to continue in the agent's own chat panel; or
- **resume in terminal** to run `claude --resume …` / `codex resume …` in the
  right folder.

These act on the **session** the selected turn belongs to (the panel's
"Session" block), so a turn in a fork opens that fork, not the original.
Within one session, though, the agent always continues from where *it* left
off: the end of the session's current path. A session can hold several
branches (a rewind in Claude, a prompt edit in Codex), and selecting an older
one doesn't change which one the agent continues.

**To continue an older branch, fork it:** select its last turn and use
**⑂ fork after this turn** (next section). You get a new session that ends
exactly there.

### Try a different approach from an earlier point

This is the core move:

1. Find the last turn where things were still going well. It's often the
   agent's answer just *before* the decision you regret.
2. Select it and click **⑂ fork after this turn**. (In Codex, pick the
   agent's *final* reply of a turn: Codex forks whole turns, so a prompt or
   an in-between reply can't be a fork point, and the panel says so.)
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
- **Some turns can't be forked.** The button is greyed out and the panel
  tells you why:
  - turns from before a `/compact` in Claude;
  - messages sent while Claude was still working (hollow dots). Fork from the
    turn after one instead; that keeps the message;
  - in Codex, anything but the last reply of a turn;
  - in Codex, a turn that a prompt edit replaced, unless a fork of that
    conversation still contains it. Fork the turn before the edit and resend
    your prompt instead.
- **Moved or deleted project folder?** Resuming still works; the terminal opens
  in your home folder instead.
- **Desktop app:** "open in Claude Code / Codex" switches to VS Code to open the
  session there. "Resume in terminal" opens a PowerShell window.

---

## 6. If something looks off

| You see | Try |
|---|---|
| A conversation is missing | Check the status rows. If a provider shows many files but few parsed, the agent changed its file format. Note the numbers and the agent's version and report it. |
| Two forks show up as separate conversations | Forks are joined by evidence the agent copies into every fork (Claude's reply ids, Codex's fork records). Each conversation's "N sessions" count shows what was joined. If a fork still stands alone, it's worth reporting with the agent's version. |
| "Open" continued a different branch than the one I selected | Expected: open/resume continue the session's current path. Fork at the end of the branch you want instead (§4). |
| "open in Claude Code" does nothing | The session may belong to a folder other than the one open in VS Code. Use **resume in terminal** instead. |
| `npm start` fails with `ipcMain` undefined | You're on an old checkout. Pull, then run `npm start` again (the launcher handles this now). |
| The desktop app has no Electron | Run `npm approve-scripts electron`, then `node node_modules/electron/install.js`. |

---

## Cheat sheet

```
Open:            Ctrl+Shift+P → "Agentree: Open Conversation Trees"
Navigate:        drag · scroll-zoom · fit · Esc = back to list
Unfold turns:    click a dotted ⋮ n segment
Lines:           solid = same session · long dash = fork / edited branch
Read a branch:   select turn → "view conversation up to here"
Continue:        select turn → "open in Claude Code / Codex" (session's current path)
Branch off:      select turn → "⑂ fork after this turn" (also: continue an old branch)
Organise:        label · star · mark dead end (dims the whole subtree)
```
