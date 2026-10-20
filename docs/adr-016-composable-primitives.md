# ADR-016: capcomd is primitives + harness, not a fixed hierarchy (draft)

Status: proposed (design only; no refactor yet). Supersedes the *enforcement* in ADR-001: the planner → worker → judge hierarchy becomes one composition of these primitives, and capcomd no longer mandates it.

## Decision
capcomd provides durable, sandboxed, observable building blocks: agents, tasks, verification, merge, state and budgets. An orchestrator (Hermes, a script, or a capcomd agent with `children.allowSpawn`) composes them into patterns, guided by `skills/capcomd-orchestration/SKILL.md`. capcomd enforces safety, not shape: sandbox/egress, the auth rules (ADR-015 §6), children limits (§7), budgets, leases, verification-before-merge and the event log.

## Surface (every command: `--json` envelope `{schema:"capcomd.v1", ok, ...}`, stable IDs, idempotency via `--key`)
IDs: `run-…` (scope/budget root), `agt-…` (agent instance), `tsk-…`, `vfy-…`, `mrg-…`. Every agent has `parent` (an agent ID or the operator) and `depth`.

| Primitive | Command | Notes |
|---|---|---|
| scope | `capcomd run new [--budget 5] [--repo R] → runId` | a container only; plans nothing |
| spawn | `capcomd spawn --run R --profile P [--set k=v] [--parent agt] --task "…" [--contract file.json] [--task-id tsk] → agt` | contract = `{goal, acceptance[], inputs, outputs:{branch?, blackboard keys?}, budgetUsd, timeoutMs}`; checks the parent's children policy, narrow-only overrides and the carved budget |
| await | `capcomd await agt… [--timeout]` / `capcomd wait-any agt… → {id, status, result}` | result = `{status: done/failed/cancelled/timeout, branch, commit, summary, turns, billing, costUsd}` |
| send | `capcomd send agt --msg "…"` (inbox, delivered at the next turn) · `capcomd handoff agt --to P [--task …]` (ends agt with status `handed-off` and spawns a successor that gets its branch + transcript summary) | |
| cancel | `capcomd cancel agt|run [--reason]` | propagates to all descendants; leases released; VMs destroyed |
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
