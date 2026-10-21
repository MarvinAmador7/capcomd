# capcomd JSON output contract

Machine consumers (apps/tui, the in-VM CLI, scripts) rely on these fields. Every `--json` line is one
JSON object with `schema` (`SCHEMA` in src/cli) and `ok`. Fields marked **alias** are kept for
back-compat. They will not be removed without bumping `schema`. New fields are additive.

Time: every timestamp is ISO-8601 UTC (`ts`, `startedAt`, …). Where an epoch is also given it is in ms
(`epochMs`, `startedAtMs`). Consumers convert to local time.

## Events: `capcomd events <runId> [--since-seq N] [--follow [--until TYPE] [--timeout-ms N] [--from-start]]`

Each event record (list: `events[]`; `--follow --json`: one line per event):

| field | meaning |
|---|---|
| `seq` | 1-based position in the run's merged, time-ordered log. Resume a stream with `--since-seq <last seq>`. |
| `entitySeq` | per-entity counter (run / task / scope agent). Unique together with `entity`. |
| `ts` / `epochMs` | the event instant (ISO / ms). `at` is an **alias** of `epochMs`. |
| `agentId` | scope agent the event is about, or `null` (run/task events). Always present. |
| `entity`, `type`, `event` | source entity, event type, full payload (unchanged). |

`--follow --json` lines are `{runId, seq, ts, epochMs, agentId, type, event: <record>}`, and the stream ends
with `{runId, end:{stopped}, ts}`. `--follow` dedupes on (entity, entitySeq), so an event is emitted once
even when others land in the same millisecond. Caveat: `seq` is a position. If two actors write in the same
millisecond, a late arrival can sort before an emitted event. A consumer that needs exactly-once across
reconnects should dedupe on (entity, entitySeq).

`capcomd run --json` progress lines also carry `seq` (per-process line counter), `ts`, `epochMs`, `agentId`.
In-VM `capcomd events` (ADR-017) returns scope events with `seq`, `ts`, `epochMs`, `at`, `agentId`.

## Tree: `capcomd tree <runId> [--root agt] --json`

`{runId, root, tree:[node], totals}`. Each node has the following fields:
`agentId, parent, profile, depth, status, budget, spent, rollup, stuck?, children[]`,
plus `createdAt`, `startedAt` (first AGENT_STARTED), `endedAt` (terminal event, null while live),
`taskId` (worker task label; the plan task id for recipe agents, else the agent id), and
`spanId` (the agent's `agent.run` span id, deterministic: `agentSpanId(runId, agentId)`).
Cost: `spent.usd` is billed spend (0 under subscription billing). A subscription-billed agent whose CLI
reported a cost also has `notionalUsd` (the API-price estimate) and `billing`; `rollup.notionalUsd` and
`totals.notionalUsd` sum it over the subtree / run. It is never added to `usd` and never counts against a budget.

## Verify: `capcomd verify <runId> --ref <agt|branch> --json` → `{id, kind:"verify", state, …data, result}`

`state` is `passed` | `failed`, or `running` while an in-VM verify waits on its reviewer (poll with the
same `--key`; the CLI does). The data echoes `ref, agentId, branch, target, check?, checks, acceptance,
reviewProfile`. `result`: `pass` (checks and, when a reviewer is set, the review), `commit` (the branch
commit that was tested), `checks {passed, status, reason?, files?, output}`, and with a reviewer
`review {profile, agentId, passed, reasons[], error?}` plus `judge {profile, passed, feedback}`, a mirror
for callers of the old `--judge-profile` contract. A review with no verdict has `passed: false` and an `error`.

## Status: `capcomd status <runId> --json` → `{run}`

`runId, state` (run lifecycle), `goal`, `startedAt`/`startedAtMs` (first run event), `budget{spent,maxCost}`,
`tasks[]`, `pendingApprovals[] {taskId, kind:"merge", targetBranch, since}`,
`awaitingApproval[]` (**alias**: task ids only), `scope` (`null` unless the run has scope agents:
`{state: running|done|failed, agents, byStatus}`), `events` (count).

## Inspect: `capcomd inspect <runId> [--json] [--follow [--since-seq N] [--until TYPE] [--timeout-ms N]]`

Without `--follow`: one `{type:"inspect.snapshot", runId, ts, epochMs, seq, status, tree, totals, trace, events}`.
Here `seq` is the last event seq, `status` is the status object above, `trace` is `capcomd trace --json`'s `trace` (or `null`),
and `events` is the event list above.

With `--follow`, the lines are:
1. a snapshot (with `--since-seq N`, `events` holds only seq > N)
2. `{type:"event", runId, seq, ts, epochMs, agentId, event}` per new event
3. `{type:"inspect.tree", runId, seq, ts, tree, totals}` after each `AGENT_*` event
4. `{type:"inspect.end", runId, ts, end}` to close

`capcomd inspect <runId> <agt>` (one agent: record, children, awaits, logs) is unchanged.

## Spans (`.traces/<runId>.ndjson`, `capcomd trace`)

- `agent.run` (one per scope agent; spanId = `agentSpanId(run, agent)`, parent = the parent agent's span):
  `relay.agent_id`, `relay.parent_agent_id` (null at root), `agent.id`/`agent.parent` (**aliases**),
  `agent.profile`, `agent.depth`, `agent.status`, `agent.cost_usd`, `agent.turns`. These are always stamped, including failed runs.
  Subscription-billed agents also get `agent.billing` and `agent.notional_cost_usd` when the CLI reported a cost.
- `agent.claude_code` / `agent.codex` (the CLI run in the VM): carry `relay.agent_id` and `relay.parent_agent_id`, parented
  under the agent's `agent.run`. On success they have `agent.cost_usd`, `agent.turns`, `agent.stop_reason`, `agent.billing`. On
  failure or timeout they still have `agent.cost_usd` (0 under subscription billing), `agent.notional_cost_usd`,
  `agent.turns`, `agent.error_kind`, and `agent.stop_reason` (the guard, e.g. `timeout`, or the error kind).

Regression gate: tests/scenarios/contract.test.ts.
