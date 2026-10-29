// A sandbox provider outage of a few minutes (boxd's API not answering, 2026-10-29) must not fail agents or leak
// machines: transient provider errors are told from permanent ones, repeatable calls are tried again with backoff for
// the outage window, an exec is never repeated (a probe tells an outage from a command that ran out of time).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  isSandboxUnreachable, isTransientSandboxError, mapBoxdError, SandboxAuthError, SandboxExecTimeoutError, SandboxNotFoundError,
  SandboxNotReadyError, SandboxQuotaError, SandboxTimeoutError, SandboxUnavailableError, SandboxUnreachableError,
} from "../../src/providers/boxd-errors";
import { FakeProvider } from "../../src/providers/fake";
import { providerLabel, rawProvider, resilientProvider, retryTransient, withOutageListener, type Outage } from "../../src/providers/resilient";
import { DockerProvider } from "../../src/providers/docker";
import { providerFromEnv } from "../../src/dependencies";

const saved = { o: process.env.CAPCOMD_SANDBOX_OUTAGE_MS, b: process.env.CAPCOMD_SANDBOX_RETRY_BASE_MS };
beforeAll(() => { process.env.CAPCOMD_SANDBOX_OUTAGE_MS = "1500"; process.env.CAPCOMD_SANDBOX_RETRY_BASE_MS = "20"; });
afterAll(() => {
  if (saved.o === undefined) delete process.env.CAPCOMD_SANDBOX_OUTAGE_MS; else process.env.CAPCOMD_SANDBOX_OUTAGE_MS = saved.o;
  if (saved.b === undefined) delete process.env.CAPCOMD_SANDBOX_RETRY_BASE_MS; else process.env.CAPCOMD_SANDBOX_RETRY_BASE_MS = saved.b;
});

// Named like the SDK's classes: mapBoxdError matches by class name and gRPC code.
class APIConnectionError extends Error { grpcCode = 14; }
class BoxdError extends Error { constructor(m: string, public grpcCode?: number) { super(m); } }
class NotFoundError extends Error { grpcCode = 5; }
class RateLimitError extends Error { grpcCode = 8; }
class AuthenticationError extends Error { grpcCode = 16; }

const spec = (k: string) => ({ idemKey: k, isolated: true as const, ttlSeconds: 600, egressAllow: ["*"], labels: {} });

describe("classification", () => {
  test("what the e2e outage threw is transient; what a retry can't cure is not", () => {
    const transient = [
      mapBoxdError(new BoxdError("Deadline exceeded after 60.000s,remote_addr=152.236.3.40:9443", 4), "vm", "machines.get"),
      mapBoxdError(new BoxdError("exec timed out after 120000ms"), "vm", "exec"),
      mapBoxdError(new APIConnectionError("connect ECONNREFUSED 152.236.3.40:9443"), "vm", "upload"),
      mapBoxdError(new BoxdError("upstream connect error", 14)),
      mapBoxdError(new BoxdError("internal", 13)),
      mapBoxdError(new RateLimitError("rate limit exceeded, slow down")),
      // As they arrive after crossing an actor boundary (a UserError: the kind is its code).
      { code: "timeout", message: "machines.get failed: Deadline exceeded" },
      { code: "unavailable", message: "docker exec: Cannot connect to the Docker daemon" },
      { code: "push_failed", message: "upload failed: socket hang up" },
    ];
    for (const e of transient) expect([e, isTransientSandboxError(e)]).toEqual([e, true]);
    expect(mapBoxdError(new APIConnectionError("x"))).toBeInstanceOf(SandboxUnavailableError);
    const permanent = [
      mapBoxdError(new NotFoundError("no such machine"), "vm", "machines.get"),
      mapBoxdError(new AuthenticationError("invalid or expired api key")),
      mapBoxdError(new RateLimitError("org machine quota reached")),
      new SandboxNotReadyError("VM vm not ready within 90000ms", "vm"),
      new SandboxExecTimeoutError("exec timed out after 20000ms", "vm"),
      new SandboxUnreachableError("the sandbox provider (boxd) didn't answer for 10 min"),
      new Error("git push failed (exit 1): rejected"),
      { code: "not_found", message: "Deadline exceeded" },
      { code: "sandbox_auth", message: "connection reset" },
      { code: "limit", message: "stopped at its timeout limit" },
    ];
    for (const e of permanent) expect([e, isTransientSandboxError(e)]).toEqual([e, false]);
    expect(mapBoxdError(new RateLimitError("org machine quota reached"))).toBeInstanceOf(SandboxQuotaError);
    expect(isSandboxUnreachable({ code: "sandbox_unreachable" })).toBe(true);
    expect(isSandboxUnreachable(new SandboxUnreachableError("x"))).toBe(true);
    expect(new SandboxUnreachableError("x").retryable).toBe(true);
  });
});

describe("retryTransient", () => {
  test("a transient failure shorter than the window is waited out, and the listener hears of it and of its end", async () => {
    let n = 0;
    const heard: Array<Outage | null> = [];
    const r = await withOutageListener((o) => heard.push(o), () => retryTransient("machines.get", async () => {
      if (++n < 4) throw new SandboxTimeoutError("machines.get failed: Deadline exceeded after 60.000s");
      return "ok";
    }, { provider: "boxd", windowMs: 2000 }));
    expect(r).toBe("ok");
    expect(n).toBe(4);
    expect(heard.length).toBe(2);
    expect(heard[0]).toMatchObject({ provider: "boxd", what: "machines.get", windowMs: 2000 });
    expect(heard[1]).toBeNull();
  });

  test("past the window: SandboxUnreachableError naming the provider, the call and how long", async () => {
    const t0 = Date.now();
    const e = await retryTransient("machines.get", async () => { throw new SandboxTimeoutError("Deadline exceeded after 60.000s"); }, { provider: "boxd", windowMs: 300 }).catch((x) => x);
    expect(e).toBeInstanceOf(SandboxUnreachableError);
    expect(e.kind).toBe("sandbox_unreachable");
    expect(e.message).toMatch(/^the sandbox provider \(boxd\) didn't answer for [\d.]+ s \(machines\.get: Deadline exceeded/);
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  test("a permanent error is thrown at once, untouched", async () => {
    for (const err of [new SandboxNotFoundError("gone"), new SandboxAuthError("rejected"), new Error("bad request")]) {
      let n = 0;
      const e = await retryTransient("x", async () => { n++; throw err; }, { windowMs: 5000 }).catch((x) => x);
      expect(e).toBe(err);
      expect(n).toBe(1);
    }
  });
});

describe("resilientProvider over the fake provider's injected outages", () => {
  const mk = () => { const raw = new FakeProvider(); return { raw, p: resilientProvider(raw, { name: "fake" }) }; };

  test("ensure, waitReady and upload wait out an outage shorter than the window", async () => {
    const { raw, p } = mk();
    raw.faults = { until: Date.now() + 300 };
    const { id } = await p.ensure(spec("a"));
    await p.waitReady(id, 1000);
    await p.upload(id, "/tmp/x", new Uint8Array([1]));
    expect(raw.faulted.ensure).toBeGreaterThan(0);
    expect((await raw.list("")).map((v) => v.id)).toEqual([id]);
  });

  test("an outage longer than the window fails with sandbox_unreachable", async () => {
    const { raw, p } = mk();
    raw.faults = { until: Date.now() + 60_000, error: "unavailable" };
    const t0 = Date.now();
    const e = await p.ensure(spec("b")).catch((x) => x);
    expect(e).toBeInstanceOf(SandboxUnreachableError);
    expect(e.message).toContain("the sandbox provider (fake) didn't answer");
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  test("permanent errors still fail fast: not found and a rejected key are never retried", async () => {
    for (const error of ["not_found", "auth"] as const) {
      const { raw, p } = mk();
      raw.faults = { until: Date.now() + 60_000, error };
      const t0 = Date.now();
      const e = await p.ensure(spec(`c-${error}`)).catch((x) => x);
      expect(e).toBeInstanceOf(error === "auth" ? SandboxAuthError : SandboxNotFoundError);
      expect(raw.faulted.ensure).toBe(1);
      expect(Date.now() - t0).toBeLessThan(200);
    }
  });

  test("exec is never run twice: an outage is told from a command that ran out of time by a probe", async () => {
    const { raw, p } = mk();
    const { id } = await p.ensure(spec("d"));
    await p.waitReady(id, 1000);
    // Only exec fails, the provider still answers: the command's own timeout, settled (not an outage).
    raw.faults = { until: Date.now() + 60_000, ops: ["exec"] };
    const own = await p.exec(id, ["sleep", "999"]).catch((x) => x);
    expect(own).toBeInstanceOf(SandboxExecTimeoutError);
    expect(isTransientSandboxError(own)).toBe(false);
    expect(raw.faulted.exec).toBe(1);
    // The provider doesn't answer at all: an outage (transient), still not repeated.
    raw.faults = { until: Date.now() + 60_000, ops: ["exec", "probe"] };
    const down = await p.exec(id, ["true"]).catch((x) => x);
    expect(down).toBeInstanceOf(SandboxUnavailableError);
    expect(isTransientSandboxError(down)).toBe(true);
    expect(raw.faulted.exec).toBe(2);
  });

  test("a destroy that fails transiently is tried again until the machine is gone", async () => {
    const { raw, p } = mk();
    const { id } = await p.ensure(spec("e"));
    raw.faults = { until: Date.now() + 300, ops: ["destroy"] };
    await p.destroy(id);
    expect(raw.faulted.destroy).toBeGreaterThan(0);
    raw.faults = null;
    expect(await raw.list("")).toEqual([]);
  });

  test("the wrapper is transparent: other methods, instanceof, its name, the raw provider; wrapping twice is a no-op", async () => {
    const { raw, p } = mk();
    expect(p).toBeInstanceOf(FakeProvider);
    expect(rawProvider(p)).toBe(raw);
    expect(resilientProvider(p)).toBe(p);
    expect(providerLabel(p)).toBe("fake");
    expect(providerLabel(raw)).toBe("fake");
    expect(rawProvider(providerFromEnv({ CAPCOMD_SANDBOX: "fake" }))).toBeInstanceOf(FakeProvider);
    await (p as FakeProvider).snapshotCreate((await p.ensure(spec("f"))).id, "s").catch(() => {});
  });
});

describe("Docker: a daemon that isn't answering is an outage, not a configuration error", () => {
  test("exec, probe and ensure say unavailable (transient)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "capcomd-docker-down-"));
    const bin = join(dir, "docker");
    writeFileSync(bin, "#!/bin/sh\necho 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?' >&2\nexit 1\n");
    chmodSync(bin, 0o755);
    const d = new DockerProvider({ bin, ledgerPath: join(dir, "ttl.json") });
    for (const call of [() => d.exec("relay-x", ["true"]), () => d.probe("relay-x"), () => d.ensure(spec("g"))]) {
      const e = await call().catch((x) => x);
      expect(e).toBeInstanceOf(SandboxUnavailableError);
      expect(isTransientSandboxError(e)).toBe(true);
    }
  });
});
