# Day view history — October 2026

These records keep the handover and the reviews of the day view (`day-view` branch) and the run-desktop skill that drives it, with the original findings and how each was resolved. Their line references are to the revisions they discuss. The [design notes](../../design.md#day-view) and the [user guide](../../user-guide.md#the-day-view) describe the current behavior; the [roadmap](../../roadmap.md) lists what remains.

| Record | Scope and status |
|---|---|
| [Handover](handoff.md) | State at `1b029d1`: how the day view works, the contracts it keeps, what is and isn't verified, limits and candidate next steps. Start here when continuing this track |
| [First review](review-findings-day-view.md) | `7d3a66c..45e2f26`: the day view and the run-desktop skill. Seven findings (fork and hand-off refusal on real stores, cache revisions, the drawn endpoint into a tree, idle breaks, a short narrow pane, Enter after picking a chat, the viewport after Esc), resolved 2026-10-28 |
| [Second review](review-findings-day-view-round-2.md) | `45e2f26..2f2c44b`: five findings (the selection across a day refresh, wheel zoom scrolling the pane, keys behind Settings, a chat's latest turn by its end, turns running over midnight) and a stale archive link, resolved 2026-10-28 |
| [Third review](review-findings-day-view-round-3.md) | Full `7d3a66c..1b029d1` branch diff: three P2 findings (cross-family selection recovery, a selected endpoint moving outside the day, execution activity missing from idle intervals) and two acknowledged gaps (a card's ◷ onto an empty day, wide-script names), resolved 2026-10-28 by resolving selections in the worker and a provider `activeUntil`. Also lane folders, no paths in the chat list, and themed scrollbars |
| [Fourth review](review-findings-day-view-round-4.md) | Full `7d3a66c..a2dc5d4` branch diff: three P2 findings (newer navigation overwritten by an old response, endpoint loss for a turn picked during refresh, and activity discarded on shared copies), resolved 2026-10-28 by adopting a day answer only for the intent it was asked about and keeping each copy's activity on its occurrence |
