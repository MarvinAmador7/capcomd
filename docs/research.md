# Research: Cursor's agent-orchestration findings
> Reconstruction: **LOW confidence.** Only a summary of this document survived in my context; original prose, tables, citations and details are lost. This file contains only content I can recall; it must be re-researched/re-written before relying on it.

## Recalled findings (from Cursor's articles on long-running/parallel agent orchestration; original URLs not retained)
- Planners never write code; they decompose and assign.
- Workers are isolated, each in its own copy of the repo, and end with a **handoff**.
- No separate "integrator" role.
- A **judge** evaluates outcomes.
- A **green branch** is kept passing.
- **Durable execution** is required for long runs.
- Hotspots noted: disk and compile load when many workers share a host (referenced in boxd.md).

## Gaps
Source URLs, quotes, numbers and the doc-claim vs inference split are lost.
