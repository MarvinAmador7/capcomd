# Actors v1: Rivet Actors from day one
> Reconstruction: **LOW-MEDIUM confidence.** Section structure and amendments are recalled; the original TypeScript sketch and pain-points table are lost (a minimal sketch is re-derived, marked as such).

## 1. Topology (recalled)
- **RunActor**: one per run; owns the event log (c.db), budget, run lifecycle, orphan-VM reaper schedule.
- **PlannerActor**: root planner + sub-planners; never writes code.
- **TaskBoardActor**: tasks, leases with epochs, lease expiry via `c.schedule`.
- **WorkerActor**: one per worker; owns its boxd VM via SandboxProvider.
- **VerifierActor**: verifies handoffs, merges to the green branch (CAS).
- **JudgeActor**: judges run outcome.

## 2. Crash/resume and idempotency (recalled)
Rivet facts relied on [Doc, verified earlier]: durable `c.state` with a 1 s save throttle; `c.db` SQLite; `c.schedule.after/at` (failed one-shot schedules are not retried); `actionTimeout` default 60 s; `onWake`, `keepAwake`, `waitUntil`; queue messages are not redelivered if processing fails; workflows via `@rivet-dev/workflows`; local endpoint :6420; tests via `setupTest`. Hence: idempotency keys on every message, outbox re-dispatch on wake, no reliance on queue redelivery.

Lifecycle state (task, lease, worker, run) is governed by **ADR-008**: XState v5 pure transitions, persisted atomically with the triggering event in actor SQLite. WorkerActor provisions VMs through `SandboxProvider` (boxd first, see boxd.md).

## 3. Event log & replay (recalled outline)
Per-RunActor event log in c.db, contiguous `seq`, replayable (ADR-002).

## 4. CLI wiring (recalled outline)
`relay` CLI uses `rivetkit/client` against the local engine (`http://localhost:6420`).

## 5. TypeScript sketch (RE-DERIVED, not original)
```ts
import { actor, setup } from "rivetkit";
import { db } from "rivetkit/db";
export const taskBoard = actor({
  db: db({ onMigrate: async (d) => {
    await d.execute(`CREATE TABLE IF NOT EXISTS lifecycle(entity_id TEXT PRIMARY KEY, machine TEXT, version INT, state TEXT, context TEXT, seq INT)`);
    await d.execute(`CREATE TABLE IF NOT EXISTS lifecycle_events(entity_id TEXT, seq INT, event TEXT, idem_key TEXT UNIQUE, at INT)`);
  }}),
  actions: { /* apply(event) -> transition() -> c.db.transaction({name:"lifecycle-transition"}) */ },
});
export const registry = setup({ use: { taskBoard } });
```

## 6. Pain points
Original table lost. Known since: `bun build --compile` breaks rivetkit's native module; 60 s action/transaction timeouts force outbox + polling for long VM operations.

## Amendment (2026-10-17): storage
All durable actor data (lifecycle rows, event log, outbox) lives in `c.db`, written via `c.db.transaction`. `c.state` is used only for disposable caches, because it saves on a throttle and isn't atomic with `c.db`. Event log durability = the local engine's disk for now (Rivet Cloud deferred, ADR-009); back up per durability.md. `bun build --compile` currently fails to embed rivetkit's native module. See rivet-sqlite.md.
