// The primitives for a "driver": the user's own agent orchestrating through `capcomd mcp` (ADR-018 §3, §4).
// A driver runs the swarm (runs, spawns, waits, verifies, merges, the board and kv) but the gates stay the
// human's: checks, the reviewer and protected branches come from the project's config, approvals for protected
// branches are a person's by default, and nothing widens a profile. Agents' text reaches the driver fenced.
import { RelayError } from "../core/errors";
import { client, existingActor } from "../core/relay";
import * as O from "../primitives/ops";
import * as S from "../primitives/state";
import { parseBudget, TERMINAL_AGENT, type Budget } from "../primitives/policy";
import { fence } from "../subagents/results";
import { WAIT_DEFAULT_MS, WAIT_MAX_MS } from "./session";

/** The driver's name in records it writes (kv writer, task holder, message sender, approver). */
export const DRIVER = "driver";
/** kv keys the orchestrator owns: a driver reads them, never writes them (same list as in-VM agents). */
const RESERVED_KV = ["_", "approval/", "recipe/", "handoff/"];
/** Waits return before a client's tool timeout (./session.ts, where the tools' schemas read them too). */
export { WAIT_DEFAULT_MS, WAIT_MAX_MS };

const deny = (message: string, hint: string): never => { throw new RelayError("usage", message, hint, { code: "forbidden" }); };

// Plugin API §6.1: verify, merge and approve go to the daemon that hosts the engine (src/primitives/front-door.ts), so
// every plugin's gate judges them. run_new and spawn run here, where the project is: a plugin only the daemon runs that
// listens to their hooks is named in the answer (`pluginsNotConsulted`), or refuses them (a `failure: closed` listener).
const F = () => import("../primitives/front-door");
const RUNS_HERE = "capcomd mcp runs it in its own process (it reads the project where it runs), and only the daemon runs those plugins";
const RUNS_HERE_HINT = "A run or spawn from capcomd mcp can't reach the daemon's plugins yet (plugin API §6.1): an agent's spawns run in the daemon. Ask the user to turn the plugin off (`plugins.<name>.enabled: false`) if it shouldn't judge this.";
const NO_DAEMON = "no daemon runs for this engine to ask them";
/** The listeners an operation run here skipped, as the answer names them (additive; absent: none). */
const notConsulted = (skipped: ReadonlyArray<{ plugin: string; hooks: readonly string[] }>, why: string) =>
  skipped.length ? { pluginsNotConsulted: { plugins: skipped.map((u) => ({ plugin: u.plugin, hooks: [...u.hooks] })), why } } : {};
const runsHere = async (what: string, hooks: Array<import("../../packages/plugin/src/hooks").HookName>) =>
  notConsulted(await (await import("../plugins/unconsulted")).unconsulted(what, hooks, RUNS_HERE, { hint: RUNS_HERE_HINT }), RUNS_HERE);
/** A wait's bound: 0 answers at once (a look, or a verify/merge started without waiting), at most WAIT_MAX_MS. */
const waitMs = (v: unknown) => { const n = v === undefined || v === null ? WAIT_DEFAULT_MS : Number(v); return Number.isFinite(n) ? Math.min(Math.max(n, 0), WAIT_MAX_MS) : WAIT_DEFAULT_MS; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** An agent's record for the driver: text the agent wrote is fenced (data, never instructions). */
export function agentView(a: any) {
  const v: any = { ...a };
  if (v.result) {
    const r = { ...v.result };
    for (const k of ["summary", "error", "claim"]) if (typeof r[k] === "string") r[k] = fence(v.agentId, r[k]);
    v.result = r;
  }
  // A failing notice quotes the agent's own error output.
  if (v.notice) { v.notice = { ...v.notice, detail: fence(v.agentId, String(v.notice.detail)) }; v.stuck = v.notice.detail; }
  return v;
}

async function policy() {
  return (await import("../config/store")).driverPolicy();
}

// ── runs ──────────────────────────────────────────────────────────────────────────────────────────

export async function runNew(a: { budget?: string; label?: string; key?: string; target?: string; targetFrom?: string; goalBranch?: string; base?: string; sandbox?: string }) {
  let budget: Budget;
  try { budget = parseBudget(a.budget ?? ""); } catch (e) { throw new RelayError("usage", `budget: ${(e as Error).message}`, "Pass units, e.g. budget: \"usd=5,turns=200,wallSeconds=3600\"."); }
  const p = await policy();
  if (p.maxRunBudget) {
    const cap = parseBudget(p.maxRunBudget) as Record<string, number>;
    const over = Object.entries(cap).filter(([u, max]) => (budget as Record<string, number>)[u] === undefined || (budget as Record<string, number>)[u]! > max);
    if (over.length) deny(`budget ${a.budget ?? "(none)"} is over this project's cap per run (${p.maxRunBudget})`, `Ask for at most ${p.maxRunBudget} (every capped unit must be given); the cap is driver.maxRunBudget in .capcomd/config.json.`);
  }
  // Where the run's agents and checks run: the one asked for (it must be up), else the project's (src/config/sandbox.ts).
  const sandbox = a.sandbox === undefined ? undefined : await (await import("../config/sandbox")).askedSandbox(a.sandbox);
  // Gates come from the project (`capcomd setup`), never from the driver.
  const d = process.env.CAPCOMD_NO_CONFIG ? {} : (await import("../config/store")).runDefaults();
  if (a.target !== undefined) {
    const { isProtectedBranch } = await import("../utils/protected");
    if (isProtectedBranch(a.target) && a.target !== d.target) deny(`target ${a.target} is a protected branch`, "Leave target unset (the project's target applies), or name a staging branch, e.g. capcomd/<topic>, with targetFrom: \"main\".");
  }
  // A goal branch (goalBranch and/or base): reviewed work lands on it with no approval; the user opens a pull request
  // from it into the base at the end (capcomd_pr_open). Base: the one given, else the project's target, else origin's
  // default branch; none of those is an error, never "main".
  if ((a.goalBranch !== undefined || a.base !== undefined) && (a.target !== undefined || a.targetFrom !== undefined)) deny("goalBranch/base replace target/targetFrom", "Pass goalBranch (and base), or target (and targetFrom), not both.");
  let goal: { branch: string; base: string } | null = null;
  if (a.goalBranch !== undefined || a.base !== undefined) {
    const cfg = (await import("../merge/config")).loadMergeConfig();
    const { env: envVar } = await import("../utils/env");
    const r = await (await import("../merge/goal")).resolveGoalBranch({ goal: a.label ?? "goal", base: a.base ?? null, goalBranch: a.goalBranch ?? null, projectTarget: d.target ?? envVar("MERGE_TARGET") ?? null,
      remote: cfg?.remote ?? null, merge: cfg, cwd: process.cwd(),
      // A goal branch that exists is decided when it's cut (O.runNew): a leftover of an ended run with nothing on it is used.
      reuse: a.goalBranch ?? null });
    goal = { branch: r.goalBranch, base: r.base };
  }
  const target = goal ? goal.branch : a.target ?? d.target;
  const skipped = await runsHere("capcomd_run_new", ["run.creating"]);
  const r = await O.runNew({ budget, label: a.label, key: a.key, checks: d.checks ?? {}, ...(d.reviewer ? { reviewer: d.reviewer } : {}), ...(sandbox ? { sandbox } : {}), ...(goal ? { goalBranch: goal.branch, base: goal.base } : { ...(target ? { target } : {}), ...(a.targetFrom ? { targetFrom: a.targetFrom } : {}) }) });
  const where = r.sandbox.name ? `Its agents and checks run on ${r.sandbox.name} (${SANDBOX_FROM[r.sandbox.source]}).` : "Its agents and checks run on the engine's own sandbox (nothing configured for this project: pass sandbox, or set it with `capcomd setup project --sandbox docker|boxd`).";
  const out = { ...r, ...skipped, gates: { checks: Object.keys(d.checks ?? {}), reviewer: d.reviewer ?? null, target: target ?? null, ...(goal ? { goalBranch: goal.branch, base: goal.base } : {}) },
    next: `${where} ` + (goal ? `Spawn agents with capcomd_spawn; verified merges land on ${goal.branch} with no approval. When the work is done, show the user capcomd_goal and ask before capcomd_pr_open.` : "Spawn agents with capcomd_spawn; give each a check name from gates.checks.") };
  return withTeamShape(out, await runCapacity(r.runId));
}

// ── team shape (how many agents run at once here; the skill's "Choose a team shape") ───────────────

/** The capacity of the place a run's agents use: its own sandbox when it has one, else this process's. */
export async function runCapacity(runId: string | null, configured?: string) {
  const { placeCapacity } = await import("../providers/capacity");
  const { runSandbox } = await import("../providers/run-sandbox");
  const { sandboxName } = await import("../providers/registry");
  let place: string;
  try { place = (runId ? await runSandbox(runId) : null) ?? configured ?? sandboxName(); } catch { place = configured ?? "fake"; }
  return placeCapacity(place);
}
/** A result with `capacity` and the plan-the-team-shape hint in front of its `next`. */
async function withTeamShape<T extends { next?: string }>(out: T, capacity: Awaited<ReturnType<typeof runCapacity>>) {
  const { teamShapeHint } = await import("../providers/capacity");
  return { ...out, capacity, next: [teamShapeHint(capacity), out.next].filter(Boolean).join(" ") };
}

const SANDBOX_FROM: Record<string, string> = { run: "chosen for this run", environment: "CAPCOMD_SANDBOX in capcomd's environment", project: "the project's setting", user: "your user config", engine: "the engine's own" };

/** The goal branch against its base: what landed, what didn't, the planner's summary, and whether a PR can be opened. */
export async function goal(a: { runId: string; done?: boolean; summary?: string }) {
  const G = await import("../primitives/goal");
  // A run you drive yourself (no planner agent) is ready when you say its work is done, with what you did.
  const v = a.done ? await G.markGoalDone(a.runId, { by: DRIVER, summary: a.summary ?? null }) : await G.goalView(a.runId);
  const f = (id: string, t: string | null) => (t == null ? t : fence(id, t).text);
  // Where the person merges it, in the run's forge's words ("on GitHub").
  const place = v.pullRequest ? await G.pullRequestPlace(a.runId) : "";
  return {
    ...v, summary: v.plannerId ? f(v.plannerId, v.summary) : v.summary,
    landed: v.landed.map((l) => ({ ...l, task: f(l.agentId, l.task), review: l.review ? { ...l.review, reasons: l.review.reasons.map((r) => fence(l.review!.agentId ?? l.agentId, r).text) } : null })),
    notLanded: v.notLanded.map((n) => ({ ...n, task: f(n.agentId, n.task), detail: f(n.agentId, n.detail) })),
    compare: { ...v.compare, commits: v.compare.commits.map((c) => ({ ...c, subject: fence("commit", c.subject).text })) },
    next: v.driven && v.state === "working" ? "You drive this run: when every agent's work is verified and merged (or given up), call capcomd_goal {runId, done: true, summary: \"what landed\"}; the user then decides on a pull request."
      : v.pullRequest ? `The pull request is #${v.pullRequest.number}${v.pullRequest.url ? ` (${v.pullRequest.url})` : ""}: the user reviews and merges it ${place}.`
      : v.openPullRequest.available && v.openPullRequest.confirm ? `${v.openPullRequest.confirm} Ask the user this, showing what landed and what didn't; only if they say yes, call capcomd_pr_open with stopped: true.`
      : v.openPullRequest.available ? `Show the user what landed and the summary, and ask whether to open a pull request into ${v.base} (capcomd_pr_open) or keep the branch.`
      : `${v.openPullRequest.reason}`,
  };
}

/** Open a pull request from the run's goal branch into its base (idempotent; capcomd never merges it). */
export async function prOpen(a: { runId: string; stopped?: boolean }) {
  const G = await import("../primitives/goal");
  const r = await G.openGoalPullRequest(a.runId, { by: DRIVER, stopped: a.stopped === true });
  return { ...r, next: `Tell the user: pull request #${r.pullRequest.number}${r.pullRequest.url ? ` (${r.pullRequest.url})` : ""} from ${r.branch} into ${r.base}. They review and merge it ${await G.pullRequestPlace(a.runId)}.` };
}

/** How long capcomd_runs waits for one run's records. */
const RUN_READ_MS = 5_000;

/** A run's state as the harness API reports it (GET /v1/runs): running while an agent is live; else how it ended
 *  (cancelled, failed), idle once its agents finished, new before any; unknown without a scope. */
export function runState(meta: { ended?: { state: string } | null } | null, agents: Array<{ status: string }>): string {
  if (!meta) return "unknown";
  if (agents.some((a) => a.status === "running" || a.status === "pending" || a.status === "paused")) return "running";
  return meta.ended ? meta.ended.state : agents.length ? "idle" : "new";
}

export async function runs(a: { limit?: number; project?: { name: string; path: string } | null }) {
  const P = await import("../config/projects");
  const limit = Math.min(Number(a.limit ?? 10), 50);
  // Each run's project: the checkout it was started in (the runs index records the directory).
  const all = O.recentRuns(a.project ? 500 : limit).map((r) => { const dir = r.cwd ? P.projectDirOf(r.cwd) : null; return { ...r, dir, project: dir ? P.projectNameOf(dir) : null }; });
  const rows = (a.project ? all.filter((r) => r.dir && P.samePath(r.dir, a.project!.path)) : all).slice(0, limit).map(({ dir: _d, ...r }) => r);
  // One engine read per run, all at once, each bounded: a run whose scope is slow to answer (an actor waking up, an
  // engine under load) is listed with what's unknown instead of holding the whole list.
  const { within } = await import("../utils/within");
  const out = await Promise.all(rows.map(async (r) => {
    try {
      return await within((async () => {
        // A listed run whose scope this engine doesn't have (another engine's) lists no agents: never create one.
        const s = await existingActor("scope", [r.runId]);
        if (!s) return { ...r, state: "unknown", agents: {}, pendingApprovals: [] };
        const [meta, agents, ops] = await Promise.all([s.getScope({}).catch(() => null), s.listAgents({}).catch(() => []), s.listOps({ state: "awaiting_approval", kind: "merge" }).catch(() => [])]) as [any, any[], any[]];
        const counts: Record<string, number> = {};
        for (const x of agents) counts[x.status] = (counts[x.status] ?? 0) + 1;
        return { ...r, state: runState(meta, agents), agents: counts, pendingApprovals: ops.map((m) => m.id) };
      })(), RUN_READ_MS, `reading ${r.runId}`);
    } catch {
      return { ...r, state: "unknown", agents: null, pendingApprovals: null, note: `the engine didn't answer for this run within ${RUN_READ_MS / 1000}s; capcomd_tree reads it on its own` };
    }
  }));
  return { runs: out };
}

export async function tree(a: { runId: string; root?: string }) {
  const t: any = await O.treeOf(a.runId, a.root);
  const { within } = await import("../utils/within");
  return { ...t, pendingApprovals: await within(O.pendingMerges(a.runId), RUN_READ_MS).catch(() => null) };
}

export async function inspect(a: { runId: string; agent: string; tail?: number }) {
  const r: any = await O.inspectAgent(a.runId, a.agent, { logTail: Math.min(Number(a.tail ?? 50), 500) });
  return { ...r, result: agentView({ agentId: a.agent, result: r.result }).result, logs: (r.logs ?? []).map((l: any) => ({ ...l, line: fence(a.agent, l.line).text })) };
}

// ── agents ────────────────────────────────────────────────────────────────────────────────────────

export async function spawn(a: { runId: string; task: string; title?: string; profile?: string; key?: string; budget?: string; check?: string; report?: boolean; continue?: string; children?: Record<string, unknown> }) {
  let budget: Budget | undefined;
  try { budget = a.budget ? parseBudget(a.budget) : undefined; } catch (e) { throw new RelayError("usage", `budget: ${(e as Error).message}`, "Units: usd, turns, wallSeconds, e.g. \"usd=1,turns=40\"."); }
  const skipped = await runsHere("capcomd_spawn", ["profile.resolved", "agent.spawning"]);
  // No `operator`: a driver's spawn may only narrow the profile, like any parent.
  const r = await O.spawnAgent({ runId: a.runId, task: a.task, ...(a.title !== undefined ? { title: a.title } : {}), profile: a.profile, key: a.key, ...(budget ? { budget } : {}), ...(a.check ? { check: a.check } : {}), ...(a.report ? { report: true } : {}), ...(a.continue ? { continueFrom: a.continue } : {}), ...(a.children ? { grant: a.children as any } : {}) });
  return { ...agentView(r), ...skipped, next: `Wait with capcomd_await {runId: "${a.runId}", agents: ["${r.agentId}"]}.` };
}

/**
 * Bounded wait: returns when all (or any) of the agents and ops (verifies and merges) are done, when an agent looks stuck
 * (ADR-019 §2: a notice raised while waiting), or after timeoutMs with what's still pending. Event-driven: it answers
 * as soon as one finishes.
 */
export async function awaitAgents(a: { runId: string; agents?: string[]; ops?: string[]; mode?: "all" | "any"; timeoutMs?: number }) {
  const agents = a.agents ?? [];
  const ops = a.ops ?? [];
  if (!agents.length && !ops.length) throw new RelayError("usage", "agents or ops required", "Pass the agent ids capcomd_spawn returned, and/or the vfy-…/mrg-… ids capcomd_verify and capcomd_merge returned.");
  const bad = ops.find((x) => !/^(vfy|mrg|chk)-/.test(x));
  if (bad) throw new RelayError("usage", `${bad} isn't a verify, merge or check id`, "ops takes the vfy-… / mrg-… / chk-… ids capcomd_verify, capcomd_merge and capcomd_check returned; agent ids go in agents.");
  const r: any = await O.awaitAgents(a.runId, agents, { timeoutMs: waitMs(a.timeoutMs), any: a.mode === "any", notices: true, ops });
  const rows: any[] = r.agents ?? [];
  const pendingAgents = rows.filter((x) => !TERMINAL_AGENT.has(x.status)).map((x) => x.agentId);
  const done = rows.filter((x) => !pendingAgents.includes(x.agentId)).map(agentView);
  const opRows: any[] = r.ops ?? [];
  const opsDone = opRows.filter((o) => o.state !== "running").map((o) => ({ ...o, next: opNext(a.runId, o) }));
  const pending = [...pendingAgents, ...opRows.filter((o) => o.state === "running").map((o) => o.id)];
  const notices = ((r.notices ?? []) as Array<{ agentId: string; kind: string; detail: string }>).map((n) => ({ ...n, detail: fence(n.agentId, n.detail) }));
  const anyDone = done.length + opsDone.length > 0;
  return {
    done, ...(ops.length ? { ops: opsDone } : {}), pending, ...(r.first ? { first: agentView(r.first) } : {}), ...(notices.length ? { notices } : {}),
    next: notices.length
      ? `${notices.map((n) => `${n.agentId} looks ${n.kind}: ${n.detail}`).join("; ")}. It keeps running (it is stopped, work kept, only if its profile sets a stuck window). Look with capcomd_inspect, cancel it with capcomd_cancel, or call capcomd_await again.`
      : pending.length && !(a.mode === "any" && anyDone) ? `Still running; call capcomd_await again for ${pending.join(", ")} (they keep working between calls).`
      : [...(done.length ? ["Verify finished work with capcomd_verify (several at once: then await their ids in ops)."] : []), ...opsDone.map((o) => `${o.id}: ${o.next}`), ...(pending.length ? [`Still pending: ${pending.join(", ")}.`] : [])].join(" "),
  };
}

export async function send(a: { runId: string; to: string; body: string; key?: string }) {
  const r = await client().scope.getOrCreate([a.runId]).sendMessage({ to: a.to, from: DRIVER, body: a.body, ...(a.key ? { key: `${DRIVER}:${a.key}` } : {}) });
  const note = await O.messageNote(a.runId, a.to);
  return { runId: a.runId, to: a.to, ...r, ...(note ? { note } : {}) };
}

/** Name an agent's tab (capability agents.title) as the driver: the agent's own later renames replace it; the user's title stays. */
export async function title(a: { runId: string; agentId: string; title: string; key?: string }) {
  return O.setAgentTitle(a.runId, a.agentId, a.title, { by: "driver", setBy: DRIVER, ...(a.key ? { key: `${DRIVER}:${a.key}` } : {}) });
}

export async function cancel(a: { runId: string; agent?: string; reason?: string }) {
  return O.cancelAgents(a.runId, a.agent, a.reason);
}

export async function resume(a: { runId: string; agent?: string }) {
  return O.resumeAgents(a.runId, a.agent);
}

export async function grant(a: { runId: string; agent?: string; budget: string; key?: string }) {
  let add: Budget;
  try { add = parseBudget(a.budget); } catch (e) { throw new RelayError("usage", `budget: ${(e as Error).message}`, "Units: usd, turns, wallSeconds, e.g. \"usd=1,turns=20\"."); }
  if (!a.agent) {
    // A driver raises the run's budget only within the project's cap per run, like run_new.
    const p = await policy();
    if (p.maxRunBudget) {
      const cap = parseBudget(p.maxRunBudget) as Record<string, number>;
      const cur = ((await O.budgetShow(a.runId)).budget ?? {}) as Record<string, number>;
      const over = Object.entries(add).filter(([u, n]) => cap[u] !== undefined && (cur[u] ?? 0) + n > cap[u]!);
      if (over.length) deny(`raising the run's budget by ${a.budget} goes over this project's cap per run (${p.maxRunBudget})`, "Ask the user to raise driver.maxRunBudget in .capcomd/config.json, or to run `capcomd grant <runId> --budget …` themselves.");
    }
  }
  return O.grantBudget(a.runId, { ...(a.agent ? { agentId: a.agent } : {}), add, by: DRIVER, ...(a.key ? { key: `${DRIVER}:${a.key}` } : {}) });
}

// ── gates ─────────────────────────────────────────────────────────────────────────────────────────

/** Race a long operation against the wait; on timeout it keeps running here, and the same call picks it up. */
async function bounded<T>(work: Promise<T>, ms: number): Promise<{ done: true; value: T } | { done: false }> {
  const timer = sleep(ms).then(() => ({ done: false as const }));
  return Promise.race([work.then((value) => ({ done: true as const, value })), timer]);
}

/** What to do with a finished verify, merge or check. */
function opNext(runId: string, v: any): string {
  if (v.kind === "check") {
    const said = typeof v.result?.text === "string" ? `${v.result.text[0]!.toUpperCase()}${v.result.text.slice(1)}.` : `The check ${v.state}.`;
    return v.state === "passed" ? `${said} Nothing was merged; the output is in result.checks.output.`
      : `${said} Nothing was merged. Read result.checks.output, then send the failure to the agent whose work broke it (capcomd_send) or spawn a fix with it in the task.`;
  }
  if (v.kind === "verify") {
    if (v.state === "passed") return `${v.result?.combined?.text ? `${v.result.combined.text[0]!.toUpperCase()}${v.result.combined.text.slice(1)}. ` : ""}Merge with capcomd_merge {runId: "${runId}", ref: "${v.ref}", require: "${v.id}"}.`;
    const setupFailed = typeof v.result?.checks?.reason === "string" && v.result.checks.reason.startsWith("checks couldn't run")
      || typeof v.checks?.reason === "string" && v.checks.reason.startsWith("checks couldn't run");
    return setupFailed
      ? "Not the agent's fault: the checks sandbox couldn't be set up (checks.output says why, usually `capcomd env build --sandbox …`). Tell the user, run what it says once they agree, then call capcomd_verify again with a new key."
      : "Not merged: send the failure to the agent (capcomd_send) or spawn a fix with it in the task.";
  }
  if (v.state === "merged") return `Merged into ${v.target}${v.result?.combined?.text ? `; ${v.result.combined.text}` : ""}.`;
  if (v.state === "awaiting_approval") return `${v.target ?? "The target"} is protected: it waits for a person's approval (capcomd_approve, or \`capcomd approve ${runId} ${v.id}\`).`;
  return `Not merged (${v.result?.status ?? v.state}${v.result?.reason ? `: ${v.result.reason}` : ""}).`;
}

const still = (runId: string, id: string, what: string) =>
  `${what} still running. Wait for it with capcomd_await {runId: "${runId}", ops: ["${id}"]} (put other verifies, merges and agents in the same call: the first to finish ends the wait), or poll it with capcomd_${id.startsWith("vfy-") ? "verify" : id.startsWith("chk-") ? "check" : "merge"} {runId: "${runId}", id: "${id}"}.`;

export async function check(a: { runId: string; ref?: string; id?: string; check?: string; key?: string; timeoutMs?: number }) {
  // A driver picks one of the operator's named checks, never writes a command.
  const { id, done } = await O.startCheck({ runId: a.runId, ...(a.ref ? { ref: a.ref } : {}), ...(a.id ? { id: a.id } : {}), ...(a.check ? { check: a.check } : {}), ...(a.key ? { key: a.key } : {}) });
  done.catch(() => {}); // a timed-out call leaves it running; its error reaches the next call
  const r = await bounded(done, waitMs(a.timeoutMs));
  if (!r.done) return { id, state: "running", next: still(a.runId, id, "The checks are") };
  const v: any = r.value;
  return { ...v, next: opNext(a.runId, v) };
}

export async function verify(a: { runId: string; ref?: string; id?: string; check?: string; acceptance?: unknown; key?: string; timeoutMs?: number }) {
  if (!a.ref && !a.id) throw new RelayError("usage", "ref or id required", "Pass the agent to verify (ref), or the vfy-… id of a verification to poll.");
  // Checks are named by the operator, the reviewer is the run's: a driver picks a check, never writes one.
  // A call without a key or id gets an id of its own up front, so the answer names it and later calls poll that one.
  const id = a.id ?? O.verifyIdFor(a.runId, a.ref!, a.key ?? `drv-${crypto.randomUUID()}`);
  const r = await (await F()).frontVerify({ runId: a.runId, ref: a.ref ?? "", id, ...(a.check ? { check: a.check } : {}), ...(a.acceptance !== undefined ? { acceptance: a.acceptance } : {}), ...(a.key ? { key: a.key } : {}) }, { waitMs: waitMs(a.timeoutMs), what: "capcomd_verify" });
  if (!r.done) return { id, state: "running", next: still(a.runId, id, "The checks (and the review, if the run has a reviewer) are") };
  const v: any = r.value;
  return { ...v, ...notConsulted(r.skipped, NO_DAEMON), next: opNext(a.runId, v) };
}

export async function merge(a: { runId: string; ref?: string; require?: string; id?: string; key?: string; timeoutMs?: number }) {
  if (!a.ref && !a.id) throw new RelayError("usage", "ref or id required", "Pass the ref and require (the id of a passing capcomd_verify of it), or the mrg-… id of a merge to poll.");
  const id = a.id ?? (a.key ? await O.mergeIdFor(a.runId, a.ref!, a.key) : `mrg-d${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`);
  const r = await (await F()).frontMerge({ runId: a.runId, ref: a.ref ?? "", id, ...(a.require ? { require: a.require } : {}), ...(a.key ? { key: a.key } : {}), requestApproval: true }, { waitMs: waitMs(a.timeoutMs), what: "capcomd_merge" });
  if (!r.done) return { id, state: "running", next: still(a.runId, id, "The merge is") };
  const m: any = { ...r.value, ...notConsulted(r.skipped, NO_DAEMON) };
  if (m.state === "awaiting_approval") {
    const how = `a person approves with \`capcomd approve ${a.runId} ${m.id}\` (or in the TUI)`;
    const elicit = ((await policy()).approvals ?? "human") === "elicit";
    return { ...m, next: elicit
      ? `${m.target ?? "The target"} is protected: tell the user what's waiting, then call capcomd_approve {runId: "${a.runId}", merge: "${m.id}"} once: capcomd asks them itself, and only their accept approves. Or ${how}.`
      : `${m.target ?? "The target"} is protected: ${how}. Tell the user; check later with capcomd_tree.` };
  }
  // Said plainly, next to the record (result.combined): whether the checks ran on the combined code.
  return m.result?.combined?.text ? { ...m, next: opNext(a.runId, m) } : m;
}

/** What capcomd_approve needs from the MCP session to ask the person itself (elicitation, `driver.approvals: "elicit"`). */
export interface ElicitPort {
  /** The client declared form elicitation at initialize (Claude Code's bare `elicitation: {}` counts as form). */
  form: boolean;
  /** The client's name as it reported it (initialize clientInfo.name), e.g. "hermes-agent". */
  client: string | null;
  /** The project this server acts on: the prompt names it. */
  project: { name: string; path: string } | null;
  /** Send elicitation/create (form mode, empty schema) and return the person's action; throws on timeout or error. */
  ask(message: string, o: { timeoutMs: number }): Promise<string>;
}

/** The only answer capcomd_approve gives when the person didn't accept (declined, cancelled, no answer, an error). */
export const NO_DECISION = "No decision: the merge is still waiting. Don't retry; ask the user.";
/** Who decided, in the merge's record, when the person accepted capcomd's own prompt. */
export const ELICITED = "driver:elicited";
export const ELICIT_TIMEOUT_S = 300;
/** Merges a prompt is open for (one prompt per merge at a time). */
const asking = new Set<string>();
const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 12) : "(none)");

export interface ApprovalFacts {
  project: { name: string; path: string } | null; repo: string | null; runId: string; mergeId: string;
  target: string; branch: string; agentId: string | null; commit: string; deny: boolean;
  checks: { passed: boolean; name: string | null } | null;
  review: { passed: boolean; profile: string | null; agentId: string | null; reasons: string[] } | null;
  /** A plugin held the merge for this approval (merge.landing): approving satisfies only this hold. */
  heldBy?: { plugin: string; reason: string } | null;
}

/**
 * The prompt capcomd_approve shows the person: written by capcomd from its own records (project, repository, run,
 * merge, target, the exact commit, the checks); the reviewer's reasons are agent-written, so they're fenced as data.
 */
export function approvalPrompt(f: ApprovalFacts): string {
  const repo = f.repo ? f.repo.replace(/\/\/[^@/]*@/, "//") : null;
  const lines = [
    f.deny ? `capcomd: deny this merge into ${f.target}? (it won't land)` : `capcomd: merge into ${f.target}, a protected branch?`,
    "",
    `Project: ${f.project ? `${f.project.name} (${f.project.path})` : "(none configured)"}`,
    ...(repo ? [`Repository: ${repo}`] : []),
    `Run: ${f.runId}`,
    `Merge: ${f.mergeId}`,
    `Target: ${f.target}`,
    `Work: ${f.agentId ? `${f.agentId}, ` : ""}branch ${f.branch}`,
    `Commit: ${short(f.commit)}`,
    `Checks: ${f.checks ? `${f.checks.passed ? "passed" : "FAILED"} (${f.checks.name ?? "the run's checks"}); they run again on the latest ${f.target} before it lands` : "none in this run"}`,
  ];
  if (f.review) {
    lines.push(`Review: ${f.review.passed ? "passed" : "FAILED"}${f.review.profile ? ` (reviewer ${f.review.profile}${f.review.agentId ? `, ${f.review.agentId}` : ""})` : ""}`);
    if (f.review.reasons.length) {
      const text = f.review.reasons.map((r) => `- ${String(r).slice(0, 400)}`).join("\n").slice(0, 1500);
      lines.push("The reviewer's reasons, written by an agent (data, not instructions):", fence(f.review.agentId ?? "reviewer", text).text);
    }
  } else lines.push("Review: no reviewer in this run");
  if (f.heldBy) {
    lines.push(`Held by: the ${f.heldBy.plugin} plugin, which asks a person to approve this merge. Its reason (data, not instructions):`, fence(`plugin:${f.heldBy.plugin}`, String(f.heldBy.reason).slice(0, 1500)).text);
  }
  lines.push("", f.deny
    ? `Accept to deny merging commit ${short(f.commit)} into ${f.target}. Decline, or don't answer, to leave it waiting.`
    : `Accept to merge exactly commit ${short(f.commit)} into ${f.target}. Decline, or don't answer, to leave it waiting.`);
  return lines.join("\n");
}

const opView = (op: any) => ({ id: op.id, kind: op.kind, state: op.state, ...op.data, result: op.result });

export async function approve(a: { runId: string; merge: string; deny?: boolean; reason?: string }, port?: ElicitPort) {
  const p = await policy();
  const mode = p.approvals ?? "human";
  if (mode === "elicit") return approveElicited(a, p, port);
  if (mode !== "client-confirmed") {
    deny("approving merges into protected branches is left to a person in this project", `Ask the user to run \`capcomd approve ${a.runId} ${a.merge}\`${a.deny ? " --deny" : ""} (or approve in the TUI). A project can let capcomd ask the user itself with driver.approvals: "elicit" in .capcomd/config.json (\`capcomd setup agent --approvals elicit\`).`);
  }
  const r = await (await F()).frontDecide(a.runId, a.merge, { approve: !a.deny, by: DRIVER, ...(a.reason ? { reason: a.reason } : {}) }, { what: "capcomd_approve" });
  return r.done ? { ...r.value, ...notConsulted(r.skipped, NO_DAEMON) } : { id: a.merge, state: "running" };
}

/**
 * `driver.approvals: "elicit"`: capcomd asks the person itself (elicitation/create, its own text) and only their accept
 * decides. Fails closed: a client without form elicitation is refused; decline, cancel, no answer and errors leave the
 * merge parked with NO_DECISION; the commit shown must still be the branch's head when they accept.
 */
async function approveElicited(a: { runId: string; merge: string; deny?: boolean; reason?: string }, p: Awaited<ReturnType<typeof policy>>, port?: ElicitPort) {
  const cmd = `capcomd approve ${a.runId} ${a.merge}${a.deny ? " --deny" : ""}`;
  if (!port?.form) deny("this MCP client can't ask the user for capcomd (it didn't declare form elicitation), so it can't approve merges", `Ask the user to run \`${cmd}\` (or approve in the TUI).`);
  const name = port!.client ?? "";
  const allowed = Array.isArray(p.elicitClients) ? p.elicitClients : null;
  if (allowed ? !allowed.includes(name) : name === "claude-code") {
    deny(`approving by elicitation isn't enabled for ${name ? `the MCP client "${name}"` : "this MCP client"} in this project`, `Ask the user to run \`${cmd}\` (or approve in the TUI). ${name === "claude-code"
      ? 'Claude Code\'s Elicitation hooks can answer the prompt without a person: allow it only with managed hooks (allowManagedHooksOnly), by adding "claude-code" to driver.elicitClients in .capcomd/config.json.'
      : `To allow it, add "${name}" to driver.elicitClients in .capcomd/config.json.`}`);
  }
  const key = `${a.runId}\u0000${a.merge}`;
  if (asking.has(key)) return { id: a.merge, state: "awaiting_approval", decision: null, next: NO_DECISION };
  asking.add(key);
  try {
    const s = client().scope.getOrCreate([a.runId]);
    const op: any = await s.getOp({ opId: a.merge });
    if (!op || op.kind !== "merge") throw new RelayError("not_found", `merge ${a.merge} not found in ${a.runId}`, "Pass the mrg-… id capcomd_merge returned (capcomd_tree lists pendingApprovals).");
    if (op.state !== "awaiting_approval") return { ...opView(op), next: "Already decided; nothing to ask." };
    const d = op.data as { branch: string; target: string; agentId?: string | null; require?: string | null; expectSha?: string | null };
    const repoEnv = await (await import("../merge/run-config")).runRepoEnv(a.runId);
    const cfg = (await import("../merge/config")).loadMergeConfig({ ...process.env, ...repoEnv });
    if (!cfg) throw new RelayError("config", `run ${a.runId} has no repository configured, so capcomd can't check the commit`, `Ask the user to run \`${cmd}\`.`);
    const { remoteBranchSha } = await import("../merge/repo");
    const headNow = async () => { try { return await remoteBranchSha(cfg, d.branch); } catch (e) { throw new RelayError("conflict", `couldn't read ${d.branch} on the remote (${(e as Error).message}); not approved`, `${NO_DECISION} (\`${cmd}\` works in a terminal.)`, { retryable: false }); } };
    const head = await headNow();
    const commit = d.expectSha ?? head;
    if (!commit || head !== commit) {
      throw new RelayError("conflict", `branch ${d.branch} moved since it was verified (${short(commit)} → ${short(head)}); not approved`, `The merge is still waiting and can only land ${short(commit)}. Verify the new commit (capcomd_verify) and merge that; tell the user. A person can deny this one: \`capcomd approve ${a.runId} ${a.merge} --deny\`.`, { code: "branch_moved" });
    }
    const v: any = d.require ? await s.getOp({ opId: d.require }).catch(() => null) : null;
    const vr = v?.result ?? {};
    const facts: ApprovalFacts = {
      project: port!.project, repo: cfg.remote, runId: a.runId, mergeId: a.merge, target: d.target, branch: d.branch, agentId: d.agentId ?? null, commit, deny: !!a.deny,
      checks: v ? { passed: vr.checks?.passed !== false, name: typeof v.data?.check === "string" ? v.data.check : null } : null,
      review: vr.review ? { passed: vr.review.passed === true, profile: vr.review.profile ?? null, agentId: vr.review.agentId ?? null, reasons: Array.isArray(vr.review.reasons) ? vr.review.reasons.map(String) : [] } : null,
      heldBy: (op.data as { heldBy?: { plugin: string; reason: string } }).heldBy ?? null,
    };
    const timeoutMs = Math.min(Math.max(Number(p.elicitTimeoutSeconds ?? ELICIT_TIMEOUT_S) || ELICIT_TIMEOUT_S, 1), 3600) * 1000;
    let action: string;
    try { action = await port!.ask(approvalPrompt(facts), { timeoutMs }); } catch (e) {
      process.stderr.write(`capcomd mcp: approval prompt for ${a.merge} got no answer (${(e as Error)?.message ?? e})\n`);
      action = "none";
    }
    const parked = { id: a.merge, state: "awaiting_approval", decision: null, ...(port!.project ? { project: port!.project.name } : {}), next: NO_DECISION };
    if (action !== "accept") return parked;
    // Bound to the commit shown: if the branch moved while the person read the prompt, their accept isn't for it.
    const after = await headNow();
    if (after !== commit) throw new RelayError("conflict", `branch ${d.branch} moved while the user was asked (${short(commit)} → ${short(after)}); not approved`, `The merge is still waiting. Verify the new commit (capcomd_verify) and merge that; tell the user.`, { code: "branch_moved" });
    // Who asked and what the person saw, next to the decision (kv approval/<mrg>, reserved: only capcomd writes it).
    await S.kvWrite(a.runId, { k: `approval/${a.merge}`, value: { decision: a.deny ? "deny" : "approve", by: ELICITED, client: name || null, commit, target: d.target, project: port!.project?.name ?? null, at: new Date().toISOString() }, writer: "operator" }).catch(() => {});
    const r = await (await F()).frontDecide(a.runId, a.merge, { approve: !a.deny, by: ELICITED, ...(a.deny && a.reason ? { reason: a.reason } : {}) }, { waitMs: WAIT_DEFAULT_MS, what: "capcomd_approve" });
    const said = { decision: a.deny ? "denied" : "approved", decidedBy: ELICITED, ...(name ? { via: name } : {}), commit };
    if (!r.done) return { id: a.merge, state: "running", ...said, next: "The user approved; the merge is landing (the checks run again on the latest target). Check with capcomd_tree." };
    return { ...(r.value as Record<string, unknown>), ...notConsulted(r.skipped, NO_DAEMON), ...said };
  } finally { asking.delete(key); }
}

// ── shared state ──────────────────────────────────────────────────────────────────────────────────

export async function task(a: { runId: string; action: string; title?: string; task?: string; epoch?: number; leaseMs?: number; after?: string[]; data?: unknown; result?: unknown; status?: string; key?: string }) {
  const key = a.key ? `${DRIVER}:${a.key}` : undefined;
  switch (a.action) {
    case "add": return S.taskAdd(a.runId, { title: String(a.title ?? ""), data: a.data, after: a.after, key });
    case "list": return { tasks: (await S.taskList(a.runId, a.status)).tasks };
    case "show": return S.taskGet(a.runId, String(a.task));
    case "claim": return S.taskClaim(a.runId, { holder: DRIVER, taskId: a.task, leaseMs: a.leaseMs, key });
    case "renew": return S.taskRenew(a.runId, { taskId: String(a.task), holder: DRIVER, epoch: Number(a.epoch), leaseMs: a.leaseMs });
    case "release": return S.taskFinish(a.runId, { taskId: String(a.task), holder: DRIVER, epoch: Number(a.epoch), outcome: "released", key });
    case "done": return S.taskFinish(a.runId, { taskId: String(a.task), holder: DRIVER, epoch: Number(a.epoch), outcome: "done", result: a.result, key });
  }
  throw new RelayError("usage", `task action ${a.action}?`, "add|list|show|claim|renew|release|done");
}

export async function kv(a: { runId: string; action: string; k?: string; value?: unknown; expect?: number; prefix?: string; key?: string }) {
  const k = String(a.k ?? "");
  if (a.action !== "get" && a.action !== "list" && RESERVED_KV.some((p) => k.startsWith(p))) deny(`kv key "${k}" is reserved for the orchestrator`, `Don't write keys starting with ${RESERVED_KV.join(", ")}.`);
  const tag = (v: any) => (v && v.writer && v.writer !== DRIVER ? { ...v, untrusted: true } : v);
  const key = a.key ? `${DRIVER}:${a.key}` : undefined;
  switch (a.action) {
    case "get": return tag(await S.kvGet(a.runId, k));
    case "list": return { items: ((await S.kvList(a.runId, a.prefix)).entries as any[]).map(tag) };
    case "put": return S.kvWrite(a.runId, { k, value: a.value, writer: DRIVER, key });
    case "cas": return S.kvWrite(a.runId, { k, value: a.value, expect: Number(a.expect), writer: DRIVER, key });
    case "del": return S.kvWrite(a.runId, { k, value: null, del: true, writer: DRIVER, ...(a.expect !== undefined ? { expect: Number(a.expect) } : {}) });
  }
  throw new RelayError("usage", `kv action ${a.action}?`, "get|put|cas|del|list");
}

export async function budget(a: { runId: string; agent?: string }) {
  return O.budgetShow(a.runId, a.agent);
}

// ── discover ──────────────────────────────────────────────────────────────────────────────────────

export async function setup() {
  const { checkSetup } = await import("../cli/commands/setup");
  const steps = await checkSetup(process.cwd(), { mcpClient: true });
  const d = process.env.CAPCOMD_NO_CONFIG ? {} : (await import("../config/store")).runDefaults();
  const p = await policy();
  const ready = steps.every((s) => s.ok);
  const failing = steps.filter((s) => !s.ok).map((s) => `${s.step}: ${s.hint ?? s.detail}`);
  const advice = steps.filter((s) => s.ok && s.advice && s.command).map((s) => `${s.step}: ${s.detail}. Recommended: \`${s.command}\` (a few minutes; ask the user first)`);
  return {
    ready, sandbox: steps.find((s) => s.step === "sandbox")?.sandbox ?? null, steps,
    // The target: the project's run default, else its merge target (what `capcomd setup project --target` writes).
    gates: { checks: d.checks ?? {}, reviewer: d.reviewer ?? null, target: d.target ?? (await import("../utils/env")).env("MERGE_TARGET") ?? null },
    driver: { approvals: p.approvals ?? "human", maxRunBudget: p.maxRunBudget ?? null },
    // How many agents run at once here (the team shape's budget of parallelism): on the sandbox this project's runs
    // would use (the project's, else the user config's), not this process's own default.
    capacity: await runCapacity(null, steps.find((s) => s.step === "sandbox")?.sandbox?.name ?? undefined),
    ...(advice.length ? { advice } : {}),
    next: ready
      ? `${advice.length ? `${advice.join(" ")} Then start` : "Start"} with capcomd_run_new (its sandbox is this project's unless you pass one).`
      : `Not ready: ${failing.join("; ")}. Fix these (\`capcomd setup\` in this repository walks through them), then call capcomd_setup again.`,
  };
}

export async function profiles() {
  const { agentsFilePath, readProfiles, leadText, abilityText, profileFacts, skillRows, untrustedPersona, untrustedSandbox } = await import("../profiles");
  const { readiness } = await import("../cli/commands/profiles");
  const { profileCapacity } = await import("../providers/capacity");
  const { loginOf, quotaUntil } = await import("../primitives/quota");
  const f = readProfiles(agentsFilePath());
  // The sandbox this project's runs use, as capcomd_setup reports it: its slots are every profile's capacity.
  const place = await runCapacity(null, (await import("../config/sandbox")).configuredSandbox(process.cwd()).name ?? undefined);
  // Its skills (names and hashes, never their text) and the project ones not trusted yet, which a spawn of it waits on,
  // as it does on a project persona not trusted yet (its file's name, never its text).
  const skillsOf = (sk: Parameters<typeof skillRows>[0]) => { const rows = skillRows(sk); return { skills: rows, untrustedSkills: rows.filter((r) => !r.trusted).map((r) => r.name) }; };
  const profiles = Object.entries(f.agents).map(([name, s]) => {
    const login = loginOf(s);
    return {
      name, provider: s.provider, auth: s.auth, model: s.model ?? null, canSpawn: !!(s as any).children?.allowSpawn, canLead: leadText(s), toolMode: s.toolMode ?? "execute",
      ...(s.description ? { description: s.description } : {}), does: abilityText(s), ...profileFacts(f.profiles[name]!),
      capacity: profileCapacity(place, login, login ? quotaUntil(login) : 0), ...readiness(name, s), ...skillsOf(f.profiles[name]!.skills), untrustedPersona: untrustedPersona(f.profiles[name]!.persona),
      untrustedSandbox: untrustedSandbox(f.profiles[name]!.machineFiles, f.profiles[name]!.runtime.sandboxProvider),
    };
  });
  const leads = profiles.filter((p) => p.canLead).map((p) => p.name);
  return {
    default: f.default ?? null, profiles,
    next: leads.length ? `To give a part with two or more independent sub-parts a lead, spawn ${leads.join(" or ")} with children: {maxChildren: N, maxDepth: 1} (skill: Choose a team shape).`
      : "No profile here can lead (spawn helpers): every agent does its task itself. Ask the user to run `capcomd setup project` again for a lead profile, or `capcomd profiles add lead …`.",
  };
}
