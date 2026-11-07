// ADR-024 §2.2 `permissions.report: false`: a profile that is never spawned to report is refused whoever asks for
// report, the spawner or an agent.spawning plugin that adds it to the contract (plugin API §6.6.6: a plugin may add
// contract keys). The spawner's side through the MCP server: tests/mcp/client.test.ts.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { PluginHost, type Candidate } from "../../packages/plugin/src/host/host";
import type { PluginContext, PluginModule } from "../../packages/plugin/src/context";
import { useHooks } from "../../src/plugins/hooks";
import { Engine } from "../helpers/test-engine";
import { capcomd, testPort } from "../helpers/engine";

let engine: Engine;
let env: Record<string, string>;
const saved = { ...process.env };

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "capcomd-prof-report-"));
  const agentsFile = join(dir, "agents.json");
  writeFileSync(agentsFile, JSON.stringify({ schema: "capcomd.agents/v1", agents: { worker: { provider: "claude", auth: "apikey" } } }));
  mkdirSync(join(dir, "profiles"), { recursive: true });
  writeFileSync(join(dir, "profiles", "critic.yaml"), "name: critic\nharness: { provider: claude, auth: apikey }\ntools: { allowed: [Read, Grep] }\npermissions: { report: false }\n");
  env = { CAPCOMD_AGENTS_FILE: agentsFile, CAPCOMD_SPAWN_EXEC: "fake", CAPCOMD_SKIP_PREFLIGHT: "1", CAPCOMD_DRIVER_LEASE_MS: "3000" };
  Object.assign(process.env, env);
  const port = await testPort();
  engine = new Engine("profile-report", { port, dataDir: join(dir, "engine") });
  await engine.start(null);
  env.CAPCOMD_ENDPOINT = process.env.CAPCOMD_ENDPOINT = `http://127.0.0.1:${port}`;
}, 120_000);
afterAll(async () => {
  await engine?.stop();
  for (const k of Object.keys(env ?? {})) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
});
afterEach(() => useHooks(null));

const plugin = (name: string, activate: (ctx: PluginContext) => void): Candidate => ({
  source: "builtin",
  manifest: { schema: "capcomd.plugin/v1", name, version: "1.0.0", description: `The ${name} test plugin.`, apiVersion: 1, engines: { capcomd: ">=0.0.0" }, entry: { runtime: "in-process", module: "./index.ts" }, contributes: { hooks: { "agent.spawning": {} } } },
  module: { activate } as PluginModule<never>,
});

test("an agent.spawning plugin that adds report to the contract can't spawn a profile whose permissions.report is false", async () => {
  const host = new PluginHost({ capcomd: "0.9.0", kernel: [], emit: () => {}, dataDir: (n) => join(tmpdir(), "capcomd-prof-report-plugins", n) });
  await host.start([plugin("reporter", (ctx) => { ctx.hooks.on("agent.spawning", () => ({ decision: "allow", patch: { contract: { report: true } } })); })]);
  useHooks(host.hooks);
  try {
    const r = await capcomd(["run", "new", "--budget", "usd=5,turns=50", "--label", "report", "--key", `rp-${Date.now()}`, "--json"], env);
    const runId = JSON.parse(r.stdout.trim().split("\n").pop()!).runId as string;
    const { spawnAgent } = await import("../../src/primitives/ops");
    let err: any = null;
    try { await spawnAgent({ runId, task: "review it", profile: "critic", key: "c", budget: { turns: 5 }, start: false }); } catch (e) { err = e; }
    expect(err).toMatchObject({ code: "config", reason: "report_not_allowed" });
    // The same plugin on a profile that may report: the spawn is recorded with report in its contract.
    const ok = await spawnAgent({ runId, task: "where is sum defined?", profile: "worker", key: "w", budget: { turns: 5 }, start: false });
    expect(ok).toMatchObject({ created: true, profile: "worker" });
    const { client } = await import("../../src/core/relay");
    expect((await client().scope.getOrCreate([runId]).getAgent({ agentId: ok.agentId }))?.contract).toEqual({ report: true });
  } finally { await host.stop(); }
}, 60_000);
