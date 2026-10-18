# Relay v0 - Current Status

**Updated:** 2026-10-18 03:45 UTC

Work stopped here on purpose. Chaos run 2 was killed after its named killpoints passed and while seeded iterations were still running. The engine on port 6420 was stopped with it. Do not treat this tree as a finished 3-run chaos gate.

## 1. Chaos

**Gate asked for:** process-group kill, wait until port 6420 and the engine data lock are free, invariant checks that fail when the audit cannot read data, then 10/10 named killpoints and 50/50 seeds on 3 consecutive runs.

**What is in the tree**

- `tests/chaos/engine.ts` spawns `relay serve` detached in its own process group. `stop()` records descendant pids, sends SIGKILL to the group, then polls for up to 8s until nothing is listening on 6420 and nothing still holds the recorded db fds.
- Readiness is not a fixed sleep. HTTP `/` must answer, then `tests/chaos/ready-probe.ts` loops `run.getRun("__ready__")` until the default runner exists or 45s elapses. A single `no_runner_config_configured` is not readiness. The parent kills the probe at 50s.
- Each case wipes `/home/ubuntu/.rivetkit/var/engine` before the first start only. The resume start reuses that directory. Wiping between the kill and the resume makes the test meaningless. A final SIGKILL of a live engine can leave RocksDB returning "An internal error occurred" on the next open, which is why the wipe happens before the first start.
- Named cases require a kill: exit 137, `[KILLPOINT]` in the client output, or `[KILLPOINT]` in the serve log. `stop()` sets a flag so the cleanup SIGKILL is not counted as the killpoint.
- `tests/chaos/invariants.ts` `auditRun` throws if the run, tasks, or charges cannot be read. It does not catch that and pass. The five checks are: no double `VERIFIED_AND_MERGED`, every task state is a known task state, no sandbox still active past its TTL, no duplicate charge id, event seqs are gap-free `1..n` per entity.
- `src/cli/commands/run.ts` resumes with `--run-id`. Planner, verifier, worker provision, push, budget charge, and outbox flush are idempotent enough to continue after `process.exit(137)`. Verifier `passed` is the constant `true`. Lease TTL is 24h so a scheduled expire does not fire mid-suite.
- Killpoints on the happy path: `tx.mid`, `model.after_return.before_commit`, `merge.before_cas`, `merge.after_cas.before_event`, `push.mid`, `push.after.before_event`, `vm.create.after_request.before_record`, `lease.expire.mid`, `budget.charge.mid`, `outbox.dispatch.after_send.before_ack`.

**Runs**

Run 1, 2026-10-18 02:48:52Z to 03:30:46Z, exit 0. `bun test tests/chaos/subprocess.test.ts`.

```
✓ tx.mid killed=true (51266ms)
✓ model.after_return.before_commit killed=true (51198ms)
✓ merge.before_cas killed=true (52108ms)
✓ merge.after_cas.before_event killed=true (52345ms)
✓ push.mid killed=true (58364ms)
✓ push.after.before_event killed=true (51298ms)
✓ vm.create.after_request.before_record killed=true (55839ms)
✓ lease.expire.mid killed=true (51117ms)
✓ budget.charge.mid killed=true (51010ms)
✓ outbox.dispatch.after_send.before_ack killed=true (51830ms)
Total: 10/10 passed
(pass) survives all 10 named killpoints [526374.95ms]
Completed 50/50 seeds (50 passed, 0 failed)
Final: 50/50 passed, 0/50 failed
(pass) survives 50 seeded killpoint iterations [1986886.23ms]
3 pass
0 fail
Ran 3 tests across 1 file. [2513.55s]
```

Run 2 started 03:30:46Z. Named killpoints passed again (`Total: 10/10 passed`, 522272.47ms, same ten names, each `killed=true`). Seeded iterations had completed 7 cases with no failure line and were inside the 8th engine start when the suite was killed. Run 3 never started.

`tests/chaos/killpoints.test.ts` is the old in-process file. It does not run these five checks. Use `tests/chaos/subprocess.test.ts`.

**Next**

1. Confirm nothing is listening on 6420 (`lsof -nP -iTCP:6420 -sTCP:LISTEN`).
2. Run `~/.bun/bin/bun test tests/chaos/subprocess.test.ts` three times in a row. Timeouts in the file are 1_200_000ms for the named test and 4_500_000ms for seeds. One full file is about 42 minutes.
3. Paste all three raw summaries. The gate is 10/10 and 50/50 on each run, with `killed=true` on every named killpoint.

## 2. Tracing

**Done**

- `src/cli/commands/trace.ts` parses and prints a waterfall from `.traces/<runId>.ndjson`. The commander-wrapper syntax error is already on main (`7788090`).
- `src/utils/tracing-simple.ts` is the Bun-safe span helper. The OTel SDK path in `src/utils/tracing.ts` builds an `NDJSONFileExporter` and never registers it as a span processor. `initTracing` is not called from the CLI or the actors. `docs/adr-010-tracing.md` still says the project uses the OTel SDK. On Bun, `BasicTracerProvider.addSpanProcessor` and `Resource` exports from the SDK do not work, which is why `tracing-simple.ts` exists.

**Not done**

- No fresh run has written `.traces/<runId>.ndjson`.
- No real `relay trace <runId>` output has been captured.

**Next**

1. Emit spans from a real `relay run` (actor actions, state transitions, model, sandbox, git) through `tracing-simple`, including `relay.run_id`.
2. Flush `.traces/<runId>.ndjson` at the end of the run.
3. Run a new run and paste `relay trace <runId>`.
4. Note in `docs/adr-010-tracing.md` why the SDK was not used on Bun, and whether OTLP is actually connected.

## 3. JSON, exit codes, MCP, approval

**Not started.** `src/cli/index.ts` has `serve`, `run`, `status`, `cancel`, `replay`, `trace`, and `ui`. `--run-id` exists. There is no `--json`, no `--detach`, no `relay mcp`, and no `relay approve`.

Usage errors still exit 1. There is no versioned JSON schema.

**Next, in this order**

1. `--json` on `run`, `status`, `cancel`, `replay`, and `trace`, one versioned schema.
2. Exit codes: 0 ok, 1 run failed, 2 usage, 3 not found, 4 engine unreachable.
3. `relay run --json --detach` prints `{runId}` and returns. Without `--detach`, stream NDJSON events.
4. `relay mcp` on stdio with tools `relay_run`, `relay_status`, `relay_cancel`, `relay_trace`, `relay_events` (cursor pagination). Truncate tool results and set `truncated: true`. Errors must say what to do next.
5. Protected-branch merges park in `awaiting_approval` until `relay approve <runId> <taskId>`. Same action as an MCP tool. Current happy-path branches are `task/<taskId>/e<epoch>`, not protected, so this must not change the chaos merge path.
6. Tests for each command, plus an MCP client test that drives a full run.
7. `docs/integration-agents.md`, using Hermes as the example caller.

## 4. Canvas

**Done in this tree, not screenshotted**

- `apps/canvas/tests/canvas-machine.test.ts`: 8 pass, 0 fail (`bun test tests/canvas-machine.test.ts` from `apps/canvas`).
- The three failures were one bug. `@statelyai/graph` stores `nodes` as an array. `foldEvent` indexed `graph.nodes[id]`, missed the task `PLAN_READY` had already inserted, and `TASK_CREATED` threw `Node "task-1" already exists`. That error stopped the machine, so `MODE.SWITCH_TO_REPLAY` never landed, and `data.status` stayed unset. `graph-fold.ts` now materializes a Stately graph for updates and publishes `nodes` as an id record.
- `buildWaterfall` in `canvas-machine.ts` fills `context.traceData.spans` when the panel spans state reaches ready. `App.tsx` renders those bars.
- Mode switches also assign `context.mode`, which the toolbar reads.

**Not done**

- No browser pass. No screenshots in `/opt/cursor/artifacts`.
- Layout positions from the ELK worker are still not applied back onto the React Flow nodes.

**Next**

1. `cd apps/canvas && bun run dev --host 127.0.0.1 --port 43123`.
2. Open the canvas, let the demo events finish, open a node, click View Spans, and confirm the waterfall.
3. Save screenshots under `/opt/cursor/artifacts`.

## Resume commands

```bash
# chaos, from /workspace, after confirming :6420 is free
~/.bun/bin/bun test tests/chaos/subprocess.test.ts

# canvas tests
cd apps/canvas && ~/.bun/bin/bun test tests/canvas-machine.test.ts
```
