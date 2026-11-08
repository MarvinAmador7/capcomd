// The kernel's primitives as a plugin calls them (docs/spec/plugin-api.md §8.1, §8.4; src/plugins/services.ts), against
// a real engine. In this process, the services-probe fixture in a daemon's host (kernelHost with the daemon's services):
// runs (a key replays, run.creating names the plugin, an unknown run is not_found and never created), kv (the reserved
// keys read-only, a key replays, compare-and-swap), the board, messages to a scripted agent and its inbox, the gates'
// pending approvals, profiles (profile.resolved names the plugin, overrides only narrow) and the run's sandbox; a
// read-only plugin reads and never writes. In the daemon (CAPCOMD_TEST_PLUGINS): the same fixture messages an agent
// that asks for it and reads back the kv key the agent wrote. The checks that need no engine: tests/plugins/services.test.ts.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { PluginContext, PluginModule } from "../../packages/plugin/src/context";
import type { PluginHost } from "../../packages/plugin/src/host/host";
import { existingActor } from "../../src/core/relay";
import { useHooks } from "../../src/plugins/hooks";
import { kernelHost } from "../../src/plugins/host";
import { probe } from "../plugins/fixtures/services-probe/index";
import { spawnRoot, trajectory, waitAll, world, type World } from "./harness";

const PROBE = join(import.meta.dir, "..", "plugins", "fixtures", "services-probe");
const PRINCIPAL = { kind: "plugin", name: "services-probe", scopes: ["read", "steer"] };
let w: World;
let host: PluginHost;
let ctx: PluginContext;
let reader: PluginContext;
let dir: string;
let log: string;
const runs: string[] = [];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "capcomd-scn-plugin-services-"));
  log = join(dir, "services.ndjson");
  w = await world("plugin-services", { CAPCOMD_TEST_PLUGINS: PROBE, CAPCOMD_TEST_SERVICES_LOG: log, NODE_ENV: "test" });
  host = kernelHost({ log: false, jobs: true });
  await host.start([{ source: "builtin", dir: PROBE }, {
    source: "builtin",
    manifest: { schema: "capcomd.plugin/v1", name: "services-reader", version: "1.0.0", description: "Reads the run's state and never steers.", apiVersion: 1, engines: { capcomd: ">=0.0.0" },
      entry: { runtime: "in-process", module: "./index.ts" }, scopes: ["read"], contributes: { hooks: { "run.changed": {} } } },
    module: { activate(c) { reader = c as PluginContext; c.hooks.on("run.changed", () => {}); } } as PluginModule<never>,
  }, {
    source: "builtin",
    manifest: { schema: "capcomd.plugin/v1", name: "services-denier", version: "1.0.0", description: "Refuses the runs labelled to be refused.", apiVersion: 1, engines: { capcomd: ">=0.0.0" },
      entry: { runtime: "in-process", module: "./index.ts" }, scopes: ["read"], contributes: { hooks: { "run.creating": {} } } },
    module: { activate(c) { c.hooks.on("run.creating", ({ payload }) => payload.options.label === "refuse me" ? { decision: "deny", reason: "no run may be labelled refuse me" } : { decision: "allow" }); } } as PluginModule<never>,
  }]);
  ctx = probe.ctx!;
  // This process's hooks are this host's: run.creating and profile.resolved reach the probe.
  useHooks(host.hooks);
}, 120_000);
afterAll(async () => {
  useHooks(null);
  // A scenario that failed may leave a scripted agent behind: stop it.
  const mine = Bun.spawnSync(["ps", "-A", "-o", "pid=,command="]).stdout.toString().split("\n").filter((l) => w && (l.includes(w.dir) || runs.some((r) => l.includes(`/${r}/`)))).map((l) => Number(l.trim().split(/\s+/)[0]));
  for (const pid of mine) if (pid > 1 && pid !== process.pid) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
  await host?.stop();
  try { await w?.stop(); } finally { if (dir) rmSync(dir, { recursive: true, force: true }); }
});

const code = async (p: unknown) => { try { await p; return "ok"; } catch (e) { return (e as { code?: string }).code ?? String(e); } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function newRun(label?: string) {
  const r = await ctx.runs.new({ budget: { usd: 10, turns: 400, wallSeconds: 3600 }, ...(label ? { label } : {}) });
  runs.push(r.id);
  return r.id;
}

describe("runs", () => {
  test("a plugin's run: a key replays it, run.creating says the plugin asked, and it is listed", async () => {
    const before = probe.heard.length;
    const r = await ctx.runs.new({ budget: { usd: 5, turns: 50 }, label: "probe run" }, { key: "first" });
    runs.push(r.id);
    expect(r).toMatchObject({ label: "probe run", state: "new", createdAt: expect.any(String) });
    expect(r.id).toMatch(/^run-/);
    expect(probe.heard.slice(before).find((h) => h.hook === "run.creating")?.principal).toEqual(PRINCIPAL);
    // The same key with the same arguments: the same run; with others, a conflict.
    expect((await ctx.runs.new({ budget: { usd: 5, turns: 50 }, label: "probe run" }, { key: "first" })).id).toBe(r.id);
    expect(await code(ctx.runs.new({ budget: { usd: 6, turns: 50 }, label: "probe run" }, { key: "first" }))).toBe("conflict");
    expect(await ctx.runs.get(r.id)).toEqual(r);
    expect((await ctx.runs.list({ limit: 50 })).map((x) => x.id)).toContain(r.id);
    expect((await reader.runs.list({})).map((x) => x.id)).toContain(r.id);
  }, 60_000);

  test("another plugin's refusal of the run reaches the caller with its reason, and no run is made", async () => {
    const before = (await ctx.runs.list({ limit: 500 })).length;
    const e = await ctx.runs.new({ budget: { usd: 1 }, label: "refuse me" }).then(() => null, (x: unknown) => x);
    expect(e).toMatchObject({ code: "conflict", message: "run.creating: refused by the services-denier plugin", hint: "no run may be labelled refuse me" });
    expect((await ctx.runs.list({ limit: 500 })).length).toBe(before);
  }, 60_000);

  test("a run's title, pause, resume and end, as the plugin", async () => {
    const run = await newRun();
    await ctx.runs.title(run, "probe things");
    expect((await ctx.runs.get(run)).title).toBe("probe things");
    expect(await code(ctx.runs.title(run, "Not A Title Of Four Words Or Less At All"))).toBe("invalid");
    await ctx.runs.pause(run);
    await ctx.runs.resume(run);
    await ctx.runs.end(run, { state: "cancelled", reason: "done probing" });
    expect((await ctx.runs.get(run)).state).toBe("cancelled");
    const ended = await trajectory(w, run, (e) => e.type === "RUN_ENDED");
    expect(ended.map((e) => e.data)).toEqual([expect.objectContaining({ state: "cancelled", reason: "by the services-probe plugin: done probing", by: "plugin:services-probe" })]);
  }, 60_000);

  test("an unknown run is not_found, whatever the call, and is never created", async () => {
    const ghost = "run-services-ghost1";
    const calls = [() => ctx.runs.get(ghost), () => ctx.runs.pause(ghost), () => ctx.runs.title(ghost, "ghost"), () => ctx.runs.end(ghost, { state: "failed", reason: "x" }), () => ctx.kv.get(ghost, "k"),
      () => ctx.kv.put(ghost, "k", 1), () => ctx.kv.list(ghost, ""), () => ctx.board.list(ghost), () => ctx.board.add(ghost, { id: "t1", goal: "g" }), () => ctx.messages.inbox(ghost, "agt-x", 0),
      () => ctx.gates.pending(ghost), () => ctx.sandboxes.forRun(ghost)];
    for (const call of calls) expect(await code(call())).toBe("not_found");
    expect(await existingActor("scope", [ghost])).toBeNull();
  }, 60_000);
});

describe("kv", () => {
  test("the run's blackboard: written as the plugin, reserved keys read-only, a key replays, compare-and-swap", async () => {
    const run = await newRun();
    expect(await ctx.kv.get(run, "notes/a")).toBeUndefined();
    await ctx.kv.put(run, "notes/a", { n: 1 });
    expect(await ctx.kv.get(run, "notes/a")).toEqual({ n: 1 });
    expect((await w.cj(["kv", "get", run, "notes/a"])).j).toMatchObject({ value: { n: 1 }, writer: "plugin:services-probe" });
    // The run's settings: read, never written, and listed only when asked for by prefix.
    expect(await ctx.kv.get(run, "_sandbox")).toBeDefined();
    expect(await code(ctx.kv.put(run, "_sandbox", { name: "boxd" }))).toBe("forbidden");
    expect(await code(ctx.kv.put(run, "approval/mrg-1", { decision: "approve" }))).toBe("forbidden");
    expect(await ctx.kv.list(run, "")).toEqual(["notes/a"]);
    expect(await ctx.kv.list(run, "_")).toContain("_sandbox");
    // A key replays the call it was first used with, and refuses another.
    await ctx.kv.put(run, "k", 1, { key: "put-1" });
    await ctx.kv.put(run, "k", 2);
    await ctx.kv.put(run, "k", 1, { key: "put-1" });
    expect(await ctx.kv.get(run, "k")).toBe(2);
    expect(await code(ctx.kv.put(run, "k", 3, { key: "put-1" }))).toBe("conflict");
    // Compare-and-swap on the current value's JSON (undefined: the key must not exist).
    expect(await ctx.kv.cas(run, "c", undefined, 1)).toBe(true);
    expect(await ctx.kv.cas(run, "c", undefined, 1)).toBe(false);
    expect(await ctx.kv.cas(run, "c", 1, 2)).toBe(true);
    expect(await ctx.kv.cas(run, "c", 1, 3)).toBe(false);
    expect(await ctx.kv.get(run, "c")).toBe(2);
    expect(await ctx.kv.cas(run, "d", undefined, "x", { key: "cas-1" })).toBe(true);
    expect(await ctx.kv.cas(run, "d", undefined, "x", { key: "cas-1" })).toBe(true);
    expect(await code(ctx.kv.cas(run, "d", undefined, "y", { key: "cas-1" }))).toBe("conflict");
    expect(await ctx.kv.get(run, "d")).toBe("x");
    // A read-only plugin reads it, and never writes.
    expect(await reader.kv.get(run, "notes/a")).toEqual({ n: 1 });
    expect(await code(reader.kv.put(run, "notes/b", 1))).toBe("forbidden");
  }, 60_000);
});

describe("board", () => {
  test("the run's task board: added, claimed by the plugin, finished; what it doesn't hold it can't finish", async () => {
    const run = await newRun();
    expect(await ctx.board.add(run, { id: "t1", goal: "write the parser" })).toMatchObject({ id: "t1", state: "pending", holder: null, after: [], goal: { text: "write the parser", untrusted: true } });
    await ctx.board.add(run, { id: "t2", goal: "test the parser", after: ["t1"] });
    // Adding it again is the same task; with another goal it's a conflict.
    expect((await ctx.board.add(run, { id: "t1", goal: "write the parser" })).id).toBe("t1");
    expect(await code(ctx.board.add(run, { id: "t1", goal: "write something else" }))).toBe("conflict");
    expect(await code(ctx.board.add(run, { id: "t3", goal: "x", after: ["t9"] }))).toBe("not_found");
    expect(await ctx.board.claim(run, {})).toMatchObject({ id: "t1", state: "leased", holder: "plugin:services-probe" });
    // t2 waits for t1.
    expect(await ctx.board.claim(run, {})).toBeNull();
    expect(await code(ctx.board.claim(run, { id: "t2" }))).toBe("conflict");
    expect(await code(ctx.board.done(run, "t2"))).toBe("conflict");
    await ctx.board.done(run, "t1");
    await ctx.board.done(run, "t1");
    expect(await ctx.board.claim(run, { id: "t2" })).toMatchObject({ id: "t2", state: "leased" });
    await ctx.board.release(run, "t2");
    expect((await reader.board.list(run)).map((t) => [t.id, t.state, t.holder])).toEqual([["t1", "done", "plugin:services-probe"], ["t2", "released", null]]);
    expect(await code(ctx.board.claim(run, { id: "t9" }))).toBe("not_found");
    expect(await code(reader.board.claim(run, {}))).toBe("forbidden");
  }, 60_000);
});

describe("messages, gates and agents", () => {
  test("a message to an agent reaches its inbox from the plugin; a key replays it; nothing is pending approval", async () => {
    const run = await newRun();
    const agent = await spawnRoot(w, run, "worker", w.script("services-inbox", `i=0; while [ $i -lt 300 ]; do m=$(capcomd inbox); case "$m" in *"hello from the test"*) break;; esac; i=$((i+1)); sleep 0.2; done
echo "from: $(printf "%s" "$m" | $S/jget messages.0.from)"
capcomd result --summary "read it" >/dev/null`));
    const sent = await ctx.messages.send(run, { to: agent, body: "hello from the test" }, { key: "hello-1" });
    expect(sent.seq).toBeGreaterThan(0);
    expect((await ctx.messages.send(run, { to: agent, body: "hello from the test" }, { key: "hello-1" })).seq).toBe(sent.seq);
    expect(await code(ctx.messages.send(run, { to: agent, body: "something else" }, { key: "hello-1" }))).toBe("conflict");
    expect(await code(ctx.messages.send(run, { to: "agt-nowhere", body: "hi" }))).toBe("not_found");
    const inbox = await reader.messages.inbox(run, agent, 0);
    expect(inbox).toEqual([{ seq: sent.seq, from: "plugin:services-probe", body: { text: "hello from the test", untrusted: true, by: "plugin:services-probe" }, at: expect.any(String) }]);
    expect(await reader.messages.inbox(run, agent, sent.seq)).toEqual([]);
    const done = (await waitAll(w, run, [agent], 90_000)).agents[0];
    expect(done.status).toBe("done");
    expect((await w.cj(["logs", run, agent, "--tail", "200"])).j.lines.map((l: { line: string }) => l.line).join("\n")).toContain("from: plugin:services-probe");
    expect((await ctx.agents.get(run, agent)).status).toBe("done");
    expect(await ctx.gates.pending(run)).toEqual([]);
  }, 120_000);
});

describe("profiles and sandboxes", () => {
  test("a profile resolves as a spawn would, profile.resolved told the plugin asked; overrides only narrow", async () => {
    expect((await ctx.profiles.list({})).map((p) => p.name)).toEqual(expect.arrayContaining(["planner", "worker", "reviewer"]));
    const before = probe.heard.length;
    const spec = await ctx.profiles.resolve("worker", {});
    expect(spec).toMatchObject({ provider: "claude", auth: "subscription", maxTurns: 20, profile: { name: "worker", version: 1 } });
    expect((spec as unknown as Record<string, unknown>).kind).toBeUndefined();
    expect(probe.heard.slice(before).find((h) => h.hook === "profile.resolved")?.principal).toEqual(PRINCIPAL);
    expect(await ctx.profiles.resolve("worker", { overrides: { maxTurns: 5 } })).toMatchObject({ maxTurns: 5 });
    expect(await code(ctx.profiles.resolve("worker", { overrides: { maxTurns: 99 } }))).toBe("widening");
    expect(await code(ctx.profiles.resolve("nobody-here", {}))).toBe("not_found");
  }, 60_000);

  test("a run's sandbox is the kernel's wrapper of its place", async () => {
    const run = await newRun();
    const { provider, name } = await ctx.sandboxes.forRun(run);
    expect(provider.describe().name).toBe(name);
    expect(provider).toBe(ctx.sandboxes.provider(name));
  }, 60_000);
});

describe("in the daemon", () => {
  test("a plugin sends a message to an agent, and reads back the kv key the agent wrote", async () => {
    const run = (await w.cj(["run", "new", "--budget", "usd=10,turns=400,wallSeconds=3600", "--key", `scn-services-${Date.now()}`])).j.runId as string;
    runs.push(run);
    const agent = await spawnRoot(w, run, "worker", w.script("services-daemon", `capcomd title "probe talk" >/dev/null
i=0; while [ $i -lt 300 ]; do m=$(capcomd inbox); case "$m" in *"ping from the services probe"*) break;; esac; i=$((i+1)); sleep 0.2; done
case "$m" in *"ping from the services probe"*) ;; *) echo "no ping"; exit 3;; esac
capcomd kv put reply "$($S/json pong="$(printf "%s" "$m" | $S/jget messages.0.from)")" >/dev/null
capcomd result --summary "replied" >/dev/null`), { task: "[plugin-services] answer the probe" });
    const done = (await waitAll(w, run, [agent], 90_000)).agents[0];
    expect(done.status).toBe("done");
    const got = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : []);
    for (let i = 0; i < 100 && !got().some((x) => x.what === "read"); i++) await sleep(200);
    expect(got().find((x) => x.what === "sent")).toMatchObject({ seq: expect.any(Number) });
    expect(got().find((x) => x.what === "read")).toEqual({ what: "read", status: "done", value: { pong: "plugin:services-probe" } });
    // The message is the plugin's on the run's stream.
    expect((await trajectory(w, run, (e) => e.type === "MESSAGE_SENT" && e.data.to === agent)).map((e) => e.agentId)).toEqual(["plugin:services-probe"]);
  }, 120_000);
});
