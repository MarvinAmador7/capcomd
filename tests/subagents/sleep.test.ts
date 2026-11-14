// The machine sleeps with an agent running (a laptop's lid closes). rivet-engine 3.x renews a 30 s topology lease every
// 3 s; asleep, it can't, so on wake it finds the lease expired, fences itself and exits ("topology fenced this worker:
// lease expired …", then "revoked singleton scope did not join within the stop timeout; exiting process"). Before,
// `capcomd serve` then exited too ("engine on :N stopped answering"), dropping the harness API, and launchd restarted
// it: on a Mac that sleeps, every wake. Now serve starts the engine again in place, on the same data, and the agent
// finishes. The sleep is simulated by stopping the daemon (serve, its engine) and the run's drivers with SIGSTOP for
// longer than the lease, then SIGCONT: the processes' clocks run on meanwhile, as the engine's do across a sleep.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Engine, serveRunnerPids, tailFile } from "../helpers/test-engine";
import { capcomd, sleep, testPort } from "../helpers/engine";
import { bareRepo } from "../merge/gitfixture";

let engine: Engine;
let env: Record<string, string>;
let vm = "";
let dataDir = "";
let port = 0;
const saved = { ...process.env };
const stopped = new Set<number>();

beforeAll(async () => {
  const r = await bareRepo({ mode: "direct" });
  const dir = mkdtempSync(join(tmpdir(), "capcomd-sleep-"));
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
    ANTHROPIC_API_KEY: "sk-ant-api03-SLEEP-abcdefghijklmnopqrstuvwxyz0123456789",
    CAPCOMD_ENV: "image",
  };
  Object.assign(process.env, env);
  port = await testPort();
  dataDir = join(dir, "engine");
  engine = new Engine("sleep", { port, dataDir });
  await engine.start(null);
  env.CAPCOMD_ENDPOINT = `http://127.0.0.1:${port}`;
  process.env.CAPCOMD_ENDPOINT = env.CAPCOMD_ENDPOINT;
}, 120_000);

const ps = () => Bun.spawnSync(["ps", "-A", "-o", "pid=,ppid=,command="]).stdout.toString().split("\n").flatMap((l) => {
  const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l);
  return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), command: m[3]! }] : [];
});
const treeOf = (root: number) => {
  const table = ps(), out = [root];
  for (let i = 0; i < out.length; i++) for (const p of table) if (p.ppid === out[i] && !out.includes(p.pid)) out.push(p.pid);
  return out;
};
// The detached driver processes (`capcomd agent-drive <run> <agt>`) of a run, by pid.
const driversOf = (run: string) => ps().filter((p) => p.command.includes(`agent-drive ${run} `)).map((p) => p.pid);
const enginePid = () => { try { return Number(readFileSync(join(dataDir, "engine.pid"), "utf8").trim()) || 0; } catch { return 0; } };
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
let runId = "";

afterAll(async () => {
  for (const pid of stopped) try { process.kill(pid, "SIGCONT"); } catch {}
  for (const pid of runId ? driversOf(runId) : []) try { process.kill(pid, "SIGKILL"); } catch {}
  // And the agent's "VM" (detached, as a real one), should the test have failed before the agent finished.
  for (const p of vm ? ps().filter((p) => p.command.includes(`${vm}/`)) : []) try { process.kill(p.pid, "SIGKILL"); } catch {}
  await engine?.stop();
  for (const k of Object.keys(env ?? {})) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
});

const cj = async (args: string[]) => {
  const x = await capcomd([...args, "--json"], env);
  let j: any = null;
  try { j = JSON.parse(x.stdout.trim().split("\n").pop()!); } catch {}
  return { ...x, j };
};

test("the machine sleeps longer than the engine's lease: serve restarts its engine in place and the agent finishes", async () => {
  const run = (runId = (await cj(["run", "new"])).j?.runId);
  expect(run).toMatch(/^run-/);
  const agent = (await cj(["spawn", run, "--profile", "worker", "--task", "[hold:45] make the failing test pass", "--key", "w"])).j?.agentId;
  expect(agent).toMatch(/^agt-/);
  const hold = join(vm, `${agent}-e1`, "hold.log");
  for (let i = 0; i < 150 && !existsSync(hold); i++) await sleep(200);
  expect(existsSync(hold)).toBe(true);

  const [serve] = await serveRunnerPids(port);
  expect(serve).toBeGreaterThan(1);
  const before = enginePid();
  expect(alive(before)).toBe(true);

  // Sleep: the daemon (serve, the engine host, the engine) and the run's drivers stop for longer than the 30 s lease.
  const victims = [...new Set([...treeOf(serve!), ...treeOf(before), ...driversOf(run).flatMap(treeOf)])];
  for (const pid of victims) try { process.kill(pid, "SIGSTOP"); stopped.add(pid); } catch {}
  await sleep(40_000);
  for (const pid of victims) try { process.kill(pid, "SIGCONT"); stopped.delete(pid); } catch {}

  // Wake: the old engine fences and exits; serve stays up and a new engine answers on the same port.
  let after = 0;
  for (let i = 0; i < 90 && !(after && after !== before && alive(after)); i++) { await sleep(1000); after = enginePid(); }
  if (!alive(serve!)) console.log(tailFile(engine.logPath, 4000));
  expect(alive(serve!)).toBe(true);
  expect(alive(before)).toBe(false);
  expect(after).not.toBe(before);
  expect(alive(after)).toBe(true);
  expect(tailFile(engine.logPath, 20_000)).toContain(`capcomd serve: the engine on :${port} exited`);
  expect(tailFile(engine.logPath, 20_000)).not.toContain(`engine on :${port} stopped answering`);
  const answers = () => fetch(`${env.CAPCOMD_ENDPOINT}/health`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false);
  const woke = Date.now();
  while (!(await answers()) && Date.now() - woke < 90_000) await sleep(500);
  expect(await answers()).toBe(true);
  console.log(`    the new engine answered ${Math.round((Date.now() - woke) / 1000)}s after its pid appeared`);

  // The run carries on: the agent finishes with its commit, and nothing failed it.
  const done = await cj(["await", run, agent, "--timeout-ms", "150000"]);
  const a = done.j?.agents?.[0];
  if (a?.status !== "done") console.log(done.stdout, done.stderr, tailFile(engine.logPath, 4000));
  expect(a?.status).toBe("done");
  expect(a?.result?.commit).toMatch(/^[0-9a-f]{40}$/);
  const ins = await cj(["inspect", run, agent]);
  const types = (ins.j?.events ?? []).map((e: any) => e.type);
  expect(types).toContain("AGENT_DONE");
  expect(types).not.toContain("DRIVE_FAILED");
  console.log(`    hold.log: ${readFileSync(hold, "utf8").trim().split("\n").join(", ")}`);
  expect(alive(serve!)).toBe(true);
  for (let i = 0; i < 60 && driversOf(run).length; i++) await sleep(500);
  expect(driversOf(run)).toEqual([]);
}, 300_000);
