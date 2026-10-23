# Driving capcomd from an agent

capcomd is built to be driven by an agent: the user's coding agent (Claude Code, Codex), or a front-door
assistant such as Hermes that talks to the user. That agent is the **driver**: it starts a run, spawns agents
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
`.capcomd/config.json`). Claude Code: `claude mcp add capcomd -- capcomd mcp` (or install the capcomd plugin, which does it for you). Codex, in `~/.codex/config.toml`:

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
| `capcomd_setup` | | `{ready, steps[], gates: {checks, reviewer, target}, driver: {approvals, maxRunBudget}}` |
| `capcomd_profiles` | | `{default, profiles: [{name, provider, auth, model, canSpawn, ready, detail}]}` |
| `capcomd_run_new` | `budget`, `label?`, `target?`, `targetFrom?`, `key?` | `{runId, created, budget, gates}` |
| `capcomd_runs` | `limit?` | `{runs: [{runId, label, repo, cwd, createdAt, agents: {status: n}, pendingApprovals}]}` |
| `capcomd_spawn` | `runId`, `task`, `profile?`, `budget?`, `check?`, `report?`, `children?`, `key?` | the agent: `{agentId, status, …}` |
| `capcomd_await` | `runId`, `agents[]`, `mode?` (`all`\|`any`), `timeoutMs?` (≤ 55000) | `{done[], pending[], first?, next}` |
| `capcomd_send` | `runId`, `to`, `body`, `key?` | `{seq, …}` |
| `capcomd_cancel` | `runId`, `agent?`, `reason?` | `{cancelled, affected[]}` |
| `capcomd_resume` | `runId`, `agent?` | `{resumed[]}`: paused agents (provider usage limit) run again now |
| `capcomd_verify` | `runId`, `ref`, `check?`, `acceptance?`, `key?`, `timeoutMs?` | `{id: "vfy-…", state: passed\|failed\|running, result, next}` |
| `capcomd_merge` | `runId`, `ref`, `require`, `key?`, `timeoutMs?` | `{id: "mrg-…", state: merged\|failed\|awaiting_approval\|running, result, next}` |
| `capcomd_approve` | `runId`, `merge`, `deny?`, `reason?` | the merge record, or a `forbidden` error (below) |
| `capcomd_task` | `runId`, `action`, … | the task board (`add\|list\|show\|claim\|renew\|release\|done`) |
| `capcomd_kv` | `runId`, `action`, `k?`, `value?`, `expect?`, `prefix?`, `key?` | the blackboard (`get\|put\|cas\|del\|list`) |
| `capcomd_budget` | `runId`, `agent?` | budget, spend, what is left, rollups |
| `capcomd_tree` | `runId`, `root?` | the agent tree with rollups, stuck flags, `pendingApprovals` |
| `capcomd_inspect` | `runId`, `agent`, `tail?` | one agent: record, children, VM, logs, events |
| `capcomd_events` | `runId`, `cursor?`, `limit?` | `{events[], nextCursor, total, truncated}` |
| `capcomd_trace` | `runId`, `cursor?`, `limit?` | `{traceId, durationMs, spans[], nextCursor, total, truncated}` |

Tools carry MCP annotations: reads are `readOnlyHint`; `capcomd_merge`, `capcomd_cancel` and `capcomd_approve`
are `destructiveHint`, so clients ask before calling them. Every write takes `key`: a retry with the same key
returns the first result.

**Waits are bounded.** `capcomd_await`, `capcomd_verify` and `capcomd_merge` return within `timeoutMs` (default
25s, at most 55s, under clients' tool timeouts) with `pending` or `state: "running"` and a `next` that says to
call again with the same arguments. The agents, checks and reviewer keep working in between.

**The driver's limits** (ADR-018 §4): the run's checks, reviewer and target come from the project's
`.capcomd/config.json` (`run`), which the user writes with `capcomd setup`; a driver names a check, never its
command. `capcomd_run_new` refuses a protected `target` (other than the project's own) and a budget over
`driver.maxRunBudget`. Reserved kv keys (`_…`, `approval/…`, `recipe/…`, `handoff/…`) are read-only. A merge into a
protected branch parks in `awaiting_approval`; by default only a person approves it (`capcomd approve <runId>
<mrgId>`, or the TUI), and `capcomd_approve` answers with that instruction. A front door that relays the user's
own decision (like Hermes) sets `"driver": {"approvals": "client-confirmed"}` in the project config.

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
