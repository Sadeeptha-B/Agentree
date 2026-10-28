---
name: run-desktop
description: Launch and drive the Agentree desktop (Electron) app to see a UI change working: screenshot the list, the day view or a tree, click, press keys, read text. Use when asked to run, start or screenshot the app, or to check a renderer change in the real app rather than only in tests.
---

# Run and drive the Agentree desktop app

The desktop app and the VS Code webview run the same renderer, so the desktop
app is the quickest way to see a UI change. `driver.mjs` (next to this file)
launches the **built** app with a DevTools port and disposable homes, then runs
commands read line by line from stdin. It speaks plain CDP over Node's built-in
WebSocket: no Playwright, nothing to install.

All commands run from the repo root.

## Build first

```sh
npm run build        # renderer (dist/) + host, preload, worker (dist-electron/)
```

The driver runs what is in `dist/` and `dist-electron/`, not the sources. It
warns when a source file is newer than the build, and refuses to launch when
there is no build. Rebuild after every change you want to see.

## Run

Pipe the commands (the normal way for an agent):

```sh
printf '%s\n' \
  'launch' \
  'day 2026-10-01' \
  'ss day' \
  'quit' | node .claude/skills/run-desktop/driver.mjs
```

Or run `node .claude/skills/run-desktop/driver.mjs` in a terminal and type the
commands at `driver>`. Each command prints `<command>: <result>` or
`<command>: ERROR …`. Lines starting with `#` are comments.

Screenshots go to `$SCREENSHOT_DIR`, or `<os tmpdir>/agentree-shots` when it is
unset. Point it at your scratch directory. **Open the screenshot and look at
it**: a blank or stale frame is a failed check, not a pass.

### Data: `launch fixtures` (the default) or `launch real`

- **`fixtures`** reads a temp **copy** of the synthetic stores: Claude
  `test/fixtures/claude/2.1` and Codex `test/fixtures/codex/0.162/home`.
  Copilot gets an empty store. Every fixture turn is on **2026-10-01**
  (10:00–18:20 UTC), so use `day 2026-10-01`. A fork lands in the copy,
  never in the committed fixtures. (A Codex fork still needs a `codex`
  binary, and the synthetic rollouts aren't complete enough for it.)
- **`real`** reads the user's own default stores, with
  `AGENTREE_READ_ONLY_STORES=1`: the app itself refuses every fork, open in
  the agent's chat panel and terminal resume, whatever button, key or
  `eval` triggers it (`electron/readonly.ts`; AGENTS.md: never test forks or
  resumes against original stores). `AGENTREE_HOME` is still a fresh temp
  directory, so sidecar migrations and settings never touch theirs.
  Screenshots then show private chat titles and text. Keep them in scratch,
  and never commit or quote them.

Every launch gets a new temp directory for the copied stores, the
`AGENTREE_HOME` and the Chromium profile, so settings and the remembered view
always start at their defaults. `quit` deletes it.

## Commands

| command | does |
|---|---|
| `launch [fixtures\|real]` | start the app; returns once the list has scanned |
| `ss [name]` | screenshot → `<SCREENSHOT_DIR>/<name>.png` |
| `day [YYYY-MM-DD]` | switch to the day view on that day (default: today), wait for it to draw; prints the day header |
| `list` | back to the list view (leaves a tree first) |
| `open <title text>` | open the list card whose title contains the text; prints the tree's name |
| `click <css>` | DOM click on the first match (SVG elements get a dispatched click) |
| `click-text <text>` | click the first button or link containing the text |
| `key <Key>` | press `ArrowLeft/Right/Up/Down`, `Enter`, `Escape`, `Tab`, … |
| `wheel <css> <deltaY> [shift]` | a browser-native wheel over the element's centre: zoom, or with `shift` pan. The selector can't contain spaces |
| `type <text>` | type into the focused element |
| `fill <css> <value>` | set a React-controlled input, e.g. `fill .search cache` |
| `wait <css>` | wait up to 20 s for a selector |
| `text [css]` | `innerText` of the selector (default: the whole page) |
| `eval <js>` | evaluate in the page, print the JSON result |
| `size <w> <h>` | viewport size; `size 820 860` shows the narrow layout (VS Code side panel) |
| `theme light\|dark` | emulate the OS colour scheme |
| `quit` | close the app |

### Selectors worth knowing

- **List:** `.mode-toggle` (List | Day), `.search`, `.tree-main` (a card),
  `.dir-row` (rail), `.provider-chip.toggle` (agent filter).
- **Day view:** `.day-date`, `.day-label` (a chat's lane name: clicking it
  selects that chat's latest turn), `.day-dot`, `.day-card` (the side card),
  `.day-tools`.
- **Tree:** `.toolbar`, `.tree-name`, `.vnode`, `.vchain`, `.panel`. `key Escape` returns to the welcome screen.

A full walk through the day view on fixtures, from a lane to a tree and back:

```
launch
day 2026-10-01
click-text fork 22222222
key ArrowLeft
text .day-card
key Enter
wait .toolbar
ss tree
key Escape
eval document.querySelector(".day-date").value
quit
```

## Gotchas

- **`ELECTRON_RUN_AS_NODE`.** Shells started from VS Code inherit it, and it
  turns `electron.exe` into plain Node (the app dies on `ipcMain`). The
  driver clears it, as `scripts/electron.mjs` does. Keep that if you edit it.
- **Port 9333 taken** (another driver run, another app): set
  `AGENTREE_DRIVER_PORT`. A leftover app from a killed run can hold the port.
  Close that window.
- **React inputs ignore a plain `.value =`.** Use `fill`, which goes through
  the native setter and fires `input`.
- **Wheel scrolling is smooth.** After a `wheel` that should scroll the
  page, wait before reading `scrollTop`, e.g.
  `eval new Promise(r => setTimeout(() => r(document.querySelector(".session-pane").scrollTop), 600))`.
  A zoom on a canvas applies at once.
- **SVG nodes have no `.click()`.** `click` dispatches a bubbling event
  instead. To select a day-view turn, clicking a `.day-label` and stepping
  with the arrow keys is more predictable than picking a `.day-dot` by index.
- **No headless mode on Windows.** The window opens on the desktop while the
  driver runs. On headless Linux, run the driver under `xvfb-run -a` (not
  verified here).
- `AGENTREE_NO_UPDATE_CHECK=1` is set, so a launch never calls GitHub.

## Not covered

The VS Code webview (the primary product) is not driven by this. It runs the
same renderer, but its theme variables, its narrow panel and its `postMessage`
bridge need a check in an Extension Development Host (F5). Report a desktop
screenshot as a desktop check, not as a VS Code one.
