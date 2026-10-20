import { isBoxdAuthError } from "../providers/boxd-errors";
// ADR-016 step 1: run new / spawn / await / wait-any / cancel, on top of the existing worker
// actor. The CLI is a thin client; durable state lives in the scope actor (agent tree, keys,
// events) and the worker actor (VM, agent run, push). A driver process advances one agent;
// it holds a renewable lease, so a crashed driver is taken over by the next await/wait-any.
import { spawn as spawnProc } from "child_process";
import { mkdirSync, openSync, writeFileSync } from "fs";
import { join } from "path";
import { client, assertEngine } from "../core/relay";
import { RelayError } from "../core/errors";
import { decodeAgentRef, encodeAgentRef, resolveAgent, AgentConfigError, type Overrides } from "../agents/profiles";
import { available, budgetCaps, paramsHash, parseBudget, parseGrant, stableId, TERMINAL_AGENT, type Budget, type Grant } from "./policy";
import { stuckReason, treeView, rollups, subtree } from "../subagents/results";
import type { ScopeAgent } from "../actors/scope";
import { runScripted, ScriptFailed, withVmRpc } from "../subagents/driver";
import { killpoint } from "../utils/killpoint";
import { env } from "../utils/env";
import { agentSpanId, rootSpanIdForRun, withSpan } from "../utils/tracing-simple";

const LEASE_MS = Number(env("DRIVER_LEASE_MS") ?? 15_000);
const POLL_MS = Number(env("AWAIT_POLL_MS") ?? 300);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Map an actor UserError (code) onto the CLI's error envelope. */
export function asRelay(e: unknown): never {
  const err = e as { code?: string; message?: string; group?: string };
  const code = err?.code;
  const msg = err?.message ?? String(e);
  if (code === "conflict") throw new RelayError("conflict", msg, "Use a new --key, or repeat the call with the same parameters.");
  if (code === "not_found") throw new RelayError("not_found", msg, "Check ids with `capcomd agents-of <runId> --json` / `capcomd run new`.");
  if (code === "children_limit" || code === "widening") throw new RelayError("config", msg, "Spawn a profile the parent allows, narrow the overrides, or (operator) pass --operator for spec widening.");
  if (code === "lease_held") throw new RelayError("conflict", msg, "Claim another task (omit the id to take the next free one), or wait for the lease to expire.");
  if (code === "lease_lost" || code === "not_claimed") throw new RelayError("conflict", msg, "Your lease was taken over (its epoch moved). Stop work on this task; claim again if it is still open.");
  if (code === "blocked") throw new RelayError("conflict", msg, "Finish its --after tasks first, or claim without an id to get the next ready task.");
  if (code === "cycle") throw new RelayError("usage", msg, "A task may only depend on tasks that don't (transitively) depend on it.");
  if (code === "too_large") throw new RelayError("usage", msg, "Store large blobs elsewhere (a branch, a file in the repo) and put a reference in kv. Cap: CAPCOMD_KV_MAX_BYTES on the engine.");
  if (code === "cas_mismatch") throw new RelayError("conflict", msg, "Re-read with `capcomd kv get`, recompute, and cas with the new --expect version.");
  if (code === "backpressure") throw new RelayError("conflict", msg, "Fan-out is at the limit your parent granted: `capcomd wait-any` for a child to finish (or cancel one), then spawn again.", { retryable: true, code: "backpressure" });
  if (code === "deadlock") throw new RelayError("conflict", msg, "Await only your own children; never an ancestor or an agent that is waiting on you.", { code: "deadlock" });
  if (code === "budget" || code === "parent_terminal") throw new RelayError("conflict", msg, "Request a smaller --budget or free budget by cancelling agents.");
  throw e;
}

export interface RunNewOpts { budget: Budget; label?: string; key?: string; runId?: string }
export async function runNew(o: RunNewOpts) {
  await assertEngine();
  const runId = o.runId ?? stableId("run", "run", o.key);
  const c = client();
  const ph = paramsHash({ budget: o.budget, label: o.label ?? null });
  const res = await c.scope.getOrCreate([runId]).init({ runId, budget: o.budget, label: o.label, paramsHash: ph }).catch(asRelay);
  // The run actor gives the scope a USD ledger, `capcomd status` and the run event log.
  await c.run.getOrCreate([runId]).createRun({ runId, goal: o.label ?? "(primitives scope)", maxCost: o.budget.usd ?? 0 });
  return { runId, created: res.created, budget: res.budget };
}

export interface SpawnOpts {
  runId: string; task: string; profile?: string; overrides?: Overrides; parent?: string; key?: string;
  contract?: Record<string, unknown>; budget?: Budget; operator?: boolean; start?: boolean;
  /** ADR-017: children limits the parent grants this child (narrow-only; contract.children also accepted). */
  grant?: Grant;
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
  // Requested budget: the contract's `budget` ({usd, turns, wallSeconds}), then --budget per unit.
  let requested: Budget;
  try { requested = { ...parseBudget(o.contract?.budget), ...(o.budget ?? {}) }; } catch (e) { throw new RelayError("usage", (e as Error).message, "Budget units: usd, turns, wallSeconds (e.g. --budget usd=2,turns=40)."); }
  let grant: Grant;
  try { grant = { ...parseGrant(o.contract?.children), ...parseGrant(o.grant) }; } catch (e) { throw new RelayError("usage", (e as Error).message, "Grant fan-out with --children.maxChildren=N, --children.maxDepth=N, --children.maxTotalDescendants=N, --children.allowedChildProfiles=a,b, --children.budgetShare=0.5 (each may only narrow the ceiling)."); }
  const hasGrant = Object.keys(grant).length > 0;
  const ph = paramsHash({ parent: o.parent ?? null, ref, task: o.task, contract: o.contract ?? null, budget: requested, operator: !!o.operator, ...(hasGrant ? { grant } : {}) });
  const res = await client().scope.getOrCreate([o.runId]).spawn({
    runId: o.runId, agentId, key: o.key, paramsHash: ph, parent: o.parent ?? null,
    profile: resolved.name, ref: ref ?? resolved.name, spec: spec ? { ...spec, kind: resolved.kind } : { kind: resolved.kind },
    task: o.task, contract: o.contract ?? null, ...(Object.keys(requested).length ? { budget: requested } : {}), operator: o.operator,
    ...(hasGrant ? { grant } : {}),
  }).catch(asRelay);
  if (o.start !== false && !TERMINAL_AGENT.has(res.agent.status)) startDriver(o.runId, agentId);
  return { ...view(res.agent), created: res.created };
}

export function view(a: ScopeAgent) {
  return {
    agentId: a.agentId, runId: a.runId, parent: a.parent, depth: a.depth, profile: a.profile, status: a.status,
    budget: a.budget, spent: a.spent, task: a.task, key: a.key, limits: a.limits, result: a.result,
    ...(a.heartbeatAt ? { heartbeatAt: a.heartbeatAt } : {}), ...(stuckReason(a) ? { stuck: stuckReason(a) } : {}),
  };
}

/** One non-blocking look at agents (ADR-017 in-VM await polls this): kicks stale drivers. */
const kickedAt = new Map<string, number>();
export async function peekAgents(runId: string, ids: string[]) {
  const out: ScopeAgent[] = [];
  for (const id of ids) {
    const a = await getAgentOrThrow(runId, id);
    if (!TERMINAL_AGENT.has(a.status) && (!a.driver || a.driverUntil < Date.now()) && (kickedAt.get(id) ?? 0) < Date.now() - LEASE_MS) { startDriver(runId, id); kickedAt.set(id, Date.now()); }
    out.push(a);
  }
  return out;
}

export async function treeOf(runId: string, root?: string) {
  await assertEngine();
  const s = client().scope.getOrCreate([runId]);
  const all: ScopeAgent[] = await s.listAgents({});
  if (root && !all.some((a) => a.agentId === root)) throw new RelayError("not_found", `agent ${root} not found in ${runId}`, "Check ids with `capcomd tree <runId>`.");
  return { runId, root: root ?? null, tree: treeView(all, root), totals: rollupTotals(all, root) };
}
function rollupTotals(all: ScopeAgent[], root?: string) {
  const ids = root ? subtree(all, root) : new Set(all.map((a) => a.agentId));
  const ru = rollups(all);
  const tops = all.filter((a) => ids.has(a.agentId) && (!a.parent || !ids.has(a.parent)));
  const t = { agents: 0, usd: 0, turns: 0, wallSeconds: 0, byStatus: {} as Record<string, number> };
  for (const a of tops) { const r = ru.get(a.agentId)!; t.agents += r.agents; t.usd = Math.round((t.usd + r.usd) * 1e6) / 1e6; t.turns += r.turns; t.wallSeconds = Math.round((t.wallSeconds + r.wallSeconds) * 10) / 10; for (const [k, n] of Object.entries(r.byStatus)) t.byStatus[k] = (t.byStatus[k] ?? 0) + n; }
  return t;
}

/** Everything about one agent: record, children, awaits, ops it was verified/merged by, log tail, events. */
export async function inspectAgent(runId: string, agentId: string, o: { logTail?: number } = {}) {
  await assertEngine();
  const s = client().scope.getOrCreate([runId]);
  const a = await getAgentOrThrow(runId, agentId);
  const all: ScopeAgent[] = await s.listAgents({});
  const awaits = (await s.listAwaits({})).filter((w: any) => w.waiter === agentId || w.target === agentId);
  const events = (await s.getEvents({})).filter((e: any) => e.agentId === agentId || e.data?.parent === agentId).slice(-50);
  const logs = await s.getLogs({ agentId, tail: o.logTail ?? 50 });
  const w = client().worker.getOrCreate([runId, agentId]);
  const wk: any = await w.getWorker({ workerId: agentId }).catch(() => null);
  return {
    ...view(a), contract: a.contract, spec: a.spec, driver: a.driver, driverUntil: a.driverUntil, heartbeatNote: a.heartbeatNote,
    children: all.filter((x) => x.parent === agentId).map((x) => ({ agentId: x.agentId, status: x.status, profile: x.profile })),
    rollup: rollups(all).get(agentId), awaits, vm: wk ? { state: wk.state, vmId: wk.vmId ?? wk.context?.vmId ?? null } : null,
    events, logs,
  };
}

export async function agentLogs(runId: string, agentId: string, tail = 200) {
  await assertEngine();
  await getAgentOrThrow(runId, agentId);
  return { runId, agentId, lines: await client().scope.getOrCreate([runId]).getLogs({ agentId, tail }) };
}

/** Budget of an agent (or the run): allocation, own spend, what children hold, what's left to carve, subtree rollup. */
export async function budgetShow(runId: string, agentId?: string) {
  await assertEngine();
  const s = client().scope.getOrCreate([runId]);
  const all: ScopeAgent[] = await s.listAgents({});
  if (!agentId) { const sc = await s.getScope({}); return { runId, agentId: null, budget: sc?.budget ?? {}, spent: sc?.spent ?? {}, available: sc?.unallocated ?? {}, totals: rollupTotals(all) }; }
  const a = await getAgentOrThrow(runId, agentId);
  const kids = all.filter((x) => x.parent === agentId);
  return { runId, agentId, budget: a.budget, spent: a.spent, available: available(a.budget, a.spent, kids), limits: a.limits, children: kids.length, rollup: rollups(all).get(agentId) };
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
  try { const d = join(process.cwd(), ".relay", "drivers"); mkdirSync(d, { recursive: true }); writeFileSync(join(d, `${agentId}.pid`), String(process.pid)); } catch {}
  // Retry the (idempotent) steps; only an error that persists while the engine answers marks the
  // agent failed. If the engine is down, the last finish() throws too, and the lease expires
  // so the next await/wait-any resumes the agent.
  const s = client().scope.getOrCreate([runId]);
  const me = await s.getAgent({ agentId });
  // Trace parenting: agent spans nest under their parent agent's span (root agents under the run).
  return withSpan("agent.run", { "relay.run_id": runId, "agent.id": agentId, "agent.parent": me?.parent ?? null, "agent.profile": me?.profile ?? null, "agent.depth": me?.depth ?? 0 }, async (span) => {
    let last: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try { const a = await driveOnce(runId, agentId); span.attributes["agent.status"] = a.status; return a; } catch (e) {
        last = e;
        // A rejected credential never heals by retrying; a scripted agent's exit code is its answer.
        if (isBoxdAuthError(e) || e instanceof ScriptFailed) break;
        await sleep(2000 * attempt);
      }
    }
    const res = await resultOf(runId, agentId);
    const fin = await s.finish({ agentId, status: "failed", result: { ...res, error: (last as Error)?.message?.slice(0, 500) ?? String(last), ...(last instanceof ScriptFailed ? { exitCode: last.exitCode } : {}) } });
    span.attributes["agent.status"] = "failed";
    return fin.agent;
  }, { spanId: agentSpanId(runId, agentId), parentSpanId: me?.parent ? agentSpanId(runId, me.parent) : rootSpanIdForRun(runId) });
}

/** The structured result an agent declared with `capcomd result` (kv _result/<agt>), if any. */
async function resultOf(runId: string, agentId: string): Promise<Record<string, unknown>> {
  const r = await client().scope.getOrCreate([runId]).kvGet({ k: `_result/${agentId}` }).catch(() => null);
  const v = r && !r.deleted ? (r.value as any) : null;
  return v ? { summary: v.summary, artifacts: v.artifacts, ...(v.data !== undefined ? { data: v.data } : {}), ...(v.truncated ? { truncated: v.truncated } : {}) } : {};
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
  // The carved budget narrows the profile: maxTurns ≤ turns, timeoutMs ≤ wallSeconds, maxBudgetUsd ≤ usd.
  const mode = env("SPAWN_EXEC");
  let exec = mode === "fake" || mode === "script" ? undefined : (a.ref ?? undefined);
  if (exec) {
    const caps = budgetCaps(a.spec as any, a.budget);
    if (Object.keys(caps).length) {
      const d = decodeAgentRef(exec);
      exec = encodeAgentRef(d.name, { set: { ...(d.overrides?.set ?? {}), ...caps }, operator: d.overrides?.operator });
    }
  }
  const branch = `capcomd/${runId}/${agentId}`;
  // The commit's Capcomd-Task trailer names the task: the contract's planTask when set (the
  // hierarchical recipe, so landings match the legacy `<run>/<task>` key), else the agent id.
  const taskLabel = taskLabelOf(a, agentId);
  try {
    let wk = await w.getWorker({ workerId: agentId });
    if (!wk || wk.state === "provisioning" || wk.state === "failed") {
      await w.provisionWorker({ workerId: agentId, runId, epoch: 1, ...(exec ? { agent: exec } : {}) });
      wk = await w.getWorker({ workerId: agentId });
    }
    if (await cancelled()) { await w.drainWorker({ workerId: agentId }); return (await s.getAgent({ agentId }))!; }
    if (wk?.state === "idle") await w.assignTask({ workerId: agentId, taskId: taskLabel, epoch: 1 });
    // ADR-017: scripted fake agents run now (with in-VM capcomd on a local spool).
    let fakeFile: { path?: string; content?: string } = {};
    if (mode === "script") {
      const done = await s.getAgent({ agentId });
      const r0 = await resultOf(runId, agentId);
      if (!r0.summary || !done?.result) {
        killpoint("spawn.script.before");
        const { exitCode } = await runScripted(runId, a);
        if (await cancelled()) { await w.drainWorker({ workerId: agentId }); return (await s.getAgent({ agentId }))!; }
        if (exitCode !== 0) throw new ScriptFailed(`scripted agent exited ${exitCode}`, exitCode);
      }
      const r = await resultOf(runId, agentId);
      const f = (r.data as any)?.file;
      if (f && typeof f.path === "string") fakeFile = { path: f.path, content: String(f.content ?? "") };
    }
    // Handoff: my result is my successor's. Await it before finishing (finishing would reap it).
    const ho = await s.kvGet({ k: `handoff/${agentId}` }).catch(() => null);
    if (ho && !ho.deleted && (ho.value as any)?.to) {
      const to = String((ho.value as any).to);
      const [succ] = (await awaitAgents(runId, [to])).agents as any[];
      await w.drainWorker({ workerId: agentId }).catch(() => {});
      const st = succ.status === "done" ? "done" : "failed";
      const fin = await s.finish({ agentId, status: st, spent: { usd: 0, turns: 0, wallSeconds: 0 }, result: { ...(succ.result ?? {}), handoffTo: to } });
      return fin.agent;
    }
    const vmRpc = exec && a.limits.allowSpawn ? await vmRpcFor(runId, a, w, agentId) : null;
    const push = () => w.pushBranch({ workerId: agentId, taskId: taskLabel, epoch: 1, branch, runId, goal: a.task, ...(exec ? { agent: exec } : {}), ...fakeFileParams(fakeFile), ...(vmRpc ? { subagents: vmRpc.params } : {}) });
    const pushed: any = vmRpc ? await vmRpc.run(push) : await push();
    const rec = pushed.recorded ?? pushed; // a replayed push reports what the first push recorded
    const costUsd = Number(rec.costUsd ?? 0);
    const spent: Budget = { usd: costUsd, turns: Number(rec.turns ?? 0), wallSeconds: Number(rec.wallSeconds ?? 0) };
    if (costUsd > 0 && !pushed.already) await c.run.getOrCreate([runId]).chargeBudget({ runId, chargeId: `${agentId}-agent`, amount: costUsd });
    await w.taskDone({ workerId: agentId });
    await w.drainWorker({ workerId: agentId });
    if (await cancelled()) return (await s.getAgent({ agentId }))!;
    const declared = await resultOf(runId, agentId);
    const fin = await s.finish({ agentId, status: "done", spent, result: { ...declared, verification: null, branch, commit: pushed.sha || null, costUsd, turns: spent.turns, wallSeconds: spent.wallSeconds, billing: rec.billing ?? (costUsd ? "api" : "subscription-or-fake"), ...(pushed.adopted ? { adopted: true } : {}) } });
    return fin.agent;
  } catch (e) {
    if (await cancelled().catch(() => false)) { await w.drainWorker({ workerId: agentId }).catch(() => {}); return (await s.getAgent({ agentId }))!; }
    throw e;
  } finally {
    clearInterval(hb);
  }
}

function fakeFileParams(f: { path?: string; content?: string }) {
  return f.path ? { fakePath: f.path, fakeContent: f.content ?? "" } : {};
}

/** Real agent allowed to spawn: token + pump on its VM; the runner installs CLI, MCP and skill. */
async function vmRpcFor(runId: string, a: ScopeAgent, w: any, agentId: string) {
  const wk: any = await w.getWorker({ workerId: agentId });
  const vmId = wk?.context?.vmId;
  if (!vmId) return null;
  const { getDependencies } = await import("../dependencies");
  const provider = getDependencies().provider;
  const { orchestrationSkill } = await import("../subagents/skill");
  const kind = (a.spec as any)?.kind ?? (a.spec as any)?.provider;
  const params = { skill: orchestrationSkill({ agentId, limits: a.limits, budget: a.budget, mcp: true }), kind };
  return { params, run: <T>(fn: () => Promise<T>) => withVmRpc(runId, a, provider, vmId, undefined, fn) };
}

export async function getAgentOrThrow(runId: string, agentId: string): Promise<ScopeAgent> {
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
  const affected = all.filter((a: { agentId: string; status: string }) => res.affected.includes(a.agentId));
  for (const a of affected) {
    if (a.status !== "cancelled") continue;
    const w = c.worker.getOrCreate([runId, a.agentId]);
    const wk = await w.getWorker({ workerId: a.agentId });
    if (wk && wk.state !== "destroyed") await w.drainWorker({ workerId: a.agentId });
  }
  if (!agentId) await c.run.getOrCreate([runId]).cancel({ runId });
  return { runId, target: agentId ?? null, cancelled: res.cancelled, affected: affected.map((a: { agentId: string; status: string }) => ({ agentId: a.agentId, status: a.status })) };
}

export async function listScope(runId: string) {
  await assertEngine();
  const s = client().scope.getOrCreate([runId]);
  const scope = await s.getScope({});
  if (!scope) throw new RelayError("not_found", `run ${runId} has no primitives scope`, "Create one with `capcomd run new`.");
  return { runId, ...scope, agents: (await s.listAgents({})).map(view) };
}

// ── ADR-016 step 2: verify + merge --require ────────────────────────────────────────────────

function taskLabelOf(a: any, agentId: string): string {
  const p = a?.contract?.planTask;
  return typeof p === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(p) ? p : agentId;
}

/** A ref is an agent id (its pushed branch) or a branch name. */
async function resolveRef(runId: string, ref: string): Promise<{ branch: string; agentId: string | null; label: string }> {
  if (ref.startsWith("agt-")) {
    const a = await getAgentOrThrow(runId, ref);
    const branch = a.result?.branch as string | undefined;
    if (a.status !== "done" || !branch) throw new RelayError("conflict", `agent ${ref} is ${a.status}; only a done agent's branch can be verified`, `Wait with \`capcomd await ${runId} ${ref}\`.`);
    return { branch, agentId: ref, label: taskLabelOf(a, ref) };
  }
  return { branch: ref, agentId: null, label: ref };
}

export interface VerifyOpts { runId: string; ref: string; checks?: string; acceptance?: unknown; judgeProfile?: string; target?: string; key?: string }

/**
 * Run checks (the repo's test command or --checks) on the ref merged with the latest target, in
 * the verifier actor (ADR-003: the result comes from running it, never from the agent's report).
 * With --judge-profile, a judge also scores the acceptance criteria; both must pass.
 * Records vfy-… with the exact branch commit tested, which `merge --require` checks.
 */
export async function verifyRef(o: VerifyOpts) {
  await assertEngine();
  const c = client();
  const s = c.scope.getOrCreate([o.runId]);
  const { loadMergeConfig } = await import("../merge/config");
  const cfg = loadMergeConfig();
  const target = o.target ?? cfg?.target ?? "main";
  const { branch, agentId, label } = await resolveRef(o.runId, o.ref);
  const vfyId = stableId("vfy", `${o.runId}\0${o.ref}`, o.key);
  const data = { ref: o.ref, agentId, branch, target, checks: o.checks ?? null, acceptance: o.acceptance ?? null, judgeProfile: o.judgeProfile ?? null };
  const st = await s.startOp({ opId: vfyId, kind: "verify", paramsHash: paramsHash(data), data }).catch(asRelay);
  if (st.op.state !== "running") return opView(st.op);
  const res: any = await c.verifier.getOrCreate([o.runId, vfyId]).verify({
    verifierId: vfyId, taskId: label, branch, runId: o.runId, target, testOnly: true, ...(o.checks ? { testCommand: o.checks } : {}),
  });
  const out = res.outcome as import("../merge/types").MergeOutcome;
  const checksPassed = out.status === "verified";
  let judge: Record<string, unknown> | null = null;
  if (checksPassed && o.judgeProfile) {
    // Step 2: the judge actor scores the criteria with the configured model. Running a judge
    // *agent profile* in a VM (read-only checkout) comes in a later step.
    const j: any = await c.judge.getOrCreate([o.runId, vfyId]).judge({ judgeId: `${vfyId}-judge`, runId: o.runId, goal: `Acceptance criteria: ${JSON.stringify(o.acceptance ?? "the task is done")}`, completedTasks: [branch] });
    judge = { profile: o.judgeProfile, passed: !!j.passed, feedback: String(j.feedback ?? "").slice(0, 1000) };
  }
  const pass = checksPassed && (judge ? judge.passed === true : true);
  const result = {
    pass, branch, target, commit: out.status === "verified" ? (out.taskSha ?? null) : null,
    checks: { passed: checksPassed, status: out.status, ...(out.status === "failed" ? { reason: out.reason } : {}), ...(out.status === "conflict" ? { files: out.files } : {}), output: "output" in out && out.output ? String(out.output).slice(-2000) : null },
    ...(judge ? { judge } : {}),
  };
  const fin = opView(await s.finishOp({ opId: vfyId, state: pass ? "passed" : "failed", result }));
  if (agentId) await s.annotateResult({ agentId, patch: { verification: { id: vfyId, pass, commit: result.commit, checks: { passed: checksPassed, status: out.status } } } }).catch(() => {});
  return fin;
}

export interface MergeOpts { runId: string; ref: string; require?: string; target?: string; operator?: boolean; key?: string }

/** Land a ref. Requires a passing vfy for that exact commit and target, unless --operator. */
export async function mergeRef(o: MergeOpts) {
  await assertEngine();
  const c = client();
  const s = c.scope.getOrCreate([o.runId]);
  const { loadMergeConfig } = await import("../merge/config");
  const { isProtectedBranch } = await import("../utils/protected");
  const cfg = loadMergeConfig();
  const target = o.target ?? cfg?.target ?? "main";
  const { branch, agentId, label } = await resolveRef(o.runId, o.ref);
  let expectSha: string | undefined;
  if (!o.require && !o.operator) throw new RelayError("usage", "merge needs --require <vfyId> (a passing `capcomd verify` of this ref)", "Run `capcomd verify <runId> --ref <ref>` first, or pass --operator to merge unverified.");
  if (o.require) {
    const v = await s.getOp({ opId: o.require });
    if (!v || v.kind !== "verify") throw new RelayError("not_found", `verification ${o.require} not found in ${o.runId}`, "Pass the id `capcomd verify` returned.");
    if (v.state !== "passed") throw new RelayError("conflict", `verification ${o.require} is ${v.state}`, "Only a passing verification can gate a merge.");
    if (v.data.branch !== branch || v.data.target !== target) throw new RelayError("conflict", `verification ${o.require} covers ${v.data.branch} → ${v.data.target}, not ${branch} → ${target}`, "Verify this ref against this target.");
    expectSha = (v.result?.commit as string | null) ?? undefined;
  }
  // No repo configured (fake merges, like the legacy loop without CAPCOMD_REPO): nothing to protect.
  if (cfg && isProtectedBranch(target) && !o.operator) throw new RelayError("conflict", `target ${target} is protected`, "Protected targets need an operator: pass --operator (or use `capcomd run` + `capcomd approve`).");
  const mrgId = stableId("mrg", `${o.runId}\0${o.ref}\0${target}`, o.key);
  const data = { ref: o.ref, agentId, branch, target, require: o.require ?? null, operator: !!o.operator, expectSha: expectSha ?? null };
  const st = await s.startOp({ opId: mrgId, kind: "merge", paramsHash: paramsHash(data), data }).catch(asRelay);
  if (st.op.state !== "running") return opView(st.op);
  const res: any = await c.verifier.getOrCreate([o.runId, mrgId]).verify({
    verifierId: mrgId, taskId: label, branch, runId: o.runId, target, testOnly: false, ...(expectSha ? { expectSha } : {}),
  });
  const out = res.outcome as import("../merge/types").MergeOutcome;
  const merged = out.status === "merged";
  const result = merged
    ? { merged: true, sha: out.sha, how: out.how, already: out.already, mode: out.mode, ...(out.pr ? { pr: out.pr } : {}) }
    : { merged: false, status: out.status, ...(out.status === "failed" ? { reason: out.reason } : {}), ...(out.status === "conflict" ? { files: out.files } : {}) };
  return opView(await s.finishOp({ opId: mrgId, state: merged ? "merged" : "failed", result }));
}

function opView(op: import("../actors/scope").ScopeOp) {
  return { id: op.id, kind: op.kind, state: op.state, ...op.data, result: op.result };
}
