# capcomd status

**Updated:** 2026-10-21. This file replaces the October 17–18 session logs (`BLOCKING.md`, `PROGRESS.md`,
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
| Reviewer: `run new --reviewer P` (operator-set); after the checks pass, verify spawns a reviewer agent on the commit (read-only, never pushes); both must pass, no verdict = fail | Built, not yet run live | `tests/scenarios/review.test.ts`, `tests/agents/claude-code.test.ts` |
| Sub-agents in VMs (ADR-017): capability tokens, narrow-only fan-out, in-VM `capcomd` CLI and MCP tools, fencing of agent text | Built | `bun run test:scenarios` |
| Real agents: Claude Code and Codex adapters, agent profiles, subscription logins (`auth login`), boxd host-bound secrets, env snapshots (`env build`), `doctor` | Built | `tests/agents`, `tests/env`, `tests/auth`, live `doctor --strict` |
| Git: direct and PR merge modes, protected branches parked for `approve` | Built | `tests/merge` |
| CLI JSON contract (`--json`, schema `relay.v1`, exit codes), MCP server | Built | `tests/cli`, `tests/mcp`, `docs/output-contract.md` |
| Tracing, `inspect --follow`, TUI (`apps/tui`) | Built | `tests/tracing`, `apps/tui` tests |
| Costs: billed USD, plus the API-price estimate for subscription work (`notionalUsd`, shown as `~$0.04`) | Built | `tests/subagents/unit.test.ts`, `apps/tui/test/cost.test.ts` |

**Live end-to-end:** `scripts/mac-subagents-e2e.sh` runs a planner agent that splits a three-file fix across
two Claude workers and one Codex worker, verifies each against its own named check, merges all three, runs
the full suite on the result and confirms no VM is left behind. Last run, 2026-10-21: `E2E PASS`, 3/3 merged,
165s, about $0.23 in API-equivalent cost on subscription billing. This script is manual; it is not in CI.

## Open work

In rough order of importance.

1. **The `capcomd run` recipe's planner and run-level judge use a fake model.** `src/models/` has only
   `FakeModelClient`, and nothing injects a real one. So the recipe's planner plans the same three generic
   tasks for any goal, and its judge always answers "passed" (`src/actors/judge.ts` also treats a reply that
   isn't JSON as a pass). Fix: make the recipe spawn a planner profile, as the sub-agent e2e already does,
   and judge the run with an agent too; keep the fake model for offline tests only. The per-branch evaluation
   is done: `verify` runs the run's reviewer agent (next table row), and the old `--judge-profile` no longer
   takes a canned verdict.
2. **Live spend.** A real agent's cost is known only when it finishes, so a budget can't stop it mid-run;
   spawn-time checks use the carved budget (ADR-017). The notional cost of a failed or timed-out agent is
   also not carried into the tree yet (successful runs only).
3. **Agent logs.** `capcomd logs` doesn't stream a real agent's own output; spans carry its events
   (ADR-017).
4. **Legacy run path.** `capcomd run --legacy` still exists next to the recipe and has its own chaos
   pinning. It is meant to be removed once the recipe covers everything.
5. **Performance.** The recipe uses one VM per agent, about 25–45% slower than the legacy single worker on
   fakes. A warm pool or VM reuse is not built (ADR-016).
6. **Distribution and deployment.** `bun build --compile` fails on rivetkit's native module. The engine runs
   locally only (Rivet Cloud deferred, ADR-009). There is no reaper that reconciles stale VM-ledger rows in
   `.relay/boxd.sqlite`.
7. **CI.** Until 2026-10-21 the workflow file was invalid YAML (an unquoted `: ` in a step name), so GitHub
   ran no CI job at all: every run "failed because of a workflow file issue". It parses now. The `test` job
   runs the typecheck, `tests/machines` and the scenario suite; its killpoint steps end in `|| true`, so they
   can't fail the build. The strict crash gate is `chaos:fast` in the `chaos-nightly` job. A randomized-chaos
   step that called a nonexistent `tests/chaos/random.test.ts` was removed. CI does not run the live e2e,
   `tests/agents` or `tests/env`. Some `tests/env` cases fail on hosts that have `codex` installed (for example
   boxd VMs), because they probe the host as if it were a fresh image.

Smaller known issues:
- `verify` on a branch that has already merged reports `status: "merged", pass: false`.
- `docs/open-questions.md` is a low-confidence reconstruction and needs re-research.

## How to check it yourself

```bash
bun run setup                  # installs the CLI/engine, apps/canvas and apps/tui
bun run typecheck
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
