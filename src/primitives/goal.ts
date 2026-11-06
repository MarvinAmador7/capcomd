// A run's goal branch once its planner is done (capability runs.goal_branch): what landed on it and what didn't, the
// branch against its base, the planner's summary, and the user's choice: a pull request from the goal branch into the
// base (opened with the user's own GitHub login, never merged by capcomd), or keeping the branch. The CLI
// (`capcomd goal`, `capcomd pr open`), the MCP tools and the harness API all come here.
import { assertEngine, existingActor } from "../core/relay";
import { RelayError } from "../core/errors";
import { TERMINAL_AGENT } from "./policy";
import { shownTitle } from "./agent-title";
import type { GoalDecision, GoalState, ScopeAgent, ScopeOp } from "../actors/scope";

/** Where a goal branch stands. working: the planner is at it; ready: it finished, the user decides; stopped: it failed
 *  or was cancelled (the branch keeps what landed); pr_opened / kept: the user decided. */
export type GoalBranchState = "working" | "ready" | "stopped" | "pr_opened" | "kept";
export const GOAL_STATES: readonly GoalBranchState[] = ["working", "ready", "stopped", "pr_opened", "kept"];

/** Why a child's work isn't on the goal branch (a stable code; `detail` says more, agent-written). */
export type NotLandedReason =
  | "checks_failed" | "review_failed" | "merge_failed" | "denied" | "awaiting_approval" | "verifying" | "not_verified" | "not_merged"
  | "failed" | "cancelled" | "still_working";

const isReview = (a: Pick<ScopeAgent, "contract">) => !!(a.contract as Record<string, unknown> | null)?.review;
type Who = Pick<ScopeAgent, "parent" | "contract"> & { agentId?: string };
/**
 * Is `a` the run's planner? The run records its planner (`planner`: its id; null: a driver's run, which has none). A
 * record without the field (older): any top-level agent that isn't a reviewer, as before.
 */
const plannerTest = (planner: string | null | undefined) => (a: Who) => planner === undefined ? !a.parent && !isReview(a) : planner !== null && !a.parent && a.agentId === planner;
const LIVE = new Set(["pending", "running", "paused"]);

/** The goal branch's state from what the scope records and how its planners stand. */
export function goalStateOf(g: GoalState, agents: Array<Pick<ScopeAgent, "parent" | "contract" | "status"> & { agentId?: string }>, ended: boolean): GoalBranchState {
  if (g.decision?.choice === "pull_request") return "pr_opened";
  if (g.decision?.choice === "keep") return "kept";
  if (g.ready) return "ready";
  // A driver's run (no planner) is ready only when its driver says so (capcomd_goal done); it stops when the run ends.
  const planners = agents.filter(plannerTest(g.planner));
  if (ended || (planners.length > 0 && planners.every((a) => TERMINAL_AGENT.has(a.status)))) return "stopped";
  return "working";
}

/** Run.goalBranch: the light summary GET /v1/runs carries. */
export function goalSummary(g: GoalState | null | undefined, agents: Array<Pick<ScopeAgent, "parent" | "contract" | "status"> & { agentId?: string }>, ended: boolean) {
  if (!g) return null;
  const pr = g.decision?.choice === "pull_request" && g.decision.pr ? { number: g.decision.pr.number, url: g.decision.pr.url } : null;
  return { branch: g.branch, base: g.base, state: goalStateOf(g, agents, ended), readyAt: g.ready ? new Date(g.ready.at).toISOString() : null, pullRequest: pr };
}

const firstLine = (t: unknown, max = 200) => {
  const l = String(t ?? "").split(/\r?\n/).map((x) => x.trim()).find(Boolean) ?? "";
  return l.length > max ? `${l.slice(0, max - 1)}…` : l;
};
const str = (v: unknown) => (typeof v === "string" && v ? v : null);

export interface LandedWork {
  agentId: string; parent: string | null; profile: string | null; task: string; branch: string | null;
  /** Its title (capability agents.title), what a person reads first; null when it has neither a title nor a task. */
  title?: string | null;
  /** The agents whose work this one carries on (`spawn --continue`, oldest last): their work landed, or didn't, here. */
  continues?: string[];
  mergeId: string; sha: string | null; verifyId: string | null; mergedBy: string | null;
  checks: { passed: boolean } | null;
  review: { passed: boolean; agentId: string | null; reasons: string[] } | null;
}
export interface NotLandedWork {
  agentId: string; parent: string | null; profile: string | null; task: string; branch: string | null; status: string;
  title?: string | null;
  continues?: string[];
  reason: NotLandedReason; detail: string | null;
}

/** What landed on the goal branch and what didn't, from the run's agents and its verify and merge records. */
export function landedOf(goal: { branch: string; planner?: string | null }, agents: ScopeAgent[], ops: ScopeOp[]): { landed: LandedWork[]; notLanded: NotLandedWork[] } {
  const isPlanner = plannerTest(goal.planner);
  const landed: LandedWork[] = [], notLanded: NotLandedWork[] = [];
  const byAgent = (kind: string, id: string) => ops.filter((o) => o.kind === kind && o.data.agentId === id).sort((a, b) => a.updatedAt - b.updatedAt);
  const hasKids = new Set(agents.map((a) => a.parent).filter(Boolean) as string[]);
  // A child continued by another (`spawn --continue`, e.g. after a merge conflict) isn't listed on its own: its work
  // went on in the agent that continued it, which is listed (landed or not) and says whose work it carries on.
  const fromOf = (a: ScopeAgent): string | null => { const f = (a.contract as any)?.from?.agentId; return typeof f === "string" && f ? f : null; };
  const continued = new Set(agents.map(fromOf).filter(Boolean) as string[]);
  const chainOf = (a: ScopeAgent): string[] => {
    const out: string[] = [];
    for (let f = fromOf(a); f && !out.includes(f); ) { out.push(f); const p = agents.find((x) => x.agentId === f); f = p ? fromOf(p) : null; }
    return out;
  };
  for (const a of agents) {
    if (isPlanner(a) || isReview(a) || continued.has(a.agentId)) continue;
    const merges = byAgent("merge", a.agentId).filter((m) => m.data.target === goal.branch);
    const verifies = byAgent("verify", a.agentId);
    const r = (a.result ?? {}) as Record<string, any>;
    const base = { agentId: a.agentId, parent: a.parent, profile: a.profile ? a.profile.toLowerCase() : null, task: firstLine(a.task), branch: str(r.branch),
      title: shownTitle(a.titleState, a.task).title, continues: chainOf(a) };
    const merged = merges.find((m) => m.state === "merged");
    if (merged) {
      const v = merged.data.require ? ops.find((o) => o.id === merged.data.require) : verifies.filter((x) => x.state === "passed").at(-1);
      const rv = (v?.result?.review ?? null) as Record<string, any> | null;
      landed.push({
        ...base, branch: str(merged.data.branch) ?? base.branch, mergeId: merged.id, sha: str(merged.result?.sha), verifyId: v?.id ?? null, mergedBy: str(merged.data.askedBy),
        checks: v?.result?.checks ? { passed: v.result.checks.passed === true } : null,
        review: rv ? { passed: rv.passed === true, agentId: str(rv.agentId), reasons: Array.isArray(rv.reasons) ? rv.reasons.map(String) : [] } : null,
      });
      continue;
    }
    const no = (reason: NotLandedReason, detail: unknown = null) => notLanded.push({ ...base, status: a.status, reason, detail: detail == null || detail === "" ? null : String(detail).slice(0, 1000) });
    const lastMerge = merges.at(-1), lastVerify = verifies.at(-1);
    if (lastMerge?.state === "awaiting_approval") { no("awaiting_approval"); continue; }
    if (lastMerge && lastMerge.state !== "running") { no(lastMerge.result?.status === "denied" ? "denied" : "merge_failed", lastMerge.result?.reason ?? lastMerge.result?.status); continue; }
    if (lastVerify?.state === "running" || lastMerge?.state === "running") { no("verifying"); continue; }
    if (lastVerify?.state === "failed") {
      const res = (lastVerify.result ?? {}) as Record<string, any>;
      if (res.checks && res.checks.passed === false) no("checks_failed", res.checks.reason ?? res.checks.status);
      else no("review_failed", res.review ? (res.review.error ?? (Array.isArray(res.review.reasons) ? res.review.reasons.join("; ") : null)) : null);
      continue;
    }
    if (LIVE.has(a.status)) { no("still_working"); continue; }
    if (a.status === "failed") { no("failed", r.error); continue; }
    if (a.status === "cancelled") { no("cancelled", r.error ?? null); continue; }
    // Done with nothing of its own to land: a report, no changes, or a lead whose children landed their work.
    if (!str(r.commit) || (hasKids.has(a.agentId) && !verifies.length)) continue;
    if (lastVerify?.state === "passed") no("not_merged");
    else no("not_verified");
  }
  return { landed, notLanded };
}

/** Whether a pull request can be opened from here, and why not (a sentence for the person). */
export type PullRequestFit = { available: boolean; reason: string | null; repo: string | null };

/** A forge's `reason` or `fix` inside the kernel's own sentence ("… there is none on this machine: run `gh auth login` …"). */
const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const upper = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const noStop = (s: string) => s.replace(/[.\s]+$/, "");

/**
 * Whether a pull request can be opened from here: the project's forge (docs/spec/plugin-api.md §7.4) has pull requests
 * (a forge that only pushes, git, can't), and the user's own login at it is on this machine (its `login`). The
 * sentences are said in the forges' own words: "isn't on GitHub" names the active forges that have pull requests.
 */
async function pullRequestFit(runId: string, branch: string): Promise<PullRequestFit & { cfg: import("../merge/config").MergeConfig | null; fix: string | null }> {
  const cfg = await (await import("../merge/run-config")).mergeConfigFor(runId).catch(() => null);
  if (!cfg) return { available: false, reason: "This run has no repository, so there is no pull request to open.", repo: null, cfg, fix: null };
  const repo = cfg.github.repo || null;
  const F = await import("../plugins/forges");
  const forge = await F.forgeFor(cfg).catch(() => null);
  if (!forge?.describe().pullRequests) {
    const prs = await F.pullRequestLabels();
    const why = prs.length ? `The repository (${cfg.remote}) isn't on ${F.orList(prs)}, so capcomd can't open a pull request.`
      : `No active forge supports pull requests, so capcomd can't open one for ${cfg.remote}.`;
    return { available: false, reason: `${why} The work is on ${branch}: open one or merge it with your own tools.`, repo, cfg, fix: null };
  }
  const login = await F.forgeLogin(forge, { use: "pullRequests" }, { merge: cfg });
  if (!login.ok) {
    const label = forge.describe().label;
    const fix = login.fix ? noStop(login.fix) : null;
    const why = fix ? `there is none on this machine: ${lower(fix)}, then try again` : noStop(lower(login.reason));
    return { available: false, reason: `capcomd opens pull requests with your ${label} login, and ${why}. The work is on ${branch}.`, repo, cfg, fix };
  }
  return { available: true, reason: null, repo, cfg, fix: null };
}

/** A stopped goal (the planner failed or was cancelled before it finished): the question to put to the person before a
 *  pull request is opened with what landed. null for any other state. */
export function stoppedQuestion(state: GoalBranchState, branch: string, agents: Array<Pick<ScopeAgent, "parent" | "contract" | "status"> & { agentId?: string }>, w: { landed: unknown[]; notLanded: unknown[] }, plannerId?: string | null): string | null {
  if (state !== "stopped") return null;
  const total0 = w.landed.length + w.notLanded.length;
  if (plannerId === null) return `The run ended before its goal was marked done: ${w.landed.length} of ${total0} ${total0 === 1 ? "task" : "tasks"} landed on ${branch}. Open a pull request with what landed?`;
  const planner = agents.filter(plannerTest(plannerId)).at(-1);
  const how = planner?.status === "failed" ? " (it failed)" : planner?.status === "cancelled" ? " (it was cancelled)" : "";
  const total = w.landed.length + w.notLanded.length;
  return `The planner stopped before it finished${how}: ${w.landed.length} of ${total} ${total === 1 ? "task" : "tasks"} landed on ${branch}. Open a pull request with what landed?`;
}

async function scopeOf(runId: string) {
  const s = await existingActor("scope", [runId]);
  const meta = s ? ((await s.getScope({}).catch(() => null)) as Record<string, any> | null) : null;
  if (!s || !meta) throw new RelayError("not_found", `run ${runId} not found`, "List runs with `capcomd runs` (or GET /v1/runs).");
  const g = meta.goalBranch as GoalState | null;
  if (!g) throw new RelayError("not_found", `run ${runId} has no goal branch`, "Runs started with a goal branch (`capcomd run <goal>`, the app) have one; this one merged straight into its target.", { code: "no_goal_branch" });
  return { s, meta, g };
}

/** The goal branch as the user sees it once the planner is done (also while it works): GET /v1/runs/{runId}/goal. */
export async function goalView(runId: string) {
  await assertEngine();
  const { s, meta, g } = await scopeOf(runId);
  const [agents, ops] = await Promise.all([s.listAgents({}) as Promise<ScopeAgent[]>, s.listOps({}) as Promise<ScopeOp[]>]);
  const state = goalStateOf(g, agents, !!meta.ended);
  const isPlanner = plannerTest(g.planner);
  const planner = agents.find((a) => a.agentId === g.ready?.plannerId) ?? agents.filter(isPlanner).at(-1) ?? null;
  const { landed, notLanded } = landedOf(g, agents, ops);
  const fit = await pullRequestFit(runId, g.branch);
  const live = agents.some((a) => isPlanner(a) && LIVE.has(a.status));
  const compare = await compareOf(fit.cfg, g);
  const open: PullRequestFit = fit.available && live ? { available: false, reason: "The planner is still working: open a pull request when the run is ready.", repo: fit.repo }
    : fit.available && !g.decision?.pr && "ahead" in compare && compare.ahead === 0 ? { available: false, reason: `Nothing landed on ${g.branch} yet, so there is nothing to open a pull request for.`, repo: fit.repo }
    : { available: fit.available, reason: fit.reason, repo: fit.repo };
  const decision = g.decision ? { choice: g.decision.choice, by: g.decision.by, at: new Date(g.decision.at).toISOString() } : null;
  const pr = g.decision?.pr ? { number: g.decision.pr.number, url: g.decision.pr.url } : null;
  const pres = (await import("../api/run-files")).summarizeDiff;
  return {
    runId, branch: g.branch, base: g.base, state, goal: (meta.goal as string | null) ?? null,
    readyAt: g.ready ? new Date(g.ready.at).toISOString() : null, plannerId: planner?.agentId ?? null,
    summary: planner && typeof (planner.result as any)?.summary === "string" ? String((planner.result as any).summary).slice(0, 64 * 1024) : g.ready?.summary ?? null,
    // A driver's run: it says the goal is done itself (capcomd_goal done: true), its summary is the driver's.
    driven: g.planner === null,
    compare: "error" in compare
      ? { baseSha: null, headSha: null, ahead: null, behind: null, commits: [], commitsTotal: null, files: [], filesTotal: null, added: null, removed: null, error: compare.error }
      : { baseSha: compare.baseSha, headSha: compare.headSha, ahead: compare.ahead, behind: compare.behind, commits: compare.commits, commitsTotal: compare.ahead,
        ...((d) => ({ files: compare.files.slice(0, GOAL_FILES_MAX).map((f) => ({ path: f.path, oldPath: f.oldPath, status: f.status, added: f.added, removed: f.removed })), filesTotal: d.filesTotal, added: d.added, removed: d.removed }))(pres(compare.files)),
        error: null },
    landed, notLanded, pullRequest: pr,
    openPullRequest: { available: open.available, reason: open.reason, repo: open.repo, confirm: open.available ? stoppedQuestion(state, g.branch, agents, { landed, notLanded }, g.planner) : null }, decision,
  };
}
export const GOAL_FILES_MAX = 200;

type Compare = import("../api/run-files").BranchCompare;
async function compareOf(cfg: import("../merge/config").MergeConfig | null, g: { branch: string; base: string }): Promise<Compare> {
  if (!cfg) return { error: "no repository is configured for this run" };
  const { mirrorFor } = await import("../api/run-files");
  return mirrorFor({ remote: cfg.remote, target: g.base, workdir: cfg.workdir }).compare(g.base, g.branch).catch((e) => ({ error: String((e as Error)?.message ?? e).slice(0, 200) }));
}

/** What a person reads for a child's work: its title, else the first line of its task. */
const workLabel = (w: { title?: string | null; task: string }) => w.title || w.task || "(no task)";
/** ", carries on agt-…'s work" for an agent that continued others' work (`spawn --continue`). */
const carriesOn = (w: { continues?: string[] }) => w.continues?.length ? `, carries on ${w.continues.join(", ")}'s work` : "";

/** Where a pull request is when its forge can't be told (a forge's label is "on <label>"). */
const WHERE_HOSTED = "where the repository is hosted";

/** Where the run's pull request is, in its forge's words ("on GitHub": its `describe().label`), else WHERE_HOSTED. */
export async function pullRequestPlace(runId: string): Promise<string> {
  const cfg = await (await import("../merge/run-config")).mergeConfigFor(runId).catch(() => null);
  const label = cfg ? (await (await import("../plugins/forges")).forgeFor(cfg).catch(() => null))?.describe().label : null;
  return label ? `on ${label}` : WHERE_HOSTED;
}

/** The pull request's body: the planner's summary, then what each agent landed and how it was reviewed, then what didn't. */
/** `forge`: the label of the forge the pull request is opened on (its `describe().label`), where the person merges it. */
export function pullRequestBody(o: { runId: string; branch: string; summary: string | null; landed: LandedWork[]; notLanded: NotLandedWork[]; stopped?: string | null; forge?: string }): string {
  const lines: string[] = [];
  // A stopped run says so first: the person opened it knowing the planner didn't finish.
  const total = o.landed.length + o.notLanded.length;
  if (o.stopped) lines.push(`> **The run stopped before the planner finished:** ${o.stopped}. ${o.landed.length} of ${total} ${total === 1 ? "task" : "tasks"} landed${o.notLanded.length ? "; what didn't is listed below" : ""}.`, "");
  if (o.summary?.trim()) lines.push(o.summary.trim().slice(0, 20_000), "");
  lines.push(`## What landed on \`${o.branch}\``, "");
  if (!o.landed.length) lines.push("Nothing was merged by the run's agents.");
  for (const l of o.landed) {
    const review = l.review ? (l.review.passed ? `reviewed and approved${l.review.agentId ? ` by ${l.review.agentId}` : ""}` : "review did not pass") : "no reviewer";
    const checks = l.checks ? (l.checks.passed ? "checks passed" : "checks failed") : "no checks recorded";
    lines.push(`- ${workLabel(l)} (${l.agentId}${l.profile ? `, ${l.profile}` : ""}${carriesOn(l)}): ${checks}, ${review}${l.sha ? `; ${l.sha.slice(0, 12)}` : ""}`);
    for (const r of l.review?.reasons.slice(0, 5) ?? []) lines.push(`  - ${firstLine(r, 300)}`);
  }
  if (o.notLanded.length) {
    lines.push("", "## Not landed", "");
    for (const n of o.notLanded) lines.push(`- ${workLabel(n)} (${n.agentId}${carriesOn(n)}): ${n.reason.replace(/_/g, " ")}${n.detail ? `: ${firstLine(n.detail, 300)}` : ""}`);
  }
  lines.push("", "---", `Opened by capcomd from run ${o.runId}. capcomd never merges this pull request: review and merge it ${o.forge ? `on ${o.forge}` : WHERE_HOSTED}.`);
  // Under the smallest cap a hosting service puts on a body (GitHub's is 65536 characters).
  return lines.join("\n").slice(0, 60_000);
}

/** Refuse a choice while the planner works (the user decides once the run is ready). */
function assertDecidable(agents: ScopeAgent[], g: GoalState) {
  const isPlanner = plannerTest(g.planner);
  if (agents.some((a) => isPlanner(a) && LIVE.has(a.status)))
    throw new RelayError("conflict", `the planner is still working on ${g.branch}`, "Wait until the run is ready (run.goal_completed), then open the pull request.", { code: "not_ready" });
}

/**
 * Open a pull request from the run's goal branch into its base, with the user's own GitHub login. Idempotent: a pull
 * request GitHub already has for the branch (open or merged) is returned, not opened again. capcomd never merges it.
 * A stopped goal (the planner failed or was cancelled) is refused (`conflict`, reason `stopped`, the question to ask)
 * unless `stopped` says the person was asked and said yes.
 */
export async function openGoalPullRequest(runId: string, o: { by: string; stopped?: boolean }) {
  await assertEngine();
  const { s, meta, g } = await scopeOf(runId);
  const [agents, ops] = await Promise.all([s.listAgents({}) as Promise<ScopeAgent[]>, s.listOps({}) as Promise<ScopeOp[]>]);
  assertDecidable(agents, g);
  const fit = await pullRequestFit(runId, g.branch);
  if (!fit.available || !fit.cfg) throw new RelayError("conflict", fit.reason ?? "a pull request can't be opened", "Open it with your own tools; the branch is pushed.", { code: "github" });
  // Through the project's forge (docs/spec/plugin-api.md §7.4), with the run's own settings.
  const F = await import("../plugins/forges");
  const forge = (await F.forgeFor(fit.cfg))!;
  const label = forge.describe().label;
  const call = <T>(fn: (c: import("../../packages/plugin/src/seams").SeamCall) => Promise<T>) => F.withForge({ merge: fit.cfg }, 60_000, fn);
  // What to do next, in the forge's words (its classifyError's hint, §7.2.3).
  const next = (e: unknown, otherwise: string) => { const k = forge.classifyError(e); return "hint" in k && k.hint ? `${upper(noStop(k.hint))}, then try again.` : otherwise; };
  const noLogin = (e: unknown) => (e as { name?: string; code?: string })?.name === "PluginError" && (e as { code?: string }).code === "unavailable"
    ? new RelayError("conflict", (e as Error).message, next(e, "Log in, then try again."), { code: "github" }) : null;
  const view = (p: import("../../packages/plugin/src/seams").PullRequestRef, created: boolean) => ({
    runId, branch: g.branch, base: g.base, created,
    pullRequest: { number: p.number, url: p.url, state: p.state },
  });
  const record = async (v: ReturnType<typeof view>) => { await s.goalDecision({ choice: "pull_request", by: o.by, pr: { number: v.pullRequest.number, url: v.pullRequest.url } }); return v; };
  const head = { remote: fit.cfg.remote, head: g.branch, base: g.base };
  const existing = await call((c) => forge.findPullRequest(head, c)).catch((e) => { throw noLogin(e) ?? new RelayError("conflict", `${label}: ${(e as Error).message}`, next(e, `Check your ${label} login and try again.`), { code: "github" }); });
  if (existing) return record(view(existing, false));
  const compare = await compareOf(fit.cfg, g);
  if (!("error" in compare) && compare.ahead === 0) throw new RelayError("conflict", `nothing landed on ${g.branch}: it has no commits that ${g.base} doesn't`, "There is nothing to open a pull request for.", { code: "empty" });
  const { landed, notLanded } = landedOf(g, agents, ops);
  const state = goalStateOf(g, agents, !!meta.ended);
  const ask = stoppedQuestion(state, g.branch, agents, { landed, notLanded }, g.planner);
  if (ask && !o.stopped) throw new RelayError("conflict", ask, "Ask the person first; if they want it, open it with `capcomd pr open <runId> --yes` (POST …/pull-request {\"stopped\": true}).", { code: "stopped" });
  const planner = agents.find((a) => a.agentId === g.ready?.plannerId) ?? agents.filter(plannerTest(g.planner)).at(-1);
  const goal = (meta.goal as string | null) ?? (meta.label as string | null) ?? g.branch;
  const title = firstLine(goal, 120) || g.branch;
  const stopped = !ask ? null : planner?.status === "failed" ? "the planner failed" : planner?.status === "cancelled" ? "the planner was cancelled" : "the run ended first";
  const body = pullRequestBody({ runId, branch: g.branch, summary: typeof (planner?.result as any)?.summary === "string" ? (planner!.result as any).summary : g.ready?.summary ?? null, landed, notLanded, stopped, forge: label });
  const pr = await call((c) => forge.openPullRequest({ ...head, title, body }, c)).catch((e) => { throw noLogin(e) ?? new RelayError("conflict", `${label} refused the pull request: ${(e as Error).message}`, `Check the branch on ${label} and your access to the repository.`, { code: "github" }); });
  return record(view(pr, true));
}

/** Keep the goal branch without a pull request (clients stop asking). Refused after a pull request was opened. */
export async function keepGoalBranch(runId: string, o: { by: string }) {
  await assertEngine();
  const { s, g } = await scopeOf(runId);
  assertDecidable((await s.listAgents({})) as ScopeAgent[], g);
  const r = (await s.goalDecision({ choice: "keep", by: o.by }).catch(async (e: any) => {
    if (e?.code === "conflict") {
      // Where it is open: the run's forge's words (docs/spec/plugin-api.md §7.4).
      throw new RelayError("conflict", String(e.message), `The pull request is open ${await pullRequestPlace(runId)}: close it there if you don't want it.`, { code: "pr_open" });
    }
    throw e;
  })) as { changed: boolean; decision: GoalDecision };
  return { runId, branch: g.branch, base: g.base, kept: true, changed: r.changed };
}

/**
 * A driver's run (no planner agent): the driver says its goal is done, with a summary of what it did. The goal branch
 * is then ready for the user (run.goal_completed), as a planner run is when its planner finishes. Refused while an agent
 * works, and in a planner's run.
 */
export async function markGoalDone(runId: string, o: { by: string; summary?: string | null }) {
  await assertEngine();
  const { s } = await scopeOf(runId);
  try { await s.goalDone({ by: o.by, summary: o.summary ?? null }); }
  catch (e) {
    const m = (e as Error)?.message ?? String(e);
    throw new RelayError("conflict", m.replace(/^\w+: /, ""), /still working/.test(m) ? "Wait for them (capcomd_await), verify and merge what's done, then mark the goal done." : "A run started with a planner agent is ready when its planner finishes.", { code: "not_ready" });
  }
  return goalView(runId);
}
