// Capability runs.options: POST /v1/runs `driver` and `sandbox`, GET /v1/run-options, and how they reach `capcomd run`
// (args and env of the launched command). Engine-free; tests/scenarios/run-sandbox.test.ts covers the engine side.
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { credentialReady, plannerDriver } from "../../src/agents/run-driver";
import { decodeAgentRef, resolveAgent } from "../../src/agents/profiles";
import { addClient, loadClients } from "../../src/api/clients";
import { CAPABILITY_NAMES, CreateRunBody, RunOptions } from "../../src/api/contract";
import { launchContext, startDetachedRun } from "../../src/api/create-run";
import { boxdKeyConfigured, dockerReachable, resetDockerCheck, runOptions, runOptionsFor } from "../../src/api/run-options";
import { harnessApp } from "../../src/api/server";
import { CreateRunError, memorySource } from "../../src/api/source";
import { harnessState } from "../../src/api/state";
import spec from "../../openapi/capcomd.json";

const dir = mkdtempSync(join(tmpdir(), "harness-runopts-"));
const cpath = join(dir, "clients.json");
const steer = addClient("menubar", ["read", "steer"], cpath).token;
const reader = addClient("reader", ["read"], cpath).token;

// An agents file as `capcomd setup` writes it for claude + codex, and logins in a ledger of its own.
const PROFILES = {
	schema: "capcomd.agents/v1",
	agents: {
		worker: { provider: "claude", auth: "subscription" },
		"codex-worker": { provider: "codex", auth: "subscription", model: "gpt-5-codex" },
		planner: { provider: "claude", auth: "subscription", model: "claude-opus-5-5", sandbox: "workspace-write", children: { allowSpawn: true, allowedChildProfiles: ["worker", "codex-worker"] } },
	},
};
/** An agent environment (`capcomd env build`) in a world's ledger for each of these sandboxes. */
function envs(home: string, sandboxes: string[]) {
	mkdirSync(join(home, "state"), { recursive: true });
	for (const s of sandboxes) writeFileSync(join(home, "state", s === "boxd" ? "envs.json" : `envs-${s}.json`), JSON.stringify({ current: { name: `capcomd-env-${s}` }, history: [] }));
}
const login = (a: string) => ({ agent: a, store: "snapshot", snapshot: `capcomd-auth-${a}-x`, method: a === "codex" ? "device-auth" : "setup-token", env: "x", createdAt: "2026-10-01T00:00:00Z" });
function world(o: { profiles?: unknown; logins?: string[]; env?: Record<string, string>; envs?: string[] } = {}) {
	const d = mkdtempSync(join(dir, "w-"));
	envs(d, o.envs ?? []);
	writeFileSync(join(d, "agents.json"), JSON.stringify(o.profiles ?? PROFILES));
	const ledger: Record<string, unknown> = {};
	for (const a of o.logins ?? []) ledger[a] = { agent: a, store: "snapshot", snapshot: `capcomd-auth-${a}-x`, method: a === "codex" ? "device-auth" : "setup-token", env: "x", createdAt: "2026-10-01T00:00:00Z" };
	writeFileSync(join(d, "auths.json"), JSON.stringify(ledger));
	return { CAPCOMD_AGENTS_FILE: join(d, "agents.json"), CAPCOMD_AUTH_LEDGER: join(d, "auths.json"), CAPCOMD_HOME: d, CAPCOMD_NO_CONFIG: "1", PATH: process.env.PATH ?? "", ...(o.env ?? {}) } as Record<string, string>;
}
/** Run options where everything can be used (memorySource's default has no planner, so a sandbox would be refused). */
const FITS = { docker: { available: true, reason: null }, boxd: { available: true, reason: null } };
const READY = { drivers: [
	{ provider: "claude" as const, label: "Claude Code", model: null, efforts: ["low", "medium", "high", "xhigh", "max"], effort: null, available: true, reason: null, default: false, sandboxes: FITS },
	{ provider: "codex" as const, label: "Codex", model: null, efforts: ["minimal", "low", "medium", "high"], effort: "medium", available: true, reason: null, default: false, sandboxes: FITS },
], sandboxes: [{ name: "docker" as const, label: "Local", available: true, reason: null, default: false }, { name: "boxd" as const, label: "VM", available: true, reason: null, default: false }] };
const dockerUp = async () => ({ ok: true, reason: null });
const dockerDown = async () => ({ ok: false, reason: "Docker isn't running" });

describe("CreateRunBody", () => {
	test("driver claude|codex and sandbox docker|boxd, both optional", () => {
		expect(CreateRunBody.parse({ goal: "g", driver: "codex", sandbox: "docker" })).toMatchObject({ driver: "codex", sandbox: "docker" });
		expect(CreateRunBody.parse({ goal: "g" })).toEqual({ goal: "g" });
		expect(CreateRunBody.safeParse({ goal: "g", driver: "gemini" }).success).toBe(false);
		expect(CreateRunBody.safeParse({ goal: "g", sandbox: "fake" }).success).toBe(false);
		expect(CreateRunBody.safeParse({ goal: "g", sandbox: "VM" }).success).toBe(false);
	});
	test("published: driver and sandbox enums on POST /v1/runs; runs.options capability; GET /v1/run-options", () => {
		const body = (spec as any).paths["/v1/runs"].post.requestBody.content["application/json"].schema;
		expect(body.properties.driver.enum).toEqual(["claude", "codex"]);
		expect(body.properties.sandbox.enum).toEqual(["docker", "boxd"]);
		expect(body.required).toEqual(["goal"]);
		expect(CAPABILITY_NAMES).toContain("runs.options");
		const out = (spec as any).paths["/v1/run-options"].get.responses["200"].content["application/json"].schema;
		expect(out.required).toEqual(["drivers", "sandboxes"]);
		expect(out.properties.drivers.items.required).toEqual(["provider", "label", "model", "efforts", "effort", "available", "reason", "default", "sandboxes"]);
		expect(body.properties.effort.type).toBe("string");
		expect(out.properties.sandboxes.items.required).toEqual(["name", "label", "available", "reason", "default"]);
	});
});

describe("POST /v1/runs with driver and sandbox", () => {
	function setup() {
		const src = memorySource({ runOptions: READY });
		const app = harnessApp({ source: src, clients: () => loadClients(cpath), state: harnessState(null) });
		const post = (body: unknown, key = "key-runopts01") => app.request("/v1/runs", { method: "POST", headers: { authorization: `Bearer ${steer}`, "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify(body) });
		return { src, app, post };
	}
	test("they reach the run's start; omitted, nothing changes", async () => {
		const { post, src } = setup();
		expect((await post({ goal: "go", driver: "codex", sandbox: "docker" }, "key-runopts-a")).status).toBe(201);
		expect((await post({ goal: "go" }, "key-runopts-b")).status).toBe(201);
		expect(src.created).toEqual([{ goal: "go", driver: "codex", sandbox: "docker" }, { goal: "go" }]);
	});
	test("422: profile with driver, an unknown driver or sandbox", async () => {
		const { post, src } = setup();
		const a = await post({ goal: "go", profile: "worker", driver: "claude" });
		expect(a.status).toBe(422);
		expect(await a.json()).toEqual({ code: "invalid", message: expect.stringContaining("profile and driver can't be combined") });
		for (const b of [{ goal: "go", driver: "gemini" }, { goal: "go", sandbox: "kubernetes" }]) {
			const r = await post(b);
			expect(r.status).toBe(422);
			expect(((await r.json()) as any).code).toBe("invalid");
		}
		expect(src.created).toEqual([]);
	});
	test("idempotency: the same key with another driver or sandbox is 409; the same body replays", async () => {
		const { post, src } = setup();
		expect((await post({ goal: "go", driver: "claude" }, "key-runopts-i")).status).toBe(201);
		const again = await post({ goal: "go", driver: "claude" }, "key-runopts-i");
		expect(again.status).toBe(201);
		expect(again.headers.get("idempotent-replayed")).toBe("true");
		for (const other of [{ goal: "go", driver: "codex" }, { goal: "go" }, { goal: "go", driver: "claude", sandbox: "boxd" }]) {
			const r = await post(other, "key-runopts-i");
			expect(r.status).toBe(409);
			expect(((await r.json()) as any).code).toBe("idempotency_conflict");
		}
		expect((await post({ goal: "go", sandbox: "docker" }, "key-runopts-j")).status).toBe(201);
		expect((await post({ goal: "go", sandbox: "boxd" }, "key-runopts-j")).status).toBe(409);
		expect(src.created.length).toBe(2);
	});
	test("a 422 from the run's start (driver or sandbox unavailable) is not recorded: the key can retry", async () => {
		const { post, src } = setup();
		const create = src.createRun;
		let refuse = true;
		src.createRun = async (i) => { if (refuse) throw new CreateRunError("sandbox docker isn't available: Docker isn't running"); return create(i); };
		const a = await post({ goal: "go", sandbox: "docker" }, "key-runopts-r");
		expect(a.status).toBe(422);
		expect(await a.json()).toEqual({ code: "invalid", message: "sandbox docker isn't available: Docker isn't running" });
		refuse = false;
		expect((await post({ goal: "go", sandbox: "docker" }, "key-runopts-r")).status).toBe(201);
	});
});

describe("GET /v1/run-options", () => {
	test("read scope; the source's answer; runs.options in /v1/health", async () => {
		const app = harnessApp({ source: memorySource(), clients: () => loadClients(cpath), state: harnessState(null) });
		expect((await app.request("/v1/run-options")).status).toBe(401);
		const r = await app.request("/v1/run-options", { headers: { authorization: `Bearer ${reader}` } });
		expect(r.status).toBe(200);
		const body = RunOptions.parse(await r.json());
		expect(body.drivers.map((d) => [d.provider, d.label])).toEqual([["claude", "Claude Code"], ["codex", "Codex"]]);
		expect(body.sandboxes.map((s) => [s.name, s.label])).toEqual([["docker", "Local"], ["boxd", "VM"]]);
		const h = (await (await app.request("/v1/health")).json()) as any;
		expect(h.capabilities).toContain("runs.options");
	});

	test("drivers: the planner profile's provider is the default, with its model; the other provider's model and login come from the project's profile on it", async () => {
		const env = world({ logins: ["claude-code", "codex"], envs: ["docker", "boxd"], env: { CAPCOMD_SANDBOX: "boxd", BOXD_API_KEY: "bxd_test" } });
		resetDockerCheck();
		const o = await runOptions(env, dockerUp);
		expect(RunOptions.parse(o)).toEqual(o);
		const fits = { docker: { available: true, reason: null }, boxd: { available: true, reason: null } };
		expect(o).toEqual({
			drivers: [
				{ provider: "claude", label: "Claude Code", model: "claude-opus-5-5", efforts: ["low", "medium", "high", "xhigh", "max"], effort: null, available: true, reason: null, default: true, sandboxes: fits },
				{ provider: "codex", label: "Codex", model: "gpt-5-codex", efforts: ["minimal", "low", "medium", "high"], effort: "medium", available: true, reason: null, default: false, sandboxes: fits },
			],
			sandboxes: [
				{ name: "docker", label: "Local", available: true, reason: null, default: false },
				{ name: "boxd", label: "VM", available: true, reason: null, default: true },
			],
		});
	});

	test("unavailable: no login, no planner profile, Docker down, no boxd key; a fake sandbox is no default", async () => {
		resetDockerCheck();
		const noCodex = await runOptions(world({ logins: ["claude-code"], env: { CAPCOMD_SANDBOX: "fake" } }), dockerDown);
		expect(noCodex.drivers[1]).toEqual({ provider: "codex", label: "Codex", model: "gpt-5-codex", efforts: ["minimal", "low", "medium", "high"], effort: "medium", available: false, reason: "Not logged in to Codex (run capcomd auth login codex)", default: false, sandboxes: {
			docker: { available: false, reason: "Not logged in to Codex for Local (run `capcomd auth login codex --sandbox docker`)" },
			boxd: { available: false, reason: "Not logged in to Codex for VM (run `capcomd auth login codex --sandbox boxd`)" },
		} });
		expect(noCodex.drivers[0]!.available).toBe(true);
		expect(noCodex.sandboxes).toEqual([
			{ name: "docker", label: "Local", available: false, reason: "Docker isn't running", default: false },
			{ name: "boxd", label: "VM", available: false, reason: "No boxd API key (run capcomd setup)", default: false },
		]);
		resetDockerCheck();
		const none = await runOptions(world({ profiles: { schema: "capcomd.agents/v1", agents: { worker: { provider: "claude", auth: "apikey" } } }, env: { CAPCOMD_SANDBOX: "docker" } }), dockerUp);
		expect(none.drivers.map((d) => [d.available, d.reason, d.default])).toEqual([[false, "No planner profile (run capcomd setup)", false], [false, "No planner profile (run capcomd setup)", false]]);
		expect(none.sandboxes.map((s) => s.default)).toEqual([true, false]);
		resetDockerCheck();
	});

	test("Docker is asked at most every few seconds, and concurrent requests share one answer", async () => {
		resetDockerCheck();
		let asked = 0;
		const ask = async () => { asked++; await Bun.sleep(20); return { ok: true, reason: null }; };
		await Promise.all([dockerReachable({}, ask), dockerReachable({}, ask), dockerReachable({}, ask)]);
		await dockerReachable({}, ask);
		expect(asked).toBe(1);
		resetDockerCheck();
	});

	test("boxd key: BOXD_API_KEY, or the key capcomd setup stored", () => {
		expect(boxdKeyConfigured({ BOXD_API_KEY: "bxd" })).toBe(true);
		expect(boxdKeyConfigured({ CAPCOMD_NO_CONFIG: "1" })).toBe(false);
		const home = mkdtempSync(join(dir, "home-"));
		expect(boxdKeyConfigured({ CAPCOMD_HOME: home })).toBe(false);
		writeFileSync(join(home, "config.json"), JSON.stringify({ boxdKey: "file" }));
		expect(boxdKeyConfigured({ CAPCOMD_HOME: home })).toBe(false);
		writeFileSync(join(home, "credentials"), JSON.stringify({ BOXD_API_KEY: "bxd" }));
		expect(boxdKeyConfigured({ CAPCOMD_HOME: home })).toBe(true);
		writeFileSync(join(home, "config.json"), JSON.stringify({ boxdKey: "keychain" }));
		expect(boxdKeyConfigured({ CAPCOMD_HOME: home })).toBe(true);
	});
});

describe("plannerDriver (what `capcomd run --planner-provider` runs)", () => {
	test("the planner's own provider: the profile as it is", () => {
		const d = plannerDriver("claude", undefined, world({ logins: ["claude-code"] }));
		expect(d).toEqual({ ok: true, profile: "planner", ref: "planner", provider: "claude", auth: "subscription", model: "claude-opus-5-5", effort: null, defaultEffort: null, swapped: false });
	});
	test("another provider: swapped, with that provider's model and login from the project's profile on it", () => {
		const env = world({ logins: ["codex"] });
		const d = plannerDriver("codex", undefined, env);
		expect(d).toMatchObject({ ok: true, profile: "planner", provider: "codex", auth: "subscription", model: "gpt-5-codex", swapped: true });
		const ref = (d as any).ref as string;
		expect(decodeAgentRef(ref)).toEqual({ name: "planner", overrides: { set: { provider: "codex", auth: "subscription", model: "gpt-5-codex", effort: null }, operator: true } });
		const r = resolveAgent(ref, env);
		expect(r).toMatchObject({ name: "planner", kind: "codex", overridden: true });
		expect(r.spec).toMatchObject({ provider: "codex", auth: "subscription", model: "gpt-5-codex", sandbox: "workspace-write", children: { allowSpawn: true } });
	});
	test("no profile on that provider: the planner's other-provider model is dropped (the provider's default), and its login mode tried first", () => {
		const profiles = { schema: "capcomd.agents/v1", agents: { worker: { provider: "claude", auth: "apikey" }, planner: { provider: "claude", auth: "apikey", model: "claude-opus-5-5", children: { allowSpawn: true, allowedChildProfiles: ["worker"] } } } };
		const env = world({ profiles, env: { OPENAI_API_KEY: "sk-test" } });
		const d = plannerDriver("codex", undefined, env);
		expect(d).toMatchObject({ ok: true, provider: "codex", auth: "apikey", model: null, swapped: true });
		expect(resolveAgent((d as any).ref, env).spec!.model).toBeUndefined();
		// CAPCOMD_AGENT_MODEL is the model any agent runs with
		expect(plannerDriver("codex", undefined, { ...env, CAPCOMD_AGENT_MODEL: "gpt-5-mini" })).toMatchObject({ ok: true, model: "gpt-5-mini" });
		// neither an API key nor a login: the first mode's reason
		expect(plannerDriver("codex", undefined, world({ profiles }))).toEqual({ ok: false, code: "login", reason: "OPENAI_API_KEY isn't set", model: null, defaultEffort: "medium" });
	});
	test("no planner profile, or a named one that can't plan", () => {
		const env = world({ profiles: { schema: "capcomd.agents/v1", agents: { worker: { provider: "claude", auth: "apikey" } } } });
		expect(plannerDriver("claude", undefined, env)).toEqual({ ok: false, code: "planner", reason: "No planner profile (run capcomd setup)", model: null, defaultEffort: null });
		expect(plannerDriver("claude", "worker", env)).toMatchObject({ ok: false, reason: expect.stringContaining("can't plan") });
	});
	test("credentialReady", () => {
		expect(credentialReady("claude", "apikey", { ANTHROPIC_API_KEY: "k" })).toEqual({ ready: true, reason: null });
		expect(credentialReady("claude", "apikey", {})).toEqual({ ready: false, reason: "ANTHROPIC_API_KEY isn't set" });
		expect(credentialReady("codex", "apikey", { CAPCOMD_CREDENTIALS: "secret" }).ready).toBe(true);
		expect(credentialReady("claude", "subscription", world())).toEqual({ ready: false, reason: "Not logged in to Claude Code (run capcomd auth login claude)" });
		expect(credentialReady("claude", "subscription", world({ logins: ["claude-code"] })).ready).toBe(true);
	});
});

describe("the launched `capcomd run`", () => {
	const project = () => {
		const d = mkdtempSync(join(dir, "prj-"));
		mkdirSync(join(d, ".capcomd"));
		writeFileSync(join(d, ".capcomd", "config.json"), JSON.stringify({ env: { CAPCOMD_REPO: "/srv/git/app.git", CAPCOMD_SANDBOX: "boxd" } }));
		return d;
	};
	/** A spawn that records its call and answers like `capcomd run --detach --json`. */
	function fakeSpawn(reply: (args: string[]) => Record<string, unknown> = (a) => ({ ok: true, runId: a[a.indexOf("--run-id") + 1], detached: true, log: "/tmp/x.ndjson" })) {
		const calls: Array<{ cmd: string; args: string[]; cwd: string; env: Record<string, string | undefined> }> = [];
		const spawn = ((cmd: string, args: string[], o: any) => {
			calls.push({ cmd, args, cwd: o.cwd, env: o.env });
			const child: any = new EventEmitter();
			child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
			setTimeout(() => { child.stdout.write(JSON.stringify(reply(args)) + "\n"); child.stdout.end(); child.stderr.end(); child.emit("exit", 0); }, 5);
			return child;
		}) as any;
		return { spawn, calls };
	}

	test("driver and sandbox become --planner-provider and --sandbox; the sandbox is that command's CAPCOMD_SANDBOX only", async () => {
		const base = { CAPCOMD_REPO: "/srv/git/daemon.git", CAPCOMD_SANDBOX: "boxd", RELAY_SANDBOX: "boxd", CAPCOMD_NO_CONFIG: "1" };
		const before = JSON.stringify(base);
		const { spawn, calls } = fakeSpawn();
		const available = async () => ({ available: true, reason: null });
		const r = await startDetachedRun({ goal: "go", runId: "run-x1", driver: "codex", sandbox: "docker" }, { env: base, cwd: dir, spawn, sandboxCheck: available });
		expect(r).toEqual({ repo: "/srv/git/daemon.git", log: "/tmp/x.ndjson" });
		expect(calls.length).toBe(1);
		const { args, env } = calls[0]!;
		expect(args).toEqual(expect.arrayContaining(["run", "--detach", "--json", "--run-id", "run-x1", "--planner-provider=codex", "--sandbox=docker"]));
		expect(args.slice(-2)).toEqual(["--", "go"]);
		expect(env.CAPCOMD_SANDBOX).toBe("docker");
		expect(env.RELAY_SANDBOX).toBeUndefined();
		expect(JSON.stringify(base)).toBe(before); // the daemon's own env is untouched

		// a project's config sets its sandbox; the request's still wins for that run
		const d = project();
		const p = fakeSpawn();
		await startDetachedRun({ goal: "go", runId: "run-x2", repo: d, sandbox: "docker" }, { env: { CAPCOMD_NO_CONFIG: "1" }, spawn: p.spawn, sandboxCheck: available });
		expect(p.calls[0]!.env.CAPCOMD_SANDBOX).toBe("docker");
		expect(p.calls[0]!.args).not.toContain("--planner-provider=codex");
	});

	test("omitted: the same command as before", async () => {
		const { spawn, calls } = fakeSpawn();
		await startDetachedRun({ goal: "go", runId: "run-x3", profile: "worker" }, { env: { CAPCOMD_REPO: "/r", CAPCOMD_SANDBOX: "boxd" }, cwd: dir, spawn, sandboxCheck: async () => { throw new Error("not asked"); } });
		expect(calls[0]!.args.filter((a) => a.startsWith("--planner-provider") || a.startsWith("--sandbox"))).toEqual([]);
		expect(calls[0]!.args).toContain("--profile=worker");
		expect(calls[0]!.env.CAPCOMD_SANDBOX).toBe("boxd");
		expect(launchContext(undefined, { CAPCOMD_REPO: "/r", CAPCOMD_SANDBOX: "boxd" }, dir).env.CAPCOMD_SANDBOX).toBe("boxd");
	});

	test("422s before anything starts: sandbox unavailable, profile with driver; the CLI's refusal of a driver is passed on", async () => {
		const { spawn, calls } = fakeSpawn();
		const base = { CAPCOMD_REPO: "/r" };
		await expect(startDetachedRun({ goal: "go", runId: "run-x4", sandbox: "docker" }, { env: base, cwd: dir, spawn, sandboxCheck: async () => ({ available: false, reason: "Docker isn't running" }) }))
			.rejects.toThrow(new CreateRunError("sandbox docker isn't available: Docker isn't running"));
		await expect(startDetachedRun({ goal: "go", runId: "run-x5", sandbox: "boxd" }, { env: { ...base, CAPCOMD_NO_CONFIG: "1" }, cwd: dir, spawn }))
			.rejects.toThrow("sandbox boxd isn't available: No boxd API key (run capcomd setup)");
		await expect(startDetachedRun({ goal: "go", runId: "run-x6", profile: "worker", driver: "codex" }, { env: base, cwd: dir, spawn })).rejects.toBeInstanceOf(CreateRunError);
		expect(calls).toEqual([]);
		const refused = fakeSpawn(() => ({ ok: false, error: { code: "config", message: "codex can't drive this run: Not logged in to Codex (run capcomd auth login codex)", hint: "Log in with `capcomd auth login codex`." } }));
		await expect(startDetachedRun({ goal: "go", runId: "run-x7", driver: "codex" }, { env: base, cwd: dir, spawn: refused.spawn }))
			.rejects.toThrow("codex can't drive this run: Not logged in to Codex (run capcomd auth login codex)");
	});
});

describe("capcomd run --planner-provider / --sandbox (checked before the engine is asked)", () => {
	const { capcomd } = require("../helpers/engine") as typeof import("../helpers/engine");
	const NO_ENGINE = { CAPCOMD_ENDPOINT: "http://127.0.0.1:6499" };
	const run = async (args: string[], env: Record<string, string>) => {
		const r = await capcomd(["run", "fix it", "--json", ...args], { ...NO_ENGINE, ...env });
		return { code: r.code, error: (() => { try { return JSON.parse(r.stdout.trim().split("\n").pop()!).error; } catch { return r.stdout + r.stderr; } })() };
	};
	test("bad values and combinations are usage errors", async () => {
		const env = world({ logins: ["claude-code", "codex"] });
		for (const args of [["--planner-provider", "gemini"], ["--sandbox", "kubernetes"], ["--sandbox", "docker", "--legacy"], ["--planner-provider", "codex", "--recipe"], ["--planner-provider", "codex", "--profile", "worker"]]) {
			const r = await run(args, env);
			expect({ args, code: r.code, kind: r.error?.code }).toEqual({ args, code: 2, kind: "usage" });
		}
	});
	test("a driver that can't run is refused with the reason; one that can goes on to the engine", async () => {
		const noCodex = await run(["--planner-provider", "codex"], world({ logins: ["claude-code"] }));
		expect(noCodex.error).toMatchObject({ code: "config", message: "codex can't drive this run: Not logged in to Codex (run capcomd auth login codex)" });
		const noPlanner = await run(["--planner-provider", "claude"], world({ profiles: { schema: "capcomd.agents/v1", agents: { worker: { provider: "claude", auth: "apikey" } } } }));
		expect(noPlanner.error).toMatchObject({ code: "config", message: expect.stringContaining("no planner profile") });
		const ok = await run(["--planner-provider", "codex", "--sandbox", "docker"], world({ logins: ["codex"] }));
		expect(ok.error).toMatchObject({ code: "engine_unreachable" });
	}, 30_000);
});

describe("effort (the driver's reasoning effort)", () => {
	const { claudeAdapter, codexAdapter } = require("../../src/agents/adapters") as typeof import("../../src/agents/adapters");
	const { loadAgentConfig, agentEffort } = require("../../src/agents/config") as typeof import("../../src/agents/config");
	const { validateSpec } = require("../../src/agents/profiles") as typeof import("../../src/agents/profiles");
	const ctx = (cfg: any) => ({ bin: "x", repo: "/r", promptFile: "/p", jsonl: "/j", errFile: "/e", dir: "/w", cfg });
	const q = (s: string) => `'${s}'`;

	test("the CLIs get it: claude --effort, codex -c model_reasoning_effort; none: no flag", () => {
		const env = world({ env: { ANTHROPIC_API_KEY: "k", OPENAI_API_KEY: "k" }, profiles: { schema: "capcomd.agents/v1", agents: { c: { provider: "claude", auth: "apikey", effort: "high" }, x: { provider: "codex", auth: "apikey", effort: "minimal" }, n: { provider: "claude", auth: "apikey" } } } });
		const c = loadAgentConfig(env, "c"), x = loadAgentConfig(env, "x"), n = loadAgentConfig(env, "n");
		expect([c.effort, x.effort, n.effort]).toEqual(["high", "minimal", undefined]);
		expect(claudeAdapter.command(ctx(c), q)).toContain(" --effort 'high'");
		expect(codexAdapter.command(ctx(x), q)).toContain(` -c 'model_reasoning_effort="minimal"'`);
		expect(claudeAdapter.command(ctx(n), q)).not.toContain("--effort");
		expect(codexAdapter.command(ctx({ ...x, effort: undefined }), q)).not.toContain("model_reasoning_effort");
		expect(loadAgentConfig({ ...env, CAPCOMD_AGENT_EFFORT: "low" }, "c").effort).toBe("low");
		expect(agentEffort({ effort: "high" }, {})).toBe("high");
	});
	test("profiles: effort is one of the provider's levels", () => {
		expect(validateSpec("a", { provider: "claude", auth: "apikey", effort: "max" })).toEqual([]);
		expect(validateSpec("a", { provider: "codex", auth: "apikey", effort: "minimal" })).toEqual([]);
		expect(validateSpec("a", { provider: "claude", auth: "apikey", effort: "minimal" }).join()).toContain("effort must be one of low, medium, high, xhigh, max");
		expect(validateSpec("a", { provider: "codex", auth: "apikey", effort: "max" }).join()).toContain("effort must be one of minimal, low, medium, high");
	});
	test("plannerDriver: a chosen level overrides the planner's; a swap carries the chosen level or the other provider's profile's; a bad level is refused", () => {
		const env = world({ logins: ["claude-code", "codex"] });
		const same = plannerDriver("claude", undefined, env, "xhigh");
		expect(same).toMatchObject({ ok: true, effort: "xhigh", defaultEffort: null, swapped: false });
		expect(decodeAgentRef((same as any).ref)).toEqual({ name: "planner", overrides: { set: { effort: "xhigh" }, operator: false } });
		expect(resolveAgent((same as any).ref, env).spec).toMatchObject({ provider: "claude", effort: "xhigh" });
		const swap = plannerDriver("codex", undefined, env, "high");
		expect(swap).toMatchObject({ ok: true, effort: "high", defaultEffort: "medium", swapped: true });
		expect(resolveAgent((swap as any).ref, env)).toMatchObject({ kind: "codex", spec: { provider: "codex", effort: "high" } });
		expect(plannerDriver("codex", undefined, env, "max")).toMatchObject({ ok: false, code: "effort", reason: 'effort "max" isn\'t a Codex level: use one of minimal, low, medium, high' });
		// the planner's own level is what a run without a chosen one gets; swapping drops it (another provider's level)
		const leveled = { ...PROFILES, agents: { ...PROFILES.agents, planner: { ...PROFILES.agents.planner, effort: "max" }, "codex-worker": { ...PROFILES.agents["codex-worker"], effort: "low" } } };
		const e2 = world({ profiles: leveled, logins: ["claude-code", "codex"] });
		expect(plannerDriver("claude", undefined, e2)).toMatchObject({ ok: true, ref: "planner", effort: "max", defaultEffort: "max" });
		const sw = plannerDriver("codex", undefined, e2);
		expect(sw).toMatchObject({ ok: true, effort: "low", defaultEffort: "low" });
		expect(resolveAgent((sw as any).ref, e2).spec!.effort).toBe("low");
	});
	test("GET /v1/run-options: efforts per provider and the level a run gets by default", async () => {
		resetDockerCheck();
		const leveled = { ...PROFILES, agents: { ...PROFILES.agents, planner: { ...PROFILES.agents.planner, effort: "high" } } };
		const o = await runOptions(world({ profiles: leveled, logins: ["claude-code", "codex"] }), dockerUp);
		expect(o.drivers.map((d) => [d.provider, d.efforts, d.effort])).toEqual([["claude", ["low", "medium", "high", "xhigh", "max"], "high"], ["codex", ["minimal", "low", "medium", "high"], "medium"]]);
		resetDockerCheck();
	});
	test("POST /v1/runs effort: one of the chosen (or default) driver's levels, else 422 naming them; part of the body for idempotency", async () => {
		const options = { drivers: [
			{ provider: "claude" as const, label: "Claude Code", model: null, efforts: ["low", "medium", "high", "xhigh", "max"], effort: null, available: true, reason: null, default: true, sandboxes: FITS },
			{ provider: "codex" as const, label: "Codex", model: null, efforts: ["minimal", "low", "medium", "high"], effort: "medium", available: true, reason: null, default: false, sandboxes: FITS },
		], sandboxes: [{ name: "docker" as const, label: "Local", available: true, reason: null, default: true }, { name: "boxd" as const, label: "VM", available: true, reason: null, default: false }] };
		const src = memorySource({ runOptions: options });
		const app = harnessApp({ source: src, clients: () => loadClients(cpath), state: harnessState(null) });
		const post = (body: unknown, key: string) => app.request("/v1/runs", { method: "POST", headers: { authorization: `Bearer ${steer}`, "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify(body) });
		expect((await post({ goal: "go", effort: "max" }, "key-effort-01")).status).toBe(201); // the default driver (claude)
		expect((await post({ goal: "go", driver: "codex", effort: "minimal" }, "key-effort-02")).status).toBe(201);
		expect(src.created).toEqual([{ goal: "go", effort: "max" }, { goal: "go", driver: "codex", effort: "minimal" }]);
		const bad = await post({ goal: "go", driver: "codex", effort: "max" }, "key-effort-03");
		expect(bad.status).toBe(422);
		expect(await bad.json()).toEqual({ code: "invalid", message: 'effort "max" isn\'t a Codex level: use one of minimal, low, medium, high' });
		const badDefault = await post({ goal: "go", effort: "minimal" }, "key-effort-04");
		expect(((await badDefault.json()) as any).message).toBe('effort "minimal" isn\'t a Claude Code level: use one of low, medium, high, xhigh, max');
		const withProfile = await post({ goal: "go", profile: "worker", effort: "high" }, "key-effort-05");
		expect(withProfile.status).toBe(422);
		expect(((await withProfile.json()) as any).message).toContain("profile and effort can't be combined");
		expect((await post({ goal: "go", effort: "high" }, "key-effort-01")).status).toBe(409);
		expect((await post({ goal: "go" }, "key-effort-01")).status).toBe(409);
		expect((await post({ goal: "go", effort: "max" }, "key-effort-01")).headers.get("idempotent-replayed")).toBe("true");
		// no default driver: effort needs one
		const none = memorySource();
		const app2 = harnessApp({ source: none, clients: () => loadClients(cpath), state: harnessState(null) });
		const r = await app2.request("/v1/runs", { method: "POST", headers: { authorization: `Bearer ${steer}`, "content-type": "application/json", "idempotency-key": "key-effort-06" }, body: JSON.stringify({ goal: "go", effort: "high" }) });
		expect(r.status).toBe(422);
		expect(((await r.json()) as any).message).toContain("effort needs a driver");
		expect(none.created).toEqual([]);
	});
	test("the launched command gets --planner-effort; the CLI checks the level", async () => {
		const calls: string[][] = [];
		const spawn = ((cmd: string, args: string[]) => {
			calls.push(args);
			const child: any = new EventEmitter();
			child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
			setTimeout(() => { child.stdout.write(JSON.stringify({ ok: true, runId: "run-e1", detached: true, log: null }) + "\n"); child.stdout.end(); child.stderr.end(); child.emit("exit", 0); }, 5);
			return child;
		}) as any;
		await startDetachedRun({ goal: "go", runId: "run-e1", driver: "codex", effort: "high" }, { env: { CAPCOMD_REPO: "/r" }, cwd: dir, spawn });
		expect(calls[0]).toEqual(expect.arrayContaining(["--planner-provider=codex", "--planner-effort=high"]));
		const { capcomd } = require("../helpers/engine") as typeof import("../helpers/engine");
		const env = { ...world({ logins: ["claude-code", "codex"] }), CAPCOMD_ENDPOINT: "http://127.0.0.1:6499" };
		const err = async (args: string[]) => JSON.parse((await capcomd(["run", "fix it", "--json", ...args], env)).stdout.trim().split("\n").pop()!).error;
		expect(await err(["--planner-provider", "codex", "--planner-effort", "max"])).toMatchObject({ code: "usage", message: expect.stringContaining("use one of minimal, low, medium, high") });
		expect(await err(["--planner-effort", "high", "--recipe"])).toMatchObject({ code: "usage" });
		expect(await err(["--planner-effort", "high"])).toMatchObject({ code: "engine_unreachable" }); // the default planner (claude) takes it
	}, 30_000);
});

describe("per sandbox: drivers[].sandboxes (capability runs.options.sandbox)", () => {
	// Logins and agent environments as a CAPCOMD_HOME keeps them: per sandbox (auths.json is boxd's, auths-docker.json Docker's).
	function home(o: { logins: Record<string, string[]>; envs: string[] }) {
		const d = mkdtempSync(join(dir, "h-"));
		writeFileSync(join(d, "agents.json"), JSON.stringify(PROFILES));
		mkdirSync(join(d, "state"), { recursive: true });
		for (const [s, agents] of Object.entries(o.logins)) writeFileSync(join(d, "state", s === "boxd" ? "auths.json" : `auths-${s}.json`), JSON.stringify(Object.fromEntries(agents.map((a) => [a, login(a)]))));
		envs(d, o.envs);
		return { CAPCOMD_AGENTS_FILE: join(d, "agents.json"), CAPCOMD_HOME: d, CAPCOMD_NO_CONFIG: "1", CAPCOMD_SANDBOX: "boxd", BOXD_API_KEY: "bxd_test", PATH: process.env.PATH ?? "" } as Record<string, string>;
	}
	test("logged in for boxd only: Claude can drive on VM, not on Local, naming the command; available stays the daemon's sandbox", async () => {
		resetDockerCheck();
		const o = await runOptions(home({ logins: { boxd: ["claude-code"] }, envs: ["boxd", "docker"] }), dockerUp);
		const claude = o.drivers[0]!;
		expect(claude).toMatchObject({ provider: "claude", available: true, reason: null, default: true });
		expect(claude.sandboxes).toEqual({
			docker: { available: false, reason: "Not logged in to Claude Code for Local (run `capcomd auth login claude --sandbox docker`)" },
			boxd: { available: true, reason: null },
		});
		// The sandbox itself is up either way.
		expect(o.sandboxes.map((s) => s.available)).toEqual([true, true]);
		resetDockerCheck();
	});
	test("logged in for both, no agent environment for Docker: unavailable there, with the env build command; the message says containers", async () => {
		resetDockerCheck();
		const env = home({ logins: { boxd: ["claude-code"], docker: ["claude-code"] }, envs: ["boxd"] });
		const o = await runOptions(env, dockerUp);
		expect(o.drivers[0]!.sandboxes).toEqual({
			docker: { available: false, reason: "No agent environment for Local yet (run `capcomd env build --sandbox docker`)" },
			boxd: { available: true, reason: null },
		});
		const { envSnapshotProblem } = await import("../../src/primitives/ops");
		expect(envSnapshotProblem("claude", { ...env, CAPCOMD_SANDBOX: "docker" })).toBe("no capcomd env snapshot for the docker sandbox (the claude CLI would be missing in its containers); run `capcomd env build --sandbox docker` first");
		expect(envSnapshotProblem("claude", { ...env, CAPCOMD_SANDBOX: "boxd", CAPCOMD_ENV_LEDGER: "/nonexistent/x.json" })).toContain("missing in its VMs); run `capcomd env build --sandbox boxd` first");
		// An API key is the same for every sandbox; an agent environment is still needed.
		const keyed = await runOptions({ ...world({ profiles: { schema: "capcomd.agents/v1", agents: { worker: { provider: "claude", auth: "apikey" }, planner: { provider: "claude", auth: "apikey", children: { allowSpawn: true, allowedChildProfiles: ["worker"] } } } }, envs: ["docker"] }), ANTHROPIC_API_KEY: "k" }, dockerUp);
		expect(keyed.drivers[0]!.sandboxes).toEqual({ docker: { available: true, reason: null }, boxd: { available: false, reason: "No agent environment for VM yet (run `capcomd env build --sandbox boxd`)" } });
		resetDockerCheck();
	});
	test("POST /v1/runs: a driver (or the default one) that can't run in the chosen sandbox is 422 with the reason, before anything starts", async () => {
		const noLocal = { available: false, reason: "Not logged in to Claude Code for Local (run `capcomd auth login claude --sandbox docker`)" };
		const options = { ...READY, drivers: [{ ...READY.drivers[0]!, default: true, sandboxes: { ...FITS, docker: noLocal } }, READY.drivers[1]!] };
		const src = memorySource({ runOptions: options });
		const app = harnessApp({ source: src, clients: () => loadClients(cpath), state: harnessState(null) });
		const post = (body: unknown, key: string) => app.request("/v1/runs", { method: "POST", headers: { authorization: `Bearer ${steer}`, "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify(body) });
		for (const [body, key] of [[{ goal: "go", driver: "claude", sandbox: "docker" }, "key-fit-01"], [{ goal: "go", sandbox: "docker" }, "key-fit-02"]] as const) {
			const r = await post(body, key);
			expect(r.status).toBe(422);
			expect(await r.json()).toEqual({ code: "invalid", message: "Claude Code can't drive a run in Local: Not logged in to Claude Code for Local (run `capcomd auth login claude --sandbox docker`)" });
		}
		expect((await post({ goal: "go", driver: "claude", sandbox: "boxd" }, "key-fit-03")).status).toBe(201);
		expect((await post({ goal: "go", driver: "codex", sandbox: "docker" }, "key-fit-04")).status).toBe(201);
		expect((await post({ goal: "go", driver: "claude" }, "key-fit-05")).status).toBe(201); // the daemon's sandbox: `available`, checked by capcomd run
		expect(src.created.length).toBe(3);
	});
	test("capcomd env/auth --sandbox takes docker or boxd", async () => {
		const { capcomd } = require("../helpers/engine") as typeof import("../helpers/engine");
		const r = await capcomd(["env", "status", "--sandbox", "kubernetes", "--json"], { CAPCOMD_HOME: mkdtempSync(join(dir, "s-")) });
		expect(r.code).toBe(2);
		expect(JSON.parse(r.stdout.trim().split("\n").pop()!).error).toMatchObject({ code: "usage", message: expect.stringContaining("docker or boxd") });
	});
});

describe("GET /v1/run-options?repo= (capability runs.options.repo)", () => {
	// The daemon's own profiles have no planner; the project's (as `capcomd setup project` writes them) do.
	const daemon = () => world({ profiles: { schema: "capcomd.agents/v1", agents: { other: { provider: "codex", auth: "apikey" } } }, logins: ["claude-code"], envs: ["boxd"], env: { CAPCOMD_SANDBOX: "boxd", BOXD_API_KEY: "bxd_test" } });
	const project = () => {
		const d = mkdtempSync(join(dir, "proj-"));
		mkdirSync(join(d, ".capcomd"));
		writeFileSync(join(d, ".capcomd", "config.json"), JSON.stringify({ env: { CAPCOMD_REPO: "/srv/git/app.git" } }));
		writeFileSync(join(d, ".capcomd", "agents.json"), JSON.stringify(PROFILES));
		return d;
	};
	const notProject = () => mkdtempSync(join(dir, "plain-"));

	test("the project's planner profile: Claude can drive there, though the daemon has none", async () => {
		resetDockerCheck();
		const base = daemon();
		expect((await runOptions(base, dockerUp)).drivers[0]).toMatchObject({ available: false, reason: "No planner profile (run capcomd setup)" });
		const o = await runOptionsFor(project(), base, dockerUp);
		expect(RunOptions.parse(o)).toEqual(o);
		expect(o.drivers[0]).toMatchObject({ provider: "claude", model: "claude-opus-5-5", available: true, reason: null, default: true, sandboxes: { boxd: { available: true, reason: null } } });
		expect(o.drivers[1]).toMatchObject({ provider: "codex", available: false, reason: "Not logged in to Codex (run capcomd auth login codex)" });
		expect(await runOptionsFor(undefined, base, dockerUp)).toEqual(await runOptions(base, dockerUp));
		resetDockerCheck();
	});
	test("not a project: CreateRunError with POST /v1/runs's message", async () => {
		const d = notProject();
		await expect(runOptionsFor(d, daemon(), dockerUp)).rejects.toThrow(new CreateRunError(`${d} is not a capcomd project (no .capcomd/config.json in it or above it). Run \`capcomd setup project\` in it first.`));
	});
	test("over HTTP: 200 for a project, 422 invalid for a non-project or relative path; POST /v1/runs effort is checked against the body's project", async () => {
		const base = daemon();
		const src = { ...memorySource(), runOptions: (repo?: string) => runOptionsFor(repo, base, dockerUp) };
		const app = harnessApp({ source: src, clients: () => loadClients(cpath), state: harnessState(null) });
		const get = (q: string) => app.request(`/v1/run-options${q}`, { headers: { authorization: `Bearer ${reader}` } });
		const p = project();
		const ok = await get(`?repo=${encodeURIComponent(p)}`);
		expect(ok.status).toBe(200);
		expect(((await ok.json()) as any).drivers[0]).toMatchObject({ provider: "claude", available: true });
		const plain = notProject();
		const bad = await get(`?repo=${encodeURIComponent(plain)}`);
		expect(bad.status).toBe(422);
		expect(await bad.json()).toEqual({ code: "invalid", message: `${plain} is not a capcomd project (no .capcomd/config.json in it or above it). Run \`capcomd setup project\` in it first.` });
		const rel = await get("?repo=relative/path");
		expect(rel.status).toBe(422);
		expect(((await rel.json()) as any).code).toBe("invalid");
		expect((await get("")).status).toBe(200);
		expect((await (await app.request("/v1/health")).json() as any).capabilities).toEqual(expect.arrayContaining(["runs.options.repo", "runs.options.sandbox"]));

		const post = (body: unknown, key: string) => app.request("/v1/runs", { method: "POST", headers: { authorization: `Bearer ${steer}`, "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify(body) });
		expect((await post({ goal: "go", repo: p, effort: "high" }, "key-repo-eff-1")).status).toBe(201); // the project's planner (claude)
		const none = await post({ goal: "go", effort: "high" }, "key-repo-eff-2");
		expect(((await none.json()) as any).message).toContain("effort needs a driver: this daemon has no default planner profile");
		const np = await post({ goal: "go", repo: plain, effort: "high" }, "key-repo-eff-3");
		expect(np.status).toBe(422);
		expect(((await np.json()) as any).message).toContain("is not a capcomd project");
	});
	test("published: the repo query and drivers[].sandboxes", () => {
		const op = (spec as any).paths["/v1/run-options"].get;
		const repo = op.parameters.find((x: any) => x.name === "repo");
		expect(repo).toMatchObject({ in: "query", schema: { type: "string" } });
		expect(repo.required).toBeFalsy();
		const driver = op.responses["200"].content["application/json"].schema.properties.drivers.items;
		expect(driver.required).toContain("sandboxes");
		expect(Object.keys(driver.properties.sandboxes.properties)).toEqual(["docker", "boxd"]);
	});
	test("a project's own profiles win over a CAPCOMD_AGENTS_FILE the daemon has", () => {
		const p = project();
		const ctx = launchContext(p, { CAPCOMD_NO_CONFIG: "1", CAPCOMD_AGENTS_FILE: "/daemon/agents.json" });
		expect(ctx.env.CAPCOMD_AGENTS_FILE).toBeUndefined();
		expect(launchContext(notProjectWithConfig(), { CAPCOMD_NO_CONFIG: "1", CAPCOMD_AGENTS_FILE: "/daemon/agents.json" }).env.CAPCOMD_AGENTS_FILE).toBe("/daemon/agents.json");
	});
	const notProjectWithConfig = () => {
		const d = mkdtempSync(join(dir, "cfg-only-"));
		mkdirSync(join(d, ".capcomd"));
		writeFileSync(join(d, ".capcomd", "config.json"), JSON.stringify({ env: { CAPCOMD_REPO: "/srv/git/app.git" } }));
		return d;
	};
});
