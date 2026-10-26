// harness.v1 write routes for the menu bar: pause / resume / cancel a run, and steer an agent with a message.
// Same Idempotency-Key rules as decisions; the state change arrives as the existing events on the run's streams.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addClient, loadClients } from "../../src/api/clients";
import { RunControl, SentMessage } from "../../src/api/contract";
import { harnessApp } from "../../src/api/server";
import { harnessState } from "../../src/api/state";
import { memorySource, type RawEvent } from "../../src/api/source";

const dir = mkdtempSync(join(tmpdir(), "harness-ctl-"));
const path = join(dir, "clients.json");
const reader = addClient("reader", ["read"], path).token;
const approver = addClient("ive", ["read", "approve"], path).token;
const steer = addClient("Menu bar", ["read", "steer"], path).token;
const other = addClient("other", ["read", "steer"], path).token;

const at = 1792900500000;
const agent = (id: string, status: string, parent: string | null = null) =>
	({ id, runId: "run-1", parent, depth: parent ? 1 : 0, profile: "worker", status, text: "", task: "t", taskAttachment: null, result: null, updatedAt: null }) as any;

function setup(o: { statePath?: string | null } = {}) {
	const events: RawEvent[] = [
		{ seq: 1, at, type: "RUN_NEW", agentId: null, data: { budget: {}, label: "demo" } },
		{ seq: 2, at: at + 1, type: "AGENT_SPAWNED", agentId: "a1", data: { parent: null, depth: 0, profile: "worker", task: "t", key: null, operator: true, budget: {}, limits: {}, agent: null } },
		{ seq: 3, at: at + 2, type: "AGENT_STARTED", agentId: "a1", data: {} },
		{ seq: 4, at: at + 3, type: "AGENT_SPAWNED", agentId: "a2", data: { parent: "a1", depth: 1, profile: "worker", task: "t", key: null, operator: false, budget: {}, limits: {}, agent: null } },
		{ seq: 5, at: at + 4, type: "AGENT_SPAWNED", agentId: "a3", data: { parent: "a1", depth: 1, profile: "worker", task: "t", key: null, operator: false, budget: {}, limits: {}, agent: null } },
		{ seq: 6, at: at + 5, type: "AGENT_STARTED", agentId: "a3", data: {} },
		{ seq: 7, at: at + 6, type: "AGENT_DONE", agentId: "a3", data: { result: { summary: "ok" }, spent: {}, budget: {} } },
	];
	const run = { id: "run-1", projectId: null, label: "demo", state: "running", goal: null, repo: "/r", createdAt: "2026-10-25T07:00:00.000Z" };
	const src = memorySource({ runs: [run], agents: { "run-1": [agent("a1", "running"), agent("a2", "pending", "a1"), agent("a3", "done", "a1")] }, events: { "run-1": events } });
	const state = harnessState(o.statePath ?? null);
	const app = harnessApp({ source: src, clients: () => loadClients(path), pollMs: 20, state });
	type Res = Omit<Response, "json"> & { json(): Promise<any> };
	const req = async (p: string, token: string, key?: string, body?: unknown): Promise<Res> => app.request(p, {
		method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) },
		...(body !== undefined ? { body: JSON.stringify(body) } : {}),
	});
	const get = async (p: string) => (await app.request(p, { headers: { authorization: `Bearer ${reader}` } })).json() as Promise<any>;
	const types = async () => ((await get("/v1/events?scope=run-1")) as any[]).map((e) => e.type);
	return { src, req, get, types };
}

describe("run controls", () => {
	test("need the steer scope and an Idempotency-Key", async () => {
		const { req } = setup();
		for (const t of [reader, approver]) {
			const r = await req("/v1/runs/run-1/pause", t, "key-00001");
			expect(r.status).toBe(403);
			expect((await r.json()).code).toBe("forbidden");
		}
		const r = await req("/v1/runs/run-1/pause", steer);
		expect(r.status).toBe(422);
		expect((await r.json()).code).toBe("invalid");
		expect((await req("/v1/runs/run-1/pause", steer, "short")).status).toBe(422);
	});

	test("pause: a pending agent pauses now, a running one is asked; agent.paused and run.paused confirm; replay and conflicts", async () => {
		const { req, types, get, src } = setup();
		const r = await req("/v1/runs/run-1/pause", steer, "pause-0001");
		expect(r.status).toBe(200);
		const body = await r.json();
		expect(RunControl.parse(body)).toEqual({ runId: "run-1", action: "pause", changed: ["a2"], pending: ["a1"] });
		const evs = await types();
		expect(evs.filter((t) => t === "agent.paused").length).toBe(2);
		const life = (await get("/v1/runs/run-1/lifecycle")) as any[];
		expect(life.map((e) => e.type)).toContain("run.paused");
		expect(life.find((e) => e.type === "agent.paused").data).toMatchObject({ cause: "paused", result: { limit: "paused", by: expect.stringMatching(/^client:cli-/) } });

		// same key, same request: the first result, nothing applied again
		const n = (await src.events("run-1", 0)).length;
		const again = await req("/v1/runs/run-1/pause", steer, "pause-0001");
		expect(again.status).toBe(200);
		expect(await again.json()).toEqual(body);
		expect((await src.events("run-1", 0)).length).toBe(n);
		// same key on another route or run: idempotency_conflict
		for (const p of ["/v1/runs/run-1/resume", "/v1/runs/run-2/pause"]) {
			const c = await req(p, steer, "pause-0001");
			expect(c.status).toBe(409);
			expect((await c.json()).code).toBe("idempotency_conflict");
		}
		// keys are per client: another client's identical key is its own request
		const o = await req("/v1/runs/run-1/pause", other, "pause-0001");
		expect(o.status).toBe(409);
		expect(await o.json()).toMatchObject({ code: "conflict", message: expect.stringContaining("no pending or running agent") });
		// a new key with nothing left to pause: conflict
		expect((await (await req("/v1/runs/run-1/pause", steer, "pause-0002")).json()).code).toBe("conflict");
	});

	test("resume: paused agents run again, confirmed by agent.resumed and run.resumed; 409 when none is paused", async () => {
		const { req, get } = setup();
		const none = await req("/v1/runs/run-1/resume", steer, "resume-001");
		expect(none.status).toBe(409);
		expect((await none.json()).code).toBe("conflict");
		await req("/v1/runs/run-1/pause", steer, "pause-0001");
		const r = await req("/v1/runs/run-1/resume", steer, "resume-002");
		expect(r.status).toBe(200);
		expect(await r.json()).toEqual({ runId: "run-1", action: "resume", changed: ["a1", "a2"], pending: [] });
		const life = ((await get("/v1/runs/run-1/lifecycle")) as any[]).map((e) => e.type);
		expect(life.slice(-5)).toEqual(["agent.paused", "run.paused", "agent.resumed", "run.resumed", "agent.resumed"]);
		// a retry of the first (failed) request looks again rather than replaying the 409: nothing was stored
		expect((await req("/v1/runs/run-1/resume", steer, "resume-001")).status).toBe(409);
	});

	test("cancel: every live agent is cancelled; run.cancelled even though one agent had finished", async () => {
		const { req, get } = setup();
		const r = await req("/v1/runs/run-1/cancel", steer, "cancel-001");
		expect(r.status).toBe(200);
		expect(await r.json()).toEqual({ runId: "run-1", action: "cancel", changed: ["a1", "a2"], pending: [] });
		const life = (await get("/v1/runs/run-1/lifecycle")) as any[];
		expect(life.filter((e) => e.type.startsWith("run.")).map((e) => e.type)).toEqual(["run.created", "run.started", "run.cancelled"]);
		expect(life.at(-1).data.cause).toBe("cancelled");
		const again = await req("/v1/runs/run-1/cancel", steer, "cancel-002");
		expect(again.status).toBe(409);
		expect(((await again.json()) as any).code).toBe("conflict");
	});

	test("unknown run: 404 not_found", async () => {
		const { req } = setup();
		const r = await req("/v1/runs/run-nope/cancel", steer, "cancel-001");
		expect(r.status).toBe(404);
		expect(((await r.json()) as any).code).toBe("not_found");
	});

	test("a replay survives a daemon restart (keys are persisted)", async () => {
		const statePath = join(mkdtempSync(join(tmpdir(), "hs-")), "harness-state.json");
		const first = setup({ statePath });
		const a = await (await first.req("/v1/runs/run-1/pause", steer, "pause-0001")).json();
		const second = setup({ statePath }); // fresh source: pausing again would change things
		const b = await second.req("/v1/runs/run-1/pause", steer, "pause-0001");
		expect(b.status).toBe(200);
		expect(await b.json()).toEqual(a);
		expect((await second.types()).filter((t) => t === "agent.paused").length).toBe(0);
	});
});

describe("steer messages", () => {
	const send = (req: any, key: string | undefined, body: unknown, agentId = "a1", token = steer) => req(`/v1/runs/run-1/agents/${agentId}/messages`, token, key, body);

	test("sends from the operator; the confirming message.sent carries the returned seq", async () => {
		const { req, get } = setup();
		const r = await send(req, "msg-000001", { body: "use the v2 API" });
		expect(r.status).toBe(200);
		const m = SentMessage.parse(await r.json());
		expect(m).toEqual({ runId: "run-1", to: "a1", from: "operator", seq: 1, note: null });
		const evs = (await get("/v1/events?scope=run-1")) as any[];
		const sent = evs.filter((e) => e.type === "message.sent");
		expect(sent.length).toBe(1);
		expect(sent[0].data).toMatchObject({ seq: m.seq, to: "a1", text: "use the v2 API" });
		expect(await get("/v1/runs/run-1/messages")).toEqual([expect.objectContaining({ seq: m.seq, from: "operator", to: "a1", text: "use the v2 API" })]);
	});

	test("idempotent: same key + body replays the same seq once; same key + other body is idempotency_conflict", async () => {
		const { req, get } = setup();
		const a = await (await send(req, "msg-000001", { body: "hi" })).json();
		const b = await send(req, "msg-000001", { body: "hi" });
		expect(b.status).toBe(200);
		expect(await b.json()).toEqual(a);
		const c = await send(req, "msg-000001", { body: "hello" });
		expect(c.status).toBe(409);
		expect((await c.json()).code).toBe("idempotency_conflict");
		expect((await send(req, "msg-000001", { body: "hi" }, "a2")).status).toBe(409); // another agent is another request
		const d = await (await send(req, "msg-000002", { body: "hi" })).json();
		expect(d.seq).toBe(a.seq + 1); // a new key is a new message
		expect(((await get("/v1/events?scope=run-1")) as any[]).filter((e) => e.type === "message.sent").length).toBe(2);
	});

	test("concurrent duplicates send once and both get the result", async () => {
		const { req, get } = setup();
		const [x, y] = await Promise.all([send(req, "msg-000001", { body: "once" }), send(req, "msg-000001", { body: "once" })]);
		expect([x.status, y.status]).toEqual([200, 200]);
		expect(await x.json()).toEqual(await y.json());
		expect(((await get("/v1/events?scope=run-1")) as any[]).filter((e) => e.type === "message.sent").length).toBe(1);
	});

	test("errors: 403 without steer, 422 bad body, 404 unknown agent or run, 409 ended agent", async () => {
		const { req } = setup();
		expect((await send(req, "msg-000001", { body: "x" }, "a1", approver)).status).toBe(403);
		expect((await send(req, undefined, { body: "x" })).status).toBe(422);
		for (const bad of [{}, { body: "" }, { body: 3 }, "text"]) {
			const r = await send(req, "msg-000001", bad);
			expect(r.status).toBe(422);
			expect((await r.json()).code).toBe("invalid");
		}
		expect((await send(req, "msg-000001", { body: "x".repeat(1024 * 1024 + 1) })).status).toBe(422);
		const nf = await send(req, "msg-000002", { body: "x" }, "agt-nope");
		expect(nf.status).toBe(404);
		expect((await nf.json()).code).toBe("not_found");
		expect((await req("/v1/runs/run-nope/agents/a1/messages", steer, "msg-000003", { body: "x" })).status).toBe(404);
		const ended = await send(req, "msg-000004", { body: "x" }, "a3");
		expect(ended.status).toBe(409);
		expect(await ended.json()).toMatchObject({ code: "conflict", message: "a3 is done: nothing will read this message" });
	});
});
