// `capcomd run "<goal>" --profile P` (POST /v1/runs `profile`, the desktop's Team launcher): a run of one agent of that
// profile. The run gets the project's gates and its goal branch as a planner run does; the agent works on the goal
// itself (no planner splits it), and this process, the run's driver, verifies its work and merges it onto the goal
// branch, then says the goal is done (a driver's run: no planner agent decides that). Without a goal branch
// (--no-goal-branch) the work merges into the target, which waits for a person when the target is protected.
import { assertEngine, client, type RunOptions, type RunResult } from "../core/relay";
import { RelayError } from "../core/errors";
import { awaitAgents, endRun, mergeRef, runNew, spawnAgent, verifyRef } from "../primitives/ops";
import { TERMINAL_AGENT } from "../primitives/policy";
import { decodeAgentRef } from "../profiles";

/** The key its one agent is spawned with (never "planner": that would make it the run's planner, plannerOf). */
export const SINGLE_AGENT_KEY = "agent";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs the goal with one agent of `profile` (a name, or an encoded ref with overrides); ok when its work landed. */
export async function runWithAgent(opts: RunOptions & { profile: string; budget?: Record<string, number>; goalBranch?: { branch: string; base: string }; pollMs?: number }): Promise<RunResult> {
  await assertEngine();
  const emit = opts.emit;
  const runId = opts.runId!;
  const pollMs = opts.pollMs ?? 2000;
  const d = process.env.CAPCOMD_NO_CONFIG ? {} : (await import("../config/store")).runDefaults();
  const g = opts.goalBranch;
  const target = g ? g.branch : opts.targetBranch ?? d.target;
  const run = await runNew({ runId, budget: opts.budget ?? {}, label: opts.goal, goal: opts.goal, checks: d.checks ?? {}, ...(d.reviewer ? { reviewer: d.reviewer } : {}),
    ...(g ? { goalBranch: g.branch, base: g.base } : target ? { target } : {}), ...(opts.sandbox ? { sandbox: opts.sandbox } : {}), ...(opts.pluginConfig ? { pluginConfig: opts.pluginConfig } : {}) });
  const gates = { checks: Object.keys(d.checks ?? {}), reviewer: d.reviewer ?? null, target: target ?? null, ...(g ? { base: g.base } : {}) };
  const ref = decodeAgentRef(opts.profile);
  emit("run.started", { goal: opts.goal, agent: ref.name, gates, recipe: "agent" }, `Starting run: ${runId}\nGoal: ${opts.goal}\nAgent: ${ref.name}${gates.checks.length ? `  checks: ${gates.checks.join(", ")}` : ""}${gates.reviewer ? `  reviewer: ${gates.reviewer}` : ""}${g ? `  goal branch: ${g.branch} (from ${g.base})` : gates.target ? `  target: ${gates.target}` : ""}\n`);
  if (!run.created) emit("run.resumed", { runId }, "✓ Run resumed");

  // The run ends failed with the reason (its goal branch then shows stopped), unless it was cancelled meanwhile.
  const fail = async (reason: string, data: Record<string, unknown> = {}, hint?: string): Promise<RunResult> => {
    const end = await endRun(runId, "failed", reason, null, { evenIfAgentsEnded: true }).catch(() => ({ changed: false, state: "failed" }));
    if (end.state === "cancelled") {
      emit("run.cancelled", { state: "cancelled", reason }, `\n✗ Run ${runId} was cancelled`);
      return { runId, state: "cancelled", ok: false, feedback: reason };
    }
    emit("run.failed", { state: "failed", reason, ...data, ...(hint ? { hint } : {}), retryable: false }, `\n✗ Run failed: ${reason}${hint ? `\n  ${hint}` : ""}\n\nRun ID: ${runId}  (capcomd tree ${runId})`);
    return { runId, state: "failed", ok: false, feedback: reason };
  };

  let agentId: string;
  try {
    const a = await spawnAgent({ runId, task: opts.goal, key: SINGLE_AGENT_KEY, profile: ref.name, ...(ref.overrides ? { overrides: ref.overrides } : {}) });
    agentId = a.agentId;
  } catch (e) {
    return fail(`the agent couldn't start: ${(e as Error)?.message ?? String(e)}`, { kind: e instanceof RelayError ? e.code : "internal" }, e instanceof RelayError ? e.hint : undefined);
  }
  emit("agent.spawned", { agentId, profile: ref.name }, `→ ${ref.name} ${agentId} is working (follow it: capcomd logs ${runId} ${agentId} --follow)`);

  // Its status as it changes, until it ends (a paused agent is waited for).
  let last = "";
  let ag: any;
  for (;;) {
    const r: any = await awaitAgents(runId, [agentId], { timeoutMs: 5000 });
    ag = r.agents[0];
    if (ag.status !== last) { last = ag.status; emit("agent.status", { agentId, parent: null, profile: ref.name, status: ag.status }, `  ${agentId} ${ref.name}: ${ag.status}`); }
    if (TERMINAL_AGENT.has(ag.status)) break;
  }
  const summary = typeof ag.result?.summary === "string" ? ag.result.summary : "";
  if (ag.status !== "done") return fail(`${ref.name} ${ag.status}${ag.result?.error ? `: ${String(ag.result.error).split("\n")[0]}` : ""}`, { agentId, status: ag.status });
  if (!ag.result?.branch) {
    // Nothing to land (a report, or no change): the goal is done with its summary.
    if (g) await (await import("../primitives/goal")).markGoalDone(runId, { by: "operator", summary: summary || null }).catch(() => {});
    emit("run.completed", { state: "completed", agentId, summary, landed: false, ...(g ? { goalBranch: g.branch, base: g.base } : {}) }, `\n✓ ${ref.name} done (no changes to land)\n${summary}\n\nRun ID: ${runId}`);
    return { runId, state: "completed", ok: true };
  }

  emit("verify.started", { agentId }, `→ Verifying ${agentId}`);
  const v: any = await verifyRef({ runId, ref: agentId, key: `v-${agentId}`, ...(target ? { target } : {}) });
  if (v.state !== "passed") return fail(`verification of ${agentId} didn't pass: ${v.result?.checks?.reason ?? v.result?.reason ?? v.result?.checks?.status ?? v.state}`, { agentId, verifyId: v.id });
  emit("verify.passed", { agentId, verifyId: v.id }, `✓ Verified ${agentId}`);
  let m: any = await mergeRef({ runId, ref: agentId, require: v.id, key: `m-${agentId}`, target: v.target as string, requestApproval: true });
  if (m.state === "awaiting_approval") {
    emit("merge.awaiting_approval", { agentId, mergeId: m.id, target: m.target }, `⏸ The merge into ${m.target} waits for a person (capcomd approve ${runId} ${m.id})`);
    const s = client().scope.getOrCreate([runId]);
    while (m.state === "awaiting_approval" || m.state === "running") {
      if ((await s.getScope({}))?.ended) break;
      await sleep(pollMs);
      const op: any = await s.getOp({ opId: m.id });
      if (op) m = { id: op.id, state: op.state, ...op.data, result: op.result };
    }
  }
  if (m.state !== "merged") return fail(`the merge of ${agentId} into ${m.target ?? target} didn't land: ${m.result?.reason ?? m.result?.status ?? m.state}`, { agentId, mergeId: m.id });
  if (g) await (await import("../primitives/goal")).markGoalDone(runId, { by: "operator", summary: summary || null });
  const next = g ? `\n\nThe work is on ${g.branch}. Open a pull request into ${g.base}: capcomd pr open ${runId}  (see it first: capcomd goal ${runId})` : "";
  emit("run.completed", { state: "completed", agentId, summary, landed: true, mergeId: m.id, ...(g ? { goalBranch: g.branch, base: g.base } : {}) }, `\n✓ ${ref.name} done, merged into ${m.target}\n${summary}${next}\n\nRun ID: ${runId}  (capcomd tree ${runId})`);
  return { runId, state: "completed", ok: true };
}
