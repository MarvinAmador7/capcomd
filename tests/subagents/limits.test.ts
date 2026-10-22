// An agent that hits a limit (here its profile's timeoutMs) is stopped, not retried: what it changed is pushed to its
// branch with a Capcomd-Stop trailer and its result says so, so a parent can continue from there. (fake claude in a
// host-exec FakeProvider, spawned through the engine like any agent.)
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Engine } from "../chaos/engine";
import { capcomd, testPort } from "../helpers/engine";
import { bareRepo } from "../merge/gitfixture";
import { Git } from "../../src/merge/git";

let engine: Engine;
let env: Record<string, string>;
let repo: Awaited<ReturnType<typeof bareRepo>>;
const saved = { ...process.env };

beforeAll(async () => {
  repo = await bareRepo({ mode: "direct" });
  const dir = mkdtempSync(join(tmpdir(), "capcomd-limits-"));
  const agentsFile = join(dir, "agents.json");
  writeFileSync(agentsFile, JSON.stringify({ schema: "capcomd.agents/v1", agents: { short: { provider: "claude", auth: "apikey", maxTurns: 20, timeoutMs: 2000 } } }));
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

const runToEnd = async (task: string, key: string) => {
  const run = (await cj(["run", "new"])).j?.runId;
  expect(run).toMatch(/^run-/);
  const id = (await cj(["spawn", run, "--profile", "short", "--task", task, "--key", key])).j?.agentId;
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
