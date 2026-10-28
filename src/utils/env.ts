// Env lookup for capcomd. CAPCOMD_<NAME> wins; RELAY_<NAME> is a deprecated alias
// kept for compatibility (one stderr warning per name, never on stdout so --json/MCP stay clean).
import { AsyncLocalStorage } from "async_hooks";

const warned = new Set<string>();
/** ADR-022: the settings of the agent being driven in this async context (withDriveEnv), over process.env. */
const driveEnvStore = new AsyncLocalStorage<Record<string, string>>();

export function env(name: string, source: Record<string, string | undefined> = process.env): string | undefined {
  if (source === process.env) {
    const drive = driveEnvStore.getStore();
    if (drive && drive[`CAPCOMD_${name}`] !== undefined) return drive[`CAPCOMD_${name}`];
  }
  const v = source[`CAPCOMD_${name}`];
  if (v !== undefined) return v;
  const legacy = source[`RELAY_${name}`];
  if (legacy !== undefined && source === process.env && !warned.has(name) && !process.env.CAPCOMD_NO_DEPRECATION_WARNINGS) {
    warned.add(name);
    process.stderr.write(`capcomd: RELAY_${name} is deprecated; use CAPCOMD_${name}\n`);
  }
  return legacy;
}

/**
 * ADR-022: the settings a driver process used to take from the CLI that started it, which travel with the agent instead
 * (recorded at spawn), so the engine host drives it the same way: how it runs (CAPCOMD_SPAWN_EXEC and the scripted
 * agents' CAPCOMD_SCRIPT_*), the agents file its children's profiles come from, and the driver's timings and test
 * knobs. Never a secret or a path to state: only these.
 */
const DRIVE_ENV = new Set(["SPAWN_EXEC", "AGENTS_FILE", "AWAIT_POLL_MS", "AWAIT_FALLBACK_MS", "DRIVER_LEASE_MS", "DRIVE_MAX_FAILURES", "DRIVE_OUTAGE_MS",
  "VM_RPC_POLL_MS", "TOKEN_TTL_MS", "DRIVER_KILLPOINT", "DRIVER_KILLPOINT_MARKER", "AGENT_WORKFLOW_POLL_MS", "QUOTA_RETRY_MS"]);
const isDriveName = (n: string) => DRIVE_ENV.has(n) || (n.startsWith("SCRIPT_") && !/KEY|TOKEN|SECRET|PASSWORD/.test(n));

/** This context's drive settings (the agent's being driven, else this process's), as CAPCOMD_* pairs. */
export function captureDriveEnv(source: Record<string, string | undefined> = process.env): Record<string, string> {
  const names = new Set<string>();
  for (const k of [...Object.keys(source), ...Object.keys(driveEnvStore.getStore() ?? {})]) {
    const m = /^(?:CAPCOMD|RELAY)_(.+)$/.exec(k);
    if (m && isDriveName(m[1]!)) names.add(m[1]!);
  }
  const out: Record<string, string> = {};
  for (const n of names) { const v = env(n, source); if (v !== undefined) out[`CAPCOMD_${n}`] = v; }
  return out;
}

/** Run `fn` (and everything it starts) with an agent's drive settings over process.env (only the allowed names). */
export function withDriveEnv<T>(vars: Record<string, string> | null | undefined, fn: () => T): T {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(vars ?? {})) { const m = /^CAPCOMD_(.+)$/.exec(k); if (m && isDriveName(m[1]!) && typeof v === "string") clean[k] = v; }
  return driveEnvStore.run(clean, fn);
}
