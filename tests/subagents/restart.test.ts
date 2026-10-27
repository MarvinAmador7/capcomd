// A daemon restart in the middle of a running agent (a real CLI agent, here the fake claude in a host-exec FakeProvider,
// whose "VM" outlives the daemon like a boxd VM does). Before, the driver counted the attempts that failed while the
// daemon was away (connection reset/refused, then "An internal error occurred" while the new engine started its actors)
// and failed the agent with that error after ~6s. Now the agent finishes, its driver runs the attempt again once the
// engine answers, and the run it left in its VM is stopped first (never two agent CLIs in one checkout).
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
  const dir = mkdtempSync(join(tmpdir(), "capcomd-restart-"));
  const agentsFile = join(dir, "agents.json");
  writeFileSync(agentsFile, JSON.stringify({ schema: "capcomd.agents/v1", agents: {
    worker: { provider: "claude", auth: "apikey", maxTurns: 20 },
  } }));
  vm = join(dir, "vm");
  env = {
    ...r.env,
    CAPCOMD_HOME: join(dir, "home"),
    CAPCOMD_HARNESS_SOCKET: join(dir, "home", "harness.sock"),
    CAPCOMD_AGENTS_FILE: agentsFile,
    CAPCOMD_SANDBOX: "fake-host",
    CAPCOMD_AGENT_CLAUDE_BIN: new URL("../agents/fake-claude.sh", import.meta.url).pathname,
    CAPCOMD_AGENT_WORKDIR: vm,
    CAPCOMD_AGENT_POLL_MS: "100",
    CAPCOMD_SKIP_PREFLIGHT: "1",
    CAPCOMD_TRACE_DIR: join(dir, "traces"),
    CAPCOMD_AUTH_LEDGER: join(dir, "auths.json"),
    CAPCOMD_ENV_LEDGER: join(dir, "envs.json"),
    ANTHROPIC_API_KEY: "sk-ant-api03-RESTART-abcdefghijklmnopqrstuvwxyz0123456789",
    CAPCOMD_ENV: "image",
  };
  Object.assign(process.env, env);
  const port = await testPort();
  engine = new Engine("restart", { port, dataDir: join(dir, "engine") });
  await engine.start(null);
  env.CAPCOMD_ENDPOINT = `http://127.0.0.1:${port}`;
  process.env.CAPCOMD_ENDPOINT = env.CAPCOMD_ENDPOINT;
}, 120_000);

// The detached driver processes (`capcomd agent-drive <run> <agt>`) of a run, by pid.
const driversOf = (run: string) => (Bun.spawnSync(["ps", "-A", "-o", "pid=,command="]).stdout.toString().split("\n")
  .filter((l) => l.includes(`agent-drive ${run} `)).map((l) => Number(l.trim().split(/\s+/)[0])).filter((p) => p > 1));
let runId = "";

afterAll(async () => {
  for (const pid of runId ? driversOf(runId) : []) try { process.kill(pid, "SIGKILL"); } catch {}
  await engine?.stop();
  for (const k of Object.keys(env ?? {})) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
});

const cj = async (args: string[]) => {
  const x = await capcomd([...args, "--json"], env);
  let j: any = null;
  try { j = JSON.parse(x.stdout.trim().split("\n").pop()!); } catch {}
  return { ...x, j };
};

test("an agent running when the daemon restarts finishes: the attempt runs again, the run left in its VM is stopped", async () => {
  const run = (runId = (await cj(["run", "new"])).j?.runId);
  expect(run).toMatch(/^run-/);
  const agent = (await cj(["spawn", run, "--profile", "worker", "--task", "[hold:90] make the failing test pass", "--key", "w"])).j?.agentId;
  expect(agent).toMatch(/^agt-/);
  // Its CLI is running in its "VM" (the work dir of its first epoch).
  const hold = join(vm, `${agent}-e1`, "hold.log");
  for (let i = 0; i < 150 && !existsSync(hold); i++) await sleep(200);
  expect(existsSync(hold)).toBe(true);

  // The daemon dies (a crash: SIGKILL of serve and its engine) and comes back on the same data, after longer than the
  // driver's retries used to last.
  await engine.stop();
  await sleep(8000);
  await engine.start(null);

  const done = await cj(["await", run, agent, "--timeout-ms", "120000"]);
  const a = done.j?.agents?.[0];
  if (a?.status !== "done") console.log(done.stdout, done.stderr);
  expect(a?.status).toBe("done");
  expect(a?.result?.commit).toMatch(/^[0-9a-f]{40}$/);
  // The attempts the restart broke aren't failures of the agent.
  const ins = await cj(["inspect", run, agent]);
  const types = (ins.j?.events ?? []).map((e: any) => e.type);
  expect(types).toContain("AGENT_DONE");
  expect(types).not.toContain("DRIVE_FAILED");
  // The first run was stopped (not left working in the checkout), then the second finished.
  expect(readFileSync(hold, "utf8").trim().split("\n")).toEqual(["start", "stopped", "start", "finished"]);
  // Every driver exits once the agent is done, including one an await started while the first waited for the engine.
  for (let i = 0; i < 60 && driversOf(run).length; i++) await sleep(500);
  expect(driversOf(run)).toEqual([]);
}, 240_000);
