# ADR-019: Agents report up; limits are optional

Status: proposed (2026-10-22), not built. Changes how ADR-016 enforces budgets and how ADR-017 detects stuck agents.
Builds on PR #3 (heartbeats from agent events) and PR #4 (an agent stopped at a limit keeps its work).

## Context

Every agent runs under three fixed caps, whether or not anyone set them:

- **Turns:** `maxTurns`, default 30 (setup's worker: 25). It counts different things per provider: Claude counts
  model turns (`--max-turns`, enforced by the CLI); Codex has no such flag, so the runner counts tool steps
  (`src/agents/adapters.ts:134`). The budget tree adds both up as one unit.
- **Time:** `timeoutMs`, default 20 min (setup's worker: 15). A feature that takes four hours hits it; a loop is
  caught only when the clock runs out.
- **Money:** `maxBudgetUsd`, default $2, passed to Claude as `--max-budget-usd` on every login. On a subscription the
  money is already paid; what runs out is the provider's quota, which the provider enforces itself. Codex on a
  subscription already skips the money guard (`adapters.ts:136`), so turns and time are its only limits.

These caps guess in advance how much work a task needs. Since PR #4 hitting one no longer loses work, but it still
stops an agent that was making progress, and it doesn't catch one that isn't until the cap runs out.

Other gaps:

- **Provider quota isn't handled.** A usage-limit error looks like any failure, and the driver retries it (up to
  `DRIVE_MAX_FAILURES`).
- **Liveness is pulled, and read from the outside.** The engine `exec`s into the VM every 2 s
  (`CAPCOMD_AGENT_POLL_MS`) to tail the agent's log; PR #3 writes the heartbeat from that on the agent's behalf. The
  in-VM CLI's spool is also polled (1 s). Workers that can't spawn have no in-VM CLI, so nothing in the VM reports
  for them. "Stuck" is one flag, 5 min without a heartbeat (`CAPCOMD_STUCK_AFTER_MS`), shown and never acted on.
- **Claude's spend is known only at the end:** its stream reports `total_cost_usd` in the final `result` event
  (`adapters.ts:48`), so there's no live spend to show or enforce.

## Decision

### 1. Information flows up: the child keeps its own liveness

The "child" is not the model, which forgets: it is a **supervisor** that runs next to the agent CLI in the VM (today's
`run.sh`, grown into a small dependency-free Node program, like `vm-cli.mjs`). It runs for every agent, workers
included, and writes reports to an outbox in the VM:

- **heartbeat:** every few seconds while it's alive;
- **progress:** a commit, files changed, a test run and its result, an error;
- **spend:** tokens and cost so far, real on an API key, notional on a subscription (§4);
- **state:** working, idle, spinning, failing, quota (§2, §6).

The transport stays a pickup (ADR-017 §1: the VM usually can't reach the engine, and we add no egress): the engine
drains the outbox. What is reported, and when, is the supervisor's decision; the engine stops inferring liveness
from the raw log, and PR #3's engine-side heartbeat is replaced.

Parents never ping a child. They receive its reports and react when they stop. Only commands flow down:

- **cancel;**
- **message:** redirect the agent, or answer it (`send`/`inbox`, now available to every agent through the
  supervisor, not only to agents that can spawn);
- **grant:** more budget (§4);
- **confirm before acting on silence:** check the VM and the supervisor's process exist before treating a silent
  agent as dead, so a network blip doesn't start a duplicate.

`await` and `wait-any` return on a notice (§2, §6), not only when an agent finishes, so a parent that is waiting
hears about trouble when it happens. That includes the user's own agent through the plugin: an MCP server can't
push to the model, so this is how it learns.

### 2. Two kinds of stuck, each with a default action

| Signal | Who reports it | Meaning | Default action |
|---|---|---|---|
| **dead** | nobody: no reports for `CAPCOMD_SILENT_AFTER_MS` | the supervisor or the VM is gone | confirm (§1), then recover as today (driver takeover, re-attach) from the last checkpoint |
| **idle** | the supervisor | the agent CLI produced no events for `idleAfterMs` | notify; after a second window, checkpoint and stop (an idle VM still costs money) |
| **spinning** | the supervisor | the same tool call K times in a row, or events with no change in the workspace for a window | notify; after a second window with no change, checkpoint and stop |
| **failing** | the supervisor | the same error K times | same as spinning |

Each is a notice to the parent first. A parent that sends a message or a grant resets the window. The thresholds are
profile fields with defaults; they measure behavior, so a long task that keeps changing things never trips them.
The heuristics will have false positives, which is why the first window only notifies.

**Step 4 (built).** Where it differs from the above:

- **Who detects it.** The runner on the engine detects idle, spinning and failing (`src/agents/stuck.ts`), not the
  supervisor: it already parses each CLI's events through the adapters, and the supervisor stays provider-agnostic.
  The adapters now report each event's tool calls (`name input`) and results (with the error text when a call
  failed); codex reports a tool step once, as both.
- **The signals.**
  - idle: no events for `idleAfterMs`; the stop is at twice that (it used to be at `idleAfterMs`).
  - spinning: the same call `stuckRepeats` times in a row (profile field, default 8); text between calls doesn't
    break the run, a different call does. The "no change in the workspace for a window" variant isn't built.
  - failing: the same call failing with the same error `stuckRepeats` times, numbers in the error ignored, and not
    necessarily in a row; that call succeeding clears it.
  - Stop at twice the repeats; the limit is the kind (`result.limit` idle, spinning, failing), and the work is
    kept as with any limit.
- **The notice.** The runner tells the engine (`notice` on the agent, `AGENT_NOTICE` / `AGENT_NOTICE_CLEARED`)
  and asks the supervisor for a checkpoint (`checkpoint.request` in the VM; reason "notice"). It clears when the
  agent does something else, and when the agent finishes or pauses.
- **dead** isn't stored: it is derived where agents are shown (no heartbeat for `CAPCOMD_STUCK_AFTER_MS`, or no
  live driver), and its action stays the driver takeover in `await`. `notice` shows all four; `stuck` keeps the
  text for callers that only show a flag. The "confirm before acting on silence" check isn't built.
- **Waking.** `capcomd_await`, the in-VM `await`/`wait-any` and `capcomd await --notices` return early with
  `notices` when one is raised while they wait (not one already showing when the wait began). On the host CLI it
  is opt-in, so scripts that wait for the end keep working. Internal waits (`verify`'s reviewer, handoffs, the
  `run` recipe) don't return on notices.
- **Not built:** a parent's message or grant resetting the window (the runner doesn't see them), and profile
  presets for the windows.

### 3. Checkpoints instead of caps

The supervisor snapshots the workspace without touching it: a temporary index (`GIT_INDEX_FILE`), `git add -A`,
`write-tree`, `commit-tree` on the current HEAD, pushed to `refs/capcomd/checkpoints/<agentId>`. The agent's working
tree, index and history are unchanged. It does this after the agent commits, when a stuck signal fires, at each
spend step when a budget is set, and every `checkpointEveryMs` otherwise (a cadence, not a limit).

Each checkpoint sends a progress report up: spend since the last one, the diff against the base, the last test
result, and the agent's last message. Any stop (a limit, stuck, a crash, cancel) loses at most one interval of work,
and a parent continues from the checkpoint the way it continues from a stopped branch today (PR #4).

Step 3 (built: the supervisor, its outbox and checkpoints):

- **The supervisor** is `src/agents/supervisor.mjs`, a dependency-free Node program.
  - `run.sh` starts it when the VM has `node`, and it runs the agent line from `agent.sh`. A VM without node (a
    native CLI) runs the agent directly, as before.
  - It appends reports to `outbox.jsonl`: `start`, a `heartbeat` every 30 s (with the count of agent events and
    when the last one came), `checkpoint`, `error` and `exit`.
  - The runner drains the outbox in the same exec that tails the agent's log, so the transport adds no calls.
- **Heartbeats** now come from the supervisor's reports (its `start` and each `heartbeat`), so an agent that is
  quietly thinking still shows as alive. The agent CLI's events still count too, as in PR #3: any sign of life is a
  heartbeat, which also covers the supervisor's start-up before its first interval, and a VM without a supervisor.
- **Checkpoints** are taken at start (the baseline, not reported), every `checkpointEveryMs` (profile field,
  default 10 min) and when HEAD moves.
  - The supervisor only writes the commit and the local ref. It never pushes, because the agent must not hold push
    credentials. The engine pushes each reported checkpoint with its own git credentials and records it on the
    agent (`checkpoint`, `AGENT_CHECKPOINT`).
  - Reviewers and reporting agents don't checkpoint.
- **Not built yet:**
  - spend and stuck states in the supervisor's reports (the runner computes both from the log; see §2, step 4);
  - checkpoints at each spend step;
  - `send`/`inbox` for workers (a headless CLI can't read a message mid-run, so this needs its own design);
  - deleting checkpoint refs once their agent's work has landed.

### 4. Limits are optional

- `maxTurns`, `timeoutMs` and `maxBudgetUsd` have **no defaults**. Unset means none. A profile that sets one gets
  today's behavior (stop and keep the work, PR #4). The built-in defaults (`AGENT_MAX_TURNS` 30,
  `AGENT_TIMEOUT_MS` 20 min, `AGENT_MAX_BUDGET_USD` $2) go away; Claude gets `--max-turns` and `--max-budget-usd`
  only when they're set; setup stops writing caps into the profiles it creates.
- **Spend is metered live for every provider:** the supervisor adds up per-message token usage times the
  configured rates (as the runner already does for Codex). It is shown in `tree`, `inspect` and every check-in.
- **Enforcement stays with the engine.** A budget protects the parent's money, so the child reports spend and the
  engine compares it to the budget and sends the stop. That works for any provider, unlike Claude's launch-time flag.
- **Run ceiling:** `run new --budget` stays the place for a hard money cap. Setup asks API-key users once ("cap
  spend per run? $___ / no limit"); subscription users aren't asked.
- **The budget tree is unchanged:** a unit a parent doesn't set is already unlimited for its children
  (`src/primitives/policy.ts`). A spawn without a budget reserves nothing, except a cap its profile sets.
- **Turns** stay accepted as a budget unit for compatibility, but they're never defaulted (reserved only when a spawn
  names them or the profile caps them), and the docs
  say they're counted differently per provider.
- **grant:** `capcomd grant <run> <agt> --budget …` (and an MCP tool) raises a running child's budget, within what
  the parent has left.

### 5. Tree size is bounded by count, not by budget

With budgets optional, `maxTotalDescendants` (children, grandchildren and so on over an agent's lifetime) is the guard
against runaway fan-out; `maxChildren` only counts concurrent children. It already exists, and setup's planner sets
6. A profile that allows spawning and doesn't set it gets a default (10). It bounds how many agents a tree starts,
not how long any of them works.

### 6. Provider quota is a pause, not a failure

The supervisor recognizes the provider's usage-limit stop (per CLI; the exact output must be checked against the
real Claude and Codex CLIs) and reports state `quota`, with the reset time when the provider gives one. The agent
checkpoints and goes to a new `paused` status. That isn't a failure, so it isn't retried. It resumes after the reset
(a scheduled wake) or on `capcomd resume`, from its checkpoint. Other agents on the same login will hit the same
quota, so the report names the login and new spawns on it wait.

Step 2 (built), until the supervisor exists:

- **Recognizing it.** The output was read from the CLIs' own code at the pinned versions, not captured live.
  - **Claude Code 2.1.303:** sends a `rate_limit_event` with `rate_limit_info.status: "rejected"` and `resetsAt`
    in epoch seconds. Then come a synthetic assistant message (`error: "rate_limit"`, `api_error:
    "usage_limit_reached"`, text "You've hit your … limit · resets 3pm (Zone)") and an `is_error` result; exit 1.
    `api_error` is internal, so the text prefix counts too. A plain 429 is retried by the CLI and isn't quota.
  - **Codex 0.163.0:** `turn.failed` with "You’ve hit your usage limit. … Try again at 3:05 PM." The reset is only
    given as VM-local clock text, so codex runs with `TZ=UTC` and the text is parsed best-effort. Prepaid quota,
    out-of-credits and spend-cap messages count too (no reset time).
- **The stop.** The runner stops the agent at `quota` and keeps its work like any limit (`Capcomd-Stop: quota`).
  The engine pauses it (`AGENT_PAUSED`) until the reset. With no reset time, it pauses for `CAPCOMD_QUOTA_RETRY_MS`
  (default an hour).
- **The login.** It is recorded on the engine host (`quotas.json`), so a new or resumed agent on that login pauses
  at once until the reset instead of starting.
- **Waking.** A paused agent wakes while it is awaited (`await`, `wait-any`, an in-VM `await`) once its reset has
  passed, or on `capcomd resume` / `capcomd_resume`, which also clears the login's wait. A wake is a new epoch:
  a fresh worker and VM, on its branch, told that it was stopped and should continue. That answers the
  open question for now: a new session from the branch, not the CLI's own session resume.

## What changes elsewhere

- **ADR-016 (multi-unit budgets):** enforcement applies only to limits that are set; there are no default caps.
- **ADR-017 (heartbeats):** heartbeats come from the supervisor for every agent; the single `stuck` flag becomes
  the dead/idle/spinning/failing notices, with the default actions above.
- **PR #3:** an interim step; its engine-side heartbeat is replaced by supervisor reports.
- **Profile presets (proposed, not built):** they set check-in cadence and stuck thresholds, not caps.

## Consequences

- A long task runs as long as it makes progress; a looping agent is noticed in minutes, not when a cap runs out.
- Subscription users get no money limits by default; API-key users choose one at setup, and see spend live.
- Workers that can't spawn get liveness, progress reports and messages through the supervisor.
- More runs inside the VM, and the supervisor becomes the thing liveness depends on: it must be small, have no
  dependencies, and be tested under the chaos suite (killing it must read as "dead").
- Reports still arrive one poll interval late (the pickup transport).
- The stuck heuristics can be wrong; the first window only notifies, so a false positive costs a notice, not work.

## Plan

Each step is its own PR, with fake-claude markers for its cases (long work with progress, idle, spinning, quota):

1. Optional limits: no default caps, flags only when set, setup changes (and its API-key question), live spend
   metering for Claude, a default `maxTotalDescendants`.
2. Quota pause (`paused`, `resume`), once the CLIs' usage-limit output is confirmed.
3. The supervisor and its outbox: heartbeats for every agent (replacing PR #3's path), checkpoints, `send`/`inbox`
   for workers.
4. Stuck notices and their default actions; `await`/`wait-any` wake on notices.
5. `grant`.

## Open questions

- The usage-limit output and reset times of each CLI: read from their code (§6); still to confirm on a live run.
- Resume from a checkpoint with a new session, or the CLI's own session resume (`claude --resume`, `codex exec
  resume`): the second keeps the model's context, but the session lives in the VM.
- Default windows: `idleAfterMs`, the spinning window and K, `checkpointEveryMs`.
- Whether a checkpoint should also be offered for verify and merge, or only for continuing.
