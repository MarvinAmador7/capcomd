// A worker's job ops follow the config it runs with, not only its profile (plugin API §16.2, ADR-017 §2): a daemon whose
// CAPCOMD_AGENT_DISALLOWED_TOOLS denies the shell runs every agent without one, so a worker (fake claude in a host-exec
// FakeProvider, with the in-VM capcomd) whose profile names no tool limit still gets no job ops in its token and no job
// lines in its instructions: `capcomd job start` is no way around the daemon's tool policy. It keeps the rest of its
// capcomd (its tab, notes, result).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Engine } from "../helpers/test-engine";
import { capcomd, testPort } from "../helpers/engine";
import { bareRepo } from "../merge/gitfixture";

let engine: Engine;
let repo: Awaited<ReturnType<typeof bareRepo>>;
let env: Record<string, string>;
let dir = "";
const runs: string[] = [];
const saved = { ...process.env };

beforeAll(async () => {
  const r = (repo = await bareRepo({ mode: "direct" }));
  dir = mkdtempSync(join(tmpdir(), "capcomd-worker-jobs-config-"));
  const agentsFile = join(dir, "agents.json");
  writeFileSync(agentsFile, JSON.stringify({ schema: "capcomd.agents/v1", agents: {
    worker: { provider: "claude", auth: "apikey", maxTurns: 20 },
    lead: { provider: "claude", auth: "apikey", maxTurns: 20, toolMode: "orchestrate", children: { allowSpawn: true, maxDepth: 1, maxChildren: 2, allowedChildProfiles: ["worker"] } },
  } }));
  env = {
    ...r.env,
    CAPCOMD_AGENTS_FILE: agentsFile,
    CAPCOMD_SANDBOX: "fake-host",
    CAPCOMD_AGENT_CLAUDE_BIN: new URL("../agents/fake-claude.sh", import.meta.url).pathname,
    CAPCOMD_AGENT_WORKDIR: join(dir, "vm"),
    CAPCOMD_AGENT_POLL_MS: "100",
    CAPCOMD_VM_RPC_POLL_MS: "200",
    CAPCOMD_JOBS_POLL_MS: "200",
    CAPCOMD_SKIP_PREFLIGHT: "1",
    CAPCOMD_TRACE_DIR: join(dir, "traces"),
    CAPCOMD_AUTH_LEDGER: join(dir, "auths.json"), // never the checkout's real .relay/ ledgers
    CAPCOMD_ENV_LEDGER: join(dir, "envs.json"),
    ANTHROPIC_API_KEY: "sk-ant-api03-JOBSCFG-abcdefghijklmnopqrstuvwxyz0123456789",
    CAPCOMD_ENV: "image",
    // The daemon's own tool policy: no agent it runs has a shell.
    CAPCOMD_AGENT_DISALLOWED_TOOLS: "Bash",
  };
  Object.assign(process.env, env); // the engine (actors) inherits process.env
  const port = await testPort();
  engine = new Engine("worker-jobs-config", { port, dataDir: join(dir, "engine") });
  await engine.start(null);
  env.CAPCOMD_ENDPOINT = `http://127.0.0.1:${port}`;
}, 120_000);

afterAll(async () => {
  const mine = Bun.spawnSync(["ps", "-A", "-o", "pid=,command="]).stdout.toString().split("\n").filter((l) => (dir && l.includes(dir)) || runs.some((r) => l.includes(`/${r}/`))).map((l) => Number(l.trim().split(/\s+/)[0]));
  for (const pid of mine) if (pid > 1 && pid !== process.pid) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
  await engine?.stop();
  for (const k of Object.keys(env ?? {})) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
});

const cj = async (args: string[]) => {
  const x = await capcomd([...args, "--json"], env);
  let j: any = null;
  try { j = JSON.parse(x.stdout.trim().split("\n").pop()!); } catch {}
  return { ...x, j };
};

test("a worker of a daemon that denies the shell has no job ops: its job start is refused and its instructions name no jobs", async () => {
  const run = (await cj(["run", "new"])).j?.runId;
  runs.push(run);
  const id = (await cj(["spawn", run, "--profile", "worker", "--task", "[job:4] run the suite", "--key", "worker"])).j?.agentId;
  expect(id).toMatch(/^agt-/);
  const agent = (await cj(["await", run, id, "--timeout-ms", "90000"])).j?.agents?.[0];
  expect(agent?.status).toBe("done");
  const started = JSON.parse(await repo.show(agent.result.branch, "job-start.txt"));
  expect(started).toMatchObject({ ok: false, error: { code: "conflict", reason: "forbidden" } });
  expect(started.error.message).toContain('op "job.start" is not in your token');
  expect((await cj(["kv", "list", run, "--prefix", "_jobs/"])).j?.entries ?? []).toEqual([]);
  // Its capcomd, without the job lines.
  const work = join(dir, "vm", readdirSync(join(dir, "vm")).find((d) => d.includes(id))!);
  const system = readFileSync(join(work, "append-system.txt"), "utf8");
  expect(system).toContain("# Your capcomd");
  expect(system).not.toContain("capcomd job start");
}, 120_000);

test("an orchestrate agent spawned with no fan-out is told of no jobs (its start would be refused by name)", async () => {
  const run = (await cj(["run", "new"])).j?.runId;
  runs.push(run);
  const sp = await cj(["spawn", run, "--profile", "lead", "--task", "plan it [nochange]", "--key", "lead", "--children.maxChildren=0"]);
  const id = sp.j?.agentId;
  if (!id) console.log(sp.stdout, sp.stderr);
  expect(id).toMatch(/^agt-/);
  expect(sp.j?.limits?.allowSpawn).toBe(false);
  await cj(["await", run, id, "--timeout-ms", "90000"]);
  const work = join(dir, "vm", readdirSync(join(dir, "vm")).find((d) => d.includes(id))!);
  const system = readFileSync(join(work, "append-system.txt"), "utf8");
  expect(system).toContain("# Your capcomd");
  expect(system).not.toContain("capcomd job start");
}, 120_000);
