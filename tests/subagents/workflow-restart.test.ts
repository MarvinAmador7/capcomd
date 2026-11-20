// ADR-022: an agent's lifecycle runs as a Rivet workflow inside its worker actor, with no `capcomd agent-drive` process.
// What only a durable workflow does by itself, checked without any client that could kick it (no await, no inspect:
// only the scope's record is read until the end):
//  - a daemon restart in the middle of a running agent, with the workflow in its watch: the engine wakes the worker at
//    its watch's deadline, its workflow runs the attempt again (stopping the run left in the VM) and finishes the agent;
//  - a usage-limit pause: the paused epoch's workflow sleeps until the reset and wakes the agent's next epoch.
// A restart inside a step: workflow-step.test.ts and workflow-long-step.test.ts.
import { expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { sleep } from "../helpers/engine";
import { workflowEngine } from "./workflow-engine";

let quotaLedger = "";
const w = workflowEngine("wf-restart", {
  worker: { provider: "claude", auth: "apikey", maxTurns: 20 },
  open: { provider: "claude", auth: "apikey", idleAfterMs: 2000 },
}, (dir) => ({ CAPCOMD_QUOTA_LEDGER: (quotaLedger = join(dir, "quotas.json")) }));

test("restart mid-watch: the workflow resumes by itself at its watch's deadline, runs the attempt again and finishes the agent", async () => {
  // The live e2e's case (2026-10-30): the engine killed well after the run started, with the workflow waiting in its
  // watch (CAPCOMD_AGENT_WORKFLOW_POLL_MS, 20 s in tests) and every alarm a step armed already fired. The watch's own
  // alarm must still wake it.
  const run = (await w.cj(["run", "new"])).j?.runId;
  expect(run).toMatch(/^run-/);
  const agent = (await w.cj(["spawn", run, "--profile", "worker", "--task", "[hold:90] make the failing test pass", "--key", "w"])).j?.agentId;
  expect(agent).toMatch(/^agt-/);
  const hold = join(w.vm, agent, "hold.log");
  for (let i = 0; i < 150 && !existsSync(hold); i++) { expect(w.drivers(run)).toEqual([]); await sleep(200); }
  expect(existsSync(hold)).toBe(true);
  expect((await w.scopeAgent(run, agent))?.driver).toMatch(/^wf-/);
  await sleep(12_000); // past the last step's wake alarm (10 s): it fired while the actor was up

  // The daemon dies (SIGKILL of serve and its engine) and comes back on the same data.
  await w.engine.stop();
  await sleep(4000);
  await w.engine.start(null);
  const back = Date.now();

  const a = await w.untilStatus(run, agent, "done", 150_000);
  // The worker wakes at its watch's deadline and runs the lost attempt again, so the agent is done within one watch
  // interval (plus the run itself) of the engine coming back.
  console.log(`  done ${Math.round((Date.now() - back) / 1000)}s after the engine came back`);
  expect(Date.now() - back).toBeLessThan(50_000);
  expect(a.result?.commit).toMatch(/^[0-9a-f]{40}$/);
  const events = (await w.cj(["events", run])).stdout;
  expect(events).toContain('"AGENT_DONE"');
  expect(events).not.toContain('"DRIVE_FAILED"');
  // The first run was stopped (not left working in the checkout), then the second finished.
  expect(readFileSync(hold, "utf8").trim().split("\n")).toEqual(["start", "stopped", "start", "finished"]);
  // An await afterwards answers from the record (and still starts no driver).
  const done = await w.cj(["await", run, agent, "--timeout-ms", "30000"]);
  expect(done.j?.agents?.[0]?.status).toBe("done");
  expect(w.drivers(run)).toEqual([]);
}, 300_000);

test("quota wake: the paused epoch's workflow sleeps to the reset and runs the next epoch, with nobody awaiting", async () => {
  rmSync(quotaLedger, { force: true });
  const run = (await w.cj(["run", "new"])).j?.runId;
  const id = (await w.cj(["spawn", run, "--profile", "open", "--task", "[quota:4] short limit", "--key", "q"])).j?.agentId;
  const paused = await w.untilStatus(run, id, "paused", 90_000);
  expect(paused.result).toMatchObject({ limit: "quota" });
  expect(paused.epoch).toBe(1);
  const a = await w.untilStatus(run, id, "done", 120_000);
  expect(a.epoch).toBe(2);
  const events = (await w.cj(["events", run])).stdout;
  expect(events).toContain('"by":"reset"');
  expect(events).not.toContain("DRIVE_FAILED");
}, 300_000);
