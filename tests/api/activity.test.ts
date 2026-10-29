// Agent activity line (harness.v1 Agent.activity, agent.activity_changed): classification from structured adapter
// events, trusted plain-language text in both tenses, coalescing + throttling, and the opt-in ephemeral SSE frames.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activityOf, activityReporter, commandKind, type FinishedStep, type StoredActivity } from "../../src/agents/activity";
import type { AgentEvent } from "../../src/agents/types";
import { addClient, loadClients } from "../../src/api/clients";
import { Agent, EventData } from "../../src/api/contract";
import { agentActivity, describeActivity } from "../../src/api/describe";
import { HarnessEvent } from "../../src/api/envelope";
import { strictEventData } from "../../src/api/legacy-events";
import { harnessApp } from "../../src/api/server";
import { memorySource } from "../../src/api/source";
import { harnessState } from "../../src/api/state";

const claude = (...uses: Array<[string, Record<string, unknown>]>): AgentEvent => ({
	type: "assistant", raw: { type: "assistant", message: { id: "m1", content: uses.map(([name, input], i) => ({ type: "tool_use", id: `t${i}`, name, input })) } },
});
const codex = (type: string, item: Record<string, unknown>): AgentEvent => ({ type, subtype: String(item.type), raw: { type: type.replace("_", "."), item } });
const kinds = (ev: AgentEvent) => activityOf(ev).map((s) => s.kind);

describe("classification (structured fields only)", () => {
	test("claude tool_use blocks", () => {
		expect(kinds(claude(["Read", { file_path: "/a.ts" }], ["Read", { file_path: "/b.ts" }]))).toEqual(["read", "read"]);
		expect(kinds(claude(["Edit", { file_path: "/a.ts" }]))).toEqual(["edit"]);
		expect(kinds(claude(["Write", { file_path: "/n.ts" }]))).toEqual(["write"]);
		expect(kinds(claude(["Grep", { pattern: "x" }], ["Glob", { pattern: "*.ts" }]))).toEqual(["search", "search"]);
		expect(kinds(claude(["Bash", { command: "cd /repo && bun test tests/api" }]))).toEqual(["test"]);
		expect(kinds(claude(["WebFetch", { url: "https://x" }]))).toEqual(["web"]);
		expect(kinds(claude(["TodoWrite", { todos: [] }]))).toEqual(["plan"]);
		expect(kinds(claude(["Task", { prompt: "p" }]))).toEqual(["delegate"]);
		expect(kinds(claude(["mcp__capcomd__capcomd_spawn", { task: "t" }]))).toEqual(["spawn"]);
		expect(kinds(claude(["mcp__capcomd__capcomd_await", { agents: ["a"] }]))).toEqual(["wait"]);
		expect(kinds(claude(["mcp__other__thing", {}]))).toEqual(["tool"]);
		expect(kinds({ type: "assistant", raw: { message: { content: [{ type: "text", text: "Let me look" }] } } })).toEqual(["think"]);
		expect(kinds({ type: "user", raw: { message: { content: [{ type: "tool_result", tool_use_id: "t0" }] } } })).toEqual([]);
		expect(kinds({ type: "result", raw: { type: "result", result: "done" } })).toEqual([]);
	});

	test("codex items", () => {
		expect(kinds(codex("item_started", { id: "i1", type: "command_execution", command: "pytest -q" }))).toEqual(["test"]);
		expect(kinds(codex("item_completed", { id: "i2", type: "file_change", changes: [{ path: "a.py", kind: "update" }, { path: "b.py", kind: "add" }] }))).toEqual(["edit", "write"]);
		expect(kinds(codex("item_completed", { id: "i3", type: "mcp_tool_call", server: "capcomd", tool: "capcomd_send" }))).toEqual(["message"]);
		expect(kinds(codex("item_completed", { id: "i4", type: "web_search", query: "q" }))).toEqual(["web"]);
		expect(kinds(codex("item_completed", { id: "i5", type: "reasoning", text: "hmm" }))).toEqual(["think"]);
	});

	test("shell commands", () => {
		const c: Array<[string, string]> = [
			["bun test", "test"], ["npm run test -- --watch=false", "test"], ["go test ./...", "test"], ["CI=1 cargo test", "test"],
			["bun install --frozen-lockfile", "install"], ["pip install -r requirements.txt", "install"],
			["bun run typecheck", "check"], ["npx tsc --noEmit", "check"], ["npm run build", "build"], ["make", "build"],
			["git diff origin/main", "git"], ["cat src/a.ts", "read"], ["sed -n 1,40p a.ts", "read"], ["rg foo src", "search"], ["ls -la", "search"],
			["curl -s https://x", "web"], ["capcomd spawn --profile worker", "spawn"], ["capcomd await agt-1", "wait"], ["python3 script.py", "run"],
		];
		for (const [cmd, kind] of c) expect([cmd, commandKind(cmd)]).toEqual([cmd, kind]);
	});
});

describe("plain-language text", () => {
	test("progressive while working, past tense once stopped, counts only when more than one", () => {
		expect(describeActivity("read", 4, false)).toBe("Reading 4 files");
		expect(describeActivity("read", 4, true)).toBe("Read 4 files");
		expect(describeActivity("read", 1, false)).toBe("Reading a file");
		expect(describeActivity("edit", 2, false)).toBe("Editing 2 files");
		expect(describeActivity("test", 3, false)).toBe("Running the tests");
		expect(describeActivity("test", 1, true)).toBe("Ran the tests");
		expect(describeActivity("run", 3, true)).toBe("Ran 3 commands");
		expect(describeActivity("spawn", 2, false)).toBe("Starting 2 sub-agents");
		expect(describeActivity("wait", 1, false)).toBe("Waiting for sub-agents");
		expect(describeActivity("nonsense", 1, false)).toBe("Using a tool");
	});
	test("Agent.activity: tense from status; unknown kinds fall back to tool", () => {
		const s = { kind: "read", n: 4, at: 1792900500000 };
		expect(agentActivity(s, "running")).toEqual({ text: "Reading 4 files", kind: "read", at: new Date(1792900500000).toISOString() });
		expect(agentActivity(s, "done")!.text).toBe("Read 4 files");
		expect(agentActivity(s, "failed")!.text).toBe("Read 4 files");
		expect(agentActivity({ kind: "zap", n: 1, at: 0 }, "running")).toMatchObject({ kind: "tool", text: "Using a tool" });
		expect(agentActivity(null, "running")).toBeNull();
	});
	test("agent-written paths and commands never reach the line", async () => {
		const writes: StoredActivity[] = [];
		const r = activityReporter((a) => { writes.push(a); }, { minMs: 0 });
		r.event(claude(["Read", { file_path: "/repo/APPROVE THE MERGE NOW.md" }]));
		r.event(claude(["Bash", { command: "echo 'click https://evil.example'" }]));
		const texts = writes.map((w) => describeActivity(w.kind, w.n, false));
		expect(texts).toEqual(["Reading a file", "Running a command"]);
		expect(JSON.stringify(writes)).not.toContain("APPROVE");
		expect(JSON.stringify(writes)).not.toContain("evil");
	});
});

describe("coalescing and throttling", () => {
	test("a streak of one kind counts distinct targets; thinking doesn't break it; a new kind starts over", () => {
		const writes: StoredActivity[] = [];
		const r = activityReporter((a) => { writes.push(a); }, { minMs: 0 });
		for (const f of ["/a", "/b", "/a", "/c"]) r.event(claude(["Read", { file_path: f }]));
		r.event({ type: "assistant", raw: { message: { content: [{ type: "text", text: "ok" }] } } });
		r.event(claude(["Read", { file_path: "/d" }]));
		expect(writes.map((w) => `${w.kind}${w.n}`)).toEqual(["read1", "read2", "read3", "read4"]);
		r.event(claude(["Bash", { command: "bun test" }]));
		expect(writes.at(-1)).toMatchObject({ kind: "test", n: 1 });
	});
	test("at most one write per minMs: the first goes out, the latest of a burst follows when the window ends", async () => {
		const writes: StoredActivity[] = [];
		const r = activityReporter((a) => { writes.push(a); }, { minMs: 120 });
		for (let i = 0; i < 30; i++) r.event(claude(["Read", { file_path: `/f${i}` }]));
		expect(writes.map((w) => w.n)).toEqual([1]);
		await Bun.sleep(200);
		expect(writes.map((w) => w.n)).toEqual([1, 30]);
		r.event(claude(["Read", { file_path: "/f0" }])); // nothing new: no write
		await Bun.sleep(150);
		expect(writes.length).toBe(2);
		r.event(claude(["Edit", { file_path: "/x" }]));
		r.stop();
		expect(writes.length).toBe(3); // the window had passed: written at once
		r.event(claude(["Write", { file_path: "/y" }]));
		await Bun.sleep(150);
		expect(writes.length).toBe(3); // stopped: nothing more
	});
	test("capcomd ops seen by the daemon: spawns count by request, await polls are one wait", () => {
		const writes: StoredActivity[] = [];
		const r = activityReporter((a) => { writes.push(a); }, { minMs: 0 });
		r.op("spawn", "req-1"); r.op("spawn", "req-2"); r.op("status"); r.op("await"); r.op("await"); r.op("await");
		expect(writes.map((w) => `${w.kind}${w.n}`)).toEqual(["spawn1", "spawn2", "wait1"]);
	});
});

const think: AgentEvent = { type: "assistant", raw: { message: { content: [{ type: "text", text: "hmm" }] } } };

describe("step history (agent.step): finished streaks, unthrottled", () => {
	const clock = () => { let t = 1_000_000; return { now: () => t, tick: (ms: number) => { t += ms; } }; };
	test("read → edit → test inside one second is three steps, in order, with their start and end; the last at finish()", async () => {
		const c = clock(), steps: FinishedStep[] = [], writes: StoredActivity[] = [];
		const r = activityReporter((a) => { writes.push(a); }, { minMs: 1000, now: c.now, onStep: (s) => { steps.push(s); } });
		r.event(claude(["Read", { file_path: "/a" }], ["Read", { file_path: "/b" }])); c.tick(100);
		r.event(claude(["Read", { file_path: "/a" }])); c.tick(100);
		r.event(claude(["Edit", { file_path: "/a" }])); c.tick(200);
		r.event(claude(["Bash", { command: "bun test" }])); c.tick(300);
		await Bun.sleep(0);
		expect(writes.length).toBe(1); // the line is still throttled (one write in the window)…
		expect(steps).toEqual([ // …the steps are not
			{ kind: "read", n: 2, startedAt: 1_000_000, endedAt: 1_000_200 },
			{ kind: "edit", n: 1, startedAt: 1_000_200, endedAt: 1_000_400 },
		]);
		await r.finish();
		expect(steps.at(-1)).toEqual({ kind: "test", n: 1, startedAt: 1_000_400, endedAt: 1_000_700 });
		expect(steps.length).toBe(3);
		r.event(claude(["Write", { file_path: "/z" }]));
		await r.finish();
		expect(steps.length).toBe(3); // finished: nothing more, and finish() twice reports nothing twice
	});
	test("one batch, one millisecond: each step still gets its own, increasing startedAt (read → edit → read is three steps)", async () => {
		const steps: FinishedStep[] = [];
		const r = activityReporter(() => {}, { minMs: 0, now: () => 5_000, onStep: (s) => { steps.push(s); } });
		r.steps([{ kind: "read", target: "/a" }, { kind: "edit", target: "/a" }, { kind: "read", target: "/b" }]);
		await r.finish();
		expect(steps).toEqual([
			{ kind: "read", n: 1, startedAt: 5_000, endedAt: 5_001 },
			{ kind: "edit", n: 1, startedAt: 5_001, endedAt: 5_002 },
			{ kind: "read", n: 1, startedAt: 5_002, endedAt: 5_002 },
		]);
	});
	test("think is never a step and never splits one; a leading think streak is skipped", async () => {
		const c = clock(), steps: FinishedStep[] = [];
		const r = activityReporter(() => {}, { minMs: 0, now: c.now, onStep: (s) => { steps.push(s); } });
		r.event(think); c.tick(50);
		r.event(claude(["Read", { file_path: "/a" }])); c.tick(50);
		r.event(think); c.tick(50);
		r.event(claude(["Read", { file_path: "/b" }])); c.tick(50);
		r.event(codex("item_completed", { id: "i1", type: "reasoning", text: "x" })); c.tick(50);
		await r.finish();
		expect(steps).toEqual([{ kind: "read", n: 2, startedAt: 1_000_050, endedAt: 1_000_250 }]);
		const only = activityReporter(() => {}, { minMs: 0, now: c.now, onStep: (s) => { steps.push(s); } });
		only.event(think);
		await only.finish();
		expect(steps.length).toBe(1); // an agent that only thought has no steps
	});
	test("stop() (a cancel) drops the unfinished last step; steps already finished still go out, in order", async () => {
		const c = clock(), steps: FinishedStep[] = [];
		const slow = async (s: FinishedStep) => { await Bun.sleep(s.kind === "read" ? 30 : 1); steps.push(s); };
		const r = activityReporter(() => {}, { minMs: 0, now: c.now, onStep: slow });
		r.op("spawn", "req-1"); c.tick(10); r.op("spawn", "req-2"); c.tick(10);
		r.op("await"); c.tick(10); r.op("await"); c.tick(10);
		r.event(claude(["Read", { file_path: "/a" }])); c.tick(10);
		r.event(claude(["Edit", { file_path: "/a" }])); c.tick(10);
		r.stop();
		await r.finish(); // after stop: reports nothing new, but waits for what is in flight
		expect(steps.map((s) => `${s.kind}${s.n}`)).toEqual(["spawn2", "wait1", "read1"]); // serialized: a slow call doesn't reorder
	});
	test("a failing or hanging onStep never breaks the reporter; finish() waits at most timeoutMs", async () => {
		const c = clock();
		const r = activityReporter(() => {}, { minMs: 0, now: c.now, onStep: () => { throw new Error("actor down"); } });
		r.event(claude(["Read", { file_path: "/a" }])); r.event(claude(["Edit", { file_path: "/a" }]));
		await r.finish();
		const h = activityReporter(() => {}, { minMs: 0, now: c.now, onStep: () => new Promise(() => {}) });
		h.event(claude(["Read", { file_path: "/a" }]));
		const t0 = Date.now();
		await h.finish({ timeoutMs: 50 });
		expect(Date.now() - t0).toBeLessThan(1000);
	});
	test("the event payload is exactly {kind, n, startedAt, endedAt}; its text is the step in past tense", () => {
		expect(strictEventData("agent.step", { kind: "read", n: 4, startedAt: 1, endedAt: 2 }).ok).toBe(true);
		expect(strictEventData("agent.step", { kind: "read", n: 4, startedAt: 1, endedAt: 2, target: "/a" }).ok).toBe(false);
		expect(strictEventData("agent.step", { kind: "read", n: 0, startedAt: 1, endedAt: 2 }).ok).toBe(false);
		expect(strictEventData("agent.step", { kind: "read", n: 1.5, startedAt: 1, endedAt: 2 }).ok).toBe(false);
		expect(EventData["agent.step"].safeParse({ kind: "new-kind", n: 1, startedAt: 1, endedAt: 2 }).success).toBe(true);
	});
});

const dir = mkdtempSync(join(tmpdir(), "harness-activity-"));
const cpath = join(dir, "clients.json");
const token = addClient("reader", ["read"], cpath).token;
const run = { id: "run-1", projectId: null, label: "demo", state: "running", goal: null, repo: "/r", createdAt: "2026-10-25T07:00:00.000Z" };
const at = 1792900500000;

function app(extra: Array<{ seq: number; at: number; type: string; agentId: string | null; data: Record<string, unknown> }> = []) {
	const agent: any = { id: "a1", runId: "run-1", parent: null, depth: 0, profile: "worker", status: "running", text: "Agent a1 is now running.", activity: agentActivity({ kind: "read", n: 2, at }, "running"), task: "t", taskAttachment: null, result: null, workspace: null, provider: "claude", model: null, effort: null, updatedAt: null };
	const src = memorySource({ runs: [run], agents: { "run-1": [agent] }, events: { "run-1": [
		{ seq: 1, at, type: "RUN_NEW", agentId: null, data: { budget: {}, label: "demo" } },
		{ seq: 2, at, type: "AGENT_SPAWNED", agentId: "a1", data: { parent: null, depth: 0, profile: "worker", task: "t", key: null, operator: true, budget: {}, limits: {}, agent: null } },
		{ seq: 3, at, type: "AGENT_STARTED", agentId: "a1", data: {} },
		...extra,
	] } });
	const a = harnessApp({ source: src, clients: () => loadClients(cpath), heartbeatMs: 60_000, pollMs: 10, activityMs: 100, state: harnessState(null) });
	const set = (kind: string, n: number) => { agent.activity = agentActivity({ kind, n, at: Date.now() }, agent.status); };
	return { src, agent, set, req: (p: string, h: Record<string, string> = {}) => a.request(p, { headers: { authorization: `Bearer ${token}`, ...h } }) };
}
async function read(res: Response, ms: number, until?: RegExp) {
	const r = res.body!.getReader(); const dec = new TextDecoder(); let t = ""; const end = Date.now() + ms;
	let pending: Promise<any> | null = null;
	while (Date.now() < end && !(until && until.test(t))) {
		pending ??= r.read();
		const x = await Promise.race([pending, new Promise<any>((ok) => setTimeout(() => ok(null), 20))]);
		if (!x) continue;
		pending = null;
		if (x.value) t += dec.decode(x.value);
		if (x.done) break;
	}
	r.cancel().catch(() => {});
	return t;
}
const frames = (t: string, type: string) => t.split("\n\n").filter((f) => f.includes(`event: ${type}\n`));

describe("API", () => {
	test("agent.step: replayed by GET /v1/events and in snapshot.steps, durable, with the past-tense text; not on the lifecycle feed", async () => {
		const { req } = app([
			{ seq: 4, at, type: "AGENT_STEP", agentId: "a1", data: { kind: "read", n: 4, startedAt: at - 900, endedAt: at - 400 } },
			{ seq: 5, at, type: "AGENT_STEP", agentId: "a1", data: { kind: "test", n: 1, startedAt: at - 400, endedAt: at } },
			{ seq: 6, at, type: "AGENT_STEP", agentId: "a1", data: { kind: "zap", n: 2, startedAt: at, endedAt: at } },
		]);
		const replay = await (await req("/v1/events?scope=run-1")).json() as any[];
		const steps = replay.filter((e) => e.type === "agent.step");
		expect(steps.map((e) => e.text)).toEqual(["Read 4 files", "Ran the tests", "Used 2 tools"]);
		for (const e of steps) {
			expect(HarnessEvent.safeParse(e).success).toBe(true);
			expect(EventData["agent.step"].safeParse(e.data).success).toBe(true);
			expect(e).toMatchObject({ durability: "durable", agentId: "a1", entity: "a1", scope: "run-1" });
		}
		expect(steps[0].data).toEqual({ kind: "read", n: 4, startedAt: at - 900, endedAt: at - 400 });
		const t = await read(await req("/v1/streams/run-1/events"), 300, /snapshot\.end/);
		expect(t).toContain('"type":"agent.step"');
		const life = await (await req("/v1/runs/run-1/lifecycle")).json() as any[];
		expect(life.some((e) => e.type === "agent.step")).toBe(false);
	});

	test("Agent.activity in GET /v1/runs/{runId}/agents and snapshot.agents", async () => {
		const { req } = app();
		const agents = await (await req("/v1/runs/run-1/agents")).json() as any[];
		expect(Agent.safeParse(agents[0]).success).toBe(true);
		expect(agents[0].activity).toEqual({ text: "Reading 2 files", kind: "read", at: new Date(1792900500000).toISOString() });
		const t = await read(await req("/v1/streams/run-1/events?feed=lifecycle&activity=1"), 300, /snapshot\.end/);
		expect(t).toMatch(/event: snapshot\.agents\ndata: [^\n]*"activity":\{"text":"Reading 2 files","kind":"read"/);
	});

	test("?activity=1 on the lifecycle feed: ephemeral agent.activity_changed, no SSE id, coalesced to one per agent per activityMs", async () => {
		const { req, set, src, agent } = app();
		const res = await req("/v1/streams/run-1/events?feed=lifecycle&activity=1");
		// A burst of 20 changes in ~200 ms, then the agent finishes.
		const burst = (async () => {
			await Bun.sleep(30);
			for (let i = 3; i < 23; i++) { set("read", i); await Bun.sleep(10); }
			set("test", 1);
			await Bun.sleep(250);
			agent.status = "done"; set("test", 1);
			src.push("run-1", { at: Date.now(), type: "AGENT_DONE", agentId: "a1", data: { result: {}, spent: {}, budget: {} } });
		})();
		const t = await read(res, 1500, /"text":"Ran the tests"/);
		await burst;
		const act = frames(t, "agent.activity_changed");
		expect(act.length).toBeGreaterThanOrEqual(2);
		expect(act.length).toBeLessThanOrEqual(8); // ~600 ms of changes at 100 ms per frame, not 22
		for (const f of act) {
			expect(f).not.toMatch(/^id: /m);
			const env = JSON.parse(f.slice(f.indexOf("data: ") + 6));
			expect(HarnessEvent.safeParse(env).success).toBe(true);
			expect(EventData["agent.activity_changed"].safeParse(env.data).success).toBe(true);
			expect(env).toMatchObject({ durability: "ephemeral", entitySeq: 0, agentId: "a1", type: "agent.activity_changed" });
			expect(env.text).toBe(env.data.activity.text);
		}
		expect(new Set(act.map((f) => JSON.parse(f.slice(f.indexOf("data: ") + 6)).id)).size).toBe(act.length);
		expect(t).toContain('"text":"Running the tests"');
		expect(t).toContain('"text":"Ran the tests"'); // past tense once it stopped
		expect(t).toContain("event: agent.done"); // lifecycle events still flow, with their ids
		expect(t).toMatch(/id: 4\nevent: run\.completed/);
	});

	test("without ?activity=1 nothing changes: no activity frames on the lifecycle feed or the full stream; never replayed", async () => {
		const { req, set } = app();
		for (const path of ["/v1/streams/run-1/events?feed=lifecycle", "/v1/streams/run-1/events"]) {
			const res = req(path);
			setTimeout(() => set("edit", 1), 30);
			const t = await read(await res, 350);
			expect(t).toContain("snapshot.end");
			expect(t).not.toContain("agent.activity_changed");
		}
		const life = await (await req("/v1/runs/run-1/lifecycle")).json() as any[];
		expect(life.some((e) => e.type === "agent.activity_changed")).toBe(false);
		const replay = await (await req("/v1/events?scope=run-1")).json() as any[];
		expect(replay.some((e) => e.type === "agent.activity_changed")).toBe(false);
	});

	test("resume by Last-Event-ID (no snapshot): the current activity is sent once right away", async () => {
		const { req } = app();
		const t = await read(await req("/v1/streams/run-1/events?feed=lifecycle&activity=1", { "last-event-id": "3" }), 400);
		expect(t).not.toContain("snapshot.");
		expect(frames(t, "agent.activity_changed").length).toBe(1);
		expect(t).toContain('"text":"Reading 2 files"');
	});
});
