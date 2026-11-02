// Agent titles (capability agents.title) against a real engine and a real runner: a worker that may not spawn names
// its tab with the local `capcomd` shim (src/primitives/title-rules.mjs), which talks to nobody: the daemon reads the
// `capcomd title …` Bash call from the agent's own tool calls (the fake claude, tests/agents/fake-claude.sh [title:…],
// in a host-exec FakeProvider). No RPC: no spool, no MCP server, no token. A call that does anything else is ignored;
// a refused title is said by the shim, and nothing is recorded. The thread and the steps leave the call out.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Engine } from "../helpers/test-engine";
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

const workDir = (id: string) => join(dir, "vm", readdirSync(join(dir, "vm")).find((d) => d.includes(id))!);
async function finished(run: string, task: string, key: string) {
	const sp = await cj(["spawn", run, "--profile", "worker", "--task", task, "--key", key]);
	const id = sp.j?.agentId;
	if (!id) console.log(sp.stdout, sp.stderr);
	expect(id).toMatch(/^agt-/);
	expect((await cj(["await", run, id, "--timeout-ms", "90000"])).j?.agents?.[0]?.status).toBe("done");
	return { id, spawned: sp.j };
}

test("a worker names its own tab with the local shim: no RPC, the daemon reads the call; the thread leaves it out", async () => {
	const run = (await cj(["run", "new"])).j?.runId;
	expect(run).toMatch(/^run-/);
	const { id, spawned } = await finished(run, "Fix the sum helper [title:Login Redirect]", "w");
	// Spawned with the daemon's title, from the task (the marker isn't part of it).
	expect(spawned).toMatchObject({ title: "fix sum helper", titleSource: "derived" });

	// The shim's answer, as the agent saw it: checked locally.
	const out = readFileSync(join(workDir(id), "title-out.txt"), "utf8");
	expect(out).toBe("ok: login redirect\nexit 0\n");
	// No RPC: no spool folder, no MCP config, no orchestration skill; the shim and the naming lines instead.
	expect(existsSync(join(tmpdir(), "capcomd-rpc", run, id))).toBe(false);
	expect(existsSync(join(workDir(id), "capcomd-mcp.json"))).toBe(false);
	expect(existsSync(join(workDir(id), "bin", "capcomd-title.mjs"))).toBe(true);
	const system = readFileSync(join(workDir(id), "append-system.txt"), "utf8");
	expect(system).toContain("# Name your tab (capcomd)");
	expect(system).not.toContain("Orchestrating child agents");

	const a = ((await get(`/v1/runs/${run}/agents`)) as any[]).find((x) => x.id === id);
	expect(a).toMatchObject({ title: "login redirect", titleSource: "self" });
	const evs = (await get(`/v1/events?scope=${run}`)) as any[];
	const spawnedEv = evs.find((e) => e.type === "agent.spawned" && e.agentId === id);
	expect(spawnedEv.data).toMatchObject({ title: "fix sum helper", titleSource: "derived" });
	const titled = evs.filter((e) => e.type === "agent.titled" && e.agentId === id);
	expect(titled.map((e) => e.data)).toEqual([{ agentId: id, title: "login redirect", by: "self", setBy: id, shown: true, titleSource: "self" }]);
	expect(EventData["agent.titled"].safeParse(titled[0].data).success).toBe(true);
	expect(titled[0].seq).toBeGreaterThan(spawnedEv.seq);
	expect(((await get(`/v1/runs/${run}/lifecycle`)) as any[]).some((e) => e.type === "agent.titled" && e.agentId === id)).toBe(true);
	// Not a step of its work: not in the thread, not in its step history. The raw log keeps it.
	const items = (await get(`/v1/runs/${run}/agents/${id}/thread?limit=500`)).items as any[];
	expect(items.some((i) => i.kind === "tool" && i.tool?.name === "Edit")).toBe(true);
	expect(items.some((i) => i.kind === "tool" && /capcomd title/.test(String(i.tool?.args ?? "")))).toBe(false);
	expect(evs.filter((e) => e.type === "agent.step" && e.agentId === id).map((e) => e.data.kind)).not.toContain("run");
	const logs = (await cj(["logs", run, id])).j.lines.map((l: any) => String(l.line));
	expect(logs.some((l: string) => l.includes("capcomd title"))).toBe(true);
	expect(logs.some((l: string) => l.startsWith("[capcomd]"))).toBe(false);   // no pump: nothing answered an RPC
}, 180_000);

test("a call that does something else too is no rename; a refused title is said by the shim and nothing is recorded", async () => {
	const run = (await cj(["run", "new"])).j?.runId;
	const chained = await finished(run, "Fix the sum helper [title-chained:evil]", "c");
	const refused = await finished(run, "Fix the sum helper [title:one two three four five]", "r");
	const out = readFileSync(join(workDir(refused.id), "title-out.txt"), "utf8");
	expect(out).toBe('a title is 1 to 4 words, not 5: say what you\'re working on in fewer words, e.g. "login redirect"\nexit 1\n');
	const agents = (await get(`/v1/runs/${run}/agents`)) as any[];
	for (const id of [chained.id, refused.id]) expect(agents.find((x) => x.id === id)).toMatchObject({ title: "fix sum helper", titleSource: "derived" });
	const evs = (await get(`/v1/events?scope=${run}`)) as any[];
	expect(evs.filter((e) => e.type === "agent.titled")).toEqual([]);
	// The daemon's own refusal is in the log (the shim had already said it).
	const logs = (await cj(["logs", run, refused.id])).j.lines.map((l: any) => String(l.line));
	expect(logs.some((l: string) => l.startsWith("[capcomd] title not recorded: a title is 1 to 4 words, not 5"))).toBe(true);
}, 180_000);
