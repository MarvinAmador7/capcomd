// Chaos client for ADR-016 primitives. Idempotent end to end: every step uses a fixed --key,
// so rerunning after an engine kill must converge to the same tree, with no duplicates.
//   bun tests/chaos/primitives-scenario.ts <tag>
import { runNew, spawnAgent, cancelAgents, awaitAgents, verifyRef, mergeRef } from "../../src/primitives/ops";

const tag = process.argv[2] ?? "default";
const mode = process.argv[3] ?? "tree";
if (mode === "board") {
  // Lease expiry + takeover, fencing of the late holder, and 4 concurrent "claim next" racers.
  // Every write is keyed, so a rerun after an engine kill replays instead of re-applying.
  const S = await import("../../src/primitives/state");
  const { runId } = await runNew({ budget: { usd: 1 }, label: `chaos ${tag}`, key: `chaos-${tag}` });
  const ids: string[] = [];
  for (const n of ["t1", "t2", "t3"]) ids.push(((await S.taskAdd(runId, { title: n, key: n })) as any).task.taskId);
  const t1 = ids[0]!;
  const w1: any = await S.taskClaim(runId, { holder: "w1", taskId: t1, leaseMs: 1500, key: "c-w1" });
  if (w1.epoch !== 1) { console.log(`✗ w1 claim ${JSON.stringify(w1)}`); process.exit(1); }
  const cur: any = await S.taskGet(runId, t1);
  if (cur.epoch < 2) await new Promise((r) => setTimeout(r, Math.max(0, cur.leaseUntil - Date.now()) + 300));
  const w2: any = await S.taskClaim(runId, { holder: "w2", taskId: t1, leaseMs: 60_000, key: "c-w2" });
  if (w2.epoch !== 2 || w2.takeover?.holder !== "w1") { console.log(`✗ w2 takeover ${JSON.stringify(w2)}`); process.exit(1); }
  const late = await S.taskFinish(runId, { taskId: t1, holder: "w1", epoch: 1, outcome: "done", result: "stale" }).then(() => "accepted", (e) => String(e?.message));
  if (!late.includes("lease lost") && !late.includes("is done")) { console.log(`✗ late w1 done: ${late}`); process.exit(1); }
  await S.taskFinish(runId, { taskId: t1, holder: "w2", epoch: 2, outcome: "done", result: { by: "w2" }, key: "d-w2" });
  const racers = ["r1", "r2", "r3", "r4"];
  const got: any[] = await Promise.all(racers.map((h) => S.taskClaim(runId, { holder: h, leaseMs: 60_000, key: `c-${h}` })));
  for (const g of got) if (g.claimed) await S.taskFinish(runId, { taskId: g.taskId, holder: g.holder, epoch: g.epoch, outcome: "done", result: { by: g.holder }, key: `d-${g.holder}` });
  console.log(`PRIM ${JSON.stringify({ runId, mode, t1, t2: ids[1], t3: ids[2] })}`);
  console.log("✓ primitives scenario ok");
  process.exit(0);
}
if (mode === "kv") {
  // 6 writers add themselves to a set with read-cas-retry; idempotent by content (a writer that
  // finds itself in the set stops), so a reply lost to a kill is never applied twice.
  const S = await import("../../src/primitives/state");
  const { runId } = await runNew({ budget: { usd: 1 }, label: `chaos ${tag}`, key: `chaos-${tag}` });
  await S.kvWrite(runId, { k: "cfg", value: { v: 1 }, key: "cfg-put" });
  const writer = async (i: number) => {
    for (let n = 0; n < 200; n++) {
      const cur: any = await S.kvGet(runId, "members");
      const set: number[] = cur.value ?? [];
      if (set.includes(i)) return;
      const ok = await S.kvWrite(runId, { k: "members", value: [...set, i].sort((a, b) => a - b), expect: cur.version, writer: `w${i}` }).then(() => true, (e) => {
        if (String(e?.message).includes("cas members")) return false; throw e;
      });
      if (ok) return;
    }
    throw new Error(`writer ${i} starved`);
  };
  await Promise.all([0, 1, 2, 3, 4, 5].map(writer));
  console.log(`PRIM ${JSON.stringify({ runId, mode })}`);
  console.log("✓ primitives scenario ok");
  process.exit(0);
}
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
