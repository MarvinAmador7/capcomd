// Capability events.wait (ADR-026 §3): GET /v1/events `type`, `agent` and `wait`, the page's cursor, and the
// before-or-after rule for state filters.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addClient, loadClients } from "../../src/api/clients";
import { CAPABILITY_NAMES, EventsPage } from "../../src/api/contract";
import { harnessApp } from "../../src/api/server";
import { harnessState } from "../../src/api/state";
import { memorySource, type RawEvent } from "../../src/api/source";

const dir = mkdtempSync(join(tmpdir(), "capcomd-events-wait-"));
const path = join(dir, "clients.json");
const reader = addClient("reader", ["read"], path).token;
const run = { id: "run-1", projectId: null, label: "demo", state: "running", goal: null, repo: "/r", createdAt: "2026-10-25T07:00:00.000Z" };
const agent = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
	id, runId: "run-1", parent: null, depth: 0, profile: null, status, text: status, activity: null, task: null, taskAttachment: null, result: null,
	workspace: null, provider: null, model: null, effort: null, updatedAt: null, ...extra,
}) as any;

function setup(o: { agents?: any[]; pollMs?: number } = {}) {
	const log: RawEvent[] = [
		{ seq: 1, at: 1792900500000, type: "RUN_NEW", agentId: null, data: { budget: {}, label: "demo" } },
		{ seq: 2, at: 1792900501000, type: "AGENT_SPAWNED", agentId: "agt-a", data: {} },
		{ seq: 3, at: 1792900502000, type: "AGENT_SPAWNED", agentId: "agt-b", data: {} },
		{ seq: 4, at: 1792900503000, type: "AGENT_STARTED", agentId: "agt-a", data: {} },
	];
	const state = harnessState(null);
	const src = memorySource({ runs: [run], agents: { "run-1": o.agents ?? [agent("agt-a", "running"), agent("agt-b", "running")] }, events: { "run-1": log } });
	const app = harnessApp({ source: src, clients: () => loadClients(path), pollMs: o.pollMs ?? 10, state });
	let seq = log.length;
	const append = (type: string, agentId: string | null, data: Record<string, unknown> = {}) => { log.push({ seq: ++seq, at: Date.now(), type, agentId, data }); return seq; };
	const get = async (q: string) => {
		const r = await app.request(`/v1/events?${q}`, { headers: { authorization: `Bearer ${reader}` } });
		return { status: r.status, body: (await r.json()) as any };
	};
	return { app, log, append, get, state };
}

describe("GET /v1/events filters (events.wait)", () => {
	test("the capability is advertised", () => {
		expect(CAPABILITY_NAMES).toContain("events.wait");
	});

	test("without type, agent or wait: the plain list as before", async () => {
		const { get } = setup();
		const r = await get("scope=run-1&after=1");
		expect(Array.isArray(r.body)).toBe(true);
		expect(r.body.map((e: any) => e.seq)).toEqual([2, 3, 4]);
	});

	test("type filter: only those types, cursor past what was scanned", async () => {
		const { get } = setup();
		const r = await get("scope=run-1&type=agent.spawned");
		expect(r.status).toBe(200);
		expect(EventsPage.parse(r.body)).toBeTruthy();
		expect(r.body.events.map((e: any) => [e.seq, e.type])).toEqual([[2, "agent.spawned"], [3, "agent.spawned"]]);
		expect(r.body.cursor).toBe(4); // agent.started (4) was scanned and didn't match
		expect(r.body.reached).toEqual([]);
		expect(r.body.timedOut).toBe(false);
		// entitySeq counts from the start of the log, as the plain replay's do.
		expect(r.body.events[0].entitySeq).toBe(1);
	});

	test("types: repeated and comma lists; a legacy name is its dotted one", async () => {
		const { get } = setup();
		const a = await get("scope=run-1&type=agent.started&type=run.created");
		expect(a.body.events.map((e: any) => e.seq)).toEqual([1, 4]);
		const b = await get("scope=run-1&type=agent.started,run.created");
		expect(b.body.events.map((e: any) => e.seq)).toEqual([1, 4]);
		const c = await get("scope=run-1&type=AGENT_STARTED");
		expect(c.body.events.map((e: any) => e.seq)).toEqual([4]);
	});

	test("agent filter, repeated or comma", async () => {
		const { get } = setup();
		const a = await get("scope=run-1&agent=agt-a");
		expect(a.body.events.map((e: any) => e.seq)).toEqual([2, 4]);
		expect(a.body.cursor).toBe(4);
		const b = await get("scope=run-1&agent=agt-a,agt-b");
		expect(b.body.events.map((e: any) => e.seq)).toEqual([2, 3, 4]);
		const c = await get("scope=run-1&agent=agt-b&agent=agt-a&after=2");
		expect(c.body.events.map((e: any) => e.seq)).toEqual([3, 4]);
	});

	test("type and agent together", async () => {
		const { get } = setup();
		const r = await get("scope=run-1&type=agent.spawned&agent=agt-b");
		expect(r.body.events.map((e: any) => e.seq)).toEqual([3]);
		expect(r.body.cursor).toBe(4);
	});

	test("nothing matching and no wait: empty, cursor at the head", async () => {
		const { get } = setup();
		const r = await get("scope=run-1&type=agent.done&agent=agt-a");
		expect(r.body).toEqual({ events: [], cursor: 4, reached: [], timedOut: false });
	});

	test("wait returns as soon as a matching event is appended", async () => {
		const { get, append } = setup();
		const t0 = Date.now();
		const p = get("scope=run-1&after=4&type=agent.done&agent=agt-a&wait=5");
		await Bun.sleep(60);
		const s = append("AGENT_DONE", "agt-a", { summary: "ok" });
		const r = await p;
		expect(Date.now() - t0).toBeLessThan(2000);
		expect(r.body.events.map((e: any) => [e.seq, e.type, e.agentId])).toEqual([[s, "agent.done", "agt-a"]]);
		expect(r.body.cursor).toBe(s);
		expect(r.body.timedOut).toBe(false);
	});

	test("non-matching events don't end the wait; the cursor still moves past them", async () => {
		const { get, append } = setup();
		const p = get("scope=run-1&after=4&type=agent.done&agent=agt-a&wait=1");
		await Bun.sleep(50);
		append("AGENT_DONE", "agt-b"); // right type, other agent
		append("AGENT_STEP", "agt-a", { kind: "read", count: 1 }); // right agent, other type
		const t0 = Date.now();
		const r = await p;
		// It kept waiting until the wait ran out (about a second from the start).
		expect(Date.now() - t0).toBeGreaterThan(500);
		expect(r.body).toEqual({ events: [], cursor: 6, reached: [], timedOut: true });
	});

	test("a wait that times out with nothing new answers the cursor it was given", async () => {
		const { get } = setup();
		const r = await get("scope=run-1&after=4&type=agent.done&wait=1");
		expect(r.body).toEqual({ events: [], cursor: 4, reached: [], timedOut: true });
	});

	test("no lost event: one appended between looks is found, from any cursor", async () => {
		// A slow poll, and events appended at many moments: each must come back exactly once across resumed waits.
		const { get, append } = setup({ pollMs: 15 });
		let cursor = 4;
		const seen: number[] = [];
		const appended: number[] = [];
		const writer = (async () => {
			for (let i = 0; i < 20; i++) {
				append("AGENT_STEP", "agt-b", { kind: "read", count: 1 });
				appended.push(append(i % 2 ? "AGENT_DONE" : "AGENT_PAUSED", "agt-a"));
				await Bun.sleep(i % 3 === 0 ? 0 : 7);
			}
		})();
		while (seen.length < 20) {
			const r = await get(`scope=run-1&after=${cursor}&type=agent.done,agent.paused&agent=agt-a&wait=2`);
			expect(r.status).toBe(200);
			expect(r.body.cursor).toBeGreaterThanOrEqual(cursor);
			seen.push(...r.body.events.map((e: any) => e.seq));
			cursor = r.body.cursor;
		}
		await writer;
		expect(seen).toEqual(appended);
	});

	test("before-or-after: an agent already done answers at once with reached", async () => {
		// The source reports agt-a done, as the scope records it with its agent.done event.
		const { get, append } = setup({ agents: [agent("agt-a", "done"), agent("agt-b", "running")] });
		const done = append("AGENT_DONE", "agt-a");
		const head = append("AGENT_STEP", "agt-b", { kind: "edit", count: 1 });
		const t0 = Date.now();
		const r = await get(`scope=run-1&after=${head}&type=agent.done&agent=agt-a&wait=10`);
		expect(Date.now() - t0).toBeLessThan(1000);
		expect(r.body.events).toEqual([]);
		expect(r.body.timedOut).toBe(false);
		expect(r.body.cursor).toBe(head);
		expect(r.body.reached).toHaveLength(1);
		expect(r.body.reached[0]).toMatchObject({ agentId: "agt-a", type: "agent.done", event: { seq: done, type: "agent.done", agentId: "agt-a" } });
		// A running agent hasn't reached it: the same wait on agt-b waits and times out.
		const w = await get(`scope=run-1&after=${head}&type=agent.done&agent=agt-b&wait=1`);
		expect(w.body).toMatchObject({ events: [], reached: [], timedOut: true });
		// Only the state types asked for: agt-a is done, not failed.
		const f = await get(`scope=run-1&after=${head}&type=agent.failed&agent=agt-a&wait=1`);
		expect(f.body).toMatchObject({ events: [], reached: [], timedOut: true });
	});

	test("before-or-after: an asked agent, and an event after the cursor wins over reached", async () => {
		const asked = { questionId: "qst-1", approvalId: "apr-q", question: "which?", recommend: "a", options: ["a"], why: null, holds: null, to: null, at: "2026-10-25T07:00:00.000Z" };
		const { get, append } = setup({ agents: [agent("agt-a", "done", { asked }), agent("agt-b", "running")] });
		const q = append("AGENT_ASKED", "agt-a", { questionId: "qst-1" });
		const later = await get(`scope=run-1&after=${q}&type=agent.asked&agent=agt-a&wait=5`);
		expect(later.body.reached.map((x: any) => [x.agentId, x.type, x.event?.seq])).toEqual([["agt-a", "agent.asked", q]]);
		// From before the question, the event itself comes back, not reached.
		const before = await get(`scope=run-1&after=${q - 1}&type=agent.asked&agent=agt-a&wait=5`);
		expect(before.body.events.map((e: any) => e.seq)).toEqual([q]);
		expect(before.body.reached).toEqual([]);
		// Without `agent`, no state rule: a type filter alone just waits for new events.
		const any = await get(`scope=run-1&after=${q}&type=agent.asked&wait=1`);
		expect(any.body).toMatchObject({ events: [], reached: [], timedOut: true });
	});

	test("daemon scope: filters its own events and waits for new ones", async () => {
		const { get, state } = setup();
		state.recordDaemonEvent({ type: "profile.changed", entity: "profile:a", text: "a", data: {} });
		const b = state.recordDaemonEvent({ type: "project.configured", entity: "project:x", text: "x", data: {} });
		const r = await get("scope=daemon&type=project.configured");
		expect(r.body.events.map((e: any) => e.seq)).toEqual([b.seq]);
		expect(r.body.cursor).toBe(b.seq);
		const p = get(`scope=daemon&after=${b.seq}&agent=profile:a&wait=5`);
		await Bun.sleep(40);
		state.recordDaemonEvent({ type: "project.configured", entity: "project:y", text: "y", data: {} });
		const c = state.recordDaemonEvent({ type: "profile.changed", entity: "profile:a", text: "a2", data: {} });
		const w = await p;
		expect(w.body.events.map((e: any) => e.seq)).toEqual([c.seq]);
		expect(w.body.cursor).toBe(c.seq);
	});

	test("bad params: the API's error shape", async () => {
		const { get } = setup();
		for (const q of ["scope=run-1&wait=46", "scope=run-1&wait=-1", "scope=run-1&wait=soon", "scope=nope&type=agent.done", "scope=prj-1&type=agent.done", "scope=run-1&type=Not%20A%20Type", `scope=run-1&agent=${encodeURIComponent("a b")}`]) {
			const r = await get(q);
			expect([q, r.status]).toEqual([q, 422]);
			expect(r.body.code).toBe("invalid");
			expect(typeof r.body.message).toBe("string");
		}
		const nf = await get("scope=run-nope&wait=1");
		expect(nf.status).toBe(404);
		expect(nf.body.code).toBe("not_found");
		// The plain replay keeps its old answer for an unknown run.
		expect((await get("scope=run-nope")).body).toEqual([]);
	});

	test("a client that goes away ends the wait", async () => {
		const { app } = setup();
		const ac = new AbortController();
		const t0 = Date.now();
		const p = Promise.resolve(app.request("/v1/events?scope=run-1&after=4&type=agent.done&wait=30", { headers: { authorization: `Bearer ${reader}` }, signal: ac.signal })).catch(() => null);
		await Bun.sleep(50);
		ac.abort();
		await p;
		expect(Date.now() - t0).toBeLessThan(5000);
	});
});
