# Changelog

All notable changes, newest first. Versions follow [Semantic Versioning](https://semver.org); while capcomd is 0.x,
minor versions may break things (marked **Breaking:**). Releases are built by CI from tags (DEVELOPMENT.md).

## Unreleased

- A paused agent (stopped by its provider's usage limit) now starts again by itself at the reset time, even when
  nothing is waiting on it; before, it only woke while something awaited it. `capcomd run` now waits through such a
  pause, however long, instead of failing the task after 6 hours (a weekly limit can reset days later).
- Merging an agent's work now deletes its checkpoint ref (`refs/capcomd/checkpoints/<agent>`) from your
  repository; checkpoints of agents whose work didn't land are kept, so you can continue from them.
- **Breaking:** nothing restricts an agent by default any more; set limits on a profile or a run when you want
  them.
  - **Tools and network:** an agent whose profile sets no `allowedTools` can use every tool without permission
    prompts (Claude Code runs with `--permission-mode bypassPermissions`), nothing is disallowed (before:
    `git push`, `git remote`, `curl`, `wget`, web fetch and search), Codex runs with `--sandbox danger-full-access`
    (before: `workspace-write`), and the VM can reach any host (before: GitHub, the npm registry, nodejs.org and
    the provider's API). The VM is the boundary, and agents still never hold push credentials. To restrict a
    profile again: `capcomd agents set <profile> --egress github.com,api.anthropic.com,registry.npmjs.org` and
    `allowedTools` / `disallowedTools` / `sandbox` in its spec.
  - **Run budget:** `capcomd run new` without `--budget` creates a run with no budget (before: $10), and the `run`
    recipe no longer gives each task $1. `capcomd_run_new` takes `budget` as optional.
  - **Fan-out:** a profile that may spawn has no depth or descendant limit unless its `children` block sets one
    (before: one level, at most 10 agents below it), and `capcomd setup` writes the planner profile with only the
    worker profiles it may spawn (before: 3 at once, 6 in all, a third of the budget each).
  - **Stuck agents:** an agent that looks idle, spinning or failing gets a notice and keeps running; it is stopped
    only if its profile sets that window (`--idle-after-ms`, `--stuck-repeats`).
- capcomd now installs as a single executable, like any other CLI, with nothing to install first (no Bun or Node):
  `curl -fsSL https://raw.githubusercontent.com/MarvinAmador7/capcomd/main/install.sh | sh`. It picks your machine's build (macOS or Linux, arm64 or x64) from the release, checks its
  SHA-256 and puts it in `~/.capcomd/bin` (`CAPCOMD_INSTALL_DIR` to change that, `CAPCOMD_VERSION` for a specific
  version). Or `brew install MarvinAmador7/tap/capcomd`. `capcomd upgrade` replaces it with the latest release
  (`--to X.Y.Z` for a specific one, `--dry-run` to only check). The binary carries the engine, which it unpacks to
  `~/.capcomd/bin/<version>/` the first time it starts. The npm package (`bun add -g capcomd`) is still published,
  and the plugin works with either.
- You can now give a running agent more budget instead of letting it stop and starting over:
  `capcomd grant <runId> <agent> --budget usd=2,turns=20,wallSeconds=600` (or the new `capcomd_grant` MCP tool,
  or `capcomd grant <agent> --budget …` from a parent agent inside its VM, for its own children). The amount is
  added to what the agent already has and taken from what its parent (or the run) has left; it is refused if
  there isn't enough, if the agent has no budget of its own in that unit (grant its parent instead), or if it
  would go over a cap set in the agent's profile. A grant also restarts the agent's stuck window. Without an agent,
  `capcomd grant <runId> --budget …` raises the run's own budget. Pass `--key` so that a retried grant counts once.
- An agent's budget now applies while it runs as well: the engine stops it once its spend goes over (within a few
  seconds), instead of the agent's CLI being launched with the budget as a fixed cap. Claude agents' turns are
  now counted while they work too, not only when they finish.
- capcomd now notices an agent that looks stuck while it works, and tells its parent. An agent is **idle** when
  it has produced no output for `idleAfterMs` (default 30 minutes), **spinning** when it makes the same tool call
  over and over, and **failing** when it hits the same error over and over (both after `stuckRepeats` times,
  default 8). The agent keeps running: `inspect` and `tree` show the `notice`, its work is checkpointed, and
  `capcomd_await`, an agent's own `await` inside its VM, and `capcomd await --notices` return early with `notices`
  so you or the parent can step in. A profile that sets the window (`capcomd agents set <profile>
  --idle-after-ms N` or `--stuck-repeats N`) also stops the agent if it is still stuck after a second window
  (twice as long, or twice as many repeats), with its work kept and `result.limit` set to `idle`, `spinning` or
  `failing`.
- Agents now save checkpoints of their work while they run, so a crash, a cancel or a lost VM no longer loses
  everything since the last commit. Every 10 minutes, and right after the agent commits, a snapshot of its
  workspace is pushed to `refs/capcomd/checkpoints/<agent>` on your repository, without touching the agent's own
  files or git state. `inspect`, `tree` and `await` show the latest one as `checkpoint` (ref, commit, time, files
  changed). To continue from one, start the new agent with
  `git fetch origin refs/capcomd/checkpoints/<agent> && git merge FETCH_HEAD`. Change the interval per profile
  with `capcomd agents set <profile> --checkpoint-every-ms N`.
- Agents that can't spawn now report that they're alive from inside their VM, every 30 seconds, instead of the
  engine inferring it from their output. An agent that is thinking quietly is no longer reported as silent.
- An agent that hits its provider's usage limit (a Claude or ChatGPT plan's limit, or the API's) is now paused
  instead of failed. It keeps what it has done so far on its branch, shows as `paused` in `tree` and `inspect`
  with the time it resumes, and runs again by itself after the provider's reset time, continuing from that
  branch. Other agents on the same login wait for the reset too, instead of starting and failing. To resume
  sooner (for example after upgrading your plan), run `capcomd resume <runId> [agent]`, or call the new
  `capcomd_resume` MCP tool. Resuming happens while the run is being awaited (`capcomd await`, `capcomd_await`, a
  parent agent's `await`).
- **Breaking:** agents no longer have default turn, time or money limits. Before, every agent stopped at 30 turns,
  20 minutes or $2 unless its profile said otherwise, and `capcomd setup` wrote 15–40 minute limits into the
  profiles it created. Now an unset limit means none, so an agent can work for hours as long as it keeps going.
  To keep a limit, set it on the profile (`capcomd agents set worker --max-turns 30 --timeout-ms 1200000 --budget 2`).
  - **Long-running VMs:** a worker's VM is no longer deleted an hour after it was created. Its one-hour delete
    deadline is renewed while its agent runs, so long work isn't cut off and a VM whose engine died is still
    cleaned up.
  - **Setup:** `capcomd setup` asks API-key users once for a spend cap per run (`--budget 20`, or empty for none).
    Plan logins aren't asked, since a plan is already paid for.
- An agent that hits its time, turn or budget limit no longer loses its work or starts over. What it changed is
  pushed to its branch as a `WIP (stopped: <limit>)` commit with a `Capcomd-Stop` trailer, and it ends `failed`
  with `result.limit` (`timeout`, `max_turns` or `max_budget_usd`), `result.branch` and `result.commit`, after one
  attempt. Before, it was retried from scratch up to three times, then failed with nothing pushed. To carry on,
  spawn a new agent with more budget that starts from that branch.
- Agents that can't spawn children are no longer shown as stuck while they work. Only agents allowed to spawn get
  the in-VM `capcomd`, so a worker had no way to heartbeat and `tree`, `inspect` and `capcomd_tree` flagged it
  `stuck` five minutes in, even when healthy. capcomd now counts the agent's own Claude Code or Codex output as its
  heartbeat, so `stuck` means the model has really gone quiet. `capcomd heartbeat "<note>"` still adds a note.
- **Breaking:** a spawn no longer hands the child everything left of a budget it doesn't name. It reserves only
  the units it names, or the profile's own cap (`maxTurns`, `timeoutMs`, `maxBudgetUsd`), and otherwise nothing.
  Spend is now tracked while agents work instead of only when they finish, so `tree`, `inspect` and `budget show`
  are current, and an agent is stopped with its work kept (`result.limit: "max_budget_usd"`) as soon as its own
  budget, a parent's or the run's is spent. Before, the first worker spawned with only `turns` took every
  remaining dollar and second and the next ones were refused (seen in the plugin's live run). To give a child a
  cap of its own, name it: `spawn --budget usd=2`.

## 0.5.0 (2026-10-22)

capcomd as a plugin for your agent: install it in Claude Code or Codex, ask your agent for the outcome, and it runs
the swarm through capcomd's MCP tools. Setup makes the boxd key from your boxd CLI login.

- **Your agent drives capcomd over MCP** (ADR-018 phase 1). `capcomd mcp` now exposes the primitives as tools:
  `capcomd_setup`, `capcomd_profiles`, `capcomd_run_new`, `capcomd_runs`, `capcomd_spawn`, `capcomd_await`,
  `capcomd_send`, `capcomd_cancel`, `capcomd_verify`, `capcomd_merge`, `capcomd_approve`, `capcomd_task`,
  `capcomd_kv`, `capcomd_budget`, `capcomd_tree`, `capcomd_inspect`, `capcomd_events` and `capcomd_trace`. Waits
  return within 55 seconds with what's still pending (call again; the agents keep working). The agent is a
  *driver*: the checks, reviewer and target come from the project's `.capcomd/config.json`, a protected target or
  a budget over `driver.maxRunBudget` is refused, and merges into protected branches wait for a person unless the
  project sets `driver.approvals: "client-confirmed"`. Agents' text arrives fenced. The server starts the engine
  when none is running (`CAPCOMD_NO_ENGINE_AUTOSTART=1` turns that off) and leaves it running, and
  `capcomd_runs` finds runs from earlier sessions. Register it with `claude mcp add capcomd -- capcomd mcp`.
- **Breaking:** the MCP tools `capcomd_run` (it started the `capcomd run` recipe, whose planner is still a fake
  model) and `capcomd_status` are gone: start a run with `capcomd_run_new` and spawn agents, and use
  `capcomd_tree` or `capcomd_runs` for status. `capcomd_approve` takes `merge` (an `mrg-…` id) instead of `taskId`.
- The orchestration skill covers the MCP tools.
- **The capcomd plugin** for Claude Code and Codex (`plugins/capcomd`; this repository is its marketplace): the MCP
  tools and two skills, orchestration and setup. In Claude Code: `/plugin install capcomd --marketplace
  MarvinAmador7/capcomd`; in Codex: `codex plugin marketplace add MarvinAmador7/capcomd`, then `/plugins`. Its server
  runs the installed capcomd in your project, or, when capcomd is missing or older than the plugin, a single
  `capcomd_setup` tool that says what to install. The setup skill walks your agent through onboarding.
- `capcomd setup` installs the plugin in Claude Code and adds the marketplace to Codex (agent step; `--no-plugin`
  skips it), and replaces the skill copy earlier versions put in `~/.claude/skills`. `setup check` reports it.
- `capcomd setup` makes the boxd key itself when the boxd CLI is logged in: a key named `capcomd-<host>`, in your
  active org (or `--org`), kept in the OS keychain and never shown; revoke it with `boxd auth keys rm`. A stale key
  in the keychain is replaced. Without the CLI or a login, setup says exactly what to run.
- Verified live: a headless Claude Code session with only the plugin's tools fixed three files with a swarm of
  three workers (two Claude, one Codex), each checked and reviewed, merged as three PRs (`scripts/mac-plugin-e2e.sh`).
- `capcomd setup check` (and `capcomd_setup`) counts settings from the environment, not only the config files, and
  checks the engine at `CAPCOMD_ENDPOINT`, not only the default port.
- `capcomd_spawn` and the orchestration skill say that budget units a spawn leaves out take everything that's left.
- The orchestration skill moved to `plugins/capcomd/skills/capcomd-orchestration/`; the npm package ships `plugins/`
  instead of `skills/`.

## 0.4.0 (2026-10-21)

First public release: capcomd is open source under the MIT license and installs from npm.

- **Open source, MIT licensed.** capcomd is published to npm (`bun add -g capcomd`); the release workflow publishes
  the package it tested, with provenance. The package no longer pulls in TypeScript (it was a peer dependency) and
  ships the design docs without the chaos logs.
- Contributor guide (`CONTRIBUTING.md`), Code of Conduct, security policy (`SECURITY.md`, private reporting through
  GitHub), issue templates, and Dependabot for the workflows' actions.
- `capcomd serve` waits for its engine to stop when it's stopped (up to 5 seconds, then kills it) instead of
  exiting while the engine still runs.
- Removed leftovers from early development: the root `index.ts` and `test_*` scripts, an uploaded docs archive,
  stray screenshots and internal import notes.

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
