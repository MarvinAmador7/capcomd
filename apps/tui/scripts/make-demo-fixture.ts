/**
 * Writes fixtures/demo-3-tasks: a synthetic, schema-faithful run (3 tasks, nested sub-agent,
 * one approval gate). Span names, attributes and event types are copied from real capcomd
 * output; timings and costs are invented. Deterministic: rerun to regenerate byte-identical files.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const runId = "run-demo-3tasks";
const T0 = Date.UTC(2026, 9, 19, 15, 2, 0);
const dir = join(import.meta.dir, "../fixtures/demo-3-tasks");
mkdirSync(dir, { recursive: true });

let n = 0;
const id = () => (++n).toString(16).padStart(16, "0");
const spans: any[] = [];
const span = (name: string, parent: string | null, s: number, d: number, attrs: Record<string, unknown> = {}, err?: string) => {
  const spanId = id();
  spans.push({
    traceId: "d".repeat(32), spanId, ...(parent ? { parentSpanId: parent } : {}), name, startTime: T0 + s, endTime: T0 + s + d,
    attributes: { "relay.run_id": runId, ...attrs }, events: [], status: err ? { code: 2, message: err } : { code: 1 },
  });
  return spanId;
};

const root = span("relay.run", null, 0, 412_000, { "relay.goal": "Add rate limiting to the public API" });
span("actor.run.createRun", root, 40, 44, { "relay.actor": "run" });
const plan = span("actor.planner.createPlan", root, 300, 9_800, { "relay.actor": "planner" });
span("agent.claude_code", plan, 420, 9_500, { "agent.profile": "planner", "agent.turns": 4, "agent.cost_usd": 0.041, "agent.billing": "api", "relay.agent_id": "agt-planner" });
span("transition.run", root, 10_200, 1, { "relay.entity_id": runId, "relay.state_from": "planning", "relay.state_to": "executing" });

const tasks = [
  { t: "task-1", s: 10_500, d: 182_000, turns: 18, usd: 0.62, sha: "4f1c2ab", vm: "vm-1" },
  { t: "task-2", s: 10_900, d: 241_000, turns: 26, usd: 0.94, sha: "a90e113", vm: "vm-2" },
  { t: "task-3", s: 11_300, d: 120_000, turns: 9, usd: 0.21, sha: "", vm: "vm-3", fail: "checks failed: 2 tests" },
];
for (const k of tasks) {
  const a = { "relay.task_id": k.t, "relay.agent_id": `agt-${k.t}` };
  span("transition.task", root, k.s, 1, { ...a, "relay.entity_id": k.t, "relay.state_from": "pending", "relay.state_to": "leased" });
  const w = span("actor.worker.assignTask", root, k.s + 200, k.d + 6_000, { ...a, "relay.actor": "worker" });
  span("sandbox.ensure", w, k.s + 220, 2_400, { "sandbox.vm_id": k.vm });
  span("git.clone", w, k.s + 2_700, 1_900, { "git.operation": "clone", "git.ref": "main" });
  for (let i = 0; i < 12; i++) span("sandbox.exec", w, k.s + 4_700 + i * 90, 70, { "sandbox.vm_id": k.vm });
  const ag = span("agent.claude_code", w, k.s + 6_000, k.d - 6_000, {
    ...a, "agent.profile": "coder", "agent.turns": k.turns, "agent.cost_usd": k.usd, "agent.billing": "subscription",
    "agent.max_turns": 30, "agent.max_budget_usd": 2, ...(k.sha ? { "git.sha": k.sha } : {}),
  }, k.fail);
  if (k.t === "task-2") {
    span("agent.claude_code", ag, k.s + 90_000, 64_000, { "relay.agent_id": "agt-task-2-review", "relay.task_id": "task-2", "agent.profile": "reviewer", "agent.turns": 7, "agent.cost_usd": 0.18, "agent.billing": "subscription" });
  }
  if (k.sha) span("git.push", w, k.s + k.d + 200, 1_400, { "git.operation": "push", "git.sha": k.sha });
}
const merge = span("actor.run.merge", root, 256_000, 150_000, { "relay.actor": "run" });
span("git.merge", merge, 256_200, 2_100, { "git.operation": "merge", "git.sha": "4f1c2ab" });
span("git.merge", merge, 400_000, 2_600, { "git.operation": "merge", "git.sha": "a90e113" });
span("transition.run", root, 411_900, 1, { "relay.entity_id": runId, "relay.state_from": "executing", "relay.state_to": "completed" });

const ev: any[] = [];
const e = (s: number, type: string, f: Record<string, unknown> = {}) => ev.push({ schema: "relay.v1", type, runId, ts: new Date(T0 + s).toISOString(), ...f });
e(0, "run.started", { goal: "Add rate limiting to the public API", targetBranch: "main" });
e(200, "run.created", { state: "planning" });
e(300, "plan.started");
e(10_100, "plan.ready", { tasks: tasks.map((k) => k.t), cost: 0.041 });
e(10_150, "tasks.creating");
for (const k of tasks) e(k.s - 100, "task.created", { taskId: k.t });
e(10_400, "worker.provisioning");
for (const k of tasks) { e(k.s, "task.leased", { taskId: k.t, workerId: `wrk-${k.vm}` }); e(k.s + 2_600, "worker.ready", { taskId: k.t, vmId: k.vm }); }
e(30_000, "agent.status", { taskId: "task-1", text: "reading src/api/router.ts" });
e(101_000, "agent.status", { taskId: "task-2", agentId: "agt-task-2-review", text: "sub-agent reviewing diff" });
e(131_400, "task.verify_failed", { taskId: "task-3", reason: "checks failed: 2 tests" });
e(192_700, "task.awaiting_approval", { taskId: "task-1", sha: "4f1c2ab" });
e(255_000, "task.approved", { taskId: "task-1", by: "marvin" });
e(258_400, "task.merged", { taskId: "task-1", sha: "4f1c2ab" });
e(252_100, "task.awaiting_approval", { taskId: "task-2", sha: "a90e113" });
e(399_000, "task.approved", { taskId: "task-2", by: "marvin" });
e(402_700, "task.merged", { taskId: "task-2", sha: "a90e113" });
e(403_000, "task.skipped", { taskId: "task-3", reason: "verify failed" });
e(411_950, "run.completed", { merged: 2, skipped: 1 });
e(412_000, "run.result", { ok: true, state: "completed" });
ev.sort((a, b) => a.ts.localeCompare(b.ts));

const node = (agentId: string, profile: string, status: string, depth: number, usd: number, turns: number, wall: number, children: any[] = []) => {
  const sum = (k: "usd" | "turns" | "wallSeconds") => children.reduce((a, c) => a + c.rollup[k], 0);
  return {
    agentId, profile, depth, status, budget: { usd: 2, turns: 30 }, spent: { usd, turns, wallSeconds: wall },
    rollup: { agents: 1 + children.reduce((a, c) => a + c.rollup.agents, 0), byStatus: { [status]: 1 }, usd: +(usd + sum("usd")).toFixed(4), turns: turns + sum("turns"), wallSeconds: wall + sum("wallSeconds") },
    children,
  };
};
const tree: any = {
  schema: "relay.v1", ok: true, runId, root: null,
  tree: [node("agt-planner", "planner", "done", 0, 0.041, 4, 9.5, [
    node("agt-task-1", "coder", "done", 1, 0.62, 18, 176),
    node("agt-task-2", "coder", "done", 1, 0.76, 19, 235, [node("agt-task-2-review", "reviewer", "done", 2, 0.18, 7, 64)]),
    node("agt-task-3", "coder", "failed", 1, 0.21, 9, 114),
  ])],
};
tree.totals = { agents: 5, usd: 1.811, turns: 57, wallSeconds: 598.5, byStatus: { done: 4, failed: 1 } } as any;

writeFileSync(join(dir, "trace.ndjson"), spans.map((s) => JSON.stringify(s)).join("\n") + "\n");
writeFileSync(join(dir, "events.ndjson"), ev.map((x) => JSON.stringify(x)).join("\n") + "\n");
writeFileSync(join(dir, "tree.json"), JSON.stringify(tree, null, 2) + "\n");
writeFileSync(join(dir, "meta.json"), JSON.stringify({ runId, synthetic: true, note: "Generated by scripts/make-demo-fixture.ts" }, null, 2) + "\n");
console.log(`wrote ${spans.length} spans, ${ev.length} events to ${dir}`);
