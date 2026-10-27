# Modernization history — October 2026

These records preserve the original brief, decisions, experiments, review findings and resolution writeups. Their implementation descriptions and source line numbers refer to the revisions they discuss. Older references to `AGENTS.md` as the engineering manual refer to material now consolidated in [design.md](../../design.md). The [working instructions](../../../AGENTS.md), [user guide](../../user-guide.md) and [current roadmap](../../roadmap.md) own current guidance.

**Round 3 is resolved:** all eight findings were fixed on 2026-10-27, with the [resolution](review-findings-round-3.md#resolution) recorded at the top of its report.

| Record | Scope and status |
|---|---|
| [Modernization brief](modernization-handoff.md) | Started from `58cf671`; retain its assumptions, vendor-format research (including prospective Copilot Chat), and implementation correction banner |
| [Review handoff](review-handoff.md) | Explains the first modernization implementation and desktop parity, owner decisions, evidence strength, probes and review questions |
| [First review](review-findings.md) | `58cf671..91185af`; resolution recorded at the top, with partial fixes revisited in round 2 |
| [Round 2 review](review-findings-round-2.md) | `58cf671..0bb38ae`; eight findings and their resolution, identity-model correction and roadmap cautions |
| [Completed roadmap](roadmap-completed.md) | Original A/B/C brief, departures and owner answers through `b400dbd`; A1–A4, B1–B4 and C1 implemented, B5 deferred. Later review findings still apply |
| [Round 3 review](review-findings-round-3.md) | Full `58cf671..b400dbd` diff; eight findings, reproductions, architecture assessment and verification limits; resolution recorded at the top |
| [Documentation proposal](documentation-plan.md) | Four-document consolidation and maintenance rationale; implemented as documentation, with archive grouping subsequently authorized by the owner |

Banners and repaired relative links distinguish historical context from current guidance; the underlying findings, evidence and original resolution claims are retained. To inspect the engineering notes exactly as they were before consolidation, use `git show b400dbd:AGENTS.md`.
