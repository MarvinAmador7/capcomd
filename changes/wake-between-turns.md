# CHANGELOG

- Planners and leads no longer wait inside a tool call. In its VM an agent runs `capcomd verify --ref <agt> --wake`,
  `capcomd check --wake` or `capcomd await <agt…> --wake` (`wake: true` on the MCP tools): it answers at once, the
  agent ends its turn, and the result comes to it as a message that starts its next turn ("Wake-up wk-…: verify vfy-…
  passed"). `capcomd wake --op <id> | --agents a,b [--all] | --events agent.done,… | --in 10m | --at <time>
  [--note "…"]` (`capcomd_wake`) does the same for anything else, and books a check-in; a wake waits at most 6 hours.
  `capcomd wake --list` and `--cancel <wk>` manage them. An agent can wait only on what it can see (its own subtree
  and its siblings'). A Codex agent can't be woken and keeps the blocking forms.
- The orchestration skill and the planner's brief teach it, and how to write a child's task: for a stranger (the files
  it owns, what is out of scope, the command that proves it's done), no more than three deliverables, no two tasks on
  the same files, dependencies stated, milestones rather than heartbeats.
- The desktop app shows a waiting agent as "waiting for verify vfy-… · 4:12" (or "waiting for 3 agents") instead of a
  running tool call, and a quiet "verify passed · woke planner" line in its thread when it is woken.
- Messages (yours, a child's, a wake-up) now reach a running agent at once instead of within 5 seconds, and an agent
  that is started again (a new attempt) is never handed a message it already read.
- When the daemon restarts in the middle of a verify, check or merge that an agent is waiting on, it picks that work
  up again as it starts, so the agent isn't left waiting until its wake's deadline.
- harness.v1: new events `agent.wake_armed`, `agent.woken` and `agent.wake_cancelled` (on run streams and the lifecycle
  feed, causes `waiting`, `woken`, `wake_cancelled`), and Agent.activity of kind `wait` with `wake` (what it waits for,
  `armedAt`) while an agent waits; capability `agents.wake`.
