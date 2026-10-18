# Calling capcomd from another agent (Hermes as the example)

capcomd is built to be the back end for a front-door agent. The agent talks to the user, turns a
request into a goal and hands it to capcomd. capcomd plans the goal, leases the tasks to workers,
verifies each one, merges it, and recovers if anything crashes. The caller only sees a run id,
status and summaries, never thousands of worker turns.

You can integrate in two ways, and both use the same schema (`relay.v1`):

| | MCP (`capcomd mcp`) | CLI (`capcomd … --json`) |
|---|---|---|
| Best for | Agents with MCP support (Hermes) | Shell-based agents, CI, scripts |
| Transport | stdio JSON-RPC | process + stdout |
| Output | tool result JSON (`structuredContent` and text) | one JSON object, or NDJSON for `run` |

Prerequisite: the engine is running (`capcomd serve`, port 6420; set `CAPCOMD_ENDPOINT` to point at a
different one).

## MCP

Register capcomd as a stdio MCP server in Hermes's config:

```yaml
mcp_servers:
  capcomd:
    command: bun
    args: ["/path/to/relay/src/cli/index.ts", "mcp"]
    env:
      CAPCOMD_PROTECTED_BRANCHES: "main,release/*"
```

### Tools

| Tool | Input | Returns |
|---|---|---|
| `capcomd_run` | `goal`, `runId?`, `targetBranch?`, `wait?`, `timeoutMs?` (max 600000) | `{runId, log, next}`; with `wait`: also `status`, `timedOut` |
| `capcomd_status` | `runId` | `{run: {runId, state, goal, budget, tasks[], awaitingApproval[], events}}` |
| `capcomd_cancel` | `runId` | `{runId, state, changed}` |
| `capcomd_events` | `runId`, `cursor?`, `limit?` (1–500, default 100) | `{events[], nextCursor, total, truncated}` |
| `capcomd_trace` | `runId`, `cursor?`, `limit?` (default 200) | `{traceId, durationMs, spans[], nextCursor, total, truncated}` |
| `capcomd_approve` | `runId`, `taskId`, `approvedBy?` | `{runId, taskId, state, already}` |

Every result is `{"schema":"relay.v1","ok":true,…}`. Results are capped at 20,000 characters. When
`capcomd_events` or `capcomd_trace` drops items to fit, it sets `truncated: true` and returns a
`nextCursor` to continue from. Never assume a page is complete unless `truncated` is
`false`.

Errors come back with `isError: true` and a body you can act on:

```json
{"schema":"relay.v1","ok":false,"error":{"code":"not_found","message":"Run run-x not found","hint":"Start one with `capcomd run <goal>`."}}
```

`code` is one of `usage`, `not_found`, `engine_unreachable`, `run_failed` or `conflict`. `hint` is
always a concrete next step, so pass it on to the user or act on it.

### A Hermes session

```
user   → Hermes: "Add rate limiting to the API and ship it to main."
Hermes → capcomd_run {goal: "Add rate limiting to the API", targetBranch: "main", wait: true}
capcomd  ← {runId: "run-…", status: {state: "executing", awaitingApproval: ["task-1"]},
          next: "Approve with capcomd_approve {runId: …, taskId: \"task-1\"} after review."}
Hermes → user: "task-1 passed verification and is ready to merge into main. Approve?"
user   → Hermes: "yes"
Hermes → capcomd_approve {runId, taskId: "task-1", approvedBy: "hermes:user"}
Hermes → capcomd_status {runId}            (poll; repeat approve for each task that parks)
capcomd  ← {run: {state: "completed", …}}
Hermes → capcomd_trace {runId, limit: 50}  (optional: summarize where the time and cost went)
```

Guidelines for the caller:
- Poll `capcomd_status` every few seconds. Don't hold `wait` open for long runs.
- `awaitingApproval` non-empty means a human or policy decision is needed. Approval is
  per task, and tasks run in order, so the next task may park right after you approve one.
- `capcomd_run` with an existing `runId` resumes that run. After a crash, re-issuing the same call is safe.
- Use `capcomd_events` (paginate until `truncated` is false) for an audit trail, and `capcomd_trace` for timing.

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

## Approval gate

A task parks in `awaiting_approval` after verification passes when its target branch matches
`CAPCOMD_PROTECTED_BRANCHES` (comma-separated, trailing `*` glob, default
`main,master,release/*`). The engine process reads that variable. The task stays there until
`capcomd approve` or `capcomd_approve` moves it to `merged` (event `APPROVED`, recorded with
`approvedBy`). Cancelling the run cancels tasks that are parked. Without `--target-branch`, tasks
merge their own `task/<id>/e<epoch>` branches, which are unprotected, so the default path and the
chaos suite never wait for approval.
