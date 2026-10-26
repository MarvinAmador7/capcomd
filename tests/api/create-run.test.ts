// runs.create (POST /v1/runs): scope, validation, idempotency (replay, conflict, concurrency, restart), and where a run
// starts (launchContext). Engine-free; the engine-backed path is tests/scenarios/harness-create-run.test.ts.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addClient, loadClients } from "../../src/api/clients";
import { GOAL_MAX_BYTES, Run } from "../../src/api/contract";
import { launchContext } from "../../src/api/create-run";
import { harnessApp } from "../../src/api/server";
import { CreateRunError, memorySource, projectIdOf } from "../../src/api/source";
import { harnessState } from "../../src/api/state";

const dir = mkdtempSync(join(tmpdir(), "harness-cr-"));
const cpath = join(dir, "clients.json");
const steer = addClient("menubar", ["read", "steer"], cpath).token;
const steer2 = addClient("tui", ["read", "steer"], cpath).token;
const approver = addClient("ive", ["read", "approve"], cpath).token;

function setup(o: { statePath?: string | null } = {}) {
	const src = memorySource();
	const app = harnessApp({ source: src, clients: () => loadClients(cpath), state: harnessState(o.statePath ?? null) });
	const post = (body: unknown, key: string | null = "key-00000001", token = steer) => app.request("/v1/runs", {
		method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) },
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
	return { src, app, post };
}
const codeOf = async (r: Response) => ((await r.json()) as any).code;

describe("POST /v1/runs", () => {
	test("is in the committed OpenAPI: 201 with a Run, Idempotency-Key required", async () => {
		const spec = (await import("../../openapi/capcomd.json")).default as any;
		const op = spec.paths["/v1/runs"].post;
		expect(op.operationId).toBe("runs.create");
		expect(op.parameters).toContainEqual(expect.objectContaining({ name: "idempotency-key", in: "header", required: true }));
		expect(op.requestBody.content["application/json"].schema.required).toEqual(["goal"]);
		expect(Object.keys(op.responses["201"].content["application/json"].schema.properties)).toEqual(Object.keys(Run.shape));
	});

	test("needs the steer scope", async () => {
		const { post, src } = setup();
		const r = await post({ goal: "fix it" }, "key-00000001", approver);
		expect(r.status).toBe(403);
		expect(await codeOf(r)).toBe("forbidden");
		expect(src.created).toEqual([]);
	});

	test("starts a run and returns it as GET /v1/runs/{runId} does (201, state starting)", async () => {
		const { post, src, app } = setup();
		const r = await post({ goal: "  Fix proration rounding in billing \n", repo: "/work/billing", profile: "worker", targetBranch: "capcomd/integration" });
		expect(r.status).toBe(201);
		expect(r.headers.get("idempotent-replayed")).toBeNull();
		const run = Run.parse(await r.json());
		expect(run).toMatchObject({ state: "starting", goal: "Fix proration rounding in billing", repo: "/work/billing", projectId: projectIdOf("/work/billing") });
		expect(src.created).toEqual([{ goal: "Fix proration rounding in billing", repo: "/work/billing", profile: "worker", targetBranch: "capcomd/integration" }]);
		const got = await app.request(`/v1/runs/${run.id}`, { headers: { authorization: `Bearer ${steer}` } });
		expect(((await got.json()) as any).id).toBe(run.id);
	});

	test("Idempotency-Key: same key + body replays without a second run; a different body is 409; keys are per client", async () => {
		const { post, src } = setup();
		const a = await post({ goal: "ship it" }, "key-replay01");
		expect(a.status).toBe(201);
		const first = (await a.json()) as any;
		const b = await post({ goal: "  ship it " }, "key-replay01"); // same body once trimmed
		expect(b.status).toBe(201);
		expect(b.headers.get("idempotent-replayed")).toBe("true");
		expect(await b.json()).toEqual(first);
		expect(src.created.length).toBe(1);
		const c = await post({ goal: "ship something else" }, "key-replay01");
		expect(c.status).toBe(409);
		expect(await codeOf(c)).toBe("idempotency_conflict");
		const d = await post({ goal: "ship it", targetBranch: "dev" }, "key-replay01");
		expect(d.status).toBe(409);
		// another client's identical key is its own
		const e = await post({ goal: "ship it" }, "key-replay01", steer2);
		expect(e.status).toBe(201);
		expect(((await e.json()) as any).id).not.toBe(first.id);
		expect(src.created.length).toBe(2);
	});

	test("concurrent requests with one key start one run; both get it", async () => {
		const { post, src } = setup();
		const create = src.createRun;
		src.createRun = async (i) => { await new Promise((r) => setTimeout(r, 40)); return create(i); };
		const [a, b] = await Promise.all([post({ goal: "once" }, "key-concur01"), post({ goal: "once" }, "key-concur01")]);
		expect([a.status, b.status]).toEqual([201, 201]);
		expect(await a.json()).toEqual(await b.json());
		expect(src.created.length).toBe(1);
		const [c, d] = await Promise.all([post({ goal: "twice" }, "key-concur02"), post({ goal: "other" }, "key-concur02")]);
		expect([c.status, d.status].sort()).toEqual([201, 409]);
	});

	test("a replay survives a daemon restart", async () => {
		const statePath = join(mkdtempSync(join(tmpdir(), "harness-cr-state-")), "harness-state.json");
		const one = setup({ statePath });
		const first = await (await one.post({ goal: "durable" }, "key-restart1")).json();
		const two = setup({ statePath });
		const again = await two.post({ goal: "durable" }, "key-restart1");
		expect(again.status).toBe(201);
		expect(await again.json()).toEqual(first);
		expect(two.src.created).toEqual([]);
		expect((await two.post({ goal: "not durable" }, "key-restart1")).status).toBe(409);
	});

	test("a refused run is 422 with the reason and is not recorded: the same key can retry", async () => {
		const { post, src } = setup();
		const create = src.createRun;
		let refuse = true;
		src.createRun = async (i) => { if (refuse) throw new CreateRunError("unknown agent profile nope"); return create(i); };
		const a = await post({ goal: "go", profile: "nope" }, "key-retry001");
		expect(a.status).toBe(422);
		expect(await a.json()).toEqual({ code: "invalid", message: "unknown agent profile nope" });
		refuse = false;
		const b = await post({ goal: "go", profile: "nope" }, "key-retry001");
		expect(b.status).toBe(201);
		expect(b.headers.get("idempotent-replayed")).toBeNull();
	});

	test("a daemon fault is 500 internal", async () => {
		const { post, src } = setup();
		src.createRun = async () => { throw new Error("engine went away"); };
		const r = await post({ goal: "go" });
		expect(r.status).toBe(500);
		expect(await r.json()).toEqual({ code: "internal", message: "engine went away" });
	});

	test("validation: 422 invalid with a message naming the field", async () => {
		const { post, src } = setup();
		const bad: Array<[unknown, string]> = [
			[{}, "goal"],
			[{ goal: "" }, "goal"],
			[{ goal: "   \n " }, "goal is empty"],
			[{ goal: "x".repeat(GOAL_MAX_BYTES + 1) }, `longer than ${GOAL_MAX_BYTES} bytes`],
			[{ goal: "é".repeat(GOAL_MAX_BYTES / 2 + 1) }, "bytes"], // fits in characters, not in UTF-8 bytes
			[{ goal: "a\u0000b" }, "NUL"],
			[{ goal: "[agent:worker] do it" }, "profile"],
			[{ goal: 42 }, "goal"],
			[{ goal: "go", repo: "relative/dir" }, "absolute"],
			[{ goal: "go", profile: "Bad Profile" }, "profile"],
			[{ goal: "go", targetBranch: "-x" }, "targetBranch"],
			[{ goal: "go", targetBranch: "a..b" }, "targetBranch"],
			["not json", "goal"],
		];
		for (const [body, msg] of bad) {
			const r = await post(body);
			const j = (await r.json()) as any;
			expect({ body, status: r.status, code: j.code }).toEqual({ body, status: 422, code: "invalid" });
			expect(j.message).toContain(msg);
		}
		expect((await post({ goal: "go" }, null)).status).toBe(422);
		expect((await post({ goal: "go" }, "short")).status).toBe(422);
		expect(src.created).toEqual([]);
		// the longest allowed goal is fine
		expect((await post({ goal: "x".repeat(GOAL_MAX_BYTES) }, "key-longest1")).status).toBe(201);
	});
});

describe("launchContext: where a run starts", () => {
	const project = (env: Record<string, string>, extra: Record<string, unknown> = {}) => {
		const d = mkdtempSync(join(tmpdir(), "harness-cr-prj-"));
		mkdirSync(join(d, ".capcomd"));
		writeFileSync(join(d, ".capcomd", "config.json"), JSON.stringify({ env, ...extra }));
		return d;
	};
	const home = mkdtempSync(join(tmpdir(), "harness-cr-home-"));

	test("no repo: the daemon's own settings, when they name a repository; else 422", () => {
		const ctx = launchContext(undefined, { CAPCOMD_REPO: "git@github.com:o/r.git", CAPCOMD_HOME: home }, "/daemon/cwd");
		expect(ctx).toMatchObject({ cwd: "/daemon/cwd", repo: "git@github.com:o/r.git" });
		expect(() => launchContext(undefined, { CAPCOMD_HOME: home })).toThrow(CreateRunError);
		expect(() => launchContext(undefined, { CAPCOMD_HOME: home })).toThrow(/repo is required/);
	});

	test("repo: a project checkout's settings replace the daemon's; it starts in that directory", () => {
		const d = project({ CAPCOMD_REPO: "https://github.com/o/billing.git", CAPCOMD_MERGE_MODE: "direct" });
		const base = { CAPCOMD_HOME: home, CAPCOMD_NO_CONFIG: "1", CAPCOMD_REPO: "/daemon/repo", CAPCOMD_GITHUB_REPO: "o/other", RELAY_MERGE_TARGET: "old", BOXD_API_KEY: "k" };
		const ctx = launchContext(d, base);
		expect(ctx.cwd).toBe(d);
		expect(ctx.repo).toBe("https://github.com/o/billing.git");
		expect(ctx.env).toMatchObject({ CAPCOMD_REPO: "https://github.com/o/billing.git", CAPCOMD_MERGE_MODE: "direct", BOXD_API_KEY: "k" });
		// none of the daemon's repository settings leak into another project's run
		expect(ctx.env.CAPCOMD_GITHUB_REPO).toBeUndefined();
		expect(ctx.env.RELAY_MERGE_TARGET).toBeUndefined();
		// a subdirectory of the checkout finds the same project
		mkdirSync(join(d, "apps", "tui"), { recursive: true });
		expect(launchContext(join(d, "apps", "tui"), base).repo).toBe("https://github.com/o/billing.git");
	});

	test("repo: with config enabled, the user's settings fill what the project leaves out", () => {
		const h = mkdtempSync(join(tmpdir(), "harness-cr-home2-"));
		writeFileSync(join(h, "config.json"), JSON.stringify({ env: { CAPCOMD_SANDBOX: "docker", CAPCOMD_MERGE_MODE: "pr" } }));
		const d = project({ CAPCOMD_REPO: "/srv/git/app.git", CAPCOMD_MERGE_MODE: "direct" });
		const ctx = launchContext(d, { CAPCOMD_HOME: h });
		expect(ctx.env).toMatchObject({ CAPCOMD_REPO: "/srv/git/app.git", CAPCOMD_MERGE_MODE: "direct", CAPCOMD_SANDBOX: "docker" });
	});

	test("repo that isn't a set-up project checkout: 422 with what to do", () => {
		const base = { CAPCOMD_HOME: home, CAPCOMD_NO_CONFIG: "1", CAPCOMD_REPO: "/daemon/repo" };
		expect(() => launchContext("rel/path", base)).toThrow(/absolute path/);
		expect(() => launchContext(join(home, "missing"), base)).toThrow(/not a directory/);
		const plain = mkdtempSync(join(tmpdir(), "harness-cr-plain-"));
		expect(() => launchContext(plain, base)).toThrow(/capcomd setup project/);
		expect(() => launchContext(project({ CAPCOMD_MERGE_MODE: "direct" }), base)).toThrow(/names no repository/);
	});
});
