// Data-returning operations shared by the CLI (`--json` and human output) and `relay mcp`.
import { createClient } from "rivetkit/client";
import type { Registry } from "../registry";
import { RelayError, SCHEMA, toRelayError } from "./errors";
import { withSpan } from "../utils/tracing-simple";
import { isProtectedBranch } from "../utils/protected";

export function endpoint(): string {
  return process.env.RELAY_ENDPOINT ?? "http://127.0.0.1:6420";
}

export function client() {
  return createClient<Registry>({ endpoint: endpoint() });
}

export async function assertEngine(): Promise<void> {
  try {
    await fetch(endpoint() + "/", { signal: AbortSignal.timeout(2000) });
  } catch (error) {
    throw new RelayError(
      "engine_unreachable",
      `Rivet engine not reachable at ${endpoint()}`,
      "Start the engine with `relay serve` (or set RELAY_ENDPOINT) and retry."
    );
  }
}

export function generateRunId(): string {
  return `run-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

export interface RelayEvent {
  schema: typeof SCHEMA;
  type: string;
  runId: string;
  ts: string;
  [key: string]: unknown;
}

export type Emit = (type: string, data: Record<string, unknown>, human: string) => void;

const TERMINAL_TASK = new Set(["merged", "failed", "cancelled"]);

function taskIdsFromPlanner(context: { tasks?: Array<{ id: string } | string> }): string[] {
  return (context.tasks ?? []).map((task) => (typeof task === "string" ? task : task.id));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface RunOptions {
  goal: string;
  runId?: string;
  /** Branch tasks merge into. Protected targets wait for `relay approve`. */
  targetBranch?: string;
  approvalPollMs?: number;
  approvalTimeoutMs?: number;
  emit: Emit;
}

export interface RunResult {
  runId: string;
  state: string;
  ok: boolean;
  feedback?: string;
}

/**
 * Drive a run to a terminal state. Every step is idempotent, so calling this
 * again with the same runId resumes a crashed run (the chaos suite relies on it).
 */
export async function executeRun(opts: RunOptions): Promise<RunResult> {
  const runId = opts.runId ?? generateRunId();
  const emit = opts.emit;
  const c = client();
  return withSpan("cli.run", { "relay.run_id": runId, "relay.goal": opts.goal }, async (cliSpan) => {
    emit("run.started", { goal: opts.goal, targetBranch: opts.targetBranch ?? null }, `Starting run: ${runId}\nGoal: ${opts.goal}\n`);

    const runHandle = c.run.getOrCreate([runId]);
    let current = await runHandle.getRun({ runId });

    if (!current) {
      const createResult = await runHandle.createRun({ runId, goal: opts.goal, maxCost: 10.0 });
      emit("run.created", { state: createResult.state }, `✓ Run created (${createResult.state})`);
      current = await runHandle.getRun({ runId });
    } else {
      emit("run.resumed", { state: current.state }, `✓ Run resumed (${current.state})`);
    }
    if (!current) throw new Error(`Run ${runId} missing after create`);

    if (current.state === "completed") {
      emit("run.completed", { state: "completed" }, `\n✓ Run completed successfully\n\nRun ID: ${runId}`);
      return { runId, state: "completed", ok: true };
    }
    if (current.state === "failed" || current.state === "cancelled") {
      throw new RelayError("run_failed", `Run ${runId} is ${current.state}`, "Start a new run; terminal runs cannot resume.");
    }

    let tasks: string[] | undefined = current.context?.plan?.tasks;
    const plannerHandle = c.planner.getOrCreate([runId, "root"]);
    const plannerId = `${runId}-planner`;

    if (!tasks) {
      const planner = await plannerHandle.getPlanner({ plannerId });
      if (planner?.context?.tasks) {
        tasks = taskIdsFromPlanner(planner.context);
        emit("plan.restored", { tasks }, `✓ Plan restored: ${tasks.length} tasks`);
      } else {
        emit("plan.started", {}, "\n→ Planning...");
        const planResult = await plannerHandle.createPlan({ plannerId, runId, goal: opts.goal });
        tasks = planResult.tasks;
        emit("plan.ready", { tasks, cost: planResult.cost }, `✓ Plan created: ${tasks!.length} tasks`);
        await runHandle.chargeBudget({ runId, chargeId: `${runId}-plan`, amount: planResult.cost });
      }

      current = await runHandle.getRun({ runId });
      if (current?.state === "planning") {
        if (planner?.context?.tasks) {
          const stored = await plannerHandle.getPlanner({ plannerId });
          await runHandle.chargeBudget({ runId, chargeId: `${runId}-plan`, amount: stored?.context?.cost ?? 0 });
        }
        await runHandle.planReady({ runId, tasks: tasks! });
      }
    }

    if (!tasks || tasks.length === 0) throw new Error(`Run ${runId} has no tasks`);

    emit("tasks.creating", {}, "\n→ Creating tasks...");
    const taskBoardHandle = c.taskBoard.getOrCreate([runId]);
    for (const taskId of tasks) {
      const existing = await taskBoardHandle.getTask({ taskId });
      if (!existing) {
        await taskBoardHandle.createTask({
          taskId,
          goal: `Task ${taskId}`,
          runId,
          maxRetries: 3,
          ...(opts.targetBranch ? { targetBranch: opts.targetBranch } : {}),
        });
        emit("task.created", { taskId }, `  ✓ ${taskId}`);
      }
    }

    for (const taskId of tasks) {
      const task = await taskBoardHandle.getTask({ taskId });
      if (task && task.state === "pending") await taskBoardHandle.expireLease({ taskId });
    }

    emit("worker.provisioning", {}, "\n→ Provisioning worker...");
    const workerId = `${runId}-worker-1`;
    const workerHandle = c.worker.getOrCreate([runId, workerId]);
    let worker = await workerHandle.getWorker({ workerId });
    if (!worker || worker.state === "provisioning" || worker.state === "failed") {
      await workerHandle.provisionWorker({ workerId, runId, epoch: 1 });
      worker = await workerHandle.getWorker({ workerId });
    }
    emit("worker.ready", { workerId, state: worker?.state ?? "unknown" }, `✓ Worker ${workerId} ready (${worker?.state ?? "unknown"})`);

    await runHandle.chargeBudget({ runId, chargeId: `${runId}-worker`, amount: 0.01 });
    await workerHandle.flushOutbox({});

    emit("tasks.executing", {}, "\n→ Executing tasks...");
    for (const taskId of tasks) {
      const runNow = await runHandle.getRun({ runId });
      if (runNow?.state === "cancelled") {
        emit("run.cancelled", { state: "cancelled" }, `\n✗ Run cancelled`);
        return { runId, state: "cancelled", ok: false };
      }
      let task = await taskBoardHandle.getTask({ taskId });
      if (!task) throw new Error(`Task ${taskId} not found`);
      if (TERMINAL_TASK.has(task.state)) {
        emit("task.skipped", { taskId, state: task.state }, `  ✓ ${taskId} already ${task.state}`);
        continue;
      }

      if (task.state === "pending") {
        const lease = await taskBoardHandle.grantLease({ taskId, workerId });
        emit("task.leased", { taskId, epoch: lease.epoch, workerId }, `  → ${taskId} (epoch ${lease.epoch})`);
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

      if (task.state !== "awaiting_approval") {
        worker = await workerHandle.getWorker({ workerId });
        if (worker?.state === "idle") {
          await workerHandle.assignTask({ workerId, taskId, epoch });
        } else if (worker?.state === "busy" && worker.context.taskId !== taskId) {
          throw new Error(`Worker ${workerId} is busy on ${worker.context.taskId}, expected ${taskId}`);
        }

        await workerHandle.pushBranch({ workerId, taskId, epoch, branch: `task/${taskId}/e${epoch}` });
      }

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

        await taskBoardHandle.verifyComplete({ taskId, passed: verifyResult.passed, commitSha: verifyResult.commitSha });
        task = await taskBoardHandle.getTask({ taskId });

        if (task?.state !== "awaiting_approval") {
          worker = await workerHandle.getWorker({ workerId });
          if (worker?.state === "busy") await workerHandle.taskDone({ workerId });
        }

        if (!verifyResult.passed) {
          emit("task.verify_failed", { taskId }, `  ✗ ${taskId} verification failed`);
        } else if (task?.state === "merged") {
          emit("task.merged", { taskId, commitSha: verifyResult.commitSha }, `  ✓ ${taskId} verified and merged`);
        }
      }

      if (task?.state === "awaiting_approval") {
        const target = task.context.targetBranch;
        emit(
          "task.awaiting_approval",
          { taskId, targetBranch: target },
          `  ⏸ ${taskId} verified; merge into protected branch ${target} awaits approval (relay approve ${runId} ${taskId})`
        );
        const deadline = Date.now() + (opts.approvalTimeoutMs ?? 24 * 3600_000);
        while (task?.state === "awaiting_approval") {
          if (Date.now() > deadline) {
            throw new RelayError("run_failed", `Approval for ${taskId} timed out`, `Run \`relay approve ${runId} ${taskId}\` then resume with \`relay run --run-id ${runId} <goal>\`.`);
          }
          await sleep(opts.approvalPollMs ?? 1000);
          task = await taskBoardHandle.getTask({ taskId });
        }
        if (task?.state === "merged") {
          worker = await workerHandle.getWorker({ workerId });
          if (worker?.state === "busy") await workerHandle.taskDone({ workerId });
          emit("task.approved", { taskId, approvedBy: task.context.approval?.approvedBy ?? null }, `  ✓ ${taskId} approved and merged`);
        } else {
          emit("task.cancelled", { taskId, state: task?.state ?? null }, `  ✗ ${taskId} ${task?.state}`);
        }
      }
    }

    await taskBoardHandle.flushOutbox({});

    current = await runHandle.getRun({ runId });
    if (current?.state === "cancelled") {
      emit("run.cancelled", { state: "cancelled" }, `\n✗ Run cancelled`);
      return { runId, state: "cancelled", ok: false };
    }
    if (current?.state === "executing") {
      emit("run.judging", {}, "\n→ All tasks complete, judging...");
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
        : await judgeHandle.judge({ judgeId, runId, goal: opts.goal, completedTasks: tasks });

      await runHandle.chargeBudget({ runId, chargeId: `${runId}-judge`, amount: judgeResult.cost });

      if (judgeResult.passed) {
        await runHandle.judgePass({ runId });
        emit("run.completed", { state: "completed", feedback: judgeResult.feedback }, `\n✓ Run completed successfully\n  ${judgeResult.feedback}\n\nRun ID: ${runId}`);
        return { runId, state: "completed", ok: true, feedback: judgeResult.feedback };
      }
      await runHandle.judgeFail({ runId, reason: judgeResult.feedback });
      cliSpan.attributes["relay.outcome"] = "judge_failed";
      emit("run.failed", { state: "failed", feedback: judgeResult.feedback }, `\n✗ Run failed\n  ${judgeResult.feedback}`);
      return { runId, state: "failed", ok: false, feedback: judgeResult.feedback };
    }
    emit("run.completed", { state: "completed" }, `\n✓ Run completed successfully\n\nRun ID: ${runId}`);
    return { runId, state: "completed", ok: true };
  });
}

async function getRunOrThrow(runId: string) {
  await assertEngine();
  const c = client();
  let run: any;
  try {
    run = await c.run.get([runId]).getRun({ runId });
  } catch (error) {
    const e = toRelayError(error);
    if (e.code === "engine_unreachable") throw e;
    throw new RelayError("not_found", `Run ${runId} not found`, "List your run ids from `relay run --json` output, or start one with `relay run <goal>`.");
  }
  if (!run) throw new RelayError("not_found", `Run ${runId} not found`, "Start one with `relay run <goal>`.");
  return { c, run };
}

export interface RunStatus {
  runId: string;
  state: string;
  goal: string;
  budget: { spent: number; maxCost: number };
  tasks: Array<{ taskId: string; state: string; targetBranch: string | null }>;
  awaitingApproval: string[];
  events: number;
}

export async function getStatus(runId: string): Promise<RunStatus> {
  const { c, run } = await getRunOrThrow(runId);
  const tasks: RunStatus["tasks"] = [];
  const ids: string[] = run.context.plan?.tasks ?? [];
  if (ids.length) {
    const board = c.taskBoard.getOrCreate([runId]);
    for (const taskId of ids) {
      const t = await board.getTask({ taskId });
      if (t) tasks.push({ taskId, state: t.state, targetBranch: t.context.targetBranch ?? null });
    }
  }
  return {
    runId: run.runId,
    state: run.state,
    goal: run.context.goal,
    budget: { spent: run.context.budget?.spent ?? 0, maxCost: run.context.budget?.maxCost ?? 0 },
    tasks,
    awaitingApproval: tasks.filter((t) => t.state === "awaiting_approval").map((t) => t.taskId),
    events: run.seq,
  };
}

export async function cancelRun(runId: string): Promise<{ runId: string; state: string; changed: boolean }> {
  const { c, run } = await getRunOrThrow(runId);
  const before = run.state;
  await c.run.get([runId]).cancel({ runId });
  // Also cancel tasks parked for approval so a waiting `relay run` exits.
  const ids: string[] = run.context.plan?.tasks ?? [];
  const after = await c.run.get([runId]).getRun({ runId });
  if (ids.length) {
    const board = c.taskBoard.getOrCreate([runId]);
    for (const taskId of ids) {
      const t = await board.getTask({ taskId });
      if (t?.state === "awaiting_approval") await board.cancelTask({ taskId });
    }
  }
  return { runId, state: after?.state ?? before, changed: (after?.state ?? before) !== before };
}

export interface EventRecord {
  entity: string;
  seq: number;
  at: number;
  type: string;
  event: unknown;
}

export async function listEvents(runId: string): Promise<EventRecord[]> {
  const { c, run } = await getRunOrThrow(runId);
  const out: EventRecord[] = [];
  for (const ev of await c.run.get([runId]).getEvents({ runId })) {
    out.push({ entity: "run", seq: ev.seq, at: ev.at, type: ev.event?.type ?? "unknown", event: ev.event });
  }
  const ids: string[] = run.context.plan?.tasks ?? [];
  if (ids.length) {
    const board = c.taskBoard.getOrCreate([runId]);
    for (const taskId of ids) {
      for (const ev of await board.getTaskEvents({ taskId })) {
        out.push({ entity: taskId, seq: ev.seq, at: ev.at, type: ev.event?.type ?? "unknown", event: ev.event });
      }
    }
  }
  out.sort((a, b) => a.at - b.at || a.entity.localeCompare(b.entity) || a.seq - b.seq);
  return out;
}

export function paginate<T>(items: T[], cursor: string | undefined, limit: number) {
  const start = cursor ? Number.parseInt(cursor, 10) : 0;
  if (!Number.isFinite(start) || start < 0) {
    throw new RelayError("usage", `Invalid cursor: ${cursor}`, "Pass the nextCursor value from the previous page, or omit it.");
  }
  const page = items.slice(start, start + limit);
  const next = start + page.length;
  return { items: page, nextCursor: next < items.length ? String(next) : null, total: items.length };
}

export async function approveTask(runId: string, taskId: string, approvedBy = "cli") {
  const { c } = await getRunOrThrow(runId);
  const res = await c.taskBoard.getOrCreate([runId]).approveTask({ taskId, approvedBy });
  if (!res.ok && res.error === "not_found") {
    throw new RelayError("not_found", `Task ${taskId} not found in run ${runId}`, `Check task ids with \`relay status ${runId}\`.`);
  }
  if (!res.ok) {
    throw new RelayError("conflict", `Task ${taskId} is ${res.state}, not awaiting_approval`, `Only tasks in awaiting_approval can be approved; see \`relay status ${runId}\`.`);
  }
  return { runId, taskId, state: res.state, already: res.already };
}

export { isProtectedBranch };
