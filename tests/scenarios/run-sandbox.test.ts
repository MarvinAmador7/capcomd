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
  expect((await w.cj(["kv", "get", own, RUN_SANDBOX_KV])).j.value).toEqual({ name: "fake-host", settings: { idleLifetime: 3600 } });

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

// A run that names no sandbox runs on its project's (.capcomd/config.json env CAPCOMD_SANDBOX), then the user config's,
// read when the run is made: never the engine's own CAPCOMD_SANDBOX. Here the engine runs the in-memory fake (as a
// daemon started with the user config's boxd would run boxd), the user config says fake too, and the project says
// fake-host: the project's run and its agent's VM are on fake-host, a run made outside the project on the user's.
test("a run made in a project gets the project's sandbox, not the engine's; outside it, the user config's", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("fs");
  const { tmpdir } = await import("os");
  const { join } = await import("path");
  const { CLI } = await import("../helpers/engine");
  const home = mkdtempSync(join(tmpdir(), "capcomd-rs-home-"));
  mkdirSync(join(home, ".capcomd"), { recursive: true });
  writeFileSync(join(home, ".capcomd", "config.json"), JSON.stringify({ env: { CAPCOMD_SANDBOX: "fake" } }));
  const project = mkdtempSync(join(tmpdir(), "capcomd-rs-project-"));
  mkdirSync(join(project, ".capcomd"));
  writeFileSync(join(project, ".capcomd", "config.json"), JSON.stringify({ env: { CAPCOMD_SANDBOX: "fake-host" } }));
  const away = mkdtempSync(join(tmpdir(), "capcomd-rs-away-"));
  // As a person's shell: no CAPCOMD_SANDBOX of its own, the settings files applied.
  const env: Record<string, string> = { ...(process.env as Record<string, string>), ...w.env, HOME: home, CAPCOMD_HOME: join(home, ".capcomd"), CAPCOMD_NO_CONFIG: "", CAPCOMD_RUNS_INDEX: join(home, "runs.jsonl") };
  delete env.CAPCOMD_SANDBOX; delete env.RELAY_SANDBOX;
  const cli = async (args: string[], cwd: string) => {
    const p = Bun.spawn(["bun", CLI, ...args, "--json"], { cwd, env, stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    try { return JSON.parse(out.trim().split("\n").pop()!); } catch { throw new Error(`capcomd ${args.join(" ")}: ${out} ${err}`); }
  };
  const inProject = await cli(["run", "new", "--label", "project sandbox", "--key", `rsp-${Date.now()}`], project);
  expect(inProject.sandbox).toEqual({ name: "fake-host", source: "project" });
  expect(await runSandbox(inProject.runId)).toBe("fake-host");
  const outside = await cli(["run", "new", "--label", "user sandbox", "--key", `rsu-${Date.now()}`], away);
  expect(outside.sandbox).toEqual({ name: "fake", source: "user" });
  // --sandbox wins over both.
  const asked = await cli(["run", "new", "--label", "asked", "--sandbox", "fake", "--key", `rsa-${Date.now()}`], project);
  expect(asked.sandbox).toEqual({ name: "fake", source: "run" });
  const bad = await cli(["run", "new", "--sandbox", "kubernetes", "--key", `rsb-${Date.now()}`], project);
  expect(bad).toMatchObject({ ok: false, error: { code: "usage" } });

  const done = w.script("rs-proj-done", `capcomd result --summary ok >/dev/null`);
  const a = (await w.cj(["spawn", inProject.runId, "--profile", "worker", "--task", "t", "--key", "w", "--contract", JSON.stringify({ script: done })])).j.agentId as string;
  expect((await waitAll(w, inProject.runId, [a])).agents[0].status).toBe("done");
  const { client } = await import("../../src/core/relay");
  const wk: any = await client().worker.getOrCreate([inProject.runId, a]).getWorker({ workerId: a });
  expect(wk?.context?.vmId).toBeTruthy();
  expect(wk?.context?.sandbox).toBe("fake-host");
}, 120_000);
