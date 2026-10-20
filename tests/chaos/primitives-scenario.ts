// Chaos client for ADR-016 primitives. Idempotent end to end: every step uses a fixed --key,
// so rerunning after an engine kill must converge to the same tree, with no duplicates.
//   bun tests/chaos/primitives-scenario.ts <tag>
import { runNew, spawnAgent, cancelAgents, awaitAgents, verifyRef, mergeRef } from "../../src/primitives/ops";

const tag = process.argv[2] ?? "default";
const mode = process.argv[3] ?? "tree";
if (mode === "merge") {
  // spawn → await → verify → merge --require; the engine is killed inside the merge.
  const { runId } = await runNew({ budget: { usd: 2 }, label: `chaos ${tag}`, key: `chaos-${tag}` });
  const d = await spawnAgent({ runId, profile: "coder", task: "work", key: "d", budget: { usd: 1 } });
  const r: any = await awaitAgents(runId, [d.agentId], { timeoutMs: 60_000 });
  if (r.agents[0].status !== "done") { console.log(`✗ d ${r.agents[0].status}`); process.exit(1); }
  const v: any = await verifyRef({ runId, ref: d.agentId, key: "v" });
  if (v.state !== "passed") { console.log(`✗ verify ${JSON.stringify(v.result)}`); process.exit(1); }
  const m: any = await mergeRef({ runId, ref: d.agentId, require: v.id, key: "m" });
  if (m.state !== "merged") { console.log(`✗ merge ${JSON.stringify(m.result)}`); process.exit(1); }
  console.log(`PRIM ${JSON.stringify({ runId, d: d.agentId, mode, vfy: v.id, mrg: m.id, commit: v.result.commit, merge: m.result })}`);
  console.log("✓ primitives scenario ok");
  process.exit(0);
}
if (mode === "driverkill") {
  // Kill the detached driver while its push is in flight (the engine keeps running the push).
  const { readFileSync } = await import("fs");
  const { createClient } = await import("rivetkit/client");
  const { runId } = await runNew({ budget: { usd: 2 }, label: `chaos ${tag}`, key: `chaos-${tag}` });
  const d = await spawnAgent({ runId, profile: "coder", task: "slow push", key: "d", budget: { usd: 1 } });
  const c: any = createClient({ endpoint: process.env.CAPCOMD_ENDPOINT! });
  const w = c.worker.getOrCreate([runId, d.agentId]);
  let killed = false;
  for (let i = 0; i < 200 && !killed; i++) {
    const p = (await w.getPushes({}).catch(() => [])) as any[];
    if (p.some((x) => x.live)) {
      const pid = Number(readFileSync(`.relay/drivers/${d.agentId}.pid`, "utf8"));
      process.kill(pid, "SIGKILL");
      killed = true;
      console.log(`[DRIVER-KILL] pid ${pid} mid-push`);
    } else await new Promise((r) => setTimeout(r, 100));
  }
  if (!killed) { const p = await w.getPushes({}); if (!p.length || p[0].state !== "done") { console.log("✗ never saw a live push"); process.exit(1); } }
  const r: any = await awaitAgents(runId, [d.agentId], { timeoutMs: 90_000 });
  if (r.timeout || r.agents[0].status !== "done") { console.log(`✗ d not done: ${JSON.stringify(r.agents[0])}`); process.exit(1); }
  console.log(`PRIM ${JSON.stringify({ runId, d: d.agentId, mode, killed })}`);
  console.log("✓ primitives scenario ok");
  process.exit(0);
}
const { runId } = await runNew({ budget: { usd: 8 }, label: `chaos ${tag}`, key: `chaos-${tag}` });
const sup = await spawnAgent({ runId, profile: "sup", task: "supervise", key: "sup", budget: { usd: 4 }, start: false });
const c1 = await spawnAgent({ runId, parent: sup.agentId, profile: "coder", task: "part 1", key: "c1", start: false });
const c2 = await spawnAgent({ runId, parent: sup.agentId, profile: "coder", task: "part 2", key: "c2", start: false });
const d = await spawnAgent({ runId, profile: "coder", task: "do work", key: "d", budget: { usd: 1 } });
await cancelAgents(runId, sup.agentId, "chaos");
const r: any = await awaitAgents(runId, [d.agentId], { timeoutMs: 60_000 });
if (r.timeout || r.agents[0].status !== "done") { console.log(`✗ d not done: ${JSON.stringify(r.agents[0])}`); process.exit(1); }
console.log(`PRIM ${JSON.stringify({ runId, sup: sup.agentId, c1: c1.agentId, c2: c2.agentId, d: d.agentId })}`);
console.log("✓ primitives scenario ok");
process.exit(0);
