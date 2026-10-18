# ADR-004: Single host first
> Reconstruction: **LOW confidence.** Only a summary of this document survived in my context; original prose, tables, citations and details are lost. This file contains only content I can recall; it must be re-researched/re-written before relying on it.

Status: Accepted (amended).

## Decision (recalled)
Start on a single host (phase A) before any distributed deployment; options A/B/C in architecture.md describe the progression.

## Amendment (2026-10-16, recalled)
Rivet Actors are used **from phase A**, still on a single host.

## Amendment (2026-10-17, ADR-009) — revised per current decision
Rivet Cloud is **deferred**. Phase A runs on the **local Rivet engine only**. Workers run on boxd VMs. Local durability and backups: durability.md.
