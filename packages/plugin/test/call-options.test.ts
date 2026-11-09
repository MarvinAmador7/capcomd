// Spec §8.2, the bounds the host puts on every async primitive (src/host/context.ts `guarded`), through the test kit's
// fake context: a call that never answers rejects `timeout` (retryable) at its `timeoutMs`, 30 000 by default; its
// `signal` rejects it at once (`timeout`, not retryable); disposing the plugin rejects the calls in flight (`disposed`);
// the kernel's side is passed the composed signal; `jobs.wait` still answers the job at its own timeout.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { PluginError } from "../src/errors";
import type { CallOptions } from "../src/context";
import type { PluginManifest } from "../src/manifest";
import type { Job } from "../src/shapes";
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

  test("without timeoutMs the deadline is 30 000 ms, jobs.start's 120 000 (its exec's foreground hold, then the call's)", async () => {
    const delays: number[] = [];
    const real = globalThis.setTimeout;
    const spy = spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => { delays.push(ms ?? 0); return real(fn, ms); }) as typeof setTimeout);
    spies.push(spy);
    const fake = testkit.fakeContext(manifest, {}, { services: { kv: { get: async () => "v" }, jobs: { start: async () => ({ jobId: "job-1" }) as Job } } });
    expect(await fake.ctx.kv.get("run-1", "k")).toBe("v");
    await fake.ctx.jobs.start({ kind: "timer", runId: null, owner: { plugin: true }, label: "t", everyMs: 1000 } as never);
    spy.mockRestore();
    expect(delays).toEqual([30_000, 120_000]);
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

describe("jobs.wait keeps its own timeout (§8.2, §16.2)", () => {
  test("it answers the job as it is at its timeoutMs, even past it, not timeout", async () => {
    const job = { jobId: "job-1", state: "running" } as Job;
    let seen: CallOptions | undefined;
    const fake = testkit.fakeContext(manifest, {}, { services: { jobs: { wait: async (_id: string, o?: CallOptions) => { seen = o; await sleep((o?.timeoutMs ?? 0) + 40); return job; } } } });
    expect(await fake.ctx.jobs.wait("job-1", { timeoutMs: 30 })).toEqual(job);
    expect(seen?.timeoutMs).toBe(30);
  });

  test("its signal still rejects it", async () => {
    const fake = testkit.fakeContext(manifest, {}, { services: { jobs: { wait: never } } });
    const ac = new AbortController();
    const call = fake.ctx.jobs.wait("job-1", { signal: ac.signal });
    ac.abort();
    expect((await rejection(call)).code).toBe("timeout");
  });
});
