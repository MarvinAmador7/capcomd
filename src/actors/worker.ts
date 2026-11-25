import { readFileSync } from "fs";
import { TITLE_SHIM_SOURCE, VM_CLI_SOURCE } from "../utils/assets";
import { namingSkill } from "../subagents/skill";
import { redactShapes } from "../agents/redact";
import type { RawAccess } from "rivetkit/db";
import { traceActions } from "../utils/tracing-simple";
import { actor, UserError } from "rivetkit";
import { isSandboxUnreachable, isTransientSandboxError, SandboxError } from "../providers/boxd-errors";
import { sandboxAuthError } from "../plugins/sandboxes";
import { backoffMs, minutes, withOutageListener, type Outage } from "../providers/resilient";
import { db } from "./db";
import { workerMachine, type WorkerContext } from "../machines/worker";
import { initialTransition, transition } from "xstate";
import {
  setupLifecycleTables,
  transitionLifecycle,
  getLifecycle,
} from "../utils/lifecycle";
import { produceFakeWork } from "../merge/fakework";
import { killpoint } from "../utils/killpoint";
import { getDependencies, providerForAgent, providerNamed } from "../dependencies";
import { agentIdleLifetime, withSandbox } from "../providers/run-sandbox";
import { reportMachineDeleted, type DeleteCause } from "../providers/machine-audit";
import { forgetMachine, machineNameFor, recordAgentMachine, recordParked } from "../providers/machines";
import { sandboxCaps, sandboxName } from "../providers/registry";
import { slotsFor } from "../providers/capacity";
import { agentFromEnv, isRealAgent, loadAgentConfig } from "../agents/config";
import { runAgent, SessionMissingError, stoppedAt } from "../agents/runner";
import { activityReporter, setupReporter } from "../agents/activity";
import { noteStep } from "../jobs/service";
import { itemWriter } from "../agents/thread-store";
import { heartbeatEveryMs } from "../subagents/results";
import { adapterFor, envPins } from "../agents/adapters";
import type { AttachedSkill } from "../agents/skills";
import { bootSnapshot, projectTemplateFor } from "../env/resolve";
import { profileFor } from "../auth/profiles";
import { effectiveAgentRecord, type ProfileMachine } from "../profiles";
import { ENGINE_INSTANCE } from "../utils/engine-instance";
import { env as envVar } from "../utils/env";
import type { SandboxProvider, VmId } from "../providers/sandbox";
import type { MergeConfig } from "../merge/config";
import { admitStart, agentVmIdemKey, agentWorkflowOn, agentWorkflowParts, queueStart, stepWakeActions, workflowStats, type StartAgent } from "./agent-workflow";

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
/** When the worker's VM is due to be reaped: its lifetime after creation, or after its last renewal if later; a parked
 *  one's (ADR-026 §6) when its retention runs out. */
async function workerDeadline(db: RawAccess, workerId: string, ctx: Record<string, unknown>): Promise<number> {
  const parked = ctx.parked as { deleteAt?: unknown } | undefined;
  if (parked && Number.isFinite(Number(parked.deleteAt))) return Number(parked.deleteAt);
  const made = Number(ctx.createdAt ?? 0) + Number(ctx.ttlMs ?? 3_600_000);
  try {
    await db.execute(WORKER_LEASE_SQL);
    const rows = await db.execute("SELECT until FROM worker_lease WHERE worker_id = ?", workerId);
    return Math.max(made, Number(rows[0]?.until ?? 0));
  } catch { return made; }
}

async function remoteBranchSha(remote: string, branch: string): Promise<string | null> {
  const { lsRemote } = await import("../merge/host-git");
  const r = await lsRemote(remote, [`refs/heads/${branch}`], { timeoutMs: 60_000 });
  if (r.code !== 0) throw new Error(`git ls-remote ${branch} failed (exit ${r.code})`);
  const sha = r.stdout.trim().split(/\s+/)[0];
  return sha && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}
/**
 * This worker's agent, resolved once per action: its kind and, for a real agent, its config, the VM's egress and the
 * snapshot it boots from (a plan login's when it has one, else its profile's environment, else the `capcomd env build`
 * snapshot, else the default image: src/env/resolve.ts `bootSnapshot`). `pinned`: the spec recorded when the agent was
 * spawned (the scope's agent record), which wins over the profile by name: this process (the daemon) need not see the
 * project's agents file, and its own may define the name otherwise or not at all. `source`: the env as the agent's
 * machine sees it (its profile's sandbox, else its run's, if either: snapshots and plan logins are per sandbox).
 * `machine`: what its profile pinned for its machine (ADR-024 `sandbox.*`), which a scripted agent has too. A problem
 * here is configuration (an unknown or invalid profile, no credentials, an environment the sandbox doesn't have): it
 * crosses the actor boundary as a typed error with its message, not rivetkit's opaque "internal error".
 */
function agentSetup(profile: string | undefined, pinned: unknown, source: Record<string, string | undefined>, machine: ProfileMachine = {}, repo?: string) {
  try {
    const kind = agentFromEnv(source, profile, pinned);
    const boot = (login?: Parameters<typeof bootSnapshot>[0]["login"], pins?: Parameters<typeof bootSnapshot>[0]["pins"]) => {
      const snap = bootSnapshot({ ...(machine.environment ? { environment: machine.environment } : {}), real: isRealAgent(kind), login, ...(repo ? { repo } : {}), ...(pins ? { pins } : {}) }, source);
      return snap ? { fromSnapshot: snap } : {};
    };
    if (!isRealAgent(kind)) return { kind, config: null, egressAllow: LEGACY_EGRESS, snapshot: boot() as { fromSnapshot?: string }, record: null, template: null };
    const config = loadAgentConfig(source, profile, pinned);
    const login = config.credentialMode === "subscription" ? profileFor(kind, source) : undefined;
    const pins = envPins(config);
    const snapshot: { fromSnapshot?: string } = boot(login ? { agent: kind, ...(login.snapshot ? { snapshot: login.snapshot } : {}), env: login.env } : null, pins);
    // Its project's template (src/env/templates.ts), when the place keeps them and nothing else chose the machine's
    // image (a plan login's, a profile's environment): used, or why not (none yet, built on other CLI pins).
    const t = machine.environment || login?.snapshot ? null : projectTemplateFor(repo, pins, source);
    const template = t && t.why !== "not_kept" ? { why: t.name && snapshot.fromSnapshot === t.name ? "used" as const : t.why === "used" ? "overridden" as const : t.why } : null;
    return { kind, config, egressAllow: config.egress, snapshot, record: effectiveAgentRecord(profile, source, pinned), template };
  } catch (e) {
    throw configError(e);
  }
}

/**
 * Its project's template (src/env/templates.ts), on a place that keeps them: built in the background when the project
 * has none or one made for other agent CLI versions, and rebuilt when this agent couldn't use it in place or the delta
 * it got passed the threshold. A run never waits for a build. Null: nothing to do (no template here, or the machine's
 * image was chosen otherwise).
 */
async function templateHooks(provider: SandboxProvider, source: Record<string, string | undefined>, cfg: MergeConfig, setup: ReturnType<typeof agentSetup>, runId: string | undefined) {
  if (!setup.template || !setup.config) return null;
  const T = await import("../env/templates");
  const { isSnapshotPlatform } = await import("../env/platform");
  if (!T.keepsProjectTemplates(source) || !isSnapshotPlatform(provider)) return null;
  // The project's setup step and its egress, as recorded with the run (`.capcomd/config.json` env).
  const run = await (await import("../merge/run-config")).runEnv(runId);
  const setupCmd = envVar("SETUP_COMMAND", run);
  const req = {
    provider: provider as SandboxProvider & import("../env/platform").SnapshotPlatform, repo: cfg.remote, cfg: setup.config, hostGit: { workdir: cfg.workdir }, source,
    ...(setupCmd ? { setup: setupCmd } : {}), egress: (envVar("SETUP_EGRESS", run) ?? "").split(",").map((d) => d.trim()).filter(Boolean),
  };
  const schedule = (reason: string, unlessTargetAt?: { target: string; commit: string } | null) => T.scheduleTemplateBuild({ ...req, reason, ...(unlessTargetAt ? { unlessTargetAt } : {}) });
  if (setup.template.why === "none") schedule("it has no template yet");
  if (setup.template.why === "stale_base") schedule("its template was built for other agent CLI versions");
  return {
    onWorkspace: (w: { path: "in_place" | "clone"; reason?: string; bytes: number }) => {
      if (setup.template?.why !== "used") return;
      const why = T.rebuildReason(w, source);
      // A clone: only a template whose branch moved would be different (else the agent's reason holds for a new one).
      if (why) schedule(why, w.path === "clone" ? T.templateTarget(cfg.remote, source) : null);
    },
  };
}

/** A configuration problem as an error rivetkit passes on (code "config", the redacted message); never retried. */
export function configError(e: unknown): UserError {
  if (e instanceof UserError) return e;
  return new UserError(redactShapes(String((e as Error)?.message ?? e)).slice(0, 2000), { code: "config", metadata: { kind: "config", retryable: false } });
}

/** A failed push as an error rivetkit passes on (it masks plain errors as "An internal error occurred"): the redacted
 *  cause, its kind as the code, and, for an agent that changed nothing, its final words, so its parent reads what it found. */
export function pushError(error: unknown): UserError {
  if (error instanceof UserError) return error;
  const kind = String((error as any)?.kind ?? (error as any)?.code ?? "push_failed");
  const retryable = isTransientSandboxError(error) || isSandboxUnreachable(error);
  const words = (error as { resultText?: unknown })?.resultText;
  const said = typeof words === "string" && words.trim() ? { resultText: redactShapes(words).slice(0, 4000) } : {};
  return new UserError(redactShapes(String((error as Error)?.message ?? error)).slice(0, 2000), { code: kind, metadata: { kind, ...(retryable ? { retryable: true } : {}), ...said } });
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
async function drainWorkerImpl(c: any, workerId: string, cause: Exclude<DeleteCause, "action"> = "run_ended", retry = 0): Promise<{ destroyed: boolean; retrying?: boolean }> {
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
          // Its memory slot (a place with a cap) is free for the next waiting agent.
          slotsFor(place)?.release(machineNameFor(idemKey));
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

/** One line in a spawned agent's log (its `capcomd logs`), best effort. */
function agentLog(c: { client: () => any }, runId: string | undefined, agentId: string, line: string): void {
  if (!runId || !agentId.startsWith("agt-")) return;
  Promise.resolve().then(() => c.client().scope.getOrCreate([runId]).appendLog({ agentId, stream: "agent", lines: [line] })).catch(() => {});
}

/**
 * ADR-026 §6: park this worker's machine when its agent's turn ended (a planner or lead; the caller decides): its delete
 * deadline moved to the retention (boxd's setDeleteAfter, which fires while it is hibernated; Docker's ledger, which the
 * sweep enforces), then hibernated (boxd `hibernate`, never `pause`; `docker stop`), which also stops boxd's keepalive.
 * The worker is `parked` and the machines ledger says so, with the machine's key, for the agent's next attempt to wake
 * (src/agents/continue.ts `parkedMachine`). Its own alarm deletes the machine when the retention runs out. A parked
 * machine holds no memory slot. Never throws: `parked: false` (with why) leaves the machine to the caller to destroy.
 */
async function parkWorkerImpl(c: any, p: { workerId: string; retentionSeconds: number; runId?: string }): Promise<{ parked: boolean; deleteAt?: number; reason?: string }> {
  const life = await getLifecycle(c.db, p.workerId);
  if (!life) return { parked: false, reason: "no worker" };
  const ctx: WorkerContext & { idemKey?: string; sandbox?: string } = JSON.parse(life.context);
  if (life.state === "parked") return { parked: true, ...(ctx.parked ? { deleteAt: ctx.parked.deleteAt } : {}) };
  const at = Date.now();
  const deleteAt = at + Math.max(1, Math.floor(p.retentionSeconds)) * 1000;
  const event = { type: "PARK" as const, at, deleteAt };
  const snap = workerMachine.resolveState({ value: life.state, context: ctx });
  if (!snap.can(event)) return { parked: false, reason: `its worker is ${life.state}` };
  if (!ctx.vmId || !ctx.idemKey) return { parked: false, reason: "it has no machine" };
  const provider = providerNamed(ctx.sandbox);
  if (typeof provider.hibernate !== "function" || typeof provider.wake !== "function") return { parked: false, reason: "its place doesn't park machines" };
  try {
    await provider.extendTtl?.(ctx.vmId, Math.max(1, Math.floor(p.retentionSeconds)));
    await provider.hibernate(ctx.vmId);
  } catch (e) {
    return { parked: false, reason: redactShapes(String((e as Error)?.message ?? e)).slice(0, 300) };
  }
  const [next] = transition(workerMachine, snap, event);
  await c.db.transaction(async (tx: RawAccess) => {
    await transitionLifecycle(tx, p.workerId, "worker", next.value as string, next.context, event, `worker-${p.workerId}-park-${at}`);
  }, { name: "parkWorker" });
  let place: string | undefined = ctx.sandbox;
  if (!place) try { place = sandboxName(); } catch { /* unknown CAPCOMD_SANDBOX */ }
  const key: string[] = Array.isArray(c?.key) ? c.key.map(String) : [];
  const runId = p.runId ?? key[0];
  if (runId) recordParked({ idemKey: ctx.idemKey, sandbox: place, runId, agentId: p.workerId, workerKey: key, ttlSeconds: p.retentionSeconds, parked: { at, deleteAt, vmId: ctx.vmId, idemKey: ctx.idemKey } });
  // Parked holds no memory slot (Docker counts running containers; this one is stopped).
  slotsFor(place)?.release(machineNameFor(ctx.idemKey));
  await c.schedule.at(deleteAt, "reapIfExpired", { workerId: p.workerId });
  return { parked: true, deleteAt };
}

/**
 * ADR-026 §5 path 2, in the agent's next attempt's worker (`params.parked`, before it provisions): the parked machine
 * is handed over by the worker that parked it (which then owns nothing: `released`) and woken. Returns its key, or null
 * (it was gone, or wouldn't wake: one line in the agent's log, the machine deleted, and the attempt gets a fresh one:
 * path 3, its saved session restored).
 */
async function takeParked(c: any, o: { workerId: string; runId: string; provider: SandboxProvider; sandbox: string | null; parked: { idemKey: string; vmId: string; workerKey: string[] } }): Promise<{ idemKey: string; vmId: string } | null> {
  const name = machineNameFor(o.parked.idemKey);
  const took = await c.client().worker.getOrCreate(o.parked.workerKey).handOver({ workerId: o.workerId, to: (c.key ?? []).join("/") }).catch(() => null) as { vmId: string; idemKey: string; sandbox: string | null } | null;
  if (!took) { agentLog(c, o.runId, o.workerId, `[capcomd] its parked machine ${name} was gone: a fresh one, its conversation restored`); return null; }
  const samePlace = (took.sandbox ?? null) === (o.sandbox ?? null) || !took.sandbox || !o.sandbox;
  try {
    if (!samePlace) throw new Error(`it is on ${took.sandbox}, this attempt runs on ${o.sandbox}`);
    await o.provider.wake!(took.vmId);
    return { idemKey: took.idemKey, vmId: took.vmId };
  } catch (e) {
    agentLog(c, o.runId, o.workerId, `[capcomd] its parked machine ${name} couldn't be woken (${redactShapes(String((e as Error)?.message ?? e)).slice(0, 200)}): a fresh one, its conversation restored`);
    await providerNamed(took.sandbox).destroy(took.vmId).catch(() => {});
    forgetMachine(name);
    return null;
  }
}

export type PushBranchParams = {
  workerId: string; taskId: string; epoch: number; branch: string; runId?: string; parentAgentId?: string | null; target?: string; rework?: boolean; resumed?: boolean;
  /** ADR-026 §1: a message woke this idle agent into this attempt: it continues its conversation (§5). */
  continued?: boolean;
  /** Legacy runs have no scope actor and use the daemon settings. */
  scopeBacked?: false;
  /** `spawn --continue`: the stopped agent whose work this branch starts from. */
  from?: { agentId: string; ref: string; stopped: string };
  /** Task goal for a real agent (claude-code). */
  goal?: string;
  /** ADR-017: scripted fake agent's declared file (fake sandbox only). */
  fakePath?: string; fakeContent?: string;
  /** ADR-017: install in-VM capcomd (src/subagents/skill.ts `hasVmCapcomd`). `rpcDir`: where its spool is in the VM. A
   *  spawner's skill comes in the agent's spec (agent.preparing, src/plugins/skill-orchestration.ts); `skill` only for an
   *  attempt no plugin prepared (src/primitives/ops.ts `unpreparedSkill`), or the worker's lines of one that may not spawn
   *  (`maySpawn: false`). */
  subagents?: { skill?: string; kind?: string; rpcDir?: string; maySpawn?: boolean };
  conflictFiles?: string[];
  /** Agent profile name for this task. */
  agent?: string;
  /** The spec the agent was spawned with (its scope record): wins over `agent` looked up by name. */
  agentSpec?: Record<string, unknown> | null;
  /** verify's reviewer: review this commit (merged onto `targetSha`, the tree the checks test); nothing is committed or pushed. */
  review?: { sha: string; branch: string; target: string; targetSha?: string };
  /** Report mode: read-only work; the final message is the result, nothing is pushed. */
  report?: boolean;
  /** ADR-025 §5.2: a consolidator answers with memory changes, which the kernel stages on its branch when it ends; the
   *  agent pushes nothing. `inputs`: the run's candidates and outcomes, which its prompt carries. */
  consolidate?: { inputs: string; brain?: string };
  /** The agent's title when it starts (the driver's, its parent's or the user's): its commit's subject before the brief. */
  title?: string;
  /** What its profile pinned for its machine (as provisionWorker got it): the same sandbox, environment and size. */
  machine?: ProfileMachine;
};

/**
 * ADR-026 §5: what a continued attempt's runner is given: the scope's record of the agent (its messages after its
 * cursor, its thread, its last hand-back), its saved session to restore in its machine, and the fallback's thread line.
 */
function continueHooks(scope: any, o: { runId: string; agentId: string; provider: SandboxProvider; machineId: VmId; fromThread?: boolean; parked?: boolean; onLog?: (lines: string[]) => void }): import("../agents/continue").ContinueHooks {
  return {
    load: async () => (await scope.continuation({ agentId: o.agentId })) ?? null,
    // `fromThread`: its saved session was restored but its CLI couldn't find it (SessionMissingError): path 4 straight away.
    // `parked` (§5 path 2): its woken machine still has the session file: nothing restored, unless it isn't there.
    restore: async ({ home, cwd }) => {
      if (o.fromThread) return null;
      const S = await import("../sessions");
      const at = { runId: o.runId, agentId: o.agentId, provider: o.provider, machineId: o.machineId, home, cwd, ...(o.onLog ? { onLog: o.onLog } : {}) };
      return (o.parked ? await S.parkedSession(at) : null) ?? S.restoreSession(at);
    },
    ...(o.parked ? { parked: true } : {}),
    pickedUpFromThread: async () => {
      const { PICKED_UP_TEXT } = await import("../agents/continue");
      const a = await scope.getAgent({ agentId: o.agentId }).catch(() => null);
      await scope.threadNote({ agentId: o.agentId, id: `itm-${o.agentId}-picked-up-e${a?.epoch ?? 0}`, text: PICKED_UP_TEXT });
    },
  };
}

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
  const scopeRunId = params.scopeBacked === false ? undefined : params.runId;
  const idemKey = `worker-${workerId}-push-${taskId}-e${epoch}`;
  const already = await c.db.execute(
    "SELECT idem_key, event FROM lifecycle_events WHERE idem_key = ?",
    idemKey
  );
  if (already.length > 0) {
    // Replay: return what the first push recorded (a resumed driver needs the commit).
    let prev: { sha?: string; costUsd?: number; notionalCostUsd?: number; billing?: string; resultText?: string; turns?: number; wallSeconds?: number; adopted?: boolean; limit?: string; resetAt?: number; orchestrateWrites?: unknown } = {};
    try { prev = JSON.parse(String(already[0]!.event)); } catch {}
    return { workerId, taskId, pushed: true, already: true, sha: prev.sha ?? "", costUsd: 0, recorded: { costUsd: prev.costUsd ?? 0, turns: prev.turns ?? 0, wallSeconds: prev.wallSeconds ?? 0, ...(prev.notionalCostUsd ? { notionalCostUsd: prev.notionalCostUsd } : {}), ...(prev.billing ? { billing: prev.billing } : {}), ...(prev.resultText ? { resultText: prev.resultText } : {}), ...(prev.limit ? { limit: prev.limit } : {}), ...(prev.resetAt ? { resetAt: prev.resetAt } : {}), ...(prev.orchestrateWrites ? { orchestrateWrites: prev.orchestrateWrites } : {}) }, ...(prev.adopted ? { adopted: true } : {}) };
  }

  const workerLife = await getLifecycle(c.db, workerId);
  if (!workerLife) throw new Error(`Worker ${workerId} not found`);
  const workerContext = JSON.parse(workerLife.context as string) as WorkerContext & {
    idemKey?: string;
  };
  // The machine is where provisionWorker made it (recorded on the worker): its profile's sandbox, else the run's.
  const own = params.machine?.sandbox ?? null;
  const { provider, sandbox } = await providerForAgent(scopeRunId, own ?? (workerContext as { sandbox?: string }).sandbox ?? null);
  const runSource = withSandbox(process.env, sandbox);
  const vmKey = workerContext.idemKey ?? `relay-worker-${workerId}`;
  // ADR-026 §5 path 2: this attempt's machine is the agent's parked one, woken (its checkout and session are there).
  const woke = !!(workerContext as WorkerContext).woke && !!params.continued;
  // The run's idle machine lifetime: the VM's delete deadline, renewed while the agent runs.
  const lifeSeconds = await agentIdleLifetime(scopeRunId, own, sandbox);

  // Acquire the push lock (or wait out a live push by another call).
  await c.db.execute(PUSH_LOCKS_SQL);
  const holder = crypto.randomUUID();
  let takeover = false;
  for (let waited = 0; ; waited += 500) {
    const done = await c.db.execute("SELECT event FROM lifecycle_events WHERE idem_key = ?", idemKey);
    if (done.length) {
      let prev: { sha?: string; costUsd?: number; notionalCostUsd?: number; billing?: string; resultText?: string; turns?: number; wallSeconds?: number; adopted?: boolean; limit?: string; resetAt?: number; orchestrateWrites?: unknown } = {};
      try { prev = JSON.parse(String(done[0]!.event)); } catch {}
      return { workerId, taskId, pushed: true, already: true, sha: prev.sha ?? "", costUsd: 0, recorded: { costUsd: prev.costUsd ?? 0, turns: prev.turns ?? 0, wallSeconds: prev.wallSeconds ?? 0, ...(prev.notionalCostUsd ? { notionalCostUsd: prev.notionalCostUsd } : {}), ...(prev.billing ? { billing: prev.billing } : {}), ...(prev.resultText ? { resultText: prev.resultText } : {}), ...(prev.limit ? { limit: prev.limit } : {}), ...(prev.resetAt ? { resetAt: prev.resetAt } : {}), ...(prev.orchestrateWrites ? { orchestrateWrites: prev.orchestrateWrites } : {}) }, ...(prev.adopted ? { adopted: true } : {}) };
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

  // The run's repository (recorded at `run new`), so an engine without CAPCOMD_REPO still clones the right one.
  const cfg = await (await import("../merge/run-config")).mergeConfigFor(scopeRunId);
  const setup = agentSetup(params.agent, params.agentSpec, runSource, params.machine, cfg?.remote);
  recordWorkerVm(c, { idemKey: vmKey, sandbox: sandbox ?? (workerContext as { sandbox?: string }).sandbox, runId: params.runId, workerId, ttlSeconds: lifeSeconds });
  // Getting it ready is its activity (kind setup) until its CLI's first event: its machine, its workspace (the
  // repository's copy as it goes), its CLI. A spawned agent's only (its row is where the activity lives).
  const prep = isRealAgent(setup.kind) && params.runId && workerId.startsWith("agt-")
    ? (() => { const s = (c as any).client().scope.getOrCreate([params.runId]); return setupReporter((a) => s.setActivity({ agentId: workerId, activity: a })); })() : null;
  prep?.report({ phase: "machine" });
  const { id: vmId } = await provider.ensure({
    idemKey: vmKey,
    isolated: true,
    ttlSeconds: lifeSeconds,
    egressAllow: setup.egressAllow,
    ...setup.snapshot,
    ...(params.machine?.size ? { size: params.machine.size } : {}),
    labels: { workerId, taskId, epoch: String(epoch) },
  }).catch((error) => {
    if (sandboxAuthError(error)) throw new UserError((error as Error).message, { code: "sandbox_auth", metadata: { kind: "config", retryable: false } });
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
  let orchestrateWrites: import("../agents/runner").OrchestrateWrites | undefined; // §16.1: an orchestrate agent wrote files (it fails)
  let sleptMs = 0; // ADR-026: time its CLI slept between turns (a wake pending): not wall time
  let adopted = false;
  const agent = setup.kind;
  // Takeover: a push that reached the remote before its holder died is adopted, not redone.
  if (takeover && cfg) {
    const remote = await remoteBranchSha(cfg.remote, branch).catch(() => null);
    if (remote) { sha = remote; adopted = true; }
  }
  const pushStarted = Date.now();
  const fakeDelay = Number(process.env.CAPCOMD_FAKE_PUSH_DELAY_MS ?? 0);
  if (adopted) {
    // nothing to run: the branch is already on the remote (and nothing was set up: no setup line stays behind)
    if (prep) { prep.stop(); await (c as any).client().scope.getOrCreate([params.runId]).setActivity({ agentId: workerId, activity: null }).catch(() => {}); }
  } else if (isRealAgent(agent)) {
    // Real worker: the agent edits the repo in the VM, commits with trailers, pushes the task branch.
    if (!cfg) throw new Error(`CAPCOMD_AGENT=${agent} needs a repo: set CAPCOMD_REPO`);
    if (!params.runId) throw new Error(`pushBranch needs runId for ${agent}`);
    const adapter = adapterFor(agent);
    const templates = await templateHooks(provider, runSource, cfg, setup, scopeRunId);
    // Optional: with a boxd host-bound secret the VM holds a bxds_ placeholder and this is unused.
    const apiKey = process.env[adapter.secretName];
    const runId = params.runId;
    // ADR-019 §1: liveness is reported up by the in-VM supervisor (or, without one, the agent CLI's own events), for
    // every agent, so one that can't spawn isn't flagged stuck while it works. Checkpoints are recorded too.
    const scope = workerId.startsWith("agt-") ? (c as any).client().scope.getOrCreate([runId]) : null;
    let pauseAsked = false;
    const beatEvery = heartbeatEveryMs();
    let beatAt = 0;
    /** The stuck notice the runner raised and hasn't cleared (ADR-019 §2). */
    let raised: string | null = null;
    // What it is doing now (harness.v1 Agent.activity): classified from its events, written at most once a second.
    // Each finished step goes into its history too (agent.step), unthrottled; the last one when it ends (not on a cancel).
    // Each step it is seen taking is one its background jobs' afterTurnMs counts from (plugin API §16.2 rule 2).
    const activity = scope ? activityReporter((a) => scope.setActivity({ agentId: workerId, activity: a }), { onStep: (st) => scope.recordStep({ agentId: workerId, ...st }), onSeen: (at) => noteStep(runId, workerId, at) }) : null;
    let cancelSeen = false;
    // Its thread (harness.v1 thread items), written in order; flushed before the agent is reported finished. Agents
    // that may spawn get one too: the spool pump forwards only their capcomd calls, not their own events.
    const items = scope ? itemWriter(scope, workerId) : null;
    const attempt = (fromThread: boolean) => runAgent(adapter, provider, vmId, {
      runId, taskId, epoch, branch: params.review?.branch ?? branch, target: params.review?.target ?? params.target ?? cfg.target, repoUrl: cfg.remote,
      goal: params.goal ?? `Task ${taskId}`, ...(params.title ? { title: params.title } : {}), rework: params.rework, ...(params.resumed ? { resumed: true } : {}), ...(params.continued ? { continued: true } : {}), ...(params.from ? { from: params.from } : {}), ...(params.review ? { review: params.review } : {}),
      // A consolidator works as a reporting agent does (a read-only checkout of the target; nothing kept or pushed), with its own prompt.
      ...(params.report || params.consolidate ? { report: true } : {}), ...(params.consolidate ? { consolidate: params.consolidate } : {}),
      ...(workerId.startsWith("agt-") ? { agentId: workerId, parentAgentId: params.parentAgentId ?? null } : {}), conflictFiles: params.conflictFiles,
    }, setup.config!, {
      apiKey,
      // The host fetches and pushes the agent's checkout through its mirror of the run's repository (§11.7).
      hostGit: { workdir: cfg.workdir },
      // A container per agent (Docker): the env image's warm template can be its workspace, used in place; a VM per
      // agent (boxd) the same from its project's template, when it booted from one (the runner reads its marker).
      warmTemplate: sandboxCaps(runSource).isolation === "container" ? true : sandboxCaps(runSource).isolation === "vm" ? "vm" : false,
      ...(templates ? { onWorkspace: templates.onWorkspace } : {}),
      // ADR-026 §5: a continued attempt picks up its conversation: its saved session (path 3), else its thread (path 4).
      ...(params.continued && scope ? { continuation: continueHooks(scope, { runId, agentId: workerId, provider, machineId: vmId, fromThread, ...(woke ? { parked: true } : {}), onLog: (lines) => { scope.appendLog({ agentId: workerId, stream: "agent", lines }).catch(() => {}); } }) } : {}),
      ...(woke ? { parked: true } : {}),
      heartbeatMs: beatEvery,
      vmTtlSeconds: lifeSeconds,
      onRenew: (secs) => { renewWorkerLease(c.db, workerId, Date.now() + secs * 1000).catch(() => {}); },
      onReport: (rep) => {
        if (!scope) return;
        if (rep.type === "checkpoint") { scope.checkpoint({ agentId: workerId, ref: rep.ref, sha: rep.sha, reason: rep.reason, files: rep.files }).catch(() => {}); return; }
        // Plugin API §16.4: its files changed, or it waits on a foreground command (the runner says so once a heartbeat).
        if (rep.type === "worked") { scope.worked({ agentId: workerId, files: rep.files, commandSince: rep.commandSince }).catch(() => {}); return; }
        if (Date.now() - beatAt < beatEvery) return;
        beatAt = Date.now();
        scope.heartbeat({ agentId: workerId }).catch(() => {});
      },
      // Clearing takes away only the kind the runner raised: a plugin's notice (the watchdog's `stalled`) stays.
      onNotice: (n) => {
        const only = n ? null : raised;
        raised = n?.kind ?? null;
        if (n || only) scope?.notice({ agentId: workerId, notice: n, ...(only ? { only } : {}) }).catch(() => {});
      },
      // Its first event ends its setup: its own activity takes over.
      ...(activity ? { onEvent: (ev: import("../agents/types").AgentEvent) => { prep?.stop(); activity.event(ev); } } : {}),
      ...(prep ? { onSetup: prep.report } : {}),
      ...(scope ? { onSpend: async (spent: { usd: number; turns: number; wallSeconds: number }, inboxAfter?: number) => (await scope.reportSpend({ agentId: workerId, spent, ...(inboxAfter !== undefined ? { inboxAfter } : {}) })) as { stop: string | null; grantedAt?: number; used?: number | null; messages?: { seq: number; from: string; body: string; skills?: AttachedSkill[] }[] } } : {}),
      // ADR-026 §3: its mailbox, pushed (the scope's messagesChanged), with the durable delivery cursor.
      ...(scope ? { messages: {
        pull: async (after: number) => (await scope.pullMessages({ agentId: workerId, after })) as { seq: number; from: string; body: string; skills?: AttachedSkill[]; nextTurn?: boolean }[],
        delivered: (seq: number) => { scope.messagesDelivered({ agentId: workerId, seq }).catch(() => {}); },
        subscribe: (onChange: () => void) => {
          try {
            const conn: any = scope.connect();
            conn.on("messagesChanged", (d: { to?: unknown }) => { if (!Array.isArray(d?.to) || d.to.includes(workerId)) onChange(); });
            // A (re)connect may have missed a push: look once.
            conn.onOpen?.(onChange);
            conn.onError?.(() => {});
            return () => { try { void conn.dispose?.(); } catch { /* gone */ } };
          } catch { return () => {}; } // no push: the runner's slow look delivers
        },
      } } : {}),
      // Every agent's tool calls, refusals and words; one with the in-VM capcomd also gets a `[capcomd] <op> → …` line per
      // capcomd call from its spool pump (driver.ts).
      ...(scope ? { onLog: (lines: string[]) => { scope.appendLog({ agentId: workerId, stream: "agent", lines }).catch(() => {}); } } : {}),
      ...(items ? { onItems: items } : {}),
      ...(params.subagents ? { subagents: { ...(params.subagents.skill ? { skill: params.subagents.skill } : {}), cliSource: VM_CLI_SOURCE, rpcDir: params.subagents.rpcDir ?? "/tmp/capcomd-rpc", ...(params.subagents.maySpawn === false ? { maySpawn: false } : {}) } } : {}),
      // agents.title: an agent without the in-VM capcomd (a reviewer, a report agent, the consolidator) names its tab
      // with a local shim; its `capcomd title …` calls, read from its tool calls, are its own renames (rate limited like
      // any; a refusal goes to its log).
      ...(scope && !params.subagents ? {
        naming: { shimSource: TITLE_SHIM_SOURCE, skill: namingSkill({ mcp: false }) },
        onTitle: (t: { title: string; callId: string }) => {
          scope.setTitle({ agentId: workerId, title: t.title, by: "self", setBy: workerId, key: `call:${t.callId}` })
            .catch((e: Error) => scope.appendLog({ agentId: workerId, stream: "agent", lines: [`[capcomd] title not recorded: ${String(e?.message ?? e).slice(0, 300)}`] }).catch(() => {}));
        },
      } : {}),
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
    });
    const res = await attempt(false)
      // ADR-026 §5 path 4: the session it was to continue wasn't there for its CLI after all: a fresh one from its thread.
      .catch((e) => { if (e instanceof SessionMissingError && params.continued && scope) return attempt(true); throw e; })
      .finally(async () => { prep?.stop(); if (cancelSeen) activity?.stop(); else await activity?.finish(); await items?.flush(); });
    sha = res.sha;
    costUsd = res.costUsd;
    turns = res.turns;
    billing = res.billing;
    notionalCostUsd = res.notionalCostUsd ?? 0;
    resultText = res.resultText;
    limit = res.limit;
    resetAt = res.resetAt;
    orchestrateWrites = res.orchestrateWrites;
    sleptMs = res.sleptMs ?? 0;
    // The `capcomd run` recipe has no stopped state: its task fails, with the work kept on the branch.
    if (limit && !workerId.startsWith("agt-")) throw new UserError(`agent ${stoppedAt(limit)}; its work so far is on ${branch}`, { code: "limit", metadata: { kind: "limit" } });
  } else if (params.review || params.report || params.consolidate) {
    // Fake sandbox reviewer/reporter/consolidator: nothing to run or push (a scripted one declares its result itself).
  } else {
    if (fakeDelay > 0) await new Promise((r) => setTimeout(r, fakeDelay)); // test knob: a slow push
    if (process.env.CAPCOMD_FAKE_PUSH_FAIL) throw new Error(process.env.CAPCOMD_FAKE_PUSH_FAIL); // test knob: a push that always fails
    // The fake sandbox's push step: one exec that answers (or doesn't, in an injected outage). No git runs in a
    // sandbox with credentials (plugin API §11.7); the task's commit is made on this host below.
    const { gitSpan } = await import("../merge/transfer");
    await gitSpan("push", branch, () => provider.exec(vmId, ["sh", "-c", `: push ${branch}`]));
  }

  // In-memory sandbox + a configured repo: produce the task's commit on the orchestrator host
  // (a real VM pushes its own branch). Idempotent: an already-pushed branch is reused. Never for a real orchestrate agent
  // (plugin API §16.1): it has no work of its own, on a fake sandbox either.
  const orchestrated = isRealAgent(agent) && setup.config?.toolMode === "orchestrate";
  if (!sha && !params.review && !params.report && !params.consolidate && !orchestrated && cfg && (sandbox ? sandbox.startsWith("fake") : getDependencies().fakeWork) && params.runId) {
    sha = await produceFakeWork(cfg, { runId: params.runId, taskId, branch, target: params.target ?? cfg.target, epoch, rework: params.rework, ...(params.fakePath ? { path: params.fakePath, content: params.fakeContent ?? "" } : {}) });
  }

  killpoint("push.after.before_event");
  const wallSeconds = Math.max(0, Math.round((Date.now() - pushStarted - sleptMs) / 100) / 10);

  await c.db.transaction(async (tx: RawAccess) => {
    await transitionLifecycle(
      tx,
      workerId,
      "worker",
      workerLife.state,
      { ...workerContext, vmId },
      { type: "PUSHED", taskId, epoch, branch, sha, costUsd, turns, wallSeconds, ...(notionalCostUsd ? { notionalCostUsd } : {}), ...(billing ? { billing } : {}), ...(resultText ? { resultText } : {}), ...(limit ? { limit } : {}), ...(resetAt ? { resetAt } : {}), ...(orchestrateWrites ? { orchestrateWrites } : {}), ...(adopted ? { adopted: true } : {}), ...(setup.record ? { agent: setup.record } : {}) },
      idemKey
    );
    await tx.execute("UPDATE push_locks SET state = 'done', sha = ?, adopted = ?, until = 0, updated_at = ? WHERE idem_key = ?", sha || null, adopted ? 1 : 0, Date.now(), idemKey);
  }, { name: "pushBranch" });

  return { workerId, taskId, pushed: true, already: false, sha, costUsd, turns, wallSeconds, adopted, ...(billing ? { billing } : {}), ...(notionalCostUsd ? { notionalCostUsd } : {}), ...(resultText ? { resultText } : {}), ...(limit ? { limit } : {}), ...(resetAt ? { resetAt } : {}), ...(orchestrateWrites ? { orchestrateWrites } : {}) };
  } catch (error) {
    // Release so a retry can take over at once (the attempt count records the retry).
    await c.db.execute("UPDATE push_locks SET until = 0, updated_at = ? WHERE idem_key = ? AND holder = ?", Date.now(), idemKey, holder).catch(() => {});
    // rivetkit masks plain errors as "An internal error occurred": surface the (redacted) cause.
    throw pushError(error);
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

  actions: {
    // ADR-022: the step wake (agent-workflow.ts STEP_WAKE_MS), and a waiting agent's ask for a slot on a place with a
    // memory cap (src/providers/capacity.ts), every few seconds: untraced.
    ...(WORKFLOW ? { ...stepWakeActions, async admitStart(c: any, params: StartAgent) { return admitStart(c, params); } } : {}),
    ...traceActions("worker", {
    /** Push lock rows (attempts, adopted, state) for audits and tests of a takeover. */
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
        /** Legacy runs have no scope actor and use the daemon settings. */
        scopeBacked?: false;
        /** Agent profile name (.capcomd/agents.json) for this worker's task. */
        agent?: string;
        /** The spec the agent was spawned with (its scope record): wins over `agent` looked up by name. */
        agentSpec?: Record<string, unknown> | null;
        /** What its profile pinned for its machine (ADR-024 `sandbox.*`): every agent's, a scripted one's too. */
        machine?: ProfileMachine;
        /** ADR-026 §5 path 2: the agent's parked machine (src/agents/continue.ts `parkedMachine`), to wake and use
         *  instead of making one: its key, its id, and the worker that parked it. */
        parked?: { idemKey: string; vmId: string; workerKey: string[] };
      }
    ) {
      const { workerId, runId, epoch } = params;
      const scopeRunId = params.scopeBacked === false ? undefined : runId;
      return withOutageListener(outageNotice(() => c.client(), runId, workerId), async () => {
      // Its profile's sandbox (ADR-024 `sandbox.provider`), else the run's, else the daemon's.
      const own = params.machine?.sandbox ?? null;
      const { provider, sandbox } = await providerForAgent(scopeRunId, own);
      const runSource = withSandbox(process.env, sandbox);
      // The run's idle machine lifetime (recorded at `run new`), else its place's current setting.
      const lifeSeconds = await agentIdleLifetime(scopeRunId, own, sandbox);

      const existing = await getLifecycle(c.db, workerId);
      if (existing && existing.state !== "provisioning" && existing.state !== "failed") {
        const ctx = JSON.parse(existing.context as string);
        return { workerId, vmId: ctx.vmId as string, state: existing.state };
      }
      // The run's repository, as recorded at `run new`: its project's template, when the place keeps them.
      const repo = (await (await import("../merge/run-config")).mergeConfigFor(scopeRunId))?.remote;
      const setup = agentSetup(params.agent, params.agentSpec, runSource, params.machine, repo);

      // ADR-026 §5 path 2: the agent's parked machine, woken, is this attempt's (its key carried over, not one derived
      // from the epoch); else (none, gone, or it wouldn't wake) a fresh one.
      const woken = !existing && params.parked ? await takeParked(c, { workerId, runId, provider, sandbox, parked: params.parked }) : null;
      const idemKey =
        existing && JSON.parse(existing.context as string).idemKey
          ? (JSON.parse(existing.context as string).idemKey as string)
          : woken?.idemKey ?? agentVmIdemKey(runId, workerId, epoch);

      if (!existing) {
        const [snapshot] = initialTransition(workerMachine, {
          workerId,
          createdAt: Date.now(),
          ttlMs: lifeSeconds * 1000,
          idemKey,
          ...(sandbox ? { sandbox } : {}),
          ...(woken ? { woke: true } : {}),
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

      let madeVm: string | undefined;
      try {
        recordWorkerVm(c, { idemKey, sandbox, runId, workerId, ttlSeconds: lifeSeconds });
        killpoint("vm.create.after_request.before_record");

        const { id: vmId } = await provider.ensure({
          idemKey,
          isolated: true,
          ttlSeconds: lifeSeconds,
          egressAllow: setup.egressAllow,
          ...setup.snapshot,
          ...(params.machine?.size ? { size: params.machine.size } : {}),
          labels: {
            runId,
            workerId,
            epoch: epoch.toString(),
          },
        });

        madeVm = vmId;
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
          ...(madeVm ? { vmId: madeVm } : {}),
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
        if (sandboxAuthError(error)) throw new UserError((error as Error).message, { code: "sandbox_auth", metadata: { kind: "config", retryable: false } });
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

    /** ADR-026 §6: park the machine instead of destroying it (see parkWorkerImpl); `parked: false` when it couldn't. */
    async parkWorker(c, params: { workerId: string; retentionSeconds: number; runId?: string }) {
      return parkWorkerImpl(c, params);
    },

    /**
     * ADR-026 §5 path 2: the agent's next attempt takes this worker's parked machine. This worker owns it no more
     * (`released`: its alarm and any delete leave the machine alone). null when it isn't parked (deleted meanwhile).
     */
    async handOver(c, params: { workerId: string; to: string }) {
      const life = await getLifecycle(c.db, params.workerId);
      if (!life || life.state !== "parked") return null;
      const ctx: WorkerContext & { idemKey?: string; sandbox?: string } = JSON.parse(life.context);
      if (!ctx.vmId || !ctx.idemKey) return null;
      const event = { type: "HANDED_OVER" as const, to: params.to };
      const [next] = transition(workerMachine, workerMachine.resolveState({ value: life.state, context: ctx }), event);
      await c.db.transaction(async (tx: RawAccess) => {
        await transitionLifecycle(tx, params.workerId, "worker", next.value as string, next.context, event, `worker-${params.workerId}-handover-${params.to}`);
      }, { name: "handOver" });
      return { vmId: ctx.vmId, idemKey: ctx.idemKey, sandbox: ctx.sandbox ?? null };
    },

    /**
     * ADR-026 §6: delete this worker's parked machine (its retention ran out, its place had too many parked, its run was
     * archived, its agent cancelled, the user's Delete). Nothing when it isn't parked (woken, or already deleted).
     */
    async dropParked(c, params: { workerId: string; cause: Exclude<DeleteCause, "action"> }) {
      const life = await getLifecycle(c.db, params.workerId);
      if (!life || life.state !== "parked") return { dropped: false, state: life?.state ?? null };
      const r = await drainWorkerImpl(c, params.workerId, params.cause);
      return { dropped: r.destroyed, ...(r.retrying ? { retrying: true } : {}), state: "draining" };
    },

    /** The worker's own alarm: a drain whose destroy the provider didn't answer, tried again (see drainWorkerImpl). */
    async retryDrain(c, params: { workerId: string; cause?: Exclude<DeleteCause, "action">; retry: number }) {
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
      if (!life || life.state === "destroyed" || life.state === "released") return { reaped: false, state: life?.state ?? null };
      const ctx = JSON.parse(life.context as string);
      const expired = (params.now ?? Date.now()) >= await workerDeadline(c.db, params.workerId, ctx);
      if (!params.terminal && !expired) return { reaped: false, state: life.state };
      await drainWorkerImpl(c, params.workerId, params.terminal ? "run_ended" : life.state === "parked" ? "retention" : "idle_lifetime");
      return { reaped: true, reason: params.terminal ? "terminal" : "ttl" };
    },

    async reapIfExpired(c, params: { workerId: string }) {
      const life = await getLifecycle(c.db, params.workerId);
      if (!life || life.state === "destroyed" || life.state === "released") return { reaped: false };
      const ctx = JSON.parse(life.context as string);
      const deadline = await workerDeadline(c.db, params.workerId, ctx);
      // Renewed while its agent ran (or parked since: its retention): look again at the new deadline.
      if (Date.now() < deadline) { await c.schedule.at(deadline, "reapIfExpired", { workerId: params.workerId }); return { reaped: false }; }
      await drainWorkerImpl(c, params.workerId, life.state === "parked" ? "retention" : "idle_lifetime");
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
  },
});
