// fx variant (agent-fx, docs/spec/plugin-api.md §7.3). Full pipeline with the real provider and its bridge: capcomd run →
// planner (1 task) → a worker on an fx profile runs the bridge, which runs a scripted fake fx (an ACP peer) in a host-exec
// FakeProvider → commit with trailers + push → verifier runs tests → real git merge.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Engine } from "../helpers/test-engine";
import { capcomd, testPort } from "../helpers/engine";
import { bareRepo } from "../merge/gitfixture";

const KEY = "vck_E2EKEY_abcdefghijklmnopqrstuvwxyz0123456789";
const FAKE = new URL("./fake-fx.mjs", import.meta.url).pathname;
let PORT = 0;
let engine: Engine;
function agentsFile() {
  const p = join(mkdtempSync(join(tmpdir(), "capcomd-e2e-agents-")), "agents.json");
  writeFileSync(p, JSON.stringify({ schema: "capcomd.agents/v1", agents: { fxw: { provider: "fx", auth: "apikey", model: "anthropic/claude-sonnet-5", effort: "high", maxTurns: 10, appendSystemPrompt: "PROFILE-APPEND-MARKER" } } }));
  return p;
}
let r: Awaited<ReturnType<typeof bareRepo>>;
let env: Record<string, string>;
const saved = { ...process.env };

beforeAll(async () => {
  chmodSync(FAKE, 0o755);
  r = await bareRepo({ mode: "direct", test: "grep -q 'a + b' src/sum.ts" });
  const traceDir = mkdtempSync(join(tmpdir(), "capcomd-agent-trace-"));
  env = {
    ...r.env,
    CAPCOMD_AGENTS_FILE: agentsFile(),
    CAPCOMD_SANDBOX: "fake-host",
    CAPCOMD_AGENT_BIN: FAKE,
    CAPCOMD_AGENT_WORKDIR: mkdtempSync(join(tmpdir(), "capcomd-agent-vm-")),
    CAPCOMD_AGENT_POLL_MS: "100",
    CAPCOMD_TRACE_DIR: traceDir,
    CAPCOMD_AUTH_LEDGER: join(traceDir, "auths.json"),
    CAPCOMD_ENV_LEDGER: join(traceDir, "envs.json"),
    AI_GATEWAY_API_KEY: KEY,
    CAPCOMD_ENV: "image",
  };
  Object.assign(process.env, env); // the engine (actors) inherits process.env
  PORT = await testPort();
  engine = new Engine("agent-e2e-fx", { port: PORT, dataDir: mkdtempSync(join(tmpdir(), "capcomd-agent-eng-")) });
  await engine.start(null);
}, 120_000);

afterAll(async () => {
  await engine?.stop();
  for (const k of Object.keys(env ?? {})) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
});

test("capcomd run --profile fxw (fx profile, apikey): the bridge runs fx, the worker's commit is verified and merged; key never in trace", async () => {
  const runId = `run-fx-e2e-${Date.now()}`;
  const cenv = { ...env, CAPCOMD_ENDPOINT: `http://127.0.0.1:${PORT}`, CAPCOMD_PLUGIN_RECIPE_HIERARCHICAL_ENABLED: "true" };
  const running = capcomd(["run", "--json", "--run-id", runId, "--profile", "fxw", "make the failing test pass"], cenv);
  let approved = false, finished = false;
  void running.then(() => { finished = true; });
  for (let i = 0; i < 240 && !approved && !finished; i++) {
    await Bun.sleep(500);
    const a = await capcomd(["approve", runId, "task-1", "--json"], cenv);
    approved = a.code === 0;
  }
  const res = await running;
  if (!approved) throw new Error(`the run ended unapproved: ${(res.stdout + res.stderr).slice(-3000)}`);
  const out = res.stdout + res.stderr;
  expect(out).not.toContain(KEY);
  expect(res.code).toBe(0);
  expect(await r.show("main", "src/sum.ts")).toContain("a + b");
  expect(await r.landings(`${runId}/task-1`)).toBe(1);

  const trace = readFileSync(join(env.CAPCOMD_TRACE_DIR!, `${runId}.ndjson`), "utf8");
  expect(trace).not.toContain(KEY);
  const spans = trace.trim().split("\n").map((l) => JSON.parse(l));
  const agent = spans.find((s) => s.name === "agent.fx");
  expect(agent.attributes["agent.profile"]).toBe("fxw");
  // The bridge's turn end is the turn's end, as claude's result and codex's turn.completed are.
  expect(agent.events.map((e: any) => e.name)).toContain("agent.result.end_turn");

  // How the bridge ran fx: its ACP server, the profile's model and effort, full access (the VM is the boundary), the
  // key in its environment, and the in-VM capcomd as an MCP server with an absolute command.
  const W = join(env.CAPCOMD_AGENT_WORKDIR!, "task-1-e1");
  const seen = JSON.parse(readFileSync(join(W, "fx-seen.json"), "utf8"));
  expect(seen.argv.slice(0, 3)).toEqual(["acp", "--model", "anthropic/claude-sonnet-5"]);
  expect(seen.env).toMatchObject({ FX_PERMISSION_MODE: "full-access", FX_PROVIDER: "gateway", FX_EFFORT: "high", FX_MAX_AGENT_STEPS: "10", FX_AUTO_UPGRADE: "0" });
  expect(seen.key).toBe("set");
  const mcp = JSON.parse(readFileSync(join(W, "fx-seen.json.mcp"), "utf8"));
  expect(mcp.map((s: any) => [s.name, s.command.startsWith("/"), s.args.at(-1)])).toEqual([["capcomd", true, "mcp"]]);
  // capcomd's own instructions reach fx in the prompt (a CLI without system prompt flags reads them first).
  expect(readFileSync(join(W, "prompt.txt"), "utf8")).toContain("PROFILE-APPEND-MARKER");
  // The stream the provider read: the bridge's lines.
  const jsonl = readFileSync(join(W, "agent.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  expect(jsonl.map((l) => l.type)).toContain("result");
  expect(jsonl.at(-1)).toMatchObject({ type: "result", stopReason: "end_turn", lastText: "fixed sum with fx" });
}, 180_000);
