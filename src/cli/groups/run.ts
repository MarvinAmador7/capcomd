// front-run's commands (src/plugins/front/groups.ts): a run, start to end, and what it recorded. Moved as they were
// from src/cli/index.ts's `switch`, one function per command (plugin API §17.2 step 8).
import { spawn } from "child_process";
import { existsSync, mkdirSync, openSync, statSync } from "fs";
import { dirname, join } from "path";
import { RelayError, SCHEMA, EXIT } from "../../core/errors";
import { approveTask, assertEngine, executeRun, generateRunId, getStatus, listEvents, paginate } from "../../core/relay";
import { initDependencies } from "../../dependencies";
import { loadTrace, renderTrace } from "../commands/trace";

/** Which `capcomd run <goal>` path runs by default (ADR-016 step 4). */
export const DEFAULT_RUN_PATH: "recipe" | "legacy" = "recipe";
import { type Cmd, type KernelCommand, usage, out, deepMerge, runTraceAt } from "./common";

/** `capcomd run` */
async function runCommand({ positionals, values, json }: Cmd): Promise<number> {
  if (positionals[1] === "new" && positionals.length === 2) {
    const { parseBudget } = await import("../../primitives/policy");
    let budget: Record<string, number> = {}; // no budget: the run is unlimited
    try { if (values.budget !== undefined) budget = parseBudget(values.budget); } catch (e) { usage(`--budget: ${(e as Error).message} (e.g. 5 or usd=5,turns=200,wallSeconds=3600)`); }
    const P = await import("../../primitives/ops");
    // Flags win; else the project's `capcomd setup` defaults (.capcomd/config.json "run").
    const d = process.env.CAPCOMD_NO_CONFIG ? {} : (await import("../../config/store")).runDefaults();
    const checks = values["checks-set"] ? P.parseCheckSet(values["checks-set"] as string[]) : (d.checks ?? {});
    const reviewer = (values.reviewer as string | undefined) ?? d.reviewer;
    const target = (values.target as string | undefined) ?? d.target;
    // --goal-branch G --base B: the run's target is G, cut from B (no default base: the operator names both).
    const goalBranch = values["goal-branch"] as string | undefined, base = values.base as string | undefined;
    if ((goalBranch !== undefined || base !== undefined) && (values.target !== undefined || values["target-from"] !== undefined)) usage("--goal-branch/--base replace --target/--target-from: pass one pair");
    // --sandbox NAME: where this run's agents and checks run (recorded with the run); default: the project's.
    const sandbox = values.sandbox !== undefined ? await (await import("../../config/sandbox")).askedSandbox(String(values.sandbox)) : undefined;
    const pluginConfig = await runPluginConfig(values);
    const r = await P.runNew({ ...(pluginConfig ? { pluginConfig } : {}), budget, label: values.label as string | undefined, ...(values.goal ? { goal: values.goal as string } : {}), key: values.key as string | undefined, runId: values["run-id"] as string | undefined, checks, ...(reviewer ? { reviewer } : {}), ...(sandbox ? { sandbox } : {}),
      ...(goalBranch !== undefined || base !== undefined ? { ...(goalBranch !== undefined ? { goalBranch } : {}), ...(base !== undefined ? { base } : {}) } : { ...(target ? { target } : {}), ...(values["target-from"] ? { targetFrom: values["target-from"] as string } : {}) }) });
    if (json) out(r); else console.log(r.runId);
    return EXIT.ok;
  }
  const rawGoal = positionals[1];
  if (!rawGoal) usage("goal required: capcomd run <goal>");
  // --plugin-config name.key=value: the run's per-run plugin settings, checked now (refused before anything starts).
  const pluginConfig = await runPluginConfig(values);
  if (pluginConfig && values.legacy) usage("--plugin-config needs a planner or recipe run (not --legacy)");
  // A planner agent plans real work: --planner P, or on real VMs the profile named "planner" (capcomd setup writes
  // it). The built-in recipe's planner is a placeholder model, so real VMs need --recipe/--legacy to use it.
  const PA = await import("../../recipes/planner-agent");
  // --sandbox NAME: where this run's agents and checks run (recorded with the run), instead of CAPCOMD_SANDBOX.
  // This process (the planner's choice, preflight, the run's driver) sees it as its own CAPCOMD_SANDBOX.
  let runSandbox: string | undefined;
  if (values.sandbox !== undefined) {
    const RS = await import("../../providers/run-sandbox");
    const n = String(values.sandbox).toLowerCase();
    if (!RS.isProviderName(n)) usage(`--sandbox names where the run's agents run: docker or boxd (got ${values.sandbox})`);
    if (values.legacy || (!values.recipe && !values.planner && !values["planner-provider"] && !values["planner-effort"] && !values["planner-model"] && (process.env.CAPCOMD_RUN_PATH ?? DEFAULT_RUN_PATH) === "legacy")) usage("--sandbox needs a planner or recipe run (not --legacy)");
    process.env.CAPCOMD_SANDBOX = n;
    delete process.env.RELAY_SANDBOX;
    runSandbox = n;
  }
  // --planner-provider claude|codex: who drives the run, i.e. the planner agent's provider (src/agents/run-driver.ts).
  const driver = values["planner-provider"] as string | undefined;
  if (driver !== undefined) {
    if (values.recipe || values.legacy) usage("--planner-provider runs a planner agent; don't combine it with --recipe/--legacy");
    if (driver !== "claude" && driver !== "codex") usage(`--planner-provider must be claude or codex (got ${driver})`);
  }
  // --planner-effort LEVEL: the planner's reasoning effort (one of its provider's levels; checked with the profile).
  const effort = values["planner-effort"] as string | undefined;
  if (effort !== undefined && (values.recipe || values.legacy)) usage("--planner-effort sets a planner agent's effort; don't combine it with --recipe/--legacy");
  // --planner-model ID: the planner's model (one its provider offers, src/config/models.ts; checked with the profile).
  const plannerModel = values["planner-model"] as string | undefined;
  if (plannerModel !== undefined && (values.recipe || values.legacy)) usage("--planner-model sets a planner agent's model; don't combine it with --recipe/--legacy");
  if (plannerModel !== undefined && !plannerModel.trim()) usage("--planner-model needs a model id");
  const realVms = (await import("../../providers/registry")).realSandbox();
  let planner: string | null = null;
  if (values.planner !== undefined) {
    if (values.recipe || values.legacy) usage("--planner runs a planner agent; don't combine it with --recipe/--legacy");
    planner = PA.plannerProfile(values.planner as string);
    if (!planner) throw PA.noPlannerError(values.planner as string);
  } else if (driver !== undefined || effort !== undefined || plannerModel !== undefined || (!values.recipe && !values.legacy && !process.env.CAPCOMD_RUN_PATH && realVms)) {
    planner = PA.plannerProfile();
    if (!planner) throw PA.noPlannerError();
  }
  // The planner agent's ref: its profile, with the provider swapped when --planner-provider names another.
  let plannerRef = planner;
  if (planner && (driver || effort || plannerModel)) {
    const RD = await import("../../agents/run-driver");
    const p = (driver as "claude" | "codex" | undefined) ?? RD.profileProvider(planner);
    const d = RD.plannerDriver(p, planner, process.env, effort, undefined, plannerModel);
    if (!d.ok && (d.code === "effort" || d.code === "model")) usage(d.reason);
    if (!d.ok) throw new RelayError("config", `${p} can't drive this run: ${d.reason}`, `Log in with \`capcomd auth login ${p}\` (or set its API key), or leave out --planner-provider to use the planner profile's own provider.`);
    plannerRef = d.ref;
  }
  if (planner && (values.profile || values.agent || (values.set as string[] | undefined)?.length || values.overrides)) usage("--profile/--set pick the worker of the built-in recipe; a planner agent picks its own workers (from its profile's children.allowedChildProfiles)");
  // The checks the planner's spawn makes (its profile, the env snapshot its CLI needs on this run's sandbox, egress),
  // made before the run is created or detached: a run whose planner can't start is refused with the reason here,
  // instead of starting and then sitting with no agent.
  if (plannerRef) (await import("../../primitives/ops")).spawnChecks(plannerRef);
  // Humans only (scripts and --json callers read stdout; stderr isn't a terminal for them).
  if (!planner && process.stderr.isTTY) console.error(`capcomd run ${realVms ? "--recipe" : "without a planner agent"} plans with a placeholder model (the same generic tasks for any goal) and judges nothing. For real work: --planner <profile> (capcomd setup writes one named "planner"), or the primitives (run new, spawn, verify, merge).`);
  // --profile/--agent NAME [--set k=v …] [--overrides JSON] [--operator] becomes the goal directive
  // the planner/worker/preflight read. Overrides may only narrow the profile unless --operator.
  const agentFlag = (values.profile ?? values.agent) as string | undefined;
  const sets = (values.set as string[] | undefined) ?? [];
  if ((sets.length || values.overrides || values.operator) && !agentFlag) usage("--set/--overrides/--operator need --profile NAME");
  let goal = rawGoal;
  if (agentFlag) {
    if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(agentFlag)) usage(`invalid --profile ${agentFlag}`);
    const P = await import("../../profiles");
    let set: Record<string, unknown> = {};
    try {
      if (values.overrides) set = JSON.parse(values.overrides as string);
      set = deepMerge(set, P.parseSetPairs(sets));
    } catch (e) { usage(`bad override: ${(e as Error).message}`); }
    const ref = P.encodeAgentRef(agentFlag, { set, operator: !!values.operator });
    try { P.resolveAgent(ref); } catch (e) { throw new RelayError("config", (e as Error).message, "Overrides may only narrow the profile (fewer turns/budget/tools/egress, stricter sandbox, smaller children limits); pass --operator to widen deliberately."); }
    if (!/^\s*\[agent:/i.test(rawGoal)) goal = `[agent:${ref}] ${rawGoal}`;
  }
  const runId = (values["run-id"] as string | undefined) ?? generateRunId();
  let targetBranch = values["target-branch"] as string | undefined;
  await assertEngine();
  // A planner run gets a goal branch (unless --no-goal-branch): cut from the base the user picked (--base; with a goal
  // branch, --target-branch names the base too), else the project's target, else origin's default branch. Decided
  // here, before the run detaches, so a base nobody can determine is refused now (never a made-up "main").
  let goalBranch: { branch: string; base: string } | null = null;
  if (values["no-goal-branch"] && (values["goal-branch"] !== undefined || values.base !== undefined)) usage("--no-goal-branch can't be combined with --goal-branch or --base");
  if (values["goal-branch"] !== undefined && !planner) usage("--goal-branch needs a planner run (the built-in recipe merges into its target)");
  // The built-in recipe has no goal branch: its work merges into the base it was given.
  if (!planner && values.base !== undefined) {
    if (targetBranch !== undefined && targetBranch !== values.base) usage("--base and --target-branch name different branches");
    targetBranch = values.base as string;
  }
  if (planner && !values["no-goal-branch"]) {
    if (values.base !== undefined && targetBranch !== undefined && values.base !== targetBranch) usage("--base and --target-branch name different branches: with a goal branch, pass only --base");
    const G = await import("../../merge/goal");
    const { env: envVar } = await import("../../utils/env");
    const cfg = (await import("../../merge/config")).loadMergeConfig();
    const d = process.env.CAPCOMD_NO_CONFIG ? {} : (await import("../../config/store")).runDefaults();
    // A run resumed with its id keeps the goal branch it has (read without creating the run's scope).
    const { GOAL_KV } = await import("../../primitives/ops");
    const pv: any = (await (await import("../../core/relay")).existingActor("scope", [runId]).then((x) => x?.kvGet({ k: GOAL_KV }) ?? null).catch(() => null))?.value;
    const prior = typeof pv?.branch === "string" && typeof pv?.base === "string" ? { branch: pv.branch as string, base: pv.base as string } : undefined;
    // The project's forge says which branches exist (its service, else the remote itself: plugin API §7.4).
    const r = await G.resolveGoalBranch({
      goal: rawGoal, base: (values.base as string | undefined) ?? targetBranch ?? prior?.base ?? null, goalBranch: (values["goal-branch"] as string | undefined) ?? prior?.branch ?? null,
      projectTarget: d.target ?? envVar("MERGE_TARGET") ?? null, remote: cfg?.remote ?? null, merge: cfg, cwd: process.cwd(), reuse: prior?.branch ?? (values["goal-branch"] as string | undefined) ?? null,
    });
    goalBranch = { branch: r.goalBranch, base: r.base };
    targetBranch = undefined;
  }

  if (values.detach) {
    const dir = join((await import("../../utils/home")).stateDir(), "runs");
    mkdirSync(dir, { recursive: true });
    const log = join(dir, `${runId}.ndjson`);
    const fd = openSync(log, "a");
    const goalArgs = goalBranch ? ["--goal-branch", goalBranch.branch, "--base", goalBranch.base] : values["no-goal-branch"] ? ["--no-goal-branch"] : [];
    const [cmd, ...args] = (await import("../../utils/self")).selfArgv("run", "--json", "--run-id", runId, ...(targetBranch ? ["--target-branch", targetBranch] : []), ...goalArgs, ...(planner ? ["--planner", planner] : values.recipe ? ["--recipe"] : values.legacy ? ["--legacy"] : []), ...(driver ? ["--planner-provider", driver] : []), ...(effort ? ["--planner-effort", effort] : []), ...(plannerModel ? ["--planner-model", plannerModel] : []), ...(runSandbox ? ["--sandbox", runSandbox] : []), ...(pluginConfig ? (await import("../../plugins/run-config")).pluginConfigFlags(pluginConfig) : []), "--", goal);
    const child = spawn(cmd!, args, { detached: true, stdio: ["ignore", fd, fd], env: process.env });
    child.unref();
    if (json) out({ runId, detached: true, log, pid: child.pid, ...(goalBranch ? { goalBranch: goalBranch.branch, base: goalBranch.base } : {}) });
    else console.log(`Started run ${runId} in the background (log: ${log})`);
    return EXIT.ok;
  }

  initDependencies();
  // ADR-016 step 4: the planner→worker→judge flow as a recipe over the primitives, or the
  // legacy hard-wired loop. --recipe/--legacy, else CAPCOMD_RUN_PATH, else the default.
  if (values.recipe && values.legacy) usage("pass at most one of --recipe / --legacy");
  const runPath = values.recipe ? "recipe" : values.legacy ? "legacy" : (process.env.CAPCOMD_RUN_PATH ?? DEFAULT_RUN_PATH);
  if (runPath !== "recipe" && runPath !== "legacy") usage(`CAPCOMD_RUN_PATH must be recipe or legacy, got ${runPath}`);
  if (pluginConfig && !planner && runPath === "legacy") usage("--plugin-config needs a planner or recipe run (not the legacy path)");
  let lineSeq = 0;
  const emit = (type: string, data: Record<string, unknown>, human: string) => {
    const now = Date.now();
    if (json) console.log(JSON.stringify({ schema: SCHEMA, type, runId, seq: ++lineSeq, ts: new Date(now).toISOString(), epochMs: now, agentId: (data.agentId as string | undefined) ?? null, ...data }));
    else console.log(human);
  };
  const result = planner
    ? await PA.runWithPlanner({ goal, runId, targetBranch, emit, profile: plannerRef!, ...(driver ? { driver } : {}), ...(runSandbox ? { sandbox: runSandbox } : {}), ...(goalBranch ? { goalBranch } : {}), ...(pluginConfig ? { pluginConfig } : {}) })
    : runPath === "recipe"
    ? await (await import("../../recipes/hierarchical")).runHierarchicalRecipe({ goal, runId, targetBranch, emit, ...(runSandbox ? { sandbox: runSandbox } : {}), ...(pluginConfig ? { pluginConfig } : {}) })
    : await executeRun({ goal, runId, targetBranch, emit });
  if (json) { const now = Date.now(); console.log(JSON.stringify({ schema: SCHEMA, type: "run.result", runId, seq: ++lineSeq, ts: new Date(now).toISOString(), epochMs: now, agentId: null, ok: result.ok, state: result.state })); }
  return result.ok ? EXIT.ok : EXIT.run_failed;
}

/** `--plugin-config <plugin>.<key>=<value>` (repeatable), checked against the plugins' per-run settings; null: none. */
async function runPluginConfig(values: Cmd["values"]): Promise<Record<string, Record<string, unknown>> | null> {
  const flags = (values["plugin-config"] as string[] | undefined) ?? [];
  if (!flags.length) return null;
  const RC = await import("../../plugins/run-config");
  return RC.checkRunPluginConfig(RC.parsePluginConfigFlags(flags));
}

/** `capcomd goal` */
async function goalCommand({ positionals, values, json }: Cmd): Promise<number> {
  // capcomd goal <runId> | capcomd goal keep <runId>
  const G = await import("../../primitives/goal");
  if (positionals[1] === "done") {
    const runId = positionals[2] ?? usage("runId required: capcomd goal done <runId> [--summary S]");
    const v = await G.markGoalDone(runId, { by: (values.by as string | undefined) ?? "operator", summary: (values.summary as string | undefined) ?? null });
    if (json) out({ goal: v }); else console.log(`${v.branch} is ready (${v.landed.length} landed). Open a pull request with \`capcomd pr open ${runId}\`.`);
    return EXIT.ok;
  }
  if (positionals[1] === "keep") {
    const runId = positionals[2] ?? usage("runId required: capcomd goal keep <runId>");
    const r = await G.keepGoalBranch(runId, { by: (values.by as string | undefined) ?? "operator" });
    if (json) out(r); else console.log(`Kept ${r.branch} (no pull request).`);
    return EXIT.ok;
  }
  const runId = positionals[1] ?? usage("runId required: capcomd goal <runId>");
  const v = await G.goalView(runId);
  if (json) { out({ goal: v }); return EXIT.ok; }
  const c = v.compare;
  console.log(`Goal branch: ${v.branch} (from ${v.base})  ${v.state}`);
  console.log(c.error ? `Compare: ${c.error}` : `${c.ahead} commit(s) ahead of ${v.base}, ${c.filesTotal} file(s), +${c.added} -${c.removed}`);
  const label = (w: { title?: string | null; task: string; continues?: string[] }) =>
    `${w.title || w.task}${w.continues?.length ? ` (carries on ${w.continues.join(", ")})` : ""}`;
  if (v.landed.length) { console.log("\nLanded:"); for (const l of v.landed) console.log(`  ${l.agentId} ${label(l)}  (${l.review ? (l.review.passed ? "reviewed" : "review failed") : "no reviewer"})`); }
  if (v.notLanded.length) { console.log("\nNot landed:"); for (const n of v.notLanded) console.log(`  ${n.agentId} ${label(n)}: ${n.reason}${n.detail ? ` (${n.detail.split("\n")[0]})` : ""}`); }
  if (v.summary) console.log(`\nPlanner's summary:\n${v.summary}`);
  console.log(v.pullRequest ? `\nPull request: #${v.pullRequest.number}${v.pullRequest.url ? ` ${v.pullRequest.url}` : ""}`
    : v.openPullRequest.available ? `\n${v.openPullRequest.confirm ? `${v.openPullRequest.confirm}\n` : ""}Open a pull request: capcomd pr open ${runId}` : `\n${v.openPullRequest.reason}`);
  return EXIT.ok;
}

/** `capcomd pr` */
async function prCommand({ positionals, values, json }: Cmd): Promise<number> {
  if (positionals[1] !== "open") usage("usage: capcomd pr open <runId>");
  const runId = positionals[2] ?? usage("runId required: capcomd pr open <runId>");
  const G = await import("../../primitives/goal");
  const by = (values.by as string | undefined) ?? "operator";
  // A run whose planner stopped before it finished: ask first on a terminal; --yes otherwise.
  const r = await G.openGoalPullRequest(runId, { by, stopped: values.yes === true }).catch(async (e) => {
    if (!(e instanceof RelayError) || e.reason !== "stopped" || json) throw e;
    const p = (await import("../prompt")).prompter();
    if (!p.interactive || !(await p.confirm(e.message, false))) throw e;
    return G.openGoalPullRequest(runId, { by, stopped: true });
  });
  if (json) out(r);
  else console.log(`${r.created ? "Opened" : "Already open:"} pull request #${r.pullRequest.number} from ${r.branch} into ${r.base}${r.pullRequest.url ? `: ${r.pullRequest.url}` : ""}`);
  return EXIT.ok;
}

/** `capcomd status` */
async function statusCommand({ positionals, json }: Cmd): Promise<number> {
  const runId = positionals[1] ?? usage("runId required: capcomd status <runId>");
  const s = await getStatus(runId);
  if (json) out({ run: s });
  else {
    console.log((await import("../status-text")).statusText(s).join("\n"));
    if (s.tasks.length) {
      console.log(`\nTasks:`);
      for (const t of s.tasks) console.log(`  ${t.taskId}: ${t.state}${t.targetBranch ? ` → ${t.targetBranch}` : ""}`);
    }
    if (s.awaitingApproval.length) console.log(`\nAwaiting approval: ${s.awaitingApproval.join(", ")}  (capcomd approve ${s.runId} <taskId>)`);
    console.log(`\nEvents: ${s.events} total`);
  }
  return EXIT.ok;
}

/** `capcomd inspect` */
async function inspectCommand({ positionals, values, json }: Cmd): Promise<number> {
  const runId = positionals[1] ?? usage("capcomd inspect <runId> [agt] [--json] [--follow]");
  if (!positionals[2]) {
    // TUI contract: one bundle (status + tree + trace + events); --follow then streams event lines.
    const bundle = async () => {
      const P = await import("../../primitives/ops");
      const [status, tree, events] = await Promise.all([
        getStatus(runId), P.treeOf(runId).catch(() => ({ runId, root: null, tree: [], totals: null })), listEvents(runId),
      ]);
      const trace = loadTrace(runId) ?? (await runTraceAt(runId));
      const now = Date.now();
      return { type: "inspect.snapshot", runId, ts: new Date(now).toISOString(), epochMs: now, seq: events.length, status, tree: tree.tree, totals: tree.totals, trace, events };
    };
    const snap = await bundle();
    if (!values.follow) {
      if (json) out(snap);
      else {
        console.log(`Run ${runId}  ${snap.status.state}${snap.status.scope ? ` (agents ${snap.status.scope.state})` : ""}  started ${snap.status.startedAt ?? "-"}`);
        console.log(`Goal: ${snap.status.goal}`);
        if (snap.status.pendingApprovals.length) console.log(`Pending approvals: ${snap.status.pendingApprovals.map((p) => p.taskId).join(", ")}`);
        console.log(`Agents: ${JSON.stringify(snap.totals)}  events ${snap.events.length}  spans ${snap.trace?.spanCount ?? 0}`);
      }
      return EXIT.ok;
    }
    const emit = (o: Record<string, unknown>) => json ? out(o) : console.log(JSON.stringify(o));
    const sinceSeq = values["since-seq"] !== undefined ? Number(values["since-seq"]) : snap.seq;
    emit({ ...snap, events: snap.events.filter((e) => e.seq > (values["since-seq"] !== undefined ? sinceSeq : -1)) });
    const S = await import("../../primitives/state");
    const P = await import("../../primitives/ops");
    // Spans are appended as they end, so a TUI attached early would never see them: push the trace
    // again whenever its file grows (checked every CAPCOMD_INSPECT_TRACE_MS, default 2s).
    const traceFile = async () => { const { tracePath } = await import("../../utils/tracing-simple"); const own = tracePath(runId); if (existsSync(own)) return own; const d = await P.runTraceDir(runId); return d ? tracePath(runId, d) : own; };
    let traceSize = await traceFile().then((f) => (existsSync(f) ? statSync(f).size : 0)).catch(() => -1); // the snapshot already has this much
    const tracePoll = setInterval(async () => {
      try {
        const f = await traceFile();
        const size = existsSync(f) ? statSync(f).size : 0;
        if (size === traceSize) return;
        traceSize = size;
        const t = loadTrace(runId, dirname(f));
        if (t) emit({ type: "inspect.trace", runId, ts: new Date().toISOString(), trace: t });
      } catch { /* next tick */ }
    }, Number(process.env.CAPCOMD_INSPECT_TRACE_MS ?? 2000));
    const r = await S.followEvents(runId, {
      sinceSeq, until: values.until as string | undefined,
      timeoutMs: values["timeout-ms"] !== undefined ? Number(values["timeout-ms"]) : undefined,
      emit: (ev) => {
        emit({ type: "event", runId, seq: ev.seq, ts: ev.ts, epochMs: ev.epochMs, agentId: ev.agentId, event: ev });
        // Agent lifecycle changes the tree: push a fresh one so a TUI never has to re-poll.
        if (/^AGENT_/.test(ev.type)) void P.treeOf(runId).then((t) => emit({ type: "inspect.tree", runId, seq: ev.seq, ts: new Date().toISOString(), tree: t.tree, totals: t.totals })).catch(() => {});
      },
    });
    clearInterval(tracePoll);
    emit({ type: "inspect.end", runId, ts: new Date().toISOString(), end: r });
    return EXIT.ok;
  }
  const id = positionals[2];
  const r: any = await (await import("../../primitives/ops")).inspectAgent(runId, id, { logTail: values.tail ? Number(values.tail) : 50 });
  if (json) out(r);
  else {
    // The profile as it was at spawn (ADR-024 §2.4): `worker v3, project`.
    const profile = `${r.profile ?? "-"}${r.profileVersion ? ` v${r.profileVersion}, ${r.profileSource}` : ""}`;
    console.log(`${r.agentId} [${profile}] ${r.status}${r.notice ? ` ${String(r.notice.kind).toUpperCase()}: ${r.notice.detail}` : ""}  parent ${r.parent ?? "(operator)"}  depth ${r.depth}`);
    console.log(`  budget ${JSON.stringify(r.budget)} spent ${JSON.stringify(r.spent)}  subtree ${JSON.stringify(r.rollup)}`);
    console.log(`  limits ${JSON.stringify(r.limits)}`);
    console.log(`  vm ${JSON.stringify(r.vm)}  driver ${r.driver ?? "-"}  heartbeat ${r.heartbeatAt ? new Date(r.heartbeatAt).toISOString() : "-"} ${r.heartbeatNote ?? ""}`);
    if (r.children.length) console.log(`  children: ${r.children.map((c: any) => `${c.agentId}(${c.status})`).join(", ")}`);
    if (r.awaits.length) console.log(`  awaits: ${r.awaits.map((w: any) => `${w.waiter}→${w.target}`).join(", ")}`);
    if (r.result) console.log(`  result ${JSON.stringify(r.result).slice(0, 800)}`);
    for (const l of r.logs) console.log(`  | ${l.line}`);
  }
  return EXIT.ok;
}

/** `capcomd logs` */
async function logsCommand({ positionals, values, json }: Cmd): Promise<number> {
  const runId = positionals[1] ?? usage("capcomd logs <runId> <agt> [--tail N] [--follow]");
  const id = positionals[2] ?? usage("capcomd logs <runId> <agt> [--tail N] [--follow]");
  const O = await import("../../primitives/ops");
  const show = (l: { at: number; stream: string; line: string }) => (json ? console.log(JSON.stringify(l)) : console.log(`${new Date(l.at).toISOString()} ${l.stream.padEnd(6)} ${l.line}`));
  const r = await O.agentLogs(runId, id, values.tail ? Number(values.tail) : 200);
  if (!values.follow) { if (json) out(r); else r.lines.forEach(show); return EXIT.ok; }
  // --follow: new lines as they come (one JSON object per line with --json), until the agent is finished.
  r.lines.forEach(show);
  let after = r.lines.at(-1)?.seq ?? 0;
  for (let status = r.status; ; ) {
    const finished = (await import("../../primitives/policy")).TERMINAL_AGENT.has(status as any);
    const more = await O.agentLogs(runId, id, 500, after);
    more.lines.forEach(show);
    after = more.lines.at(-1)?.seq ?? after;
    if (finished && !more.lines.length) return EXIT.ok;
    status = more.status;
    if (!more.lines.length) await new Promise((res) => setTimeout(res, 1000));
  }
}

/** `capcomd agent-drive` */
async function agentDriveCommand({ positionals, json }: Cmd): Promise<number> {
  const runId = positionals[1] ?? usage("capcomd agent-drive <runId> <agentId>");
  const agentId = positionals[2] ?? usage("capcomd agent-drive <runId> <agentId>");
  const a = await (await import("../../primitives/ops")).driveAgent(runId, agentId);
  if (json) out({ agent: a }); else console.log(`${agentId}: ${a.status}`);
  return a.status === "done" ? EXIT.ok : EXIT.run_failed;
}

/** `capcomd cancel` */
async function cancelCommand({ positionals, values, json }: Cmd): Promise<number> {
  const runId = positionals[1] ?? usage("runId required: capcomd cancel <runId> [agentId]");
  // A recipe run (planner flow over the primitives) keeps the run-level cancel contract
  // ({runId, state, changed}); its scope agents are cancelled alongside.
  const c = await (await import("../../primitives/ops")).cancelAny(runId, positionals[2], values.reason as string | undefined, "operator");
  if (c.kind === "agents") {
    const r = c.agents;
    if (json) out(r);
    else console.log(r.cancelled.length ? `✓ cancelled ${r.cancelled.join(", ")}` : r.runEnded ? `✓ Run ${runId} cancelled` : `nothing to cancel (${r.affected.map((a: { agentId: string; status: string }) => `${a.agentId}=${a.status}`).join(", ") || "no agents"})`);
    return EXIT.ok;
  }
  const r = c.run;
  if (json) out(r);
  else console.log(r.changed ? `✓ Run ${runId} cancelled` : `Run ${runId} is ${r.state}; nothing to cancel`);
  return EXIT.ok;
}

/** `capcomd pause` */
async function pauseCommand({ positionals, json }: Cmd): Promise<number> {
  const runId = positionals[1] ?? usage("runId required: capcomd pause <runId> [agentId]");
  const r = await (await import("../../primitives/ops")).pauseAgents(runId, positionals[2]);
  if (json) out(r);
  else console.log(r.paused.length || r.pausing.length
    ? [r.paused.length ? `✓ paused ${r.paused.join(", ")}` : "", r.pausing.length ? `pausing ${r.pausing.join(", ")} (each stops at its next check, keeping its work)` : ""].filter(Boolean).join("; ")
    : "no pending or running agents to pause");
  return EXIT.ok;
}

/** `capcomd resume` */
async function resumeCommand({ positionals, json }: Cmd): Promise<number> {
  const runId = positionals[1] ?? usage("runId required: capcomd resume <runId> [agentId]");
  const r = await (await import("../../primitives/ops")).resumeAgents(runId, positionals[2]);
  if (json) out(r);
  else console.log(r.resumed.length ? `✓ resumed ${r.resumed.join(", ")}` : "no paused agents to resume");
  return EXIT.ok;
}

/** `capcomd events | replay` */
async function eventsCommand({ command, positionals, values, json }: Cmd): Promise<number> {
  const runId = positionals[1] ?? usage(`runId required: capcomd ${command} <runId>`);
  let sinceSeq: number | undefined;
  if (values["since-seq"] !== undefined) { sinceSeq = Number(values["since-seq"]); if (!Number.isInteger(sinceSeq) || sinceSeq < 0) usage("--since-seq must be an integer >= 0 (the seq of the last line you saw)"); }
  if (values.follow) {
    const S = await import("../../primitives/state");
    const r = await S.followEvents(runId, {
      until: values.until as string | undefined, fromStart: !!values["from-start"], sinceSeq,
      timeoutMs: values["timeout-ms"] !== undefined ? Number(values["timeout-ms"]) : undefined,
      emit: (ev) => json ? out({ runId, seq: ev.seq, ts: ev.ts, epochMs: ev.epochMs, agentId: ev.agentId, type: ev.type, event: ev }) : console.log(`[${ev.entity.padEnd(20)}] ${new Date(ev.at).toISOString()} ${JSON.stringify(ev.event)}`),
    });
    if (json) out({ runId, end: r, ts: new Date().toISOString() });
    return EXIT.ok;
  }
  const limit = values.limit ? Number.parseInt(values.limit as string, 10) : 1000;
  if (!Number.isFinite(limit) || limit < 1) usage("--limit must be a positive integer");
  const all = (await listEvents(runId)).filter((e) => sinceSeq === undefined || e.seq > sinceSeq);
  const page = paginate(all, values.cursor as string | undefined, limit);
  if (json) out({ runId, events: page.items, nextCursor: page.nextCursor, total: page.total, truncated: page.nextCursor !== null });
  else {
    console.log(`Events for ${runId}: ${page.total} total\n`);
    for (const ev of page.items) console.log(`[${ev.entity.padEnd(20)}] ${new Date(ev.at).toISOString()} ${JSON.stringify(ev.event)}`);
    if (page.nextCursor) console.log(`\n… more: --cursor ${page.nextCursor}`);
  }
  return EXIT.ok;
}

/** `capcomd trace` */
async function traceCommand({ positionals, json }: Cmd): Promise<number> {
  const runId = positionals[1] ?? usage("runId required: capcomd trace <runId>");
  const tree = loadTrace(runId) ?? (await runTraceAt(runId));
  if (!tree) throw new RelayError("not_found", `No trace found for run ${runId}`, "Traces are written to .traces/<runId>.ndjson while a run executes; start one with `capcomd run`.");
  if (json) out({ trace: tree });
  else console.log(renderTrace(tree));
  return EXIT.ok;
}

/** `capcomd triggers log|subscriptions` (plugin API §16.3): what the daemon's intake decided about each trigger, and the
 *  threads runs follow, read from its records on this machine (the daemon need not run). */
async function triggersCommand({ positionals, values, json }: Cmd): Promise<number> {
  const sub = positionals[1] ?? "log";
  const T = await import("../../triggers/intake");
  if (sub === "subscriptions") {
    const subs = T.listSubscriptionRecords().filter((s) => (!values.source || s.source === values.source) && (!positionals[2] || s.runId === positionals[2]));
    if (json) { out({ subscriptions: subs }); return EXIT.ok; }
    if (!subs.length) console.log("No run follows a thread.");
    for (const s of subs) console.log(`${s.runId}  ${s.source}  ${s.thread}  ${s.until ? `until ${s.until}` : "while the run works, and 14 days after"}`);
    return EXIT.ok;
  }
  if (sub !== "log") usage("usage: capcomd triggers log [--source S] [--limit N] | capcomd triggers subscriptions [runId] [--source S]");
  const limit = values.limit !== undefined ? Number(values.limit) : 50;
  if (!Number.isInteger(limit) || limit < 1) usage("--limit is a whole number of entries, at least 1");
  const entries = T.readTriggerLog({ ...(values.source ? { source: String(values.source) } : {}), limit });
  if (json) { out({ triggers: entries }); return EXIT.ok; }
  if (!entries.length) console.log(values.source ? `No trigger from ${values.source} yet.` : "No trigger yet. Sources (a schedule, GitHub comments) send them once configured; see docs/spec/plugin-api.md §16.3.");
  for (const e of entries) console.log(`${e.at}  ${e.source}  ${e.actor.id}${e.actor.bot ? " (bot)" : ""}  ${e.thread}  ${triggerOutcome(e.decision)}`);
  return EXIT.ok;
}
function triggerOutcome(d: import("../../triggers/intake").LoggedDecision): string {
  switch (d.kind) {
    case "deduped": return `deduped (first seen ${d.first})`;
    case "denied": return `denied by ${d.by}: ${d.reason}`;
    case "recorded": return `recorded: would have ${d.wouldHave === "start" ? "started a run" : `continued ${d.runId ?? "a run"}`} (observe mode)`;
    case "started": return `started ${d.runId}`;
    case "continued": return `continued ${d.runId} (message ${d.seq}${d.restarted ? `; its planner started again: ${d.restarted}` : ""})`;
    case "failed": return `failed: ${d.reason}`;
  }
}

/** `capcomd approve` */
async function approveCommand({ positionals, values, json }: Cmd): Promise<number> {
  const runId = positionals[1] ?? usage("usage: capcomd approve <runId> <taskId|mrgId> [--deny] [--reason R]");
  const taskId = positionals[2] ?? usage("usage: capcomd approve <runId> <taskId|mrgId> [--deny] [--reason R]");
  // An agent's merge into a protected target (mrg-…): approve runs it, --deny fails it.
  if (taskId.startsWith("mrg-")) {
    const P = await import("../../primitives/ops");
    const m: any = await P.decideMerge(runId, taskId, { approve: !values.deny, by: (values.by as string | undefined) ?? "cli", ...(values.reason ? { reason: String(values.reason) } : {}) });
    if (json) out(m); else console.log(`${taskId}: ${m.state}${m.result?.sha ? ` (${String(m.result.sha).slice(0, 12)})` : ""}${m.result?.reason ? ` ${m.result.reason}` : ""}`);
    // Approved, then held by a plugin (merge.landing): it waits for a second approval, of that plugin's hold.
    if (!json && m.state === "awaiting_approval" && m.heldBy) console.log((await import("../status-text")).heldMergeText(runId, taskId, m, { again: true }).join("\n"));
    await P.settleCleanups();
    return m.state === "merged" || (values.deny && m.state === "failed") ? EXIT.ok : EXIT.run_failed;
  }
  if (values.deny) usage("--deny applies to an agent's parked merge (mrg-…)");
  // Both run paths park protected merges on the task-board ledger (public contract).
  const r = await approveTask(runId, taskId, (values.by as string | undefined) ?? "cli");
  if (json) out(r);
  else console.log(r.already ? `${taskId} was already merged` : `✓ Approved ${taskId}; merging into protected branch`);
  return EXIT.ok;
}

export const COMMANDS: Record<string, KernelCommand> = {
  "run": runCommand,
  "goal": goalCommand,
  "pr": prCommand,
  "status": statusCommand,
  "inspect": inspectCommand,
  "logs": logsCommand,
  "agent-drive": agentDriveCommand,
  "cancel": cancelCommand,
  "pause": pauseCommand,
  "resume": resumeCommand,
  "events": eventsCommand,
  "replay": eventsCommand,
  "trace": traceCommand,
  "approve": approveCommand,
  "triggers": triggersCommand,
};
