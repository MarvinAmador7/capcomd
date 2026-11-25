# CHANGELOG

- Agents hand back typed: `capcomd result --handback '{"status": "done", "outcome": "…", "changed": [{"path": "…"}],
  "checked": [{"check": "bun test", "result": "passed"}], "risks": [], "decide": []}'` (`handback` on the
  `capcomd_result` tool). capcomd checks it before recording it: one that doesn't fit is refused with each field to fix
  ("status: must be one of "done", "partly", "blocked"; changed[0].path: required"), and nothing is recorded. Without
  a `--summary`, its prose form ("Done: …", then bullets) is the summary, so the commit subject and older readers are
  unchanged. A prose `--summary` alone still works. Workers and leads are taught the typed form; a planner's summary
  stays prose (it opens the pull request).
- A parent reads a child's typed hand-back as fields: `result.typed` is `{schema: "handback@1", value: {status,
  outcome, changed, checked, risks, decide}}` in `capcomd await`, `status` and the driver's tools (marked untrusted,
  with its author, like the summary).
- A reviewer's verdict is typed too (review-verdict@1): it ends with `{"passed": …, "findings": [{"severity":
  "blocker", "file": "src/a.ts", "line": 3, "text": "…"}]}`, recorded as `result.typed`. `result.verdict.reasons` are
  the same findings as lines ("src/a.ts:3: …"); a reviewer that sends `reasons` still works.
- The desktop app draws typed hand-backs as cards: the outcome line ("Done", or "Blocked" in red), what you must
  decide, the files changed, each check with its result on the right (a blue tick, "Failed", "Not run") and the
  risks. A reviewer's card lists its findings with their severity and file:line, "blocker" in red.
- An agent's bookkeeping is no longer in its thread by default: arming a wake or booking a check-in, waiting on other
  agents, reading its own status, inbox or events, and its CLI's system events (a retried or fallen-back model request,
  a compacted conversation). It is still recorded: an agent's ••• menu in the desktop app has Show Bookkeeping, and a
  conversation rebuilt from the thread leaves it out.
- harness.v1: thread items carry `internal: true` for bookkeeping, left out of GET …/thread, …/thread/tail and
  `?thread=1` frames unless asked for with `internal=true` (`internal=1` on the stream); a handoff item carries
  `child.handback` and `child.verdict.findings`; `GET /v1/schemas` lists the payload schemas (`name@version`, never
  changed once registered); `Agent.result.typed`. Capabilities `agents.thread_internal` and `agents.handback_typed`.
