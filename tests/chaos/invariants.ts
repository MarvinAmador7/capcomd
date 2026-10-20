import { createClient } from "rivetkit/client";
import type { Registry } from "../../src/registry";

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
  "approved",
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

/**
 * repo: when the run merged into a real bare repo, git is checked too (git wins):
 *  doubleMerge: no task's change appears twice on the target;
 *  lostTasks:   a `merged` task's change is on the target exactly once, and nothing is on the
 *               target for a task that is not recorded `merged`.
 */
export async function auditRun(runId: string, endpoint = "http://127.0.0.1:6420", repo?: { bare: string; target: string }): Promise<InvariantReport> {
  const client = createClient<Registry>({ endpoint });
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
    if (repo) {
      const { Git } = await import("../../src/merge/git");
      const { countTaskLandings } = await import("../../src/merge/repo");
      const landed = await countTaskLandings(new Git(repo.bare), `refs/heads/${repo.target}`, `${runId}/${task.taskId}`);
      if (landed > 1) mergeViolations.push(`git double merge ${task.taskId}: ${landed} commits on ${repo.target}`);
      if (task.state === "merged" && landed !== 1) lostViolations.push(`task ${task.taskId} recorded merged but ${landed} landings on ${repo.target}`);
      if (task.state !== "merged" && landed > 0) lostViolations.push(`task ${task.taskId} is ${task.state} but its change is on ${repo.target} (merge not recorded)`);
      const full = await client.taskBoard.getOrCreate([runId]).getTask({ taskId: task.taskId });
      if (task.state === "merged" && !full?.context?.merge?.sha) lostViolations.push(`task ${task.taskId} merged without a recorded sha`);
    }
  }

  // Sandboxes: the legacy loop has one worker (<run>-worker-1); the recipe one worker per scope
  // agent (keyed [run, agentId]). Audit whichever the run used; every one must be reaped.
  const scopeAgents: any[] = await client.scope.getOrCreate([runId]).listAgents({}).then((r: any) => (Array.isArray(r) ? r : r?.agents ?? []), () => []);
  const workerIds = scopeAgents.length ? scopeAgents.map((x) => String(x.agentId)) : [`${runId}-worker-1`];
  const sandboxViolations: string[] = [];
  const runNow = await runHandle.getRun({ runId });
  for (const workerId of workerIds) {
    const worker = await client.worker.getOrCreate([runId, workerId]).getWorker({ workerId });
    if (!worker) {
      // A recipe agent that never reached provisioning (e.g. cancelled/failed before its driver ran) has no sandbox.
      if (!scopeAgents.length) sandboxViolations.push(`worker ${workerId} missing`);
      continue;
    }
    if (!WORKER_STATES.has(worker.state)) {
      sandboxViolations.push(`worker ${workerId} in unknown state ${worker.state}`);
      continue;
    }
    const createdAt = Number(worker.context?.createdAt ?? Date.now());
    const ttlMs = Number(worker.context?.ttlMs ?? 3_600_000);
    const active = worker.state !== "destroyed" && worker.state !== "failed";
    if (active && Date.now() - createdAt > ttlMs) sandboxViolations.push(`orphan sandbox ${workerId} past TTL`);
    // Deterministic (clock-independent) form: a finished run must have reaped its sandbox.
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
    ...(await Promise.all(workerIds.map((w) => client.worker.getOrCreate([runId, w]).listEventSeqs({})))),
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
