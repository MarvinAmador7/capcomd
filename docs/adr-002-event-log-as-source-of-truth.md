# ADR-002: Event log as source of truth
> Reconstruction: **LOW confidence.** Only a summary of this document survived in my context; original prose, tables, citations and details are lost. This file contains only content I can recall; it must be re-researched/re-written before relying on it.

Status: Accepted.

## Decision (recalled)
Run state is derived from an append-only event log (later: per-RunActor SQLite in c.db, gap-free seq, see ADR-008/durability.md).

## Gaps
Context, alternatives and consequences sections are lost.
