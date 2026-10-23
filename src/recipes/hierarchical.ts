// ADR-016 step 4: the planner → worker → judge flow of `capcomd run`, written as a recipe over
// the primitives instead of a hard-wired loop. Same actors (planner, worker, verifier, judge,
// run ledger), composed through the scope: run new, task add --after (plan order), task claim,
// spawn, await, verify, merge --require, task done, judge. Every step is keyed by the run and
// task ids, so running it again with the same runId resumes where a crash left off.
import { client, assertEngine, isNoopGoal, reapSandboxes, teardownRun, type RunOptions, type RunResult } from "../core/relay";
import { withSpan } from "../utils/tracing-simple";
import { isBoxdAuthError, BOXD_AUTH_HINT } from "../providers/boxd-errors";
import { preflightNeeded, runPreflight } from "../core/preflight";
import { RelayError } from "../core/errors";
import { decodeAgentRef, parseAgentDirective } from "../agents/profiles";
import { awaitAgents, mergeRef, runNew, spawnAgent, verifyRef } from "../primitives/ops";
import * as S from "../primitives/state";
import { isProtectedBranch } from "../utils/protected";
import { loadMergeConfig } from "../merge/config";

export const RECIPE_HOLDER = "recipe:hierarchical";
const MAX_ATTEMPTS = 4; // the legacy task machine: 1 attempt + maxRetries 3; verify failures and conflicts both retry
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface PlannedTask { id: string; goal: string; agent?: string }

export async function runHierarchicalRecipe(opts: RunOptions & { budgetUsd?: number }): Promise<RunResult> {
  await assertEngine();
  const runId = opts.runId ?? `run-${Date.now().toString(36)}`;
  // Same preflight, reap and auth-failure contract as the legacy path.
  if (preflightNeeded()) {
    const bad = (await runPreflight(process.env, {}, parseAgentDirective(opts.goal).agent)).filter((x) => !x.ok);
    if (bad.length) throw new RelayError("config", `Preflight failed: ${bad.map((x) => x.detail).join("; ")}`, "Fix the credentials above, then rerun. (CAPCOMD_SKIP_PREFLIGHT=1 skips this check.)");
  }
  await reapSandboxes(client(), runId).catch(() => {});
  let result: RunResult;
  try {
    // Same span shape as the legacy path (relay.run → cli.run → actor/transition/model/sandbox/git).
    result = await withSpan("cli.run", { "relay.run_id": runId, "relay.goal": opts.goal, "relay.recipe": "hierarchical" }, () => recipeInner({ ...opts, runId }));
  } catch (error) {
    if (!isBoxdAuthError(error)) throw error;
    const reason = `boxd rejected BOXD_API_KEY (invalid or expired). ${BOXD_AUTH_HINT}`;
    await client().run.getOrCreate([runId]).configFail({ runId, reason });
    opts.emit("run.failed", { state: "failed", reason, kind: "config", retryable: false }, `\n✗ Run failed (config): ${reason}`);
    result = { runId, state: "failed", ok: false, feedback: reason };
  }
  if (["completed", "failed", "cancelled"].includes(result.state)) {
    await teardownRun(client(), runId).catch(() => {});
    opts.emit("worker.destroyed", { workerId: `${runId}-recipe` }, `✓ Sandbox destroyed`);
  }
  return result;
}

async function recipeInner(opts: RunOptions & { budgetUsd?: number }): Promise<RunResult> {
  const emit = opts.emit;
  const c = client();
  const runId = opts.runId ?? `run-${Date.now().toString(36)}`;
  emit("run.started", { goal: opts.goal, targetBranch: opts.targetBranch ?? null, recipe: "hierarchical" }, `Starting run: ${runId} (recipe)\nGoal: ${opts.goal}\n`);

  // 1. scope + run ledger (run new also creates the run actor in "planning").
  const scope = await runNew({ runId, budget: opts.budgetUsd ? { usd: opts.budgetUsd } : {}, label: opts.goal });
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

  for (const t of (pctx?.tasks ?? []) as any[]) if (t && typeof t === "object" && t.agentSpec) emit("agent.resolved", { taskId: t.id, agent: t.agentSpec }, `  agent for ${t.id}: ${t.agentSpec.name ?? t.agentSpec.kind}${t.agentSpec.overridden ? " (overridden)" : ""}`);
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

  // 4. workers. The task-board actor stays the public task ledger (status, events, approve,
  // cancel read it; Hermes consumes that contract), so every attempt drives the same
  // transitions the legacy loop does: lease → started → handoff → verify → merged |
  // awaiting_approval → approved → merged, with the ledger's own retry budget (maxRetries 3).
  // The work itself goes through the primitives: claim, spawn, await, verify, merge --require.
  emit("tasks.executing", {}, "\n→ Executing tasks...");
  const target = opts.targetBranch;
  const hasRepo = !!loadMergeConfig();
  const ledger = c.taskBoard.getOrCreate([runId]);
  const TERMINAL = new Set(["merged", "failed", "cancelled"]);
  for (const t of planned) {
    if (!(await ledger.getTask({ taskId: t.id }))) await ledger.createTask({ taskId: t.id, goal: t.goal, runId, maxRetries: MAX_ATTEMPTS - 1, ...(target ? { targetBranch: target } : {}) });
  }
  const completed: string[] = [];
  for (const t of planned) {
    if ((await runH.getRun({ runId }))?.state === "cancelled") { emit("run.cancelled", { state: "cancelled" }, "\n✗ Run cancelled"); return { runId, state: "cancelled", ok: false }; }
    const tid = boardId[t.id]!;
    let lt: any = await ledger.getTask({ taskId: t.id });
    if (TERMINAL.has(lt.state)) {
      emit("task.skipped", { taskId: t.id, state: lt.state }, `  ✓ ${t.id} already ${lt.state}`);
      if (lt.state === "merged") completed.push(t.id);
      continue;
    }
    const claim: any = await S.taskClaim(runId, { holder: RECIPE_HOLDER, taskId: tid, leaseMs: 6 * 3600_000, key: `claim-${t.id}` });
    const profile = t.agent ? decodeAgentRef(t.agent) : null;
    let feedback = "";
    let lastReason = "";
    while (!TERMINAL.has(lt.state)) {
      if (lt.state === "pending") {
        const g: any = await ledger.grantLease({ taskId: t.id, workerId: `${runId}-recipe` });
        await ledger.flushOutbox({}); // ack the lease's outbox events, as the legacy loop does after provisioning
        emit("task.leased", { taskId: t.id, epoch: g.epoch, workerId: `${runId}-recipe` }, `  → ${t.id} (epoch ${g.epoch})`);
        lt = await ledger.getTask({ taskId: t.id });
        continue;
      }
      const epoch = Number(lt.context.epoch);
      const k = `${t.id}-e${epoch}`; // one attempt per ledger epoch: replays after a crash, fresh after a retry
      if (lt.state === "awaiting_approval") {
        emit("task.awaiting_approval", { taskId: t.id, targetBranch: lt.context.targetBranch ?? target ?? null }, `  ⏸ ${t.id} verified; merge into protected branch ${lt.context.targetBranch ?? target} awaits approval (capcomd approve ${runId} ${t.id})`);
        const deadline = Date.now() + (opts.approvalTimeoutMs ?? 24 * 3600_000);
        while (lt.state === "awaiting_approval") {
          if (Date.now() > deadline) throw new RelayError("run_failed", `Approval for ${t.id} timed out`, `Run \`capcomd approve ${runId} ${t.id}\` then resume with \`capcomd run --run-id ${runId} <goal>\`.`);
          await sleep(opts.approvalPollMs ?? 1000);
          lt = await ledger.getTask({ taskId: t.id });
        }
        if (lt.state === "cancelled") emit("task.cancelled", { taskId: t.id, state: lt.state }, `  ✗ ${t.id} cancelled`);
        continue;
      }
      const a = await spawnAgent({ runId, task: feedback ? `${t.goal}\n\nPrevious attempt failed: ${feedback}` : t.goal, key: k, contract: { planTask: t.id, epoch }, ...(profile ? { profile: profile.name, overrides: profile.overrides } : {}) });
      if (lt.state === "leased") { await ledger.workerStarted({ taskId: t.id, epoch }); lt = await ledger.getTask({ taskId: t.id }); }
      const done: any = await awaitAgents(runId, [a.agentId], { timeoutMs: 6 * 3600_000 });
      const ag = done.agents[0];
      if (ag.status === "failed" && isBoxdAuthError(String(ag.result?.error ?? ""))) throw new Error(String(ag.result.error)); // non-retryable: fail the run as config
      if (lt.state === "running") { await ledger.handoffTask({ taskId: t.id, epoch, branch: ag.result?.branch ?? "", commitSha: ag.result?.commit ?? "" }); lt = await ledger.getTask({ taskId: t.id }); }
      if (lt.state === "handed_off") { await ledger.startVerify({ taskId: t.id }); lt = await ledger.getTask({ taskId: t.id }); }
      if (ag.status !== "done") {
        feedback = lastReason = `agent ${ag.status}`;
        if (lt.state === "verifying") await ledger.verifyComplete({ taskId: t.id, passed: false, target });
        emit("task.verify_failed", { taskId: t.id, reason: feedback }, `  ✗ ${t.id} verification failed: ${feedback}`);
        lt = await ledger.getTask({ taskId: t.id });
        continue;
      }
      const approved = lt.state === "approved";
      const v: any = await verifyRef({ runId, ref: a.agentId, key: `v-${k}`, ...(target ? { target } : {}) });
      if (v.state !== "passed") {
        const conflict = v.result?.checks?.status === "conflict";
        feedback = lastReason = v.result?.checks?.reason ?? v.result?.checks?.status ?? "verification failed";
        if (approved) throw new RelayError("run_failed", `Merge of ${t.id} failed: ${feedback}`, `Fix the cause, then resume with \`capcomd run --run-id ${runId} <goal>\`.`);
        if (conflict) await ledger.mergeConflict({ taskId: t.id, files: v.result?.checks?.files ?? [], epoch });
        else await ledger.verifyComplete({ taskId: t.id, passed: false, target });
        lt = await ledger.getTask({ taskId: t.id });
        emit(conflict ? (lt.state === "failed" ? "task.conflict_escalated" : "task.conflict") : "task.verify_failed", { taskId: t.id, epoch, reason: feedback }, `  ✗ ${t.id} epoch ${epoch}: ${feedback}`);
        continue;
      }
      // Protection follows the legacy rule: the run's target, or the repo's default when a repo is configured.
      const tgt = v.target as string;
      const effective = target ?? (hasRepo ? tgt : undefined);
      if (!approved && effective && isProtectedBranch(effective)) {
        await ledger.verifyComplete({ taskId: t.id, passed: true, commitSha: ag.result?.commit ?? undefined, target: effective });
        lt = await ledger.getTask({ taskId: t.id });
        continue; // → awaiting_approval
      }
      const m: any = await mergeRef({ runId, ref: a.agentId, require: v.id, key: `m-${k}`, target: tgt, operator: approved });
      if (m.state !== "merged") {
        const conflict = m.result?.status === "conflict";
        feedback = lastReason = conflict ? `merge conflict in ${(m.result.files ?? []).join(", ")}` : String(m.result?.reason ?? "merge failed");
        if (approved && !conflict) throw new RelayError("run_failed", `Merge of ${t.id} failed: ${feedback}`, `Fix the cause, then resume with \`capcomd run --run-id ${runId} <goal>\`.`);
        if (conflict) await ledger.mergeConflict({ taskId: t.id, files: m.result.files ?? [], targetSha: m.result.targetSha, epoch });
        else await ledger.verifyComplete({ taskId: t.id, passed: false, target });
        lt = await ledger.getTask({ taskId: t.id });
        emit(conflict ? (lt.state === "failed" ? "task.conflict_escalated" : "task.conflict") : "task.verify_failed", { taskId: t.id, epoch, reason: feedback }, `  ⚠ ${t.id} ${feedback}`);
        continue;
      }
      const sha = m.result?.sha ?? null;
      const merge = { sha, mode: m.result?.mode, strategy: m.result?.strategy, how: m.result?.how, already: m.result?.already, target: tgt, ...(m.result?.pr ? { pr: m.result.pr } : {}) };
      if (approved) await ledger.mergeComplete({ taskId: t.id, merge });
      else await ledger.verifyComplete({ taskId: t.id, passed: true, commitSha: sha ?? undefined, target, merge });
      lt = await ledger.getTask({ taskId: t.id });
      emit(approved ? "task.approved" : "task.merged", { taskId: t.id, commitSha: sha, merge, approvedBy: approved ? (lt.context.approval?.approvedBy ?? null) : null },
        approved ? `  ✓ ${t.id} approved and merged${sha ? ` (${String(sha).slice(0, 12)})` : ""}` : `  ✓ ${t.id} verified and merged${sha ? ` (${String(sha).slice(0, 12)})` : ""}`);
    }
    const outcome = lt.state === "merged" ? { status: "merged", sha: lt.context.merge?.sha ?? null } : { status: lt.state, reason: lastReason || lt.state };
    await S.taskFinish(runId, { taskId: tid, holder: RECIPE_HOLDER, epoch: claim.epoch, outcome: "done", result: outcome, key: `done-${t.id}` }).catch((e) => { if (!String(e?.message).includes("is done")) throw e; });
    if (lt.state === "merged") completed.push(t.id);
  }

  // 5. judge the goal over the completed tasks (same judge actor and ledger transitions).
  run = await runH.getRun({ runId });
  if (run?.state === "cancelled") { emit("run.cancelled", { state: "cancelled" }, "\n✗ Run cancelled"); return { runId, state: "cancelled", ok: false }; }
  if (run?.state === "executing") { emit("run.judging", {}, "\n→ All tasks complete, judging..."); await runH.allTasksTerminal({ runId }); run = await runH.getRun({ runId }); }
  if (run?.state === "judging") {
    const judgeId = `${runId}-judge`;
    const jh = c.judge.getOrCreate([runId, "final"]);
    const ex = await jh.getJudge({ judgeId });
    const j = ex ? { passed: ex.context.passed !== false, feedback: ex.context.feedback ?? "Goal achieved", cost: ex.context.cost ?? 0 } : await jh.judge({ judgeId, runId, goal: opts.goal, completedTasks: completed, noop: isNoopGoal(opts.goal) });
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
