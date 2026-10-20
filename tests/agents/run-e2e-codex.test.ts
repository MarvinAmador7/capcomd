// Codex variant. Full pipeline with the real adapter: capcomd run → planner (1 task) → worker runs (fake) claude
// in a host-exec FakeProvider → commit with trailers + push → verifier runs tests → real git merge.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Engine } from "../chaos/engine";
import { capcomd } from "../helpers/engine";
import { bareRepo } from "../merge/gitfixture";

const KEY = "sk-proj-E2EKEY-abcdefghijklmnopqrstuvwxyz0123456789";
const PORT = 7641;
let engine: Engine;
function agentsFile() {
  const p = join(mkdtempSync(join(tmpdir(), "capcomd-e2e-agents-")), "agents.json");
  writeFileSync(p, JSON.stringify({ schema: "capcomd.agents/v1", agents: { cx: { provider: "codex", auth: "apikey", maxTurns: 10, appendSystemPrompt: "PROFILE-APPEND-MARKER" } } }));
  return p;
}
let r: Awaited<ReturnType<typeof bareRepo>>;
let env: Record<string, string>;
const saved = { ...process.env };

beforeAll(async () => {
  r = await bareRepo({ mode: "direct", test: "grep -q 'a + b' src/sum.ts" });
  const traceDir = mkdtempSync(join(tmpdir(), "capcomd-agent-trace-"));
  env = {
    ...r.env,
    // Agent comes from a named profile selected with `capcomd run --agent cx` (no CAPCOMD_AGENT).
    CAPCOMD_AGENTS_FILE: agentsFile(),
    CAPCOMD_SANDBOX: "fake-host",
    CAPCOMD_AGENT_BIN: new URL("./fake-codex.sh", import.meta.url).pathname,
    CAPCOMD_AGENT_WORKDIR: mkdtempSync(join(tmpdir(), "capcomd-agent-vm-")),
    CAPCOMD_AGENT_POLL_MS: "100",
    CAPCOMD_TRACE_DIR: traceDir,
    OPENAI_API_KEY: KEY,
    CAPCOMD_ENV: "image",
  };
  Object.assign(process.env, env); // the engine (actors) inherits process.env
  engine = new Engine("agent-e2e-codex", { port: PORT, dataDir: mkdtempSync(join(tmpdir(), "capcomd-agent-eng-")) });
  await engine.start(null);
}, 120_000);

afterAll(async () => {
  await engine?.stop();
  for (const k of Object.keys(env ?? {})) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
});

test("capcomd run --profile cx --set maxTurns=8 (codex profile, apikey, appendSystemPrompt): one task, agent commit, verified, merged; key never in trace", async () => {
  const runId = `run-codex-e2e-${Date.now()}`;
  const cenv = { ...env, CAPCOMD_ENDPOINT: `http://127.0.0.1:${PORT}` };
  const running = capcomd(["run", "--json", "--run-id", runId, "--profile", "cx", "--set", "maxTurns=8", "make the failing test pass"], cenv);
  // main is protected: the task parks in awaiting_approval after verification; approve it.
  let approved = false;
  for (let i = 0; i < 240 && !approved; i++) {
    await Bun.sleep(500);
    const a = await capcomd(["approve", runId, "task-1", "--json"], cenv);
    approved = a.code === 0;
  }
  expect(approved).toBe(true);
  const res = await running;
  const out = res.stdout + res.stderr;
  expect(out).not.toContain(KEY);
  expect(res.code).toBe(0);
  const evs = res.stdout.trim().split("\n").map((l) => JSON.parse(l));
  expect(JSON.stringify(evs.find((e) => e.type === "plan.ready"))).toContain(`["task-1"]`);
  expect(evs.some((e) => e.type === "task.approved")).toBe(true);
  expect(await r.show("main", "src/sum.ts")).toContain("a + b");
  expect(await r.landings(`${runId}/task-1`)).toBe(1);

  const trace = readFileSync(join(env.CAPCOMD_TRACE_DIR!, `${runId}.ndjson`), "utf8");
  expect(trace).not.toContain(KEY);
  const spans = trace.trim().split("\n").map((l) => JSON.parse(l));
  const agent = spans.find((s) => s.name === "agent.codex");
  expect(agent.events.map((e: any) => e.name)).toContain("agent.turn_completed");
  expect(spans.some((s) => s.name === "git.merge")).toBe(true);
  expect(agent.attributes["agent.profile"]).toBe("cx");
  // Effective resolved spec recorded (CLI stream + event log), with the narrowing override applied.
  const resolved = evs.find((e) => e.type === "agent.resolved");
  expect(resolved.agent).toMatchObject({ name: "cx", kind: "codex", overridden: true, maxTurns: 8, auth: "apikey", children: { allowSpawn: false } });
  const evlog = await capcomd(["events", runId, "--json", "--limit", "500"], cenv);
  process.stderr.write(evlog.stdout.slice(0, 0));
  expect(evlog.stdout).toContain('"maxTurns":8');
  expect(readFileSync(join(env.CAPCOMD_AGENT_WORKDIR!, "task-1-e1/argv.txt"), "utf8")).toContain("PROFILE-APPEND-MARKER");
}, 180_000);
