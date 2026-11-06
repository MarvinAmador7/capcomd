// agent.preparing's skills and variables against a real engine and runner (plugin API §6.6.7, §17.2 step 8): the
// orchestration skill is the built-in skill-orchestration plugin's patch, and a plugin of the test's own
// (tests/plugins/fixtures/test-preparer, loaded by the daemon with CAPCOMD_TEST_PLUGINS) adds a skill and a variable.
// What the agent gets (the fake claude in a host-exec sandbox): the skills after its profile's prompt, in plugin order,
// in its appended system prompt; the variable in its environment. A lead that may spawn gets the orchestration skill;
// a worker that may not gets the naming lines instead, and the test plugin's skill all the same.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Engine } from "../helpers/test-engine";
import { capcomd, testPort } from "../helpers/engine";
import { bareRepo } from "../merge/gitfixture";
import { SKILL_TEXT } from "../plugins/fixtures/test-preparer/index";

let engine: Engine;
let env: Record<string, string>;
let dir = "";
const saved = { ...process.env };

beforeAll(async () => {
  const r = await bareRepo({ mode: "direct" });
  dir = mkdtempSync(join(tmpdir(), "capcomd-prepare-skills-"));
  const agentsFile = join(dir, "agents.json");
  writeFileSync(agentsFile, JSON.stringify({ schema: "capcomd.agents/v1", agents: {
    lead: { provider: "claude", auth: "apikey", maxTurns: 20, appendSystemPrompt: "Keep the team small.", children: { allowSpawn: true, maxChildren: 2, maxDepth: 1, allowedChildProfiles: ["worker"] } },
    worker: { provider: "claude", auth: "apikey", maxTurns: 20 },
  } }));
  env = {
    ...r.env,
    CAPCOMD_HOME: join(dir, "home"),
    CAPCOMD_HARNESS_SOCKET: join(dir, "home", "harness.sock"),
    CAPCOMD_AGENTS_FILE: agentsFile,
    CAPCOMD_SANDBOX: "fake-host",
    CAPCOMD_AGENT_CLAUDE_BIN: new URL("../agents/fake-claude.sh", import.meta.url).pathname,
    CAPCOMD_AGENT_WORKDIR: join(dir, "vm"),
    CAPCOMD_AGENT_POLL_MS: "100",
    CAPCOMD_VM_RPC_POLL_MS: "200",
    CAPCOMD_SKIP_PREFLIGHT: "1",
    CAPCOMD_TRACE_DIR: join(dir, "traces"),
    CAPCOMD_AUTH_LEDGER: join(dir, "auths.json"),
    CAPCOMD_ENV_LEDGER: join(dir, "envs.json"),
    CAPCOMD_RPC_KEY: `prepare-skills-${Math.random()}`,
    ANTHROPIC_API_KEY: "sk-ant-api03-PREPARE-abcdefghijklmnopqrstuvwxyz0123456789",
    CAPCOMD_ENV: "image",
    CAPCOMD_TEST_PLUGINS: new URL("../plugins/fixtures/test-preparer", import.meta.url).pathname,
  };
  Object.assign(process.env, env);
  const port = await testPort();
  engine = new Engine("prepare-skills", { port, dataDir: join(dir, "engine") });
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
const workDir = (id: string) => join(dir, "vm", readdirSync(join(dir, "vm")).find((d) => d.includes(id))!);
async function finished(run: string, profile: string, key: string) {
  const id = (await cj(["spawn", run, "--profile", profile, "--task", "Fix the sum helper", "--key", key])).j?.agentId as string;
  expect(id).toMatch(/^agt-/);
  const done = (await cj(["await", run, id, "--timeout-ms", "90000"])).j?.agents?.[0];
  if (done?.status !== "done") console.log(JSON.stringify(done), (await cj(["logs", run, id])).stdout);
  expect(done?.status).toBe("done");
  return { id, system: readFileSync(join(workDir(id), "append-system.txt"), "utf8"), env: readFileSync(join(workDir(id), "plugin-env.txt"), "utf8") };
}

test("a lead gets its profile's prompt, then the orchestration skill, then a plugin's skill; and the plugin's variable", async () => {
  const run = (await cj(["run", "new", "--key", `ps-${Date.now()}`])).j.runId as string;
  const lead = await finished(run, "lead", "lead");
  const own = lead.system.indexOf("Keep the team small."), orch = lead.system.indexOf("# Orchestrating child agents (capcomd)"), cite = lead.system.indexOf(SKILL_TEXT);
  expect(own).toBe(0);
  expect(orch).toBeGreaterThan(own);
  expect(cite).toBeGreaterThan(orch);
  expect(lead.system).toContain(`You are agent ${lead.id}.`);
  expect(lead.system.split("# Orchestrating child agents (capcomd)").length).toBe(2);   // once
  expect(lead.env).toBe("PLUGIN_TEAM=payments\n");

  const worker = await finished(run, "worker", "worker");
  expect(worker.system).not.toContain("Orchestrating child agents");
  expect(worker.system).toContain(SKILL_TEXT);
  expect(worker.system).toContain("# Name your tab (capcomd)");
  expect(worker.env).toBe("PLUGIN_TEAM=payments\n");
}, 180_000);
