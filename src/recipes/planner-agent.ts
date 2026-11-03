// `capcomd run "<goal>"` with a real planner: the run gets the project's gates (checks, reviewer, target from
// `capcomd setup`, as an MCP driver's run does), and a planner agent (a profile that may spawn) splits the goal into
// child agents, verifies and merges their work from inside its VM, and reports. The command shows the agent tree as
// it changes and ends with the planner's summary. The fake-model recipe (hierarchical.ts) stays for offline runs.
import { assertEngine, type RunOptions, type RunResult } from "../core/relay";
import { RelayError } from "../core/errors";
import { awaitAgents, endRun, runNew, spawnAgent, treeOf } from "../primitives/ops";
import { TERMINAL_AGENT } from "../primitives/policy";

// The planner choice lives with the run's driver choice (src/agents/run-driver.ts), which GET /v1/run-options reads too.
export { DEFAULT_PLANNER, plannerProfile } from "../agents/run-driver";
import { DEFAULT_PLANNER } from "../agents/run-driver";

export function plannerBrief(goal: string, gates: { checks: string[]; reviewer: string | null; target: string | null; base?: string | null }): string {
  // A goal branch (gates.base set): merges land on it with no approval, and the user reads the summary before opening
  // a pull request into the base, so the summary is written for them.
  const goalBranch = gates.base && gates.target ? gates.target : null;
  return [
    `Goal: ${goal}`,
    "",
    "You are the planner for this goal. Don't change files yourself: use the capcomd command (see the orchestration skill in your instructions).",
    ...(goalBranch ? [`This run's work goes onto its goal branch ${goalBranch}, cut from ${gates.base}. Every child you verify and merge lands there right away, with no approval; when you finish, the user reads your summary and decides whether to open a pull request from ${goalBranch} into ${gates.base}.`, ""] : []),
    "1. Split the goal into tasks that child agents can do independently, and spawn one child per task (`capcomd spawn --task … --key <name>`), each with a self-contained task that says which files to change and how to check the result." +
      (gates.checks.length ? ` Pin the check that fits each child with --check (the operator's checks: ${gates.checks.join(", ")}).` : "") +
      " Land the shared pieces (types, stubs) first in one small child, then spawn every independent task at once. A task with two or more independent parts goes to a lead (`--profile lead --children.maxChildren=3 --children.maxDepth=1`), which splits it among helpers and verifies and merges their work itself.",
    "2. `capcomd await` them. Verify each finished child (`capcomd verify --ref <agt> --key v-<agt>`" + (gates.reviewer ? "; a reviewer agent also reviews it, so give the command a 10-minute timeout and run it again if it is cut off" : "") + `), and merge the ones that pass (\`capcomd merge --ref <agt> --require <vfyId>\`) into ${gates.target ?? "the run's target"}.`,
    "3. A child that failed or didn't pass: spawn one replacement with the failure in its task, or continue its work with `capcomd spawn --continue <agt>`; then verify and merge it.",
    goalBranch
      ? `4. Finish with \`capcomd result --summary "<summary>"\`: it opens the pull request's description, so write it for the person who reviews it: what the change does and why, then per task what landed on ${goalBranch} (child, verified, reviewed) and what didn't (and why), and what is left to do.`
      : '4. Finish with `capcomd result --summary "<per task: child, verified?, merged?; what is left>"`.',
  ].join("\n");
}

/** Runs the goal with a planner agent; ok when the planner finishes "done". */
export async function runWithPlanner(opts: RunOptions & { profile: string; driver?: string; budget?: Record<string, number>; goalBranch?: { branch: string; base: string } }): Promise<RunResult> {
  await assertEngine();
  const emit = opts.emit;
  const runId = opts.runId!;
  // Gates come from the project (`capcomd setup`), as for an MCP driver's runs.
  const d = process.env.CAPCOMD_NO_CONFIG ? {} : (await import("../config/store")).runDefaults();
  // With a goal branch, the run's target is that branch (cut from the base the user picked); without, the project's target.
  const g = opts.goalBranch;
  const target = g ? g.branch : opts.targetBranch ?? d.target;
  const run = await runNew({ runId, budget: opts.budget ?? {}, label: opts.goal, goal: opts.goal, checks: d.checks ?? {}, ...(d.reviewer ? { reviewer: d.reviewer } : {}),
    ...(g ? { goalBranch: g.branch, base: g.base } : target ? { target } : {}), ...(opts.sandbox ? { sandbox: opts.sandbox } : {}) });
  const gates = { checks: Object.keys(d.checks ?? {}), reviewer: d.reviewer ?? null, target: target ?? null, ...(g ? { base: g.base } : {}) };
  // `profile` may be a ref with overrides (`--planner-provider`): show its name and provider.
  const planner = opts.profile.split(";")[0]!, driver = opts.driver ? ` (${opts.driver})` : "";
  emit("run.started", { goal: opts.goal, planner, ...(opts.driver ? { driver: opts.driver } : {}), gates, recipe: "planner" }, `Starting run: ${runId}\nGoal: ${opts.goal}\nPlanner: ${planner}${driver}${gates.checks.length ? `  checks: ${gates.checks.join(", ")}` : ""}${gates.reviewer ? `  reviewer: ${gates.reviewer}` : ""}${g ? `  goal branch: ${g.branch} (from ${g.base})` : gates.target ? `  target: ${gates.target}` : ""}\n`);
  if (!run.created) emit("run.resumed", { runId }, "✓ Run resumed");
  let root: Awaited<ReturnType<typeof spawnAgent>>;
  try {
    // The run is a planner's: its goal is ready when this agent finishes (not when any top-level agent does).
    const { rootAgentIdFor, PLANNER_KV } = await import("../primitives/ops");
    await (await import("../primitives/state")).kvWrite(runId, { k: PLANNER_KV, value: { agentId: rootAgentIdFor(runId, "planner") }, writer: "operator" });
    root = await spawnAgent({ runId, profile: opts.profile, task: plannerBrief(opts.goal, gates), key: "planner" });
  } catch (e) {
    // The run started, but its planner can't: the run ends failed with the reason (not left "started" with no agent).
    const reason = (e as Error)?.message ?? String(e);
    const kind = e instanceof RelayError ? e.code : "internal";
    const end = await endRun(runId, "failed", reason).catch(() => ({ changed: false, state: "failed" }));
    if (end.state === "cancelled") {
      emit("run.cancelled", { state: "cancelled", reason }, `\n✗ Run ${runId} was cancelled before its planner started`);
      return { runId, state: "cancelled", ok: false, feedback: reason };
    }
    emit("run.failed", { state: "failed", reason, kind, ...(e instanceof RelayError && e.hint ? { hint: e.hint } : {}), retryable: false }, `\n✗ Run failed: the planner couldn't start: ${reason}${e instanceof RelayError && e.hint ? `\n  ${e.hint}` : ""}`);
    return { runId, state: "failed", ok: false, feedback: reason };
  }
  emit("planner.spawned", { agentId: root.agentId }, `→ Planner ${root.agentId} is working (follow it: capcomd tree ${runId}, capcomd logs ${runId} ${root.agentId} --follow)`);

  // Show each agent's status as it changes until the planner is finished (a paused planner is waited for).
  const seen = new Map<string, string>();
  const showTree = async () => {
    const t: any = await treeOf(runId).catch(() => null);
    const walk = (n: any): any[] => [n, ...(n.children ?? []).flatMap(walk)];
    for (const n of t ? t.tree.flatMap(walk) : []) {
      const was = seen.get(n.agentId);
      if (was === n.status) continue;
      seen.set(n.agentId, n.status);
      const indent = "  ".repeat(Number(n.depth ?? 0) + 1);
      const what = n.agentId === root.agentId ? "planner" : `${n.profile ?? "agent"}${n.parent && n.parent !== root.agentId ? ` (under ${n.parent})` : ""}`;
      emit("agent.status", { agentId: n.agentId, parent: n.parent ?? null, profile: n.profile ?? null, status: n.status }, `${indent}${n.agentId} ${what}: ${n.status}`);
    }
  };
  for (;;) {
    await showTree();
    const r: any = await awaitAgents(runId, [root.agentId], { timeoutMs: 5000 });
    const a = r.agents[0];
    if (TERMINAL_AGENT.has(a.status)) {
      await showTree();
      const summary = typeof a.result?.summary === "string" ? a.result.summary : a.result?.error ?? "";
      if (a.status === "done") {
        const next = g ? `\n\nThe work is on ${g.branch}. Open a pull request into ${g.base}: capcomd pr open ${runId}  (see it first: capcomd goal ${runId})` : "";
        emit("run.completed", { state: "completed", agentId: root.agentId, summary, ...(g ? { goalBranch: g.branch, base: g.base } : {}) }, `\n✓ Planner done\n${summary}${next}\n\nRun ID: ${runId}  (capcomd tree ${runId})`);
        return { runId, state: "completed", ok: true };
      }
      emit("run.failed", { state: "failed", agentId: root.agentId, status: a.status, reason: summary }, `\n✗ Planner ${a.status}${summary ? `: ${summary}` : ""}\n\nRun ID: ${runId}  (capcomd tree ${runId}, capcomd inspect ${runId} ${root.agentId})`);
      return { runId, state: "failed", ok: false, feedback: summary };
    }
  }
}

/** `capcomd run` on real VMs without a planner profile: the fake model would plan three generic tasks for any goal. */
export function noPlannerError(name?: string): RelayError {
  return new RelayError("config", name ? `profile ${name} can't plan: it doesn't exist or may not spawn agents (children.allowSpawn)` : `no planner profile: capcomd run needs a profile named "${DEFAULT_PLANNER}" that may spawn agents to plan real work`,
    "Run `capcomd setup` (it writes one), or pass --planner <profile> naming a profile with children.allowSpawn.");
}
