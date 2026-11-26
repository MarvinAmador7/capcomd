// The Crew screen's daemon side on a real engine: GET /v1/profiles/{name}/work reads each run's agents of a profile
// with the scope's one-query `profileWork` (capability profiles.work), and an agent of a profile that sets
// identity.avatar.seed carries it on agent.spawned and Agent (capability profiles.avatar). tests/api/crew.test.ts
// covers the rest engine-free.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addClient, loadClients } from "../../src/api/clients";
import { Agent, ProfileWork } from "../../src/api/contract";
import { strictEventData } from "../../src/api/legacy-events";
import { rivetSource } from "../../src/api/rivet-source";
import { harnessApp } from "../../src/api/server";
import { harnessState } from "../../src/api/state";
import { client } from "../../src/core/relay";
import { newRun, spawnRoot, trajectory, waitAll, WORKER, world, type World } from "./harness";

let w: World;
beforeAll(async () => {
  w = await world("profile-work");
  // A project profile (the profiles/ next to the harness's agents.json) with a face of its own.
  mkdirSync(join(w.dir, "profiles", "scout"), { recursive: true });
  writeFileSync(join(w.dir, "profiles", "scout", "profile.yaml"), "schema: capcomd.profile/v2\nname: scout\nidentity: { avatar: { seed: scout-face } }\nharness: { provider: claude, auth: subscription }\nlimits: { maxTurns: 10 }\n");
}, 120_000);
afterAll(async () => { await w?.stop(); });

test("a profile's work across runs, newest first, with outcomes from state and results; its agents carry its avatar seed", async () => {
  const ok = w.script("ok", WORKER), bad = w.script("bad", `EXIT=3\n${WORKER}`);
  const runA = await newRun(w), runB = await newRun(w);
  const a1 = await spawnRoot(w, runA, "scout", ok, { task: "map the login flow" });
  const a2 = await spawnRoot(w, runA, "scout", bad, { task: "break the parser" });
  const b1 = await spawnRoot(w, runB, "scout", ok, { task: "survey the tests" });
  const other = await spawnRoot(w, runB, "worker", ok, { task: "not a scout" });
  await waitAll(w, runA, [a1, a2]);
  await waitAll(w, runB, [b1, other]);
  // What verify and merge write on the agent (Agent.result), as they would after its work merged.
  await (client().scope as any).getOrCreate([runB]).annotateResult({ agentId: b1, patch: { verification: { pass: true }, merge: { state: "merged" } } });

  const clients = join(w.dir, "harness-clients.json");
  const { token } = addClient("crew", ["read"], clients);
  const app = harnessApp({ source: rivetSource(), clients: () => loadClients(clients), pollMs: 100, state: harnessState(null) });
  const get = async (p: string) => { const r = await app.request(p, { headers: { authorization: `Bearer ${token}` } }); return { status: r.status, body: (await r.json()) as any }; };

  const r = await get("/v1/profiles/scout/work?limit=10");
  expect(r.status).toBe(200);
  expect(ProfileWork.parse(r.body)).toEqual(r.body);
  const byId = new Map(r.body.items.map((i: any) => [i.agentId, i]));
  expect([...byId.keys()].sort()).toEqual([a1, a2, b1].sort());
  expect(byId.get(a1)).toMatchObject({ runId: runA, title: "map login flow", outcome: "idle", endedAt: expect.any(Number) });
  expect(byId.get(a2)).toMatchObject({ runId: runA, outcome: "failed" });
  expect(byId.get(b1)).toMatchObject({ runId: runB, outcome: "merged" });
  const at = r.body.items.map((i: any) => i.updatedAt);
  expect(at).toEqual([...at].sort((x: number, y: number) => y - x));
  expect((await get("/v1/profiles/scout/work?limit=1")).body.items).toHaveLength(1);
  expect((await get("/v1/profiles/worker/work")).body.items.map((i: any) => i.agentId)).toContain(other);

  // One face per profile: agent.spawned and Agent carry the seed; an agent of a profile without one carries null.
  const spawned = new Map((await trajectory(w, runA)).filter((e) => e.type === "AGENT_SPAWNED").map((e) => [e.agentId, e.data]));
  expect(spawned.get(a1).avatarSeed).toBe("scout-face");
  for (const d of spawned.values()) expect(strictEventData("agent.spawned", d)).toEqual({ ok: true });
  const listed = (await get(`/v1/runs/${runB}/agents`)).body as any[];
  for (const a of listed) expect(Agent.safeParse(a).success).toBe(true);
  expect(listed.find((a) => a.id === b1).avatarSeed).toBe("scout-face");
  expect(listed.find((a) => a.id === other).avatarSeed).toBeNull();
}, 120_000);
