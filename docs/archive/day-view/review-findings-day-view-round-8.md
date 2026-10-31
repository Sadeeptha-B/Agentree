# Full branch review, round 8 — 2026-10-31

> **Historical review of `75b7eef..93142ee`; resolved.** The original report follows the resolution below unchanged; its line references are to `93142ee`. Current contracts are in the [design notes](../../design.md#one-turn-is-many-records).

<a id="resolution"></a>

> **Resolution (2026-10-31, `day-view-round-6` branch).** All three findings
> had merit and failed as reported before any fix. The first was broader than
> block prompts: grouping by `message.id` assumed a message is contiguous, so a
> text prompt inside one failed the same way on `main`.
>
> | # | Fix | Check |
> |---|---|---|
> | [1](#dv8-1) | A message's records stop being one group where the chain holds something drawn between them, so it is one node per drawn part, each with its own sound cut. The test is the chain, not file order, and it asks what the display filter would keep rather than listing record kinds. The first drawn part keeps `m:<id>` and the usage; a later one is `m:<id>#<n>`, a form no scheme saved. The earlier drawing's keys treat the message as the one node it was | `c--work-inside`, with a fork ending before the message, joins every fixture-wide invariant. Exact ancestry, tip, holders, action targets, keys, usage counted once, and five cases around the rule in `test/endpoints.test.ts`, two of which it must not split. A weak prompt below a divided reply keeps its key |
> | [2](#dv8-2) | A matched copy's `legacyIds` join the kept node, which is stitching's own copy, so no cached parse changes. The family-wide ownership rule applies unchanged | `test/claude.test.ts`: the saved key computed as the earlier parser did, then read and cleared through the family, with the parent's parse unaffected |
> | [3](#dv8-3) | A note a turn's cut carries is that turn's own record. Notes elsewhere still count as activity | `test/day-find.test.ts`: a real fork of a prompt and its note reports no run and no turn |
>
> **Proportion.** The second is one line and the third a few. The first is about
> forty lines and a new key form for a shape nobody has observed. That is
> justified by what it protects: an enabled fork holding a turn its path doesn't
> show breaks the invariant this repository checks over every fixture, and the
> alternative, refusing such forks, would have left the tree and the session's
> tip wrong. Nothing beyond the three was added: no new abstraction, and no
> change to the renderer or the fork writer. The check runs only for a block
> continuing a message, and walks only what stands between it and the block
> before it.
>
> **Limits.** A label saved on a message now divided stays on its first part,
> where its key is. A text mid-turn message under a block with no drawn text,
> weakly keyed by that message, gets a new key with no alias: that needs a shape
> unobserved in either half. The round-7 limits stand.
>
> Verification: 269 tests, typecheck and both builds pass on Windows, Node
> 26.12.1. Before and after on a copy of the target machine's store, 73
> families: all 120 days of day projections identical, no node, key, endpoint or
> ancestry changed, no key added, and the fork invariant holds on all 890 fork
> points. Median cold list 2,167 → 2,229 ms over seven alternating runs, within
> their 400 ms spread. No visual check: worker-side changes only.

## Original report

Reviewed `75b7eef..93142ee` (`main...day-view-round-6`): all four commits after the CI work merged, 24 changed files, +1,353/−118 lines. The repository's base is `main`; no local `master` exists. The working tree was clean before review. References below are to `93142ee`.

**Assessment:** two P2 correctness findings and one P3 activity finding remain. Address the ancestry/fork invariant and annotation compatibility findings before merging. The architecture remains appropriate; these are integration gaps between the new projection and existing grouping, stitching and activity rules, not reasons for a broader redesign.

All three findings were executed with synthetic inputs in disposable homes. They are not claims about observing these exact combinations in a real vendor store. The existing suite passes; it does not cover these combinations.

<a id="dv8-1"></a>

## 1. [P2] A block-prompt message inside one API message is drawn after the reply it interrupts

References: [attachment projection](../../../electron/transcripts.ts#L949), [grouping by API message id](../../../electron/transcripts.ts#L987), [draft construction](../../../electron/transcripts.ts#L1013).

The branch now draws block-prompt attachments, but the earlier per-message grouping still collects every record with the same `message.id` regardless of an intervening drawn message. The later blocks become part of a node above the interjection. The following is a single, valid raw parent chain; the two assistant records share one API message id:

```text
user "Build it"
  → assistant a1, message.id=M, "Starting."
  → queued_command attachment, block prompt "Also test it"
  → assistant a2, message.id=M, "Done."
```

Executed with the actual parser, family loader and fork writer:

- The tree draws `Build it → Starting.Done. → Also test it`.
- The member's tip is the interjection, although a later reply block follows it in the transcript.
- The assistant node is forkable, with `lastRawId=a2`. Its selected path contains only `Build it` and `Starting.Done.`.
- Forking it succeeds, but the fork draws an additional `Also test it` node, because the copied raw chain includes the attachment. The fork therefore contains a drawn turn absent from its selected path.

Before the branch, the block attachment was not drawn at all. Adding its display exposes the existing grouping assumption. The design notes already acknowledge this unobserved same-message/interjection shape under [notes](../../design.md#claude-codes-own-notes-arent-turns); it remains an executable failure in the newly supported projection, rather than being covered by the fix for hidden notes.

Grouping must preserve the position of intervening drawn messages and a sound cut. Add this case to the fork invariant, including the member tip and ancestry. Any split needs compatible semantic identities; collecting all blocks into the first node cannot retain the current fork guarantee.

<a id="dv8-2"></a>

## 2. [P2] Stitching drops legacy annotation keys carried only by a matched member

References: [new per-parse aliases](../../../electron/transcripts.ts#L1176), [matched-copy handling](../../../electron/providers/stitch.ts#L162).

The compatibility pass correctly retains the earlier drawing's keys on each parsed node. However, when a member matches a canonical node, stitching keeps its occurrence and activity only; it does not carry its `legacyIds` into the family. Hiding notes can make two member projections match even though their earlier drawings used different weak parents, so the canonical node's aliases need not cover the other copy's.

Executed through the actual family loader, using the **actual `main` parser** to compute the saved key:

```text
parent P: user "Begin" → assistant M, "Ready." → user "Next" (no promptId)
fork F:   copied user → copied assistant M → isMeta "Continue from where you left off."
                                              → user "Next" (no promptId)
```

F has explicit lineage to P. Its original annotation is saved in F's sidecar under the old `Next` key, qualified by the note's identity. After the upgrade, both `Next` nodes have the same visible parent and match under the text-only rule:

- Parsing F alone retains the saved key in `Next.legacyIds`.
- Loading the two-member family drops that key from the canonical node.
- The saved label, favorite status and note do not appear. The original entry remains on disk, but `applyAnnotations` cannot find it or migrate it.

The no-`promptId` format is supported; the round-7 compatibility requirement applies across the family, not just to isolated parsing. Union the matched copies' compatibility claims into the canonical node, without mutating cached parse arrays, and keep the existing family-wide ownership check for ambiguous claims. Verify both reading and clearing a key carried only by a matched member.

<a id="dv8-3"></a>

## 3. [P3] A copied hidden companion note is counted as fresh fork activity

References: [extending a prompt's anchor through a note](../../../electron/transcripts.ts#L1060), [own-record exclusion](../../../electron/transcripts.ts#L1153), [copy activity comparison](../../../electron/providers/stitch.ts#L168).

A hidden note directly after a user prompt becomes that prompt's `lastRawId` and contributes its end time. It is nevertheless absent from the `own` record set: that set is built from groups whose heads survive the display filter, and the note's group does not survive. `markActivity` consequently treats the note as activity under the prompt.

Executed with `user prompt → isMeta image-source note → assistant reply`, then `forkClaudeAt` on the prompt:

- The writer copies through the note and re-stamps that last copied record to now, as designed.
- The note's activity key therefore differs from its source's key.
- Stitching assigns the untouched fork occurrence `activeFrom=activeUntil=now`.
- The actual `dayActivity` projection returns **one own-work run and zero turns** for the new fork in the current window, although it has never been resumed.

This is the copied-record activity regression the own-record exclusion is meant to prevent. It can shorten an idle interval when another conversation has a subsequent turn. It does not change ancestry or fork contents. Treat notes incorporated into a drawn prompt's endpoint as that prompt's own records for this exclusion; notes occurring elsewhere should still count as activity. Add a quiet prompt-plus-note fork to the copy-activity regression tests.

## Architecture, data model and components

The change remains within the worker. No provider or store import was introduced into either host, no new bridge privilege was added, and the activity-record keys stay local to the worker. The built Electron main and VS Code extension host bundles contain no implementations of `parseRecords`, `stitchFamily`, `loadCodexSession`, `findWant` or `dayActivity`. Store resolution, enabled-provider routing and the two-host typed bridge remain intact.

Replacing bare activity times with `{at, key}` is a proportionate fix for the sixth review: different payloads at the same instant can now be distinguished, while the copier's rewritten ids are excluded. Claude result-content digests resolve the seventh review's equal-length collision, and Copilot leaves out exactly the top-level session id its writer changes. I found no additional concrete issue in those changed key functions.

The data model still separates semantic keys, physical occurrences, holders, display groups, fork points and activity. The findings identify where implementation does not yet carry those distinctions all the way through: a semantic API message can span a new display boundary; annotation compatibility claims belong to every matched copy; and a hidden record incorporated into an endpoint is not additional execution activity.

No renderer component or layout implementation changes in this diff. I traced the affected outputs through member tips/action targets, `NodePanel` fork requests, tree/day selection references, `dayPart` and the day layout's busy-time calculation. The existing renderer state and layout tests pass. There is no evidence here requiring a component rewrite or a new state abstraction. The remaining problems should be fixed and tested at the projection/stitching boundaries.

The new fixtures check ordinary block prompts, notes, endpoints, actions and annotations well. The missing coverage is the combination of those features: an interjection inside one API message, compatibility aliases from a matched noncanonical member, and an untouched fork ending on a hidden companion. Counts and unique ids alone would not detect any of them.

## Existing limits kept separate

The round-7 resolution explicitly defers compatibility through an earlier hollow queue reconstruction and separator variants in split text blocks. Those limits remain documented; the new family-alias finding is a different failure after an isolated parse has already retained the right key. Labels on notes that are no longer drawn also remain an explicitly documented behavior.

Native Claude resume at tool-ending or compacted cuts, VS Code webview interaction, and the Copilot provider's broader upstream drift remain the recorded verification/deferred-work items. This review neither establishes native success nor reopens the owner-confirmed raw-Codex-reading/app-server-forking and Claude fork-format decisions. The CI/release implementation is already in the base; the branch changes its upstream baseline only by adding `isMeta` to Claude's source-field canary.

## Verification

Executed on Windows, Node **26.12.1**:

| Check | Result |
|---|---|
| `npm test` | 23 files passed; **261 passed, 3 skipped**. Includes fixture regeneration/equality and existing fork invariants |
| `npm run typecheck` | Passed, including the VS Code extension |
| `npm run build` | Passed |
| `npm run build:vscode` | Passed |
| `node scripts/check-links.mjs` | Passed |
| `node scripts/check-version.mjs` | Passed: 0.2.0 everywhere |
| `git diff --check main...HEAD` | Passed |
| Additional disposable-home reproductions | All three findings above executed; the annotation case uses `main`'s parser as the old-key oracle |
| Source/bundle inspection | Worker/host separation and downstream projection/selection/component consumers inspected |

Vitest/esbuild and the link check initially met sandbox subprocess restrictions; they were rerun with reviewed subprocess access and passed. No check remains blocked by that restriction.

No real harness store was read or modified, and no live model generation, native vendor resume, desktop visual check, VS Code webview check, remote CI run or extension packaging was performed. The automated results above are local Windows results, not a claim about the CI platform/Node matrix. Temporary scripts, source copies and populated disposable homes used by the completed reproductions were removed. Runtime sources and tests are unchanged by this review; only this report and the archive index were added.
