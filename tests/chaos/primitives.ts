// Chaos case for primitives: kill the engine inside spawn/cancel/drive, restart, rerun the
// idempotent scenario, then audit the tree: one agent per key, cancel reached every descendant,
// no live VMs for cancelled/finished agents, one event per transition, contiguous seqs.
import { spawn } from "child_process";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createClient } from "rivetkit/client";
import { Engine, engineEnv, type EngineOpts } from "./engine";
import { seedRepo, wipeEngineData } from "./survive";

// "driver.kill:0" = no engine kill: the scenario kills the driver process mid-push (engine push is slowed).
// push.after.before_event runs with a repo: the remote branch exists when the takeover runs, so it must adopt it.
// With the agent workflow (ADR-022, the default; CAPCOMD_AGENT_WORKFLOW=0 is the driver path) there are no driver processes; each driver case kills the engine host instead,
// mid-step, and proves the same recovery: "driver.kill:0" dies at workflow.watch.running while the slowed push is in
// flight (the run is re-run once after the restart, the push lands once, the agent finishes once); "vm.rpc.*:0" fire
// in the engine host, where the agent's spool pump now runs (the scripted "VM" outlives it, its RPC is answered once).
export const PRIM_KILLPOINTS = ["scope.spawn.mid:1", "scope.spawn.mid:3", "scope.cancel.mid:1", "push.mid:1", "push.after.before_event:1", "driver.kill:0", "merge.after_cas.before_event:1", "board.claim.mid:2", "board.claim.after.before_reply:4", "kv.cas.mid:3", "kv.cas.after.before_reply:4",
  // ADR-017: spawn-from-VM and await. "vm.rpc.*:0" kill the parent's driver (not the engine);
  // "vm.scope.spawn.mid:2" kills the engine inside the first spawn a VM asked for.
  "vm.rpc.spawn.before_reply:0", "vm.rpc.await.before:0", "vm.scope.spawn.mid:2"];
const ROOT = new URL("../..", import.meta.url).pathname;

function agentsFile() {
  const p = join(mkdtempSync(join(tmpdir(), "capcomd-chaos-prim-")), "agents.json");
  writeFileSync(p, JSON.stringify({ schema: "capcomd.agents/v1", agents: {
    sup: { provider: "claude", auth: "subscription", children: { allowSpawn: true, maxDepth: 1, maxChildren: 2, allowedChildProfiles: ["coder"], budgetShare: 0.5 } },
    coder: { provider: "claude", auth: "subscription" },
  } }));
  return p;
}

function runScenario(tag: string, opts: EngineOpts, extra: Record<string, string>, mode = "tree"): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const { CAPCOMD_ENDPOINT, ...rest } = engineEnv(opts);
    const env: NodeJS.ProcessEnv = { ...process.env, ...extra, ...(opts.repo ? rest : {}), CAPCOMD_ENDPOINT };
    delete env.CAPCOMD_KILLPOINT;
    const child = spawn(process.execPath, ["tests/chaos/primitives-scenario.ts", tag, mode], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout?.on("data", (d) => (output += d));
    child.stderr?.on("data", (d) => (output += d));
    const t = setTimeout(() => child.kill("SIGKILL"), 120_000);
    child.on("close", (code) => { clearTimeout(t); resolve({ code: code ?? 1, output }); });
  });
}

/** The lines that say what failed (error/code/message), which a raw stack tail often cuts off. */
function errorLines(out: string): string {
  return out.split("\n").filter((l) => /error|code:|message|✗/i.test(l) && !/^\s*at /.test(l)).slice(-6).map((l) => l.trim()).join(" | ").slice(0, 600);
}

export async function survivePrimitives(kp: string, baseOpts: EngineOpts): Promise<{ ok: boolean; killed: boolean; error?: string; phases: Record<string, number> }> {
  const tag = `${kp.replace(/[.:]/g, "-")}-${Date.now()}-p${baseOpts.port}`;
  const vm = kp.startsWith("vm.");
  const vmDriver = kp.startsWith("vm.rpc.");
  const driverKill = kp.startsWith("driver.kill") || vmDriver;
  const workflow = process.env.CAPCOMD_AGENT_WORKFLOW !== "0";
  // With the workflow, the driver's death is the engine host's: restart and resume like any engine kill.
  const engineKill = !driverKill || workflow;
  const adopt = kp.startsWith("push.after.before_event");
  const merge = kp.startsWith("merge.");
  const board = kp.startsWith("board."), kv = kp.startsWith("kv.");
  const mode = vm ? "subagent" : board ? "board" : kv ? "kv" : merge ? "merge" : driverKill || adopt ? "driverkill" : "tree";
  const opts: EngineOpts = { ...baseOpts, ...(adopt || merge ? { repo: true } : {}), ...(driverKill && !vm ? { env: { CAPCOMD_FAKE_PUSH_DELAY_MS: "4000" } } : {}) };
  const engine = new Engine(`prim-${tag}`, opts);
  // The workflow looks at its run every second here (default 60 s): driver.kill's killpoint must fire during the push.
  const extra: Record<string, string> = { CAPCOMD_AGENTS_FILE: agentsFile(), CAPCOMD_SPAWN_EXEC: vm ? "script" : "fake", CAPCOMD_AWAIT_POLL_MS: "200", CAPCOMD_DRIVER_LEASE_MS: "4000", CAPCOMD_SKIP_PREFLIGHT: "1", CAPCOMD_AGENT_WORKFLOW_POLL_MS: "1000" };
  if (vm) Object.assign(extra, {
    CAPCOMD_RPC_KEY: `chaos-${tag}`, CAPCOMD_SCRIPT_RPC_TIMEOUT_MS: "240000", CAPCOMD_SCRIPT_VM_DIR: mkdtempSync(join(tmpdir(), "capcomd-chaos-vms-")),
    ...(vmDriver ? { CAPCOMD_DRIVER_KILLPOINT: kp.slice(3).split(":")[0]!, CAPCOMD_DRIVER_KILLPOINT_MARKER: join(mkdtempSync(join(tmpdir(), "capcomd-chaos-dk-")), "fired") } : {}),
  });
  const phases: Record<string, number> = {};
  let t = Date.now();
  const mark = (k: string) => { phases[k] = Date.now() - t; t = Date.now(); };
  await wipeEngineData(opts);
  if (opts.repo) await seedRepo(opts);
  try {
    await engine.start(workflow && kp.startsWith("driver.kill") ? "workflow.watch.running:1" : driverKill ? null : vm ? kp.slice(3) : kp);
    mark("engineUp");
    const first = await runScenario(tag, opts, extra, mode);
    mark("firstClient");
    const killed = driverKill && !workflow ? first.output.includes("[DRIVER-KILL]") : engine.sawKill || first.output.includes("[KILLPOINT]");
    if (vmDriver && !killed) return { ok: false, killed, error: `driver killpoint ${kp} never fired: ${first.output.slice(-400)}`, phases };
    let final = first;
    if (engineKill && !(first.code === 0 && !killed)) {
      await engine.stop(); mark("stop");
      await engine.start(null); mark("restart");
      final = await runScenario(tag, opts, extra, mode);
      mark("resume");
    }
    if (!killed) return { ok: false, killed, error: `killpoint ${kp} never fired; client (${first.code}): ${first.output.slice(-400)}`, phases };
    if (final.code !== 0 || !final.output.includes("✓ primitives scenario ok")) return { ok: false, killed, error: `scenario failed (${final.code}): ${errorLines(final.output)} … ${final.output.slice(-400)}`, phases };
    const ids = JSON.parse(final.output.split("\n").find((l) => l.startsWith("PRIM "))!.slice(5));
    const v = mode === "subagent" ? await auditSubagent(ids, engineEnv(opts).CAPCOMD_ENDPOINT!) : mode === "board" ? await auditBoard(ids, engineEnv(opts).CAPCOMD_ENDPOINT!) : mode === "kv" ? await auditKv(ids, engineEnv(opts).CAPCOMD_ENDPOINT!) : mode === "merge" ? await auditMerge(ids, engineEnv(opts).CAPCOMD_ENDPOINT!, opts) : mode === "driverkill" ? await auditPush(ids, engineEnv(opts).CAPCOMD_ENDPOINT!, { driverKill, adopt, opts, workflow }) : await audit(ids, engineEnv(opts).CAPCOMD_ENDPOINT!);
    mark("audit");
    return v.length ? { ok: false, killed, error: v.join("; "), phases } : { ok: true, killed, phases };
  } catch (e) {
    return { ok: false, killed: engine.sawKill, error: String((e as Error)?.stack ?? e).slice(0, 600), phases };
  } finally {
    await engine.stop().catch(() => {});
  }
}

async function audit(ids: { runId: string; sup: string; c1: string; c2: string; d: string }, endpoint: string): Promise<string[]> {
  const c: any = createClient({ endpoint });
  const s = c.scope.getOrCreate([ids.runId]);
  const v: string[] = [];
  const agents: any[] = await s.listAgents({});
  if (agents.length !== 4) v.push(`expected 4 agents, got ${agents.length}`);
  const keys = agents.map((a) => a.key);
  if (new Set(keys).size !== keys.length) v.push(`duplicate keys ${keys}`);
  const st = Object.fromEntries(agents.map((a) => [a.agentId, a.status]));
  for (const k of ["sup", "c1", "c2"] as const) if (st[ids[k]] !== "cancelled") v.push(`${k} ${ids[k]} is ${st[ids[k]]}, want cancelled`);
  if (st[ids.d] !== "done") v.push(`d is ${st[ids.d]}, want done`);
  const evs: any[] = await s.getEvents({});
  evs.forEach((e, i) => { if (e.seq !== i + 1) v.push(`scope event gap at ${i + 1} (seq ${e.seq})`); });
  const count = (type: string, id: string) => evs.filter((e) => e.type === type && e.agentId === id).length;
  for (const a of agents) if (count("AGENT_SPAWNED", a.agentId) !== 1) v.push(`${a.agentId} AGENT_SPAWNED×${count("AGENT_SPAWNED", a.agentId)}`);
  for (const k of ["sup", "c1", "c2"] as const) if (count("AGENT_CANCELLED", ids[k]) !== 1) v.push(`${k} AGENT_CANCELLED×${count("AGENT_CANCELLED", ids[k])}`);
  if (count("AGENT_DONE", ids.d) !== 1) v.push(`d AGENT_DONE×${count("AGENT_DONE", ids.d)}`);
  const sup = agents.find((a) => a.agentId === ids.sup);
  const held = agents.filter((a) => a.parent === ids.sup).reduce((x, a) => x + (a.budget.usd ?? 0), 0);
  if (held > (sup.budget.usd ?? 0) * 1.000001) v.push(`children hold $${held} > parent $${sup.budget.usd}`);
  for (const a of agents) {
    const w = await c.worker.getOrCreate([ids.runId, a.agentId]).getWorker({ workerId: a.agentId });
    if (w && w.state !== "destroyed") v.push(`worker ${a.agentId} still ${w.state}`);
  }
  return v;
}

/** Spawn-from-VM: exactly two children (no duplicates from retried requests), all done, awaits cleared, tokens revoked. */
async function auditSubagent(ids: { runId: string; sup: string }, endpoint: string): Promise<string[]> {
  const c: any = createClient({ endpoint });
  const s = c.scope.getOrCreate([ids.runId]);
  const v: string[] = [];
  const agents: any[] = await s.listAgents({});
  const kids = agents.filter((a) => a.parent === ids.sup);
  if (agents.length !== 3 || kids.length !== 2) v.push(`expected sup + 2 children, got ${agents.length} agents (${kids.length} children)`);
  for (const a of agents) if (a.status !== "done") v.push(`${a.agentId} is ${a.status}`);
  const sup = agents.find((a) => a.agentId === ids.sup);
  for (const k of kids) if (!String(sup?.result?.summary ?? "").includes(k.agentId)) v.push(`sup result doesn't name child ${k.agentId}: ${sup?.result?.summary}`);
  const evs: any[] = await s.getEvents({});
  evs.forEach((e, i) => { if (e.seq !== i + 1) v.push(`scope event gap at ${i + 1} (seq ${e.seq})`); });
  for (const a of agents) { const n = evs.filter((e) => e.type === "AGENT_SPAWNED" && e.agentId === a.agentId).length; if (n !== 1) v.push(`${a.agentId} AGENT_SPAWNED×${n}`); }
  if (evs.some((e) => e.type === "DEADLOCK_DETECTED")) v.push("spurious DEADLOCK_DETECTED");
  const aw: any[] = await s.listAwaits({});
  if (aw.length) v.push(`stale await edges ${JSON.stringify(aw)}`);
  for (const a of agents) {
    const w = await c.worker.getOrCreate([ids.runId, a.agentId]).getWorker({ workerId: a.agentId });
    if (w && w.state !== "destroyed") v.push(`worker ${a.agentId} still ${w.state}`);
  }
  return v;
}

/** One push: the takeover driver waited for (driver kill) or adopted (engine kill after push) the first push. */
async function auditPush(ids: { runId: string; d: string }, endpoint: string, o: { driverKill: boolean; adopt: boolean; opts: EngineOpts; workflow?: boolean }): Promise<string[]> {
  const c: any = createClient({ endpoint });
  const v: string[] = [];
  const pushes: any[] = await c.worker.getOrCreate([ids.runId, ids.d]).getPushes({});
  if (pushes.length !== 1) v.push(`expected 1 push lock row, got ${pushes.length}`);
  const p = pushes[0];
  if (p?.state !== "done") v.push(`push state ${p?.state}`);
  if (o.driverKill && !o.workflow && p?.attempts !== 1) v.push(`driver kill: push ran ${p?.attempts}× (want 1: takeover must wait for the live push)`);
  // The workflow's executor died with the engine mid-push: its run is re-run once after the restart (a takeover).
  if (o.driverKill && o.workflow && p?.attempts !== 2) v.push(`engine kill mid-push: push ran ${p?.attempts}× (want 2: the lost run once more)`);
  if (o.adopt) {
    if (p?.attempts !== 2) v.push(`adopt: attempts ${p?.attempts} (want 2: first push, then takeover)`);
    if (!p?.adopted) v.push("adopt: takeover re-pushed instead of adopting the remote branch");
    const bare = `${o.opts.dataDir}/git/origin.git`;
    const n = Bun.spawnSync(["git", "-C", bare, "rev-list", "--count", `trunk..capcomd/${ids.runId}/${ids.d}`]).stdout.toString().trim();
    if (n !== "1") v.push(`remote branch has ${n} commits beyond trunk (want exactly 1 push)`);
  }
  const a = await c.scope.getOrCreate([ids.runId]).getAgent({ agentId: ids.d });
  if (a?.status !== "done") v.push(`agent ${a?.status}`);
  const evs: any[] = await c.scope.getOrCreate([ids.runId]).getEvents({});
  if (evs.filter((e) => e.type === "AGENT_DONE").length !== 1) v.push("AGENT_DONE not exactly once");
  return v;
}

/** Merge killed after the CAS: the rerun records the landed merge once, never lands twice. */
async function auditMerge(ids: { runId: string; d: string; vfy: string; mrg: string; commit: string }, endpoint: string, opts: EngineOpts): Promise<string[]> {
  const c: any = createClient({ endpoint });
  const s = c.scope.getOrCreate([ids.runId]);
  const v: string[] = [];
  const m = await s.getOp({ opId: ids.mrg });
  if (m?.state !== "merged") v.push(`merge op ${m?.state}`);
  if (m?.data?.expectSha !== ids.commit) v.push(`merge expectSha ${m?.data?.expectSha} != verified ${ids.commit}`);
  const evs: any[] = await s.getEvents({});
  for (const t of ["VERIFY_PASSED", "MERGED"]) { const n = evs.filter((e) => e.type === t).length; if (n !== 1) v.push(`${t}×${n}`); }
  evs.forEach((e, i) => { if (e.seq !== i + 1) v.push(`scope event gap at ${i + 1}`); });
  const bare = `${opts.dataDir}/git/origin.git`;
  const log = Bun.spawnSync(["git", "-C", bare, "log", "--format=%B", "trunk"]).stdout.toString();
  const n = log.split("Capcomd-Task:").length - 1;
  if (n !== 1) v.push(`trunk has ${n} task commits (want 1)`);
  return v;
}

/** Board: t1 taken over exactly once (epoch 2, done by w2, late w1 fenced); t2/t3 each claimed once and done once. */
async function auditBoard(ids: { runId: string; t1: string; t2: string; t3: string }, endpoint: string): Promise<string[]> {
  const c: any = createClient({ endpoint });
  const s = c.scope.getOrCreate([ids.runId]);
  const v: string[] = [];
  const tasks: any[] = await s.taskList({});
  if (tasks.length !== 3) v.push(`expected 3 tasks, got ${tasks.length}`);
  const t1 = tasks.find((t) => t.taskId === ids.t1);
  if (t1?.status !== "done" || t1?.holder !== "w2" || t1?.epoch !== 2 || t1?.result?.by !== "w2") v.push(`t1 ${JSON.stringify(t1)}`);
  // t2/t3: done once, by the holder of the final epoch. A lease that expired during a long
  // engine outage may be taken over (that's correct); every extra claim must be such a takeover.
  for (const id of [ids.t2, ids.t3]) {
    const t = tasks.find((x) => x.taskId === id);
    if (t?.status !== "done" || t?.result?.by !== t?.holder) v.push(`${id} ${JSON.stringify(t)} (want done by the final holder)`);
  }
  const evs: any[] = await s.getEvents({});
  evs.forEach((e, i) => { if (e.seq !== i + 1) v.push(`scope event gap at ${i + 1}`); });
  const n = (type: string, id: string) => evs.filter((e) => e.type === type && e.data.taskId === id).length;
  if (n("TASK_CLAIMED", ids.t1) !== 2) v.push(`t1 TASK_CLAIMED×${n("TASK_CLAIMED", ids.t1)} (want 2)`);
  if (n("TASK_LEASE_EXPIRED", ids.t1) !== 1) v.push(`t1 TASK_LEASE_EXPIRED×${n("TASK_LEASE_EXPIRED", ids.t1)}`);
  for (const id of [ids.t1, ids.t2, ids.t3]) {
    if (n("TASK_ADDED", id) !== 1) v.push(`${id} TASK_ADDED×${n("TASK_ADDED", id)}`);
    if (n("TASK_DONE", id) !== 1) v.push(`${id} TASK_DONE×${n("TASK_DONE", id)}`);
  }
  for (const id of [ids.t1, ids.t2, ids.t3]) {
    const claims = evs.filter((e) => e.type === "TASK_CLAIMED" && e.data.taskId === id);
    const epochs = claims.map((e) => e.data.epoch);
    if (JSON.stringify(epochs) !== JSON.stringify(epochs.map((_, i) => i + 1))) v.push(`${id} claim epochs ${JSON.stringify(epochs)} (want 1..n, no duplicate epoch)`);
    if (claims.length !== 1 + n("TASK_LEASE_EXPIRED", id) + n("TASK_RELEASED", id)) v.push(`${id} ${claims.length} claims but ${n("TASK_LEASE_EXPIRED", id)} expiries (a claim on a live lease)`);
    const t = tasks.find((x) => x.taskId === id);
    if (t && t.epoch !== claims.length) v.push(`${id} epoch ${t.epoch} != ${claims.length} claims`);
  }
  return v;
}

/** Kv: all 6 writers in the set, version 6 (no double apply), 6 KV_CAS events, keyed put applied once. */
async function auditKv(ids: { runId: string }, endpoint: string): Promise<string[]> {
  const c: any = createClient({ endpoint });
  const s = c.scope.getOrCreate([ids.runId]);
  const v: string[] = [];
  const m = await s.kvGet({ k: "members" });
  if (JSON.stringify(m?.value) !== "[0,1,2,3,4,5]") v.push(`members ${JSON.stringify(m?.value)}`);
  if (m?.version !== 6) v.push(`members version ${m?.version} (want 6: one cas per writer)`);
  const cfg = await s.kvGet({ k: "cfg" });
  if (cfg?.version !== 1) v.push(`cfg version ${cfg?.version} (keyed put applied ${cfg?.version}×)`);
  const evs: any[] = await s.getEvents({});
  evs.forEach((e, i) => { if (e.seq !== i + 1) v.push(`scope event gap at ${i + 1}`); });
  const cas = evs.filter((e) => e.type === "KV_CAS" && e.data.k === "members").map((e) => e.data.version);
  if (JSON.stringify(cas) !== "[1,2,3,4,5,6]") v.push(`KV_CAS versions ${JSON.stringify(cas)}`);
  return v;
}
