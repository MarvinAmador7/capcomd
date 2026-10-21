# Changelog

All notable changes, newest first. Versions follow [Semantic Versioning](https://semver.org); while capcomd is 0.x,
minor versions may break things (marked **Breaking:**). Releases are built by CI from tags (DEVELOPMENT.md).

## Unreleased

## 0.3.0 (2026-10-21), private preview

Guided setup (`capcomd setup`), the engine as a background service, and releases built and tested by CI.

- **`capcomd setup`**: a guided setup, re-runnable and scriptable (`--yes`). An optional local demo with fake agents
  (no accounts), then the boxd key (validated, kept in the OS keychain: macOS Keychain or Linux Secret Service),
  the agent VM snapshot, Claude/Codex logins (plan or API key), `doctor`, your project (repository, target branch,
  PR or direct merges, a default check from `package.json`, `worker`/`reviewer`/`planner` profiles), the Claude
  Code skill, and the engine as a service. `capcomd setup check` reports what's configured and working.
- **`capcomd service install|uninstall|status`**: the engine in the background (launchd agent on macOS, systemd
  user unit on Linux), restarted on failure.
- **Persisted settings**: `~/.capcomd/config.json` and a project's `.capcomd/config.json` are defaults for the
  environment (a real env var wins); `run new` takes its checks, reviewer and target from the project when no
  flags are given. `CAPCOMD_NO_CONFIG=1` ignores them.
- **Runs carry their repository settings**: `run new` records the repository, merge mode, target, test command and
  protected branches, and the engine uses the run's. An engine started without any of them (the service) works,
  and one engine can serve runs on different repositories.
- `kv list` leaves out reserved `_` keys (the run's settings), as it already did inside VMs; `--prefix _` lists
  them and `kv get` reads them.
- **Releases from CI**: pushing a `vX.Y.Z` tag runs the tests on Linux and macOS and a strict chaos round, packs the
  package, installs it the way a user does (fresh `HOME`, fake agents: `setup demo`, a run, `setup check`, the
  service definition, state only in `~/.capcomd`) on both, then publishes the GitHub release with the package, its
  SHA-256 and this changelog's section as notes (`.github/workflows/release.yml`, `scripts/release-smoke.sh`).
- CI: the crash suite runs as four parallel jobs (one round per push, three nightly): ~8 minutes instead of ~45.
  Bun is pinned (`.bun-version`, 1.4.3) instead of `latest`; `test:fast` (unit, CLI, setup/config, tracing, auth, env, MCP) and the TUI tests run on every push; the
  old killpoint step, which could never fail, is gone (the chaos jobs cover it). CI also checks that CHANGELOG.md
  and the package version agree.
- `AGENTS.md` (and `CLAUDE.md`): the rules coding agents follow here: changes through PRs with a changelog entry,
  Semantic Versioning, releases only from a tag on `main` through CI, never by hand.

## 0.2.0 (2026-10-21), private preview

First tagged release. Installs from git (`bun add -g git+ssh://git@github.com/MarvinAmador7/capcomd.git#v0.2.0`);
needs Bun ≥ 1.4. What works and what's open: [STATUS.md](STATUS.md), [ROADMAP.md](ROADMAP.md).

### Orchestration
- **Primitives** (ADR-016): `run new`, `spawn`, `await` / `wait-any`, `cancel` (propagates), `tree`, a task board
  with fenced leases and dependencies (`task add --after`), a versioned kv blackboard, `events --follow`, multi-unit
  budgets (usd, turns, wallSeconds), idempotent `--key` on every write.
- **Sub-agents in VMs** (ADR-017): agents allowed to spawn get the same verbs inside their VM (in-VM CLI and MCP
  tools over the exec channel), with capability tokens, narrow-only fan-out set by the parent, budget carving,
  stuck detection and fencing of agent-written text.
- **Gates**: `verify` runs checks on the branch merged with the latest target; `merge --require` lands only that
  exact commit and re-runs the same checks. Operator-named checks (`run new --checks-set`), pinned per child at
  spawn (`spawn --check`).
- **Reviewer**: `run new --reviewer P`; after the checks pass, a reviewer agent reads the commit (read-only, never
  pushes); checks and review must both pass, no verdict fails. Replaces the old fake-model judge in `verify`.
- **Checks in a VM**: with real agents (boxd), checks run in a throwaway VM, never on the orchestrator host.
- **Report mode** (`spawn --report`), **per-run staging targets** (`run new --target T --target-from BASE`), and
  **approval requests**: an agent's merge into a protected branch waits for `capcomd approve <runId> <mrgId>`.
- **Interface-first** pattern for dependent work (planner guidance + scenario test).

### Agents and environments
- Claude Code and Codex adapters; agent profiles (`capcomd agents …`); subscription logins (`auth login`);
  boxd host-bound secrets (`secrets sync`); env snapshots (`env build`); `doctor`.
- Costs: billed USD plus the API-price estimate for subscription work (`~$0.04`) in `tree`, `budget` and the TUI.

### Observability
- Versioned JSON contract for every command (`--json`, schema `relay.v1`, exit codes), MCP server, traces,
  `inspect --follow` (snapshot, events, tree and trace updates).
- Terminal debugger (`apps/tui`): Live tree with parallel groups, reviewers and per-agent pipelines; Waterfall,
  Timeline, Rollups, Events and Replay views that fill in while a run executes.

### Reliability and CI
- Crash safety: atomic lifecycle transitions, epochs, an outbox, exactly-once merges; chaos killpoint suite and
  strict `chaos:fast`.
- CI runs for the first time (the workflow file had been invalid YAML): typecheck, state machines, the scenario
  suite, killpoints, nightly `chaos:fast`. Tests run on macOS and Linux.

### Upgrade notes
- An **installed** CLI keeps state in `~/.capcomd` (`state/`, `traces/`, `agents.json`), or `$CAPCOMD_HOME`. A git
  checkout of capcomd keeps its old layout (`.relay/`, `.traces/`, `.capcomd/agents.json`). Per-file overrides
  (`CAPCOMD_AUTH_LEDGER`, `CAPCOMD_ENV_LEDGER`, `CAPCOMD_TRACE_DIR`, `CAPCOMD_AGENTS_FILE`, …) still win. A project's
  own `.capcomd/agents.json` (in the current directory) is used when present.
- `verify --judge-profile` is now an alias of `--review-profile` and runs a real reviewer agent; an unknown profile
  is refused.

### Known limitations
- `capcomd run "<goal>"` is **experimental**: its planner and run-level judge still use a fake model. Use the
  primitives for real work.
- A real agent's spend is known only when it finishes; no stacked branches yet (dependent work goes interface
  first); one engine per machine (no Rivet Cloud); no standalone binary yet (`serve` doesn't work compiled).
- `capcomd ui` (the web canvas) isn't part of the package; run it from a checkout.
