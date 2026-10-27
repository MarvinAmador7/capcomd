// Capabilities logins, environments and service: GET /v1/logins, /v1/environments and /v1/service (the app's Settings
// window). Local state only: scratch ledgers per sandbox, a scratch HOME for the service file, an injected launchctl.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addClient, loadClients } from "../../src/api/clients";
import { CAPABILITY_NAMES, Environments, Logins, ServiceStatus } from "../../src/api/contract";
import { harnessApp } from "../../src/api/server";
import { memorySource } from "../../src/api/source";
import { harnessState } from "../../src/api/state";
import { environments, exitsZero, logins, resetServiceCheck, serviceState } from "../../src/api/settings";
import { envBuild } from "../../src/env/build";
import { BUILD_MARKER_MAX_MS, buildMarkerPath } from "../../src/env/resolve";
import { loadAgentConfig } from "../../src/agents/config";
import spec from "../../openapi/capcomd.json";

const dir = mkdtempSync(join(tmpdir(), "harness-settings-"));
const cpath = join(dir, "clients.json");
const reader = addClient("reader", ["read"], cpath).token;
const steerOnly = addClient("steer-only", ["steer"], cpath).token;
/** A credential-shaped value planted everywhere a careless route could pick it up. */
const PLANTED = "sk-ant-oat01-PLANTEDsecretVALUEthatMustNeverLeak0123456789";

/** A world: CAPCOMD_HOME with its own state dir (auths.json / envs.json for boxd, auths-docker.json / envs-docker.json for docker). */
function world(o: { env?: Record<string, string> } = {}) {
	const home = mkdtempSync(join(dir, "w-"));
	mkdirSync(join(home, "state"), { recursive: true });
	const env = { CAPCOMD_HOME: home, CAPCOMD_NO_CONFIG: "1", PATH: process.env.PATH ?? "", ...(o.env ?? {}) } as Record<string, string>;
	const state = (f: string) => join(home, "state", f);
	return { home, env, state };
}
const ledgerFile = (sandbox: string, base: string) => (sandbox === "boxd" ? `${base}.json` : `${base}-${sandbox}.json`);
/** A plan login as `capcomd auth login` saves it, with a planted token field a route must never echo. */
function planLogin(w: ReturnType<typeof world>, sandbox: string, agent: "claude-code" | "codex", store: "secret" | "snapshot") {
	const f = w.state(ledgerFile(sandbox, "auths"));
	const l = existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : {};
	l[agent] = { agent, store, ...(store === "snapshot" ? { snapshot: `capcomd-auth-${agent}-x` } : {}), method: agent === "codex" ? "device-auth" : "setup-token", env: "capcomd-env-x", createdAt: "2026-10-01T00:00:00.000Z", token: PLANTED };
	writeFileSync(f, JSON.stringify(l));
}
const RECORD = {
	name: "capcomd-env-2f1eed2b11c528fc",
	manifest: { schema: 1, pins: { claude: "2.1.303", codex: "0.163.0", node: "22.0.0" }, lockHash: "none", lockFile: "none", repo: `https://x:${PLANTED}@github.com/o/r.git` },
	versions: { claude: { version: "2.1.303", source: "installed" }, codex: { version: "0.163.0", source: "installed" }, node: { version: "22.23.3", source: "image" } },
	builtAt: "2026-10-24T17:30:48.532Z", buildMs: 1000, depsInstalled: false,
};
function envReady(w: ReturnType<typeof world>, sandbox: string, record = RECORD) {
	writeFileSync(w.state(ledgerFile(sandbox, "envs")), JSON.stringify({ current: record, history: [record] }));
}
function marker(w: ReturnType<typeof world>, sandbox: string, m: Record<string, unknown>) {
	writeFileSync(buildMarkerPath(w.state(ledgerFile(sandbox, "envs"))), JSON.stringify(m));
}
/** The pid of a process that has exited. */
async function deadPid(): Promise<number> {
	const p = Bun.spawn(["true"]);
	await p.exited;
	return p.pid;
}
const pick = (l: ReturnType<typeof logins>, provider: string, sandbox: string) => l.find((x) => x.provider === provider && x.sandbox === sandbox)!;

afterEach(() => resetServiceCheck());

describe("GET /v1/logins", () => {
	test("nothing: four entries in order, none logged in, each with its login command", () => {
		const l = logins(world().env);
		expect(Logins.parse({ logins: l })).toBeTruthy();
		expect(l).toEqual([
			{ provider: "claude", sandbox: "docker", loggedIn: false, how: null, detail: null, command: "capcomd auth login claude --sandbox docker" },
			{ provider: "claude", sandbox: "boxd", loggedIn: false, how: null, detail: null, command: "capcomd auth login claude --sandbox boxd" },
			{ provider: "codex", sandbox: "docker", loggedIn: false, how: null, detail: null, command: "capcomd auth login codex --sandbox docker" },
			{ provider: "codex", sandbox: "boxd", loggedIn: false, how: null, detail: null, command: "capcomd auth login codex --sandbox boxd" },
		]);
	});
	test("a plan login in the docker ledger only: logged in for docker, not for boxd", () => {
		const w = world();
		planLogin(w, "docker", "claude-code", "snapshot");
		const l = logins(w.env);
		expect(pick(l, "claude", "docker")).toEqual({ provider: "claude", sandbox: "docker", loggedIn: true, how: "plan", detail: "Saved in the agent environment", command: "capcomd auth login claude --sandbox docker" });
		expect(pick(l, "claude", "boxd")).toMatchObject({ loggedIn: false, how: null, detail: null });
		expect(pick(l, "codex", "docker").loggedIn).toBe(false);
	});
	test("a plan login in the boxd ledger only: a boxd secret bound to the provider's API host", () => {
		const w = world();
		planLogin(w, "boxd", "claude-code", "secret");
		planLogin(w, "boxd", "codex", "snapshot");
		const l = logins(w.env);
		expect(pick(l, "claude", "boxd")).toEqual({ provider: "claude", sandbox: "boxd", loggedIn: true, how: "plan", detail: "Kept as a boxd secret bound to api.anthropic.com", command: "capcomd auth login claude --sandbox boxd" });
		expect(pick(l, "codex", "boxd")).toMatchObject({ loggedIn: true, how: "plan", detail: "Saved in the agent environment" });
		expect(pick(l, "claude", "docker").loggedIn).toBe(false);
		expect(pick(l, "codex", "docker").loggedIn).toBe(false);
	});
	test("an API key set for the daemon: logged in with a key in both sandboxes, that provider only", () => {
		const l = logins(world({ env: { ANTHROPIC_API_KEY: PLANTED } }).env);
		for (const s of ["docker", "boxd"]) expect(pick(l, "claude", s)).toMatchObject({ loggedIn: true, how: "api_key", detail: "ANTHROPIC_API_KEY is set for capcomd" });
		for (const s of ["docker", "boxd"]) expect(pick(l, "codex", s).loggedIn).toBe(false);
		expect(JSON.stringify(l)).not.toContain(PLANTED);
		expect(pick(logins(world({ env: { OPENAI_API_KEY: "sk-proj-x" } }).env), "codex", "docker")).toMatchObject({ how: "api_key", detail: "OPENAI_API_KEY is set for capcomd" });
	});
	test("a plan login wins over a key; a blank key is no key", () => {
		const w = world({ env: { ANTHROPIC_API_KEY: PLANTED } });
		planLogin(w, "docker", "claude-code", "snapshot");
		const l = logins(w.env);
		expect(pick(l, "claude", "docker").how).toBe("plan");
		expect(pick(l, "claude", "boxd").how).toBe("api_key");
		expect(pick(logins(world({ env: { ANTHROPIC_API_KEY: "  " } }).env), "claude", "docker").loggedIn).toBe(false);
	});
	test("CAPCOMD_CREDENTIALS=secret: keys kept as boxd secrets count for boxd only", () => {
		const l = logins(world({ env: { CAPCOMD_CREDENTIALS: "secret" } }).env);
		expect(pick(l, "claude", "boxd")).toMatchObject({ loggedIn: true, how: "api_key", detail: "Kept as a boxd secret bound to api.anthropic.com" });
		expect(pick(l, "codex", "boxd")).toMatchObject({ loggedIn: true, how: "api_key", detail: "Kept as a boxd secret bound to api.openai.com" });
		expect(pick(l, "claude", "docker").loggedIn).toBe(false);
	});
	test("the daemon's own CAPCOMD_SANDBOX doesn't change which ledger each entry reads", () => {
		const w = world({ env: { CAPCOMD_SANDBOX: "docker" } });
		planLogin(w, "boxd", "claude-code", "secret");
		expect(pick(logins(w.env), "claude", "boxd").loggedIn).toBe(true);
		expect(pick(logins(w.env), "claude", "docker").loggedIn).toBe(false);
	});
});

describe("GET /v1/environments", () => {
	test("missing everywhere: docker then boxd, with the build command", () => {
		const e = environments(world().env);
		expect(Environments.parse({ environments: e })).toBeTruthy();
		expect(e).toEqual([
			{ sandbox: "docker", status: "missing", name: null, versions: {}, builtAt: null, command: "capcomd env build --sandbox docker" },
			{ sandbox: "boxd", status: "missing", name: null, versions: {}, builtAt: null, command: "capcomd env build --sandbox boxd" },
		]);
	});
	test("ready in boxd: the snapshot, its versions (found or installed, else pinned) and when it was built", () => {
		const w = world();
		envReady(w, "boxd");
		const [docker, boxd] = environments(w.env);
		expect(docker).toMatchObject({ sandbox: "docker", status: "missing", name: null });
		expect(boxd).toEqual({ sandbox: "boxd", status: "ready", name: "capcomd-env-2f1eed2b11c528fc", versions: { claude: "2.1.303", codex: "0.163.0", node: "22.23.3" }, builtAt: "2026-10-24T17:30:48.532Z", command: "capcomd env build --sandbox boxd" });
		// A reused snapshot's record has no versions: its pins.
		const w2 = world();
		envReady(w2, "docker", { ...RECORD, versions: {} as any, builtAt: "garbage" });
		expect(environments(w2.env)[0]).toMatchObject({ status: "ready", versions: { claude: "2.1.303", codex: "0.163.0", node: "22.0.0" }, builtAt: null });
	});
	test("building while a build's marker names a live process", () => {
		const w = world();
		marker(w, "docker", { state: "building", pid: process.pid, startedAt: new Date().toISOString() });
		expect(environments(w.env)[0]!.status).toBe("building");
		expect(environments(w.env)[1]!.status).toBe("missing");
		// Over a ready environment too: a rebuild in progress.
		envReady(w, "docker");
		expect(environments(w.env)[0]).toMatchObject({ status: "building", name: RECORD.name });
	});
	test("a stale marker (its process gone, or implausibly old) is not building", async () => {
		const w = world();
		marker(w, "docker", { state: "building", pid: await deadPid(), startedAt: new Date().toISOString() });
		expect(environments(w.env)[0]!.status).toBe("missing");
		envReady(w, "docker");
		expect(environments(w.env)[0]!.status).toBe("ready");
		marker(w, "boxd", { state: "building", pid: process.pid, startedAt: new Date(Date.now() - BUILD_MARKER_MAX_MS - 60_000).toISOString() });
		expect(environments(w.env)[1]!.status).toBe("missing");
		marker(w, "boxd", { state: "building", pid: "x", startedAt: 1 });
		expect(environments(w.env)[1]!.status).toBe("missing");
	});
	test("failed when the last build failed; the environment agents use is still named", () => {
		const w = world();
		marker(w, "boxd", { state: "failed", pid: 1, startedAt: "2026-10-27T10:00:00.000Z", endedAt: "2026-10-27T10:01:00.000Z" });
		expect(environments(w.env)[1]).toMatchObject({ status: "failed", name: null });
		envReady(w, "boxd");
		expect(environments(w.env)[1]).toMatchObject({ status: "failed", name: RECORD.name, builtAt: RECORD.builtAt });
	});
	test("env build writes the marker while it runs, removes it when it succeeds, and records a failure", async () => {
		const w = world({ env: { CAPCOMD_SANDBOX: "docker" } });
		const ledger = w.state("envs-docker.json");
		const cfg = loadAgentConfig({ CAPCOMD_AGENT_WORKDIR: w.home });
		let release!: (v: unknown) => void;
		const gate = new Promise((r) => { release = r; });
		// A provider whose snapshot lookup waits for the test, then says the snapshot exists (a cached build).
		const ok = { snapshotGet: async (name: string) => { await gate; return { name, status: "ready" }; } } as any;
		const run = envBuild(ok, { cfg, ledgerPath: ledger });
		await Bun.sleep(10);
		expect(JSON.parse(readFileSync(buildMarkerPath(ledger), "utf8"))).toMatchObject({ state: "building", pid: process.pid });
		expect(environments(w.env)[0]!.status).toBe("building");
		release(null);
		await run;
		expect(existsSync(buildMarkerPath(ledger))).toBe(false);
		expect(environments(w.env)[0]!.status).toBe("ready");
		// A build that throws leaves a failed record; the next good build clears it.
		const bad = { snapshotGet: async () => null, ensure: async () => { throw new Error("no capacity"); } } as any;
		await expect(envBuild(bad, { cfg, ledgerPath: ledger })).rejects.toThrow("no capacity");
		expect(JSON.parse(readFileSync(buildMarkerPath(ledger), "utf8"))).toMatchObject({ state: "failed", pid: process.pid });
		expect(environments(w.env)[0]!.status).toBe("failed");
		await envBuild({ snapshotGet: async (name: string) => ({ name, status: "ready" }) } as any, { cfg, ledgerPath: ledger });
		expect(environments(w.env)[0]!.status).toBe("ready");
	});
});

const plist = (home: string) => join(home, "Library", "LaunchAgents", "dev.capcomd.engine.plist");
describe("GET /v1/service", () => {
	test("not installed: no service file, launchctl never asked", async () => {
		let asked = 0;
		const s = await serviceState({ home: world().home, platform: "darwin", probe: async () => { asked++; return true; } });
		expect(ServiceStatus.parse(s)).toEqual({ installed: false, loaded: false, installCommand: "capcomd service install", uninstallCommand: "capcomd service uninstall" });
		expect(asked).toBe(0);
	});
	test("installed: the launchd plist, loaded as launchctl says (asked at most every few seconds)", async () => {
		const home = world().home;
		mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
		writeFileSync(plist(home), "<plist/>");
		let asked = 0;
		const probe = async (p: NodeJS.Platform) => { asked++; expect(p).toBe("darwin"); return true; };
		expect(await serviceState({ home, platform: "darwin", probe })).toEqual({ installed: true, loaded: true, installCommand: "capcomd service install", uninstallCommand: "capcomd service uninstall" });
		expect(await serviceState({ home, platform: "darwin", probe })).toMatchObject({ loaded: true });
		expect(asked).toBe(1);
		resetServiceCheck();
		expect(await serviceState({ home, platform: "darwin", probe: async () => false })).toMatchObject({ installed: true, loaded: false });
		resetServiceCheck();
		expect(await serviceState({ home, platform: "darwin", probe: async () => { throw new Error("launchctl"); } })).toMatchObject({ installed: true, loaded: false });
	});
	test("linux: the systemd user unit; other platforms: no service", async () => {
		const home = world().home;
		mkdirSync(join(home, ".config", "systemd", "user"), { recursive: true });
		writeFileSync(join(home, ".config", "systemd", "user", "capcomd-engine.service"), "[Unit]");
		expect(await serviceState({ home, platform: "linux", probe: async () => true })).toMatchObject({ installed: true, loaded: true });
		expect(await serviceState({ home, platform: "darwin", probe: async () => true })).toMatchObject({ installed: false, loaded: false });
		expect(await serviceState({ home, platform: "win32", probe: async () => true })).toMatchObject({ installed: false, loaded: false });
	});
	test("a probe that hangs is cut off within its time box", async () => {
		const t = Date.now();
		expect(await exitsZero(["sleep", "5"], 200)).toBe(false);
		expect(Date.now() - t).toBeLessThan(2_000);
		expect(await exitsZero(["true"], 1_000)).toBe(true);
		expect(await exitsZero(["/nonexistent/capcomd-probe"], 1_000)).toBe(false);
	});
});

describe("the routes", () => {
	const ROUTES = ["/v1/logins", "/v1/environments", "/v1/service"];
	test("published and advertised as capabilities", () => {
		expect(CAPABILITY_NAMES).toEqual(expect.arrayContaining(["logins", "environments", "service"]));
		for (const p of ROUTES) expect((spec as any).paths[p]?.get).toBeTruthy();
		const login = (spec as any).paths["/v1/logins"].get.responses["200"].content["application/json"].schema.properties.logins.items;
		expect(login.required).toEqual(["provider", "sandbox", "loggedIn", "how", "detail", "command"]);
		expect(login.properties.how.enum).toEqual(["plan", "api_key", null]);
		const env = (spec as any).paths["/v1/environments"].get.responses["200"].content["application/json"].schema.properties.environments.items;
		expect(env.required).toEqual(["sandbox", "status", "name", "versions", "builtAt", "command"]);
		expect(env.properties.status.enum).toEqual(["ready", "missing", "building", "failed"]);
		expect((spec as any).paths["/v1/service"].get.responses["200"].content["application/json"].schema.required).toEqual(["installed", "loaded", "installCommand", "uninstallCommand"]);
	});
	test("need the read scope: 401 without a token, 403 without read", async () => {
		const app = harnessApp({ source: memorySource(), clients: () => loadClients(cpath), state: harnessState(null) });
		for (const p of ROUTES) {
			const none = await app.request(p);
			expect(none.status).toBe(401);
			expect(((await none.json()) as any).code).toBe("unauthorized");
			const steer = await app.request(p, { headers: { authorization: `Bearer ${steerOnly}` } });
			expect(steer.status).toBe(403);
			expect(((await steer.json()) as any).code).toBe("forbidden");
			expect((await app.request(p, { headers: { authorization: `Bearer ${reader}` } })).status).toBe(200);
		}
	});
	test("memory source defaults: logged out, no environment, no service", async () => {
		const app = harnessApp({ source: memorySource(), clients: () => loadClients(cpath), state: harnessState(null) });
		const get = async (p: string) => (await app.request(p, { headers: { authorization: `Bearer ${reader}` } })).json() as Promise<any>;
		expect((await get("/v1/logins")).logins.map((l: any) => [l.provider, l.sandbox, l.loggedIn])).toEqual([["claude", "docker", false], ["claude", "boxd", false], ["codex", "docker", false], ["codex", "boxd", false]]);
		expect((await get("/v1/environments")).environments.map((e: any) => [e.sandbox, e.status])).toEqual([["docker", "missing"], ["boxd", "missing"]]);
		expect(await get("/v1/service")).toEqual({ installed: false, loaded: false, installCommand: "capcomd service install", uninstallCommand: "capcomd service uninstall" });
	});
	test("the real readers over HTTP: what a Settings window gets, and no secret anywhere in it", async () => {
		const w = world({ env: { ANTHROPIC_API_KEY: PLANTED, OPENAI_API_KEY: PLANTED, CLAUDE_CODE_OAUTH_TOKEN: PLANTED, BOXD_API_KEY: PLANTED } });
		planLogin(w, "boxd", "claude-code", "secret");
		planLogin(w, "docker", "codex", "snapshot");
		envReady(w, "boxd");
		marker(w, "docker", { state: "failed", pid: 1, startedAt: "2026-10-27T10:00:00.000Z", endedAt: "2026-10-27T10:01:00.000Z", reason: PLANTED });
		mkdirSync(join(w.home, "Library", "LaunchAgents"), { recursive: true });
		writeFileSync(plist(w.home), `<plist>${PLANTED}</plist>`);
		const src = { ...memorySource(), logins: async () => logins(w.env), environments: async () => environments(w.env), service: () => serviceState({ home: w.home, platform: "darwin", probe: async () => true }) };
		const app = harnessApp({ source: src, clients: () => loadClients(cpath), state: harnessState(null) });
		const bodies: Record<string, any> = {};
		for (const p of ROUTES) {
			const r = await app.request(p, { headers: { authorization: `Bearer ${reader}` } });
			expect(r.status).toBe(200);
			const text = await r.text();
			expect(text).not.toContain(PLANTED);
			expect(text).not.toContain("PLANTED");
			bodies[p] = JSON.parse(text);
		}
		expect(bodies["/v1/logins"]).toEqual({ logins: [
			{ provider: "claude", sandbox: "docker", loggedIn: true, how: "api_key", detail: "ANTHROPIC_API_KEY is set for capcomd", command: "capcomd auth login claude --sandbox docker" },
			{ provider: "claude", sandbox: "boxd", loggedIn: true, how: "plan", detail: "Kept as a boxd secret bound to api.anthropic.com", command: "capcomd auth login claude --sandbox boxd" },
			{ provider: "codex", sandbox: "docker", loggedIn: true, how: "plan", detail: "Saved in the agent environment", command: "capcomd auth login codex --sandbox docker" },
			{ provider: "codex", sandbox: "boxd", loggedIn: true, how: "api_key", detail: "OPENAI_API_KEY is set for capcomd", command: "capcomd auth login codex --sandbox boxd" },
		] });
		expect(bodies["/v1/environments"]).toEqual({ environments: [
			{ sandbox: "docker", status: "failed", name: null, versions: {}, builtAt: null, command: "capcomd env build --sandbox docker" },
			{ sandbox: "boxd", status: "ready", name: "capcomd-env-2f1eed2b11c528fc", versions: { claude: "2.1.303", codex: "0.163.0", node: "22.23.3" }, builtAt: "2026-10-24T17:30:48.532Z", command: "capcomd env build --sandbox boxd" },
		] });
		expect(bodies["/v1/service"]).toEqual({ installed: true, loaded: true, installCommand: "capcomd service install", uninstallCommand: "capcomd service uninstall" });
	});
});
