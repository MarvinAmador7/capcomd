// ADR-022 (spike, behind CAPCOMD_AGENT_WORKFLOW=1): one agent's lifecycle as a Rivet workflow inside its worker actor.
//
// With the flag on, nothing runs `capcomd agent-drive`: starting an agent (spawn, resume, an await's kick) sends a
// `start` message to the worker actor of its current epoch, whose workflow then drives it to an end:
//
//   wait-start → prepare (claim, operator pause, env snapshot, login quota)
//   → drive loop, one phase per iteration: ensure-machine (provision + assign) → start-agent (the run, in the actor,
//     kept awake) → poll (lease, attempt row) + sleep, [restart-agent after a daemon restart] → on failure: record it,
//     back off, try again (3 attempts, the driver's rules)
//   → settle (charge, task done, drain, finish or pause) → [quota: sleepUntil(reset) → wake the next epoch]
//
// Every step is durable: after a daemon or engine restart the engine wakes the actor and the workflow replays to where
// it was. The agent's run itself (the runner, a scripted agent, the push) can't be resumed half-way: an attempt whose
// engine process is gone ("lost": its row names another ENGINE_INSTANCE) runs again, as a driver's retry did (the
// runner stops what the earlier run left in the VM; the push lock adopts a branch that already landed).
import { queue } from "rivetkit";
import { Loop, workflow } from "rivetkit/workflow";
import type { RawAccess } from "rivetkit/db";
import { env } from "../utils/env";
import { ENGINE_INSTANCE } from "../utils/engine-instance";
import { redactShapes } from "../agents/redact";

export { agentWorkflowOn } from "../utils/agent-workflow-flag";

export interface StartAgent { runId: string; agentId: string; epoch: number }

const POLL_MS = () => Number(env("AGENT_WORKFLOW_POLL_MS") ?? 1000);
const LEASE_MS = () => Number(env("DRIVER_LEASE_MS") ?? 15_000);
const MAX_ATTEMPTS = 3;

export const ATTEMPTS_SQL = `CREATE TABLE IF NOT EXISTS agent_attempts (
  attempt INTEGER PRIMARY KEY, instance TEXT NOT NULL, state TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER,
  outcome TEXT, error TEXT, restarts INTEGER NOT NULL DEFAULT 0)`;
export const STARTS_SQL = "CREATE TABLE IF NOT EXISTS agent_workflow_start (id INTEGER PRIMARY KEY CHECK (id = 1), run_id TEXT NOT NULL, agent_id TEXT NOT NULL, epoch INTEGER NOT NULL, at INTEGER NOT NULL)";

/** The worker actor's queue and run handler, added only with the flag on (the flag off leaves the actor as it was). */
export function agentWorkflowParts() {
  return { queues: { start: queue<StartAgent>() }, run: workflow(agentLifecycle) };
}

/**
 * The worker action `startAgent`: queue the one `start` its workflow waits for. Idempotent (the first call queues it,
 * later ones only wake the actor, which resumes its workflow if a restart left it asleep).
 */
export async function queueStart(c: any, p: StartAgent): Promise<{ queued: boolean }> {
  await c.db.execute(STARTS_SQL);
  const had = await c.db.execute("SELECT 1 FROM agent_workflow_start WHERE id = 1");
  if (had.length) return { queued: false };
  await c.db.execute("INSERT OR IGNORE INTO agent_workflow_start (id, run_id, agent_id, epoch, at) VALUES (1, ?, ?, ?, ?)", p.runId, p.agentId, p.epoch, Date.now());
  await c.queue.send("start", p);
  return { queued: true };
}

/** What a failed attempt was, as stored (the driver's classification: some failures are never retried). */
interface AttemptError { kind: string; message: string; exitCode?: number; final: boolean }
type Drive = { phase: "ensure" | "start" | "watch" | "failed"; n: number; error?: AttemptError };
type Poll = { state: "running" } | { state: "lost" } | { state: "done"; outcome: unknown } | { state: "failed"; error: AttemptError } | { state: "ended" };

const ops = () => import("../primitives/ops");
const scopeOf = async (runId: string) => (await import("../core/relay")).client().scope.getOrCreate([runId]);

/** Errors the driver never retried: a rejected sandbox login, a scripted agent's exit code, a missing env snapshot,
 *  a limit (timeout, turns, budget) and a configuration problem. */
async function classify(e: unknown): Promise<AttemptError> {
  const { ScriptFailed } = await import("../subagents/driver");
  const { isBoxdAuthError } = await import("../providers/boxd-errors");
  const { EnvSnapshotMissing } = await ops();
  const kind = String((e as any)?.code ?? (e as any)?.kind ?? (e as Error)?.name ?? "error");
  const message = redactShapes(String((e as Error)?.message ?? e)).slice(0, 2000);
  const final = isBoxdAuthError(e) || e instanceof ScriptFailed || e instanceof EnvSnapshotMissing || kind === "limit" || kind === "config" || kind === "sandbox_auth";
  return { kind, message, final, ...(e instanceof ScriptFailed ? { exitCode: e.exitCode } : {}) };
}

/**
 * Run attempt `n` in the background of this actor (kept awake until it settles), recording its end in agent_attempts.
 * Called from a step; it must not touch the step's context after the step returns, so it keeps the actor's own db,
 * key and client.
 */
async function startAttempt(c: any, p: StartAgent, n: number): Promise<"started" | "running" | "settled"> {
  const db: RawAccess = c.db;
  const key: string[] = c.key;
  const cl = c.client();
  await db.execute(ATTEMPTS_SQL);
  const row: any = (await db.execute("SELECT state, instance FROM agent_attempts WHERE attempt = ?", n))[0];
  if (row && row.state !== "running") return "settled";
  if (row && row.instance === ENGINE_INSTANCE) return "running";
  await db.execute(`INSERT INTO agent_attempts (attempt, instance, state, started_at) VALUES (?, ?, 'running', ?)
    ON CONFLICT(attempt) DO UPDATE SET instance = excluded.instance, state = 'running', restarts = agent_attempts.restarts + 1`, n, ENGINE_INSTANCE, Date.now());
  const run = (async () => {
    const o = await ops();
    const a = await o.getAgentOrThrow(p.runId, p.agentId);
    const w = cl.worker.getOrCreate(key);
    const { pushBranchImpl } = await import("./worker");
    const shim = { db, key, client: () => cl };
    const out = await o.runAttempt(p.runId, a, w, (params: any) => pushBranchImpl(shim, params));
    await db.execute("UPDATE agent_attempts SET state = 'done', outcome = ?, ended_at = ? WHERE attempt = ? AND instance = ?", JSON.stringify(out), Date.now(), n, ENGINE_INSTANCE);
  })().catch(async (e) => {
    const err = await classify(e);
    console.error(`[agent-workflow] ${p.agentId} attempt ${n} failed (${err.kind}): ${err.message.slice(0, 500)}`);
    await db.execute("UPDATE agent_attempts SET state = 'failed', error = ?, ended_at = ? WHERE attempt = ? AND instance = ?", JSON.stringify(err), Date.now(), n, ENGINE_INSTANCE).catch(() => {});
  });
  c.keepAwake(run);
  return "started";
}

const renewedAt = new Map<string, number>();

/** One look at attempt `n`, renewing the agent's driver lease (so awaits see it driven) on the way. */
async function poll(c: any, p: StartAgent, n: number, driver: string): Promise<Poll> {
  const s = await scopeOf(p.runId);
  const k = `${p.agentId}:${n}`;
  if (Date.now() - (renewedAt.get(k) ?? 0) > LEASE_MS() / 3) {
    const claim: any = await s.claimDriver({ agentId: p.agentId, driver, ttlMs: LEASE_MS() });
    renewedAt.set(k, Date.now());
    // Cancelled (or finished by someone else): settle now; the run notices too (its runner polls for a cancel).
    if (!claim.ok && ["cancelled", "done", "failed"].includes(claim.agent.status)) return { state: "ended" };
  }
  await c.db.execute(ATTEMPTS_SQL);
  const row: any = (await c.db.execute("SELECT * FROM agent_attempts WHERE attempt = ?", n))[0];
  if (!row) return { state: "lost" };
  if (row.state === "running") return row.instance === ENGINE_INSTANCE ? { state: "running" } : { state: "lost" };
  if (row.state === "done") return { state: "done", outcome: JSON.parse(row.outcome ?? "null") };
  return { state: "failed", error: JSON.parse(row.error ?? "{}") };
}

async function agentLifecycle(ctx: any): Promise<void> {
  const msg = await ctx.queue.next("wait-start", { names: ["start"] });
  const p = msg.body as StartAgent;
  const driver = `wf-${p.agentId}-e${p.epoch}`;
  const step = (name: string, run: (c: any) => Promise<any>, o: Record<string, unknown> = {}) =>
    ctx.step({ name, timeout: 120_000, maxRetries: 5, retryBackoffBase: 1000, retryBackoffMax: 30_000, retryOnTimeout: true, ...o, run });

  // Claim it, then the checks the driver made before making a VM. A paused (quota) agent sleeps to its reset.
  const prep = await step("prepare", async () => {
    const o = await ops();
    try { return await o.prepareDrive(p.runId, p.agentId, driver, LEASE_MS()); } catch (e) {
      const err = await classify(e);
      if (err.final) return { kind: "fail", error: err };
      throw e;
    }
  });
  if (prep.kind === "fail") { await step("finish-failed", async () => (await ops()).finishFailed(p.runId, p.agentId, p.epoch, prep.error)); return; }
  if (prep.kind === "end") return;
  if (prep.kind === "paused") { if (prep.until > 0) await wakeAt(ctx, step, p, prep.until); return; }

  // One flat loop, one phase per iteration (a loop nested in a loop's iteration diverges on replay in 2.3.31: the inner
  // loop resumes at its saved iteration and the outer iteration's check finds the retained earlier ones unvisited).
  // The driver's retry rules; each attempt's wait and backoff durable.
  const outcome = await ctx.loop({
    name: "drive", state: { phase: "ensure", n: 1 } as Drive,
    run: async (l: any, st: Drive) => {
      const lstep = (name: string, run: (c: any) => Promise<any>, o: Record<string, unknown> = {}) =>
        l.step({ name, timeout: 60_000, maxRetries: 5, retryBackoffBase: 1000, retryBackoffMax: 15_000, retryOnTimeout: true, ...o, run });
      const n = st.n;
      if (st.phase === "ensure") {
        const r = await l.tryStep({
          name: "ensure-machine", timeout: 15 * 60_000, maxRetries: 3, retryBackoffBase: 2000, retryBackoffMax: 30_000, retryOnTimeout: true,
          run: async () => {
            try { return await (await ops()).ensureMachine(p.runId, p.agentId, p.epoch); } catch (e) {
              const err = await classify(e);
              if (err.final) return { kind: "fail", error: err };
              throw e;
            }
          },
        });
        if (!r.ok) return Loop.continue({ phase: "failed", n, error: { kind: "error", message: String(r.failure.error?.message ?? "ensure-machine failed").slice(0, 2000), final: false } });
        if (r.value.kind === "fail") return Loop.continue({ phase: "failed", n, error: r.value.error });
        if (r.value.kind === "ended") return Loop.break({ state: "ended" } as Poll);
        return Loop.continue({ phase: "start", n });
      }
      if (st.phase === "start") {
        await lstep("start-agent", (c) => startAttempt(c, p, n));
        return Loop.continue({ phase: "watch", n });
      }
      if (st.phase === "watch") {
        const r: Poll = await lstep("poll", (c) => poll(c, p, n, driver), { maxRetries: 10 });
        if (r.state === "running") { await l.sleep("poll-wait", POLL_MS()); return Loop.continue(st); }
        // The daemon went away under the run: run it again (not a failure of the agent).
        if (r.state === "lost") { await lstep("restart-agent", (c) => startAttempt(c, p, n)); return Loop.continue(st); }
        if (r.state === "failed") return Loop.continue({ phase: "failed", n, error: r.error });
        return Loop.break(r);
      }
      // A failed attempt: recorded (DRIVE_FAILED); tried again after a durable backoff, or the agent fails.
      const again = await lstep("attempt-failed", async () => (await ops()).recordDriveFailure(p.runId, p.agentId, driver, n, st.error ?? null, MAX_ATTEMPTS));
      if (!again.retry) return Loop.break({ state: "failed", error: st.error! } as Poll);
      await l.sleep("retry-backoff", 2000 * n);
      return Loop.continue({ phase: "ensure", n: n + 1 });
    },
  });

  const settled = await step("settle", async () => {
    const o = await ops();
    if (outcome.state === "done") return o.settleAttempt(p.runId, p.agentId, p.epoch, outcome.outcome);
    if (outcome.state === "ended") return o.settleEnded(p.runId, p.agentId, p.epoch);
    return o.finishFailed(p.runId, p.agentId, p.epoch, outcome.error);
  }, { timeout: 10 * 60_000 });
  await step("trace", async () => (await ops()).recordAgentRunSpan(p.runId, p.agentId, prep.startedAt));
  if (settled?.status === "paused" && Number(settled.pausedUntil) > 0) await wakeAt(ctx, step, p, Number(settled.pausedUntil));
}

/**
 * ADR-019 §6 under the workflow: a paused agent's own workflow sleeps (durably) until the reset, then wakes it: its next
 * epoch runs in that epoch's worker, started like any agent. `wakeDue` checks it is still this pause.
 */
async function wakeAt(ctx: any, step: (name: string, run: (c: any) => Promise<any>, o?: Record<string, unknown>) => Promise<any>, p: StartAgent, until: number) {
  await ctx.sleepUntil("usage-reset", until);
  await step("wake", async () => (await scopeOf(p.runId)).wakeDue({ agentId: p.agentId, epoch: p.epoch }));
}
