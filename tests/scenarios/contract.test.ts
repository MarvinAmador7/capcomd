// TUI output contract (docs/output-contract.md): fields apps/tui depends on, from a real scripted run.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { world, newRun, spawnRoot, waitAll, WORKER, type World } from "./harness";

let w: World;
beforeAll(async () => { w = await world("contract"); }, 120_000);
afterAll(async () => { await w?.stop(); });

const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

test("contract: events, tree, status, inspect bundle + follow resume, agent.* span ids", async () => {
  const run = await newRun(w);
  const worker = w.script("cw", `capcomd result --summary "ok"`);
  const planner = w.script("cp", `
set -e
id=$(capcomd spawn --profile worker --task "leaf" --key leaf --budget turns=5 --children.maxChildren=0 --contract "$($S/json script='${worker}')" | $S/jget agentId)
capcomd await "$id" --timeout-ms 60000 >/dev/null
capcomd result --summary "done"
`);
  const root = await spawnRoot(w, run, "planner", planner);
  const aw = await waitAll(w, run, [root]);
  expect(aw.agents[0].status).toBe("done");

  // (3) unified events: global seq 1..n, ts ISO + epochMs (at alias), agentId key on every event.
  const ev = (await w.cj(["events", run])).j.events;
  expect(ev.length).toBeGreaterThan(3);
  ev.forEach((e: any, i: number) => {
    expect(e.seq).toBe(i + 1);
    expect(e.ts).toMatch(ISO);
    expect(e.epochMs).toBe(e.at);
    expect(new Date(e.ts).getTime()).toBe(e.epochMs);
    expect("agentId" in e).toBe(true);
    expect(typeof e.entitySeq).toBe("number");
  });
  expect(ev.some((e: any) => e.agentId === root)).toBe(true);
  const since = (await w.cj(["events", run, "--since-seq", String(ev.length - 2)])).j.events;
  expect(since.map((e: any) => e.seq)).toEqual([ev.length - 1, ev.length]);

  // (4) tree nodes
  const t = (await w.cj(["tree", run])).j;
  const n = t.tree[0];
  expect(n.agentId).toBe(root);
  expect(n.startedAt).toMatch(ISO); expect(n.endedAt).toMatch(ISO);
  expect(typeof n.taskId).toBe("string"); expect(n.spanId).toMatch(/^[0-9a-f]{16}$/);
  expect(n.children[0].parent).toBe(root);
  expect(Date.parse(n.endedAt)).toBeGreaterThanOrEqual(Date.parse(n.startedAt));

  // (5) status
  const s = (await w.cj(["status", run])).j.run;
  expect(typeof s.goal).toBe("string"); expect(s.startedAt).toMatch(ISO); expect(typeof s.state).toBe("string");
  expect(Array.isArray(s.pendingApprovals)).toBe(true); expect(Array.isArray(s.awaitingApproval)).toBe(true);
  expect(s.scope.state).toBe("done"); expect(s.scope.agents).toBe(2);

  // (6) inspect bundle
  const b = (await w.cj(["inspect", run])).j;
  expect(b.type).toBe("inspect.snapshot");
  expect(b.status.runId).toBe(run); expect(b.tree[0].agentId).toBe(root); expect(b.events.length).toBe(ev.length); expect(b.seq).toBe(ev.length);
  // (1) relay.agent_id / relay.parent_agent_id on agent.run spans, parented under the parent's span; (2) cost/turns stamped.
  const runs = (b.trace?.spans ?? []).filter((x: any) => x.name === "agent.run");
  expect(runs.length).toBe(2);
  const child = runs.find((x: any) => x.attributes["relay.parent_agent_id"] === root);
  expect(child).toBeTruthy();
  expect(child.parentSpanId).toBe(n.spanId);
  for (const r of runs) { expect(typeof r.attributes["agent.cost_usd"]).toBe("number"); expect(typeof r.attributes["agent.turns"]).toBe("number"); expect(r.attributes["relay.agent_id"]).toBeTruthy(); }

  // --follow: snapshot line, then event lines with seq; resume from a seq replays only what follows.
  const f = await w.cj(["inspect", run, "--follow", "--since-seq", String(ev.length - 1), "--timeout-ms", "1200"]);
  const lines = f.stdout.trim().split("\n").map((l) => JSON.parse(l));
  expect(lines[0].type).toBe("inspect.snapshot");
  expect(lines[0].events.map((e: any) => e.seq)).toEqual([ev.length]);
  expect(lines.at(-1).type).toBe("inspect.end");
  const ef = await w.cj(["events", run, "--follow", "--since-seq", String(ev.length - 2), "--timeout-ms", "1200"]);
  const el = ef.stdout.trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.event);
  expect(el.map((l: any) => l.seq)).toEqual([ev.length - 1, ev.length]);
  expect(el[0].ts).toMatch(ISO); expect("agentId" in el[0]).toBe(true);
}, 150_000);

test("contract: nested sub-agent tree keeps events, lanes and span parenting consistent (planner→lead→2 workers)", async () => {
  const run = await newRun(w);
  const worker = w.script("nw", WORKER);
  const lead = w.script("nl", `
set -e
a=$(capcomd spawn --profile worker --task wa --key wa --children.maxChildren=0 --contract "$($S/json script='${worker}')" | $S/jget agentId)
b=$(capcomd spawn --profile worker --task wb --key wb --children.maxChildren=0 --contract "$($S/json script='${worker}')" | $S/jget agentId)
capcomd await "$a" "$b" --timeout-ms 60000 >/dev/null
capcomd send parent "both workers done" >/dev/null
capcomd result --summary "lead ok"
`);
  const planner = w.script("np", `
set -e
l=$(capcomd spawn --profile lead --task lead --key lead --children.maxChildren=2 --children.maxDepth=1 --contract "$($S/json script='${lead}')" | $S/jget agentId)
capcomd await "$l" --timeout-ms 80000 >/dev/null
capcomd result --summary "planner ok"
`);
  const root = await spawnRoot(w, run, "planner", planner);
  const aw = await waitAll(w, run, [root], 120_000);
  expect(aw.agents[0].status).toBe("done");

  const t = (await w.cj(["tree", run])).j;
  const all: any[] = [];
  const walk = (n: any) => { all.push(n); n.children.forEach(walk); };
  t.tree.forEach(walk);
  expect(all.length).toBe(4);
  expect(all.map((n) => n.depth).sort()).toEqual([0, 1, 2, 2]);
  const byId = new Map(all.map((n) => [n.agentId, n]));

  // events: contiguous seq; (entity, entitySeq) unique; agent-scoped events name their agent in entity + agentId
  const ev: any[] = (await w.cj(["events", run])).j.events;
  ev.forEach((e, i) => expect(e.seq).toBe(i + 1));
  expect(new Set(ev.map((e) => `${e.entity}/${e.entitySeq}`)).size).toBe(ev.length);
  const scoped = ev.filter((e) => e.entity.startsWith("scope:"));
  for (const e of scoped) expect(e.entity).toBe(`scope:${e.agentId}`);
  for (const ty of ["AGENT_SPAWNED", "AGENT_STARTED", "AGENT_DONE"]) {
    const got = ev.filter((e) => e.type === ty);
    expect(got.length).toBe(4);
    for (const e of got) expect(byId.has(e.agentId)).toBe(true);
  }
  expect(ev.some((e) => e.type === "MESSAGE_SENT")).toBe(true);
  // the TUI's sub-agent lanes: span relay.parent_agent_id == tree parent; span parent == parent's agent.run span
  const b = (await w.cj(["inspect", run])).j;
  const runs = (b.trace?.spans ?? []).filter((x: any) => x.name === "agent.run");
  expect(runs.length).toBe(4);
  for (const r of runs) {
    const n = byId.get(r.attributes["relay.agent_id"]);
    expect(n).toBeTruthy();
    expect(r.spanId).toBe(n.spanId);
    expect(r.attributes["relay.parent_agent_id"]).toBe(n.parent);
    if (n.parent) expect(r.parentSpanId).toBe(byId.get(n.parent).spanId);
  }
  // rollups: workers' turns roll up through the lead to the root
  expect(t.totals.agents).toBe(4);
  expect(byId.get(root).rollup.agents).toBe(4);
}, 180_000);
