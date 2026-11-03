// A run cancelled while its agent works reads "cancelled" everywhere: the cancel's answer, `capcomd status` (what the
// TUI shows), the harness API's run list, capcomd_runs and the agent's own status. And capcomd_runs answers quickly.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { world, type World } from "./harness";

let w: World;
beforeAll(async () => { w = await world("runcancel", { CAPCOMD_RUNS_INDEX: join(mkdtempSync(join(tmpdir(), "capcomd-rc-")), "runs.jsonl") }); }, 120_000);
afterAll(async () => { await w?.stop(); }, 60_000);

test("a run cancelled mid-work is cancelled, not failed or idle; its agent is cancelled", async () => {
  const runId = (await w.cj(["run", "new", "--label", "cancel me", "--key", `rc-${Date.now()}`])).j.runId as string;
  const slow = w.script("rc-slow", "sleep 60; capcomd result --summary late >/dev/null");
  const agentId = (await w.cj(["spawn", runId, "--profile", "worker", "--task", "long job", "--key", "slow", "--contract", JSON.stringify({ script: slow })])).j.agentId as string;
  const { client } = await import("../../src/core/relay");
  for (let i = 0; i < 100; i++) {
    const agents: any[] = await client().scope.getOrCreate([runId]).listAgents({});
    if (agents.some((a) => a.agentId === agentId && a.status === "running")) break;
    await Bun.sleep(100);
  }
  const c = await w.cj(["cancel", runId, "--reason", "changed my mind"]);
  expect(c.code).toBe(0);
  expect(c.j).toMatchObject({ cancelled: [agentId], runEnded: true });

  const st = (await w.cj(["status", runId])).j.run;
  expect(st.state).toBe("cancelled");
  expect(st.scope).toMatchObject({ state: "cancelled", byStatus: { cancelled: 1 } });

  const { rivetSource } = await import("../../src/api/rivet-source");
  const listed = (await rivetSource().runs()).find((r: any) => r.id === runId);
  expect(listed?.state).toBe("cancelled");

  const D = await import("../../src/mcp/driver");
  const t0 = Date.now();
  const mine = (await D.runs({ limit: 8 })).runs.find((r: any) => r.runId === runId);
  expect(Date.now() - t0).toBeLessThan(10_000);
  expect(mine).toMatchObject({ state: "cancelled", agents: { cancelled: 1 }, pendingApprovals: [] });
  const tree: any = await D.tree({ runId });
  expect(JSON.stringify(tree)).toContain('"status":"cancelled"');
}, 120_000);
