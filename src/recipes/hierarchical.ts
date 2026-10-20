// ADR-016 step 4: the planner → worker → judge flow of `capcomd run`, written as a recipe over
// the primitives instead of a hard-wired loop. Same actors (planner, worker, verifier, judge,
// run ledger), composed through the scope: run new, task add --after (plan order), task claim,
// spawn, await, verify, merge --require, task done, judge. Every step is keyed by the run and
// task ids, so running it again with the same runId resumes where a crash left off.
import { client, assertEngine, type RunOptions, type RunResult } from "../core/relay";
import { RelayError } from "../core/errors";
import { decodeAgentRef } from "../agents/profiles";
import { awaitAgents, mergeRef, runNew, spawnAgent, verifyRef } from "../primitives/ops";
import * as S from "../primitives/state";
import { isProtectedBranch } from "../utils/protected";

export const RECIPE_HOLDER = "recipe:hierarchical";
const MAX_ATTEMPTS = 4; // the legacy task machine: 1 attempt + maxRetries 3; verify failures and conflicts both retry
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface PlannedTask { id: string; goal: string; agent?: string }

export async function runHierarchicalRecipe(opts: RunOptions & { budgetUsd?: number }): Promise<RunResult> {
  await assertEngine();
  const emit = opts.emit;
  const c = client();
  const runId = opts.runId ?? `run-${Date.now().toString(36)}`;
  emit("run.started", { goal: opts.goal, targetBranch: opts.targetBranch ?? null, recipe: "hierarchical" }, `Starting run: ${runId} (recipe)\nGoal: ${opts.goal}\n`);

  // 1. scope + run ledger (run new also creates the run actor in "planning").
  const scope = await runNew({ runId, budget: { usd: opts.budgetUsd ?? 10 }, label: opts.goal });
  emit(scope.created ? "run.created" : "run.resumed", { runId }, scope.created ? "✓ Run created (scope)" : "✓ Run resumed (scope)");
  const runH = c.run.getOrCreate([runId]);
  let run = await runH.getRun({ runId });
  if (run?.state === "completed") { emit("run.completed", { state: "completed" }, `\n✓ Run completed successfully\n\nRun ID: ${runId}`); return { runId, state: "completed", ok: true }; }
  if (run?.state === "failed" || run?.state === "cancelled") throw new RelayError("run_failed", `Run ${runId} is ${run.state}`, "Start a new run; terminal runs cannot resume.");

  // 2. plan: the planner actor (same model call and directive parsing as the legacy path).
  const plannerH = c.planner.getOrCreate([runId, "root"]);
  const plannerId = `${runId}-planner`;
  let pctx = (await plannerH.getPlanner({ plannerId }))?.context;
  if (!pctx?.tasks) {
    emit("plan.started", {}, "\n→ Planning...");
    const p = await plannerH.createPlan({ plannerId, runId, goal: opts.goal });
    pctx = (await plannerH.getPlanner({ plannerId }))?.context;
    emit("plan.ready", { tasks: p.tasks, cost: p.cost }, `✓ Plan created: ${p.tasks.length} tasks`);
  }
  await runH.chargeBudget({ runId, chargeId: `${runId}-plan`, amount: Number(pctx?.cost ?? 0) });
  const planned: PlannedTask[] = ((pctx?.tasks ?? []) as any[]).map((t, i) => typeof t === "object" ? { id: t.id, goal: t.goal ?? `Task ${t.id}`, agent: t.agent } : { id: String(t), goal: `Task ${t}` }).filter((t) => t.id);
  if (!planned.length) throw new Error(`Run ${runId} has no tasks`);
  run = await runH.getRun({ runId });
  if (run?.state === "planning") {
    const agents: Record<string, unknown> = {};
    for (const t of (pctx?.tasks ?? []) as any[]) if (t?.agentSpec) agents[t.id] = t.agentSpec;
    await runH.planReady({ runId, tasks: planned.map((t) => t.id), ...(Object.keys(agents).length ? { agents } : {}) });
  }

  await S.kvWrite(runId, { k: "recipe/plan", value: { recipe: "hierarchical", tasks: planned.map((t) => t.id) }, key: "recipe-plan" });

  // 3. the plan as a board: each task after the previous one (the legacy path runs them in order).
  const boardId: Record<string, string> = {};
  let prev: string | undefined;
  for (const t of planned) {
    const r: any = await S.taskAdd(runId, { title: t.goal, data: { planTask: t.id, agent: t.agent ?? null }, key: `plan-${t.id}`, ...(prev ? { after: [prev] } : {}) });
    boardId[t.id] = r.task.taskId;
    if (r.created) emit("task.created", { taskId: t.id, boardTask: r.task.taskId }, `  ✓ ${t.id}`);
    prev = r.task.taskId;
  }

  // 4. workers: claim → spawn → await → verify → merge --require → done (retry on fail/conflict).
  emit("tasks.executing", {}, "\n→ Executing tasks...");
  const target = opts.targetBranch;
  const completed: string[] = [];
  for (const t of planned) {
    if ((await runH.getRun({ runId }))?.state === "cancelled") { emit("run.cancelled", { state: "cancelled" }, "\n✗ Run cancelled"); return { runId, state: "cancelled", ok: false }; }
    const tid = boardId[t.id]!;
    const cur: any = await S.taskGet(runId, tid);
    if (cur.status === "done") { emit("task.skipped", { taskId: t.id, state: cur.result?.status }, `  ✓ ${t.id} already ${cur.result?.status ?? "done"}`); if (cur.result?.status === "merged") completed.push(t.id); continue; }
    const claim: any = await S.taskClaim(runId, { holder: RECIPE_HOLDER, taskId: tid, leaseMs: 6 * 3600_000, key: `claim-${t.id}` });
    emit("task.leased", { taskId: t.id, epoch: claim.epoch }, `  → ${t.id} (epoch ${claim.epoch})`);
    const profile = t.agent ? decodeAgentRef(t.agent) : null;
    let outcome: { status: "merged" | "failed" | "awaiting_approval"; sha?: string; reason?: string } = { status: "failed", reason: "no attempt" };
    let feedback = "";
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const k = `${t.id}-a${attempt}`;
      const a = await spawnAgent({ runId, task: feedback ? `${t.goal}\n\nPrevious attempt failed: ${feedback}` : t.goal, key: k, contract: { planTask: t.id, attempt }, ...(profile ? { profile: profile.name, overrides: profile.overrides } : {}), budget: { usd: 1 } });
      const done: any = await awaitAgents(runId, [a.agentId], { timeoutMs: 6 * 3600_000 });
      if (done.agents[0].status !== "done") { feedback = `agent ${done.agents[0].status}`; continue; }
      const v: any = await verifyRef({ runId, ref: a.agentId, key: `v-${k}`, ...(target ? { target } : {}) });
      if (v.state !== "passed") {
        feedback = v.result?.checks?.reason ?? v.result?.checks?.status ?? "verification failed";
        emit(v.result?.checks?.status === "conflict" ? "task.conflict" : "task.verify_failed", { taskId: t.id, attempt, reason: feedback }, `  ✗ ${t.id} attempt ${attempt}: ${feedback}`);
        outcome = { status: "failed", reason: feedback };
        continue;
      }
      const tgt = v.target as string;
      let operator = false;
      if (isProtectedBranch(tgt)) {
        // Protected target: park until `capcomd approve <runId> <task>` writes approval/<task>.
        emit("task.awaiting_approval", { taskId: t.id, targetBranch: tgt }, `  ⏸ ${t.id} verified; merge into protected ${tgt} awaits approval (capcomd approve ${runId} ${t.id})`);
        const deadline = Date.now() + (opts.approvalTimeoutMs ?? 24 * 3600_000);
        while (!((await S.kvGet(runId, `approval/${t.id}`)) as any).value) {
          if (Date.now() > deadline) throw new RelayError("run_failed", `Approval for ${t.id} timed out`, `Run \`capcomd approve ${runId} ${t.id}\` then resume.`);
          await sleep(opts.approvalPollMs ?? 1000);
        }
        operator = true; // the approval is the operator's act
      }
      const m: any = await mergeRef({ runId, ref: a.agentId, require: v.id, key: `m-${k}`, target: tgt, operator });
      if (m.state === "merged") { outcome = { status: "merged", sha: m.result?.sha }; break; }
      feedback = m.result?.status === "conflict" ? `merge conflict in ${(m.result.files ?? []).join(", ")}` : String(m.result?.reason ?? "merge failed");
      emit("task.conflict", { taskId: t.id, attempt, reason: feedback }, `  ⚠ ${t.id} ${feedback}; ${attempt < MAX_ATTEMPTS ? "back to worker" : "retries exhausted"}`);
      outcome = { status: "failed", reason: feedback };
    }
    await S.taskFinish(runId, { taskId: tid, holder: RECIPE_HOLDER, epoch: claim.epoch, outcome: "done", result: outcome, key: `done-${t.id}` }).catch((e) => { if (!String(e?.message).includes("is done")) throw e; });
    if (outcome.status === "merged") { completed.push(t.id); emit("task.merged", { taskId: t.id, commitSha: outcome.sha ?? null }, `  ✓ ${t.id} verified and merged${outcome.sha ? ` (${outcome.sha.slice(0, 12)})` : ""}`); }
    else emit("task.failed", { taskId: t.id, reason: outcome.reason }, `  ✗ ${t.id} failed: ${outcome.reason}`);
  }

  // 5. judge the goal over the completed tasks (same judge actor and ledger transitions).
  run = await runH.getRun({ runId });
  if (run?.state === "executing") { emit("run.judging", {}, "\n→ All tasks complete, judging..."); await runH.allTasksTerminal({ runId }); run = await runH.getRun({ runId }); }
  if (run?.state === "judging") {
    const judgeId = `${runId}-judge`;
    const jh = c.judge.getOrCreate([runId, "final"]);
    const ex = await jh.getJudge({ judgeId });
    const j = ex ? { passed: ex.context.passed !== false, feedback: ex.context.feedback ?? "Goal achieved", cost: ex.context.cost ?? 0 } : await jh.judge({ judgeId, runId, goal: opts.goal, completedTasks: completed });
    await runH.chargeBudget({ runId, chargeId: `${runId}-judge`, amount: j.cost });
    await S.kvWrite(runId, { k: "recipe/judge", value: { passed: j.passed, feedback: j.feedback }, key: "judge-result" });
    if (j.passed) { await runH.judgePass({ runId }); emit("run.completed", { state: "completed", feedback: j.feedback }, `\n✓ Run completed successfully\n  ${j.feedback}\n\nRun ID: ${runId}`); return { runId, state: "completed", ok: true, feedback: j.feedback }; }
    await runH.judgeFail({ runId, reason: j.feedback });
    emit("run.failed", { state: "failed", feedback: j.feedback }, `\n✗ Run failed\n  ${j.feedback}`);
    return { runId, state: "failed", ok: false, feedback: j.feedback };
  }
  const st = run?.state ?? "missing";
  emit(st === "completed" ? "run.completed" : "run.failed", { state: st }, `\nRun ${runId}: ${st}`);
  return { runId, state: st, ok: st === "completed" };
}
