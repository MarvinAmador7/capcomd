// harness.v1 server (phase 1 step 5): auth scopes, ApiError bodies, decision idempotency, SSE snapshot / resume / heartbeat, Unix socket.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addClient, loadClients, revokeClient } from "../../src/api/clients";
import { HarnessEvent } from "../../src/api/envelope";
import { harnessApp } from "../../src/api/server";
import { serveHarnessSocket } from "../../src/api/socket";
import { harnessState } from "../../src/api/state";
import { memorySource } from "../../src/api/source";

const dir = mkdtempSync(join(tmpdir(), "harness-"));
const path = join(dir, "clients.json");
const reader = addClient("reader", ["read"], path).token;
const approver = addClient("ive", ["read", "approve"], path).token;
const run = { id: "run-1", projectId: null, label: "demo", state: "running", goal: null, repo: "/r", createdAt: "2026-10-25T07:00:00.000Z" };
const apr = { approvalId: "apr-1", kind: "merge" as const, status: "pending" as const, question: "merge?", requestedBy: { agentId: "a1", runId: "run-1" }, subject: { target: "main" }, expiresAt: null };

function setup(heartbeatMs = 60_000) {
	const src = memorySource({ runs: [run], approvals: { "run-1": [apr] }, events: { "run-1": [
		{ seq: 1, at: 1792900500000, type: "RUN_NEW", agentId: null, data: { budget: {}, label: "demo" } },
		{ seq: 2, at: 1792900501000, type: "MESSAGE_SENT", agentId: "a1", data: { to: "a2", seq: 1, bytes: 2, text: "hi", attachment: null } },
	] } });
	const app = harnessApp({ source: src, clients: () => loadClients(path), heartbeatMs, pollMs: 20, state: harnessState(null) });
	return { src, req: (p: string, init: RequestInit & { token?: string } = {}) => app.request(p, { ...init, headers: { ...(init.token ? { authorization: `Bearer ${init.token}` } : {}), ...(init.headers as any) } }) };
}

async function readFrames(res: Response, until: (t: string) => boolean, ms = 2000) {
	const r = res.body!.getReader(); const dec = new TextDecoder(); let t = "";
	const end = Date.now() + ms;
	let pending: Promise<any> | null = null;
	while (!until(t) && Date.now() < end) {
		pending ??= r.read();
		const x = await Promise.race([pending, new Promise<any>((ok) => setTimeout(() => ok(null), 50))]);
		if (!x) continue;
		pending = null;
		if (x.value) t += dec.decode(x.value);
		if (x.done) break;
	}
	r.cancel().catch(() => {});
	return t;
}

describe("harness server", () => {
	test("health needs no token; everything else does", async () => {
		const { req } = setup();
		const h = await req("/v1/health");
		expect(await h.json()).toEqual({ ok: true, api: "harness.v1", version: "test", capabilities: ["run.controls", "agents.messages", "steer.skills", "agent.pause", "runs.options", "runs.options.repo", "runs.options.sandbox", "agent.steps", "logins", "environments", "service", "sandboxes", "sandboxes.resources", "sandboxes.settings", "sandboxes.actions"] });
		const r = await req("/v1/runs");
		expect(r.status).toBe(401);
		expect(((await r.json()) as any).code).toBe("unauthorized");
		expect((await req("/v1/runs", { token: reader })).status).toBe(200);
	});
	test("revoked tokens stop working", async () => {
		const p2 = join(dir, "c2.json"); const { client, token } = addClient("x", ["read"], p2);
		const app = harnessApp({ source: memorySource(), clients: () => loadClients(p2), state: harnessState(null) });
		expect((await app.request("/v1/runs", { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
		revokeClient(client.id, p2);
		expect((await app.request("/v1/runs", { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
		expect(statSync(p2).mode & 0o777).toBe(0o600);
	});
	test("404s are ApiError", async () => {
		const { req } = setup();
		const r = await req("/v1/runs/run-nope", { token: reader });
		expect(r.status).toBe(404);
		expect(((await r.json()) as any).code).toBe("not_found");
	});
	test("messages route returns the thread", async () => {
		const { req } = setup();
		const m = await (await req("/v1/runs/run-1/messages", { token: reader })).json();
		expect(m).toEqual([{ seq: 1, from: "a1", to: "a2", at: "2026-10-25T03:55:01.000Z", text: "hi", attachment: null }]);
	});
	test("replay maps to envelopes with text", async () => {
		const { req } = setup();
		const evs: any = await (await req("/v1/events?scope=run-1", { token: reader })).json();
		expect(evs.map((e: any) => e.type)).toEqual(["run.created", "message.sent"]);
		for (const e of evs) expect(HarnessEvent.safeParse(e).success).toBe(true);
	});
	describe("decision", () => {
		const post = (req: any, token: string, key: string | undefined, body: unknown) =>
			req("/v1/approvals/apr-1/decision", { method: "POST", token, headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) }, body: JSON.stringify(body) });
		test("needs the approve scope", async () => {
			const { req } = setup();
			expect((await post(req, reader, "key-00001", { decision: "approve" })).status).toBe(403);
		});
		test("replay, conflict, already_decided", async () => {
			const { req, src } = setup();
			expect((await post(req, approver, undefined, { decision: "approve" })).status).toBe(422);
			const a = await post(req, approver, "key-00001", { decision: "approve" });
			expect(a.status).toBe(200);
			const d = await a.json();
			expect(d.decidedBy).toEqual({ clientId: expect.stringMatching(/^cli-/), principal: "ive" });
			expect(await (await post(req, approver, "key-00001", { decision: "approve" })).json()).toEqual(d);
			const c = await post(req, approver, "key-00001", { decision: "deny" });
			expect(c.status).toBe(409); expect((await c.json()).code).toBe("idempotency_conflict");
			const e = await post(req, approver, "key-00002", { decision: "deny" });
			expect(e.status).toBe(409);
			const eb = await e.json();
			expect(eb.code).toBe("already_decided"); expect(eb.decision).toEqual(d);
			expect(src.decided.length).toBe(1);
		});
		test("unknown approval is 404", async () => {
			const { req } = setup();
			const r = await req("/v1/approvals/apr-zz/decision", { method: "POST", token: approver, headers: { "idempotency-key": "key-00001" }, body: JSON.stringify({ decision: "deny" }) });
			expect(r.status).toBe(404);
		});
	});
	describe("stream", () => {
		test("fresh connect: snapshot frames, then live events", async () => {
			const { req, src } = setup();
			const res = await req("/v1/streams/run-1/events", { token: reader });
			expect(res.headers.get("content-type")).toContain("text/event-stream");
			setTimeout(() => src.push("run-1", { at: 1792900502000, type: "AGENT_STARTED", agentId: "a1", data: {} }), 100);
			const t = await readFrames(res, (x) => x.includes("agent.started"));
			for (const f of ["snapshot.run", "snapshot.agents", "snapshot.approvals", "snapshot.steps", "snapshot.threads", "snapshot.end"]) expect(t).toContain(`event: ${f}`);
			expect(t).toContain("id: 3\nevent: agent.started");
			expect(t).not.toContain("stream.reset");
		});
		test("Last-Event-ID resumes after that seq without a snapshot", async () => {
			const { req } = setup();
			const t = await readFrames(await req("/v1/streams/run-1/events", { token: reader, headers: { "last-event-id": "1" } }), (x) => x.includes("message.sent"));
			expect(t).toContain("id: 2\nevent: message.sent");
			expect(t).not.toContain("snapshot.");
			expect(t).not.toContain("run.created");
		});
		test("unknown cursor: stream.reset then snapshot", async () => {
			const { req } = setup();
			const t = await readFrames(await req("/v1/streams/run-1/events", { token: reader, headers: { "last-event-id": "99" } }), (x) => x.includes("snapshot.end"));
			expect(t.indexOf("event: stream.reset")).toBeLessThan(t.indexOf("event: snapshot.end"));
			expect(t).toContain('"reason":"compacted"');
		});
		test("heartbeat comment", async () => {
			const { req } = setup(30);
			const t = await readFrames(await req("/v1/streams/run-1/events", { token: reader }), (x) => x.includes(": heartbeat"));
			expect(t).toContain(": heartbeat\n\n");
		});
		test("daemon scope lists runs", async () => {
			const { req } = setup();
			const t = await readFrames(await req("/v1/streams/daemon/events", { token: reader }), (x) => x.includes("run.created"));
			expect(t).toContain("id: 1\nevent: run.created");
		});
	});
	test("served on a 0600 socket", async () => {
		const sock = join(mkdtempSync(join(tmpdir(), "hs-")), "sub", "h.sock");
		const app = harnessApp({ source: memorySource(), clients: () => [], state: harnessState(null) });
		const s = await serveHarnessSocket(sock, app.fetch);
		try {
			expect(statSync(sock).mode & 0o777).toBe(0o600);
			expect(statSync(join(sock, "..")).mode & 0o777).toBe(0o700);
			const r = await fetch("http://localhost/v1/health", { unix: sock } as any);
			expect(((await r.json()) as any).api).toBe("harness.v1");
		} finally { s.close(); }
	});
});
