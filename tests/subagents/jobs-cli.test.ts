// Background jobs through a real agent CLI (plugin API §16.2): a lead (fake claude in a host-exec FakeProvider, with
// the in-VM capcomd and the supervisor feeding its stdin) runs `capcomd job start`. A long job answers `running`; the
// CLI's turn ends, the supervisor keeps its input open while the job runs, and the job's result reaches it on stdin as
// a message from the job. A job that answered in the foreground sends no message, so it doesn't hold the CLI's input
// open after its turn: the agent ends as soon as it is done.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Engine } from "../helpers/test-engine";
import { capcomd, testPort } from "../helpers/engine";
import { bareRepo } from "../merge/gitfixture";

let engine: Engine;
let repo: Awaited<ReturnType<typeof bareRepo>>;
let env: Record<string, string>;
let dir = "";
/** This file's runs: a cancelled agent's processes are named by them. */
const runs: string[] = [];
const saved = { ...process.env };

beforeAll(async () => {
  const r = (repo = await bareRepo({ mode: "direct" }));
  dir = mkdtempSync(join(tmpdir(), "capcomd-jobs-cli-"));
  const agentsFile = join(dir, "agents.json");
  writeFileSync(agentsFile, JSON.stringify({ schema: "capcomd.agents/v1", agents: {
    lead: { provider: "claude", auth: "apikey", maxTurns: 20, children: { allowSpawn: true, maxDepth: 1, maxChildren: 1, allowedChildProfiles: ["lead"] } },
    worker: { provider: "claude", auth: "apikey", maxTurns: 20 },
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
    ANTHROPIC_API_KEY: "sk-ant-api03-JOBSCLI-abcdefghijklmnopqrstuvwxyz0123456789",
    CAPCOMD_ENV: "image",
  };
  Object.assign(process.env, env); // the engine (actors) inherits process.env
  const port = await testPort();
  engine = new Engine("jobs-cli", { port, dataDir: join(dir, "engine") });
  await engine.start(null);
  env.CAPCOMD_ENDPOINT = `http://127.0.0.1:${port}`;
}, 120_000);

afterAll(async () => {
  // A cancelled agent's "VM" here is this host: its CLI, supervisor and job outlive the cancel (a real VM goes with it).
  for (const run of runs) {
    const spool = join(tmpdir(), "capcomd-rpc", run);
    for (const pidFile of Bun.spawnSync(["sh", "-c", `cat "$1"/*/jobs/*/pid 2>/dev/null; true`, "sh", spool]).stdout.toString().split("\n")) {
      const pid = Number(pidFile.trim());
      if (pid > 1) try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ }
    }
  }
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

test("a long job answers running; the CLI's input stays open and the job's result reaches it on stdin", async () => {
  const run = (await cj(["run", "new"])).j?.runId;
  runs.push(run);
  const id = (await cj(["spawn", run, "--profile", "lead", "--task", "[job:4] build it", "--key", "long"])).j?.agentId;
  expect(id).toMatch(/^agt-/);
  const agent = (await cj(["await", run, id, "--timeout-ms", "90000"])).j?.agents?.[0];
  expect(agent?.status).toBe("done");
  const started = JSON.parse(await repo.show(agent.result.branch, "job-start.txt"));
  expect(started).toMatchObject({ state: "running", label: "build" });
  const heard = await repo.show(agent.result.branch, "messages.txt");
  expect(heard).toContain("From capcomd, about your background job");
  expect(heard).toContain(`Your background job ${started.jobId} (build) finished (exit 0)`);
  expect(heard).toContain("built-ok");
  const kv = await cj(["kv", "get", run, `_jobs/${started.jobId}`]);
  expect(kv.j?.value).toMatchObject({ state: "done", result: { code: 0, stdout: "built-ok\n" } });
}, 120_000);

test("a worker that may not spawn has the in-VM capcomd too: its long job's result reaches it; its final message is its summary", async () => {
  const run = (await cj(["run", "new"])).j?.runId;
  runs.push(run);
  const id = (await cj(["spawn", run, "--profile", "worker", "--task", "[job:4] run the suite", "--key", "worker"])).j?.agentId;
  expect(id).toMatch(/^agt-/);
  const agent = (await cj(["await", run, id, "--timeout-ms", "90000"])).j?.agents?.[0];
  expect(agent?.status).toBe("done");
  const started = JSON.parse(await repo.show(agent.result.branch, "job-start.txt"));
  expect(started).toMatchObject({ ok: true, state: "running", label: "build" });
  const heard = await repo.show(agent.result.branch, "messages.txt");
  expect(heard).toContain(`Your background job ${started.jobId} (build) finished (exit 0)`);
  expect(heard).toContain("built-ok");
  expect((await cj(["kv", "get", run, `_jobs/${started.jobId}`])).j?.value).toMatchObject({ state: "done", by: id, result: { code: 0, stdout: "built-ok\n" } });
  // It declared no summary (the fake CLI never runs `capcomd result`): its final message is its summary, here its
  // answer to the job's message (the fake CLI answers each message with "answered").
  expect(agent.result.summary).toBe("answered");
}, 120_000);

test("a cancelled agent's job is stopped with it and its record ends", async () => {
  const run = (await cj(["run", "new"])).j?.runId;
  runs.push(run);
  // [wip]: after starting its job the CLI hangs, as an agent still at work.
  const id = (await cj(["spawn", run, "--profile", "lead", "--task", "[job:20] [wip] build it", "--key", "cancelled"])).j?.agentId;
  let job: any = null;
  for (let i = 0; i < 200 && !job; i++) { await Bun.sleep(150); job = (await cj(["kv", "list", run, "--prefix", "_jobs/"])).j?.entries?.[0] ?? null; }
  expect(job?.value?.state).toBe("running");
  const jobId = String(job.k).replace("_jobs/", "");
  expect((await cj(["cancel", run, id])).code).toBe(0);
  let rec: any = null;
  for (let i = 0; i < 150; i++) { rec = (await cj(["kv", "get", run, `_jobs/${jobId}`])).j?.value; if (rec && rec.state !== "running" && rec.state !== "stopping") break; await Bun.sleep(200); }
  expect(rec).toMatchObject({ state: "killed", reason: "its agent ended" });
  expect((await cj(["events", run])).stdout).toContain("JOB_ENDED");
}, 120_000);

test("a job that answered in the foreground sends no message, so it doesn't keep the agent waiting for one", async () => {
  const run = (await cj(["run", "new"])).j?.runId;
  runs.push(run);
  const t0 = Date.now();
  const id = (await cj(["spawn", run, "--profile", "lead", "--task", "[job:0] check it", "--key", "quick"])).j?.agentId;
  const agent = (await cj(["await", run, id, "--timeout-ms", "90000"])).j?.agents?.[0];
  expect(agent?.status).toBe("done");
  // The supervisor waits up to a minute for a result message that may still come; none comes for this one.
  expect(Date.now() - t0).toBeLessThan(40_000);
  const started = JSON.parse(await repo.show(agent.result.branch, "job-start.txt"));
  expect(started).toMatchObject({ state: "done", code: 0, stdout: "quick-ok\n" });
  expect((await cj(["events", run])).stdout).not.toContain("MESSAGE_SENT");
}, 120_000);
