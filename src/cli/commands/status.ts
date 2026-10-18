import { createClient } from "rivetkit/client";

export async function status(opts: { runId?: string }) {
  const c = createClient({ endpoint: "http://localhost:6420" });

  try {
    if (opts.runId) {
      const runHandle = c.run.get([opts.runId]);
      const run = await runHandle.getRun({ runId: opts.runId });
      if (!run) {
        console.log(`Run ${opts.runId} not found`);
        return;
      }

      console.log(`Run: ${run.runId}`);
      console.log(`State: ${run.state}`);
      console.log(`Goal: ${run.context.goal}`);
      console.log(
        `Budget: $${run.context.budget.spent.toFixed(4)} / $${run.context.budget.maxCost.toFixed(2)}`
      );

      if (run.context.plan) {
        console.log(`\nPlan (v${run.context.plan.version}):`);
        const taskBoardHandle = c.taskBoard.get([opts.runId]);
        for (const taskId of run.context.plan.tasks) {
          const task = await taskBoardHandle.getTask({ taskId });
          if (task) {
            console.log(`  ${taskId}: ${task.state}`);
          }
        }
      }

      console.log(`\nEvents: ${run.seq} total`);
    } else {
      console.log("No runId specified. Use: relay status <runId>");
    }
  } catch (error) {
    console.error("Error:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
