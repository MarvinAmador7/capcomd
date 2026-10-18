# relay architecture
> Reconstruction: **LOW-MEDIUM confidence.** The original Mermaid diagram and the options A/B/C prose are not retained verbatim. The diagram below is re-derived from the recalled topology (actors-v1.md) and the appended decision lines, which are recalled accurately. Deployment line updated for ADR-009 = Deferred.

```mermaid
flowchart LR
  CLI[relay CLI (Bun, rivetkit/client)] --> RA[RunActor]
  RA --> PA[PlannerActor: root planner]
  PA --> SP[Sub-planners]
  RA --> TB[TaskBoardActor: tasks + leases/epochs]
  TB --> WA[WorkerActor x N]
  WA -->|SandboxProvider| VM[(boxd microVM per worker)]
  VM -->|handoff: branch task/id/e-epoch| VA[VerifierActor]
  VA -->|CAS merge| GB[(green branch)]
  RA --> JA[JudgeActor]
  RA --> EL[(event log: RunActor SQLite c.db)]
```

## Options A/B/C (recalled outline only)
- A: single host (ADR-004), now with Rivet Actors from day one on the local engine.
- B/C: progressively distributed deployments (details lost).

## Runtime (ADR-006)
TypeScript on Bun.

## Actor mapping
See actors-v1.md: RunActor, PlannerActor, TaskBoardActor, WorkerActor, VerifierActor, JudgeActor.

Lifecycles (task, lease, worker, run) follow explicit state machines: ADR-008 (XState v5 pure transitions, Rivet-persisted). The sandbox backend is boxd microVMs first: boxd.md, ADR-005 amendment.

**Deployment (ADR-009, Deferred):** actors run on the **local Rivet engine** for now (dev, CI and real runs); Rivet Cloud is deferred for later evaluation. The CLI is a thin client; workers run on boxd. Failure handling, crash tests and backups: durability.md.
