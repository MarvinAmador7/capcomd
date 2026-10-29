# capcomd

[![CI](https://github.com/MarvinAmador7/capcomd/actions/workflows/ci.yml/badge.svg)](https://github.com/MarvinAmador7/capcomd/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/capcomd)](https://www.npmjs.com/package/capcomd)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**Durable orchestration for swarms of coding agents, driven by your agent.**

Give your coding agent capcomd (a skill and a CLI, or an MCP server) and ask for the outcome. Your agent becomes
the orchestrator: it splits the work, spawns a team of Claude Code and Codex agents that run in parallel, each in
its own isolated VM on its own branch, and lands only the work that passed checks you defined and a review by
another agent, as the exact commit that was tested. Runs are durable: agents keep working when your agent's session
ends, a crash or a restart resumes where it stopped, and every merge happens exactly once.

> **Early release (0.x).** The primitives, sub-agents, verification, review and durability are built and verified
> live; expect changes between minor versions. Your agent drives capcomd through the plugin (MCP tools and
> skills) or the CLI. See [STATUS.md](STATUS.md) and
> [ROADMAP.md](ROADMAP.md).

## How you use it

You don't run orchestration commands by hand. You tell your agent what you want:

> Use capcomd to fix the failing tests in `src/`: one worker per file, each verified and reviewed, then merged.

Your agent does the rest with capcomd's primitives (`spawn`, `await`, `verify`, `merge`, a task board and a shared
blackboard), and you watch, approve merges into protected branches, or step in:

```
 you ──▶ your agent (Claude Code, Codex, …) + capcomd skill/CLI/MCP
              │  plans, then spawns a swarm in parallel, each in its own VM and branch
              ├──▶ worker: parser ─┐
              ├──▶ worker: tests    ├──▶ verify ──▶ your checks (in a fresh VM)
              └──▶ worker: docs   ─┘        └──▶ reviewer agent (read-only)
                                                  │ both pass
                                                  ▼
                               merge the exact tested commit ──▶ your branch
                               (protected branch: waits for your approval)
```

Workers can be orchestrators too: an agent allowed to delegate gets the same primitives inside its VM and runs
its own sub-team, within limits you set.

## Why

Coding agents are fast, but on their own they are hard to trust and hard to scale:

- **They report success, not proof.** "All tests pass" is a claim until something else runs the tests.
- **Parallel agents collide.** Several agents on one checkout overwrite each other, and their changes conflict on
  the way in.
- **Delegation multiplies risk.** An agent that spawns agents can spend without limit and approve its own work.
- **Long runs break.** A crash or a dropped session halfway through a multi-agent run loses the work, or merges it
  twice.
- **You can't see what happened.** Who did what, in what order, at what cost, and why it failed.

capcomd treats each of these as a hard rule rather than a hope.

## What you get

**Durable runs.** A run is a set of durable actors (built on [Rivet](https://rivet.dev)) whose state survives
crashes and restarts. Every step is an idempotent, recorded transition, so a crashed orchestrator, engine or agent
driver resumes where it stopped, a retried call never acts twice, and a merge happens exactly once. A chaos suite
kills the process at named points, and at random, to prove it.

**Isolation.** Every agent runs in a fresh VM with its own clone and branch; VM snapshots are scrubbed of secrets.
Agents can't touch each other's work or your machine, and never hold push credentials. Inside its VM an agent is
unrestricted by default (every tool, open network); a profile can narrow its tools, sandbox and egress allowlist.

**Verification you control.** You name the checks (`run new --checks-set unit='bun test'`); agents pick one by
name and can never write their own. Checks run on the branch merged with the latest target, in a throwaway VM, so
agent-written code never executes on your host. A merge lands only the exact commit that passed.

**Review by another agent.** Set a reviewer for the run (`--reviewer`) and every change that passes its checks is
also read by a separate, read-only reviewer agent against acceptance criteria. Both must pass; a missing or
garbled verdict is a fail.

**Agents that delegate, safely.** You set the ceiling (depth, fan-out, allowed profiles, budget share); a parent
can only narrow it for its children. Capability tokens scope every call, and text from other agents is treated as
data, never instructions.

**Budgets and cost.** Budgets in dollars, turns and wall time are carved down the tree. Costs roll up per agent and
subtree, including the API-equivalent cost of work on Claude and ChatGPT subscription plans.

**You stay in charge of what lands.** Merges into protected branches wait for your approval. A run can land on its
own staging branch instead of `main`.

**See everything.** A terminal debugger shows the agent tree (what ran in parallel, each child's checks → review →
merge), a span waterfall, per-agent timelines, rollups and the event log, live while the run executes.

### VMs come from a sandbox provider

capcomd doesn't depend on one VM vendor. It creates, runs commands in, snapshots and destroys VMs through a small
sandbox provider interface ([`src/providers/sandbox.ts`](src/providers/sandbox.ts)): create from a snapshot, exec,
upload and download, egress allowlist, checkpoint and snapshot, suspend and resume, destroy. The orchestration,
durability and gates sit above it.

[boxd](https://boxd.sh) is the first provider, and the one verified live. A local fake provider runs everything
on your machine with scripted agents, for tests and the setup demo (it isolates nothing). More providers, and a
documented contract for writing one, are on the [roadmap](ROADMAP.md).

## A real run

From the live end-to-end test (`scripts/mac-subagents-e2e.sh`, 2026-10-21): three broken functions in a private
repo, one failing test each. A planner agent split the fix across two Claude workers and one Codex worker, ran
them in parallel, verified each against its own named check in a checks VM, had a reviewer agent review each
change, and merged all three.

| | |
|---|---|
| Result | 3 of 3 fixed, reviewed and merged; full test suite green on the result |
| Agents | 7 (planner, 3 workers, 3 reviewers), 13 VMs, all cleaned up |
| Time | 228s end to end |
| Cost | $0 billed on subscription plans (about $0.37 at API prices) |

## Quickstart

**Requirements:** macOS or Linux, a sandbox provider account ([boxd](https://boxd.sh) today), a GitHub repository,
and a Claude and/or ChatGPT plan (or Anthropic/OpenAI API keys).

**Install** (one self-contained executable, no runtime to install first):

```bash
curl -fsSL https://raw.githubusercontent.com/MarvinAmador7/capcomd/main/install.sh | sh
# or: brew install MarvinAmador7/tap/capcomd
# or, with Bun: bun add -g capcomd
```

`capcomd upgrade` updates it later.

**1. Add capcomd to your agent.** The capcomd plugin gives your agent the MCP tools and two skills
(orchestration, and setup):

```bash
# Claude Code
/plugin install capcomd --marketplace MarvinAmador7/capcomd
# Codex
codex plugin marketplace add MarvinAmador7/capcomd     # then install capcomd from /plugins
# Hermes (Nous Research): after installing the CLI, in your repository
capcomd setup agent      # adds capcomd's MCP server and skills to ~/.hermes (docs/integration-agents.md#hermes)
```

**2. Ask your agent to set it up**, in the repository the agents should work on:

> Set up capcomd for this repository.

It installs the CLI if it's missing (the installer above), connects your sandbox provider (with the boxd CLI logged in, it creates
a key just for capcomd and keeps it in your OS keychain), builds the agent VM snapshot, detects your repository,
target branch and test command, and starts the engine. A few steps are yours: logging in to boxd
(`boxd auth login`) and your agents (`capcomd auth login claude`) open a browser, and you confirm the gates (the
checks, the reviewer, the target branch). Prefer a terminal? `capcomd setup` after installing does the same,
including the plugin, and can be re-run safely; `capcomd setup check` shows what's configured.

**3. Ask for the outcome:**

> Use capcomd to fix the failing tests in `src/`: one worker per file, each verified and reviewed, then merged.

> Use capcomd to add rate limiting to the API: plan it, put the shared types first, then the middleware and its
> tests in parallel; land on a `staging` branch.

Your agent reports back as agents finish and merges land. Merges into protected branches wait for you:
`capcomd approve <runId> <mrgId>`. Watch a run with `capcomd tree <runId>`, or in the terminal debugger:
`capcomd tui [runId]` (its agents live, a waterfall of what each did, a timeline, cost rollups and events; with no
runId, the latest run).

Each [release](https://github.com/MarvinAmador7/capcomd/releases) has the binaries for macOS and Linux (arm64 and
x64) and the npm package, each with its SHA-256 (the installer and `capcomd upgrade` check it); the npm package is
published by CI with [provenance](https://docs.npmjs.com/generating-provenance-statements).

### Connecting your agent

| Agent | How it drives capcomd | Today |
|---|---|---|
| Claude Code | The capcomd plugin: MCP tools + orchestration and setup skills | Works, verified live: Claude Code ran a 3-worker swarm with only the plugin's tools |
| Codex | The same plugin from the marketplace (`/plugins`) | Built to OpenAI's plugin format; not yet tried in Codex |
| Hermes | `capcomd setup agent`: `capcomd mcp` in Hermes's `config.yaml` + the skills ([how](docs/integration-agents.md#hermes)) | Setup tested against Hermes's documented config; not yet driven live |
| Any other MCP client | `capcomd mcp` ([how](docs/integration-agents.md#mcp)) | Works |
| Any agent with a shell | The CLI with `--json` and [the skill](plugins/capcomd/skills/capcomd-orchestration/SKILL.md) | Works, verified live |

The orchestration skill teaches the agent the primitives and when to use which pattern (single loop, fan-out,
supervisor, critic, best-of-n, planner, interface-first).

<details><summary>What your agent runs</summary>

The same commands work for you, and every one takes `--json` (a stable, versioned contract):

```bash
RUN=$(capcomd run new --budget usd=6,turns=200 --json | jq -r .runId)   # checks + reviewer come from setup
A=$(capcomd spawn $RUN --profile worker --task "Fix the off-by-one in src/pager.ts" --check unit --key pager --json | jq -r .agentId)
capcomd await $RUN $A
V=$(capcomd verify $RUN --ref $A --json | jq -r .id)     # checks in a VM, then the reviewer
capcomd merge $RUN --ref $A --require $V                 # only the verified commit lands
```

Or hand the whole goal to a `planner` agent, which spawns, verifies and merges its own workers from inside its VM:

```bash
capcomd spawn $RUN --profile planner --task "Fix the three failing tests; one child per file; verify and merge each"
```
</details>

<details><summary>Setting up by hand</summary>

```bash
export BOXD_API_KEY=…  CAPCOMD_SANDBOX=boxd
capcomd env build                 # bake the agent CLIs into a VM snapshot (once; no secrets)
capcomd auth login claude         # log in with your plan inside a VM (or: codex)
capcomd doctor --strict           # check every agent works
export CAPCOMD_REPO=https://github.com/you/app.git  CAPCOMD_MERGE_TARGET=main  CAPCOMD_MERGE_MODE=pr
capcomd agents add worker --provider claude --auth subscription   # no limits; add --max-turns, --timeout-ms or --budget for one
capcomd agents add reviewer --provider claude --auth subscription \
  --allowed-tools 'Read,Glob,Grep,LS,Bash(git diff:*),Bash(bun test:*)'
capcomd serve &                   # the engine (setup can install it as a service instead)
```

State lives in `~/.capcomd` (set `CAPCOMD_HOME` to move it); a project's own `.capcomd/` holds its settings and
agent profiles.
</details>

## Core concepts

| | |
|---|---|
| **Run** | A durable scope with a budget, its named checks, an optional reviewer and target branch (`capcomd run new`). |
| **Orchestrator** | Whoever calls the primitives: your agent, an agent inside a VM allowed to delegate, or you. |
| **Agent** | One Claude Code or Codex session in its own VM and branch (`capcomd spawn`). |
| **Profile** | A reusable agent definition: provider, login, model, limits, tools, and whether it may spawn (`capcomd agents`). |
| **Check** | A command the operator names for the run; agents choose one per child, never write one. |
| **Reviewer** | An agent profile that reads each verified change and returns pass or fail with reasons. |
| **Verify / merge** | `verify` runs the checks and the review on a commit; `merge --require` lands exactly that commit. |
| **Report** | A read-only agent (`spawn --report`) whose answer is its result: research, triage, analysis. |
| **Provider** | Where VMs come from, behind the sandbox provider interface ([boxd](https://boxd.sh) today). |

## Safety model

- **Gates belong to the operator.** Test commands, the reviewer, protected-branch approvals and the target branch
  are set by you; agents can't choose or change them.
- **Authority comes from tokens, not text.** An agent can only act on its own subtree with the operations its token
  grants; anything another agent writes is fenced and treated as data.
- **Nothing runs on your machine.** Agents and checks run in VMs. An agent's VM holds only its own login and a
  short-lived git credential for pushing its branch; a checks VM holds none.
- **No self-approval.** An agent can't verify or merge its own work.

## Integrations

- **Plugin** for Claude Code and Codex ([plugins/capcomd](plugins/capcomd)): the MCP server and the
  [orchestration](plugins/capcomd/skills/capcomd-orchestration/SKILL.md) and
  [setup](plugins/capcomd/skills/capcomd-setup/SKILL.md) skills.
- **CLI with a JSON contract**: every command takes `--json` (schema `relay.v1`, stable exit codes), documented in
  [docs/output-contract.md](docs/output-contract.md).
- **MCP server** (`capcomd mcp`): the primitives as tools for your agent, with bounded waits; it starts the engine
  when none is running. See [docs/integration-agents.md](docs/integration-agents.md#mcp).
- **Hermes** (Nous Research's agent, also from Telegram, Slack and the rest of its gateway): `capcomd setup agent`
  registers the MCP server and installs the skills; see [docs/integration-agents.md](docs/integration-agents.md#hermes).
- **Other callers** (scripts, services): see [docs/integration-agents.md](docs/integration-agents.md).

## Documentation

- [STATUS.md](STATUS.md): what works today, and how it's verified.
- [ROADMAP.md](ROADMAP.md): what's next, known limits and their approaches.
- [CHANGELOG.md](CHANGELOG.md): what's in each release.
- [DEVELOPMENT.md](DEVELOPMENT.md): architecture, tests, chaos suite, cutting a release.
- [docs/](docs/): design decisions (ADRs), and the operator's orchestration skill in [skills/](skills/).

## Contributing

Issues and pull requests are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md), the [Code of Conduct](CODE_OF_CONDUCT.md),
and [SECURITY.md](SECURITY.md) for reporting vulnerabilities privately. Coding agents follow [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE) © Marvin Amador Campos
