# ADR-026: Durable agents and threads

**Status:** proposed (draft, 2026-11-19). The owner's decisions are marked **☐ Owner** and gate the phases that need
them. Builds on ADR-016 (primitives), ADR-017 (in-VM capcomd, the spool pump), ADR-019 (liveness, usage-limit pauses),
ADR-021 (sandbox provider surface) and ADR-022 (an agent's lifecycle as a Rivet workflow). Research: four spikes run on
2026-11-19 (durable CLI sessions, boxd/Docker hibernation, event-driven waits with a working prototype on
`spike/event-wake`, Vercel Board's source), and the products below.

## Context

The owner, after a finished planner refused a message ("agt-… is done: nothing will read this message"):

> From a first principles perspective, a cloud/always-on agent or project — the user should not perceive any issue at
> all resuming a conversation later on. The whole purpose of durable orchestration is to have durable threads too. VMs
> are just infra: the state should be durable and the orchestrator should just spawn a new VM if the original is not
> available. Also the planner VM should be hibernated, not deleted.

What capcomd does today (`main` 623dfd02):

| Today | Where |
|---|---|
| An agent's machine is destroyed at every end: done, failed, cancelled, **and paused** | `ops.ts` `settlePushed` → `drainWorker` (:1128), :1142-1153, :978, :1473; `worker.ts:208-285` |
| A finished agent refuses messages and new work | `ops.ts:1681`, `:79`; `server.ts:596`; terminal states `policy.ts:7` |
| A resumed agent gets a new machine and a **new conversation**: the branch plus one line, "you were stopped earlier" | `agent-workflow.ts:87` (machine key includes the epoch); `runner.ts:372` |
| The agent CLI's own session is never kept: Claude Code writes one in the VM that is never copied out; Codex runs `--ephemeral`; no session id is recorded | `runner.ts:450`, `agent-claude.ts:87-102`, `agent-codex.ts:89` |
| Thread items are durable but lossy (64 KB an item, a tool's last 16 KB); `capcomd logs` are one-line summaries | `scope.ts:411`, `:408`; `packages/agent-thread` |
| Long waits happen **inside a tool call**: `verify`/`check` loop in the VM CLI (2 s) against a 90 s host hold, `await` asks every 1 s; Claude Code's Bash tool cuts a call at its own limit (capcomd never sets `BASH_DEFAULT_TIMEOUT_MS`) and the model calls again | `vm-cli.mjs` `verifyLoop`/`awaitLoop`, `rpc.ts` `VERIFY_HOLD_MS` |
| Suspend exists in the provider seam but is boxd `pause` (memory kept, billed like running) and nothing calls it; boxd machines are kept awake by an `exec true` every 30 min | `seam.ts:112-113`, `boxd.ts:363-370`, `:127`, `:233-247` |

The incident that started this (run-1795099418840-hkl5xs0): the planner sat in `capcomd verify` for 30 minutes while a
check that could never finish re-ran in a new VM every 20 (fixed in `src/merge/verify.ts`), then gave up; the work was
reviewed and passed but never landed, and the user could no longer talk to the planner.

### What others do

| Product | After the agent finishes | When its machine is gone |
|---|---|---|
| Devin | Sessions sleep instead of ending; a message wakes them (resume window ~14 days) | Snapshots restore the machine, not the conversation |
| Codex cloud | Follow-ups reuse a container cached up to 12 h, branch re-checked-out | Rebuilds container + branch |
| Cursor cloud agents | Follow-ups wake the agent, chat history kept | Recreates VM + branch |
| Claude Code on the web | Continue, or teleport session + branch to the terminal | Environment reclaimed; an expired session starts fresh |
| Conductor (local) | Workspace = worktree + branch; the CLI's own session resumes (`claude --resume`, deleted after 30 days); archive/restore keeps chats; a checkpoint per turn as a private git ref | n/a |
| Conductor Cloud | Sandbox sleeps after 4 h idle, files and chat survive, processes don't; a sandbox lives ≤ ~24 h | Replaced routinely; chat restored onto a new sandbox |
| Vercel Board | A task is a thread with board-kept state; "matching events wake your deployment, so no process needs to stay running between events"; "the lead never polls"; "a question doesn't hold a worker" | Not its concern: it records that a PR exists; no verification or merge gate |

Everyone treats the machine as a cache with a lifetime; continuity breaks when it expires (Devin loses the
conversation, Claude Code on the web starts fresh). Nobody gates what lands. capcomd can do both.

### What the spikes proved

- **A Claude Code session resumes on a fresh machine** (real CLI 2.1.303, Docker): the session `.jsonl` plus a git
  bundle moved to a new container at a different path, and `claude -p --resume <id>` (also with
  `--input-format stream-json`, as capcomd runs it) continued the same conversation. `--session-id <uuid>` lets capcomd
  pick the id; 2.1.303 ↔ 2.1.311 both ways worked; a redacted file still resumes; an unknown id fails detectably (exit 1,
  "No conversation found"). The system prompt is frozen at the first run, so new context must arrive as a user turn. A
  different checkout path costs the agent one tool call to notice. Real session sizes: p50 6.8 MB, p90 91 MB, max 301 MB,
  plus an `<id>/` folder for long sessions.
- **Codex** resumes the same way against a mock model (`codex exec resume <id>`, the rollout file must keep its
  `rollout-<ts>-<id>.jsonl` name); a real backend (encrypted reasoning replay) is unverified.
- **Hibernation:** boxd `hibernate` writes memory to disk and bills disk only (typical €0.0016/h; ~€0.01–0.04/day for a
  parked agent machine), waking in ~0.1–0.2 s per boxd's docs; `pause` keeps memory and costs ~20×. Docker stop/start
  took 0.23–0.38 s on OrbStack; files (and a session file) survive, processes don't. capcomd's `ensure` already wakes a
  hibernated boxd machine or a stopped container it finds.
- **Event-driven waits:** a prototype (`spike/event-wake`, `src/actors/wakes.ts`) lets an agent arm a wake, return in
  about a second, end its turn, and receive the event as a new turn exactly once — for an op, a set of agents, events
  after a cursor, or a time — including across an engine restart. 5 scenario tests; `test:fast` green.
- **Vercel Board** (source: `vercel/board` SPEC.md, `@vercel/board@0.52.0`): capcomd already has its core — an ordered
  log with cursors, leases with an epoch fence and takeover, dependencies, idempotent writes, credential-free VMs — mostly
  in a stronger form. What capcomd lacks is how agents wait and get woken (watchers with a durable queue, schedules,
  filtered cursor waits), "ask and stop", typed payloads, and a richer task state machine.

## Decision (proposed)

### 1. The thread is the record; an agent is never "done"

An agent is a durable thread: its items, its CLI session, its branch or checkpoint, its memory. Machines and processes
serve it and come and go. "Done", "failed", "cancelled" describe how a **turn or an attempt** ended, not the agent.

Agent states the user sees:

| State | Means | Machine |
|---|---|---|
| working | a turn is running | running |
| waiting | its turn ended with a wake armed (§3): a verify, children, a time | warm, or parked |
| asked | it asked a question and stopped (§4) | parked |
| idle | its turn ended; it is waiting for nothing | parked (§5) or none |
| archived | the run was archived: read-only until restored | none |

A message to any of them except archived is always accepted and starts a turn. The app never says "nothing will read
this message"; the composer of an idle agent reads "planner is idle. Send to continue." Cancel stays final for what it
cancels (the turn and its children); the thread can still be continued.

**☐ Owner:** does a finished *run* keep accepting messages forever (until archived), or for a window? Proposal: until
archived; archived runs restore on demand.

### 2. The CLI session is durable state

- capcomd picks and records the session id at the first turn (`claude --session-id <uuid>`; Codex without
  `--ephemeral`, reading `thread.started.thread_id`), stored with each attempt.
- The runner tails the session file by byte offset in its existing poll loop and flushes at the end of every turn (and
  the `<id>/` folder at the end), into host state: `stateDir()/sessions/<run>/<agent>/…`, compressed, mode 0600 —
  never in actor SQLite (size) and never in git or checkpoint refs (it would push transcripts to the remote).
- Strings pass through the runner's existing `Redactor` before they are stored. Residual risk, stated: a session holds
  everything the agent read, including a secret it read from a file.
- An agent keeps one checkout path across machines (`${workdir}/<agentId>/repo`, not `${taskId}-e${epoch}`).

**☐ Owner:** where sessions live beyond the host (object storage for capcomd cloud, the iCloud sync plugin for the
desktop?) and how long (proposal: as long as the run, deleted with it).

### 3. Waits happen between turns, never inside a tool call

- **`wake.arm`** (from the prototype): an agent records "wake me when" — an op ends (`verify`, `check`, `merge`),
  agents end (any/all), event types after a cursor, or a time — with a deadline (default and max 6 h). The match runs in
  the same transaction that appends the event, arming checks the current state in the same transaction (no lost
  wakeups), and firing puts exactly one message in the agent's mailbox (idempotency key `wake-<id>`), in event-log
  order. In the VM: `capcomd verify|check|await|wait-any … --wake`, `capcomd wake …`; MCP: a `wake` flag and
  `capcomd_wake`.
- **Schedules:** the timer form: an agent books its own check-in (`capcomd wake --in 5m --note "check CI"`).
  Board's rules apply: a send id derived from `(schedule, n)`, missed slots skipped, cancelled when the target ends.
- **A durable delivery cursor per agent:** the last message seq the CLI took, so a new attempt never re-delivers.
- **Push delivery:** the scope broadcasts "messages changed" to the runner instead of a 5 s poll.
- **A filtered, cursor-resumable wait** on the API (`GET /v1/events?scope=&after=&wait=&type=&agent=`), with Board's
  before-or-after rule for state filters, for drivers and the app.
- The in-VM CLI's waits stop being loops the model sees: `--wake` is what the skills and prompts teach, and capcomd sets
  `BASH_DEFAULT_TIMEOUT_MS` for the few blocking waits left.

### 4. Ask and stop

An agent that needs a decision runs `capcomd ask "<question>" --recommend "<answer>"`: its work is checkpointed and
pushed, it becomes **asked**, its slot frees, and the question goes to its parent (or the user at the root) as an
approval of a new `question` kind. The answer is appended to the thread and wakes the same conversation (§5). A parent's
`await` returns on asked, as it does on notices.

### 5. Waking: fastest path first, never a dead end

1. **Warm:** the CLI process is still alive with its input open (as jobs already do) → the message is its next turn.
2. **Parked machine:** wake it (boxd `wake`, `docker start`; `ensure` with the same machine key already does this) →
   restore nothing; start the CLI with `--resume <session>`.
3. **Fresh machine:** a new VM from the project's warm template + the agent's branch or checkpoint at its stable path +
   the saved session placed under the new path's slug → `--resume <session>`.
4. **Fresh session:** the session can't resume ("No conversation found", a CLI too far apart, a corrupt file) → a new
   session whose prompt is built from the thread items, and one quiet line in the thread saying so.

The wake message carries what changed (the user's text, "verify vfy-… passed", "agt-… answered"), because the system
prompt is frozen. The app shows "Waking planner…" with the real phase (the getting-ready states, `agents.setup`).

### 6. Hibernation is a latency optimization, never a requirement

- When a **planner or lead** (an orchestrate profile, or any agent the user can reply to in a thread) finishes its turn
  idle or asked: stop the keepalive, `hibernate` on boxd (never `pause`) or `docker stop -t 5` on Docker, and set the
  delete deadline to the retention (boxd `setDeleteAfter`, enforced while hibernated; Docker's ledger + sweep).
- **Workers** are destroyed when their work is merged, as today; their branch and session are enough to wake them on
  a fresh machine if anyone ever does.
- The machine key is recorded on the agent and carried across attempts (not derived from the epoch).
- Delete when: retention passes, the run ends or is archived, the agent is cancelled, the user deletes it, or the parked
  count passes a cap per place (oldest first) so parked machines never block a spawn against the org limit.
- Seam: `SandboxCaps.hibernate: "memory" | "disk" | "none"`, optional `hibernate(id)`/`wake(id)`; Docker `ensure` also
  unpauses. Machines list shows parked machines; "Delete idle machines" includes them.

**☐ Owner:** retention default (proposal 24 h; choices 4 h / 24 h / 7 days, per place, recorded per run like the idle
lifetime) and the parked cap (proposal 10 per place). Which roles hibernate (proposal: planner and leads only).

### 7. Typed hand-backs, internal vs shared items

- A schema registry (`name@version`, immutable, a bounded JSON-Schema subset, checked on write — Board's model):
  `handback@1` (outcome, changed, checked, risks, decide) and `review-verdict@1` (passed, findings) first; the app renders
  them and keeps prose as the fallback.
- Bookkeeping (wake arms, polls, check-ins, CLI system events) is recorded but marked internal and hidden by default;
  only progress the user should read is shown.

### 8. Planner and lead guidance (from Board's swarm guide)

Added to the orchestration skill and the planner's brief: write each brief for a stranger (the files it owns, what's
out of scope, the command that proves it's done); more than three deliverables is two tasks; no two tasks change the
same files; dependencies stated (`needs`); post milestones, not heartbeats; never wait inside a tool call.

## Phases

| Phase | What | Effort (spikes' estimates) | Fixes |
|---|---|---|---|
| 1 | §3 warm wake (production of the prototype: event types `agent.wake_armed`/`agent.woken`, a startup sweep for ops a wake waits on, visibility checks, push delivery, skills/prompts, `BASH_DEFAULT_TIMEOUT_MS`) + §8 guidance | 1–1.5 weeks | the polling loops (today's verify incident) |
| 2 | §2 durable sessions + §1 idle-not-done + §5 waking without parking (paths 1, 3, 4) + the app's composer/states | 2–3 weeks | "nothing will read this message"; lost conversations |
| 3 | §6 hibernation (path 2) | 3–5 days + a live boxd e2e | wake latency, cost |
| 4 | §4 ask and stop, §7 typed hand-backs, schedules | 1–2 weeks | workers holding VMs while they wait for an answer |
| later | Board's task board v2 (states, labels, `claim --ready --label --wait`, batch plans, a `task run` wrapper), path-scoped secrets and a Docker egress proxy (own ADR), a harness.v1 conformance suite | — | — |

Phase 1 needs no owner decision. Phase 2 needs the §1 and §2 decisions; phase 3 the §6 one.

## Consequences

- The user can always talk to an agent; the only visible cost of a long pause is a few seconds of "Waking…".
- Planners stop burning turns and wall time inside tool calls; a lead's turn ends and the event wakes it.
- Host state grows by the session files (bounded by run retention); a parked boxd machine costs ~€0.01–0.04 a day.
- A parent's `await` must treat waiting/asked/idle children correctly, and budgets must not count wall time while an
  agent sleeps (**☐ Owner:** does a sleeping agent's wall-time budget pause? Proposal: yes; turns and spend still count).
- Codex can only be woken cold (it reads nothing after its prompt) until verified against a real backend.

## Not doing

Two-way Slack/GitHub/Linear mirroring (capcomd is distraction-free; trigger replies stay one-way), Board's per-channel
grants and "X via Y" identities (until capcomd cloud has teams), memory-preserving local checkpoints (CRIU fails on
OrbStack).

## References

Spike notes (session scratch, 2026-11-19): durable sessions, hibernation, event-driven waits (`spike/event-wake`
b9263d1b, `tests/subagents/wake-cli.test.ts`), Board internals (`vercel/board` 84b24636 SPEC.md). Products: Devin
(cognition.ai/blog/sept-24-product-update, docs.devin.ai/onboard-devin/snapshots), Codex cloud
(developers.openai.com/codex/cloud/environments), Cursor (cursor.com/docs/cloud-agents), Claude Code on the web
(code.claude.com/docs/en/claude-code-on-the-web), Conductor (conductor.build/docs, /docs/cloud,
blog.conductor.build/checkpointing), Vercel Board (vercel.com/blog/introducing-vercel-board, vercel.com/docs/board,
vercel.com/docs/board/guides/agent-swarm, github.com/vercel/board).
