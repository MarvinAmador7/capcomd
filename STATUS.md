# capcomd status

**Updated:** 2026-10-21. What's left, with proposed approaches, is in [ROADMAP.md](ROADMAP.md). This file replaces the October 17–18 session logs (`BLOCKING.md`, `PROGRESS.md`,
`FINAL-STATUS.md`, and the old `STATUS.md`); they are in git history. Design decisions live in `docs/adr-*.md`.

## Summary

The orchestration primitives and in-VM sub-agents work end to end with real agents: Claude Code and
Codex run in boxd VMs on API keys or subscription logins, and every merge is gated by operator-set checks.
Most of the remaining work is in the `capcomd run "<goal>"` recipe: its planner and its judge still answer
from a fake model, so that path doesn't plan or judge for real yet (see Open work, item 1). Per-branch
review by an agent (`run new --reviewer`) is built.

## What works

| Area | State | Verified by |
|---|---|---|
| Lifecycle actors and state machines (run, task, lease, worker) | Built | `tests/machines`, chaos killpoints |
| Crash safety: outbox, epochs, exactly-once merge | Built | `tests/chaos` (named killpoints and seeded runs), `chaos:fast` |
| Primitives (ADR-016): `run new`, `spawn`, `await`, `wait-any`, `cancel`, `tree`, task board with fenced leases, versioned kv, `events --follow` | Built | `tests/primitives`, chaos `board.*` / `kv.*` killpoints |
| `verify` (checks on the ref merged with the latest target) and `merge --require` (only the verified commit lands; merge re-runs the same checks) | Built | `tests/primitives/verify-merge.test.ts` |
| Operator-named checks: `run new --checks-set name='cmd'`, pinned per child with `spawn --check NAME` | Built | `tests/scenarios/named-checks.test.ts` |
| Reviewer: `run new --reviewer P` (operator-set); after the checks pass, verify spawns a reviewer agent on the commit (read-only, never pushes); both must pass, no verdict = fail | Built, verified live | `tests/scenarios/review.test.ts`, `tests/agents/claude-code.test.ts` |
| Checks in a VM: with `CAPCOMD_SANDBOX=boxd`, verify and merge run the check command in a throwaway VM (env snapshot, no credentials, registry-only egress, the archived tree, destroyed after); fakes run it on the host | Built, verified live | `tests/merge/checks-vm.test.ts` |
| Report mode: `spawn --report` gives a leaf a read-only checkout; its final message is its result, nothing is pushed (research, triage) | Built | `tests/scenarios/review.test.ts`, `tests/agents/claude-code.test.ts` |
| Protected targets from agents: an in-VM merge into a protected branch is parked (`awaiting_approval`, listed in `status` `pendingApprovals`); `approve <runId> <mrgId>` lands it, `--deny` fails it | Built | `tests/scenarios/approvals.test.ts` |
| Per-run staging target: `run new --target T [--target-from BASE]`; children branch from it, verify and merge default to it | Built | `tests/scenarios/approvals.test.ts` |
| Guided setup (`capcomd setup`, `setup check`): local demo, boxd key in the OS keychain, snapshot, logins, project config and profiles, Claude Code skill, engine service | Built (accounts step verified live, non-interactive) | `tests/config/` |
| Engine as a service (`capcomd service install`): launchd (macOS), systemd user unit (Linux) | Built (launchd verified live) | `tests/config/service.test.ts` |
| Releases from CI: a `vX.Y.Z` tag runs the tests (Linux, macOS), a chaos round, an install of the packed package with a fresh `HOME` (fake agents), then publishes the GitHub release | Built (v0.3.0 released this way) | `.github/workflows/release.yml`, `scripts/release-smoke.sh` |
| Runs carry their repository settings: an engine without repo env (a service) works; one engine serves several repos | Built | `tests/scenarios/run-repo.test.ts` |
| Dependent work, interface first: a contract child lands, then provider and consumers run in parallel and land in dependency order (planner guidance, pattern 7) | Built | `tests/scenarios/interface-first.test.ts` |
| Sub-agents in VMs (ADR-017): capability tokens, narrow-only fan-out, in-VM `capcomd` CLI and MCP tools, fencing of agent text | Built | `bun run test:scenarios` |
| Real agents: Claude Code and Codex adapters, agent profiles, subscription logins (`auth login`), boxd host-bound secrets, env snapshots (`env build`), `doctor` | Built | `tests/agents`, `tests/env`, `tests/auth`, live `doctor --strict` |
| Git: direct and PR merge modes, protected branches parked for `approve` | Built | `tests/merge` |
| CLI JSON contract (`--json`, schema `relay.v1`, exit codes), MCP server | Built | `tests/cli`, `tests/mcp`, `docs/output-contract.md` |
| Tracing, `inspect --follow`, TUI (`apps/tui`) | Built | `tests/tracing`, `apps/tui` tests |
| Costs: billed USD, plus the API-price estimate for subscription work (`notionalUsd`, shown as `~$0.04`) | Built | `tests/subagents/unit.test.ts`, `apps/tui/test/cost.test.ts` |

**Live end-to-end:** `scripts/mac-subagents-e2e.sh` runs a planner agent that splits a three-file fix across
two Claude workers and one Codex worker, verifies each against its own named check in a boxd checks VM, has a
read-only reviewer agent review each, merges all three, runs the full suite on the result and confirms no VM is
left behind. Last run, 2026-10-21: `E2E PASS`, 3/3 reviewed and merged, 228s (181s planner), 7 agents and 6
checks VMs, about $0.37 in API-equivalent cost on subscription billing. This script is manual; it is not in CI.

## Open work

The full list, with approaches and sizes, is in [ROADMAP.md](ROADMAP.md). The biggest items:

1. The `capcomd run` recipe's planner and run-level judge still answer from a fake model (per-branch review
   by an agent is built: `run new --reviewer`).
2. Live spend: a real agent's cost is known only when it finishes.
3. Patterns that aren't possible yet: stacked branches (dependent work goes interface first instead),
   verifying and landing several branches together, lead → team branch → main hierarchies, comparing candidates.
4. Report mode, staging targets, approval requests and the interface-first pattern pass their tests but
   haven't had a live boxd run yet.

## How to check it yourself

```bash
bun run setup                  # installs the CLI/engine, apps/canvas and apps/tui
bun run typecheck
bun run test:fast              # unit, CLI, setup/config, state machines, tracing, auth, env, MCP (~1 min)
bun run test:scenarios         # CI's regression suite, about 3.5 min on macOS, 6.5 min on Linux
bun test tests/agents tests/primitives tests/merge
(cd apps/tui && bun test)
bun run test:chaos             # long: the killpoint and seed suites
scripts/mac-subagents-e2e.sh   # live: needs BOXD_API_KEY, gh, and working claude + codex logins
```

The engine-backed tests run on macOS and Linux; Linux uses `/proc` and macOS uses `ps`/`lsof`. On a Mac,
run long suites under `caffeinate -i`: if the machine sleeps mid-run, tests time out and can leave an
orphaned `rivet-engine` behind.

Other reports: `CANVAS_REFACTOR.md` (the `apps/canvas` XState refactor), `docs/evidence/` (chaos logs).
