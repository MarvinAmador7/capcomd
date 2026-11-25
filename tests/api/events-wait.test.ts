// Capability events.wait (ADR-026 §3): GET /v1/events/wait's `type`, `agent` and `wait`, the page's cursor, and the
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
		const r = await app.request(`/v1/events/wait?${q}`, { headers: { authorization: `Bearer ${reader}` } });
		return { status: r.status, body: (await r.json()) as any };
	};
	const replay = async (q: string) => {
		const r = await app.request(`/v1/events?${q}`, { headers: { authorization: `Bearer ${reader}` } });
		return { status: r.status, body: (await r.json()) as any };
	};
	return { app, log, append, get, replay, state };
}

describe("GET /v1/events/wait (events.wait)", () => {
	test("the capability is advertised", () => {
		expect(CAPABILITY_NAMES).toContain("events.wait");
	});

	test("GET /v1/events stays a plain list, whatever else is asked", async () => {
		const { replay } = setup();
		for (const q of ["scope=run-1&after=1", "scope=run-1&after=1&type=agent.started&wait=5"]) {
			const r = await replay(q);
			expect(Array.isArray(r.body)).toBe(true);
			expect(r.body.map((e: any) => e.seq)).toEqual([2, 3, 4]);
		}
	});

	test("no filter and no wait: a page of everything after the cursor", async () => {
		const { get } = setup();
		const r = await get("scope=run-1&after=1");
		expect(r.body.events.map((e: any) => e.seq)).toEqual([2, 3, 4]);
		expect(r.body).toMatchObject({ cursor: 4, reached: [], timedOut: false });
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
		const { get, replay } = setup();
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
		expect((await replay("scope=run-nope")).body).toEqual([]);
	});

	test("a client that goes away ends the wait", async () => {
		const { app } = setup();
		const ac = new AbortController();
		const t0 = Date.now();
		const p = Promise.resolve(app.request("/v1/events/wait?scope=run-1&after=4&type=agent.done&wait=30", { headers: { authorization: `Bearer ${reader}` }, signal: ac.signal })).catch(() => null);
		await Bun.sleep(50);
		ac.abort();
		await p;
		expect(Date.now() - t0).toBeLessThan(5000);
	});
});

// The push path: a wait looks again as soon as its scope says it appended (the source's subscribeEvents, the daemon
// state's onDaemonEvent) instead of at its next poll. These servers poll only every minute, so an answer within a few
// milliseconds of an append came from the push.
describe("GET /v1/events/wait: woken by push", () => {
	const SLOW = 60_000;
	function pushed(o: { waitFallbackMs?: number } = {}) {
		const state = harnessState(null);
		const log: RawEvent[] = [{ seq: 1, at: 1792900500000, type: "RUN_NEW", agentId: null, data: { budget: {}, label: "demo" } }];
		const src = memorySource({ runs: [run], agents: { "run-1": [agent("agt-a", "running"), agent("agt-b", "running")] }, events: { "run-1": log } });
		const app = harnessApp({ source: src, clients: () => loadClients(path), pollMs: SLOW, state, ...o });
		const append = (type: string, agentId: string | null, data: Record<string, unknown> = {}) => src.push("run-1", { at: Date.now(), type, agentId, data }).seq;
		const get = async (q: string, signal?: AbortSignal) => {
			const r = await app.request(`/v1/events/wait?${q}`, { headers: { authorization: `Bearer ${reader}` }, ...(signal ? { signal } : {}) });
			return { status: r.status, body: (await r.json()) as any };
		};
		return { src, state, app, log, append, get };
	}
	/** Resolves once `cond` holds (checked every ms), or throws after `ms`. */
	const until = async (cond: () => boolean, ms = 2000) => {
		const end = Date.now() + ms;
		while (!cond()) { if (Date.now() > end) throw new Error("condition not reached"); await Bun.sleep(1); }
	};

	test("a run scope's wait answers within milliseconds of the append", async () => {
		const { src, append, get } = pushed();
		const p = get("scope=run-1&after=1&type=agent.done&agent=agt-a&wait=30");
		await until(() => src.eventListeners("run-1") === 1);
		await Bun.sleep(20);
		append("AGENT_STEP", "agt-a", { kind: "read", count: 1 }); // told, looked at, doesn't match: it keeps waiting
		await Bun.sleep(20);
		const t0 = performance.now();
		const s = append("AGENT_DONE", "agt-a", { summary: "ok" });
		const r = await p;
		const ms = performance.now() - t0;
		expect(ms).toBeLessThan(100);
		expect(r.body).toMatchObject({ cursor: s, reached: [], timedOut: false });
		expect(r.body.events.map((e: any) => e.seq)).toEqual([s]);
		expect(src.eventListeners()).toBe(0);
	});

	test("the daemon scope's wait answers within milliseconds of the event", async () => {
		const { state, get } = pushed();
		const head = state.recordDaemonEvent({ type: "profile.changed", entity: "profile:a", text: "a", data: {} }).seq;
		const p = get(`scope=daemon&after=${head}&type=project.configured&wait=30`);
		await until(() => state.daemonListeners() === 1);
		state.recordDaemonEvent({ type: "profile.changed", entity: "profile:a", text: "a2", data: {} });
		await Bun.sleep(20);
		const t0 = performance.now();
		const c = state.recordDaemonEvent({ type: "project.configured", entity: "project:x", text: "x", data: {} });
		const r = await p;
		expect(performance.now() - t0).toBeLessThan(100);
		expect(r.body.events.map((e: any) => e.seq)).toEqual([c.seq]);
		expect(r.body.cursor).toBe(c.seq);
		expect(state.daemonListeners()).toBe(0);
	});

	test("no lost event: concurrent appends and resumed waits, two waiters, woken only by push", async () => {
		const { src, append, get } = pushed();
		const appended: number[] = [];
		const N = 40;
		const writer = (async () => {
			for (let i = 0; i < N; i++) {
				append("AGENT_STEP", "agt-b", { kind: "read", count: 1 });
				appended.push(append(i % 2 ? "AGENT_DONE" : "AGENT_PAUSED", "agt-a"));
				// Some in the same tick, some between a tell and its look, some while nobody waits.
				await Bun.sleep(i % 3 === 0 ? 0 : i % 3 === 1 ? 1 : 5);
			}
		})();
		const waiter = async () => {
			let cursor = 1;
			const seen: number[] = [];
			while (seen.length < N) {
				const r = await get(`scope=run-1&after=${cursor}&type=agent.done,agent.paused&agent=agt-a&wait=10`);
				expect(r.status).toBe(200);
				expect(r.body.timedOut).toBe(false); // every append was told: none waited for the minute's poll
				expect(r.body.cursor).toBeGreaterThanOrEqual(cursor);
				seen.push(...r.body.events.map((e: any) => e.seq));
				cursor = r.body.cursor;
			}
			return seen;
		};
		const [a, b] = await Promise.all([waiter(), waiter(), writer]);
		expect(a).toEqual(appended);
		expect(b).toEqual(appended);
		expect(src.eventListeners()).toBe(0);
	});

	test("an append no one was told of is still found by the fallback poll", async () => {
		const { src, log, get } = pushed({ waitFallbackMs: 100 });
		const p = get("scope=run-1&after=1&type=agent.done&wait=10");
		await until(() => src.eventListeners("run-1") === 1);
		// Written straight into the log, with no tell (as one lost while a feed reconnects).
		log.push({ seq: 2, at: Date.now(), type: "AGENT_DONE", agentId: "agt-a", data: {} });
		const t0 = Date.now();
		const r = await p;
		expect(Date.now() - t0).toBeLessThan(1000);
		expect(r.body).toMatchObject({ cursor: 2, timedOut: false });
		expect(r.body.events.map((e: any) => e.seq)).toEqual([2]);
	});

	test("listeners: none left after waits that end every way, and after clients that go away", async () => {
		const { src, state, append, get } = pushed();
		const head = append("AGENT_STEP", "agt-b", { kind: "read", count: 1 });
		// No wait: never subscribes. An event already there: answers on the first look.
		await get("scope=run-1&after=1");
		for (let i = 0; i < 20; i++) await get(`scope=run-1&after=1&type=agent.step&wait=5`);
		expect(src.eventListeners()).toBe(0);
		// Waits that end by a push, many at once.
		const many = Array.from({ length: 30 }, () => get(`scope=run-1&after=${head}&type=agent.done&wait=30`));
		await until(() => src.eventListeners("run-1") === 30);
		append("AGENT_DONE", "agt-a");
		for (const r of await Promise.all(many)) expect(r.body.events).toHaveLength(1);
		expect(src.eventListeners()).toBe(0);
		// Waits that run out.
		const short = harnessApp({ source: src, clients: () => loadClients(path), pollMs: SLOW, state });
		await Promise.all(Array.from({ length: 5 }, () => short.request(`/v1/events/wait?scope=run-1&after=100&type=agent.done&wait=1`, { headers: { authorization: `Bearer ${reader}` } })));
		expect(src.eventListeners()).toBe(0);
		// Clients that go away, on a run and on the daemon: their waits end and unsubscribe at once.
		const acs = Array.from({ length: 10 }, () => new AbortController());
		const gone = acs.map((ac, i) => get(i % 2 ? "scope=run-1&after=100&type=agent.done&wait=30" : "scope=daemon&after=100000&type=project.configured&wait=30", ac.signal).catch(() => null));
		await until(() => src.eventListeners() === 5 && state.daemonListeners() === 5);
		const t0 = Date.now();
		for (const ac of acs) ac.abort();
		await Promise.all(gone);
		await until(() => src.eventListeners() === 0 && state.daemonListeners() === 0, 1000);
		expect(Date.now() - t0).toBeLessThan(1000);
	});
});
