# Day view review, round 5 / merge assessment — 2026-10-28

> **Historical review of the full `7d3a66c..e014355` branch; resolved.** The original report follows the resolution below unchanged; its line references are to `e014355`. Current contracts are in the [design notes](../../design.md#day-view).

<a id="resolution"></a>

> **Resolution (2026-10-28, same branch, after `e014355`).** Both findings
> had merit, and both were fixed at the layer the report names. Finding 1
> is the boundary the round-4 occurrence fix lacked: a copy's activity was
> its parsed end, with no way to tell copied history from new work and no
> start of its own. Finding 2 was loop-wide state for a per-request rule.
>
> | # | Fix | Check |
> |---|---|---|
> | [1](#dv5-1) | Provenance by record time. Each parse keeps, per node, the times of the activity records under it, leaving out the node's own records (Claude `Parsed.activity`, Copilot `ParsedSession.activity`; `markActivity` now takes the drawn groups' records as `own`). Stitching gives an occurrence only the activity its source (the parent member's copy of that tree node) doesn't have (`ownWork`), as `activeFrom`–`activeUntil`. Copiers keep record times, so copied history is shared, and a copy's re-stamped record is its own record, not activity. `dayPart` starts a copy's run at `activeFrom`. `TurnNode.activeUntil`, display ownership, ends, "latest" and fork cuts are unchanged | `test/day-find.test.ts`, all failing on `e014355`. Case A: a Claude fork of an Oct 1 reply, copied with the reply re-stamped Oct 3 12:00 and its own tool result at 12:02. It gives no run on Oct 1, and one from 12:02 on Oct 3. Case B: Agentree's actual Copilot fork writer, run on a disposable store, copies through `assistant.turn_end`; the fresh fork holds the reply and gives no run. The round-4 cases now run from the fork's first own record (10:00, and 00:40 after midnight, no longer from the evening before) |
> | [2](#dv5-2) | The one move to the day a target's turn started belongs to the request. The moved target carries `moved: true`, and the loop-wide `hopped` flag is gone. A newer request is a new object without it, so it gets its own move | store test, failing on `e014355`: A asked on Oct 3 moves to Oct 2; B asked on Oct 2 meanwhile moves to Oct 1 and is selected there, with no error |
>
> **Proportionality and merge readiness.** The two fixes stay inside
> existing contracts: one per-node map and one difference at stitching,
> and one field on the pending target. They add no new state framework or
> provider infrastructure, change no persisted format, and don't change
> the identity scheme. The report's own proportionality analysis stands:
> this is a moderately sized, coherent feature PR, mostly tests and
> documentation, with no dependency changes. With its blocking P2
> resolved, the branch is ready to merge on the evidence available. That
> evidence is automated and desktop. The VS Code webview remains a
> documented release check on the [roadmap](../../roadmap.md), along with
> native fork and resume canaries and a performance re-measurement.
>
> Verification: 193 tests in 20 files (190 before), `npm run typecheck`,
> `npm run build` and `npm run build:vscode` pass on Node 26.3.0, Windows.
> `git diff --check` is clean, and the host bundles contain no provider,
> stitching or projection code. The new Copilot fork test uses Agentree's
> own writer, on a temporary store only. No new desktop check was made:
> these are provider, projection and store-logic changes.

## Original report

Full branch assessment of `7d3a66c..e014355`: eight commits and 52 changed files, including all earlier review resolutions. The working tree was clean at the start. This review also assesses proportionality and whether further work is necessary before merging.

**Verdict: not quite merge-ready.** One P2 remains in the copy-activity model, with two executed counterexamples below. There is also a narrow P3 navigation issue. The architecture and overall scope are proportionate; neither finding warrants a broad rewrite. Fix the P2 before merging. The P3 can be a follow-up, though its correction should be small. Existing VS Code/native verification gaps remain explicitly separate from these findings.

## Findings

<a id="dv5-1"></a>

### 1. [P2] Copy activity still lacks its copied-history boundary and its own time bound

References: [stitch.ts:139](../../../electron/providers/stitch.ts#L139), [registry.ts:279](../../../electron/registry.ts#L279), [registry.ts:287](../../../electron/registry.ts#L287), [copilot.ts:146](../../../electron/providers/copilot.ts#L146).

Retaining `activeUntil` on occurrences fixes the previous case where a fork's activity disappeared. However, the retained value is the parsed copy's activity end, not necessarily *new work after copying*. The occurrence carries no local activity start or copied-prefix boundary. `dayPart` then manufactures a `DayRun` starting at the canonical owner's `n.timestamp`.

Two executed reproductions expose the remaining attribution problem. Times below are synthetic UTC timestamps.

**A. Later fork work makes an earlier pause busy.** A temporary Claude parent contains a prompt and reply on October 1. Its fork has the matching copied reply restamped to **October 3 at 12:00**, then a tool result at **12:02**. Another conversation has turns at 09:00, 09:01 and 10:00 on October 3.

The projection correctly retains the fork's later tool activity, but emits its run as **October 1 at 09:01 → October 3 at 12:02**. Including that run removes the other conversation's 59-minute gap before 10:00; excluding it restores the gap. The fork's noon work has been made to cover the morning before its copied reply. Sorting runs by start cannot repair this because the wrong start was already supplied.

This used the actual Claude provider, registry and layout with new disposable homes. The start comes directly from the canonical message; the copy's own restamped time is lost at the occurrence boundary. This is an incorrect time bound, independent of any attempt to infer exact runtime utilization from sparse logs.

**B. A fresh Copilot fork with no new events is reported as doing work.** In a synthetic Copilot parent, a 09:01 assistant message is followed by tool completion and `assistant.turn_end` at 10:00:01. I executed Agentree's actual `forkAnyAt`/Copilot copy-fork writer against this temporary store. Its cut includes those closing events, as intended. The new fork contains **zero additional events** and was never resumed.

Nevertheless, `dayActivity` reports a run in the fresh fork's lane from **09:01 to 10:00:01**. The parser treats the copied closing records as `activeUntil`, and stitching transfers that end to the occurrence. The current comparison against the canonical node's display `endOf` does not distinguish inherited activity from work after the fork. This also affects the claimed lane/filter attribution, even when the parent's own interval happens to hide the duplicate in an unfiltered layout.

The existing restamp test covers a Claude copy whose own message record is restamped and has no trailing copied activity. It does not cover a copied Copilot closing record. The new shared-copy activity tests also give parent and fork the same message start, so they do not exercise case A.

**Proportionate correction:** retain enough copy-local timing/provenance to establish which activity follows the copied prefix and the earliest time that activity can cover. Project a copy's run from that bound, not from the drawn owner's historical timestamp. Pure copied history must add no new member work, while genuine later fork activity must survive. Keep canonical display ownership, membership, semantic identity, display ends, latest ranking and fork cuts unchanged. Add both counterexamples, including a copy made on a later calendar day, to the fixture/projection coverage.

This is the remaining boundary of the round-4 activity fix, rather than a reason to replace the provider or stitching architecture.

<a id="dv5-2"></a>

### 2. [P3] A newer target inherits the previous target's consumed alternate-day allowance

References: [store.ts:301](../../../src/store.ts#L301), [store.ts:325](../../../src/store.ts#L325), [store.ts:329](../../../src/store.ts#L329).

`hopped` belongs to the entire gated `loadDay` invocation. When a new pending target is detected, the loop correctly discards the old answer and asks about the newer intent, but it retains `hopped = true` from the old target. The new target consequently cannot make its own one permitted correction to its turn's starting day.

Executed reproduction through the actual renderer store and a fully stubbed API, with no filesystem access:

1. Request A with an initial date of October 3. The worker finds A's turn on October 2, so the store hops there and begins the second request.
2. While that request is pending, return to List and request B on October 2. B's latest turn actually started October 1; its activity ended October 2.
3. Return the pending A answer. The intent check correctly discards it and asks for B.
4. The worker finds B on October 1. Because A already set `hopped`, the B result is accepted without its date correction, its pending target is cleared, and the view remains on October 2 with no selection and no error.

Observed request dates/targets were `Oct 3/A`, `Oct 2/A`, `Oct 2/B`, followed by an ordinary October 2 refresh. October 1 was never requested.

Scope the corrective-hop allowance to the logical target being resolved, resetting it when an unrelated pending intent supersedes that target. Retain the one-hop limit for a single target. This requires the conjunction of a replacement request and two alternate-day cases; it is a usability issue with a retry workaround, not a merge blocker on its own.

## Resolution checks and architecture

The prior round's async reproductions are fixed: a newer same-day target is not consumed by an older answer, and a turn selected during a refresh is asked for by its drawn endpoint before a new snapshot is adopted. The new tests fail on the earlier implementation and pass here. Using pending-target object identity plus the selected key is a compact solution while the old snapshot remains on screen; it does not require a new state framework.

The previous missing-copy-activity case and its overnight variant now retain activity in the member's lane. Per-occurrence metadata is the right layer for facts about a physical copy. Finding 1 concerns the missing boundary/start information at that same layer. The separation between `activeUntil`/`activeEndOf` and `endedAt`/`endOf` remains sound and should be preserved.

The cumulative architecture remains appropriate:

- Store access and family recovery remain in the worker. The optional `DayWant` crosses both typed host bridges, with no provider logic added to the renderer or hosts.
- Provider revisions cover the projection's inputs, conservative start bounds narrow family loading, and the projection cache avoids reloading unchanged families. No new persisted cache or annotation format was introduced.
- Selection recovery retains family context and endpoint semantics. Weak text identities are not searched across unrelated families. The persisted identity scheme and owner-confirmed provider/fork decisions remain unchanged.
- Original-store protections remain at the actions. No new fork or native hand-off surface was introduced by these fixes. The synthetic fork reproduction above used only a new temporary store and did not invoke a vendor runtime.
- Filtering and layout remain pure helpers, and the shared renderer continues to serve Electron and VS Code. The SVG approach is reasonable for the documented local-viewer scale.

Inspected production host bundles contain no implementations of `parseRecords`, `stitchFamily`, `loadCodexSession`, `findWant` or `dayActivity`. This is source/bundle evidence, not a claim that native vendor hand-offs were executed.

## Proportionality

The committed branch adds 5,384 lines and removes 209. Of the additions, **2,486 are runtime code**, **1,390 tests**, **1,026 documentation** and **482 the desktop skill/driver**. The large file count therefore overstates the production change. There are no changes to package dependencies or lockfiles in this branch.

Most runtime additions are the day component, pure layout/date/filter helpers, projection and selection contracts, activity metadata, and the bridge wiring needed for the two hosts. The shared wheel/modal fixes and the read-only test guard support actual integration and safe verification. The driver has its own commit and a concrete testing purpose. Historical reviews are kept in the designated archive rather than becoming another current specification.

This is a moderately sized, coherent feature PR. Further decomposition into generic timeline engines, a new state-management system, new provider infrastructure or a replacement rendering technology is not justified. The two findings call for bounded changes at existing contracts: copy-local activity provenance/timing and per-target hop state. DOM-backed tests, larger-scale performance work, CI and broader distribution smoke checks remain sensible follow-ups, not reasons to expand this patch indefinitely.

The feature is fit for its stated local conversation-viewer purpose. The actionable reason to hold merge is the incorrect copy-activity attribution above, rather than PR size, architectural direction or the accumulated number of review rounds.

## Verification and limits

- **Current automated checks:** all 190 tests in 20 files passed on Node 26.3.0, Windows. `npm run typecheck`, `npm run build`, `npm run build:vscode` and `git diff --check main...HEAD` passed. Reviewed execution outside the sandbox was used where esbuild/test subprocesses required it.
- **Current targeted execution:** the later-copy start case used a new synthetic Claude family and the real provider/projection/layout. The inherited-closing-event case used Agentree's actual Copilot fork writer on a new synthetic temporary store, then the real projection; the new fork was not resumed. The hop-state case used the real renderer store with a stubbed API and completed without errors.
- **Current source inspection:** reviewed the latest changes and their composition with the cumulative branch: family stitching/grouping, activity projection/order, cache revisions and date bounds, selection/target adoption, shared endpoint recovery, both bridges, read-only actions, and current/archived documentation.
- **Earlier UI evidence:** the round-4 review inspected dark/light desktop screenshots, lane folders, directory filtering, CJK wrapping, Settings focus and Day/Tree return behavior. Those renderer/CSS sources are unchanged by `e014355`. No new desktop or VS Code UI session was executed in this pass; the new interval behavior was checked through the actual projection and layout functions.
- **Still unverified:** VS Code webview interaction/theme/scrollbar behavior, native vendor fork/resume/deep-link canaries, macOS/Linux behavior, native-wheel behavior in this pass, and a new performance measurement. These remain the documented finite release follow-ups; passing builds are not evidence of successful native workflows.

No original harness transcripts or databases were modified. No live model generation was invoked. Runtime sources and tests remain unchanged; this report and its archive-index entry are the only repository edits made by the review.
