// ADR-016 step 1 end to end against a real engine (fake sandbox + fake agent):
// run new / spawn / await / wait-any / cancel / tree / events, idempotency keys, children
// limits, budget carve, propagating cancel, stale-driver takeover.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Engine } from "../chaos/engine";
import { capcomd, testPort } from "../helpers/engine";
import { primitivesAgentsFile } from "./helpers";

let PORT = 0;
let engine: Engine;
let env: Record<string, string>;
const saved = { ...process.env };


beforeAll(async () => {
  env = { CAPCOMD_AGENTS_FILE: primitivesAgentsFile(), CAPCOMD_SPAWN_EXEC: "fake", CAPCOMD_AWAIT_POLL_MS: "100", CAPCOMD_DRIVER_LEASE_MS: "3000", CAPCOMD_SKIP_PREFLIGHT: "1" };
  Object.assign(process.env, env);
  PORT = await testPort();
  engine = new Engine("primitives-e2e", { port: PORT, dataDir: mkdtempSync(join(tmpdir(), "capcomd-prim-eng-")) });
  await engine.start(null);
  env.CAPCOMD_ENDPOINT = `http://127.0.0.1:${PORT}`;
}, 120_000);
afterAll(async () => {
  await engine?.stop();
  for (const k of Object.keys(env ?? {})) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
});

const cj = async (args: string[]) => {
  const r = await capcomd([...args, "--json"], env);
  let j: any = null;
  try { j = JSON.parse(r.stdout.trim().split("\n").pop()!); } catch {}
  return { ...r, j };
};

test("primitives: ids, keys, limits, budget, cancel propagation, await/wait-any, events", async () => {
  const key = `e2e-${Date.now()}`;
  const r1 = await cj(["run", "new", "--budget", "usd=8,turns=100", "--label", "prim e2e", "--key", key]);
  expect(r1.code).toBe(0);
  const runId = r1.j.runId as string;
  expect(runId).toMatch(/^run-k[0-9a-f]{16}$/);
  expect(r1.j).toMatchObject({ ok: true, created: true, budget: { usd: 8, turns: 100 } });
  expect((await cj(["run", "new", "--budget", "usd=8,turns=100", "--label", "prim e2e", "--key", key])).j).toMatchObject({ runId, created: false });
  const clash = await cj(["run", "new", "--budget", "usd=9,turns=100", "--label", "prim e2e", "--key", key]);
  expect(clash.code).not.toBe(0);
  expect(clash.j.error.code).toBe("conflict");

  // root supervisor (held: --no-start), idempotent by key
  const sup = await cj(["spawn", runId, "--profile", "sup", "--task", "supervise", "--key", "sup", "--budget", "4", "--no-start"]);
  expect(sup.code).toBe(0);
  expect(sup.j).toMatchObject({ created: true, depth: 0, profile: "sup", status: "pending", budget: { usd: 4, turns: 100 } });
  const supId = sup.j.agentId as string;
  expect((await cj(["spawn", runId, "--profile", "sup", "--task", "supervise", "--key", "sup", "--budget", "4", "--no-start"])).j).toMatchObject({ agentId: supId, created: false });
  expect((await cj(["spawn", runId, "--profile", "sup", "--task", "other", "--key", "sup", "--budget", "4", "--no-start"])).j.error.code).toBe("conflict");

  // children: carve 4 × 0.5 = 2, then 2 × 0.5 = 1; maxChildren=2; only "coder"; coders can't spawn
  const c1 = await cj(["spawn", runId, "--parent", supId, "--profile", "coder", "--task", "part 1", "--key", "c1", "--no-start"]);
  expect(c1.j).toMatchObject({ depth: 1, parent: supId, budget: { usd: 2, turns: 50 } });
  const c2 = await cj(["spawn", runId, "--parent", supId, "--profile", "coder", "--task", "part 2", "--key", "c2", "--no-start"]);
  expect(c2.j.budget).toEqual({ usd: 1, turns: 25 });
  const c3 = await cj(["spawn", runId, "--parent", supId, "--profile", "coder", "--task", "part 3", "--key", "c3", "--no-start"]);
  // ADR-017: saturating maxChildren is retryable backpressure (await or cancel a child), not a hard refusal.
  expect(c3.code).not.toBe(0);
  expect(c3.j.error.message).toContain("maxChildren=2");
  expect(c3.j.error).toMatchObject({ reason: "backpressure", retryable: true });
  expect((await cj(["spawn", runId, "--parent", supId, "--profile", "sup", "--task", "x", "--no-start"])).j.error.message).toContain("allowedChildProfiles");
  expect((await cj(["spawn", runId, "--parent", c1.j.agentId, "--profile", "coder", "--task", "x", "--no-start"])).j.error.message).toContain("allowSpawn=false");
  expect((await cj(["spawn", runId, "--parent", supId, "--profile", "coder", "--set", "maxTurns=99", "--task", "x", "--no-start"])).code).toBe(2);
  expect((await cj(["spawn", runId, "--profile", "coder", "--task", "x", "--budget", "5", "--no-start"])).j.error.message).toContain("exceeds $4");
  // turns: the run has 100, sup holds all of them while live
  expect((await cj(["spawn", runId, "--profile", "coder", "--task", "x", "--budget", "turns=1", "--no-start"])).j.error.message).toContain("exceeds 0 turns");

  // propagating cancel
  const cancel = await cj(["cancel", runId, supId, "--reason", "test"]);
  expect(cancel.code).toBe(0);
  expect(new Set(cancel.j.cancelled)).toEqual(new Set([supId, c1.j.agentId, c2.j.agentId]));
  expect((await cj(["cancel", runId, supId])).j.cancelled).toEqual([]); // idempotent
  expect((await cj(["spawn", runId, "--parent", supId, "--profile", "coder", "--task", "late", "--no-start"])).j.error.message).toContain("cancelled");

  // driven agents: spawn (detached driver) → await; held agent → await takes it over; wait-any
  const d1 = await cj(["spawn", runId, "--profile", "coder", "--task", "do work", "--key", "d1", "--budget", "usd=1,turns=10"]);
  const held = await cj(["spawn", runId, "--profile", "coder", "--task", "held", "--key", "held", "--budget", "usd=1,turns=10", "--no-start"]);
  const aw = await cj(["await", runId, d1.j.agentId, held.j.agentId, "--timeout-ms", "60000"]);
  expect(aw.code).toBe(0);
  expect(aw.j.agents.map((a: any) => a.status)).toEqual(["done", "done"]);
  expect(aw.j.agents[0].result.branch).toBe(`capcomd/${runId}/${d1.j.agentId}`);
  expect(aw.j.agents[0].spent).toMatchObject({ usd: 0, turns: 0 });
  expect(aw.j.agents[0].spent.wallSeconds).toBeGreaterThanOrEqual(0);
  const w1 = await cj(["spawn", runId, "--profile", "coder", "--task", "a", "--key", "w1", "--budget", "usd=0.5,turns=10"]);
  const w2 = await cj(["spawn", runId, "--profile", "coder", "--task", "b", "--key", "w2", "--budget", "usd=0.5,turns=10"]);
  const any = await cj(["wait-any", runId, w1.j.agentId, w2.j.agentId, "--timeout-ms", "60000"]);
  expect(any.code).toBe(0);
  expect([w1.j.agentId, w2.j.agentId]).toContain(any.j.first.agentId);
  expect(any.j.first.status).toBe("done");

  // tree + events
  const tree = await cj(["tree", runId]);
  expect(tree.j.agents.find((a: any) => a.agentId === supId).status).toBe("cancelled");
  const ev = await cj(["events", runId, "--limit", "1000"]);
  const types = ev.j.events.map((e: any) => e.type);
  for (const t of ["RUN_NEW", "AGENT_SPAWNED", "AGENT_CANCELLED", "AGENT_STARTED", "AGENT_DONE"]) expect(types).toContain(t);
  const spawned = ev.j.events.find((e: any) => e.type === "AGENT_SPAWNED" && e.entity === `scope:${supId}`);
  expect(spawned.event).toMatchObject({ profile: "sup", budget: { usd: 4, turns: 100 }, limits: { allowSpawn: true, maxDepth: 2 }, agent: { maxTurns: 40 } });
  expect(types.filter((t: string) => t === "AGENT_SPAWNED").length).toBe(7);

  // run-wide cancel cancels the rest (w-agent still running or done) and the run
  const all = await cj(["cancel", runId]);
  expect(all.code).toBe(0);
}, 180_000);
