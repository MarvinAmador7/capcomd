// ADR-021 phase 1 (capabilities sandboxes, sandboxes.resources): GET /v1/sandboxes, /v1/sandboxes/{name},
// …/resources and …/resources/{id}; logins' hostBound/boundTo; ?sandbox= on /v1/logins and /v1/environments. Engine-free:
// the memory source with injected provider lists and machine owners, and a fake clock for the list cache.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addClient, loadClients } from "../../src/api/clients";
import { CAPABILITY_NAMES, ResourceDetail, ResourcePage, SandboxDetail, Sandboxes } from "../../src/api/contract";
import { harnessApp } from "../../src/api/server";
import { memorySource } from "../../src/api/source";
import { harnessState } from "../../src/api/state";
import { checkpointsField, durationLabel, joinResources, loginsField, resourceCatalog, taskLine, terminalCommandFor, type MachineOwner } from "../../src/api/sandboxes";
import { logins } from "../../src/api/settings";
import { SandboxConfigError } from "../../src/providers/boxd-errors";
import type { VmInfo } from "../../src/providers/sandbox";
import spec from "../../openapi/capcomd.json";

const dir = mkdtempSync(join(tmpdir(), "harness-sandboxes-"));
const cpath = join(dir, "clients.json");
const reader = addClient("reader", ["read"], cpath).token;
const steerOnly = addClient("steer-only", ["steer"], cpath).token;
/** A credential-shaped value planted wherever a careless route could pick it up. */
const PLANTED = "sk-ant-oat01-PLANTEDsecretVALUEthatMustNeverLeak0123456789";

/**
 * The app's rule for commands it runs in Terminal (apps/menubar/app/Sources/CapcomdStore/Settings.swift
 * `isSafeCommand`), ported word for word: optional CAPCOMD_*=value assignments, then `capcomd` and words of ASCII
 * letters, digits and `._/=,:@+-`; at most 300 characters.
 */
function isSafeCommand(c: string): boolean {
	const words = c.split(" ");
	if (!words.length || [...c].length > 300) return false;
	const word = (w: string) => w.length > 0 && [...w].every((ch) => /^[A-Za-z0-9]$/.test(ch) || "._/=,:@+-".includes(ch));
	const assignment = (w: string) => {
		if (!w.startsWith("CAPCOMD_")) return false;
		const eq = w.indexOf("=");
		if (eq < 0) return false;
		return [...w.slice(0, eq)].every((ch) => /^[A-Z0-9_]$/.test(ch)) && word(w.slice(eq + 1));
	};
	let i = 0;
	while (i < words.length && assignment(words[i]!)) i++;
	if (i >= words.length || words[i] !== "capcomd") return false;
	return words.slice(i + 1).every(word);
}

const at = (iso: string) => Date.parse(iso);
const BOXD_ROWS: VmInfo[] = [
	{ id: "m_1", name: "relay-3f9c2a1b7e5d4c60", state: "running", createdAt: at("2026-10-27T09:12:03.000Z"), deleteAt: at("2026-10-27T10:22:03.000Z") },
	{ id: "m_2", name: "relay-0a0b0c0d0e0f1011", state: "running", createdAt: at("2026-10-27T07:00:00.000Z"), deleteAt: at("2026-10-27T08:00:00.000Z") },
	// Rows a careless join could trust: another prefix, and a name built to break out of a shell command.
	{ id: "m_3", name: "someone-elses-machine", state: "running" },
	{ id: "m_4", name: "relay-x;rm -rf ~", state: "running" },
];
const OWNER: MachineOwner = { sandbox: "boxd", vmId: "m_1", name: "relay-3f9c2a1b7e5d4c60", runId: "run-8kq2", agentId: "agt-41", role: "worker", task: taskLine(`Add an abs(a) function to math.ts with ${PLANTED}\nand tests`), workerState: "busy", createdAt: at("2026-10-27T09:12:00.000Z") };

function setup(seed: Parameters<typeof memorySource>[0] = {}) {
	const src = memorySource({ machines: { boxd: BOXD_ROWS }, owners: [OWNER], ...seed });
	const app = harnessApp({ source: src, clients: () => loadClients(cpath), state: harnessState(null) });
	const get = async (p: string, token = reader) => { const r = await app.request(p, { headers: { authorization: `Bearer ${token}` } }); return { status: r.status, text: await r.clone().text(), body: (await r.json()) as any }; };
	return { app, src, get };
}

describe("GET /v1/sandboxes (capability sandboxes)", () => {
	test("advertised, published, and every listed place as its descriptor with availability", async () => {
		expect(CAPABILITY_NAMES).toEqual(expect.arrayContaining(["sandboxes", "sandboxes.resources"]));
		for (const p of ["/v1/sandboxes", "/v1/sandboxes/{name}", "/v1/sandboxes/{name}/resources", "/v1/sandboxes/{name}/resources/{id}"]) expect((spec as any).paths[p]?.get).toBeTruthy();
		const { get } = setup();
		const r = await get("/v1/sandboxes");
		expect(r.status).toBe(200);
		expect(Sandboxes.parse(r.body)).toBeTruthy();
		expect(r.body).toEqual({ sandboxes: [
			{ name: "docker", descriptorVersion: 1, label: "Local", kind: "local", vendor: "Docker", title: "Local · Docker", mark: "docker", listed: true,
				caps: { isolation: "container", snapshots: true, hostBoundSecrets: false, egressAllowlist: false, interactive: true, idleLifetime: "sweep", shell: true },
				settings: ["idleLifetime"], info: ["logins", "checkpoints"], resourceKinds: ["machine"], actions: ["open_terminal"], available: false, reason: "Docker isn't running", default: false },
			{ name: "boxd", descriptorVersion: 1, label: "Cloud", kind: "cloud", vendor: "boxd", title: "Cloud · boxd", mark: "boxd", listed: true,
				caps: { isolation: "vm", snapshots: true, hostBoundSecrets: true, egressAllowlist: true, interactive: true, idleLifetime: "platform", shell: true },
				settings: ["idleLifetime"], info: ["logins", "checkpoints"], resourceKinds: ["machine"], actions: ["open_terminal"], available: false, reason: "No boxd API key (run capcomd setup)", default: false },
		] });
	});
	test("availability and the default follow GET /v1/run-options", async () => {
		const ro = await memorySource().runOptions();
		ro.sandboxes = ro.sandboxes.map((s) => (s.name === "boxd" ? { ...s, available: true, reason: null, default: true } : s));
		const { get } = setup({ runOptions: ro });
		expect((await get("/v1/sandboxes")).body.sandboxes.map((s: any) => [s.name, s.available, s.reason, s.default])).toEqual([["docker", false, "Docker isn't running", false], ["boxd", true, null, true]]);
	});
});

describe("GET /v1/sandboxes/{name}", () => {
	test("boxd: the descriptor, the idle lifetime at its real value (editable: sandboxes.settings), logins and checkpoints", async () => {
		const { get } = setup();
		const r = await get("/v1/sandboxes/boxd");
		expect(r.status).toBe(200);
		expect(SandboxDetail.parse(r.body)).toBeTruthy();
		expect(r.body.descriptor).toMatchObject({ name: "boxd", title: "Cloud · boxd", actions: ["open_terminal"] });
		expect(r.body.settings).toEqual([{
			id: "idleLifetime", type: "choice", label: "Delete idle machines after",
			help: "A machine left behind (a crash, a stopped run) is deleted after this, so it stops billing.",
			value: "3600", display: "1 hour", default: "3600",
			choices: [{ value: "900", label: "15 minutes" }, { value: "3600", label: "1 hour" }, { value: "14400", label: "4 hours" }, { value: "43200", label: "12 hours" }],
			source: "default", editable: true, appliesTo: "new_runs", needsRestart: false, state: null,
		}]);
		expect(r.body.info).toEqual([
			{ id: "logins", type: "info", label: "Logins", help: "A bound login is swapped in on the way to its AI's API, so agents only ever see a placeholder. Plan logins kept in the agent environment aren't bound.",
				value: "none", display: "No logins yet", default: null, choices: [], source: "daemon", editable: false, appliesTo: null, needsRestart: false, state: null },
			{ id: "checkpoints", type: "info", label: "Checkpoints", help: "Agents save their work to a git checkpoint as they go, so a machine that's lost costs at most the work since the last one.",
				value: "600000", display: "After each commit and every 10 minutes", default: null, choices: [], source: "daemon", editable: false, appliesTo: null, needsRestart: false, state: null },
		]);
		expect(r.body.rev).toMatch(/^[0-9a-f]{16}$/);
		expect((await get("/v1/sandboxes/boxd?v=1")).body.rev).toBe(r.body.rev);
	});
	test("docker: its idle lifetime help says the sweep can run up to 5 minutes over", async () => {
		const { get } = setup();
		const r = await get("/v1/sandboxes/docker");
		expect(r.body.settings[0]).toMatchObject({ id: "idleLifetime", value: "3600", display: "1 hour", editable: true });
		expect(r.body.settings[0].help).toContain("up to 5 minutes over");
		expect(r.body.info.map((f: any) => f.id)).toEqual(["logins", "checkpoints"]);
	});
	test("a place clients don't see, or none at all: 404 not_found", async () => {
		const { get } = setup();
		for (const n of ["fake", "fake-host", "nope", "..", "boxd%3Bx"]) {
			const r = await get(`/v1/sandboxes/${n}`);
			expect(r.status).toBe(404);
			expect(r.body.code).toBe("not_found");
		}
	});
	test("the Logins row: Bound only when every logged-in login here is bound, else which aren't", () => {
		const L = (provider: "claude" | "codex", sandbox: string, loggedIn: boolean, hostBound: boolean) => ({ provider, sandbox, loggedIn, hostBound });
		expect(loginsField("boxd", [L("claude", "boxd", true, true), L("codex", "boxd", false, false), L("codex", "docker", true, false)])).toMatchObject({ value: "bound", display: "Bound" });
		expect(loginsField("boxd", [L("claude", "boxd", true, true), L("codex", "boxd", true, false)])).toMatchObject({ value: "partial", display: "Codex isn't bound to its API host" });
		expect(loginsField("docker", [L("claude", "docker", true, false), L("codex", "docker", true, false)])).toMatchObject({ value: "unbound", display: "Claude Code and Codex aren't bound to their API host" });
		expect(loginsField("docker", [L("claude", "boxd", true, true)])).toMatchObject({ value: "none", display: "No logins yet" });
	});
	test("checkpoints follow CAPCOMD_AGENT_CHECKPOINT_MS; durations read as people say them", () => {
		expect(checkpointsField({}).display).toBe("After each commit and every 10 minutes");
		expect(checkpointsField({ CAPCOMD_AGENT_CHECKPOINT_MS: "60000" }).display).toBe("After each commit and every minute");
		expect(checkpointsField({ CAPCOMD_AGENT_CHECKPOINT_MS: "3600000" }).display).toBe("After each commit and every hour");
		expect(checkpointsField({ CAPCOMD_AGENT_CHECKPOINT_MS: "90000" }).display).toBe("After each commit and every 90 seconds");
		expect(checkpointsField({ CAPCOMD_AGENT_CHECKPOINT_MS: "0" })).toMatchObject({ value: "0", display: "After each commit" });
		expect(checkpointsField({ CAPCOMD_AGENT_CHECKPOINT_MS: "nonsense" }).value).toBe("600000");
		expect([900, 3600, 14400, 43200].map(durationLabel)).toEqual(["15 minutes", "1 hour", "4 hours", "12 hours"]);
	});
});

describe("logins and environments by place (?sandbox=)", () => {
	test("hostBound/boundTo where the login is a host-bound secret, and one place's rows", async () => {
		const home = mkdtempSync(join(dir, "w-"));
		mkdirSync(join(home, "state"), { recursive: true });
		writeFileSync(join(home, "state", "auths.json"), JSON.stringify({ "claude-code": { agent: "claude-code", store: "secret", method: "setup-token", env: "e", createdAt: "2026-10-01T00:00:00.000Z", token: PLANTED } }));
		const env = { CAPCOMD_HOME: home, CAPCOMD_NO_CONFIG: "1", OPENAI_API_KEY: PLANTED, PATH: process.env.PATH ?? "" };
		const all = logins(env);
		const { get } = setup({ logins: all });
		const r = await get("/v1/logins?sandbox=boxd");
		expect(r.status).toBe(200);
		expect(r.text).not.toContain("PLANTED");
		expect(r.body).toEqual({ logins: [
			{ provider: "claude", sandbox: "boxd", loggedIn: true, how: "plan", detail: "Kept as a boxd secret bound to api.anthropic.com", hostBound: true, boundTo: "api.anthropic.com", command: "capcomd auth login claude --sandbox boxd" },
			{ provider: "codex", sandbox: "boxd", loggedIn: true, how: "api_key", detail: "OPENAI_API_KEY is set for capcomd", hostBound: false, boundTo: null, command: "capcomd auth login codex --sandbox boxd" },
		] });
		expect(logins({ CAPCOMD_NO_CONFIG: "1", CAPCOMD_HOME: home, CAPCOMD_CREDENTIALS: "secret" }, "boxd").find((l) => l.provider === "codex")).toMatchObject({ how: "api_key", hostBound: true, boundTo: "api.openai.com" });
		// The details screen's Logins row summarizes the same rows: one source per fact.
		expect((await get("/v1/sandboxes/boxd")).body.info[0]).toMatchObject({ value: "partial", display: "Codex isn't bound to its API host" });
		expect((await get("/v1/logins")).body.logins).toHaveLength(4);
		expect((await get("/v1/environments?sandbox=docker")).body.environments.map((e: any) => e.sandbox)).toEqual(["docker"]);
		for (const p of ["/v1/logins?sandbox=fake", "/v1/environments?sandbox=nope"]) expect((await get(p)).status).toBe(404);
	});
});

describe("GET /v1/sandboxes/{name}/resources (capability sandboxes.resources)", () => {
	test("capcomd's records joined with the provider's list: an agent's machine, an orphan, and nothing else", async () => {
		const { get } = setup();
		const r = await get("/v1/sandboxes/boxd/resources");
		expect(r.status).toBe(200);
		expect(ResourcePage.parse(r.body)).toBeTruthy();
		expect(r.body).toEqual({
			resources: [
				{ id: "relay-0a0b0c0d0e0f1011", kind: "machine", state: "orphaned", owner: null, createdAt: "2026-10-27T07:00:00.000Z", deleteAfter: "2026-10-27T08:00:00.000Z", actions: ["open_terminal"] },
				{ id: "relay-3f9c2a1b7e5d4c60", kind: "machine", state: "running", owner: { kind: "agent", runId: "run-8kq2", agentId: "agt-41", role: "worker", task: "Add an abs(a) function to math.ts with [REDACTED]", label: null },
					createdAt: "2026-10-27T09:12:03.000Z", deleteAfter: "2026-10-27T10:22:03.000Z", actions: ["open_terminal"] },
			],
			asOf: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/), stale: false, error: null, next: null,
		});
		expect(r.text).not.toContain("PLANTED");
		expect(r.text).not.toContain("someone-elses-machine");
		expect(r.text).not.toContain("rm -rf");
		expect((await get("/v1/sandboxes/docker/resources")).body).toMatchObject({ resources: [], stale: false, error: null, next: null });
		expect((await get("/v1/sandboxes/fake/resources")).status).toBe(404);
	});
	test("one machine with its terminal command; ids capcomd doesn't list are 404", async () => {
		const { get } = setup();
		const own = await get("/v1/sandboxes/boxd/resources/relay-3f9c2a1b7e5d4c60");
		expect(own.status).toBe(200);
		expect(ResourceDetail.parse(own.body)).toBeTruthy();
		expect(own.body).toMatchObject({ id: "relay-3f9c2a1b7e5d4c60", state: "running", owner: { runId: "run-8kq2", agentId: "agt-41" }, terminalCommand: "capcomd sandbox shell run-8kq2 agt-41" });
		const orphan = await get("/v1/sandboxes/boxd/resources/relay-0a0b0c0d0e0f1011");
		expect(orphan.body).toMatchObject({ state: "orphaned", owner: null, terminalCommand: "capcomd sandbox shell --sandbox boxd --machine relay-0a0b0c0d0e0f1011" });
		for (const id of ["someone-elses-machine", "relay-ffffffffffffffff", "m_1", encodeURIComponent("relay-x;rm -rf ~")]) expect((await get(`/v1/sandboxes/boxd/resources/${id}`)).status).toBe(404);
		expect((await get("/v1/sandboxes/docker/resources/relay-3f9c2a1b7e5d4c60")).status).toBe(404);
	});
	test("paging: limit and cursor walk the list by id", async () => {
		const rows: VmInfo[] = Array.from({ length: 5 }, (_, i) => ({ id: `v${i}`, name: `relay-${String(i).padStart(16, "0")}`, state: "running" }));
		const { get } = setup({ machines: { docker: rows }, owners: [] });
		const p1 = (await get("/v1/sandboxes/docker/resources?limit=2")).body;
		expect(p1.resources.map((r: any) => r.id)).toEqual(["relay-0000000000000000", "relay-0000000000000001"]);
		expect(p1.next).toBe("relay-0000000000000001");
		const p2 = (await get(`/v1/sandboxes/docker/resources?limit=2&cursor=${p1.next}`)).body;
		expect(p2.resources.map((r: any) => r.id)).toEqual(["relay-0000000000000002", "relay-0000000000000003"]);
		const p3 = (await get(`/v1/sandboxes/docker/resources?limit=2&cursor=${p2.next}`)).body;
		expect(p3).toMatchObject({ next: null });
		expect(p3.resources.map((r: any) => r.state)).toEqual(["orphaned"]);
		expect((await get("/v1/sandboxes/docker/resources?limit=201")).status).toBe(422);
	});
	test("terminal commands pass the app's safe-command rule, and are built only from trusted ids", () => {
		const rows: VmInfo[] = [...BOXD_ROWS, { id: "m_5", name: "relay-$(touch pwned)", state: "running" }, { id: "m_6", name: "relay-a b", state: "running" }];
		const hostileOwner: MachineOwner = { ...OWNER, vmId: "m_2", name: "relay-0a0b0c0d0e0f1011", runId: "run-1; rm -rf /", agentId: "agt-`id`" };
		const res = joinResources("boxd", rows, [OWNER, hostileOwner]);
		expect(res.map((r) => r.id)).toEqual(["relay-0a0b0c0d0e0f1011", "relay-3f9c2a1b7e5d4c60"]);
		const cmds = res.map((r) => terminalCommandFor("boxd", r));
		// An owner whose ids aren't safe falls back to the machine form: its id was checked against capcomd's prefix.
		expect(cmds).toEqual(["capcomd sandbox shell --sandbox boxd --machine relay-0a0b0c0d0e0f1011", "capcomd sandbox shell run-8kq2 agt-41"]);
		for (const c of cmds) expect(isSafeCommand(c!)).toBe(true);
		// The port itself refuses what the app refuses.
		for (const bad of ["capcomd sandbox shell 'x'", "capcomd x; rm", "capcomd $(id)", "capcomd a > b", "PATH=/tmp capcomd x", "capcomdx", "capcomd  x"]) expect(isSafeCommand(bad)).toBe(false);
		expect(isSafeCommand("CAPCOMD_SANDBOX=boxd capcomd env build --sandbox boxd")).toBe(true);
		// No shell action, no command.
		expect(terminalCommandFor("boxd", { ...res[0]!, actions: [] })).toBeNull();
		expect(terminalCommandFor("fake", res[0]!)).toBeNull();
	});
	test("states: starting while the worker provisions, stopping while it drains, unknown when records can't be read", () => {
		const rows: VmInfo[] = [{ id: "m_1", name: "relay-3f9c2a1b7e5d4c60", state: "running" }, { id: "m_2", name: "relay-0a0b0c0d0e0f1011", state: "removing" }];
		expect(joinResources("boxd", rows, [{ ...OWNER, workerState: "draining" }]).map((r) => [r.id, r.state, r.actions])).toEqual([["relay-0a0b0c0d0e0f1011", "stopping", []], ["relay-3f9c2a1b7e5d4c60", "stopping", []]]);
		// Provisioning and not listed yet: starting, from capcomd's records alone.
		expect(joinResources("boxd", [], [{ ...OWNER, workerState: "provisioning" }]).map((r) => [r.id, r.state])).toEqual([["relay-3f9c2a1b7e5d4c60", "starting"]]);
		// The provider listed and an owned machine isn't there: it's gone.
		expect(joinResources("boxd", [], [OWNER])).toEqual([]);
		// No list at all (the provider never answered): owned machines as unknown.
		expect(joinResources("boxd", null, [OWNER]).map((r) => [r.id, r.state, r.owner?.agentId])).toEqual([["relay-3f9c2a1b7e5d4c60", "unknown", "agt-41"]]);
		// capcomd's records unreadable: nothing is called orphaned.
		expect(joinResources("boxd", rows.slice(0, 1), null).map((r) => r.state)).toEqual(["unknown"]);
		// Another place's owner doesn't claim this place's machine.
		expect(joinResources("docker", [{ id: "m_1", name: "relay-3f9c2a1b7e5d4c60", state: "running" }], [OWNER]).map((r) => r.state)).toEqual(["orphaned"]);
		expect(joinResources("boxd", [{ id: "x", name: "relay-3f9c2a1b7e5d4c60", state: "running" }], [OWNER])[0]!.owner?.agentId).toBe("agt-41");
	});
});

describe("the provider list: cached, single-flight, timed out, stale on error", () => {
	const clock = () => { let t = Date.parse("2026-10-27T12:00:00.000Z"); return { now: () => t, tick: (ms: number) => { t += ms; } }; };
	test("at most one list per provider every 10 s, shared by concurrent requests", async () => {
		const c = clock();
		let calls = 0, ownerCalls = 0;
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const cat = resourceCatalog({ now: c.now, list: async () => { calls++; await gate; return BOXD_ROWS; }, owners: async () => { ownerCalls++; return [OWNER]; } });
		const pending = [cat.page("boxd"), cat.page("boxd"), cat.get("boxd", "relay-3f9c2a1b7e5d4c60")];
		release();
		const [a, b, one] = await Promise.all(pending);
		expect(calls).toBe(1);
		expect(a).toEqual(b);
		expect((one as any).terminalCommand).toBe("capcomd sandbox shell run-8kq2 agt-41");
		c.tick(9_999);
		await cat.page("boxd");
		expect(calls).toBe(1);
		c.tick(1);
		await cat.page("boxd");
		expect([calls, ownerCalls]).toEqual([2, 2]);
		// Another provider has its own cache.
		await cat.page("docker");
		expect(calls).toBe(3);
	});
	test("a provider that doesn't answer in 3 s: the last good list, stale, with a daemon-written error; status 200", async () => {
		const c = clock();
		let mode: "ok" | "hang" | "throw" | "config" = "ok";
		const cat = resourceCatalog({ now: c.now, timeoutMs: 30, owners: async () => [OWNER], list: async () => {
			if (mode === "hang") return new Promise<VmInfo[]>(() => {});
			if (mode === "throw") throw new Error(`boxd said: invalid key ${PLANTED}`);
			if (mode === "config") throw new SandboxConfigError(`BoxdProvider requires BOXD_API_KEY ${PLANTED}`);
			return BOXD_ROWS;
		} });
		const good = (await cat.page("boxd"))!;
		expect(good).toMatchObject({ stale: false, error: null, asOf: "2026-10-27T12:00:00.000Z" });
		mode = "hang"; c.tick(10_000);
		const t0 = Date.now();
		const late = (await cat.page("boxd"))!;
		expect(Date.now() - t0).toBeLessThan(2_000);
		expect(late).toEqual({ ...good, stale: true, error: "boxd didn't answer within 3 seconds" });
		mode = "throw"; c.tick(10_000);
		expect((await cat.page("boxd"))!).toMatchObject({ stale: true, error: "boxd couldn't list its machines", asOf: "2026-10-27T12:00:00.000Z", resources: good.resources });
		mode = "config"; c.tick(10_000);
		const cfg = (await cat.page("boxd"))!;
		expect(cfg.error).toBe("boxd isn't set up or isn't reachable (run capcomd setup check)");
		expect(JSON.stringify(cfg)).not.toContain("PLANTED");
		// A failed attempt is throttled like a good one: no retry storm.
		let calls = 0;
		const slow = resourceCatalog({ now: c.now, owners: async () => [], list: async () => { calls++; throw new Error("down"); } });
		await slow.page("docker"); await slow.page("docker");
		expect(calls).toBe(1);
		// Never listed: no rows from the provider, owners still shown as unknown.
		const never = resourceCatalog({ now: c.now, owners: async () => [{ ...OWNER, sandbox: "docker" }], list: async () => { throw new Error("down"); } });
		expect((await never.page("docker"))!).toMatchObject({ asOf: null, stale: true, error: "Docker couldn't list its machines", resources: [{ id: "relay-3f9c2a1b7e5d4c60", state: "unknown" }] });
		mode = "ok"; c.tick(10_000);
		expect((await cat.page("boxd"))!).toMatchObject({ stale: false, error: null, asOf: "2026-10-27T12:00:40.000Z" });
	});
	test("over HTTP: a failing provider is still 200, stale, and leaks nothing", async () => {
		const { get } = setup({ machines: { boxd: async () => { throw new Error(`grpc: unauthenticated key=${PLANTED}`); } } });
		const r = await get("/v1/sandboxes/boxd/resources");
		expect(r.status).toBe(200);
		// The agent's machine still shows (from capcomd's records), as unknown: the provider never said how it is.
		expect(r.body).toMatchObject({ resources: [{ id: "relay-3f9c2a1b7e5d4c60", state: "unknown", owner: { agentId: "agt-41" } }], asOf: null, stale: true, error: "boxd couldn't list its machines", next: null });
		expect(r.text).not.toContain("PLANTED");
	});
});

describe("scopes and secrets", () => {
	const ROUTES = ["/v1/sandboxes", "/v1/sandboxes/boxd", "/v1/sandboxes/docker", "/v1/sandboxes/boxd/resources", "/v1/sandboxes/boxd/resources/relay-3f9c2a1b7e5d4c60", "/v1/sandboxes/boxd/resources/relay-0a0b0c0d0e0f1011", "/v1/logins?sandbox=boxd", "/v1/environments?sandbox=boxd"];
	test("401 without a token, 403 without the read scope, 200 with it", async () => {
		const { app, get } = setup();
		for (const p of ROUTES) {
			expect((await app.request(p)).status).toBe(401);
			const no = await get(p, steerOnly);
			expect(no.status).toBe(403);
			expect(no.body.code).toBe("forbidden");
			expect((await get(p)).status).toBe(200);
		}
	});
	test("no credential anywhere: planted in the environment, the ledger, the task and the provider", async () => {
		const home = mkdtempSync(join(dir, "s-"));
		mkdirSync(join(home, "state"), { recursive: true });
		writeFileSync(join(home, "state", "auths.json"), JSON.stringify({ "claude-code": { agent: "claude-code", store: "secret", method: "setup-token", env: "e", createdAt: "2026-10-01T00:00:00.000Z", token: PLANTED } }));
		const env = { CAPCOMD_HOME: home, CAPCOMD_NO_CONFIG: "1", ANTHROPIC_API_KEY: PLANTED, OPENAI_API_KEY: PLANTED, BOXD_API_KEY: PLANTED, CLAUDE_CODE_OAUTH_TOKEN: PLANTED, PATH: process.env.PATH ?? "" };
		const { get } = setup({
			logins: logins(env),
			machines: { boxd: BOXD_ROWS.map((r) => ({ ...r, state: `${r.state}` })), docker: async () => { throw new Error(PLANTED); } },
			owners: [{ ...OWNER, role: "worker", task: taskLine(`use ${PLANTED} to deploy`) }],
			surface: { env },
		});
		for (const p of [...ROUTES, "/v1/sandboxes/docker/resources", "/v1/logins", "/v1/environments"]) {
			const r = await get(p);
			expect(r.status).toBe(200);
			expect(r.text).not.toContain(PLANTED);
			expect(r.text).not.toContain("PLANTED");
		}
	});
});
