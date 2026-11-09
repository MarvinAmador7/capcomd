// Plugin API §6.1 (the owner's decision of 2026-11-08), through a real daemon: a front door's verify, merge and approve
// (the CLI's, `capcomd mcp`'s) run in the daemon that hosts their engine (capability ops.front_door), so a user's plugin,
// which only the daemon runs (out of process: the proc-gate fixture in <home>/plugins), judges them as it judges an
// agent's. Before, the CLI and the MCP server ran verify and approve themselves, where only the built-in gates listen:
// proc-gate's verify.judging and approval.deciding were never asked.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { CLI } from "../helpers/engine";
import { world, waitAll, trajectory, WORKER, type World } from "./harness";
import { PROC_GATE_COMMAND, putProcGate } from "../plugins/fixtures/proc-gate";

const home = process.env.CAPCOMD_HOME!;
const pluginDir = join(home, "plugins", "proc-gate");
const data = join(home, "state", "plugins", "proc-gate");
let w: World;
let worker: string;
let mcp: Client;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const frames = () => (existsSync(join(data, "frames.ndjson")) ? readFileSync(join(data, "frames.ndjson"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const asked = (hook: string, runId: string) => frames().filter((f) => f.frame === "hook.call" && f.hook === hook && f.runId === runId);
const control = (c: object) => writeFileSync(join(data, "control.json"), JSON.stringify(c));
const until = async (what: () => boolean | Promise<boolean>, ms = 60_000) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (await what()) return; throw new Error("timed out"); };
const filesOn = async (branch: string) => {
  await w.repo.seed.ok(["fetch", "-q", "origin"]);
  return (await w.repo.seed.ok(["ls-tree", "-r", "--name-only", `origin/${branch}`])).split("\n");
};
const newRun = async (key: string) => (await w.cj(["run", "new", "--budget", "usd=10,turns=400,wallSeconds=3600", "--checks-set", "unit=true", "--key", `${key}-${Date.now()}`])).j.runId as string;
async function done(run: string, key: string) {
  const sp = await w.cj(["spawn", run, "--profile", "worker", "--task", `write ${key}`, "--key", key, "--contract", JSON.stringify({ script: `FILE=src/${key}.txt CONTENT=${key} ${worker}` })]);
  const id = sp.j.agentId as string;
  expect((await waitAll(w, run, [id])).agents[0].status).toBe("done");
  return id;
}
const verify = async (run: string, ref: string, key: string) => (await w.cj(["verify", run, "--ref", ref, "--checks", `test -f src/${key}.txt`, "--key", `v-${key}`])).j;
/** A capcomd_* tool through `capcomd mcp`, polled by its id until it stops answering running. */
async function tool(name: string, args: Record<string, unknown>) {
  const callOnce = async (a: Record<string, unknown>) => {
    const res: any = await mcp.callTool({ name, arguments: a });
    return { isError: !!res.isError, body: JSON.parse(res.content[0].text) };
  };
  let r = await callOnce({ ...args, timeoutMs: 20_000 });
  for (let i = 0; i < 20 && !r.isError && r.body.state === "running"; i++) r = await callOnce({ runId: args.runId, id: r.body.id, timeoutMs: 20_000 });
  return r;
}

beforeAll(async () => {
  mkdirSync(pluginDir, { recursive: true });
  await putProcGate(pluginDir);
  writeFileSync(join(pluginDir, "plugin.json"), JSON.stringify({
    schema: "capcomd.plugin/v1", name: "proc-gate", version: "1.0.0", description: "proc-gate, as a user's plugin judging the front doors' operations", apiVersion: 1, engines: { capcomd: ">=0.0.0" },
    entry: { runtime: "process", command: PROC_GATE_COMMAND }, scopes: ["read", "steer"],
    contributes: { hooks: { "verify.judging": {}, "merge.landing": {}, "approval.deciding": {} }, events: ["answered"] },
  }));
  mkdirSync(data, { recursive: true });
  control({ "merge.landing": "allow" });
  w = await world("front-door", { CAPCOMD_PROTECTED_BRANCHES: "release" });
  worker = w.script("worker", WORKER);
  await until(() => existsSync(join(data, "opened.json")));
  mcp = new Client({ name: "front-door-test", version: "0.0.1" });
  await mcp.connect(new StdioClientTransport({ command: "bun", args: [CLI, "mcp"], cwd: w.dir, stderr: "ignore", env: { ...process.env, ...w.env } as Record<string, string> }));
}, 180_000);
afterAll(async () => {
  try { await mcp?.close(); await w?.stop(); } finally { rmSync(pluginDir, { recursive: true, force: true }); }
});

test("the daemon's out-of-process plugin judges `capcomd verify` and capcomd_verify (verify.judging)", async () => {
  const run = await newRun("verify");
  const a = await done(run, "a");
  control({ "verify.judging": "deny", "merge.landing": "allow" });
  const v = await verify(run, a, "a");
  expect(v).toMatchObject({ state: "failed", result: { pass: false, checks: { passed: true }, judges: { passed: false, deniedBy: "proc-gate" } } });
  expect(asked("verify.judging", run)).toHaveLength(1);
  const denied = (await trajectory(w, run)).filter((e) => e.type === "PLUGIN_GATE_DENIED").map((e) => e.data);
  expect(denied).toContainEqual(expect.objectContaining({ plugin: "proc-gate", hook: "verify.judging", entity: v.id, decision: "deny" }));

  // The MCP server's verify: the same plugin is asked, in the daemon.
  const b = await done(run, "b");
  const m = await tool("capcomd_verify", { runId: run, ref: b, check: "unit" });
  expect(m.isError).toBe(false);
  expect(m.body).toMatchObject({ state: "failed", result: { judges: { passed: false, deniedBy: "proc-gate" } } });
  expect(asked("verify.judging", run)).toHaveLength(2);

  // Allowed, it passes: the plugin decides, nothing else.
  control({ "verify.judging": "allow", "merge.landing": "allow" });
  const ok = await tool("capcomd_verify", { runId: run, ref: b, check: "unit", key: "again" });
  expect(ok.body).toMatchObject({ state: "passed", result: { judges: { passed: true, plugins: expect.arrayContaining(["proc-gate"]) } } });
}, 300_000);

test("a merge.landing deny or hold from it stops `capcomd merge` and capcomd_merge; a person's approval asks approval.deciding there too", async () => {
  control({ "merge.landing": "allow" });
  const run = await newRun("merge");
  const a = await done(run, "c");
  const va = await verify(run, a, "c");
  expect(va.state).toBe("passed");
  // Held: parked for a person, naming the plugin.
  control({ "merge.landing": "hold" });
  const held = (await w.cj(["merge", run, "--ref", a, "--require", va.id, "--key", "m-c"])).j;
  expect(held).toMatchObject({ state: "awaiting_approval", heldBy: { plugin: "proc-gate" } });
  expect(await filesOn("trunk")).not.toContain("src/c.txt");
  // The person approves, from the CLI: approval.deciding is the plugin's too, and it refuses this approval.
  control({ "merge.landing": "allow", "approval.deciding": "deny" });
  const refused = await w.cj(["approve", run, held.id]);
  expect(refused.code).not.toBe(0);
  expect(JSON.stringify(refused.j)).toContain("plugin:proc-gate");
  expect(asked("approval.deciding", run)).toHaveLength(1);
  // Allowed, the approval lands it (merge.landing asked again, and allowed now).
  control({ "merge.landing": "allow", "approval.deciding": "allow" });
  const landed = (await w.cj(["approve", run, held.id])).j;
  expect(landed).toMatchObject({ state: "merged" });
  expect(await filesOn("trunk")).toContain("src/c.txt");

  // capcomd_merge: denied by the plugin, in the daemon, nothing lands.
  const b = await done(run, "d");
  const vb = await verify(run, b, "d");
  control({ "merge.landing": "deny" });
  const m = await tool("capcomd_merge", { runId: run, ref: b, require: vb.id });
  expect(m.isError).toBe(false);
  expect(m.body).toMatchObject({ state: "failed" });
  expect(JSON.stringify(m.body)).toContain("the process gate lands nothing");
  expect(await filesOn("trunk")).not.toContain("src/d.txt");
  expect(asked("merge.landing", run).length).toBeGreaterThanOrEqual(3);
}, 300_000);

test("the one-call tokens the front doors made for these calls are gone after them", async () => {
  const { loadClients } = await import("../../src/api/clients");
  expect(loadClients().filter((c) => c.frontDoor)).toEqual([]);
}, 30_000);
