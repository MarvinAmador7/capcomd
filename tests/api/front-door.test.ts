// Capability ops.front_door (plugin API §6.1, the owner's decision of 2026-11-08): the routes a front door's verify, merge
// and approval go through to run in the daemon. Only the one-call tokens the CLI and `capcomd mcp` make for them; a
// bounded wait (202 while it runs); the operation's own refusal carried as its relay.v1 error. The operations here are
// stand-ins; tests/scenarios/front-door-daemon.test.ts runs the real ones against a daemon and an out-of-process plugin.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addClient, authenticate, loadClients, mintPluginClient, oneCallClient } from "../../src/api/clients";
import { harnessApp } from "../../src/api/server";
import { harnessState } from "../../src/api/state";
import { memorySource } from "../../src/api/source";
import type { FrontDoorOps } from "../../src/api/front-door";
import { RelayError } from "../../src/core/errors";

const dir = mkdtempSync(join(tmpdir(), "front-door-"));
const path = join(dir, "clients.json");
const app = addClient("an app", ["read", "steer", "approve", "configure"], path).token;
const front = oneCallClient("capcomd front door (one call)", ["steer"], path, { frontDoor: true }).token;
const frontApprove = oneCallClient("capcomd front door (one call)", ["approve"], path, { frontDoor: true }).token;
const plugin = mintPluginClient("acme", ["read", "steer"]);

const calls: Array<{ op: string; runId: string; body: unknown; mergeId?: string }> = [];
let next: () => Promise<Record<string, unknown>> = async () => ({ id: "vfy-1", state: "passed" });
const ops: FrontDoorOps = {
	async verify(runId, b) { calls.push({ op: "verify", runId, body: b }); if (b.ref === "refused") throw new RelayError("conflict", "verification vfy-x is failed", "Only a passing verification can gate a merge.", { code: "stale" }); return { id: b.id ?? "vfy-1", done: next() }; },
	async merge(runId, b) { calls.push({ op: "merge", runId, body: b }); return { id: b.id ?? "mrg-1", done: next() }; },
	async decide(runId, mergeId, b) { calls.push({ op: "decide", runId, mergeId, body: b }); return { id: mergeId, done: next() }; },
};
const server = harnessApp({ source: memorySource({ runs: [] }), clients: () => loadClients(path), state: harnessState(null), frontDoor: ops });
const post = (p: string, token: string, body: unknown) => server.request(p, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });

describe("front-door operation routes", () => {
	test("only a front door's one-call token: an app's and a plugin's get 403, and the marker isn't a plugin's to claim", async () => {
		for (const t of [app, plugin.token]) {
			const r = await post("/v1/runs/run-1/verifications", t, { ref: "agt-1" });
			expect(r.status).toBe(403);
			expect(await r.json()).toMatchObject({ code: "forbidden" });
		}
		expect(calls).toEqual([]);
		expect(authenticate(`Bearer ${front}`, loadClients(path))).toMatchObject({ frontDoor: true });
		expect(authenticate(`Bearer ${app}`, loadClients(path))?.frontDoor).toBeUndefined();
		// The record keeps the marker; a revoked one-call token is gone with its record.
		expect(loadClients(path).filter((c) => c.frontDoor).length).toBe(2);
	});

	test("an operation that ends within waitMs is 200 with its record; one that doesn't is 202 with its id", async () => {
		next = async () => ({ id: "vfy-1", kind: "verify", state: "passed", result: { pass: true } });
		const r = await post("/v1/runs/run-1/verifications", front, { ref: "agt-1", checks: "true", key: "k", waitMs: 1000 });
		expect(r.status).toBe(200);
		expect(await r.json()).toEqual({ done: true, id: "vfy-1", state: "passed", op: { id: "vfy-1", kind: "verify", state: "passed", result: { pass: true } } });
		expect(calls.at(-1)).toEqual({ op: "verify", runId: "run-1", body: { ref: "agt-1", checks: "true", key: "k", waitMs: 1000 } });
		next = () => new Promise(() => {});
		const t0 = Date.now();
		const s = await post("/v1/runs/run-1/merges", front, { ref: "agt-1", require: "vfy-1", id: "mrg-abc", waitMs: 50 });
		expect(s.status).toBe(202);
		expect(await s.json()).toEqual({ done: false, id: "mrg-abc", state: "running" });
		expect(Date.now() - t0).toBeLessThan(2000);
	});

	test("the operation's refusal is its relay.v1 error, with the gateway's status and code", async () => {
		const r = await post("/v1/runs/run-1/verifications", front, { ref: "refused" });
		expect(r.status).toBe(409);
		expect(await r.json()).toEqual({ code: "conflict", message: "verification vfy-x is failed", relay: { code: "conflict", message: "verification vfy-x is failed", hint: "Only a passing verification can gate a merge.", reason: "stale" } });
		next = () => Promise.reject(new RelayError("usage", "merge needs --require <vfyId>", "Run `capcomd verify` first."));
		const u = await post("/v1/runs/run-1/merges", front, { ref: "agt-1", waitMs: 1000 });
		expect(u.status).toBe(422);
		expect(await u.json()).toMatchObject({ code: "invalid", relay: { code: "usage", message: "merge needs --require <vfyId>" } });
	});

	test("a body the route doesn't take is 422 invalid, naming the field", async () => {
		const r = await post("/v1/runs/run-1/merges", front, { ref: "agt-1", askedBy: "agt-2" });
		expect(r.status).toBe(422);
		const w = await post("/v1/runs/run-1/verifications", front, { ref: "agt-1", waitMs: 60_000 });
		expect(w.status).toBe(422);
		expect(await w.json()).toMatchObject({ code: "invalid", field: "waitMs" });
	});

	test("a decision needs the approve scope, as POST /v1/approvals/{id}/decision does", async () => {
		next = async () => ({ id: "mrg-1", kind: "merge", state: "merged" });
		const no = await post("/v1/runs/run-1/merges/mrg-1/decision", front, { approve: true });
		expect(no.status).toBe(403);
		const ok = await post("/v1/runs/run-1/merges/mrg-1/decision", frontApprove, { approve: true, by: "cli", waitMs: 1000 });
		expect(ok.status).toBe(200);
		expect(await ok.json()).toMatchObject({ done: true, id: "mrg-1", state: "merged" });
		expect(calls.at(-1)).toEqual({ op: "decide", runId: "run-1", mergeId: "mrg-1", body: { approve: true, by: "cli", waitMs: 1000 } });
		const bad = await post("/v1/runs/run-1/merges/vfy-1/decision", frontApprove, { approve: true });
		expect(bad.status).toBe(422);
	});

	test("a daemon without the operations answers 404 (a front door then runs them itself)", async () => {
		const bare = harnessApp({ source: memorySource({ runs: [] }), clients: () => loadClients(path), state: harnessState(null) });
		const r = await bare.request("/v1/runs/run-1/verifications", { method: "POST", headers: { authorization: `Bearer ${front}`, "content-type": "application/json" }, body: JSON.stringify({ ref: "agt-1" }) });
		expect(r.status).toBe(404);
		expect(((await r.json()) as { relay?: unknown }).relay).toBeUndefined();
	});
});
