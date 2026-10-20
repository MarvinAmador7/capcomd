// ADR-016 step 1: run new / spawn / await / wait-any / cancel, on top of the existing worker
// actor. The CLI is a thin client; durable state lives in the scope actor (agent tree, keys,
// events) and the worker actor (VM, agent run, push). A driver process advances one agent;
// it holds a renewable lease, so a crashed driver is taken over by the next await/wait-any.
import { spawn as spawnProc } from "child_process";
import { mkdirSync, openSync } from "fs";
import { join } from "path";
import { client, assertEngine } from "../core/relay";
import { RelayError } from "../core/errors";
import { encodeAgentRef, resolveAgent, AgentConfigError, type Overrides } from "../agents/profiles";
import { paramsHash, stableId, TERMINAL_AGENT } from "./policy";
import type { ScopeAgent } from "../actors/scope";
import { env } from "../utils/env";

const LEASE_MS = Number(env("DRIVER_LEASE_MS") ?? 15_000);
const POLL_MS = Number(env("AWAIT_POLL_MS") ?? 300);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Map an actor UserError (code) onto the CLI's error envelope. */
function asRelay(e: unknown): never {
  const err = e as { code?: string; message?: string; group?: string };
  const code = err?.code;
  const msg = err?.message ?? String(e);
  if (code === "conflict") throw new RelayError("conflict", msg, "Use a new --key, or repeat the call with the same parameters.");
  if (code === "not_found") throw new RelayError("not_found", msg, "Check ids with `capcomd agents-of <runId> --json` / `capcomd run new`.");
  if (code === "children_limit" || code === "widening") throw new RelayError("config", msg, "Spawn a profile the parent allows, narrow the overrides, or (operator) pass --operator for spec widening.");
  if (code === "budget" || code === "parent_terminal") throw new RelayError("conflict", msg, "Request a smaller --budget or free budget by cancelling agents.");
  throw e;
}

export interface RunNewOpts { budgetUsd: number; label?: string; key?: string; runId?: string }
export async function runNew(o: RunNewOpts) {
  await assertEngine();
  const runId = o.runId ?? stableId("run", "run", o.key);
  const c = client();
  const ph = paramsHash({ budgetUsd: o.budgetUsd, label: o.label ?? null });
  const res = await c.scope.getOrCreate([runId]).init({ runId, budgetUsd: o.budgetUsd, label: o.label, paramsHash: ph }).catch(asRelay);
  // The run actor gives the scope a budget ledger, `capcomd status` and the run event log.
  await c.run.getOrCreate([runId]).createRun({ runId, goal: o.label ?? "(primitives scope)", maxCost: o.budgetUsd });
  return { runId, created: res.created, budgetUsd: res.budgetUsd };
}

export interface SpawnOpts {
  runId: string; task: string; profile?: string; overrides?: Overrides; parent?: string; key?: string;
  contract?: Record<string, unknown>; budgetUsd?: number; operator?: boolean; start?: boolean;
}
export async function spawnAgent(o: SpawnOpts) {
  await assertEngine();
  let resolved;
  const ref = o.profile ? encodeAgentRef(o.profile, o.overrides) : null;
  try { resolved = resolveAgent(ref); } catch (e) {
    if (e instanceof AgentConfigError) throw new RelayError("config", e.message, "Check the profile with `capcomd agents show <name>`; overrides may only narrow unless --operator.");
    throw e;
  }
  const scope = o.parent ?? "operator";
  const agentId = stableId("agt", `${o.runId}\0${scope}`, o.key);
  const spec = resolved.spec ? (resolved.spec as unknown as Record<string, unknown>) : null;
  const ph = paramsHash({ parent: o.parent ?? null, ref, task: o.task, contract: o.contract ?? null, budgetUsd: o.budgetUsd ?? null, operator: !!o.operator });
  const res = await client().scope.getOrCreate([o.runId]).spawn({
    runId: o.runId, agentId, key: o.key, paramsHash: ph, parent: o.parent ?? null,
    profile: resolved.name, ref: ref ?? resolved.name, spec: spec ? { ...spec, kind: resolved.kind } : { kind: resolved.kind },
    task: o.task, contract: o.contract ?? null, budgetUsd: o.budgetUsd, operator: o.operator,
  }).catch(asRelay);
  if (o.start !== false && !TERMINAL_AGENT.has(res.agent.status)) startDriver(o.runId, agentId);
  return { ...view(res.agent), created: res.created };
}

export function view(a: ScopeAgent) {
  return {
    agentId: a.agentId, runId: a.runId, parent: a.parent, depth: a.depth, profile: a.profile, status: a.status,
    budgetUsd: a.budgetUsd, spentUsd: a.spentUsd, task: a.task, key: a.key, limits: a.limits, result: a.result,
  };
}

/** Launch a detached driver process for one agent (logs in .relay/drivers/). */
export function startDriver(runId: string, agentId: string) {
  if (env("NO_DRIVER") === "1") return;
  const dir = join(process.cwd(), ".relay", "drivers");
  mkdirSync(dir, { recursive: true });
  const fd = openSync(join(dir, `${agentId}.log`), "a");
  const cli = new URL("../cli/index.ts", import.meta.url).pathname;
  const p = spawnProc(process.execPath, [cli, "agent-drive", runId, agentId], { detached: true, stdio: ["ignore", fd, fd], env: process.env });
  p.unref();
}

/**
 * Advance one agent to a terminal state. Every step is idempotent (worker actor), so a new
 * driver resumes where a crashed one stopped. Returns the agent's final record.
 */
export async function driveAgent(runId: string, agentId: string): Promise<ScopeAgent> {
  // Retry the (idempotent) steps; only an error that persists while the engine answers marks the
  // agent failed. If the engine is down, the last finish() throws too, and the lease expires
  // so the next await/wait-any resumes the agent.
  let last: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try { return await driveOnce(runId, agentId); } catch (e) { last = e; await sleep(2000 * attempt); }
  }
  const s = client().scope.getOrCreate([runId]);
  const fin = await s.finish({ agentId, status: "failed", result: { error: (last as Error)?.message?.slice(0, 500) ?? String(last) } });
  return fin.agent;
}

async function driveOnce(runId: string, agentId: string): Promise<ScopeAgent> {
  const c = client();
  const s = c.scope.getOrCreate([runId]);
  const driver = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const claim = await s.claimDriver({ agentId, driver, ttlMs: LEASE_MS }).catch(asRelay);
  if (!claim.ok) return claim.agent;
  const a = claim.agent;
  const hb = setInterval(() => { s.claimDriver({ agentId, driver, ttlMs: LEASE_MS }).catch(() => {}); }, Math.max(500, LEASE_MS / 3));
  const w = c.worker.getOrCreate([runId, agentId]);
  const cancelled = async () => (await s.getAgent({ agentId }))?.status === "cancelled";
  // Test/eval knob: run the fake agent while profiles still govern policy (no real CLI/repo).
  const exec = env("SPAWN_EXEC") === "fake" ? undefined : (a.ref ?? undefined);
  const branch = `capcomd/${runId}/${agentId}`;
  try {
    let wk = await w.getWorker({ workerId: agentId });
    if (!wk || wk.state === "provisioning" || wk.state === "failed") {
      await w.provisionWorker({ workerId: agentId, runId, epoch: 1, ...(exec ? { agent: exec } : {}) });
      wk = await w.getWorker({ workerId: agentId });
    }
    if (await cancelled()) { await w.drainWorker({ workerId: agentId }); return (await s.getAgent({ agentId }))!; }
    if (wk?.state === "idle") await w.assignTask({ workerId: agentId, taskId: agentId, epoch: 1 });
    const pushed: any = await w.pushBranch({ workerId: agentId, taskId: agentId, epoch: 1, branch, runId, goal: a.task, ...(exec ? { agent: exec } : {}) });
    const costUsd = Number(pushed.costUsd ?? 0);
    if (costUsd > 0) await c.run.getOrCreate([runId]).chargeBudget({ runId, chargeId: `${agentId}-agent`, amount: costUsd });
    await w.taskDone({ workerId: agentId });
    await w.drainWorker({ workerId: agentId });
    if (await cancelled()) return (await s.getAgent({ agentId }))!;
    const fin = await s.finish({ agentId, status: "done", spentUsd: costUsd, result: { branch, commit: pushed.sha || null, costUsd, billing: pushed.billing ?? (costUsd ? "api" : null) } });
    return fin.agent;
  } catch (e) {
    if (await cancelled().catch(() => false)) { await w.drainWorker({ workerId: agentId }).catch(() => {}); return (await s.getAgent({ agentId }))!; }
    throw e;
  } finally {
    clearInterval(hb);
  }
}

async function getAgentOrThrow(runId: string, agentId: string): Promise<ScopeAgent> {
  const a = await client().scope.getOrCreate([runId]).getAgent({ agentId });
  if (!a) throw new RelayError("not_found", `agent ${agentId} not found in ${runId}`, "Check ids with `capcomd agents-of <runId> --json`.");
  return a;
}

/** Wait until the agents are terminal; take over stale drivers. Timeout returns status "timeout". */
export async function awaitAgents(runId: string, ids: string[], opts: { timeoutMs?: number; any?: boolean } = {}) {
  await assertEngine();
  const deadline = Date.now() + (opts.timeoutMs ?? 30 * 60_000);
  const kicked = new Map<string, number>();
  const done = new Map<string, ScopeAgent>();
  for (;;) {
    for (const id of ids) {
      if (done.has(id)) continue;
      const a = await getAgentOrThrow(runId, id);
      if (TERMINAL_AGENT.has(a.status)) { done.set(id, a); continue; }
      const stale = !a.driver || a.driverUntil < Date.now();
      if (stale && (kicked.get(id) ?? 0) < Date.now() - LEASE_MS) { startDriver(runId, id); kicked.set(id, Date.now()); }
    }
    if (opts.any && done.size) { const [first] = [...done.values()].sort((x, y) => x.updatedAt - y.updatedAt); return { first: view(first!), agents: ids.map((i) => (done.has(i) ? view(done.get(i)!) : { agentId: i, status: "running" })) }; }
    if (done.size === ids.length) return { agents: ids.map((i) => view(done.get(i)!)) };
    if (Date.now() > deadline) return { timeout: true, agents: ids.map((i) => (done.has(i) ? view(done.get(i)!) : { agentId: i, status: "timeout" })) };
    await sleep(POLL_MS);
  }
}

/** Cancel an agent (or the whole run) and every descendant; destroy their VMs. Idempotent. */
export async function cancelAgents(runId: string, agentId?: string, reason?: string) {
  await assertEngine();
  const c = client();
  const s = c.scope.getOrCreate([runId]);
  const res = await s.cancel({ ...(agentId ? { agentId } : {}), ...(reason ? { reason } : {}) }).catch(asRelay);
  const all = await s.listAgents({});
  const affected = all.filter((a) => res.affected.includes(a.agentId));
  for (const a of affected) {
    if (a.status !== "cancelled") continue;
    const w = c.worker.getOrCreate([runId, a.agentId]);
    const wk = await w.getWorker({ workerId: a.agentId });
    if (wk && wk.state !== "destroyed") await w.drainWorker({ workerId: a.agentId });
  }
  if (!agentId) await c.run.getOrCreate([runId]).cancel({ runId });
  return { runId, target: agentId ?? null, cancelled: res.cancelled, affected: affected.map((a) => ({ agentId: a.agentId, status: a.status })) };
}

export async function listScope(runId: string) {
  await assertEngine();
  const s = client().scope.getOrCreate([runId]);
  const scope = await s.getScope({});
  if (!scope) throw new RelayError("not_found", `run ${runId} has no primitives scope`, "Create one with `capcomd run new`.");
  return { runId, ...scope, agents: (await s.listAgents({})).map(view) };
}
