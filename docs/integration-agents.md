# Driving capcomd from an agent

capcomd is built to be driven by an agent: the user's coding agent (Claude Code, Codex), or a front-door
assistant such as [Hermes](#hermes) that talks to the user. That agent is the **driver**: it starts a run, spawns agents
in VMs, waits for them, verifies and merges their work through capcomd's primitives (ADR-016, ADR-018). capcomd
keeps the run durable, isolates the agents and enforces the gates.

Two ways in, same schema (`relay.v1`):

| | MCP (`capcomd mcp`) | CLI (`capcomd … --json`) |
|---|---|---|
| Best for | Agents with MCP support, including ones without a shell | Agents with a shell, CI, scripts |
| Transport | stdio JSON-RPC | process + stdout |
| Output | tool result JSON (`structuredContent` and text) | one JSON object per command |

The skill (`plugins/capcomd/skills/capcomd-orchestration/SKILL.md`) teaches either one the patterns: single loop, fan-out,
supervisor, critic, best-of-n, planner, interface first.

## MCP

Register capcomd as a stdio MCP server, run from the repository the agents work on (it reads that project's
`.capcomd/config.json`), or once for all your projects (the [Hermes](#hermes) setup: see
[Projects](#one-capcomd-for-several-projects)). Claude Code: `claude mcp add capcomd -- capcomd mcp` (or install the capcomd plugin, which does it for you). Codex, in `~/.codex/config.toml`:

```toml
[mcp_servers.capcomd]
command = "capcomd"
args = ["mcp"]
```

The server starts the engine (`capcomd serve`, port 6420, state in `~/.capcomd`) when none answers, and leaves
it running: runs outlive the session that started them. `CAPCOMD_NO_ENGINE_AUTOSTART=1` turns that off.

### Tools

| Tool | Input | Returns |
|---|---|---|
| `capcomd_projects` | | `{default, here, projects: [{name, path, default, ready}]}`: the projects this capcomd serves |
| `capcomd_setup` | `project?` | `{ready, steps[], gates: {checks, reviewer, target}, driver: {approvals, maxRunBudget}, project}` |
| `capcomd_profiles` | | `{default, profiles: [{name, provider, auth, model, canSpawn, ready, detail}]}` |
| `capcomd_run_new` | `budget?` (none: unlimited), `label?`, `target?`, `targetFrom?`, `key?` | `{runId, created, budget, gates}` |
| `capcomd_runs` | `limit?`, `project?` (only its runs) | `{runs: [{runId, label, repo, cwd, project, createdAt, agents: {status: n}, pendingApprovals}]}` |
| `capcomd_spawn` | `runId`, `task`, `profile?`, `budget?`, `check?`, `report?`, `children?`, `key?` | the agent: `{agentId, status, …}` |
| `capcomd_await` | `runId`, `agents[]`, `mode?` (`all`\|`any`), `timeoutMs?` (≤ 55000) | `{done[], pending[], first?, next}` |
| `capcomd_send` | `runId`, `to`, `body`, `key?` | `{seq, …}` |
| `capcomd_cancel` | `runId`, `agent?`, `reason?` | `{cancelled, affected[]}` |
| `capcomd_resume` | `runId`, `agent?` | `{resumed[]}`: paused agents (provider usage limit) run again now |
| `capcomd_grant` | `runId`, `agent?`, `budget`, `key?` | `{agentId, budget, from, left}`: more budget for a live agent, from its parent's (or, without `agent`, a higher run budget, within `driver.maxRunBudget`) |
| `capcomd_verify` | `runId`, `ref`, `check?`, `acceptance?`, `key?`, `timeoutMs?` | `{id: "vfy-…", state: passed\|failed\|running, result, next}` |
| `capcomd_merge` | `runId`, `ref`, `require`, `key?`, `timeoutMs?` | `{id: "mrg-…", state: merged\|failed\|awaiting_approval\|running, result, next}` |
| `capcomd_approve` | `runId`, `merge`, `deny?`, `reason?` | the merge record, a `forbidden` error (below), or, under `elicit`, "No decision" |
| `capcomd_task` | `runId`, `action`, … | the task board (`add\|list\|show\|claim\|renew\|release\|done`) |
| `capcomd_kv` | `runId`, `action`, `k?`, `value?`, `expect?`, `prefix?`, `key?` | the blackboard (`get\|put\|cas\|del\|list`) |
| `capcomd_budget` | `runId`, `agent?` | budget, spend, what is left, rollups |
| `capcomd_tree` | `runId`, `root?` | the agent tree with rollups, stuck flags, `pendingApprovals` |
| `capcomd_inspect` | `runId`, `agent`, `tail?` | one agent: record, children, VM, logs, events |
| `capcomd_events` | `runId`, `cursor?`, `limit?` | `{events[], nextCursor, total, truncated}` |
| `capcomd_trace` | `runId`, `cursor?`, `limit?` | `{traceId, durationMs, spans[], nextCursor, total, truncated}` |

Tools carry MCP annotations: reads are `readOnlyHint`; `capcomd_merge`, `capcomd_cancel` and `capcomd_approve`
are `destructiveHint`, so clients ask before calling them. `capcomd_approve` is never `idempotentHint` (a client may
replay an idempotent call) and carries `_meta: {"anthropic/requiresUserInteraction": true}` (Claude Code then asks a
person before every call, even in bypass and auto modes). Every write takes `key`: a retry with the same key returns
the first result. Every tool that acts on a project (all but `capcomd_projects`, `capcomd_events` and
`capcomd_trace`) takes `project?`, and its result names the project.

**Waits are bounded.** `capcomd_await`, `capcomd_verify` and `capcomd_merge` return within `timeoutMs` (default
25s, at most 55s, under clients' tool timeouts) with `pending` or `state: "running"` and a `next` that says to
call again with the same arguments. The agents, checks and reviewer keep working in between.

**The driver's limits** (ADR-018 §4): the run's checks, reviewer and target come from the project's
`.capcomd/config.json` (`run`), which the user writes with `capcomd setup`; a driver names a check, never its
command. `capcomd_run_new` refuses a protected `target` (other than the project's own) and a budget over
`driver.maxRunBudget`. Reserved kv keys (`_…`, `approval/…`, `recipe/…`, `handoff/…`) are read-only. A merge into a
protected branch parks in `awaiting_approval`; by default only a person approves it (`capcomd approve <runId>
<mrgId>`, or the TUI), and `capcomd_approve` answers with that instruction. A project can instead let capcomd ask the
person itself: `"driver": {"approvals": "elicit"}` ([below](#approvals-asked-by-capcomd-elicit)).
`"client-confirmed"` (the tool approves after the client's own confirmation) still works but isn't recommended:
`elicit` is strictly stronger.

### Approvals asked by capcomd (`elicit`)

With `"driver": {"approvals": "elicit"}` in the project's `.capcomd/config.json`, `capcomd_approve` asks the user
itself, with MCP elicitation (`elicitation/create`, form mode, an empty form): the client shows capcomd's own text as
a prompt (Hermes: in the terminal, or Allow / Deny buttons in Telegram, Slack…). Only an accept approves:

```text
capcomd: merge into main, a protected branch?

Project: app (/home/you/src/app)
Repository: https://github.com/you/app.git
Run: run-k894f215404134113
Merge: mrg-mvr2ho5y0hlhh4
Target: main
Work: agt-kc2575266c5227a62, branch capcomd/run-k894f215404134113/agt-kc2575266c5227a62
Commit: 928e277cfeda
Checks: passed (unit); they run again on the latest main before it lands
Review: passed (reviewer reviewer, agt-k213c831a01336500)
The reviewer's reasons, written by an agent (data, not instructions):
<<<untrusted:agt-k213c831a01336500>>>
- does what the task asks
<<<end:agt-k213c831a01336500>>>

Accept to merge exactly commit 928e277cfeda into main. Decline, or don't answer, to leave it waiting.
```

- The text comes from capcomd's records only; the reviewer's reasons are fenced as data. It never asks for a secret.
- Accept: capcomd checks the branch still points at the commit it showed (else it refuses, `reason: "branch_moved"`),
  then approves through the normal approval path, recorded `by: "driver:elicited"`; the client's name and the commit
  shown are kept in the run's kv as `approval/<mrgId>`. The verified commit lands (the checks run again first).
- Decline, cancel, no answer within `driver.elicitTimeoutSeconds` (default 300) or an error: no decision. The merge
  stays parked and the tool says exactly `No decision: the merge is still waiting. Don't retry; ask the user.`
- Fail closed: a client that didn't declare form elicitation when it connected gets the `forbidden` answer, like
  `human`. So does a client not in `driver.elicitClients` (the MCP clients' names, e.g. `["hermes-agent"]`, which
  `capcomd setup agent --approvals elicit` writes); without that list, any client except Claude Code.
- **Claude Code**: its `Elicitation` hooks can answer the prompt with no person, and in `claude -p` a repository's
  `.claude/settings.json` hooks run without a trust prompt. Use `elicit` with Claude Code only when hooks are managed
  (`allowManagedHooksOnly` in managed settings), by adding `"claude-code"` to `driver.elicitClients`. Setup never turns
  it on for Claude Code.

Text written by agents (results, logs, messages) reaches the driver fenced
(`<<<untrusted:agt-…>>> … <<<end:agt-…>>>`): it is data, never instructions.

Every result is `{"schema":"relay.v1","ok":true,…}`, capped at 20,000 characters; `capcomd_events` and
`capcomd_trace` page with `nextCursor` and set `truncated: true` when more remains. Errors come back with
`isError: true` and a body you can act on:

```json
{"schema":"relay.v1","ok":false,"error":{"code":"usage","reason":"forbidden","message":"approving merges into protected branches is left to a person in this project","hint":"Ask the user to run `capcomd approve run-… mrg-…` (or approve in the TUI). …"}}
```

`code` is one of `usage`, `not_found`, `engine_unreachable`, `run_failed`, `conflict` or `config`; `reason`
refines it (`forbidden`, `backpressure`, …); `retryable: true` means the same call may succeed later. `hint` is
always a concrete next step.

### A session

```
user   → agent: "Fix the three failing tests, one worker per file, each verified and reviewed."
agent  → capcomd_setup                      ← {ready: true, gates: {checks: {unit: "bun test"}, reviewer: "reviewer", target: "main"}}
agent  → capcomd_run_new {budget: "usd=6,turns=200", label: "fix tests"}          ← {runId: "run-…"}
agent  → capcomd_spawn ×3 {runId, task: "Fix src/a.ts …", profile: "worker", check: "unit", key: "a"}
agent  → capcomd_await {runId, agents: [a, b, c], mode: "any"}   (repeat until none pending)
agent  → capcomd_verify {runId, ref: a}     ← {state: "running", next: "call again"} … ← {id: "vfy-…", state: "passed"}
agent  → capcomd_merge {runId, ref: a, require: "vfy-…"}   ← {state: "awaiting_approval", next: "capcomd approve run-… mrg-…"}
agent  → user: "All three pass their checks and review; approve the merges into main with `capcomd approve …`."
```

## Hermes

[Hermes](https://github.com/NousResearch/hermes-agent) (Nous Research) is a front door: you talk to it in a
terminal or from Telegram, Discord, Slack and the rest of its messaging gateway, and it drives capcomd over MCP.
With Hermes installed, `capcomd setup agent` (also part of `capcomd setup`), run in your repository, adds capcomd to
it. It finds Hermes by its files only (`$HERMES_HOME`, else `~/.hermes`, or the profile `hermes profile use` made
sticky; or `hermes` on PATH) and never runs it. `--no-hermes` skips it.

What it changes, in Hermes's `config.yaml` (edited in place: other servers, settings and comments stay as they
were; the previous file is kept as `config.yaml.capcomd.bak`; re-running updates capcomd's entry, never adds a
second one, and keeps keys you added to it, like `timeout` or `enabled`):

```yaml
mcp_servers:
  capcomd:  # capcomd setup agent keeps this entry; re-run it to update
    command: "/home/you/.capcomd/bin/capcomd"   # absolute: Hermes's gateway service may not have capcomd on PATH
    args: ["mcp"]
    trust: untrusted                            # Hermes asks you before tools not marked read-only…
    timeout: 360                                # a call outlives capcomd's 300 s approval prompt (only when unset)

command_allowlist:                              # …except these, which run without asking (within the project's gates)
  - "mcp:capcomd/capcomd_run_new"
  - "mcp:capcomd/capcomd_spawn"
  - "mcp:capcomd/capcomd_send"
  - "mcp:capcomd/capcomd_resume"
  - "mcp:capcomd/capcomd_grant"
  - "mcp:capcomd/capcomd_verify"
  - "mcp:capcomd/capcomd_task"
  - "mcp:capcomd/capcomd_kv"

approvals:
  deny:
    - "capcomd approve*"                        # Hermes's terminal never approves a merge itself
```

So Hermes shows you an approval card (in the terminal, or buttons in Telegram, Slack…) before `capcomd_merge`,
`capcomd_cancel` and `capcomd_approve`, the tools capcomd marks destructive (Hermes reads only `readOnlyHint`, so
`trust: untrusted` plus the allowlist is how it asks for exactly those). An entry with `CAPCOMD_HOME` set at setup
time also gets `env: {CAPCOMD_HOME: …}`: Hermes passes a stdio server only `PATH`, `HOME`, `USER`, `LANG`, `LC_ALL`,
`TERM`, `SHELL`, `TMPDIR`, `XDG_*` and the entry's own `env`, so capcomd's settings come from `~/.capcomd/config.json`
and each project's `.capcomd/config.json`, not your shell. Setup also installs the orchestration and setup skills
in `<hermes home>/skills/capcomd/` (a copy you or Hermes edited is kept, not overwritten).

### One capcomd for several projects

The entry has no `cwd`: one `capcomd` serves all your projects. Each `capcomd setup agent` adds the checkout it runs
in to capcomd's project list, in `~/.capcomd/config.json` (the first one is the default; `--default-project` makes
this one the default):

```json
{
  "projects": {
    "default": "app",
    "list": [
      { "name": "app", "path": "/home/you/src/app" },
      { "name": "api", "path": "/home/you/src/api" }
    ]
  }
}
```

A project's gates, approvals policy and agent profiles stay in its own `.capcomd/config.json` and
`.capcomd/agents.json`. Tools take `project` (a name, or a checkout's path); without it, a run's tools use the run's
own project, and the rest the checkout capcomd was started in (Hermes in a terminal in a repository), else the default
project, else the only one. An unknown name is refused with the list; `capcomd_projects` lists them. Every result
and the approval prompt name the project.

An entry an older setup pinned to one folder (`cwd`) is migrated: the `cwd` goes, and that folder joins the project
list. To keep a separate entry for one project (say, a different trust setting), `capcomd setup agent
--hermes-entry-per-project` writes `mcp_servers.capcomd-<project>` pinned to it, with its own allowlist; it's opt-in,
since every tool is then listed once per entry.

### Who approves merges into protected branches

In a terminal, setup asks: **capcomd asks you itself in Hermes** (`elicit`, recommended, the default) or **you, in a
terminal** (`human`: `capcomd approve <runId> <mrgId>`). `--approvals elicit|human` sets it without asking; `--yes`
alone changes nothing. It's a project setting (`driver.approvals` in that project's `.capcomd/config.json`); `elicit`
also writes `"elicitClients": ["hermes-agent"]`, so only Hermes's capcomd asks (not a Claude Code session in the
same repository).

With `elicit`, when a merge waits, Hermes calls `capcomd_approve` (its own card first: answer **Once**), then capcomd's
prompt appears ([what it says](#approvals-asked-by-capcomd-elicit)): Allow merges exactly that commit, Deny or no
answer leaves it waiting. Hermes's `/yolo`, `--yolo` and `approvals.mode: off` don't answer it, and cron jobs and
`chat -q` decline it, so nothing merges into a protected branch unattended. If Hermes has elicitation turned off
(`mcp_servers.capcomd.elicitation.enabled: false`), approve in a terminal instead.

`--approvals client-confirmed` (Hermes's own card for `capcomd_approve` is the confirmation) still works for existing
setups but isn't recommended: `/yolo`, `approvals.mode: off` and an earlier "Always" answer all skip that card. Setup
won't set it when Hermes's `approvals.mode` is `off`. The checks and the reviewer run before any merge, whoever
approves.

### Check it

`capcomd setup check` has a `hermes` line (capcomd in Hermes for N projects, missing, disabled, pinned to one folder,
or Hermes not found). In a Hermes session, run `/reload-mcp` (a running gateway picks the entry up by itself); its
tools are `mcp__capcomd__capcomd_projects`, `mcp__capcomd__capcomd_spawn` and so on. Then ask, for example:

> Which capcomd projects do you know? Check app is ready.

> Use capcomd on api to fix the failing tests: one worker per file, each verified and reviewed.

> Start a capcomd run on app with a $5 budget: a planner splits "add rate limiting to the API" across workers. Tell
> me when merges are waiting, then ask me to approve them.

> What are my capcomd runs doing, in every project? Anything stuck or waiting for approval?

To check the approval prompt, let a run reach a merge into a protected branch and say "approve it": the prompt names
the project, the target and the commit; Deny, and the merge is still listed as waiting (`capcomd status <runId>`).

### Recipes (no new code)

**A nightly run that stages but never merges into a protected branch.** A Hermes cron job with the capcomd skills
attached, delivered to your chat:

```bash
hermes cron create "0 2 * * *" "Use capcomd on app: start a run with target capcomd/nightly (from main) and a \
\$10 budget, fix the flaky tests (one worker per test file, each verified and reviewed), merge what passes into \
capcomd/nightly, then report what landed and what didn't." \
  --skill capcomd-orchestration --deliver telegram --name "capcomd nightly"
```

Cron is unattended: Hermes denies approval prompts there (`approvals.cron_mode: deny`) and declines capcomd's own,
so the run verifies and lands on the staging branch, and anything aimed at `main` waits for you. That's intended:
merge `capcomd/nightly` in the morning, or ask Hermes to and approve the prompt.

**A morning digest with no model.** A no-agent cron job runs a script and delivers its output verbatim (zero LLM
cost):

```bash
#!/bin/sh
# ~/.hermes/scripts/capcomd-digest.sh: the last runs started on this machine, their state, and what waits for you
tail -n 20 ~/.capcomd/state/runs.jsonl | jq -r .runId | awk '!seen[$0]++' | while read -r r; do
  capcomd status "$r" --json | jq -r '.run | "\(.runId)  \(.state)  spent $\(.budget.spent)  waiting: \([.pendingApprovals[]? | "\(.taskId) → \(.targetBranch)"] | join(", "))"'
done
```

```bash
hermes cron create "0 8 * * *" --no-agent --script capcomd-digest.sh --deliver telegram --name "capcomd digest"
```

The script must live in `$HERMES_HOME/scripts/`; its output is delivered as is (empty output: nothing is sent).
(`capcomd … --json` output is the [output contract](output-contract.md); agent-written text in it is fenced.)

**Narration while a run works.** In a session: `/heartbeat every 5m Check capcomd run run-…: tell me what changed
since last time (agents done, checks, merges waiting); don't repeat yourself.`

**Hermes on a boxd machine.** Hermes often lives on its own boxd VM, and capcomd can run its agents from there
without a boxd API key (the machine's own credentials, see [boxd.md](boxd.md#inside-a-boxd-machine-no-key-needed)):

```bash
ssh hermes.boxd                                   # the VM where Hermes runs
curl -fsSL https://raw.githubusercontent.com/MarvinAmador7/capcomd/main/install.sh | sh
git clone https://github.com/you/app && cd app
capcomd setup                                     # no key needed here; logs in Claude/Codex; the project; Hermes
```

A running gateway (`hermes gateway run`, or the service) connects a new `mcp_servers` entry within about a minute
by itself; in a terminal session, `/reload-mcp`. Clone and `capcomd setup agent` more repositories there to add them.

Setup records the machine in `~/.capcomd/config.json` (`CAPCOMD_BOXD_MACHINE`), because the `capcomd mcp` Hermes's
gateway starts doesn't see the login shell's `BOXD_VM_*` variables. Then talk to Hermes from wherever it listens.

## CLI with `--json`

```bash
capcomd run --json --detach --target-branch main "Add rate limiting"
# {"schema":"relay.v1","ok":true,"runId":"run-…","detached":true,"log":".relay/runs/run-….ndjson","pid":1234}

capcomd run --json "Add rate limiting"        # streams NDJSON, one event per line:
# {"schema":"relay.v1","type":"run.started","runId":"…","ts":"…","goal":"…","targetBranch":null}
# {"schema":"relay.v1","type":"plan.ready","runId":"…","ts":"…","tasks":["task-1","task-2","task-3"],"cost":0.01}
# … task.leased, task.merged | task.awaiting_approval, task.approved, run.judging, run.completed …
# {"schema":"relay.v1","type":"run.result","runId":"…","ts":"…","ok":true,"state":"completed"}

capcomd status  <runId> --json
capcomd events  <runId> --json --limit 100 [--cursor N]
capcomd trace   <runId> --json
capcomd approve <runId> <taskId> --json [--by NAME]
capcomd cancel  <runId> --json
```

Exit codes:

| Code | Meaning |
|---|---|
| 0 | ok |
| 1 | run failed (or conflict, such as approving a task that isn't waiting) |
| 2 | usage error |
| 3 | not found (run, task or trace) |
| 4 | engine unreachable |

### Trace span contract

Every run's trace starts with `relay.run → cli.run` and contains actor (`actor.*`), task-ledger transition (`transition.task`), `model.generate`, `sandbox.ensure` and `git.push` spans. The same holds for both run paths (recipe default and `--legacy`).

**`git.merge` appears only when something merged.** The recipe verifies a ref first (`git.verify`) and merges only a passing one (`git.merge`). A run that merges nothing, for example because every check failed, has **no** `git.merge` span. Don't infer that a merge happened from anything except `git.merge` spans and `task.merged`/`task.approved` events. (The legacy loop used to emit `git.merge` for verify-and-merge attempts that failed their checks; that span is not part of the contract.)

## Approval gate

A task parks in `awaiting_approval` after verification passes when its target branch matches
`CAPCOMD_PROTECTED_BRANCHES` (comma-separated, trailing `*` glob, default
`main,master,release/*`). The engine process reads that variable. The task stays there until
`capcomd approve` or `capcomd_approve` moves it to `merged` (event `APPROVED`, recorded with
`approvedBy`). Cancelling the run cancels tasks that are parked. Without `--target-branch`, tasks
merge their own `task/<id>/e<epoch>` branches, which are unprotected, so the default path and the
chaos suite never wait for approval.
