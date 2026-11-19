// Goal branch names (src/merge/goal.ts): the suggested name in the repository's own convention (else <type>/<slug>),
// collisions with the remote's branches, the
// checks a name must pass, where the branch list and default branch come from (GitHub, else git, else local refs),
// and how a run's base is decided: given, the project's target, the remote's default branch, else refused (never main).
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { branchConvention, collides, goalBranchProblem, goalBranchSlug, goalSlug, goalType, isRefSafe, listBranches, resolveGoalBranch, suggestGoalBranch, type GoalType } from "../../src/merge/goal";
import { RelayError } from "../../src/core/errors";

describe("goalSlug: the whole first line", () => {
	test("lowercase ASCII words joined by single hyphens, from the first line", () => {
		expect(goalSlug("Add multiply to src/math.ts")).toBe("add-multiply-to-src-math-ts");
		expect(goalSlug("  Fix   the --- flaky   TEST!!  \nsecond line")).toBe("fix-the-flaky-test");
		expect(goalSlug("\n\nRésumé für Café")).toBe("resume-fur-cafe");
	});
	test("at most 40 characters, cut at a hyphen when it can be", () => {
		const s = goalSlug("Rewrite the authentication middleware so that sessions expire after thirty minutes");
		expect(s.length).toBeLessThanOrEqual(40);
		expect(s).toBe("rewrite-the-authentication-middleware");
		expect(goalSlug("a".repeat(80))).toBe("a".repeat(40));
	});
	test("nothing usable: goal", () => {
		expect(goalSlug("")).toBe("goal");
		expect(goalSlug("🚀 ✨ !!!")).toBe("goal");
	});
});

describe("goalType: the kind of change a goal reads as", () => {
	const cases: Array<[string, GoalType]> = [
		["Add CSV export to the reports page", "feat"],
		["Support SAML login", "feat"],
		["Add error handling to the importer", "feat"],
		["Add an approval workflow for refunds", "feat"],
		["Fix the crash when the config file is missing", "fix"],
		["Login is broken on Safari", "fix"],
		["Checkout throws an error for empty carts", "fix"],
		["Regression: totals are off by one", "fix"],
		["Fix the flaky tests in the parser", "fix"],
		["Update the README with install steps", "docs"],
		["Document the export API", "docs"],
		["Refactor the billing module", "refactor"],
		["Clean up the old feature flags", "refactor"],
		["Rename Workspace to Project everywhere", "refactor"],
		["Write tests for the CSV parser", "test"],
		["Add tests for the crash reporter", "test"],
		["Run the linter in CI", "ci"],
		["Cache bun installs in the GitHub Actions workflow", "ci"],
		["Bump bun to 1.3", "chore"],
		["Upgrade dependencies", "chore"],
		["Make the dashboard load faster", "perf"],
		["Speed up cold start", "perf"],
		["Optimize the search query", "perf"],
	];
	for (const [goal, type] of cases) test(`${goal} → ${type}`, () => expect(goalType(goal)).toBe(type));
	test("only the first line counts", () => expect(goalType("Add a settings page\nand fix the crash on save")).toBe("feat"));
});

describe("goalBranchSlug: short and readable", () => {
	const cases: Array<[string, string]> = [
		["Add CSV export to the reports page", "csv-export-reports-page"],
		["Fix the crash when the config file is missing", "crash-config-file-missing"],
		["Write tests for the CSV parser", "csv-parser"],
		["Make the dashboard load faster", "dashboard-load-faster"],
		["Optimize the search query", "search-query"],
		["Upgrade dependencies", "upgrade-dependencies"],
		["Speed up cold start", "cold-start"],
		["Clean up the old feature flags", "old-feature-flags"],
		["Don't crash when the user's name is empty", "dont-crash-users-name"],
		["Résumé upload für Café", "resume-upload-fur-cafe"],
		["Rewrite the authentication middleware so that sessions expire after thirty minutes", "rewrite-authentication-middleware"],
		// No meaningful word left: the whole line.
		["Fix it", "fix-it"],
		["", ""],
	];
	for (const [goal, slug] of cases) test(`${JSON.stringify(goal)} → ${slug}`, () => expect(goalBranchSlug(goal)).toBe(slug));
	test("at most 4 words and 40 characters, ASCII lowercase with single hyphens", () => {
		const s = goalBranchSlug("Implement incremental synchronisation reconciliation orchestration internationalisation");
		expect(s.length).toBeLessThanOrEqual(40);
		expect(s).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
		expect(goalBranchSlug("one two three four five six seven").split("-").length).toBe(4);
	});
});

describe("branchConvention: learned from the repository's branches", () => {
	test("bots', agents', capcomd's, release and long-lived branches and the default branch teach nothing", () => {
		const noise = ["main", "dev", "trunk", "capcomd/add-x", "capcomd/run-k1/agt-1", "dependabot/npm_and_yarn/foo-1.2", "renovate/all", "gh-readonly-queue/main/pr-1",
			"release/1.2", "copilot/fix-12", "claude/fix-login", "revert-12-feature/x", "integration"];
		expect(branchConvention(noise, ["integration"]).style).toBe("none");
	});
	test("mostly type prefixes: types, in the repository's spelling", () => {
		const c = branchConvention(["feature/a", "feature/b", "bugfix/c", "hotfix/d", "docs/e", "spike"]);
		expect(c).toMatchObject({ style: "types", spelling: { feat: "feature", fix: "bugfix", docs: "docs" } });
		// hotfix only when it's the only spelling of a fix.
		expect(branchConvention(["feat/a", "feat/b", "hotfix/c"]).spelling.fix).toBe("hotfix");
	});
	test("mostly one other first part: that owner, with types after it when they're used", () => {
		expect(branchConvention(["marvin/a", "marvin/b", "marvin/c", "alice/d"])).toMatchObject({ style: "owner", owner: "marvin", ownerTypes: false });
		expect(branchConvention(["marvin/feature/a", "marvin/fix/b", "marvin/feature/c"])).toMatchObject({ style: "owner", owner: "marvin", ownerTypes: true, spelling: { feat: "feature" } });
	});
	test("too few branches, or mixed: none", () => {
		expect(branchConvention(["feature/a", "feature/b"]).style).toBe("none");
		expect(branchConvention(["feature/a", "marvin/b", "alice/c", "x", "y"]).style).toBe("none");
		// …but the spelling still counts.
		expect(branchConvention(["feature/a", "feature/b"]).spelling.feat).toBe("feature");
	});
	test("ticket ids: their case", () => {
		expect(branchConvention(["feature/ENG-1-a", "feature/ENG-2-b", "fix/ENG-3-c"]).tickets).toBe("upper");
		expect(branchConvention(["marvin/eng-1-a", "marvin/eng-2-b", "marvin/eng-3-c"]).tickets).toBe("lower");
		expect(branchConvention(["feature/a", "feature/b", "fix/c"]).tickets).toBeNull();
	});
});

describe("suggestGoalBranch", () => {
	const none = ["main", "dev", "capcomd/old-run", "dependabot/npm_and_yarn/x-1.2"];
	const typed = ["main", "feature/login-page", "feature/billing", "bugfix/null-user", "docs/api", "release/1.2", "renovate/all"];
	const owner = ["main", "marvin/sso", "marvin/csv-import", "marvin/fix-billing", "marvin/onboarding", "alice/old-thing"];
	const cases: Array<[string, string, string, string]> = [
		// goal, none, feature/bugfix, marvin/
		["Add CSV export to the reports page", "feat/csv-export-reports-page", "feature/csv-export-reports-page", "marvin/csv-export-reports-page"],
		["Fix the crash when the config file is missing", "fix/crash-config-file-missing", "bugfix/crash-config-file-missing", "marvin/crash-config-file-missing"],
		["Make the dashboard load faster", "perf/dashboard-load-faster", "perf/dashboard-load-faster", "marvin/dashboard-load-faster"],
		["Update the README with install steps", "docs/readme-install-steps", "docs/readme-install-steps", "marvin/readme-install-steps"],
		["Write tests for the CSV parser", "test/csv-parser", "test/csv-parser", "marvin/csv-parser"],
		["Refactor the billing module", "refactor/billing-module", "refactor/billing-module", "marvin/billing-module"],
		["Upgrade dependencies", "chore/upgrade-dependencies", "chore/upgrade-dependencies", "marvin/upgrade-dependencies"],
		["Run the linter in CI", "ci/run-linter", "ci/run-linter", "marvin/run-linter"],
	];
	for (const [goal, a, b, c] of cases) test(goal, () => {
		expect(suggestGoalBranch(goal, none, { defaultBranch: "main" })).toBe(a);
		expect(suggestGoalBranch(goal, typed, { defaultBranch: "main" })).toBe(b);
		expect(suggestGoalBranch(goal, owner, { defaultBranch: "main" })).toBe(c);
		for (const n of [a, b, c]) expect(isRefSafe(n)).toBe(true);
	});
	test("an owner with types after it", () => {
		expect(suggestGoalBranch("Fix the login crash", ["marvin/feature/a", "marvin/bugfix/b", "marvin/feature/c"])).toBe("marvin/bugfix/login-crash");
	});
	test("a ticket id in the goal leads the slug, in the repository's case; none is made up", () => {
		expect(suggestGoalBranch("ENG-142: let users invite teammates by email", none)).toBe("feat/eng-142-users-invite-teammates-email");
		expect(suggestGoalBranch("Fix ENG-7 login crash", ["feature/ENG-1-a", "bugfix/ENG-2-b", "feature/ENG-3-c"])).toBe("bugfix/ENG-7-login-crash");
		expect(suggestGoalBranch("ENG-9", none)).toBe("feat/eng-9");
		expect(suggestGoalBranch("Add invites", ["feature/ENG-1-a", "bugfix/ENG-2-b", "feature/ENG-3-c"])).toBe("feature/invites");
	});
	test("nothing usable: <type>/goal", () => {
		expect(suggestGoalBranch("🚀 ✨ !!!")).toBe("feat/goal");
	});
	test("never an existing remote branch: -2, -3…", () => {
		expect(suggestGoalBranch("Add x", ["main", "feat/x"])).toBe("feat/x-2");
		expect(suggestGoalBranch("Add x", ["feat/x", "feat/x-2"])).toBe("feat/x-3");
		// git can't hold feat/x next to feat/x/sub (or next to a branch named feat/x/…).
		expect(suggestGoalBranch("Add x", ["feat/x/sub"])).toBe("feat/x-2");
		// Case-insensitive: macOS checkouts can't hold both (and the repository's own spelling, Feat, is kept).
		expect(suggestGoalBranch("Add x", ["Feat/X"])).toBe("Feat/x-2");
	});
	test("a branch named like the prefix blocks everything under it: a flat name", () => {
		expect(suggestGoalBranch("Add x", ["feat"])).toBe("feat-x");
		expect(suggestGoalBranch("Add x", ["marvin", "marvin/a", "marvin/b", "marvin/c"])).toBe("marvin-x");
	});
	test("collides", () => {
		expect(collides("a/b", ["a"])).toBe(true);
		expect(collides("a", ["a/b"])).toBe(true);
		expect(collides("a-b", ["a"])).toBe(false);
	});
	test("instant on a big listing", () => {
		const many = Array.from({ length: 500 }, (_, i) => `feature/thing-${i}`);
		const t = performance.now();
		expect(suggestGoalBranch("Add thing", many)).toBe("feature/thing");
		expect(performance.now() - t).toBeLessThan(50);
	});
});

describe("goalBranchProblem", () => {
	test("a ref-safe name that isn't the base or protected passes", () => {
		expect(goalBranchProblem("capcomd/add-x", { base: "dev", env: {} })).toBeNull();
		expect(goalBranchProblem("feature/Login_2.0", { base: "dev", env: {} })).toBeNull();
	});
	test("not a branch name git takes", () => {
		for (const bad of ["", "-x", ".x", "a..b", "a//b", "a/", "a.", "a b", "a~1", "a^", "a:b", "a?", "a*", "a[b", "a\\b", "a@{1}", "x.lock", "a/.b", "HEAD", "a".repeat(201)])
			expect(goalBranchProblem(bad, { env: {} })).toContain("isn't a branch name");
	});
	test("not the base itself", () => {
		expect(goalBranchProblem("dev", { base: "dev", env: {} })).toContain("can't be the base");
	});
	test("not a protected branch (the default patterns, or CAPCOMD_PROTECTED_BRANCHES)", () => {
		for (const p of ["main", "master", "release/1.2"]) expect(goalBranchProblem(p, { base: "dev", env: {} })).toContain("protected");
		expect(goalBranchProblem("capcomd/x", { base: "dev", env: { CAPCOMD_PROTECTED_BRANCHES: "capcomd/*" } })).toContain("protected");
		expect(goalBranchProblem("main", { base: "dev", env: { CAPCOMD_PROTECTED_BRANCHES: "trunk" } })).toBeNull();
	});
});

describe("listBranches", () => {
	const gh = (routes: Record<string, unknown>, calls: string[] = []) => (async (url: string | URL | Request) => {
		const u = new URL(String(url));
		calls.push(u.pathname + u.search);
		const key = u.pathname + (u.searchParams.get("page") ? `#${u.searchParams.get("page")}` : "");
		return key in routes ? new Response(JSON.stringify(routes[key]), { status: 200 }) : new Response("{}", { status: 404 });
	}) as typeof fetch;

	test("GitHub first, with the user's login: the default branch and every page of branches", async () => {
		const page1 = Array.from({ length: 100 }, (_, i) => ({ name: `b${String(i).padStart(3, "0")}` }));
		const calls: string[] = [];
		const r = await listBranches({ remote: "/nowhere.git", github: "acme/app", cwd: tmpdir() }, {
			github: async () => ({ api: "https://gh.test", token: "t" }),
			fetch: gh({ "/repos/acme/app": { default_branch: "develop" }, "/repos/acme/app/branches#1": page1, "/repos/acme/app/branches#2": [{ name: "develop" }] }, calls),
		});
		expect(r).toMatchObject({ source: "github", defaultBranch: "develop", note: null });
		expect(r.branches.length).toBe(101);
		expect(calls.filter((c) => c.includes("/branches")).length).toBe(2);
	});

	test("no GitHub login: git ls-remote, with the remote's HEAD as the default branch", async () => {
		const bare = await repoWith(["main", "dev", "feature/x"], "dev");
		const r = await listBranches({ remote: bare, github: "acme/app", cwd: tmpdir() }, { github: async () => null });
		expect(r).toMatchObject({ source: "git", defaultBranch: "dev", branches: ["dev", "feature/x", "main"] });
		expect(r.note).toContain("no login");
	});

	test("the remote can't be read: the local refs, saying why; a remote HEAD that points nowhere is no default branch", async () => {
		const r = await listBranches({ remote: "/does/not/exist.git", cwd: tmpdir(), local: () => ({ defaultBranch: null, branches: ["x"] }) }, { github: async () => null, timeoutMs: 5000 });
		expect(r).toMatchObject({ source: "local", defaultBranch: null, branches: ["x"] });
		expect(r.note).toContain("ls-remote failed");
		const dangling = await repoWith(["dev"], "gone");
		expect((await listBranches({ remote: dangling, cwd: tmpdir() })).defaultBranch).toBeNull();
	});
});

describe("resolveGoalBranch: the run's base and goal branch", () => {
	test("base: given, else the project's target, else the remote's default branch", async () => {
		const bare = await repoWith(["main", "dev", "feat/x"], "main");
		const o = { goal: "Add x", remote: bare, cwd: tmpdir(), env: {} };
		expect(await resolveGoalBranch({ ...o, base: "dev", projectTarget: "main" })).toMatchObject({ base: "dev", baseSource: "given", goalBranch: "feat/x-2" });
		expect(await resolveGoalBranch({ ...o, projectTarget: "dev" })).toMatchObject({ base: "dev", baseSource: "project" });
		expect(await resolveGoalBranch(o)).toMatchObject({ base: "main", baseSource: "remote" });
	});

	test("unknown base: refused with reason base, never main", async () => {
		const bare = await repoWith(["main", "dev"], "nothing");
		const err = await resolveGoalBranch({ goal: "Add x", remote: bare, cwd: tmpdir(), env: {} }).catch((e) => e);
		expect(err).toBeInstanceOf(RelayError);
		expect(err).toMatchObject({ code: "usage", reason: "base" });
		expect(err.message).toContain("can't tell which branch");
		// No remote at all, nothing configured: the same.
		expect(await resolveGoalBranch({ goal: "x", remote: null, cwd: tmpdir() }).catch((e) => e.reason)).toBe("base");
	});

	test("a base the remote doesn't have, or a goal branch that's taken or not allowed: refused with the field", async () => {
		const bare = await repoWith(["main", "dev", "capcomd/taken"], "main");
		const o = { goal: "Add x", remote: bare, cwd: tmpdir(), env: {} };
		expect(await resolveGoalBranch({ ...o, base: "nope" }).catch((e) => [e.code, e.reason])).toEqual(["not_found", "base"]);
		expect(await resolveGoalBranch({ ...o, base: "dev", goalBranch: "capcomd/taken" }).catch((e) => [e.code, e.reason])).toEqual(["conflict", "goalBranch"]);
		expect(await resolveGoalBranch({ ...o, base: "dev", goalBranch: "main" }).catch((e) => e.message)).toContain("protected");
		expect(await resolveGoalBranch({ ...o, base: "dev", goalBranch: "dev" }).catch((e) => e.message)).toContain("can't be the base");
		// The run that made it (a resume) may name it.
		expect(await resolveGoalBranch({ ...o, base: "dev", goalBranch: "capcomd/taken", reuse: "capcomd/taken" })).toMatchObject({ goalBranch: "capcomd/taken" });
	});
});

/** A bare repository with these branches (one commit) and HEAD → refs/heads/<head>. */
async function repoWith(branches: string[], head: string): Promise<string> {
	const root = mkdtempSync(join(tmpdir(), "goal-branch-"));
	const bare = join(root, "o.git"), seed = join(root, "s");
	const git = (args: string[], cwd: string) => { const r = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }); if (r.exitCode !== 0) throw new Error(r.stderr.toString()); };
	git(["init", "-q", "--bare", bare], root);
	git(["init", "-q", "-b", "seed", seed], root);
	git(["commit", "-q", "--allow-empty", "-m", "seed"], seed);
	for (const b of branches) git(["push", "-q", bare, `HEAD:refs/heads/${b}`], seed);
	git(["symbolic-ref", "HEAD", `refs/heads/${head}`], bare);
	return bare;
}

describe("a stopped goal: ask before a pull request", () => {
	const planner = (status: string) => ({ parent: null, contract: null, status }) as any;
	const work = { landed: [{}], notLanded: [{}, {}] };
	test("the question says how the planner stopped and how much landed; none for any other state", async () => {
		const { stoppedQuestion } = await import("../../src/primitives/goal");
		expect(stoppedQuestion("stopped", "capcomd/add-x", [planner("failed")], work))
			.toBe("The planner stopped before it finished (it failed): 1 of 3 tasks landed on capcomd/add-x. Open a pull request with what landed?");
		expect(stoppedQuestion("stopped", "capcomd/add-x", [planner("cancelled")], { landed: [{}], notLanded: [] })).toContain("(it was cancelled): 1 of 1 task landed");
		for (const s of ["working", "ready", "pr_opened", "kept"] as const) expect(stoppedQuestion(s, "capcomd/add-x", [planner("done")], work)).toBeNull();
	});
	test("the pull request's description says so first", async () => {
		const { pullRequestBody } = await import("../../src/primitives/goal");
		const l = { agentId: "agt-w", parent: "agt-p", profile: "worker", task: "write x", branch: null, mergeId: "mrg-1", sha: null, verifyId: null, mergedBy: null, checks: null, review: null };
		const n = { agentId: "agt-v", parent: "agt-p", profile: "worker", task: "write y", branch: null, status: "failed", reason: "failed" as const, detail: null };
		const body = pullRequestBody({ runId: "run-g", branch: "capcomd/add-x", summary: "Added x.", landed: [l], notLanded: [n], stopped: "the planner failed" });
		expect(body.split("\n")[0]).toBe("> **The run stopped before the planner finished:** the planner failed. 1 of 2 tasks landed; what didn't is listed below.");
		expect(body.indexOf("Added x.")).toBeGreaterThan(0);
		expect(pullRequestBody({ runId: "run-g", branch: "capcomd/add-x", summary: "Added x.", landed: [l], notLanded: [] }).startsWith("Added x.")).toBe(true);
	});
});

describe("what landed: continued work and titles", () => {
	const goal = { branch: "capcomd/add-helpers" };
	const agent = (id: string, o: Record<string, unknown> = {}) => ({ agentId: id, parent: "agt-p", profile: "worker", status: "done", task: `task of ${id}`,
		contract: null, result: { branch: `b-${id}`, commit: "c0ffee" }, titleState: null, ...o }) as any;
	const planner = agent("agt-p", { parent: null, profile: "planner" });
	let t = 0;
	const op = (kind: "verify" | "merge", agentId: string, state: string, result: Record<string, unknown> = {}) =>
		({ id: `${kind}-${agentId}-${++t}`, kind, state, updatedAt: t, data: { agentId, target: goal.branch, branch: `b-${agentId}` }, result }) as any;

	test("a child whose merge conflicted and was continued isn't listed: its continuation is, and says so", async () => {
		const { landedOf } = await import("../../src/primitives/goal");
		const agents = [planner, agent("agt-clamp"), agent("agt-sign"), agent("agt-fix", { contract: { from: { agentId: "agt-sign", ref: "refs/heads/b-agt-sign" } } })];
		const ops = [op("verify", "agt-clamp", "passed"), op("merge", "agt-clamp", "merged"), op("verify", "agt-sign", "passed"),
			op("merge", "agt-sign", "failed", { status: "conflict" }), op("verify", "agt-fix", "passed"), op("merge", "agt-fix", "merged")];
		const { landed, notLanded } = landedOf(goal, agents, ops);
		expect(landed.map((l) => [l.agentId, l.continues])).toEqual([["agt-clamp", []], ["agt-fix", ["agt-sign"]]]);
		expect(notLanded).toEqual([]);
	});

	test("a continuation that didn't land either is listed once, with the chain it carries", async () => {
		const { landedOf } = await import("../../src/primitives/goal");
		const agents = [planner, agent("agt-a"), agent("agt-b", { contract: { from: { agentId: "agt-a" } } }),
			agent("agt-c", { status: "failed", result: { error: "usage limit" }, contract: { from: { agentId: "agt-b" } } })];
		const { landed, notLanded } = landedOf(goal, agents, [op("merge", "agt-a", "failed", { status: "conflict" })]);
		expect(landed).toEqual([]);
		expect(notLanded.map((n) => [n.agentId, n.reason, n.continues])).toEqual([["agt-c", "failed", ["agt-b", "agt-a"]]]);
	});

	test("work is labelled by its title in the pull request, with the task as the fallback", async () => {
		const { landedOf, pullRequestBody } = await import("../../src/primitives/goal");
		const agents = [planner, agent("agt-clamp", { titleState: { agent: { title: "clamp helper", by: "self", setBy: "agt-clamp", at: 1 } } }),
			agent("agt-sign", { task: "" }), agent("agt-fix", { contract: { from: { agentId: "agt-sign" } }, task: "Merge the goal branch into the sign work" })];
		const ops = [op("merge", "agt-clamp", "merged"), op("merge", "agt-fix", "merged")];
		const { landed, notLanded } = landedOf(goal, agents, ops);
		expect(landed.map((l) => l.title)).toEqual(["clamp helper", "merge goal branch"]);
		const body = pullRequestBody({ runId: "run-g", branch: goal.branch, summary: null, landed, notLanded });
		expect(body).toContain("- clamp helper (agt-clamp, worker): no checks recorded, no reviewer");
		expect(body).toContain("(agt-fix, worker, carries on agt-sign's work)");
		expect(body).not.toContain("Not landed");
	});
});
