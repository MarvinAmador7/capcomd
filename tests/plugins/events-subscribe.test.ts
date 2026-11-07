// `ctx.events.subscribe` and `ctx.events.replay` through the daemon's host (docs/spec/plugin-api.md §8.4,
// src/plugins/events.ts): a fixture plugin subscribed to the daemon stream and to a run's hears the events its filter
// names, in seq order and one at a time, as the envelopes GET /v1/events serves; replay(after) is what came after; a
// disposed subscription (or plugin) hears nothing more; a handler that throws is logged and skipped; a plugin without
// the read scope is refused, and a host that isn't the daemon's refuses both. The daemon stream is the harness state's;
// a run's is an in-memory log here (the engine's: tests/scenarios/plugin-events.test.ts).
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import type { HarnessEventEnvelope, PluginContext, PluginModule } from "../../packages/plugin/src/context";
import type { PluginHost } from "../../packages/plugin/src/host/host";
import type { PluginManifest } from "../../packages/plugin/src/manifest";
import { PluginError } from "../../packages/plugin/src/errors";
import { envelopes, type RawEvent } from "../../src/api/source";
import { HarnessEvent } from "../../src/api/envelope";
import { daemonEnvelope, harnessState } from "../../src/api/state";
import { kernelHost, type RunEventSink } from "../../src/plugins/host";
import { heard, listener, recorder } from "./fixtures/event-listener/index";

const FIXTURE = join(import.meta.dir, "fixtures", "event-listener");
const state = harnessState(null);
const runs = new Map<string, RawEvent[]>();
const append = (runId: string, e: Omit<RawEvent, "seq" | "at">) => {
  const l = runs.get(runId)!;
  const seq = (l.at(-1)?.seq ?? 0) + 1;
  l.push({ seq, at: Date.now(), ...e });
  return seq;
};
const writeRun: RunEventSink = async (runId, e) => {
  if (!runs.has(runId)) throw new PluginError("not_found", `no run ${runId}`);
  return { seq: append(runId, { type: e.type, agentId: null, data: e.data, entity: e.entity, text: e.text }) };
};
let reads = 0;
const readRun = async (runId: string, after: number) => { reads++; return runs.get(runId)?.filter((e) => e.seq > after) ?? null; };
const newRun = (id: string) => {
  runs.set(id, []);
  append(id, { type: "RUN_NEW", agentId: null, data: { label: "t", goal: "g", budget: null } });
  append(id, { type: "AGENT_SPAWNED", agentId: "agt-1", data: { profile: "worker" } });
  return id;
};

const lines: string[] = [];
let host: PluginHost;
let ctx: PluginContext;
const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  expect(cond()).toBe(true);
};
const settle = () => new Promise((r) => setTimeout(r, 80));   // several polls (10 ms each)
const of = (stream: string) => heard.filter((h) => h.stream === stream);

const manifest = (name: string, extra: Partial<PluginManifest> = {}): PluginManifest => ({
  schema: "capcomd.plugin/v1", name, version: "1.0.0", description: "Test plugin.", apiVersion: 1,
  engines: { capcomd: ">=0.0.0" }, entry: { runtime: "in-process", module: "./index.ts" }, contributes: { events: ["noted"] }, ...extra,
});

beforeAll(async () => {
  // The host's log lines (§13.3) are the daemon's stdout: kept here to read the handler's failure back.
  spyOn(console, "log").mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(" ")); });
  // History before the plugin loads: a subscription without `after` starts at the head and never hears it.
  state.recordDaemonEvent({ type: "profile.changed", entity: "profile:old", text: "Profile old changed.", data: { name: "old" } });
  host = kernelHost({ record: (e) => state.recordDaemonEvent(e), events: { daemon: (after) => state.daemonEvents(after), run: readRun, pollMs: 10 }, run: writeRun });
  await host.start([{ source: "builtin", dir: FIXTURE }]);
  expect(host.get("event-listener")?.state).toBe("active");
  ctx = listener.ctx!;
});
afterAll(async () => { await host?.stop(); (console.log as unknown as { mockRestore(): void }).mockRestore(); });

describe("subscribe", () => {
  test("the daemon stream: the filtered types, in seq order, one at a time, from the head", async () => {
    const a = state.recordDaemonEvent({ type: "profile.changed", entity: "profile:worker", text: "Profile worker changed.", data: { name: "worker" } });
    const { seq: b } = await ctx.events.emit({ type: "noted", stream: "daemon", entity: "", text: "Noted one.", data: { n: 1 } });
    state.recordDaemonEvent({ type: "sandbox.settings_changed", entity: "sandbox:docker", text: "Settings changed.", data: {} });   // not in the filter
    const { seq: c } = await ctx.events.emit({ type: "noted", stream: "daemon", entity: "", text: "Noted two.", data: { n: 2 } });
    await until(() => of("daemon").length >= 3);
    await settle();
    expect(of("daemon").map((h) => [h.type, h.seq, h.text])).toEqual([
      ["profile.changed", a.seq, "Profile worker changed."],
      ["plugin.event-listener.noted", b, "Noted one."],
      ["plugin.event-listener.noted", c, "Noted two."],
    ]);
    // entitySeq counts by entity on the whole stream (the host's plugin.loaded is plugin:event-listener's first).
    const [w, n1, n2] = of("daemon").map((h) => h.entitySeq);
    expect([w, n2! - n1!]).toEqual([1, 1]);
    expect(of("daemon").every((h) => h.overlap === 1)).toBe(true);
  });

  test("a run's stream: the envelopes GET /v1/events serves, in seq order, filtered by type, from the head or from `after`", async () => {
    const run = newRun("run-sub1");
    const live = ctx.events.subscribe(run, { types: ["agent.spawned", "plugin.event-listener.noted"] }, recorder(run));
    const all: HarnessEventEnvelope[] = [];
    const whole = ctx.events.subscribe(run, { after: 0 }, (e) => { all.push(e); });
    await until(() => all.length === 2);   // the history, from `after: 0`
    const spawned = append(run, { type: "AGENT_SPAWNED", agentId: "agt-2", data: { profile: "worker" } });
    const { seq: noted } = await ctx.events.emit({ type: "noted", stream: run, entity: "vfy-1", text: "Noted the run.", data: {} });
    append(run, { type: "AGENT_STARTED", agentId: "agt-2", data: {} });   // not in the filter
    const spawned3 = append(run, { type: "AGENT_SPAWNED", agentId: "agt-3", data: { profile: "reviewer" } });
    await until(() => of(run).length >= 3 && all.length >= 6);
    await settle();
    // From the head: the run's first spawn is history, never delivered.
    expect(of(run).map((h) => [h.type, h.seq])).toEqual([["agent.spawned", spawned], ["plugin.event-listener.noted", noted], ["agent.spawned", spawned3]]);
    expect(of(run).every((h) => h.overlap === 1)).toBe(true);
    // The same envelopes, seq and entitySeq as replayed, every one valid.
    const replayed = envelopes(run, runs.get(run)!);
    expect(all).toEqual(replayed);
    for (const e of all) expect(HarnessEvent.safeParse(e).success).toBe(true);
    expect(all.find((e) => e.seq === noted)).toMatchObject({ entity: "vfy-1", text: "Noted the run.", runId: run, scope: run });
    live.dispose(); whole.dispose();
  });

  test("dispose stops delivery: a subscription's, and the plugin's", async () => {
    const run = newRun("run-sub2");
    const got: number[] = [];
    const sub = ctx.events.subscribe(run, { after: 0 }, (e) => { got.push(e.seq); });
    await until(() => got.length === 2);
    sub.dispose();
    append(run, { type: "AGENT_STARTED", agentId: "agt-1", data: {} });
    const before = reads;
    await settle();
    expect(got).toEqual([1, 2]);
    expect(reads).toBe(before);   // and it stopped polling
    // A plugin disabled: its daemon subscription goes with it.
    await host.disable("event-listener");
    const n = of("daemon").length;
    state.recordDaemonEvent({ type: "profile.changed", entity: "profile:worker", text: "Profile worker changed again.", data: {} });
    await settle();
    expect(of("daemon").length).toBe(n);
    await host.enable("event-listener");
    ctx = listener.ctx!;
  });

  test("a handler that throws is logged and the event skipped; the next one is delivered", async () => {
    const run = newRun("run-sub3");
    const got: number[] = [];
    const sub = ctx.events.subscribe(run, { after: 0 }, (e) => { if (e.seq === 1) throw new Error("boom"); got.push(e.seq); });
    await until(() => got.length === 1);
    append(run, { type: "AGENT_STARTED", agentId: "agt-1", data: {} });
    await until(() => got.length === 2);
    expect(got).toEqual([2, 3]);
    const line = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((l) => l?.message?.includes("handler threw"));
    expect(line).toMatchObject({ plugin: "event-listener", level: "warn", fields: { stream: run, type: "run.created", seq: 1, error: "boom" } });
    sub.dispose();
  });

  test("a run that doesn't exist delivers nothing and isn't polled again", async () => {
    const warn = spyOn(console, "error").mockImplementation(() => {});
    const before = reads;
    const sub = ctx.events.subscribe("run-ghost", {}, () => { throw new Error("never"); });
    await settle();
    expect(reads).toBe(before + 1);
    expect(warn.mock.calls.map((c) => String(c[0]))).toContain("[plugins] no run run-ghost: the subscription delivers nothing");
    sub.dispose();
    warn.mockRestore();
  });

  test("a stream that isn't daemon or a run, and a bad filter, are invalid", () => {
    for (const s of ["prj-abc", "run-", "everything", ""]) expect(() => ctx.events.subscribe(s, {}, () => {})).toThrow(expect.objectContaining({ code: "invalid" }));
    expect(() => ctx.events.subscribe("daemon", { types: "x" as never }, () => {})).toThrow(expect.objectContaining({ code: "invalid" }));
    expect(() => ctx.events.subscribe("daemon", { after: -1 }, () => {})).toThrow(expect.objectContaining({ code: "invalid" }));
  });
});

describe("replay", () => {
  test("replay(after) is what came after, on the daemon stream and a run's", async () => {
    const all = await ctx.events.replay("daemon", 0);
    expect(all).toEqual(state.daemonEvents(0).map(daemonEnvelope));
    const mid = all[1]!.seq;
    expect((await ctx.events.replay("daemon", mid)).map((e) => e.seq)).toEqual(all.filter((e) => e.seq > mid).map((e) => e.seq));
    expect(await ctx.events.replay("daemon", all.at(-1)!.seq)).toEqual([]);

    const run = newRun("run-replay");
    append(run, { type: "AGENT_STARTED", agentId: "agt-1", data: {} });
    expect(await ctx.events.replay(run, 0)).toEqual(envelopes(run, runs.get(run)!));
    expect((await ctx.events.replay(run, 1)).map((e) => [e.seq, e.type, e.entitySeq])).toEqual([[2, "agent.spawned", 1], [3, "agent.started", 2]]);
  });

  test("a run that doesn't exist is not_found; a stream that isn't one is invalid", async () => {
    await expect(ctx.events.replay("run-nope", 0)).rejects.toMatchObject({ code: "not_found" });
    await expect(ctx.events.replay("prj-abc", 0)).rejects.toMatchObject({ code: "invalid" });
    await expect(ctx.events.replay("daemon", -1)).rejects.toMatchObject({ code: "invalid" });
  });
});

describe("refusals", () => {
  test("without the read scope, subscribe and replay are forbidden", async () => {
    const daemon = kernelHost({ log: false, events: { daemon: (after) => state.daemonEvents(after), run: readRun, pollMs: 10 } });
    let c!: PluginContext;
    await daemon.start([{ source: "builtin", manifest: manifest("no-read", { scopes: ["steer"] }), module: { activate(x) { c = x; } } as PluginModule<never> }]);
    expect(() => c.events.subscribe("daemon", {}, () => {})).toThrow(expect.objectContaining({ code: "forbidden" }));
    await expect(c.events.replay("daemon", 0)).rejects.toMatchObject({ code: "forbidden" });
    await daemon.stop();
  });

  test("a host that isn't the daemon's refuses both, unsupported", async () => {
    const local = kernelHost({ log: false });
    let c!: PluginContext;
    await local.start([{ source: "builtin", manifest: manifest("reader", { scopes: ["read"] }), module: { activate(x) { c = x; } } as PluginModule<never> }]);
    expect(() => c.events.subscribe("daemon", {}, () => {})).toThrow(expect.objectContaining({ code: "unsupported" }));
    await expect(c.events.replay("daemon", 0)).rejects.toMatchObject({ code: "unsupported" });
    await local.stop();
  });
});
