// The kernel's primitives for a plugin (docs/spec/plugin-api.md §8.1, §8.4; src/plugins/services.ts) without an engine:
// which processes have which services (the daemon's engine primitives, every process's sandboxes and auth), the scope
// each call needs, what a call refuses before it reaches a run (a reserved kv key, a value over 64 KB, a bad id, a spawn
// or merge as the operator), the
// sandbox a plugin gets (the kernel's wrapper, never the seam object, its deadline kept) and the auth facts. Every
// primitive against a real engine, and a plugin talking to an agent: tests/scenarios/plugin-services.test.ts.
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { PluginContext, PluginModule } from "../../packages/plugin/src/context";
import type { Candidate, PluginHost } from "../../packages/plugin/src/host/host";
import { kernelHost } from "../../src/plugins/host";
import { useHooks } from "../../src/plugins/hooks";
import { describedSandboxes, sandboxSeam } from "../../src/plugins/sandboxes";
import { RESERVED_KV } from "../../src/plugins/services";
import { seamCall } from "../../src/providers/seam";
import { probe } from "./fixtures/services-probe/index";

const PROBE = join(import.meta.dir, "fixtures", "services-probe");
const contexts = new Map<string, PluginContext>();
/** A plugin that only hands its context over, with these scopes. */
const bare = (name: string, scopes: string[]): Candidate => ({
  source: "builtin",
  manifest: { schema: "capcomd.plugin/v1", name, version: "1.0.0", description: `The ${name} test plugin.`, apiVersion: 1, engines: { capcomd: ">=0.0.0" }, entry: { runtime: "in-process", module: "./index.ts" }, scopes: scopes as never, contributes: { hooks: { "run.changed": {} } } },
  module: { activate(ctx) { contexts.set(name, ctx as PluginContext); ctx.hooks.on("run.changed", () => {}); } } as PluginModule<never>,
});
let hosts: PluginHost[] = [];
async function started(o: { daemon: boolean }) {
  const host = kernelHost({ log: false, jobs: o.daemon });
  await host.start([{ source: "builtin", dir: PROBE }, bare("reader", ["read"]), bare("nobody", [])]);
  hosts.push(host);
  return { host, ctx: probe.ctx!, reader: contexts.get("reader")!, nobody: contexts.get("nobody")! };
}
afterEach(async () => { for (const h of hosts) await h.stop(); hosts = []; useHooks(null); });

/** What a call answered: "ok", or its error's code. A list of calls is made one at a time (none left unhandled). */
const code = async (p: unknown) => { try { await p; return "ok"; } catch (e) { return (e as { code?: string }).code ?? String(e); } };
const codes = async (calls: Array<() => unknown>) => { const out: string[] = []; for (const c of calls) out.push(await code(c())); return out; };
const syncCode = (f: () => unknown) => { try { f(); return "ok"; } catch (e) { return (e as { code?: string }).code ?? String(e); } };
const RUN = "run-services-nowhere";

describe("which process has which service (§8.4)", () => {
  test("a CLI's local host has no engine primitive; its plugins still have sandboxes and auth", async () => {
    const { ctx } = await started({ daemon: false });
    const calls = [() => ctx.runs.get(RUN), () => ctx.runs.list({}), () => ctx.messages.inbox(RUN, "agt-x", 0), () => ctx.kv.get(RUN, "k"), () => ctx.board.list(RUN), () => ctx.gates.pending(RUN), () => ctx.profiles.list({}), () => ctx.agents.get(RUN, "agt-x"),
      () => ctx.agents.spawn({ runId: RUN, profile: "worker", task: "t" }), () => ctx.agents.await(RUN, ["agt-x"], {}), () => ctx.agents.grant(RUN, "agt-x", { usd: 1 }), () => ctx.agents.title(RUN, "agt-x", "x"),
      () => ctx.gates.verify(RUN, { ref: "agt-x" }), () => ctx.gates.merge(RUN, { ref: "agt-x", require: "vfy-1" })];
    expect(await codes(calls)).toEqual(calls.map(() => "unsupported"));
    expect(ctx.sandboxes.descriptors().map((d) => d.name)).toEqual(describedSandboxes().map((d) => d.name));
    expect(ctx.auth.credentialMode("claude", "subscription")).toBe("subscription");
  });

  test("the daemon's host has every primitive of agents and gates (§8.4)", async () => {
    const services = (await import("../../src/plugins/services")).daemonServices({ name: "services-probe", scopes: ["read", "steer"] } as never);
    expect(Object.keys(services.agents).sort()).toEqual(["await", "cancel", "get", "grant", "notice", "spawn", "title", "tree"]);
    expect(Object.keys(services.gates).sort()).toEqual(["merge", "pending", "verify"]);
  });
});

describe("agents and gates: never the operator, never past a gate (§8.4, §11.3)", () => {
  test("a merge or a spawn as the operator, a reviewer, a check command or a host-only contract key is forbidden", async () => {
    const { ctx } = await started({ daemon: true });
    const forbidden = [
      () => ctx.gates.merge(RUN, { ref: "agt-x", require: "vfy-1", operator: true } as never),
      () => ctx.gates.merge(RUN, { ref: "agt-x", operator: true } as never),
      () => ctx.agents.spawn({ runId: RUN, profile: "worker", task: "t", operator: true } as never),
      () => ctx.agents.spawn({ runId: RUN, profile: "worker", task: "t", review: true }),
      () => ctx.agents.spawn({ runId: RUN, profile: "worker", task: "t", contract: { checks: "rm -rf ." } }),
      () => ctx.agents.spawn({ runId: RUN, profile: "worker", task: "t", contract: { review: { vfyId: "vfy-1" } } }),
      () => ctx.agents.spawn({ runId: RUN, profile: "worker", task: "t", contract: { from: { agentId: "agt-x" } } }),
      () => ctx.gates.verify(RUN, { ref: "agt-x", checks: "true" } as never),
    ];
    expect(await codes(forbidden)).toEqual(forbidden.map(() => "forbidden"));
  });

  test("the kernel itself refuses a plugin's spawn or merge as the operator", async () => {
    const O = await import("../../src/primitives/ops");
    const principal = { kind: "plugin" as const, name: "services-probe", scopes: ["steer" as const] };
    const spawned = await O.spawnAgent({ runId: RUN, profile: "worker", task: "t", principal, operator: true }).then(() => null, (e: unknown) => e);
    expect(spawned).toMatchObject({ code: "conflict", reason: "forbidden" });
    const merged = await O.mergeRef({ runId: RUN, ref: "agt-x", requester: "plugin:services-probe", operator: true }).then(() => null, (e: unknown) => e);
    expect(merged).toMatchObject({ code: "conflict", reason: "forbidden" });
  });

  test("what they're given is checked before any run is looked up", async () => {
    const { ctx } = await started({ daemon: true });
    const invalid = [
      () => ctx.agents.spawn({ runId: RUN, profile: "Not A Name", task: "t" }),
      () => ctx.agents.spawn({ runId: RUN, profile: "worker", task: " " }),
      () => ctx.agents.spawn({ runId: RUN, profile: "worker", task: "t", budget: { usd: -1 } }),
      () => ctx.agents.spawn({ runId: RUN, profile: "worker", task: "t", contract: [] as never }),
      () => ctx.agents.spawn({ runId: RUN, profile: "worker", task: "t", grant: "all" as never }),
      () => ctx.agents.spawn({ runId: RUN, profile: "worker", task: "t", title: 7 as never }),
      () => ctx.agents.spawn({ runId: "not-a-run", profile: "worker", task: "t" }),
      () => ctx.agents.spawn({ runId: RUN, profile: "worker", task: "t" }, { key: "a".repeat(201) }),
      () => ctx.agents.await(RUN, [], {}),
      () => ctx.agents.await(RUN, ["not-an-agent"], {}),
      () => ctx.agents.await(RUN, ["agt-x"], { any: "yes" as never }),
      () => ctx.agents.await(RUN, ["agt-x"], {}, { timeoutMs: 2 * 60 * 60_000 }),
      () => ctx.agents.grant(RUN, "agt-x", {}),
      () => ctx.agents.grant(RUN, "agt-x", { dollars: 1 } as never),
      () => ctx.agents.title(RUN, "agt-x", 7 as never),
      () => ctx.gates.verify(RUN, { ref: "" }),
      () => ctx.gates.verify(RUN, { ref: "agt-x", reviewer: "Not A Name" }),
      () => ctx.gates.merge(RUN, { ref: "agt-x", require: "mrg-1" }),
      () => ctx.gates.merge(RUN, { ref: "agt-x" } as never),
    ];
    expect(await codes(invalid)).toEqual(invalid.map(() => "invalid"));
  });

  test("a read-only plugin awaits and never spawns, grants, names, verifies or merges", async () => {
    const { reader, nobody } = await started({ daemon: true });
    const steer = [() => reader.agents.spawn({ runId: RUN, profile: "worker", task: "t" }), () => reader.agents.grant(RUN, "agt-x", { usd: 1 }), () => reader.agents.title(RUN, "agt-x", "x"),
      () => reader.gates.verify(RUN, { ref: "agt-x" }), () => reader.gates.merge(RUN, { ref: "agt-x", require: "vfy-1" })];
    expect(await codes(steer)).toEqual(steer.map(() => "forbidden"));
    // A read: past the scope check, to the checks of what it is given.
    expect(await code(reader.agents.await(RUN, [], {}))).toBe("invalid");
    expect(await code(nobody.agents.await(RUN, ["agt-x"], {}))).toBe("forbidden");
  });
});

describe("scopes (§11.1)", () => {
  test("a read-only plugin reads and never steers; one with no scope only gets what needs none", async () => {
    const { reader, nobody } = await started({ daemon: true });
    const steer = [() => reader.runs.new({ budget: { usd: 1 } }), () => reader.runs.end(RUN, { state: "failed", reason: "x" }), () => reader.runs.pause(RUN), () => reader.runs.title(RUN, "x"),
      () => reader.messages.send(RUN, { to: "agt-x", body: "hi" }), () => reader.kv.put(RUN, "k", 1), () => reader.kv.cas(RUN, "k", undefined, 1), () => reader.board.add(RUN, { id: "t1", goal: "g" }),
      () => reader.board.claim(RUN, {}), () => reader.board.done(RUN, "t1")];
    expect(await codes(steer)).toEqual(steer.map(() => "forbidden"));
    expect(reader.auth.credentialMode("claude", "subscription")).toBe("subscription");
    const read = [() => nobody.runs.get(RUN), () => nobody.kv.get(RUN, "k"), () => nobody.messages.inbox(RUN, "agt-x", 0), () => nobody.board.list(RUN), () => nobody.gates.pending(RUN), () => nobody.profiles.list({}), () => nobody.auth.loginPresent("claude", "docker")];
    expect(await codes(read)).toEqual(read.map(() => "forbidden"));
    // auth.credentialMode answers synchronously, so it refuses by throwing; the sandboxes need no scope.
    expect(syncCode(() => nobody.auth.credentialMode("claude", "apikey"))).toBe("forbidden");
    expect(nobody.sandboxes.provider("fake").describe().name).toBe("fake");
  });
});

describe("refused before any run is looked up (§8.4)", () => {
  test("kv: the reserved prefixes are read-only, a key is a key, a value is JSON of at most 64 KB", async () => {
    const { ctx } = await started({ daemon: true });
    for (const p of RESERVED_KV) {
      expect([p, await code(ctx.kv.put(RUN, `${p}x`, 1))]).toEqual([p, "forbidden"]);
      expect([p, await code(ctx.kv.cas(RUN, `${p}x`, undefined, 1))]).toEqual([p, "forbidden"]);
    }
    expect(await code(ctx.kv.put(RUN, "_target", { branch: "main" }))).toBe("forbidden");
    expect(await code(ctx.kv.put(RUN, "a key", 1))).toBe("invalid");
    expect(await code(ctx.kv.get(RUN, ""))).toBe("invalid");
    expect(await code(ctx.kv.list(RUN, "bad prefix"))).toBe("invalid");
    expect(await code(ctx.kv.put(RUN, "k", undefined))).toBe("invalid");
    expect(await code(ctx.kv.put(RUN, "k", "x".repeat(64 * 1024)))).toBe("invalid");
    expect(await code(ctx.kv.put(RUN, "k", 1, { key: "" }))).toBe("invalid");
    // No JSON, or none that can be written: invalid, not a TypeError.
    for (const v of [() => 1, Symbol("s"), 1n]) expect(await code(ctx.kv.put(RUN, "k", v))).toBe("invalid");
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(await code(ctx.kv.put(RUN, "k", cycle))).toBe("invalid");
    // A key is refused past 200 characters, never cut (two keys that differ after the cut would be one).
    expect(await code(ctx.kv.put(RUN, "k", 1, { key: "a".repeat(201) }))).toBe("invalid");
    expect(await code(ctx.board.add(RUN, { id: "t1", goal: "g" }, { key: "a".repeat(201) }))).toBe("invalid");
  });

  test("runs, messages, board and profiles check what they're given", async () => {
    const { ctx } = await started({ daemon: true });
    expect(await code(ctx.runs.get("not-a-run"))).toBe("invalid");
    expect(await code(ctx.runs.new({ budget: { usd: -1 } }))).toBe("invalid");
    expect(await code(ctx.runs.new({ budget: { dollars: 1 } as never }))).toBe("invalid");
    expect(await code(ctx.runs.new({ budget: { usd: 1 }, label: "" }))).toBe("invalid");
    // A goal is checked as POST /v1/runs checks one.
    for (const goal of [" ", "x".repeat(16 * 1024 + 1), "a\u0000b", "[agent:planner] fix it", 7 as never])
      expect([String(goal).slice(0, 20), await code(ctx.runs.new({ budget: { usd: 1 }, goal }))]).toEqual([String(goal).slice(0, 20), "invalid"]);
    expect(await code(ctx.runs.list({ limit: 0 }))).toBe("invalid");
    expect(await code(ctx.messages.send(RUN, { to: "operator", body: "hi" }))).toBe("invalid");
    expect(await code(ctx.board.add(RUN, { id: "bad id", goal: "g" }))).toBe("invalid");
    expect(await code(ctx.board.add(RUN, { id: "t1", goal: " " }))).toBe("invalid");
    expect(await code(ctx.profiles.resolve("Not A Name", {}))).toBe("invalid");
    expect(await code(ctx.profiles.resolve("worker", { overrides: [] as never }))).toBe("invalid");
  });
});

describe("sandboxes (§7.1, §8.4)", () => {
  test("a plugin gets the kernel's wrapper of a place, never the seam itself, and the same one each time", async () => {
    const { ctx } = await started({ daemon: true });
    const p = ctx.sandboxes.provider("fake");
    expect(p).not.toBe(sandboxSeam("fake"));
    expect(ctx.sandboxes.provider("fake")).toBe(p);
    expect(Object.isFrozen(p)).toBe(true);
    expect(p.describe()).toEqual(sandboxSeam("fake")!.describe());
    expect(syncCode(() => ctx.sandboxes.provider("nowhere"))).toBe("not_found");
    expect(ctx.sandboxes.descriptors().map((d) => d.name)).toContain("fake");
  });

  test("its calls go to the kernel's provider for the place, within the call's deadline", async () => {
    const { ctx } = await started({ daemon: true });
    const p = ctx.sandboxes.provider("fake");
    const call = () => seamCall(10_000).call;
    const spec = { idemKey: `capcomd-services-${Date.now()}`, isolated: true as const, ttlSeconds: 60, egressAllow: [], labels: { workerId: "agt-services", runId: RUN } };
    const { id, created } = await p.ensure(spec, call());
    expect(created).toBe(true);
    expect((await p.ensure(spec, call())).id).toBe(id);
    await p.waitReady(id, call());
    expect((await p.list("", call())).map((m) => m.id)).toContain(id);
    await p.destroy(id, call());
    expect(await code(p.waitReady("vm-nowhere", call()))).not.toBe("ok");
    const gone = seamCall(10_000);
    const ac = new AbortController();
    ac.abort();
    expect(await code(p.list("", { ...gone.call, signal: ac.signal }))).toBe("timeout");
    gone.done();
    // The deadline holds even when the signal never fires; a deadline that isn't a time is refused.
    const live = new AbortController().signal;
    expect(await code(p.list("", { ...call(), signal: live, deadline: new Date(Date.now() - 1000).toISOString() }))).toBe("timeout");
    expect(await code(p.list("", { ...call(), signal: live, deadline: "tomorrow" }))).toBe("invalid");
  });
});

describe("auth: facts, never values (§11.4)", () => {
  test("how an agent of a provider gets its credential, and whether a login is there", async () => {
    const { ctx } = await started({ daemon: true });
    expect(ctx.auth.credentialMode("claude", "subscription")).toBe("subscription");
    expect(ctx.auth.credentialMode("codex", "apikey")).toBe("secret");
    expect(syncCode(() => ctx.auth.credentialMode("nowhere", "apikey"))).toBe("not_found");
    expect(syncCode(() => ctx.auth.credentialMode("claude", "password" as never))).toBe("invalid");
    expect(typeof (await ctx.auth.loginPresent("claude", "docker"))).toBe("boolean");
    expect(await code(ctx.auth.loginPresent("claude", "nowhere"))).toBe("not_found");
    expect(await code(ctx.auth.loginPresent("nowhere", "docker"))).toBe("not_found");
    expect(ctx.auth.redact("key sk-ant-api03-abcdefghijklmnopqrstuvwxyz")).not.toContain("abcdefghijklmnop");
  });
});
