import { describe, expect, test, beforeAll } from "bun:test";
import { Engine, runClient, sleep } from "./engine";
import { auditRun, eventGapViolations } from "./invariants";
import { randomKillpoint } from "./harness";

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

async function releasePort(): Promise<void> {
  const proc = Bun.spawn(["lsof", "-nP", "-iTCP:6420", "-sTCP:LISTEN", "-t"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  for (const part of text.split(/\s+/)) {
    const pid = Number(part);
    if (pid > 0) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }
  await sleep(200);
}

async function wipeEngineData(): Promise<void> {
  await releasePort();
  const { rm } = await import("fs/promises");
  await rm("/home/ubuntu/.rivetkit/var/engine", { recursive: true, force: true });
}

async function survive(killpoint: string, count: number, requireKill: boolean): Promise<{
  ok: boolean;
  error?: string;
  killed: boolean;
}> {
  const runId = `chaos-${killpoint.replace(/\./g, "-")}-n${count}-${Date.now()}`;
  const engine = new Engine(`${killpoint}-${count}-${runId}`);
  const started = Date.now();
  const mark = (label: string) => {
    console.log(`    ${label} +${Date.now() - started}ms`);
  };
  await wipeEngineData();
  mark("wiped");

  try {
    await engine.start(`${killpoint}:${count}`);
    mark("engine-up");
    const first = await runClient(runId);
    mark(`first-client exit=${first.code} killed=${engine.sawKill}`);
    const killed =
      engine.sawKill ||
      first.output.includes("[KILLPOINT]") ||
      (await Bun.file(engine.logPath).text().catch(() => "")).includes("[KILLPOINT]");

    if (first.code === 0 && !killed) {
      const report = await auditRun(runId);
      if (requireKill) {
        return { ok: false, killed: false, error: "killpoint never fired" };
      }
      if (!report.ok) {
        return { ok: false, killed: false, error: report.violations.join("; ") };
      }
      return { ok: true, killed: false };
    }

    await engine.stop();
    mark("stopped-after-kill");
    await engine.start(null);
    mark("engine-restarted");
    const second = await runClient(runId);
    if (second.code !== 0 || !second.output.includes("✓ Run completed successfully")) {
      return {
        ok: false,
        killed,
        error: `resume failed (${second.code}): ${second.output.slice(-600)}`,
      };
    }
    if (requireKill && !killed && !engine.sawKill) {
      return { ok: false, killed: false, error: "killpoint never fired" };
    }

    const report = await auditRun(runId);
    if (!report.ok) {
      return {
        ok: false,
        killed: true,
        error: `invariants: ${report.violations.join("; ")} checks=${JSON.stringify(report.checks)}`,
      };
    }
    const missing = Object.entries(report.checks)
      .filter(([, passed]) => !passed)
      .map(([name]) => name);
    if (missing.length > 0) {
      return { ok: false, killed: true, error: `unchecked invariants: ${missing.join(",")}` };
    }
    return { ok: true, killed: true };
  } catch (error) {
    return {
      ok: false,
      killed: engine.sawKill,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    try {
      await engine.stop();
    } catch (error) {
      console.log(`    cleanup error: ${error instanceof Error ? error.message : error}`);
    }
  }
}

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
