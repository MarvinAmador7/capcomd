import { actor } from "rivetkit";
import { db } from "rivetkit/db";
import { setupLifecycleTables, getLifecycle } from "../utils/lifecycle";
import { killpoint } from "../utils/killpoint";
import { getDependencies } from "../dependencies";

export const plannerActor = actor({
  db: db({
    onMigrate: async (database) => {
      await setupLifecycleTables(database);
    },
  }),

  actions: {
    async createPlan(
      c,
      params: {
        plannerId: string;
        runId: string;
        goal: string;
      }
    ) {
      const { plannerId, runId, goal } = params;
      const { model } = getDependencies();

      const existing = await getLifecycle(c.db, plannerId);
      if (existing) {
        const ctx = JSON.parse(existing.context as string);
        const tasks = (ctx.tasks ?? []).map((task: { id: string } | string) =>
          typeof task === "string" ? task : task.id
        );
        return { plannerId, tasks, cost: ctx.cost ?? 0 };
      }

      const response = await model.generate([
        {
          role: "system",
          content:
            "You are a task planner. Break down the goal into concrete tasks. Return JSON with a 'tasks' array.",
        },
        {
          role: "user",
          content: `Goal: ${goal}\n\nBreak this down into 3-5 concrete tasks.`,
        },
      ]);

      killpoint("model.after_return.before_commit");

      let tasks: Array<{ id: string; goal: string }>;
      try {
        const parsed = JSON.parse(response.content);
        tasks = parsed.tasks || [];
      } catch {
        tasks = [
          { id: "task-1", goal: "Implement core functionality" },
          { id: "task-2", goal: "Add tests" },
        ];
      }
      if (tasks.length === 0) {
        tasks = [
          { id: "task-1", goal: "Implement core functionality" },
          { id: "task-2", goal: "Add tests" },
        ];
      }

      await c.db.execute(
        `INSERT INTO lifecycle (entity_id, machine, version, state, context, seq)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(entity_id) DO UPDATE SET
           state = excluded.state,
           context = excluded.context,
           seq = seq + 1`,
        plannerId,
        "planner",
        1,
        "completed",
        JSON.stringify({ runId, goal, tasks, cost: response.cost }),
        1
      );

      return {
        plannerId,
        tasks: tasks.map((t) => t.id),
        cost: response.cost,
      };
    },

    async getPlanner(c, params: { plannerId: string }) {
      const rows = await c.db.execute(
        "SELECT * FROM lifecycle WHERE entity_id = ?",
        params.plannerId
      );

      if (rows.length === 0) return null;

      const row = rows[0];
      if (!row) return null;
      
      return {
        plannerId: row.entity_id as string,
        state: row.state as string,
        context: JSON.parse(row.context as string),
      };
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
});
