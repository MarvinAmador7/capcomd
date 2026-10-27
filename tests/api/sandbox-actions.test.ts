// ADR-021 phase 3 (capability sandboxes.actions): POST /v1/sandboxes/{name}/resources/{id}/actions/delete. An agent's
// machine is deleted by cancelling that agent (agent.cancelled), an orphan by the provider, capcomd's own jobs' machines
// not at all; the id must be a machine capcomd lists; the state is read again before acting; one action at a time; the
// write-route Idempotency-Key rules; and the sandbox.resource_action / sandbox.resource_deleted audit events. Engine-free:
// the memory source with injected provider lists, owners and a recording destroy. Nothing here reaches a real daemon.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addClient, loadClients } from "../../src/api/clients";
import { CAPABILITY_NAMES, EventData, ResourceActionResult, ResourcePage } from "../../src/api/contract";
import { HarnessEvent } from "../../src/api/envelope";
import { harnessApp } from "../../src/api/server";
import { memorySource } from "../../src/api/source";
import { harnessState } from "../../src/api/state";
import { deleteConfirm, liveDescendants, taskLine, type MachineOwner } from "../../src/api/sandboxes";
import { PROVIDERS } from "../../src/providers/registry";
import { resetMachineAudit } from "../../src/providers/machine-audit";
import type { VmInfo } from "../../src/providers/sandbox";
import spec from "../../openapi/capcomd.json";

const dir = mkdtempSync(join(tmpdir(), "harness-actions-"));
const cpath = join(dir, "clients.json");
const steerer = addClient("menubar", ["read", "steer", "approve", "configure"], cpath);
const reader = addClient("reader", ["read"], cpath).token;
const other = addClient("other", ["read", "steer"], cpath).token;

const OWNED = "relay-3f9c2a1b7e5d4c60", ORPHAN = "relay-0a0b0c0d0e0f1011", CHECK = "relay-c0ffee00c0ffee00";
const rows = (): VmInfo[] => [
	{ id: "m_1", name: OWNED, state: "running", createdAt: Date.parse("2026-10-27T09:12:03.000Z") },
	{ id: "m_2", name: ORPHAN, state: "running", createdAt: Date.parse("2026-10-27T07:00:00.000Z") },
	{ id: "m_3", name: CHECK, state: "running" },
	{ id: "m_4", name: "someone-elses-machine", state: "running" },
];
const WORKER: MachineOwner = { sandbox: "boxd", vmId: "m_1", name: OWNED, runId: "run-8kq2", agentId: "agt-41", role: "worker", task: taskLine("Add an abs(a) function to math.ts with tests"), workerState: "busy", createdAt: null };
const CHECKS: MachineOwner = { sandbox: "boxd", vmId: null, name: CHECK, kind: "check", runId: "run-8kq2", agentId: null, role: "checks", task: null, label: "Checks for run-8kq2", workerState: "busy", createdAt: null };
const agent = (id: string, status: string, parent: string | null = null) =>
	({ id, runId: "run-8kq2", parent, depth: parent ? 1 : 0, profile: "worker", status, text: "", task: "t", taskAttachment: null, result: null, updatedAt: null }) as any;
const run = { id: "run-8kq2", projectId: null, label: "demo", state: "running", goal: null, repo: "/r", createdAt: "2026-10-27T09:00:00.000Z" };

type Seed = Parameters<typeof memorySource>[0];
function setup(seed: Seed = {}) {
	const machines = seed?.machines ?? { boxd: rows() };
	const src = memorySource({
		runs: [run], agents: { "run-8kq2": [agent("agt-41", "running"), agent("agt-42", "running", "agt-41"), agent("agt-50", "running")] },
		owners: [WORKER, CHECKS], ...seed, machines,
	});
	const state = harnessState(null);
	const app = harnessApp({ source: src, clients: () => loadClients(cpath), state, pollMs: 20 });
	const post = async (name: string, id: string, action = "delete", key: string | null = `key-${crypto.randomUUID()}`, token = steerer.token) => {
		const r = await app.request(`/v1/sandboxes/${name}/resources/${id}/actions/${action}`, { method: "POST", headers: { authorization: `Bearer ${token}`, ...(key ? { "idempotency-key": key } : {}) } });
		return { status: r.status, body: (await r.json()) as any };
	};
	const get = async (p: string) => (await (await app.request(p, { headers: { authorization: `Bearer ${reader}` } })).json()) as any;
	const audit = () => state.daemonEvents().map((e) => ({ type: e.type, data: e.data }));
	return { src, app, state, post, get, audit };
}

afterEach(() => resetMachineAudit());

describe("POST /v1/sandboxes/{name}/resources/{id}/actions/delete", () => {
	test("advertised and published, with 403 and 503 among its answers", () => {
		expect(CAPABILITY_NAMES).toContain("sandboxes.actions");
		const op = (spec as any).paths["/v1/sandboxes/{name}/resources/{id}/actions/{action}"]?.post;
		expect(op?.operationId).toBe("sandboxes.action");
		expect(Object.keys(op.responses)).toEqual(expect.arrayContaining(["200", "403", "404", "409", "422", "503"]));
		expect(op.parameters.map((p: any) => p.name)).toEqual(expect.arrayContaining(["name", "id", "action", "idempotency-key"]));
		expect(op.requestBody).toBeUndefined();
	});

	test("resources that can be deleted say so, with the daemon's question", async () => {
		const { get } = setup();
		const page = await get("/v1/sandboxes/boxd/resources");
		expect(ResourcePage.parse(page)).toBeTruthy();
		const by = (id: string) => page.resources.find((r: any) => r.id === id);
		expect(by(OWNED)).toMatchObject({ actions: ["open_terminal", "delete"], destructive: true,
			confirm: "Delete worker's machine? This stops the worker on “Add an abs(a) function to math.ts with…”. Work since its last checkpoint is lost." });
		expect(by(ORPHAN)).toMatchObject({ actions: ["open_terminal", "delete"], destructive: true, confirm: "Delete this machine? No agent is using it." });
		expect(by(CHECK)).toMatchObject({ actions: [], destructive: false, confirm: null });
	});

	test("an agent's machine: that agent (and the ones it started) is cancelled, agent.cancelled, no provider call; audited", async () => {
		const { src, post, get, audit, state } = setup();
		const r = await post("boxd", OWNED);
		expect(r.status).toBe(200);
		expect(ResourceActionResult.parse(r.body)).toBeTruthy();
		expect(r.body).toMatchObject({ changed: true, resource: { id: OWNED, state: "stopping", actions: [], destructive: false, confirm: null, owner: { kind: "agent", runId: "run-8kq2", agentId: "agt-41" } } });
		expect(src.destroyed).toEqual([]);
		const evs = (await get("/v1/events?scope=run-8kq2")) as any[];
		const cancelled = evs.filter((e) => e.type === "agent.cancelled");
		expect(cancelled.map((e) => e.agentId)).toEqual(["agt-41", "agt-42"]);
		expect(cancelled[0].data.reason).toBe(`cancelled by client:${steerer.client.id}`);
		expect((await src.agents("run-8kq2"))!.find((a) => a.id === "agt-50")!.status).toBe("running");
		expect(audit()).toEqual([
			{ type: "sandbox.resource_action", data: { sandbox: "boxd", resourceId: OWNED, action: "delete", owner: { kind: "agent", runId: "run-8kq2", agentId: "agt-41", role: "worker" }, clientId: steerer.client.id } },
			{ type: "sandbox.resource_deleted", data: { sandbox: "boxd", resourceId: OWNED, cause: "action" } },
		]);
		expect(state.daemonEvents().map((e) => e.text)).toEqual([
			`Cloud: Delete on machine ${OWNED}: cancelled worker agt-41 of run-8kq2.`,
			`Cloud: machine ${OWNED} was deleted from capcomd.`,
		]);
		// The audit never copies the agent's task.
		expect(JSON.stringify(state.daemonEvents())).not.toContain("abs(a)");
		// Served on the daemon stream's replay, in the envelope, with payloads the contract declares.
		const daemon = (await get("/v1/events?scope=daemon")) as any[];
		expect(daemon.map((e) => e.type)).toEqual(["sandbox.resource_action", "sandbox.resource_deleted"]);
		for (const e of daemon) {
			expect(HarnessEvent.parse(e)).toBeTruthy();
			expect((EventData as any)[e.type].parse(e.data)).toBeTruthy();
			expect(e).toMatchObject({ scope: "daemon", entity: "sandbox:boxd", durability: "durable", runId: null });
		}
		expect(daemon[1].seq).toBeGreaterThan(daemon[0].seq);
	});

	test("an orphan: the provider deletes it by its provider id; the list no longer has it", async () => {
		const { src, post, get, audit } = setup();
		expect((await get("/v1/sandboxes/boxd/resources")).resources.map((r: any) => r.id)).toContain(ORPHAN);
		const r = await post("boxd", ORPHAN);
		expect(r).toEqual({ status: 200, body: { changed: true, resource: expect.objectContaining({ id: ORPHAN, state: "stopping", owner: null, actions: [] }) } });
		expect(src.destroyed).toEqual([{ sandbox: "boxd", vmId: "m_2" }]);
		expect((await get("/v1/sandboxes/boxd/resources")).resources.map((r: any) => r.id)).not.toContain(ORPHAN);
		expect(audit()).toEqual([
			{ type: "sandbox.resource_action", data: { sandbox: "boxd", resourceId: ORPHAN, action: "delete", owner: null, clientId: steerer.client.id } },
			{ type: "sandbox.resource_deleted", data: { sandbox: "boxd", resourceId: ORPHAN, cause: "action" } },
		]);
		// Asked again with a new key: it isn't capcomd's machine any more.
		expect((await post("boxd", ORPHAN)).status).toBe(404);
	});

	test("a machine of capcomd's own job: 409, nothing deleted", async () => {
		const { src, post, audit } = setup();
		const r = await post("boxd", CHECK);
		expect(r).toEqual({ status: 409, body: { code: "conflict", message: "capcomd is using this machine itself (Checks for run-8kq2) and deletes it when that's done." } });
		expect(src.destroyed).toEqual([]);
		expect(audit()).toEqual([]);
	});

	test("ids capcomd doesn't list, places it doesn't list, and malformed ids: 404 before any provider call", async () => {
		const { src, post } = setup();
		for (const id of ["relay-ffffffffffffffff", "someone-elses-machine", "m_2", "relay-*", encodeURIComponent("relay-x;rm -rf ~"), encodeURIComponent(`${ORPHAN},${OWNED}`)]) {
			const r = await post("boxd", id);
			expect(r.status).toBe(404);
			expect(r.body.code).toBe("not_found");
			expect(r.body.message).not.toContain("rm -rf");
		}
		expect((await post("docker", ORPHAN)).status).toBe(404);
		expect((await post("fake", ORPHAN)).body).toEqual({ code: "not_found", message: "sandbox fake not found" });
		expect((await post("nowhere", ORPHAN)).status).toBe(404);
		expect(src.destroyed).toEqual([]);
	});

	test("unknown actions, open_terminal, and an action the provider doesn't declare: 404", async () => {
		const { src, post, get } = setup();
		expect((await post("boxd", ORPHAN, "extend")).body).toEqual({ code: "not_found", message: "extend isn't an action on machines (actions: delete)" });
		expect((await post("boxd", ORPHAN, "rm%20-rf")).body.message).toBe("that isn't an action on machines (actions: delete)");
		expect((await post("boxd", ORPHAN, "open_terminal")).body).toMatchObject({ code: "not_found", message: expect.stringContaining("terminalCommand") });
		const actions = PROVIDERS.boxd.actions;
		(PROVIDERS.boxd as any).actions = ["open_terminal"];
		try {
			expect((await post("boxd", ORPHAN)).body).toEqual({ code: "not_found", message: "boxd machines have no delete action" });
			expect((await get("/v1/sandboxes/boxd")).descriptor.actions).toEqual(["open_terminal"]);
		} finally { (PROVIDERS.boxd as any).actions = actions; }
		expect(src.destroyed).toEqual([]);
	});

	test("the Idempotency-Key is required; a replay answers the first result and deletes once; reused elsewhere it is a conflict", async () => {
		const { src, post, audit } = setup();
		expect(await post("boxd", ORPHAN, "delete", null)).toEqual({ status: 422, body: { code: "invalid", message: "Idempotency-Key header (8-200 chars) is required" } });
		expect((await post("boxd", ORPHAN, "delete", "short")).status).toBe(422);
		const first = await post("boxd", ORPHAN, "delete", "delete-orphan-1");
		expect(first.status).toBe(200);
		const again = await post("boxd", ORPHAN, "delete", "delete-orphan-1");
		expect(again).toEqual(first);
		expect(src.destroyed).toHaveLength(1);
		expect(audit()).toHaveLength(2);
		expect((await post("boxd", OWNED, "delete", "delete-orphan-1")).body.code).toBe("idempotency_conflict");
		// The key is the client's own: another client's same key is a new request (the machine is gone: 404).
		expect((await post("boxd", ORPHAN, "delete", "delete-orphan-1", other)).status).toBe(404);
		// The owned machine, twice with one key: one cancel.
		const k = "delete-owned-1";
		const a = await post("boxd", OWNED, "delete", k), b = await post("boxd", OWNED, "delete", k);
		expect(a.status).toBe(200);
		expect(b).toEqual(a);
		expect(audit().filter((e) => e.type === "sandbox.resource_action")).toHaveLength(2);
	});

	test("needs the steer scope: 403 for a read-only token, 401 without one", async () => {
		const { src, app, post } = setup();
		expect(await post("boxd", ORPHAN, "delete", "key-reader-1", reader)).toEqual({ status: 403, body: { code: "forbidden", message: "token lacks the steer scope" } });
		expect((await app.request(`/v1/sandboxes/boxd/resources/${ORPHAN}/actions/delete`, { method: "POST", headers: { "idempotency-key": "key-anon-1" } })).status).toBe(401);
		expect(src.destroyed).toEqual([]);
	});

	test("a provider that doesn't answer: 503 unavailable, nothing deleted, and the next try looks again", async () => {
		let calls = 0;
		let hang = false;
		const list = () => (++calls > 1 && hang ? new Promise<VmInfo[]>(() => {}) : Promise.resolve(rows()));
		const { src, post, audit } = setup({ machines: { boxd: list }, surface: { lookupTimeoutMs: 50 } });
		hang = true;
		const r = await post("boxd", ORPHAN);
		expect(r).toEqual({ status: 503, body: { code: "unavailable", message: "boxd didn't answer within 0.05 seconds, so nothing was deleted. Try again in a moment." } });
		expect(src.destroyed).toEqual([]);
		expect(audit()).toEqual([]);
		hang = false;
		expect((await post("boxd", ORPHAN)).status).toBe(200);
	});

	test("a delete the provider doesn't confirm in time: 503, and a failing provider is 503 with a daemon-written sentence", async () => {
		const slow = setup({ destroy: () => new Promise<void>(() => {}), surface: { actionTimeoutMs: 50 } });
		expect(await slow.post("boxd", ORPHAN)).toEqual({ status: 503, body: { code: "unavailable", message: "boxd didn't answer within 0.05 seconds. Look again in a moment: the machine may still be deleted." } });
		expect(slow.audit()).toEqual([]);
		const broken = setup({ destroy: async () => { throw new Error("HTTP 500 sk-ant-oat01-SECRETSECRETSECRET from boxd"); } });
		const r = await broken.post("boxd", ORPHAN);
		expect(r).toEqual({ status: 503, body: { code: "unavailable", message: "boxd couldn't delete the machine just now. Try again in a moment." } });
		// capcomd's records that can't be read: nothing is deleted on a guess.
		let n = 0;
		const blind = setup({ owners: () => (++n > 1 ? Promise.reject(new Error("engine down")) : Promise.resolve([WORKER, CHECKS])) });
		expect((await blind.post("boxd", ORPHAN)).body).toEqual({ code: "unavailable", message: "capcomd couldn't read which agents use its machines, so nothing was deleted. Try again in a moment." });
		expect(blind.src.destroyed).toEqual([]);
	});

	test("who uses it changed between the read and the act: 409, nothing deleted, nobody cancelled", async () => {
		// Left behind when the daemon listed it; an agent took it (resumed into it) by the time the delete runs.
		const taker: MachineOwner = { ...WORKER, vmId: "m_2", name: ORPHAN, agentId: "agt-50" };
		let n = 0;
		const { src, post, get, audit } = setup({ owners: () => Promise.resolve(++n > 1 ? [WORKER, CHECKS, taker] : [WORKER, CHECKS]) });
		const r = await post("boxd", ORPHAN);
		expect(r).toEqual({ status: 409, body: { code: "conflict", message: "This machine changed since you looked: the worker agt-50 is using it now. Look again before deleting it." } });
		expect(src.destroyed).toEqual([]);
		expect(((await get("/v1/events?scope=run-8kq2")) as any[]).filter((e) => e.type === "agent.cancelled")).toEqual([]);
		expect(audit()).toEqual([]);
		// The other way: the agent ended and its machine is left behind now.
		let m = 0;
		const ended = setup({ owners: () => Promise.resolve(++m > 1 ? [CHECKS] : [WORKER, CHECKS]) });
		expect((await ended.post("boxd", OWNED)).body).toEqual({ code: "conflict", message: "This machine changed since you looked: no agent is using it now. Look again before deleting it." });
		expect(ended.src.destroyed).toEqual([]);
	});

	test("an agent that ended just before its cancel: 409", async () => {
		const { src, post, audit } = setup({ agents: { "run-8kq2": [agent("agt-41", "done")] } });
		expect((await post("boxd", OWNED)).body).toEqual({ code: "conflict", message: "agt-41 has already ended, so this machine is no longer its own. Look again in a moment." });
		expect(src.destroyed).toEqual([]);
		expect(audit()).toEqual([]);
	});

	test("already gone when the daemon looks again: 200 with changed false, nothing audited", async () => {
		let n = 0;
		const { src, post, audit } = setup({ machines: { boxd: () => Promise.resolve(++n > 1 ? rows().filter((r) => r.name !== ORPHAN) : rows()) } });
		expect(await post("boxd", ORPHAN)).toEqual({ status: 200, body: { resource: null, changed: false } });
		expect(src.destroyed).toEqual([]);
		expect(audit()).toEqual([]);
	});

	test("one action at a time per machine: a second Delete while the first runs is 409", async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const { src, post } = setup({ destroy: () => gate });
		const first = post("boxd", ORPHAN, "delete", "concurrent-1");
		await Bun.sleep(30);
		expect(await post("boxd", ORPHAN, "delete", "concurrent-2")).toEqual({ status: 409, body: { code: "conflict", message: "Another Delete of this machine is still under way." } });
		release();
		expect((await first).status).toBe(200);
		expect(src.destroyed).toHaveLength(1);
	});
});

describe("the Delete question", () => {
	test("names the agent, the agents it started, and the work that's lost; plain for one left behind", () => {
		expect(deleteConfirm(null)).toBe("Delete this machine? No agent is using it.");
		expect(deleteConfirm({ role: "worker", agentId: "agt-41", task: "Add an abs(a) function", descendants: 0 }))
			.toBe("Delete worker's machine? This stops the worker on “Add an abs(a) function”. Work since its last checkpoint is lost.");
		expect(deleteConfirm({ role: "planner", agentId: "agt-1", task: "Fix the three failing date tests in utils and the parser module", descendants: 3 }))
			.toBe("Delete planner's machine? This stops the planner on “Fix the three failing date tests in…” and the 3 agents it started. Work since their last checkpoints is lost.");
		expect(deleteConfirm({ role: null, agentId: "agt-9", task: null, descendants: 1 }))
			.toBe("Delete agt-9's machine? This stops agt-9 and the agent it started. Work since their last checkpoints is lost.");
		expect(deleteConfirm({ role: "Evil\"Role", agentId: "x;y", task: null }))
			.toBe("Delete this agent's machine? This stops this agent. Work since its last checkpoint is lost.");
	});
	test("descendants count live agents below one, through their parents", () => {
		const live = [{ agentId: "a", parent: null }, { agentId: "b", parent: "a" }, { agentId: "c", parent: "b" }, { agentId: "d", parent: null }, { agentId: "e", parent: "gone" }];
		expect(liveDescendants(live, "a")).toBe(2);
		expect(liveDescendants(live, "b")).toBe(1);
		expect(liveDescendants(live, "d")).toBe(0);
	});
});
