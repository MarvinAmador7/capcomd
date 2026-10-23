# ADR-016: capcomd is primitives + harness, not a fixed hierarchy (draft)

Status: accepted in part. Built: step 1 (run new, spawn, await, wait-any, cancel, tree) and step 2 (verify, `merge --require`). The rest is proposed. Supersedes the *enforcement* in ADR-001: the planner → worker → judge hierarchy becomes one composition of these primitives, and capcomd no longer mandates it.

## Decision
capcomd provides durable, sandboxed, observable building blocks: agents, tasks, verification, merge, state and budgets. An orchestrator (Hermes, a script, or a capcomd agent with `children.allowSpawn`) composes them into patterns, guided by `plugins/capcomd/skills/capcomd-orchestration/SKILL.md`. capcomd enforces safety, not shape: sandbox/egress, the auth rules (ADR-015 §6), children limits (§7), budgets, leases, verification-before-merge and the event log.

## Surface (every command: `--json` envelope `{schema:"capcomd.v1", ok, ...}`, stable IDs, idempotency via `--key`)
IDs: `run-…` (scope/budget root), `agt-…` (agent instance), `tsk-…`, `vfy-…`, `mrg-…`. Every agent has `parent` (an agent ID or the operator) and `depth`.

| Primitive | Command | Notes |
|---|---|---|
| scope | `capcomd run new [--budget 5] [--repo R] → runId` | a container only; plans nothing |
| spawn | `capcomd spawn <runId> --profile P [--set k=v] [--parent agt] --task "…" [--contract file.json] [--task-id tsk] → agt` | contract = `{goal, acceptance[], inputs, outputs:{branch?, blackboard keys?}, budgetUsd, timeoutMs}`; checks the parent's children policy, narrow-only overrides and the carved budget |
| await | `capcomd await <runId> agt… [--timeout-ms]` / `capcomd wait-any <runId> agt…` → `{agents, first}` | result = `{status: done/failed/cancelled/timeout, branch, commit, summary, turns, billing, costUsd}` |
| send | `capcomd send agt --msg "…"` (inbox, delivered at the next turn) · `capcomd handoff agt --to P [--task …]` (ends agt with status `handed-off` and spawns a successor that gets its branch + transcript summary) | |
| cancel | `capcomd cancel <runId> [agt] [--reason]` | propagates to all descendants; leases released; VMs destroyed |
| verify | `capcomd verify --ref branch|commit [--checks "bun test"] [--review-profile R] --acceptance file → vfy {pass, checks, review{passed, reasons}}` | commands run in a fresh VM (ADR-003); then a reviewer agent (the run's `--reviewer`, operator-set) reads the commit against the criteria |
| merge | `capcomd merge --ref B --target main [--require vfy] [--strategy squash] → mrg` | requires a passing `vfy` for that exact commit unless `--operator` (ADR-013 CAS) |
| board | `capcomd task add|claim|renew|release|done|list|show <runId> …` (built, step 3) | leases with fencing epochs; expired leases are taken over |
| blackboard | `capcomd kv get|put|cas|list <runId> key [value] [--expect n]` (built, step 3) | versioned and CAS-protected, so concurrent writers can't lose an update |
| events | `capcomd events R [--follow [--until TYPE] [--timeout-ms N] [--from-start]]` (follow built, step 3) | read or subscribe (NDJSON); includes the per-actor `agent.resolved` record |
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
  Amended 2026-10-22: per unit, a spawn that doesn't name a unit reserves the child profile's own cap for it
  (`maxTurns`, `timeoutMs`, `maxBudgetUsd`, at most what's left); a subscription child that can't spawn reserves no
  usd; only a unit the profile doesn't cap defaults to all that's left.
  Amended by ADR-019 (step 1b): a unit the profile doesn't cap reserves nothing. Spend is metered live and the
  engine stops an agent when its own budget, an ancestor's (that ancestor's whole subtree counts) or the run's is
  over; a child that reserved nothing holds what its subtree has spent.
- **Enforcement:** the carved budget narrows the agent's profile: `maxTurns ≤ turns`, `timeoutMs ≤ wallSeconds`, `maxBudgetUsd ≤ usd`. The profile's own limits stay the ceiling.
  Amended by ADR-019 (step 1): these limits are optional. Profiles have no default turns, time or money, and an
  unset limit means none; the only guard always on is an idle stop (no output from the agent CLI for
  `idleAfterMs`, default 30 min). A worker VM's delete deadline is a one-hour lease renewed while its agent runs.
  An agent that reaches one of them is stopped, not retried (running it again hits the same limit): what it changed is
  committed and pushed to its branch (subject `WIP (stopped: <limit>) …`, trailer `Capcomd-Stop: <limit>`, so a
  replay after a crash still sees the stop), and it finishes `failed` with `result.limit`, `result.branch` and
  `result.commit`. A parent continues from that branch with a new child and more budget.
- **Charging:** agents are charged `{usd: costUsd, turns, wallSeconds}` (agent wall time). Subscription agents spend usd 0 and are charged turns + time.

### Future (ADR item)
- Drive agents from the engine with actor schedules instead of host `capcomd agent-drive` processes. That removes the dependency on the orchestrating host and the lease takeover. The host driver is fine for now.


## Step 2 as built: verify + merge --require
- `capcomd verify <runId> --ref <agt|branch> [--checks CMD] [--acceptance JSON|file] [--judge-profile P] [--target T] [--key K]` → `vfy-…`.
  - The verifier actor runs the checks (`--checks`, or the repo's test command) on the ref merged with the latest target (ADR-003). It records the exact branch commit it tested (`result.commit`).
  - **Reviewer** (2026-10-21; replaces step 2's judge actor, which answered from the fake model and passed everything). The operator names a reviewer profile per run (`run new --reviewer P`); operator `verify` may override it with `--review-profile P` (`--judge-profile` is a deprecated alias). After the checks pass, verify spawns the reviewer as an agent with a detached checkout of the verified commit and a brief (the acceptance criteria and the child's task); it never commits or pushes. Its verdict is `{"passed": bool, "reasons": [...]}` (declared result data, else the last such JSON in its final message). Both the checks and the review must pass; a missing or malformed verdict, or a reviewer that fails, fails the verify. In-VM verify can't choose the reviewer (forbidden), the reviewer is paid from the caller's budget (the run's for the operator) but exempt from its fan-out limits, and it can never spawn. An in-VM verify answers `state: "running"` after 90s (`CAPCOMD_VERIFY_HOLD_MS`) and the CLI polls with the same key; the in-flight verify is shared, never re-run. The vfy result has `review {profile, agentId, passed, reasons, error?}` and a `judge` mirror for old callers. Tests: `tests/scenarios/review.test.ts`, `tests/agents/claude-code.test.ts` (review mode).
  - Exit code 0 means it passed.
  - **Where checks run** (2026-10-21): with `CAPCOMD_SANDBOX=boxd`, in a throwaway VM (`src/merge/verify.ts`): the env snapshot (never an auth snapshot), registry-only egress, the merged tree as a `git archive` (no `.git`), deps reused from the snapshot when the lockfile matches, only the run/task/target ids in the command's env, destroyed after. Before this they ran in a host clone with the host's environment. Fake sandboxes still run them on the host; `CAPCOMD_CHECKS=vm|host` overrides.
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

## Step 3 as built: task board, blackboard, events --follow
Both live in the run's scope actor (one SQLite transaction per write, engine clock for leases). They are separate from the legacy `taskBoard` actor that `capcomd run` uses.
- **Task board**
  - `task add <runId> --title T [--data JSON] [--key K]` → `tsk-…`. A keyed add is idempotent; the same key with other params is a conflict.
  - `task claim <runId> [tsk] --holder H [--lease-ms N] [--key K]` → `{claimed, taskId, epoch, leaseUntil, takeover}`. With no id it takes the next free task: open tasks first, then the longest-expired lease. Each claim bumps the task's **epoch** (fencing token). Taking an expired lease records TASK_LEASE_EXPIRED then TASK_CLAIMED with `takeoverFrom`.
  - `task renew|release|done <runId> <tsk> --holder H --epoch E` are **fenced**: a stale epoch fails with "lease lost" (`conflict`). Until someone else claims, a holder whose lease ran out can still renew or finish, because its epoch still matches.
  - Renewals are not logged as events (they would flood the log). The events are TASK_ADDED, TASK_CLAIMED, TASK_LEASE_EXPIRED, TASK_RELEASED and TASK_DONE.
- **Blackboard**
  - `kv get` returns `{value, version}`; a missing key reads as version 0.
  - `kv put` is unconditional. `kv cas --expect V` writes only if the current version is V (0 = must not exist); otherwise it fails with `conflict` "version is N".
  - Every successful write bumps the version and records KV_PUT or KV_CAS (key and version; the value is not in the log).
- **Idempotent writes:** claim, done/release and kv put/cas take `--key`. Repeating the key returns the recorded result with `replayed: true`. Only successful writes are recorded, so a failed cas or claim can simply be retried.
- **Follow:** `events <runId> --follow` polls the merged log (run, legacy tasks, scope) and emits each event once. With `--json` it prints one envelope per line, `{event}`, then `{end:{stopped}}` when `--until TYPE` matches or `--timeout-ms` passes.
- **Tests:**
  - Unit: `tests/primitives/board.test.ts`.
  - End to end: `tests/primitives/state-e2e.test.ts` covers fencing, expiry takeover, keyed replay, a 6-writer cas counter race, and `--follow --until`.
  - Chaos: `board.claim.mid:2`, `board.claim.after.before_reply:4`, `kv.cas.mid:3`, `kv.cas.after.before_reply:4`. Audits check the takeover epoch, that the late holder is fenced, one claim per task among 4 concurrent racers, a set of 6 cas writers at exactly version 6, a keyed put applied once, and contiguous event seqs.
  - Negative control: with claim replay removed, `board.claim.after.before_reply:4` fails.
- **Dependencies:** `task add --after tsk,…`. A task is blocked until all its deps are done.
  - Claim-next skips blocked tasks; an explicit claim of a blocked task fails with "blocked by …" (`conflict`). `task list` shows `blockedBy`.
  - Deps are fixed when the task is added and must already exist (unknown = `not_found`). So the only cycle that can reach the board is a task naming itself (its id is a pure function of run and key). Add still runs a full cycle check (`findCycle`) and rejects with "dependency cycle: a -> … -> a" (`usage`), so the check holds if forward references are ever allowed.
- **kv delete:** `kv del <runId> <k> [--expect V] [--key K]` writes a versioned **tombstone**: the version goes up, `get` returns `{value:null, deleted:true, version}`, `list` hides it unless `--all`, and KV_DELETE is logged.
  - A tombstone is cas-able like any version: recreate with `cas --expect <tombstone version>`.
  - Deleting a missing or already-deleted key without `--expect` is a no-op (`noop:true`).
- **kv size cap:** values are limited to 64KB of UTF-8 JSON (`CAPCOMD_KV_MAX_BYTES`). The CLI and the actor both check it, and an oversized value fails with "value is N bytes, cap is 65536" (`usage`).
- **Not built:** server-push subscribe (`--follow` polls, by decision).

## Step 4 as built: `capcomd run` as a recipe (default)

`src/recipes/hierarchical.ts` runs planner → workers → judge as a composition of the primitives: `run new`, the planner actor, `task add --after` (plan order), `task claim`, `spawn`/`await`, `verify`, `merge --require`, `task done`, the judge actor. It is the default path. `--legacy` (or `CAPCOMD_RUN_PATH=legacy`) keeps the old loop until it is removed. The MCP server spawns `capcomd run`, so it follows the same default.

**The CLI output is a public contract (Hermes consumes it).** So the recipe keeps the task-board actor as the public task ledger and drives the same transitions as legacy: lease → started → handoff → verify → merged | awaiting_approval → approved → merged, with the ledger's retry budget (maxRetries 3, so 4 attempts). As a result, `status` (tasks, `awaitingApproval`), `events` (VERIFIED_AWAITING_APPROVAL, APPROVED, …), `approve` (conflict on a task that isn't waiting) and `cancel` (`{runId, state, changed}`) are identical on both paths. The stream emits the same events (`agent.resolved`, `task.awaiting_approval`, `task.approved`, `task.merged`, `task.verify_failed`). The trace has `relay.run → cli.run` with actor, transition, model, sandbox and git spans. Preflight, sandbox reaping and the boxd auth failure (`run.failed` with `kind: config`, `retryable: false`) work the same way. Spawn keys are `<task>-e<epoch>`, so a resumed run replays the attempt it crashed in, and a retried task gets a fresh agent. `contract.planTask` names the commit trailer, giving `Capcomd-Task: <run>/<task>`, so landings and exactly-once audits match legacy.

**Judge rule (both paths, fake and real):** a run with 0 merged tasks fails, unless its goal is tagged `[noop]`. The judge sees only merged tasks.

**Parity eval** (`evals/recipe-parity/run.ts`) uses one engine and one bare repo per case. Cases: 3-task plan, explicit target, protected target with the approval flow driven through the CLI, and checks that fail. It compares the run outcome (state, judge, merged tasks, landed files, commits, failed attempts) and the CLI contract: status keys, states and tasks, `awaitingApproval`, `cancel` on a finished run, ledger event counts, stream event types, required trace spans, and the early-approve conflict. Trace rule (asserted, documented in docs/integration-agents.md): a `git.merge` span appears iff something merged; in a run that merges nothing there is none (the recipe verifies, then merges only a passing ref). Legacy's `git.merge` on a failed verify-and-merge attempt is not contract.

**Chaos:** the killpoint gate's client is pinned to `--legacy`. `RECIPE_KILLPOINTS` reruns every actor and merge killpoint (except legacy-only `lease.expire.mid`) plus `board.claim.mid` and `scope.spawn.mid` on `--recipe`, with the same audit (one landing per plan task, ledger, budget, outbox).

**Later (perf):** the recipe uses one VM per agent (the isolation default), which is about 25–45% slower than legacy's single worker on fakes. A warm pool or VM reuse is a follow-up; nothing changes now.
