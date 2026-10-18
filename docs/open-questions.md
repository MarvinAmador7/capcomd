# Open questions
> Reconstruction: **LOW confidence.** Only a summary of this document survived in my context; original prose, tables, citations and details are lost. This file contains only content I can recall; it must be re-researched/re-written before relying on it. Items below are collected from surviving docs.

1. Regions/latency for boxd and Rivet (Costa Rica); actor ↔ VM RTT.
2. boxd idempotent create semantics on name collision (only confirmed for fork).
3. Local Rivet engine storage backend and data-dir location (for backups).
4. Fix for `bun build --compile` with rivetkit's native module.
5. Rivet Cloud evaluation (ADR-009, Deferred): backup/PITR on Hobby/Team, limits, region list.
6. Cost per run (boxd VMs dominate; ~€0.1/h per default VM).
7. boxd org cap of 50 machines vs fan-out.
8. ~~Does c.db support atomic multi-statement transactions?~~ Answered yes (rivet-sqlite.md).
