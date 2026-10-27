// A run's own sandbox (`capcomd run --sandbox NAME`, POST /v1/runs `sandbox`): where that run's agents and checks run,
// when it isn't the daemon's CAPCOMD_SANDBOX. `run new` records it (kv _sandbox, reserved for the orchestrator), and
// the engine side (the worker's VMs, verify's checks VM, env snapshots and plan logins) reads it per run. A run
// without one uses the daemon's sandbox, as before.
import { PROVIDERS, type ProviderName } from "./registry";

export const RUN_SANDBOX_KV = "_sandbox";
type Env = Record<string, string | undefined>;

export function isProviderName(name: string): name is ProviderName {
  return Object.hasOwn(PROVIDERS, name);
}

/** `base` with the sandbox set to `name` (null: unchanged). */
export function withSandbox(base: Env, name: string | null | undefined): Env {
  if (!name) return base;
  const env: Env = { ...base, CAPCOMD_SANDBOX: name };
  delete env.RELAY_SANDBOX;
  return env;
}

// A run's sandbox never changes once recorded (before its first agent), so a read is cached; a failed read isn't.
const known = new Map<string, ProviderName | null>();

/** The sandbox recorded for a run, or null when it has none (it uses the daemon's). */
export async function runSandbox(runId: string | null | undefined): Promise<ProviderName | null> {
  if (!runId) return null;
  if (known.has(runId)) return known.get(runId)!;
  try {
    const { client } = await import("../core/relay");
    const look = (async () => (await (client().scope as any).get([runId]).kvGet({ k: RUN_SANDBOX_KV })))();
    const r: any = await Promise.race([look, new Promise((ok) => setTimeout(() => ok(undefined), 3000))]);
    if (r === undefined) return null; // no answer: don't cache
    const name = r && !r.deleted && typeof r.value?.name === "string" && isProviderName(r.value.name) ? r.value.name : null;
    known.set(runId, name);
    return name;
  } catch { return null; }
}

/** This process's env as the run sees it: its recorded sandbox on top. */
export async function runSandboxEnv(runId: string | null | undefined, base: Env = process.env): Promise<Env> {
  return withSandbox(base, await runSandbox(runId));
}
