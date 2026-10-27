// A run's own sandbox (`capcomd run --sandbox`, POST /v1/runs `sandbox`): recorded with the run, and the engine makes
// that run's agent VMs on it while other runs keep the daemon's CAPCOMD_SANDBOX. Here the daemon runs the in-memory
// fake and one run asks for fake-host (the host-exec fake), so no Docker or boxd is needed.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { RUN_SANDBOX_KV, runSandbox } from "../../src/providers/run-sandbox";
import { newRun, waitAll, world, type World } from "./harness";

let w: World;
beforeAll(async () => { w = await world("runsandbox"); }, 120_000);
afterAll(async () => { await w?.stop(); });

test("an agent of a run started on another sandbox gets its VM there; a run without one uses the daemon's", async () => {
  const { runNew } = await import("../../src/primitives/ops");
  const own = (await runNew({ budget: {}, label: "own sandbox", sandbox: "fake-host", key: `rs-${Date.now()}` })).runId as string;
  const plain = await newRun(w);
  expect(await runSandbox(own)).toBe("fake-host");
  expect(await runSandbox(plain)).toBeNull();
  // Reserved for the orchestrator: an agent can't change where its run's VMs are made.
  expect((await w.cj(["kv", "get", own, RUN_SANDBOX_KV])).j.value).toEqual({ name: "fake-host" });

  const done = w.script("rs-done", `capcomd result --summary ok >/dev/null`);
  const spawn = async (run: string) => (await w.cj(["spawn", run, "--profile", "worker", "--task", "t", "--key", "w", "--contract", JSON.stringify({ script: done })])).j.agentId as string;
  const [a, b] = [await spawn(own), await spawn(plain)];
  expect((await waitAll(w, own, [a])).agents[0].status).toBe("done");
  expect((await waitAll(w, plain, [b])).agents[0].status).toBe("done");

  const { client } = await import("../../src/core/relay");
  const workerOf = async (run: string, id: string): Promise<any> => client().worker.getOrCreate([run, id]).getWorker({ workerId: id });
  const wa = await workerOf(own, a), wb = await workerOf(plain, b);
  expect(wa?.context?.vmId).toBeTruthy();
  expect(wa?.context?.sandbox).toBe("fake-host");
  expect(wb?.context?.vmId).toBeTruthy();
  expect(wb?.context?.sandbox).toBeUndefined();
}, 120_000);
