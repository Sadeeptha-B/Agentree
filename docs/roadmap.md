# Remaining work

Current after the round 3 resolution on 2026-10-27. The [completed A/B/C roadmap](archive/2026-10-modernize/roadmap-completed.md) retains the original brief, acceptance criteria, deviations and owner decisions. The [design notes](design.md) explain the current architecture; [AGENTS.md](../AGENTS.md) supplies working boundaries and checks.

The [round 3 review](archive/2026-10-modernize/review-findings-round-3.md) is resolved: its [resolution](archive/2026-10-modernize/review-findings-round-3.md#resolution) maps each finding to its fix and regression test. What it left open is listed below.

## Verification and durability follow-ups

- Disposable-home native checks: resuming Claude forks after compaction or tool-ending turns; Claude `editor.open` outside the workspace; visible Codex deep-link routing. A dispatched URI or passing parser fixture does not establish a successful vendor workflow.
- Visual checks of the VS Code webview (theme, narrow widths and interaction) and native terminal checks on macOS/Linux remain unverified in the retained reviews. Preserve the existing Windows evidence separately.
- A repeatable harness-format canary remains proposed; any live model/API use is an owner decision. Keep sanitized fixtures and executed evidence next to the affected design rule. Normal tests should stay deterministic and local.
- Concurrent desktop/extension sidecar writes can lose updates, and a clear reaches only the sidecars of the members known when it is made (no tombstones). Membership-growth reconciliation fills only missing entries and never resolves conflicts; stronger guarantees need defined conflict/clear semantics first. Atomic replacement alone does not solve this.
- Visual check of the Session block's member selector on shared turns, in VS Code and the desktop app; it is covered by store tests, not yet by a rendered UI check.
- A Claude fork first written in a previously unwatched project directory can be missed by an already open family until another watched event or reopen. Inferred parent direction for restored/copied files with renamed titles remains ambiguous; retain its evidence label.
- Repeatable CI for tests, typecheck and both builds is a release follow-up. Confirm Marketplace publisher ownership (`sadeeptha-b`) before publishing.

## Deferred product work

- **B5 grouped list:** optional only if fork names/search/focus prove insufficient. Keep one card per family as the default; the [original brief](archive/2026-10-modernize/roadmap-completed.md#b5-optional-a-grouped-list-view) retains the proposed behavior.
- **VS Code Copilot Chat:** read-only provider; the [original format research](archive/2026-10-modernize/modernization-handoff.md#33-vs-code-copilot-chat-phase-4-read-only) is a starting point, not a current compatibility guarantee. Older Copilot CLI formats also remain unsupported.
- **Subagent lane** and **desktop installer packaging** remain scope candidates.
- **Claude file-history snapshots / rewind code** and **pre-compact fork support** remain separate research decisions. Snapshot omission and pre-compact refusal are deliberate current restrictions, not promised follow-up implementations.
- VS Code Settings UI/sync integration can be considered if needed; the shared on-disk settings panel is implemented.

The [user guide](user-guide.md#limitations) owns current user-facing limitations. Keep this file focused on remaining work; completed implementation detail belongs in design notes or a dated resolution, without growing a second historical brief here.
