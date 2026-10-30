// ADR-022 (CAPCOMD_AGENT_WORKFLOW=1): an agent's lifecycle runs as a Rivet workflow inside its worker actor, with no
// `capcomd agent-drive` process. Two things only a durable workflow does by itself, checked without any client that
// could kick it (no await, no inspect: only the scope's record is read until the end):
//  - a daemon restart in the middle of a running agent (fake claude in a host-exec FakeProvider, whose "VM" outlives the
//    daemon): the engine wakes the worker, its workflow runs the attempt again (stopping the run left in the VM) and
//    finishes the agent;
//  - a usage-limit pause: the paused epoch's workflow sleeps until the reset and wakes the agent's next epoch.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Engine } from "../chaos/engine";
import { capcomd, sleep, testPort } from "../helpers/engine";
import { bareRepo } from "../merge/gitfixture";

let engine: Engine;
let env: Record<string, string>;
let vm = "";
let quotaLedger = "";
let faultFile = "";
const saved = { ...process.env };

beforeAll(async () => {
  const r = await bareRepo({ mode: "direct" });
  const dir = mkdtempSync(join(tmpdir(), "capcomd-workflow-"));
  const agentsFile = join(dir, "agents.json");
  writeFileSync(agentsFile, JSON.stringify({ schema: "capcomd.agents/v1", agents: {
    worker: { provider: "claude", auth: "apikey", maxTurns: 20 },
    open: { provider: "claude", auth: "apikey", idleAfterMs: 2000 },
  } }));
  vm = join(dir, "vm");
  env = {
    ...r.env,
    CAPCOMD_AGENT_WORKFLOW: "1",
    CAPCOMD_HOME: join(dir, "home"),
    CAPCOMD_AGENTS_FILE: agentsFile,
    CAPCOMD_SANDBOX: "fake-host",
    CAPCOMD_AGENT_CLAUDE_BIN: new URL("../agents/fake-claude.sh", import.meta.url).pathname,
    CAPCOMD_AGENT_WORKDIR: vm,
    CAPCOMD_AGENT_POLL_MS: "100",
    CAPCOMD_DRIVER_LEASE_MS: "3000",
    CAPCOMD_SKIP_PREFLIGHT: "1",
    CAPCOMD_TRACE_DIR: join(dir, "traces"),
    CAPCOMD_AUTH_LEDGER: join(dir, "auths.json"),
    CAPCOMD_ENV_LEDGER: join(dir, "envs.json"),
    CAPCOMD_QUOTA_LEDGER: (quotaLedger = join(dir, "quotas.json")),
    // An injected provider outage (none while the file is absent): keeps a step inside a provider call for as long.
    CAPCOMD_FAKE_OUTAGE_FILE: (faultFile = join(dir, "fault.json")),
    ANTHROPIC_API_KEY: "sk-ant-api03-WORKFLOW-abcdefghijklmnopqrstuvwxyz0123456789",
    CAPCOMD_ENV: "image",
  };
  Object.assign(process.env, env); // the engine (actors) inherits process.env
  const port = await testPort();
  engine = new Engine("workflow", { port, dataDir: join(dir, "engine") });
  await engine.start(null);
  env.CAPCOMD_ENDPOINT = `http://127.0.0.1:${port}`;
  process.env.CAPCOMD_ENDPOINT = env.CAPCOMD_ENDPOINT;
}, 120_000);

afterAll(async () => {
  await engine?.stop();
  for (const k of Object.keys(env ?? {})) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
});

const cj = async (args: string[]) => {
  const x = await capcomd([...args, "--json"], env);
  let j: any = null;
  try { j = JSON.parse(x.stdout.trim().split("\n").pop()!); } catch {}
  return { ...x, j };
};

/** This run's `capcomd agent-drive` processes (there must never be one with the workflow on). */
const drivers = (run: string) => Bun.spawnSync(["ps", "-A", "-o", "command="]).stdout.toString().split("\n").filter((l) => l.includes(` agent-drive ${run} `));
/** The agent as the scope records it: reading it never starts, kicks or wakes anything. */
async function scopeAgent(run: string, id: string) {
  const { client } = await import("../../src/core/relay");
  return client().scope.getOrCreate([run]).getAgent({ agentId: id }).catch(() => null);
}
/** Wait (reading the scope only) for a status, checking there's never a driver process. */
async function untilStatus(run: string, id: string, status: string, ms: number) {
  const end = Date.now() + ms;
  let a: any = null;
  while (Date.now() < end) {
    expect(drivers(run)).toEqual([]);
    a = await scopeAgent(run, id);
    if (a?.status === status) return a;
    await sleep(500);
  }
  throw new Error(`${id} never reached ${status} (last: ${a?.status})`);
}

test("restart mid-agent: the workflow resumes by itself, runs the attempt again and finishes the agent", async () => {
  const run = (await cj(["run", "new"])).j?.runId;
  expect(run).toMatch(/^run-/);
  const agent = (await cj(["spawn", run, "--profile", "worker", "--task", "[hold:90] make the failing test pass", "--key", "w"])).j?.agentId;
  expect(agent).toMatch(/^agt-/);
  const hold = join(vm, `${agent}-e1`, "hold.log");
  for (let i = 0; i < 150 && !existsSync(hold); i++) { expect(drivers(run)).toEqual([]); await sleep(200); }
  expect(existsSync(hold)).toBe(true);
  expect((await scopeAgent(run, agent))?.driver).toMatch(/^wf-/);

  // The daemon dies (SIGKILL of serve and its engine) and comes back on the same data.
  await engine.stop();
  await sleep(4000);
  await engine.start(null);
  const back = Date.now();

  const a = await untilStatus(run, agent, "done", 150_000);
  // With the default watch (60 s): the worker wakes at its watch's deadline and runs the lost attempt again, so the
  // agent is done within one watch interval (plus the run itself) of the engine coming back.
  console.log(`  done ${Math.round((Date.now() - back) / 1000)}s after the engine came back`);
  expect(Date.now() - back).toBeLessThan(100_000);
  expect(a.result?.commit).toMatch(/^[0-9a-f]{40}$/);
  const events = (await cj(["events", run])).stdout;
  expect(events).toContain('"AGENT_DONE"');
  expect(events).not.toContain('"DRIVE_FAILED"');
  // The first run was stopped (not left working in the checkout), then the second finished.
  expect(readFileSync(hold, "utf8").trim().split("\n")).toEqual(["start", "stopped", "start", "finished"]);
  // An await afterwards answers from the record (and still starts no driver).
  const done = await cj(["await", run, agent, "--timeout-ms", "30000"]);
  expect(done.j?.agents?.[0]?.status).toBe("done");
  expect(drivers(run)).toEqual([]);
}, 300_000);

test("restart mid-step: a worker whose engine host died inside a workflow step wakes by itself and finishes the agent", async () => {
  // The engine host dies inside the start-agent step (killpoint), with the agent claimed by its workflow (a 6 h lease, so
  // no await would kick it) and no wait of the workflow's own pending (a step arms no alarm). After the restart nothing
  // calls the worker: only the scope's record is read, so the worker must wake by itself.
  await engine.stop();
  await engine.start("workflow.start_agent.mid:1");
  const run = (await cj(["run", "new"])).j?.runId;
  expect(run).toMatch(/^run-/);
  await cj(["spawn", run, "--profile", "worker", "--task", "make the failing test pass", "--key", "mid"]);
  for (let i = 0; i < 300 && !engine.sawKill; i++) await sleep(100);
  expect(engine.sawKill).toBe(true);
  expect(await Bun.file(engine.logPath).text()).toContain("[KILLPOINT] Exiting at workflow.start_agent.mid");
  await engine.stop();
  await engine.start(null);
  const back = Date.now();
  const { client } = await import("../../src/core/relay");
  const agents: any[] = await client().scope.getOrCreate([run]).listAgents({});
  expect(agents.length).toBe(1);
  expect(agents[0].driver).toMatch(/^wf-/);
  const a = await untilStatus(run, agents[0].agentId, "done", 90_000);
  // Before: the worker slept until its next alarm (the machine's 1 h reap), so the agent stayed "running".
  console.log(`  done ${Math.round((Date.now() - back) / 1000)}s after the engine came back`);
  expect(Date.now() - back).toBeLessThan(60_000);
  expect(a.result?.commit).toMatch(/^[0-9a-f]{40}$/);
  expect((await cj(["events", run])).stdout).not.toContain('"DRIVE_FAILED"');
}, 300_000);

test("restart mid-watch, after its steps' wakes have fired: the worker still wakes by itself at its watch's deadline", async () => {
  // The live e2e's case (2026-10-30): the engine killed well after the run started, with the workflow waiting in its
  // watch (60 s default here) and every alarm a step armed already fired. The watch's own alarm must still wake it.
  const run = (await cj(["run", "new"])).j?.runId;
  const agent = (await cj(["spawn", run, "--profile", "worker", "--task", "[hold:90] make the failing test pass", "--key", "late"])).j?.agentId;
  expect(agent).toMatch(/^agt-/);
  const hold = join(vm, `${agent}-e1`, "hold.log");
  for (let i = 0; i < 150 && !existsSync(hold); i++) await sleep(200);
  expect(existsSync(hold)).toBe(true);
  await sleep(15_000); // past the last step's wake alarm (10 s): it fired while the actor was up
  await engine.stop();
  await sleep(4000);
  await engine.start(null);
  const back = Date.now();
  await untilStatus(run, agent, "done", 150_000);
  console.log(`  done ${Math.round((Date.now() - back) / 1000)}s after the engine came back`);
  expect(Date.now() - back).toBeLessThan(100_000);
  expect(readFileSync(hold, "utf8").trim().split("\n")).toEqual(["start", "stopped", "start", "finished"]);
}, 300_000);

test("restart inside a long step (provisioning that blocks): the worker wakes by itself and finishes the agent", async () => {
  // The live path: a machine call that takes a while (here the fake provider not answering `ensure`, retried with
  // backoff inside the ensure-machine step), the engine killed 15 s in (the step's first wakes have fired; it keeps one
  // armed), then the provider answers again.
  writeFileSync(faultFile, JSON.stringify({ until: Date.now() + 120_000, ops: ["ensure"] }));
  try {
    const run = (await cj(["run", "new"])).j?.runId;
    const agent = (await cj(["spawn", run, "--profile", "worker", "--task", "make the failing test pass", "--key", "slow"])).j?.agentId;
    expect(agent).toMatch(/^agt-/);
    await sleep(15_000);
    expect((await scopeAgent(run, agent))?.status).toBe("running");
    await engine.stop();
    rmSync(faultFile, { force: true });
    await sleep(4000);
    await engine.start(null);
    const back = Date.now();
    const a = await untilStatus(run, agent, "done", 120_000);
    console.log(`  done ${Math.round((Date.now() - back) / 1000)}s after the engine came back`);
    expect(Date.now() - back).toBeLessThan(60_000);
    expect(a.result?.commit).toMatch(/^[0-9a-f]{40}$/);
  } finally { rmSync(faultFile, { force: true }); }
}, 300_000);

test("quota wake: the paused epoch's workflow sleeps to the reset and runs the next epoch, with nobody awaiting", async () => {
  rmSync(quotaLedger, { force: true });
  const run = (await cj(["run", "new"])).j?.runId;
  const id = (await cj(["spawn", run, "--profile", "open", "--task", "[quota:4] short limit", "--key", "q"])).j?.agentId;
  const paused = await untilStatus(run, id, "paused", 90_000);
  expect(paused.result).toMatchObject({ limit: "quota" });
  expect(paused.epoch).toBe(1);
  const a = await untilStatus(run, id, "done", 120_000);
  expect(a.epoch).toBe(2);
  const events = (await cj(["events", run])).stdout;
  expect(events).toContain('"by":"reset"');
  expect(events).not.toContain("DRIVE_FAILED");
}, 300_000);
