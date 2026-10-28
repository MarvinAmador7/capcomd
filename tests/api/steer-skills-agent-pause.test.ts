// harness.v1 follow-ups to the run controls, for the menu bar's thread input: skills attached to a steer
// (capability steer.skills) and pausing one agent with its subtree (capability agent.pause), feature-detected
// through GET /v1/health `capabilities`.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addClient, loadClients } from "../../src/api/clients";
import { AgentControl, CAPABILITY_NAMES, SentMessage } from "../../src/api/contract";
import { harnessApp } from "../../src/api/server";
import { harnessState } from "../../src/api/state";
import { memorySource, type RawEvent } from "../../src/api/source";
import { messageText } from "../../src/agents/runner";
import { SKILL_MAX_BYTES, withSkills } from "../../src/agents/skills";

const dir = mkdtempSync(join(tmpdir(), "harness-steer-"));
const path = join(dir, "clients.json");
const reader = addClient("reader", ["read"], path).token;
const steer = addClient("Menu bar", ["read", "steer"], path).token;
const other = addClient("other", ["read", "steer"], path).token;

const at = 1792900500000;
const agent = (id: string, status: string, parent: string | null = null) =>
	({ id, runId: "run-1", parent, depth: parent ? 1 : 0, profile: "worker", status, text: "", task: "t", taskAttachment: null, result: null, updatedAt: null }) as any;
const SKILLS = [
	{ name: "tdd", description: "Test first", source: "user" as const, content: "---\nname: tdd\ndescription: Test first\n---\nWrite the failing test first." },
	{ name: "review", description: "Review", source: "bundled" as const, content: "---\nname: review\n---\nRead the diff twice." },
	{ name: "huge", description: "Too big", source: "user" as const, content: "x".repeat(SKILL_MAX_BYTES + 1) },
	...Array.from({ length: 8 }, (_, i) => ({ name: `s${i}`, description: "", source: "user" as const, content: `skill ${i}` })),
	...["half-a", "half-b"].map((name) => ({ name, description: "", source: "user" as const, content: "y".repeat(SKILL_MAX_BYTES / 2 + 1) })),
];

// a1 (running) ── a2 (pending), a3 (done); b1 (running) is another tree of the same run.
function setup() {
	const events: RawEvent[] = [
		{ seq: 1, at, type: "RUN_NEW", agentId: null, data: { budget: {}, label: "demo" } },
		{ seq: 2, at: at + 1, type: "AGENT_SPAWNED", agentId: "a1", data: { parent: null, depth: 0, profile: "worker", task: "t", key: null, operator: true, budget: {}, limits: {}, agent: null } },
		{ seq: 3, at: at + 2, type: "AGENT_STARTED", agentId: "a1", data: {} },
		{ seq: 4, at: at + 3, type: "AGENT_SPAWNED", agentId: "a2", data: { parent: "a1", depth: 1, profile: "worker", task: "t", key: null, operator: false, budget: {}, limits: {}, agent: null } },
		{ seq: 5, at: at + 4, type: "AGENT_SPAWNED", agentId: "a3", data: { parent: "a1", depth: 1, profile: "worker", task: "t", key: null, operator: false, budget: {}, limits: {}, agent: null } },
		{ seq: 6, at: at + 5, type: "AGENT_STARTED", agentId: "a3", data: {} },
		{ seq: 7, at: at + 6, type: "AGENT_DONE", agentId: "a3", data: { result: { summary: "ok" }, spent: {}, budget: {} } },
		{ seq: 8, at: at + 7, type: "AGENT_SPAWNED", agentId: "b1", data: { parent: null, depth: 0, profile: "worker", task: "t", key: null, operator: true, budget: {}, limits: {}, agent: null } },
		{ seq: 9, at: at + 8, type: "AGENT_STARTED", agentId: "b1", data: {} },
	];
	const run = { id: "run-1", projectId: null, label: "demo", state: "running", goal: null, repo: "/r", createdAt: "2026-10-25T07:00:00.000Z" };
	const agents = [agent("a1", "running"), agent("a2", "pending", "a1"), agent("a3", "done", "a1"), agent("b1", "running")];
	const src = memorySource({ runs: [run], agents: { "run-1": agents }, events: { "run-1": events }, skills: SKILLS });
	const app = harnessApp({ source: src, clients: () => loadClients(path), pollMs: 20, state: harnessState(null) });
	type Res = Omit<Response, "json"> & { json(): Promise<any> };
	const req = async (p: string, token: string, key?: string, body?: unknown): Promise<Res> => app.request(p, {
		method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) },
		...(body !== undefined ? { body: JSON.stringify(body) } : {}),
	});
	const get = async (p: string) => (await app.request(p, { headers: { authorization: `Bearer ${reader}` } })).json() as Promise<any>;
	const send = (key: string | undefined, body: unknown, agentId = "a1", token = steer) => req(`/v1/runs/run-1/agents/${agentId}/messages`, token, key, body);
	const sentEvents = async () => ((await get("/v1/events?scope=run-1")) as any[]).filter((e) => e.type === "message.sent");
	const lifecycle = async () => ((await get("/v1/runs/run-1/lifecycle")) as any[]).map((e) => e.type);
	const status = (id: string) => agents.find((a) => a.id === id)!.status;
	return { app, src, req, get, send, sentEvents, lifecycle, status };
}

describe("health capabilities", () => {
	test("health lists the features a client can detect, with no token", async () => {
		const { app } = setup();
		const h = await (await app.request("/v1/health")).json() as any;
		expect(h.capabilities).toEqual(["run.controls", "agents.messages", "steer.skills", "agent.pause", "runs.options", "runs.options.repo", "runs.options.sandbox", "agent.steps", "logins", "environments", "service", "sandboxes", "sandboxes.resources", "sandboxes.settings", "sandboxes.actions", "projects.setup"]);
		expect(h.capabilities).toEqual(CAPABILITY_NAMES);
	});
});

describe("steer with skills (steer.skills)", () => {
	test("the agent gets each skill's SKILL.md with the message; message.sent echoes the names", async () => {
		const { send, sentEvents, src, get } = setup();
		const r = await send("msg-skills-1", { body: "add a test for sum", skills: ["tdd", "review", "tdd"] });
		expect(r.status).toBe(200);
		const m = SentMessage.parse(await r.json());
		expect(m).toEqual({ runId: "run-1", to: "a1", from: "operator", seq: 1, note: null });
		const ev = await sentEvents();
		expect(ev.length).toBe(1);
		expect(ev[0].data).toMatchObject({ seq: m.seq, to: "a1", text: "add a test for sum", skills: ["tdd", "review"] }); // a repeat is sent once
		// What the agent receives: the body, then each SKILL.md (the thread shows only the body).
		expect(src.delivered).toEqual([{ runId: "run-1", to: "a1", seq: 1, body: "add a test for sum", skills: [{ name: "tdd", content: SKILLS[0]!.content }, { name: "review", content: SKILLS[1]!.content }] }]);
		expect(await get("/v1/runs/run-1/messages")).toEqual([expect.objectContaining({ seq: 1, text: "add a test for sum" })]);
		// A message without skills echoes an empty list.
		await send("msg-skills-2", { body: "plain" });
		expect((await sentEvents())[1].data.skills).toEqual([]);
	});

	test("validation: unknown, too many, too big or not a list of names is 422 invalid and sends nothing", async () => {
		const { send, sentEvents } = setup();
		const unknown = await send("msg-skills-1", { body: "x", skills: ["tdd", "nope"] });
		expect(unknown.status).toBe(422);
		expect(await unknown.json()).toEqual({ code: "invalid", message: 'There is no skill named "nope": GET /v1/skills lists the skills you can attach.' });
		const many = await send("msg-skills-2", { body: "x", skills: ["tdd", ...Array.from({ length: 8 }, (_, i) => `s${i}`)] });
		expect(many.status).toBe(422);
		expect((await many.json()).message).toBe("At most 8 skills can go with one message (got 9).");
		expect((await send("msg-skills-3", { body: "x", skills: Array.from({ length: 8 }, (_, i) => `s${i}`) })).status).toBe(200); // 8 is fine
		const big = await send("msg-skills-4", { body: "x", skills: ["huge"] });
		expect(big.status).toBe(422);
		expect((await big.json()).message).toContain('The skill "huge" is over');
		expect((await send("msg-skills-6", { body: "x", skills: ["half-a"] })).status).toBe(200);
		const both = await send("msg-skills-7", { body: "x", skills: ["half-a", "half-b"] });
		expect(both.status).toBe(422);
		expect((await both.json()).message).toBe(`These skills add up to over ${SKILL_MAX_BYTES} bytes, too much to send with one message: attach fewer.`);
		for (const bad of [{ body: "x", skills: "tdd" }, { body: "x", skills: [3] }, { body: "x", skills: [""] }]) {
			const r = await send("msg-skills-5", bad);
			expect(r.status).toBe(422);
			expect((await r.json()).code).toBe("invalid");
		}
		expect((await sentEvents()).length).toBe(2);
		// A 422 is not stored: the same key with a fixed request goes through.
		expect((await send("msg-skills-1", { body: "x", skills: ["tdd"] })).status).toBe(200);
	});

	test("idempotency: the same key with other skills is a conflict, like another body; the same request replays", async () => {
		const { send, sentEvents } = setup();
		const a = await (await send("msg-skills-1", { body: "hi", skills: ["tdd"] })).json();
		const b = await send("msg-skills-1", { body: "hi", skills: ["tdd"] });
		expect(b.status).toBe(200);
		expect(await b.json()).toEqual(a);
		for (const other of [{ body: "hi", skills: ["review"] }, { body: "hi" }, { body: "hi", skills: [] }, { body: "hi", skills: ["tdd", "review"] }]) {
			const c = await send("msg-skills-1", other);
			expect(c.status).toBe(409);
			expect((await c.json()).code).toBe("idempotency_conflict");
		}
		// Without skills, a request hashes as it did before skill attach: `skills: []` and no field are the same request.
		await send("msg-plain-1", { body: "hey" });
		expect((await send("msg-plain-1", { body: "hey", skills: [] })).status).toBe(200);
		expect((await sentEvents()).length).toBe(2);
	});

	test("what the agent reads: the message, then the skills", () => {
		const text = messageText({ from: "operator", body: "add a test", skills: [{ name: "tdd", content: "Write the failing test first.\n" }] });
		expect(text).toBe([
			"Message from the operator, sent while you work (capcomd send):", "", "add a test", "",
			"The sender attached this skill to the message: read it and use it for this request.", "",
			'<skill name="tdd">', "Write the failing test first.", "</skill>",
		].join("\n"));
		expect(withSkills("plain", [])).toBe("plain");
		expect(withSkills("plain", undefined)).toBe("plain");
	});
});

describe("agent pause (agent.pause)", () => {
	const pause = (req: any, key: string | undefined, agentId = "a1", token = steer) => req(`/v1/runs/run-1/agents/${agentId}/pause`, token, key);
	const resume = (req: any, key: string | undefined, agentId = "a1", token = steer) => req(`/v1/runs/run-1/agents/${agentId}/resume`, token, key);

	test("needs the steer scope, an Idempotency-Key and a known run and agent", async () => {
		const { req } = setup();
		expect((await pause(req, "pause-0001", "a1", reader)).status).toBe(403);
		const noKey = await pause(req, undefined);
		expect(noKey.status).toBe(422);
		expect((await noKey.json()).code).toBe("invalid");
		const nf = await pause(req, "pause-0002", "agt-nope");
		expect(nf.status).toBe(404);
		expect(await nf.json()).toEqual({ code: "not_found", message: "agent agt-nope not found" });
		const run = await req("/v1/runs/run-nope/agents/a1/pause", steer, "pause-0003");
		expect(run.status).toBe(404);
		expect((await run.json()).message).toBe("run run-nope not found");
	});

	test("pauses the agent and its subtree, not the rest of the run; agent.paused confirms each", async () => {
		const { req, lifecycle, status, get } = setup();
		const r = await pause(req, "pause-0001");
		expect(r.status).toBe(200);
		expect(AgentControl.parse(await r.json())).toEqual({ runId: "run-1", agentId: "a1", action: "pause", changed: ["a2"], pending: ["a1"] });
		expect([status("a1"), status("a2"), status("a3"), status("b1")]).toEqual(["paused", "paused", "done", "running"]);
		const life = await lifecycle();
		expect(life.filter((t) => t === "agent.paused").length).toBe(2);
		// b1 still works: the run is not paused.
		expect(life).not.toContain("run.paused");
		const ev = ((await get("/v1/runs/run-1/lifecycle")) as any[]).find((e) => e.type === "agent.paused");
		expect(ev.data).toMatchObject({ cause: "paused", result: { limit: "paused", by: expect.stringMatching(/^client:cli-/) } });
		// Nothing left to pause in that subtree: 409 conflict.
		const again = await pause(req, "pause-0002");
		expect(again.status).toBe(409);
		expect(await again.json()).toMatchObject({ code: "conflict", message: expect.stringContaining("no pending or running agent") });
	});

	test("the run reads as paused once every live agent is, and resumed when one runs again", async () => {
		const { req, lifecycle, status } = setup();
		await pause(req, "pause-0001", "a1");
		await pause(req, "pause-0002", "b1");
		expect((await lifecycle()).filter((t) => t.startsWith("run."))).toEqual(["run.created", "run.started", "run.paused"]);
		const r = await resume(req, "resume-001", "b1");
		expect(r.status).toBe(200);
		expect(await r.json()).toEqual({ runId: "run-1", agentId: "b1", action: "resume", changed: ["b1"], pending: [] });
		expect((await lifecycle()).filter((t) => t.startsWith("run."))).toEqual(["run.created", "run.started", "run.paused", "run.resumed"]);
		expect([status("a1"), status("a2"), status("b1")]).toEqual(["paused", "paused", "running"]);
	});

	test("resume runs the agent and its paused descendants; 409 when nothing there is paused", async () => {
		const { req, status, lifecycle } = setup();
		const none = await resume(req, "resume-001");
		expect(none.status).toBe(409);
		expect((await none.json()).code).toBe("conflict");
		await pause(req, "pause-0001");
		const r = await resume(req, "resume-002");
		expect(await r.json()).toEqual({ runId: "run-1", agentId: "a1", action: "resume", changed: ["a1", "a2"], pending: [] });
		expect([status("a1"), status("a2")]).toEqual(["running", "running"]);
		expect((await lifecycle()).filter((t) => t === "agent.resumed").length).toBe(2);
		// A failed (409) request isn't stored: the same key looks again.
		expect((await resume(req, "resume-001")).status).toBe(409);
	});

	test("idempotency: replay; the same key on another agent, route or client's request", async () => {
		const { req, src } = setup();
		const first = await (await pause(req, "pause-0001")).json();
		const n = (await src.events("run-1", 0)).length;
		const replay = await pause(req, "pause-0001");
		expect(replay.status).toBe(200);
		expect(await replay.json()).toEqual(first);
		expect((await src.events("run-1", 0)).length).toBe(n);
		for (const c of [await pause(req, "pause-0001", "b1"), await resume(req, "pause-0001"), await req("/v1/runs/run-1/pause", steer, "pause-0001")]) {
			expect(c.status).toBe(409);
			expect((await c.json()).code).toBe("idempotency_conflict");
		}
		// Keys are per client: another client's identical key is its own request (here nothing is left to pause).
		expect((await (await pause(req, "pause-0001", "a1", other)).json()).code).toBe("conflict");
	});
});
