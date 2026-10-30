// ADR-022: one agent's lifecycle as a Rivet workflow inside its worker actor (the default; CAPCOMD_AGENT_WORKFLOW=0 on
// the engine host brings back `capcomd agent-drive` processes for one release).
//
// Nothing runs `capcomd agent-drive`: starting an agent (spawn, resume, an await's kick) sends a
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

/**
 * How long the watch waits for the run's `attempt` message before it looks anyway. The run sends it when it ends (a
 * cancel or the operator's pause ends it too), so this bounds only what nothing tells it: a run lost with its engine
 * host. After a daemon restart the worker sleeps until this wait's deadline (its alarm), so a lost run is found and
 * run again within one watch interval of the restart. Every look writes workflow history
 * and its engine storage (ADR-022 "Measurements": at 5 s, four times the driver path's writes; at 60 s, about the
 * same), hence a long default. An integer: the workflow engine refuses a fractional timeout.
 */
const WATCH_MS = () => Math.ceil(Number(env("AGENT_WORKFLOW_POLL_MS") ?? 60_000));
/** The workflow holds the agent's driver lease for this long, so an await never "kicks" it and a driver process
 *  (a client without the flag) can't take it over while the workflow runs it. */
const WF_LEASE_MS = 6 * 3600_000;
const MAX_ATTEMPTS = 3;
/**
 * How far ahead a running step keeps its worker's wake alarm. When the engine host dies, the engine brings a worker back
 * only at its next alarm or on a call to it (rivet's crash policy: sleep). The workflow arms an alarm only to wait (the
 * watch, a backoff, the usage-limit sleep): a step arms none, and the workflow's long lease means no await kicks it. A
 * host that died inside a step (provisioning, starting the run, settling) left the agent "running" until the worker's
 * next alarm, its machine's reap an hour later. So each step keeps a no-op alarm this far ahead while it runs: after a
 * restart the worker wakes within this (at once if it's past) and its workflow runs the step again.
 *
 * The wake must never outlive its step. An actor has one alarm, and in rivetkit 2.3.31 the workflow sets it directly
 * for its waits while every change to the actor's schedule (an event added, fired or cancelled) sets it to the earliest
 * scheduled event. A wake left to fire during the watch replaced the watch's alarm with the machine's reap (an hour
 * out): a host killed after that left the worker asleep (live e2e, 2026-10-30). So a step cancels its wakes before it
 * returns, before the workflow arms its next wait.
 */
const STEP_WAKE_MS = 10_000;
/** Steps that need no wake of their own: the watch's look follows its timed wait, whose alarm covers it. */
const NO_WAKE = new Set(["poll", "look"]);
const ALL_FAILURES = ["critical", "timeout", "exhausted", "rollback"] as const;

export const ATTEMPTS_SQL = `CREATE TABLE IF NOT EXISTS agent_attempts (
  attempt INTEGER PRIMARY KEY, instance TEXT NOT NULL, state TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER,
  outcome TEXT, error TEXT, restarts INTEGER NOT NULL DEFAULT 0)`;
export const STARTS_SQL = "CREATE TABLE IF NOT EXISTS agent_workflow_start (id INTEGER PRIMARY KEY CHECK (id = 1), run_id TEXT NOT NULL, agent_id TEXT NOT NULL, epoch INTEGER NOT NULL, at INTEGER NOT NULL)";

/** The worker actor's queue and run handler, added only with the flag on (the flag off leaves the actor as it was). */
export function agentWorkflowParts() {
  return {
    queues: { start: queue<StartAgent>(), attempt: queue<{ n: number }>() },
    run: workflow(agentLifecycle)
  };
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

/** The worker actions behind the step wake (STEP_WAKE_MS); untraced: bookkeeping, not work. */
export const stepWakeActions = {
  /** Arm a wake alarm `ms` ahead (a step calls it on its own worker as it starts, then every half of that). */
  async armStepWake(c: any, p: { ms?: number }) {
    const id = await c.schedule.after(Math.min(Math.max(Number(p?.ms) || STEP_WAKE_MS, 1000), 60_000), "stepWake", {});
    return { id };
  },
  /** Cancel every pending step wake (a step calls it as it ends: see STEP_WAKE_MS). */
  async disarmStepWakes(c: any, _p: Record<string, never>) {
    let n = 0;
    for (const e of (await c.schedule.list()) as Array<{ id: string; action: string }>) if (e.action === "stepWake") { await c.schedule.cancel(e.id); n++; }
    return { cancelled: n };
  },
  /** The alarm's action: nothing. Waking the worker is the point: its workflow resumes when the actor starts. */
  async stepWake(_c: any, _p: Record<string, never>) { return { ok: true }; },
};

const within = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<void>((r) => setTimeout(r, ms))]);

/**
 * Run a step body with its worker's wake alarm armed (STEP_WAKE_MS ahead) until it ends, then cancel the wakes before
 * the step returns (the workflow's next wait sets the actor's alarm after that). Never fails the step.
 */
async function withStepWake<T>(c: any, run: () => Promise<T>): Promise<T> {
  let self: any = null;
  try { self = c.client().worker.getOrCreate(c.key); } catch {}
  if (!self) return run();
  const inFlight = new Set<Promise<unknown>>();
  const arm = () => { const p = self.armStepWake({ ms: STEP_WAKE_MS }).catch(() => {}); inFlight.add(p); void p.finally(() => inFlight.delete(p)); return p; };
  // Armed before the work (bounded: a slow engine never holds the step up).
  await within(arm(), 2000);
  const t = setInterval(arm, STEP_WAKE_MS / 2);
  try { return await run(); } finally {
    clearInterval(t);
    await within(Promise.all([...inFlight]), 5000);
    // A wake left pending would replace the workflow's next alarm when it fires: the cancel is tried twice.
    for (let i = 0; i < 2; i++) if (await within(self.disarmStepWakes({}).then(() => true, () => false), 5000)) break;
  }
}

/** ADR-022 measurements: the workflow's stored history (rows, bytes) and the actor database's size. */
export async function workflowStats(c: any): Promise<{ rows: number; bytes: number; dbBytes: number; looks: number }> {
  const h: any = (await c.db.execute("SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(key) + LENGTH(value)), 0) AS b FROM _rivet_wf_kv").catch(() => [{ n: 0, b: 0 }]))[0];
  const pc: any = (await c.db.execute("PRAGMA page_count").catch(() => [{}]))[0];
  const ps: any = (await c.db.execute("PRAGMA page_size").catch(() => [{}]))[0];
  return { looks: looks.get(c.actorId) ?? 0, rows: Number(h?.n ?? 0), bytes: Number(h?.b ?? 0), dbBytes: Number(Object.values(pc ?? {})[0] ?? 0) * Number(Object.values(ps ?? {})[0] ?? 0) };
}

/** What a failed attempt was, as stored (the driver's classification: some failures are never retried). `transient`:
 *  the sandbox provider didn't answer (an outage): tried again without counting against the attempts. */
interface AttemptError { kind: string; message: string; exitCode?: number; final: boolean; transient?: boolean }
/** `outages`: attempts so far that failed only because the provider didn't answer (not counted as attempts). */
type Drive = { phase: "ensure" | "start" | "watch" | "failed"; n: number; error?: AttemptError; outages?: number };
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
  const { isBoxdAuthError, isSandboxUnreachable, isTransientSandboxError } = await import("../providers/boxd-errors");
  const { EnvSnapshotMissing } = await ops();
  const kind = String((e as any)?.code ?? (e as any)?.kind ?? (e as Error)?.name ?? "error");
  const message = redactShapes(String((e as Error)?.message ?? e)).slice(0, 2000);
  // The provider didn't answer for the whole outage window: the waiting is over, another attempt would wait again.
  const final = isBoxdAuthError(e) || e instanceof ScriptFailed || e instanceof EnvSnapshotMissing || kind === "limit" || kind === "config" || kind === "sandbox_auth" || isSandboxUnreachable(e);
  const transient = !final && isTransientSandboxError(e);
  return { kind, message, final, ...(transient ? { transient: true } : {}), ...(e instanceof ScriptFailed ? { exitCode: e.exitCode } : {}) };
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
  killpoint("workflow.start_agent.mid"); // chaos/tests: the engine host dies inside a step (no wait, so no alarm of its own)
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
      const shim = { db, key, client: () => cl };
      const push = await tracedPush();
      value = await o.runAttempt(p.runId, a, w, (params: any) => push(shim, params));
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

/**
 * The worker's push, traced as the pushBranch action is (actor.worker.pushBranch, with the run's id), so its sandbox and
 * git spans land in the run's trace as they did when a driver called the action. (./worker imports this module.)
 */
let pushTraced: ((c: any, params: any) => Promise<any>) | null = null;
async function tracedPush() {
  pushTraced ??= traceActions("worker", { pushBranch: (await import("./worker")).pushBranchImpl }).pushBranch;
  return pushTraced;
}

/** One look at attempt `n`: ended (cancelled or finished by someone else), still running, lost, or its outcome. */
/** Looks per worker actor in this process (measurements: workflowStats). */
const looks = new Map<string, number>();

async function poll(c: any, p: StartAgent, n: number): Promise<Poll> {
  looks.set(c.actorId, (looks.get(c.actorId) ?? 0) + 1);
  const a = await (await scopeOf(p.runId)).getAgent({ agentId: p.agentId });
  if (!a || TERMINAL_AGENT.has(a.status)) return { state: "ended" };
  await c.db.execute(ATTEMPTS_SQL);
  const row: any = (await c.db.execute("SELECT * FROM agent_attempts WHERE attempt = ?", n))[0];
  if (!row) return { state: "lost" };
  if (row.state === "running") {
    if (!liveRuns.has(`${c.actorId}:${n}`)) return { state: "lost" };
    // Chaos: the engine host dies mid-step, with the agent's run in flight and its push lock held (mid-push).
    if (process.env.CAPCOMD_KILLPOINT && (await c.db.execute("SELECT 1 FROM push_locks WHERE state = 'running' AND until > ?", Date.now()).catch(() => [])).length) killpoint("workflow.watch.running");
    return { state: "running" };
  }
  if (row.state === "done") return { state: "done", outcome: JSON.parse(row.outcome ?? "null") };
  return { state: "failed", error: JSON.parse(row.error ?? "{}") };
}

/**
 * The workflow's shape version (ADR-022 "Changing the workflow"). History is matched by entry names, so an agent in
 * flight when capcomd is upgraded replays its recorded entries against the new code. Every change to the order, names
 * or kinds of entries is gated: bump the version here and branch on what `getVersion` returns (an agent that had
 * already run past the gate under older code gets the version it ran with, 1 for code before any gate; a new one gets
 * the latest), and mark an entry the new code no longer makes with `ctx.removed(name, kind)`. LIFECYCLE gates the
 * top level; DRIVE gates one iteration of the drive loop (each iteration resolves its own).
 */
// Test only (workflow-upgrade.test.ts): the upgrade drill's "next version". Remove it (and its branches) with the
// first real shape bump, which the drill then exercises instead. "1": shape 2 behind the gates; "ungated":
// shape 2 for everyone, as a change made without the rule would be (the drill's control: it must diverge).
const DRILL = () => env("WORKFLOW_DRILL");
const LIFECYCLE_SHAPE = () => (DRILL() ? 2 : 1);
const DRIVE_SHAPE = () => (DRILL() ? 2 : 1);
const gate = async (ctx: any, name: string, latest: number) => (DRILL() === "ungated" ? latest : ctx.getVersion(name, latest));

async function agentLifecycle(ctx: any): Promise<void> {
  const msg = await ctx.queue.next("wait-start", { names: ["start"] });
  const p = msg.body as StartAgent;
  const shape: number = await gate(ctx, "lifecycle-shape", LIFECYCLE_SHAPE());
  const driver = `wf-${p.agentId}-e${p.epoch}`;
  // The agent's drive settings (recorded at spawn: how it runs, the driver's timings), over this host's env, for every
  // step and the run it starts. Read by the first step (its output is history, so a replay knows them too).
  let driveEnv: Record<string, string> | null = null;
  // Each step runs with the agent's settings and (but the watch's look) its worker's wake alarm armed (STEP_WAKE_MS).
  const inEnv = (name: string, run: (c: any) => Promise<any>) => (c: any) => withDriveEnv(driveEnv, () => (NO_WAKE.has(name) ? run(c) : withStepWake(c, () => run(c))));
  const settings = await ctx.tryStep({ name: "settings", timeout: 60_000, maxRetries: 10, retryBackoffBase: 1000, retryBackoffMax: 30_000, retryOnTimeout: true, catch: ALL_FAILURES,
    run: (c: any) => withStepWake(c, async () => { const a = await (await ops()).getAgentOrThrow(p.runId, p.agentId); return { driveEnv: a.driveEnv, watchMs: withDriveEnv(a.driveEnv, WATCH_MS) }; }) });
  driveEnv = settings.ok ? settings.value.driveEnv : null;
  const watchMs: number = settings.ok ? settings.value.watchMs : WATCH_MS();
  const step = (name: string, run: (c: any) => Promise<any>, o: Record<string, unknown> = {}) =>
    ctx.tryStep({ name, timeout: 120_000, maxRetries: 5, retryBackoffBase: 1000, retryBackoffMax: 30_000, retryOnTimeout: true, catch: ALL_FAILURES, ...o, run: inEnv(name, run) });
  const failureOf = (r: any): AttemptError => ({ kind: "error", message: String(r.failure?.error?.message ?? `${r.failure?.stepName ?? "a step"} failed`).slice(0, 2000), final: true });
  // A step that never succeeds (its retries exhausted): the agent fails with that error, never stays "running".
  const giveUp = async (err: AttemptError) => { await step("give-up", async () => (await ops()).finishFailed(p.runId, p.agentId, p.epoch, err), { maxRetries: 10 }); };

  // Claim it, then the checks the driver made before making a VM. A paused (quota) agent sleeps to its reset.
  const prep = await step("prepare", async () => {
    const o = await ops();
    try { return await o.prepareDrive(p.runId, p.agentId, driver, WF_LEASE_MS); } catch (e) {
      const err = await classify(e);
      if (err.final) return { kind: "fail", error: err };
      throw e;
    }
  });
  if (!prep.ok) return giveUp(failureOf(prep));
  if (prep.value.kind === "end") return;
  if (prep.value.kind === "paused") { if (prep.value.until > 0) await wakeAt(ctx, step, p, prep.value.until); return; }
  // The upgrade drill's version 2 adds a step here; agents that started under version 1 never see it.
  if (shape >= 2) await step("drill-v2", async () => (await scopeOf(p.runId)).appendLog({ agentId: p.agentId, stream: "workflow", lines: ["workflow shape 2"] }));
  const startedAt: number = prep.value.startedAt ?? Date.now();

  // One flat loop, one phase per iteration (a loop nested in a loop's iteration, or in a try block, diverges on replay
  // in 2.3.31: the inner loop resumes at its saved iteration and the enclosing check finds the retained earlier ones
  // unvisited). The driver's retry rules; each wait and backoff durable.
  const outcome: Poll = prep.value.kind === "fail" ? { state: "failed", error: prep.value.error } : await ctx.loop({
    name: "drive", state: { phase: "ensure", n: 1 } as Drive,
    run: async (l: any, st: Drive) => {
      const lstep = (name: string, run: (c: any) => Promise<any>, o: Record<string, unknown> = {}) =>
        l.tryStep({ name, timeout: 60_000, maxRetries: 5, retryBackoffBase: 1000, retryBackoffMax: 15_000, retryOnTimeout: true, catch: ALL_FAILURES, ...o, run: inEnv(name, run) });
      const n = st.n;
      const iterShape: number = await gate(l, "drive-shape", DRIVE_SHAPE());
      // The upgrade drill's version 2 of an iteration: one more (no-op) step before each phase, and the watch's entries
      // renamed (an iteration that recorded "attempt-wait"/"poll" under shape 1 must replay those names).
      if (iterShape >= 2) await lstep("drill-iteration-v2", async () => ({ phase: st.phase }));
      const outages = st.outages ?? 0;
      const failed = (r: any) => Loop.continue({ phase: "failed", n, outages, error: { ...failureOf(r), final: false } });
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
        if (r.value.kind === "fail") return Loop.continue({ phase: "failed", n, outages, error: r.value.error });
        if (r.value.kind === "ended") return Loop.break({ state: "ended" } as Poll);
        return Loop.continue({ phase: "start", n, outages });
      }
      if (st.phase === "start") {
        const r = await lstep("start-agent", (c) => startAttempt(c, p, n));
        return r.ok ? Loop.continue({ phase: "watch", n, outages }) : failed(r);
      }
      if (st.phase === "watch") {
        // Woken by the run's `attempt` message when it ends; else it looks every WATCH_MS (a cancel, a lost run).
        await l.queue.nextBatch(iterShape >= 2 ? "attempt-wait-2" : "attempt-wait", { names: ["attempt"], count: 1, timeout: watchMs });
        const r = await lstep(iterShape >= 2 ? "look" : "poll", (c) => poll(c, p, n), { maxRetries: 10 });
        if (!r.ok) return failed(r);
        const v: Poll = r.value;
        if (v.state === "running") return Loop.continue(st);
        // The run is gone (the daemon or the actor went away under it): run it again, not a failure of the agent.
        if (v.state === "lost") { const s2 = await lstep("restart-agent", (c) => startAttempt(c, p, n)); return s2.ok ? Loop.continue(st) : failed(s2); }
        if (v.state === "failed") return Loop.continue({ phase: "failed", n, outages, error: v.error });
        return Loop.break(v);
      }
      // A failed attempt: recorded (DRIVE_FAILED); tried again after a durable backoff, or the agent fails. One the
      // sandbox provider's outage caused isn't counted: the next attempt's machine calls wait for the provider.
      const again = await lstep("attempt-failed", async () => (await ops()).recordDriveFailure(p.runId, p.agentId, driver, n, st.error ?? null, MAX_ATTEMPTS, { outages }));
      if (!again.ok || !again.value.retry) return Loop.break({ state: "failed", error: st.error! } as Poll);
      await l.sleep("retry-backoff", 2000 * Math.min(n, 5));
      return Loop.continue({ phase: "ensure", n: n + 1, outages: outages + (again.value.outage ? 1 : 0) });
    },
  });
  if (prep.value.kind === "fail") await step("attempt-failed", async () => (await ops()).recordDriveFailure(p.runId, p.agentId, driver, 1, prep.value.error, MAX_ATTEMPTS));

  const settled = await step("settle", async (c) => {
    const o = await ops();
    const a = outcome.state === "done" ? await o.settleAttempt(p.runId, p.agentId, p.epoch, outcome.outcome as any)
      : outcome.state === "failed" ? await o.finishFailed(p.runId, p.agentId, p.epoch, outcome.error)
      : await o.settleEnded(p.runId, p.agentId, p.epoch);
    await o.recordAgentRunSpan(p.runId, p.agentId, startedAt).catch(() => {});
    looks.delete(c.actorId);
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
