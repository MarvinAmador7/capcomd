// ADR-022: the engine host dying inside a long workflow step (provisioning that blocks): the step keeps a wake alarm
// armed while it runs (STEP_WAKE_MS), so the worker wakes by itself after the restart and finishes the agent. Only the
// scope's record is read. Other restarts: workflow-restart.test.ts, workflow-step.test.ts.
import { expect, test } from "bun:test";
import { rmSync, writeFileSync } from "fs";
import { join } from "path";
import { sleep } from "../helpers/engine";
import { workflowEngine } from "./workflow-engine";

let faultFile = "";
const w = workflowEngine("wf-long-step", { worker: { provider: "claude", auth: "apikey", maxTurns: 20 } },
  // An injected provider outage (none while the file is absent): keeps a step inside a provider call for as long.
  (dir) => ({ CAPCOMD_FAKE_OUTAGE_FILE: (faultFile = join(dir, "fault.json")) }));

test("restart inside a long step (provisioning that blocks): the worker wakes by itself and finishes the agent", async () => {
  // The live path: a machine call that takes a while (here the fake provider not answering `ensure`, retried with
  // backoff inside the ensure-machine step), the engine killed 12 s in (the step's first wake has fired; it keeps one
  // armed), then the provider answers again.
  writeFileSync(faultFile, JSON.stringify({ until: Date.now() + 120_000, ops: ["ensure"] }));
  try {
    const run = (await w.cj(["run", "new"])).j?.runId;
    const agent = (await w.cj(["spawn", run, "--profile", "worker", "--task", "make the failing test pass", "--key", "slow"])).j?.agentId;
    expect(agent).toMatch(/^agt-/);
    await sleep(12_000);
    expect((await w.scopeAgent(run, agent))?.status).toBe("running");
    await w.engine.stop();
    rmSync(faultFile, { force: true });
    await sleep(4000);
    await w.engine.start(null);
    const back = Date.now();
    const a = await w.untilStatus(run, agent, "done", 120_000);
    console.log(`  done ${Math.round((Date.now() - back) / 1000)}s after the engine came back`);
    expect(Date.now() - back).toBeLessThan(60_000);
    expect(a.result?.commit).toMatch(/^[0-9a-f]{40}$/);
  } finally { rmSync(faultFile, { force: true }); }
}, 300_000);
