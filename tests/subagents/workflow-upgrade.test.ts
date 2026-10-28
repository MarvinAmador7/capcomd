// ADR-022 "Changing the workflow": an agent in flight when capcomd is upgraded to a workflow of another shape resumes
// and finishes. The drill: agent A runs (fake claude in a host-exec FakeProvider, its "VM" outlives the daemon) under
// shape 1; the engine host dies and comes back with the next shape (CAPCOMD_WORKFLOW_DRILL=1: a new top-level step,
// and a new step in every drive-loop iteration, both behind getVersion gates); A replays its shape-1 history, never
// runs the new top-level step, and finishes; agent B, started after the upgrade, runs shape 2. No history divergence.
// The control: the same change made without the gates (CAPCOMD_WORKFLOW_DRILL=ungated) makes an agent in flight run
// code of a shape it never started with.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Engine } from "../chaos/engine";
import { capcomd, sleep, testPort } from "../helpers/engine";
import { bareRepo } from "../merge/gitfixture";

let engine: Engine;
let env: Record<string, string>;
let vm = "";
const saved = { ...process.env };

beforeAll(async () => {
  const r = await bareRepo({ mode: "direct" });
  const dir = mkdtempSync(join(tmpdir(), "capcomd-wf-upgrade-"));
  const agentsFile = join(dir, "agents.json");
  writeFileSync(agentsFile, JSON.stringify({ schema: "capcomd.agents/v1", agents: { worker: { provider: "claude", auth: "apikey", maxTurns: 20 } } }));
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
    ANTHROPIC_API_KEY: "sk-ant-api03-UPGRADE-abcdefghijklmnopqrstuvwxyz0123456789",
    CAPCOMD_ENV: "image",
  };
  Object.assign(process.env, env); // the engine (actors) inherits process.env
  delete process.env.CAPCOMD_WORKFLOW_DRILL;
  const port = await testPort();
  engine = new Engine("wf-upgrade", { port, dataDir: join(dir, "engine") });
  await engine.start(null);
  env.CAPCOMD_ENDPOINT = `http://127.0.0.1:${port}`;
  process.env.CAPCOMD_ENDPOINT = env.CAPCOMD_ENDPOINT;
}, 120_000);

afterAll(async () => {
  await engine?.stop();
  delete process.env.CAPCOMD_WORKFLOW_DRILL;
  for (const k of Object.keys(env ?? {})) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
});

const cj = async (args: string[]) => {
  const x = await capcomd([...args, "--json"], env);
  let j: any = null;
  try { j = JSON.parse(x.stdout.trim().split("\n").pop()!); } catch {}
  return { ...x, j };
};
const scope = async (run: string) => (await import("../../src/core/relay")).client().scope.getOrCreate([run]);
async function untilStatus(run: string, id: string, status: string, ms: number) {
  const end = Date.now() + ms;
  let a: any = null;
  while (Date.now() < end) { a = await (await scope(run)).getAgent({ agentId: id }).catch(() => null); if (a?.status === status) return a; await sleep(500); }
  throw new Error(`${id} never reached ${status} (last: ${a?.status})`);
}
const shape2Logged = async (run: string, id: string) =>
  ((await (await scope(run)).getLogs({ agentId: id, tail: 500 })) as any[]).some((l) => l.stream === "workflow" && l.line.includes("workflow shape 2"));

test("upgrade drill: an agent in flight on shape 1 finishes after the engine comes back with shape 2; a new one runs shape 2", async () => {
  const logFrom = existsSync(engine.logPath) ? readFileSync(engine.logPath, "utf8").length : 0; // the log file outlives runs
  const run = (await cj(["run", "new"])).j?.runId;
  expect(run).toMatch(/^run-/);
  const a = (await cj(["spawn", run, "--profile", "worker", "--task", "[hold:90] make the failing test pass", "--key", "a"])).j?.agentId;
  const hold = join(vm, `${a}-e1`, "hold.log");
  for (let i = 0; i < 150 && !existsSync(hold); i++) await sleep(200);
  expect(existsSync(hold)).toBe(true); // A is mid-workflow (its run is in flight, the workflow in its watch phase)

  // Upgrade: the engine host dies and comes back running the next workflow shape.
  await engine.stop();
  process.env.CAPCOMD_WORKFLOW_DRILL = "1";
  await engine.start(null);

  const b = (await cj(["spawn", run, "--profile", "worker", "--task", "write the docs", "--key", "b"])).j?.agentId;
  const doneA = await untilStatus(run, a, "done", 150_000);
  const doneB = await untilStatus(run, b, "done", 120_000);
  expect(doneA.result?.commit).toMatch(/^[0-9a-f]{40}$/);
  expect(doneB.result?.commit).toMatch(/^[0-9a-f]{40}$/);
  // A kept its version: the new top-level step never ran for it; B, started after the upgrade, ran it.
  expect(await shape2Logged(run, a)).toBe(false);
  expect(await shape2Logged(run, b)).toBe(true);
  // A's run was in flight at the restart: it ran once more (stopped first), then finished, without a recorded failure.
  expect(readFileSync(hold, "utf8").trim().split("\n")).toEqual(["start", "stopped", "start", "finished"]);
  const events = (await cj(["events", run])).stdout;
  expect(events).not.toContain('"DRIVE_FAILED"');
  // No workflow diverged from its history.
  expect(readFileSync(engine.logPath, "utf8").slice(logFrom)).not.toMatch(/HistoryDivergedError|was not visited/);
}, 360_000);

test("control: the same change without the gates runs the new shape inside an agent that started under the old one", async () => {
  await engine.stop();
  delete process.env.CAPCOMD_WORKFLOW_DRILL;
  await engine.start(null);
  const run = (await cj(["run", "new"])).j?.runId;
  const c = (await cj(["spawn", run, "--profile", "worker", "--task", "[hold:90] control", "--key", "c"])).j?.agentId;
  const hold = join(vm, `${c}-e1`, "hold.log");
  for (let i = 0; i < 150 && !existsSync(hold); i++) await sleep(200);
  expect(existsSync(hold)).toBe(true);
  await engine.stop();
  process.env.CAPCOMD_WORKFLOW_DRILL = "ungated";
  const logBefore = readFileSync(engine.logPath, "utf8").length;
  await engine.start(null);
  let ranNew = false;
  for (let i = 0; i < 120 && !ranNew; i++) { ranNew = await shape2Logged(run, c).catch(() => false); if (!ranNew) await sleep(500); }
  expect(ranNew).toBe(true);
  const diverged = /HistoryDivergedError|was not visited/.test(readFileSync(engine.logPath, "utf8").slice(logBefore));
  console.log(`  ungated upgrade: the in-flight agent ran shape-2 code${diverged ? " and its workflow diverged from its history" : ""}`);
  await cj(["cancel", run]);
}, 360_000);
