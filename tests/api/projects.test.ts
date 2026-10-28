// Capability projects.setup: GET /v1/projects/inspect and POST /v1/projects set a folder up as a capcomd project without
// Terminal. Real folders (local git checkouts cloned from local bare repositories, origin then pointed at a GitHub URL
// that is never contacted), a scratch CAPCOMD_HOME, `gh` stubbed; engine-free (the memory source).
import { beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addClient, loadClients } from "../../src/api/clients";
import { CAPABILITY_NAMES, EventData, ProjectInspect, ProjectSetupResult, RunOptions } from "../../src/api/contract";
import { HarnessEvent } from "../../src/api/envelope";
import { resetDockerCheck, runOptionsFor } from "../../src/api/run-options";
import { harnessApp } from "../../src/api/server";
import { memorySource } from "../../src/api/source";
import { harnessState } from "../../src/api/state";
import { describeEvent } from "../../src/api/describe";
import spec from "../../openapi/capcomd.json";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "harness-projects-")));
const cpath = join(dir, "clients.json");
const configurer = addClient("menubar", ["read", "steer", "approve", "configure"], cpath);
const steerOnly = addClient("old-menubar", ["read", "steer", "approve"], cpath);
const CLI = new URL("../../src/cli/index.ts", import.meta.url).pathname;

const sh = (cmd: string[], cwd: string) => {
	const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME: join(dir, "home"), GIT_CONFIG_NOSYSTEM: "1" } });
	if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${r.stderr.toString()}`);
	return r.stdout.toString().trim();
};
/** A `gh` that says it's logged in (ok) or not; never the real one. */
function fakeGh(ok: boolean): string {
	const bin = mkdtempSync(join(dir, "bin-"));
	writeFileSync(join(bin, "gh"), `#!/bin/sh\nexit ${ok ? 0 : 1}\n`);
	chmodSync(join(bin, "gh"), 0o755);
	return bin;
}
beforeAll(() => {
	mkdirSync(join(dir, "home"), { recursive: true });
	writeFileSync(join(dir, "home", ".gitconfig"), "[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n");
});

/** A checkout cloned from a local bare repo with main and capcomd/staging (so origin/HEAD and the remote branches are
 *  real local refs), with origin then pointed at `origin` (never fetched). */
function checkout(o: { origin?: string | null; packageJson?: boolean } = {}): string {
	const bare = mkdtempSync(join(dir, "bare-"));
	sh(["git", "init", "-q", "--bare", "-b", "main", bare], dir);
	const seed = mkdtempSync(join(dir, "seed-"));
	sh(["git", "clone", "-q", bare, seed], dir);
	if (o.packageJson !== false) { writeFileSync(join(seed, "package.json"), JSON.stringify({ scripts: { test: "bun test" } })); writeFileSync(join(seed, "bun.lock"), ""); }
	else writeFileSync(join(seed, "README.md"), "hi\n");
	sh(["git", "add", "-A"], seed); sh(["git", "commit", "-qm", "init"], seed);
	sh(["git", "push", "-q", "origin", "main"], seed);
	sh(["git", "push", "-q", "origin", "main:capcomd/staging"], seed);
	const co = join(mkdtempSync(join(dir, "co-")), "app");
	sh(["git", "clone", "-q", bare, co], dir);
	mkdirSync(join(co, "src"));
	if (o.origin === null) sh(["git", "remote", "remove", "origin"], co);
	else sh(["git", "remote", "set-url", "origin", o.origin ?? "git@github.com:acme/app.git"], co);
	return realpathSync(co);
}

type Login = { provider: "claude" | "codex"; sandbox: string; loggedIn: boolean; how: "plan" | "api_key" | null; detail: string | null; hostBound: boolean; boundTo: string | null; command: string };
const login = (provider: "claude" | "codex", sandbox: string, how: "plan" | "api_key" | null): Login => ({ provider, sandbox, loggedIn: how !== null, how, detail: null, hostBound: false, boundTo: null, command: `capcomd auth login ${provider} --sandbox ${sandbox}` });
const PLAN = [login("claude", "docker", null), login("claude", "boxd", "plan"), login("codex", "docker", null), login("codex", "boxd", null)];
const APIKEY = [login("claude", "docker", "api_key"), login("claude", "boxd", null), login("codex", "docker", null), login("codex", "boxd", null)];

function world(o: { gh?: boolean; logins?: Login[]; runOptions?: Record<string, string> } = {}) {
	const home = realpathSync(mkdtempSync(join(dir, "user-")));
	const env = { HOME: home, CAPCOMD_HOME: join(home, ".capcomd") };
	const base = o.runOptions;
	const mem = memorySource({ logins: o.logins ?? PLAN, projects: { env, ghReady: async () => o.gh ?? true } });
	const src = base ? { ...mem, runOptions: (repo?: string) => runOptionsFor(repo, { ...base, ...env }, async () => ({ ok: true, reason: null })) } : mem;
	const state = harnessState(null);
	const app = harnessApp({ source: src, clients: () => loadClients(cpath), state });
	const req = async (method: string, p: string, body?: unknown, o2: { token?: string; key?: string | null } = {}) => {
		const headers: Record<string, string> = { authorization: `Bearer ${o2.token ?? configurer.token}`, "content-type": "application/json" };
		if (method === "POST" && o2.key !== null) headers["idempotency-key"] = o2.key ?? `key-${Math.random().toString(36).slice(2)}`;
		const r = await app.request(p, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
		return { status: r.status, body: (await r.json()) as any };
	};
	const inspect = (path: string, token?: string) => req("GET", `/v1/projects/inspect?path=${encodeURIComponent(path)}`, undefined, { token });
	const post = (body: unknown, o2: { token?: string; key?: string | null } = {}) => req("POST", "/v1/projects", body, o2);
	return { app, env, home, state, inspect, post, req };
}
const answers = (path: string, extra: Record<string, unknown> = {}) => ({ path, mode: "direct", target: "main", check: "bun run test", agents: ["claude"], ...extra });
const read = (f: string) => readFileSync(f, "utf8");

describe("GET /v1/projects/inspect", () => {
	test("a GitHub checkout, from a folder inside it: its root, origin, branches, check and agents; nothing written", async () => {
		const co = checkout();
		const { inspect } = world({ gh: true });
		const r = await inspect(join(co, "src"));
		expect(r.status).toBe(200);
		expect(ProjectInspect.parse(r.body)).toEqual(r.body);
		expect(r.body).toEqual({
			path: join(co, "src"), root: co, name: "app", configured: false, values: null,
			repo: "https://github.com/acme/app.git", github: "acme/app", ghReady: true, defaultBranch: "main", branches: ["capcomd/staging", "main"],
			suggestedCheck: "bun run test", suggestedMode: "pr", suggestedAgents: ["claude"],
			agents: [
				{ provider: "claude", label: "Claude Code", loggedIn: true, auth: "subscription", places: [{ sandbox: "docker", loggedIn: false, how: null }, { sandbox: "boxd", loggedIn: true, how: "plan" }] },
				{ provider: "codex", label: "Codex", loggedIn: false, auth: "subscription", places: [{ sandbox: "docker", loggedIn: false, how: null }, { sandbox: "boxd", loggedIn: false, how: null }] },
			],
			budgetAsked: false, problems: [],
		});
		expect(existsSync(join(co, ".capcomd"))).toBe(false);
	});

	test("no gh login: pull requests aren't ready, so direct is suggested", async () => {
		const r = await world({ gh: false }).inspect(checkout());
		expect(r.body).toMatchObject({ ghReady: false, suggestedMode: "direct", problems: [] });
	});

	test("an agent with only an API key: its auth is apikey and a spend cap is asked", async () => {
		const r = await world({ logins: APIKEY }).inspect(checkout());
		expect(r.body.agents[0]).toMatchObject({ provider: "claude", loggedIn: true, auth: "apikey" });
		expect(r.body).toMatchObject({ suggestedAgents: ["claude"], budgetAsked: true });
	});

	test("already configured: its current values", async () => {
		const co = checkout();
		const w = world({ logins: APIKEY });
		expect((await w.post(answers(co, { agents: ["claude", "codex"], target: "capcomd/staging", budgetUsd: 15 }))).status).toBe(200);
		const r = await w.inspect(co);
		expect(r.body).toMatchObject({ configured: true, values: { repo: "https://github.com/acme/app.git", mode: "direct", target: "capcomd/staging", check: "bun run test", agents: ["claude", "codex"], budgetUsd: 15 } });
	});

	test("problems, each with its code and the daemon's sentence", async () => {
		const w = world();
		const plain = mkdtempSync(join(dir, "plain-"));
		expect((await w.inspect(plain)).body).toMatchObject({ root: null, name: null, problems: [{ code: "not_git", message: `${plain} isn't a git checkout. Choose your repository's folder, or clone it first.` }] });
		expect((await w.inspect(join(dir, "nope"))).body.problems).toEqual([{ code: "not_found", message: `${join(dir, "nope")} isn't a folder on this Mac. Choose your repository's folder.` }]);
		expect((await w.inspect(w.home)).body.problems).toEqual([{ code: "home", message: "~ is your home folder, where capcomd keeps its own settings. Choose your repository's folder." }]);
		const none = checkout({ origin: null });
		expect((await w.inspect(none)).body).toMatchObject({ root: none, repo: null, problems: [{ code: "no_origin", message: `${none} has no origin remote, so agents have no repository to push to. Add one (\`git remote add origin <url>\`), or choose another checkout.` }] });
		const lab = checkout({ origin: "git@gitlab.com:acme/app.git" });
		expect((await w.inspect(lab)).body).toMatchObject({ repo: "https://gitlab.com/acme/app.git", github: null, ghReady: false, problems: [{ code: "not_github", message: `${lab}'s origin (https://gitlab.com/acme/app.git) isn't on GitHub. The app sets up GitHub checkouts; set this one up with \`capcomd setup project\` in Terminal.` }] });
	});

	test("a checkout whose .capcomd/config.json is capcomd's own user config (CAPCOMD_HOME's parent) is the home folder", async () => {
		const co = checkout();
		const home = realpathSync(mkdtempSync(join(dir, "u-")));
		const src = memorySource({ projects: { env: { HOME: home, CAPCOMD_HOME: join(co, ".capcomd") } } });
		const app = harnessApp({ source: src, clients: () => loadClients(cpath), state: harnessState(null) });
		const r = await app.request(`/v1/projects/inspect?path=${encodeURIComponent(co)}`, { headers: { authorization: `Bearer ${configurer.token}` } });
		expect(((await r.json()) as any).problems[0].code).toBe("home");
	});

	test("read scope; a relative path is 422; advertised and published", async () => {
		const w = world();
		const readOnly = addClient("reader", ["read"], cpath).token;
		expect((await w.inspect(checkout(), readOnly)).status).toBe(200);
		const rel = await w.req("GET", "/v1/projects/inspect?path=relative/app");
		expect(rel).toMatchObject({ status: 422, body: { code: "invalid" } });
		expect(CAPABILITY_NAMES).toContain("projects.setup");
		expect((await (await w.app.request("/v1/health")).json() as any).capabilities).toContain("projects.setup");
		const paths = (spec as any).paths;
		expect(paths["/v1/projects/inspect"].get.parameters.find((x: any) => x.name === "path")).toMatchObject({ in: "query", required: true });
		expect(Object.keys(paths["/v1/projects"].post.responses)).toEqual(expect.arrayContaining(["200", "403", "409", "422"]));
		expect(paths["/v1/projects"].post.parameters.find((x: any) => x.name === "idempotency-key")).toMatchObject({ in: "header", required: true });
	});
});

describe("POST /v1/projects", () => {
	test("writes the two files the CLI writes for the same answers, byte for byte, and lists the project", async () => {
		const viaCli = checkout(), viaApi = checkout();
		const home = realpathSync(mkdtempSync(join(dir, "cli-")));
		const gh = fakeGh(false);
		const cli = Bun.spawnSync([process.execPath, CLI, "setup", "project", "--yes", "--agents", "claude,codex", "--mode", "direct", "--target", "capcomd/staging", "--check", "bun run test", "--json"],
			{ cwd: viaCli, env: { ...process.env, HOME: home, CAPCOMD_HOME: join(home, ".capcomd"), PATH: `${gh}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe" });
		expect(cli.exitCode).toBe(0);
		const w = world();
		const r = await w.post(answers(viaApi, { agents: ["claude", "codex"], target: "capcomd/staging", expect: { repo: "https://github.com/acme/app.git" } }));
		expect(r.status).toBe(200);
		expect(ProjectSetupResult.parse(r.body)).toEqual(r.body);
		expect(r.body).toEqual({ project: { path: viaApi, root: viaApi, name: "app", configured: true, values: { repo: "https://github.com/acme/app.git", mode: "direct", target: "capcomd/staging", check: "bun run test", agents: ["claude", "codex"], budgetUsd: null } }, changed: true });
		for (const f of ["config.json", "agents.json"]) expect(read(join(viaApi, ".capcomd", f))).toBe(read(join(viaCli, ".capcomd", f)));
		expect(JSON.parse(read(join(viaApi, ".capcomd", "agents.json"))).agents.planner.children.allowedChildProfiles).toEqual(["worker", "codex-worker"]);
		// capcomd's project list (the user config under CAPCOMD_HOME): the first project is the default.
		expect(JSON.parse(read(join(w.env.CAPCOMD_HOME, "config.json"))).projects).toEqual({ list: [{ name: "app", path: viaApi }], default: "app" });
	});

	test("an API-key agent with a spend cap: the same files as `--auth apikey --budget 20`", async () => {
		const viaCli = checkout(), viaApi = checkout();
		const home = realpathSync(mkdtempSync(join(dir, "cli-")));
		const cli = Bun.spawnSync([process.execPath, CLI, "setup", "project", "--yes", "--auth", "apikey", "--budget", "20", "--mode", "direct", "--json"],
			{ cwd: viaCli, env: { ...process.env, HOME: home, CAPCOMD_HOME: join(home, ".capcomd"), PATH: `${fakeGh(false)}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe" });
		expect(cli.exitCode).toBe(0);
		const w = world({ logins: APIKEY });
		expect((await w.post(answers(viaApi, { budgetUsd: 20 }))).status).toBe(200);
		for (const f of ["config.json", "agents.json"]) expect(read(join(viaApi, ".capcomd", f))).toBe(read(join(viaCli, ".capcomd", f)));
		expect(JSON.parse(read(join(viaApi, ".capcomd", "config.json"))).driver).toEqual({ maxRunBudget: "usd=20" });
	});

	test("pull requests with gh logged in; merged into an existing config; existing profiles kept; a setup that changes nothing says so", async () => {
		const co = checkout();
		mkdirSync(join(co, ".capcomd"));
		writeFileSync(join(co, ".capcomd", "config.json"), JSON.stringify({ env: { CAPCOMD_SANDBOX: "docker" }, driver: { approvals: "elicit" } }));
		writeFileSync(join(co, ".capcomd", "agents.json"), JSON.stringify({ schema: "capcomd.agents/v1", default: "worker", agents: { worker: { provider: "claude", auth: "subscription", model: "claude-opus-5-5" } } }));
		const w = world({ gh: true });
		const r = await w.post(answers(co, { mode: "pr", check: "" }));
		expect(r.status).toBe(200);
		const cfg = JSON.parse(read(join(co, ".capcomd", "config.json")));
		expect(cfg).toEqual({ env: { CAPCOMD_SANDBOX: "docker", CAPCOMD_REPO: "https://github.com/acme/app.git", CAPCOMD_MERGE_MODE: "pr", CAPCOMD_MERGE_TARGET: "main", CAPCOMD_GITHUB_REPO: "acme/app" }, driver: { approvals: "elicit" }, run: { reviewer: "reviewer" } });
		const agents = JSON.parse(read(join(co, ".capcomd", "agents.json"))).agents;
		expect(agents.worker.model).toBe("claude-opus-5-5");
		expect(Object.keys(agents)).toEqual(["worker", "reviewer", "planner"]);
		const again = await w.post(answers(co, { mode: "pr", check: "" }));
		expect(again.body.changed).toBe(false);
		expect(w.state.daemonEvents().length).toBe(1);
	});

	test("every answer is checked again: 422 with the daemon's sentence and the field", async () => {
		const co = checkout();
		const w = world({ gh: false });
		const no = async (body: unknown) => { const r = await w.post(body); expect(r.status).toBe(422); return r.body; };
		expect(await no(answers(mkdtempSync(join(dir, "plain-"))))).toMatchObject({ code: "invalid", field: "path", problem: "not_git", message: expect.stringContaining("isn't a git checkout") });
		expect(await no(answers(checkout({ origin: "git@gitlab.com:acme/app.git" })))).toMatchObject({ field: "path", problem: "not_github" });
		expect(await no(answers(w.home))).toMatchObject({ field: "path", problem: "home" });
		expect(await no(answers(co, { mode: "pr" }))).toEqual({ code: "invalid", field: "mode", message: "Pull requests need the GitHub CLI logged in on this Mac (run `gh auth login` in Terminal), so choose direct merges or log in first." });
		expect(await no(answers(co, { target: "bad..branch" }))).toMatchObject({ field: "target" });
		expect(await no(answers(co, { target: "-x" }))).toMatchObject({ field: "target" });
		expect(await no(answers(co, { agents: ["claude", "claude"] }))).toEqual({ code: "invalid", field: "agents", message: "Choose Claude Code, Codex or both, once each." });
		expect(await no(answers(co, { agents: ["gemini"] }))).toMatchObject({ field: "agents" });
		expect(await no(answers(co, { agents: [] }))).toMatchObject({ field: "agents" });
		expect(await no(answers(co, { budgetUsd: 20 }))).toEqual({ code: "invalid", field: "budgetUsd", message: "None of these agents bills an API key, so there's no spend to cap: leave the budget out." });
		expect(await no(answers(co, { check: "bun test\nrm -rf /" }))).toMatchObject({ field: "check" });
		expect(await no(answers("relative/app"))).toMatchObject({ field: "path" });
		expect(await no(answers(co, { mode: "merge" }))).toMatchObject({ field: "mode" });
		expect(existsSync(join(co, ".capcomd"))).toBe(false);
		// An API-key agent: the cap must be over 0.
		const k = world({ logins: APIKEY });
		expect((await k.post(answers(co, { budgetUsd: 0 }))).body).toMatchObject({ code: "invalid", field: "budgetUsd" });
		expect(existsSync(join(co, ".capcomd"))).toBe(false);
		expect(w.state.daemonEvents()).toEqual([]);
	});

	test("Idempotency-Key: required; the same key and body replays without writing again; another body is 409", async () => {
		const co = checkout();
		const w = world();
		expect(await w.post(answers(co), { key: null })).toEqual({ status: 422, body: { code: "invalid", message: "Idempotency-Key header (8-200 chars) is required" } });
		const first = await w.post(answers(co), { key: "setup-key-0001" });
		expect(first.status).toBe(200);
		writeFileSync(join(co, ".capcomd", "config.json"), "{}\n");   // a write after it: a replay must not undo it
		const replay = await w.post(answers(co), { key: "setup-key-0001" });
		expect(replay).toEqual(first);
		expect(read(join(co, ".capcomd", "config.json"))).toBe("{}\n");
		expect(w.state.daemonEvents().length).toBe(1);
		expect(await w.post(answers(co, { target: "capcomd/staging" }), { key: "setup-key-0001" })).toMatchObject({ status: 409, body: { code: "idempotency_conflict" } });
		// A refusal isn't kept: the same key can try again once it's fixed.
		const other = checkout();
		expect((await w.post(answers(other, { budgetUsd: 3 }), { key: "setup-key-0002" })).status).toBe(422);
		expect((await w.post(answers(other), { key: "setup-key-0002" })).status).toBe(200);
	});

	test("a token without the configure scope: 403, nothing written", async () => {
		const co = checkout();
		const r = await world().post(answers(co), { token: steerOnly.token });
		expect(r).toEqual({ status: 403, body: { code: "forbidden", message: "token lacks the configure scope" } });
		expect(existsSync(join(co, ".capcomd"))).toBe(false);
	});

	test("origin changed since inspect: 409 with the origin now, nothing written", async () => {
		const co = checkout();
		const w = world();
		const seen = (await w.inspect(co)).body.repo;
		sh(["git", "remote", "set-url", "origin", "git@github.com:someone-else/app.git"], co);
		const r = await w.post(answers(co, { expect: { repo: seen } }));
		expect(r).toEqual({ status: 409, body: { code: "conflict", message: `${co}'s origin changed since you looked: it's https://github.com/someone-else/app.git now. Look at the folder again before setting it up.`, repo: "https://github.com/someone-else/app.git" } });
		expect(existsSync(join(co, ".capcomd"))).toBe(false);
		expect((await w.post(answers(co, { expect: { repo: "https://github.com/someone-else/app.git" } }))).status).toBe(200);
	});

	test("a .capcomd that is a symlink out of the checkout: refused, nothing written there", async () => {
		const co = checkout();
		const outside = mkdtempSync(join(dir, "outside-"));
		symlinkSync(outside, join(co, ".capcomd"));
		const w = world();
		const r = await w.post(answers(co));
		expect(r).toEqual({ status: 422, body: { code: "invalid", field: "path", message: `${join(co, ".capcomd")} leads outside the checkout (a symlink), so capcomd won't write there. Remove the link, or set the project up with \`capcomd setup project\` in Terminal.` } });
		expect(existsSync(join(outside, "config.json"))).toBe(false);
		// The same for config.json itself.
		const co2 = checkout();
		mkdirSync(join(co2, ".capcomd"));
		const target = join(outside, "elsewhere.json");
		writeFileSync(target, "{}\n");
		symlinkSync(target, join(co2, ".capcomd", "config.json"));
		expect((await w.post(answers(co2))).body).toMatchObject({ field: "path", message: expect.stringContaining("leads outside the checkout") });
		expect(read(target)).toBe("{}\n");
		expect(w.state.daemonEvents()).toEqual([]);
	});

	test("afterwards GET /v1/run-options?repo=<root> answers for the project (422 before)", async () => {
		resetDockerCheck();
		const co = checkout();
		const auth = mkdtempSync(join(dir, "auth-"));
		writeFileSync(join(auth, "auths.json"), JSON.stringify({ "claude-code": { agent: "claude-code", store: "snapshot", snapshot: "capcomd-auth-claude-x", method: "setup-token", env: "x", createdAt: "2026-10-01T00:00:00Z" } }));
		const w = world({ runOptions: { CAPCOMD_NO_CONFIG: "1", CAPCOMD_AUTH_LEDGER: join(auth, "auths.json"), CAPCOMD_SANDBOX: "boxd", BOXD_API_KEY: "bxd_test", PATH: process.env.PATH ?? "" } });
		const before = await w.req("GET", `/v1/run-options?repo=${encodeURIComponent(co)}`);
		expect(before).toMatchObject({ status: 422, body: { code: "invalid", message: expect.stringContaining("is not a capcomd project") } });
		expect((await w.post(answers(co))).status).toBe(200);
		const after = await w.req("GET", `/v1/run-options?repo=${encodeURIComponent(co)}`);
		expect(after.status).toBe(200);
		expect(RunOptions.parse(after.body)).toEqual(after.body);
		expect(after.body.drivers[0]).toMatchObject({ provider: "claude", available: true, default: true });
		resetDockerCheck();
	});

	test("audited: project.configured on the daemon scope, with who and what, never a secret", async () => {
		const co = checkout();
		const w = world({ logins: APIKEY, gh: true });
		expect((await w.post(answers(co, { mode: "pr", agents: ["claude", "codex"], budgetUsd: 12.5 }))).status).toBe(200);
		const evs = (await w.req("GET", "/v1/events?scope=daemon")).body as any[];
		expect(evs.length).toBe(1);
		expect(HarnessEvent.parse(evs[0])).toBeTruthy();
		expect(EventData["project.configured"].parse(evs[0].data)).toBeTruthy();
		expect(evs[0]).toMatchObject({
			scope: "daemon", entity: "project:app", entitySeq: 1, type: "project.configured", durability: "durable", runId: null,
			text: `Set up app (${co}): pull requests into main, with Claude Code and Codex.`,
			data: { path: co, name: "app", mode: "pr", target: "main", check: "bun run test", agents: ["claude", "codex"], budgetUsd: 12.5, clientId: configurer.client.id },
		});
		expect(describeEvent("project.configured", {}, null)).toBe("A project was set up.");
	});
});
