// ADR-018 phase 1: an agent with no shell drives a swarm through `capcomd mcp` alone. A real MCP client
// (stdio) against the server, a private engine, a bare git repo, fake agents. The project's
// .capcomd/config.json holds the gates (named checks, target); the driver can't change them.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Engine } from "../chaos/engine";
import { CLI, capcomd, testPort } from "../helpers/engine";
import { bareRepo } from "../merge/gitfixture";
import { primitivesAgentsFile } from "../primitives/helpers";

const CHECK = 'test -f "tasks/$CAPCOMD_TASK_ID.md"';
let engine: Engine;
let env: Record<string, string>;
let project: string;
let repo: Awaited<ReturnType<typeof bareRepo>>;
let mcp: Client;
const saved = { ...process.env };

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const res: any = await mcp.callTool({ name, arguments: args });
  return { isError: !!res.isError, body: JSON.parse(res.content[0].text) };
};
const ok = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await call(name, args);
  if (r.isError) throw new Error(`${name}: ${JSON.stringify(r.body)}`);
  return r.body;
};
/** Call a bounded tool until it stops answering "running". */
const settle = async (name: string, args: Record<string, unknown>) => {
  for (let i = 0; i < 30; i++) {
    const b = await ok(name, { ...args, timeoutMs: 5000 });
    if (b.state !== "running") return b;
  }
  throw new Error(`${name} never settled`);
};
const filesOn = async (branch: string) => {
  await repo.seed.ok(["fetch", "-q", "origin"]);
  return (await repo.seed.ok(["ls-tree", "-r", "--name-only", `origin/${branch}`])).split("\n");
};

beforeAll(async () => {
  repo = await bareRepo({ mode: "direct", extraEnv: { CAPCOMD_MERGE_TARGET: "trunk", CAPCOMD_PROTECTED_BRANCHES: "trunk,release/*" } });
  await repo.seed.ok(["push", "-q", "origin", "main:trunk"]);
  const home = mkdtempSync(join(tmpdir(), "capcomd-mcp-home-"));
  project = mkdtempSync(join(tmpdir(), "capcomd-mcp-project-"));
  mkdirSync(join(project, ".capcomd"));
  writeFileSync(join(project, ".capcomd", "config.json"), JSON.stringify({ run: { checks: { unit: CHECK }, target: "trunk" }, driver: { maxRunBudget: "usd=20" } }));
  env = { ...repo.env, CAPCOMD_HOME: home, CAPCOMD_AGENTS_FILE: primitivesAgentsFile(), CAPCOMD_SPAWN_EXEC: "fake", CAPCOMD_AWAIT_POLL_MS: "100", CAPCOMD_DRIVER_LEASE_MS: "3000", CAPCOMD_SKIP_PREFLIGHT: "1", CAPCOMD_NO_ENGINE_AUTOSTART: "1" };
  Object.assign(process.env, env);
  const port = await testPort();
  engine = new Engine("mcp-driver", { port, dataDir: mkdtempSync(join(tmpdir(), "capcomd-mcp-engine-")) });
  await engine.start(null);
  env.CAPCOMD_ENDPOINT = `http://127.0.0.1:${port}`;
  process.env.CAPCOMD_ENDPOINT = env.CAPCOMD_ENDPOINT;
  // The server reads the project's config (tests preload CAPCOMD_NO_CONFIG=1 for everything else).
  const childEnv = { ...process.env, ...env } as Record<string, string>;
  delete childEnv.CAPCOMD_NO_CONFIG;
  connectEnv = childEnv;
  await connect();
}, 120_000);

let connectEnv: Record<string, string>;
/** A new agent session: a fresh `capcomd mcp` process. */
async function connect() {
  await mcp?.close();
  mcp = new Client({ name: "driver-test", version: "0.0.1" });
  await mcp.connect(new StdioClientTransport({ command: "bun", args: [CLI, "mcp"], cwd: project, stderr: "ignore", env: connectEnv }));
}

afterAll(async () => {
  await mcp?.close();
  await engine?.stop();
  for (const k of Object.keys(env ?? {})) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
});

describe("capcomd mcp: the driver's tools", () => {
  test("lists the primitives, with read-only and destructive annotations", async () => {
    const { tools } = await mcp.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "capcomd_approve", "capcomd_await", "capcomd_budget", "capcomd_cancel", "capcomd_events", "capcomd_inspect", "capcomd_kv",
      "capcomd_merge", "capcomd_profiles", "capcomd_run_new", "capcomd_runs", "capcomd_send", "capcomd_setup", "capcomd_spawn",
      "capcomd_task", "capcomd_trace", "capcomd_tree", "capcomd_verify",
    ]);
    const by = Object.fromEntries(tools.map((t) => [t.name, t.annotations ?? {}]));
    for (const n of ["capcomd_merge", "capcomd_cancel", "capcomd_approve"]) expect(by[n]!.destructiveHint).toBe(true);
    for (const n of ["capcomd_tree", "capcomd_await", "capcomd_setup", "capcomd_events"]) expect(by[n]!.readOnlyHint).toBe(true);
  });

  test("setup reports the project's gates", async () => {
    const s = await ok("capcomd_setup");
    expect(s.gates).toMatchObject({ checks: { unit: CHECK }, target: "trunk" });
    expect(s.driver).toMatchObject({ approvals: "human", maxRunBudget: "usd=20" });
    expect((await ok("capcomd_profiles")).profiles.map((p: any) => p.name).sort()).toEqual(["coder", "sup"]);
  });

  test("fan-out on a staging target: spawn 3, await, verify, merge each; only verified commits land", async () => {
    const r = await ok("capcomd_run_new", { budget: "usd=10,turns=200", label: "fan-out", target: "capcomd/fanout", targetFrom: "trunk", key: `fo-${Date.now()}` });
    expect(r.gates.checks).toEqual(["unit"]);
    const run = r.runId as string;
    const ids: string[] = [];
    for (const t of ["a", "b", "c"]) ids.push((await ok("capcomd_spawn", { runId: run, task: `work ${t}`, profile: "coder", check: "unit", budget: "usd=1,turns=10", key: t })).agentId);

    let pending = ids;
    const done: string[] = [];
    while (pending.length) {
      const w = await ok("capcomd_await", { runId: run, agents: pending, mode: "any", timeoutMs: 10_000 });
      for (const d of w.done) { expect(d.status).toBe("done"); if (!done.includes(d.agentId)) done.push(d.agentId); }
      pending = pending.filter((x) => !done.includes(x));
    }
    for (const id of ids) {
      const v = await settle("capcomd_verify", { runId: run, ref: id });
      expect(v.state).toBe("passed");
      const m = await settle("capcomd_merge", { runId: run, ref: id, require: v.id });
      expect(m).toMatchObject({ state: "merged", result: { merged: true } });
    }
    const files = await filesOn("capcomd/fanout");
    expect(files.filter((f) => f.startsWith("tasks/")).length).toBe(3);
    expect(await filesOn("trunk")).not.toContain(files.find((f) => f.startsWith("tasks/")));

    // Durable and findable: a new session (the old one is gone) lists the run and its finished agents.
    await connect();
    const listed = (await ok("capcomd_runs")).runs.find((x: any) => x.runId === run);
    expect(listed).toMatchObject({ label: "fan-out", agents: { done: 3 } });
    expect((await ok("capcomd_tree", { runId: run })).runId).toBe(run);
  }, 180_000);

  test("gates stay the human's: protected target, budget cap, reserved kv, approvals", async () => {
    const rel = await call("capcomd_run_new", { budget: "usd=5", target: "release/1" });
    expect(rel.isError).toBe(true);
    expect(rel.body.error.reason).toBe("forbidden");
    const big = await call("capcomd_run_new", { budget: "usd=50" });
    expect(big.body.error.reason).toBe("forbidden");
    expect(big.body.error.hint).toContain("usd=20");

    // The project's own target (trunk, protected here) is allowed; its merges park for a person.
    const run = (await ok("capcomd_run_new", { budget: "usd=5,turns=100", key: `gt-${Date.now()}` })).runId as string;
    const reserved = await call("capcomd_kv", { runId: run, action: "put", k: "_checks", value: { unit: "true" } });
    expect(reserved.body.error.reason).toBe("forbidden");
    await ok("capcomd_kv", { runId: run, action: "put", k: "plan", value: { files: 1 } });
    expect((await ok("capcomd_kv", { runId: run, action: "get", k: "plan" })).writer).toBe("driver");

    const a = (await ok("capcomd_spawn", { runId: run, task: "work p", profile: "coder", check: "unit", key: "p" })).agentId;
    for (;;) { const w = await ok("capcomd_await", { runId: run, agents: [a], timeoutMs: 10_000 }); if (!w.pending.length) break; }
    const v = await settle("capcomd_verify", { runId: run, ref: a });
    const m = await settle("capcomd_merge", { runId: run, ref: a, require: v.id });
    expect(m.state).toBe("awaiting_approval");
    expect(m.next).toContain(`capcomd approve ${run} ${m.id}`);
    const ap = await call("capcomd_approve", { runId: run, merge: m.id });
    expect(ap.body.error.reason).toBe("forbidden");
    expect(ap.body.error.hint).toContain(`capcomd approve ${run} ${m.id}`);
    expect((await ok("capcomd_tree", { runId: run })).pendingApprovals.map((p: any) => p.taskId)).toEqual([m.id]);

    // A person approves; it lands.
    const human = await capcomd(["approve", run, m.id, "--json"], env);
    expect(human.code).toBe(0);
    expect(JSON.parse(human.stdout.trim().split("\n").pop()!)).toMatchObject({ id: m.id, state: "merged" });
    expect((await filesOn("trunk")).some((f) => f.startsWith("tasks/"))).toBe(true);
  }, 180_000);

  test("errors are typed and say what to do next", async () => {
    const r = await call("capcomd_merge", { runId: "run-nope", ref: "agt-nope", require: "vfy-nope" });
    expect(r.isError).toBe(true);
    expect(r.body.error.hint.length).toBeGreaterThan(0);
  });
});
