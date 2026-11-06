// ADR-018 phase 1: an agent with no shell drives a swarm through `capcomd mcp` alone. A real MCP client
// (stdio) against the server, a private engine, a bare git repo, fake agents. The project's
// .capcomd/config.json holds the gates (named checks, target); the driver can't change them.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { Engine } from "../helpers/test-engine";
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
  if (!res.content?.[0]?.text?.startsWith("{")) throw new Error(`${name}: ${res.content?.[0]?.text}`);
  return { isError: !!res.isError, body: JSON.parse(res.content[0].text) };
};
const ok = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await call(name, args);
  if (r.isError) throw new Error(`${name}: ${JSON.stringify(r.body)}`);
  return r.body;
};
/** Call a bounded tool until it stops answering "running": the first call starts the verify or merge, the next ones
 *  poll it by the id it answered (another call with the ref and no id or key would start a new one each time). */
const settle = async (name: string, args: Record<string, unknown>) => {
  let b = await ok(name, { ...args, timeoutMs: 5000 });
  for (let i = 0; i < 30 && b.state === "running"; i++) b = await ok(name, { runId: args.runId, id: b.id, timeoutMs: 5000 });
  if (b.state === "running") throw new Error(`${name} never settled`);
  return b;
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
  writeFileSync(join(project, ".capcomd", "config.json"), JSON.stringify({ run: { checks: { unit: CHECK, slow: `sleep 6; ${CHECK}` }, target: "trunk" }, driver: { maxRunBudget: "usd=20" } }));
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
      "capcomd_approve", "capcomd_await", "capcomd_budget", "capcomd_cancel", "capcomd_check", "capcomd_events", "capcomd_goal", "capcomd_grant", "capcomd_inspect", "capcomd_kv",
      "capcomd_merge", "capcomd_pr_open", "capcomd_profiles", "capcomd_projects", "capcomd_resume", "capcomd_run_new", "capcomd_runs", "capcomd_send", "capcomd_setup", "capcomd_spawn",
      "capcomd_task", "capcomd_title", "capcomd_trace", "capcomd_tree", "capcomd_verify",
    ]);
    const by = Object.fromEntries(tools.map((t) => [t.name, t.annotations ?? {}]));
    for (const n of ["capcomd_merge", "capcomd_cancel", "capcomd_approve", "capcomd_pr_open"]) expect(by[n]!.destructiveHint).toBe(true);
    for (const n of ["capcomd_tree", "capcomd_await", "capcomd_setup", "capcomd_events"]) expect(by[n]!.readOnlyHint).toBe(true);
    // A stopped run's pull request needs the person's yes, passed as `stopped`; the description says to ask first.
    const pr = tools.find((t) => t.name === "capcomd_pr_open")!;
    expect((pr.inputSchema.properties as Record<string, any>).stopped).toMatchObject({ type: "boolean" });
    expect(pr.description).toContain("ask the person that question first");
  });

  test("setup reports the project's gates", async () => {
    const s = await ok("capcomd_setup");
    expect(s.gates).toMatchObject({ checks: { unit: CHECK }, target: "trunk" });
    expect(s.driver).toMatchObject({ approvals: "human", maxRunBudget: "usd=20" });
    expect((await ok("capcomd_profiles")).profiles.map((p: any) => p.name).sort()).toEqual(["coder", "sup"]);
  });

  test("team shapes: the server's instructions, capacity in setup and run_new, who can lead, a children grant with no effect", async () => {
    const instructions = mcp.getInstructions() ?? "";
    expect(instructions).toContain("capcomd-orchestration skill");
    expect(instructions).toContain("Start with capcomd_setup");
    expect(instructions).toContain("leads with helpers");
    // The test fakes have no local cap.
    expect((await ok("capcomd_setup")).capacity).toEqual({ sandbox: "fake", agentsAtOnce: null, detail: "no local cap (test fakes)" });
    const p = await ok("capcomd_profiles");
    const by = Object.fromEntries(p.profiles.map((x: any) => [x.name, x]));
    expect(by.sup).toMatchObject({ canSpawn: true, canLead: "up to 2 coder helpers, 2 levels" });
    expect(by.coder).toMatchObject({ canSpawn: false, canLead: null, does: expect.stringContaining("can't spawn") });
    expect(p.next).toContain("spawn sup with children");
    const r = await ok("capcomd_run_new", { budget: "usd=5,turns=100", label: "shapes", target: "capcomd/shapes", targetFrom: "trunk", key: `ts-${Date.now()}` });
    expect(r.capacity).toMatchObject({ sandbox: "fake", agentsAtOnce: null });
    expect(r.next).toStartWith("Plan the team shape first (skill: Choose a team shape): there's no fixed number of agents at once here (fake");
    expect(r.next).toContain("Spawn agents with capcomd_spawn");
    // Fan-out for a profile that can't spawn would do nothing: refused by name, with what to do; a lead takes it.
    const leaf = await call("capcomd_spawn", { runId: r.runId, task: "leaf", profile: "coder", children: { maxChildren: 2 }, budget: "usd=1,turns=10", key: "leaf" });
    expect(leaf.isError).toBe(true);
    expect(leaf.body.error).toMatchObject({ code: "config", reason: "cannot_spawn", message: expect.stringContaining("profile coder can't spawn"), hint: expect.stringContaining("capcomd_profiles canLead") });
    const lead = await ok("capcomd_spawn", { runId: r.runId, task: "lead", profile: "sup", children: { maxChildren: 2, maxDepth: 1 }, budget: "usd=1,turns=10", key: "lead" });
    expect(lead.limits).toMatchObject({ allowSpawn: true, maxChildren: 2, maxDepth: 1 });
    expect((await ok("capcomd_spawn", { runId: r.runId, task: "plain", profile: "coder", children: { maxChildren: 0 }, budget: "usd=1,turns=10", key: "plain" })).limits.allowSpawn).toBe(false);
    await ok("capcomd_cancel", { runId: r.runId });
  }, 60_000);

  test("profiles: title, tags, fit, cost, capacity; a profile whose permissions.report is false is never spawned to report", async () => {
    // A v2 profile beside the agents file (its layer is the project's): read on each call, removed afterwards.
    const dir = join(dirname(env.CAPCOMD_AGENTS_FILE!), "profiles");
    mkdirSync(join(dir, "critic"), { recursive: true });
    writeFileSync(join(dir, "critic", "profile.yaml"), [
      "name: critic", "tags: [review]", "identity: { title: Critic }", "harness: { provider: claude, auth: subscription, model: claude-opus-5-5 }",
      "tools: { allowed: [Read, Grep] }", "permissions: { report: false }",
    ].join("\n") + "\n");
    try {
      const by = Object.fromEntries((await ok("capcomd_profiles")).profiles.map((x: any) => [x.name, x]));
      expect(by.critic).toMatchObject({
        title: "Critic", tags: ["review"], canReport: false, cost: "high", fit: "read-only; never spawned with report; Claude Code, claude-opus-5-5, high cost; can't spawn",
        capacity: { agentsAtOnce: null, detail: "no local cap (test fakes)" },
      });
      expect(by.coder).toMatchObject({ title: null, tags: [], canReport: true, cost: null, fit: "edits and runs code; Claude Code, the CLI's default model; up to 20 turns; can't spawn" });
      const r = await ok("capcomd_run_new", { budget: "usd=5,turns=100", label: "report", key: `rp-${Date.now()}` });
      const refused = await call("capcomd_spawn", { runId: r.runId, task: "where is sum defined?", profile: "critic", report: true, budget: "usd=1,turns=10", key: "q" });
      expect(refused.isError).toBe(true);
      expect(refused.body.error).toMatchObject({ code: "config", reason: "report_not_allowed", message: "profile critic can't be spawned with report (its permissions.report is false)" });
      // Unset is allowed, as before; the critic itself still spawns without report.
      expect((await ok("capcomd_spawn", { runId: r.runId, task: "where is sum defined?", profile: "coder", report: true, budget: "usd=1,turns=10", key: "q2" })).agentId).toBeString();
      expect((await ok("capcomd_spawn", { runId: r.runId, task: "review it", profile: "critic", budget: "usd=1,turns=10", key: "q3" })).agentId).toBeString();
      await ok("capcomd_cancel", { runId: r.runId });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 60_000);

  test("fan-out on a staging target: spawn 3, await, verify, merge each; only verified commits land", async () => {
    const r = await ok("capcomd_run_new", { budget: "usd=10,turns=200", label: "fan-out", target: "capcomd/fanout", targetFrom: "trunk", key: `fo-${Date.now()}` });
    expect(r.gates.checks).toEqual(expect.arrayContaining(["unit"]));
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

    // capcomd_check: the run's checks on its target as it is now (the three merges), merging nothing.
    const c = await settle("capcomd_check", { runId: run, check: "unit" });
    expect(c).toMatchObject({ kind: "check", state: "passed", branch: "capcomd/fanout", result: { pass: true, mergesOn: 3, checks: { passed: true } } });
    expect(c.next).toContain("Nothing was merged");
    // Waited for like a verify; the same check again is the same record.
    const w = await ok("capcomd_await", { runId: run, ops: [c.id], timeoutMs: 1000 });
    expect(w.ops[0]).toMatchObject({ id: c.id, state: "passed" });
    expect((await ok("capcomd_check", { runId: run, ref: "capcomd/fanout", check: "unit" })).id).toBe(c.id);
    // An agent's branch, by its id.
    expect((await settle("capcomd_check", { runId: run, ref: ids[0], check: "unit" })).result.pass).toBe(true);
  }, 180_000);

  test("verify several, await any; poll by key or id without resending parameters; merge a verified commit fast", async () => {
    const r = await ok("capcomd_run_new", { budget: "usd=10,turns=200", label: "parallel verify", target: "capcomd/parallel", targetFrom: "trunk", key: `pv-${Date.now()}` });
    const run = r.runId as string;
    const fast = (await ok("capcomd_spawn", { runId: run, task: "work fast", profile: "coder", check: "unit", budget: "usd=1,turns=10", key: "fast" })).agentId;
    const slow = (await ok("capcomd_spawn", { runId: run, task: "work slow", profile: "coder", check: "slow", budget: "usd=1,turns=10", key: "slow" })).agentId;
    let pending = [fast, slow];
    while (pending.length) pending = (await ok("capcomd_await", { runId: run, agents: pending, timeoutMs: 10_000 })).pending;

    // Start both verifies without waiting (timeoutMs 0): each answers at once with its id.
    const acceptance = "a long acceptance text the driver shouldn't have to send again ".repeat(20);
    const vSlow = await ok("capcomd_verify", { runId: run, ref: slow, key: "v-slow", acceptance, timeoutMs: 0 });
    const vFast = await ok("capcomd_verify", { runId: run, ref: fast, key: "v-fast", acceptance, timeoutMs: 0 });
    // (Plain checks: toMatchObject with an asymmetric matcher replaces the matched value in the object it reads.)
    for (const v of [vSlow, vFast]) { expect(v.state).toBe("running"); expect(v.id).toMatch(/^vfy-/); }

    // One wait for both: it returns when the first finishes (the fast check), with the slow one still pending.
    const t0 = Date.now();
    const first = await ok("capcomd_await", { runId: run, ops: [vSlow.id, vFast.id], mode: "any", timeoutMs: 30_000 });
    expect(Date.now() - t0).toBeLessThan(5_500);
    expect(first.ops.map((o: any) => o.id)).toEqual([vFast.id]);
    expect(first.ops[0]).toMatchObject({ kind: "verify", state: "passed", result: { pass: true } });
    expect(typeof first.ops[0].result.timings.checksMs).toBe("number");
    expect(typeof first.ops[0].result.timings.totalMs).toBe("number");
    expect(first.pending).toEqual([vSlow.id]);
    // Event-driven: it answered right after the verify's record changed, not at a poll interval.
    const finishedAt = (await ok("capcomd_events", { runId: run, limit: 500 })).events.find((e: any) => e.type === "VERIFY_PASSED" && e.event.id === vFast.id).epochMs;
    expect(Date.now() - finishedAt).toBeLessThan(2_000);

    // Poll by key with no acceptance, and by id alone: the same verification, never a conflict (finished or not).
    const byKeySlow = await ok("capcomd_verify", { runId: run, ref: slow, key: "v-slow", timeoutMs: 0 });
    expect(byKeySlow).toMatchObject({ id: vSlow.id });
    const byKey = await ok("capcomd_verify", { runId: run, ref: fast, key: "v-fast" });
    expect(byKey).toMatchObject({ id: vFast.id, state: "passed" });
    expect(await ok("capcomd_verify", { runId: run, id: vFast.id })).toMatchObject({ id: vFast.id, state: "passed", acceptance });
    // Only a parameter given explicitly that differs conflicts.
    const other = await call("capcomd_verify", { runId: run, ref: fast, key: "v-fast", acceptance: "something else" });
    expect(other.isError).toBe(true);
    expect(other.body.error).toMatchObject({ code: "conflict" });
    expect(other.body.error.message).toContain("acceptance");

    // The fast one merges at once: the target hasn't moved since its verify, so its commit is pushed as it is.
    const m1 = await ok("capcomd_merge", { runId: run, ref: fast, require: vFast.id, key: "m-fast", timeoutMs: 0 });
    expect(m1.id).toMatch(/^mrg-/);
    const done1 = await ok("capcomd_await", { runId: run, ops: [m1.id, vSlow.id], mode: "all", timeoutMs: 30_000 });
    const merged1 = done1.ops.find((o: any) => o.id === m1.id);
    expect(merged1).toMatchObject({ state: "merged", result: { merged: true, timings: { path: "fast" } } });
    expect(await ok("capcomd_merge", { runId: run, id: m1.id })).toMatchObject({ id: m1.id, state: "merged" }); // poll by id
    // The slow one's target moved (the fast one landed): its merge checks again on the new target first.
    const sv = done1.ops.find((o: any) => o.id === vSlow.id);
    expect(sv).toMatchObject({ state: "passed" });
    const m2 = await settle("capcomd_merge", { runId: run, ref: slow, require: vSlow.id, key: "m-slow" });
    expect(m2).toMatchObject({ state: "merged", result: { merged: true, timings: { path: "full", checksWhere: "host" } } });
    const files = await filesOn("capcomd/parallel");
    expect(files).toEqual(expect.arrayContaining([`tasks/${fast}.md`, `tasks/${slow}.md`]));
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

    // More budget for the run stays within the project's cap per run (usd=20) too.
    const raise = await call("capcomd_grant", { runId: run, budget: "usd=16" });
    expect(raise.body.error.reason).toBe("forbidden");
    expect(await ok("capcomd_grant", { runId: run, budget: "usd=1", key: "r1" })).toMatchObject({ agentId: null, budget: { usd: 6, turns: 100 } });

    const a = (await ok("capcomd_spawn", { runId: run, task: "work p", profile: "coder", check: "unit", key: "p" })).agentId;
    for (;;) { const w = await ok("capcomd_await", { runId: run, agents: [a], timeoutMs: 10_000 }); if (!w.pending.length) break; }
    expect((await call("capcomd_grant", { runId: run, agent: a, budget: "usd=1" })).isError).toBe(true); // finished
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
