// Capability runs.goal_branch on the harness API: POST /v1/runs `base` and `goalBranch`, Run.goalBranch, GET
// /v1/projects/branches, GET /v1/runs/{runId}/goal, POST …/pull-request and …/keep-branch, and the run.goal_completed /
// run.pr_opened / run.branch_kept events. Engine-free (memory source); the engine-backed flow is
// tests/scenarios/goal-branch.test.ts.
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { addClient, loadClients } from "../../src/api/clients";
import { CAPABILITY_NAMES, GoalPullRequestResult, GoalView, ProjectBranches, Run } from "../../src/api/contract";
import { startDetachedRun } from "../../src/api/create-run";
import { lifecycleEvents } from "../../src/api/lifecycle";
import { strictEventData } from "../../src/api/legacy-events";
import { harnessApp } from "../../src/api/server";
import { CreateRunError, memorySource, type RawEvent } from "../../src/api/source";
import { harnessState } from "../../src/api/state";

const dir = mkdtempSync(join(tmpdir(), "harness-goal-"));
const cpath = join(dir, "clients.json");
const reader = addClient("reader", ["read"], cpath).token;
const approver = addClient("ive", ["read", "approve"], cpath).token;
const steer = addClient("menubar", ["read", "steer"], cpath).token;

const at = 1792900500000;
const view = (o: Partial<ReturnType<typeof GoalView.parse>> = {}) => GoalView.parse({
	runId: "run-g", branch: "capcomd/add-x", base: "dev", state: "ready", goal: "Add x", readyAt: "2026-11-01T10:00:00.000Z", plannerId: "agt-p",
	summary: "Added x.", compare: { baseSha: "a".repeat(40), headSha: "b".repeat(40), ahead: 2, behind: 0, commits: [{ sha: "b".repeat(40), subject: "Add x", at: null }], commitsTotal: 2,
		files: [{ path: "src/x.ts", oldPath: null, status: "added", added: 3, removed: 0 }], filesTotal: 1, added: 3, removed: 0, error: null },
	landed: [{ agentId: "agt-w", parent: "agt-p", profile: "worker", task: "write x", branch: "capcomd/run-g/agt-w", mergeId: "mrg-1", sha: "c".repeat(40), verifyId: "vfy-1", mergedBy: "agt-p", checks: { passed: true }, review: { passed: true, agentId: "agt-r", reasons: ["ok"] } }],
	notLanded: [{ agentId: "agt-v", parent: "agt-p", profile: "worker", task: "write y", branch: null, status: "failed", reason: "failed", detail: "boom" }],
	pullRequest: null, openPullRequest: { available: true, reason: null, repo: "acme/app" }, decision: null, ...o,
});

function setup(goal = view()) {
	const events: RawEvent[] = [
		{ seq: 1, at, type: "RUN_NEW", agentId: null, data: { budget: {}, label: "Add x", goal: "Add x" } },
		{ seq: 2, at: at + 1, type: "AGENT_SPAWNED", agentId: "agt-p", data: { parent: null, depth: 0, profile: "planner", task: "t", key: "planner", operator: true, budget: {}, limits: {}, agent: null } },
		{ seq: 3, at: at + 2, type: "AGENT_STARTED", agentId: "agt-p", data: {} },
		{ seq: 4, at: at + 3, type: "AGENT_DONE", agentId: "agt-p", data: { result: { summary: "Added x." }, spent: {}, budget: {} } },
		{ seq: 5, at: at + 3, type: "RUN_GOAL_COMPLETED", agentId: "agt-p", data: { branch: goal.branch, base: goal.base, plannerId: "agt-p" } },
	];
	const run = { id: "run-g", projectId: null, label: "Add x", state: "idle", goal: "Add x", repo: "/r", createdAt: "2026-11-01T09:00:00.000Z" };
	const plain = { id: "run-plain", projectId: null, label: "old", state: "idle", goal: null, repo: "/r", createdAt: "2026-11-01T09:00:00.000Z" };
	const src = memorySource({ runs: [run, plain], events: { "run-g": events }, goals: { "run-g": goal } });
	const app = harnessApp({ source: src, clients: () => loadClients(cpath), pollMs: 20, state: harnessState(null) });
	const post = async (p: string, token = steer, key: string | null = `k-${Math.random()}`, body?: unknown) => {
		const r = await app.request(p, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
		return { status: r.status, body: (await r.json()) as any };
	};
	const get = async (p: string) => { const r = await app.request(p, { headers: { authorization: `Bearer ${reader}` } }); return { status: r.status, body: (await r.json()) as any }; };
	return { src, post, get };
}

describe("capability runs.goal_branch", () => {
	test("health lists it", () => { expect(CAPABILITY_NAMES).toContain("runs.goal_branch"); });

	test("Run.goalBranch: the branch, base, state and pull request; null for a run without one", async () => {
		const { get } = setup();
		const runs = (await get("/v1/runs")).body as any[];
		for (const r of runs) Run.parse(r);
		expect(runs.find((r) => r.id === "run-g").goalBranch).toEqual({ branch: "capcomd/add-x", base: "dev", state: "ready", readyAt: "2026-11-01T10:00:00.000Z", pullRequest: null });
		expect(runs.find((r) => r.id === "run-plain").goalBranch ?? null).toBeNull();
	});

	test("GET /v1/runs/{runId}/goal: the presentation; 404 for a run without a goal branch", async () => {
		const { get } = setup();
		const r = await get("/v1/runs/run-g/goal");
		expect(r.status).toBe(200);
		expect(GoalView.parse(r.body)).toEqual(r.body);
		expect(r.body).toMatchObject({ state: "ready", summary: "Added x.", landed: [{ agentId: "agt-w", review: { passed: true } }], notLanded: [{ reason: "failed" }] });
		expect((await get("/v1/runs/run-plain/goal")).status).toBe(404);
		expect((await get("/v1/runs/run-none/goal")).body.code).toBe("not_found");
	});

	test("POST …/pull-request: the steer scope and an Idempotency-Key; opens one, then returns it; run.pr_opened once", async () => {
		const { post, get } = setup();
		expect((await post("/v1/runs/run-g/pull-request", reader)).status).toBe(403);
		expect((await post("/v1/runs/run-g/pull-request", approver)).status).toBe(403);
		expect((await post("/v1/runs/run-g/pull-request", steer, null)).status).toBe(422);
		const a = await post("/v1/runs/run-g/pull-request", steer, "pr-key-0001");
		expect(a.status).toBe(200);
		expect(GoalPullRequestResult.parse(a.body)).toEqual(a.body);
		expect(a.body).toMatchObject({ created: true, branch: "capcomd/add-x", base: "dev", pullRequest: { number: 1, url: "https://github.com/acme/app/pull/1", state: "open" } });
		// A replay answers the first result; a new key returns the same pull request.
		expect((await post("/v1/runs/run-g/pull-request", steer, "pr-key-0001")).body).toEqual(a.body);
		expect((await post("/v1/runs/run-g/pull-request", steer, "pr-key-0002")).body).toMatchObject({ created: false, pullRequest: { number: 1 } });
		const evs = (await get("/v1/events?scope=run-g")).body as any[];
		const opened = evs.filter((e) => e.type === "run.pr_opened");
		expect(opened.length).toBe(1);
		expect(opened[0]).toMatchObject({ text: "Pull request #1 opened from capcomd/add-x into dev.", data: { number: 1, base: "dev", by: expect.stringMatching(/^client:/) } });
		const run = ((await get("/v1/runs")).body as any[]).find((r) => r.id === "run-g");
		expect(run.goalBranch).toMatchObject({ state: "pr_opened", pullRequest: { number: 1 } });
		// Keeping it now is refused.
		const keep = await post("/v1/runs/run-g/keep-branch");
		expect(keep).toMatchObject({ status: 409, body: { code: "conflict" } });
	});

	test("POST …/pull-request is refused with the reason: while the planner works, without GitHub; 404 without a goal branch", async () => {
		expect(await setup(view({ state: "working" })).post("/v1/runs/run-g/pull-request")).toMatchObject({ status: 409, body: { code: "conflict", message: expect.stringContaining("still working") } });
		const why = "The repository (/srv/app.git) isn't on GitHub, so capcomd can't open a pull request. The work is on capcomd/add-x: open one or merge it with your own tools.";
		const noGh = setup(view({ openPullRequest: { available: false, reason: why, repo: null } }));
		expect(await noGh.post("/v1/runs/run-g/pull-request")).toMatchObject({ status: 409, body: { code: "conflict", message: why } });
		expect((await setup().post("/v1/runs/run-plain/pull-request")).status).toBe(404);
	});

	test("POST …/keep-branch: recorded once (run.branch_kept); a pull request can still be opened after", async () => {
		const { post, get } = setup();
		expect(await post("/v1/runs/run-g/keep-branch")).toMatchObject({ status: 200, body: { kept: true, changed: true, branch: "capcomd/add-x" } });
		expect(await post("/v1/runs/run-g/keep-branch")).toMatchObject({ status: 200, body: { changed: false } });
		expect(((await get("/v1/runs")).body as any[]).find((r) => r.id === "run-g").goalBranch.state).toBe("kept");
		expect(((await get("/v1/events?scope=run-g")).body as any[]).filter((e) => e.type === "run.branch_kept").length).toBe(1);
		expect((await post("/v1/runs/run-g/pull-request")).body).toMatchObject({ created: true });
	});

	test("the events: strict payloads, daemon-written text, and on the lifecycle feed with a cause", () => {
		expect(strictEventData("run.goal_completed", { branch: "capcomd/x", base: "dev", plannerId: "agt-p" })).toEqual({ ok: true });
		expect(strictEventData("run.pr_opened", { branch: "capcomd/x", base: "dev", number: 3, url: null, by: "operator" })).toEqual({ ok: true });
		expect(strictEventData("run.branch_kept", { branch: "capcomd/x", base: "dev", by: "operator" })).toEqual({ ok: true });
		expect(strictEventData("run.goal_completed", { branch: "capcomd/x", base: "dev", plannerId: "agt-p", extra: 1 }).ok).toBe(false);
		const evs: RawEvent[] = [
			{ seq: 1, at, type: "RUN_NEW", agentId: null, data: { budget: {}, label: null } },
			{ seq: 2, at, type: "AGENT_SPAWNED", agentId: "agt-p", data: { parent: null, depth: 0, profile: "planner", task: "t", key: null, operator: true, budget: {}, limits: {}, agent: null } },
			{ seq: 3, at, type: "AGENT_STARTED", agentId: "agt-p", data: {} },
			{ seq: 4, at, type: "AGENT_DONE", agentId: "agt-p", data: { result: {}, spent: {}, budget: {} } },
			{ seq: 5, at, type: "RUN_GOAL_COMPLETED", agentId: "agt-p", data: { branch: "capcomd/x", base: "dev", plannerId: "agt-p" } },
			{ seq: 6, at, type: "RUN_PR_OPENED", agentId: null, data: { branch: "capcomd/x", base: "dev", number: 3, url: null, by: "operator" } },
		];
		const lc = lifecycleEvents("run-1", evs);
		expect(lc.map((e) => e.type)).toEqual(["run.created", "agent.spawned", "agent.started", "run.started", "agent.done", "run.completed", "run.goal_completed", "run.pr_opened"]);
		expect(lc.find((e) => e.type === "run.goal_completed")).toMatchObject({ seq: 5, data: { cause: "planner_done" }, text: "The work is ready on capcomd/x: open a pull request into dev, or keep the branch." });
		expect(lc.find((e) => e.type === "run.pr_opened")!.data.cause).toBe("pull_request_opened");
	});
});

describe("POST /v1/runs: base and goalBranch", () => {
	const create = () => {
		const src = memorySource();
		const app = harnessApp({ source: src, clients: () => loadClients(cpath), state: harnessState(null) });
		const post = async (body: unknown, key = `key-${Math.random()}`) => { const r = await app.request("/v1/runs", { method: "POST", headers: { authorization: `Bearer ${steer}`, "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify(body) }); return { status: r.status, body: (await r.json()) as any }; };
		return { src, post };
	};
	test("passed to the run as given; false turns the goal branch off", async () => {
		const { src, post } = create();
		expect((await post({ goal: "Add x", base: "dev", goalBranch: "capcomd/add-x" })).status).toBe(201);
		expect((await post({ goal: "Add y", goalBranch: false })).status).toBe(201);
		expect(src.created).toEqual([{ goal: "Add x", base: "dev", goalBranch: "capcomd/add-x" }, { goal: "Add y", goalBranch: false }]);
	});
	test("a name that isn't a branch is 422 with the field", async () => {
		const { post } = create();
		expect(await post({ goal: "x", goalBranch: "a..b" })).toMatchObject({ status: 422, body: { code: "invalid", field: "goalBranch" } });
		expect(await post({ goal: "x", base: "-x" })).toMatchObject({ status: 422, body: { field: "base" } });
	});
	test("another base or goal branch with the same key is another request", async () => {
		const { post } = create();
		expect((await post({ goal: "x", base: "dev" }, "same-key-01")).status).toBe(201);
		expect((await post({ goal: "x", base: "develop" }, "same-key-01")).body.code).toBe("idempotency_conflict");
	});
	test("they become capcomd run flags; a refusal about the base or goal branch names its field", async () => {
		const calls: string[][] = [];
		const spawnWith = (reply: Record<string, unknown>) => ((_c: string, args: string[]) => {
			calls.push(args);
			const child: any = new EventEmitter();
			child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
			setTimeout(() => { child.stdout.write(JSON.stringify(reply.ok ? { ...reply, runId: args[args.indexOf("--run-id") + 1] } : reply) + "\n"); child.stdout.end(); child.stderr.end(); child.emit("exit", reply.ok ? 0 : 2); }, 5);
			return child;
		}) as any;
		const env = { CAPCOMD_REPO: "/r", CAPCOMD_NO_CONFIG: "1" };
		await startDetachedRun({ goal: "go", runId: "run-b1", base: "dev", goalBranch: "capcomd/go" }, { env, cwd: dir, spawn: spawnWith({ ok: true, log: null }) });
		expect(calls[0]).toEqual(expect.arrayContaining(["--base=dev", "--goal-branch=capcomd/go"]));
		await startDetachedRun({ goal: "go", runId: "run-b2", goalBranch: false }, { env, cwd: dir, spawn: spawnWith({ ok: true, log: null }) });
		expect(calls[1]).toContain("--no-goal-branch");
		const refused = await startDetachedRun({ goal: "go", runId: "run-b3" }, { env, cwd: dir, spawn: spawnWith({ ok: false, error: { code: "usage", message: "can't tell which branch this run starts from", hint: "Pick the base branch (e.g. --base dev).", reason: "base" } }) }).catch((e) => e);
		expect(refused).toBeInstanceOf(CreateRunError);
		expect(refused).toMatchObject({ field: "base" });
		expect(refused.message).toContain("can't tell which branch");
	});
});

describe("GET /v1/projects/branches", () => {
	const git = (args: string[], cwd: string) => { const r = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }); if (r.exitCode !== 0) throw new Error(r.stderr.toString()); return r.stdout.toString().trim(); };
	/** A checkout whose origin has main, dev and capcomd/add-x; origin/HEAD unknown unless `head`. */
	const checkout = (o: { head?: string; target?: string } = {}) => {
		const root = mkdtempSync(join(tmpdir(), "harness-branches-"));
		const bare = join(root, "o.git"), co = join(root, "app");
		git(["init", "-q", "--bare", bare], root);
		git(["init", "-q", "-b", "main", co], root);
		git(["commit", "-q", "--allow-empty", "-m", "seed"], co);
		git(["remote", "add", "origin", "https://github.com/acme/app.git"], co);
		git(["remote", "set-url", "--push", "origin", bare], co);
		for (const b of ["main", "dev", "capcomd/add-x"]) git(["update-ref", `refs/remotes/origin/${b}`, "HEAD"], co);
		if (o.head) git(["symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${o.head}`], co);
		if (o.target) { mkdirSync(join(co, ".capcomd")); writeFileSync(join(co, ".capcomd", "config.json"), JSON.stringify({ env: { CAPCOMD_REPO: "https://github.com/acme/app.git", CAPCOMD_MERGE_TARGET: o.target } })); }
		return co;
	};
	const app = (listBranches?: Parameters<typeof memorySource>[0]["listBranches"]) => {
		const a = harnessApp({ source: memorySource({ ...(listBranches ? { listBranches } : {}), projects: { env: { HOME: dir, CAPCOMD_HOME: join(dir, ".capcomd") } } }), clients: () => loadClients(cpath), state: harnessState(null) });
		return async (q: Record<string, string>) => { const r = await a.request(`/v1/projects/branches?${new URLSearchParams(q)}`, { headers: { authorization: `Bearer ${reader}` } }); return { status: r.status, body: (await r.json()) as any }; };
	};

	test("the base menu, the suggested goal branch (never an existing one), and no guessed default branch", async () => {
		const get = app();
		const co = checkout();
		const r = await get({ path: co, goal: "Add x" });
		expect(r.status).toBe(200);
		expect(ProjectBranches.parse(r.body)).toEqual(r.body);
		expect(r.body).toMatchObject({ root: expect.any(String), github: "acme/app", source: "local", defaultBranch: null, suggestedBase: null, projectTarget: null,
			branches: ["capcomd/add-x", "dev", "main"], suggestedGoalBranch: "capcomd/add-x-2", goalBranchProblem: null, baseProblem: null });
		// origin/HEAD known: that's the default branch and the preselected base.
		expect((await get({ path: checkout({ head: "dev" }) })).body).toMatchObject({ defaultBranch: "dev", suggestedBase: "dev", suggestedGoalBranch: null });
		// The project's target wins as the preselection.
		expect((await get({ path: checkout({ head: "main", target: "dev" }) })).body).toMatchObject({ defaultBranch: "main", projectTarget: "dev", suggestedBase: "dev" });
	});

	test("checks a typed goal branch and base", async () => {
		const get = app(async () => ({ defaultBranch: "main", branches: ["capcomd/add-x", "dev", "main"], source: "github", note: null }));
		const co = checkout();
		expect((await get({ path: co, goalBranch: "capcomd/add-x", base: "dev" })).body.goalBranchProblem).toContain("already exists");
		expect((await get({ path: co, goalBranch: "dev", base: "dev" })).body.goalBranchProblem).toContain("can't be the base");
		expect((await get({ path: co, goalBranch: "main", base: "dev" })).body.goalBranchProblem).toContain("protected");
		expect((await get({ path: co, goalBranch: "bad..name", base: "dev" })).body.goalBranchProblem).toContain("isn't a branch name");
		expect((await get({ path: co, goalBranch: "capcomd/fresh", base: "dev" })).body).toMatchObject({ goalBranchProblem: null, baseProblem: null, suggestedBase: "dev", source: "github" });
		expect((await get({ path: co, base: "nope" })).body.baseProblem).toContain("isn't a branch of acme/app");
	});

	test("not a checkout: 200 with root null; a relative path: 422", async () => {
		const get = app();
		expect((await get({ path: dir, goal: "x" })).body).toMatchObject({ root: null, branches: [], defaultBranch: null, suggestedGoalBranch: "capcomd/x" });
		expect((await get({ path: "rel/path" })).status).toBe(422);
	});
});
