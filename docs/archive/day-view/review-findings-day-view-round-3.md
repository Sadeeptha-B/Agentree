# Day view review, round 3 — 2026-10-28

> **Historical review of the full `7d3a66c..1b029d1` branch; resolved.** The original report follows the resolution below unchanged; its line references are to `1b029d1`. Current contracts are in the [design notes](../../design.md#day-view).

<a id="resolution"></a>

> **Resolution (2026-10-28, same branch, after `1b029d1`).** All three P2
> findings had merit, and so did both acknowledged gaps. As the report
> says, the P2s were composition boundaries, and each had one structural
> cause:
> - findings 1 and 2: a whole-family resolver was handed a partial,
>   cross-family snapshot (a day's turns). Selection resolution moved to
>   the worker, which has the family;
> - finding 3: display spans were read as execution intervals. Providers
>   now record activity under a node as its own field.
>
> | # | Fix | Check |
> |---|---|---|
> | 1, 2 | The renderer no longer resolves a day selection against the day's turns. `loadDay` sends a `DayWant` with `getDay`: the provider, the drawn `NodeRef`, and the sessions to find its family through (the lane, the other holders, now carried as `DayTurn.heldBy`, then the family). `findWant` (`registry.ts`) answers `DayActivity.found`. It takes a day turn that ends where the selection did (`endingAt`, sound across families because a session's record is in one family only). Otherwise it uses `locate` in the first of those sessions' families that loads, never another family. A found turn that starts outside the day is deselected on a refresh, since a refresh never changes the day. A missing turn is deselected too. Within a family, `locateBy`'s identity rule now requires an unambiguous match: one node holding an identity, else the one holding the last. `resolveForkPoint` is `endingAt` over a family's nodes, so there is one end rule. `resolveTarget`, which searched the whole provider, is gone | `test/day-find.test.ts` (disposable home). Finding 1's case: Copilot P, its quiet fork F with rewritten ids, and unrelated X with the same opening exchange (same `stableIds`, asserted). With P removed, the reply is found as `F`'s `f2`. Finding 2's case: a copy of the Claude endpoint fixture, with the window ending between `ep-a1` and `ep-a2`. After the quiet fork is added, the day's own `ep-a1` ends on itself, and `found` is `ep-a2`, outside the window. Store tests: the want sent, a re-rooted find followed, a find on another day deselected without changing the day, and a turn picked while a load was out kept |
> | 3 | `TurnNode.activeUntil` is the last activity under a node before the next drawn turn, by each harness's `activeAt` rules. Claude: every activity record counts for its nearest drawn ancestor. Codex: non-message items within the node's turn. Copilot: non-message activity events, including `assistant.turn_end`. It is merged as a maximum, projected as `DayTurn.activeUntil`, and read only through `activeEndOf`, by the layout's `busyUntil` and by `running`. Display, "latest" and fork points still use `endOf`. The legend and user guide say "no recorded activity" instead of "nothing running" | `test/day-find.test.ts`: the report's Copilot case (09:01 reply, tool and `turn_end` at 10:00, prompt at 10:01) gives the reply `activeUntil` 10:00:01 and leaves the next prompt without one. A Codex command run in its turn does the same. The overnight variant becomes the next day's `running`, ending 00:40:01. `test/endpoints.test.ts`: Claude tool results and a tool-only reply count for the reply. Layout test: the same messages give no break with `activeUntil`, and one break without it |
> | [dv3-4](#dv3-4) | A card's ◷ asks for the family's latest-ending turn (`familyWant`, no ref). The worker finds it in the family. If it starts on another day, the view moves there once and selects it. `activeAt` still sorts the list and names the button's date. An empty day's jump uses the same mechanism ("go to the latest turn", for the latest-active conversation the filters let through) | store test: a card asked on 10-06 lands on 10-05's turn, asked again by the found ref. `day-find`: the latest-ending turn is found from a window that holds none of the family's turns. Welcome test: the empty-day button |
> | [dv3-5](#dv3-5) | `labelLines` estimates by character width: 7 px, or a 12 px em for CJK, Hangul, fullwidth forms and emoji, which break between any two characters | layout test: 80 CJK characters wrap to 11 per line, more lines than 80 Latin characters, and emoji count as wide. Desktop app at 1440×860, with a fixture copy retitled to 80 CJK characters: the lane is 160 px, and the name's box clears the lane by 24 px above and below. Screenshot inspected |
>
> Done in the same change at the owner's request. Under All conversations, each lane names its directory's last folder at the bottom right, on a line the layout keeps for it. The side card's chat list dropped its paths, and the selected chat's card keeps the full path. Scrollbars in every pane are the app's own slim thumb instead of the platform's. In the desktop app, the folder lines are present with no filter and absent with a directory picked, and the chat list has no paths.
>
> Not changed: the deliberate rule that a turn belongs to the day it
> started, the persisted identity scheme, and the provider stitching.
>
> Verification: 186 tests in 20 files (173 before), `npm run typecheck`,
> `npm run build` and `npm run build:vscode` pass on Node 26.3.0, Windows.
> The host bundles contain no `dayActivity`, `findWant` or provider code.
> Not executed: the VS Code webview (scrollbars, folder lines and wide
> names there remain a roadmap check), real-store audits, and a
> re-measurement of day-load performance.

## Original report

Full branch review of `7d3a66c..1b029d1`, six commits, 46 changed files. This includes both previous review resolutions and the later wrapped-name and chat-to-day changes. The working-tree handover added during this review was read as additional context; it is not part of that committed diff. No runtime code was changed by this review.

**Assessment:** the architecture fits Agentree's local-viewer purpose. Fix the three P2 correctness findings below before merging. Two additional product limitations are recorded separately because the new handover already acknowledges them. No new original-store write bypass or host/worker boundary violation was found in the inspected paths.

## Findings

<a id="dv3-1"></a>

### 1. [P2] Day selection can move to an unrelated conversation after re-rooting

References: [store.ts:316](../../../src/store.ts#L316), [render.ts:184](../../../shared/render.ts#L184).

`loadDay` passes every turn of the selected provider to `locateBy`. Once the old physical endpoint and node ID disappear, the resolver takes the first intersecting `stableIds` value. Those identities are not necessarily unique across that provider's unrelated families. In particular, Copilot's text-derived identities qualify text by its parent chain, not by a globally unique conversation anchor. Two independent conversations with the same opening exchange legitimately have the same weak keys.

Executed reproduction using three new synthetic Copilot sessions in a disposable home:

1. Parent P has “Hello” → “Hello there”; F is its quiet fork, with rewritten event IDs.
2. Unrelated X has the same exchange, stamped an hour earlier. It is a separate family, not a fork.
3. Select P's reply, then remove only P's temporary files and refresh the day.
4. The projection now contains both F's inherited reply and X's reply, with the same weak identity. The exact resolver used by `loadDay` chooses **X**, because its turn occurs first in the day. It should retain F's related history or decline an ambiguous match.

This can silently change the selected chat; opening Tree then focuses the unrelated session. The existing re-root test contains only the intended replacement, so it cannot detect this.

Carry enough family/member context to constrain recovery to related history, and refuse ambiguous identity-only recovery. Keep the common resolver, but make its candidate scope and uniqueness requirements explicit. The same caution applies to its unqualified node-ID fallback: the day model itself states that node IDs are unique only within a family. Do not change the persisted identity scheme to solve a selection-scope problem.

<a id="dv3-2"></a>

### 2. [P2] A day refresh still shortens a selected group when its endpoint moves outside the day

References: [store.ts:316](../../../src/store.ts#L316), [render.ts:181](../../../shared/render.ts#L181), [registry.ts:275](../../../electron/registry.ts#L275).

The endpoint-preserving resolver can preserve an endpoint only if its candidate snapshot contains it. A day projection contains nodes whose *group starts* fall inside that day. Regrouping can move the selected endpoint into another day's projection without deleting it from the family.

Executed reproduction using temporary copies of the existing Claude endpoint fixtures, with their timestamps shifted across midnight:

1. Before the quiet fork appears, Day on October 1 draws `ep-a1` as “First prose. Later prose.” Its drawn endpoint is `ep-a2`, just after midnight on October 2.
2. Add the existing quiet-fork fixture. Membership correctly splits the group into `ep-a1` and `ep-a2`.
3. October 1's refreshed projection contains only `ep-a1`. `ep-a2` still exists in the family, but starts on October 2.
4. `locateBy` cannot see the endpoint, falls back to the old head ID, and selects “First prose.” Opening Tree now carries that shorter reference.

This reproduces the earlier endpoint-loss failure at the boundary between two day windows. It does not call for changing the deliberate rule that a node belongs to its starting day.

Retain the drawn reference independently of the visible turn key and distinguish “outside this projection” from “gone from the family.” Resolve against sufficient family context before accepting a shorter head. Either reveal the endpoint on its current day or explicitly clear the visible selection; do not silently replace its range. Add a refresh regression that combines the existing quiet-fork split with midnight.

<a id="dv3-3"></a>

### 3. [P2] The idle calculation treats display-message spans as complete execution intervals

References: [day-layout.ts:267](../../../src/day-layout.ts#L267), [registry.ts:272](../../../electron/registry.ts#L272), [copilot.ts:155](../../../electron/providers/copilot.ts#L155).

`busyUntil` advances only from projected nodes' `timestamp` and `endedAt`. These describe the displayed message/group's recorded span; they do not necessarily include all execution activity. For example, Copilot's parser recognizes `assistant.turn_end` but uses it only to extend the fork writer's `endLine`. Its timestamp never extends the node or supplies a separate activity interval. Tool events can also continue after the last displayed message.

Executed reproduction through the real registry and layout using a new synthetic Copilot store:

- 09:00: user prompt;
- 09:01: assistant “Working”, with a shell tool request;
- 10:00: tool completion and `assistant.turn_end`;
- 10:01: next user prompt.

The layout emits a **60-minute idle break**. The recorded execution ended one minute before the next prompt. The same missing interval also prevents a tool-ending turn from contributing the appropriate `running` context after midnight.

The existing tests demonstrate arithmetic over supplied `endedAt` values and an overnight reply with two assistant messages. They do not establish that actual closing/activity records reach that arithmetic.

Define a provider-backed activity-interval contract for the day projection, including available closing events and trailing tool activity. Keep execution activity distinct from display grouping and fork endpoints. If the data cannot establish execution intervals, describe the result as gaps between recorded messages rather than promising “nothing running.” Add a fixture with one displayed reply followed by tool/closing events, including an overnight variant.

## Additional fit-for-purpose gaps

<a id="dv3-4"></a>

### The card's day link can lead to an empty timeline for an overnight reply

References: [Welcome.tsx:345](../../../src/components/Welcome.tsx#L345), [day.ts:64](../../../src/day.ts#L64), [day.ts:137](../../../src/day.ts#L137).

The list chooses the day of `activeAt`; the day view draws groups by their start. These can name different days even without tool-only activity. Executed reproduction: a user prompt at 23:50 and two merged assistant messages at 23:55 and 00:30. The list's date button targets October 2. That projection has zero turns and one `running` interval, and `resolveTarget` returns null. The view therefore says “No activity” and cannot show the conversation that was explicitly requested. The empty-day “latest activity” jump uses the same unsuitable source.

The working-tree handover explicitly accepts the no-selection case as a limit. This report does not treat it as an undisclosed implementation deviation, but it remains at odds with the user guide's promise that the button shows that conversation with its latest turn selected. A proportionate improvement is a worker-supplied navigable turn reference and its starting day, or an explicit selectable representation for ongoing context. Keep `activeAt` for list activity ordering. At minimum, make the user-facing limitation and empty-state wording accurate.

<a id="dv3-5"></a>

### [P3] Wrapped lane names still clip wide scripts

References: [day-layout.ts:41](../../../src/day-layout.ts#L41), [day-layout.ts:231](../../../src/day-layout.ts#L231), [styles.css:614](../../../src/styles.css#L614).

`labelLines` estimates every character at 7px. The lane's button has a fixed estimated height and hides overflow. In the built desktop app at 1440×860, changing a copied fixture's title to 80 CJK characters produced a 112px text element inside a 96px lane. The screenshot showed clipping at both ends. The side-card version wrapped completely.

This is also acknowledged as an unverified limitation in the new handover. It is non-blocking, but the feature's promise of showing the whole name is broader than the implementation. Measure rendered text or use a layout estimate that accounts for wide glyphs, then verify actual browser bounds; comparing lane height against the same estimate in a pure layout test cannot prove that the text fits.

## Architecture, scope and maintainability

The worker-owned projection is the right extension point. It reuses the providers' stitched families, keeps filesystem work outside both hosts, and adds one typed API call through both bridges. The inspected production host bundles contain the proxy and read-only hand-off checks, with no `parseRecords`, `stitchFamily`, `loadCodexSession` or `dayActivity` implementation.

Provider-supplied revisions are a substantial improvement over timestamp/count cache keys. The inspected revisions cover transcript paths and stat identities, family names and relevant lineage. Conservative `startedAt` bounds, enabled-provider routing, bounded previews and excluding annotations from the projection are proportionate choices. I found no reason to replace the parser, stitching, fork or persistence architecture, or to reopen the owner-confirmed Codex/Claude decisions.

The important model gaps are at composition boundaries: identity meaningful within a family is searched across a whole provider; a whole-family selection resolver is given a partial-day snapshot; and a displayed message's recorded end is interpreted as an execution interval. These call for explicit context/contracts, not more UI-specific fallback conditions.

Pure filtering/layout functions and the shared selection resolver support maintenance. The test suite exercises meaningful ancestry, ownership, cache invalidation and stale-result cases. Its main weakness is combination coverage: re-rooting plus unrelated matching text; regrouping plus midnight; closing events plus idle detection; actual glyph measurements versus estimated geometry. Small targeted regressions should cover the first three. Browser-backed tests would help with focus, wheel cancellation, viewport restoration and constrained layout; the existing static-markup tests cannot establish those properties.

Large-day SVG performance, per-window caching, remembered-view scope and the deliberate absence of annotations are reasonable within the documented local-viewer scope. They do not warrant a speculative rewrite. Performance numbers retained from the first implementation are historical measurements, not results from this review.

## Verification and limits

- **Automated:** all 173 tests in 19 files passed; `npm run typecheck`, `npm run build` and `npm run build:vscode` passed on Node 26.3.0, Windows. `git diff --check main...HEAD` passed. Vitest initially could not start esbuild in the sandbox; the reviewed execution outside it completed successfully.
- **Executed synthetic reproductions:** the three P2 findings and the overnight list-link case above used disposable homes; the endpoint cases used copied committed fixtures. They exercised the actual projection and resolution/layout functions. These are local synthetic evidence, not vendor-runtime canaries.
- **Desktop UI:** used the repository's run-desktop skill on copied fixtures. Inspected screenshots at 1440×860, 820×600, 600×800 and 420×600. Checked lane selection, arrow navigation, Enter into Tree, Esc back with selection/viewport retained, and basic Settings focus/Tab/Esc behavior. Reproduced wide-script clipping. The 420px layout also shows severe inherited rail/search width pressure; that is a broader responsive-layout follow-up, not a newly isolated day-view finding.
- **Wheel limitation:** an additional CDP wheel/modal sequence stalled at the wheel dispatch. A separate Runtime query showed the fixture app remained responsive; it was then closed through its dedicated debugging connection. This review therefore does not claim a newly completed native-wheel or full modal-shortcut check. The earlier review's wheel evidence remains separate.
- **Source inspection:** traced the worker/API wiring, revision generation, selection recovery, provider timestamp inputs, read-only checks in both hosts and registry, the driver, and relevant current and archived documentation.
- **Not executed:** a VS Code webview session, native fork/resume or deep-link workflows, real-store audits, macOS/Linux behavior, or live model generation. The primary-product VS Code interaction/theme check remains an explicit release-verification gap. Original harness stores were not modified or used for probes.

The review used the [run-desktop skill](../../../.claude/skills/run-desktop/SKILL.md). Runtime sources and tests remain unchanged. The pre-existing working-tree handover and archive-index edits were preserved.
