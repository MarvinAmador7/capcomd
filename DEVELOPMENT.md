# Developing capcomd

How the code is laid out, how to test it, and how to cut a release. For what capcomd is and how to use it, see
the [README](README.md); for what works and what's open, [STATUS.md](STATUS.md) and [ROADMAP.md](ROADMAP.md).

## Setup

A fresh clone has three package roots: the CLI/engine, the canvas UI and the terminal debugger (apps/tui).
Install all three, or `bun run typecheck` fails (it checks apps/canvas and apps/tui too):

```bash
bun install
(cd apps/canvas && bun install)
(cd apps/tui && bun install)
# or, equivalently:
bun run setup
```

Run the CLI from the checkout with `bun capcomd …` (or `bun src/cli/index.ts …`).

### Where state lives

A git checkout keeps state next to the code: `.relay/` (auth profiles, env snapshot ledger, boxd VM ledger, run
logs, driver pids), `.traces/` (spans) and `.capcomd/agents.json` (with v2 profiles in `.capcomd/profiles/`). An
installed CLI, or any CLI with `CAPCOMD_HOME` set, uses `~/.capcomd` (`state/`, `traces/`, `agents.json`, `profiles/`). The daemon's `harness-state.json`, the
engine autostart's `engine.log` and the agent token signing key `rpc.key` follow the same rule: `.relay/` in a checkout, the top of `~/.capcomd` otherwise. `src/utils/home.ts` decides; the
per-file overrides (`CAPCOMD_AUTH_LEDGER`, `CAPCOMD_ENV_LEDGER`, `CAPCOMD_QUOTA_LEDGER`, `CAPCOMD_TRACE_DIR`,
`CAPCOMD_AGENTS_FILE`, `CAPCOMD_BOXD_DB`, `CAPCOMD_MACHINES_LEDGER`, `CAPCOMD_RUNS_INDEX`, `CAPCOMD_RPC_KEY_FILE`) win. Tests that touch these must set their own (a saved login in `.relay/` changes outcomes).

The Rivet engine's data is always under the capcomd home (`~/.capcomd`, or `$CAPCOMD_HOME`), checkout or not, one
directory per port (`src/engine/data.ts`; `CAPCOMD_ENGINE_DATA` names another): `engine/<port>/db` (RocksDB),
`engine.pid`, `engine-version.json` (the engine version that last opened it), `backups/<version>-<UTC>/{db,engine-version.json}`
(taken before a different engine version opens it; newest 3), `.rivetkit/` (rivetkit's engine logs and runtime stamp,
via `RIVETKIT_STORAGE_PATH`) and, on 6420, `migrated-from-rivetkit.json` (the one-time copy from `~/.rivetkit`).
Nothing reads or writes `~/.rivetkit`. When you run a daemon by hand, give it `CAPCOMD_ENGINE_DATA` and its own
`--port`/`CAPCOMD_ENDPOINT`; `capcomd serve` on 6420 with no override is the user's real data.

Persisted settings (`capcomd setup` writes them): `~/.capcomd/config.json` and the nearest `.capcomd/config.json` from
the current directory are environment defaults, applied by `src/cli/apply-config.ts` before anything else loads
(a real env var wins; the boxd key comes from the OS keychain). `bun test` preloads `tests/helpers/isolate-config.ts`
(`CAPCOMD_NO_CONFIG=1`), so a developer's own settings never reach the engines and CLIs tests start (Testing, below, has
the rest of what it isolates).

## Architecture

Design documents live in `docs/`. Start with:
- `adr-016-composable-primitives.md` - the primitives and the `capcomd run` recipe
- `adr-017-subagents-in-vm.md` - agents orchestrating agents from inside their VMs
- `adr-018-agent-plugins.md` - capcomd as a plugin for your agent: MCP tools, skills, the driver role
- `adr-019-agents-report-up.md` - (proposed) agents report up to their parents; turn, time and money limits are optional
- `adr-022-agent-lifecycle-workflow.md` - an agent's lifecycle as a Rivet workflow in its worker actor (the default; `CAPCOMD_AGENT_WORKFLOW=0` on the engine brings back `agent-drive` processes for one release), and the rule for changing the workflow
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

### State machines

- **Task**: pending → leased → running → handed_off → verifying → merged
- **Lease**: free → held (with epoch-guarded heartbeats) → released/expired
- **Worker**: provisioning → idle → busy → draining → destroyed
- **Run**: planning → executing → judging → completed

### Project structure

```
src/
  actors/       - Rivet actors (run, scope, worker, verifier, planner, taskboard, judge)
  agents/       - Claude Code / Codex adapters, credentials, the agent runner
  auth/         - subscription logins (auth login/status/logout)
  context/      - the context layer (ADR-025): brief.ts, the router that builds an agent's brief from its profile's
                  context providers; memory.ts, the project layer's provider (`.capcomd/context/` read through the
                  files mirror); limits.ts, the brief's budgets (limits.gen.ts: the eval's docs/evidence/context/
                  <model>/limits.json, regenerated with `bun scripts/gen-context-limits.ts`); providers.ts, the active
                  providers by name; capture.ts, the candidates an agent's result.data.context makes; scan.ts, the
                  seeded secret scan that refuses (capture and lint); lint.ts, `capcomd context lint` and index.md;
                  skills.ts and skills/, the doctrine and routing skills the router attaches;
                  consolidate.ts, how a consolidator's answer is staged as files (pure); consolidator.ts, its kernel
                  side (its inputs, its model, the commit on its branch); promotion.ts, what the gates judge of a
                  branch that changes .capcomd/context/; groundray.ts, a brain's provider and the project's brain
                  mappings (`capcomd context brain`); groundray-write.ts, its write path (a draft through the groundray
                  CLI in a throwaway authoring clone, its proposal branch and pull request); brain-proposals.ts, a run's
                  proposals to a brain (kept, and sent as a person or as capcomd); project.ts, the project's `context` settings and their copy
                  kept with a run
  cli/          - the CLI: index.ts, the dispatcher (serve, plugins, help, version, tui itself; every other command a
                  front door's registration, front-doors.ts); groups/, the kernel's commands by group; flags.ts, help.ts;
                  commands/, what they call
  core/         - client, errors, preflight, VM cleanup checks
  engine/       - engine launcher (per-port data dir, pid file)
  install/      - installable packages (plugins now, profile packages next, ADR-024 step 7): source.ts, owner/repo#name@ref;
                  fetch.ts, a package's directory written out of a fetched commit (host-git.ts fetches); lock.ts, LOCK and
                  the content hash; trust.ts, the operator's trust per content hash and place (~/.capcomd/trust.json)
  env/          - env snapshots, secrets sync, doctor
  jobs/         - background jobs and timers (plugin API §16.2): service.ts, the records (a run's kv `_jobs/`, the
                  daemon's state/jobs/), limits, ctx.jobs, the job.changed hook, timers; machine.ts, a job's detached
                  runner in its agent's machine, reached through the agent's spool pump's exec (subagents/driver.ts)
  machines/     - XState state machines
  mcp/          - MCP server (server.ts: serves the registered tools; tools.ts: capcomd's own, front-mcp's)
  merge/        - git: direct and PR merge modes, verification runs (checks in a VM with boxd)
  models/       - model client (fake only, see STATUS.md)
  plugins/      - the kernel's plugin host (ADR-023): the built-in list (builtin/: the sandbox providers; gate-reviewer/,
                  the reviewer gate), what `capcomd serve` starts before the API opens, and the listing `capcomd plugins
                  list` reads; hooks.ts, what the kernel's hook sites share (silent unless a plugin listens); changes.ts,
                  the `*.changed` hooks from the scope actor's events; sandbox.ts, the sandbox hooks around every
                  provider. Tests load a plugin directory as a built-in with CAPCOMD_TEST_PLUGINS (only under `bun test`;
                  a CLI's verify loads them with the built-in gates too); sandboxes.ts, the sandbox seams the kernel asks
                  for a provider by name (`capcomd plugins validate --conformance <name>` runs one's suite); front/, the
                  front doors (the CLI's groups, front-mcp, front-hermes), skill-orchestration.ts, the orchestration
                  skill as an agent.preparing patch, context.ts, the context router's listeners (the brief, capture)
                  and `capcomd context`, and context-memory.ts and context-groundray.ts, the `memory` and `groundray`
                  context providers (context-memory.ts also the gates that keep the memory: verify.judging,
                  merge.landing): every process loads them (host.ts `localHost`);
                  sources/, trigger sources (source-schedule, and timer.ts, a source's timer kept across restarts and
                  setting changes; forge-github's own is forges/github-source.ts); process.ts, how the daemon starts an
                  out-of-process plugin (filtered env, its token, its log, the chaos killpoints); storage.ts, a plugin's
                  private storage; watchdog.ts, the daemon's watchdog (off until `capcomd setup` turns it on); config.ts,
                  a plugin's settings from the user's and the project's config and CAPCOMD_PLUGIN_<NAME>_<KEY>;
                  services.ts, the daemon's `ctx.agents`; lifecycle.ts, whether the plugins a profile's `lifecycle`
                  names are there to hear its agents. The user's plugins (~/.capcomd/plugins/<name>) run out of
                  process; install.ts, `capcomd plugins install|update|remove|trust|allow-version` (plugin API
                  §4.8): ~/.capcomd/plugins/<name>/ with its LOCK, a project's `plugins.use` fetched to
                  ~/.capcomd/plugins/.project/<key>/, exemptions in ~/.capcomd/plugins/compatibility.json;
                  run-config.ts, a run's per-run plugin settings (`--plugin-config`, POST /v1/runs `plugins`) in the
                  plugin's run storage
  primitives/   - ADR-016 operations, policy, task board, kv
  profiles/     - agent profiles (ADR-024): the flat v1 spec every profile pins (v1.ts), the v2 manifest (v2.ts), the
                  layers a name resolves through, project, user, bundled (load.ts), a profile's skills, read and
                  hashed (skills.ts), what an agent is pinned with beside the flat spec: MCP servers, sandbox,
                  environment, size, lifecycle plugins (runtime.ts), resolution, pins and overrides (resolve.ts), and
                  what `capcomd profiles`, GET /v1/profiles and a planner read of each: the files and values, title,
                  tags, fit, cost (describe.ts)
  providers/    - sandbox providers (docker, boxd, fake) behind their plugins; seam.ts, the seam and kernel shapes
  recipes/      - `capcomd run` composed from the primitives
  subagents/    - ADR-017 RPC, tokens, in-VM CLI, driver, results
  triggers/     - the trigger intake (plugin API §16.3): intake.ts, what the daemon does with a source's trigger (dedupe,
                  a followed thread, the operator's gate, trigger.admitting, the accept mode, a run), subscriptions,
                  ctx.triggers; its records in the daemon's state/triggers/ (`capcomd triggers log` reads log.ndjson)
  utils/        - lifecycle, killpoints, tracing, state paths
apps/
  canvas/       - web UI (capcomd ui)
  tui/          - terminal debugger
  menubar/      - the macOS app (SwiftUI: the window and the menu bar item); its README says how to run it and build capcomd.app
packages/
  agent-thread/ - agent CLI streams (Claude stream-json, Codex --json) → harness.v1 thread items with a sanitized
                  blocks/1 tree; pure functions (no imports from src/), own tsconfig, tests and golden fixtures
  bot-avatar/   - (proposal) deterministic pixel bot avatars: agent id + role + size → SVG, from a parts catalog;
                  pure, no dependencies; catalog.json and golden bots for the Swift renderer
  plugin/       - @capcomd/plugin (private): the plugin API's manifest schema and loading, context, hook registry,
                  seams, protocol and its client library (client.ts `connect`), the host's machinery (src/host/: states,
                  order, dispatch, breaker, process.ts the out-of-process runtime) and the test
                  kit, with worked examples; normative spec in docs/spec/plugin-api.md. The kernel fires hooks only
                  as `hooks.fire("<hook>", "<mode>", …)`; `bun scripts/check-hook-modes.ts` (run by test:fast)
                  checks each site's mode against HOOKS
tests/          - unit, scenario, agent and merge suites
scripts/        - live e2e scripts (boxd + GitHub) and helpers
docs/           - design documents and ADRs
```

## Testing

```bash
bun run typecheck
bun run test:fast              # unit, CLI, setup/config, state machines, tracing, auth, env, MCP, plugins, packages/*
bun run test:apps              # apps/canvas and apps/tui
bun run test:scenarios         # the regression suite: scenarios, sub-agents, primitives, agent adapters, merges
bun run test:scenarios:timings # the same, then refresh tests/scenario-timings.json from this machine's times
bun evals/primitives/run.ts    # deterministic evals (fakes): the primitives' recipes against their latency baseline
bun evals/recipe-parity/run.ts #   and `capcomd run --recipe` against `--legacy`
```

What CI runs, and where (`.github/workflows/`):

| Job | Runs |
|---|---|
| `ci.yml` test | contract and title-shim checks, typecheck, `test:fast`, `test:apps` |
| `ci.yml` scenarios (7 shards) | `test:scenarios`, balanced by `tests/scenario-timings.json` |
| `ci.yml` evals | both evals above (the primitives eval with `--report-latency`: its baseline is a developer machine's, so on a shared runner a slow case is printed, not failed), and the context eval on the fake sandbox (`--seed 1 --expect` with every runnable arm, below) |
| `ci.yml` binary | the Linux single executable, installed and driven (`scripts/release-smoke.sh`) |
| `menubar.yml` macos | the Swift client and app tests (`swift test`), when the app, the contract or a file its tests read changes |
| `release.yml` test | typecheck, `test:fast`, `test:apps` and `test:scenarios` on Linux and macOS, unsharded |

Every `*.test.ts` in the repository is in one of them. Gated off by default, because they need real accounts or VMs:
`tests/merge/github-live.test.ts` (`CAPCOMD_GH_LIVE=1`: a throwaway private GitHub repo through `gh`) and
`tests/agents/egress.live.test.ts` (`CAPCOMD_BOXD_LIVE=1` and `BOXD_API_KEY`: a boxd VM's egress allowlist), and the
live scripts below. A new test file goes in a directory one of the scripts lists (or the script gets the directory).

Each scenarios shard uploads the per-file times it measured (artifact `scenario-timings-N`);
`bun scripts/scenario-timings.ts <run id>` merges a CI run's into `tests/scenario-timings.json`, so the shards are
balanced by the runner's times (a file without one gets an estimate; `--check` lists those).

Both scripts run with `bun test --isolate`: every file gets a fresh global, module registry and environment, and the
preload (`tests/helpers/isolate-config.ts`) runs again for it, so nothing one file sets leaks into the next. For each
file it sets a scratch `CAPCOMD_HOME` (a fresh temp dir, whatever the environment had), `CAPCOMD_ENDPOINT` to a closed
port and `CAPCOMD_NO_ENGINE_AUTOSTART=1` (a test that forgets its engine fails as "engine unreachable" instead of asking
a developer's daemon on :6420, and nothing starts an engine for it), and it installs `tests/helpers/guard.ts` there and,
through `BUN_OPTIONS`, in every bun process a test starts: a connection to 127.0.0.1:6420, :6421 or :6430, or a write
under the real `~/.capcomd`, throws, and fails the file even when the code swallowed the error
(`tests/unit/test-isolation.test.ts` shows it). A test that needs its own home, endpoint or the autostart sets them.

`packages/agent-thread` has no install of its own: its dependencies are the root's (one zod for the daemon's contract
and the package), and `bun run typecheck` / `test:fast` cover it. Its golden files
(`packages/agent-thread/fixtures/golden/*.items.json`, decoded by the Swift renderer too) are generated from the fixture
sessions next to them; after an intended change to the thread output, refresh them with
`bun packages/agent-thread/scripts/golden.ts` (the tests fail while they are stale). Keep new fixtures small.
`packages/bot-avatar` works the same way: its `fixtures/catalog.json` and `fixtures/golden/bots.json` refresh with
`bun packages/bot-avatar/scripts/golden.ts`; a change to any golden bot means existing agents get a new face.

The engine-backed tests run on macOS and Linux (Linux reads `/proc`; macOS uses `ps`/`lsof`). On a Mac, run long
suites under `caffeinate -i`: a sleeping machine times tests out and can leave an orphaned `rivet-engine`.

### Live end-to-end

`scripts/mac-subagents-e2e.sh` runs a planner agent that splits a three-file fix across Claude and Codex workers
in boxd VMs, verifies each (checks in a VM, then a reviewer agent), merges them, runs the full suite on the
result and checks that no VM is left. It needs `BOXD_API_KEY`, `gh` and working Claude and Codex logins, creates
a private GitHub repo (it prints the delete command) and ends with `E2E PASS` or `E2E FAIL: <reasons>`.

`scripts/mac-plugin-e2e.sh` is the same goal driven the way users drive capcomd: a headless Claude Code session
loads `plugins/capcomd` and may use only the plugin's MCP tools and skills (no shell, no edits). It needs `claude`
logged in as well, and fails if the session used any other tool.

### Team-shape eval

`scripts/eval-team-shape.ts` checks how a real Claude Code driver organizes a team from capcomd's steering (the
orchestration skill, the MCP server's instructions and tool results, the profiles `capcomd setup` writes). A headless
`claude -p --model sonnet` session gets the tinycalc request (a mid-size build that asks for parallel work, shared
pieces first and careful reviews), with the plugin loaded by `--plugin-dir` (a scratch copy without its own MCP server)
and this checkout's `capcomd mcp` by `--mcp-config --strict-mcp-config`. It talks to a scratch engine on its own port
with the fake sandbox and scripted agents (`CAPCOMD_SPAWN_EXEC=script`): workers take `--worker-seconds` (45) and
commit a placeholder, a lead or planner splits its part between two helpers and verifies and merges them, the reviewer
passes; the repository is a local bare repo. Only the driver uses a model. Afterwards it prints the tree, the driver's
spawns by phase (a phase starts after a merge landed), peak agents at once against the slots (`--slots`, 7), the
phase of the parser, printer, CLI and end-to-end work (`consumersOnStubs`: the CLI started no later than the parser),
the wall time and the driver's cost.

```bash
bun scripts/eval-team-shape.ts --out after.json                    # this checkout
bun scripts/eval-team-shape.ts --ref origin/main --port 6531       # capcomd as it is on origin/main (git archive)
```

Everything is in one scratch folder (`CAPCOMD_EVAL_TMP`, else the system temp dir), deleted at the end (`--keep`
keeps it, with `session.ndjson`, `events.json` and the engine's `engine.log`). It never uses `~/.capcomd`, :6420, Docker or your Claude Code
settings (`--setting-sources project`, `--no-session-persistence`); it needs `claude` logged in. Runs vary: compare a
few of each. Two at once need ports at least 20 apart (an engine takes its port, the next and port+10).

### Context eval

`scripts/eval-context.ts` measures what an agent gets beyond its task (ADR-025 §12): nothing, an `AGENTS.md`, and,
as the context layer's build steps land, the router's brief, project memory and a company brain. It generates a
fictional company from a seed (`scripts/eval-context/world.ts`: a small Node shop repository, its business records
with one superseded each, meeting notes, a carriers file with an instruction planted in it; `world.yaml` is the
source of truth), gives every arm the same repository plus the arm's files (`arms.ts`), and runs five task chains
(`tasks.ts`) the way a user does, with `run new`, `spawn` and `await`: (a) one agent finds a fact buried in the docs
and a second in the same run needs it; (b) a fix whose cause is a repository convention lands (verify, merge) and a
fresh run writes new code where it applies; (c) a business rule only the company knows, superseded once, cited; (d)
a stale comment in the code against the current record; (e) the planted instruction. A hidden Node checker scores
each step with `capcomd check` on the agent's branch, in a sandbox like verify's, and names the answer's class
(current, superseded, other, …); the planted instruction is its own probe. Metrics per step: tool calls and
re-discovery (reads of the fact's file) from `capcomd logs`, turns, tokens, the cache-read ratio, cost (notional on
a plan login) and the model the CLI reported, from the agent's span.

The arms past the baselines are the router's brief over a hand-written `.capcomd/context/` (`index`; its records, the
two lessons the tasks need and, with `--memory project`, the default, the rest of a project's memory:
`world.ts` `otherRecords`) and what ADR-025 step 6 asked of it, delivered by the harness the way the kernel would
(`scripts/eval-context/deliver.ts`): `index-paths` (no `paths` column), `index-k1` and `index-k3` (the brief's first
k items, whole and fenced, in the agent's first message) and `index-triggered` (an item pushed as a fenced message
the first time the agent touches a path it applies to; Claude Code only, a Codex agent can't read a message while it
runs). `report.ts` `admission` answers each against `index` by fixed rules, and a run on a project's memory writes the
answers into the model's `limits.json` (`inlineItems`, `triggeredInjection`, `decisions`); `--memory small` (only
what the tasks need) is reported, never decides.

```bash
bun scripts/eval-context.ts --seed 1 --expect --arms none,agents-md,index,index-paths,index-k1,index-k3,index-triggered   # fake (CI, ~1 min)
bun scripts/eval-context.ts --list                     # the arms, chains and pending probes, and which are runnable
CAPCOMD_HOME=<a home with your logins> BOXD_API_KEY=… \
  bun scripts/eval-context.ts --agents live --models claude-opus-5-5,gpt-6.1-sol --reps 3 --port 6571 --evidence docs/evidence/context
```

`--agents fake` runs on the fake-host sandbox with `scripts/eval-context/fake-agent.ts` as `claude`: a deterministic
agent that reads only its checkout and its prompt (the instruction file when there is one, the context brief's lines and
the files they name when its profile has one, else the stub's stale comment and the docs), so `--expect` knows every verdict and fails when an arm, a checker or a metric stops working. `--agents live`
runs real Claude Code or Codex agents (one profile per `--models` entry, plan logins) on `--sandbox` (boxd by default,
or docker); a Codex model must be one the login offers (`~/.codex/models_cache.json` lists them). Give it a
`CAPCOMD_HOME` of its own with copies of your logins (`state/auths.json`, `state/envs.json`), never `~/.capcomd`
itself (refused). `--evidence DIR` writes `DIR/<model>/<date>.json` (`<date>-2.json` and so on for another run that
day: evidence is never overwritten) and, the first time, the model's `limits.json` (ADR-025 D4's starting values until
an arm measures them). The world itself isn't written there: the seed and the
recorded commit give it back, and its carriers file holds the planted instruction. The router reads a model's
`limits.json` from a generated copy: after the eval writes one, run `bun scripts/gen-context-limits.ts` (CI checks
it with `--check`). The seed defaults to today's date
(UTC), so a run on a new model release gets names and numbers no model has seen; re-run the live baselines on every
release and commit them. Everything else (the engine's data, bare repositories, traces, `world.yaml`) is in one
scratch folder (`CAPCOMD_EVAL_TMP`, else the system temp dir, or a new or empty `--work`), deleted at the end unless
`--keep` (which keeps `steps/<model>-<arm>-<rep>-<step>.json`: each agent's record and log). Ports as for the
team-shape eval.

### Killpoints

`CAPCOMD_KILLPOINT=<name>[:n]` kills the process (SIGKILL) the n-th time it reaches a named point, which the merge
and workflow tests use to check that a crashed step resumes. Named killpoints:

- `tx.mid` - Kill during transaction
- `model.after_return.before_commit` - Kill after model call
- `merge.before_cas` - Kill before merge CAS
- `merge.after_cas.before_event` - Kill after CAS, before event
- `push.mid`, `push.after.before_event` - Kill during or after a branch push
- `plugin.hook.mid` - Kill the daemon right after it sent a gate or modify call to an out-of-process plugin
- `plugin.process.crash` - Kill the plugin's process (not the daemon) at the same point: the call is `crashed`, denied
- `vm.create.after_request.before_record` - Kill during VM creation
- `lease.expire.mid` - Kill during lease expiry
- `budget.charge.mid` - Kill during budget charge

## Cutting a release

CI builds releases (`.github/workflows/release.yml`); [AGENTS.md](AGENTS.md) has the rules (Semantic Versioning,
the changelog, what never to do by hand). By hand, before tagging:

1. In a `release: vX.Y.Z` commit, bump `version` in `package.json` and in both plugin manifests under
   `plugins/capcomd/`; in `CHANGELOG.md`, rename `## Unreleased` to
   `## X.Y.Z (YYYY-MM-DD)` and add a new empty `## Unreleased` above it (CI checks both stay in step:
   `bun scripts/release-notes.ts --check`). `bun scripts/release-notes.ts vX.Y.Z` prints the release notes, or why
   it can't.
2. Run the live e2e (`scripts/mac-subagents-e2e.sh`, `E2E PASS`); CI can't (it needs boxd, GitHub and agent logins).
   Optionally `bun pm pack && scripts/release-smoke.sh capcomd-X.Y.Z.tgz X.Y.Z`, and
   `bun scripts/build-binary.ts && scripts/release-smoke.sh dist/capcomd-<os>-<arch> X.Y.Z` (the install checks CI runs).
3. Merge to `main`, let CI pass, then tag that commit: `git tag -a vX.Y.Z -m "capcomd X.Y.Z" <sha> && git push origin vX.Y.Z`.

The tag runs the release workflow: it checks the tag is on `main`, matches `package.json` and has a changelog
section; runs typecheck, `test:fast`, the canvas and TUI tests and `test:scenarios` on Linux and macOS; packs the package and
installs it with a fresh `HOME` on both (`scripts/release-smoke.sh`: `setup demo`, a run
with fake agents, `setup check`, the service definition, state only in `~/.capcomd`); then publishes that package
to npm and the GitHub release with `capcomd-X.Y.Z.tgz`, the four binaries, their `.sha256` files and the changelog
section. Any failure publishes nothing; fix, then
re-run the workflow (Actions → Release → Run workflow, with the tag), which updates the release in place. Moving a
tag that's already published needs `git push --force origin vX.Y.Z` and is best avoided: cut X.Y.Z+1 instead.

npm: the workflow publishes the exact package it tested, with provenance, under the `latest` dist-tag (`next` for
`X.Y.Z-rc.N`). It authenticates with the repository secret `NPM_TOKEN` (an npm automation token), or with npm
trusted publishing once that's configured for this repository on npmjs.com (then the secret can go). A version
that's already on npm is skipped, so re-runs are safe. Never `npm publish` by hand.

Binaries: the workflow builds the single executable for darwin-arm64, darwin-x64, linux-x64 and linux-arm64 on one
Linux runner (`scripts/build-binary.ts --target T`), then installs each with `install.sh` and drives it without Bun
on a runner of its own platform (`scripts/release-smoke.sh dist/capcomd-T X.Y.Z`; on macOS arm64 it also installs
the Homebrew formula from a throwaway tap). They go on the release with their `.sha256` files, which is where
`install.sh` and `capcomd upgrade` download from. Last, for a non-prerelease, it commits `Formula/capcomd.rb`
(`scripts/homebrew-formula.ts`) to MarvinAmador7/homebrew-tap with the `HOMEBREW_TAP_DEPLOY_KEY` secret (the private
half of an SSH deploy key with write access to that repository only); without the secret it warns and skips that
step.

### The single executable

`bun scripts/build-binary.ts [--target darwin-arm64|darwin-x64|linux-x64|linux-arm64]` writes
`dist/capcomd-<target>` (210–240 MB) and its `.sha256`. Any target builds on any host: its native parts (rivetkit's
addon and rivet-engine) are the installed packages for the host's platform, or are fetched from npm at the same
versions and checked against the registry's integrity hash. What makes it work, if you change something nearby:

- Everything capcomd reads from its own package at run time is bundled: `src/utils/assets.ts` (the in-VM supervisor
  and CLI, the engine launcher, the orchestration skill) and the version (`src/utils/self.ts`). Don't add
  `readFileSync(new URL(…, import.meta.url))` for a package file; import it there.
- capcomd starting itself (the engine, drivers, `run --detach`, the service) goes through `selfArgv()`: the binary
  runs itself, a checkout runs `bun src/cli/index.ts`.
- rivetkit loads its native runtime and engine resolver by computed names; the build's plugin spells them out so
  they're bundled, and fails the build if it can't find them. The engine is extracted to
  `~/.capcomd/bin/<version>/` on first `serve` (`onDisk`), since the OS can't run a file inside the binary.
- The binary never reads a `.env` or `bunfig.toml` from the directory it's run in.

CI builds the Linux binary and drives it on every pull request (the `binary` job).

## Naming (renamed from relay)

The CLI was renamed from `relay` to `capcomd` on 2026-10-18.
- Binary / package: `capcomd`. MCP tools: `capcomd_*` (the list is in `docs/integration-agents.md`).
- Env: `CAPCOMD_*` (`CAPCOMD_ENDPOINT`, `CAPCOMD_SANDBOX`, `CAPCOMD_PROTECTED_BRANCHES`, `CAPCOMD_TRACE`, `CAPCOMD_TRACE_DIR`, `CAPCOMD_KILLPOINT`, `CAPCOMD_BOXD_DB`). The old `RELAY_*` names still work as deprecated aliases and print one warning on stderr (silence with `CAPCOMD_NO_DEPRECATION_WARNINGS=1`).
- Deliberately unchanged, for compatibility: actor names, the `relay.v1` JSON schema id, `relay.*` span attribute keys in traces, the `.relay/` state directory, and the `relay-` boxd VM name prefix (existing idempotency keys stay stable).
