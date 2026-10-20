# ADR-016: capcomd is primitives + harness, not a fixed hierarchy (draft)

Status: accepted in part. Step 1 is built (run new, spawn, await, wait-any, cancel, tree). The rest is proposed. Supersedes the *enforcement* in ADR-001: the planner → worker → judge hierarchy becomes one composition of these primitives, and capcomd no longer mandates it.

## Decision
capcomd provides durable, sandboxed, observable building blocks: agents, tasks, verification, merge, state and budgets. An orchestrator (Hermes, a script, or a capcomd agent with `children.allowSpawn`) composes them into patterns, guided by `skills/capcomd-orchestration/SKILL.md`. capcomd enforces safety, not shape: sandbox/egress, the auth rules (ADR-015 §6), children limits (§7), budgets, leases, verification-before-merge and the event log.

## Surface (every command: `--json` envelope `{schema:"capcomd.v1", ok, ...}`, stable IDs, idempotency via `--key`)
IDs: `run-…` (scope/budget root), `agt-…` (agent instance), `tsk-…`, `vfy-…`, `mrg-…`. Every agent has `parent` (an agent ID or the operator) and `depth`.

| Primitive | Command | Notes |
|---|---|---|
| scope | `capcomd run new [--budget 5] [--repo R] → runId` | a container only; plans nothing |
| spawn | `capcomd spawn <runId> --profile P [--set k=v] [--parent agt] --task "…" [--contract file.json] [--task-id tsk] → agt` | contract = `{goal, acceptance[], inputs, outputs:{branch?, blackboard keys?}, budgetUsd, timeoutMs}`; checks the parent's children policy, narrow-only overrides and the carved budget |
| await | `capcomd await <runId> agt… [--timeout-ms]` / `capcomd wait-any <runId> agt…` → `{agents, first}` | result = `{status: done/failed/cancelled/timeout, branch, commit, summary, turns, billing, costUsd}` |
| send | `capcomd send agt --msg "…"` (inbox, delivered at the next turn) · `capcomd handoff agt --to P [--task …]` (ends agt with status `handed-off` and spawns a successor that gets its branch + transcript summary) | |
| cancel | `capcomd cancel <runId> [agt] [--reason]` | propagates to all descendants; leases released; VMs destroyed |
| verify | `capcomd verify --ref branch|commit [--checks "bun test"] [--judge-profile J] --acceptance file → vfy {pass, checks[], judge{verdict, reasons}}` | commands run in a fresh VM (ADR-003); an optional judge agent scores against the criteria |
| merge | `capcomd merge --ref B --target main [--require vfy] [--strategy squash] → mrg` | requires a passing `vfy` for that exact commit unless `--operator` (ADR-013 CAS) |
| board | `capcomd task add|claim|renew|release|done|list --run R` | leases with epochs (fencing), as the actors have today |
| blackboard | `capcomd kv get|put|cas|list --run R key [--if-version n]` | versioned and CAS-protected, so concurrent writers can't lose an update; values ≤64KB |
| events | `capcomd events R [--follow] [--since cursor] [--type …]` | read or subscribe (NDJSON); includes the per-actor `agent.resolved` record |
| budget | `capcomd budget show|carve|charge R` | tree of allocations; a child is never > the parent's remaining budget × `budgetShare` |

Agents inside VMs get the same surface as a scoped tool (`capcomd` with a token limited to their run and subtree), so nesting needs no special mechanism, only `children` limits.

## Existing hierarchy as a composition
`capcomd run "goal"` stays as a recipe: `run new` → `spawn planner(profile=planner)` → the planner `task add`s N tasks → for each, `spawn worker --task-id` → `wait-any` loop → `verify --checks` → `merge --require` → `verify --judge-profile judge` on main. The relay/planner actors become clients of the primitives (refactor later, behind the chaos suite).

## Consequences
+ Patterns (critic loop, best-of-n, …) without changing the engine; Hermes picks them per goal.
+ The safety invariants live in one place (primitives), so they are chaos-testable.
− More surface to keep stable; the `capcomd.v1` envelope and IDs are a compatibility contract.
− Composition bugs move to the orchestrator; the skill and the event log mitigate them.

## Migration (later)
1 spawn/await/cancel over the existing worker actor · 2 verify/merge split out of the relay · 3 kv + budget tree · 4 planner rewritten as a recipe · 5 in-VM scoped CLI for children.

## Step 1 as built
- `capcomd run new [--budget USD=10] [--label] [--key K]` → `run-k<hash>` (with a key) or `run-<random>`. The same key with the same params returns the same run; with different params it's a `conflict` error.
- `capcomd spawn <runId> --task T [--profile P] [--set k=v|--overrides JSON] [--parent agt] [--key K] [--budget USD] [--contract JSON|file] [--no-start] [--operator]` → `agt-k<hash(run, parent, key)>`. Repeating it returns `created:false`; the same key with different params is a conflict.
- `capcomd await <runId> <agt…> [--timeout-ms]` · `capcomd wait-any <runId> <agt…>` → `{agents:[{agentId,status,result:{branch,commit,costUsd,billing}}], first?}`. Exit codes: 0 when everything is done; 1 when an agent failed or was cancelled, or on timeout.
- `capcomd cancel <runId> [agt] [--reason]`: cancels the subtree (pre-order) and destroys each agent's VM. Without `agt` it cancels the whole scope and the run. It is idempotent.
- `capcomd tree <runId>`: the agent tree with budgets. `capcomd events <runId>` now includes `scope:*` events: RUN_NEW, AGENT_SPAWNED (with the effective spec, limits, budget and key), AGENT_STARTED, AGENT_DONE/FAILED, AGENT_CANCELLED.
- **State:** a `scope` actor per run holds the agent tree, keys and the primitive event log. Spawn and each cancel are single transactions, so the limit checks and budget carve can't race.
- **Execution:** each agent gets its own worker actor (`[runId, agentId]`), which does provision → assign → pushBranch (the same idempotent steps as `capcomd run`) → drain. A detached `capcomd agent-drive` process drives it, holding a renewable lease (`CAPCOMD_DRIVER_LEASE_MS`, default 15s). `await`/`wait-any` restart a driver whose lease has expired. Cancel is noticed at step boundaries and inside the agent poll.
- **Policy:** `src/primitives/policy.ts` (pure).
  - Children limits are narrowed down the tree: depth−1, descendants−1, the allowed-profile list intersected.
  - maxChildren counts active children only.
  - Spec widening is rejected unless `--operator`.
  - Budget: a child gets `parent remaining × budgetShare`. An explicit `--budget` above that is rejected. A finished agent holds only what it spent.
- **Tests:**
  - `tests/primitives/policy.test.ts` (unit) and `tests/primitives/e2e.test.ts` (CLI with a real engine).
  - `evals/primitives/run.ts` (recipe eval with a latency baseline).
  - Chaos: in `chaos:fast`, 4 primitive killpoints per round (`scope.spawn.mid:1|3`, `scope.cancel.mid:1`, `push.mid:1` while an agent is being driven). After each kill the harness reruns the keyed scenario and audits the tree: one agent per key, cancel reached every descendant, one event per transition, contiguous seqs, no live workers.
- **Known limits:** `CAPCOMD_SPAWN_EXEC=fake` runs the fake agent while profiles still govern the policy. If a driver dies while its worker action is still running in the engine, the replacement driver can call pushBranch again; it's idempotent only after the push is recorded. That matters only for real agents.
