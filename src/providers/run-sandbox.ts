// A run's own sandbox (`capcomd run --sandbox NAME`, POST /v1/runs `sandbox`): where that run's agents and checks run,
// when it isn't the daemon's CAPCOMD_SANDBOX. `run new` records it (kv _sandbox, reserved for the orchestrator), and
// the engine side (the worker's VMs, verify's checks VM, env snapshots and plan logins) reads it per run. A run
// without one uses the daemon's sandbox, as before. ADR-021 §2: the same record carries the provider's settings as they
// were when the run started (`settings.idleLifetime`), so the worker uses the run's own idle machine lifetime.
import { isProviderName, sandboxName, type ProviderName } from "./registry";
import { currentIdleLifetime, validLifetime } from "./settings";

export const RUN_SANDBOX_KV = "_sandbox";
type Env = Record<string, string | undefined>;

export { isProviderName };

/** `base` with the sandbox set to `name` (null: unchanged). */
export function withSandbox(base: Env, name: string | null | undefined): Env {
  if (!name) return base;
  const env: Env = { ...base, CAPCOMD_SANDBOX: name };
  delete env.RELAY_SANDBOX;
  return env;
}

/** What `run new` records under `_sandbox`: the run's own place (when it has one) and its provider's settings as they
 *  were when the run started (ADR-021 §2: a run keeps the policy it started with). Old readers only look at `.name`. */
export interface RunSandboxRecord { name: ProviderName | null; settings: { idleLifetime?: number } }

// A run's sandbox never changes once recorded (before its first agent), so a read is cached; a failed read isn't.
const known = new Map<string, RunSandboxRecord | null>();

/** The `_sandbox` value `run new` writes: `{name?, settings: {idleLifetime}}`. */
export function runSandboxValue(name: string | null | undefined, settings: { idleLifetime: number }): Record<string, unknown> {
  return { ...(name ? { name } : {}), settings: { ...settings } };
}

/** A recorded `_sandbox` value as capcomd reads it (anything it doesn't know is dropped). */
export function parseRunSandbox(value: unknown): RunSandboxRecord | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const name = typeof v.name === "string" && isProviderName(v.name) ? v.name : null;
  const s = v.settings && typeof v.settings === "object" ? (v.settings as Record<string, unknown>) : {};
  const life = validLifetime(s.idleLifetime);
  return { name, settings: life !== null ? { idleLifetime: life } : {} };
}

/** The run's `_sandbox` record; null when it has none, undefined when the engine didn't answer (not cached). */
export async function runSandboxRecord(runId: string | null | undefined): Promise<RunSandboxRecord | null | undefined> {
  if (!runId) return null;
  if (known.has(runId)) return known.get(runId)!;
  try {
    const { client } = await import("../core/relay");
    const look = (async () => (await (client().scope as any).get([runId]).kvGet({ k: RUN_SANDBOX_KV })))();
    const r: any = await Promise.race([look, new Promise((ok) => setTimeout(() => ok(undefined), 3000))]);
    if (r === undefined) return undefined; // no answer: don't cache
    const rec = r && !r.deleted ? parseRunSandbox(r.value) : null;
    known.set(runId, rec);
    return rec;
  } catch { return undefined; }
}

/** The sandbox recorded for a run, or null when it has none (it uses the daemon's). */
export async function runSandbox(runId: string | null | undefined): Promise<ProviderName | null> {
  return (await runSandboxRecord(runId))?.name ?? null;
}

/**
 * The idle machine lifetime (seconds) for a run's machines: what `run new` recorded with it, else (a run from before
 * settings, or none recorded) the current setting of the place it runs on (`sandbox`, else the daemon's).
 */
export async function runIdleLifetime(runId: string | null | undefined, sandbox: string | null | undefined, env: Env = process.env): Promise<number> {
  const rec = await runSandboxRecord(runId);
  if (rec?.settings.idleLifetime !== undefined) return rec.settings.idleLifetime;
  let name = sandbox ?? null;
  if (!name) { try { name = sandboxName(env); } catch { name = "fake"; } }
  return currentIdleLifetime(name, { env }).seconds;
}

/** This process's env as the run sees it: its recorded sandbox on top. */
export async function runSandboxEnv(runId: string | null | undefined, base: Env = process.env): Promise<Env> {
  return withSandbox(base, await runSandbox(runId));
}
