// Spec §9.4-§9.5, the frames of the out-of-process runtime (src/host/process.ts) without a process: a fake launcher, a
// hook registry and sinks that collect frames. One gate call at a time, observe frames queued while no stream is open
// (the oldest dropped past the limit, then a hook.dropped), Last-Event-ID resume, a second stream replacing the first,
// a reconnect after a disconnect, and the answers' statuses.
import { describe, expect, test } from "bun:test";
import { HookRegistry, type HostEvent } from "../src/host/registry";
import { ProcessPlugin, ProtocolError, type FrameSink, type ProcessStart } from "../src/host/process";
import type { HookFrame } from "../src/protocol";
import type { PluginManifest } from "../src/manifest";

const manifest = {
  schema: "capcomd.plugin/v1", name: "wire", version: "1.0.0", description: "a fake process", apiVersion: 1, engines: { capcomd: ">=0.0.0" },
  entry: { runtime: "process", command: ["fake"] }, contributes: { hooks: { "merge.landing": {}, "run.changed": {} } },
} as unknown as PluginManifest;
const OPERATOR = { principal: { kind: "operator" as const, clientId: null }, entity: "mrg-1" };
const merge = { merge: { mrgId: "mrg-1" } } as never;
const runChanged = (i: number) => ({ run: { id: `run-${i}` }, change: { kind: "started" } }) as never;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setup(timings = {}) {
  const events: HostEvent[] = [];
  const registry = new HookRegistry({ emit: (e) => events.push(e), rank: () => 0 });
  let n = 0;
  const starts: Array<ProcessStart & { exit(code: number): void }> = [];
  const proc: ProcessPlugin = new ProcessPlugin({
    name: "wire", manifest, root: "/nowhere", dataDir: "/nowhere", manifestHash: "h".repeat(64), emit: (e) => events.push(e), dropped: (k) => registry.dropped("wire", k),
    launcher: { start: () => {
      let exit!: (x: { code: number | null; signal: string | null }) => void;
      const exited = new Promise<{ code: number | null; signal: string | null }>((r) => { exit = r; });
      const s = { clientId: `plg-${++n}`, pid: 1000 + n, exited, kill: () => exit({ code: null, signal: "SIGKILL" }), revoke: () => {}, exit: (code: number) => exit({ code, signal: null }) };
      starts.push(s);
      return s;
    } },
    opened: () => ({ plugin: { name: "wire", version: "1.0.0", scopes: [] }, config: {}, secrets: {}, hookTimeoutsMs: {}, daemon: { version: "0", capabilities: [] } }),
    listen: () => { for (const h of ["merge.landing", "run.changed"] as const) registry.on("wire", h, ((call: never) => proc.call(call)) as never, { timeoutMs: 2000 }); },
    failed: () => {}, timings: { backoffMs: () => 20, closingMs: 20, ...timings },
  });
  registry.attach("wire", new AbortController().signal, { settled: (id, f) => proc.settled(id, f) });
  const sink = () => { const got: HookFrame[] = []; let closed = false; const s: FrameSink & { got: HookFrame[]; closed(): boolean } = { got, frame: (f) => got.push(f), close: () => { closed = true; }, closed: () => closed }; return s; };
  const caller = () => ({ clientId: starts.at(-1)!.clientId, plugin: "wire" });
  const open = () => proc.open(caller(), { session: (proc as unknown as { session: { id: string } }).session.id, protocol: 1, manifestHash: "h".repeat(64), pid: 1, hooks: ["run.changed", "merge.landing"] });
  const session = () => (proc as unknown as { session: { id: string } }).session.id;
  return { proc, registry, events, starts, sink, caller, open, session };
}

describe("the process runtime's frames (§9.4, §9.5)", () => {
  test("gate calls go one at a time: the second is sent once the first is answered", async () => {
    const t = setup();
    const running = t.proc.run();
    t.open();
    const s = t.sink();
    const detach = t.proc.attach(t.caller(), t.session(), null, s);
    expect(await running).toBeNull();
    const a = t.registry.fire("merge.landing", "veto", merge, OPERATOR);
    const b = t.registry.fire("merge.landing", "veto", merge, { ...OPERATOR, entity: "mrg-2" });
    await sleep(20);
    const calls = () => s.got.filter((f) => f.frame === "hook.call");
    expect(calls()).toHaveLength(1);
    const first = calls()[0]!;
    if (first.frame !== "hook.call") throw new Error();
    await t.proc.answer(t.caller(), first.call.callId, { session: t.session(), result: { decision: "allow" } });
    expect(await a).toMatchObject({ decision: "allow" });
    await sleep(20);
    expect(calls()).toHaveLength(2);
    const second = calls()[1]!;
    if (second.frame !== "hook.call") throw new Error();
    expect(second.call.idempotencyKey).toBe("merge.landing:mrg-2:1");
    // Answered twice: 409; an unknown call: 404; an answer that doesn't fit the mode: 422 (and the gate denies).
    await expect(t.proc.answer(t.caller(), first.call.callId, { session: t.session(), result: { decision: "allow" } })).rejects.toMatchObject({ status: 409 });
    await expect(t.proc.answer(t.caller(), "call_nope", { session: t.session(), result: { decision: "allow" } })).rejects.toMatchObject({ status: 404 });
    await expect(t.proc.answer(t.caller(), second.call.callId, { session: t.session(), result: { decision: "allow", patch: {} } })).rejects.toMatchObject({ status: 422 });
    expect(await b).toMatchObject({ decision: "deny", failure: "invalid_result" });
    detach();
    await t.proc.dispose("disabled");
  });

  test("observe frames wait for a stream, the oldest dropped past the limit; then a hook.dropped says how many", async () => {
    const t = setup();
    const running = t.proc.run();
    t.open();
    const s1 = t.sink();
    const detach = t.proc.attach(t.caller(), t.session(), null, s1);
    await running;
    detach();
    // In batches the registry's own queue drains between (§6.2), so every call reaches the process's queue (§9.5).
    for (let i = 0; i < 1005; i++) {
      t.registry.fire("run.changed", "observe", runChanged(i), { ...OPERATOR, entity: `run-${i}` });
      if (i % 100 === 99) await t.registry.idle();
    }
    await t.registry.idle();
    const s2 = t.sink();
    t.proc.attach(t.caller(), t.session(), null, s2);
    expect(s2.got[0]).toMatchObject({ frame: "hook.dropped", count: 5, hooks: ["run.changed"] });
    const calls = s2.got.filter((f) => f.frame === "hook.call");
    expect(calls).toHaveLength(1000);
    expect((calls[0] as { call: { payload: { run: { id: string } } } }).call.payload.run.id).toBe("run-5");
    expect(t.registry.stats("wire").dropped).toBe(5);
    // An answer to an observe call is taken and ignored.
    await t.proc.answer(t.caller(), (calls[0] as { call: { callId: string } }).call.callId, { session: t.session(), result: {} });
    await t.proc.dispose("disabled");
  });

  test("Last-Event-ID resumes after the seq given, the open gate call again with its callId; a second stream replaces the first", async () => {
    const t = setup();
    const running = t.proc.run();
    t.open();
    const s1 = t.sink();
    t.proc.attach(t.caller(), t.session(), null, s1);
    await running;
    t.registry.fire("run.changed", "observe", runChanged(1), { ...OPERATOR, entity: "run-1" });
    t.registry.fire("run.changed", "observe", runChanged(2), { ...OPERATOR, entity: "run-2" });
    await t.registry.idle();
    const gate = t.registry.fire("merge.landing", "veto", merge, OPERATOR);
    await sleep(20);
    expect(s1.got.map((f) => f.seq)).toEqual([1, 2, 3]);
    // The process saw seq 1 only and comes back: 2 and 3 again; the first stream is told it was replaced.
    const s2 = t.sink();
    t.proc.attach(t.caller(), t.session(), 1, s2);
    expect(s1.got.at(-1)).toMatchObject({ frame: "session.closing", reason: "replaced" });
    expect(s1.closed()).toBe(true);
    expect(s2.got.map((f) => [f.frame, f.seq])).toEqual([["hook.call", 2], ["hook.call", 3]]);
    const call = s2.got[1] as { call: { callId: string } };
    await t.proc.answer(t.caller(), call.call.callId, { session: t.session(), result: { decision: "deny", reason: "no" } });
    expect(await gate).toMatchObject({ decision: "deny", text: "no" });
    await t.proc.dispose("disabled");
  });

  test("disconnected after disconnectMs without a stream: gate calls fail at once; a reconnect brings it back", async () => {
    const t = setup({ disconnectMs: 100 });
    const running = t.proc.run();
    t.open();
    const detach = t.proc.attach(t.caller(), t.session(), null, t.sink());
    await running;
    detach();
    await sleep(200);
    expect(t.events.filter((e) => e.type === "plugin.process_changed").map((e) => (e.data as { event: string }).event)).toEqual(["started", "disconnected"]);
    expect(await t.registry.fire("merge.landing", "veto", merge, OPERATOR)).toMatchObject({ decision: "deny", failure: "disconnected" });
    t.proc.attach(t.caller(), t.session(), null, t.sink());
    expect((t.events.at(-1)!.data as { event: string }).event).toBe("reconnected");
    await t.proc.dispose("disabled");
  });

  test("the handshake: another start's token is 403, a second open of the session 409, the stream before the open 409", async () => {
    const t = setup();
    const running = t.proc.run();
    expect(() => t.proc.attach(t.caller(), t.session(), null, t.sink())).toThrow(ProtocolError);
    expect(() => t.proc.open({ clientId: "plg-other", plugin: "wire" }, {})).toThrow(expect.objectContaining({ status: 403 }));
    t.open();
    expect(() => t.open()).toThrow(expect.objectContaining({ status: 409 }));
    t.proc.attach(t.caller(), t.session(), null, t.sink());
    expect(await running).toBeNull();
    await t.proc.dispose("disabled");
  });
});
