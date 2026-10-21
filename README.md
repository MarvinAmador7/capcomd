# capcomd

Agent orchestration CLI built on Rivet Actors and XState state machines.

## Overview

`capcomd` runs coding agents (Claude Code and Codex) in isolated boxd VMs and coordinates them through
crash-safe primitives: spawn an agent, await it, verify its branch with real checks, and merge only the
commit that was verified. Agents can orchestrate too: a planner agent in its VM spawns, verifies and merges
its own children through the same verbs, limited by capability tokens and narrow-only fan-out.

For what works today, see [STATUS.md](STATUS.md); for what's left, [ROADMAP.md](ROADMAP.md).

**Key features:**
- Composable primitives: `run new`, `spawn`, `await`/`wait-any`, `verify`, `merge --require`, a task board
  with fenced leases, a versioned kv blackboard, and `events --follow` (ADR-016)
- Sub-agents in VMs: an in-VM `capcomd` CLI and MCP tools, capability tokens, narrow-only fan-out and
  budgets (ADR-017)
- Verification from execution, never self-report: checks run on the branch merged with the latest target,
  and the operator names the checks an agent may use (ADR-003)
- Real agents on API keys or subscription logins, with env snapshots and host-bound secrets (ADR-014, ADR-015)
- Crash-safe lifecycles: atomic transitions, epoch-fenced leases, an outbox, exactly-once merges, and a
  chaos killpoint suite (ADR-008, ADR-012)
- A versioned JSON contract for every command (`--json`, schema `relay.v1`), an MCP server, traces and a
  terminal debugger (`apps/tui`)

## Architecture

Design documents live in `docs/`. Start with:
- `adr-016-composable-primitives.md` - the primitives and the `capcomd run` recipe
- `adr-017-subagents-in-vm.md` - agents orchestrating agents from inside their VMs
- `adr-015-agent-envs-secrets-codex.md` - agent profiles, credentials, env snapshots
- `actors-v1.md`, `adr-008-lifecycle-state-machines.md`, `durability.md` - actors, state machines, failure handling
- `output-contract.md` - the JSON, events and spans that callers can rely on
- `boxd.md` - the sandbox provider

### Actors

- **RunActor**: run lifecycle, budget ledger, event log
- **ScopeActor**: the primitives' scope: agents, budgets and carve-outs, ops (verify/merge), tokens, kv, task board
- **WorkerActor**: VM provisioning and the agent run; pushes the task branch
- **VerifierActor**: runs checks on a branch merged with the latest target; merges a verified commit
- **PlannerActor**, **TaskBoardActor**, **JudgeActor**: the `capcomd run` recipe's plan, task ledger and verdict

### State Machines

- **Task**: pending → leased → running → handed_off → verifying → merged
- **Lease**: free → held (with epoch-guarded heartbeats) → released/expired
- **Worker**: provisioning → idle → busy → draining → destroyed
- **Run**: planning → executing → judging → completed

## Installation

A fresh clone has three package roots: the CLI/engine, the canvas UI and the terminal debugger (apps/tui).
Install all three, or `bun run typecheck` fails (it checks apps/canvas and apps/tui too):

```bash
bun install
(cd apps/canvas && bun install)
(cd apps/tui && bun install)
# or, equivalently:
bun run setup
```

## Usage

`bun capcomd …` runs the CLI from the repo (`bun src/cli/index.ts …` works too). `capcomd --help` lists
every command; add `--json` for machine-readable output.

### Start the engine

```bash
bun capcomd serve
```

### Set up real agents (boxd)

```bash
export BOXD_API_KEY=…            # and CAPCOMD_SANDBOX=boxd
bun capcomd env build            # bake the agent CLIs into a boxd snapshot (idempotent, no secrets)
bun capcomd auth login claude    # or codex: log in with your plan inside a VM
bun capcomd doctor --strict      # check each agent and credential inside a snapshot VM
```

API keys work too: `bun capcomd secrets sync` stores local `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` as boxd
host-bound secrets. Agent profiles (provider, auth, model, limits, tools, children policy) are managed with
`bun capcomd agents …`.

### Orchestrate with the primitives

```bash
RUN=$(bun capcomd run new --budget usd=6,turns=200 --checks-set unit='bun test' --json | jq -r .runId)
AGT=$(bun capcomd spawn $RUN --profile claude-worker --task "Fix src/add.ts" --check unit --key add --json | jq -r .agentId)
bun capcomd await $RUN $AGT
VFY=$(bun capcomd verify $RUN --ref $AGT --json | jq -r .id)
bun capcomd merge $RUN --ref $AGT --require $VFY
bun capcomd tree $RUN            # cost/turn rollups and stuck flags
# add a reviewer agent to every verify: run new … --reviewer <profile>  (both checks and review must pass)
# land on a staging branch instead of the configured target: run new … --target staging --target-from main
# read-only work (research, triage): spawn … --report   (the final message is the result; nothing is pushed)
# an agent's merge into a protected branch waits for you: capcomd approve <runId> <mrgId> [--deny --reason R]
```

A profile with `children.allowSpawn` gets the same verbs inside its VM, so a planner agent can run this loop
itself. `scripts/mac-subagents-e2e.sh` is a complete live example.

With real agents (`CAPCOMD_SANDBOX=boxd`), checks run in a throwaway VM, so agent-written code never runs on
the orchestrator host.

### Run a goal

```bash
bun capcomd run "Build a todo app"
bun capcomd status <runId>
bun capcomd cancel <runId>
bun capcomd events <runId>
bun capcomd trace <runId>
```

`capcomd run` is a recipe built from the primitives: planner → workers → judge. Its planner and run-level judge still
answer from a fake model, so it doesn't plan or evaluate for real yet; see STATUS.md.

### Watch a run

```bash
cd apps/tui && bun run start --run <runId>    # set CAPCOMD_ENDPOINT if the engine isn't on :6420
```

## Testing

```bash
bun run typecheck
bun test tests/machines/       # state machine transition tables
bun run test:scenarios         # sub-agent scenarios, primitives policy (the CI regression suite)
bun test tests/agents tests/primitives tests/merge
(cd apps/tui && bun test)
```

The engine-backed tests run on macOS and Linux.

### Chaos tests

```bash
bun run test:chaos             # named killpoints and seeded iterations (long)
bun run chaos:fast             # parallel workers; strict when CI=true

# Run with a specific killpoint
CAPCOMD_KILLPOINT=tx.mid:1 bun test tests/chaos/killpoints.test.ts
```

### Named killpoints

- `tx.mid` - Kill during transaction
- `model.after_return.before_commit` - Kill after model call
- `merge.before_cas` - Kill before merge CAS
- `merge.after_cas.before_event` - Kill after CAS, before event
- `push.mid`, `push.after.before_event` - Kill during or after a branch push
- `vm.create.after_request.before_record` - Kill during VM creation
- `lease.expire.mid` - Kill during lease expiry
- `budget.charge.mid` - Kill during budget charge
- `outbox.dispatch.after_send.before_ack` - Kill during outbox dispatch

## Project Structure

```
src/
  actors/       - Rivet actors (run, scope, worker, verifier, planner, taskboard, judge)
  agents/       - Claude Code / Codex adapters, profiles, credentials, the agent runner
  auth/         - subscription logins (auth login/status/logout)
  cli/          - CLI commands
  core/         - client, errors, preflight, VM cleanup checks
  engine/       - engine launcher (per-port data dir, pid file)
  env/          - env snapshots, secrets sync, doctor
  machines/     - XState state machines
  mcp/          - MCP server
  merge/        - git: direct and PR merge modes, verification runs
  models/       - model client (fake only, see STATUS.md)
  primitives/   - ADR-016 operations, policy, task board, kv
  providers/    - sandbox providers (boxd, fake)
  recipes/      - `capcomd run` composed from the primitives
  subagents/    - ADR-017 RPC, tokens, in-VM CLI, driver, results
  utils/        - lifecycle, killpoints, tracing
apps/
  canvas/       - web UI (capcomd ui)
  tui/          - terminal debugger
tests/          - unit, scenario, chaos, agent and merge suites
scripts/        - live e2e scripts (boxd + GitHub) and helpers
docs/           - design documents and ADRs
```

## Known limitations

See [STATUS.md](STATUS.md) for the full list. The main ones: the `capcomd run` recipe's planner and judge
use a fake model, a real agent's spend is known only when it finishes, `bun build --compile` doesn't survive
rivetkit's native module, and the engine runs locally only (Rivet Cloud deferred).

## Naming (renamed from relay)

The CLI was renamed from `relay` to `capcomd` on 2026-10-18.
- Binary / package: `capcomd`. MCP tools: `capcomd_run`, `capcomd_status`, `capcomd_cancel`, `capcomd_events`, `capcomd_trace`, `capcomd_approve`.
- Env: `CAPCOMD_*` (`CAPCOMD_ENDPOINT`, `CAPCOMD_SANDBOX`, `CAPCOMD_PROTECTED_BRANCHES`, `CAPCOMD_TRACE`, `CAPCOMD_TRACE_DIR`, `CAPCOMD_KILLPOINT`, `CAPCOMD_BOXD_DB`). The old `RELAY_*` names still work as deprecated aliases and print one warning on stderr (silence with `CAPCOMD_NO_DEPRECATION_WARNINGS=1`).
- Deliberately unchanged, for compatibility: actor names, the `relay.v1` JSON schema id, `relay.*` span attribute keys in traces, the `.relay/` state directory, and the `relay-` boxd VM name prefix (existing idempotency keys stay stable).
