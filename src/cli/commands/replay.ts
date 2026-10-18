import { createClient } from "rivetkit/client";

export async function replay(opts: { runId: string }) {
  const c = createClient({ endpoint: "http://localhost:6420" });

  try {
    const runHandle = c.run.get([opts.runId]);
    const run = await runHandle.getRun({ runId: opts.runId });

    if (!run) {
      console.log(`Run ${opts.runId} not found`);
      return;
    }

    console.log(`Replaying run: ${opts.runId}`);

    // Get run events
    const runEvents = await runHandle.getEvents({ runId: opts.runId });

    // Get task events for all tasks in the plan
    const allEvents: Array<{ seq: number; at: number; entity: string; event: any }> = [];

    for (const ev of runEvents) {
      allEvents.push({
        seq: ev.seq,
        at: ev.at,
        entity: "run",
        event: ev.event,
      });
    }

    // Get events from tasks if plan exists
    if (run.context.plan && run.context.plan.tasks) {
      const taskBoardHandle = c.taskBoard.get([opts.runId]);
      
      for (const taskId of run.context.plan.tasks) {
        try {
          const taskEvents = await taskBoardHandle.getTaskEvents({ taskId });
          for (const ev of taskEvents) {
            allEvents.push({
              seq: ev.seq,
              at: ev.at,
              entity: taskId,
              event: ev.event,
            });
          }
        } catch (e) {
          // Task might not have events yet
        }
      }
    }

    // Sort all events by timestamp
    allEvents.sort((a, b) => a.at - b.at);

    console.log(`Total events: ${allEvents.length}\n`);

    for (const ev of allEvents) {
      const timestamp = new Date(ev.at).toISOString();
      const eventStr = JSON.stringify(ev.event);
      const entity = ev.entity.padEnd(20);
      console.log(`[${entity}] ${timestamp} ${eventStr}`);
    }
  } catch (error) {
    console.error("Error:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
