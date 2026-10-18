import { traceActions } from "../utils/tracing-simple";
import { actor } from "rivetkit";
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
import { killpoint } from "../utils/killpoint";
import { getDependencies } from "../dependencies";

export const workerActor = actor({
  db: db({
    onMigrate: async (database) => {
      await setupLifecycleTables(database);
    },
  }),

  actions: traceActions("worker", {
    async provisionWorker(
      c,
      params: {
        workerId: string;
        runId: string;
        epoch: number;
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

        await c.db.transaction(async (tx) => {
          await transitionLifecycle(
            tx,
            workerId,
            "worker",
            snapshot.value as string,
            snapshot.context,
            { type: "PROVISIONING" },
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
          ttlSeconds: 3600,
          egressAllow: ["github.com", "registry.npmjs.org"],
          labels: {
            runId,
            workerId,
            epoch: epoch.toString(),
          },
        });

        await provider.waitReady(vmId, 90_000);

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

        await c.db.transaction(async (tx) => {
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

        await c.db.transaction(async (tx) => {
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

      await c.db.transaction(async (tx) => {
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
      params: { workerId: string; taskId: string; epoch: number; branch: string }
    ) {
      const { workerId, taskId, epoch, branch } = params;
      const idemKey = `worker-${workerId}-push-${taskId}-e${epoch}`;
      const already = await c.db.execute(
        "SELECT idem_key FROM lifecycle_events WHERE idem_key = ?",
        idemKey
      );
      if (already.length > 0) {
        return { workerId, taskId, pushed: true, already: true };
      }

      const workerLife = await getLifecycle(c.db, workerId);
      if (!workerLife) throw new Error(`Worker ${workerId} not found`);
      const workerContext = JSON.parse(workerLife.context as string) as WorkerContext & {
        idemKey?: string;
      };
      const { provider } = getDependencies();
      const vmKey = workerContext.idemKey ?? `relay-worker-${workerId}`;

      killpoint("push.mid");

      const { id: vmId } = await provider.ensure({
        idemKey: vmKey,
        isolated: true,
        ttlSeconds: 3600,
        egressAllow: ["github.com", "registry.npmjs.org"],
        labels: { workerId, taskId, epoch: String(epoch) },
      });
      await provider.waitReady(vmId, 90_000);
      await provider.exec(vmId, ["git", "push", "origin", branch]);

      killpoint("push.after.before_event");

      await c.db.transaction(async (tx) => {
        await transitionLifecycle(
          tx,
          workerId,
          "worker",
          workerLife.state,
          { ...workerContext, vmId },
          { type: "PUSHED", taskId, epoch, branch, sha: "abc123" },
          idemKey,
          []
        );
      }, { name: "pushBranch" });

      return { workerId, taskId, pushed: true, already: false };
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
      return rows.map((row) => ({
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

      await c.db.transaction(async (tx) => {
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

    async drainWorker(
      c,
      params: { workerId: string }
    ) {
      const { workerId } = params;
      const { provider } = getDependencies();

      const workerLife = await getLifecycle(c.db, workerId);
      if (!workerLife) return;

      const workerContext: WorkerContext = JSON.parse(workerLife.context);
      const workerSnapshot = workerMachine.resolveState({
        value: workerLife.state,
        context: workerContext,
      });

      const drainEvent = { type: "DRAIN" as const };

      if (!workerSnapshot.can(drainEvent)) return;

      const [drainSnapshot] = transition(workerMachine, workerSnapshot, drainEvent);

      await c.db.transaction(async (tx) => {
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

        await c.db.transaction(async (tx) => {
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
