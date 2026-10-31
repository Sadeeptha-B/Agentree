# Mid-turn messages and notes, review — 2026-10-31

> **Historical review; resolved.** The findings were made against `ad9d682`, before `2d19f9a`; the report follows the resolution below with its wording unchanged and its line references to that revision. Current contracts are in the [design notes](../../design.md#claude-codes-own-notes-arent-turns).

<a id="resolution"></a>

> **Resolution (2026-10-31, `day-view-round-6` branch).** All three findings
> had merit and reproduced on `2d19f9a`, and the second was wider than
> reported. It had been accepted in the design notes because the audited store
> didn't show it. That was the wrong test: a key saved on a supported format
> has to stay findable whether or not one machine holds such a transcript.
>
> | # | Fix | Check |
> |---|---|---|
> | [1](#dv7-1) | `spliceInterjections` also compares the queue entry with the prompt as delivered, through `textOf`, not only block by block. Two lines | `test/claude.test.ts`: parse, fork and family reload stay one line of four nodes with no fork edge |
> | [2](#dv7-2) | A weak key is qualified by the drawn parent, so what is drawn is part of it. `2d19f9a` moved keys the same way by hiding notes, and there the keys are shipped ones, since notes exist in transcripts with no prompt id. Where a file holds a block-prompt message or a note, `parseRecords` rebuilds that earlier drawing's identities with the same `assignStableIds` and keeps them as `legacyIds`, so the existing ownership rule applies. No new scheme. The compatibility test now keeps the skipped records' lineage | `test/annotations.test.ts`: a label, status and note saved under the earlier key show, under a message and under a note; a clear reaches the old key; a key two turns answer to goes to neither; a turn nothing changed for gains no key |
> | [3](#dv7-3) | `blockKey` digests a block's content instead of measuring it, as Copilot's key already did. Simpler than before: it replaces a branch per content shape | `test/endpoints.test.ts`: "3 passed" and "1 failed" differ; a copy under a fresh uuid doesn't |
>
> **Proportion.** Finding 1's shape was not seen on the target machine (a block
> prompt's enqueue holds no text), and finding 3 needs two runs of one call
> ending in the same millisecond with results of equal length. Both were kept
> because the fixes are this small: the first is two lines, and the second
> removes code and adds about 1% to a cold list (median of five, 2,053 → 2,080 ms;
> a full family load unchanged). Finding 2 is the one that adds code, about
> twenty lines, because losing a user's annotation is the failure this
> repository's identity rules exist to prevent. On the target machine it adds
> no key to any node.
>
> **Not done, deliberately.** A label saved on a note that stood alone stays
> in the sidecar and doesn't show: there is no turn to show it on. A turn
> below a message the queue reconstructed (hollow) and an attachment now draws
> keeps no alias through the hollow node; that needs a block prompt with queue
> text and a prompt without an id below it, neither seen. A prompt split into
> text blocks is compared joined with nothing between them, not also with
> separators.
>
> Verification: 261 tests, typecheck and both builds pass on Windows, Node
> 26.12.1. Before and after on a copy of the target machine's store, 72
> families: all 120 days of day projections identical, no node, key, endpoint
> or ancestry changed, and the fork invariant holds on all 886 fork points. No
> visual check: worker-side changes only.

## Original report

<a id="dv7-1"></a>

### [P2] Multiple text blocks can duplicate a message and create a false fork branch

Reference: `electron/transcripts.ts`, line 487.

Queue deduplication compares the enqueue text against each content block separately. If the queue contains "also back up" and the attachment contains text blocks "also " and "back up", neither block matches. The parser draws both the reconstructed message and the attachment.

Executed against both revisions: main draws the instruction once; this branch draws "also back up\n\nalso back up". Forking after the subsequent reply succeeds, but reloading then produces six nodes instead of four, including a duplicate reply and a false fork edge.

Index the complete delivered text alongside individual blocks, and add a regression exercising parse → fork → family reload.

<a id="dv7-2"></a>

### [P2] Newly drawn messages can orphan existing annotations on weakly identified descendants

Reference: `electron/transcripts.ts`, line 933.

When an attachment becomes visible, a following prompt without promptId can acquire a different parent. Its parent-qualified w: identity changes, but the previous identity is absent from legacyIds.

I reproduced this against the actual main parser, then saved a label under its key and loaded the current projection: the label disappeared. Notes and statuses use the same lookup.

The new design notes acknowledge this conditional case, but absence from the audited machine does not preserve compatibility for the supported no-promptId format. Retain the previous projection's keys as owned compatibility aliases.

The compatibility test at `test/claude.test.ts`, line 395, also removes attachments entirely, removing their lineage. That does not accurately simulate the previous parser, which retained their ancestry while skipping their display.

<a id="dv7-3"></a>

### [P3] Claude activity keys still conflate different results with equal lengths

Reference: `electron/transcripts.ts`, line 705.

Result content contributes its length rather than a content digest. A parent and fork answering the same copied tool-call ID at the same timestamp, with the same outcome flag, still collide when their results have equal lengths.

Executed example: "3 passed" and "1 failed" produced identical activity keys. Stitching consequently omitted the fork's activity bounds. The day view can still overstate idle time.

Hash the preserved result content into the bounded key. This is a narrower residual of the round-6 finding; it does not affect transcript ancestry or fork cuts.
