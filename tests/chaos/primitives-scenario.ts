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
  const w2: any = await S.taskClaim(runId, { holder: "w2", taskId: t1, leaseMs: 600_000, key: "c-w2" });
  if (w2.epoch !== 2 || w2.takeover?.holder !== "w1") { console.log(`✗ w2 takeover ${JSON.stringify(w2)}`); process.exit(1); }
  const late = await S.taskFinish(runId, { taskId: t1, holder: "w1", epoch: 1, outcome: "done", result: "stale" }).then(() => "accepted", (e) => String(e?.message));
  if (!late.includes("lease lost") && !late.includes("is done")) { console.log(`✗ late w1 done: ${late}`); process.exit(1); }
  await S.taskFinish(runId, { taskId: t1, holder: "w2", epoch: 2, outcome: "done", result: { by: "w2" }, key: "d-w2" });
  const racers = ["r1", "r2", "r3", "r4"];
  // Leases outlast a normal engine restart (~40s); a stall longer than that can still expire one,
  // and then a racer's done is fenced ("lease lost"/"is done"): correct, and the audit checks it.
  const fenced = (e: any) => { const m = String(e?.message); if (m.includes("lease lost") || m.includes("is done")) return null; throw e; };
  const got: any[] = await Promise.all(racers.map((h) => S.taskClaim(runId, { holder: h, leaseMs: 600_000, key: `c-${h}` })));
  for (const g of got) if (g.claimed) await S.taskFinish(runId, { taskId: g.taskId, holder: g.holder, epoch: g.epoch, outcome: "done", result: { by: g.holder }, key: `d-${g.holder}` }).catch(fenced);
  // A racer whose claim replays a lease that was taken over finds the task done; claim-next picks up anything left.
  for (const h of racers) {
    const g: any = await S.taskClaim(runId, { holder: h, leaseMs: 600_000 });
    if (g.claimed) await S.taskFinish(runId, { taskId: g.taskId, holder: h, epoch: g.epoch, outcome: "done", result: { by: h } }).catch(fenced);
  }
  console.log(`PRIM ${JSON.stringify({ runId, mode, t1, t2: ids[1], t3: ids[2] })}`);
  console.log("✓ primitives scenario ok");
  process.exit(0);
}
if (mode === "subagent") {
  // ADR-017: a scripted planner spawns 2 children and awaits them through in-VM capcomd, with no
  // --key: retries must be idempotent by request id. Chaos kills the parent's driver after a VM
  // spawn was handled but before the reply, at an await poll, or kills the engine mid-spawn.
  const { writeFileSync, existsSync } = await import("fs");
  const { join } = await import("path");
  const { tmpdir } = await import("os");
  const script = join(tmpdir(), `capcomd-chaos-planner-${tag}.sh`);
  writeFileSync(script, [
    `j() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).agentId||"")}catch{console.log("")}})'; }`,
    `a=$(capcomd spawn --profile coder --task one | j); b=$(capcomd spawn --profile coder --task two | j)`,
    `[ -n "$a" ] && [ -n "$b" ] || { echo "spawn failed a=$a b=$b"; exit 1; }`,
    `capcomd await $a $b --timeout-ms 240000 > /dev/null || exit 1`,
    `capcomd result --summary "kids=2 $a $b" > /dev/null`,
  ].join("\n"));
  const { runId } = await runNew({ budget: { usd: 4 }, label: `chaos ${tag}`, key: `chaos-${tag}` });
  const sup = await spawnAgent({ runId, task: "plan", profile: "sup", key: "sup", contract: { script: `sh ${script}` } });
  const res: any = await awaitAgents(runId, [sup.agentId], { timeoutMs: 240_000 });
  const a = res.agents[0];
  if (a.status !== "done") { console.log(`✗ planner ${a.status} ${JSON.stringify(a.result ?? {})}`); process.exit(1); }
  const marker = process.env.CAPCOMD_DRIVER_KILLPOINT_MARKER;
  if (marker && existsSync(marker)) console.log("[DRIVER-KILL] observed");
  console.log(`PRIM ${JSON.stringify({ runId, mode, sup: sup.agentId })}`);
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
  // Kill the detached driver while its push is in flight (the engine keeps running the push). With the agent workflow
  // (ADR-022) there is no driver: the engine host itself dies mid-step (killpoint workflow.watch.running) and the
  // harness restarts it, so this only awaits.
  const workflow = process.env.CAPCOMD_AGENT_WORKFLOW !== "0";
  const { readFileSync } = await import("fs");
  const { join } = await import("path");
  const { stateDir } = await import("../../src/utils/home");
  const { createClient } = await import("rivetkit/client");
  const { runId } = await runNew({ budget: { usd: 2 }, label: `chaos ${tag}`, key: `chaos-${tag}` });
  const d = await spawnAgent({ runId, profile: "coder", task: "slow push", key: "d", budget: { usd: 1 } });
  const c: any = createClient({ endpoint: process.env.CAPCOMD_ENDPOINT! });
  const w = c.worker.getOrCreate([runId, d.agentId]);
  let killed = false;
  for (let i = 0; i < 200 && !killed && !workflow; i++) {
    const p = (await w.getPushes({}).catch(() => [])) as any[];
    if (p.some((x) => x.live)) {
      // Where driveAgent writes it: <state dir>/drivers (the checkout's .relay/, or $CAPCOMD_HOME/state).
      const pid = Number(readFileSync(join(stateDir(), "drivers", `${d.agentId}.pid`), "utf8"));
      process.kill(pid, "SIGKILL");
      killed = true;
      console.log(`[DRIVER-KILL] pid ${pid} mid-push`);
    } else await new Promise((r) => setTimeout(r, 100));
  }
  if (!killed && !workflow) { const p = await w.getPushes({}); if (!p.length || p[0].state !== "done") { console.log("✗ never saw a live push"); process.exit(1); } }
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
