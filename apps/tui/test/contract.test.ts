// docs/output-contract.md: double counting, envelope metadata, inspect --follow folding, sub-agent lanes.
import { describe, expect, test } from "bun:test";
import { mergeEvents, parseEvents } from "../src/adapters/events";
import { lanesOf } from "../src/adapters/lanes";
import { InspectState, loadFixture } from "../src/adapters/source";
import { parseTrace } from "../src/adapters/trace";
import { agentsFromTrace, flattenAgents } from "../src/adapters/tree";

const span = (spanId: string, name: string, parentSpanId: string | undefined, attrs: Record<string, unknown>, s = 0, e = 1000) =>
  JSON.stringify({ traceId: "t", spanId, parentSpanId, name, startTime: s, endTime: e, attributes: attrs, events: [], status: { code: 1 } });

describe("agentsFromTrace", () => {
  test("sums agent.run only; the CLI span under it repeats the same cost/turns", () => {
    const t = parseTrace([
      span("a", "agent.run", undefined, { "relay.agent_id": "agt-a", "relay.parent_agent_id": null, "agent.cost_usd": 0.5, "agent.turns": 5, "agent.status": "done" }),
      span("a1", "agent.claude_code", "a", { "relay.agent_id": "agt-a", "agent.cost_usd": 0.5, "agent.turns": 5 }),
      span("b", "agent.run", "a", { "relay.agent_id": "agt-b", "relay.parent_agent_id": "agt-a", "agent.cost_usd": 0.25, "agent.turns": 2, "agent.status": "failed" }, 100, 600),
      span("b1", "agent.codex", "b", { "relay.agent_id": "agt-b", "agent.cost_usd": 0.25, "agent.turns": 2, "agent.error_kind": "timeout" }, 100, 600),
    ].join("\n"))!;
    const flat = flattenAgents(agentsFromTrace(t));
    expect(flat.map((a) => [a.agentId, a.depth, a.spent.usd, a.spent.turns])).toEqual([["agt-a", 0, 0.5, 5], ["agt-b", 1, 0.25, 2]]);
    expect(flat[1]!.status).toBe("failed");
    expect(flat[1]!.errorKind).toBe("timeout");
  });
  test("falls back to CLI spans when a trace has no agent.run", () => {
    const t = parseTrace(span("x", "agent.claude_code", undefined, { "relay.task_id": "task-1", "agent.cost_usd": 0.1, "agent.turns": 3 }))!;
    expect(agentsFromTrace(t).map((a) => [a.agentId, a.spent.usd, a.spent.turns])).toEqual([["task-1", 0.1, 3]]);
  });
});

describe("events metadata", () => {
  test("run --json lines: seq/epochMs/agentId leave data; seq and agentId become fields", () => {
    const [e] = parseEvents(JSON.stringify({ schema: "relay.v1", type: "task.leased", runId: "r", ts: "2026-10-20T00:00:00.000Z", epochMs: 1792454400000, seq: 7, agentId: "agt-x", taskId: "task-1" }));
    expect(e).toEqual({ at: 1792454400000, type: "task.leased", entity: "task-1", data: { taskId: "task-1" }, seq: 7, agentId: "agt-x" });
  });
  test("dedupes on (entity, entitySeq), not on global seq", () => {
    const a = { at: 1, type: "X", entity: "scope:agt-a", data: {}, seq: 3, entitySeq: 1 };
    const b = { at: 1, type: "Y", entity: "scope:agt-b", data: {}, seq: 3, entitySeq: 1 }; // same seq, other entity
    expect(mergeEvents([a], [a, b]).length).toBe(2);
  });
});

describe("inspect --follow (real recorded run)", () => {
  const raw = require("node:fs").readFileSync(require("node:path").join(import.meta.dir, "../fixtures/live-scope/inspect.ndjson"), "utf8").trim().split("\n");
  test("folds snapshot + events + tree pushes; a reconnect replay adds nothing", () => {
    const s = new InspectState("r", "live");
    for (const l of raw) s.line(l);
    const n = s.data().events.length;
    const seqs = s.data().events.map((e) => e.seq);
    expect(new Set(seqs).size).toBe(n);
    for (const l of raw.filter((l: string) => l.includes('"type":"event"'))) s.line(l); // --since-seq overlap
    expect(s.data().events.length).toBe(n);
    expect(s.lastSeq).toBe(Math.max(...(seqs as number[])));
  });
  test("sub-agents nest and get their own lanes under the parent", () => {
    const d = loadFixture("live-scope");
    const flat = flattenAgents(d.agents);
    expect(flat.map((a) => a.depth)).toEqual([0, 1, 2, 1, 1]);
    expect(flat.map((a) => a.profile)).toEqual(["planner", "lead", "worker", "worker", "critic"]);
    expect(flat.every((a) => a.startedAt && a.spanId)).toBe(true);
    const lanes = lanesOf(d.trace!, d.events, d.agents).filter((l) => l.id !== "run");
    expect(lanes.map((l) => l.depth)).toEqual([0, 1, 2, 1, 1]);
    expect(lanes[3]!.errors).toBeGreaterThan(0); // the flaky worker failed
  });
  test("status.pendingApprovals becomes an open approval wait", () => {
    const d = loadFixture("live-scope");
    const id = flattenAgents(d.agents)[1]!.agentId;
    const lanes = lanesOf(d.trace!, d.events, d.agents, [{ taskId: id, since: d.trace!.start + 1000 }]);
    expect(lanes.find((l) => l.id === id)!.waits.length).toBe(1);
  });
});
