// ADR-026 §2 against a real engine and runner, with the fake claude in a host-exec sandbox (fake-host): an agent of a
// run saves its CLI session into the daemon's state (`<CAPCOMD_HOME>/state/sessions/<run>/<agent>/`, gzipped, 0600)
// as it runs, and restoreSession puts it back on a fresh machine where Claude Code looks for it from the new checkout.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Engine } from "../helpers/test-engine";
import { capcomd, testPort } from "../helpers/engine";
import { bareRepo } from "../merge/gitfixture";
import { FakeProvider } from "../../src/providers/fake";
import { latestSession, readSession } from "../../src/sessions/store";
import { restoreSession } from "../../src/sessions/restore";
import { claudeProjectSlug } from "../../src/plugins/agent-claude";

let engine: Engine;
let env: Record<string, string>;
let dir = "";
const saved = { ...process.env };
const KEY = "sk-ant-api03-SESSIONS-abcdefghijklmnopqrstuvwxyz0123456789";

beforeAll(async () => {
  const r = await bareRepo({ mode: "direct" });
  dir = mkdtempSync(join(tmpdir(), "capcomd-sessions-engine-"));
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
    CAPCOMD_SKIP_PREFLIGHT: "1",
    CAPCOMD_TRACE_DIR: join(dir, "traces"),
    CAPCOMD_AUTH_LEDGER: join(dir, "auths.json"),
    CAPCOMD_ENV_LEDGER: join(dir, "envs.json"),
    CAPCOMD_RPC_KEY: `sessions-${Math.random()}`,
    // Never the real iCloud Drive, whatever the user config says.
    CAPCOMD_SESSIONS_REPLICA: "none",
    ANTHROPIC_API_KEY: KEY,
    CAPCOMD_ENV: "image",
  };
  Object.assign(process.env, env);
  const port = await testPort();
  engine = new Engine("sess-save", { port, dataDir: join(dir, "engine") });
  await engine.start(null);
  env.CAPCOMD_ENDPOINT = `http://127.0.0.1:${port}`;
  process.env.CAPCOMD_ENDPOINT = env.CAPCOMD_ENDPOINT;
}, 120_000);

const fresh = mkdtempSync(join(tmpdir(), "capcomd-sessions-fresh-"));
afterAll(async () => {
  await engine?.stop();
  for (const k of Object.keys(env ?? {})) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  // The engine's data and the machines' folders are big: not left behind.
  for (const d of [dir, fresh]) if (d) rmSync(d, { recursive: true, force: true });
});

const cj = async (args: string[]) => {
  const x = await capcomd([...args, "--json"], env);
  let j: any = null;
  try { j = JSON.parse(x.stdout.trim().split("\n").pop()!); } catch {}
  return { ...x, j };
};

test("an agent's session is saved into the daemon's state as it runs, and restores onto a fresh machine", async () => {
  const run = (await cj(["run", "new", "--key", `sessions-${Date.now()}`])).j.runId as string;
  const spawned = await cj(["spawn", run, "--profile", "worker", "--task", "fix it [session-folder] [session-secret]", "--key", "w1"]);
  const id = spawned.j?.agentId as string;
  expect(id).toMatch(/^agt-/);
  const done = (await cj(["await", run, id, "--timeout-ms", "90000"])).j?.agents?.[0];
  if (done?.status !== "done") console.log(JSON.stringify(done), (await cj(["logs", run, id])).stdout);
  expect(done?.status).toBe("done");

  // In the daemon's state, under the run and the agent: the record and the gzipped segments, private.
  const host = join(dir, "home", "state", "sessions", run, id);
  expect(statSync(host).mode & 0o777).toBe(0o700);
  expect(statSync(join(host, "ref.json")).mode & 0o777).toBe(0o600);
  const ref = await latestSession(run, id);
  const vm = join(dir, "vm", readdirSync(join(dir, "vm")).find((d) => d.includes("e1"))!);
  const argv = readFileSync(join(vm, "argv.txt"), "utf8").split("\n");
  expect(ref).toMatchObject({ cli: "claude", sessionId: argv[argv.indexOf("--session-id") + 1], file: `${argv[argv.indexOf("--session-id") + 1]}.jsonl` });
  const text = new TextDecoder().decode((await readSession(run, id))!.file);
  expect(text).toContain("fix it [session-folder]");
  expect(text).not.toContain(KEY);

  // A fresh machine (another work folder): the file lands where Claude Code looks from the new checkout.
  const provider = new FakeProvider({ hostExec: true });
  const { id: machineId } = await provider.ensure({ idemKey: `fresh-${Math.random()}`, isolated: true, ttlSeconds: 60, egressAllow: ["*"], labels: {} });
  await provider.waitReady(machineId, 1000);
  const home = join(fresh, "home"), cwd = join(fresh, id, "repo");
  expect(await restoreSession({ runId: run, agentId: id, provider, machineId, home, cwd })).toEqual({ sessionId: ref!.sessionId, cli: "claude" });
  const dirOf = join(home, ".claude", "projects", claudeProjectSlug(cwd));
  expect(readFileSync(join(dirOf, ref!.file), "utf8")).toBe(text);
  expect(existsSync(join(dirOf, ref!.sessionId, "subagents", "agent-a1.jsonl"))).toBe(true);
}, 120_000);
