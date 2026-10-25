// lifecycle_events (decided Oct 25, 2026) and spawn-task redaction (decision: same path as message bodies).
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addClient, loadClients } from "../../src/api/clients";
import { EventData } from "../../src/api/contract";
import { HarnessEvent } from "../../src/api/envelope";
import { LIFECYCLE_TYPES, lifecycleEvents } from "../../src/api/lifecycle";
import { harnessApp } from "../../src/api/server";
import { harnessState } from "../../src/api/state";
import { approvalIdFor, memorySource, type RawEvent } from "../../src/api/source";
import { redactShapes, REDACTED } from "../../src/agents/redact";
import { inlineOrAttach } from "../../src/api/inline-cap";

let at = 1792900500000;
const ev = (seq: number, type: string, agentId: string | null, data: Record<string, unknown> = {}): RawEvent => ({ seq, at: at + seq * 1000, type, agentId, data });
const log: RawEvent[] = [
	ev(1, "RUN_NEW", null, { budget: {}, label: "demo" }),
	ev(2, "AGENT_SPAWNED", "a1", { parent: null, depth: 0, profile: "worker", task: "t", key: null, operator: true, budget: {}, limits: {}, agent: null }),
	ev(3, "AGENT_STARTED", "a1"),
	ev(4, "MESSAGE_SENT", "a1", { to: "a2", seq: 1, bytes: 2, text: "hi", attachment: null }),
	ev(5, "TASK_ADDED", null, { taskId: "x", title: "t" }),
	ev(6, "AGENT_PAUSED", "a1", { result: { limit: "quota" }, until: null }),
	ev(7, "AGENT_RESUMED", "a1", { epoch: 2, by: null }),
	ev(8, "MERGE_AWAITING_APPROVAL", "a1", { id: "op1", target: "main", ref: "b" }),
	ev(9, "MERGE_APPROVED", "a1", { id: "op1", by: "client:ive" }),
	ev(10, "MERGED", "a1", { id: "op1" }),
	ev(11, "AGENT_DONE", "a1", { result: { summary: "ok" }, spent: {}, budget: {} }),
];

describe("lifecycle_events", () => {
	test("only run/agent state changes and approvals; tool calls, messages, tasks and merges stay out", () => {
		const l = lifecycleEvents("run-1", log);
		expect(l.map((e) => e.type)).toEqual([
			"run.created", "agent.spawned", "agent.started", "run.started", "agent.paused", "run.paused",
			"agent.resumed", "run.resumed", "approval.requested", "approval.decided", "agent.done", "run.completed",
		]);
		for (const e of l) {
			expect(LIFECYCLE_TYPES as readonly string[]).toContain(e.type);
			expect(HarnessEvent.safeParse(e).success).toBe(true);
			expect(EventData[e.type as keyof typeof EventData].safeParse(e.data).success).toBe(true);
			expect(typeof e.data.cause).toBe("string");
			expect(e.text.length).toBeGreaterThan(0);
		}
		expect(l.find((e) => e.type === "agent.paused")!.data.cause).toBe("usage_limit");
		expect(l.find((e) => e.type === "approval.requested")!.data.approvalId).toBe(approvalIdFor("run-1", "op1"));
		expect(l.find((e) => e.type === "approval.decided")!.data).toMatchObject({ status: "approved", decidedBy: { clientId: "client:ive" } });
		expect(new Set(l.map((e) => e.id)).size).toBe(l.length);
	});

	test("decision 9 names: every lifecycle type is a published dotted past-tense type", () => {
		for (const t of LIFECYCLE_TYPES) { expect(t in EventData).toBe(true); expect(t).toMatch(/^[a-z]+\.[a-z_]+$/); expect(t.split(".").at(-1)!).toMatch(/(ed|done)$/); }
	});

	test("run.failed when the last live agent ends and one failed; run.cancelled when all were cancelled", () => {
		const f = lifecycleEvents("run-1", [ev(1, "AGENT_SPAWNED", "a", {}), ev(2, "AGENT_SPAWNED", "b", {}), ev(3, "AGENT_STARTED", "a"), ev(4, "AGENT_STARTED", "b"),
			ev(5, "AGENT_FAILED", "a", { result: {} }), ev(6, "AGENT_DONE", "b", { result: {} })]).map((e) => e.type);
		expect(f.filter((t) => t.startsWith("run."))).toEqual(["run.started", "run.failed"]);
		const c = lifecycleEvents("run-1", [ev(1, "AGENT_SPAWNED", "a", {}), ev(2, "AGENT_STARTED", "a"), ev(3, "AGENT_CANCELLED", "a", { reason: "stop", by: "run" })]);
		expect(c.map((e) => e.type)).toEqual(["agent.spawned", "agent.started", "run.started", "agent.cancelled", "run.cancelled"]);
		expect(c[3]!.data).toMatchObject({ reason: "stop", cause: "cancelled" });
		expect(c[3]!.text).not.toContain("stop"); // agent-written reason never reaches trusted text
	});

	test("deterministic projection: same seq across calls, resumable by seq", () => {
		const a = lifecycleEvents("run-1", log), b = lifecycleEvents("run-1", log);
		expect(a).toEqual(b);
		expect(a.filter((e) => e.seq > 6).map((e) => e.type)[0]).toBe("agent.resumed");
	});
});

const dir = mkdtempSync(join(tmpdir(), "harness-lc-"));
const cpath = join(dir, "clients.json");
const token = addClient("reader", ["read"], cpath).token;
const run = { id: "run-1", projectId: null, label: "demo", state: "running", goal: null, repo: "/r", createdAt: "2026-10-25T07:00:00.000Z" };

function app() {
	const src = memorySource({ runs: [run], events: { "run-1": log.slice(0, 4).map((e) => ({ ...e })) } });
	const a = harnessApp({ source: src, clients: () => loadClients(cpath), heartbeatMs: 60_000, pollMs: 20, state: harnessState(null) });
	return { src, req: (p: string, h: Record<string, string> = {}) => a.request(p, { headers: { authorization: `Bearer ${token}`, ...h } }) };
}
async function readUntil(res: Response, re: RegExp, ms = 2000) {
	const r = res.body!.getReader(); const dec = new TextDecoder(); let t = ""; const end = Date.now() + ms;
	let pending: Promise<any> | null = null;
	while (!re.test(t) && Date.now() < end) {
		pending ??= r.read();
		const x = await Promise.race([pending, new Promise<any>((ok) => setTimeout(() => ok(null), 50))]);
		if (!x) continue;
		pending = null;
		if (x?.value) t += dec.decode(x.value);
		if (x?.done) break;
	}
	r.cancel().catch(() => {});
	return t;
}

describe("lifecycle API", () => {
	test("GET /v1/runs/{runId}/lifecycle returns only lifecycle events, honours after, 404s unknown runs", async () => {
		const { req } = app();
		const all = await (await req("/v1/runs/run-1/lifecycle")).json() as any[];
		expect(all.map((e) => e.type)).toEqual(["run.created", "agent.spawned", "agent.started", "run.started"]);
		const after = await (await req("/v1/runs/run-1/lifecycle?after=2")).json() as any[];
		expect(after.map((e) => e.type)).toEqual(["agent.started", "run.started"]);
		expect((await req("/v1/runs/run-nope/lifecycle")).status).toBe(404);
	});

	test("SSE ?feed=lifecycle: snapshot without steps/threads, live lifecycle events only, resume by Last-Event-ID", async () => {
		const { src, req } = app();
		const res = await req("/v1/streams/run-1/events?feed=lifecycle");
		setTimeout(() => { src.push("run-1", { at: at + 50_000, type: "TASK_ADDED", agentId: null, data: { taskId: "q", title: "t" } }); src.push("run-1", { at: at + 60_000, type: "AGENT_DONE", agentId: "a1", data: { result: {}, spent: {}, budget: {} } }); }, 60);
		const t = await readUntil(res, /event: run\.completed/);
		expect(t).toContain("event: snapshot.end");
		expect(t).not.toContain("snapshot.steps");
		expect(t).not.toContain("event: message.sent");
		expect(t).not.toContain("event: task.added");
		expect(t).toMatch(/id: 6\nevent: agent\.done/);
		expect(t).toMatch(/id: 6\nevent: run\.completed\ndata: [^\n]*"text":"The run finished/);
		const again = await readUntil(await req("/v1/streams/run-1/events?feed=lifecycle", { "last-event-id": "3" }), /run\.completed/);
		expect(again).not.toContain("snapshot.");
		expect(again).toContain("event: agent.done");
	});
});

describe("spawn task redaction", () => {
	test("spawn task uses the message-body path: redactShapes then the 64 KB cap", () => {
		const secret = "sk-ant-" + "A".repeat(24);
		const inl = inlineOrAttach(redactShapes(`deploy with ${secret}`));
		expect(inl.text).toBe(`deploy with ${REDACTED}`);
		const big = inlineOrAttach(redactShapes(`${secret} ${"x".repeat(70_000)}`));
		expect(big.text).toBeNull();
		expect((big as any).body.startsWith(REDACTED)).toBe(true);
	});
	test("scope.spawn and the API agent view redact task text like message bodies", async () => {
		const scope = await Bun.file("src/actors/scope.ts").text();
		expect(scope).toContain("inlineOrAttach(redactShapes(params.task))");
		expect(scope).toContain("inlineOrAttach(redactShapes(params.body))");
		expect(await Bun.file("src/api/rivet-source.ts").text()).toContain("inlineOrAttach(redactShapes(String(a.task");
	});
});

test("RUN_DELETED in the scope log projects to run.deleted with cause deleted", () => {
	const out = lifecycleEvents("run-x", [{ seq: 1, type: "RUN_DELETED", at: "2026-10-25T00:00:00.000Z" } as any]);
	expect(out.map((e: any) => [e.type, e.data?.cause])).toContainEqual(["run.deleted", "deleted"]);
});
