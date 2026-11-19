// An agent's setup is its activity until its CLI's first step (capability agents.setup): against a real engine, a
// spawned agent (the fake claude in a host-exec FakeProvider, its repository copied a chunk at a time) reads, over GET
// /v1/runs/{runId}/agents, as kind setup with the phase the daemon is in (the copy with its bytes of the total), and
// its own activity replaces that once it works. Before, its thread pane stayed empty for the whole setup.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomBytes } from "crypto";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Engine } from "../helpers/test-engine";
import { capcomd, testPort } from "../helpers/engine";
import { bareRepo } from "../merge/gitfixture";
import { addClient, loadClients } from "../../src/api/clients";
import { AgentActivity } from "../../src/api/contract";
import { rivetSource } from "../../src/api/rivet-source";
import { harnessApp } from "../../src/api/server";
import { harnessState } from "../../src/api/state";

let engine: Engine;
let env: Record<string, string>;
let app: ReturnType<typeof harnessApp>;
let token = "";
const saved = { ...process.env };

beforeAll(async () => {
  const r = await bareRepo({ mode: "direct" });
  // A repository big enough that its copy takes many chunks.
  writeFileSync(join(r.root, "seed", "big.bin"), randomBytes(4 * 1024 * 1024));
  await r.seed.ok(["add", "big.bin"]);
  await r.seed.ok(["commit", "-q", "-m", "big"]);
  await r.seed.ok(["push", "-q", "origin", "main"]);
  const dir = mkdtempSync(join(tmpdir(), "capcomd-setup-"));
  const agentsFile = join(dir, "agents.json");
  writeFileSync(agentsFile, JSON.stringify({ schema: "capcomd.agents/v1", agents: { worker: { provider: "claude", auth: "apikey", maxTurns: 20 } } }));
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
    ANTHROPIC_API_KEY: "sk-ant-api03-SETUP-abcdefghijklmnopqrstuvwxyz0123456789",
    CAPCOMD_ENV: "image",
    CAPCOMD_TRANSFER_CHUNK_BYTES: String(32 * 1024),
  };
  Object.assign(process.env, env);
  const port = await testPort();
  engine = new Engine("setup-activity", { port, dataDir: join(dir, "engine") });
  await engine.start(null);
  env.CAPCOMD_ENDPOINT = `http://127.0.0.1:${port}`;
  process.env.CAPCOMD_ENDPOINT = env.CAPCOMD_ENDPOINT;
  const clients = join(dir, "clients.json");
  token = addClient("menubar", ["read"], clients).token;
  app = harnessApp({ source: rivetSource(), clients: () => loadClients(clients), state: harnessState(null), pollMs: 100 });
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
const get = async (p: string) => (await app.request(p, { headers: { authorization: `Bearer ${token}` } }));

test("an agent's setup reads as its activity, phase by phase (the copy with its bytes), until its own first step", async () => {
  const run = (await cj(["run", "new"])).j?.runId;
  expect(run).toMatch(/^run-/);
  const a = (await cj(["spawn", run, "--profile", "worker", "--task", "[slow] make the failing test pass", "--key", "w"])).j?.agentId;
  expect(a).toMatch(/^agt-/);
  // What a client sees, polled as the app's snapshot would be.
  const seen: any[] = [];
  const until = Date.now() + 90_000;
  let status = "";
  while (Date.now() < until && !["done", "failed", "cancelled"].includes(status)) {
    const agents = await (await get(`/v1/runs/${run}/agents`)).json() as any[];
    const me = agents.find((x) => x.id === a);
    status = me?.status ?? "";
    if (me?.activity && JSON.stringify(me.activity) !== JSON.stringify(seen.at(-1))) seen.push(me.activity);
    await Bun.sleep(30);
  }
  expect(status).toBe("done");
  for (const s of seen) expect(AgentActivity.safeParse(s).success).toBe(true);
  const setups = seen.filter((s) => s.kind === "setup");
  const phases = setups.map((s) => s.setup.phase);
  // The machine comes first (on this host it is ready at once: a poll may miss it); the copy is seen with its bytes of
  // the whole; the CLI's start last of all.
  expect(["machine", "workspace"]).toContain(phases[0]);
  expect(phases.lastIndexOf("machine")).toBeLessThanOrEqual(0);
  const copy = setups.find((s) => s.setup.phase === "copy");
  expect(copy).toBeTruthy();
  expect(copy.setup.totalBytes).toBeGreaterThan(4 * 1024 * 1024);
  expect(copy.text).toMatch(/^Copying the repository · \d+% \([\d.]+ of [\d.]+ MB\)$/);
  // Once it works, its own activity replaces the setup, and no setup line comes back after that.
  const own = seen.findIndex((s) => s.kind !== "setup");
  expect(own).toBeGreaterThan(0);
  expect(seen.slice(own).every((s) => s.kind !== "setup")).toBe(true);
  expect(phases.indexOf("agent")).toBe(phases.length - 1);
}, 120_000);
