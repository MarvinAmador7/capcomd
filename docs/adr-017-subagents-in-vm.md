# ADR-017: Sub-agents spawned from inside agents

Status: accepted (2026-10-20). Builds on ADR-016 (composable primitives).

## Context
ADR-016 gave the operator primitives (spawn/await/verify/merge/board/kv). Agents themselves
could not use them: a planner agent in a VM could not delegate. We want an agent to orchestrate
its own children with the same verbs, without giving the VM any host secret or network path,
and with limits it cannot exceed.

## Decision

### 1. Transport: RPC over the boxd exec channel (request spool), not a tunnel or proxy
In-VM `capcomd` writes `<spool>/req/<id>.json` (atomic rename) and polls `<spool>/res/<id>.json`.
The agent's host-side driver, which already polls the VM over boxd's authenticated exec API
(it tails the agent's event stream), drains the spool each tick (`req → work → res`), runs the
call against the scope, and uploads the answer. Spool: `/tmp/capcomd-rpc` (one agent per VM).

Alternatives considered:
- **boxd proxy** (`MachineProxies`): routes a public `<name>.<machine>.<zone>` URL *into* a VM
  port. Wrong direction: we need VM → orchestrator, and it would expose a public endpoint.
- **Reverse tunnel / reverse proxy to the orchestrator** (cloudflared, ngrok, a relay): the
  orchestrator often runs on a laptop behind NAT (Marvin's Mac). It needs a public endpoint,
  TLS, an extra service, and an egress allowlist entry per VM.

Why the spool:
- **Zero new egress.** The VM's allowlist is unchanged. That is stricter than "egress only to the
  orchestrator endpoint": there is no endpoint.
- **No host secrets in the VM.** No orchestrator URL, no engine credentials, no boxd key. The
  only thing in the VM is a capability token.
- **Reuses the authenticated channel** the driver already uses; works behind NAT, nothing to deploy.
- **Durable.** Requests are files: a driver that crashes mid-call leaves them in `work/`; the
  next driver re-attaches to the same VM (or scripted "VM" dir) and answers them. Combined with
  per-request idempotency keys (below), a retried spawn never duplicates a child.
- Cost: latency ≈ the poll interval (VM 1s, `CAPCOMD_VM_RPC_POLL_MS`) plus ~2 exec calls per tick
  while requests are pending. Fine for orchestration verbs (seconds-scale). Revisit with a
  streaming exec, or a tunnel if boxd adds VM → host forwarding, if an agent needs chatty RPC.

### 2. Capability tokens
`cct1.<claims>.<hmac>` with claims `{run, sub (the agent), ops[], exp, jti}`, HMAC-SHA256 over
the claims with a host-only key (`CAPCOMD_RPC_KEY` or `~/.capcomd/rpc.key`, 0600). TTL 30 min,
refreshed by the driver every TTL/2 while the agent runs. A token is refused if: its signature or
format is bad, it is expired, its jti is in the scope's `revoked` table (`capcomd token revoke`;
the driver revokes on agent exit), its agent is terminal, or it arrives through another agent's
spool (`sub` must match the spool's owner, so a stolen token is useless elsewhere).
Ops: spawners get all verbs. Others get no CLI at all for real agents (scripted test agents get
status/kv/task/inbox/send/result/heartbeat).

Authority comes only from the token and the scope's limits, never from request text:
- **Writes** (spawn, cancel, send, verify, merge, handoff) reach only the caller's subtree;
  spawn's parent is always the caller and never `--operator`.
- **Reads** (status, await, tree, inspect, logs, events) also see the caller's parent's subtree
  (siblings), so peers can coordinate and await cycles can be detected.
- Contracts from a VM can't carry `checks`: verify runs the root contract's operator-set checks
  or the repo's test command, never VM-supplied shell on the host. In-VM `verify --checks` is
  refused (`forbidden`), not ignored. For per-task checks the operator names them at
  `run new --checks-set add='bun test ./test/add.test.ts' …` (stored in kv `_checks`, read-only from
  VMs). A parent pins one to a child at spawn (`spawn … --check add`, validated then, kept in the
  child's contract); in-VM verify runs the pinned check and refuses any other name (no switching
  to an easier check after a failure), and named checks reach a child only through a pin. The
  operator may still verify with any check. The vfy record keeps the check name and exact command.
- `merge --require vfy` re-runs the checks that verification passed with, not the repo default.
- `merge` needs a passing `verify` of that exact commit. A merge into a protected target is parked
  (`awaiting_approval`) for the operator (`capcomd approve <runId> <mrgId>`, or `--deny`), not refused.
  A run's target can be a staging branch (`run new --target T`); agents can't choose another.
- `spawn --report`: a read-only leaf whose final message is its result (nothing pushed), so research and
  triage work doesn't need the in-VM CLI or a diff.
- kv prefixes `_`, `approval/`, `recipe/`, `handoff/` are read-only from VMs.

### 3. Fan-out is set by the parent, at spawn time (narrow-only)
`spawn --children.{maxChildren,maxDepth,maxTotalDescendants,allowedChildProfiles,budgetShare}`
(MCP: `children: {...}`). The ceiling is the child's profile narrowed by every ancestor. A grant
above the ceiling is **refused** (`children_limit`, message names the limit and ceiling), not
clamped. Narrowing to zero is always allowed. Saturating `maxChildren` returns a retryable
`backpressure` error (`error.reason`, `retryable: true`; in-VM exit 75).

### 4. Tooling
- In-VM `capcomd` (single dependency-free node script, `src/subagents/vm-cli.mjs`) and the same
  verbs as MCP tools (`capcomd mcp`, wired with `--mcp-config` for claude and `-c mcp_servers…`
  for codex): spawn, await, wait-any, status, tree, cancel, send, inbox, handoff, events
  (`--follow`), budget, task, kv, verify, merge, inspect, logs, heartbeat, result.
- **Structured child results**: `{summary, artifacts, data, truncated?, branch, commit,
  verification}`. The agent declares summary/artifacts/data with `capcomd result`. Branch and
  commit come from the push. `verification` is attached by `verify`. Caps: summary 8KB, data 8KB,
  50 artifacts, messages 16KB, any response 256KB; every truncation is reported.
- **Fencing**: text written by another agent (result summary/error, messages, logs, events, kv
  written by others) reaches a caller inside `<<<untrusted:agt-…>>> … <<<end:agt-…>>>`, with
  look-alike markers neutralized.
- `capcomd inspect <run> <agt>` (record, limits, children, awaits, VM, heartbeat, result, events,
  log tail), `capcomd logs` (scripted stdout/stderr and each in-VM call, stored in the scope).
- **Heartbeats + stuck detection**: every in-VM call and log line is a heartbeat; `capcomd
  heartbeat <note>` too. `tree`/`status` flag `stuck` after 5 min silence
  (`CAPCOMD_STUCK_AFTER_MS`) or when the driver lease has expired.
- **Cancellation propagation**: cancel walks the subtree (pre-order). Each driver sees the
  cancel, kills the agent (real: process group in the VM; scripted: process group) and drains
  the worker (VM destroyed).
- **Orphans**: when an agent finishes or fails with live children, they are reaped (cancelled,
  `AGENT_REAPED`), or re-parented to the nearest live ancestor if its contract says
  `"orphans": "adopt"` (`AGENT_ADOPTED`).
- **Deadlocks**: each in-VM await registers edges (`awaits` table). Refused with
  `reason: deadlock`: awaiting an ancestor, or an edge that closes a cycle
  (`DEADLOCK_DETECTED` with the cycle).
- **Rollups**: `tree` returns per-node subtree sums (usd, turns, wallSeconds, agents, by status)
  and run totals; `budget show` gives allocation/spent/available/rollup per agent.
- **Trace parenting**: an agent's `agent.run` span id is derived from (run, agent), and its
  parent span is its parent agent's span (root agents hang off the run root). The tree nests
  across processes and VMs with no context passing.
- **Handoff**: `capcomd handoff --task …` spawns a successor child and records `handoff/<agt>`.
  The driver awaits the successor and finishes the agent with the successor's result (`handoffTo`).

### 5. Skill injection
For agents whose *effective* limits allow spawning, the driver passes the orchestration skill
(`src/subagents/skill.ts`: the agent's own limits, budget, core loop, fan-out sizing guidance,
trust rules) to the runner. For claude it is appended to `--append-system-prompt` (alongside the
profile's own append), and claude gets `Bash(capcomd:*)` and `mcp__capcomd` tools. For codex it is
appended to the prompt. Agents without `children.allowSpawn` get no CLI, no MCP server and no skill.

## Testing
- `tests/scenarios/` (regression gate in CI, `bun run test:scenarios`): scripted fake agents
  (`CAPCOMD_SPAWN_EXEC=script`) drive the real in-VM CLI over a local spool against a real engine
  and git repo. 24 scenarios assert outcome, trajectory (scope event order) and rollups.
- `tests/subagents/unit.test.ts`: tokens, fencing/caps, rollups/stuck, CLI parsing, the MCP
  server, VmSpool over boxd-style exec (FakeProvider hostExec), skill gating via the claude adapter.
- Chaos (`chaos:fast --only primitives`): `vm.rpc.spawn.before_reply` (driver killed after a VM's
  spawn was handled but before the reply), `vm.rpc.await.before`, and `vm.scope.spawn.mid`
  (engine killed inside a VM-initiated spawn). The audit checks exactly two children (no
  duplicates from retries), all done, contiguous events, no stale await edges, no live VMs.

## Consequences / open items
- Real-VM token refresh and spool re-attach after a host crash rely on boxd exec; covered by
  VmSpool unit tests and `scripts/mac-subagents-e2e.sh`, not by CI.
- Real agents' own logs are not yet streamed into `capcomd logs` (the VmSpool can tail
  `agent.jsonl`; not wired, to keep exec traffic low). Spans carry the agent events.
- Spend of real agents is known only when they finish; budget checks at spawn time use the
  carve, not live spend.
