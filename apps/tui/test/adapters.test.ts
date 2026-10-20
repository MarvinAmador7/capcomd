import { describe, expect, test } from "bun:test";
import { filterEvents, parseEvents } from "../src/adapters/events";
import { laneCells, lanesOf } from "../src/adapters/lanes";
import { loadFixture } from "../src/adapters/source";
import { parseTrace, waterfallRows } from "../src/adapters/trace";
import { agentsFromTrace, flattenAgents, parseTree } from "../src/adapters/tree";
import { bar } from "../src/format";

describe("trace adapter (real .traces NDJSON)", () => {
  const d = loadFixture("task-timeout");
  test("parses every span and synthesizes one root", () => {
    expect(d.trace!.spans.length).toBe(816); // 815 real spans + synthesized relay.run
    expect(d.trace!.spans[0]!.name).toBe("relay.run");
    expect(d.trace!.spans[0]!.attrs["relay.synthesized"]).toBe(true);
    expect(d.trace!.spans.filter((s) => s.depth === 0).length).toBe(1);
  });
  test("keeps the agent timeout as an error with its message", () => {
    const a = d.trace!.spans.find((s) => s.name === "agent.claude_code")!;
    expect(a.status).toBe("error");
    expect(a.message).toContain("timed out after 1200000ms");
    expect(a.durationMs).toBe(1231622);
  });
  test("folds 770 sandbox.exec siblings into a single waterfall row", () => {
    const rows = waterfallRows(d.trace!);
    const exec = rows.filter((r) => r.span.name === "sandbox.exec");
    expect(exec.reduce((a, r) => a + r.count, 0)).toBe(770);
    expect(Math.max(...exec.map((r) => r.count))).toBeGreaterThan(100);
    expect(rows.length).toBeLessThan(80);
    const unfolded = waterfallRows(d.trace!, new Set(exec.map((r) => r.key)));
    expect(unfolded.length).toBeGreaterThan(rows.length);
  });
  test("accepts `capcomd trace --json` envelopes", () => {
    const span = { traceId: "t", spanId: "a", name: "relay.run", startTime: 10, endTime: 30, attributes: {}, events: [], status: { code: 1 } };
    const t = parseTrace(JSON.stringify({ schema: "relay.v1", ok: true, trace: { runId: "r9", spans: [span] } }))!;
    expect(t.runId).toBe("r9");
    expect(t.durationMs).toBe(20);
  });
});

describe("agents inferred from trace", () => {
  test("sums agent.cost_usd and agent.turns per task across attempts", () => {
    const d = loadFixture("claude-retries");
    expect(d.agentsFromTree).toBe(false);
    const [a] = agentsFromTrace(d.trace);
    expect(a!.agentId).toBe("task-1");
    expect(a!.spent.usd!).toBeCloseTo(14.465, 3);
    expect(a!.spent.turns).toBe(761);
  });
});

describe("events adapter", () => {
  test("reads the run --json stream and turns the error envelope into cli.error", () => {
    const d = loadFixture("boxd-blocked");
    expect(d.events.map((e) => e.type)).toEqual(["run.started", "run.created", "plan.started", "plan.ready", "tasks.creating", "task.created", "task.created", "worker.provisioning", "cli.error"]);
    expect(d.goal).toBe("boxd e2e: uname");
    expect(d.state).toBe("failed");
    expect(filterEvents(d.events, "problems").map((e) => e.type)).toEqual(["cli.error"]);
  });
  test("reads `events --json` pages and `--follow --json` lines", () => {
    const page = JSON.stringify({ schema: "relay.v1", ok: true, runId: "r", events: [{ entity: "task-1", seq: 1, at: 5, type: "task.leased", event: { type: "task.leased", workerId: "w" } }] });
    const follow = [JSON.stringify({ ok: true, runId: "r", event: { entity: "run", seq: 2, at: 9, type: "run.result", event: { type: "run.result", ok: true, state: "completed" } } }), JSON.stringify({ ok: true, end: { reason: "until" } })].join("\n");
    const evs = [...parseEvents(page), ...parseEvents(follow)];
    expect(evs).toEqual([
      { at: 5, type: "task.leased", entity: "task-1", data: { workerId: "w" } },
      { at: 9, type: "run.result", entity: "run", data: { ok: true, state: "completed" } },
    ]);
  });
  test("filters by family and free text", () => {
    const d = loadFixture("demo-3-tasks");
    expect(filterEvents(d.events, "plan").map((e) => e.type)).toEqual(["plan.started", "plan.ready"]);
    expect(filterEvents(d.events, "all", "verify").length).toBe(2);
  });
});

describe("tree + lanes", () => {
  const d = loadFixture("demo-3-tasks");
  test("parses nested sub-agents from `capcomd tree --json`", () => {
    const flat = flattenAgents(d.agents);
    expect(flat.map((a) => a.agentId)).toEqual(["agt-planner", "agt-task-1", "agt-task-2", "agt-task-2-review", "agt-task-3"]);
    expect(flat.find((a) => a.agentId === "agt-task-2-review")!.depth).toBe(2);
    expect(parseTree("not json")).toEqual([]);
  });
  test("approval waits show up on the agent's lane", () => {
    const lanes = lanesOf(d.trace!, d.events);
    const t1 = lanes.find((l) => l.id === "agt-task-1")!;
    expect(t1.waits.length).toBe(1);
    expect(laneCells(t1, d.trace!.start, d.trace!.durationMs, 100).some((c) => c.kind === "wait")).toBe(true);
  });
  test("bars are never invisible and never overflow", () => {
    const [lead, fill, trail] = bar(50, 50, 100, 20);
    expect(fill.length).toBeGreaterThan(0);
    expect(lead.length + fill.length + trail.length).toBe(20);
  });
});
