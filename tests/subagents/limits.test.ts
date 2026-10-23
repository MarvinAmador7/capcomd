// An agent that hits a limit (here its profile's timeoutMs) is stopped, not retried: what it changed is pushed to its
// branch with a Capcomd-Stop trailer and its result says so, so a parent can continue from there. (fake claude in a
// host-exec FakeProvider, spawned through the engine like any agent.)
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Engine } from "../chaos/engine";
import { capcomd, sleep, testPort } from "../helpers/engine";
import { bareRepo } from "../merge/gitfixture";
import { Git } from "../../src/merge/git";

let engine: Engine;
let env: Record<string, string>;
let repo: Awaited<ReturnType<typeof bareRepo>>;
let quotaLedger: string;
const saved = { ...process.env };

beforeAll(async () => {
  repo = await bareRepo({ mode: "direct" });
  const dir = mkdtempSync(join(tmpdir(), "capcomd-limits-"));
  const agentsFile = join(dir, "agents.json");
  writeFileSync(agentsFile, JSON.stringify({ schema: "capcomd.agents/v1", agents: { short: { provider: "claude", auth: "apikey", maxTurns: 20, timeoutMs: 2000 }, open: { provider: "claude", auth: "apikey", idleAfterMs: 2000 }, spin: { provider: "claude", auth: "apikey", stuckRepeats: 3 } } }));
  env = {
    ...repo.env,
    CAPCOMD_AGENTS_FILE: agentsFile,
    CAPCOMD_SANDBOX: "fake-host",
    CAPCOMD_AGENT_CLAUDE_BIN: new URL("../agents/fake-claude.sh", import.meta.url).pathname,
    CAPCOMD_AGENT_WORKDIR: join(dir, "vm"),
    CAPCOMD_AGENT_POLL_MS: "100",
    CAPCOMD_DRIVER_LEASE_MS: "3000",
    CAPCOMD_SKIP_PREFLIGHT: "1",
    CAPCOMD_TRACE_DIR: join(dir, "traces"),
    CAPCOMD_AUTH_LEDGER: join(dir, "auths.json"), // never the checkout's real .relay/ ledgers
    CAPCOMD_ENV_LEDGER: join(dir, "envs.json"),
    CAPCOMD_QUOTA_LEDGER: (quotaLedger = join(dir, "quotas.json")),
    ANTHROPIC_API_KEY: "sk-ant-api03-LIMITS-abcdefghijklmnopqrstuvwxyz0123456789",
    CAPCOMD_ENV: "image",
  };
  Object.assign(process.env, env); // the engine (actors) inherits process.env
  const port = await testPort();
  engine = new Engine("limits", { port, dataDir: join(dir, "engine") });
  await engine.start(null);
  env.CAPCOMD_ENDPOINT = `http://127.0.0.1:${port}`;
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

const runToEnd = async (task: string, key: string, profile = "short", runArgs: string[] = []) => {
  const run = (await cj(["run", "new", ...runArgs])).j?.runId;
  expect(run).toMatch(/^run-/);
  const id = (await cj(["spawn", run, "--profile", profile, "--task", task, "--key", key])).j?.agentId;
  expect(id).toMatch(/^agt-/);
  const agent = (await cj(["await", run, id, "--timeout-ms", "90000"])).j?.agents?.[0];
  const events = (await capcomd(["events", run, "--json"], env)).stdout;
  return { agent, driveFailures: events.split("\n").filter((l) => l.includes('"DRIVE_FAILED"')).length };
};

test("at its timeout an agent's work is pushed with a Capcomd-Stop trailer, and it is stopped, not retried", async () => {
  const { agent, driveFailures } = await runToEnd("[wip] long job", "wip");
  expect(agent.status).toBe("failed");
  expect(agent.result).toMatchObject({ limit: "timeout" });
  expect(agent.result.error).toContain("stopped at its timeout limit");
  expect(agent.result.branch).toMatch(/^capcomd\//);
  expect(agent.result.commit).toBeTruthy();
  expect(driveFailures).toBe(0);
  const msg = (await new Git(repo.bare).run(["log", "-1", "--format=%B", agent.result.branch])).stdout;
  expect(msg).toContain("Capcomd-Stop: timeout");
  expect(await repo.show(agent.result.branch, "src/sum.ts")).toContain("a + b");
}, 120_000);

test("an agent that hits its timeout before changing anything fails after one attempt", async () => {
  const { agent, driveFailures } = await runToEnd("[sleep] hang", "sleep");
  expect(agent.status).toBe("failed");
  expect(agent.result.error).toContain("timeout limit");
  expect(driveFailures).toBe(1);
}, 120_000);

test("an agent with no limits that goes silent is noticed as idle (await --notices returns), then stopped, keeps its work, and isn't retried", async () => {
  const run = (await cj(["run", "new"])).j?.runId;
  const id = (await cj(["spawn", run, "--profile", "open", "--task", "[wip] long job", "--key", "idle"])).j?.agentId;
  // ADR-019 §2: the first window is a notice, and a waiting parent hears it while the agent still runs.
  const early = await cj(["await", run, id, "--notices", "--timeout-ms", "60000"]);
  expect(early.code).toBe(1);
  expect(early.j?.notices).toEqual([expect.objectContaining({ agentId: id, kind: "idle" })]);
  expect(early.j?.agents?.[0]).toMatchObject({ status: "running", notice: { kind: "idle" }, stuck: expect.stringContaining("no output from the agent") });
  const agent = (await cj(["await", run, id, "--timeout-ms", "60000"])).j?.agents?.[0];
  const events = (await capcomd(["events", run, "--json"], env)).stdout;
  const driveFailures = events.split("\n").filter((l) => l.includes('"DRIVE_FAILED"')).length;
  expect(events).toContain("AGENT_NOTICE");
  expect(agent.notice).toBeUndefined();
  expect(agent.status).toBe("failed");
  expect(agent.result).toMatchObject({ limit: "idle" });
  expect(agent.result.error).toContain("stopped after going idle");
  expect(driveFailures).toBe(0);
  const msg = (await new Git(repo.bare).run(["log", "-1", "--format=%B", agent.result.branch])).stdout;
  expect(msg).toContain("Capcomd-Stop: idle");
}, 120_000);

test("a spawn without a budget reserves nothing, and the engine stops it from live spend when the run's cap is reached", async () => {
  const { agent, driveFailures } = await runToEnd("[spend] costly work", "spend", "open", ["--budget", "usd=1"]);
  expect(agent.budget).toEqual({});
  expect(agent.status).toBe("failed");
  expect(agent.result).toMatchObject({ limit: "max_budget_usd" });
  expect(agent.spent.usd).toBeGreaterThan(1);
  expect(driveFailures).toBe(0);
  const msg = (await new Git(repo.bare).run(["log", "-1", "--format=%B", agent.result.branch])).stdout;
  expect(msg).toContain("Capcomd-Stop: max_budget_usd");
}, 120_000);

test("an agent repeating the same tool call is stopped as spinning after its second window, with its work kept", async () => {
  const { agent, driveFailures } = await runToEnd("[spin] go round", "spin", "spin");
  expect(agent.status).toBe("failed");
  expect(agent.result).toMatchObject({ limit: "spinning" });
  expect(agent.result.error).toContain("stopped after repeating the same tool call");
  expect(driveFailures).toBe(0);
  expect((await new Git(repo.bare).run(["log", "-1", "--format=%B", agent.result.branch])).stdout).toContain("Capcomd-Stop: spinning");
  expect(await repo.show(agent.result.branch, "src/sum.ts")).toContain("a + b");
}, 120_000);

// ADR-019 §6. These run last: a usage limit is remembered for the login (claude:apikey here) that every profile shares.
const statusOf = async (run: string, id: string) => (await cj(["inspect", run, id])).j;
const until = async (run: string, id: string, status: string) => {
  for (let i = 0; i < 120; i++) { const a = await statusOf(run, id); if (a?.status === status) return a; await sleep(500); }
  throw new Error(`${id} never reached ${status}`);
};

test("a usage limit pauses the agent with its work kept; other agents on the login wait; resume runs them on", async () => {
  const run = (await cj(["run", "new"])).j?.runId;
  const first = (await cj(["spawn", run, "--profile", "open", "--task", "[quota] big job", "--key", "q1"])).j?.agentId;
  const a = await until(run, first, "paused");
  expect({ ...a.result }).toMatchObject({ limit: "quota", login: "claude:apikey", branch: expect.stringMatching(/^capcomd\//) });
  expect(a.result.error).toContain("stopped by its provider's usage limit");
  expect(Date.parse(a.pausedUntil)).toBeGreaterThan(Date.now() + 3500_000); // the provider's reset, an hour out
  expect(a.stuck).toBeUndefined();
  expect((await new Git(repo.bare).run(["log", "-1", "--format=%B", a.result.branch])).stdout).toContain("Capcomd-Stop: quota");

  // Same login, new work: it waits for the reset instead of starting (and failing).
  const second = (await cj(["spawn", run, "--profile", "open", "--task", "plain job", "--key", "q2"])).j?.agentId;
  const b = await until(run, second, "paused");
  expect(b.result.error).toContain("waiting for claude:apikey's usage limit to reset");

  const r = await cj(["resume", run]);
  expect(r.j.resumed.sort()).toEqual([first, second].sort());
  const done = (await cj(["await", run, first, second, "--timeout-ms", "90000"])).j?.agents;
  expect(done.map((x: any) => x.status)).toEqual(["done", "done"]);
  expect(done[0].epoch).toBe(2); // a new attempt (worker, VM) that continued on the branch
  const log = (await new Git(repo.bare).run(["log", "--format=%B", done[0].result.branch])).stdout;
  expect(log).toContain("Capcomd-Stop: quota");
  const events = (await capcomd(["events", run, "--json"], env)).stdout;
  expect(events).toContain("AGENT_PAUSED");
  expect(events).toContain("AGENT_RESUMED");
  expect(events.split("\n").filter((l) => l.includes('"DRIVE_FAILED"')).length).toBe(0);
}, 180_000);

test("a paused agent wakes by itself at the provider's reset time while it is awaited", async () => {
  rmSync(quotaLedger, { force: true });
  const run = (await cj(["run", "new"])).j?.runId;
  const id = (await cj(["spawn", run, "--profile", "open", "--task", "[quota:3] short limit", "--key", "w"])).j?.agentId;
  const [agent] = (await cj(["await", run, id, "--timeout-ms", "90000"])).j?.agents;
  expect(agent).toMatchObject({ status: "done", epoch: 2 });
  expect((await capcomd(["events", run, "--json"], env)).stdout).toContain('"by":"reset"');
}, 180_000);
