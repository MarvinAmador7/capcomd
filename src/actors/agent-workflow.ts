// ADR-022 (spike, behind CAPCOMD_AGENT_WORKFLOW=1): one agent's lifecycle as a Rivet workflow inside its worker actor.
//
// With the flag on, nothing runs `capcomd agent-drive`: starting an agent (spawn, resume, an await's kick) sends a
// `start` message to the worker actor of its current epoch, whose workflow then drives it to an end:
//
//   wait-start → prepare (claim with a long lease, operator pause, env snapshot, login quota)
//   → drive loop, one phase per iteration: ensure-machine (re-claim, provision + assign) → start-agent (the run, in the
//     actor, kept awake; it sends `attempt` when it ends) → watch: wait for `attempt` (or LEASE/3) + poll,
//     [restart-agent when the run is gone] → on failure: record it, back off, try again (3 attempts, the driver's rules)
//   → settle (charge, task done, drain, finish or pause; the agent.run span) → [quota: sleepUntil(reset) → wake]
//
// Every step is durable: after a daemon or engine restart the engine wakes the actor and the workflow replays to where
// it was. The agent's run itself (the runner, a scripted agent, the push) can't be resumed half-way: an attempt whose
// run is gone (not in this process's live runs: the daemon restarted, or the actor was stopped) runs again, as a
// driver's retry did (the runner stops what the earlier run left in the VM; the push lock adopts a branch that landed).
// A step that keeps failing never leaves the agent "running": the agent fails with that error (give-up).
import { queue } from "rivetkit";
import { Loop, workflow } from "rivetkit/workflow";
import type { RawAccess } from "rivetkit/db";
import { env, withDriveEnv } from "../utils/env";
import { ENGINE_INSTANCE } from "../utils/engine-instance";
import { redactShapes } from "../agents/redact";
import { TERMINAL_AGENT } from "../primitives/policy";
import { killpoint } from "../utils/killpoint";
import { traceActions } from "../utils/tracing-simple";

export { agentWorkflowOn } from "../utils/agent-workflow-flag";

export interface StartAgent { runId: string; agentId: string; epoch: number }

/** How long the watch waits for the run's `attempt` message before it looks anyway (cancel, a lost run). */
// An integer: the workflow engine refuses a fractional timeout ("Not an integer"), e.g. a 4000 ms lease / 3.
const WATCH_MS = () => Math.ceil(Number(env("AGENT_WORKFLOW_POLL_MS") ?? Math.max(1000, Number(env("DRIVER_LEASE_MS") ?? 15_000) / 3)));
/** The workflow holds the agent's driver lease for this long, so an await never "kicks" it and a driver process
 *  (a client without the flag) can't take it over while the workflow runs it. */
const WF_LEASE_MS = 6 * 3600_000;
const MAX_ATTEMPTS = 3;
const ALL_FAILURES = ["critical", "timeout", "exhausted", "rollback"] as const;

export const ATTEMPTS_SQL = `CREATE TABLE IF NOT EXISTS agent_attempts (
  attempt INTEGER PRIMARY KEY, instance TEXT NOT NULL, state TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER,
  outcome TEXT, error TEXT, restarts INTEGER NOT NULL DEFAULT 0)`;
export const STARTS_SQL = "CREATE TABLE IF NOT EXISTS agent_workflow_start (id INTEGER PRIMARY KEY CHECK (id = 1), run_id TEXT NOT NULL, agent_id TEXT NOT NULL, epoch INTEGER NOT NULL, at INTEGER NOT NULL)";

/** The worker actor's queue and run handler, added only with the flag on (the flag off leaves the actor as it was). */
export function agentWorkflowParts() {
  return { queues: { start: queue<StartAgent>(), attempt: queue<{ n: number }>() }, run: workflow(agentLifecycle) };
}

/**
 * The worker action `startAgent`: queue the one `start` its workflow waits for. Idempotent (the first call queues it,
 * later ones only wake the actor, which resumes its workflow if a restart left it asleep).
 */
export async function queueStart(c: any, p: StartAgent): Promise<{ queued: boolean }> {
  await c.db.execute(STARTS_SQL);
  if ((await c.db.execute("SELECT 1 FROM agent_workflow_start WHERE id = 1")).length) return { queued: false };
  // Send, then remember: a crash in between costs a second `start` (consumed by nobody), never a lost one.
  await c.queue.send("start", p);
  await c.db.execute("INSERT OR IGNORE INTO agent_workflow_start (id, run_id, agent_id, epoch, at) VALUES (1, ?, ?, ?, ?)", p.runId, p.agentId, p.epoch, Date.now());
  return { queued: true };
}

/** What a failed attempt was, as stored (the driver's classification: some failures are never retried). */
interface AttemptError { kind: string; message: string; exitCode?: number; final: boolean }
type Drive = { phase: "ensure" | "start" | "watch" | "failed"; n: number; error?: AttemptError };
type Poll = { state: "running" } | { state: "lost" } | { state: "done"; outcome: unknown } | { state: "failed"; error: AttemptError } | { state: "ended" };
/** Runs alive in this process, by actor and attempt: a row "running" without one here was lost with its process or actor. */
const liveRuns = new Map<string, Promise<void>>();

const ops = () => import("../primitives/ops");
const scopeOf = async (runId: string) => (await import("../core/relay")).client().scope.getOrCreate([runId]);

/** Errors the driver never retried: a rejected sandbox login, a scripted agent's exit code, a missing env snapshot,
 *  a limit (timeout, turns, budget) and a configuration problem. */
async function classify(e: unknown): Promise<AttemptError> {
  try { return await classifyOrThrow(e); } catch { return { kind: "error", message: redactShapes(String((e as Error)?.message ?? e)).slice(0, 2000), final: false }; }
}
async function classifyOrThrow(e: unknown): Promise<AttemptError> {
  const { ScriptFailed } = await import("../subagents/driver");
  const { isBoxdAuthError } = await import("../providers/boxd-errors");
  const { EnvSnapshotMissing } = await ops();
  const kind = String((e as any)?.code ?? (e as any)?.kind ?? (e as Error)?.name ?? "error");
  const message = redactShapes(String((e as Error)?.message ?? e)).slice(0, 2000);
  const final = isBoxdAuthError(e) || e instanceof ScriptFailed || e instanceof EnvSnapshotMissing || kind === "limit" || kind === "config" || kind === "sandbox_auth";
  return { kind, message, final, ...(e instanceof ScriptFailed ? { exitCode: e.exitCode } : {}) };
}

/**
 * Run attempt `n` in the background of this actor (kept awake until it settles), recording its end in agent_attempts and
 * telling the workflow (`attempt`). Called from a step; it must not touch the step's context after the step returns, so
 * it keeps the actor's own db, key and client.
 */
async function startAttempt(c: any, p: StartAgent, n: number): Promise<"started" | "running" | "settled"> {
  const db: RawAccess = c.db;
  const key: string[] = c.key;
  const cl = c.client();
  const live = `${c.actorId}:${n}`;
  await db.execute(ATTEMPTS_SQL);
  const row: any = (await db.execute("SELECT state FROM agent_attempts WHERE attempt = ?", n))[0];
  if (row && row.state !== "running") return "settled";
  if (row && liveRuns.has(live)) return "running";
  await db.execute(`INSERT INTO agent_attempts (attempt, instance, state, started_at) VALUES (?, ?, 'running', ?)
    ON CONFLICT(attempt) DO UPDATE SET instance = excluded.instance, state = 'running', restarts = agent_attempts.restarts + 1`, n, ENGINE_INSTANCE, Date.now());
  const w = cl.worker.getOrCreate(key);
  const run = (async () => {
    let state: "done" | "failed", col: "outcome" | "error", value: unknown;
    try {
      const o = await ops();
      const a = await o.getAgentOrThrow(p.runId, p.agentId);
      const { pushBranchImpl } = await import("./worker");
      const shim = { db, key, client: () => cl };
      // Traced as the pushBranch action is (actor.worker.pushBranch, with the run's id), so its sandbox and git spans
      // land in the run's trace as they did when a driver called the action.
      const traced = traceActions("worker", { pushBranch: pushBranchImpl });
      value = await o.runAttempt(p.runId, a, w, (params: any) => traced.pushBranch(shim, params));
      state = "done"; col = "outcome";
    } catch (e) {
      value = await classify(e);
      state = "failed"; col = "error";
      console.error(`[agent-workflow] ${p.agentId} attempt ${n} failed (${(value as AttemptError).kind}): ${(value as AttemptError).message.slice(0, 500)}`);
    }
    try { await db.execute(`UPDATE agent_attempts SET state = ?, ${col} = ?, ended_at = ? WHERE attempt = ?`, state, JSON.stringify(value), Date.now(), n); }
    catch (e) { console.error(`[agent-workflow] ${p.agentId} attempt ${n}: couldn't record its end (${(e as Error)?.message ?? e}); it runs again`); }
  })().finally(() => {
    liveRuns.delete(live);
    w.send("attempt", { n }).catch(() => {}); // the watch looks now instead of at its next timeout
  });
  liveRuns.set(live, run);
  c.keepAwake(run);
  return "started";
}

/** One look at attempt `n`: ended (cancelled or finished by someone else), still running, lost, or its outcome. */
async function poll(c: any, p: StartAgent, n: number): Promise<Poll> {
  const a = await (await scopeOf(p.runId)).getAgent({ agentId: p.agentId });
  if (!a || TERMINAL_AGENT.has(a.status)) return { state: "ended" };
  await c.db.execute(ATTEMPTS_SQL);
  const row: any = (await c.db.execute("SELECT * FROM agent_attempts WHERE attempt = ?", n))[0];
  if (!row) return { state: "lost" };
  if (row.state === "running") {
    if (!liveRuns.has(`${c.actorId}:${n}`)) return { state: "lost" };
    killpoint("workflow.watch.running"); // chaos: the engine host dies mid-step, with the agent's run in flight
    return { state: "running" };
  }
  if (row.state === "done") return { state: "done", outcome: JSON.parse(row.outcome ?? "null") };
  return { state: "failed", error: JSON.parse(row.error ?? "{}") };
}

async function agentLifecycle(ctx: any): Promise<void> {
  const msg = await ctx.queue.next("wait-start", { names: ["start"] });
  const p = msg.body as StartAgent;
  const driver = `wf-${p.agentId}-e${p.epoch}`;
  // The agent's drive settings (recorded at spawn: how it runs, the driver's timings), over this host's env, for every
  // step and the run it starts. Known from prepare on (its output is history, so a replay knows them too).
  let driveEnv: Record<string, string> | null = null;
  const inEnv = (run: (c: any) => Promise<any>) => (c: any) => withDriveEnv(driveEnv, () => run(c));
  const step = (name: string, run: (c: any) => Promise<any>, o: Record<string, unknown> = {}) =>
    ctx.tryStep({ name, timeout: 120_000, maxRetries: 5, retryBackoffBase: 1000, retryBackoffMax: 30_000, retryOnTimeout: true, catch: ALL_FAILURES, ...o, run: inEnv(run) });
  const failureOf = (r: any): AttemptError => ({ kind: "error", message: String(r.failure?.error?.message ?? `${r.failure?.stepName ?? "a step"} failed`).slice(0, 2000), final: true });
  // A step that never succeeds (its retries exhausted): the agent fails with that error, never stays "running".
  const giveUp = async (err: AttemptError) => { await step("give-up", async () => (await ops()).finishFailed(p.runId, p.agentId, p.epoch, err), { maxRetries: 10 }); };

  // Claim it, then the checks the driver made before making a VM. A paused (quota) agent sleeps to its reset.
  const prep = await step("prepare", async () => {
    const o = await ops();
    const a = await o.getAgentOrThrow(p.runId, p.agentId);
    try { return { ...(await withDriveEnv(a.driveEnv, () => o.prepareDrive(p.runId, p.agentId, driver, WF_LEASE_MS))), driveEnv: a.driveEnv }; } catch (e) {
      const err = await classify(e);
      if (err.final) return { kind: "fail", error: err, driveEnv: a.driveEnv };
      throw e;
    }
  });
  if (!prep.ok) return giveUp(failureOf(prep));
  driveEnv = prep.value.driveEnv ?? null;
  if (prep.value.kind === "end") return;
  if (prep.value.kind === "paused") { if (prep.value.until > 0) await wakeAt(ctx, step, p, prep.value.until); return; }
  const startedAt: number = prep.value.startedAt ?? Date.now();

  // One flat loop, one phase per iteration (a loop nested in a loop's iteration, or in a try block, diverges on replay
  // in 2.3.31: the inner loop resumes at its saved iteration and the enclosing check finds the retained earlier ones
  // unvisited). The driver's retry rules; each wait and backoff durable.
  const outcome: Poll = prep.value.kind === "fail" ? { state: "failed", error: prep.value.error } : await ctx.loop({
    name: "drive", state: { phase: "ensure", n: 1 } as Drive,
    run: async (l: any, st: Drive) => {
      const lstep = (name: string, run: (c: any) => Promise<any>, o: Record<string, unknown> = {}) =>
        l.tryStep({ name, timeout: 60_000, maxRetries: 5, retryBackoffBase: 1000, retryBackoffMax: 15_000, retryOnTimeout: true, catch: ALL_FAILURES, ...o, run: inEnv(run) });
      const n = st.n;
      const failed = (r: any) => Loop.continue({ phase: "failed", n, error: { ...failureOf(r), final: false } });
      if (st.phase === "ensure") {
        const r = await lstep("ensure-machine", async () => {
          try {
            // (Re)claim: a recorded failure releases the lease.
            const claim: any = await (await scopeOf(p.runId)).claimDriver({ agentId: p.agentId, driver, ttlMs: WF_LEASE_MS });
            if (!claim.ok) return { kind: "ended" };
            return await (await ops()).ensureMachine(p.runId, p.agentId, p.epoch);
          } catch (e) {
            const err = await classify(e);
            if (err.final) return { kind: "fail", error: err };
            throw e;
          }
        }, { timeout: 15 * 60_000, maxRetries: 3, retryBackoffBase: 2000, retryBackoffMax: 30_000 });
        if (!r.ok) return failed(r);
        if (r.value.kind === "fail") return Loop.continue({ phase: "failed", n, error: r.value.error });
        if (r.value.kind === "ended") return Loop.break({ state: "ended" } as Poll);
        return Loop.continue({ phase: "start", n });
      }
      if (st.phase === "start") {
        const r = await lstep("start-agent", (c) => startAttempt(c, p, n));
        return r.ok ? Loop.continue({ phase: "watch", n }) : failed(r);
      }
      if (st.phase === "watch") {
        // Woken by the run's `attempt` message when it ends; else it looks every WATCH_MS (a cancel, a lost run).
        await l.queue.nextBatch("attempt-wait", { names: ["attempt"], count: 1, timeout: withDriveEnv(driveEnv, WATCH_MS) });
        const r = await lstep("poll", (c) => poll(c, p, n), { maxRetries: 10 });
        if (!r.ok) return failed(r);
        const v: Poll = r.value;
        if (v.state === "running") return Loop.continue(st);
        // The run is gone (the daemon or the actor went away under it): run it again, not a failure of the agent.
        if (v.state === "lost") { const s2 = await lstep("restart-agent", (c) => startAttempt(c, p, n)); return s2.ok ? Loop.continue(st) : failed(s2); }
        if (v.state === "failed") return Loop.continue({ phase: "failed", n, error: v.error });
        return Loop.break(v);
      }
      // A failed attempt: recorded (DRIVE_FAILED); tried again after a durable backoff, or the agent fails.
      const again = await lstep("attempt-failed", async () => (await ops()).recordDriveFailure(p.runId, p.agentId, driver, n, st.error ?? null, MAX_ATTEMPTS));
      if (!again.ok || !again.value.retry) return Loop.break({ state: "failed", error: st.error! } as Poll);
      await l.sleep("retry-backoff", 2000 * n);
      return Loop.continue({ phase: "ensure", n: n + 1 });
    },
  });
  if (prep.value.kind === "fail") await step("attempt-failed", async () => (await ops()).recordDriveFailure(p.runId, p.agentId, driver, 1, prep.value.error, MAX_ATTEMPTS));

  const settled = await step("settle", async () => {
    const o = await ops();
    const a = outcome.state === "done" ? await o.settleAttempt(p.runId, p.agentId, p.epoch, outcome.outcome as any)
      : outcome.state === "failed" ? await o.finishFailed(p.runId, p.agentId, p.epoch, outcome.error)
      : await o.settleEnded(p.runId, p.agentId, p.epoch);
    await o.recordAgentRunSpan(p.runId, p.agentId, startedAt).catch(() => {});
    return { status: a.status, pausedUntil: a.pausedUntil ?? null };
  }, { timeout: 10 * 60_000 });
  if (!settled.ok) return giveUp(failureOf(settled));
  if (settled.value.status === "paused" && Number(settled.value.pausedUntil) > 0) await wakeAt(ctx, step, p, Number(settled.value.pausedUntil));
}

/**
 * ADR-019 §6 under the workflow: a paused agent's own workflow sleeps (durably) until the reset, then wakes it: its next
 * epoch runs in that epoch's worker, started like any agent. `wakeDue` checks it is still this pause.
 */
async function wakeAt(ctx: any, step: (name: string, run: (c: any) => Promise<any>, o?: Record<string, unknown>) => Promise<any>, p: StartAgent, until: number) {
  await ctx.sleepUntil("usage-reset", Math.ceil(until));
  // (The scope's own wakeDue alarm is the backstop: whichever comes first resumes it, the other finds it resumed.)
  await step("wake", async () => (await scopeOf(p.runId)).wakeDue({ agentId: p.agentId, epoch: p.epoch }));
}
