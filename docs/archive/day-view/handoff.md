# Day view: handover — 2026-10-28

> **Superseded in part by the [third review's resolution](review-findings-day-view-round-3.md#resolution).** A day selection or target is now resolved by the worker in its family (`DayWant` / `findWant`), not by `locateBy` over the day's turns (§5 contract 6). Idle time reads recorded activity (`activeUntil`), not message ends alone (§5 contract 9). A card's ◷ lands on the day its latest turn started, and wide scripts are estimated wide (§8). Lanes name their folder, and the chat list has no paths. The [fourth review's resolution](review-findings-day-view-round-4.md#resolution) adds two rules. A day answer is adopted only for the intent it was asked about. A fork's work under a shared turn counts, in the fork's lane. The [fifth review's resolution](review-findings-day-view-round-5.md#resolution) narrows that work to what the fork's copy has beyond its source, from its own first record. The rest stands as written.

> **Handover for the next agent on the day-view track.** It records the state at `1b029d1` on branch `day-view`, how the feature works, the contracts it must keep, what has and hasn't been verified, and what is left. It is a snapshot. Where it disagrees with the code, the code wins; the [design notes](../../design.md#day-view) and [user guide](../../user-guide.md#the-day-view) hold the current explanations. [AGENTS.md](../../../AGENTS.md) still governs how to work in this repository. Read it first.

## 1. Status in one screen

**What exists.** The welcome screen has a **List | Day** switch. The day view draws every turn that *started* on one local calendar day, across all enabled agents and all conversations, on one timeline:

- one lane per chat session, with forks in their own lane, joined to the turn they forked from;
- colour by agent: filled dots are user prompts, rings are agent turns;
- a compressed time axis, with pauses of 20 minutes or more with nothing running drawn as labelled breaks;
- a side card that lists the day's chats, or shows the selected turn;
- keyboard navigation;
- Open in tree, and a way back with Esc;
- **◷ date** buttons on list cards and in the tree toolbar, which open a chat's day with it selected.

The work also added:

- a project skill, `run-desktop`, that drives the built desktop app;
- an environment switch, `AGENTREE_READ_ONLY_STORES`, under which the app refuses every fork, chat-panel open and terminal resume.

**Branch state.**

| | |
|---|---|
| Branch | `day-view`, based on `main` at `7d3a66c` (`main` holds the merged modernization) |
| Commits | 6: `79807bc` (feature), `45e2f26` (run-desktop skill), `2f2c44b` and `36d7f18` (review rounds 1 and 2), `a0db4ef` (full chat names), `1b029d1` (◷ entry points, paths in the side card) |
| Remote | `origin/day-view` is at `79807bc`. **The last five commits are local and unpushed.** No PR exists. Push or open a PR only when the owner asks |
| Size | about 46 files, +4,000/−180 against `7d3a66c`, most of it in tests and documentation |
| Checks at `1b029d1` | 173 tests in 19 files, `npm run typecheck`, `npm run build` and `npm run build:vscode` all pass (Node 26.3.0, Windows 11). Host bundles contain no provider code |
| Reviews | two external review rounds, both resolved and recorded with their findings ([round 1](review-findings-day-view.md), [round 2](review-findings-day-view-round-2.md)) |

**What is not verified.** The VS Code webview, which is the primary product. Every interactive check so far was made in the Electron desktop app. See §6.

## 2. Read in this order

1. [AGENTS.md](../../../AGENTS.md): boundaries (worker-only store access, renderer without Node, identity and membership rules, never writing original stores), commands, and how to report verification.
2. [Design notes, "Day view"](../../design.md#day-view): the authoritative engineering description. Also read "Welcome screen" (`activeAt`, `touchedAt`, `startedAt`, `revision`), "Settings" (the read-only switch, the modal), "The fork point" and "Membership, focus and family lifecycle". The day view reuses their rules.
3. [User guide, "The day view"](../../user-guide.md#the-day-view): what the user is promised.
4. The two review records in this folder. Their resolutions say why each contract exists. The findings show the failure modes reviewers look for: identity across snapshots, cache keys, browser event semantics, constrained layouts.
5. [run-desktop skill](../../../.claude/skills/run-desktop/SKILL.md): how to see the UI.

## 3. Where things are

| Layer | File | Responsibility |
|---|---|---|
| Shared types | `shared/types.ts` | `DayChat`, `DayTurn` (with `ref: NodeRef`), `DayRun`, `DayActivity`, `NodeRef`, `SessionMeta.startedAt` / `.revision`, `ViewState.mode`, `AgentreeApi.getDay` |
| Shared rules | `shared/render.ts` | `endOf` (any `{timestamp, endedAt}`), `oldest`, `refOf`, `locateBy` (the one selection-resolution rule), `locate` (= `locateBy` over a family's nodes) |
| Worker | `electron/registry.ts` | `dayActivity(start, end)` and `dayPart(detail, start, end)`; the per-family projection cache keyed by `revision` |
| Providers | `electron/transcripts.ts`, `providers/codex.ts`, `providers/copilot.ts` | `startedAt` (minimum record time) and `revision` (a digest of what a load reads) on each family's `SessionMeta` |
| Sidecar | `electron/lineage.ts` | `readLineage` is cached by file stat; `lineageOf(ids)` gives the lineage entries that go into a revision |
| Guard | `electron/readonly.ts` | `storesReadOnly`, `handOffRefused`: checked by `forkAnyAt` in the worker and by `openNative` / `resumeInTerminal` in both hosts |
| Bridge | `electron/{backend,backend-client,ipc,main,preload}.ts`, `vscode-ext/src/{extension,shim}.ts` | `getDay` in each. `METHOD_NAMES` completeness is enforced by typecheck |
| Pure renderer rules | `src/day.ts` | local day keys and bounds (DST-correct), `filterDay`, `chatName`, `laneKey` / `turnKey`, `DayTarget` and `resolveTarget`, `latestActiveDay`, `shortDay` |
| Layout | `src/day-layout.ts` | lane order, tracks, the compressed x axis, breaks, raw ticks, edges, `laneLatest`, `stepInLane` / `stepLane`, `labelLines`, `dotRadius`, `visibleTicks` |
| Store | `src/store.ts` | `listMode`, `day`, `dayActivity`, `dayLoading`, `daySelected`, `dayViewport`, `dayTarget`, `setDay`, `loadDay` (gated, re-keys the selection), `showInDay`, `openSession(…, { focus, select: NodeRef })`, `carry` (reload, via `locate`) |
| View | `src/components/DayView.tsx` | the screen mapping (time-only zoom), grid, pinned time strip, dots, edges, lane labels, side card, keyboard, the kept viewport |
| Entry points | `Welcome.tsx` (List/Day switch, ◷ on cards), `Toolbar.tsx` (◷ for the selected turn), `App.tsx` (the welcome watch also reloads the day) | |
| Shared UI | `src/wheel.ts` (`useCanvasWheel`, used by both canvases), `Settings.tsx` (modal), `src/format.ts` (`tilde`, `span`), `src/tree-layout.ts` (`chainHolding`) | |
| Tests | `test/day.test.ts`, `src/day.test.ts`, `src/day-layout.test.ts`, the "day view" blocks in `src/store.test.ts` and `src/welcome.test.tsx`, `test/registry.test.ts` (read-only), `test/settings.test.ts` (`view.mode`) | |
| Tooling | `.claude/skills/run-desktop/{SKILL.md,driver.mjs}` | launches the built app on a temp copy of the fixtures (or on real stores read-only) and drives it over CDP |

## 4. How a day gets on screen

1. The `day` key (`YYYY-MM-DD`, local) becomes `[start, end)` from calendar midnights (`dayBounds`), so a DST day is 23 or 25 hours. The renderer calls `api.getDay(start, end)` from `loadDay`.
   - `loadDay` runs behind its own `gate()`: at most one load is in flight, and a request arriving meanwhile triggers exactly one more pass. It is triggered by the DayView mount effect (`[day, settingsRev]`), by the welcome watch in `App.tsx` while `listMode === "day"`, and by `showInDay`.
2. In the worker, `dayActivity` asks each **enabled** provider for its list.
   - It keeps only families with `touchedAt >= start` and `(startedAt || 0) < end`.
   - It takes each one's `DayPart` from the cache, under key `provider:id:revision`, or loads it (`p.load`) and projects it with `dayPart`.
3. `dayPart` takes a family's stitched nodes:
   - nodes whose `timestamp` falls in `[start, end)` become `DayTurn`s, each in lane `sourceSessionId ?? meta.id`;
   - nodes that started before `start` with `endOf >= start` become `DayRun`s;
   - one `DayChat` is created per session that has either. Member title, cwd, parent and parent title come from `members`.
   - Previews are folded text cut at 400 characters. **Annotations are deliberately not projected.**
4. In the renderer, `filterDay` applies the welcome filters per lane: agent chip, the rail's directory against the lane's **own** cwd, and the search over chat title, family title, ids and cwd. `buildDayLayout(turns, chats, running)` then lays it out, and `DayView` maps layout coordinates to the screen (`screen(view)`: `x → tx + x·k`, `y → ty + y`).

## 5. Contracts to keep

Each item names its enforcement point and its test. Break one only with the owner's agreement, and update the design notes in the same change.

1. **A turn belongs to the day it started.** Turns that run past midnight are carried into the next day as `running`. They get no mark there, but the next day isn't idle until they end. *(registry `dayPart`; `test/day.test.ts` "runs past midnight"; layout test "running".)*
2. **`startedAt` only narrows which families load.** It is the oldest timestamp on *any* record (a lower bound), and `oldest()` returns 0 (unknown, so the family is always loaded) if any part is unknown. Never use it for display or ordering. *(Invariant test: it is no later than any node, across Claude, Codex and Copilot.)*
3. **Cache by `revision`, never by times or counts.** A revision is a digest of every member file's path, mtime and size, plus the family's **own** name-index entries (Codex) and lineage entries (Claude, Copilot). Another family's rename or fork must not invalidate it. A family without a revision is not cached. If you add a new input to a provider's `load` (a new sidecar or index), add it to that provider's revision. *(`test/day.test.ts` "day cache revisions": a rename and a same-time record rewrite change only their own families' revisions, and exactly those two reload.)*
4. **Annotations are not in the day projection.** A sidecar write doesn't change the revision, so a projected label would go stale. Showing annotations needs a new key ingredient, such as the sidecar's identity per family, not a patch in the view.
5. **Lanes belong to owners, not holders.** A shared prefix is drawn once, in its owner's lane, as in the tree. Lanes are keyed `provider:sessionId` and turns `provider:familyId:nodeId`, because node ids are unique only per family.
6. **A selection is a `NodeRef`, resolved by `locateBy` and nothing else.** The order is: end point (`ForkPoint`: drawn session and last raw id), then head id, then `stableIds`.
   - It is applied on a tree reload (`carry`), on a day refresh (re-keying `daySelected` among that agent's turns), on Open in tree (`openSession(…, { select })`) and on a ◷ target (`resolveTarget`).
   - Never carry a selection by `turnKey` or head id alone. A group can split, gain an owner or be re-rooted under a new id between reads.
   - *(Store tests for split and re-root; round 1 finding 3 and round 2 finding 1.)*
7. **`openSession` asks for the focused member's family first, then `id`.** The family a lane or card was listed under may have split. This now applies to every caller, the list's fork names included.
8. **"Latest" means `endOf`.** A chat's landing turn (`laneLatest`), the end of a chat's time range in the side card, and a ◷ card target use the maximum end, with the later-starting turn winning a tie. ←/→ step in *start* order. *(Layout test with the endpoints-fixture branch shape.)*
9. **Idle is time with nothing running.** It is measured from `busyUntil`, the running maximum of `endOf` over earlier turns in any lane, seeded by `running`. The break and its resume label share that one decision. *(Layout tests.)*
10. **Zoom is time-only.** Only x scales; lanes keep their pixel height. Because of that:
    - a lane is as tall as its tracks or its wrapped name (`labelLines`);
    - dots shrink as turns close up (`dotRadius`: a track's turns stay apart down to k ≈ 0.375, below which the radius floors at 2px);
    - time labels are a fixed size, pinned in a 22px strip and thinned for the current zoom (`visibleTicks`, 64px apart).

    The layout returns *all* ticks. Thinning belongs to the view, because it depends on k. *(Layout tests, including the fuzz test's lane-height and in-lane checks.)*
11. **Keyboard model.**
    - One window-level listener in DayView: ←/→ within a chat, ↑/↓ to the nearest-in-time turn in the adjacent lane, Enter opens, Esc deselects.
    - It ignores inputs, textareas and selects, and stands down while `settingsOpen`.
    - Every control that picks a chat or turn calls `pick`, which moves focus to the focusable timeline, so Enter opens instead of re-pressing a button. A focused button keeps its own Enter.
    - Settings is a modal (`aria-modal`): focus moves in on open and back on close, Tab cycles inside, and its `onKeyDown` stops every key at the dialog.
    - *(Checked in the desktop app only; see §6.)*
12. **Wheel goes through `useCanvasWheel`**, a native `{ passive: false }` listener attached with a callback ref. React's `onWheel` is passive, and its `preventDefault` doesn't cancel scrolling of the pane around the canvas. Never reintroduce `onWheel` on either canvas.
13. **The way back.**
    - `dayViewport` stores pan and zoom when the view unmounts and is restored for the same day; a fresh fit reveals any kept selection.
    - `showInDay(day, target)` closes an open tree, clears the viewport and the day's old turns, and parks `dayTarget` until *a* load of that day arrives. The gate may coalesce loads, so the target is resolved inside `loadDay`, not after awaiting it.
    - A target for a day the user has left is dropped. A target the filters would hide clears the filters, since the chat was asked for by name. This also changes the list's filters, which are shared.
14. **Worker boundary.** All store access is in `dayActivity`. The host only forwards `getDay`, and the renderer never resolves stores.
15. **Writes to agent stores are refused at the action**, under `AGENTREE_READ_ONLY_STORES`: in `forkAnyAt` before any provider is asked, and in both hosts' `openNative` and `resumeInTerminal`. Don't move this into UI controls or the driver; round 1 finding 1 shows why.
16. **Settings change visibility, never interpretation.** The remembered view stores `mode` (list or day), not the selected day, so the day view always reopens on today.

## 6. Verification state

Report these separately. AGENTS.md asks for that, and the owner reads it.

| Kind | Covered |
|---|---|
| **Fixture and unit tests** (`npm test`) | Projection, lanes, exact turn ids and fork lanes on the Claude fixtures; window edges; midnight split and `running`; family narrowing and cache reuse; revision invalidation on a rename and on a same-time rewrite; a disabled agent never asked; `startedAt` bounds; layout (tracks, breaks, idle, ticks, edges, navigation, label lines, dot radius; a 300-day fuzz test for overlap, x order, lane heights and in-lane dots); local day bounds across DST; filters; `resolveTarget`; the store (open with ref, split and re-root carry, stale loads, `showInDay`, dropped targets, viewport and day state across close); static markup (switch, card ◷, paths only under All conversations); read-only refusals; settings `mode` |
| **Desktop app, driven by the run-desktop skill** (Electron, Windows, fixtures and owner's stores read-only) | List/Day switch; day navigation; Open in tree and Esc back (same turn and viewport); Enter after picking a lane; Settings key isolation and focus return; wheel zoom with no pane scroll (and ordinary pane scroll elsewhere); a short narrow pane (card shrinks and scrolls, pane scrolls under 380px); wrapped names with nothing clipped (7 real chats, 820px and 1440px); time labels without overlap at 27%; ◷ from a card (lands on the fork's latest-ending turn) and from the tree (lands on the selected fork turn); paths only under All conversations; read-only refusal of `click-text fork` and of bridge resume/open calls |
| **Not verified** | **The VS Code webview** (theme classes, a narrow side panel, focus, wheel and `postMessage` latency; roadmap item); macOS and Linux (and `xvfb-run` for the driver); a Codex fork in the driver's fixtures mode (needs a `codex` binary, and the synthetic rollouts aren't complete enough for the app-server); `labelLines` with wide scripts (CJK, emoji) |
| **Performance** | Measured read-only on the owner's stores (158 families) at `79807bc`: per-day cold load 70–370 ms after a cold list, warm about 18 ms. **Not re-measured** since the revision key and `running` were added. Both should be cheap (one digest per family per list; one pass over loaded nodes), but re-measure before claiming numbers |

Interactive behaviour has no automated test, because the renderer tests render static markup with no DOM (`renderToStaticMarkup` with a zustand shim). The cheapest way to add coverage is a DOM test environment (happy-dom or jsdom) for `src/*.test.tsx`. That is an owner-level decision about test infrastructure.

## 7. Working on it

- **Commands:** `npm test`, `npm run typecheck`, `npm run build`, `npm run build:vscode`. Run both builds whenever shared types, the worker, the bridge or a host changes. To check the boundary, grep `dist-electron/main.cjs` and `vscode-ext/dist/extension.cjs` for `dayActivity`, `parseRecords`, `stitchFamily` or `loadCodexSession`; there should be none.
- **Seeing the UI:** build, then pipe commands to the driver:
  ```sh
  printf '%s\n' 'launch' 'day 2026-10-01' 'click-text fork 22222222' 'key ArrowLeft' 'text .day-card' 'ss day' 'quit' \
    | node .claude/skills/run-desktop/driver.mjs
  ```
  - All fixture turns are on **2026-10-01** (10:00–18:20 UTC).
  - Set `SCREENSHOT_DIR` to your scratch directory, and **look at the screenshots**.
  - `launch real` reads the owner's stores with a scratch home and `AGENTREE_READ_ONLY_STORES=1`. Its screenshots contain private titles: keep them in scratch and never commit or quote them.
  - Driver gotchas:
    - selectors can't contain spaces (arguments are split on whitespace);
    - SVG nodes need a dispatched click (`click` handles it);
    - page scrolls after `wheel` are smooth, so wait before reading `scrollTop`;
    - `fill` needs a non-empty value.
- **Real-store audits:** use a scratch `AGENTREE_HOME` and import the registry through `tsx` from a script in your scratch directory. Print counts and timings, never text. Loading families writes annotation migrations, but only into that home.
- **Fixtures for mutation tests:** copy them into a temp home in `vi.hoisted` (as `test/day.test.ts` does). Never write into `test/fixtures`.
- **Commits:** describe the change and leave out roadmap ids (an owner preference). End with the `Co-Authored-By` line from the session's attribution instructions. Commit on `day-view`, and don't push unless asked.
- **Environment trivia (Windows):** the repo uses `core.autocrlf=true`, so LF→CRLF warnings on commit are expected. When editing files through Python, set `PYTHONUTF8=1`: the default code page mangles `·`, `“”` and `◷`, and exact-match replacements then fail.

## 8. Deliberate choices and known limits

None of these is a bug. Change one only on the owner's direction.

- **No annotations, and only a 400-character preview, in the day view** (contract 4). Open in tree for the rest.
- **Time-only zoom** (contract 10), chosen so names and time labels stay readable at any zoom. Fit means fitting the day's *width*; the lanes scroll vertically.
- **`labelLines` estimates** from character counts (7px per character on 12px text, words wrapping whole), as the tree estimates its box widths. It is generous for Latin text but can under-estimate wide glyphs. The label clips (`overflow: hidden`) rather than overlapping the next lane. Measuring would mean a render–measure–relayout pass.
- **The ◷ card button uses the day of `activeAt`.** It never uses `touchedAt`, which bookkeeping records can move. If that day holds no turn of the family (activity was tool records past midnight), the day opens with nothing selected.
- **Filter clearing by `showInDay`** also changes the list's filters, which are shared state.
- **The rail's counts in Day mode count families** (the list's rule), not lanes.
- **The selected day isn't remembered** across launches; only the mode is.
- **One window-level keyboard listener**, guarded by input, dialog and focus rules, rather than per-element handlers. Arrows work while focus is anywhere outside inputs, by design.

## 9. Candidate next steps

These are suggestions, roughly by value, not commitments. Check the [roadmap](../../roadmap.md) and ask the owner before starting anything that isn't a fix.

1. **Verify in the VS Code webview** (F5, or a packaged `.vsix` on a disposable home). Check: theme variables under `body.vscode-dark/-light`, the stacked layout in a narrow side panel, focus and Enter, the wheel, Settings as a modal, and ◷ from the tree. Record results in the roadmap or a dated note, labelled as VS Code checks.
2. **Re-measure performance** on real stores (read-only, scratch home), cold and warm, for today, yesterday, a week ago and a month ago. Update the number in the design notes.
3. **Decide on a DOM test environment** (owner decision). That would let focus, wheel cancellation, modal isolation and constrained-height layout regress in CI instead of only in driven checks.
4. **Prev/next *active* day.** ◀ ▶ step by calendar day. "Previous day with activity" needs per-day knowledge the list doesn't have. One honest source is `[startedAt, activeAt]` ranges as candidates, confirmed by `getDay`. Don't infer it from `activeAt` alone.
5. **Annotations in the day view**, if the owner wants them: extend each family's cache key with its sidecar identity, then project `label` and `status`. Never patch them in on the client.
6. **Large days.** SVG with one element per turn has been fine up to the low hundreds. If a day reaches thousands of turns, consider culling dots outside the viewport (the x mapping is monotone, so a binary search over `dots` by x works) before reaching for canvas rendering.
7. **CI** for tests, typecheck and both builds is already a release follow-up on the roadmap. This branch adds about 50 tests that would benefit.

## 10. Lessons from this track

Each of these cost a review round or a fix. Check new work against them.

- **Identity crosses snapshots.** Anything carried from one read to the next (selection, a click target, a ◷ target) must go through `NodeRef` and `locateBy`. Head ids and composite keys break when groups split or families re-root.
- **Cache keys must cover inputs, not symptoms.** Times and counts missed renames and same-time rewrites. A global index stamp invalidated every family on one rename. The answer was a per-family revision of exactly what the load reads.
- **Guards belong at the action.** A text filter on clicks was bypassed by other text and by the keyboard. The read-only switch sits in `forkAnyAt` and in the host hand-offs.
- **Don't drive tools against committed data.** The driver's first fixtures mode pointed the app at `test/fixtures`, where a fork would have written into the repository. It now copies them.
- **Browser defaults matter:**
  - React's wheel listener is passive;
  - "0 conversations" renders before the first scan answers (the driver waits for cards);
  - Codex stamps a prompt and its reply in the same second, so equal-time ordering must put parents first (`timeOrder`).
- **Geometry that depends on zoom belongs in the view.** Tick thinning moved from layout to `visibleTicks` when labels stopped scaling.
- **Verify behaviour in the running app.** Static markup tests did not catch any of the focus, scroll or wheel problems; the driver did.

## 11. How the owner works

These are observations from this track. Confirm them against current instructions.

- The owner sends **review rounds** and asks for changes that are holistic and proportionate, and **structural where the cause is structural**, with no regressions and with documentation kept consistent across README, AGENTS.md, the user guide, the design notes and the archive.
- Each review is recorded in `docs/archive/day-view/`, with its resolution at the top and the original findings unchanged below (anchors added). The archive's README indexes them. The owner moved the first record here from the modernization archive, so keep this track's history in this folder.
- The owner asks clarifying questions mid-task and expects them answered in the same turn (for example "paths only under All conversations").
- Screenshots from the owner are of their real stores. Treat titles in them as private.
