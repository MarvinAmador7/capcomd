import { readFileSync } from "fs";
import { VM_CLI_SOURCE } from "../utils/assets";
import { redactShapes } from "../agents/redact";
import type { RawAccess } from "rivetkit/db";
import { traceActions } from "../utils/tracing-simple";
import { actor, UserError } from "rivetkit";
import { isBoxdAuthError, isSandboxUnreachable, isTransientSandboxError, SandboxError } from "../providers/boxd-errors";
import { backoffMs, minutes, withOutageListener, type Outage } from "../providers/resilient";
import { db } from "rivetkit/db";
import { workerMachine, type WorkerContext } from "../machines/worker";
import { initialTransition, transition } from "xstate";
import {
  setupLifecycleTables,
  transitionLifecycle,
  getLifecycle,
} from "../utils/lifecycle";
import { produceFakeWork } from "../merge/fakework";
import { killpoint } from "../utils/killpoint";
import { getDependencies, providerForRun, providerNamed } from "../dependencies";
import { runIdleLifetime, withSandbox } from "../providers/run-sandbox";
import { reportMachineDeleted } from "../providers/machine-audit";
import { forgetMachine, machineNameFor, recordAgentMachine } from "../providers/machines";
import { sandboxName } from "../providers/registry";
import { agentFromEnv, isRealAgent, loadAgentConfig } from "../agents/config";
import { runAgent, stoppedAt } from "../agents/runner";
import { activityReporter } from "../agents/activity";
import { itemWriter } from "../agents/thread-store";
import { heartbeatEveryMs } from "../subagents/results";
import { adapterFor } from "../agents/adapters";
import type { AttachedSkill } from "../agents/skills";
import { resolveEnvSnapshot } from "../env/resolve";
import { profileFor } from "../auth/profiles";
import { effectiveAgentRecord } from "../agents/profiles";
import { ENGINE_INSTANCE } from "../utils/engine-instance";
import { agentWorkflowOn, agentWorkflowParts, queueStart, workflowStats, type StartAgent } from "./agent-workflow";

const LEGACY_EGRESS = ["github.com", "registry.npmjs.org"];

// Push-in-progress lock (ADR-016): one persisted lock per push idempotency key. The action that
// holds it renews it while the agent runs. A caller that finds a live lock (e.g. a takeover driver
// whose predecessor died mid-push) waits for that push instead of starting a second one. A lock
// from a dead engine process (other instance id) or one past its lease can be taken over, and
// the new holder first checks the remote branch and adopts a push that already landed.
const PUSH_LOCK_MS = () => Number(process.env.CAPCOMD_PUSH_LOCK_MS ?? 30_000);
const PUSH_LOCKS_SQL = `CREATE TABLE IF NOT EXISTS push_locks (
  idem_key TEXT PRIMARY KEY, holder TEXT NOT NULL, instance TEXT NOT NULL, until INTEGER NOT NULL,
  attempts INTEGER NOT NULL, state TEXT NOT NULL, adopted INTEGER NOT NULL DEFAULT 0, sha TEXT, updated_at INTEGER NOT NULL)`;

// ADR-021 §2: a worker's VM lives for the run's idle machine lifetime (ttlMs), as a lease: while its agent runs, the
// runner renews the VM's delete deadline every 10 minutes and the worker records the new deadline here, so the reap
// alarm (createdAt + ttlMs) doesn't take a machine whose agent is still working.
const WORKER_LEASE_SQL = "CREATE TABLE IF NOT EXISTS worker_lease (worker_id TEXT PRIMARY KEY, until INTEGER NOT NULL)";
async function renewWorkerLease(db: RawAccess, workerId: string, until: number): Promise<void> {
  await db.execute(WORKER_LEASE_SQL);
  await db.execute("INSERT INTO worker_lease (worker_id, until) VALUES (?, ?) ON CONFLICT(worker_id) DO UPDATE SET until = MAX(worker_lease.until, excluded.until)", workerId, until);
}
/** When the worker's VM is due to be reaped: its lifetime after creation, or after its last renewal if later. */
async function workerDeadline(db: RawAccess, workerId: string, ctx: Record<string, unknown>): Promise<number> {
  const made = Number(ctx.createdAt ?? 0) + Number(ctx.ttlMs ?? 3_600_000);
  try {
    await db.execute(WORKER_LEASE_SQL);
    const rows = await db.execute("SELECT until FROM worker_lease WHERE worker_id = ?", workerId);
    return Math.max(made, Number(rows[0]?.until ?? 0));
  } catch { return made; }
}

async function remoteBranchSha(remote: string, branch: string): Promise<string | null> {
  const p = Bun.spawn(["git", "ls-remote", remote, `refs/heads/${branch}`], { stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  if (code !== 0) throw new Error(`git ls-remote ${branch} failed (exit ${code})`);
  const sha = out.trim().split(/\s+/)[0];
  return sha && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}
/**
 * This worker's agent, resolved once per action: its kind and, for a real agent, its config, the VM's egress and the
 * snapshot it boots from (a plan login's when it has one, else the `capcomd env build` snapshot, else the default image).
 * `pinned`: the spec recorded when the agent was spawned (the scope's agent record), which wins over the profile by
 * name: this process (the daemon) need not see the project's agents file, and its own may define the name otherwise or
 * not at all. `source`: the env as the run sees it (its own sandbox, if it has one: snapshots and plan logins are per
 * sandbox). A problem here is configuration (an unknown or invalid profile, no credentials): it crosses the actor
 * boundary as a typed error with its message, not rivetkit's opaque "internal error".
 */
function agentSetup(profile: string | undefined, pinned: unknown, source: Record<string, string | undefined>) {
  try {
    const kind = agentFromEnv(source, profile, pinned);
    if (!isRealAgent(kind)) return { kind, config: null, egressAllow: LEGACY_EGRESS, snapshot: {} as { fromSnapshot?: string }, record: null };
    const config = loadAgentConfig(source, profile, pinned);
    let snapshot: { fromSnapshot?: string } = {};
    if (config.credentialMode === "subscription") {
      const prof = profileFor(kind, source);
      if (prof?.snapshot) snapshot = { fromSnapshot: prof.snapshot };
    }
    if (!snapshot.fromSnapshot) { const snap = resolveEnvSnapshot(source); if (snap) snapshot = { fromSnapshot: snap }; }
    return { kind, config, egressAllow: config.egress, snapshot, record: effectiveAgentRecord(profile, source, pinned) };
  } catch (e) {
    throw configError(e);
  }
}

/** A configuration problem as an error rivetkit passes on (code "config", the redacted message); never retried. */
export function configError(e: unknown): UserError {
  if (e instanceof UserError) return e;
  return new UserError(redactShapes(String((e as Error)?.message ?? e)).slice(0, 2000), { code: "config", metadata: { kind: "config", retryable: false } });
}


/** The notice an agent shows while it waits for its sandbox provider to answer again (cleared when it does). */
export const OUTAGE_NOTICE = "sandbox_outage";
/**
 * While a provider call made for this agent waits out an outage (src/providers/resilient.ts), the agent shows it: a
 * notice like the stuck ones (ADR-019 §2), cleared once the provider answers. Only for spawned agents (agt-…).
 */
function outageNotice(client: () => any, runId: string | undefined, agentId: string): (o: Outage | null) => void {
  if (!runId || !agentId.startsWith("agt-")) return () => {};
  const scope = () => client().scope.getOrCreate([runId]);
  return (o) => {
    const notice = o ? { kind: OUTAGE_NOTICE, detail: `the sandbox provider (${o.provider}) hasn't answered since ${new Date(o.since).toISOString().slice(11, 19)} UTC (${o.what}: ${o.error.slice(0, 120)}); waiting up to ${minutes(o.windowMs)} for it` } : null;
    Promise.resolve().then(() => scope().notice({ agentId, notice, ...(o ? {} : { only: OUTAGE_NOTICE }) })).catch(() => {});
  };
}

/** A sandbox error as one rivetkit passes on (plain errors are masked as "internal error"): its kind as the code. */
function sandboxUserError(error: unknown): unknown {
  if (error instanceof UserError || !(error instanceof SandboxError)) return error;
  const retryable = isTransientSandboxError(error) || isSandboxUnreachable(error);
  return new UserError(redactShapes(error.message).slice(0, 2000), { code: error.kind, metadata: { kind: error.kind, retryable } });
}

/** How often, and for how long, a destroy the provider didn't answer is tried again (the worker's own alarm). */
const DRAIN_RETRIES = 60;
const DRAIN_RETRY_MAX_MS = 5 * 60_000;

/**
 * ADR-021 §3: this capcomd's record of the VM a worker is about to make (the machines ledger), written before
 * `provider.ensure` so the resources route knows the machine is capcomd's own; removed once the worker destroyed it.
 * Never throws and never blocks provisioning: a machine whose record couldn't be written is just never listed.
 */
function recordWorkerVm(c: any, o: { idemKey: string; sandbox: string | null | undefined; runId: string | undefined; workerId: string; ttlSeconds: number }): void {
  try {
    const key: string[] = Array.isArray(c?.key) ? c.key.map(String) : [];
    const runId = o.runId ?? key[0];
    if (!runId || !key.length) return;
    let place: string | undefined = o.sandbox ?? undefined;
    if (!place) try { place = sandboxName(); } catch { /* unknown CAPCOMD_SANDBOX: recorded as such */ }
    recordAgentMachine({ idemKey: o.idemKey, sandbox: place, runId, agentId: o.workerId, workerKey: key, ttlSeconds: o.ttlSeconds });
  } catch { /* best effort */ }
}

// Shared by drainWorker, reap and the TTL alarm. Idempotent and resumable. `cause`: why the machine goes, for the
// daemon's audit (sandbox.resource_deleted): its agent ended (run_ended), or its idle lifetime ran out.
// A destroy the provider didn't answer (an outage) doesn't fail the drain: the worker stays "draining" and its own alarm
// (`retryDrain`) tries again with backoff until the machine is gone; the machines ledger keeps its record meanwhile.
async function drainWorkerImpl(c: any, workerId: string, cause: "run_ended" | "idle_lifetime" = "run_ended", retry = 0): Promise<{ destroyed: boolean; retrying?: boolean }> {
      const workerLife = await getLifecycle(c.db, workerId);
      if (!workerLife) return { destroyed: false };

      const workerContext: WorkerContext & { sandbox?: string } = JSON.parse(workerLife.context);
      // The VM lives on the sandbox it was made on (the run's own, recorded at provisioning), else the daemon's.
      const provider = providerNamed(workerContext.sandbox);
      const workerSnapshot = workerMachine.resolveState({
        value: workerLife.state,
        context: workerContext,
      });

      const drainEvent = { type: "DRAIN" as const };

      // Resume a drain that crashed after DRAIN but before VM_DESTROYED.
      const resuming = workerLife.state === "draining";
      if (!resuming && !workerSnapshot.can(drainEvent)) return { destroyed: workerLife.state === "destroyed" };

      const [drainSnapshot] = resuming
        ? [workerSnapshot]
        : transition(workerMachine, workerSnapshot, drainEvent);

      if (!resuming) await c.db.transaction(async (tx: RawAccess) => {
        await transitionLifecycle(
          tx,
          workerId,
          "worker",
          drainSnapshot.value as string,
          drainSnapshot.context,
          drainEvent,
          `worker-${workerId}-drain-${Date.now()}`
        );
      }, { name: "drain" });

      if (workerContext.vmId) {
        try {
          await provider.destroy(workerContext.vmId);
        } catch (e) {
          if (!(isTransientSandboxError(e) || isSandboxUnreachable(e)) || !c.schedule) throw e;
          if (retry >= DRAIN_RETRIES) {
            console.error(`[worker] ${workerId}: gave up destroying ${workerContext.vmId} after ${retry} tries (${(e as Error)?.message ?? e}); its idle lifetime deletes it`);
            return { destroyed: false };
          }
          await c.schedule.at(Date.now() + backoffMs(retry, 5000, DRAIN_RETRY_MAX_MS), "retryDrain", { workerId, cause, retry: retry + 1 });
          return { destroyed: false, retrying: true };
        }
        // Audit (ADR-021 §5): the machine by its name, as the resources route lists it.
        const idemKey = (workerContext as { idemKey?: unknown }).idemKey;
        let place: string | undefined = workerContext.sandbox;
        if (!place) try { place = sandboxName(); } catch { /* unknown CAPCOMD_SANDBOX */ }
        if (typeof idemKey === "string" && idemKey) {
          reportMachineDeleted(place, machineNameFor(idemKey), cause);
          // Destroyed (or already gone: destroy tolerates that): no longer a machine of capcomd's.
          forgetMachine(machineNameFor(idemKey));
        }

        const destroyEvent = { type: "VM_DESTROYED" as const };
        const [destroySnapshot] = transition(
          workerMachine,
          drainSnapshot,
          destroyEvent
        );

        await c.db.transaction(async (tx: RawAccess) => {
          await transitionLifecycle(
            tx,
            workerId,
            "worker",
            destroySnapshot.value as string,
            destroySnapshot.context,
            destroyEvent,
            `worker-${workerId}-destroyed-${Date.now()}`
          );
        }, { name: "vmDestroyed" });
      }
      return { destroyed: true };
}

export type PushBranchParams = {
  workerId: string; taskId: string; epoch: number; branch: string; runId?: string; parentAgentId?: string | null; target?: string; rework?: boolean; resumed?: boolean;
  /** `spawn --continue`: the stopped agent whose work this branch starts from. */
  from?: { agentId: string; ref: string; stopped: string };
  /** Task goal for a real agent (claude-code). */
  goal?: string;
  /** ADR-017: scripted fake agent's declared file (fake sandbox only). */
  fakePath?: string; fakeContent?: string;
  /** ADR-017: install in-VM capcomd + skill (agents allowed to spawn). */
  subagents?: { skill: string; kind?: string };
  conflictFiles?: string[];
  /** Agent profile name for this task. */
  agent?: string;
  /** The spec the agent was spawned with (its scope record): wins over `agent` looked up by name. */
  agentSpec?: Record<string, unknown> | null;
  /** verify's reviewer: review this commit; nothing is committed or pushed. */
  review?: { sha: string; branch: string; target: string };
  /** Report mode: read-only work; the final message is the result, nothing is pushed. */
  report?: boolean;
};

/**
 * The agent's run and push (provision is done): the pushBranch action, and (ADR-022) the worker's own workflow, which
 * calls it with the actor's db, key and client (`c` needs only those).
 */
export async function pushBranchImpl(c: { db: any; key: string[]; client: () => any }, params: PushBranchParams) {
  // A provider call that waits out an outage shows on the agent (its notice) while it waits.
  return withOutageListener(outageNotice(() => c.client(), params.runId, params.workerId), () => pushBranchRun(c, params));
}

async function pushBranchRun(c: { db: any; key: string[]; client: () => any }, params: PushBranchParams) {
  const { workerId, taskId, epoch, branch } = params;
  const idemKey = `worker-${workerId}-push-${taskId}-e${epoch}`;
  const already = await c.db.execute(
    "SELECT idem_key, event FROM lifecycle_events WHERE idem_key = ?",
    idemKey
  );
  if (already.length > 0) {
    // Replay: return what the first push recorded (a resumed driver needs the commit).
    let prev: { sha?: string; costUsd?: number; notionalCostUsd?: number; billing?: string; resultText?: string; turns?: number; wallSeconds?: number; adopted?: boolean; limit?: string; resetAt?: number } = {};
    try { prev = JSON.parse(String(already[0]!.event)); } catch {}
    return { workerId, taskId, pushed: true, already: true, sha: prev.sha ?? "", costUsd: 0, recorded: { costUsd: prev.costUsd ?? 0, turns: prev.turns ?? 0, wallSeconds: prev.wallSeconds ?? 0, ...(prev.notionalCostUsd ? { notionalCostUsd: prev.notionalCostUsd } : {}), ...(prev.billing ? { billing: prev.billing } : {}), ...(prev.resultText ? { resultText: prev.resultText } : {}), ...(prev.limit ? { limit: prev.limit } : {}), ...(prev.resetAt ? { resetAt: prev.resetAt } : {}) }, ...(prev.adopted ? { adopted: true } : {}) };
  }

  const workerLife = await getLifecycle(c.db, workerId);
  if (!workerLife) throw new Error(`Worker ${workerId} not found`);
  const workerContext = JSON.parse(workerLife.context as string) as WorkerContext & {
    idemKey?: string;
  };
  const { provider, sandbox } = await providerForRun(params.runId);
  const runSource = withSandbox(process.env, sandbox);
  const vmKey = workerContext.idemKey ?? `relay-worker-${workerId}`;
  // The run's idle machine lifetime: the VM's delete deadline, renewed while the agent runs.
  const lifeSeconds = await runIdleLifetime(params.runId, sandbox);

  // Acquire the push lock (or wait out a live push by another call).
  await c.db.execute(PUSH_LOCKS_SQL);
  const holder = crypto.randomUUID();
  let takeover = false;
  for (let waited = 0; ; waited += 500) {
    const done = await c.db.execute("SELECT event FROM lifecycle_events WHERE idem_key = ?", idemKey);
    if (done.length) {
      let prev: { sha?: string; costUsd?: number; notionalCostUsd?: number; billing?: string; resultText?: string; turns?: number; wallSeconds?: number; adopted?: boolean; limit?: string; resetAt?: number } = {};
      try { prev = JSON.parse(String(done[0]!.event)); } catch {}
      return { workerId, taskId, pushed: true, already: true, sha: prev.sha ?? "", costUsd: 0, recorded: { costUsd: prev.costUsd ?? 0, turns: prev.turns ?? 0, wallSeconds: prev.wallSeconds ?? 0, ...(prev.notionalCostUsd ? { notionalCostUsd: prev.notionalCostUsd } : {}), ...(prev.billing ? { billing: prev.billing } : {}), ...(prev.resultText ? { resultText: prev.resultText } : {}), ...(prev.limit ? { limit: prev.limit } : {}), ...(prev.resetAt ? { resetAt: prev.resetAt } : {}) }, ...(prev.adopted ? { adopted: true } : {}) };
    }
    const now = Date.now();
    const rows = await c.db.execute("SELECT * FROM push_locks WHERE idem_key = ?", idemKey);
    const lk: any = rows[0];
    const live = lk && lk.state === "running" && lk.instance === ENGINE_INSTANCE && Number(lk.until) > now;
    if (!live) {
      takeover = !!lk && lk.state === "running";
      await c.db.execute(
        `INSERT INTO push_locks (idem_key, holder, instance, until, attempts, state, updated_at) VALUES (?, ?, ?, ?, 1, 'running', ?)
         ON CONFLICT(idem_key) DO UPDATE SET holder = excluded.holder, instance = excluded.instance, until = excluded.until,
           attempts = push_locks.attempts + 1, state = 'running', updated_at = excluded.updated_at
         WHERE NOT (push_locks.state = 'running' AND push_locks.instance = ? AND push_locks.until > ?)`,
        idemKey, holder, ENGINE_INSTANCE, now + PUSH_LOCK_MS(), now, ENGINE_INSTANCE, now
      );
      const mine = await c.db.execute("SELECT holder FROM push_locks WHERE idem_key = ?", idemKey);
      if (mine[0]?.holder === holder) break;
    }
    if (waited > 60 * 60_000) throw new UserError(`push ${idemKey} still in progress after 1h`, { code: "push_in_progress" });
    await new Promise((r) => setTimeout(r, 500));
  }
  const renew = setInterval(() => {
    c.db.execute("UPDATE push_locks SET until = ?, updated_at = ? WHERE idem_key = ? AND holder = ?", Date.now() + PUSH_LOCK_MS(), Date.now(), idemKey, holder).catch(() => {});
  }, Math.max(200, PUSH_LOCK_MS() / 3));
  try {

  killpoint("push.mid");

  const setup = agentSetup(params.agent, params.agentSpec, runSource);
  recordWorkerVm(c, { idemKey: vmKey, sandbox: sandbox ?? (workerContext as { sandbox?: string }).sandbox, runId: params.runId, workerId, ttlSeconds: lifeSeconds });
  const { id: vmId } = await provider.ensure({
    idemKey: vmKey,
    isolated: true,
    ttlSeconds: lifeSeconds,
    egressAllow: setup.egressAllow,
    ...setup.snapshot,
    labels: { workerId, taskId, epoch: String(epoch) },
  }).catch((error) => {
    if (isBoxdAuthError(error)) throw new UserError((error as Error).message, { code: "sandbox_auth", metadata: { kind: "config", retryable: false } });
    throw error;
  });
  await provider.waitReady(vmId, 90_000);

  let sha = "";
  let costUsd = 0;
  let turns = 0;
  let billing: string | undefined;
  let notionalCostUsd = 0; // subscription billing: what the CLI says the tokens would cost at API prices
  let resultText: string | undefined; // a reviewer's final message (its verdict)
  let limit: string | undefined; // stopped at a limit: the branch holds the work so far
  let resetAt: number | undefined; // limit "quota": when the provider said the usage limit resets (ms epoch)
  let adopted = false;
  // The run's repository (recorded at `run new`), so an engine without CAPCOMD_REPO still clones the right one.
  const cfg = await (await import("../merge/run-config")).mergeConfigFor(params.runId);
  const agent = setup.kind;
  // Takeover: a push that reached the remote before its holder died is adopted, not redone.
  if (takeover && cfg) {
    const remote = await remoteBranchSha(cfg.remote, branch).catch(() => null);
    if (remote) { sha = remote; adopted = true; }
  }
  const pushStarted = Date.now();
  const fakeDelay = Number(process.env.CAPCOMD_FAKE_PUSH_DELAY_MS ?? 0);
  if (adopted) {
    // nothing to run: the branch is already on the remote
  } else if (isRealAgent(agent)) {
    // Real worker: the agent edits the repo in the VM, commits with trailers, pushes the task branch.
    if (!cfg) throw new Error(`CAPCOMD_AGENT=${agent} needs a repo: set CAPCOMD_REPO`);
    if (!params.runId) throw new Error(`pushBranch needs runId for ${agent}`);
    const adapter = adapterFor(agent);
    // Optional: with a boxd host-bound secret the VM holds a bxds_ placeholder and this is unused.
    const apiKey = process.env[adapter.secretName];
    const runId = params.runId;
    // ADR-019 §1: liveness is reported up by the in-VM supervisor (or, without one, the agent CLI's own events), for
    // every agent, so one that can't spawn isn't flagged stuck while it works. Checkpoints are recorded too.
    const scope = workerId.startsWith("agt-") ? (c as any).client().scope.getOrCreate([runId]) : null;
    let pauseAsked = false;
    const beatEvery = heartbeatEveryMs();
    let beatAt = 0;
    // What it is doing now (harness.v1 Agent.activity): classified from its events, written at most once a second.
    // Each finished step goes into its history too (agent.step), unthrottled; the last one when it ends (not on a cancel).
    const activity = scope ? activityReporter((a) => scope.setActivity({ agentId: workerId, activity: a }), { onStep: (st) => scope.recordStep({ agentId: workerId, ...st }) }) : null;
    let cancelSeen = false;
    // Its thread (harness.v1 thread items), written in order; flushed before the agent is reported finished. Agents
    // that may spawn get one too: the spool pump forwards only their capcomd calls, not their own events.
    const items = scope ? itemWriter(scope, workerId) : null;
    const res = await runAgent(adapter, provider, vmId, {
      runId, taskId, epoch, branch: params.review?.branch ?? branch, target: params.review?.target ?? params.target ?? cfg.target, repoUrl: cfg.remote,
      goal: params.goal ?? `Task ${taskId}`, rework: params.rework, ...(params.resumed ? { resumed: true } : {}), ...(params.from ? { from: params.from } : {}), ...(params.review ? { review: params.review } : {}), ...(params.report ? { report: true } : {}),
      ...(workerId.startsWith("agt-") ? { agentId: workerId, parentAgentId: params.parentAgentId ?? null } : {}), conflictFiles: params.conflictFiles,
    }, setup.config!, {
      apiKey,
      heartbeatMs: beatEvery,
      vmTtlSeconds: lifeSeconds,
      onRenew: (secs) => { renewWorkerLease(c.db, workerId, Date.now() + secs * 1000).catch(() => {}); },
      onReport: (rep) => {
        if (!scope) return;
        if (rep.type === "checkpoint") { scope.checkpoint({ agentId: workerId, ref: rep.ref, sha: rep.sha, reason: rep.reason, files: rep.files }).catch(() => {}); return; }
        if (Date.now() - beatAt < beatEvery) return;
        beatAt = Date.now();
        scope.heartbeat({ agentId: workerId }).catch(() => {});
      },
      onNotice: (n) => { scope?.notice({ agentId: workerId, notice: n }).catch(() => {}); },
      ...(activity ? { onEvent: activity.event } : {}),
      ...(scope ? { onSpend: async (spent: { usd: number; turns: number; wallSeconds: number }, inboxAfter?: number) => (await scope.reportSpend({ agentId: workerId, spent, ...(inboxAfter !== undefined ? { inboxAfter } : {}) })) as { stop: string | null; grantedAt?: number; used?: number | null; messages?: { seq: number; from: string; body: string; skills?: AttachedSkill[] }[] } } : {}),
      // Agents that may spawn already have their raw stream tailed into the log by the spool pump (driver.ts).
      ...(scope && !params.subagents ? { onLog: (lines: string[]) => { scope.appendLog({ agentId: workerId, stream: "agent", lines }).catch(() => {}); } } : {}),
      ...(items ? { onItems: items } : {}),
      ...(params.subagents ? { subagents: { skill: params.subagents.skill, cliSource: VM_CLI_SOURCE, rpcDir: "/tmp/capcomd-rpc" } } : {}),
      isCancelled: async () => {
        const run = await (c as any).client().run.getOrCreate([runId]).getRun({ runId });
        if (run?.state === "cancelled") { cancelSeen = true; return true; }
        // Spawned agents (ADR-016): the worker id is the agent id in the run's scope actor.
        if (!workerId.startsWith("agt-")) return false;
        const a = await (c as any).client().scope.getOrCreate([runId]).getAgent({ agentId: workerId }).catch(() => null);
        pauseAsked = !!a?.pauseRequested;
        if (a?.status === "cancelled") cancelSeen = true;
        return a?.status === "cancelled";
      },
      // The operator's pause (scope requestPause): the runner stops the agent and keeps its work; the driver pauses it.
      // Read from the agent row isCancelled just fetched (the runner asks right after it), so no extra actor call per poll.
      ...(scope ? { isPaused: async () => pauseAsked } : {}),
    }).finally(async () => { if (cancelSeen) activity?.stop(); else await activity?.finish(); await items?.flush(); });
    sha = res.sha;
    costUsd = res.costUsd;
    turns = res.turns;
    billing = res.billing;
    notionalCostUsd = res.notionalCostUsd ?? 0;
    resultText = res.resultText;
    limit = res.limit;
    resetAt = res.resetAt;
    // The `capcomd run` recipe has no stopped state: its task fails, with the work kept on the branch.
    if (limit && !workerId.startsWith("agt-")) throw new UserError(`agent ${stoppedAt(limit)}; its work so far is on ${branch}`, { code: "limit", metadata: { kind: "limit" } });
  } else if (params.review || params.report) {
    // Fake sandbox reviewer/reporter: nothing to run or push (a scripted one declares its result itself).
  } else {
    if (fakeDelay > 0) await new Promise((r) => setTimeout(r, fakeDelay)); // test knob: a slow push
    if (process.env.CAPCOMD_FAKE_PUSH_FAIL) throw new Error(process.env.CAPCOMD_FAKE_PUSH_FAIL); // test knob: a push that always fails
    await provider.exec(vmId, ["git", "push", "origin", branch]);
  }

  // In-memory sandbox + a configured repo: produce the task's commit on the orchestrator host
  // (a real VM pushes its own branch). Idempotent: an already-pushed branch is reused.
  if (!sha && !params.review && !params.report && cfg && (sandbox ? sandbox.startsWith("fake") : getDependencies().fakeWork) && params.runId) {
    sha = await produceFakeWork(cfg, { runId: params.runId, taskId, branch, target: params.target ?? cfg.target, epoch, rework: params.rework, ...(params.fakePath ? { path: params.fakePath, content: params.fakeContent ?? "" } : {}) });
  }

  killpoint("push.after.before_event");
  const wallSeconds = Math.round((Date.now() - pushStarted) / 100) / 10;

  await c.db.transaction(async (tx: RawAccess) => {
    await transitionLifecycle(
      tx,
      workerId,
      "worker",
      workerLife.state,
      { ...workerContext, vmId },
      { type: "PUSHED", taskId, epoch, branch, sha, costUsd, turns, wallSeconds, ...(notionalCostUsd ? { notionalCostUsd } : {}), ...(billing ? { billing } : {}), ...(resultText ? { resultText } : {}), ...(limit ? { limit } : {}), ...(resetAt ? { resetAt } : {}), ...(adopted ? { adopted: true } : {}), ...(setup.record ? { agent: setup.record } : {}) },
      idemKey
    );
    await tx.execute("UPDATE push_locks SET state = 'done', sha = ?, adopted = ?, until = 0, updated_at = ? WHERE idem_key = ?", sha || null, adopted ? 1 : 0, Date.now(), idemKey);
  }, { name: "pushBranch" });

  return { workerId, taskId, pushed: true, already: false, sha, costUsd, turns, wallSeconds, adopted, ...(billing ? { billing } : {}), ...(notionalCostUsd ? { notionalCostUsd } : {}), ...(resultText ? { resultText } : {}), ...(limit ? { limit } : {}), ...(resetAt ? { resetAt } : {}) };
  } catch (error) {
    // Release so a retry can take over at once (the attempt count records the retry).
    await c.db.execute("UPDATE push_locks SET until = 0, updated_at = ? WHERE idem_key = ? AND holder = ?", Date.now(), idemKey, holder).catch(() => {});
    // rivetkit masks plain errors as "An internal error occurred": surface the (redacted) cause.
    if (error instanceof UserError) throw error;
    const kind = String((error as any)?.kind ?? (error as any)?.code ?? "push_failed");
    const retryable = isTransientSandboxError(error) || isSandboxUnreachable(error);
    throw new UserError(redactShapes(String((error as Error)?.message ?? error)).slice(0, 2000), { code: kind, metadata: { kind, ...(retryable ? { retryable: true } : {}) } });
  } finally {
    clearInterval(renew);
  }
}

// ADR-022: unless the engine host has CAPCOMD_AGENT_WORKFLOW=0 (read when it loads), an agent's worker also runs its
// lifecycle as a workflow (`run`), started by one `start` message (`startAgent`). With =0 the actor is as before.
const WORKFLOW = agentWorkflowOn();

export const workerActor = actor({
  // A claude-code task runs for minutes inside pushBranch (install + agent + push).
  options: { actionTimeout: 60 * 60_000 },
  ...(WORKFLOW ? (agentWorkflowParts() as {}) : {}),
  db: db({
    onMigrate: async (database) => {
      await setupLifecycleTables(database);
      await database.execute(PUSH_LOCKS_SQL);
    },
  }),

  actions: traceActions("worker", {
    /** Push lock rows (attempts, adopted, state) for audits and the takeover chaos case. */
    async getPushes(c, _p: Record<string, never>) {
      await c.db.execute(PUSH_LOCKS_SQL);
      return (await c.db.execute("SELECT * FROM push_locks ORDER BY idem_key")).map((r: any) => ({
        idemKey: r.idem_key as string, state: r.state as string, attempts: Number(r.attempts), adopted: !!Number(r.adopted),
        sha: (r.sha as string | null) ?? null, live: r.state === "running" && r.instance === ENGINE_INSTANCE && Number(r.until) > Date.now(),
      }));
    },

    async provisionWorker(
      c,
      params: {
        workerId: string;
        runId: string;
        epoch: number;
        /** Agent profile name (.capcomd/agents.json) for this worker's task. */
        agent?: string;
        /** The spec the agent was spawned with (its scope record): wins over `agent` looked up by name. */
        agentSpec?: Record<string, unknown> | null;
      }
    ) {
      const { workerId, runId, epoch } = params;
      return withOutageListener(outageNotice(() => c.client(), runId, workerId), async () => {
      const { provider, sandbox } = await providerForRun(runId);
      const runSource = withSandbox(process.env, sandbox);
      // The run's idle machine lifetime (recorded at `run new`), else its place's current setting.
      const lifeSeconds = await runIdleLifetime(runId, sandbox);

      const existing = await getLifecycle(c.db, workerId);
      if (existing && existing.state !== "provisioning" && existing.state !== "failed") {
        const ctx = JSON.parse(existing.context as string);
        return { workerId, vmId: ctx.vmId as string, state: existing.state };
      }
      const setup = agentSetup(params.agent, params.agentSpec, runSource);

      const idemKey =
        existing && JSON.parse(existing.context as string).idemKey
          ? (JSON.parse(existing.context as string).idemKey as string)
          : `relay-${runId.substring(0, 8)}-${workerId}-e${epoch}`;

      if (!existing) {
        const [snapshot] = initialTransition(workerMachine, {
          workerId,
          createdAt: Date.now(),
          ttlMs: lifeSeconds * 1000,
          idemKey,
          ...(sandbox ? { sandbox } : {}),
        } as any);

        await c.db.transaction(async (tx: RawAccess) => {
          await transitionLifecycle(
            tx,
            workerId,
            "worker",
            snapshot.value as string,
            snapshot.context,
            { type: "PROVISIONING", ...(setup.record ? { agent: setup.record } : {}) },
            `worker-${workerId}-provisioning`
          );
        }, { name: "provisionWorker" });
      }

      try {
        recordWorkerVm(c, { idemKey, sandbox, runId, workerId, ttlSeconds: lifeSeconds });
        killpoint("vm.create.after_request.before_record");

        const { id: vmId } = await provider.ensure({
          idemKey,
          isolated: true,
          ttlSeconds: lifeSeconds,
          egressAllow: setup.egressAllow,
          ...setup.snapshot,
          labels: {
            runId,
            workerId,
            epoch: epoch.toString(),
          },
        });

        await provider.waitReady(vmId, 90_000);

        // TTL sweep: the actor reaps its own sandbox at createdAt+ttl even if no client ever returns.
        {
          const life = await getLifecycle(c.db, workerId);
          const ctx = life ? JSON.parse(life.context as string) : {};
          const at = Number(ctx.createdAt ?? Date.now()) + Number(ctx.ttlMs ?? 3_600_000);
          await c.schedule.at(at, "reapIfExpired", { workerId });
        }

        const workerLife = await getLifecycle(c.db, workerId);
        if (!workerLife) {
          throw new Error(`Worker ${workerId} not found after provisioning`);
        }

        const workerContext: WorkerContext = JSON.parse(workerLife.context);
        const workerSnapshot = workerMachine.resolveState({
          value: workerLife.state,
          context: workerContext,
        });

        const event = { type: "VM_READY" as const, vmId };
        const [newSnapshot] = transition(workerMachine, workerSnapshot, event);

        await c.db.transaction(async (tx: RawAccess) => {
          await transitionLifecycle(
            tx,
            workerId,
            "worker",
            newSnapshot.value as string,
            newSnapshot.context,
            event,
            `worker-${workerId}-ready-${vmId}`
          );
        }, { name: "vmReady" });

        return { workerId, vmId, state: "idle" };
      } catch (error) {
        const workerLife = await getLifecycle(c.db, workerId);
        if (!workerLife) return;

        const workerContext: WorkerContext = JSON.parse(workerLife.context);
        const workerSnapshot = workerMachine.resolveState({
          value: workerLife.state,
          context: workerContext,
        });

        const event = {
          type: "VM_FAILED" as const,
          error: error instanceof Error ? error.message : String(error),
        };

        const [newSnapshot] = transition(workerMachine, workerSnapshot, event);

        await c.db.transaction(async (tx: RawAccess) => {
          await transitionLifecycle(
            tx,
            workerId,
            "worker",
            newSnapshot.value as string,
            newSnapshot.context,
            event,
            `worker-${workerId}-failed`
          );
        }, { name: "vmFailed" });

        // Cross the actor boundary with a readable, typed error (plain errors are masked as "internal error").
        if (isBoxdAuthError(error)) throw new UserError((error as Error).message, { code: "sandbox_auth", metadata: { kind: "config", retryable: false } });
        throw sandboxUserError(error);
      }
      });
    },

    async assignTask(
      c,
      params: {
        workerId: string;
        taskId: string;
        epoch: number;
      }
    ) {
      const { workerId, taskId, epoch } = params;

      const workerLife = await getLifecycle(c.db, workerId);
      if (!workerLife) {
        throw new Error(`Worker ${workerId} not found`);
      }

      const workerContext: WorkerContext = JSON.parse(workerLife.context);
      if (workerLife.state === "busy" && workerContext.taskId === taskId) {
        return { workerId, taskId, vmId: workerContext.vmId };
      }
      const workerSnapshot = workerMachine.resolveState({
        value: workerLife.state,
        context: workerContext,
      });

      const event = { type: "ASSIGN" as const, taskId, epoch };

      if (!workerSnapshot.can(event)) {
        throw new Error(
          `Worker ${workerId} cannot accept ASSIGN in state ${workerLife.state}`
        );
      }

      const [newSnapshot] = transition(workerMachine, workerSnapshot, event);

      await c.db.transaction(async (tx: RawAccess) => {
        await transitionLifecycle(
          tx,
          workerId,
          "worker",
          newSnapshot.value as string,
          newSnapshot.context,
          event,
          `worker-${workerId}-assign-${taskId}-${epoch}`
        );
      }, { name: "assignTask" });

      return { workerId, taskId, vmId: workerContext.vmId };
    },

    async pushBranch(c, params: PushBranchParams) {
      return pushBranchImpl(c, params);
    },

    async listEventSeqs(c, _params: Record<string, never>) {
      const rows = await c.db.execute(
        "SELECT entity_id, seq FROM lifecycle_events ORDER BY entity_id, seq"
      );
      return rows.map((row: Record<string, unknown>) => ({
        entityId: row.entity_id as string,
        seq: Number(row.seq),
      }));
    },

    async taskDone(c, params: { workerId: string }) {
      const { workerId } = params;

      const workerLife = await getLifecycle(c.db, workerId);
      if (!workerLife) return;

      const workerContext: WorkerContext = JSON.parse(workerLife.context);
      const workerSnapshot = workerMachine.resolveState({
        value: workerLife.state,
        context: workerContext,
      });

      const event = { type: "TASK_DONE" as const };

      if (!workerSnapshot.can(event)) return;

      const [newSnapshot] = transition(workerMachine, workerSnapshot, event);

      await c.db.transaction(async (tx: RawAccess) => {
        await transitionLifecycle(
          tx,
          workerId,
          "worker",
          newSnapshot.value as string,
          newSnapshot.context,
          event,
          `worker-${workerId}-done-${Date.now()}`
        );
      }, { name: "taskDone" });
    },

    async drainWorker(c, params: { workerId: string }) {
      return drainWorkerImpl(c, params.workerId);
    },

    /** The worker's own alarm: a drain whose destroy the provider didn't answer, tried again (see drainWorkerImpl). */
    async retryDrain(c, params: { workerId: string; cause?: "run_ended" | "idle_lifetime"; retry: number }) {
      const life = await getLifecycle(c.db, params.workerId);
      if (!life || life.state !== "draining") return { destroyed: life?.state === "destroyed" };
      return drainWorkerImpl(c, params.workerId, params.cause ?? "run_ended", params.retry);
    },

    /**
     * Idempotent reap. Destroys the sandbox when the caller says the run/task is
     * terminal, or when the worker is past its TTL. No-op once destroyed.
     */
    async reap(c, params: { workerId: string; terminal?: boolean; now?: number }) {
      const life = await getLifecycle(c.db, params.workerId);
      if (!life || life.state === "destroyed") return { reaped: false, state: life?.state ?? null };
      const ctx = JSON.parse(life.context as string);
      const expired = (params.now ?? Date.now()) >= await workerDeadline(c.db, params.workerId, ctx);
      if (!params.terminal && !expired) return { reaped: false, state: life.state };
      await drainWorkerImpl(c, params.workerId, params.terminal ? "run_ended" : "idle_lifetime");
      return { reaped: true, reason: params.terminal ? "terminal" : "ttl" };
    },

    async reapIfExpired(c, params: { workerId: string }) {
      const life = await getLifecycle(c.db, params.workerId);
      if (!life || life.state === "destroyed") return { reaped: false };
      const ctx = JSON.parse(life.context as string);
      const deadline = await workerDeadline(c.db, params.workerId, ctx);
      // Renewed while its agent ran: look again at the new deadline.
      if (Date.now() < deadline) { await c.schedule.at(deadline, "reapIfExpired", { workerId: params.workerId }); return { reaped: false }; }
      await drainWorkerImpl(c, params.workerId, "idle_lifetime");
      return { reaped: true, reason: "ttl" };
    },

    ...(WORKFLOW ? {
      /** ADR-022: queue the `start` this worker's agent workflow waits for (idempotent). */
      async startAgent(c: any, params: StartAgent) { return queueStart(c, params); },
      /** ADR-022: how much workflow history this worker holds (rows and bytes in its SQLite), and its database's size. */
      async getWorkflowStats(c: any) { return workflowStats(c); },
    } : {}),

    async getWorker(c, params: { workerId: string }) {
      const workerLife = await getLifecycle(c.db, params.workerId);
      if (!workerLife) return null;

      return {
        workerId: workerLife.entity_id,
        state: workerLife.state,
        context: JSON.parse(workerLife.context),
      };
    },
  }),
});
