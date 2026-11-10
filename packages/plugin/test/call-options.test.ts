// Spec §8.2, the bounds the host puts on every async primitive (src/host/context.ts `guarded`), through the test kit's
// fake context: a call that never answers rejects `timeout` (retryable) at its `timeoutMs`, 30 000 by default; its
// `signal` rejects it at once (`timeout`, not retryable); disposing the plugin rejects the calls in flight (`disposed`);
// the kernel's side is passed the composed signal; `jobs.wait` and `agents.await` still answer at their own timeout.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { PluginError } from "../src/errors";
import { ContributionStore, createContext } from "../src/host/context";
import { HookRegistry } from "../src/host/registry";
import type { CallOptions } from "../src/context";
import type { PluginManifest } from "../src/manifest";
import type { Agent, Job, Merge, Verification } from "../src/shapes";
import { testkit } from "../src/testkit";

const manifest = {
  schema: "capcomd.plugin/v1", name: "caller", version: "1.0.0", description: "calls primitives", apiVersion: 1, engines: { capcomd: ">=0.0.0" },
  entry: { runtime: "in-process", module: "index.ts" }, scopes: ["read", "steer"], contributes: {},
} as unknown as PluginManifest;
const never = () => new Promise<never>(() => {});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rejection = async (p: Promise<unknown>) => {
  const e = await p.then(() => { throw new Error("it resolved"); }, (x: unknown) => x);
  expect(e).toBeInstanceOf(PluginError);
  return e as PluginError;
};

let spies: Array<{ mockRestore(): void }> = [];
afterEach(() => { for (const s of spies) s.mockRestore(); spies = []; });

describe("a primitive's deadline (§8.2)", () => {
  test("a service method that never answers rejects timeout, retryable, at timeoutMs; the kernel's side sees its signal abort", async () => {
    let seen: CallOptions | undefined;
    const fake = testkit.fakeContext(manifest, {}, { services: { kv: { get: (_r: string, _k: string, o?: CallOptions) => { seen = o; return never(); } } } });
    const started = Date.now();
    const e = await rejection(fake.ctx.kv.get("run-1", "k", { timeoutMs: 40 }));
    expect(e.code).toBe("timeout");
    expect(e.retryable).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(35);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(seen?.timeoutMs).toBe(40);
    expect(seen?.signal?.aborted).toBe(true);
    expect((seen?.signal?.reason as PluginError).code).toBe("timeout");
  });

  test("without timeoutMs the deadline is 30 000 ms; a primitive that runs a kernel operation to its end has a longer one", async () => {
    const delays: number[] = [];
    const real = globalThis.setTimeout;
    const spy = spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => { delays.push(ms ?? 0); return real(fn, ms); }) as typeof setTimeout);
    spies.push(spy);
    const fake = testkit.fakeContext(manifest, {}, { services: {
      kv: { get: async () => "v" }, jobs: { start: async () => ({ jobId: "job-1" }) as Job },
      agents: { spawn: async () => ({ id: "agt-1" }) as Agent }, gates: { verify: async () => ({ vfyId: "vfy-1" }) as Verification, merge: async () => ({ mrgId: "mrg-1" }) as Merge },
    } });
    expect(await fake.ctx.kv.get("run-1", "k")).toBe("v");
    await fake.ctx.jobs.start({ kind: "timer", runId: null, owner: { plugin: true }, label: "t", everyMs: 1000 } as never);
    await fake.ctx.agents.spawn({ runId: "run-1", profile: "worker", task: "t" });
    await fake.ctx.gates.verify("run-1", { ref: "agt-1" });
    await fake.ctx.gates.merge("run-1", { ref: "agt-1", require: "vfy-1" });
    expect(await fake.ctx.kv.get("run-1", "k", { timeoutMs: 5 })).toBe("v");
    spy.mockRestore();
    // jobs.start: an exec's foreground hold (90 s) and the call's; agents.spawn: its two modify hooks (60 s each) and the
    // call's; gates.verify: its checks (an hour) and verify.judging's longest (60 min); gates.merge: an hour.
    expect(delays).toEqual([30_000, 120_000, 150_000, 7_200_000, 3_600_000, 5]);
  });

  test("a gates.verify that outlasts 30 s still answers: its default deadline is its own", async () => {
    const delays: number[] = [];
    const real = globalThis.setTimeout;
    // Every host deadline fires at once unless it is longer than 30 000 ms, so a verify bounded by the call's default
    // would reject; the kernel's verify answers after a few ms.
    const spy = spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => { delays.push(ms ?? 0); return real(fn, (ms ?? 0) > 30_000 ? ms : (ms ?? 0) >= 1000 ? 0 : ms); }) as typeof setTimeout);
    spies.push(spy);
    const fake = testkit.fakeContext(manifest, {}, { services: { gates: { verify: async () => { await sleep(20); return { vfyId: "vfy-1", state: "passed" } as Verification; } } } });
    expect((await fake.ctx.gates.verify("run-1", { ref: "agt-1" })).vfyId).toBe("vfy-1");
  });

  test("a call that answers in time resolves with its answer, and the options reach the kernel with key and the composed signal", async () => {
    let seen: CallOptions | undefined;
    const fake = testkit.fakeContext(manifest, {}, { services: { kv: { put: async (_r: string, _k: string, _v: unknown, o?: CallOptions) => { seen = o; } } } });
    await fake.ctx.kv.put("run-1", "k", 1, { key: "once" });
    expect(seen?.key).toBe("once");
    expect(seen?.signal).toBeInstanceOf(AbortSignal);
    expect(seen?.signal?.aborted).toBe(false);
  });

  test("timeoutMs that isn't a number above 0 is invalid", async () => {
    const fake = testkit.fakeContext(manifest, {}, { services: { kv: { get: async () => "v" } } });
    for (const timeoutMs of [0, -1, Number.NaN, "5" as unknown as number]) expect((await rejection(fake.ctx.kv.get("run-1", "k", { timeoutMs }))).code).toBe("invalid");
  });
});

describe("a primitive's signal and ctx.signal (§8.2)", () => {
  test("an already aborted signal rejects at once and the kernel isn't called", async () => {
    let called = false;
    const fake = testkit.fakeContext(manifest, {}, { services: { kv: { get: () => { called = true; return never(); } } } });
    const e = await rejection(fake.ctx.kv.get("run-1", "k", { signal: AbortSignal.abort() }));
    expect(e.code).toBe("timeout");
    expect(e.retryable).toBe(false);
    expect(called).toBe(false);
  });

  test("a signal aborted while the call is in flight rejects it at once and aborts the kernel's side", async () => {
    let seen: AbortSignal | undefined;
    const fake = testkit.fakeContext(manifest, {}, { services: { runs: { pause: (_r: string, o?: CallOptions) => { seen = o?.signal; return never(); } } } });
    const ac = new AbortController();
    const call = fake.ctx.runs.pause("run-1", { signal: ac.signal, timeoutMs: 60_000 });
    await sleep(5);
    const started = Date.now();
    ac.abort();
    const e = await rejection(call);
    expect(e.code).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(500);
    expect(seen?.aborted).toBe(true);
  });

  test("disposing the plugin rejects its calls in flight with disposed", async () => {
    let seen: AbortSignal | undefined;
    const fake = testkit.fakeContext(manifest, {}, { services: { kv: { get: (_r: string, _k: string, o?: CallOptions) => { seen = o?.signal; return never(); } }, storage: { list: never } } });
    const calls = [fake.ctx.kv.get("run-1", "k"), fake.ctx.storage.list("daemon", "")];
    await sleep(5);
    expect(await fake.dispose()).toEqual([]);
    for (const c of calls) expect((await rejection(c)).code).toBe("disposed");
    expect(seen?.aborted).toBe(true);
    expect((await rejection(fake.ctx.kv.get("run-1", "k"))).code).toBe("disposed");
  });
});

describe("jobs.wait and agents.await keep their own timeout (§8.2, §8.4, §16.2)", () => {
  test("it answers the job as it is at its timeoutMs, even past it, not timeout", async () => {
    const job = { jobId: "job-1", state: "running" } as Job;
    let seen: CallOptions | undefined;
    const fake = testkit.fakeContext(manifest, {}, { services: { jobs: { wait: async (_id: string, o?: CallOptions) => { seen = o; await sleep((o?.timeoutMs ?? 0) + 40); return job; } } } });
    expect(await fake.ctx.jobs.wait("job-1", { timeoutMs: 30 })).toEqual(job);
    expect(seen?.timeoutMs).toBe(30);
  });

  test("agents.await answers which ended at its timeoutMs, not timeout, and 0 is a look now", async () => {
    const answer = { ended: [], pending: ["agt-1"] };
    const seen: Array<number | undefined> = [];
    const fake = testkit.fakeContext(manifest, {}, { services: { agents: { await: async (_r: string, _ids: string[], _i: unknown, o?: CallOptions) => { seen.push(o?.timeoutMs); await sleep((o?.timeoutMs ?? 0) + 40); return answer; } } } });
    expect(await fake.ctx.agents.await("run-1", ["agt-1"], {}, { timeoutMs: 30 })).toEqual(answer);
    expect(await fake.ctx.agents.await("run-1", ["agt-1"], {}, { timeoutMs: 0 })).toEqual(answer);
    expect(seen).toEqual([30, 0]);
  });

  test("its signal still rejects it", async () => {
    const fake = testkit.fakeContext(manifest, {}, { services: { jobs: { wait: never } } });
    const ac = new AbortController();
    const call = fake.ctx.jobs.wait("job-1", { signal: ac.signal });
    ac.abort();
    expect((await rejection(call)).code).toBe("timeout");
  });
});

describe("events.emit and events.replay are bounded too (§8.2)", () => {
  const withSinks = (sinks: { emit?: () => Promise<{ seq: number }>; replay?: () => Promise<never[]> }) => createContext({
    manifest: { ...manifest, contributes: { events: ["noted"] } } as unknown as PluginManifest, runtime: "in-process", root: "", dataDir: "/nonexistent",
    hooks: new HookRegistry({ emit: () => {}, rank: () => 0 }), store: new ContributionStore(), config: {}, ...sinks,
  });
  const noted = { type: "noted", stream: "daemon", entity: "", text: "t", data: {} };

  test("an emit or replay that never answers rejects timeout, retryable, at timeoutMs", async () => {
    const r = withSinks({ emit: never, replay: never });
    const emitted = await rejection(r.ctx.events.emit(noted, { timeoutMs: 30 }));
    expect([emitted.code, emitted.retryable]).toEqual(["timeout", true]);
    const replayed = await rejection(r.ctx.events.replay("daemon", 0, { timeoutMs: 30 }));
    expect([replayed.code, replayed.retryable]).toEqual(["timeout", true]);
  });

  test("their signal rejects them and dispose rejects them in flight; an answer in time comes back", async () => {
    const r = withSinks({ emit: never, replay: never });
    expect((await rejection(r.ctx.events.replay("daemon", 0, { signal: AbortSignal.abort() }))).code).toBe("timeout");
    const call = r.ctx.events.emit(noted);
    await sleep(5);
    await r.dispose();
    expect((await rejection(call)).code).toBe("disposed");
    const ok = withSinks({ emit: async () => ({ seq: 7 }) });
    expect(await ok.ctx.events.emit(noted, { timeoutMs: 1000 })).toEqual({ seq: 7 });
  });
});
