# Day view review, round 4 — 2026-10-28

> **Historical review of the full `7d3a66c..a2dc5d4` branch; resolved.** The original report follows the resolution below unchanged; its line references are to `a2dc5d4`. Current contracts are in the [design notes](../../design.md#day-view).

<a id="resolution"></a>

> **Resolution (2026-10-28, same branch, after `a2dc5d4`).** All three
> findings had merit, and each had the structural cause the report names.
> Findings 1 and 2 are one: a day answer was adopted without checking that
> the user's intent was still the one it answered. Finding 3: activity was
> kept only on the drawn node, so drawing a shared turn once dropped the
> other copies' activity.
>
> | # | Fix | Check |
> |---|---|---|
> | 1, 2 | `loadDay` captures the intent with the request: the pending `dayTarget` (each request a new object) and `daySelected`, in the snapshot it was picked from. If either changed by the time the answer arrives, the answer is not adopted, so no selection, no consumed target, no day move and no filter clearing. The load asks again from the newer intent. That snapshot is still on screen, so a turn picked meanwhile is sent to the worker by its drawn end (`wantOf`), never kept by its key. The previous fallback that kept a newer pick by `turnKey` is gone. This is the tree's `view` rule applied to the day, now stated in AGENTS.md | Store tests, both failing on `a2dc5d4` and passing now. Two same-day requests: worker requests A, then B, then B's ordinary refresh; B is selected and no error is set. Picking merged B (ending at `b2`) while A refreshes, with the answer splitting B: the answer about A is dropped, B is asked for with its drawn end, and `b2` is selected |
> | 3 | Activity belongs to a physical copy. When stitching matches a member's node to an existing tree node, the member's `activeUntil` is kept on its occurrence (`occurrences[].activeUntil`). The display owner, ends, "latest" and fork cuts are untouched. A copy's own records, including a re-stamped last one, are its start and end, never activity. `dayPart` projects each occurrence's activity as a `DayRun` in the lane of the member that recorded it, from the turn's start, so the filters apply to it as to that lane. The layout folds runs into `busyUntil` in start order, before the first turn starting after them, instead of only seeding from runs that began before the day. Codex needs no rule: its forks share turns by reference, and work after a shared turn is a turn of its own | `test/day-find.test.ts`: the report's case (parent P and fork F share the 09:01 reply; only F has tool completion and `turn_end` at 10:00) gives a run for F, 09:01–10:00:01, and F's chat is listed. The overnight variant gives the next day a run for the fork, 23:51–00:40:01. The Claude endpoint fork's re-stamped copy gives no run. Layout test: the same turns get a break without the run and none with it, and a run cannot make the pause before its own start busy |
>
> Not changed: the worker's family lookup, the persisted identity scheme,
> membership and display ownership.
>
> Verification: 190 tests in 20 files (186 before), `npm run typecheck`,
> `npm run build` and `npm run build:vscode` pass on Node 26.3.0, Windows.
> `git diff --check` is clean. These are store-logic and projection fixes,
> so no new desktop check was made; the VS Code webview remains a roadmap
> check.

## Original report

Full branch review of `7d3a66c..a2dc5d4`: seven commits and 50 changed files, including the three earlier review resolutions and the subsequent UI changes. The working tree was clean when review began. Runtime sources and tests were not changed by this review.

**Assessment:** the feature and its architecture fit Agentree's purpose, but three P2 correctness findings remain. Fix these before merging. The previous review's specific reproductions are now addressed; these findings concern newer user intent during asynchronous reads and activity surviving family stitching. No new store-write bypass, persisted-identity migration problem or host/worker boundary violation was found in the inspected paths.

## Findings

<a id="dv4-1"></a>

### 1. [P2] An old day request can erase a newer target for the same day

References: [store.ts:299](../../../src/store.ts#L299), [store.ts:313](../../../src/store.ts#L313), [store.ts:334](../../../src/store.ts#L334).

`loadDay` captures `dayTarget` before awaiting `getDay`. On return it validates only the day string, then applies the captured target's result and unconditionally clears `dayTarget`. A newer target for that same date is consequently treated as belonging to the old request.

Executed reproduction through the actual renderer store with a stubbed asynchronous API:

1. Request conversation A in Day; keep its first `getDay` pending.
2. Request conversation B for the same date before A answers. In the UI this can happen by returning to List while A is loading, then using B's day button.
3. Answer A's request.
4. A's result clears B's pending target and selects A. The gate's coalesced second pass now requests A's selected turn instead of B.

Observed requests were `[["A"], ["A"]]`; selection ended at `claude:A:A1`, although the newer request was B. The day-string check does not distinguish two navigation intents on the same day. If A's answer points to another date, the captured-target branch can also move the day after the user has requested B.

Give explicit navigation a revision/token and check it before adopting a result, redirecting days, clearing filters or consuming the pending target. Preserve a newer target and arrange the next pass to resolve it. The existing day-change test covers different dates, not two requests for the same date. This is a renderer result-adoption problem; the worker's family lookup need not be changed to fix it.

<a id="dv4-2"></a>

### 2. [P2] A turn picked during a refresh still falls back to its raw composite key

Reference: [store.ts:341](../../../src/store.ts#L341).

When the user selects another turn while `getDay` is pending, `now !== sel` bypasses the worker's endpoint-aware result. It preserves the new selection whenever its old `turnKey` exists in the returned projection. A `turnKey` still contains only the display group's head ID; its existence does not establish that it represents the same endpoint.

Executed reproduction through the actual renderer store with a delayed API response:

1. The current snapshot contains A and merged B, where B ends at `b2`.
2. Begin a refresh while A is selected, so the request asks the worker to find A.
3. While that read is pending, select merged B in the still-visible old snapshot.
4. Return a projection in which a quiet fork has split B into `b` and `b2`.
5. The store keeps `claude:P:b`, now ending at `b`, instead of retaining B's drawn endpoint at `b2` or deselecting it. The subsequent tree handoff carries the shortened reference.

This reintroduces the earlier endpoint-loss problem specifically for a selection made during a live refresh. It also clears a newly picked turn unnecessarily if re-rooting changes its key while it remains in related history. The new test for picking during a refresh uses unchanged keys and unchanged endpoints, so it proves only the simple case.

Capture the newly picked turn's `DayWant` from the old snapshot before replacing it, and have the worker resolve that intent too. Retry/coalesce when the selection changes during the request, or otherwise retain the drawn reference until resolution completes. Do not repair this by searching semantic identities across the day's mixed families again. A result for the earlier selection is not evidence about the newer one.

<a id="dv4-3"></a>

### 3. [P2] Stitching discards activity recorded on a fork's copy of a shared turn

References: [copilot.ts:146](../../../electron/providers/copilot.ts#L146), [stitch.ts:128](../../../electron/providers/stitch.ts#L128), [registry.ts:292](../../../electron/registry.ts#L292).

Providers now attach `activeUntil` to their parsed nodes, and same-role grouping combines it. Shared-prefix stitching has no corresponding activity rule: when a child's node matches the parent's existing node, only occurrence information is retained. The child's `activeUntil` is dropped with its physical copy. The day projection then sees only the canonical owner's activity, even when a fork continued working beneath that shared message.

Executed reproduction using two newly created synthetic Copilot sessions in a disposable home:

- P: prompt at 09:00, assistant “Working” with a shell request at 09:01, next prompt at 10:01.
- F: copied prompt and reply under rewritten IDs, followed by tool completion and `assistant.turn_end` at 10:00; F has explicit parentage to P and no new prose.
- The resulting shared reply correctly lists F as a holder, but has no `activeUntil`. The layout emits a **60-minute idle break**, despite F's recorded work ending one minute before the next prompt.

This is a synthetic supported-format case, not an executed vendor-resume claim. It exercises the actual provider, registry and layout. The new activity tests cover standalone families and the new selection test covers copied prefixes, but no test combines activity with copied-prefix stitching.

Define how occurrence/member activity survives canonical display deduplication. A family-wide timeline must retain genuine post-fork activity from every member even when its visible message is shared. Decide explicitly how to distinguish it from restamped copied history and how directory/provider filters apply; simply changing the drawn owner or widening membership would mix distinct contracts. A separate member activity projection, or a carefully specified reduction during stitching, can preserve the information without changing message identity, display ends, latest-turn ranking or fork cuts. Add the shared-copy case and an overnight variant to the regression coverage.

## Previous resolutions and overall design

The round-3 fixes are substantive. `DayWant` gives the worker the family context needed for recovery. The cross-family weak-key reproduction and the selected endpoint outside the current window are now covered by executed tests, with a found out-of-window turn deselected by the renderer. Identity-only recovery within a family now handles ambiguity instead of arbitrarily taking the first intersecting node. This preserves the existing persisted identity scheme.

Separating `activeUntil`/`activeEndOf` from `endedAt`/`endOf` is also the appropriate model correction. The ordinary standalone Copilot tool-run case, Codex items and Claude ancestry have regression coverage. Latest-turn ranking and fork endpoints continue to use their established display/end contracts. Finding 3 is the remaining reduction boundary for this new field.

The list's day navigation now asks for an actual latest turn and can follow its starting date. The store's alternate-day hop has test coverage. The CJK title fix was also verified in the built desktop app: 80 CJK characters produced 112px of rendered text within a 160px lane, with its folder line separate and no clipping in the inspected screenshot.

The worker-only store boundary, shared typed bridge, provider-supplied revisions, conservative `startedAt` bounds and action-level read-only guards remain appropriate. Inspected desktop and VS Code host bundles contain no implementations of `parseRecords`, `stitchFamily`, `loadCodexSession`, `findWant` or `dayActivity`. Both hosts forward the optional day-selection request to the worker. No parser or persistence redesign, identity-scheme change, app-server read path, SDK dependency or reopening of the owner-confirmed provider decisions is justified by this review.

The new folder lines, removal of directory lines from the chat list, and themed scrollbars fit the requested product behavior. Folder lines appear under All conversations and disappear with a directory selected. The selected card retains its full path. Static pure layout/filter helpers remain useful, and the modest SVG approach is proportionate to the documented local-viewer scope.

The important remaining state-model issue is distinguishing a loaded snapshot from the user's current intent. A date, a display key and a gate's `again` bit are insufficient to identify that intent. The tree's existing protection against stale view results is relevant precedent; a comparable day-navigation/selection contract would address findings 1 and 2 without duplicating selection semantics in components.

The activity model likewise needs to account for physical occurrences as well as the canonical semantic node. Display deduplication must not erase an independent fact such as work recorded later by a member. Retain the existing separation among identity, occurrence, membership, display grouping and fork anchors when extending it.

## Verification and remaining limits

- **Automated:** all 186 tests in 20 files passed, as did `npm run typecheck`, `npm run build`, `npm run build:vscode` and `git diff --check main...HEAD`, on Node 26.3.0, Windows. The reviewed execution outside the sandbox was used where esbuild/test subprocesses required it.
- **Targeted reproductions:** findings 1 and 2 were executed against the actual Zustand store with a stubbed API, without transcript access. Finding 3 used new disposable Copilot/Agentree homes and the actual provider, projection and layout. No original stores or live model generation were used.
- **Desktop UI:** used the [run-desktop skill](../../../.claude/skills/run-desktop/SKILL.md) on copied fixtures. Inspected dark/light screenshots at 1440×860 and 820×600, including the lane folder lines, chat-list paths being absent, and custom scrollbars. Checked lane/arrow selection, Enter into Tree, Esc back, basic Settings focus/Tab/Esc, the 80-character CJK name and hiding folder labels with a directory filter. The app was closed normally with the driver.
- **Not executed:** a VS Code webview session, native-wheel cancellation in this pass, full modal-key isolation, native fork/resume/deep-link workflows, real-store audits, macOS/Linux checks or a new performance measurement. Earlier evidence remains labelled separately. The primary-product VS Code theme/interaction smoke check remains a documented release follow-up.
- **Test gaps:** add delayed-response cases that change target or selected endpoint, and activity on shared copies. Existing static-markup renderer tests still cannot establish browser focus, wheel cancellation or actual geometry. A browser/DOM test layer would make those regressions repeatable, but is not a prerequisite for the focused logic fixes above.

Known sidecar concurrency limitations, unexecuted native canaries, broad very-narrow-pane responsiveness and large-day performance remain the documented follow-ups from earlier work; this review does not present them as newly discovered branch regressions. The feature is close to its stated purpose, with the remaining correctness work concentrated at the asynchronous intent and copy-stitching boundaries.
