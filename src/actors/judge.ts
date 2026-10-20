import type { RawAccess } from "rivetkit/db";
import { traceActions } from "../utils/tracing-simple";
import { actor } from "rivetkit";
import { db } from "rivetkit/db";
import { setupLifecycleTables } from "../utils/lifecycle";
import { getDependencies } from "../dependencies";

/** The hard rule ahead of any judge model: nothing merged fails the run, unless the contract says no-op. */
export function zeroMergedVerdict(completedTasks: string[], noop?: boolean): { passed: false; feedback: string } | null {
  return completedTasks.length === 0 && !noop ? { passed: false, feedback: "No tasks merged; a run must land at least one task unless its goal is tagged [noop]" } : null;
}

export const judgeActor = actor({
  db: db({
    onMigrate: async (database) => {
      await setupLifecycleTables(database);
    },
  }),

  actions: traceActions("judge", {
    async judge(
      c,
      params: {
        judgeId: string;
        runId: string;
        goal: string;
        completedTasks: string[];
        /** The contract marks the run a no-op: landing nothing is acceptable. */
        noop?: boolean;
      }
    ) {
      const { judgeId, runId, goal, completedTasks } = params;
      const { model } = getDependencies();

      // Hard rule ahead of any model (fake or real): a run that merged nothing failed,
      // unless its contract says it is a no-op.
      const forced = zeroMergedVerdict(completedTasks, params.noop);
      const response = forced ? { content: JSON.stringify(forced), cost: 0 } : await model.generate([
        {
          role: "system",
          content:
            "You are a judge evaluating if a goal was achieved. Return JSON with 'passed' (boolean) and 'feedback' (string).",
        },
        {
          role: "user",
          content: `Goal: ${goal}\n\nCompleted tasks: ${completedTasks.join(", ")}\n\nDid we achieve the goal?`,
        },
      ]);

      let passed = true;
      let feedback = "Goal achieved";
      try {
        const parsed = JSON.parse(response.content);
        passed = parsed.passed !== false;
        feedback = parsed.feedback || feedback;
      } catch {
        passed = true;
      }

      await c.db.execute(
        `INSERT INTO lifecycle (entity_id, machine, version, state, context, seq)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(entity_id) DO UPDATE SET
           state = excluded.state,
           context = excluded.context,
           seq = seq + 1`,
        judgeId,
        "judge",
        1,
        passed ? "passed" : "failed",
        JSON.stringify({
          runId,
          goal,
          completedTasks,
          passed,
          feedback,
          cost: response.cost,
          judgedAt: Date.now(),
        }),
        1
      );

      return {
        judgeId,
        passed,
        feedback,
        cost: response.cost,
      };
    },

    async getJudge(c, params: { judgeId: string }) {
      const rows = await c.db.execute(
        "SELECT * FROM lifecycle WHERE entity_id = ?",
        params.judgeId
      );

      if (rows.length === 0) return null;

      const row = rows[0];
      if (!row) return null;
      
      return {
        judgeId: row.entity_id as string,
        state: row.state as string,
        context: JSON.parse(row.context as string),
      };
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
});
