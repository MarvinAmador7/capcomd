# ADR-016: capcomd is primitives + harness, not a fixed hierarchy (draft)

Status: accepted in part. Built: step 1 (run new, spawn, await, wait-any, cancel, tree) and step 2 (verify, `merge --require`). The rest is proposed. Supersedes the *enforcement* in ADR-001: the planner → worker → judge hierarchy becomes one composition of these primitives, and capcomd no longer mandates it.

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
- **Test knob:** `CAPCOMD_SPAWN_EXEC=fake` runs the fake agent while profiles still govern the policy.

### Push lock (decision 2026-10-19)
- The worker actor keeps a persisted `push_locks` row per push idempotency key (`worker-<id>-push-<task>-e<epoch>`): holder, engine instance id, lease, attempts, state, adopted, sha.
  - The action holding the lock renews it while the agent runs (`CAPCOMD_PUSH_LOCK_MS`, default 30s).
  - Any other pushBranch call for that key waits while the lock is live. So a takeover driver whose predecessor died mid-push waits for that push instead of starting a second one.
- **Takeover** happens when the lock belongs to a dead engine process (different instance id) or its lease has expired. The new holder first runs `git ls-remote` on the task branch. If the branch is already on the remote, it adopts that commit and doesn't run the agent again.
  - A PR isn't created at push time (verify/merge opens PRs), so checking the branch is enough there. The PR-mode merge path keeps its own CAS (ADR-013).
- The lock row and the PUSHED event commit in one transaction, so a replay returns the recorded sha, turns and wallSeconds.
- **Chaos coverage:**
  - `driver.kill`: SIGKILL the driver mid-push (with the engine's push slowed down). Asserts 1 attempt, 1 PUSHED, agent done.
  - `push.after.before_event`: kill the engine after the push reached a real bare repo. Asserts 2 attempts, `adopted`, exactly one commit on the branch.

### Multi-unit budgets (decision 2026-10-19)
- **Units:** `usd`, `turns`, `wallSeconds`. Use `--budget 5` (usd) or `--budget usd=5,turns=200,wallSeconds=3600`, on `run new` and on `spawn`; a contract can carry `{"budget":{…}}`, and `--budget` overrides it per unit.
- **Unlimited units:** a unit the parent doesn't set is unlimited for its children.
- **Carve and refund**, per unit: a live child holds its allocation and a finished one holds what it spent. A child gets `remaining × budgetShare`, with turns floored. Requesting more than that is rejected.
- The default with no request is all of the remaining budget (× budgetShare), so fan-out callers should request explicitly.
- **Enforcement:** the carved budget narrows the agent's profile: `maxTurns ≤ turns`, `timeoutMs ≤ wallSeconds`, `maxBudgetUsd ≤ usd`. The profile's own limits stay the ceiling.
- **Charging:** agents are charged `{usd: costUsd, turns, wallSeconds}` (agent wall time). Subscription agents spend usd 0 and are charged turns + time.

### Future (ADR item)
- Drive agents from the engine with actor schedules instead of host `capcomd agent-drive` processes. That removes the dependency on the orchestrating host and the lease takeover. The host driver is fine for now.


## Step 2 as built: verify + merge --require
- `capcomd verify <runId> --ref <agt|branch> [--checks CMD] [--acceptance JSON|file] [--judge-profile P] [--target T] [--key K]` → `vfy-…`.
  - The verifier actor runs the checks (`--checks`, or the repo's test command) on the ref merged with the latest target (ADR-003). It records the exact branch commit it tested (`result.commit`).
  - `--judge-profile` adds a judge verdict over the acceptance criteria, and both must pass. Step 2 uses the judge actor and its model. Running a judge *agent profile* in a VM with a read-only checkout comes later.
  - Exit code 0 means it passed.
- `capcomd merge <runId> --ref <agt|branch> --require <vfyId> [--target T] [--operator] [--key K]` → `mrg-…`.
  - Without `--require` (and without `--operator`) it refuses with a usage error.
  - The vfy must be `passed`, for the same branch and target.
  - The merge passes `expectSha` = the verified commit. Under the target lock, a branch that moved since verification fails with "moved since verification", so only the verified commit can land.
  - Protected targets need `--operator` (or `capcomd run` + `approve`). Merges keep ADR-013's CAS and the existing-merge detection.
- **Records and events:** both are records in the scope actor (`ops`), idempotent by id; the same id with different params is a conflict. Events: VERIFY_STARTED/PASSED/FAILED and MERGE_STARTED/MERGED/MERGE_FAILED.
- **Recovery:** a rerun after a crash re-enters the verifier, which reconciles against git and records an already-landed merge instead of merging twice.
- **Tests:**
  - `tests/primitives/verify-merge.test.ts` (real bare repo): the gate, failed checks, a judge, a cross-ref vfy, a branch moved after verify, the happy path and an idempotent repeat.
  - Chaos case `merge.after_cas.before_event:1` (kill after the CAS push): asserts merge recorded once, exactly one task commit on trunk, contiguous events.
