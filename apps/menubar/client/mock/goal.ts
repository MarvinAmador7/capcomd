// Goal branches for the UI mock (scenarios.ts, SCENARIO=goal): capability runs.goal_branch, answered as the daemon does
// (src/api/contract.ts; names and sentences from src/merge/goal.ts and src/primitives/goal.ts).
//
//   GET  /v1/projects/branches?path&goal&goalBranch&base   the setup's base menu, suggested goal branch and checks
//   POST /v1/runs (base, goalBranch)                        422 with `field` base / goalBranch, as the daemon refuses
//   GET  /v1/runs/{runId}/goal                              the branch against its base, landed / not landed, the summary
//   POST /v1/runs/{runId}/pull-request ({"stopped": true})  opens #n once (run.pr_opened); 409 conflict / stopped
//   POST /v1/runs/{runId}/keep-branch                       run.branch_kept; 409 once a pull request is open
//
// Knobs (env):
//   GOAL_READY_AFTER=<ms>   run-gb01 goes working → ready this long after the server starts (default 8000; 0: ready now)
//   GOAL_BASE=dev|none      the project's target; none: no target and no default branch reported, so the person picks
//   GOAL_SOURCE=github|git  where the branches came from (git: with the daemon's note about the GitHub login)
//   GOAL_GITHUB=yes|no|nologin   the repository on GitHub with a login (yes), not on GitHub (no), or no gh login
import { baseProblem, goalBranchProblem, suggestGoalBranch } from "../../../../src/merge/goal";

export const goalCaps = ["runs.goal_branch"];
const REPO = "acme/app";
const BRANCHES = ["capcomd/add-a-clamp-helper", "dev", "main", "release/2026-10"];
const env = (k: string, d: string) => process.env[k] ?? d;

type Landed = { agentId: string; task: string; checks: boolean | null; review: boolean | null; reasons?: string[] };
type NotLanded = { agentId: string; task: string; reason: string; status: string; detail: string | null };
export type GoalSpec = {
  branch: string; base: string; state: "working" | "ready" | "stopped" | "pr_opened" | "kept"; plannerId: string;
  /** Ready (or stopped) after this many ms; null: as it is. */
  readyAfter: number | null;
  summary: string | null; landed: Landed[]; notLanded: NotLanded[];
  files: Array<{ path: string; status: string; added: number | null; removed: number | null }>;
  commits: string[]; behind: number;
  pr: { number: number; url: string } | null; readyAt: number | null;
  decision: { choice: "pull_request" | "keep"; by: string; at: number } | null;
};

export const clampGoal = (): GoalSpec => {
  const after = Number(env("GOAL_READY_AFTER", "8000"));
  return {
    branch: "capcomd/add-a-clamp-helper-2", base: "dev", state: after > 0 ? "working" : "ready", plannerId: "agt-gb-pl", readyAfter: after > 0 ? after : null,
    summary: "Added clamp(x, lo, hi) to src/math.ts with a bun test for the edges (lo > hi throws).\nLeft out: the docs page, whose worker failed its checks; it can follow in another run.",
    landed: [
      { agentId: "agt-gb-w1", task: "Add clamp(x, lo, hi) to src/math.ts", checks: true, review: true, reasons: ["Handles lo > hi by throwing, as asked."] },
      { agentId: "agt-gb-w2", task: "Test clamp's edges in src/math.test.ts", checks: true, review: true },
    ],
    notLanded: [{ agentId: "agt-gb-w3", task: "Document clamp in docs/math.md", reason: "checks_failed", status: "done", detail: "markdownlint: docs/math.md:12 MD040 fenced code blocks should have a language" }],
    files: [{ path: "src/math.test.ts", status: "added", added: 13, removed: 0 }, { path: "src/math.ts", status: "modified", added: 11, removed: 0 }],
    commits: ["Test clamp's edges", "Add clamp(x, lo, hi)"], behind: 0, pr: null, readyAt: after > 0 ? null : Date.now(), decision: null,
  };
};
export const ledgerGoal = (): GoalSpec => ({
  branch: "capcomd/migrate-the-ledger-to-v2", base: "dev", state: "stopped", plannerId: "agt-gl-pl", readyAfter: null,
  summary: null,
  landed: [{ agentId: "agt-gl-w1", task: "Add the v2 ledger schema", checks: true, review: true }],
  notLanded: [
    { agentId: "agt-gl-w2", task: "Backfill v1 rows into v2", reason: "failed", status: "failed", detail: "usage limit reached (resets 18:40)" },
    { agentId: "agt-gl-w3", task: "Switch readers to v2", reason: "cancelled", status: "cancelled", detail: null },
  ],
  files: [{ path: "db/ledger_v2.sql", status: "added", added: 64, removed: 0 }],
  commits: ["Add the v2 ledger schema"], behind: 3, pr: null, readyAt: null, decision: null,
});

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
const decided = (g: GoalSpec) => g.state === "pr_opened" || g.state === "kept";

/** Run.goalBranch. */
export const goalSummary = (g: GoalSpec) => ({ branch: g.branch, base: g.base, state: g.state, readyAt: iso(g.readyAt), pullRequest: g.pr });

const github = () => env("GOAL_GITHUB", "yes");
function openFit(g: GoalSpec) {
  if (github() === "no") return { available: false, reason: `The repository (/srv/git/app.git) isn't on GitHub, so capcomd can't open a pull request. The work is on ${g.branch}: open one or merge it with your own tools.`, repo: null };
  if (github() === "nologin") return { available: false, reason: `capcomd opens pull requests with your GitHub login, and there is none on this machine: run \`gh auth login\` (or set GITHUB_TOKEN), then try again. The work is on ${g.branch}.`, repo: REPO };
  if (g.state === "working") return { available: false, reason: "The planner is still working: open a pull request when the run is ready.", repo: REPO };
  return { available: true, reason: null, repo: REPO };
}
const stoppedQuestion = (g: GoalSpec) => {
  const total = g.landed.length + g.notLanded.length;
  return `The planner stopped before it finished (it failed): ${g.landed.length} of ${total} ${total === 1 ? "task" : "tasks"} landed on ${g.branch}. Open a pull request with what landed?`;
};

/** GET /v1/runs/{runId}/goal. */
export function goalView(runId: string, goal: string, g: GoalSpec) {
  const fit = openFit(g);
  const sha = (n: number) => (n.toString(16) + "f".repeat(40)).slice(0, 40);
  return {
    runId, branch: g.branch, base: g.base, state: g.state, goal, readyAt: iso(g.readyAt), plannerId: g.plannerId,
    summary: g.state === "working" ? null : g.summary,
    compare: { baseSha: sha(1), headSha: sha(2), ahead: g.commits.length, behind: g.behind, commits: g.commits.map((s, i) => ({ sha: sha(10 + i), subject: s, at: null })), commitsTotal: g.commits.length,
      files: g.files.map((f) => ({ ...f, oldPath: null })), filesTotal: g.files.length,
      added: g.files.reduce((n, f) => n + (f.added ?? 0), 0), removed: g.files.reduce((n, f) => n + (f.removed ?? 0), 0), error: null },
    landed: g.landed.map((l, i) => ({ agentId: l.agentId, parent: g.plannerId, profile: "worker", task: l.task, branch: `capcomd/${runId}/${l.agentId}`, mergeId: `mrg-${i + 1}`, sha: sha(20 + i),
      verifyId: `vfy-${i + 1}`, mergedBy: g.plannerId, checks: l.checks === null ? null : { passed: l.checks }, review: l.review === null ? null : { passed: l.review, agentId: "agt-rv", reasons: l.reasons ?? [] } })),
    notLanded: g.notLanded.map((n) => ({ agentId: n.agentId, parent: g.plannerId, profile: "worker", task: n.task, branch: null, status: n.status, reason: n.reason, detail: n.detail })),
    pullRequest: g.pr,
    openPullRequest: { ...fit, confirm: fit.available && g.state === "stopped" ? stoppedQuestion(g) : null },
    decision: g.decision ? { ...g.decision, at: iso(g.decision.at) } : null,
  };
}

/** GET /v1/projects/branches. */
function branches(url: URL) {
  const q = (k: string) => url.searchParams.get(k);
  const path = q("path") ?? "";
  if (!path.startsWith("/")) return Response.json({ code: "invalid", message: "path must be absolute" }, { status: 422 });
  const none = env("GOAL_BASE", "dev") === "none", git = env("GOAL_SOURCE", "github") === "git";
  const projectTarget = none ? null : env("GOAL_BASE", "dev"), defaultBranch = none ? null : "main";
  const base = q("base"), goal = q("goal"), name = q("goalBranch");
  const suggestedBase = base ?? projectTarget ?? defaultBranch;
  const goalBranchProblemOf = (n: string) => goalBranchProblem(n, { base: base ?? suggestedBase, env: { CAPCOMD_PROTECTED_BRANCHES: "main,release/*" } })
    ?? (BRANCHES.includes(n) ? `${n} is already a branch of ${REPO}: pick another name (capcomd never reuses a branch for a goal).` : null);
  return Response.json({
    path, root: path.replace(/\/src$/, ""), github: REPO, source: git ? "git" : "github",
    note: git ? "GitHub: no login (GITHUB_TOKEN, GH_TOKEN or `gh auth login`); read with git ls-remote" : null,
    defaultBranch, branches: BRANCHES, projectTarget, suggestedBase,
    suggestedGoalBranch: goal ? suggestGoalBranch(goal, BRANCHES) : null,
    goalBranchProblem: name ? goalBranchProblemOf(name) : null,
    baseProblem: base ? (baseProblem(base) ?? (BRANCHES.includes(base) ? null : `base ${base} isn't a branch of ${REPO}`)) : null,
  });
}

/** POST /v1/runs with goal branches: the refusals the daemon gives, with `field`; null when it would start. */
export function goalCreateRefusal(body: any): Response | null {
  const none = env("GOAL_BASE", "dev") === "none";
  const base: string | undefined = body.base ?? (none ? undefined : env("GOAL_BASE", "dev"));
  const no = (field: string, message: string) => Response.json({ code: "invalid", message, field }, { status: 422 });
  if (!base) return no("base", "capcomd can't tell which branch this run starts from: the project has no target and origin reports no default branch. Pick the base.");
  if (!BRANCHES.includes(base)) return no("base", `base ${base} isn't a branch of ${REPO}`);
  if (typeof body.goalBranch === "string") {
    const p = goalBranchProblem(body.goalBranch, { base, env: { CAPCOMD_PROTECTED_BRANCHES: "main,release/*" } })
      ?? (BRANCHES.includes(body.goalBranch) ? `${body.goalBranch} is already a branch of ${REPO}: pick another name.` : null);
    if (p) return no("goalBranch", p);
  }
  return null;
}

type Emit = (runId: string, type: string, data: Record<string, unknown>) => void;
/** The goal routes for the runs that have one; null for anything else. */
export async function goalRoute(url: URL, req: Request, goals: Map<string, { goal: string; spec: GoalSpec }>, emit: Emit): Promise<Response | null> {
  const p = url.pathname;
  if (p === "/v1/projects/branches") return branches(url);
  const m = p.match(/^\/v1\/runs\/([^/]+)\/(goal|pull-request|keep-branch)$/);
  if (!m) return null;
  const run = goals.get(m[1]!);
  if (!run) return Response.json({ code: "not_found", message: `run ${m[1]} has no goal branch` }, { status: 404 });
  const g = run.spec, runId = m[1]!;
  const conflict = (message: string, code = "conflict") => Response.json({ code, message }, { status: 409 });
  if (m[2] === "goal") return Response.json(goalView(runId, run.goal, g));
  if (req.method !== "POST") return null;
  if (!req.headers.get("idempotency-key")) return Response.json({ code: "invalid", message: "Idempotency-Key header (8-200 chars) is required" }, { status: 422 });
  if (m[2] === "pull-request") {
    const body: any = await req.text().then((t) => (t.trim() ? JSON.parse(t) : {})).catch(() => ({}));
    const result = (created: boolean) => Response.json({ runId, branch: g.branch, base: g.base, created, pullRequest: { ...g.pr!, state: "open" } });
    if (g.pr) return result(false);
    const fit = openFit(g);
    if (!fit.available) return conflict(fit.reason!);
    if (g.state === "stopped" && body?.stopped !== true) return conflict(stoppedQuestion(g), "stopped");
    await Bun.sleep(700);   // GitHub takes a moment
    g.pr = { number: 42, url: `https://github.com/${REPO}/pull/42` };
    g.state = "pr_opened"; g.decision = { choice: "pull_request", by: "client:menubar", at: Date.now() };
    emit(runId, "run.pr_opened", { branch: g.branch, base: g.base, number: 42, url: g.pr.url, by: "client:menubar" });
    return result(true);
  }
  if (g.state === "working") return conflict(`the planner is still working on ${g.branch}`);
  if (g.pr) return conflict(`a pull request (#${g.pr.number}) is open from ${g.branch}: there's nothing to keep`);
  const changed = !decided(g);
  if (changed) {
    await Bun.sleep(300);
    g.state = "kept"; g.decision = { choice: "keep", by: "client:menubar", at: Date.now() };
    emit(runId, "run.branch_kept", { branch: g.branch, base: g.base, by: "client:menubar" });
  }
  return Response.json({ runId, branch: g.branch, base: g.base, kept: true, changed });
}
