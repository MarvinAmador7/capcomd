import { describe, expect, test } from "bun:test";
import { auditRun, eventGapViolations } from "./invariants";
import { randomKillpoint } from "./harness";
import { survive } from "./survive";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { testPort } from "../helpers/engine";

// Measured on gate 5 run 1 (65baa08): 45 normal seeds, mean 35.5s, max 53.5s per seed.
// Budget = 50 seeds x 53.5s max x 2 headroom ≈ 5350s → 5400s. (Three seeds at
// 908s, 3461s and 5498s were box suspensions; no timeout covers those.)
const SEED_SUITE_TIMEOUT_MS = 5_400_000;

import { KILLPOINTS } from "./cases";

/** A private engine for one case: its own port block and data dir (never :6420 or the user's engine data). */
const privateOpts = async (tag: string) => ({ port: await testPort(), dataDir: mkdtempSync(join(tmpdir(), `capcomd-chaos-sub-${tag}-`)) });


describe("Chaos Tests - Subprocess Killpoints", () => {
  test("event gap helper rejects holes and duplicate seqs", () => {
    expect(eventGapViolations([{ entityId: "a", seq: 1 }, { entityId: "a", seq: 2 }])).toEqual([]);
    expect(eventGapViolations([{ entityId: "a", seq: 1 }, { entityId: "a", seq: 3 }])[0]).toContain("event gap");
    expect(eventGapViolations([{ entityId: "a", seq: 1 }, { entityId: "a", seq: 1 }])[0]).toContain("duplicate");
  });

  test("survives every named killpoint", async () => {
    const results: Array<{ killpoint: string; ok: boolean; ms: number; error?: string; killed: boolean }> = [];

    for (const killpoint of KILLPOINTS) {
      const started = Date.now();
      console.log(`Testing killpoint: ${killpoint}`);
      const result = await survive(killpoint, 1, true, await privateOpts(killpoint));
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
      const result = await survive(pick.killpoint, pick.iteration, false, await privateOpts(`seed${seed}`));
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
  }, SEED_SUITE_TIMEOUT_MS);
});
