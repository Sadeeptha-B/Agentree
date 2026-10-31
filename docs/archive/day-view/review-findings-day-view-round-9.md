# Full branch review, round 9 — 2026-10-31

> **Historical review of `75b7eef..4d0943b`; resolved.** The original report follows the resolution below unchanged; its line references are to `4d0943b`. Current contracts are in the [design notes](../../design.md#one-turn-is-many-records).

<a id="resolution"></a>

> **Resolution (2026-11-01, `day-view-round-6` branch).** Both findings had
> merit and failed as reported before any fix. The first exposed a flaw in the
> round-8 design rather than a missed case: whether two blocks of a message
> belong together depends on branches that may be written later, and on nothing
> a copy of one branch can see. A better lookup couldn't fix that, and neither
> could appending to the earlier part, as the report warned. So grouping no
> longer decides it.
>
> | # | Fix | Check |
> |---|---|---|
> | [1](#dv9-1) | A group holds one block of text, with the tool calls and thinking around it, and the same-role merge folds a message's parts, under the rules it already has. A later part's key is `m:<id>#<digest>` of its own first block, since round 8's ordinal differed between a session and a copy of one branch; that form was never released. `groupOfKey` and `interrupted` are gone | `BK` in `c--work-inside` joins the fixture-wide invariants. Exact paths, tip, holders and copied identities through real forks of both branches; the same drawing whichever branch was written first |
> | [2](#dv9-2) | A later part carries the call's context as `lastUsage` and no `usage`, so cost and context stay apart | `test/endpoints.test.ts`: parser, `mergeSameRoleRuns`, `contextAt` and `inferWindow`: 200,000 + 20 billed, 100,010 context, a 200k window |
>
> **Found while fixing.** The first version made a block the CLI rewrote in
> place a second part with the same id. An existing test caught it. A survey
> of real messages ruled out the simplest rule, joining only the latest block:
> parallel tool calls hang 4 of 11,921 continuing records off an earlier one,
> and those would have lost their tool names.
>
> **Proportion.** Both changes are cheap: the runtime diff is +48/−43, and the
> first fix removes the logic round 8 added rather than extending it. All of it
> serves shapes nobody has observed: no real message has two text records. It
> is kept because the alternative was a third round of patches on a rule that
> couldn't be right, and because the cost is about 50 ms of a cold list (median
> of seven alternating runs, 2,022 → 2,076 ms). A message's parts are now joined
> by a blank line, like any run, where they used to run together.
>
> **Limits.** Where a message's first text blocks stand on two branches below
> a block with no text, a copy of the later one keys it `m:<id>` and won't match.
> Two text blocks of one message with identical content share a key, under
> different parents. Neither shape has been seen.
>
> Verification: 275 tests, typecheck and both builds pass on Windows, Node
> 26.12.1. Before and after on a copy of the target machine's store, 73
> families: no field of any of 1,001 nodes changed, tools, usage, keys and
> endpoints included, all 120 days of day projections are identical, and the
> fork invariant holds on all 895 fork points. No visual check: worker-side
> changes only.

## Original report

Reviewed `75b7eef..4d0943b` (`main...day-view-round-6`): six commits, 28 changed files, +1,807/−131 lines. This includes the full branch after the CI rebase and the round-8 resolution, not just its latest commit. The working tree was clean. References below are to `4d0943b`.

**Assessment:** one P2 remains in message grouping, and one P3 was introduced by suppressing usage on later parts. Resolve the P2 before merging. The original round-8 cases pass; its annotation and companion-note fixes are appropriately small and preserve the existing boundaries.

Both findings were executed on synthetic records. Neither is a claim that this exact interleaving has been observed in a vendor-written store. The conditional, unobserved nature of messages divided by drawn records remains as documented in the round-8 resolution.

<a id="dv9-1"></a>

## 1. [P2] A continuation from an earlier branch is appended to the latest message part

Reference: [transcripts.ts:988](../../../electron/transcripts.ts#L988), especially [the current-group lookup](../../../electron/transcripts.ts#L1003).

`groupOfKey` keeps only the most recently created part of an API message. `interrupted` searches for an ancestor belonging to that particular group. Once a message has split, a subsequent record can descend from an earlier part instead. The walk then finds no member of the latest group, returns `false`, and appends the record to that unrelated latest part. Using the chain for the boolean check does not make the chosen group belong to that chain.

Executed input, in file order, with distinct record uuids and one assistant API message id `M`:

```text
u1: user "Start"
a1: assistant M, "First.", parent=u1
q1: user "Interrupt", parent=a1
a2: assistant M, "After interruption.", parent=q1
a3: assistant M, "Sibling continuation.", parent=a1
```

The raw transcript is a DAG with two continuations of `a1`; `a3` does not descend from `q1` or `a2`. The actual family loader draws:

```text
Start → First. → Interrupt → After interruption.Sibling continuation.
```

The last node has head `a2`, key `m:M#1`, and `lastRawId=a3`. Its enabled fork succeeds, but the actual fork file, parsed and display-merged on its own, draws:

```text
Start → First.Sibling continuation.
```

The fork loses the drawn interjection and the drawn `After interruption.` text. Its raw anchor belongs to the other branch, so the selected range and copied range disagree. This is a remaining form of the round-8 grouping problem; the new tests for an unrelated branch do not first create a split, so they do not exercise the overwritten `groupOfKey` entry.

Group selection and its fork endpoint need to agree with the ancestor path, including a return to an earlier branch. Merely appending to the earlier group is not sufficient if that would make another node's prefix include text from a sibling path: the full grouping must still satisfy the drawn-path/fork invariant. Add this DAG to the fixture-wide fork checks, asserting exact paths, tips and holders as well as copy identities. A range whose anchor cannot represent all its drawn contents must not remain an enabled cut.

<a id="dv9-2"></a>

## 2. [P3] Suppressing repeated cost also removes the final context snapshot

Reference: [transcripts.ts:1145](../../../electron/transcripts.ts#L1145), consumed by [the same-role merge](../../../electron/transcripts.ts#L404) and [contextAt](../../../shared/render.ts#L264).

A later part receives neither `usage` nor `lastUsage`. Omitting chargeable usage correctly avoids counting one API message twice, but the part still needs the message's context snapshot. When another assistant message divides the original message, all three drawn parts can fold into a same-role run:

```text
assistant M, "First."
  → assistant B, "Aside."
  → assistant M, "Last."
```

This is the other-assistant interruption shape the new endpoint tests explicitly cover. With both messages reporting 100,000 input tokens and 10 output tokens, executed through the parser, display merge and shared renderer helpers:

| Projection | Summed usage | Final context | Inferred context window |
|---|---|---|---|
| `main` and `93142ee` | 200,000 input + 20 output | 100,010 | 200,000 |
| Current branch | 200,000 input + 20 output | **200,020** | **1,000,000** |

The final part has no usage-bearing snapshot, so the merge produces no `lastUsage`. `contextAt` and `inferWindow` fall back to the run's summed cost, which is not a context size. The panel therefore shows the wrong context and denominator. The current ordering is an improvement over the earlier projection; the table compares the usage behavior only, and does not endorse the earlier ordering.

Keep cost accounting separate from context-at-end accounting. The existing `lastUsage` field can retain the snapshot on a later part while its chargeable `usage` stays absent. Add a regression through `mergeSameRoleRuns`, `contextAt` and `inferWindow`; checking only that usage is counted once misses the affected consumers. This is a display issue, not a fork or transcript-write error.

## Previous fixes and full-branch assessment

The new fixture and passing regressions cover a linear API message divided by a block prompt, cuts on both sides, the quiet fork's endpoint, holders/action targets, stable part keys, and a weak prompt's earlier key below the divided reply. Those resolve the original round-8 input. The remaining P2 adds a branch after a split; it is not a rerun of the same linear case.

Matched copies now union their `legacyIds` into stitching's copied node using a new array. That preserves the cached parse and leaves ambiguity to the existing family-wide ownership rule. Its regression reads and clears the saved label, status and note through the family. Companion notes carried by a visible prompt are now in the own-record exclusion; the actual disposable fork/day-projection regression reports no spurious run or turn. Notes elsewhere remain activity.

Across the cumulative diff, activity records remain worker-local, with provider keys based on preserved time/kind/content rather than rewritten raw ids. Claude's content digest distinguishes equal-length results; Copilot excludes the top-level session id its copy writer changes. The block-prompt projection uses the existing content reader and warns when a human attachment yields no drawn turn. The ownership-based compatibility lookup remains intact. I found no additional concrete finding in those changes.

The newly documented `m:<id>#<n>` form is treated as an opaque key by consumers. It introduces no renderer parsing or bridge change. The important identity check for the remaining grouping work is still that a copied path keeps the identities of the parts it contains; adding DAG coverage should verify this alongside ancestry and fork contents. Existing documented limits around earlier hollow queue reconstructions, notes no longer drawn, and a weak text interjection below an initially textless message part remain separate from the findings above.

## Architecture, data model and components

The architecture remains suitable for the product. Providers, parsing, stitching and day projection stay in the backend worker. Hosts continue to forward typed calls and own watches/native hand-offs; the renderer has no Node access. Inspection of both freshly built host bundles found no implementations of `parseRecords`, `stitchFamily`, `loadCodexSession`, `findWant` or `dayActivity`. The changes introduce no new dependency, persistence file, service, privilege or vendor execution path.

The model still distinguishes semantic identity, physical occurrence, membership, display grouping, endpoint and activity. The remaining P2 is a failure to preserve a raw path while forming a display group. The P3 shows why summed usage and a final context snapshot must remain distinct even when several drawn parts come from one API call. Both belong at the existing parser/grouping boundary and can be addressed without a new general-purpose abstraction.

No renderer component, layout algorithm or async selection implementation changes in this branch diff. I traced the changed outputs through member tips and action targets, endpoint/identity selection recovery, `NodePanel` fork requests and context display, tree layout, and the day projection/layout. Their existing tests pass. The P3 reaches a real component through its shared helper; the component does not need to reinterpret message-part keys or reconstruct usage itself.

The implementation size remains proportionate to the problems: keyed activity, reading a supported content shape, suppressing harness notes while retaining their cuts, and compatibility across changed drawings. The tests now cover the original cross-feature failures well. The outstanding coverage gap is a split followed by a branch continuation, plus usage consumers after regrouping. I found no reason for a component rewrite, a new state framework, or changes to the owner-confirmed Codex read/fork split or Claude fork format.

## Verification

Executed on Windows, Node **26.12.1**:

| Check | Result |
|---|---|
| `npm test` | **269 passed, 3 skipped**, 23 files passed; includes committed-fixture equality and fixture-wide fork invariants |
| `npm run typecheck` | Passed, renderer/Node/VS Code extension |
| `npm run build` | Passed |
| `npm run build:vscode` | Passed |
| `node scripts/check-links.mjs` | Passed |
| `node scripts/check-version.mjs` | Passed: 0.2.0 everywhere |
| `git diff --check main...HEAD` | Passed |
| Additional grouping reproduction | Actual disposable Claude store, family loader, fork writer, copied-file parser and display merge reproduce finding 1 |
| Additional usage reproduction | Parser, display merge, `contextAt` and `inferWindow` reproduce finding 2; actual `main` and `93142ee` parsers used for the comparison |
| Source/bundle inspection | Cumulative runtime/test/docs diff, model and downstream component consumers; both production host bundles |

Subprocess-dependent checks ran with reviewed subprocess access. No real harness store was read or modified; all added execution used disposable homes set before provider imports, and no live model generation was invoked. Temporary source copies and populated reproduction homes were removed.

No visual desktop or VS Code webview check, native vendor resume, remote CI run, platform/Node matrix, extension packaging or fresh real-store audit was executed in this review. The earlier source/verified/unverified labels in the provider research and the owner's recorded audit remain distinct from these local results. Runtime code and tests are unchanged by this review; only this report and its archive-index entry were added.
