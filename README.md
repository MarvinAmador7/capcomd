# capcomd

**Run teams of coding agents in parallel, and land only the work that passes.**

capcomd orchestrates Claude Code and Codex agents. Each agent works in its own isolated VM on its own branch;
nothing reaches your repository until it has passed checks you defined, been reviewed by another agent, and been
merged as the exact commit that was tested. Agents can break work down and delegate to other agents, within
limits you set.

> **Private preview (v0.2.0).** The orchestration primitives, sub-agents, verification and review are built and
> verified live. `capcomd run "<goal>"` is experimental. See [STATUS.md](STATUS.md) and [ROADMAP.md](ROADMAP.md).

## Why

Coding agents are fast, but on their own they are hard to trust and hard to scale:

- **They report success, not proof.** "All tests pass" is a claim until something else runs the tests.
- **Parallel agents collide.** Several agents on one checkout overwrite each other, and their changes conflict on
  the way in.
- **Delegation multiplies risk.** An agent that spawns agents can spend without limit and approve its own work.
- **You can't see what happened.** Who did what, in what order, at what cost, and why it failed.

capcomd treats each of these as a hard rule rather than a hope.

## What you get

**Isolation.** Every agent runs in a fresh boxd VM with its own clone and branch and an egress allowlist; VM
snapshots are scrubbed of secrets. Agents can't touch each other's work or your machine.

**Verification you control.** You name the checks (`run new --checks-set unit='bun test'`); agents pick one by
name and can never write their own. Checks run on the branch merged with the latest target, in a throwaway VM, so
agent-written code never executes on your host. A merge lands only the exact commit that passed.

**Review by another agent.** Set a reviewer for the run (`--reviewer`) and every change that passes its checks is
also read by a separate, read-only reviewer agent against acceptance criteria. Both must pass; a missing or
garbled verdict is a fail.

**Agents that delegate, safely.** A planner agent can spawn, verify and merge its own children from inside its
VM. You set the ceiling (depth, fan-out, allowed profiles, budget share); a parent can only narrow it for its
children. Capability tokens scope every call, and text from other agents is treated as data, never instructions.

**Budgets and cost.** Budgets in dollars, turns and wall time are carved down the tree. Costs roll up per agent and
subtree, including the API-equivalent cost of work on Claude and ChatGPT subscription plans.

**You stay in charge of what lands.** Merges into protected branches wait for your `capcomd approve`. A run can
land on its own staging branch instead of `main`.

**See everything.** A terminal debugger shows the agent tree (what ran in parallel, each child's checks → review →
merge), a span waterfall, per-agent timelines, rollups and the event log, live while the run executes.

**Built to survive crashes.** Every step is an idempotent, recorded transition; a crashed orchestrator resumes
where it stopped, and a merge happens exactly once. A chaos suite kills the process at named points to prove it.

## How it works

```
 you ──▶ capcomd ──▶ planner agent (VM)
                        │  spawns children in parallel, each in its own VM and branch
                        ├──▶ worker: add   ─┐
                        ├──▶ worker: mul    ├──▶ verify ──▶ checks (in a fresh VM)
                        └──▶ worker: shout ─┘        └──▶ reviewer agent (read-only)
                                                          │ both pass
                                                          ▼
                                       merge the exact tested commit ──▶ your branch
                                       (protected branch: waits for `capcomd approve`)
```

Everything an agent does goes through a small set of primitives (`spawn`, `await`, `verify`, `merge`, a task
board and a shared blackboard), available to you on the command line and to agents inside their VMs.

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

**Requirements:** [Bun](https://bun.sh) ≥ 1.4, a [boxd](https://boxd.sh) API key, a GitHub repository, and a
Claude and/or ChatGPT plan (or Anthropic/OpenAI API keys).

**1. Install** (private preview: needs read access to this repository)

```bash
bun add -g git+ssh://git@github.com/MarvinAmador7/relay.git#v0.2.0
capcomd --version
```

State lives in `~/.capcomd` (set `CAPCOMD_HOME` to move it); a project's own `.capcomd/agents.json` is used when
you run capcomd from that project.

**2. Connect your sandbox and agents**

```bash
export BOXD_API_KEY=…  CAPCOMD_SANDBOX=boxd
capcomd env build                 # bake the agent CLIs into a VM snapshot (once; no secrets)
capcomd auth login claude         # log in with your plan inside a VM (or: codex)
capcomd doctor --strict           # check every agent works
```

**3. Point capcomd at your repository and define your agents**

```bash
export CAPCOMD_REPO=https://github.com/you/app.git  CAPCOMD_MERGE_TARGET=main  CAPCOMD_MERGE_MODE=pr
capcomd agents add worker --provider claude --auth subscription --max-turns 25
capcomd agents add reviewer --provider claude --auth subscription --max-turns 15 \
  --allowed-tools 'Read,Glob,Grep,LS,Bash(git diff:*),Bash(bun test:*)'
```

**4. Run agents**

```bash
capcomd serve &                   # the local engine

RUN=$(capcomd run new --budget usd=6,turns=200 --checks-set unit='bun test' --reviewer reviewer --json | jq -r .runId)
A=$(capcomd spawn $RUN --profile worker --task "Fix the off-by-one in src/pager.ts" --check unit --key pager --json | jq -r .agentId)
capcomd await $RUN $A
V=$(capcomd verify $RUN --ref $A --json | jq -r .id)     # checks in a VM, then the reviewer
capcomd merge $RUN --ref $A --require $V                 # only the verified commit lands
```

Watch it in the terminal debugger (from a checkout: `cd apps/tui && bun run start --run $RUN`), or see the tree
with `capcomd tree $RUN`.

**5. Let an agent orchestrate.** Give a profile the right to spawn, and it runs the same loop for you:

```bash
capcomd agents add planner --spec '{"provider":"claude","auth":"subscription","maxTurns":60,
  "children":{"allowSpawn":true,"maxDepth":1,"maxChildren":3,"allowedChildProfiles":["worker"],"budgetShare":0.34}}'
capcomd spawn $RUN --profile planner --task "Fix the three failing tests; one child per file; verify and merge each"
```

## Core concepts

| | |
|---|---|
| **Run** | A scope with a budget, its named checks, an optional reviewer and target branch (`capcomd run new`). |
| **Agent** | One Claude Code or Codex session in its own VM and branch (`capcomd spawn`). |
| **Profile** | A reusable agent definition: provider, login, model, limits, tools, and whether it may spawn (`capcomd agents`). |
| **Check** | A command the operator names for the run; agents choose one per child, never write one. |
| **Reviewer** | An agent profile that reads each verified change and returns pass or fail with reasons. |
| **Verify / merge** | `verify` runs the checks and the review on a commit; `merge --require` lands exactly that commit. |
| **Report** | A read-only agent (`spawn --report`) whose answer is its result: research, triage, analysis. |

## Safety model

- **Gates belong to the operator.** Test commands, the reviewer, protected-branch approvals and the target branch
  are set by you; agents can't choose or change them.
- **Authority comes from tokens, not text.** An agent can only act on its own subtree with the operations its token
  grants; anything another agent writes is fenced and treated as data.
- **Nothing runs on your machine.** Agents and checks run in VMs. An agent's VM holds only its own login and a
  short-lived git credential for pushing its branch; a checks VM holds none.
- **No self-approval.** An agent can't verify or merge its own work.

## Integrations

- **CLI with a JSON contract**: every command takes `--json` (schema `relay.v1`, stable exit codes), documented in
  [docs/output-contract.md](docs/output-contract.md).
- **MCP server** (`capcomd mcp`) for driving capcomd from another agent.
- **Hermes** and other callers: see [docs/integration-agents.md](docs/integration-agents.md).

## Documentation

- [STATUS.md](STATUS.md): what works today, and how it's verified.
- [ROADMAP.md](ROADMAP.md): what's next, known limits and their approaches.
- [CHANGELOG.md](CHANGELOG.md): what's in each release.
- [DEVELOPMENT.md](DEVELOPMENT.md): architecture, tests, chaos suite, cutting a release.
- [docs/](docs/): design decisions (ADRs), and the operator's orchestration skill in [skills/](skills/).
