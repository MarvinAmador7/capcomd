// Agent titles (capability agents.title) against a real engine and a real runner: a worker that may not spawn still
// gets the in-VM capcomd, with a token that only names its tab, and names itself with `capcomd title` (the fake claude,
// tests/agents/fake-claude.sh [title:…], in a host-exec FakeProvider). Its MCP server lists only capcomd_title.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Engine } from "../chaos/engine";
import { capcomd, testPort } from "../helpers/engine";
import { bareRepo } from "../merge/gitfixture";
import { addClient, loadClients } from "../../src/api/clients";
import { EventData } from "../../src/api/contract";
import { rivetSource } from "../../src/api/rivet-source";
import { harnessApp } from "../../src/api/server";
import { harnessState } from "../../src/api/state";

let engine: Engine;
let env: Record<string, string>;
let app: ReturnType<typeof harnessApp>;
let token = "";
let dir = "";
const saved = { ...process.env };

beforeAll(async () => {
	const r = await bareRepo({ mode: "direct" });
	dir = mkdtempSync(join(tmpdir(), "capcomd-titles-"));
	const agentsFile = join(dir, "agents.json");
	writeFileSync(agentsFile, JSON.stringify({ schema: "capcomd.agents/v1", agents: { worker: { provider: "claude", auth: "apikey", maxTurns: 20 } } }));
	env = {
		...r.env,
		CAPCOMD_HOME: join(dir, "home"),
		CAPCOMD_HARNESS_SOCKET: join(dir, "home", "harness.sock"),
		CAPCOMD_AGENTS_FILE: agentsFile,
		CAPCOMD_SANDBOX: "fake-host",
		CAPCOMD_AGENT_CLAUDE_BIN: new URL("../agents/fake-claude.sh", import.meta.url).pathname,
		CAPCOMD_AGENT_WORKDIR: join(dir, "vm"),
		CAPCOMD_AGENT_POLL_MS: "100",
		CAPCOMD_VM_RPC_POLL_MS: "200",
		CAPCOMD_VM_RPC_LEAF_POLL_MS: "200",
		CAPCOMD_SKIP_PREFLIGHT: "1",
		CAPCOMD_TRACE_DIR: join(dir, "traces"),
		CAPCOMD_AUTH_LEDGER: join(dir, "auths.json"),
		CAPCOMD_ENV_LEDGER: join(dir, "envs.json"),
		CAPCOMD_RPC_KEY: `titles-${Math.random()}`,
		ANTHROPIC_API_KEY: "sk-ant-api03-TITLES-abcdefghijklmnopqrstuvwxyz0123456789",
		CAPCOMD_ENV: "image",
	};
	Object.assign(process.env, env);
	const port = await testPort();
	engine = new Engine("titles", { port, dataDir: join(dir, "engine") });
	await engine.start(null);
	env.CAPCOMD_ENDPOINT = `http://127.0.0.1:${port}`;
	process.env.CAPCOMD_ENDPOINT = env.CAPCOMD_ENDPOINT;
	const clients = join(dir, "clients.json");
	token = addClient("desktop", ["read", "steer"], clients).token;
	app = harnessApp({ source: rivetSource(), clients: () => loadClients(clients), state: harnessState(null), pollMs: 100 });
}, 120_000);

afterAll(async () => {
	await engine?.stop();
	for (const k of Object.keys(env ?? {})) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
});

const cj = async (args: string[]) => {
	const x = await capcomd([...args, "--json"], env);
	let j: any = null;
	try { j = JSON.parse(x.stdout.trim().split("\n").pop()!); } catch {}
	return { ...x, j };
};
const get = async (p: string) => (await (await app.request(p, { headers: { authorization: `Bearer ${token}` } })).json()) as any;

test("a worker names its own tab from its VM: Agent.title self, agent.titled after agent.spawned's derived title", async () => {
	const run = (await cj(["run", "new"])).j?.runId;
	expect(run).toMatch(/^run-/);
	const sp = await cj(["spawn", run, "--profile", "worker", "--task", "Fix the sum helper [title:Login Redirect]", "--key", "w"]);
	const id = sp.j?.agentId;
	if (!id) console.log(sp.stdout, sp.stderr);
	expect(id).toMatch(/^agt-/);
	// Spawned with the daemon's title, from the task (the marker isn't part of it).
	expect(sp.j).toMatchObject({ title: "fix sum helper", titleSource: "derived" });
	const aw = await cj(["await", run, id, "--timeout-ms", "90000"]);
	expect(aw.j?.agents?.[0]?.status).toBe("done");

	// The in-VM verb's answer, as the agent saw it.
	const work = readdirSync(join(dir, "vm")).find((d) => d.includes(id))!;
	const out = readFileSync(join(dir, "vm", work, "title-out.txt"), "utf8");
	expect(out).toContain("exit 0");
	expect(JSON.parse(out.split("\n")[0]!)).toMatchObject({ ok: true, agentId: id, title: "login redirect", titleSource: "self", shown: true, changed: true });

	const a = ((await get(`/v1/runs/${run}/agents`)) as any[]).find((x) => x.id === id);
	expect(a).toMatchObject({ title: "login redirect", titleSource: "self" });
	const evs = (await get(`/v1/events?scope=${run}`)) as any[];
	const spawned = evs.find((e) => e.type === "agent.spawned" && e.agentId === id);
	expect(spawned.data).toMatchObject({ title: "fix sum helper", titleSource: "derived" });
	const titled = evs.filter((e) => e.type === "agent.titled");
	expect(titled.map((e) => e.data)).toEqual([{ agentId: id, title: "login redirect", by: "self", setBy: id, shown: true, titleSource: "self" }]);
	expect(EventData["agent.titled"].safeParse(titled[0].data).success).toBe(true);
	expect(titled[0].seq).toBeGreaterThan(spawned.seq);
	expect(titled[0].seq).toBeLessThan(evs.find((e) => e.type === "agent.done" && e.agentId === id).seq);
	// On the lifecycle feed too.
	expect(((await get(`/v1/runs/${run}/lifecycle`)) as any[]).some((e) => e.type === "agent.titled" && e.agentId === id)).toBe(true);
	// A worker that may not spawn: its token names its tab and nothing else.
	const { opsFor } = await import("../../src/subagents/token");
	expect(opsFor({ allowSpawn: false }, { naming: true })).toEqual(["title", "heartbeat"]);
	const { toolsFor } = await import("../../src/subagents/vm-cli.mjs");
	expect(toolsFor(["title", "heartbeat"]).map((t: any) => t.name)).toEqual(["capcomd_title", "capcomd_heartbeat"]);
}, 180_000);
