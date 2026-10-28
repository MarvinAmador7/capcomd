# ADR-022: An agent's lifecycle as a Rivet workflow (spike, behind a flag)

**Status:** spike, off by default (`CAPCOMD_AGENT_WORKFLOW=1` turns it on, 2026-10-27). Builds on ADR-016 (primitives:
spawn, await, the driver), ADR-017 (in-VM capcomd, the spool pump), ADR-019 §1, §6 (liveness, usage-limit pauses) and
docs/durability.md. Research: rivetkit 2.3.31 source (`rivetkit-typescript/packages/{rivetkit/src/workflow,workflow-engine}`).

## Context

capcomd keeps its durable data in Rivet actors (SQLite per actor, `c.schedule` alarms), but the part that most often
went wrong was hand-rolled around them:

| Mechanism (flag off, today) | Where |
|---|---|
| One detached `capcomd agent-drive` OS process per running agent | `src/primitives/drivers.ts`, `ops.ts` `driveAgent` |
| A driver lease (15 s) renewed by a `setInterval`, takeover of a stale one | `ops.ts` `driveOnce`, `scope.ts` `claimDriver` |
| Outage detection and retries: 3 attempts, N identical failures, up to 20 "the engine restarted" re-runs, 5 min outage | `ops.ts` `engineOutage`, `driveAgent` |
| `await` polls every agent every 300 ms and starts a driver when its lease is stale | `ops.ts` `awaitAgents`, `peekAgents` |
| The whole agent run inside one action with a 60-minute timeout, plus a push lock for takeovers | `worker.ts` `pushBranch` |
| A usage-limit pause wakes by a scope alarm (`wakeDue`) that spawns a driver process from the engine host | `scope.ts` `pause`, `wakeDue` |

Rivet workflows (`rivetkit/workflow`: durable `step`, `loop`, `sleep`, `sleepUntil`, retries with backoff), queues and
actor events exist for exactly this, and were already in the pinned rivetkit.

## Decision (spike)

With `CAPCOMD_AGENT_WORKFLOW=1` (it must be set for the engine host and the CLI alike):

1. **The worker actor runs the agent's lifecycle as its workflow** (`src/actors/agent-workflow.ts`, the worker actor's
   `run`, added only with the flag). One worker actor per agent epoch already exists (`[run, agent]`, `[run, agent,
   eN]`), so one workflow drives one attempt-series of one agent:

   ```
   wait-start (queue "start")
   prepare        claim the agent (driver "wf-<agent>-e<N>"), the operator's pause, env snapshot, the login's quota
   drive loop     one phase per iteration:
     ensure-machine   provision + assign (idempotent by the VM name)          15 min, 3 retries, backoff 2 s → 30 s
     start-agent      start the run in the actor's background (keepAwake), recording it in agent_attempts
     poll             renew the lease every LEASE/3, read the attempt row    + sleep(poll-wait, 1 s)
     restart-agent    the row names another engine process: the daemon went away mid-run, run it again
     attempt-failed   DRIVE_FAILED, the driver's rules (3 attempts, N identical, final kinds); sleep(retry-backoff)
   settle         charge, task done, drain, finish or pause
   [quota]        sleepUntil(usage-reset) → wake (scope.wakeDue: resume as the next epoch, start its workflow)
   ```

2. **Starting an agent sends `start`** to the worker of its current epoch (`startDriver` → `worker.startAgent`, which
   queues one `start` and records that it did: idempotent). Spawn, resume, an await's kick on a stale lease and the
   reset wake all go through it; a second `start` only wakes the actor, which resumes its workflow if it was asleep.
3. **The long `pushBranch` action is not called**: the workflow calls the same code (`pushBranchImpl`) in the actor's
   background, with the actor's own db, key and client. The run itself (runner, scripted agent, in-VM spool pump) is
   unchanged and still not resumable half-way: an attempt whose engine process is gone runs again, as a driver's retry
   did (the runner stops the run it left in the VM; the push lock adopts a branch that already landed).
4. **Waiting is event-driven**: the scope broadcasts `agentsChanged` when an agent finishes, pauses, resumes, is
   cancelled or gets a notice; `await` holds one connection to the scope and looks again on each event, with a 5 s poll
   as the fallback (`CAPCOMD_AWAIT_FALLBACK_MS`) instead of 300 ms.
5. **A usage-limit pause wakes from the paused epoch's own workflow** (`sleepUntil`): `scope.pause` no longer schedules
   `wakeDue` with the flag on, and an await past the reset only wakes that workflow.

The driver code is shared, not copied: `driveOnce` was split into `preflightDrive`, `ensureWorker`, `runAttempt` and
`settlePushed` (`ops.ts`), which both the driver process (flag off) and the workflow's steps call.

### What moves to Rivet with the flag on

| Today | With the flag |
|---|---|
| `agent-drive` process per agent, its pid/log files | none: the worker actor's workflow |
| driver lease heartbeat `setInterval` in that process | the workflow's poll step (the lease still exists: awaits read it) |
| `engineOutage`, "engine restarted" re-runs | workflow replay; an attempt row from another engine instance is re-run |
| retry sleeps (`2 s × n`) in a process | durable `sleep("retry-backoff")` |
| `pushBranch` as a 60-minute action | the same code in the actor's background, kept awake |
| await polling at 300 ms + kicks | `agentsChanged` events + 5 s fallback (kicks stay, they're cheap and idempotent) |
| `wakeDue` alarm + `startDriver` process | `sleepUntil` in the paused epoch's workflow, then `start` for the next epoch |

## Results (2026-10-27)

- New scenarios (`tests/subagents/workflow.test.ts`, flag on, read only the scope's record until the end, so nothing
  kicks the workflow): a daemon SIGKILL mid-agent → the engine wakes the worker by itself, the workflow re-runs the
  attempt (the run left in the VM is stopped first: `start, stopped, start, finished`), the agent finishes, no
  `DRIVE_FAILED`, never an `agent-drive` process; a usage-limit pause with nobody awaiting → its workflow sleeps to the
  reset and the next epoch finishes.
- The full scenario suites run with the flag off and on (numbers in the stage report / PR).

## Failure modes

- **Workflow replay and code changes.** History is matched by step names; changing the workflow's shape breaks
  in-flight agents (`HistoryDivergedError`). Use `ctx.getVersion`/`ctx.removed` for changes once agents can be in
  flight across an upgrade, or drain (no running agent) before upgrading.
- **Nested loops diverge on replay (rivetkit 2.3.31).** A loop inside another loop's iteration resumes at its saved
  iteration, and the outer iteration's check then finds the retained earlier inner iterations unvisited. Found by the
  first version of this spike; the workflow is one flat loop with a phase per iteration. Upstream report worth filing.
- **Step outputs are history.** Keep them small (the push result is the largest). Loop history is pruned every 20
  iterations; a 60-minute agent at 1 s polls writes ~3600 small entries over its life.
- **The run is not resumable mid-way**: after a restart the attempt runs again from the start in the same VM (same as
  the driver). Real re-attach needs the runner split into start/poll/finish around the VM's files (later).
- **The background run lives in the engine host process.** It is held by `keepAwake`; if the actor is stopped (engine
  restart, rescheduling) the run dies with it and the poll step sees the attempt as lost. Two runs of one attempt are
  prevented by the engine instance check and the push lock.
- **Both paths during a mixed rollout**: a CLI without the flag starts a driver process for an agent whose engine has
  the flag (the driver claims the lease first and runs it; the workflow's `prepare` then ends). Set the flag for the
  daemon and every client together.
- **Events are best effort**: a missed `agentsChanged` (reconnect) costs at most the fallback poll.
- **Observability**: the driver's `agent.run` span wraps the drive in its own process; the workflow writes one at the
  end instead (same ids and attributes, `agent.driver: workflow`, start = when it claimed the agent), so traces keep
  their parenting. Spans opened inside the run (the worker's actions) are unchanged.
- **Where driver-side settings are read.** The driver process read its environment from the CLI that started it; the
  workflow reads the engine host's. Production settings live in config both read, but test knobs set only for one CLI
  call (`CAPCOMD_SCRIPT_<PROFILE>` for a scripted agent) don't reach the engine: `run-planner.test.ts` fails with the
  flag on for this reason (its planner script is passed to `capcomd run` only).
- **Faster start shifts test timing.** `observability.test.ts` "activity line" expects to see the planner's "Waiting
  for sub-agents" arrive as a live frame; with the flag on it is already in the stream's opening snapshot (the activity
  is recorded as before), so the test's live-frame assertion fails.

## Criteria to make it the default (S3, not now)

1. The scenario suites, `tests/agents` and the chaos fast gate pass with the flag on, twice in a row, with no new flake.
2. The live end-to-end (`scripts/mac-subagents-e2e.sh`, boxd + Claude + Codex) passes with the flag on; a daemon
   restart mid-run of a real agent recovers.
3. A workflow-shape change is shipped once with `getVersion` against in-flight agents (upgrade drill).
4. `agent.run` spans and the menu bar's live views are unchanged with the flag on.
5. Then: remove `agent-drive`, `driveAgent`/`engineOutage`, the process-side lease heartbeat and the scope's `wakeDue`
   alarm path; keep `claimDriver` only as the workflow's liveness lease.
