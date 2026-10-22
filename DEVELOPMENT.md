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
logs, driver pids), `.traces/` (spans) and `.capcomd/agents.json`. An installed CLI, or any CLI with
`CAPCOMD_HOME` set, uses `~/.capcomd` (`state/`, `traces/`, `agents.json`). `src/utils/home.ts` decides; the
per-file overrides (`CAPCOMD_AUTH_LEDGER`, `CAPCOMD_ENV_LEDGER`, `CAPCOMD_TRACE_DIR`, `CAPCOMD_AGENTS_FILE`,
`CAPCOMD_BOXD_DB`) win. Tests that touch these must set their own (a saved login in `.relay/` changes outcomes).

Persisted settings (`capcomd setup` writes them): `~/.capcomd/config.json` and the nearest `.capcomd/config.json` from
the current directory are environment defaults, applied by `src/cli/apply-config.ts` before anything else loads
(a real env var wins; the boxd key comes from the OS keychain). `bun test` preloads `tests/helpers/isolate-config.ts`
(`CAPCOMD_NO_CONFIG=1`), so a developer's own settings never reach the engines and CLIs tests start.

## Architecture

Design documents live in `docs/`. Start with:
- `adr-016-composable-primitives.md` - the primitives and the `capcomd run` recipe
- `adr-017-subagents-in-vm.md` - agents orchestrating agents from inside their VMs
- `adr-018-agent-plugins.md` - capcomd as a plugin for your agent: MCP tools, skills, the driver role
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
  agents/       - Claude Code / Codex adapters, profiles, credentials, the agent runner
  auth/         - subscription logins (auth login/status/logout)
  cli/          - CLI commands
  core/         - client, errors, preflight, VM cleanup checks
  engine/       - engine launcher (per-port data dir, pid file)
  env/          - env snapshots, secrets sync, doctor
  machines/     - XState state machines
  mcp/          - MCP server
  merge/        - git: direct and PR merge modes, verification runs (checks in a VM with boxd)
  models/       - model client (fake only, see STATUS.md)
  primitives/   - ADR-016 operations, policy, task board, kv, the reviewer
  providers/    - sandbox providers (boxd, fake)
  recipes/      - `capcomd run` composed from the primitives
  subagents/    - ADR-017 RPC, tokens, in-VM CLI, driver, results
  utils/        - lifecycle, killpoints, tracing, state paths
apps/
  canvas/       - web UI (capcomd ui)
  tui/          - terminal debugger
tests/          - unit, scenario, chaos, agent and merge suites
scripts/        - live e2e scripts (boxd + GitHub) and helpers
docs/           - design documents and ADRs
```

## Testing

```bash
bun run typecheck
bun run test:fast              # unit, CLI, setup/config, state machines, tracing, auth, env, MCP (~1 min)
bun run test:scenarios         # sub-agent scenarios, primitives policy (the CI regression suite)
bun test tests/agents tests/primitives tests/merge
(cd apps/tui && bun test)
```

The engine-backed tests run on macOS and Linux (Linux reads `/proc`; macOS uses `ps`/`lsof`). On a Mac, run long
suites under `caffeinate -i`: a sleeping machine times tests out and can leave an orphaned `rivet-engine`. Run
test files one per `bun test` process when in doubt; a few still interfere when they share one.

### Live end-to-end

`scripts/mac-subagents-e2e.sh` runs a planner agent that splits a three-file fix across Claude and Codex workers
in boxd VMs, verifies each (checks in a VM, then a reviewer agent), merges them, runs the full suite on the
result and checks that no VM is left. It needs `BOXD_API_KEY`, `gh` and working Claude and Codex logins, creates
a private GitHub repo (it prints the delete command) and ends with `E2E PASS` or `E2E FAIL: <reasons>`.

### Chaos tests

```bash
bun run test:chaos             # named killpoints and seeded iterations (long)
bun run chaos:fast             # parallel workers; strict when CI=true

# Run with a specific killpoint
CAPCOMD_KILLPOINT=tx.mid:1 bun test tests/chaos/killpoints.test.ts
```

Named killpoints:

- `tx.mid` - Kill during transaction
- `model.after_return.before_commit` - Kill after model call
- `merge.before_cas` - Kill before merge CAS
- `merge.after_cas.before_event` - Kill after CAS, before event
- `push.mid`, `push.after.before_event` - Kill during or after a branch push
- `vm.create.after_request.before_record` - Kill during VM creation
- `lease.expire.mid` - Kill during lease expiry
- `budget.charge.mid` - Kill during budget charge
- `outbox.dispatch.after_send.before_ack` - Kill during outbox dispatch

## Cutting a release

CI builds releases (`.github/workflows/release.yml`); [AGENTS.md](AGENTS.md) has the rules (Semantic Versioning,
the changelog, what never to do by hand). By hand, before tagging:

1. In a `release: vX.Y.Z` commit, bump `version` in `package.json`; in `CHANGELOG.md`, rename `## Unreleased` to
   `## X.Y.Z (YYYY-MM-DD)` and add a new empty `## Unreleased` above it (CI checks both stay in step:
   `bun scripts/release-notes.ts --check`). `bun scripts/release-notes.ts vX.Y.Z` prints the release notes, or why
   it can't.
2. Run the live e2e (`scripts/mac-subagents-e2e.sh`, `E2E PASS`); CI can't (it needs boxd, GitHub and agent logins).
   Optionally `bun pm pack && scripts/release-smoke.sh capcomd-X.Y.Z.tgz X.Y.Z` (the install check CI runs).
3. Merge to `main`, let CI pass, then tag that commit: `git tag -a vX.Y.Z -m "capcomd X.Y.Z" <sha> && git push origin vX.Y.Z`.

The tag runs the release workflow: it checks the tag is on `main`, matches `package.json` and has a changelog
section; runs typecheck, `test:fast`, the TUI tests and `test:scenarios` on Linux and macOS, and one strict chaos
round; packs the package and installs it with a fresh `HOME` on both (`scripts/release-smoke.sh`: `setup demo`, a run
with fake agents, `setup check`, the service definition, state only in `~/.capcomd`); then publishes that package
to npm and the GitHub release with `capcomd-X.Y.Z.tgz`, its `.sha256` and the changelog section. Any failure publishes nothing; fix, then
re-run the workflow (Actions → Release → Run workflow, with the tag), which updates the release in place. Moving a
tag that's already published needs `git push --force origin vX.Y.Z` and is best avoided: cut X.Y.Z+1 instead.

npm: the workflow publishes the exact package it tested, with provenance, under the `latest` dist-tag (`next` for
`X.Y.Z-rc.N`). It authenticates with the repository secret `NPM_TOKEN` (an npm automation token), or with npm
trusted publishing once that's configured for this repository on npmjs.com (then the secret can go). A version
that's already on npm is skipped, so re-runs are safe. Never `npm publish` by hand.

A standalone binary (`bun build --compile`) builds, but `serve` doesn't work compiled yet (ROADMAP.md).

## Naming (renamed from relay)

The CLI was renamed from `relay` to `capcomd` on 2026-10-18.
- Binary / package: `capcomd`. MCP tools: `capcomd_run`, `capcomd_status`, `capcomd_cancel`, `capcomd_events`, `capcomd_trace`, `capcomd_approve`.
- Env: `CAPCOMD_*` (`CAPCOMD_ENDPOINT`, `CAPCOMD_SANDBOX`, `CAPCOMD_PROTECTED_BRANCHES`, `CAPCOMD_TRACE`, `CAPCOMD_TRACE_DIR`, `CAPCOMD_KILLPOINT`, `CAPCOMD_BOXD_DB`). The old `RELAY_*` names still work as deprecated aliases and print one warning on stderr (silence with `CAPCOMD_NO_DEPRECATION_WARNINGS=1`).
- Deliberately unchanged, for compatibility: actor names, the `relay.v1` JSON schema id, `relay.*` span attribute keys in traces, the `.relay/` state directory, and the `relay-` boxd VM name prefix (existing idempotency keys stay stable).
