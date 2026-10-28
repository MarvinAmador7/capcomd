# capcomd status

**Updated:** 2026-10-23. What's left, with proposed approaches, is in [ROADMAP.md](ROADMAP.md). This file replaces the October 17–18 session logs (`BLOCKING.md`, `PROGRESS.md`,
`FINAL-STATUS.md`, and the old `STATUS.md`); they are in git history. Design decisions live in `docs/adr-*.md`.

## Summary

The orchestration primitives and in-VM sub-agents work end to end with real agents: Claude Code and
Codex run in VMs from the first sandbox provider, boxd, on API keys or subscription logins, every merge is gated
by operator-set checks and a reviewer agent, and runs survive crashes. An agent drives a run today through the
capcomd plugin (MCP tools and skills; verified live from Claude Code), the skill and the CLI, or `capcomd run
"<goal>"` with a planner agent, and boxd is still the only real provider (see Open work, items 1 and 2).

## What works

| Area | State | Verified by |
|---|---|---|
| Lifecycle actors and state machines (run, task, lease, worker) | Built | `tests/machines`, chaos killpoints |
| Crash safety: idempotency keys, epochs, exactly-once merge | Built | `tests/chaos` (named killpoints and seeded runs), `chaos:fast` |
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
| CLI JSON contract (`--json`, schema `relay.v1`, exit codes) | Built | `tests/cli`, `docs/output-contract.md` |
| The capcomd plugin (ADR-018 phase 2): Claude Code and Codex manifests, the repo as marketplace, the MCP server through a launcher that finds the installed CLI (or explains how to install it), orchestration and setup skills; `capcomd setup` installs it | Built; verified live 2026-10-22 (`scripts/mac-plugin-e2e.sh`, E2E PASS: a headless Claude Code session with only the plugin's tools ran 3 workers, 2 Claude and 1 Codex, each checked and reviewed, merged as 3 PRs, suite green, no VMs left; 221s, $0.46 API-equivalent for the session). Codex not tried | `tests/config/setup.test.ts`, `claude plugin validate` in CI |
| `capcomd setup` makes the boxd key with your logged-in boxd CLI (a key just for capcomd, kept in the OS keychain, never shown) | Built (detection verified against the real CLI) | `tests/config/boxd-key.test.ts` |
| MCP server for a driver agent (ADR-018 phase 1): the primitives as 18 tools, bounded waits, gates from the project config, human approvals by default, fenced agent text, engine auto-start, runs found again from a new session | Built; verified live through the plugin | `tests/mcp`, `tests/core/engine-start.test.ts` |
| Tracing, `inspect --follow`, TUI (`apps/tui`) | Built | `tests/tracing`, `apps/tui` tests |
| Costs: billed USD, plus the API-price estimate for subscription work (`notionalUsd`, shown as `~$0.04`) | Built | `tests/subagents/unit.test.ts`, `apps/tui/test/cost.test.ts` |
| No restrictions by default (ADR-019 §7): no run budget, no turn, time, money or fan-out limits, every tool without permission prompts and open egress in the VM, unless a profile or run sets them | Built, verified live 2026-10-23 (the e2e runs `capcomd setup`'s planner profile with no run budget) | `tests/agents`, `tests/auth`, `scripts/mac-subagents-e2e.sh` |
| In-VM supervisor (ADR-019 §1, §3): heartbeats, checkpoints of the workspace (every 10 min, after a commit, at each quarter of a budget, on a notice) pushed by the engine to `refs/capcomd/checkpoints/<agent>` and deleted when the work merges | Built; checkpoint push and deletion on GitHub verified live 2026-10-23 | `tests/agents/supervisor.test.ts`, `tests/subagents/liveness.test.ts` |
| Live spend: budgets enforced by the engine from spend reported every 5 s, for both CLIs; `grant` raises a running agent's budget | Built | `tests/subagents/limits.test.ts`, `tests/primitives/policy.test.ts` |
| Stuck notices (idle, spinning, failing) to the parent and the waiting `await`; a stop only when the profile sets the window | Built; idle verified live 2026-10-23 | `tests/subagents/limits.test.ts`, `tests/agents/stuck.test.ts` |
| Quota pause: an agent at its provider's usage limit is `paused` with its work kept, other agents on that login wait, and it wakes at the reset (scheduled by the engine) or on `resume` | Built; the CLIs' limit output was read from their code, not captured live | `tests/subagents/limits.test.ts` |
| Messages to a running Claude worker (`send`): delivered on its stdin through the supervisor, read at its next step | Built, verified live 2026-10-23 (`scripts/mac-agent-ops-e2e.sh`) | `tests/subagents/liveness.test.ts`, `tests/agents/supervisor.test.ts` |
| `spawn --continue <agt>`: a new agent starts from a finished agent's branch or last checkpoint | Built, verified live 2026-10-23 | `tests/subagents/limits.test.ts` |
| `capcomd run "<goal>"` with a planner agent (`--planner P`; on boxd the `planner` profile setup writes): the run gets the project's gates, the planner splits, verifies and merges, and the command shows each agent's status; the built-in recipe's placeholder planner is for offline runs (`--recipe`) | Built, verified live 2026-10-24 | `tests/scenarios/run-planner.test.ts`, `CAPCOMD_E2E_VIA=run scripts/mac-subagents-e2e.sh` |
| `capcomd logs <run> <agt> [--follow]`: a line per tool call, failed call, message and result of a working agent | Built | `tests/subagents/liveness.test.ts` |
| Checks: on the host without the operator's credentials; a merge reuses verify's pass for the same tree and command instead of a second run (and checks VM) | Built | `tests/merge/host-checks.test.ts` |
| Single executable (`install.sh`, Homebrew tap `MarvinAmador7/tap`, `capcomd upgrade`), built for macOS and Linux, x64 and arm64 | Built; linux-x64 and darwin-arm64 driven in CI and locally; the other two first run in the next release | `tests/cli/binary.test.ts`, `scripts/release-smoke.sh`, CI `binary` job |

**Live end-to-end:** `scripts/mac-subagents-e2e.sh` runs a planner agent that splits a three-file fix across
two Claude workers and one Codex worker, verifies each against its own named check in a boxd checks VM, has a
read-only reviewer agent review each, merges all three, runs the full suite on the result and confirms no VM is
left behind. It uses the planner profile `capcomd setup` writes and no run budget, and checks that the workers'
checkpoints reach GitHub and are deleted once their work merges. Last run, 2026-10-23: `E2E PASS`, 3/3 reviewed
and merged, checkpoints pushed and cleaned up, 185s (143s planner), 7 agents. This script is manual; it is not in
CI.

## Open work

The full list, with approaches and sizes, is in [ROADMAP.md](ROADMAP.md). The biggest items:

1. The plugin in Codex: built to OpenAI's plugin format, not yet run in Codex.
2. Sandbox providers as a documented contract: boxd is still wired in (provider list, checks VMs, snapshots,
   setup); a registry, capabilities, a conformance suite and a second provider are next.
3. Patterns that aren't possible yet: stacked branches (dependent work goes interface first instead),
   verifying and landing several branches together, lead → team branch → main hierarchies, comparing candidates.
4. Report mode, staging targets, approval requests and the interface-first pattern pass their tests but
   haven't had a live boxd run yet; neither have quota pauses, spinning and failing notices, or grants.

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
scripts/mac-agent-ops-e2e.sh   # live: notices, send to a running agent, spawn --continue (claude login)
```

The engine-backed tests run on macOS and Linux; Linux uses `/proc` and macOS uses `ps`/`lsof`. On a Mac,
run long suites under `caffeinate -i`: if the machine sleeps mid-run, tests time out and can leave an
orphaned `rivet-engine` behind.

Other reports: `docs/evidence/` (chaos logs).
