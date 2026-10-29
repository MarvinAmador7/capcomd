// A run the daemon starts for a project (POST /v1/runs {repo, driver}, as the menu bar app starts every run) runs its
// agents with that project's profiles (.capcomd/agents.json, written by `capcomd setup project`), which the daemon's own
// agents file doesn't have. `capcomd run --detach` resolves them in the project's directory and records each agent's
// spec; the engine (the daemon's `serve`, elsewhere) runs the worker from that spec. It used to look the profile up by
// name in its own file, so the planner failed ~5 s in with "An internal error occurred" (unknown agent profile).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Engine } from "../chaos/engine";
import { testPort } from "../helpers/engine";
import { bareRepo } from "../merge/gitfixture";
import { addClient, loadClients } from "../../src/api/clients";
import { rivetSource } from "../../src/api/rivet-source";
import { harnessApp } from "../../src/api/server";
import { harnessState } from "../../src/api/state";

let engine: Engine;
let env: Record<string, string>;
let app: ReturnType<typeof harnessApp>;
let token = "";
let project = "";
let home = "";
const saved = { ...process.env };

beforeAll(async () => {
  const r = await bareRepo({ mode: "direct" });
  const dir = mkdtempSync(join(tmpdir(), "capcomd-projprof-"));
  home = join(dir, "home");
  // The project, as `capcomd setup project` leaves it: its repository settings and its own profiles.
  project = join(dir, "project");
  mkdirSync(join(project, ".capcomd"), { recursive: true });
  writeFileSync(join(project, ".capcomd", "config.json"), JSON.stringify({ env: { CAPCOMD_REPO: r.env.CAPCOMD_REPO, CAPCOMD_MERGE_MODE: "direct", CAPCOMD_MERGE_TARGET: "main", CAPCOMD_WORKDIR: r.env.CAPCOMD_WORKDIR } }));
  writeFileSync(join(project, ".capcomd", "agents.json"), JSON.stringify({ schema: "capcomd.agents/v1", agents: {
    planner: { provider: "claude", auth: "apikey", maxTurns: 20, children: { allowSpawn: true, allowedChildProfiles: ["worker"] } },
    worker: { provider: "claude", auth: "apikey", maxTurns: 20 },
  } }));
  // The daemon: its own home, whose agents file defines neither profile, and no repository of its own.
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "agents.json"), JSON.stringify({ schema: "capcomd.agents/v1", agents: { other: { provider: "codex", auth: "apikey" } } }));
  for (const k of Object.keys(process.env)) if (/^(CAPCOMD|RELAY)_(REPO|AGENTS_FILE|MERGE_|WORKDIR|TEST_COMMAND|GITHUB_)/.test(k)) delete process.env[k];
  env = {
    CAPCOMD_HOME: home,
    CAPCOMD_HARNESS_SOCKET: join(home, "h.sock"),
    CAPCOMD_SANDBOX: "fake-host",
    CAPCOMD_AGENT_CLAUDE_BIN: new URL("../agents/fake-claude.sh", import.meta.url).pathname,
    CAPCOMD_AGENT_WORKDIR: join(dir, "vm"),
    CAPCOMD_AGENT_POLL_MS: "100",
    CAPCOMD_VM_RPC_POLL_MS: "200",
    CAPCOMD_SKIP_PREFLIGHT: "1",
    CAPCOMD_TRACE_DIR: join(dir, "traces"),
    CAPCOMD_AUTH_LEDGER: join(dir, "auths.json"),
    CAPCOMD_ENV_LEDGER: join(dir, "envs.json"),
    ANTHROPIC_API_KEY: "sk-ant-api03-PROJPROF-abcdefghijklmnopqrstuvwxyz0123456789",
    CAPCOMD_ENV: "image",
  };
  Object.assign(process.env, env);
  const port = await testPort();
  engine = new Engine("projprof", { port, dataDir: join(dir, "engine") });
  await engine.start(null);
  env.CAPCOMD_ENDPOINT = `http://127.0.0.1:${port}`;
  process.env.CAPCOMD_ENDPOINT = env.CAPCOMD_ENDPOINT;
  const clients = join(dir, "clients.json");
  token = addClient("menubar", ["read", "steer"], clients).token;
  app = harnessApp({ source: rivetSource(), clients: () => loadClients(clients), state: harnessState(null), pollMs: 100 });
}, 120_000);

afterAll(async () => {
  await engine?.stop();
  for (const k of Object.keys(process.env)) if (saved[k] === undefined) delete process.env[k];
  Object.assign(process.env, saved);
});

const req = (path: string, init: RequestInit = {}) => app.request(path, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) } });

test("a project run started through the daemon gets past provisioning with the project's planner profile", async () => {
  // The app asks first: in the project's context, Claude can drive (the daemon's own file has no planner).
  const opts = await (await req(`/v1/run-options?repo=${encodeURIComponent(project)}`)).json() as any;
  expect(opts.drivers.find((d: any) => d.provider === "claude")).toMatchObject({ available: true, default: true });

  const res = await req("/v1/runs", { method: "POST", headers: { "idempotency-key": "key-projprof-1" }, body: JSON.stringify({ goal: "make the failing test pass", repo: project, driver: "claude" }) });
  const run = await res.json() as any;
  expect(res.status).toBe(201);
  const runId = run.id as string;

  let planner: any = null;
  for (let i = 0; i < 240; i++) {
    const r = await req(`/v1/runs/${runId}/agents`);
    if (r.status === 200) {
      const agents = await r.json() as any[];
      planner = agents.find((a) => a.profile === "planner") ?? null;
      if (planner && ["done", "failed", "cancelled"].includes(planner.status)) break;
    }
    await Bun.sleep(500);
  }
  const drivers = join(home, "state", "drivers");
  const logs = existsSync(drivers) ? readdirSync(drivers).filter((f) => f.endsWith(".log")).map((f) => readFileSync(join(drivers, f), "utf8")).join("\n") : "";
  if (planner?.status !== "done") console.log(JSON.stringify(planner, null, 2), logs);
  expect(logs).not.toContain("An internal error occurred");
  expect(logs).not.toContain("unknown agent profile");
  expect(planner?.status).toBe("done");
  // The planner really ran (the fake claude got its brief in the "VM").
  const seen = readdirSync(env.CAPCOMD_AGENT_WORKDIR!, { recursive: true }).map(String).filter((f) => f.endsWith("prompt-seen.txt"));
  expect(seen.length).toBeGreaterThan(0);
}, 180_000);

test("a configuration problem on the engine side crosses with its message (code config), not as an internal error", async () => {
  const { client } = await import("../../src/core/relay");
  const runId = `run-cfg${Date.now().toString(36)}`;
  // An agent without a recorded spec (older records) is looked up by name in the daemon's file, which lacks it.
  const w = client().worker.getOrCreate([runId, "agt-cfg"]);
  let e: any = null;
  try { await w.provisionWorker({ workerId: "agt-cfg", runId, epoch: 1, agent: "planner" }); } catch (x) { e = x; }
  expect(e).not.toBeNull();
  expect(e.code).toBe("config");
  expect(String(e.message)).toContain('unknown agent profile "planner" (defined: other');
  // A recorded spec wins over the name: the same call with the spawn-time spec gets a VM.
  const ok = await w.provisionWorker({ workerId: "agt-cfg", runId, epoch: 1, agent: "planner", agentSpec: { provider: "claude", auth: "apikey", kind: "claude-code" } });
  expect(ok).toMatchObject({ workerId: "agt-cfg", state: "idle" });
  await w.drainWorker({ workerId: "agt-cfg" });
}, 60_000);
