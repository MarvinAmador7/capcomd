// The plugin host, in process, with test plugins (docs/spec/plugin-api.md §17.2 step 1): the §5.4 states, the §6.3
// order, hook dispatch by mode (§6.2), deadlines (§6.4), the failure policy and the breaker (§6.5), disposal (§5.3,
// §14.1), the plugin.* events (§13.1), GET /v1/plugins and `capcomd plugins list` (§13.2), and the mode-consistency
// script (§14.4). These tests fire hooks the way the kernel does (its sites: tests/plugins/kernel-hooks.test.ts and
// tests/scenarios/hooks-order.test.ts).
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginHost, type Candidate, type HostOptions } from "../../packages/plugin/src/host/host";
import type { HookSpan, HostEvent } from "../../packages/plugin/src/host/registry";
import { createHash } from "node:crypto";
import { kernelHost } from "../../src/plugins/host";
import { statsLines } from "../../src/cli/commands/plugins";
import { kernelSandbox } from "../../src/providers/seam";
import { getDependencies, resetDependencies } from "../../src/dependencies";
import { agentSpanId, getFinishedSpans, readTrace, resetSpans, tracePath } from "../../src/utils/tracing-simple";
import { PluginError } from "../../packages/plugin/src/errors";
import { readManifest } from "../../packages/plugin/src/load";
import { satisfies } from "../../packages/plugin/src/semver";
import { samplePayload, testkit } from "../../packages/plugin/src/testkit";
import type { HookCall, HookName } from "../../packages/plugin/src/hooks";
import type { PluginContext, PluginModule } from "../../packages/plugin/src/context";
import type { PluginManifest } from "../../packages/plugin/src/manifest";
import { checkHookModes, hookSites } from "../../scripts/check-hook-modes";
import { addClient, loadClients } from "../../src/api/clients";
import { CAPABILITY_NAMES, Plugins } from "../../src/api/contract";
import { harnessApp } from "../../src/api/server";
import { memorySource } from "../../src/api/source";
import { harnessState } from "../../src/api/state";

const ROOT = join(import.meta.dir, "..", "..");
const OPERATOR = { kind: "operator" as const, clientId: null };
const at = (entity = "vfy-1") => ({ principal: OPERATOR, entity, runId: "run-1" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type M = Record<string, unknown>;
const manifest = (name: string, extra: M = {}): M => ({
  schema: "capcomd.plugin/v1", name, version: "1.0.0", description: `The ${name} test plugin.`, apiVersion: 1,
  engines: { capcomd: ">=0.0.0" }, entry: { runtime: "in-process", module: "./index.ts" },
  contributes: { hooks: { "run.changed": {} } }, ...extra,
});
const hooks = (h: Record<string, M>, extra: M = {}): M => ({ contributes: { hooks: h, ...extra } });
const builtin = (m: M, activate: (ctx: PluginContext) => void | Promise<void>): Candidate => ({ source: "builtin", manifest: m, module: { activate } as PluginModule<never> });

function makeHost(o: Partial<HostOptions> = {}) {
  const events: HostEvent[] = [];
  const host = new PluginHost({ capcomd: "0.9.0", kernel: ["kernel:plugins"], emit: (e) => { events.push(e); }, dataDir: (n) => join(tmpdir(), "capcomd-plugin-data", n), ...o });
  type Loose = { type: string; stream: string; entity: string; text: string; data: Record<string, any> };
  return { host, events, of: (type: string) => events.filter((e) => e.type === type) as Loose[] };
}
const state = (host: PluginHost, name: string) => { const s = host.get(name)!; return s.cause ? `${s.state}(${s.cause})` : s.state; };

describe("load order (§6.3, §4.6)", () => {
  test("pre, normal, post; then after and requires edges; then names in byte order", async () => {
    const seen: string[] = [];
    const loaded: string[] = [];
    const disposed: string[] = [];
    const p = (name: string, extra: M = {}) => builtin(manifest(name, { ...hooks({ "merge.landing": {} }), ...extra }), (ctx) => {
      loaded.push(name);
      ctx.hooks.on("merge.landing", () => { seen.push(name); return { decision: "allow" }; });
      ctx.onDispose(() => { disposed.push(name); });
    });
    const { host } = makeHost();
    await host.start([
      p("zeta"), p("alpha"), p("late", { order: "post" }), p("early", { order: "pre" }),
      p("beta", { after: ["gamma"] }), p("gamma", { requires: ["plugin:omega"] }), p("omega"), p("ghost-after", { after: ["nobody"] }),
    ]);
    const order = ["early", "alpha", "ghost-after", "omega", "gamma", "beta", "zeta", "late"];
    expect(loaded).toEqual(order);
    expect(host.list().map((s) => s.name)).toEqual(order);
    expect(host.hooks.order("merge.landing")).toEqual(order);
    expect(await host.hooks.fire("merge.landing", "veto", samplePayload("merge.landing"), at("mrg-1"))).toEqual({ decision: "allow" });
    expect(seen).toEqual(order);
    await host.stop();
    expect(disposed).toEqual([...order].reverse());
    expect(host.list().every((s) => s.state === "disposed")).toBe(true);
  });

  test("a cycle fails the later plugin in discovery order; what requires it fails unresolved", async () => {
    const { host, of } = makeHost();
    const noop = () => {};
    const cb = (ctx: PluginContext) => { ctx.hooks.on("run.changed", noop); };
    await host.start([
      builtin(manifest("a", { after: ["b"] }), cb), builtin(manifest("b", { after: ["a"] }), cb),
      builtin(manifest("c", { requires: ["plugin:b"] }), cb), builtin(manifest("d"), cb),
    ]);
    expect([state(host, "a"), state(host, "b"), state(host, "c"), state(host, "d")]).toEqual(["active", "failed(cycle)", "failed(unresolved)", "active"]);
    expect(of("plugin.failed").map((e) => [e.data.plugin, e.data.cause])).toEqual([["b", "cycle"], ["c", "unresolved"]]);
  });

  test("two providers of one seam: the later fails seam_conflict; requires on kernel features and missing capabilities", async () => {
    const { host } = makeHost();
    const seam = (name: string) => builtin(manifest(name, { provides: ["seam:forge/git"], contributes: { seams: [{ kind: "forge", name: "git" }] } }), (ctx) => {
      ctx.seams.forge({ describe: () => ({ name: "git", label: "Git", pullRequests: false }) } as never);
    });
    const cb = (ctx: PluginContext) => { ctx.hooks.on("run.changed", () => {}); };
    await host.start([seam("forge-one"), seam("forge-two"), builtin(manifest("needs-kernel", { requires: ["kernel:plugins"] }), cb), builtin(manifest("needs-ghost", { requires: ["seam:sandbox/nowhere"] }), cb)]);
    expect([state(host, "forge-one"), state(host, "forge-two"), state(host, "needs-kernel"), state(host, "needs-ghost")]).toEqual(["active", "failed(seam_conflict)", "active", "failed(unresolved)"]);
    expect(host.contributions.get("seam", "forge/git")?.plugin).toBe("forge-one");
    expect(host.get("forge-one")!.seams).toEqual([{ kind: "forge", name: "git" }]);
  });

  test("enabling a plugin whose source an active plugin already provides fails it seam_conflict; the active one stays", async () => {
    const { host } = makeHost();
    const source = (name: string, enabled: boolean): Candidate => ({ ...builtin(manifest(name, { provides: ["source:chat"], contributes: { hooks: { "run.changed": {} }, sources: [{ name: "chat", summary: "Chat" }] } }), (ctx) => {
      ctx.hooks.on("run.changed", () => {});
    }), enabled });
    await host.start([source("chat-one", false), source("chat-two", true)]);
    expect([state(host, "chat-one"), state(host, "chat-two")]).toEqual(["validated(disabled)", "active"]);
    await host.enable("chat-one");
    expect([state(host, "chat-one"), state(host, "chat-two")]).toEqual(["failed(seam_conflict)", "active"]);
    expect(host.message("chat-one")).toContain("source:chat is already provided by chat-two");
  });
});

describe("dispatch by mode (§6.2)", () => {
  test("modify: listeners chain, each sees the previous patches; the kernel's rule refuses a widening, naming the plugin", async () => {
    const saw: Array<[string, number | undefined]> = [];
    const lower = (name: string, usd: number, extra: M = {}) => builtin(manifest(name, { ...hooks({ "run.creating": {} }), ...extra }), (ctx) => {
      ctx.hooks.on("run.creating", (call) => { saw.push([name, call.payload.options.budget.usd]); return { decision: "allow", patch: { budget: { usd } } }; });
    });
    const { host, of } = makeHost();
    await host.start([lower("one", 4), lower("two", 3), lower("wide", 9, { order: "post" })]);
    // The kernel's rule for run.creating (§6.6.3): budget may only go down.
    const apply = (p: ReturnType<typeof samplePayload<"run.creating">>, patch: { budget?: { usd?: number } }, plugin: string) => {
      if ((patch.budget?.usd ?? 0) > (p.options.budget.usd ?? Infinity)) throw new PluginError("widening", `${plugin} raised the budget`);
      return { options: { ...p.options, budget: { ...p.options.budget, ...patch.budget } } };
    };
    const r = await host.hooks.fire("run.creating", "modify", samplePayload("run.creating"), { ...at("run-1"), apply });
    expect(saw).toEqual([["one", 5], ["two", 4], ["wide", 3]]);
    // `wide` is open (the default for run.creating): its widening is a failed call, skipped; the chain's result stands.
    expect(r).toMatchObject({ decision: "allow", payload: { options: { budget: { usd: 3 } } }, patches: [{ plugin: "one", patch: { budget: { usd: 4 } } }, { plugin: "two", patch: { budget: { usd: 3 } } }] });
    expect(of("plugin.hook_failed").map((e) => e.data)).toMatchObject([{ plugin: "wide", hook: "run.creating", kind: "invalid_result", effect: "skipped" }]);
    expect(String(of("plugin.hook_failed")[0]!.data.message)).toContain("widening");
  });

  test("modify: a closed listener's widening denies; a patch outside the hook's fields is an invalid result", async () => {
    const { host, of } = makeHost();
    await host.start([
      builtin(manifest("strict", hooks({ "sandbox.ensuring": { failure: "closed" } })), (ctx) => { ctx.hooks.on("sandbox.ensuring", () => ({ decision: "allow", patch: { size: { vcpu: 8 } } })); }),
    ]);
    const apply = () => { throw new PluginError("widening", "size may not grow"); };
    const r = await host.hooks.fire("sandbox.ensuring", "modify", samplePayload("sandbox.ensuring"), { ...at("agt-1"), apply });
    expect(r).toMatchObject({ decision: "deny", plugin: "strict", failure: "invalid_result" });

    const { host: h2, of: of2 } = makeHost();
    await h2.start([builtin(manifest("sneaky", hooks({ "verify.starting": {} })), (ctx) => { ctx.hooks.on("verify.starting", () => ({ decision: "allow", patch: { checks: { test: "true" } } as never })); })]);
    const v = await h2.hooks.fire("verify.starting", "modify", samplePayload("verify.starting"), { ...at(), apply: (p) => p });
    // verify.starting is a gate: a patch to the checks (never patchable, ADR-017 §2) fails the call, closed.
    expect(v).toMatchObject({ decision: "deny", plugin: "sneaky", failure: "invalid_result" });
    expect(String(of2("plugin.hook_failed")[0]!.data.message)).toContain("not checks");
    expect(of("plugin.gate_denied")).toEqual([]);
    expect(of2("plugin.gate_denied").map((e) => [e.stream, e.data.decision])).toEqual([["run-1", "deny"]]);
  });

  test("veto: the first deny stops the chain and names the plugin; a hold parks merge.landing; a patch is an invalid result", async () => {
    const called: string[] = [];
    const v = (name: string, answer: unknown) => builtin(manifest(name, hooks({ "merge.landing": {} })), (ctx) => {
      ctx.hooks.on("merge.landing", () => { called.push(name); return answer as never; });
    });
    const { host, of } = makeHost();
    await host.start([v("a-allow", { decision: "allow" }), v("b-deny", { decision: "deny", reason: "not on Fridays", reasons: ["it is Friday"] }), v("c-never", { decision: "allow" })]);
    const r = await host.hooks.fire("merge.landing", "veto", samplePayload("merge.landing"), at("mrg-1"));
    expect(r).toEqual({ decision: "deny", plugin: "b-deny", text: "not on Fridays", reasons: ["it is Friday"], failure: null });
    expect(called).toEqual(["a-allow", "b-deny"]);
    expect(of("plugin.gate_denied").map((e) => e.data)).toEqual([{ plugin: "b-deny", hook: "merge.landing", entity: "mrg-1", decision: "deny", reason: "not on Fridays" }]);

    const { host: h2 } = makeHost();
    await h2.start([v("holder", { decision: "hold", reason: "a second pair of eyes" })]);
    expect(await h2.hooks.fire("merge.landing", "veto", samplePayload("merge.landing"), at("mrg-1"))).toEqual({ decision: "hold", plugin: "holder", text: "a second pair of eyes" });

    const { host: h3, of: of3 } = makeHost();
    await h3.start([builtin(manifest("patcher", hooks({ "approval.deciding": {} })), (ctx) => { ctx.hooks.on("approval.deciding", () => ({ decision: "allow", patch: {} }) as never); })]);
    expect(await h3.hooks.fire("approval.deciding", "veto", samplePayload("approval.deciding"), at("apr-1"))).toMatchObject({ decision: "deny", plugin: "patcher", failure: "invalid_result" });
    expect(of3("plugin.hook_failed")[0]!.data).toMatchObject({ kind: "invalid_result", effect: "denied" });
  });

  test("observe: every listener, concurrently, never awaited; payloads by value", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const done: string[] = [];
    const { host } = makeHost();
    const slow = (name: string) => builtin(manifest(name), (ctx) => {
      ctx.hooks.on("run.changed", async (call) => { (call.payload.run as { label: string | null }).label = "mutated"; await gate; done.push(name); });
    });
    await host.start([slow("one"), slow("two")]);
    const payload = samplePayload("run.changed");
    const t0 = Date.now();
    expect(host.hooks.fire("run.changed", "observe", payload, at("run-1"))).toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(50);
    expect(done).toEqual([]);
    release();
    await host.hooks.idle();
    expect(done.sort()).toEqual(["one", "two"]);
    expect(payload.run.label).toBe("test");
  });

  test("observe: a plugin's queue drops its oldest calls past the bound, counted, never a hook failure", async () => {
    const seen: string[] = [];
    const events: HostEvent[] = [];
    const { HookRegistry } = await import("../../packages/plugin/src/host/registry");
    const reg = new HookRegistry({ emit: (e) => { events.push(e); }, rank: () => 0, observeQueue: 2 });
    const ac = new AbortController();
    reg.attach("p", ac.signal);
    reg.on("p", "run.changed", (call) => { seen.push(String(call.payload.run.label)); });
    for (const label of ["1", "2", "3", "4"]) reg.fire("run.changed", "observe", { ...samplePayload("run.changed"), run: { ...samplePayload("run.changed").run, label } }, at("run-1"));
    await reg.idle();
    expect(seen).toEqual(["3", "4"]);
    expect(reg.stats("p")).toMatchObject({ calls: 2, dropped: 2, failures: 0 });
    expect(events).toEqual([]);
  });

  test("observe: calls queued before the breaker trips are skipped once it has", async () => {
    let calls = 0;
    const events: HostEvent[] = [];
    const { HookRegistry } = await import("../../packages/plugin/src/host/registry");
    const reg = new HookRegistry({ emit: (e) => { events.push(e); }, rank: () => 0 });
    reg.attach("p", new AbortController().signal);
    reg.on("p", "run.changed", () => { calls++; throw new Error("down"); });
    for (let i = 0; i < 5; i++) reg.fire("run.changed", "observe", samplePayload("run.changed"), at("run-1"));
    await reg.idle();
    expect(calls).toBe(3);
    expect(events.map((e) => e.type)).toEqual(["plugin.hook_failed", "plugin.hook_failed", "plugin.hook_failed", "plugin.suspended"]);
  });

  test("observe: a job.changed listener that declared `changes` is called, and counted as listening, for those kinds only", async () => {
    const got: Record<string, string[]> = { timer: [], all: [] };
    const listen = (name: string, decl: M) => builtin(manifest(name, hooks({ "job.changed": decl })), (ctx) => {
      ctx.hooks.on("job.changed", (call) => { got[name]!.push(call.payload.change.kind); });
    });
    const job = (change: M) => ({ ...samplePayload("job.changed"), change }) as ReturnType<typeof samplePayload<"job.changed">>;
    const { host } = makeHost();
    await host.start([listen("timer", { changes: ["fired"] })]);
    // Only a timer's listener: nobody wants a running job's output (the jobs service reads none, §6.6.19).
    expect(host.hooks.listening("job.changed")).toBe(true);
    expect(host.hooks.listening("job.changed", "fired")).toBe(true);
    expect(host.hooks.listening("job.changed", "output")).toBe(false);
    expect(host.hooks.listening("job.changed", "started")).toBe(false);
    for (const c of [{ kind: "started" }, { kind: "output", stdout: "x", stderr: "" }, { kind: "fired", n: 1 }, { kind: "ended", state: "done" }]) host.hooks.fire("job.changed", "observe", job(c), at("job-1"));
    await host.hooks.idle();
    expect(got.timer).toEqual(["fired"]);
    expect(host.hooks.stats("timer").calls).toBe(1);

    // One that declares none is called for every kind, as before.
    const { host: h2 } = makeHost();
    await h2.start([listen("timer", { changes: ["fired"] }), listen("all", {})]);
    expect(h2.hooks.listening("job.changed", "output")).toBe(true);
    for (const c of [{ kind: "output", stdout: "x", stderr: "" }, { kind: "fired", n: 2 }]) h2.hooks.fire("job.changed", "observe", job(c), at("job-1"));
    await h2.hooks.idle();
    expect(got.timer).toEqual(["fired", "fired"]);
    expect(got.all).toEqual(["output", "fired"]);
  });

  test("a hook fired with the wrong mode is refused", () => {
    const { host } = makeHost();
    expect(() => host.hooks.fire("merge.landing" as never, "observe", samplePayload("merge.landing") as never, at())).toThrow(/veto hook, fired as observe/);
  });
});

describe("failure policy, deadlines and the breaker (§6.4, §6.5)", () => {
  const thrower = (name: string, hook: HookName, decl: M = {}) => builtin(manifest(name, hooks({ [hook]: decl })), (ctx) => {
    ctx.hooks.on(hook, () => { throw new Error(`${name} broke`); });
  });

  test("gates fail closed; other veto/modify hooks open by default or closed when declared; observe always open", async () => {
    const { host, of } = makeHost();
    await host.start([thrower("gate", "verify.judging"), thrower("open", "agent.spawning"), thrower("closed", "agent.preparing", { failure: "closed" }), thrower("watch", "agent.changed")]);
    expect(await host.hooks.fire("verify.judging", "veto", samplePayload("verify.judging"), at())).toMatchObject({ decision: "deny", plugin: "gate", failure: "threw" });
    expect(await host.hooks.fire("agent.spawning", "modify", samplePayload("agent.spawning"), { ...at("agt-1"), apply: (p) => p })).toMatchObject({ decision: "allow", patches: [] });
    expect(await host.hooks.fire("agent.preparing", "modify", samplePayload("agent.preparing"), { ...at("agt-1"), apply: (p) => p })).toMatchObject({ decision: "deny", plugin: "closed", failure: "threw" });
    host.hooks.fire("agent.changed", "observe", samplePayload("agent.changed"), at("agt-1"));
    await host.hooks.idle();
    expect(of("plugin.hook_failed").map((e) => [e.data.plugin, e.data.kind, e.data.effect])).toEqual([["gate", "threw", "denied"], ["open", "threw", "skipped"], ["closed", "threw", "denied"], ["watch", "threw", "skipped"]]);
    expect(String(of("plugin.hook_failed")[0]!.data.message)).toBe("gate broke");
  });

  test("a gate declared open is refused at validation; a timeout over the hook's maximum too", async () => {
    const { host } = makeHost();
    await host.start([thrower("opener", "merge.landing", { failure: "open" }), thrower("slowpoke", "merge.landing", { timeoutMs: 120_000 })]);
    expect(state(host, "opener")).toBe("failed(invalid_manifest)");
    expect(state(host, "slowpoke")).toBe("failed(invalid_manifest)");
    expect(host.message("slowpoke")).toContain("maximum of 60000 ms");
  });

  test("the deadline: a listener that doesn't answer in time fails with timeout and its signal is aborted", async () => {
    let signal: AbortSignal | null = null;
    let deadline = "";
    const { host, of } = makeHost();
    await host.start([builtin(manifest("hang", hooks({ "merge.landing": { timeoutMs: 150 } })), (ctx) => {
      ctx.hooks.on("merge.landing", (call) => { signal = call.signal; deadline = call.deadline; return new Promise(() => {}); });
    })]);
    const t0 = Date.now();
    const r = await host.hooks.fire("merge.landing", "veto", samplePayload("merge.landing"), at("mrg-1"));
    const ms = Date.now() - t0;
    expect(r).toMatchObject({ decision: "deny", plugin: "hang", failure: "timeout" });
    expect(ms).toBeGreaterThanOrEqual(140);
    expect(ms).toBeLessThan(1000);
    expect(signal!.aborted).toBe(true);
    expect(Date.parse(deadline) - t0).toBeLessThan(400);
    expect(of("plugin.hook_failed")[0]!.data).toMatchObject({ kind: "timeout", effect: "denied" });
  });

  test("three failed calls in a row suspend a plugin: its gates deny without being called, its open listeners are skipped; enable resumes it", async () => {
    let calls = 0;
    let ok = false;
    const { host, of } = makeHost();
    await host.start([builtin(manifest("flaky", hooks({ "merge.landing": {}, "run.creating": {}, "run.changed": {} })), (ctx) => {
      ctx.hooks.on("merge.landing", () => { calls++; if (!ok) throw new Error("down"); return { decision: "allow" }; });
      ctx.hooks.on("run.creating", () => { calls++; return { decision: "allow" }; });
      ctx.hooks.on("run.changed", () => { calls++; });
    })]);
    const land = () => host.hooks.fire("merge.landing", "veto", samplePayload("merge.landing"), at("mrg-1"));
    for (let i = 0; i < 3; i++) expect(await land()).toMatchObject({ decision: "deny", failure: "threw" });
    expect(of("plugin.suspended").map((e) => e.data)).toEqual([{ plugin: "flaky", failures: 3, lastHook: "merge.landing" }]);
    expect(host.get("flaky")).toMatchObject({ state: "active", hooksSuspended: true, stats: { failures: 3 } });
    ok = true;
    const before = calls;
    expect(await land()).toMatchObject({ decision: "deny", plugin: "flaky", failure: "suspended" });
    expect(await host.hooks.fire("run.creating", "modify", samplePayload("run.creating"), { ...at("run-1"), apply: (p) => p })).toMatchObject({ decision: "allow" });
    host.hooks.fire("run.changed", "observe", samplePayload("run.changed"), at("run-1"));
    await host.hooks.idle();
    expect(calls).toBe(before);
    expect(of("plugin.hook_failed").at(-1)!.data).toMatchObject({ kind: "suspended", effect: "denied" });

    await host.enable("flaky", "operator");
    expect(of("plugin.resumed").map((e) => e.data)).toEqual([{ plugin: "flaky", by: "operator" }]);
    expect(host.get("flaky")!.hooksSuspended).toBe(false);
    expect(await land()).toEqual({ decision: "allow" });
  });

  test("a successful call resets the count", async () => {
    let n = 0;
    const { host, of } = makeHost();
    await host.start([builtin(manifest("bumpy", hooks({ "merge.landing": {} })), (ctx) => {
      ctx.hooks.on("merge.landing", () => { if (++n % 3 === 0) return { decision: "allow" }; throw new Error("bump"); });
    })]);
    for (let i = 0; i < 9; i++) await host.hooks.fire("merge.landing", "veto", samplePayload("merge.landing"), at("mrg-1"));
    expect(of("plugin.hook_failed").length).toBe(6);
    expect(of("plugin.suspended")).toEqual([]);
    expect(host.get("bumpy")!.stats).toMatchObject({ calls: 9, failures: 6 });
    expect(host.get("bumpy")!.stats.p50Ms).not.toBeNull();
  });

  test("while the daemon stops, a gate that fires is denied and other hooks do nothing", async () => {
    let called = 0;
    const { host } = makeHost();
    await host.start([builtin(manifest("late", hooks({ "merge.landing": {}, "agent.spawning": {} })), (ctx) => {
      ctx.hooks.on("merge.landing", () => { called++; return { decision: "allow" }; });
      ctx.hooks.on("agent.spawning", () => { called++; return { decision: "deny", reason: "no" }; });
    })]);
    await host.stop();
    expect(await host.hooks.fire("merge.landing", "veto", samplePayload("merge.landing"), at("mrg-1"))).toEqual({ decision: "deny", plugin: null, text: "daemon stopping", reasons: [], failure: null });
    expect(await host.hooks.fire("agent.spawning", "modify", samplePayload("agent.spawning"), { ...at("agt-1"), apply: (p) => p })).toMatchObject({ decision: "allow", patches: [] });
    expect(called).toBe(0);
  });
});

describe("lifecycle states (§5.4) and plugin.* events (§13.1)", () => {
  test("validation: schema, engines, duplicates, trust, enabled: false", async () => {
    const cb = (ctx: PluginContext) => { ctx.hooks.on("run.changed", () => {}); };
    const { host, of } = makeHost();
    await host.start([
      builtin({ ...manifest("broken"), apiVersion: "one" }, cb),
      builtin(manifest("old", { engines: { capcomd: ">=0.1.0 <0.2.0" } }), cb),
      builtin(manifest("future", { apiVersion: 2 }), cb),
      builtin(manifest("twin"), cb), { ...builtin(manifest("twin"), cb), source: "user" },
      { ...builtin(manifest("outsider"), cb), source: "project" },
      { ...builtin(manifest("resting"), cb), enabled: false },
      builtin(manifest("remote", { entry: { runtime: "process", command: ["bun", "./index.ts"] } }), cb),
    ]);
    expect(host.list().map((s) => `${s.name}:${s.cause ? `${s.state}(${s.cause})` : s.state}`)).toEqual([
      "twin:active", "broken:failed(invalid_manifest)", "old:failed(incompatible)", "future:failed(incompatible)", "twin:failed(duplicate)",
      "outsider:failed(untrusted)", "resting:validated(disabled)", "remote:validated",
    ]);
    expect(host.get("resting")!.enabled).toBe(false);
    expect(of("plugin.version_refused").map((e) => e.data)).toEqual([
      { plugin: "old", version: "1.0.0", engines: ">=0.1.0 <0.2.0", capcomd: "0.9.0", apiVersion: 1 },
      { plugin: "future", version: "1.0.0", engines: ">=0.0.0", capcomd: "0.9.0", apiVersion: 2 },
    ]);
    expect(of("plugin.duplicate_refused").map((e) => e.data)).toEqual([{ plugin: "twin", kept: "builtin", refused: "user", path: "(built-in)" }]);
    expect(of("plugin.failed").map((e) => [e.data.plugin, e.data.cause])).toEqual([["broken", "invalid_manifest"], ["outsider", "untrusted"]]);
    expect(of("plugin.loaded").map((e) => e.data.plugin)).toEqual(["twin"]);
    // An exemption for exactly that name@version (§4.4 allow-version) lets it load.
    const { host: h2 } = makeHost({ exempt: (n, v) => n === "old" && v === "1.0.0" });
    await h2.start([builtin(manifest("old", { engines: { capcomd: ">=0.1.0 <0.2.0" } }), cb)]);
    expect(state(h2, "old")).toBe("active");
  });

  test("activate that throws, hangs, or registers what the manifest doesn't declare fails, its partial registrations disposed", async () => {
    const cleaned: string[] = [];
    const { host, of } = makeHost({ activateTimeoutMs: 100 });
    await host.start([
      builtin(manifest("thrower", hooks({ "run.changed": {}, "agent.changed": {} })), (ctx) => { ctx.hooks.on("run.changed", () => {}); ctx.onDispose(() => { cleaned.push("thrower"); }); throw new Error("no config"); }),
      builtin(manifest("hanger"), (ctx) => { ctx.onDispose(() => { cleaned.push("hanger"); }); return new Promise(() => {}); }),
      builtin(manifest("greedy"), (ctx) => { ctx.hooks.on("run.changed", () => {}); try { ctx.hooks.on("merge.landing", () => ({ decision: "allow" })); } catch { /* swallowed: still a violation */ } }),
      builtin(manifest("fine"), (ctx) => { ctx.hooks.on("run.changed", () => {}); }),
    ]);
    expect([state(host, "thrower"), state(host, "hanger"), state(host, "greedy"), state(host, "fine")]).toEqual(["failed(activate_threw)", "failed(activate_timeout)", "failed(conflict)", "active"]);
    expect(cleaned.sort()).toEqual(["hanger", "thrower"]);
    expect(host.hooks.order("run.changed")).toEqual(["fine"]);
    expect(Object.fromEntries(of("plugin.failed").map((e) => [e.data.plugin, e.data.message]))).toEqual({ thrower: "no config", hanger: "activate did not return within 100 ms", greedy: expect.stringContaining("hook merge.landing") });
  });

  test("disable disposes every registration (§5.3, §14.1); enable runs the same module's activate again", async () => {
    let activations = 0;
    let calls = 0;
    const log: string[] = [];
    const m = manifest("full", {
      scopes: ["read", "steer"],
      provides: ["seam:sandbox/full", "source:full"],
      contributes: {
        hooks: { "merge.landing": {}, "run.changed": {} }, seams: [{ kind: "sandbox", name: "full" }], sources: [{ name: "full", summary: "Test source" }],
        cli: [{ name: "fullcli", summary: "A command" }], mcp: [{ name: "do_it", summary: "A tool" }], api: [{ method: "GET", path: "/status", scope: "read" }],
        ui: [{ kind: "card", id: "fullCard" }], events: ["thing"],
      },
    });
    const mod = {
      activate(ctx: PluginContext) {
        activations++;
        ctx.hooks.on("merge.landing", () => { calls++; return { decision: "allow" }; });
        ctx.hooks.on("run.changed", () => { calls++; });
        ctx.seams.sandbox({ describe: () => ({ name: "full" }) } as never);
        ctx.cli.command({ name: "fullcli", summary: "A command", usage: [], run: async () => ({ schema: "relay.v1", ok: true }) });
        ctx.mcp.tool({ name: "do_it", description: "Do it", inputSchema: { type: "object" }, run: async () => ({ schema: "relay.v1", ok: true }) });
        ctx.mcp.instructions("Use do_it.");
        ctx.api.route({ method: "GET", path: "/status", scope: "read", handler: async () => ({}) });
        ctx.api.capability("thing", "A thing");
        ctx.ui.descriptor({ kind: "card", id: "fullCard", title: "Full", read: async () => ({ lines: [], state: "ok" }) });
        ctx.events.subscribe("daemon", {}, () => {});
        ctx.onDispose(async () => { log.push("first"); });
        ctx.onDispose(() => { log.push(`second:${ctx.signal.aborted}`); });
      },
    };
    // The subscription is the host's (src/plugins/events.ts in the daemon): disposed with the rest.
    const { host, of } = makeHost({ sinks: { subscribe: (stream) => ({ dispose: () => { log.push(`unsubscribed:${stream}`); } }) } });
    await host.start([{ source: "builtin", manifest: m, module: mod as PluginModule<never> }]);
    expect(host.get("full")).toMatchObject({ state: "active", hooks: ["merge.landing", "run.changed"], seams: [{ kind: "sandbox", name: "full" }] });
    const store = () => (["seam", "cli", "mcp", "instructions", "api", "capability", "ui"] as const).map((k) => host.contributions.list(k).map((x) => x.key)).flat();
    expect(store()).toEqual(["sandbox/full", "fullcli", "capcomd_full_do_it", "full", "GET /v1/x/full/status", "x.full.thing", "full/fullCard"]);
    expect(of("plugin.loaded")[0]!.data).toMatchObject({ plugin: "full", hooks: ["merge.landing", "run.changed"], seams: ["sandbox/full"] });

    await host.disable("full");
    expect(log).toEqual(["second:true", "first", "unsubscribed:daemon"]);
    expect(store()).toEqual([]);
    expect(host.hooks.order("merge.landing")).toEqual([]);
    expect(await host.hooks.fire("merge.landing", "veto", samplePayload("merge.landing"), at("mrg-1"))).toEqual({ decision: "allow" });
    host.hooks.fire("run.changed", "observe", samplePayload("run.changed"), at("run-1"));
    await host.hooks.idle();
    expect(calls).toBe(0);
    expect(host.get("full")).toMatchObject({ state: "disposed", cause: "disabled", enabled: false });
    expect(of("plugin.disposed").map((e) => e.data)).toEqual([{ plugin: "full", cause: "disabled" }]);

    await host.enable("full");
    expect(activations).toBe(2);
    expect(host.get("full")).toMatchObject({ state: "active", enabled: true, cause: null });
    expect(store().length).toBe(7);
    expect(await host.hooks.fire("merge.landing", "veto", samplePayload("merge.landing"), at("mrg-1"))).toEqual({ decision: "allow" });
    expect(calls).toBe(1);
  });

  test("disposal has a 10 s budget: past it the rest is dropped (inert) and dispose_timeout recorded", async () => {
    const { host } = makeHost({ disposeBudgetMs: 100 });
    let later = false;
    await host.start([builtin(manifest("stuck"), (ctx) => {
      ctx.hooks.on("run.changed", () => {});
      ctx.onDispose(() => { later = true; });
      ctx.onDispose(() => new Promise(() => {}));
    })]);
    const t0 = Date.now();
    await host.stop();
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(host.get("stuck")).toMatchObject({ state: "disposed", cause: "dispose_timeout" });
    expect(later).toBe(false);
    expect(host.hooks.order("run.changed")).toEqual([]);
  });

  test("the context checks scopes and disposal; primitives the kernel doesn't serve yet are unsupported", async () => {
    let ctx!: PluginContext;
    const { host } = makeHost();
    await host.start([builtin(manifest("bare", hooks({ "run.changed": {} }, { events: ["thing"] })), (c) => { ctx = c; c.hooks.on("run.changed", () => {}); })]);
    await expect(ctx.runs.get("run-1")).rejects.toMatchObject({ code: "forbidden" });
    await expect(ctx.events.emit({ type: "thing", stream: "daemon", entity: "x", text: "hi", data: {} })).rejects.toMatchObject({ code: "forbidden" });
    await expect(ctx.storage.get("daemon", "k")).rejects.toMatchObject({ code: "unsupported" });
    expect(ctx.principal).toEqual({ kind: "plugin", name: "bare", scopes: [] });
    expect(() => ctx.hooks.on("run.changed", () => {})).toThrow(/already listens/);
    await host.stop();
    expect(ctx.signal.aborted).toBe(true);
    expect(() => ctx.onDispose(() => {})).toThrow(/disposing/);
  });

  test("a plugin's events go through the host: declared types, redacted data, plugin.<name>.<type>", async () => {
    const out: Array<{ type: string; stream: string; entity: string; text: string; data: Record<string, unknown> }> = [];
    let ctx!: PluginContext;
    const { host } = makeHost({ sinks: { emit: async (e) => { out.push(e); return { seq: out.length }; }, redact: (t) => t.replace(/sk-ant-\w+/g, "[REDACTED]") } });
    await host.start([builtin(manifest("talker", { scopes: ["steer"], ...hooks({ "run.changed": {} }, { events: ["said"] }) }), (c) => { ctx = c; c.hooks.on("run.changed", () => {}); })]);
    expect(await ctx.events.emit({ type: "said", stream: "daemon", entity: "talker", text: "key sk-ant-abc123", data: { key: "sk-ant-abc123", n: 1 } })).toEqual({ seq: 1 });
    expect(out).toEqual([{ type: "plugin.talker.said", stream: "daemon", entity: "talker", text: "key [REDACTED]", data: { key: "[REDACTED]", n: 1 } }]);
    await expect(ctx.events.emit({ type: "other", stream: "daemon", entity: "talker", text: "x", data: {} })).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("the test kit (§14.5)", () => {
  const examples = join(ROOT, "packages", "plugin", "examples");
  for (const name of readdirSync(examples).sort()) {
    const loaded = readManifest(join(examples, name), { capcomd: "0.9.0" });
    if (!loaded.ok || loaded.manifest.entry.runtime !== "in-process") continue;
    test(`${name}: loadDispose and hookContract (§14.1, §14.4)`, async () => {
      const mod = (await import(join(examples, name, "index.ts"))).plugin as PluginModule;
      await testkit.loadDispose(loaded.manifest, mod);
      await testkit.hookContract(loaded.manifest, mod);
    });
  }

  test("validateManifest runs the §4.9 checks: containment, kernel commands, engines", async () => {
    const dir = mkdtempSync(join(tmpdir(), "capcomd-plugin-manifest-"));
    const write = (m: M) => writeFileSync(join(dir, "plugin.json"), JSON.stringify(m));
    writeFileSync(join(dir, "index.ts"), "export const plugin = { activate() {} };\n");
    write(manifest("ok"));
    expect(await testkit.validateManifest(dir, { capcomd: "0.9.0" })).toMatchObject({ ok: true });
    write(manifest("escape", { entry: { runtime: "in-process", module: "./../outside.ts" } }));
    expect(await testkit.validateManifest(dir)).toMatchObject({ ok: false, issues: [{ path: "entry.module", message: expect.stringContaining("outside the plugin's directory") }] });
    write(manifest("taker", { contributes: { cli: [{ name: "merge", summary: "Mine" }] } }));
    expect(await testkit.validateManifest(dir)).toMatchObject({ ok: false, issues: [{ path: "contributes.cli.0.name", message: expect.stringContaining("kernel command") }] });
    write(manifest("old", { engines: { capcomd: "<0.5.0" } }));
    expect(await testkit.validateManifest(dir, { capcomd: "0.9.0" })).toMatchObject({ ok: false, issues: [{ path: "engines.capcomd" }] });
    write(manifest("garbage", { engines: { capcomd: "sometime soon" } }));
    expect(await testkit.validateManifest(dir)).toMatchObject({ ok: false, issues: [{ path: "engines.capcomd", message: expect.stringContaining("not a semver range") }] });
  });

  test("loadDispose catches a declaration the code never registers, and a registration it didn't declare", async () => {
    const m = (await import("../../packages/plugin/src/manifest")).PluginManifest.parse(manifest("half", hooks({ "run.changed": {}, "agent.changed": {} })));
    await expect(testkit.loadDispose(m, { activate(ctx) { ctx.hooks.on("run.changed", () => {}); } })).rejects.toThrow(/never registers: hook agent.changed/);
    await expect(testkit.loadDispose(m, { activate(ctx) { ctx.hooks.on("run.changed", () => {}); ctx.hooks.on("agent.changed", () => {}); ctx.hooks.on("merge.landing", () => ({ decision: "allow" })); } })).rejects.toThrow(/doesn't declare: hook merge.landing/);
  });

  test("a fake context fires a listener as the host would, and call() builds a HookCall for unit tests", async () => {
    const m = (await import("../../packages/plugin/src/manifest")).PluginManifest.parse(manifest("unit", { scopes: ["steer"], ...hooks({ "merge.landing": {} }, { events: ["seen"] }) }));
    const fake = testkit.fakeContext(m);
    await testkit.load(fake, { activate(ctx) { ctx.hooks.on("merge.landing", async (call) => { await ctx.events.emit({ type: "seen", stream: call.runId!, entity: call.payload.merge.mrgId, text: "Seen.", data: { key: call.idempotencyKey } }); return { decision: "deny", reason: "seen" }; }); } });
    const r = await fake.fire("merge.landing", samplePayload("merge.landing"), { runId: "run-1" });
    expect(r).toMatchObject({ result: { decision: "deny", reason: "seen" }, failure: null });
    expect(fake.emitted()).toEqual([{ type: "plugin.unit.seen", stream: "run-1", data: { key: "merge.landing:run-1:1" } }]);
    const call: HookCall<"run.changed"> = testkit.call("run.changed", samplePayload("run.changed"), { timeoutMs: 50 });
    expect(call).toMatchObject({ hook: "run.changed", mode: "observe", payloadVersion: 1 });
    await sleep(80);
    expect(call.signal.aborted).toBe(true);
    expect(await fake.dispose()).toEqual([]);
  });

  test("a fake context, like the host, doesn't call a job.changed listener for a kind its `changes` leave out (§4.7)", async () => {
    const m = (await import("../../packages/plugin/src/manifest")).PluginManifest.parse(manifest("starts", hooks({ "job.changed": { changes: ["started", "ended"] } })));
    const got: string[] = [];
    const mod: PluginModule = { activate(ctx) { ctx.hooks.on("job.changed", (call) => { got.push(call.payload.change.kind); }); } };
    const fake = testkit.fakeContext(m);
    await testkit.load(fake, mod);
    // A test that fires an output frame at it can't pass on a call the daemon never makes.
    await expect(fake.fire("job.changed", { ...samplePayload("job.changed"), change: { kind: "output", stdout: "x", stderr: "" } })).rejects.toThrow(/starts is not called for job.changed output: its manifest's changes are started, ended/);
    await expect(fake.fire("job.changed", samplePayload("job.changed"))).rejects.toThrow(/not called for job.changed fired/);
    expect(await fake.fire("job.changed", { ...samplePayload("job.changed"), change: { kind: "started" } })).toMatchObject({ failure: null });
    expect(got).toEqual(["started"]);
    await fake.dispose();
    // The hook contract calls it with a change it declared, not the sample's `fired`.
    await testkit.hookContract(m, mod);
  });
});

describe("GET /v1/plugins and capcomd plugins list (§13.2)", () => {
  test("the API lists the host's plugins in the contract's shape, with the read scope; health names the capability", async () => {
    const dir = mkdtempSync(join(tmpdir(), "capcomd-plugins-api-"));
    const cpath = join(dir, "clients.json");
    const token = addClient("reader", ["read"], cpath).token;
    const { host } = makeHost();
    await host.start([builtin(manifest("listed"), (ctx) => { ctx.hooks.on("run.changed", () => {}); }), builtin({ ...manifest("bad"), name: "Bad!" }, () => {})]);
    const app = harnessApp({ source: memorySource({}), clients: () => loadClients(cpath), state: harnessState(null), plugins: () => host.list() });
    const res = await app.request("/v1/plugins", { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const body = Plugins.parse(await res.json());
    expect(body.plugins.map((p) => [p.name, p.state, p.cause])).toEqual([["listed", "active", null], ["plugin-2", "failed", "invalid_manifest"]]);
    expect(body.plugins[0]).toMatchObject({ apiVersion: 1, runtime: "in-process", source: "builtin", enabled: true, hooks: ["run.changed"], seams: [], hooksSuspended: false, stats: { calls: 0, failures: 0, dropped: 0, p50Ms: null, p95Ms: null, lastFailureAt: null } });
    expect((await app.request("/v1/plugins")).status).toBe(401);
    const empty = harnessApp({ source: memorySource({}), clients: () => loadClients(cpath), state: harnessState(null) });
    expect(await (await empty.request("/v1/plugins", { headers: { authorization: `Bearer ${token}` } })).json()).toEqual({ plugins: [] });
    expect(CAPABILITY_NAMES).toContain("plugins");
    expect(((await (await app.request("/v1/health")).json()) as { capabilities: string[] }).capabilities).toContain("plugins");
  });

  test("POST /v1/plugins/{name}/disable refuses a built-in (409) except the watchdog, which a person turns on and may turn off", async () => {
    const dir = mkdtempSync(join(tmpdir(), "capcomd-plugins-toggle-"));
    const cpath = join(dir, "clients.json");
    const token = addClient("operator", ["read", "configure"], cpath).token;
    const { BUILTINS, candidateOf } = await import("../../src/plugins/builtins");
    const { host } = makeHost();
    await host.start(BUILTINS.filter((b) => ["forge-git", "watchdog"].includes((b.manifest as M).name as string)).map((b) => ({ ...candidateOf(b), enabled: true })));
    const app = harnessApp({ source: memorySource({}), clients: () => loadClients(cpath), state: harnessState(null), plugins: () => host.list(), pluginHost: host });
    const post = (p: string, key: string) => app.request(p, { method: "POST", headers: { authorization: `Bearer ${token}`, "idempotency-key": key } });
    const refused = await post("/v1/plugins/forge-git/disable", "key-toggle-1");
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "conflict", message: "forge-git is built into capcomd: it can't be disabled" });
    expect(host.get("forge-git")).toMatchObject({ state: "active" });
    const off = await post("/v1/plugins/watchdog/disable", "key-toggle-2");
    expect(off.status).toBe(200);
    expect(await off.json()).toMatchObject({ name: "watchdog", state: "disposed", cause: "disabled", enabled: false });
    await host.stop();
  });

  test("capcomd plugins list: the running daemon's listing, else what one would load (the built-ins)", async () => {
    const home = mkdtempSync(join(tmpdir(), "capcomd-plugins-cli-"));
    const cli = (...args: string[]) => {
      const p = Bun.spawnSync([process.execPath, join(ROOT, "src", "cli", "index.ts"), "plugins", ...args], { env: { ...process.env, CAPCOMD_HOME: home, CAPCOMD_NO_CONFIG: "1" }, stdout: "pipe", stderr: "pipe" });
      return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
    };
    const none = cli("list", "--json");
    expect(none.code).toBe(0);
    // No daemon: the built-ins, resolved, never run (§17.2 step 3 ships the sandbox providers; later steps add more).
    const would = JSON.parse(none.out) as { schema: string; ok: boolean; daemon: null; plugins: Array<{ name: string; state: string }> };
    expect(would).toMatchObject({ schema: "relay.v1", ok: true, daemon: null });
    expect(would.plugins.filter((p) => p.name.startsWith("sandbox-")).map((p) => [p.name, p.state])).toEqual([["sandbox-docker", "resolved"], ["sandbox-boxd", "resolved"], ["sandbox-fake", "resolved"], ["sandbox-fake-host", "resolved"]]);
    expect(cli("list").out).toMatch(/^Plugins \(no daemon is running; this is what one would load\):\n(.|\n)*sandbox-boxd\s+\S+\s+builtin\s+resolved\s+1 hook, sandbox boxd/);
    // Step 5 adds the reviewer gate.
    expect(would.plugins.find((p) => p.name === "gate-reviewer")).toMatchObject({ source: "builtin", state: "resolved", hooks: ["verify.starting", "verify.judging"] });
    expect(cli("list").out).toMatch(/no daemon is running; this is what one would load[\s\S]*gate-reviewer/);
    // A daemon's listing (this process stands in for the daemon: its pid is alive).
    const { host } = makeHost();
    await host.start([builtin(manifest("shown"), (ctx) => { ctx.hooks.on("run.changed", () => {}); })]);
    mkdirSync(join(home, "state"), { recursive: true });
    writeFileSync(join(home, "state", "plugins.json"), JSON.stringify({ pid: process.pid, at: "2026-11-05T00:00:00.000Z", plugins: host.list() }));
    const live = JSON.parse(cli("list", "--json").out);
    expect(live).toMatchObject({ ok: true, daemon: { pid: process.pid }, plugins: [{ name: "shown", state: "active" }] });
    expect(cli("list").out).toMatch(/shown\s+1\.0\.0\s+builtin\s+active\s+1 hook/);
    expect(cli("frobnicate").code).toBe(2);
  });

  test("a plugin's MCP tools, as the server names them: declared before it runs, registered while active, in the contract's shape", async () => {
    const tools = { contributes: { hooks: { "run.changed": {} }, mcp: [{ name: "ping", summary: "Ping" }, { name: "pong", summary: "Pong" }] } };
    // Registers only one of the two it declares: the active listing says what it registered.
    const p = builtin(manifest("tool-box", tools), (ctx) => {
      ctx.hooks.on("run.changed", () => {});
      ctx.mcp.tool({ name: "ping", description: "Ping", inputSchema: { type: "object" }, run: async () => ({ schema: "relay.v1", ok: true }) });
    });
    const { host } = makeHost();
    expect(host.plan([p]).find((x) => x.name === "tool-box")?.tools).toEqual(["capcomd_tool_box_ping", "capcomd_tool_box_pong"]);
    expect(host.detail("tool-box")?.tools).toEqual(["capcomd_tool_box_ping", "capcomd_tool_box_pong"]);
    const { host: running } = makeHost();
    await running.start([p, builtin(manifest("no-tools"), (ctx) => { ctx.hooks.on("run.changed", () => {}); })]);
    expect(running.get("tool-box")).toMatchObject({ state: "active", tools: ["capcomd_tool_box_ping"] });
    expect(running.get("no-tools")).not.toHaveProperty("tools");
    expect(Plugins.parse({ plugins: running.list() }).plugins.find((x) => x.name === "tool-box")?.tools).toEqual(["capcomd_tool_box_ping"]);
    await running.stop();
  });

  test("capcomd plugins show front-mcp and list: its command and its tools, by the names capcomd mcp serves them", () => {
    const home = mkdtempSync(join(tmpdir(), "capcomd-plugins-cli-"));
    const cli = (...args: string[]) => {
      const p = Bun.spawnSync([process.execPath, join(ROOT, "src", "cli", "index.ts"), "plugins", ...args], { env: { ...process.env, CAPCOMD_HOME: home, CAPCOMD_NO_CONFIG: "1" }, stdout: "pipe", stderr: "pipe" });
      return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
    };
    const show = cli("show", "front-mcp", "--json");
    expect(show.code).toBe(0);
    const { plugin } = JSON.parse(show.out) as { plugin: { commands: string[]; tools: string[]; manifest: { contributes: { mcp: Array<{ name: string }> } } } };
    expect(plugin.commands).toEqual(["mcp"]);
    // A kernel front door's tools are capcomd_<tool> (§4.7.2), one per tool its manifest declares.
    expect(plugin.tools).toEqual(plugin.manifest.contributes.mcp.map((t) => `capcomd_${t.name}`));
    expect(plugin.tools).toContain("capcomd_spawn");
    expect(cli("show", "front-mcp").out).toMatch(/\n {2}commands: capcomd mcp\n {2}MCP tools: capcomd_\w+, [^\n]*capcomd_spawn/);
    const listed = (JSON.parse(cli("list", "--json").out) as { plugins: Array<{ name: string; commands?: string[]; tools?: string[] }> }).plugins;
    expect(listed.find((p) => p.name === "front-mcp")).toMatchObject({ commands: ["mcp"], tools: plugin.tools });
    expect(listed.find((p) => p.name === "sandbox-docker")).not.toHaveProperty("tools");
    expect(cli("list").out).toMatch(new RegExp(`front-mcp\\s+\\S+\\s+builtin\\s+resolved\\s+1 command, ${plugin.tools.length} MCP tools`));
  });
});

describe("capcomd plugins validate --strict: the attention budget (§16.5)", () => {
  const home = mkdtempSync(join(tmpdir(), "capcomd-plugins-strict-"));
  const validate = (...args: string[]) => {
    const p = Bun.spawnSync([process.execPath, join(ROOT, "src", "cli", "index.ts"), "plugins", "validate", ...args], { env: { ...process.env, CAPCOMD_HOME: home, CAPCOMD_NO_CONFIG: "1" }, stdout: "pipe", stderr: "pipe" });
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
  };
  type V = { ok: boolean; plugins: Array<{ name: string; ok: boolean; warnings: Array<{ path: string; message: string }> }> };
  const json = (...args: string[]) => { const r = validate(...args, "--json"); return { code: r.code, body: JSON.parse(r.out) as V }; };
  const example = join(ROOT, "packages", "plugin", "examples", "slack-notifier");
  /** The Slack example's manifest in a directory of its own, changed by `edit`. */
  const slackCopy = (edit: (m: any) => void) => {
    const dir = mkdtempSync(join(tmpdir(), "capcomd-slack-"));
    const m = JSON.parse(readFileSync(join(example, "plugin.json"), "utf8"));
    edit(m);
    writeFileSync(join(dir, "plugin.json"), JSON.stringify(m));
    writeFileSync(join(dir, "index.ts"), "");
    return dir;
  };
  const quietWarning = expect.objectContaining({ path: "config.properties.quiet", message: expect.stringContaining("no quiet option") });

  test("the Slack example has its quiet option: no warning", () => {
    const r = json(example, "--strict");
    expect(r.code).toBe(0);
    expect(r.body.plugins[0]).toMatchObject({ name: "slack-notifier", ok: true, warnings: [] });
  });

  test("without its quiet property it warns under --strict (and still passes), and says nothing without --strict", () => {
    const dir = slackCopy((m) => { delete m.config.properties.quiet; });
    const strict = json(dir, "--strict");
    expect(strict.code).toBe(0);
    expect(strict.body).toMatchObject({ ok: true, plugins: [{ name: "slack-notifier", ok: true, warnings: [quietWarning] }] });
    const text = validate(dir, "--strict");
    expect(text.code).toBe(0);
    expect(text.out).toContain("✓ slack-notifier 1.0.0");
    expect(text.out).toContain("    ! config.properties.quiet: it observes run.changed and agent.changed");
    const plain = json(dir);
    expect(plain.code).toBe(0);
    expect(plain.body.plugins[0]!.warnings).toEqual([]);
    expect(validate(dir).out).not.toContain("quiet");
    // No config at all is the same: nothing to turn it down with.
    expect(json(slackCopy((m) => { delete m.config; }), "--strict").body.plugins[0]!.warnings).toEqual([quietWarning]);
  });

  test("only a notifier's shape warns: run.changed and agent.changed both observed; a quiet option in a $ref schema counts", () => {
    // Observes run.changed alone (and merge.changed): not notifier-shaped.
    expect(json(slackCopy((m) => { delete m.config.properties.quiet; delete m.contributes.hooks["agent.changed"]; }), "--strict").body.plugins[0]!.warnings).toEqual([]);
    expect(json(slackCopy((m) => { delete m.config.properties.quiet; delete m.contributes.hooks["run.changed"]; }), "--strict").body.plugins[0]!.warnings).toEqual([]);
    // Its config schema in a file of its own, quiet in it: no warning; without it, the warning.
    const ref = (withQuiet: boolean) => {
      let schema: any;
      const dir = slackCopy((m) => { schema = m.config; m.config = { $ref: "./config.schema.json" }; });
      if (!withQuiet) delete schema.properties.quiet;
      writeFileSync(join(dir, "config.schema.json"), JSON.stringify(schema));
      return dir;
    };
    expect(json(ref(true), "--strict").body.plugins[0]).toMatchObject({ ok: true, warnings: [] });
    expect(json(ref(false), "--strict").body.plugins[0]).toMatchObject({ ok: true, warnings: [quietWarning] });
  });

  test("every built-in passes --strict with no attention warning (none is a notifier)", () => {
    const r = json("--strict");
    expect(r.code).toBe(0);
    expect(r.body.ok).toBe(true);
    expect(r.body.plugins.flatMap((p) => p.warnings.filter((w) => w.path === "config.properties.quiet").map(() => p.name))).toEqual([]);
  });
});

describe("kernel facts the package keeps", () => {
  // KERNEL_COMMANDS against the CLI's commands: tests/plugins/front-doors.test.ts.

  test("engines ranges include prereleases (§4.4)", () => {
    expect(satisfies("0.10.0-rc.1", ">=0.9.0 <1.0.0")).toBe(true);
    expect(satisfies("1.0.0-rc.1", "<1.0.0")).toBe(true);
    expect(satisfies("1.0.0", ">=0.9.0 <1.0.0")).toBe(false);
    expect(satisfies("0.9.3", "^0.9.0")).toBe(true);
    expect(satisfies("0.9.0", "anything")).toBe(false);
  });
});

describe("the mode-consistency script (§14.4)", () => {
  test("every hooks.fire( site in src/ uses the hook's mode", () => {
    expect(checkHookModes(join(ROOT, "src"))).toEqual([]);
    const p = Bun.spawnSync([process.execPath, join(ROOT, "scripts", "check-hook-modes.ts")], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    expect(p.exitCode).toBe(0);
  });

  test("it finds a wrong mode, an unknown hook and a call it can't read", () => {
    const dir = mkdtempSync(join(tmpdir(), "capcomd-hook-modes-"));
    writeFileSync(join(dir, "good.ts"), `await host.hooks.fire("merge.landing", "veto", payload, o);\nthis.hooks.fire("run.changed", "observe", p, o);\n`);
    writeFileSync(join(dir, "bad.ts"), `hooks.fire("run.changed", "veto", p, o);\nhooks.fire("run.started", "observe", p, o);\nhooks.fire(name, "observe", p, o);\n`);
    expect(hookSites(dir).length).toBe(5);
    expect(checkHookModes(dir).map((l) => l.replace(/^.*\//, ""))).toEqual([
      "bad.ts:1: run.changed is an observe hook, fired as veto",
      "bad.ts:2: unknown hook run.started",
      "bad.ts:3: hooks.fire( needs the hook name and the mode as string literals",
    ]);
    const p = Bun.spawnSync([process.execPath, join(ROOT, "scripts", "check-hook-modes.ts"), dir], { stdout: "pipe", stderr: "pipe" });
    expect(p.exitCode).toBe(1);
  });
});

describe("observability (§13.3-§13.5)", () => {
  const runTrace = (runId: string) => createHash("sha256").update(`trace:${runId}`).digest("hex").slice(0, 32);
  /** A kernel host (src/plugins/host.ts) whose spans go to a fresh trace directory; `lines`: its daemon-log lines. */
  async function kernel(candidates: Candidate[]) {
    const dir = mkdtempSync(join(tmpdir(), "capcomd-plugin-trace-"));
    const was = process.env.CAPCOMD_TRACE_DIR;
    process.env.CAPCOMD_TRACE_DIR = dir;
    resetSpans();
    const lines: Record<string, unknown>[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => { try { lines.push(JSON.parse(String(a[0]))); } catch { log(...a); } };
    const host = kernelHost({});
    await host.start(candidates);
    const done = async () => {
      await host.stop();
      console.log = log;
      if (was === undefined) delete process.env.CAPCOMD_TRACE_DIR; else process.env.CAPCOMD_TRACE_DIR = was;
    };
    const trace = (runId: string) => readTrace(readFileSync(tracePath(runId, dir), "utf8"));
    return { host, lines, trace, done };
  }

  test("each hook call is a plugin.hook span in the run's trace, with its outcome; call.trace names that span", async () => {
    const calls: HookCall[] = [];
    let answer: "deny" | "allow" = "deny";
    const k = await kernel([builtin(manifest("bouncer", hooks({ "merge.landing": {} })), (ctx) => {
      ctx.hooks.on("merge.landing", (call) => { calls.push(call as HookCall); return answer === "deny" ? { decision: "deny", reason: "not today" } : { decision: "allow" }; });
    })]);
    try {
      const o = { principal: OPERATOR, entity: "mrg-1", runId: "run-trace-1", agentId: "agt-1" };
      expect((await k.host.hooks.fire("merge.landing", "veto", samplePayload("merge.landing"), o)).decision).toBe("deny");
      answer = "allow";
      expect((await k.host.hooks.fire("merge.landing", "veto", samplePayload("merge.landing"), o)).decision).toBe("allow");
      const spans = k.trace("run-trace-1").filter((s) => s.name === "plugin.hook");
      expect(spans.map((s) => s.attributes.outcome)).toEqual(["deny", "allow"]);
      expect(spans[0]!.attributes).toMatchObject({ plugin: "bouncer", hook: "merge.landing", mode: "veto", callId: calls[0]!.callId, "relay.run_id": "run-trace-1", "relay.agent_id": "agt-1" });
      expect(spans[0]!.attributes["failure.kind"]).toBeUndefined();
      expect(spans[0]!.traceId).toBe(runTrace("run-trace-1"));
      expect(spans[0]!.parentSpanId).toBe(agentSpanId("run-trace-1", "agt-1"));
      // An out-of-process plugin continues the trace under its call's span.
      expect(calls.map((c) => c.trace)).toEqual(spans.map((s) => ({ traceId: s.traceId, spanId: s.spanId })));
    } finally { await k.done(); }
  });

  test("a failed call's span says failed and why; a suspended plugin's open listener is skipped", async () => {
    const spans: HookSpan[] = [];
    const { host } = makeHost({ hookSpan: (s) => { spans.push(s); } });
    await host.start([builtin(manifest("broken", hooks({ "run.changed": {} })), (ctx) => { ctx.hooks.on("run.changed", () => { throw new Error("boom"); }); })]);
    for (let i = 0; i < 3; i++) host.hooks.fire("run.changed", "observe", samplePayload("run.changed"), at("run-1"));
    await host.hooks.idle();
    host.hooks.fire("run.changed", "observe", samplePayload("run.changed"), at("run-1"));
    await host.hooks.idle();
    expect(spans.map((s) => [s.attributes.outcome, s.attributes["failure.kind"] ?? null])).toEqual([["failed", "threw"], ["failed", "threw"], ["failed", "threw"], ["skipped", null]]);
    expect(spans.every((s) => s.runId === "run-1" && s.attributes.mode === "observe")).toBe(true);
    await host.stop();
  });

  test("ctx.trace.span inside a hook call is a child of the call's span; a log line there carries the run and the trace", async () => {
    const k = await kernel([builtin(manifest("tracer", hooks({ "run.changed": {} })), (ctx) => {
      ctx.hooks.on("run.changed", async () => {
        ctx.log.info("before the lookup");
        await ctx.trace.span("lookup", async (s) => { s.setAttributes({ rows: 3 }); ctx.log.info("inside the lookup"); });
      });
    })]);
    try {
      k.host.hooks.fire("run.changed", "observe", samplePayload("run.changed"), { principal: OPERATOR, entity: "run-trace-2", runId: "run-trace-2", agentId: "agt-2" });
      await k.host.hooks.idle();
      const spans = k.trace("run-trace-2");
      const call = spans.find((s) => s.name === "plugin.hook")!;
      const own = spans.find((s) => s.name === "plugin.tracer.lookup")!;
      expect(call.attributes).toMatchObject({ plugin: "tracer", outcome: "allow" });
      expect(own).toMatchObject({ traceId: call.traceId, parentSpanId: call.spanId, attributes: { plugin: "tracer", rows: 3, "relay.run_id": "run-trace-2" }, status: { code: 1 } });
      const mine = k.lines.filter((l) => l.plugin === "tracer");
      expect(mine.map((l) => l.message)).toEqual(["before the lookup", "inside the lookup"]);
      expect(mine[0]).toMatchObject({ runId: "run-trace-2", agentId: "agt-2", traceId: runTrace("run-trace-2"), spanId: call.spanId });
      expect(mine[1]).toMatchObject({ runId: "run-trace-2", traceId: runTrace("run-trace-2"), spanId: own.spanId });
    } finally { await k.done(); }
  });

  test("a plugin's span can't pick the run's trace it goes to or the plugin it names, and is redacted like its logs", async () => {
    const k = await kernel([builtin(manifest("sneaky", hooks({ "run.changed": {} })), async (ctx) => {
      await ctx.trace.span("forge", async (s) => { s.setAttributes({ "relay.run_id": "run-victim", plugin: "other" }); });
      ctx.hooks.on("run.changed", async () => {
        await ctx.trace.span("inside", async (s) => { s.setAttributes({ "relay.run_id": "run-victim", "relay.agent_id": "agt-x", plugin: "other", note: "fine" }); });
      });
    })]);
    try {
      expect(existsSync(tracePath("run-victim", process.env.CAPCOMD_TRACE_DIR!))).toBe(false);
      k.host.hooks.fire("run.changed", "observe", samplePayload("run.changed"), { principal: OPERATOR, entity: "run-mine", runId: "run-mine", agentId: "agt-3" });
      await k.host.hooks.idle();
      expect(existsSync(tracePath("run-victim", process.env.CAPCOMD_TRACE_DIR!))).toBe(false);
      const own = k.trace("run-mine").find((s) => s.name === "plugin.sneaky.inside")!;
      expect(own.attributes).toEqual({ plugin: "sneaky", note: "fine", "relay.run_id": "run-mine", "relay.agent_id": "agt-3" });
    } finally { await k.done(); }
    const spans: Array<{ attributes: Record<string, unknown>; events: string[] }> = [];
    const { host } = makeHost({ sinks: { redact: (t) => t.replaceAll("hunter2", "[redacted]"), span: (s) => { spans.push(s); } } });
    await host.start([builtin(manifest("leaky"), async (ctx) => {
      ctx.hooks.on("run.changed", () => {});
      await ctx.trace.span("login", async (s) => { s.setAttributes({ token: "key hunter2" }); s.event("sent hunter2"); });
    })]);
    expect(spans[0]).toMatchObject({ attributes: { plugin: "leaky", token: "key [redacted]" }, events: ["sent [redacted]"] });
    await host.stop();
  });

  test("a log line outside a hook call carries no run or trace", async () => {
    const lines: Array<Record<string, unknown>> = [];
    const { host } = makeHost({ sinks: { log: (l) => { lines.push(l as unknown as Record<string, unknown>); } } });
    await host.start([builtin(manifest("quiet"), (ctx) => { ctx.hooks.on("run.changed", () => {}); ctx.log.info("activated"); })]);
    expect(lines.find((l) => l.message === "activated")).toEqual({ plugin: "quiet", level: "info", message: "activated", fields: {} });
    await host.stop();
  });

  test("a sandbox seam call's span names the plugin that provides it", async () => {
    const was = process.env.CAPCOMD_SANDBOX;
    delete process.env.CAPCOMD_SANDBOX;
    resetDependencies();
    resetSpans();
    try {
      await getDependencies().provider.list("nothing-");
      const span = getFinishedSpans().find((s) => s.name === "sandbox.list")!;
      expect(span.attributes).toMatchObject({ plugin: "sandbox-fake", "sandbox.operation": "list" });
    } finally {
      resetDependencies();
      if (was !== undefined) process.env.CAPCOMD_SANDBOX = was;
    }
  });

  test("stats count each seam's calls and its failed ones by ErrorClass.kind, whether the kernel calls the seam or a built-in's own provider", async () => {
    const native = { create: () => ({ list: async () => { throw Object.assign(new Error("rate limited"), { code: "quota" }); } }) };
    const { host } = makeHost();
    await host.start([builtin(manifest("sandbox-test", { provides: ["seam:sandbox/testbox"], contributes: { seams: [{ kind: "sandbox", name: "testbox" }] } }), (ctx) => {
      ctx.seams.sandbox({
        describe: () => ({ name: "testbox" }), classifyError: (e: unknown) => ((e as { code?: string }).code === "quota" ? { kind: "quota", retryable: true, hint: "wait" } : { kind: "unknown", retryable: false }),
        available: async () => ({ ok: true }), waitReady: async () => {}, ensure: async () => { throw new Error("no machine"); },
        [Symbol.for("capcomd.sandbox.native")]: native,
      } as never);
    })]);
    const seam = host.contributions.get("seam", "sandbox/testbox")!.value.impl as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    await seam.waitReady!("vm-1", {});
    await expect(seam.ensure!({}, {})).rejects.toThrow("no machine");
    await seam.available!();   // describing a seam isn't a call
    await expect(kernelSandbox(seam as never).list("x")).rejects.toThrow("rate limited");
    const counted = { sandbox: { calls: 3, errors: { unknown: 1, quota: 1 } } };
    expect(host.get("sandbox-test")!.stats.seams).toEqual(counted);
    // The API lists them in the contract's shape, and `capcomd plugins show` prints them.
    expect(Plugins.parse({ plugins: host.list() }).plugins.find((p) => p.name === "sandbox-test")!.stats.seams).toEqual(counted);
    expect(CAPABILITY_NAMES).toContain("plugins.seam_stats");
    expect(statsLines(host.get("sandbox-test")!.stats)).toEqual(["hook calls: 0, 0 failed, 0 dropped", "sandbox seam: 3 calls, failed: 1 unknown, 1 quota"]);
    await host.stop();
  });
});
