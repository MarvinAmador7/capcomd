import type { RawAccess } from "rivetkit/db";
import { traceActions } from "../utils/tracing-simple";
import { isProtectedBranch } from "../utils/protected";
import type { MergeRecord } from "../machines/task";
import { actor } from "rivetkit";
import { db } from "rivetkit/db";
import { taskMachine, type TaskContext } from "../machines/task";
import { leaseMachine, type LeaseContext } from "../machines/lease";
import { initialTransition, transition } from "xstate";
import {
  setupLifecycleTables,
  transitionLifecycle,
  getLifecycle,
  getUndispatchedOutbox,
  markOutboxDispatched,
} from "../utils/lifecycle";
import { killpoint } from "../utils/killpoint";

const LEASE_TTL_MS = 24 * 60 * 60 * 1000;

export const taskBoardActor = actor({
  db: db({
    onMigrate: async (database) => {
      await setupLifecycleTables(database);
    },
  }),

  actions: traceActions("taskBoard", {
    async createTask(
      c,
      params: { taskId: string; goal: string; runId: string; maxRetries: number; targetBranch?: string }
    ) {
      const { taskId, goal, maxRetries, targetBranch } = params;

      const [snapshot] = initialTransition(taskMachine, {
        taskId,
        goal,
        maxRetries,
        ...(targetBranch ? { targetBranch } : {}),
      });

      await c.db.transaction(async (tx: RawAccess) => {
        await transitionLifecycle(
          tx,
          taskId,
          "task",
          snapshot.value as string,
          snapshot.context,
          { type: "CREATED" },
          `task-${taskId}-created`,
          []
        );
      }, { name: "createTask" });

      return { taskId, state: snapshot.value };
    },

    async grantLease(c, params: { taskId: string; workerId: string }) {
      const { taskId, workerId } = params;

      const taskLife = await getLifecycle(c.db, taskId);
      if (!taskLife) {
        throw new Error(`Task ${taskId} not found`);
      }

      const taskContext: TaskContext = JSON.parse(taskLife.context);
      const taskSnapshot = taskMachine.resolveState({
        value: taskLife.state,
        context: taskContext,
      });

      const event = {
        type: "LEASE_GRANTED" as const,
        epoch: taskContext.epoch + 1,
        workerId,
      };

      if (!taskSnapshot.can(event)) {
        throw new Error(`Task ${taskId} cannot accept LEASE_GRANTED from state ${taskLife.state}`);
      }

      const [newSnapshot] = transition(taskMachine, taskSnapshot, event);

      const leaseId = `${taskId}-lease`;
      const leaseLife = await getLifecycle(c.db, leaseId);
      
      let leaseSnapshot;
      if (leaseLife) {
        const leaseContext: LeaseContext = JSON.parse(leaseLife.context);
        leaseSnapshot = leaseMachine.resolveState({
          value: leaseLife.state,
          context: leaseContext,
        });
      } else {
        [leaseSnapshot] = initialTransition(leaseMachine, {
          taskId,
          ttlMs: LEASE_TTL_MS,
        });
      }

      const leaseEvent = {
        type: "GRANT" as const,
        workerId,
        now: Date.now(),
      };

      const [newLeaseSnapshot] = transition(leaseMachine, leaseSnapshot, leaseEvent);

      await c.db.transaction(async (tx: RawAccess) => {
        await transitionLifecycle(
          tx,
          taskId,
          "task",
          newSnapshot.value as string,
          newSnapshot.context,
          event,
          `task-${taskId}-lease-${event.epoch}`,
          [
            {
              type: "taskEvent",
              params: {
                runId: taskContext.runId,
                taskId,
                event: { type: "LEASE_GRANTED", taskId, epoch: event.epoch, workerId },
              },
            },
          ]
        );

        await transitionLifecycle(
          tx,
          leaseId,
          "lease",
          newLeaseSnapshot.value as string,
          newLeaseSnapshot.context,
          leaseEvent,
          `lease-${leaseId}-grant-${newLeaseSnapshot.context.epoch}`,
          [
            {
              type: "leaseEvent",
              params: {
                runId: taskContext.runId,
                leaseId,
                event: { type: "LEASE_GRANTED", leaseId, epoch: newLeaseSnapshot.context.epoch, workerId },
              },
            },
          ]
        );
      }, { name: "grantLease" });

      const expiresAt = newLeaseSnapshot.context.expiresAt!;
      await c.schedule.at(expiresAt, "expireLease", { taskId });

      return {
        taskId,
        workerId,
        epoch: newSnapshot.context.epoch,
        expiresAt,
      };
    },

    async heartbeat(c, params: { taskId: string; epoch: number }) {
      const { taskId, epoch } = params;
      const leaseId = `${taskId}-lease`;

      const leaseLife = await getLifecycle(c.db, leaseId);
      if (!leaseLife) {
        return { accepted: false, reason: "Lease not found" };
      }

      const leaseContext: LeaseContext = JSON.parse(leaseLife.context);
      const leaseSnapshot = leaseMachine.resolveState({
        value: leaseLife.state,
        context: leaseContext,
      });

      const event = {
        type: "HEARTBEAT" as const,
        epoch,
        now: Date.now(),
      };

      if (!leaseSnapshot.can(event)) {
        return { accepted: false, reason: `Lease in state ${leaseLife.state}, epoch mismatch` };
      }

      const [newSnapshot] = transition(leaseMachine, leaseSnapshot, event);

      await c.db.transaction(async (tx: RawAccess) => {
        await transitionLifecycle(
          tx,
          leaseId,
          "lease",
          newSnapshot.value as string,
          newSnapshot.context,
          event,
          `lease-${leaseId}-hb-${epoch}-${Date.now()}`,
          []
        );
      }, { name: "heartbeat" });

      const expiresAt = newSnapshot.context.expiresAt!;
      await c.schedule.at(expiresAt, "expireLease", { taskId });

      return { accepted: true, expiresAt };
    },

    async workerStarted(
      c,
      params: {
        taskId: string;
        epoch: number;
        branch?: string;
        commitSha?: string;
      }
    ) {
      const { taskId, epoch } = params;

      const taskLife = await getLifecycle(c.db, taskId);
      if (!taskLife) {
        throw new Error(`Task ${taskId} not found`);
      }

      const taskContext: TaskContext = JSON.parse(taskLife.context);
      const taskSnapshot = taskMachine.resolveState({
        value: taskLife.state,
        context: taskContext,
      });

      const event = { type: "WORKER_STARTED" as const, epoch };

      if (!taskSnapshot.can(event)) {
        throw new Error(`Task ${taskId} cannot WORKER_STARTED from state ${taskLife.state}`);
      }

      const [newSnapshot] = transition(taskMachine, taskSnapshot, event);

      await c.db.transaction(async (tx: RawAccess) => {
        await transitionLifecycle(
          tx,
          taskId,
          "task",
          newSnapshot.value as string,
          newSnapshot.context,
          event,
          `task-${taskId}-worker-started-${epoch}`,
          []
        );
      }, { name: "workerStarted" });

      return { taskId, state: newSnapshot.value as string };
    },

    async handoffTask(
      c,
      params: {
        taskId: string;
        epoch: number;
        branch?: string;
        commitSha?: string;
      }
    ) {
      const { taskId, epoch } = params;

      const taskLife = await getLifecycle(c.db, taskId);
      if (!taskLife) {
        throw new Error(`Task ${taskId} not found`);
      }

      const taskContext: TaskContext = JSON.parse(taskLife.context);
      const taskSnapshot = taskMachine.resolveState({
        value: taskLife.state,
        context: taskContext,
      });

      const event = { type: "HANDOFF" as const, epoch, branch: params.branch ?? "", commitSha: params.commitSha ?? "" };

      if (!taskSnapshot.can(event)) {
        throw new Error(`Task ${taskId} cannot HANDOFF from state ${taskLife.state}`);
      }

      const [newSnapshot] = transition(taskMachine, taskSnapshot, event);

      await c.db.transaction(async (tx: RawAccess) => {
        await transitionLifecycle(
          tx,
          taskId,
          "task",
          newSnapshot.value as string,
          newSnapshot.context,
          event,
          `task-${taskId}-handoff-${epoch}`,
          []
        );
      }, { name: "handoffTask" });

      return { taskId, state: newSnapshot.value as string };
    },

    async startVerify(
      c,
      params: {
        taskId: string;
      }
    ) {
      const { taskId } = params;

      const taskLife = await getLifecycle(c.db, taskId);
      if (!taskLife) {
        throw new Error(`Task ${taskId} not found`);
      }

      const taskContext: TaskContext = JSON.parse(taskLife.context);
      const taskSnapshot = taskMachine.resolveState({
        value: taskLife.state,
        context: taskContext,
      });

      const event = { type: "VERIFY_STARTED" as const };

      if (!taskSnapshot.can(event)) {
        throw new Error(`Task ${taskId} cannot VERIFY_STARTED from state ${taskLife.state}`);
      }

      const [newSnapshot] = transition(taskMachine, taskSnapshot, event);

      await c.db.transaction(async (tx: RawAccess) => {
        await transitionLifecycle(
          tx,
          taskId,
          "task",
          newSnapshot.value as string,
          newSnapshot.context,
          event,
          `task-${taskId}-verify-start-${Date.now()}`,
          []
        );
      }, { name: "startVerify" });

      return { taskId, state: newSnapshot.value as string };
    },

    async verifyComplete(
      c,
      params: {
        taskId: string;
        passed: boolean;
        commitSha?: string;
        /** Effective target (run's or repo default). Protection is decided on this. */
        target?: string;
        /** Present when the merge already happened (unprotected target). */
        merge?: MergeRecord;
      }
    ) {
      const { taskId, passed, commitSha, merge } = params;

      const taskLife = await getLifecycle(c.db, taskId);
      if (!taskLife) {
        throw new Error(`Task ${taskId} not found`);
      }

      const taskContext: TaskContext = JSON.parse(taskLife.context);
      const taskSnapshot = taskMachine.resolveState({
        value: taskLife.state,
        context: taskContext,
      });

      const target = params.target ?? taskContext.targetBranch;
      const needsApproval = passed && !merge && isProtectedBranch(target);
      const event = !passed
        ? { type: "VERIFY_FAILED" as const }
        : needsApproval
          ? { type: "VERIFIED_AWAITING_APPROVAL" as const, commitSha, targetBranch: target }
          : { type: "VERIFIED_AND_MERGED" as const, commitSha, merge };

      if (!taskSnapshot.can(event)) {
        throw new Error(`Task ${taskId} cannot accept ${event.type} from state ${taskLife.state}`);
      }

      const [newSnapshot] = transition(taskMachine, taskSnapshot, event);

      await c.db.transaction(async (tx: RawAccess) => {
        await transitionLifecycle(
          tx,
          taskId,
          "task",
          newSnapshot.value as string,
          newSnapshot.context,
          event,
          `task-${taskId}-verify-${Date.now()}`,
          []
        );
      }, { name: "verifyComplete" });

      return { taskId, state: newSnapshot.value as string };
    },

    async expireLease(c, params: { taskId: string }) {
      const { taskId } = params;

      killpoint("lease.expire.mid");

      const taskLife = await getLifecycle(c.db, taskId);
      if (!taskLife) return;

      const taskContext: TaskContext = JSON.parse(taskLife.context);
      const taskSnapshot = taskMachine.resolveState({
        value: taskLife.state,
        context: taskContext,
      });

      const event = { type: "LEASE_EXPIRED" as const };

      if (!taskSnapshot.can(event)) {
        return;
      }

      const [newSnapshot] = transition(taskMachine, taskSnapshot, event);

      await c.db.transaction(async (tx: RawAccess) => {
        await transitionLifecycle(
          tx,
          taskId,
          "task",
          newSnapshot.value as string,
          newSnapshot.context,
          event,
          `task-${taskId}-expired-${Date.now()}`,
          []
        );
      }, { name: "expireLease" });
    },

    async approveTask(c, params: { taskId: string; approvedBy?: string }) {
      const { taskId } = params;
      const taskLife = await getLifecycle(c.db, taskId);
      if (!taskLife) return { taskId, ok: false as const, error: "not_found" as const, state: null };
      if (taskLife.state === "merged" || taskLife.state === "approved") return { taskId, ok: true as const, already: true, state: taskLife.state };
      if (taskLife.state !== "awaiting_approval") {
        return { taskId, ok: false as const, error: "not_awaiting_approval" as const, state: taskLife.state };
      }
      const taskContext: TaskContext = JSON.parse(taskLife.context);
      const snapshot = taskMachine.resolveState({ value: taskLife.state, context: taskContext });
      const event = { type: "APPROVED" as const, approvedBy: params.approvedBy ?? "cli", approvedAt: Date.now() };
      const [next] = transition(taskMachine, snapshot, event);
      await c.db.transaction(async (tx: RawAccess) => {
        await transitionLifecycle(
          tx, taskId, "task", next.value as string, next.context, event,
          `task-${taskId}-approved`, []
        );
      }, { name: "approveTask" });
      return { taskId, ok: true as const, already: false, state: next.value as string };
    },

    /** approved → merged, once the PR/direct merge landed (or was found already landed). */
    async mergeComplete(c, params: { taskId: string; merge: MergeRecord }) {
      const taskLife = await getLifecycle(c.db, params.taskId);
      if (!taskLife) throw new Error(`Task ${params.taskId} not found`);
      if (taskLife.state === "merged") return { taskId: params.taskId, state: "merged", already: true };
      const snapshot = taskMachine.resolveState({ value: taskLife.state, context: JSON.parse(taskLife.context) });
      const event = { type: "MERGED" as const, merge: params.merge };
      if (!snapshot.can(event)) throw new Error(`Task ${params.taskId} cannot accept MERGED from state ${taskLife.state}`);
      const [next] = transition(taskMachine, snapshot, event);
      await c.db.transaction(async (tx: RawAccess) => {
        await transitionLifecycle(tx, params.taskId, "task", next.value as string, next.context, event, `task-${params.taskId}-merged`, []);
      }, { name: "mergeComplete" });
      return { taskId: params.taskId, state: next.value as string, already: false };
    },

    /** A real conflict: back to a worker with the files (pending, new epoch) or escalate (failed). */
    async mergeConflict(c, params: { taskId: string; files: string[]; targetSha?: string; epoch: number }) {
      const taskLife = await getLifecycle(c.db, params.taskId);
      if (!taskLife) throw new Error(`Task ${params.taskId} not found`);
      const ctx: TaskContext = JSON.parse(taskLife.context);
      if (ctx.epoch !== params.epoch) return { taskId: params.taskId, state: taskLife.state, changed: false };
      const snapshot = taskMachine.resolveState({ value: taskLife.state, context: ctx });
      const event = { type: "MERGE_CONFLICT" as const, files: params.files, targetSha: params.targetSha, at: Date.now() };
      if (!snapshot.can(event)) return { taskId: params.taskId, state: taskLife.state, changed: false };
      const [next] = transition(taskMachine, snapshot, event);
      await c.db.transaction(async (tx: RawAccess) => {
        await transitionLifecycle(tx, params.taskId, "task", next.value as string, next.context, event, `task-${params.taskId}-conflict-e${params.epoch}`, []);
      }, { name: "mergeConflict" });
      return { taskId: params.taskId, state: next.value as string, changed: true };
    },

    async cancelTask(c, params: { taskId: string }) {
      const taskLife = await getLifecycle(c.db, params.taskId);
      if (!taskLife) return { taskId: params.taskId, state: null as string | null, changed: false };
      const snapshot = taskMachine.resolveState({ value: taskLife.state, context: JSON.parse(taskLife.context) });
      const event = { type: "CANCEL" as const };
      if (!snapshot.can(event)) return { taskId: params.taskId, state: taskLife.state, changed: false };
      const [next] = transition(taskMachine, snapshot, event);
      await c.db.transaction(async (tx: RawAccess) => {
        await transitionLifecycle(tx, params.taskId, "task", next.value as string, next.context, event, `task-${params.taskId}-cancel`, []);
      }, { name: "cancelTask" });
      return { taskId: params.taskId, state: next.value as string, changed: true };
    },

    async getTask(c, params: { taskId: string }) {
      const taskLife = await getLifecycle(c.db, params.taskId);
      if (!taskLife) return null;

      return {
        entityId: taskLife.entity_id,
        state: taskLife.state,
        context: JSON.parse(taskLife.context),
        seq: taskLife.seq,
      };
    },

    async listTasks(c, params: { runId: string }) {
      const rows = await c.db.execute(
        "SELECT entity_id, state FROM lifecycle WHERE machine = 'task'"
      );

      return rows.map((row: Record<string, unknown>) => ({
        taskId: row.entity_id as string,
        state: row.state as string,
      }));
    },

    async getTaskEvents(c, params: { taskId: string }) {
      const rows = await c.db.execute(
        "SELECT seq, event, at FROM lifecycle_events WHERE entity_id = ? ORDER BY seq",
        params.taskId
      );

      return rows.map((row: Record<string, unknown>) => ({
        seq: row.seq as number,
        event: JSON.parse(row.event as string),
        at: row.at as number,
      }));
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
  }),

  async onWake(c) {
    try {
      const pending = await getUndispatchedOutbox(c.db);
      for (const row of pending) {
        await markOutboxDispatched(c.db, row.id);
      }
    } catch (error) {
      console.error("[taskBoard.onWake] Error:", error);
    }
  },
});
