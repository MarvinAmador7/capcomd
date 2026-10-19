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

## Fast gate: `bun run chaos:fast` (2026-10-19)

Same cases as the serial gate (3 rounds × (10 named killpoints + seeds 1–50) = 180 cases), same
kill semantics (killpoint SIGKILLs itself; harness SIGKILLs the runner's process group and that
instance's rivet-engine; cold restart on the same data dir) and the same 5 invariants. The serial
gate is kept as `bun run chaos:slow` / `bun test tests/chaos/subprocess.test.ts`.

### Where the time goes (measured, merge.before_cas:1, one case)
| phase | serial (before) | fast worker (after) |
|---|---|---|
| wipe | 42ms | ~130ms (16 concurrent) |
| engine up (fresh) | 2.4s | 1.9s (p50) |
| first client | 3.7s | 3.9s |
| stop after kill | 33ms | ~220ms |
| **restart (stop→ready)** | **39.1s** | **39.2s** |
| resume client | 4.9s | 5.2s |
| audit | 1.3s | 1.3s |

The restart wait is NOT the pegboard envoy/runner lost threshold:
- rivetkit 2.3.27's native runtime already spawns the engine with
  `RIVET__PEGBOARD__ENVOY_LOST_THRESHOLD=7000`, `RUNNER_LOST_THRESHOLD=7000`, `*_ELIGIBLE_THRESHOLD=5000`
  (read from `/proc/<engine>/environ`). Keys and defaults: rivet `engine/packages/config/src/config/pegboard.rs`
  (`envoy_lost_threshold`, `envoy_ping_timeout`, `envoy_update_ping_interval`, `envoy_eligible_threshold`,
  `runner_lost_threshold`, `runner_ping_timeout_ms`, `runner_update_ping_interval_ms`, `actor_start_threshold`,
  `gateway_tunnel_ping_timeout_ms`), env form `RIVET__PEGBOARD__<KEY>`.
- Forcing envoy/runner lost=1500, eligible=1000, ping_timeout=1500, ping_interval=250 (confirmed applied: the
  envoy init frame reported `envoyLostThreshold: 1500`), and separately gateway_tunnel_ping_timeout_ms=2000:
  restart stayed 39.2s. Dropped.
- Debug timeline: new engine's envoy connects at T, the `__ready__` actor only starts at T+30.3s. That is
  gasoline (the engine's workflow runtime): the SIGKILLed engine's worker still holds the workflow leases, and
  they are only released by `clear_expired_leases` once the worker's last ping is older than
  `WORKER_LOST_THRESHOLD_MS = 30s`, checked every `GC_INTERVAL = 10s` (rivet
  `engine/packages/gasoline/src/worker.rs`, `src/db/kv/mod.rs`). These are compile-time constants, not config.
  It is inherent to a whole-host crash with a cold engine restart, so it stays in the test.

### What made it fast
1. **Parallel isolated workers** (`tests/chaos/fast.ts`). Each slot gets guard port 7700+20·slot (engine also
   binds +1 api-peer, +10 metrics), its own engine data dir `/tmp/relay-chaos-fast/w<slot>`, and
   `RIVET_RUN_SERVICES=0` (rivet-services binds a fixed :8642 outside the runner's process group). The data dir is
   applied by `tests/chaos/engine-wrapper.sh` via `RIVET_ENGINE_BINARY` (`@rivetkit/engine-cli` getEnginePath),
   because rivetkit forces `RIVET__FILE_SYSTEM__PATH=$HOME/.rivetkit/var/engine/db` on the engine it spawns.
   Cases are ~75% idle wait, so N is memory-bound, not core-bound: measured ~125MB per worker, load average < 2 at
   N=16 on 8 cores. Auto N = min(2×cores, (freeMB−1024)/250, 16) = 16 here.
2. **Kill scoping** (required for N>1): runner reaping is `pgrep -f "src/cli/index.ts serve --port <port>"`; the
   orphaned engine (it runs in its own process group) is killed by its own ports; stop()'s lock holders are now only
   files under that instance's data dir. Bug found on the first parallel pilot: the old fd regex `/sqlite|\.db|rivet/`
   matched shared files (rivetkit napi / engine binary), so one worker's stop() SIGKILLed every other worker.
3. **Sleeps**: `releasePort` waits for the listener to disappear instead of a fixed 200ms; stop() polls at 50ms.
   These are small; the 30s gasoline lease dominates.

### Result
Trial run on this box: 180/180, wall 496s (serial-equivalent case time 7547s, i.e. ~2.1h of serial work).
Official runs: `chaos-fast-run-{1,2,3}.log`.
