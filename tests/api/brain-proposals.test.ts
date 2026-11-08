// Capability context.brain_proposals on the harness API (ADR-025 step 5): GET /v1/runs/{runId}/brain-proposals lists a
// run's proposals to a company's brain, POST …/brain-proposals/send sends those waiting for a person as the caller
// (groundray's actor human:<client id>), as `capcomd context brain propose --run <runId> --yes` does. Engine-free
// (memory source); the engine-backed send is tests/scenarios/context-brain.test.ts.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addClient, loadClients, mintPluginClient } from "../../src/api/clients";
import { BrainProposals, BrainProposalsSent, CAPABILITY_NAMES } from "../../src/api/contract";
import { harnessApp } from "../../src/api/server";
import { memorySource } from "../../src/api/source";
import { harnessState } from "../../src/api/state";

const dir = mkdtempSync(join(tmpdir(), "harness-brain-"));
const cpath = join(dir, "clients.json");
const reader = addClient("reader", ["read"], cpath).token;
const steer = addClient("menubar", ["read", "steer"], cpath).token;
const admin = addClient("app", ["read", "steer", "configure"], cpath);
const adminId = admin.client.id;

const proposal = (n: number, o: Record<string, unknown> = {}) => ({
  id: `agt-cons.${n}`, agentId: "agt-cons", brain: "acme", type: "policy", title: `Fact ${n}`, from: ["agt-w.1"], at: "2026-11-08T10:00:00.000Z", sent: null, ...o,
});

function setup(o: { fails?: Record<string, string> } = {}) {
  const run = { id: "run-b", projectId: null, label: "Brain", state: "idle", goal: null, repo: "/r", createdAt: "2026-11-08T09:00:00.000Z" };
  const src = memorySource({
    runs: [run], events: { "run-b": [] },
    brainProposals: { "run-b": [proposal(1), proposal(2), proposal(3, { agentId: "agt-other", id: "agt-other.3", sent: { actor: "capcomd/0.0.0", at: "2026-11-08T10:01:00.000Z", item: "urn:uuid:x", where: "fake://pull/9" } })] },
    ...(o.fails ? { brainFails: o.fails } : {}),
  });
  const app = harnessApp({ source: src, clients: () => loadClients(cpath), pollMs: 20, state: harnessState(null) });
  const post = async (p: string, token = admin.token, key: string | null = `k-${Math.random()}`, body?: unknown) => {
    const r = await app.request(p, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: (await r.json()) as any };
  };
  const get = async (p: string, token = reader) => { const r = await app.request(p, { headers: { authorization: `Bearer ${token}` } }); return { status: r.status, body: (await r.json()) as any }; };
  return { src, post, get };
}

describe("capability context.brain_proposals", () => {
  test("health lists it", () => { expect(CAPABILITY_NAMES).toContain("context.brain_proposals"); });

  test("GET …/brain-proposals: the run's proposals and whether each was sent; 404 for an unknown run", async () => {
    const { get } = setup();
    const r = await get("/v1/runs/run-b/brain-proposals");
    expect(r.status).toBe(200);
    expect(BrainProposals.parse(r.body)).toEqual(r.body);
    expect(r.body.proposals.map((p: any) => [p.id, p.sent?.where ?? null])).toEqual([["agt-cons.1", null], ["agt-cons.2", null], ["agt-other.3", "fake://pull/9"]]);
    expect((await get("/v1/runs/run-none/brain-proposals")).body.code).toBe("not_found");
  });

  test("POST …/send: the configure scope and an Idempotency-Key; sends those waiting as the caller; a replay with the same key is answered once", async () => {
    const { src, post, get } = setup();
    // Scope: reading or steering a run isn't enough to write in a company's brain in someone's name.
    expect((await post("/v1/runs/run-b/brain-proposals/send", reader)).status).toBe(403);
    expect((await post("/v1/runs/run-b/brain-proposals/send", steer)).body).toMatchObject({ code: "forbidden", message: expect.stringContaining("configure") });
    expect((await post("/v1/runs/run-b/brain-proposals/send", admin.token, null)).status).toBe(422);
    // A plugin's token, whatever its scopes: a plugin never sends a proposal in a person's name.
    const plugin = mintPluginClient("x-brainy", ["read", "steer", "configure"]);
    try { expect((await post("/v1/runs/run-b/brain-proposals/send", plugin.token)).body).toMatchObject({ code: "forbidden", message: expect.stringContaining("a person sends them") }); } finally { plugin.revoke(); }
    expect(src.brainSent).toEqual([]);

    const key = "brain-send-key-1";
    const first = await post("/v1/runs/run-b/brain-proposals/send", admin.token, key);
    expect(first.status).toBe(200);
    expect(BrainProposalsSent.parse(first.body)).toEqual(first.body);
    expect(first.body.actor).toBe(`human:${adminId}`);
    expect(first.body.sent).toEqual([
      expect.objectContaining({ id: "agt-cons.1", ok: true, already: false, where: "fake://pull/1" }),
      expect.objectContaining({ id: "agt-cons.2", ok: true, already: false }),
      expect.objectContaining({ id: "agt-other.3", ok: true, already: true, where: "fake://pull/9" }),
    ]);
    // The caller is the actor of what was sent now; what was sent before stays as it was.
    expect(src.brainSent).toEqual([{ runId: "run-b", id: "agt-cons.1", actor: `human:${adminId}` }, { runId: "run-b", id: "agt-cons.2", actor: `human:${adminId}` }]);
    const listed = (await get("/v1/runs/run-b/brain-proposals")).body.proposals;
    expect(listed.map((p: any) => p.sent.actor)).toEqual([`human:${adminId}`, `human:${adminId}`, "capcomd/0.0.0"]);

    // A replay with the same key answers the first 200 and sends nothing; the same key on another body is a conflict.
    const again = await post("/v1/runs/run-b/brain-proposals/send", admin.token, key);
    expect(again).toEqual(first);
    expect(src.brainSent).toHaveLength(2);
    expect((await post("/v1/runs/run-b/brain-proposals/send", admin.token, key, { agentId: "agt-cons" })).body.code).toBe("idempotency_conflict");
    // A new key: everything is sent already, nothing is sent again.
    const fresh = await post("/v1/runs/run-b/brain-proposals/send");
    expect(fresh.body.sent.every((x: any) => x.already)).toBe(true);
    expect(src.brainSent).toHaveLength(2);
    expect((await post("/v1/runs/run-none/brain-proposals/send")).status).toBe(404);
  });

  test("POST …/send: one consolidator's with agentId; a body that isn't one is 422", async () => {
    const { src, post } = setup();
    expect((await post("/v1/runs/run-b/brain-proposals/send", admin.token, "k-agent-only", { agentId: "agt-other" })).body.sent).toEqual([expect.objectContaining({ id: "agt-other.3", already: true })]);
    expect(src.brainSent).toEqual([]);
    expect((await post("/v1/runs/run-b/brain-proposals/send", admin.token, "k-bad-agent", { agentId: "../etc" })).body).toMatchObject({ code: "invalid", field: "agentId" });
  });

  test("POST …/send: one that couldn't be sent is 503 with each outcome, never kept, so the same key sends it once it can", async () => {
    const fails = { "agt-cons.2": "groundray knowledge create (plan) failed (1): offline" };
    const { src, post } = setup({ fails });
    const key = "brain-send-retry";
    const first = await post("/v1/runs/run-b/brain-proposals/send", admin.token, key);
    expect(first.status).toBe(503);
    expect(first.body).toMatchObject({ code: "unavailable", message: expect.stringContaining("1 of 3") });
    expect(first.body.sent.map((x: any) => [x.id, x.ok])).toEqual([["agt-cons.1", true], ["agt-cons.2", false], ["agt-other.3", true]]);
    expect(src.brainSent.map((x) => x.id)).toEqual(["agt-cons.1"]);
    delete (fails as Record<string, string>)["agt-cons.2"];
    const retry = await post("/v1/runs/run-b/brain-proposals/send", admin.token, key);
    expect(retry.status).toBe(200);
    expect(retry.body.sent.map((x: any) => [x.id, x.already])).toEqual([["agt-cons.1", true], ["agt-cons.2", false], ["agt-other.3", true]]);
    expect(src.brainSent.map((x) => x.id)).toEqual(["agt-cons.1", "agt-cons.2"]);
  });
});
