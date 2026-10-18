import { describe, expect, test, beforeAll } from "bun:test";
import { Engine, runClient, sleep } from "./engine";
import { auditRun, eventGapViolations } from "./invariants";
import { randomKillpoint } from "./harness";
import { survive, wipeEngineData, releasePort } from "./survive";

const KILLPOINTS = [
  "tx.mid",
  "model.after_return.before_commit",
  "merge.before_cas",
  "merge.after_cas.before_event",
  "push.mid",
  "push.after.before_event",
  "vm.create.after_request.before_record",
  "lease.expire.mid",
  "budget.charge.mid",
  "outbox.dispatch.after_send.before_ack",
];


describe("Chaos Tests - Subprocess Killpoints", () => {
  beforeAll(async () => {
    await wipeEngineData();
  });

  test("event gap helper rejects holes and duplicate seqs", () => {
    expect(eventGapViolations([{ entityId: "a", seq: 1 }, { entityId: "a", seq: 2 }])).toEqual([]);
    expect(eventGapViolations([{ entityId: "a", seq: 1 }, { entityId: "a", seq: 3 }])[0]).toContain("event gap");
    expect(eventGapViolations([{ entityId: "a", seq: 1 }, { entityId: "a", seq: 1 }])[0]).toContain("duplicate");
  });

  test("survives all 10 named killpoints", async () => {
    const results: Array<{ killpoint: string; ok: boolean; ms: number; error?: string; killed: boolean }> = [];

    for (const killpoint of KILLPOINTS) {
      const started = Date.now();
      console.log(`Testing killpoint: ${killpoint}`);
      const result = await survive(killpoint, 1, true);
      const ms = Date.now() - started;
      results.push({ killpoint, ok: result.ok, ms, error: result.error, killed: result.killed });
      console.log(
        `  ${result.ok ? "✓" : "✗"} ${killpoint} killed=${result.killed} (${ms}ms)${result.error ? ` ${result.error}` : ""}`
      );
    }

    const failed = results.filter((result) => !result.ok);
    console.log(`Total: ${results.length - failed.length}/${results.length} passed`);
    if (failed.length > 0) {
      console.log(JSON.stringify(failed, null, 2));
    }
    expect(failed).toEqual([]);
  }, 1_200_000);

  test("survives 50 seeded killpoint iterations", async () => {
    let passed = 0;
    const failures: Array<{ seed: number; killpoint: string; iteration: number; error?: string }> = [];

    for (let seed = 1; seed <= 50; seed++) {
      const pick = randomKillpoint(seed);
      const result = await survive(pick.killpoint, pick.iteration, false);
      if (result.ok) {
        passed++;
      } else {
        failures.push({ seed, killpoint: pick.killpoint, iteration: pick.iteration, error: result.error });
        console.log(`  ✗ seed ${seed} ${pick.killpoint}:${pick.iteration} ${result.error}`);
      }
      if (seed % 10 === 0) {
        console.log(`Completed ${seed}/50 seeds (${passed} passed, ${failures.length} failed)`);
      }
    }

    console.log(`Final: ${passed}/50 passed, ${failures.length}/50 failed`);
    if (failures.length > 0) console.log(JSON.stringify(failures, null, 2));
    expect(failures).toEqual([]);
  }, 4_500_000);
});
