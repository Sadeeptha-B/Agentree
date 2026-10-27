# Remaining work

Current after the `b400dbd` implementation and documentation consolidation on 2026-10-27. The [completed A/B/C roadmap](archive/2026-10-modernize/roadmap-completed.md) retains the original brief, acceptance criteria, deviations and owner decisions. The [design notes](design.md) explain the current architecture; [AGENTS.md](../AGENTS.md) supplies working boundaries and checks.

## Address the open round 3 review

All eight findings remain **open**. Documentation changes do not resolve application findings. The [report](archive/2026-10-modernize/review-findings-round-3.md) owns the detailed evidence, fix directions and acceptance conditions.

| Finding | Priority | Remaining change |
|---|---|---|
| [1](archive/2026-10-modernize/review-findings-round-3.md#r3-1) | P1 | Preserve semantically meaningful prompt whitespace in matching and persisted identities |
| [2](archive/2026-10-modernize/review-findings-round-3.md#r3-2) | P1 | Preserve exact member endpoints through display merging, including quiet forks |
| [3](archive/2026-10-modernize/review-findings-round-3.md#r3-3) | P2 | Preserve focused-member intent for Open/Resume on shared history |
| [4](archive/2026-10-modernize/review-findings-round-3.md#r3-4) | P2 | Keep stable-key annotations accessible when membership grows and the root is removed |
| [5](archive/2026-10-modernize/review-findings-round-3.md#r3-5) | P2 | Reduce metadata across source copies separately from conversation UUID deduplication |
| [6](archive/2026-10-modernize/review-findings-round-3.md#r3-6) | P2 | Honor disabled providers during session watch discovery |
| [7](archive/2026-10-modernize/review-findings-round-3.md#r3-7) | P2 | Bound text-keyed identity size while retaining saved-data compatibility |
| [8](archive/2026-10-modernize/review-findings-round-3.md#r3-8) | P3 | Cancel/recheck pending view persistence when remembering is disabled |

Fix the history-correctness defects first. Treat identity encoding/normalization changes as persistence changes, and address endpoint and member-action semantics together. Reproduce each case before fixing it; retain regression coverage and record a resolution linked from the report.

## Verification and durability follow-ups

- Disposable-home native checks: resuming Claude forks after compaction or tool-ending turns; Claude `editor.open` outside the workspace; visible Codex deep-link routing. A dispatched URI or passing parser fixture does not establish a successful vendor workflow.
- Visual checks of the VS Code webview (theme, narrow widths and interaction) and native terminal checks on macOS/Linux remain unverified in the retained reviews. Preserve the existing Windows evidence separately.
- A repeatable harness-format canary remains proposed; any live model/API use is an owner decision. Keep sanitized fixtures and executed evidence next to the affected design rule. Normal tests should stay deterministic and local.
- Concurrent desktop/extension sidecar writes can lose updates. Define conflict/clear semantics before implementing stronger reconciliation. Atomic replacement alone does not solve this.
- A Claude fork first written in a previously unwatched project directory can be missed by an already open family until another watched event or reopen. Inferred parent direction for restored/copied files with renamed titles remains ambiguous; retain its evidence label.
- Repeatable CI for tests, typecheck and both builds is a release follow-up. Confirm Marketplace publisher ownership (`sadeeptha-b`) before publishing.

## Deferred product work

- **B5 grouped list:** optional only if fork names/search/focus prove insufficient. Keep one card per family as the default; the [original brief](archive/2026-10-modernize/roadmap-completed.md#b5-optional-a-grouped-list-view) retains the proposed behavior.
- **VS Code Copilot Chat:** read-only provider; the [original format research](archive/2026-10-modernize/modernization-handoff.md#33-vs-code-copilot-chat-phase-4-read-only) is a starting point, not a current compatibility guarantee. Older Copilot CLI formats also remain unsupported.
- **Subagent lane** and **desktop installer packaging** remain scope candidates.
- **Claude file-history snapshots / rewind code** and **pre-compact fork support** remain separate research decisions. Snapshot omission and pre-compact refusal are deliberate current restrictions, not promised follow-up implementations.
- VS Code Settings UI/sync integration can be considered if needed; the shared on-disk settings panel is implemented.

The [user guide](user-guide.md#limitations-and-open-review) owns current user-facing limitations. Keep this file focused on remaining work; completed implementation detail belongs in design notes or a dated resolution, without growing a second historical brief here.
