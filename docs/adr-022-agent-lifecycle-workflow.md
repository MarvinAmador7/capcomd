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
   prepare        claim the agent with a 6 h lease (driver "wf-<agent>-e<N>"), operator pause, env snapshot, login quota
   drive loop     one phase per iteration:
     ensure-machine   re-claim, provision + assign (idempotent by the VM name)  15 min, 3 retries, backoff 2 s → 30 s
     start-agent      start the run in the actor's background (keepAwake), recording it in agent_attempts; the run
                      sends `attempt` to its own actor when it ends
     watch            queue.nextBatch("attempt", timeout LEASE/3) → poll: the agent ended (cancel)? the row's outcome?
     restart-agent    the row says running but no live run in this process: the daemon or actor went away, run again
     attempt-failed   DRIVE_FAILED, the driver's rules (3 attempts, N identical, final kinds); sleep(retry-backoff)
   settle         charge, task done, drain, finish or pause; the agent.run span
   give-up        any step whose retries ran out: the agent fails with that error (never left "running")
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
5. **A usage-limit pause wakes from the paused epoch's own workflow** (`sleepUntil`), and an await past the reset only
   wakes that workflow. The scope's `wakeDue` alarm stays as a backstop (a pause written by a driver, a workflow that
   died or diverged): whichever comes first resumes the agent, the other finds it resumed.

The driver code is shared, not copied: `driveOnce` was split into `preflightDrive`, `ensureWorker`, `runAttempt` and
`settlePushed` (`ops.ts`), which both the driver process (flag off) and the workflow's steps call.

6. **The driver's settings travel with the agent** (2026-10-28). A driver process read its settings from the CLI that
   started it; the workflow runs in the engine host, whose env is another's. So `spawn` records the spawner's drive
   settings on the agent (`agents_v2.drive_env`): how it runs (`CAPCOMD_SPAWN_EXEC`), scripted agents' scripts and
   spool knobs (`CAPCOMD_SCRIPT_*`), the agents file its children's profiles resolve from (`CAPCOMD_AGENTS_FILE`, as
   that shell resolved it, made absolute: a config path, the one state-ish value), the driver's timings and test
   killpoints. It's an allowlist (`src/utils/env.ts`): never a secret (no `KEY`, `TOKEN`, `SECRET`, `PASSWORD`,
   `CREDENTIAL` name segment) and no path to capcomd's own state. A spawn replayed by key keeps the settings it was
   first recorded with. Each workflow step and the run it starts apply them over
   the host's env through an `AsyncLocalStorage` (`withDriveEnv`), so `env()` reads them for that agent only, and what
   the agent spawns from its VM inherits them. Recorded with the flag off too (harmless, and a mixed rollout works).

### What moves to Rivet with the flag on

| Today | With the flag |
|---|---|
| `agent-drive` process per agent, its pid/log files | none: the worker actor's workflow |
| driver lease heartbeat `setInterval` in that process | one long lease (6 h) the workflow takes when it claims and after a failure |
| `engineOutage`, "engine restarted" re-runs | workflow replay; an attempt row from another engine instance is re-run |
| retry sleeps (`2 s × n`) in a process | durable `sleep("retry-backoff")` |
| a driver polling the run | the run's own `attempt` message to its actor's queue (a LEASE/3 timeout as the fallback) |
| `pushBranch` as a 60-minute action | the same code in the actor's background, kept awake |
| await polling at 300 ms + kicks | `agentsChanged` events + 5 s fallback (kicks stay, they're cheap and idempotent) |
| `wakeDue` alarm + `startDriver` process | `sleepUntil` in the paused epoch's workflow, then `start` for the next epoch (the alarm stays as a backstop) |

## Results (2026-10-27, 2026-10-28)

- New scenarios (`tests/subagents/workflow.test.ts`, flag on, read only the scope's record until the end, so nothing
  kicks the workflow): a daemon SIGKILL mid-agent → the engine wakes the worker by itself, the workflow re-runs the
  attempt (the run left in the VM is stopped first: `start, stopped, start, finished`), the agent finishes, no
  `DRIVE_FAILED`, never an `agent-drive` process; a usage-limit pause with nobody awaiting → its workflow sleeps to the
  reset and the next epoch finishes.
- First spike run (2026-10-28): flag on, run-planner and 10 of 14 chaos primitives failed, because the settings the
  driver took from its CLI didn't reach the engine and the driver-kill cases had no driver; fixed by decision 6 and the
  counterparts below.
- After the gap fixes (2026-10-28, branch feat/agent-workflow-gaps, each run with a fresh `CAPCOMD_HOME`):

  | | flag off | flag on |
  |---|---|---|
  | `test:fast` | 678/678 | 678/678 |
  | `tests/agents` | 58/58 | 58/58 |
  | `test:scenarios` | 110/110 | 110/110 |
  | chaos:fast named killpoints (private ports) | 11/11 | 11/11 |
  | chaos:fast primitives | 14/14 | 14/14 (every case killed) |
  | `tests/chaos` killpoints, harness-fix, seed35, seed36 | 4, 1, 3, 2 pass | 4, 1, 3, 2 pass |
  | `tests/chaos/classify.test.ts` | 5/5 | (no engine) |

  `tests/chaos/subprocess.test.ts` (flag off, legacy run path, private ports, with a repo as chaos:fast runs it): the 11
  named killpoints 11/11 plus its unit case, 50/50 seeds (63 min).
- The two harness-stream tests (agent-provider, observability "activity line") that failed in earlier runs failed only
  with a long-lived scratch `CAPCOMD_HOME` (850 runs in `runs.jsonl`, 137 machine records): opening a run's stream took
  over their 5 s read window. With a fresh home they pass both ways. Worth a look on its own (a stream's first frames
  shouldn't depend on how many runs the home has seen).

## Measurements (2026-10-28, `tests/chaos/measure-workflow.ts`)

Fake agents on the in-memory sandbox, a slowed push standing in for a long run, one private engine on this Mac (other
agents' tests running alongside). "Looks" are watch iterations (one `attempt-wait` + `poll` each). Engine data is
the size of its RocksDB folder; host RSS is the engine host (`capcomd serve`, which runs every workflow); engine RSS
is `rivet-engine`; the worker's history is its `_rivet_wf_kv` rows (worker action `getWorkflowStats`).

| Case | Looks per agent | History per agent | Actor DB | Host RSS | Engine RSS | Engine data |
|---|---|---|---|---|---|---|
| (a) one agent, 240 s at a 50 ms watch (≈ 65 h of looks at the 60 s default) | 3899 | ≤ 210 rows, ≤ 17 KB, flat | 136 KB, flat | 166–204 MB, flat | 134 → 303 MB | 0.3 → 130 MB |
| (b) 12 agents, 300 s, default 60 s watch | 5 | ≤ 59 rows, 4.4 KB | 120 KB | peak 148 MB | peak 157 MB | 5.5 MB |
| (b) baseline: 12 agents, driver processes (flag off), 120–300 s | – | – | – | peak 137 MB, **+ 12 `agent-drive` processes, 664 MB** | peak 152–160 MB | 2.7–4.9 MB |
| (b) 12 agents, 120 s, a 5 s watch (the earlier default) | ~24 | ≤ 146 rows | 128 KB | 144 MB | 173 MB | 10.3 MB |

- **Bounded:** the workflow's own history (the drive loop prunes old iterations every 20 and keeps 20; rivetkit
  default), the worker actor's database, and the host's memory. Twelve agents cost the engine host ~10 MB more than
  one, where the driver path ran a ~55 MB process per agent.
- **Grows with writes, not reclaimed while idle:** the engine's data folder (~33 KB per look: every history flush is
  an actor SQLite commit the engine stores) and, while writing, `rivet-engine`'s memory (it fell back from 303 to 185
  MB once idle). The driver path writes too (a lease renewal every 5 s). So the watch writes rarely: its default went
  from LEASE/3 (5 s) to 60 s, which brings 12 agents to about the driver path's writes. Nothing waits on it: the run
  sends `attempt` when it ends, and a worker that wakes with a run in flight (a restarted daemon) sends it to itself
  (`onWake`), so a lost run is found at once (the restart scenario: done 25 s after the engine came back, with the 60 s
  default). `CAPCOMD_AGENT_WORKFLOW_POLL_MS` overrides it. Compacting the engine's storage is Rivet's (residual).

## Changing the workflow (the rule; since 2026-10-28)

An agent can be in flight across a capcomd upgrade: its workflow replays the history it recorded under the old code,
matched to the new code by entry name. The workflow carries two shape gates (`src/actors/agent-workflow.ts`):
`ctx.getVersion("lifecycle-shape", N)` at the top, and `l.getVersion("drive-shape", M)` at the start of every
drive-loop iteration. `getVersion` returns the version the instance (or that iteration) started with: 1 for one that
had already run past the gate under code from before the gate existed, the latest for one that reaches it fresh; the
answer is recorded, so a replay gets the same one.

- **Any change to the names, kinds or order of workflow entries** (a step, sleep, queue wait, loop, try) bumps the
  version of the scope it's in: `LIFECYCLE_SHAPE` for the top level, `DRIVE_SHAPE` for an iteration of the drive loop.
- **Branch on the returned version**: code for older versions stays until no agent can still be on it (one release
  after the change, then remove it with the next bump). New entries go in the new branch only.
- **An entry the new code no longer makes** is marked `await ctx.removed(name, kind)` where it used to be.
- **Never** rename or reorder an entry in place, change a step's output shape that later code reads without a
  version check, or nest a loop in a loop (or a try block).
- **Changing what a step does inside** (its body, not its name or output) needs no bump: completed steps aren't re-run,
  and an interrupted one runs again with the new body. It must stay idempotent.
- Run `tests/subagents/workflow-upgrade.test.ts` for any change here.

The drill (`workflow-upgrade.test.ts`, test-only `CAPCOMD_WORKFLOW_DRILL`): agent A is mid-run under shape 1 when the
engine host dies; it comes back with shape 2 (a new top-level step, and in every drive-loop iteration a new step plus
the watch's `attempt-wait`/`poll` entries renamed). With the gates, A replays its shape-1 history, never runs the new
top-level step, finishes, and nothing diverges; agent B, started after the upgrade, runs shape 2. The control makes the
same change without the gates (`=ungated`): A runs the shape-2 step it never started with and its workflow diverges
from its history (`HistoryDivergedError`), so it would never finish. Both pass (2026-10-28).

## Failure modes

- **Workflow replay and code changes.** History is matched by entry names; changing the workflow's shape under an
  in-flight agent breaks it (`HistoryDivergedError`), or makes it run steps of a shape it never started with. Every
  change follows "Changing the workflow" below.
- **Nested loops diverge on replay (rivetkit 2.3.31).** A loop inside another loop's iteration resumes at its saved
  iteration, and the outer iteration's check then finds the retained earlier inner iterations unvisited. Found by the
  first version of this spike; the workflow is one flat loop with a phase per iteration. Upstream report worth filing.
- **Step outputs are history.** Keep them small (the push result is the largest). Loop history is pruned every 20
  iterations; a 60-minute agent at 1 s polls writes ~3600 small entries over its life.
- **The run is not resumable mid-way**: after a restart the attempt runs again from the start in the same VM (same as
  the driver). Real re-attach needs the runner split into start/poll/finish around the VM's files (later).
- **The background run lives in the engine host process.** It is held by `keepAwake` and listed in a per-process map;
  a row that says "running" with no live run there (the daemon restarted, or the actor was stopped and woken) is lost
  and runs again. The push lock keeps two pushes of one attempt from both landing.
- **A step that keeps failing** (an engine that won't answer for minutes) ends in `give-up`: the agent fails with the
  step's error rather than staying "running"; a later `capcomd spawn --continue` picks its work up.
- **Both paths during a mixed rollout**: a CLI without the flag starts a driver process; whichever claims the lease
  first drives the agent (the workflow's 6 h lease keeps a driver out once it has it; a driver's 15 s one keeps the
  workflow's `prepare` out). A CLI with the flag against an engine without it falls back to a driver process. Set
  the flag for the daemon and every client together.
- **Events are best effort**: a missed `agentsChanged` (reconnect) costs at most the fallback poll.
- **Observability**: the driver's `agent.run` span wraps the drive in its own process; the workflow writes one at the
  end instead (same ids and attributes, `agent.driver: workflow`, start = when it claimed the agent), so traces keep
  their parenting. Spans opened inside the run (the worker's actions) are unchanged.
- **Review (2026-10-27, applied):** exhausted steps fail the agent (give-up) instead of sleeping forever; a lost run is
  detected per actor, not per process; `start` is sent before it's remembered; final prepare failures are recorded as
  DRIVE_FAILED like the driver's; the watch waits on the run's `attempt` message instead of a 1 s poll (an hour's agent
  writes ~720 loop entries instead of ~7200); the lease is claimed once, not renewed.
- **Where driver-side settings are read** (fixed, decision 6): they travel with the agent. Settings outside the
  allowlist are the engine host's, as they always were for the worker's own actions (`CAPCOMD_REPO`, sandbox, keys).
- **Workflow-engine argument checks.** A queue wait's timeout must be an integer (a 4000 ms lease / 3 failed the whole
  workflow with "Not an integer"); timeouts and `sleepUntil` targets are rounded.

### Chaos counterparts with the flag on

The primitives chaos cases that killed a driver process have no driver to kill with the flag on; each kills the engine
host instead, mid-step, and checks the same property (`tests/chaos/primitives.ts`):

| Case | Flag off | Flag on |
|---|---|---|
| `driver.kill:0` | the scenario SIGKILLs the agent's driver mid-push; the takeover waits, the push runs once | killpoint `workflow.watch.running` kills the engine host while the slowed push is in flight; after the restart the lost run runs once more (2 push attempts), the push lands once, the agent finishes once |
| `vm.rpc.spawn.before_reply:0`, `vm.rpc.await.before:0` | the parent's driver dies inside a VM's RPC | the same driver killpoint fires in the engine host, where the spool pump now runs: the engine dies, the scripted "VM" outlives it, the restarted workflow re-attaches and answers the RPC once (2 children, no duplicates) |

## Criteria to make it the default (S3, not now)

1. Met on 2026-10-28 (numbers under Results): the scenario suites, `tests/agents`, `test:fast` and the chaos fast
   gate (named killpoints and primitives) pass with the flag on as with it off. Still to do: a second clean run in a
   row on a quiet machine, and the remaining items below.
2. Real agents with the flag on, which no suite here runs: the live end-to-end (`scripts/mac-subagents-e2e.sh`, boxd +
   Claude + Codex) and the same goal on the Docker (Local) provider pass; a daemon restart mid-run of a real agent
   recovers; an hour-long agent's workflow history and the engine host's memory with a dozen agents are measured
   (every run now lives in the engine host process, not in one process per agent).
3. Met (2026-10-28): the upgrade drill above passes, and the version gates are in the workflow.
4. `agent.run` spans and the menu bar's live views are unchanged with the flag on.
5. Then: remove `agent-drive`, `driveAgent`/`engineOutage`, the process-side lease heartbeat and the scope's `wakeDue`
   alarm path; keep `claimDriver` only as the workflow's liveness lease.
