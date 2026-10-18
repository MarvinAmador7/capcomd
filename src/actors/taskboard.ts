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

  actions: {
    async createTask(c, params: { taskId: string; goal: string; runId: string; maxRetries: number }) {
      const { taskId, goal, maxRetries } = params;

      const [snapshot] = initialTransition(taskMachine, {
        taskId,
        goal,
        maxRetries,
      });

      await c.db.transaction(async (tx) => {
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

      await c.db.transaction(async (tx) => {
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

      await c.db.transaction(async (tx) => {
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

      await c.db.transaction(async (tx) => {
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

      const event = { type: "HANDOFF" as const, epoch };

      if (!taskSnapshot.can(event)) {
        throw new Error(`Task ${taskId} cannot HANDOFF from state ${taskLife.state}`);
      }

      const [newSnapshot] = transition(taskMachine, taskSnapshot, event);

      await c.db.transaction(async (tx) => {
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

      await c.db.transaction(async (tx) => {
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
      }
    ) {
      const { taskId, passed, commitSha } = params;

      const taskLife = await getLifecycle(c.db, taskId);
      if (!taskLife) {
        throw new Error(`Task ${taskId} not found`);
      }

      const taskContext: TaskContext = JSON.parse(taskLife.context);
      const taskSnapshot = taskMachine.resolveState({
        value: taskLife.state,
        context: taskContext,
      });

      const event = passed
        ? { type: "VERIFIED_AND_MERGED" as const, commitSha }
        : { type: "VERIFY_FAILED" as const };

      if (!taskSnapshot.can(event)) {
        throw new Error(`Task ${taskId} cannot accept ${event.type} from state ${taskLife.state}`);
      }

      const [newSnapshot] = transition(taskMachine, taskSnapshot, event);

      await c.db.transaction(async (tx) => {
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

      await c.db.transaction(async (tx) => {
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

      return rows.map((row) => ({
        taskId: row.entity_id as string,
        state: row.state as string,
      }));
    },

    async getTaskEvents(c, params: { taskId: string }) {
      const rows = await c.db.execute(
        "SELECT seq, event, at FROM lifecycle_events WHERE entity_id = ? ORDER BY seq",
        params.taskId
      );

      return rows.map((row) => ({
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
      return rows.map((row) => ({
        entityId: row.entity_id as string,
        seq: Number(row.seq),
      }));
    },
  },

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
