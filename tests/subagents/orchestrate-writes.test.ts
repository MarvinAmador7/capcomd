// Plugin API §16.1 against a real engine and runner: an orchestrate agent (here a lead on Claude Code, the fake claude in
// a host-exec sandbox) whose checkout has a changed file at the end of its turn fails, naming the file, with
// errorKind orchestrate_wrote_files; nothing it wrote reaches the repository (no branch, no checkpoint ref). It used to
// end "done" with the change logged and dropped. One that writes nothing still ends by the old rule (it spawned none).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Engine } from "../helpers/test-engine";
import { capcomd, testPort } from "../helpers/engine";
import { bareRepo } from "../merge/gitfixture";

let engine: Engine;
let env: Record<string, string>;
let repo: Awaited<ReturnType<typeof bareRepo>>;
const saved = { ...process.env };

beforeAll(async () => {
  repo = await bareRepo({ mode: "direct" });
  const dir = mkdtempSync(join(tmpdir(), "capcomd-orch-writes-"));
  const agentsFile = join(dir, "agents.json");
  writeFileSync(agentsFile, JSON.stringify({ schema: "capcomd.agents/v1", agents: {
    lead: { provider: "claude", auth: "apikey", maxTurns: 20, toolMode: "orchestrate", children: { allowSpawn: true, maxChildren: 2, maxDepth: 1, allowedChildProfiles: ["worker"] } },
    worker: { provider: "claude", auth: "apikey", maxTurns: 20 },
  } }));
  env = {
    ...repo.env,
    CAPCOMD_HOME: join(dir, "home"),
    CAPCOMD_HARNESS_SOCKET: join(dir, "home", "harness.sock"),
    CAPCOMD_AGENTS_FILE: agentsFile,
    CAPCOMD_SANDBOX: "fake-host",
    CAPCOMD_AGENT_CLAUDE_BIN: new URL("../agents/fake-claude.sh", import.meta.url).pathname,
    CAPCOMD_AGENT_WORKDIR: join(dir, "vm"),
    CAPCOMD_AGENT_POLL_MS: "100",
    CAPCOMD_AGENT_CHECKPOINT_MS: "300",
    CAPCOMD_VM_RPC_POLL_MS: "200",
    CAPCOMD_SKIP_PREFLIGHT: "1",
    CAPCOMD_TRACE_DIR: join(dir, "traces"),
    CAPCOMD_AUTH_LEDGER: join(dir, "auths.json"),
    CAPCOMD_ENV_LEDGER: join(dir, "envs.json"),
    CAPCOMD_RPC_KEY: `orch-writes-${Math.random()}`,
    ANTHROPIC_API_KEY: "sk-ant-api03-ORCHWRITES-abcdefghijklmnopqrstuvwxyz0123456789",
    CAPCOMD_ENV: "image",
  };
  Object.assign(process.env, env);
  const port = await testPort();
  engine = new Engine("orch-writes", { port, dataDir: join(dir, "engine") });
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

test("an orchestrate agent that wrote a file fails naming it; nothing it wrote is pushed", async () => {
  const run = (await cj(["run", "new", "--key", `ow-${Date.now()}`])).j.runId as string;
  const lead = (await cj(["spawn", run, "--profile", "lead", "--task", "[linger] split the work", "--key", "lead"])).j.agentId as string;
  const done = (await cj(["await", run, lead, "--timeout-ms", "90000"])).j.agents[0];
  if (done.status !== "failed") console.log(JSON.stringify(done), (await cj(["logs", run, lead])).stdout);
  expect(done.status).toBe("failed");
  expect(done.result.errorKind).toBe("orchestrate_wrote_files");
  expect(done.result.error).toBe(`${lead} is an orchestrate agent and it changed src/sum.ts in its checkout (stopped at the end of that turn). An orchestrate agent writes nothing, so it failed; its changes were discarded, never committed or pushed. Give that work to a worker it spawns.`);
  expect(done.result.wrote).toEqual({ files: ["src/sum.ts"], total: 1, commits: 0, at: "turn" });
  expect(done.result.branch).toBeNull();
  expect(await repo.sha(`refs/heads/capcomd/${run}/${lead}`)).toBeNull();
  expect(await repo.sha(`refs/capcomd/checkpoints/${lead}`)).toBeNull();
  const logs = (await cj(["logs", run, lead])).j.lines.map((l: any) => l.line).join("\n");
  expect(logs).toContain("[capcomd] orchestrate: it changed src/sum.ts in a turn, so it was stopped there");
}, 120_000);

test("one that wrote nothing still ends by the old rule: it spawned no agents", async () => {
  const run = (await cj(["run", "new", "--key", `ow2-${Date.now()}`])).j.runId as string;
  const lead = (await cj(["spawn", run, "--profile", "lead", "--task", "[nochange] split the work", "--key", "lead"])).j.agentId as string;
  const done = (await cj(["await", run, lead, "--timeout-ms", "90000"])).j.agents[0];
  expect(done.status).toBe("failed");
  expect(done.result.errorKind).toBe("orchestrate_no_children");
}, 120_000);
