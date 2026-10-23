import { readFileSync } from "fs";
import { redactShapes } from "../agents/redact";
import type { RawAccess } from "rivetkit/db";
import { traceActions } from "../utils/tracing-simple";
import { actor, UserError } from "rivetkit";
import { isBoxdAuthError } from "../providers/boxd-errors";
import { db } from "rivetkit/db";
import { workerMachine, type WorkerContext } from "../machines/worker";
import { initialTransition, transition } from "xstate";
import {
  setupLifecycleTables,
  transitionLifecycle,
  getLifecycle,
  getUndispatchedOutbox,
  markOutboxDispatched,
} from "../utils/lifecycle";
import { produceFakeWork } from "../merge/fakework";
import { killpoint } from "../utils/killpoint";
import { getDependencies } from "../dependencies";
import { agentFromEnv, isRealAgent, loadAgentConfig } from "../agents/config";
import { AGENT_VM_TTL_SECONDS, runAgent, stoppedAt } from "../agents/runner";
import { heartbeatEveryMs } from "../subagents/results";
import { adapterFor } from "../agents/adapters";
import { resolveEnvSnapshot } from "../env/resolve";
import { profileFor } from "../auth/profiles";
import { effectiveAgentRecord } from "../agents/profiles";

const LEGACY_EGRESS = ["github.com", "registry.npmjs.org"];

// Push-in-progress lock (ADR-016): one persisted lock per push idempotency key. The action that
// holds it renews it while the agent runs. A caller that finds a live lock (e.g. a takeover driver
// whose predecessor died mid-push) waits for that push instead of starting a second one. A lock
// from a dead engine process (other instance id) or one past its lease can be taken over, and
// the new holder first checks the remote branch and adopts a push that already landed.
const ENGINE_INSTANCE = crypto.randomUUID();
const PUSH_LOCK_MS = () => Number(process.env.CAPCOMD_PUSH_LOCK_MS ?? 30_000);
const PUSH_LOCKS_SQL = `CREATE TABLE IF NOT EXISTS push_locks (
  idem_key TEXT PRIMARY KEY, holder TEXT NOT NULL, instance TEXT NOT NULL, until INTEGER NOT NULL,
  attempts INTEGER NOT NULL, state TEXT NOT NULL, adopted INTEGER NOT NULL DEFAULT 0, sha TEXT, updated_at INTEGER NOT NULL)`;

async function remoteBranchSha(remote: string, branch: string): Promise<string | null> {
  const p = Bun.spawn(["git", "ls-remote", remote, `refs/heads/${branch}`], { stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  if (code !== 0) throw new Error(`git ls-remote ${branch} failed (exit ${code})`);
  const sha = out.trim().split(/\s+/)[0];
  return sha && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}
/** claude-code VMs may reach only GitHub, the Anthropic API and the package registries the bootstrap needs. */
/** Real-agent VMs boot from the `capcomd env build` snapshot when one exists (else the default image). */
function snapshotSpec(profile?: string): { fromSnapshot?: string } {
  const agent = agentFromEnv(process.env, profile);
  if (!isRealAgent(agent)) return {};
  // Plan login (capcomd auth login): boot from the auth profile's snapshot when it has one.
  if (loadAgentConfig(process.env, profile).credentialMode === "subscription") {
    const prof = profileFor(agent);
    if (prof?.snapshot) return { fromSnapshot: prof.snapshot };
  }
  const snap = resolveEnvSnapshot();
  return snap ? { fromSnapshot: snap } : {};
}

function egressAllow(profile?: string): string[] {
  return isRealAgent(agentFromEnv(process.env, profile)) ? loadAgentConfig(process.env, profile).egress : LEGACY_EGRESS;
}


// Shared by drainWorker, reap and the TTL alarm. Idempotent and resumable.
async function drainWorkerImpl(c: any, workerId: string) {

            const { provider } = getDependencies();

      const workerLife = await getLifecycle(c.db, workerId);
      if (!workerLife) return;

      const workerContext: WorkerContext = JSON.parse(workerLife.context);
      const workerSnapshot = workerMachine.resolveState({
        value: workerLife.state,
        context: workerContext,
      });

      const drainEvent = { type: "DRAIN" as const };

      // Resume a drain that crashed after DRAIN but before VM_DESTROYED.
      const resuming = workerLife.state === "draining";
      if (!resuming && !workerSnapshot.can(drainEvent)) return;

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
          `worker-${workerId}-drain-${Date.now()}`,
          []
        );
      }, { name: "drain" });

      if (workerContext.vmId) {
        await provider.destroy(workerContext.vmId);

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
            `worker-${workerId}-destroyed-${Date.now()}`,
            []
          );
        }, { name: "vmDestroyed" });
      }
}

export const workerActor = actor({
  // A claude-code task runs for minutes inside pushBranch (install + agent + push).
  options: { actionTimeout: 60 * 60_000 },
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
      }
    ) {
      const { workerId, runId, epoch } = params;
      const { provider } = getDependencies();

      const existing = await getLifecycle(c.db, workerId);
      if (existing && existing.state !== "provisioning" && existing.state !== "failed") {
        const ctx = JSON.parse(existing.context as string);
        return { workerId, vmId: ctx.vmId as string, state: existing.state };
      }

      const idemKey =
        existing && JSON.parse(existing.context as string).idemKey
          ? (JSON.parse(existing.context as string).idemKey as string)
          : `relay-${runId.substring(0, 8)}-${workerId}-e${epoch}`;

      if (!existing) {
        const [snapshot] = initialTransition(workerMachine, {
          workerId,
          createdAt: Date.now(),
          ttlMs: 3_600_000,
          idemKey,
        });

        await c.db.transaction(async (tx: RawAccess) => {
          await transitionLifecycle(
            tx,
            workerId,
            "worker",
            snapshot.value as string,
            snapshot.context,
            { type: "PROVISIONING", ...(isRealAgent(agentFromEnv(process.env, params.agent)) ? { agent: effectiveAgentRecord(params.agent) } : {}) },
            `worker-${workerId}-provisioning`,
            [
              {
                type: "workerEvent",
                params: {
                  runId,
                  workerId,
                  event: { type: "WORKER_PROVISIONING", workerId },
                },
              },
            ]
          );
        }, { name: "provisionWorker" });
      }

      try {
        killpoint("vm.create.after_request.before_record");

        const { id: vmId } = await provider.ensure({
          idemKey,
          isolated: true,
          ttlSeconds: AGENT_VM_TTL_SECONDS,
          egressAllow: egressAllow(params.agent),
        ...snapshotSpec(params.agent),
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
            `worker-${workerId}-ready-${vmId}`,
            []
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
            `worker-${workerId}-failed`,
            []
          );
        }, { name: "vmFailed" });

        // Cross the actor boundary with a readable, typed error (plain errors are masked as "internal error").
        if (isBoxdAuthError(error)) throw new UserError((error as Error).message, { code: "sandbox_auth", metadata: { kind: "config", retryable: false } });
        throw error;
      }
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
          `worker-${workerId}-assign-${taskId}-${epoch}`,
          []
        );
      }, { name: "assignTask" });

      return { workerId, taskId, vmId: workerContext.vmId };
    },

    async pushBranch(
      c,
      params: {
        workerId: string; taskId: string; epoch: number; branch: string; runId?: string; parentAgentId?: string | null; target?: string; rework?: boolean; resumed?: boolean;
        /** Task goal for a real agent (claude-code). */
        goal?: string;
        /** ADR-017: scripted fake agent's declared file (fake sandbox only). */
        fakePath?: string; fakeContent?: string;
        /** ADR-017: install in-VM capcomd + skill (agents allowed to spawn). */
        subagents?: { skill: string; kind?: string };
        conflictFiles?: string[];
        /** Agent profile name for this task. */
        agent?: string;
        /** verify's reviewer: review this commit; nothing is committed or pushed. */
        review?: { sha: string; branch: string; target: string };
        /** Report mode: read-only work; the final message is the result, nothing is pushed. */
        report?: boolean;
      }
    ) {
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
      const { provider } = getDependencies();
      const vmKey = workerContext.idemKey ?? `relay-worker-${workerId}`;

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

      const { id: vmId } = await provider.ensure({
        idemKey: vmKey,
        isolated: true,
        ttlSeconds: AGENT_VM_TTL_SECONDS,
        egressAllow: egressAllow(params.agent),
        ...snapshotSpec(params.agent),
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
      const agent = agentFromEnv(process.env, params.agent);
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
        // Liveness from what the agent does, not what it says: its CLI's events (throttled) are its heartbeat, so an
        // agent without the in-VM capcomd (one that can't spawn) isn't flagged stuck while it works.
        const scope = workerId.startsWith("agt-") ? (c as any).client().scope.getOrCreate([runId]) : null;
        const beatEvery = heartbeatEveryMs();
        let beatAt = 0;
        const res = await runAgent(adapter, provider, vmId, {
          runId, taskId, epoch, branch: params.review?.branch ?? branch, target: params.review?.target ?? params.target ?? cfg.target, repoUrl: cfg.remote,
          goal: params.goal ?? `Task ${taskId}`, rework: params.rework, ...(params.resumed ? { resumed: true } : {}), ...(params.review ? { review: params.review } : {}), ...(params.report ? { report: true } : {}),
          ...(workerId.startsWith("agt-") ? { agentId: workerId, parentAgentId: params.parentAgentId ?? null } : {}), conflictFiles: params.conflictFiles,
        }, loadAgentConfig(process.env, params.agent), {
          apiKey,
          onEvent: () => {
            if (!scope || Date.now() - beatAt < beatEvery) return;
            beatAt = Date.now();
            scope.heartbeat({ agentId: workerId }).catch(() => {});
          },
          ...(scope ? { onSpend: async (spent: { usd: number; turns: number; wallSeconds: number }) => ((await scope.reportSpend({ agentId: workerId, spent })) as { stop: string | null }).stop } : {}),
          ...(params.subagents ? { subagents: { skill: params.subagents.skill, cliSource: readFileSync(new URL("../subagents/vm-cli.mjs", import.meta.url).pathname, "utf8"), rpcDir: "/tmp/capcomd-rpc" } } : {}),
          isCancelled: async () => {
            const run = await (c as any).client().run.getOrCreate([runId]).getRun({ runId });
            if (run?.state === "cancelled") return true;
            // Spawned agents (ADR-016): the worker id is the agent id in the run's scope actor.
            if (!workerId.startsWith("agt-")) return false;
            const a = await (c as any).client().scope.getOrCreate([runId]).getAgent({ agentId: workerId }).catch(() => null);
            return a?.status === "cancelled";
          },
        });
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
      if (!sha && !params.review && !params.report && cfg && getDependencies().fakeWork && params.runId) {
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
          { type: "PUSHED", taskId, epoch, branch, sha, costUsd, turns, wallSeconds, ...(notionalCostUsd ? { notionalCostUsd } : {}), ...(billing ? { billing } : {}), ...(resultText ? { resultText } : {}), ...(limit ? { limit } : {}), ...(resetAt ? { resetAt } : {}), ...(adopted ? { adopted: true } : {}), ...(isRealAgent(agentFromEnv(process.env, params.agent)) ? { agent: effectiveAgentRecord(params.agent) } : {}) },
          idemKey,
          []
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
        throw new UserError(redactShapes(String((error as Error)?.message ?? error)).slice(0, 2000), { code: kind, metadata: { kind } });
      } finally {
        clearInterval(renew);
      }
    },

    async flushOutbox(c, _params: Record<string, never>) {
      const pending = await getUndispatchedOutbox(c.db);
      for (const row of pending) {
        await markOutboxDispatched(c.db, row.id);
      }
      return { flushed: pending.length };
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
          `worker-${workerId}-done-${Date.now()}`,
          []
        );
      }, { name: "taskDone" });
    },

    async drainWorker(c, params: { workerId: string }) {
      await drainWorkerImpl(c, params.workerId);
    },

    /**
     * Idempotent reap. Destroys the sandbox when the caller says the run/task is
     * terminal, or when the worker is past its TTL. No-op once destroyed.
     */
    async reap(c, params: { workerId: string; terminal?: boolean; now?: number }) {
      const life = await getLifecycle(c.db, params.workerId);
      if (!life || life.state === "destroyed") return { reaped: false, state: life?.state ?? null };
      const ctx = JSON.parse(life.context as string);
      const expired = (params.now ?? Date.now()) >= Number(ctx.createdAt ?? 0) + Number(ctx.ttlMs ?? 3_600_000);
      if (!params.terminal && !expired) return { reaped: false, state: life.state };
      await drainWorkerImpl(c, params.workerId);
      return { reaped: true, reason: params.terminal ? "terminal" : "ttl" };
    },

    async reapIfExpired(c, params: { workerId: string }) {
      const life = await getLifecycle(c.db, params.workerId);
      if (!life || life.state === "destroyed") return { reaped: false };
      const ctx = JSON.parse(life.context as string);
      if (Date.now() < Number(ctx.createdAt ?? 0) + Number(ctx.ttlMs ?? 3_600_000)) return { reaped: false };
      await drainWorkerImpl(c, params.workerId);
      return { reaped: true, reason: "ttl" };
    },

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

  async onWake(c) {
    const pending = await getUndispatchedOutbox(c.db);
    for (const row of pending) {
      await markOutboxDispatched(c.db, row.id);
    }
  },
});
