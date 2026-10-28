// Named killpoints, one actor call each, against a private engine (its own port block and data dir: never :6420 or the
// user's engine data). The engine host starts with CAPCOMD_KILLPOINT set, so the call really crashes it mid-way
// (SIGKILL, like a power cut); the engine comes back on the same data, the call is repeated, and it must converge:
// nothing half-written, nothing applied twice. (This file used to start rivetkit in the test process on the default
// port, where a killpoint couldn't fire and a daemon already on :6420 was used instead.)
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createClient } from "rivetkit/client";
import { Engine } from "./engine";
import { testPort } from "../helpers/engine";

const saved = { ...process.env };
let engine: Engine;
let client: any;

beforeAll(async () => {
  // The engine host's own fakes: an in-memory sandbox and the fake model (the defaults without other settings).
  Object.assign(process.env, { CAPCOMD_SANDBOX: "fake", CAPCOMD_SKIP_PREFLIGHT: "1" });
  const port = await testPort();
  engine = new Engine(`killpoints-${port}`, { port, dataDir: mkdtempSync(join(tmpdir(), "capcomd-chaos-kp-")) });
  client = createClient({ endpoint: `http://127.0.0.1:${port}` });
});

afterAll(async () => {
  await engine?.stop();
  for (const k of ["CAPCOMD_SANDBOX", "CAPCOMD_SKIP_PREFLIGHT"]) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
});

/** Start the engine with `killpoint`, make the call that hits it (it dies under the call), then restart it clean. */
async function crashOn(killpoint: string, call: () => Promise<unknown>): Promise<void> {
  await engine.start(killpoint);
  const r = await call().then(() => "returned", (e) => `threw: ${String((e as Error)?.message ?? e).slice(0, 120)}`);
  for (let i = 0; i < 100 && !engine.sawKill; i++) await Bun.sleep(100);
  expect({ killpoint, killed: engine.sawKill, call: r.startsWith("threw") ? "threw" : r }).toEqual({ killpoint, killed: true, call: "threw" });
  await engine.stop();
  await engine.start(null);
}

/** Every entity's event seqs run 1..n with no gap or duplicate. */
function gapFree(seqs: Array<{ entityId: string; seq: number }>): string[] {
  const by = new Map<string, number[]>();
  for (const s of seqs) by.set(s.entityId, [...(by.get(s.entityId) ?? []), s.seq]);
  return [...by].flatMap(([id, ns]) => (JSON.stringify(ns.sort((a, b) => a - b)) === JSON.stringify(ns.map((_, i) => i + 1)) ? [] : [`${id}: ${ns.join(",")}`]));
}

describe("Chaos Tests - Named Killpoints (private engine, real crashes)", () => {
  // Each case starts from a stopped engine (the one before leaves it running after its restart).
  beforeEach(async () => { await engine.stop(); });

  test("tx.mid: a run whose creating transaction died is created once on retry, with a gap-free log", async () => {
    const runId = `chaos-tx-${Date.now()}`;
    const run = () => client.run.getOrCreate([runId]);
    await crashOn("tx.mid:1", () => run().createRun({ runId, goal: "Test chaos recovery", maxCost: 10 }));
    await run().createRun({ runId, goal: "Test chaos recovery", maxCost: 10 });
    const r = await run().getRun({ runId });
    expect(r?.state).toBe("planning");
    expect(gapFree(await run().listEventSeqs({}))).toEqual([]);
  }, 240_000);

  test("model.after_return.before_commit: the plan is made again on retry and recorded once", async () => {
    const runId = `chaos-model-${Date.now()}`;
    const plannerId = `${runId}-planner`;
    await engine.start(null);
    await client.run.getOrCreate([runId]).createRun({ runId, goal: "Test model chaos", maxCost: 10 });
    await engine.stop();
    await crashOn("model.after_return.before_commit:1", () => client.planner.getOrCreate([plannerId]).createPlan({ plannerId, runId, goal: "Test model chaos" }));
    const plan = await client.planner.getOrCreate([plannerId]).createPlan({ plannerId, runId, goal: "Test model chaos" });
    expect(plan.tasks.length).toBeGreaterThan(0);
    const again = await client.planner.getOrCreate([plannerId]).createPlan({ plannerId, runId, goal: "Test model chaos" });
    expect(again.tasks).toEqual(plan.tasks); // recorded once: a repeat reads it back
    expect((await client.run.getOrCreate([runId]).getRun({ runId }))?.state).toBe("planning");
  }, 240_000);

  test("budget.charge.mid: a charge whose transaction died is charged exactly once", async () => {
    const runId = `chaos-budget-${Date.now()}`;
    const run = () => client.run.getOrCreate([runId]);
    await engine.start(null);
    await run().createRun({ runId, goal: "Test budget chaos", maxCost: 10 });
    await engine.stop();
    const chargeId = `${runId}-charge-1`;
    await crashOn("budget.charge.mid:1", () => run().chargeBudget({ runId, chargeId, amount: 0.5 }));
    const first = await run().chargeBudget({ runId, chargeId, amount: 0.5 });
    expect(first.charged).not.toBe(false); // the crashed transaction left nothing behind
    expect(await run().chargeBudget({ runId, chargeId, amount: 0.5 })).toMatchObject({ charged: false, reason: "Already charged" });
    const charges: any[] = await run().getCharges({ runId });
    expect(charges.filter((c) => c.chargeId === chargeId || c.charge_id === chargeId).length).toBe(1);
  }, 240_000);

  test("vm.create.after_request.before_record: provisioning after the crash ends with one ready worker", async () => {
    const runId = `chaos-vm-${Date.now()}`;
    const workerId = `${runId}-worker-1`;
    await engine.start(null);
    await client.run.getOrCreate([runId]).createRun({ runId, goal: "Test VM chaos", maxCost: 10 });
    await engine.stop();
    const worker = () => client.worker.getOrCreate([runId, workerId]);
    await crashOn("vm.create.after_request.before_record:1", () => worker().provisionWorker({ workerId, runId, epoch: 1 }));
    await worker().provisionWorker({ workerId, runId, epoch: 1 });
    expect((await worker().getWorker({ workerId }))?.state).toBe("idle");
    expect(gapFree(await worker().listEventSeqs({}))).toEqual([]);
    await engine.stop();
  }, 240_000);
});
