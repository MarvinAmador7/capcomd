// A sandbox provider that rides out an outage of a few minutes (boxd's API not answering, Docker's daemon restarting):
// calls that are safe to repeat (reads, an ensure by idempotency key, an upload of the same bytes, a lease renewal, a
// destroy) are tried again with bounded, jittered backoff while the error is transient (boxd-errors.ts
// isTransientSandboxError); an exec is never run twice, but a transient failure of one is checked against the provider
// (`probe`) so a command that ran out of its own time isn't mistaken for an outage. Past the outage window
// (CAPCOMD_SANDBOX_OUTAGE_MS, 10 minutes by default) the call fails with SandboxUnreachableError.
//
// While a call waits, whoever started the work hears of it (withOutageListener: the worker turns it into the agent's
// notice), and hears again when the provider answers.
import { AsyncLocalStorage } from "node:async_hooks";
import { env } from "../utils/env";
import {
  SandboxExecTimeoutError, SandboxTimeoutError, SandboxUnavailableError, SandboxUnreachableError, isTransientSandboxError,
} from "./boxd-errors";
import { MACHINE_PREFIX, type SandboxProvider, type VmId } from "./sandbox";

/** How long an outage is waited out before the work fails with SandboxUnreachableError (ms). */
export const outageWindowMs = () => Math.max(0, Number(env("SANDBOX_OUTAGE_MS") ?? 10 * 60_000));
/** The first backoff step; it doubles per try up to 30 s, with jitter. */
const retryBaseMs = () => Math.max(10, Number(env("SANDBOX_RETRY_BASE_MS") ?? 1000));
const RETRY_MAX_MS = 30_000;
/** Calls that must not hold up their caller for the whole window (a destroy, a renewal): retried this long,
 *  then left to their caller's own retry (the worker's drain alarm, the runner's next renewal). */
const SHORT_WINDOW_MS = 90_000;
/** A probe that hangs counts as no answer. */
const PROBE_MS = 90_000;

export interface Outage { since: number; what: string; error: string; windowMs: number; provider: string }
type Listener = (o: Outage | null) => void;
const listeners = new AsyncLocalStorage<Listener>();
/** Run `fn` with `listener` hearing of each outage a provider call waits out (and null once it answered again). */
export function withOutageListener<T>(listener: Listener, fn: () => Promise<T>): Promise<T> { return listeners.run(listener, fn); }
/** Tell this context's listener (if any) that the provider is (or is no longer, null) not answering. Never throws. */
export function reportOutage(o: Outage | null): void { try { listeners.getStore()?.(o); } catch { /* best effort */ } }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Exponential backoff with jitter (half fixed, half random), capped. */
export function backoffMs(n: number, base = retryBaseMs(), max = RETRY_MAX_MS): number {
  const cap = Math.min(max, base * 2 ** n);
  return Math.round(cap / 2 + Math.random() * (cap / 2));
}
export const minutes = (ms: number) => (ms >= 60_000 ? `${Math.round(ms / 6000) / 10} min` : `${Math.round(ms / 100) / 10} s`);

/** The outage error a wait ends with. */
export function unreachable(provider: string, what: string, sinceMs: number, last: unknown, vmId?: string): SandboxUnreachableError {
  const msg = String((last as Error)?.message ?? last ?? "").slice(0, 400);
  return new SandboxUnreachableError(`the sandbox provider (${provider}) didn't answer for ${minutes(sinceMs)} (${what}: ${msg})`, vmId, last);
}

/**
 * `fn`, tried again while it fails transiently, for at most `windowMs` from its first failure. A permanent error is
 * thrown at once; a wait that runs out throws SandboxUnreachableError.
 */
export async function retryTransient<T>(what: string, fn: () => Promise<T>, o: { provider?: string; windowMs?: number; vmId?: string } = {}): Promise<T> {
  const windowMs = o.windowMs ?? outageWindowMs();
  const provider = o.provider ?? "sandbox";
  let since = 0, n = 0;
  for (;;) {
    const started = Date.now();
    try {
      const r = await fn();
      if (since) reportOutage(null);
      return r;
    } catch (e) {
      if (!isTransientSandboxError(e)) throw e;
      since ||= started;
      const waited = Date.now() - since;
      if (waited >= windowMs) throw unreachable(provider, what, waited, e, o.vmId);
      if (n === 0) reportOutage({ since, what, error: String((e as Error)?.message ?? e).slice(0, 300), windowMs, provider });
      await sleep(Math.max(10, Math.min(backoffMs(n++), windowMs - waited)));
    }
  }
}

/** Does the provider answer now? (Any answer counts, "not found" too.) False only for a transient failure or no answer. */
export async function providerAnswers(p: SandboxProvider, id?: VmId): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const probe = (p.probe ? p.probe(id) : p.list(MACHINE_PREFIX).then(() => {})).then(() => true, (e) => !isTransientSandboxError(e));
  const hung = new Promise<boolean>((ok) => { timer = setTimeout(() => ok(false), PROBE_MS); });
  try { return await Promise.race([probe, hung]); } finally { clearTimeout(timer); }
}

const RESILIENT = Symbol.for("capcomd.resilientProvider");
const NAME = Symbol.for("capcomd.providerName");
/** What to call a provider in messages: boxd, docker, fake. */
export function providerLabel(p: SandboxProvider): string {
  return ((p as any)[NAME] as string | undefined) ?? (rawProvider(p).constructor?.name ?? "sandbox").replace(/Provider$/, "").toLowerCase();
}
/** The provider under a resilient wrapper (itself when it isn't one). */
export function rawProvider<P extends SandboxProvider>(p: P): P { return ((p as any)[RESILIENT] as P | undefined) ?? p; }

/** Repeatable calls: tried again for the whole window. */
const LONG = new Set(["ensure", "waitReady", "upload", "download", "setEgress", "suspend", "resume"]);
/** Repeatable calls whose callers have their own retry: tried again for a short while only. (`list` isn't retried: its
 *  callers, the resources route above all, bound it to a few seconds and ask again soon.) */
const SHORT = new Set(["destroy", "extendTtl"]);

/** `p`, riding out transient failures (see the top of this file). Idempotent: a wrapped provider is returned as is. */
export function resilientProvider<P extends SandboxProvider>(p: P, o: { name?: string } = {}): P {
  if ((p as any)[RESILIENT]) return p;
  const name = o.name ?? (p.constructor?.name ?? "sandbox").replace(/Provider$/, "").toLowerCase();
  const exec = async (id: VmId, cmd: string[], opts?: Parameters<SandboxProvider["exec"]>[2]) => {
    try {
      return await p.exec(id, cmd, opts);
    } catch (e) {
      if (!isTransientSandboxError(e)) throw e;
      // An exec is never repeated (it may have run). Ask the provider whether it answers at all: if it does, a timeout
      // was the command's own; if it doesn't, this is an outage (the caller waits for the machine, or re-checks it).
      if (await providerAnswers(p, id)) {
        if (e instanceof SandboxTimeoutError) throw new SandboxExecTimeoutError(e.message, id, e);
        throw e;
      }
      throw new SandboxUnavailableError(`${(e as Error)?.message ?? e} (${name} isn't answering)`, id, e);
    }
  };
  return new Proxy(p, {
    get(target, prop, receiver) {
      if (prop === RESILIENT) return target;
      if (prop === NAME) return name;
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function" || typeof prop !== "string") return value;
      if (prop === "exec") return exec;
      if (LONG.has(prop) || SHORT.has(prop)) {
        return (...args: any[]) => retryTransient(`${prop}`, () => value.apply(target, args), {
          provider: name, windowMs: SHORT.has(prop) ? Math.min(outageWindowMs(), SHORT_WINDOW_MS) : outageWindowMs(), vmId: typeof args[0] === "string" ? args[0] : undefined,
        });
      }
      return value.bind(target);
    },
  });
}
