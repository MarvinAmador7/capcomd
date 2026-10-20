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
export const PRIM_KILLPOINTS = ["scope.spawn.mid:1", "scope.spawn.mid:3", "scope.cancel.mid:1", "push.mid:1", "push.after.before_event:1", "driver.kill:0", "merge.after_cas.before_event:1"];
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
    const env = { ...process.env, ...extra, ...(opts.repo ? rest : {}), CAPCOMD_ENDPOINT };
    delete env.CAPCOMD_KILLPOINT;
    const child = spawn(process.execPath, ["tests/chaos/primitives-scenario.ts", tag, mode], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout?.on("data", (d) => (output += d));
    child.stderr?.on("data", (d) => (output += d));
    const t = setTimeout(() => child.kill("SIGKILL"), 120_000);
    child.on("close", (code) => { clearTimeout(t); resolve({ code: code ?? 1, output }); });
  });
}

export async function survivePrimitives(kp: string, baseOpts: EngineOpts): Promise<{ ok: boolean; killed: boolean; error?: string; phases: Record<string, number> }> {
  const tag = `${kp.replace(/[.:]/g, "-")}-${Date.now()}-p${baseOpts.port}`;
  const driverKill = kp.startsWith("driver.kill");
  const adopt = kp.startsWith("push.after.before_event");
  const merge = kp.startsWith("merge.");
  const mode = merge ? "merge" : driverKill || adopt ? "driverkill" : "tree";
  const opts: EngineOpts = { ...baseOpts, ...(adopt || merge ? { repo: true } : {}), ...(driverKill ? { env: { CAPCOMD_FAKE_PUSH_DELAY_MS: "4000" } } : {}) };
  const engine = new Engine(`prim-${tag}`, opts);
  const extra = { CAPCOMD_AGENTS_FILE: agentsFile(), CAPCOMD_SPAWN_EXEC: "fake", CAPCOMD_AWAIT_POLL_MS: "200", CAPCOMD_DRIVER_LEASE_MS: "4000", CAPCOMD_SKIP_PREFLIGHT: "1" };
  const phases: Record<string, number> = {};
  let t = Date.now();
  const mark = (k: string) => { phases[k] = Date.now() - t; t = Date.now(); };
  await wipeEngineData(opts);
  if (opts.repo) await seedRepo(opts);
  try {
    await engine.start(driverKill ? null : kp);
    mark("engineUp");
    const first = await runScenario(tag, opts, extra, mode);
    mark("firstClient");
    const killed = driverKill ? first.output.includes("[DRIVER-KILL]") : engine.sawKill || first.output.includes("[KILLPOINT]");
    let final = first;
    if (!driverKill && !(first.code === 0 && !killed)) {
      await engine.stop(); mark("stop");
      await engine.start(null); mark("restart");
      final = await runScenario(tag, opts, extra, mode);
      mark("resume");
    }
    if (!killed) return { ok: false, killed, error: `killpoint ${kp} never fired; client (${first.code}): ${first.output.slice(-400)}`, phases };
    if (final.code !== 0 || !final.output.includes("✓ primitives scenario ok")) return { ok: false, killed, error: `scenario failed (${final.code}): ${final.output.slice(-600)}`, phases };
    const ids = JSON.parse(final.output.split("\n").find((l) => l.startsWith("PRIM "))!.slice(5));
    const v = mode === "merge" ? await auditMerge(ids, engineEnv(opts).CAPCOMD_ENDPOINT!, opts) : mode === "driverkill" ? await auditPush(ids, engineEnv(opts).CAPCOMD_ENDPOINT!, { driverKill, adopt, opts }) : await audit(ids, engineEnv(opts).CAPCOMD_ENDPOINT!);
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

/** One push: the takeover driver waited for (driver kill) or adopted (engine kill after push) the first push. */
async function auditPush(ids: { runId: string; d: string }, endpoint: string, o: { driverKill: boolean; adopt: boolean; opts: EngineOpts }): Promise<string[]> {
  const c: any = createClient({ endpoint });
  const v: string[] = [];
  const pushes: any[] = await c.worker.getOrCreate([ids.runId, ids.d]).getPushes({});
  if (pushes.length !== 1) v.push(`expected 1 push lock row, got ${pushes.length}`);
  const p = pushes[0];
  if (p?.state !== "done") v.push(`push state ${p?.state}`);
  if (o.driverKill && p?.attempts !== 1) v.push(`driver kill: push ran ${p?.attempts}× (want 1: takeover must wait for the live push)`);
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
