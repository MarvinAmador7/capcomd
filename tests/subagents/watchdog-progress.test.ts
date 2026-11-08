// The watchdog's progress from real activity (docs/spec/plugin-api.md §16.4), the whole way: fake claude workers in a
// host-exec FakeProvider, spawned through a daemon with the watchdog on and a stall limit of 8 s, far shorter than the
// 10 minutes between checkpoints. The in-VM supervisor fingerprints each checkout at its heartbeats, the runner reads
// the CLI's Bash calls, and the worker hands both to the scope as `worked` (src/actors/worker.ts), which the watchdog
// hears as agent.changed. One worker edits a file for 16 s, one waits on a 10 s command, one sits silent for 16 s: only
// the silent one gets `stalled`, and its notice says what was seen. (tests/scenarios/watchdog-progress.test.ts has the
// same with the reports faked and a 90 s limit.)
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Engine } from "../helpers/test-engine";
import { capcomd, testPort } from "../helpers/engine";
import { bareRepo } from "../merge/gitfixture";

const STALLED_MS = 8_000;
let engine: Engine;
let env: Record<string, string>;
const saved = { ...process.env };

beforeAll(async () => {
  const r = await bareRepo({ mode: "direct" });
  const dir = mkdtempSync(join(tmpdir(), "capcomd-wd-progress-"));
  const agentsFile = join(dir, "agents.json");
  writeFileSync(agentsFile, JSON.stringify({ schema: "capcomd.agents/v1", agents: { worker: { provider: "claude", auth: "apikey" } } }));
  env = {
    ...r.env,
    CAPCOMD_AGENTS_FILE: agentsFile,
    CAPCOMD_SANDBOX: "fake-host",
    CAPCOMD_AGENT_CLAUDE_BIN: new URL("../agents/fake-claude.sh", import.meta.url).pathname,
    CAPCOMD_AGENT_WORKDIR: join(dir, "vm"),
    CAPCOMD_AGENT_POLL_MS: "100",
    // A heartbeat (the supervisor's, and the runner's reports) every second.
    CAPCOMD_STUCK_AFTER_MS: "4000",
    CAPCOMD_DRIVER_LEASE_MS: "3000",
    CAPCOMD_SKIP_PREFLIGHT: "1",
    CAPCOMD_TRACE_DIR: join(dir, "traces"),
    CAPCOMD_AUTH_LEDGER: join(dir, "auths.json"), // never the checkout's real .relay/ ledgers
    CAPCOMD_ENV_LEDGER: join(dir, "envs.json"),
    ANTHROPIC_API_KEY: "sk-ant-api03-WDPROGRESS-abcdefghijklmnopqrstuvwxyz0123456789",
    CAPCOMD_ENV: "image",
    CAPCOMD_PLUGIN_WATCHDOG_ENABLED: "true",
    CAPCOMD_PLUGIN_WATCHDOG_STALLEDAFTERMS: String(STALLED_MS),
    CAPCOMD_PLUGIN_WATCHDOG_STOPAFTERMS: "0",
    CAPCOMD_PLUGIN_WATCHDOG_EVERYMS: "1000", // (its minimum)
  };
  Object.assign(process.env, env); // the engine (actors) inherits process.env
  const port = await testPort();
  engine = new Engine("wd-progress", { port, dataDir: join(dir, "engine") });
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

test("with an 8 s limit: a worker editing files and one waiting on a command aren't flagged, a silent one is", async () => {
  const run = (await cj(["run", "new"])).j?.runId;
  expect(run).toMatch(/^run-/);
  const spawn = async (task: string, key: string) => (await cj(["spawn", run, "--profile", "worker", "--task", task, "--key", key])).j?.agentId as string;
  const editor = await spawn("[editing:16] keep editing the notes", "editor");
  const commander = await spawn("[command:10] run the tests", "commander");
  const silent = await spawn("[quiet:16] think it over", "silent");
  for (const id of [editor, commander, silent]) expect(id).toMatch(/^agt-/);
  const agents = (await cj(["await", run, editor, commander, silent, "--timeout-ms", "90000"])).j?.agents ?? [];
  expect(agents.map((a: any) => a.status)).toEqual(["done", "done", "done"]);

  const evs: any[] = (await cj(["events", run])).j?.events ?? [];
  const stalled = evs.filter((e) => e.type === "AGENT_NOTICE" && e.event?.kind === "stalled");
  expect(stalled.map((e) => e.agentId)).toEqual([silent]);
  expect(stalled[0].event.detail).toMatch(/^no progress for \d+ s: no file change seen, no agent of its own started or ended, no check or approval it waited on finished; (no tool step|\d+ tool steps?) seen meanwhile$/);
  // No checkpoint came (they are 10 minutes apart): what the watchdog saw was the runners' reports.
  expect(evs.filter((e) => e.type === "AGENT_CHECKPOINT")).toEqual([]);
}, 150_000);
