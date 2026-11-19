// ADR-022: the engine host dying around a workflow step (the agent claimed by its workflow, a 6 h lease, so no await
// would kick it): the worker wakes by itself and finishes the agent, with no failed attempt. Only the scope's record is
// read until the end. A restart in the watch: workflow-restart.test.ts; inside a long step: workflow-long-step.test.ts.
import { expect, test } from "bun:test";
import { readFileSync } from "fs";
import { sleep } from "../helpers/engine";
import { workflowEngine } from "./workflow-engine";

const w = workflowEngine("wf-step", { worker: { provider: "claude", auth: "apikey", maxTurns: 20 } });

test("restart mid-step: a worker whose engine host died inside a workflow step wakes by itself and finishes the agent", async () => {
  // The engine host dies inside the start-agent step (killpoint), with the agent claimed by its workflow (a 6 h lease, so
  // no await would kick it) and no wait of the workflow's own pending (a step arms no alarm). After the restart nothing
  // calls the worker: only the scope's record is read, so the worker must wake by itself.
  await w.engine.stop();
  await w.engine.start("workflow.start_agent.mid:1");
  const run = (await w.cj(["run", "new"])).j?.runId;
  expect(run).toMatch(/^run-/);
  await w.cj(["spawn", run, "--profile", "worker", "--task", "make the failing test pass", "--key", "mid"]);
  for (let i = 0; i < 300 && !w.engine.sawKill; i++) await sleep(100);
  const killed = Date.now();
  expect(w.engine.sawKill).toBe(true);
  expect(await Bun.file(w.engine.logPath).text()).toContain("[KILLPOINT] Exiting at workflow.start_agent.mid");
  await w.engine.stop();
  await w.engine.start(null);
  const back = Date.now();
  const { client } = await import("../../src/core/relay");
  const agents: any[] = await client().scope.getOrCreate([run]).listAgents({});
  expect(agents.length).toBe(1);
  expect(agents[0].driver).toMatch(/^wf-/);
  const a = await w.untilStatus(run, agents[0].agentId, "done", 90_000);
  // Before: the worker slept until its next alarm (the machine's 1 h reap), so the agent stayed "running".
  console.log(`  done ${Math.round((Date.now() - back) / 1000)}s after the engine came back`);
  expect(Date.now() - back).toBeLessThan(60_000);
  expect(a.result?.commit).toMatch(/^[0-9a-f]{40}$/);
  const events = (await w.cj(["events", run])).stdout;
  // On a failure, which attempt failed, when (against the kill and the restart) and why.
  if (events.includes('"DRIVE_FAILED"')) console.error(`killed ${new Date(killed).toISOString()}, back ${new Date(back).toISOString()}:`, JSON.stringify((JSON.parse(events.trim().split("\n").pop()!).events ?? []).filter((e: any) => /DRIVE|ATTEMPT|AGENT_(STARTED|DONE|FAILED)/.test(e.type))));
  expect(events).not.toContain('"DRIVE_FAILED"');
}, 300_000);

test("an attempt that runs into the engine still starting (internal_error) runs again: no failed attempt, no DRIVE_FAILED", async () => {
  // Right after a restart the engine can answer internal_error until the actors it routes are ready (a "restart
  // mid-step" under load, 2026-11-05: one DRIVE_FAILED). Injected here: the first attempt this host starts fails so.
  const logFrom = readFileSync(w.engine.logPath, "utf8").length;
  await w.engine.stop();
  process.env.CAPCOMD_TEST_ATTEMPT_ERRORS = "1";
  try { await w.engine.start(null); } finally { delete process.env.CAPCOMD_TEST_ATTEMPT_ERRORS; }
  const run = (await w.cj(["run", "new"])).j?.runId;
  const agent = (await w.cj(["spawn", run, "--profile", "worker", "--task", "make the failing test pass", "--key", "starting"])).j?.agentId;
  expect(agent).toMatch(/^agt-/);
  const a = await w.untilStatus(run, agent, "done", 90_000);
  expect(a.result?.commit).toMatch(/^[0-9a-f]{40}$/);
  expect(readFileSync(w.engine.logPath, "utf8").slice(logFrom)).toContain(`${agent} attempt 1 ran into the engine still starting`);
  expect((await w.cj(["events", run])).stdout).not.toContain('"DRIVE_FAILED"');
}, 300_000);
