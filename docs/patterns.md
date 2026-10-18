# Patterns
> Reconstruction: **LOW confidence.** Only a summary of this document survived in my context; original prose, tables, citations and details are lost. This file contains only content I can recall; it must be re-researched/re-written before relying on it.

Recalled patterns (derived from research.md):
- Hierarchical planner → sub-planners → workers (ADR-001).
- Event log as source of truth (ADR-002).
- Verification, not self-report (ADR-003).
- Worker isolation per repo copy; handoff at the end of each task.
- Leases with epochs; idempotency keys on every external effect (later formalised in ADR-008 and durability.md).
- Judge + green branch.

## Gaps
Full pattern catalogue, trade-offs and citations are lost.
