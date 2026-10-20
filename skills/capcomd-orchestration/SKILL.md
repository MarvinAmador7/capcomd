---
name: capcomd-orchestration
description: Compose capcomd primitives (spawn, await, send, cancel, verify, merge, board, kv, events, budget) into multi-agent coding patterns. Use when orchestrating coding agents on a repo through capcomd.
---
# capcomd orchestration

capcomd gives you primitives, not a workflow. Pick the **simplest** pattern that fits. Always use `--json`, keep IDs, and read `capcomd events R --follow` when debugging. See ADR-016.

Built today: `run new`, `spawn <runId> …`, `await <runId> agt…`, `wait-any <runId> agt…`, `cancel <runId> [agt]`, `tree <runId>`, `events <runId>`, `verify <runId> --ref agt [--checks CMD] [--judge-profile P --acceptance …]`, `merge <runId> --ref agt --require vfy`. `send`/`handoff`, `task`, `kv` and `budget` are proposed (ADR-016). Always pass `--key` on spawn so retries after a crash are safe. Budgets are multi-unit (`--budget usd=1,turns=40,wallSeconds=900`). With no request, a spawn takes everything that's left, so request explicitly when fanning out. Subscription agents are limited by turns and wall time.

Ground rules: one `run new` per goal with an explicit `--budget`; nothing reaches main without `verify` + `merge --require`; write acceptance criteria as commands where possible; cancel what you no longer need (`cancel` propagates); profiles come from `capcomd agents list --json`.

## 1. Single loop (default)
`spawn --profile coder --task T` → `await` → `verify --checks` → on fail, `send` the failures or spawn again with them → `merge`.
Use for: one coherent change. Skip it when the work splits cleanly and the speed matters.

## 2. Fan-out / fan-in
`task add` ×N (disjoint files) → `spawn` per task → `wait-any` loop, `verify` each → `merge` serially → final `verify` on main.
Use for: independent subtasks. Avoid it when tasks touch the same files (merge conflicts), or with N > budget / subscription concurrency (codex subscription = 1).

## 3. Supervisor / worker
A supervisor agent (profile with `children.allowSpawn`, `maxDepth:1`) uses `task claim/done` + `kv` for shared decisions; workers lease tasks, and expired leases are re-claimed.
Use for: a long queue of dynamic work. Avoid it for short goals; the supervisor's turns are pure overhead.

## 4. Critic loop
coder `spawn` → `verify --judge-profile critic --acceptance A` → `send` the critique to the coder (or `handoff`) → repeat ≤k rounds.
Use for: quality bar not expressible as tests. Avoid it when tests already decide, or when the critic and coder share a model's blind spots (use a different provider for the critic).

## 5. Best-of-n with judge
`spawn` n coders (the same task, different profiles/models; budget ÷ n) → `await` all → `verify --checks` each → `verify --judge-profile judge` comparing the passing branches → `merge` the winner, `cancel` the rest.
Use for: high-variance, high-value changes. Avoid it when cost matters or the first attempt usually passes.

## 6. Nested planner (what `capcomd run` does)
planner `spawn` → it `task add`s the plan → recursive sub-planners only for big tasks (`maxDepth` ≤2, `maxTotalDescendants` cap, `budgetShare` ≤0.5) → workers → verify/merge → judge on main.
Use for: big multi-area goals. Avoid it for anything a single loop can do; every level multiplies cost and latency.

## Failure handling
`await` returns timeout/failed: read events, then retry once with the failure in the task, or escalate. Budget exhausted: stop and report, don't use `--operator`. A widening override or spawn is rejected: narrow it, or ask the human operator.
