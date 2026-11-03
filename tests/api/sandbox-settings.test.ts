// ADR-021 phase 2 (capability sandboxes.settings): PATCH /v1/sandboxes/{name}/settings with the configure scope; field
// validation, rev, precedence (CAPCOMD_SANDBOX_IDLE_SECONDS → user config → default), the user config file write, and
// the sandbox.settings_changed audit event on the daemon stream. Engine-free: the memory source, with the settings in
// memory or in a scratch user config.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addClient, CLIENT_SCOPES, loadClients } from "../../src/api/clients";
import { CAPABILITY_NAMES, EventData, SandboxDetail } from "../../src/api/contract";
import { HarnessEvent } from "../../src/api/envelope";
import { harnessApp } from "../../src/api/server";
import { memorySource } from "../../src/api/source";
import { harnessState } from "../../src/api/state";
import { currentAgentMemory, currentIdleLifetime, fileSettingsStore, idleLifetimeFromEnv, memorySettingsStore, settingsPath, type SettingsStore } from "../../src/providers/settings";
import { capcomd } from "../helpers/engine";
import spec from "../../openapi/capcomd.json";

const dir = mkdtempSync(join(tmpdir(), "harness-settings-"));
const cpath = join(dir, "clients.json");
const configurer = addClient("menubar", ["read", "steer", "approve", "configure"], cpath);
const oldApp = addClient("old-menubar", ["read", "steer", "approve"], cpath);

function setup(o: { settings?: SettingsStore; env?: Record<string, string>; statePath?: string | null } = {}) {
	const settings = o.settings ?? memorySettingsStore();
	const src = memorySource({ settings, surface: { env: { CAPCOMD_NO_CONFIG: "1", ...(o.env ?? {}) } } });
	const state = harnessState(o.statePath ?? null);
	const app = harnessApp({ source: src, clients: () => loadClients(cpath), state, pollMs: 20 });
	const req = async (method: string, p: string, body?: unknown, token = configurer.token) => {
		const r = await app.request(p, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}) });
		return { status: r.status, body: (await r.json()) as any };
	};
	const get = (p: string, token?: string) => req("GET", p, undefined, token);
	const patch = (name: string, body: unknown, token?: string) => req("PATCH", `/v1/sandboxes/${name}/settings`, body, token);
	return { app, src, settings, state, get, patch };
}

describe("PATCH /v1/sandboxes/{name}/settings", () => {
	test("advertised and published; the configure scope is a scope clients can be given", () => {
		expect(CAPABILITY_NAMES).toContain("sandboxes.settings");
		const op = (spec as any).paths["/v1/sandboxes/{name}/settings"]?.patch;
		expect(op).toBeTruthy();
		expect(Object.keys(op.responses)).toEqual(expect.arrayContaining(["200", "403", "404", "409", "422"]));
		expect(CLIENT_SCOPES).toContain("configure");
		expect(() => addClient("x", ["bogus" as never], join(dir, "other.json"))).toThrow(/unknown scope bogus/);
	});

	test("`capcomd clients add … --scopes …,configure` makes a token that can change settings", async () => {
		const home = mkdtempSync(join(dir, "cli-"));
		const r = await capcomd(["clients", "add", "menubar", "--scopes", "read,steer,approve,configure"], { CAPCOMD_HOME: home });
		expect(r.code).toBe(0);
		const out = JSON.parse(r.stdout);
		expect(out.scopes).toEqual(["read", "steer", "approve", "configure"]);
		const app = harnessApp({ source: memorySource(), clients: () => loadClients(join(home, "harness-clients.json")), state: harnessState(null) });
		const h = { authorization: `Bearer ${out.token}`, "content-type": "application/json" };
		const rev = ((await (await app.request("/v1/sandboxes/boxd", { headers: h })).json()) as any).rev;
		expect((await app.request("/v1/sandboxes/boxd/settings", { method: "PATCH", headers: h, body: JSON.stringify({ values: { idleLifetime: "900" }, rev }) })).status).toBe(200);
		expect((await capcomd(["clients", "add", "x", "--scopes", "read,admin"], { CAPCOMD_HOME: home })).stderr).toContain("unknown scope admin (use read, steer, approve, configure)");
	}, 30_000);

	test("changes the idle lifetime: the new value, its source, a new rev; GET agrees; one audit event", async () => {
		const { get, patch, settings, state } = setup();
		const before = (await get("/v1/sandboxes/boxd")).body;
		expect(before.settings[0]).toMatchObject({ id: "idleLifetime", value: "3600", source: "default", editable: true });
		const r = await patch("boxd", { values: { idleLifetime: "14400" }, rev: before.rev });
		expect(r.status).toBe(200);
		expect(SandboxDetail.parse(r.body)).toBeTruthy();
		expect(r.body.settings[0]).toMatchObject({ id: "idleLifetime", value: "14400", display: "4 hours", source: "config", editable: true, appliesTo: "new_runs" });
		expect(r.body.rev).not.toBe(before.rev);
		expect((await get("/v1/sandboxes/boxd")).body).toEqual(r.body);
		expect(settings.read("boxd")).toEqual({ idleLifetime: 14400 });
		// Per place: docker's is still the default.
		expect((await get("/v1/sandboxes/docker")).body.settings[0]).toMatchObject({ value: "3600", source: "default" });
		const evs = state.daemonEvents();
		expect(evs).toHaveLength(1);
		expect(evs[0]).toMatchObject({ type: "sandbox.settings_changed", entity: "sandbox:boxd", entitySeq: 1, text: "Cloud: Delete idle machines after is now 4 hours (was 1 hour).", data: { sandbox: "boxd", id: "idleLifetime", from: "3600", to: "14400", clientId: configurer.client.id } });
		// The same value again: 200, nothing changed, no event.
		const again = await patch("boxd", { values: { idleLifetime: "14400" }, rev: r.body.rev });
		expect(again).toEqual({ status: 200, body: r.body });
		expect(state.daemonEvents()).toHaveLength(1);
	});

	test("a token without the configure scope: 403 forbidden, nothing written; GETs still need only read", async () => {
		const { get, patch, settings, state } = setup();
		const rev = (await get("/v1/sandboxes/boxd", oldApp.token)).body.rev;
		const r = await patch("boxd", { values: { idleLifetime: "900" }, rev }, oldApp.token);
		expect(r).toEqual({ status: 403, body: { code: "forbidden", message: "token lacks the configure scope" } });
		expect(settings.read("boxd")).toEqual({});
		expect(state.daemonEvents()).toEqual([]);
	});

	test("a stale rev: 409 conflict with the current rev, nothing written; the current rev works", async () => {
		const { get, patch, settings } = setup();
		const rev = (await get("/v1/sandboxes/docker")).body.rev;
		expect((await patch("docker", { values: { idleLifetime: "900" }, rev })).status).toBe(200);
		const stale = await patch("docker", { values: { idleLifetime: "43200" }, rev });
		expect(stale.status).toBe(409);
		expect(stale.body.code).toBe("conflict");
		expect(stale.body.rev).toMatch(/^[0-9a-f]{16}$/);
		expect(stale.body.rev).not.toBe(rev);
		expect(settings.read("docker")).toEqual({ idleLifetime: 900 });
		const fresh = await patch("docker", { values: { idleLifetime: "43200" }, rev: stale.body.rev });
		expect(fresh.body.settings[0]).toMatchObject({ id: "idleLifetime", value: "43200", display: "12 hours" });
	});

	test("422 invalid: not a choice, under the 15-minute minimum, an unknown setting, a bad body; 404 for an unknown place", async () => {
		const { get, patch, settings } = setup();
		const rev = (await get("/v1/sandboxes/boxd")).body.rev;
		const cases: Array<[unknown, RegExp]> = [
			[{ values: { idleLifetime: "7200" }, rev }, /^Delete idle machines after: use one of 900 \(15 minutes\), 3600 \(1 hour\), 14400 \(4 hours\), 43200 \(12 hours\)$/],
			[{ values: { idleLifetime: "600" }, rev }, /10 minutes is under the 15-minute minimum/],
			[{ values: { idleLifetime: "0" }, rev }, /under the 15-minute minimum/],
			[{ values: { idleLifetime: true }, rev }, /send one of its choices' values as a string/],
			[{ values: { egressDefault: "open" }, rev }, /^"egressDefault" isn't a setting of boxd \(its settings: idleLifetime\)$/],
			[{ values: { "<script>": "1" }, rev }, /^that isn't a setting of boxd/],
			[{ values: { idleLifetime: "900" } }, /^body must be \{values: \{id: value\}, rev\}/],
			[{ values: {}, rev }, /^values must name at least one setting$/],
			["not json", /^body must be/],
		];
		for (const [body, msg] of cases) {
			const r = await patch("boxd", body);
			expect(r.status).toBe(422);
			expect(r.body.code).toBe("invalid");
			expect(r.body.message).toMatch(msg);
		}
		// An invalid value is 422 even with a stale rev (the value is what's wrong).
		expect((await patch("boxd", { values: { idleLifetime: "7200" }, rev: "0000000000000000" })).status).toBe(422);
		// A number is read as its string.
		expect((await patch("boxd", { values: { idleLifetime: 900 }, rev })).body.settings[0]).toMatchObject({ value: "900" });
		expect(settings.read("boxd")).toEqual({ idleLifetime: 900 });
		for (const n of ["fake", "fake-host", "nope"]) expect((await patch(n, { values: { idleLifetime: "900" }, rev })).body.code).toBe("not_found");
	});

	test("CAPCOMD_SANDBOX_IDLE_SECONDS wins over the user config: read-only, said so; a change is 422", async () => {
		const { get, patch } = setup({ settings: memorySettingsStore({ boxd: { idleLifetime: 900 } }), env: { CAPCOMD_SANDBOX_IDLE_SECONDS: "7200" } });
		const d = (await get("/v1/sandboxes/boxd")).body;
		expect(d.settings[0]).toMatchObject({ value: "7200", source: "env", editable: false, display: "Set by CAPCOMD_SANDBOX_IDLE_SECONDS in capcomd's environment" });
		const r = await patch("boxd", { values: { idleLifetime: "3600" }, rev: d.rev });
		expect(r).toEqual({ status: 422, body: { code: "invalid", message: "Delete idle machines after is set by CAPCOMD_SANDBOX_IDLE_SECONDS in capcomd's environment, so it can't be changed here" } });
	});

	test("precedence and parsing: env (raised to the minimum), then the user config, then 1 hour", () => {
		const store = memorySettingsStore({ docker: { idleLifetime: 14400 } });
		expect(currentIdleLifetime("docker", { env: {}, store })).toEqual({ seconds: 14400, source: "config" });
		expect(currentIdleLifetime("boxd", { env: {}, store })).toEqual({ seconds: 3600, source: "default" });
		expect(currentIdleLifetime("docker", { env: { CAPCOMD_SANDBOX_IDLE_SECONDS: "1800" }, store })).toEqual({ seconds: 1800, source: "env" });
		expect(idleLifetimeFromEnv({ CAPCOMD_SANDBOX_IDLE_SECONDS: "60" })).toBe(900);
		for (const v of ["", "abc", "-5", "0", "1e4", " "]) expect(idleLifetimeFromEnv({ CAPCOMD_SANDBOX_IDLE_SECONDS: v })).toBeNull();
		expect(currentIdleLifetime("docker", { env: { CAPCOMD_SANDBOX_IDLE_SECONDS: "nope" }, store }).source).toBe("config");
	});
});

describe("Memory per agent (agentMemory, Docker): presets, precedence, and the Agents at once row follows it", () => {
	const GB = 1024 ** 3;
	const withSlots = (o: { settings?: SettingsStore; env?: Record<string, string> } = {}) => {
		const settings = o.settings ?? memorySettingsStore();
		// Docker has 8 GB here (the row's only provider fact; the budget is the setting's).
		const src = memorySource({ settings, surface: { env: { CAPCOMD_NO_CONFIG: "1", ...(o.env ?? {}) }, agentSlots: async (n: string) => (n === "docker" ? { memTotal: 8 * GB } : null) } });
		const app = harnessApp({ source: src, clients: () => loadClients(cpath), state: harnessState(null), pollMs: 20 });
		const req = async (method: string, p: string, body?: unknown) => {
			const r = await app.request(p, { method, headers: { authorization: `Bearer ${configurer.token}`, "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
			return { status: r.status, body: (await r.json()) as any };
		};
		return { settings, get: (p: string) => req("GET", p), patch: (n: string, b: unknown) => req("PATCH", `/v1/sandboxes/${n}/settings`, b) };
	};
	const field = (d: any, id: string) => [...d.settings, ...d.info].find((f: any) => f.id === id);

	test("docker offers it as a choice of 512 MB, 1 GB, 2 GB and 4 GB at 1 GB by default; boxd doesn't have it", async () => {
		const { get } = withSlots();
		const d = (await get("/v1/sandboxes/docker")).body;
		expect(SandboxDetail.safeParse(d).success).toBe(true);
		expect(d.descriptor.settings).toEqual(["idleLifetime", "agentMemory"]);
		expect(field(d, "agentMemory")).toEqual({
			id: "agentMemory", type: "choice", label: "Memory per agent", help: expect.stringContaining("Agents here share Docker's memory"),
			value: "1024", display: "1 GB", default: "1024",
			choices: [{ value: "512", label: "512 MB" }, { value: "1024", label: "1 GB" }, { value: "2048", label: "2 GB" }, { value: "4096", label: "4 GB" }],
			source: "default", editable: true, appliesTo: "new_agents", needsRestart: false, state: null,
		});
		expect(field(d, "agentSlots")).toMatchObject({ value: "8", display: "8 (8 GB ÷ 1 GB per agent)" });
		const boxd = (await get("/v1/sandboxes/boxd")).body;
		expect(boxd.settings.map((f: any) => f.id)).toEqual(["idleLifetime"]);
	});

	test("a change is stored, and the same answer's Agents at once row already uses it (no stale budget)", async () => {
		const { get, patch, settings } = withSlots();
		const rev = (await get("/v1/sandboxes/docker")).body.rev;
		const r = await patch("docker", { values: { agentMemory: "512" }, rev });
		expect(r.status).toBe(200);
		expect(settings.read("docker")).toEqual({ agentMemory: 512 });
		expect(field(r.body, "agentMemory")).toMatchObject({ value: "512", display: "512 MB", source: "config" });
		expect(field(r.body, "agentSlots")).toMatchObject({ value: "16", display: "16 (8 GB ÷ 512 MB per agent)" });
		expect(r.body.rev).not.toBe(rev);
		// GET agrees, and a second change from the new rev works.
		const again = (await get("/v1/sandboxes/docker")).body;
		expect(field(again, "agentSlots").value).toBe("16");
		const four = await patch("docker", { values: { agentMemory: "4096" }, rev: again.rev });
		expect(field(four.body, "agentSlots")).toMatchObject({ value: "2", display: "2 (8 GB ÷ 4 GB per agent)" });
		// Only the presets; and not on boxd.
		expect((await patch("docker", { values: { agentMemory: "1536" }, rev: four.body.rev })).body.message).toBe("Memory per agent: use one of 512 (512 MB), 1024 (1 GB), 2048 (2 GB), 4096 (4 GB)");
		expect((await patch("boxd", { values: { agentMemory: "512" }, rev: (await get("/v1/sandboxes/boxd")).body.rev })).body.message).toBe("\"agentMemory\" isn't a setting of boxd (its settings: idleLifetime)");
	});

	test("CAPCOMD_DOCKER_AGENT_MEMORY_MB wins over the user config: read-only, said so; a change is 422", async () => {
		const { get, patch } = withSlots({ settings: memorySettingsStore({ docker: { agentMemory: 4096 } }), env: { CAPCOMD_DOCKER_AGENT_MEMORY_MB: "2048" } });
		const d = (await get("/v1/sandboxes/docker")).body;
		expect(field(d, "agentMemory")).toMatchObject({ value: "2048", source: "env", editable: false, display: "Set by CAPCOMD_DOCKER_AGENT_MEMORY_MB in capcomd's environment" });
		expect(field(d, "agentSlots")).toMatchObject({ value: "4", source: "env" });
		const r = await patch("docker", { values: { agentMemory: "512" }, rev: d.rev });
		expect(r).toEqual({ status: 422, body: { code: "invalid", message: "Memory per agent is set by CAPCOMD_DOCKER_AGENT_MEMORY_MB in capcomd's environment, so it can't be changed here" } });
	});

	test("precedence: env, then the user config, then 1 GB; a stored value capcomd wouldn't accept reads as unset", () => {
		const store = memorySettingsStore({ docker: { agentMemory: 2048 } });
		expect(currentAgentMemory("docker", { env: {}, store })).toEqual({ mb: 2048, source: "config" });
		expect(currentAgentMemory("docker", { env: { CAPCOMD_DOCKER_AGENT_MEMORY_MB: "768" }, store })).toEqual({ mb: 768, source: "env" });
		expect(currentAgentMemory("docker", { env: { CAPCOMD_DOCKER_AGENT_MEMORY_MB: "100" }, store })).toEqual({ mb: 2048, source: "config" });
		expect(currentAgentMemory("docker", { env: {}, store: memorySettingsStore() })).toEqual({ mb: 1024, source: "default" });
		const home = mkdtempSync(join(dir, "mem-"));
		const path = settingsPath({ CAPCOMD_HOME: home })!;
		writeFileSync(path, JSON.stringify({ sandboxes: { docker: { agentMemory: 100, idleLifetime: 900 } } }));
		expect(fileSettingsStore(path).read("docker")).toEqual({ idleLifetime: 900 });
		fileSettingsStore(path).write("docker", "agentMemory", 512);
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ sandboxes: { docker: { agentMemory: 512, idleLifetime: 900 } } });
		expect(currentAgentMemory("docker", { env: { CAPCOMD_HOME: home } })).toEqual({ mb: 512, source: "config" });
	});
});

describe("the user config file", () => {
	test("written atomically, other keys kept, 0600; read back through the route; CAPCOMD_HOME respected", async () => {
		const home = mkdtempSync(join(dir, "home-"));
		const path = settingsPath({ CAPCOMD_HOME: home });
		expect(path).toBe(join(home, "config.json"));
		expect(settingsPath({ CAPCOMD_HOME: home, CAPCOMD_NO_CONFIG: "1" })).toBeNull();
		writeFileSync(path!, JSON.stringify({ env: { CAPCOMD_SANDBOX: "docker" }, boxdKey: "keychain", sandboxes: { docker: { idleLifetime: 900, other: "kept" } }, future: { x: 1 } }));
		const { get, patch } = setup({ settings: fileSettingsStore(path) });
		const d = (await get("/v1/sandboxes/docker")).body;
		expect(d.settings[0]).toMatchObject({ value: "900", source: "config" });
		expect((await patch("boxd", { values: { idleLifetime: "43200" }, rev: (await get("/v1/sandboxes/boxd")).body.rev })).status).toBe(200);
		expect(JSON.parse(readFileSync(path!, "utf8"))).toEqual({ env: { CAPCOMD_SANDBOX: "docker" }, boxdKey: "keychain", sandboxes: { docker: { idleLifetime: 900, other: "kept" }, boxd: { idleLifetime: 43200 } }, future: { x: 1 } });
		expect(statSync(path!).mode & 0o777).toBe(0o600);
		expect(readdirSync(home)).toEqual(["config.json"]); // no temporary file left behind
		expect(currentIdleLifetime("boxd", { env: { CAPCOMD_HOME: home } })).toEqual({ seconds: 43200, source: "config" });
		// A value capcomd wouldn't write (under the minimum, not a number) reads as unset.
		writeFileSync(path!, JSON.stringify({ sandboxes: { boxd: { idleLifetime: 60 }, docker: { idleLifetime: "x" } } }));
		expect(currentIdleLifetime("boxd", { env: { CAPCOMD_HOME: home } }).source).toBe("default");
		expect(currentIdleLifetime("docker", { env: { CAPCOMD_HOME: home } }).source).toBe("default");
	});

	test("a config file that isn't JSON is never overwritten: 422 with what to do", async () => {
		const home = mkdtempSync(join(dir, "bad-"));
		const path = join(home, "config.json");
		writeFileSync(path, "{ not json");
		const { get, patch } = setup({ settings: fileSettingsStore(path) });
		const r = await patch("boxd", { values: { idleLifetime: "900" }, rev: (await get("/v1/sandboxes/boxd")).body.rev });
		expect(r.status).toBe(422);
		expect(r.body.message).toContain("isn't valid JSON: fix it or remove it");
		expect(readFileSync(path, "utf8")).toBe("{ not json");
	});

	test("settings off (CAPCOMD_NO_CONFIG): read-only at the default", async () => {
		const { get, patch } = setup({ settings: fileSettingsStore(null) });
		const d = (await get("/v1/sandboxes/boxd")).body;
		expect(d.settings[0]).toMatchObject({ value: "3600", source: "default", editable: false });
		expect((await patch("boxd", { values: { idleLifetime: "900" }, rev: d.rev })).body.message).toBe("Delete idle machines after can't be changed here");
	});
});

describe("audit: sandbox.settings_changed on the daemon scope", () => {
	test("durable: replayed by GET /v1/events?scope=daemon, sent on the daemon stream in seq order with run.created, kept across a restart", async () => {
		const statePath = join(mkdtempSync(join(dir, "state-")), "harness-state.json");
		const { app, get, patch, src } = setup({ statePath });
		(await src.runs()).push({ id: "run-a", projectId: null, label: "a", state: "new", goal: "a", title: "a", titleSource: "goal", repo: null, createdAt: "2026-10-27T09:00:00.000Z" });
		// The stream assigns the run its seq first (1), then the change gets the next one (2).
		const read = async (after?: number) => {
			const ctl = new AbortController();
			const r = await app.request("/v1/streams/daemon/events", { headers: { authorization: `Bearer ${configurer.token}`, ...(after !== undefined ? { "last-event-id": String(after) } : {}) }, signal: ctl.signal });
			const reader = r.body!.getReader();
			let text = "";
			const until = Date.now() + 1500;
			while (Date.now() < until && !text.includes("sandbox.settings_changed")) {
				const chunk = await Promise.race([reader.read(), Bun.sleep(100).then(() => null)]);
				if (chunk && !chunk.done) text += new TextDecoder().decode(chunk.value);
			}
			ctl.abort(); await reader.cancel().catch(() => {});
			return text;
		};
		expect(await read()).toContain("event: run.created");
		const rev = (await get("/v1/sandboxes/docker")).body.rev;
		expect((await patch("docker", { values: { idleLifetime: "900" }, rev })).status).toBe(200);
		const live = await read(1);
		expect(live).toContain("id: 2\nevent: sandbox.settings_changed\n");
		const frame = JSON.parse(live.split("event: sandbox.settings_changed\ndata: ")[1]!.split("\n")[0]!);
		expect(HarnessEvent.parse(frame)).toBeTruthy();
		expect(EventData["sandbox.settings_changed"].parse(frame.data)).toBeTruthy();
		expect(frame).toMatchObject({ id: "evt_daemon_2", scope: "daemon", seq: 2, entity: "sandbox:docker", entitySeq: 1, type: "sandbox.settings_changed", durability: "durable", runId: null, agentId: null, text: "Local: Delete idle machines after is now 15 minutes (was 1 hour).", data: { sandbox: "docker", id: "idleLifetime", from: "3600", to: "900", clientId: configurer.client.id } });
		const replay = (await get("/v1/events?scope=daemon")).body;
		expect(replay).toEqual([frame]);
		expect((await get("/v1/events?scope=daemon&after=2")).body).toEqual([]);
		// A restarted daemon replays it from its state file, and its next seq comes after it.
		const again = harnessState(statePath);
		expect(again.daemonEvents().map((e) => e.seq)).toEqual([2]);
		expect(again.seqs([{ id: "run-b", createdAt: "2026-10-27T10:00:00.000Z" }]).get("run-b")).toBe(3);
	});
});
