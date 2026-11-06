// The sandbox seam (docs/spec/plugin-api.md §7.2) and the kernel's provider shape (./sandbox.ts), both ways. A sandbox
// plugin registers a seam object: SeamCall-shaped methods plus describe, available and classifyError. The kernel's
// consumers keep calling the kernel shape (`exec(id, cmd, {timeoutMs})`), and the built-ins' providers keep their own
// extras (snapshots, secrets, interactive sessions), so a built-in's seam carries its kernel provider factory under
// NATIVE and the kernel uses that object as it always has; a seam without one (a test's plugin: out-of-process plugins
// carry no seam in protocol 1, §9.6) is adapted here, its errors turned back into the kernel's sandbox errors through its
// own classifyError (§7.2.3).
import { PluginError } from "../../packages/plugin/src/errors";
import type { ErrorClass, SandboxDescriptor, SandboxProvider as SandboxSeam, SeamCall } from "../../packages/plugin/src/seams";
import {
  SandboxAuthError, SandboxConfigError, SandboxError, SandboxNotFoundError, SandboxQuotaError, SandboxTimeoutError,
  SandboxUnavailableError, isTransientSandboxError,
} from "./boxd-errors";
import type { SandboxProvider } from "./sandbox";

type Env = Record<string, string | undefined>;
/** A plugin's own secret (an `x-secret` property of its config, §10.3), resolved for the kernel; undefined when unset. */
export type SecretOf = (key: string) => string | undefined;

/** Where a built-in seam keeps its kernel-shaped provider factory. Kernel-only: never part of the plugin API. */
export const NATIVE = Symbol.for("capcomd.sandbox.native");
export interface NativeSandbox {
  /** The provider for `env` (the CAPCOMD_* knobs of the place a run uses), as the kernel's consumers call it. */
  create(env: Env, secret?: SecretOf): SandboxProvider;
}
export type BuiltinSandboxSeam = SandboxSeam & { [NATIVE]: NativeSandbox };

export type Availability = { ok: true } | { ok: false; reason: string; fix: string | null };

const RefusedConnection = /^(ECONNREFUSED|ECONNRESET|ECONNABORTED|ETIMEDOUT|EPIPE|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH)$/;

/**
 * §7.2.3 for the errors every built-in provider throws (./boxd-errors.ts): a PluginError by its code, then the
 * kernel's sandbox error classes and the codes they keep across an actor boundary. `authHint` is what a rejected
 * credential tells the user to do; null for a provider that has no credential to reject (it then never says `auth`).
 * Vendor-specific errors are the plugin's own business, before this.
 */
export function classifySandboxError(e: unknown, authHint: string | null): ErrorClass {
  if (e instanceof PluginError) {
    if (e.code === "not_found") return { kind: "not_found", retryable: false };
    if (e.code === "timeout") return { kind: "timeout", retryable: true };
    if (e.code === "unavailable") return { kind: "transient", retryable: true };
    if (e.code === "invalid" || e.code === "unsupported" || e.code === "forbidden") return { kind: "config", retryable: false, hint: e.hint ?? e.message };
    return { kind: "unknown", retryable: false };
  }
  const x = e as { kind?: unknown; code?: unknown; message?: unknown } | null;
  const kind = String(x?.code ?? x?.kind ?? "");
  if (authHint !== null && (e instanceof SandboxAuthError || kind === "sandbox_auth" || kind === "auth")) return { kind: "auth", retryable: false, hint: authHint };
  if (e instanceof SandboxNotFoundError || kind === "not_found") return { kind: "not_found", retryable: false };
  if (RefusedConnection.test(kind)) return { kind: "transient", retryable: true };
  if (isTransientSandboxError(e)) {
    if (e instanceof SandboxQuotaError || kind === "quota") return { kind: "quota", retryable: true, hint: "The provider is rate limiting capcomd; it is tried again shortly." };
    if (e instanceof SandboxTimeoutError || kind === "timeout") return { kind: "timeout", retryable: true };
    return { kind: "transient", retryable: true };
  }
  if (e instanceof SandboxQuotaError || kind === "quota") return { kind: "quota", retryable: true, hint: "Free capacity at the provider (delete machines you don't need), then retry." };
  if (e instanceof SandboxConfigError || kind === "config") return { kind: "config", retryable: false, hint: String(x?.message ?? "") };
  return { kind: "unknown", retryable: false };
}

const remaining = (c: SeamCall) => Math.max(1, Date.parse(c.deadline) - Date.now());
const cancelled = (what: string, c: SeamCall) => new PluginError("timeout", `${what} was cancelled or ran past its deadline (${c.deadline})`);

/** `fn` against the provider, settled by the call's signal: an abort rejects `timeout` at once, and so does an answer
 *  that came at or after the deadline (an exec the provider killed there, §7.2). */
async function within<T>(what: string, c: SeamCall, fn: (ms: number) => Promise<T>): Promise<T> {
  if (c.signal.aborted) throw cancelled(what, c);
  let onAbort = () => {};
  const aborted = new Promise<never>((_, reject) => { onAbort = () => reject(cancelled(what, c)); });
  c.signal.addEventListener("abort", onAbort, { once: true });
  try {
    const r = await Promise.race([fn(remaining(c)), aborted]);
    if (c.signal.aborted || Date.now() >= Date.parse(c.deadline)) throw cancelled(what, c);
    return r;
  } finally { c.signal.removeEventListener("abort", onAbort); }
}

export interface BuiltinSandboxOptions {
  descriptor: SandboxDescriptor;
  native: NativeSandbox;
  classifyError(e: unknown): ErrorClass;
  /** Cheap: can this place run agents now (§7.2 `available`). Never rejects. */
  available(): Promise<Availability>;
  /** The provider the seam's own methods use (default: `native.create(process.env)`, made on first use). */
  instance?(): Promise<SandboxProvider>;
  /** `caps.idleLifetime === "sweep"`: delete the machines past their deadline; returns their names. */
  sweep?(p: SandboxProvider): Promise<string[]>;
}

/** A built-in provider as a sandbox seam: the kernel provider behind SeamCall-shaped methods, plus NATIVE. */
export function builtinSandbox(o: BuiltinSandboxOptions): BuiltinSandboxSeam {
  const d = o.descriptor;
  let made: Promise<SandboxProvider> | null = null;
  const p = () => (made ??= o.instance ? o.instance() : Promise.resolve().then(() => o.native.create(process.env)));
  const run = <T>(what: string, c: SeamCall, fn: (p: SandboxProvider, ms: number) => Promise<T>) => within(`${d.name} ${what}`, c, async (ms) => fn(await p(), ms));
  const unsupported = (what: string) => Promise.reject(new PluginError("unsupported", `${d.name} has no ${what}`));
  const seam: BuiltinSandboxSeam = {
    [NATIVE]: o.native,
    describe: () => d,
    available: () => o.available().catch((e: unknown) => ({ ok: false as const, reason: e instanceof Error ? e.message : String(e), fix: null })),
    classifyError: (e) => o.classifyError(e),
    ensure: (spec, c) => run("ensure", c, (x) => x.ensure(spec)),
    waitReady: (id, c) => run("waitReady", c, (x, ms) => x.waitReady(id, ms)),
    exec: (id, cmd, opts, c) => run("exec", c, (x, ms) => x.exec(id, cmd, { ...(opts.env ? { env: opts.env } : {}), ...(opts.cwd ? { cwd: opts.cwd } : {}), timeoutMs: ms })),
    upload: (id, path, data, c) => run("upload", c, (x) => x.upload(id, path, data)),
    download: (id, path, c) => run("download", c, (x) => x.download(id, path)),
    setEgress: (id, allow, c) => d.caps.egressAllowlist ? run("setEgress", c, (x) => x.setEgress(id, allow)) : unsupported("egress allowlist (caps.egressAllowlist is false)"),
    snapshot: (id, name, c) => d.caps.snapshots ? run("snapshot", c, (x) => x.snapshot(id, name)) : unsupported("snapshots (caps.snapshots is false)"),
    checkpoint: (id, name, c) => run("checkpoint", c, (x) => x.checkpoint(id, name)),
    restore: (id, name, c) => run("restore", c, (x) => x.restore(id, name)),
    suspend: (id, c) => run("suspend", c, (x) => x.suspend(id)),
    resume: (id, c) => run("resume", c, (x) => x.resume(id)),
    destroy: (id, c) => run("destroy", c, (x) => x.destroy(id)),
    list: (prefix, c) => run("list", c, (x) => x.list(prefix)),
    extendTtl: (id, seconds, c) => run("extendTtl", c, (x) => x.extendTtl ? x.extendTtl(id, seconds) : unsupported("extendTtl")),
    probe: (id, c) => run("probe", c, (x) => x.probe ? x.probe(id) : unsupported("probe")),
  };
  if (o.sweep && d.caps.idleLifetime === "sweep") seam.sweep = (c) => run("sweep", c, async (x) => ({ deleted: await o.sweep!(x) }));
  return seam;
}

/** A call to a seam with `ms` to go: its own signal, aborted at the deadline (§7.1). */
export function seamCall(ms: number): { call: SeamCall; done(): void } {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  (timer as { unref?: () => void }).unref?.();
  return { call: { signal: ac.signal, deadline: new Date(Date.now() + ms).toISOString(), trace: { traceId: "0".repeat(32), spanId: "0".repeat(16) } }, done: () => clearTimeout(timer) };
}

/** What a seam's rejection is as the kernel's sandbox error, so the kernel's retries and failures (resilient.ts,
 *  the worker) treat a plugin's provider like a built-in one. */
export function kernelError(seam: Pick<SandboxSeam, "classifyError">, e: unknown, what: string, vmId?: string): Error {
  if (e instanceof SandboxError) return e;
  const msg = `${what} failed${vmId ? ` (vm ${vmId})` : ""}: ${(e as Error)?.message ?? String(e)}`;
  let c: ErrorClass;
  try { c = seam.classifyError(e); } catch { c = { kind: "unknown", retryable: false }; }
  if (e instanceof PluginError && c.kind === "unknown") {
    if (e.code === "not_found") return new SandboxNotFoundError(msg, vmId, e);
    if (e.code === "timeout") return new SandboxTimeoutError(msg, vmId, e);
    if (e.code === "unavailable") return new SandboxUnavailableError(msg, vmId, e);
  }
  switch (c.kind) {
    case "auth": return new SandboxAuthError(`${msg}. ${c.hint}`, vmId, e);
    case "config": return new SandboxConfigError(c.hint ? `${msg}. ${c.hint}` : msg, vmId, e);
    case "not_found": return new SandboxNotFoundError(msg, vmId, e);
    case "quota": return new SandboxQuotaError(msg, vmId, e);
    case "timeout": return new SandboxTimeoutError(msg, vmId, e);
    case "transient": return new SandboxUnavailableError(msg, vmId, e);
    default: return e instanceof Error ? e : new Error(msg);
  }
}

/** Deadlines for the kernel-shaped calls that carry none of their own. */
const CALL_MS = 5 * 60_000;
const EXEC_MS = 60 * 60_000;

/** The kernel provider for a seam: a built-in's own provider for `env`, else the seam adapted (SeamCalls made from
 *  the kernel's timeouts; an exec past its deadline is exit 124, as GNU `timeout` reports it). */
export function kernelSandbox(seam: SandboxSeam, env: Env = process.env, secret?: SecretOf): SandboxProvider {
  const native = (seam as Partial<BuiltinSandboxSeam>)[NATIVE];
  if (native) return native.create(env, secret);
  const go = async <T>(what: string, ms: number, fn: (c: SeamCall) => Promise<T>, vmId?: string): Promise<T> => {
    const { call, done } = seamCall(ms);
    try { return await fn(call); } catch (e) { throw kernelError(seam, e, `${seam.describe().name} ${what}`, vmId); } finally { done(); }
  };
  const p: SandboxProvider = {
    ensure: (spec) => go("ensure", CALL_MS, (c) => seam.ensure(spec, c)),
    waitReady: (id, timeoutMs) => go("waitReady", timeoutMs, (c) => seam.waitReady(id, c), id),
    exec: async (id, cmd, opts = {}) => {
      const { call, done } = seamCall(opts.timeoutMs ?? EXEC_MS);
      try { return await seam.exec(id, cmd, { ...(opts.env ? { env: opts.env } : {}), ...(opts.cwd ? { cwd: opts.cwd } : {}) }, call); } catch (e) {
        if (e instanceof PluginError && e.code === "timeout") return { code: 124, stdout: "", stderr: `timed out after ${opts.timeoutMs ?? EXEC_MS} ms` };
        throw kernelError(seam, e, `${seam.describe().name} exec`, id);
      } finally { done(); }
    },
    upload: (id, path, data) => go("upload", CALL_MS, (c) => seam.upload(id, path, data, c), id),
    download: (id, path) => go("download", CALL_MS, (c) => seam.download(id, path, c), id),
    setEgress: (id, allow) => go("setEgress", CALL_MS, (c) => seam.setEgress(id, allow, c), id),
    checkpoint: (id, name) => go("checkpoint", CALL_MS, (c) => seam.checkpoint(id, name, c), id),
    restore: (id, name) => go("restore", CALL_MS, (c) => seam.restore(id, name, c), id),
    snapshot: (id, name) => go("snapshot", CALL_MS, (c) => seam.snapshot(id, name, c), id),
    suspend: (id) => go("suspend", CALL_MS, (c) => seam.suspend(id, c), id),
    resume: (id) => go("resume", CALL_MS, (c) => seam.resume(id, c), id),
    destroy: (id) => go("destroy", CALL_MS, (c) => seam.destroy(id, c), id),
    list: (prefix) => go("list", CALL_MS, (c) => seam.list(prefix, c)),
  };
  if (seam.extendTtl) p.extendTtl = (id, seconds) => go("extendTtl", CALL_MS, (c) => seam.extendTtl!(id, seconds, c), id);
  if (seam.probe) p.probe = (id) => go("probe", 90_000, (c) => seam.probe!(id, c), id);
  return p;
}
