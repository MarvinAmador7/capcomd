# Changelog

All notable changes, newest first. Versions follow [Semantic Versioning](https://semver.org); while capcomd is 0.x,
minor versions may break things (marked **Breaking:**). Releases are built by CI from tags (DEVELOPMENT.md).

## Unreleased

- Menu bar app: project cards now match the approved design. Each card is titled by the project's goal, shows the
  folders its agents work in as chips (up to three, then `+n`), and nests every run of the project as an agent tree.
  Run ids no longer appear on cards (they stay in the run view), and a card waiting for your approval gets a faint
  amber tint instead of a coloured border. Click a card's title to open its run. Running status marks are blue even
  when another app is in front.
- Menu bar app: each running agent on a project card shows what it is doing right now under its name ("Reading 4
  files"), updated live. An agent waiting for your approval shows the question there instead, with the branch line
  beneath it and Deny / Approve; Approve stays blue even when another app is in front. Needs a capcomd daemon that
  reports agent activity; with an older one the line is simply absent.
- Menu bar app: the Active list shows only work in progress. A run that finished, failed or was stopped leaves its
  project's card, and a project with nothing left running drops below the cards as one line saying how its latest run
  ended, how long it took and how many folders it touched ("Done in 4m · 3 repos", "Failed after 12m"); the newest
  three are kept, and clicking one opens its run. A paused run stays in the Active list.
- Menu bar app: the run view is rebuilt to the approved design. **Activity** lists each agent's work in plain words
  ("Read 4 files", "Editing 3 files") by phase, with "now" / "6m ago"; finished steps carry no status icon, and the
  list collapses to one row of step icons (⌘\). **Trace** shows the run's model calls, sandbox and git steps with
  timing lanes, follows live, and offers "Jump to now" when you scroll back. Activity or Trace (⌘1/⌘2) is remembered.
  Below, **Log** tails the working agent's output and **Files** lists what the run changed with `+n −n`, one at a
  time. The footer can **Pause**/**Resume** and **Stop** the run (Stop asks once) and **Open in terminal** runs
  `capcomd tui` for it. Pause, Stop and Files need a daemon with the new run controls and files routes; an older one
  says so instead.
- Menu bar app: opening a run or an agent's thread no longer draws it on top of the project list (both showed at
  once, and clicks could land on the hidden cards).
- harness.v1 now says what each agent is doing right now, in plain language: "Reading 4 files", "Running the tests",
  "Waiting for sub-agents", and in past tense once it stopped ("Read 4 files"). It is the new `activity`
  (`{text, kind, at}`, or null) on each agent in `GET /v1/runs/{runId}/agents` and `snapshot.agents`. For live updates,
  add `?activity=1` to a run stream, lifecycle feed included (`/v1/streams/{runId}/events?feed=lifecycle&activity=1`):
  you get `agent.activity_changed` frames, at most one per agent per second, sent live only (never replayed, no SSE
  `id`). The daemon writes the line from tool names, commands and capcomd calls; file names and command text never
  appear in it. Without `?activity=1` the streams are unchanged.
- The harness.v1 API can start a run: `POST /v1/runs` with `{goal, repo?, profile?, targetBranch?}` and an
  `Idempotency-Key` header does what `capcomd run --detach <goal>` does in that project's checkout and returns the
  new run at once (`state: "starting"`); it then appears on the `daemon` stream with `run.created` like a run started
  from the CLI. `repo` is the absolute path of a checkout you ran `capcomd setup project` in; without it the daemon's
  own repository settings (`CAPCOMD_REPO`) are used, and with neither the request is refused (422) with what to do.
  Retrying with the same key returns the same run instead of starting another. The client's token needs the `steer`
  scope: `capcomd clients add <name> --scopes read,steer,approve`.
- `capcomd run --detach -- "<goal>"` with a goal that starts with `-` now runs; the background run used to read the
  goal as a flag and fail.
- harness API: each agent now says where it works. `GET /v1/runs/{runId}/agents`, the `snapshot.agents` stream frame
  and `agent.spawned` events carry `workspace: {repo, path, label}` (null when the run has no repository), so a client
  can show a folder chip per agent and a run's distinct folders. Show `label` as is: the repository's name (e.g.
  `matchkey`), or the sub-folder when an agent is scoped to one. Today every agent works in its run's repository, so
  `path` is null; credentials in a repository URL are left out.
- The harness API has a new read route, `GET /v1/runs/{runId}/files`: the files a run's agents changed, each with
  lines added and removed (null for binary files), its status (added, modified, deleted, renamed…) and the agent
  whose work changed it. Each agent's work is its pushed commit, or its latest checkpoint while it still works,
  compared with where its branch left the run's target branch. Pass `agentId` for one agent and `limit` (at most
  500) to cap the rows; `truncated` says rows were left out. Refetch when the run stream shows a checkpoint, an
  agent finishing or pausing, or a merge with a seq above the answer's `asOf`. Merges now also record the target's
  commit before the merge (`targetBefore` on `merge.succeeded`).

## 0.6.0 (2026-10-25)

Stable release of 0.6.0-rc.2, with no code changes since it: agents in Docker containers, `capcomd tui` in the CLI,
and `capcomd setup` fixes (boxd key, project checkout). See 0.6.0-rc.2 below for the details. The live Mac e2e
(`scripts/mac-subagents-e2e.sh`) was skipped for this release by owner decision.

## 0.6.0-rc.2 (2026-10-25)

Release candidate: agents in Docker containers, `capcomd tui` in the CLI, and `capcomd setup` fixes (boxd key, project checkout).

- `capcomd setup` run outside a git checkout (your home directory, say) now asks for the path to your project's
  checkout and offers that repository's `origin` as the repository, as it does when run inside one. Before, it asked
  for a repository URL with no default and saved the project's settings in the current directory, which from your
  home directory meant capcomd's own config. Without a terminal, it says to run `capcomd setup project` in the
  repository; it never writes project settings into capcomd's own config.
- `capcomd tui [runId]` opens the terminal debugger: the run's agents live, a waterfall of what each did, a timeline,
  cost rollups and events (`--view` picks the first tab). With no runId it opens the latest run. Before, it ran only
  from a git checkout (`apps/tui`); it now ships with the CLI and the single executable.
- `capcomd setup` can create its boxd key again: it failed with "org not found" because the boxd CLI rejects
  `keys create --org` for your active org. Setup now leaves `--org` out there (the key is fenced to that org anyway);
  for another org it says to `boxd auth switch` first.
- Running capcomd from inside a boxd machine (an agent like Hermes on boxd) no longer needs a `BOXD_API_KEY`: when
  the machine has credentials of its own, `capcomd setup` and preflight say so and use them. An explicit key still
  wins. Agent VMs never get such credentials: capcomd only ever runs agents in isolated VMs, which boxd refuses them
  to, and now refuses to use a VM that isn't isolated.
- capcomd can now run agents in Docker containers on your machine instead of boxd VMs: `CAPCOMD_SANDBOX=docker`
  (Docker Desktop, OrbStack, Colima or Podman's docker). `capcomd env build` bakes the agent CLIs into a local image
  and the engine removes expired containers. Differences from boxd: a container instead of a VM, an API key reaches
  the agent in its environment (plan logins are unaffected), and no egress allowlist (a profile that sets `egress` is
  refused). See [docs/providers.md](docs/providers.md).
## 0.6.0-rc.1 (2026-10-24)

Release candidate: a single executable; agents that report up (checkpoints, stuck notices, grants, quota pauses,
messages while they run); no restrictions by default; `capcomd run` with a planner agent.

- `capcomd send` (and `capcomd_send`) now tells you when the agent won't read your message now: a Codex agent can't
  read messages while it works, and a finished agent reads nothing (`note` in the result).
- An agent that keeps working but changes nothing can now be caught: set `noChangeAfterMs` on its profile
  (`capcomd agents set <profile> --no-change-after-ms 1200000`) and an agent with no change in its workspace for that
  long gets a `spinning` notice, then is stopped (its work kept) after twice that. Off by default.
- `capcomd verify` on work that is already merged into the target now passes and says so (`alreadyMerged: true`)
  instead of failing with `pass: false`.
- `capcomd logs <runId> <agent>` (and `capcomd_inspect`'s recent logs) now show what a working Claude Code or
  Codex agent does, a line per tool call, failed call, message and result; before, they were empty for agents that
  can't spawn. `capcomd logs … --follow` streams new lines until the agent finishes (`--json`: one object per line).
- A merge no longer re-runs the checks when nothing changed since `verify` (the same tree, the same check
  command), so it doesn't boot a second checks VM; the result says so (`not run again`). When the target moved, the
  checks run again as before. `CAPCOMD_CHECKS_REUSE=0` always re-runs them.
- Checks that run on your machine (local fake sandboxes, or `CAPCOMD_CHECKS=host`) no longer see your credentials:
  capcomd's settings, provider and GitHub keys, anything named like a key, token, secret or password, git
  credential settings and the SSH agent are removed from their environment. Your toolchain variables stay.
- `capcomd run "<goal>"` now plans real work with a planner agent: `--planner <profile>`, or on boxd by default
  the profile named `planner` (which `capcomd setup` writes). The run gets your project's checks, reviewer and
  target, the planner splits the goal into child agents, verifies and merges their work, and the command shows each
  agent's status as it changes and ends with the planner's summary. **Breaking:** on boxd, `capcomd run` without a
  planner profile now stops with a hint instead of running the built-in placeholder planner (which planned the same
  three generic tasks for any goal); pass `--recipe` to use that anyway.
- A paused agent (stopped by its provider's usage limit) now starts again by itself at the reset time, even when
  nothing is waiting on it; before, it only woke while something awaited it. `capcomd run` now waits through such a
  pause, however long, instead of failing the task after 6 hours (a weekly limit can reset days later).
- Merging an agent's work now deletes its checkpoint ref (`refs/capcomd/checkpoints/<agent>`) from your
  repository; checkpoints of agents whose work didn't land are kept, so you can continue from them.
- An agent with a budget (its own, a parent's or the run's) now also saves a checkpoint each time its spend passes
  another quarter of that budget, so stopping at the budget loses little work.
- `capcomd spawn <runId> --continue <agent> --task …` (`continue` on `capcomd_spawn`, and `capcomd spawn --continue`
  inside a VM for your own children) starts a new agent from a finished agent's work: its branch (for example one
  stopped at a limit), or its last checkpoint if it never pushed one. Before, the new agent's task had to fetch and
  merge that work itself. It is refused for an agent that is still running or paused.
- `capcomd send <runId> <agent> "…"` (and `capcomd_send`, or `capcomd send` from a parent inside its VM) now reaches
  a running Claude Code agent within seconds: it reads the message at its next step and carries on with it. Before,
  only agents allowed to spawn could read messages, by checking their inbox. A message also restarts the agent's
  stuck window, as a grant does. Codex agents still can't read messages while they run.
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
