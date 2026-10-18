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
