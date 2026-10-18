import { traceActions } from "../utils/tracing-simple";
import { actor } from "rivetkit";
import { db } from "rivetkit/db";
import { runMachine, type RunContext } from "../machines/run";
import { initialTransition, transition } from "xstate";
import type { ModelClient } from "../models/fake";
import {
  setupLifecycleTables,
  transitionLifecycle,
  getLifecycle,
  getUndispatchedOutbox,
  markOutboxDispatched,
} from "../utils/lifecycle";
import { killpoint } from "../utils/killpoint";

export const runActor = actor({
  db: db({
    onMigrate: async (database) => {
      await setupLifecycleTables(database);

      await database.execute(`
        CREATE TABLE IF NOT EXISTS budget_charges (
          charge_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          amount REAL NOT NULL,
          charged_at INTEGER NOT NULL
        )
      `);
    },
  }),

  actions: traceActions("run", {
    async createRun(
      c,
      params: {
        runId: string;
        goal: string;
        maxCost: number;
      }
    ) {
      const { runId, goal, maxCost } = params;

      const existing = await getLifecycle(c.db, runId);
      if (existing) {
        return { runId, state: existing.state };
      }

      const [snapshot] = initialTransition(runMachine, {
        runId,
        goal,
        budget: {
          maxCost,
          spent: 0,
        },
      });

      await c.db.transaction(async (tx) => {
        await transitionLifecycle(
          tx,
          runId,
          "run",
          snapshot.value as string,
          snapshot.context,
          { type: "CREATED" },
          `run-${runId}-created`,
          []
        );
      }, { name: "createRun" });

      return { runId, state: snapshot.value };
    },

    async planReady(
      c,
      params: {
        runId: string;
        tasks: string[];
      }
    ) {
      const { runId, tasks } = params;

      const runLife = await getLifecycle(c.db, runId);
      if (!runLife) {
        throw new Error(`Run ${runId} not found`);
      }

      const runContext: RunContext = JSON.parse(runLife.context);
      const runSnapshot = runMachine.resolveState({
        value: runLife.state,
        context: runContext,
      });

      const event = { type: "PLAN_READY" as const, tasks };

      if (!runSnapshot.can(event)) {
        throw new Error(
          `Run ${runId} cannot accept PLAN_READY from state ${runLife.state}`
        );
      }

      const [newSnapshot] = transition(runMachine, runSnapshot, event);

      await c.db.transaction(async (tx) => {
        await transitionLifecycle(
          tx,
          runId,
          "run",
          newSnapshot.value as string,
          newSnapshot.context,
          event,
          `run-${runId}-plan-ready`,
          []
        );
      }, { name: "planReady" });

      return { runId, state: newSnapshot.value, tasks };
    },

    async allTasksTerminal(c, params: { runId: string }) {
      const { runId } = params;

      const runLife = await getLifecycle(c.db, runId);
      if (!runLife) return;

      const runContext: RunContext = JSON.parse(runLife.context);
      const runSnapshot = runMachine.resolveState({
        value: runLife.state,
        context: runContext,
      });

      const event = { type: "ALL_TASKS_TERMINAL" as const };

      if (!runSnapshot.can(event)) return;

      const [newSnapshot] = transition(runMachine, runSnapshot, event);

      await c.db.transaction(async (tx) => {
        await transitionLifecycle(
          tx,
          runId,
          "run",
          newSnapshot.value as string,
          newSnapshot.context,
          event,
          `run-${runId}-all-terminal`,
          []
        );
      }, { name: "allTasksTerminal" });
    },

    async judgePass(c, params: { runId: string }) {
      const { runId } = params;

      const runLife = await getLifecycle(c.db, runId);
      if (!runLife) return;

      const runContext: RunContext = JSON.parse(runLife.context);
      const runSnapshot = runMachine.resolveState({
        value: runLife.state,
        context: runContext,
      });

      const event = { type: "JUDGE_PASS" as const };

      if (!runSnapshot.can(event)) return;

      const [newSnapshot] = transition(runMachine, runSnapshot, event);

      await c.db.transaction(async (tx) => {
        await transitionLifecycle(
          tx,
          runId,
          "run",
          newSnapshot.value as string,
          newSnapshot.context,
          event,
          `run-${runId}-judge-pass`,
          []
        );
      }, { name: "judgePass" });
    },

    async judgeFail(
      c,
      params: { runId: string; reason: string }
    ) {
      const { runId, reason } = params;

      const runLife = await getLifecycle(c.db, runId);
      if (!runLife) return;

      const runContext: RunContext = JSON.parse(runLife.context);
      const runSnapshot = runMachine.resolveState({
        value: runLife.state,
        context: runContext,
      });

      const event = { type: "JUDGE_FAIL" as const, reason };

      if (!runSnapshot.can(event)) return;

      const [newSnapshot] = transition(runMachine, runSnapshot, event);

      await c.db.transaction(async (tx) => {
        await transitionLifecycle(
          tx,
          runId,
          "run",
          newSnapshot.value as string,
          newSnapshot.context,
          event,
          `run-${runId}-judge-fail`,
          []
        );
      }, { name: "judgeFail" });
    },

    async cancel(c, params: { runId: string }) {
      const { runId } = params;

      const runLife = await getLifecycle(c.db, runId);
      if (!runLife) return;

      const runContext: RunContext = JSON.parse(runLife.context);
      const runSnapshot = runMachine.resolveState({
        value: runLife.state,
        context: runContext,
      });

      const event = { type: "CANCEL" as const };

      if (!runSnapshot.can(event)) return;

      const [newSnapshot] = transition(runMachine, runSnapshot, event);

      await c.db.transaction(async (tx) => {
        await transitionLifecycle(
          tx,
          runId,
          "run",
          newSnapshot.value as string,
          newSnapshot.context,
          event,
          `run-${runId}-cancel`,
          []
        );
      }, { name: "cancel" });
    },

    async chargeBudget(
      c,
      params: {
        runId: string;
        chargeId: string;
        amount: number;
      }
    ) {
      const { runId, chargeId, amount } = params;

      const existing = await c.db.execute(
        "SELECT charge_id FROM budget_charges WHERE charge_id = ?",
        chargeId
      );

      if (existing.length > 0) {
        return { charged: false, reason: "Already charged" };
      }

      let newSpent = 0;
      await c.db.transaction(async (tx) => {
        const again = await tx.execute(
          "SELECT charge_id FROM budget_charges WHERE charge_id = ?",
          chargeId
        );
        if (again.length > 0) return;

        await tx.execute(
          `INSERT INTO budget_charges (charge_id, run_id, amount, charged_at)
           VALUES (?, ?, ?, ?)`,
          chargeId, runId, amount, Date.now()
        );

        killpoint("budget.charge.mid");

        const runLife = await tx.execute(
          "SELECT context FROM lifecycle WHERE entity_id = ?",
          runId
        );
        if (runLife.length === 0 || !runLife[0]) return;

        const runContext: RunContext = JSON.parse(runLife[0].context as string);
        runContext.budget.spent += amount;
        newSpent = runContext.budget.spent;

        await tx.execute(
          "UPDATE lifecycle SET context = ? WHERE entity_id = ?",
          JSON.stringify(runContext), runId
        );
      }, { name: "chargeBudget" });

      return { charged: true, newSpent };
    },

    async getRun(c, params: { runId: string }) {
      const runLife = await getLifecycle(c.db, params.runId);
      if (!runLife) return null;

      return {
        runId: runLife.entity_id,
        state: runLife.state,
        context: JSON.parse(runLife.context),
        seq: runLife.seq,
      };
    },

    async getEvents(c, params: { runId: string }) {
      const rows = await c.db.execute(
        `SELECT seq, event, at FROM lifecycle_events 
         WHERE entity_id = ? 
         ORDER BY seq`,
        params.runId
      );

      return rows.map((row) => ({
        seq: row.seq as number,
        event: JSON.parse(row.event as string),
        at: row.at as number,
      }));
    },

    async getCharges(c, params: { runId: string }) {
      const rows = await c.db.execute(
        "SELECT charge_id, run_id, amount FROM budget_charges WHERE run_id = ? ORDER BY charged_at",
        params.runId
      );
      return rows.map((row) => ({
        chargeId: row.charge_id as string,
        runId: row.run_id as string,
        amount: row.amount as number,
      }));
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

    async taskEvent(c, params: { runId: string; taskId: string; event: any }) {
      const { runId, taskId, event } = params;
      
      const idemKey = `run-${runId}-task-${taskId}-${event.type}-${Date.now()}`;
      
      await c.db.transaction(async (tx) => {
        const existing = await tx.execute(
          "SELECT idem_key FROM lifecycle_events WHERE idem_key = ?",
          idemKey
        );
        
        if (existing.length > 0) return;
        
        const rows = await tx.execute(
          "SELECT seq FROM lifecycle WHERE entity_id = ?",
          runId
        );
        
        const seq = rows.length > 0 && rows[0] ? Number(rows[0].seq) + 1 : 1;
        
        await tx.execute(
          `INSERT INTO lifecycle_events (entity_id, seq, event, idem_key, at, trace_id, span_id)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          runId, seq, JSON.stringify(event), idemKey, Date.now(), null, null
        );
        
        await tx.execute(
          "UPDATE lifecycle SET seq = ? WHERE entity_id = ?",
          seq, runId
        );
      }, { name: "taskEvent" });
    },

    async leaseEvent(c, params: { runId: string; leaseId: string; event: any }) {
      const { runId, leaseId, event } = params;
      
      const idemKey = `run-${runId}-lease-${leaseId}-${event.type}-${Date.now()}`;
      
      await c.db.transaction(async (tx) => {
        const existing = await tx.execute(
          "SELECT idem_key FROM lifecycle_events WHERE idem_key = ?",
          idemKey
        );
        
        if (existing.length > 0) return;
        
        const rows = await tx.execute(
          "SELECT seq FROM lifecycle WHERE entity_id = ?",
          runId
        );
        
        const seq = rows.length > 0 && rows[0] ? Number(rows[0].seq) + 1 : 1;
        
        await tx.execute(
          `INSERT INTO lifecycle_events (entity_id, seq, event, idem_key, at, trace_id, span_id)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          runId, seq, JSON.stringify(event), idemKey, Date.now(), null, null
        );
        
        await tx.execute(
          "UPDATE lifecycle SET seq = ? WHERE entity_id = ?",
          seq, runId
        );
      }, { name: "leaseEvent" });
    },

    async workerEvent(c, params: { runId: string; workerId: string; event: any }) {
      const { runId, workerId, event } = params;
      
      const idemKey = `run-${runId}-worker-${workerId}-${event.type}-${Date.now()}`;
      
      await c.db.transaction(async (tx) => {
        const existing = await tx.execute(
          "SELECT idem_key FROM lifecycle_events WHERE idem_key = ?",
          idemKey
        );
        
        if (existing.length > 0) return;
        
        const rows = await tx.execute(
          "SELECT seq FROM lifecycle WHERE entity_id = ?",
          runId
        );
        
        const seq = rows.length > 0 && rows[0] ? Number(rows[0].seq) + 1 : 1;
        
        await tx.execute(
          `INSERT INTO lifecycle_events (entity_id, seq, event, idem_key, at, trace_id, span_id)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          runId, seq, JSON.stringify(event), idemKey, Date.now(), null, null
        );
        
        await tx.execute(
          "UPDATE lifecycle SET seq = ? WHERE entity_id = ?",
          seq, runId
        );
      }, { name: "workerEvent" });
    },
  }),

  async onWake(c) {
    const pending = await getUndispatchedOutbox(c.db);
    for (const row of pending) {
      await markOutboxDispatched(c.db, row.id);
    }
  },
});
