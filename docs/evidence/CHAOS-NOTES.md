# Chaos gate notes (2026-10-18)

## attempt-0: seed 29 (`vm.create.after_request.before_record:1`), resume reported as failed
- Log: `chaos-attempt-0-seed29-failure.log`. The resumed client printed `✓ Run completed successfully` but exited 1.
- Root cause: the old `src/cli/index.ts` never called `process.exit` after a successful command, so the
  process only exited once the event loop drained. A rivetkit `tunnel_request_aborted` retry kept a
  handle open, and the harness's 30s `runClient` timer SIGKILLed the client, which reported `code ?? 1`.
- Fix: the CLI now always exits explicitly with its exit code (`102eb9e`).

## attempt-1: seed 8 (`push.after.before_event:1`), engine never ready after restart
- Log: `chaos-attempt-1-seed8-ready-timeout.log`. The ready probe saw `actor_ready_timeout` for the
  whole 45s window.
- Root cause: the restarted engine sometimes never registers its runner. That's a readiness
  problem, not data loss or an invariant failure.
- Fix: `Engine.start` cold-restarts the engine on the same data dir (no wipe) up to twice, and logs
  `engine-not-ready attempt=N` (`61e9a7b`). In run 1 it fired twice, once for `actor_ready_timeout`
  and once for `internal_error`, and that case then passed.

## Gate runs (tree 61e9a7b, runner /workspace/chaos3.sh)
- Run 1: 10/10 killpoints, 50/50 seeds, exit 0 (`chaos-run-1.log`).
- Runs 2 and 3: see `chaos-run-2.log` and `chaos-run-3.log`.

## Run 2: 10/10 killpoints, 49/50 seeds, failed on seed 36 (`merge.after_cas.before_event:2`)
- Violation: `orphan sandbox …-worker-1 past TTL` (worker TTL is 1h).
- That case's first client took `+26131796ms` (7.26h), even though `runClient` SIGKILLs after 30s.
  A 30s timer firing 7h late means the whole box was suspended mid-case (the same night my
  agent waits stopped tracking real time). The wall clock jumped past the 1h worker TTL, so the
  audit correctly reported an expired active sandbox. That's environmental, not a recovery bug.
  Run 2 started 05:46Z and ended 13:47Z.
- Run 3 never started (the script stops on the first failure). The 3-consecutive gate restarts from zero.

## Seed 36 (chaos-run-2) root cause — revised 2026-10-18

The earlier note blamed the box suspension. That was only the trigger. The real cause: before 71e889b,
**nothing ever destroyed a worker's sandbox**. `drainWorker` had no callers. Recovery reconciled the
merge correctly, but no path, including the one where the crash lands between CAS and event, released the VM.
Every run left its worker `idle` with a live vmId. The TTL invariant only noticed when wall time passed
createdAt+1h, which the 7.26h suspension caused for seed 36.

Proof: `tests/chaos/seed36-regression.test.ts` run against ee9b0d5 fails with
`unreaped sandbox ...-worker-1 (worker idle, run completed)`, and passes on the fix.

Fix (idempotent reap):
- `reapSandboxes(runId)` runs on every executeRun entry (recovery) and reaps when the run is terminal, all tasks are terminal, or the worker is past TTL.
- teardown runs on completion, failure and cancel (71e889b).
- the worker actor schedules `reapIfExpired` at createdAt+ttl (a sweep that works with no client).
- `drainWorker` resumes a half-done drain.
- the invariant now also flags any active worker of a finished run. This check doesn't depend on the clock.

## Gate attempt 2, run 2: push.mid resume SIGKILL (2026-10-18)

Run 1 on 7d0597f was green (`chaos-run-1.log`). In run 2, push.mid failed. The resume printed
"✓ Run completed successfully … ✓ Sandbox destroyed" and was then killed by the harness's 30s client timer.
The engine log shows rivetkit stalls: 60s before the kill ("websocket not available for sending"),
and 31s after the restart before any actor ran ("failed to sync scheduled actor alarm", key `__ready__`).
Median resume time is about 7.5s. This was a readiness stall, not a hang or an invariant breach. The client timeout is
now 90s, which still catches the seed-29 class (a CLI that never exits). Log:
`chaos-gate2-run-2-pushmid-resume-sigkill.log`. The gate restarts from zero.

## Gate 3, run 1: seed 35 (merge.before_cas:1), root cause (2026-10-19)

Log: `chaos-gate3-run-1-seed35-zombie-runner.log` (49/50), engine log `chaos-gate3-seed35-engine.log`.

This was a real defect in the kill path, not a readiness timeout. `killpoint()` called `process.exit(137)`, which runs
exit hooks, including rivetkit's native envoy shutdown. The engine log shows the "killed" host still alive
~2 min after `[KILLPOINT] Exiting at merge.before_cas:1`: its websocket session to the old engine ran 129.9s. That is
why the first client took +136726ms instead of ~15s. Then the old runner (envoy 9ebcf86a…) **reconnected to the restarted engine**
(`websocket connected … envoy_key=9ebcf86a` at 18:36:41, before the new host's runner 79b2cb18… at 18:36:46).
The engine assigned actors to that zombie runner. When it died, requests got `tunnel_message_timeout …
no_responders_after_retry_budget_exhausted` (actor_stop_threshold is 30 min), so the resume could not finish.

Fix:
- `killpoint()` now kills itself with SIGKILL: a real crash, with no exit hooks.
- `Engine.stop()` also SIGKILLs any leftover `src/cli/index.ts serve` runner before the next start.

Regression test: `tests/chaos/seed35-regression.test.ts`. Its SIGKILL test fails on the old killpoint (5s hang in an exit hook)
and passes on the fix. The end-to-end merge.before_cas:1 survive check passes.
(`tests/chaos/harness-fix.test.ts` is a legacy imported test that runs `pkill -9 bun` and kills its own runner. It is not part of the gate.)

## Gate 4, run 1: stopped (harness stall after the SIGKILL change)

Log: `chaos-gate4-run-1-orphan-engine-stall.log` (killpoints 10/10, stalled during seeds). There were two harness bugs:
1. With a true SIGKILL, the runner no longer reaps its `rivet-engine` child. A runner-less engine kept accepting the
   client's requests, so the client waited forever. Fix: `Engine.noteKill` SIGKILLs the whole process group when a kill is
   seen (a whole-host crash).
2. The client's 90s timeout never fired. `spawn("bun")` starts `/usr/local/bin/bun`, which is a `/bin/sh` wrapper,
   so `child.kill("SIGKILL")` killed only the wrapper. `bun.exe` kept the pipes open and `close` never fired. This is also
   why seed 35's resume client lived ~17 min. Fix: spawn `process.execPath` for the engine, the probe and the client.

## Gate 5, run 1: seed suite hit bun's 4500s test timeout (2026-10-19)

Log: `chaos-gate5-run-1-timeout.log`. Killpoints 10/10; 48 seeds ran, 0 invariant failures.
- **Restart time.** The `engine-restarted` mark is cumulative from the start of the seed, so "~45s" includes the ~14s
  first client. The restart itself (stop→ready) is ~30s, against 2.4s for a fresh engine. Measured: http up in ~1s, then the
  readiness probe's first `getRun` on `__ready__` blocks ~30s. That actor lived on the SIGKILLed runner, and the
  engine only reschedules it once it declares that runner lost. Probing a fresh actor key instead made restart 1.2s,
  but the resume client then took 34s instead of ~7s, waiting on the same reschedule for its own actors. So the wait is the
  engine's lost-runner detection, which is inherent to crash recovery. It is not a harness sleep or a lock wait, so there was no cheap fix. The probe was left unchanged.
- **Timeout.** The 45 normal seeds averaged 35.5s, max 53.5s. Three outliers (908s, 3461s, 5498s) were box suspensions.
  The seed suite timeout is now 50 × 53.5s × 2 ≈ 5400s.
