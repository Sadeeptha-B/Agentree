# Day view review, round 6 / merge assessment — 2026-10-28

> **Historical review of the full `7d3a66c..b168353` branch; resolved.** The original report follows the resolution below unchanged; its line references are to `b168353`. Current contracts are in the [design notes](../../design.md#a-node-starts-and-ends).

<a id="resolution"></a>

> **Resolution (2026-10-28, `day-view-round-6` branch, after the day view merged and on top of `ci`).**
> The finding had merit, and its cause was structural: the activity maps
> carried only numbers, so the copied-history comparison had no evidence but
> a time to compare. They now carry records.
>
> | # | Fix | Check |
> |---|---|---|
> | [1](#dv6-1) | `ActivityRecord {at, key}` replaces the bare times in `FamilyMember.activity`, Claude `Parsed.activity` and Copilot `ParsedSession.activity`; `ownWork` subtracts by key. Each provider's key is the evidence its copier keeps. Claude (`activityKey` in `transcripts.ts`): the time, kind, API message id, and per content block the tool call made or answered with its length and an answer's outcome, since a fork that re-runs a copied call answers the same call id; no uuid. Copilot: the time, kind and a digest of the payload without the session id the fork writer rewrites; no event id. A key holds its record's time, so keys can only find more own work than times did, never less. Not a persisted identity: keys stay in the worker | `test/day-find.test.ts`, both failing before the fix. The reported Copilot case: the fork's run is 09:30–10:00, not a point at 09:30, and a third member copying the parent's events under rewritten ids adds no run. A Claude fork's re-run answer at its parent's instant is a run, and Agentree's own fork writer's copy of the parent's answer, on a disposable store, is not |
>
> **A crash found on real data, and the decision it confirmed.** The first
> version of the Claude key read a queued message's prompt as text, as
> `RawRecord` typed it. A read-only audit of the real stores (scratch
> Agentree home, `AGENTREE_READ_ONLY_STORES=1`) threw on the first transcript
> where it's content blocks: on CLIs 2.1.289–2.1.311 nearly every human
> queued prompt is. The provider guard caught it, and the list lost the whole
> Claude provider (164 families → 98). The key now reads shapes as found;
> `test/endpoints.test.ts` parses a block prompt. The fixtures had only text
> prompts. The same audit then gave identical digests before and after the
> fix: every family's nodes, holders, occurrences and identities, and 90 days
> of day projections (164 families, 1,600 nodes; no copy work on this
> machine). Cold listing time was unchanged (≈4.0 s against ≈4.1 s).
>
> **Out of scope, recorded on the [roadmap](../../roadmap.md).** The same
> survey shows those block prompts aren't drawn: the mid-turn projection
> accepts a text prompt only, and queue-operation reconstruction isn't used
> when attachments exist. On this machine 121 human mid-turn messages in 32
> transcripts are in no node, with no health warning. Drawing them adds turns
> and re-parents the turns after them, which stitching and weak identities
> both follow, so it needs its own fixture and an identity-compatibility check.
>
> Verification: 196 tests in 20 files, `npm run typecheck`, `npm run build`
> and `npm run build:vscode` pass on Node 26.3.0, Windows. No desktop check:
> worker-side provider and stitching changes only.

## Original report

Full branch assessment of `7d3a66c..b168353`: nine commits, 53 changed files, +5,671/−209 lines. The working tree was clean when review began. This includes the cumulative implementation, earlier resolutions, and the latest activity-provenance and per-request navigation fixes.

**Verdict: recommend merging within Agentree's documented local-viewer scope.** No P1 or P2 findings remain from this review. One P3 activity-timestamp limitation was reproduced and is suitable for follow-up. The architecture and implementation are proportionate. The existing VS Code/native smoke checks remain finite release-verification work; this assessment does not claim those workflows were executed.

## Non-blocking finding

<a id="dv6-1"></a>

### [P3] Equal timestamps can hide independent fork activity

Reference: [stitch.ts:57](../../../electron/providers/stitch.ts#L57).

`ownWork` treats any activity timestamp present in the source copy as copied history. Preserving a timestamp is evidence consistent with copying, but distinct events can have the same timestamp. The current map retains only numbers, so event IDs, tool-call IDs, event types and payload differences cannot distinguish them.

Executed reproduction with new disposable Copilot stores and the actual provider, projection, filtering and layout:

- Parent P and fork F share their prompt and assistant reply.
- P records a tool start at 09:15; F records its independent start at 09:30.
- P and F record different tool completions and turn-end events at exactly 10:00. The event IDs, tool-call IDs and result payloads differ, but their timestamps match.
- F's activity is reduced to a point at **09:30**, rather than ending at 10:00, because both finishing timestamps are removed as apparently copied.
- With P excluded by a directory filter and another visible conversation resuming at 10:01, the layout reports a **31-minute** idle interval instead of the one-minute gap after F's completion.

This is a narrowly conditioned activity-display error. It does not affect message identity, ancestry, membership, selection, annotations, latest-turn ranking, fork cuts or hand-offs. I would not hold this merge for exact-timestamp collisions in a recorded-activity overview. The previous P2 cases involved ordinary copies deterministically creating or losing large activity spans; those are now fixed.

As a follow-up, use a bounded activity-record key that includes suitable event/call/content evidence alongside the timestamp. Preserve event IDs where the copier preserves them; use copied stable fields where raw IDs are rewritten. Keep this separate from the persisted semantic-message identity scheme. Until then, regard timestamp subtraction as an activity-provenance heuristic rather than proof that two records are the same event. A regression with different records at the same instant would make the limitation explicit.

## Previous findings and current correctness

The round-5 copy cases are addressed at the intended layer. Claude and Copilot parses retain activity-record times apart from a drawn message's own records. Stitching compares a member's activity with its immediate source copy, and occurrences retain their own `activeFrom`–`activeUntil`. `dayPart` projects those copy-local bounds rather than borrowing the canonical owner's historical start.

The current regression suite executes the later Claude copy case and Agentree's own fresh Copilot copy-fork writer on a temporary store. The later fork no longer covers the days or morning before its own activity, and the untouched fresh Copilot fork contributes no extra work. The ordinary shared-copy and overnight cases retain genuine additional record times. Comparing each member with its parent member's copy also fits a fork-of-a-fork, without flattening source provenance onto the canonical owner.

The navigation fix is appropriately small: `moved` belongs to the pending request object. A newer request therefore receives its own alternate-day correction. The delayed-response tests also retain the previous safeguards: old answers cannot consume newer same-day targets, and a turn picked during a refresh is resolved by its drawn endpoint before adopting a new snapshot. The original round-5 replacement-target sequence is covered and passes.

The earlier cache-revision, midnight-window, family-scoped identity, quiet-fork endpoint, disabled-provider and read-only-action cases remain covered by the full passing suite. The persisted identity scheme and original-store write boundaries are unchanged. No new blocker was identified in their interaction with the latest changes.

## Architecture and data model

The design remains a good fit for a local conversation-tree viewer:

- **Worker-owned projection.** Providers and family lookup remain in the backend worker. Both hosts forward the same typed optional `DayWant`; the renderer has no Node access. The inspected production host bundles contain no implementations of `parseRecords`, `stitchFamily`, `loadCodexSession`, `findWant` or `dayActivity`.
- **Separate contracts.** Semantic identity, physical copies, holders, display grouping, vendor turns and fork endpoints remain distinct. Activity provenance is carried on occurrences; it does not change display ownership, `endOf`, latest ranking or fork cuts. Detailed activity-time maps stay in the worker, with only the projected bounds crossing the bridge.
- **Selection intent.** Family-scoped recovery and endpoint-aware references are reused across snapshots. Async result adoption checks the pending target and selected key while retaining the snapshot those selections came from. Per-request move state avoids a separate navigation framework.
- **Caching and visibility.** Provider revisions describe transcript/name/lineage inputs, date bounds conservatively narrow loads, and unchanged family projections are reused. Disabled providers are not invoked. Annotations remain deliberately absent from this cached projection.
- **Pure layout and filtering.** Calendar/DST handling, filters, lane/track geometry, navigation and compressed time remain testable outside the component. The SVG and shared renderer are reasonable for the documented scale.
- **Safe hand-offs and audits.** Read-only refusal remains at fork/open/resume action boundaries, not only UI controls. The fixture driver uses disposable copied stores. The owner-confirmed Codex read/fork split and Claude fork format are preserved.

No new persistence format, dependency, service, SDK, telemetry path or renderer privilege was introduced. I found no justification for reopening the owner-confirmed provider decisions or replacing the existing architecture.

## Proportionality

The committed diff's additions break down as **2,538 runtime lines**, **1,487 test lines**, **1,164 documentation lines**, and **482 desktop skill/driver lines**. There are no dependency or lockfile changes. The production change is therefore substantially smaller than the headline file/line count suggests.

The day component, layout/date helpers, worker projection, selection/activity contracts and two-host bridge wiring account for most runtime additions. Shared wheel/modal changes solve actual integration problems, and the read-only guard supports safe verification. The driver has a defined purpose and a separate commit. Historical reviews live in the designated archive; current behavior remains owned by the design notes and user guide.

The successive fixes add some model detail, but each serves an observed boundary: physical-copy activity, family-scoped selection and async user intent. That is reasonable complexity for an application whose central purpose is representing branching histories accurately. The new activity maps and a per-request boolean remain bounded local mechanisms. Additional generic timeline/provider/state infrastructure, a rendering replacement, or a broad refactor would increase scope without a demonstrated need.

I would merge the reviewed feature now and keep the P3 timestamp-key hardening, browser-backed interaction coverage, performance remeasurement and distribution checks as follow-ups. The visualizer is not an exact runtime-utilization instrument; its documented recorded-activity semantics and finite limitations are appropriate for this scope.

## Verification and PR state

- **Current automated execution:** all **193 tests in 20 files** passed on Node 26.3.0, Windows, along with `npm run typecheck`, `npm run build`, `npm run build:vscode` and `git diff --check main...HEAD`. Reviewed execution outside the sandbox was used where esbuild/test subprocesses required it.
- **Current targeted execution:** the P3 reproduction used newly created synthetic Claude/Codex/Copilot/Agentree homes, with only synthetic Copilot conversations populated. It exercised the actual registry, filtering and layout. The passing suite also executes the temporary-store Copilot fork reproduction from the previous report. No vendor runtime or live model generation was invoked.
- **Source/bundle inspection:** assessed the latest changes against the cumulative branch, current design/guide/instructions and archived findings. Checked provider/stitching/activity boundaries, selection and navigation state, worker/bridge integration, enabled-provider routing, caching and read-only guards.
- **GitHub read-only check:** [PR #2](https://github.com/Sadeeptha-B/Agentree/pull/2) is open, non-draft, and reports `mergeable: true`. Its head is exactly `b1683534bf25ca57de9a0f0597cf8400b0bd972b`, and its base is the reviewed `main` at `7d3a66c0ca5709aac3e0c1569736bd235c8c8b15`. The connector returned no submitted reviews, inline review threads or commit-status entries. Accordingly, the green checks claimed here are the executed local checks; no separate remote CI success is claimed. No review, comment or merge action was posted.
- **UI evidence:** the earlier desktop checks cover the unchanged component/CSS behavior: dark/light scrollbars, folder labels and directory filtering, wide CJK names, basic Settings focus and Day/Tree return behavior. No additional desktop session was executed for this logic-only commit.
- **Remaining verification limits:** the VS Code webview itself, native vendor fork/resume/deep-link workflows, macOS/Linux behavior, native-wheel cancellation in this pass, larger-day performance and relocated-store native canaries remain the explicit roadmap checks. Build success does not establish those workflows. They are release follow-ups within the already documented scope, not newly discovered source regressions.

No original harness transcripts or databases were modified. Runtime sources and tests are unchanged by this review. Only this report and its archive-index entry were added locally.
