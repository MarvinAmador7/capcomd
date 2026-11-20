// The setup the ADR-022 workflow tests share (workflow-restart, workflow-step, workflow-long-step, workflow-upgrade*):
// one engine with the agent workflow on, fake claude in a host-exec FakeProvider whose "VM" (a work dir) outlives the
// daemon, and readers that never start, kick or wake anything (only the scope's record is read). One engine per file:
// the files are split so that no one of them dominates a parallel run.
import { afterAll, beforeAll, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Engine } from "../helpers/test-engine";
import { capcomd, sleep, testPort } from "../helpers/engine";
import { bareRepo } from "../merge/gitfixture";

export interface WorkflowEngine {
  engine: Engine;
  env: Record<string, string>;
  /** The fake provider's machines: an agent works in `<vm>/<agentId>` (the same dir every epoch, ADR-026 §2). */
  vm: string;
  /** The test's own scratch dir (ledgers and the outage file live here). */
  dir: string;
  cj(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string; j: any }>;
  /** This run's `capcomd agent-drive` processes (there must never be one with the workflow on). */
  drivers(run: string): string[];
  /** The agent as the scope records it: reading it never starts, kicks or wakes anything. */
  scopeAgent(run: string, id: string): Promise<any>;
  /** Wait (reading the scope only) for a status, checking there's never a driver process. */
  untilStatus(run: string, id: string, status: string, ms: number): Promise<any>;
}

/** Start the engine before the file's tests (and stop it after): `agents` are the profiles, `extra` more env. */
export function workflowEngine(label: string, agents: Record<string, unknown>, extra: (dir: string) => Record<string, string> = () => ({})): WorkflowEngine {
  const saved = { ...process.env };
  const w = { env: {} as Record<string, string>, vm: "", dir: "" } as WorkflowEngine;
  w.cj = async (args) => {
    const x = await capcomd([...args, "--json"], w.env);
    let j: any = null;
    try { j = JSON.parse(x.stdout.trim().split("\n").pop()!); } catch {}
    return { ...x, j };
  };
  w.drivers = (run) => Bun.spawnSync(["ps", "-A", "-o", "command="]).stdout.toString().split("\n").filter((l) => l.includes(` agent-drive ${run} `));
  w.scopeAgent = async (run, id) => {
    const { client } = await import("../../src/core/relay");
    return client().scope.getOrCreate([run]).getAgent({ agentId: id }).catch(() => null);
  };
  w.untilStatus = async (run, id, status, ms) => {
    const end = Date.now() + ms;
    let a: any = null;
    while (Date.now() < end) {
      expect(w.drivers(run)).toEqual([]);
      a = await w.scopeAgent(run, id);
      if (a?.status === status) return a;
      await sleep(500);
    }
    throw new Error(`${id} never reached ${status} (last: ${a?.status})`);
  };

  beforeAll(async () => {
    const r = await bareRepo({ mode: "direct" });
    const dir = (w.dir = mkdtempSync(join(tmpdir(), `capcomd-${label}-`)));
    const agentsFile = join(dir, "agents.json");
    writeFileSync(agentsFile, JSON.stringify({ schema: "capcomd.agents/v1", agents }));
    w.vm = join(dir, "vm");
    w.env = {
      ...r.env,
      CAPCOMD_AGENT_WORKFLOW: "1",
      CAPCOMD_HOME: join(dir, "home"),
      CAPCOMD_AGENTS_FILE: agentsFile,
      CAPCOMD_SANDBOX: "fake-host",
      CAPCOMD_AGENT_CLAUDE_BIN: new URL("../agents/fake-claude.sh", import.meta.url).pathname,
      CAPCOMD_AGENT_WORKDIR: w.vm,
      CAPCOMD_AGENT_POLL_MS: "100",
      CAPCOMD_DRIVER_LEASE_MS: "3000",
      CAPCOMD_SKIP_PREFLIGHT: "1",
      CAPCOMD_TRACE_DIR: join(dir, "traces"),
      CAPCOMD_AUTH_LEDGER: join(dir, "auths.json"),
      CAPCOMD_ENV_LEDGER: join(dir, "envs.json"),
      ANTHROPIC_API_KEY: "sk-ant-api03-WORKFLOW-abcdefghijklmnopqrstuvwxyz0123456789",
      CAPCOMD_ENV: "image",
      ...extra(dir),
    };
    Object.assign(process.env, w.env); // the engine (actors) inherits process.env
    delete process.env.CAPCOMD_WORKFLOW_DRILL; // the upgrade drill's next shape: only where a test sets it
    const port = await testPort();
    w.engine = new Engine(label, { port, dataDir: join(dir, "engine") });
    await w.engine.start(null);
    w.env.CAPCOMD_ENDPOINT = `http://127.0.0.1:${port}`;
    process.env.CAPCOMD_ENDPOINT = w.env.CAPCOMD_ENDPOINT;
  }, 120_000);

  afterAll(async () => {
    await w.engine?.stop();
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  });

  return w;
}
