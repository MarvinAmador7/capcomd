import { createClient } from "rivetkit/client";

export interface SeqRow {
  entityId: string;
  seq: number;
}

export interface InvariantReport {
  ok: boolean;
  checks: {
    doubleMerge: boolean;
    lostTasks: boolean;
    sandboxes: boolean;
    charges: boolean;
    eventLog: boolean;
  };
  violations: string[];
}

const TASK_STATES = new Set([
  "pending",
  "leased",
  "running",
  "handed_off",
  "verifying",
  "merged",
  "awaiting_approval",
  "failed",
  "cancelled",
]);

const WORKER_STATES = new Set([
  "provisioning",
  "idle",
  "busy",
  "draining",
  "destroyed",
  "failed",
]);

export function eventGapViolations(rows: SeqRow[]): string[] {
  const grouped = new Map<string, number[]>();
  for (const row of rows) {
    const seqs = grouped.get(row.entityId) ?? [];
    seqs.push(row.seq);
    grouped.set(row.entityId, seqs);
  }

  const violations: string[] = [];
  for (const [entityId, seqs] of grouped) {
    const sorted = [...seqs].sort((a, b) => a - b);
    if (new Set(sorted).size !== sorted.length) {
      violations.push(`duplicate event seq for ${entityId}`);
    }
    for (let index = 0; index < sorted.length; index++) {
      if (sorted[index] !== index + 1) {
        violations.push(`event gap for ${entityId}: expected ${index + 1}, found ${sorted[index]}`);
        break;
      }
    }
  }
  return violations;
}

export async function auditRun(runId: string): Promise<InvariantReport> {
  const client = createClient({ endpoint: "http://127.0.0.1:6420" });
  const violations: string[] = [];

  const runHandle = client.run.getOrCreate([runId]);
  const run = await runHandle.getRun({ runId });
  if (!run) {
    throw new Error(`invariant audit could not read run ${runId}`);
  }

  const tasks = await client.taskBoard.getOrCreate([runId]).listTasks({ runId });
  if (!Array.isArray(tasks)) {
    throw new Error("invariant audit could not read tasks");
  }

  const mergeViolations: string[] = [];
  const lostViolations: string[] = [];
  for (const task of tasks) {
    if (!TASK_STATES.has(task.state)) {
      lostViolations.push(`lost task ${task.taskId} in ${task.state}`);
    }
    const events = await client.taskBoard.getOrCreate([runId]).getTaskEvents({ taskId: task.taskId });
    const merges = events.filter((event: { event?: { type?: string } }) => event.event?.type === "VERIFIED_AND_MERGED");
    if (merges.length > 1) {
      mergeViolations.push(`double merge ${task.taskId} (${merges.length})`);
    }
  }

  const workerId = `${runId}-worker-1`;
  const worker = await client.worker.getOrCreate([runId, workerId]).getWorker({ workerId });
  const sandboxViolations: string[] = [];
  if (!worker) {
    sandboxViolations.push(`worker ${workerId} missing`);
  } else if (!WORKER_STATES.has(worker.state)) {
    sandboxViolations.push(`worker ${workerId} in unknown state ${worker.state}`);
  } else {
    const createdAt = Number(worker.context?.createdAt ?? Date.now());
    const ttlMs = Number(worker.context?.ttlMs ?? 3_600_000);
    const active = worker.state !== "destroyed" && worker.state !== "failed";
    if (active && Date.now() - createdAt > ttlMs) {
      sandboxViolations.push(`orphan sandbox ${workerId} past TTL`);
    }
    // Deterministic (clock-independent) form: a finished run must have reaped its sandbox.
    const runNow = await runHandle.getRun({ runId });
    if (active && runNow && ["completed", "failed", "cancelled"].includes(runNow.state)) {
      sandboxViolations.push(`unreaped sandbox ${workerId} (worker ${worker.state}, run ${runNow.state})`);
    }
  }

  const charges = await runHandle.getCharges({ runId });
  if (!Array.isArray(charges)) {
    throw new Error("invariant audit could not read budget charges");
  }
  const chargeViolations: string[] = [];
  const seen = new Set<string>();
  for (const charge of charges) {
    if (seen.has(charge.chargeId)) chargeViolations.push(`double charge ${charge.chargeId}`);
    seen.add(charge.chargeId);
  }

  const seqSources = [
    await runHandle.listEventSeqs({}),
    await client.taskBoard.getOrCreate([runId]).listEventSeqs({}),
    await client.worker.getOrCreate([runId, workerId]).listEventSeqs({}),
    await client.planner.getOrCreate([runId, "root"]).listEventSeqs({}),
    await client.judge.getOrCreate([runId, "final"]).listEventSeqs({}),
  ];
  for (const task of tasks) {
    seqSources.push(await client.verifier.getOrCreate([runId, task.taskId]).listEventSeqs({}));
  }
  const gapViolations = eventGapViolations(seqSources.flat());

  violations.push(...mergeViolations, ...lostViolations, ...sandboxViolations, ...chargeViolations, ...gapViolations);

  const checks = {
    doubleMerge: mergeViolations.length === 0,
    lostTasks: lostViolations.length === 0,
    sandboxes: sandboxViolations.length === 0,
    charges: chargeViolations.length === 0,
    eventLog: gapViolations.length === 0,
  };

  return {
    ok: violations.length === 0,
    checks,
    violations,
  };
}
