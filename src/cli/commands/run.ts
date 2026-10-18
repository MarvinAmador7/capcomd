import { createClient } from "rivetkit/client";
import { initDependencies } from "../../dependencies";
import { FakeModelClient } from "../../models/fake";
import { FakeProvider } from "../../providers/fake";

function generateRunId(): string {
  return `run-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

const TERMINAL_TASK = new Set(["merged", "failed", "cancelled"]);

function taskIdsFromPlanner(context: { tasks?: Array<{ id: string } | string> }): string[] {
  return (context.tasks ?? []).map((task) => (typeof task === "string" ? task : task.id));
}

export async function run(opts: { goal: string; runId?: string }) {
  initDependencies({
    model: new FakeModelClient(),
    provider: new FakeProvider(),
  });

  const runId = opts.runId ?? generateRunId();

  console.log(`Starting run: ${runId}`);
  console.log(`Goal: ${opts.goal}\n`);

  const c = createClient({ endpoint: "http://localhost:6420" });

  try {
    const runHandle = c.run.getOrCreate([runId]);
    let current = await runHandle.getRun({ runId });

    if (!current) {
      const createResult = await runHandle.createRun({
        runId,
        goal: opts.goal,
        maxCost: 10.0,
      });
      console.log(`✓ Run created (${createResult.state})`);
      current = await runHandle.getRun({ runId });
    } else {
      console.log(`✓ Run resumed (${current.state})`);
    }

    if (!current) {
      throw new Error(`Run ${runId} missing after create`);
    }

    if (current.state === "completed") {
      console.log(`\n✓ Run completed successfully`);
      console.log(`\nRun ID: ${runId}`);
      return;
    }

    if (current.state === "failed" || current.state === "cancelled") {
      throw new Error(`Run ${runId} is ${current.state}`);
    }

    let tasks: string[] | undefined = current.context?.plan?.tasks;
    const plannerHandle = c.planner.getOrCreate([runId, "root"]);
    const plannerId = `${runId}-planner`;

    if (!tasks) {
      const planner = await plannerHandle.getPlanner({ plannerId });
      if (planner?.context?.tasks) {
        tasks = taskIdsFromPlanner(planner.context);
        console.log(`✓ Plan restored: ${tasks.length} tasks`);
      } else {
        console.log("\n→ Planning...");
        const planResult = await plannerHandle.createPlan({
          plannerId,
          runId,
          goal: opts.goal,
        });
        tasks = planResult.tasks;
        console.log(`✓ Plan created: ${tasks.length} tasks`);
        await runHandle.chargeBudget({
          runId,
          chargeId: `${runId}-plan`,
          amount: planResult.cost,
        });
      }

      current = await runHandle.getRun({ runId });
      if (current?.state === "planning") {
        if (!planner?.context?.tasks) {
          // plan charge already issued for a fresh plan
        } else {
          const stored = await plannerHandle.getPlanner({ plannerId });
          await runHandle.chargeBudget({
            runId,
            chargeId: `${runId}-plan`,
            amount: stored?.context?.cost ?? 0,
          });
        }
        await runHandle.planReady({ runId, tasks });
      }
    }

    if (!tasks || tasks.length === 0) {
      throw new Error(`Run ${runId} has no tasks`);
    }

    console.log("\n→ Creating tasks...");
    const taskBoardHandle = c.taskBoard.getOrCreate([runId]);
    for (const taskId of tasks) {
      const existing = await taskBoardHandle.getTask({ taskId });
      if (!existing) {
        await taskBoardHandle.createTask({
          taskId,
          goal: `Task ${taskId}`,
          runId,
          maxRetries: 3,
        });
        console.log(`  ✓ ${taskId}`);
      }
    }

    for (const taskId of tasks) {
      const task = await taskBoardHandle.getTask({ taskId });
      if (task && task.state === "pending") {
        await taskBoardHandle.expireLease({ taskId });
      }
    }

    console.log("\n→ Provisioning worker...");
    const workerId = `${runId}-worker-1`;
    const workerHandle = c.worker.getOrCreate([runId, workerId]);
    let worker = await workerHandle.getWorker({ workerId });
    if (!worker || worker.state === "provisioning" || worker.state === "failed") {
      await workerHandle.provisionWorker({
        workerId,
        runId,
        epoch: 1,
      });
      worker = await workerHandle.getWorker({ workerId });
    }
    console.log(`✓ Worker ${workerId} ready (${worker?.state ?? "unknown"})`);

    await runHandle.chargeBudget({
      runId,
      chargeId: `${runId}-worker`,
      amount: 0.01,
    });

    await workerHandle.flushOutbox({});

    console.log("\n→ Executing tasks...");
    for (const taskId of tasks) {
      let task = await taskBoardHandle.getTask({ taskId });
      if (!task) throw new Error(`Task ${taskId} not found`);
      if (TERMINAL_TASK.has(task.state)) {
        console.log(`  ✓ ${taskId} already ${task.state}`);
        continue;
      }

      if (task.state === "pending") {
        const lease = await taskBoardHandle.grantLease({ taskId, workerId });
        console.log(`  → ${taskId} (epoch ${lease.epoch})`);
        task = await taskBoardHandle.getTask({ taskId });
        if (!task) throw new Error(`Task ${taskId} missing after lease`);
      }

      const epoch = Number(task.context.epoch);
      if (!epoch) throw new Error(`Task ${taskId} has no lease epoch in state ${task.state}`);

      if (task.state === "leased") {
        await taskBoardHandle.workerStarted({ taskId, epoch });
        task = await taskBoardHandle.getTask({ taskId });
        if (!task) throw new Error(`Task ${taskId} missing after worker start`);
      }

      worker = await workerHandle.getWorker({ workerId });
      if (worker?.state === "idle") {
        await workerHandle.assignTask({ workerId, taskId, epoch });
      } else if (worker?.state === "busy" && worker.context.taskId !== taskId) {
        throw new Error(`Worker ${workerId} is busy on ${worker.context.taskId}, expected ${taskId}`);
      }

      await workerHandle.pushBranch({
        workerId,
        taskId,
        epoch,
        branch: `task/${taskId}/e${epoch}`,
      });

      if (task.state === "running") {
        await taskBoardHandle.handoffTask({ taskId, epoch });
        task = await taskBoardHandle.getTask({ taskId });
        if (!task) throw new Error(`Task ${taskId} missing after handoff`);
      }

      if (task.state === "handed_off") {
        await taskBoardHandle.startVerify({ taskId });
        task = await taskBoardHandle.getTask({ taskId });
        if (!task) throw new Error(`Task ${taskId} missing after verify start`);
      }

      if (task.state === "verifying") {
        const verifierHandle = c.verifier.getOrCreate([runId, taskId]);
        const verifyResult = await verifierHandle.verify({
          verifierId: `${taskId}-verifier`,
          taskId,
          branch: `task/${taskId}/e${epoch}`,
          commitSha: "abc123",
          runId,
        });

        await taskBoardHandle.verifyComplete({
          taskId,
          passed: verifyResult.passed,
          commitSha: verifyResult.commitSha,
        });

        worker = await workerHandle.getWorker({ workerId });
        if (worker?.state === "busy") {
          await workerHandle.taskDone({ workerId });
        }

        if (verifyResult.passed) {
          console.log(`  ✓ ${taskId} verified and merged`);
        } else {
          console.log(`  ✗ ${taskId} verification failed`);
        }
      }
    }

    await taskBoardHandle.flushOutbox({});

    current = await runHandle.getRun({ runId });
    if (current?.state === "executing") {
      console.log("\n→ All tasks complete, judging...");
      await runHandle.allTasksTerminal({ runId });
      current = await runHandle.getRun({ runId });
    }

    if (current?.state !== "judging" && current?.state !== "completed") {
      throw new Error(`Run ${runId} is ${current?.state ?? "missing"} after tasks; expected judging`);
    }

    if (current.state === "judging") {
      const judgeId = `${runId}-judge`;
      const judgeHandle = c.judge.getOrCreate([runId, "final"]);
      const existingJudge = await judgeHandle.getJudge({ judgeId });
      const judgeResult = existingJudge
        ? {
            passed: existingJudge.context.passed !== false,
            feedback: existingJudge.context.feedback ?? "Goal achieved",
            cost: existingJudge.context.cost ?? 0,
          }
        : await judgeHandle.judge({
            judgeId,
            runId,
            goal: opts.goal,
            completedTasks: tasks,
          });

      await runHandle.chargeBudget({
        runId,
        chargeId: `${runId}-judge`,
        amount: judgeResult.cost,
      });

      if (judgeResult.passed) {
        await runHandle.judgePass({ runId });
        console.log(`\n✓ Run completed successfully`);
        console.log(`  ${judgeResult.feedback}`);
      } else {
        await runHandle.judgeFail({ runId, reason: judgeResult.feedback });
        console.log(`\n✗ Run failed`);
        console.log(`  ${judgeResult.feedback}`);
        process.exit(1);
      }
    } else {
      console.log(`\n✓ Run completed successfully`);
    }

    console.log(`\nRun ID: ${runId}`);
  } catch (error) {
    console.error("\n✗ Run failed:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
