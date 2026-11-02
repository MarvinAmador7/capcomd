// Goal branch names (src/merge/goal.ts): the suggested capcomd/<slug>, collisions with the remote's branches, the
// checks a name must pass, where the branch list and default branch come from (GitHub, else git, else local refs),
// and how a run's base is decided: given, the project's target, the remote's default branch, else refused (never main).
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collides, goalBranchProblem, goalSlug, isRefSafe, listBranches, resolveGoalBranch, suggestGoalBranch } from "../../src/merge/goal";
import { RelayError } from "../../src/core/errors";

describe("goalSlug", () => {
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

describe("suggestGoalBranch", () => {
	test("capcomd/<slug>, ref-safe", () => {
		const b = suggestGoalBranch("Add dark mode to the settings window");
		expect(b).toBe("capcomd/add-dark-mode-to-the-settings-window");
		expect(isRefSafe(b)).toBe(true);
	});
	test("never an existing remote branch: -2, -3…", () => {
		expect(suggestGoalBranch("Add x", ["main", "capcomd/add-x"])).toBe("capcomd/add-x-2");
		expect(suggestGoalBranch("Add x", ["capcomd/add-x", "capcomd/add-x-2"])).toBe("capcomd/add-x-3");
		// git can't hold capcomd/add-x next to capcomd/add-x/sub (or next to a branch named capcomd/add-x/…).
		expect(suggestGoalBranch("Add x", ["capcomd/add-x/sub"])).toBe("capcomd/add-x-2");
		// Case-insensitive: macOS checkouts can't hold both.
		expect(suggestGoalBranch("Add x", ["Capcomd/Add-X"])).toBe("capcomd/add-x-2");
	});
	test("a branch named capcomd blocks the whole prefix: a flat name", () => {
		expect(suggestGoalBranch("Add x", ["capcomd"])).toBe("capcomd-add-x");
	});
	test("collides", () => {
		expect(collides("a/b", ["a"])).toBe(true);
		expect(collides("a", ["a/b"])).toBe(true);
		expect(collides("a-b", ["a"])).toBe(false);
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
		const bare = await repoWith(["main", "dev", "capcomd/add-x"], "main");
		const o = { goal: "Add x", remote: bare, cwd: tmpdir(), env: {} };
		expect(await resolveGoalBranch({ ...o, base: "dev", projectTarget: "main" })).toMatchObject({ base: "dev", baseSource: "given", goalBranch: "capcomd/add-x-2" });
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
