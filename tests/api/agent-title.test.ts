// harness.v1 agent titles (capability agents.title): Agent.title and titleSource, the user's title through PUT and
// DELETE …/agents/{agentId}/title (steer scope, Idempotency-Key, 422 with field title), agent.titled on the run's
// events and lifecycle feed, run.titled and Run.titleSource agent, and the daemon-side strict shapes of both events.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addClient, loadClients } from "../../src/api/clients";
import { Agent, AgentTitleResult, CAPABILITY_NAMES, EventData } from "../../src/api/contract";
import { lifecycleEvents } from "../../src/api/lifecycle";
import { strictEventData } from "../../src/api/legacy-events";
import { describeEvent } from "../../src/api/describe";
import { runTitle } from "../../src/api/run-title";
import { harnessApp } from "../../src/api/server";
import { harnessState } from "../../src/api/state";
import { memorySource, type RawEvent } from "../../src/api/source";

const dir = mkdtempSync(join(tmpdir(), "harness-title-"));
const path = join(dir, "clients.json");
const reader = addClient("reader", ["read"], path).token;
const steer = addClient("Desktop", ["read", "steer"], path).token;

const at = 1792900500000;
const agent = (id: string, task: string, parent: string | null = null) =>
	({ id, runId: "run-1", parent, depth: parent ? 1 : 0, profile: parent ? "worker" : "planner", status: "running", text: "", activity: null, task, taskAttachment: null, result: null, workspace: null, provider: null, model: null, effort: null, updatedAt: null }) as any;

function setup() {
	const events: RawEvent[] = [
		{ seq: 1, at, type: "RUN_NEW", agentId: null, data: { budget: {}, label: "demo" } },
		{ seq: 2, at: at + 1, type: "AGENT_SPAWNED", agentId: "a1", data: { parent: null, depth: 0, profile: "planner", task: "Goal: fix login", key: null, operator: true, budget: {}, limits: {}, agent: null } },
		{ seq: 3, at: at + 2, type: "AGENT_STARTED", agentId: "a1", data: {} },
	];
	const run = { id: "run-1", projectId: null, label: "demo", state: "running", goal: null, repo: "/r", createdAt: "2026-10-25T07:00:00.000Z" };
	const agents = [agent("a1", "Goal: fix the login redirect"), agent("a2", "Fix the login redirect bug in auth.ts", "a1"), agent("a3", "", "a1")];
	const src = memorySource({ runs: [run], agents: { "run-1": agents }, events: { "run-1": events } });
	const app = harnessApp({ source: src, clients: () => loadClients(path), pollMs: 20, state: harnessState(null) });
	type Res = Omit<Response, "json"> & { json(): Promise<any> };
	const call = async (method: string, p: string, o: { token?: string; key?: string; body?: unknown } = {}): Promise<Res> => app.request(p, {
		method, headers: { authorization: `Bearer ${o.token ?? steer}`, "content-type": "application/json", ...(o.key ? { "idempotency-key": o.key } : {}) },
		...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
	});
	const put = (agentId: string, title: unknown, key = `k-${Math.random()}`, token = steer) => call("PUT", `/v1/runs/run-1/agents/${agentId}/title`, { token, key, body: { title } });
	const del = (agentId: string, key = `k-${Math.random()}`) => call("DELETE", `/v1/runs/run-1/agents/${agentId}/title`, { key });
	const get = async (p: string) => (await app.request(p, { headers: { authorization: `Bearer ${reader}` } })).json() as Promise<any>;
	const tree = async () => Object.fromEntries(((await get("/v1/runs/run-1/agents")) as any[]).map((a) => [a.id, { title: a.title, titleSource: a.titleSource }]));
	const titled = async () => ((await get("/v1/events?scope=run-1")) as any[]).filter((e) => e.type === "agent.titled");
	return { src, put, del, get, tree, titled, call };
}

describe("Agent.title", () => {
	test("the capability is listed", () => expect(CAPABILITY_NAMES).toContain("agents.title"));
	test("nobody named an agent: the daemon's, from its task (null without task text); it matches the contract", async () => {
		const { get, tree } = setup();
		expect(await tree()).toEqual({
			a1: { title: "fix login redirect", titleSource: "derived" },
			a2: { title: "fix login redirect bug", titleSource: "derived" },
			a3: { title: null, titleSource: null },
		});
		for (const a of await get("/v1/runs/run-1/agents")) expect(Agent.safeParse(a).success).toBe(true);
	});
});

describe("PUT and DELETE /v1/runs/{runId}/agents/{agentId}/title", () => {
	test("sets the user's title (normalized), confirmed by agent.titled by user; the agent shows it", async () => {
		const { put, tree, titled } = setup();
		const r = await put("a2", "  Login   Redirect ");
		expect(r.status).toBe(200);
		const body = await r.json();
		expect(body).toEqual({ runId: "run-1", agentId: "a2", title: "login redirect", titleSource: "user", changed: true });
		expect(AgentTitleResult.safeParse(body).success).toBe(true);
		expect((await tree()).a2).toEqual({ title: "login redirect", titleSource: "user" });
		const [e] = await titled();
		expect(e).toMatchObject({ agentId: "a2", entity: "a2", data: { agentId: "a2", title: "login redirect", by: "user", setBy: "user", shown: true, titleSource: "user" } });
		expect(EventData["agent.titled"].safeParse(e.data).success).toBe(true);
		// The envelope text is trusted: it never quotes the title.
		expect(e.text).toBe("You renamed a2.");
		expect(e.text).not.toContain("login");
	});
	test("DELETE clears it: the derived title shows again (agent.titled by cleared, with the title now shown)", async () => {
		const { put, del, tree, titled } = setup();
		await put("a2", "my tab");
		const r = await del("a2");
		expect(r.status).toBe(200);
		expect(await r.json()).toEqual({ runId: "run-1", agentId: "a2", title: "fix login redirect bug", titleSource: "derived", changed: true });
		expect((await tree()).a2).toEqual({ title: "fix login redirect bug", titleSource: "derived" });
		expect((await titled()).at(-1)!.data).toMatchObject({ by: "cleared", setBy: "user", title: "fix login redirect bug", shown: true, titleSource: "derived" });
		// Nothing left to clear: 200, changed false, no event.
		const again = await del("a2");
		expect((await again.json()).changed).toBe(false);
		expect((await titled()).length).toBe(2);
	});
	test("refusals: 422 invalid with field title (no words, 5 words, 33 characters, not a string), nothing recorded", async () => {
		const { put, titled } = setup();
		for (const t of ["   ", "one two three four five", "x".repeat(33), 7]) {
			const r = await put("a2", t);
			expect(r.status).toBe(422);
			const b = await r.json();
			expect(b).toMatchObject({ code: "invalid", field: "title" });
			expect(typeof b.message).toBe("string");
		}
		expect(await titled()).toEqual([]);
	});
	test("unknown run or agent: 404; an Idempotency-Key is required", async () => {
		const { call, put } = setup();
		expect((await call("PUT", "/v1/runs/run-nope/agents/a2/title", { key: "k-12345678", body: { title: "x" } })).status).toBe(404);
		expect((await put("agt-nope", "x")).status).toBe(404);
		expect((await call("PUT", "/v1/runs/run-1/agents/a2/title", { body: { title: "x" } })).status).toBe(422);
	});
	test("the steer scope: a read token is refused (403)", async () => {
		const { put, call } = setup();
		expect((await put("a2", "x", "k-12345678", reader)).status).toBe(403);
		expect((await call("DELETE", "/v1/runs/run-1/agents/a2/title", { token: reader, key: "k-12345678" })).status).toBe(403);
	});
	test("same key + same body replays; same key on another title is idempotency_conflict", async () => {
		const { put, titled } = setup();
		const a = await (await put("a2", "login redirect", "key-one-1")).json();
		const b = await put("a2", "login redirect", "key-one-1");
		expect(b.status).toBe(200);
		expect(await b.json()).toEqual(a);
		expect((await put("a2", "other", "key-one-1")).status).toBe(409);
		expect((await titled()).length).toBe(1);
	});
});

describe("agent.titled and run.titled on the feeds", () => {
	const events: RawEvent[] = [
		{ seq: 1, at, type: "RUN_NEW", agentId: null, data: { budget: {}, label: null } },
		{ seq: 2, at, type: "AGENT_SPAWNED", agentId: "agt-p", data: { parent: null, depth: 0, profile: "planner", task: "Goal: x", key: null, operator: true, budget: {}, limits: {}, agent: null, title: "x", titleSource: "derived" } },
		{ seq: 3, at, type: "AGENT_STARTED", agentId: "agt-p", data: {} },
		{ seq: 4, at, type: "AGENT_TITLED", agentId: "agt-p", data: { agentId: "agt-p", title: "login redirect", by: "self", setBy: "agt-p", shown: true, titleSource: "self" } },
		{ seq: 5, at, type: "RUN_TITLED", agentId: "agt-p", data: { title: "login fixes", setBy: "agt-p" } },
	];
	test("the lifecycle feed carries both, with cause titled, and they don't move the run's state", () => {
		const l = lifecycleEvents("run-1", events);
		expect(l.map((e) => e.type)).toEqual(["run.created", "agent.spawned", "agent.started", "run.started", "agent.titled", "run.titled"]);
		expect(l.find((e) => e.type === "agent.titled")!.data).toMatchObject({ cause: "titled", title: "login redirect" });
		expect(l.find((e) => e.type === "run.titled")!.data).toMatchObject({ cause: "titled", setBy: "agt-p" });
		expect(describeEvent("run.titled", { title: "login fixes", setBy: "agt-p" }, "agt-p")).toBe("Agent agt-p named the run.");
		expect(describeEvent("agent.titled", { by: "self" }, "agt-p")).toBe("Agent agt-p named its tab.");
	});
	test("strict shapes: what the scope emits is declared; an undeclared field or a wrong by is refused", () => {
		expect(strictEventData("agent.titled", events[3]!.data)).toEqual({ ok: true });
		expect(strictEventData("agent.titled", { ...events[3]!.data, by: "cleared", title: null, titleSource: "derived" })).toEqual({ ok: true });
		expect(strictEventData("run.titled", events[4]!.data)).toEqual({ ok: true });
		expect(strictEventData("agent.spawned", events[1]!.data)).toEqual({ ok: true });
		expect(strictEventData("agent.titled", { ...events[3]!.data, extra: 1 }).ok).toBe(false);
		expect(strictEventData("agent.titled", { ...events[3]!.data, by: "planner" }).ok).toBe(false);
		expect(EventData["run.titled"].safeParse(events[4]!.data).success).toBe(true);
	});
	test("Run.title: the planner's name ranks below a label of the run's own, above the merged work and the goal", () => {
		expect(runTitle({ label: null, goal: "Fix the login redirect bug", agentTitle: "login fixes" })).toEqual({ title: "login fixes", titleSource: "agent" });
		expect(runTitle({ label: "Fix the login redirect bug", goal: "Fix the login redirect bug", agentTitle: "login fixes" })).toEqual({ title: "login fixes", titleSource: "agent" });
		expect(runTitle({ label: "Auth work", goal: "Fix the login redirect bug", agentTitle: "login fixes" })).toEqual({ title: "Auth work", titleSource: "label" });
		const merged = [{ parent: "agt-p", task: "Fix redirect", result: { merge: { state: "merged" } } }];
		expect(runTitle({ label: null, goal: "g", agentTitle: "login fixes", agents: merged })).toEqual({ title: "login fixes", titleSource: "agent" });
		expect(runTitle({ label: null, goal: "g", agentTitle: null, agents: merged }).titleSource).toBe("merge");
	});
});
