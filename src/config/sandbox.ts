// Which sandbox a project's runs use when the run doesn't name one, and where that choice comes from. Read from the
// files each time (not from this process's environment as it was filled at startup), so a project set up after a
// long-lived process started (`capcomd mcp`) is seen right away, and so the run records the project's choice rather
// than whatever the engine was started with. Order: a real CAPCOMD_SANDBOX in this process's environment (one a person
// or a parent process set, not one a config file filled in), then the project's .capcomd/config.json `env`, then the
// user's ~/.capcomd/config.json `env`; else none (the run then uses the engine's own CAPCOMD_SANDBOX).
import { isProviderName, type ProviderName } from "../providers/registry";
import { APPLIED_TO_PROCESS, projectConfigPath, readConfig, userConfigPath } from "./store";

type Env = Record<string, string | undefined>;
export type SandboxSource = "run" | "environment" | "project" | "user" | "engine";
export interface SandboxChoice {
  /** The provider's name; null when nothing here names one (source "engine"). */
  name: ProviderName | null;
  source: SandboxSource;
  /** The config file it was read from (project or user). */
  path: string | null;
  /** A name that isn't a provider capcomd knows: what was written, and where. */
  invalid?: string;
}

const KEYS = ["CAPCOMD_SANDBOX", "RELAY_SANDBOX"] as const;
const named = (e: Record<string, string> | undefined) => { for (const k of KEYS) { const v = e?.[k]; if (typeof v === "string" && v.trim()) return v.trim(); } return null; };

/** A CAPCOMD_SANDBOX this process was given (not one applyConfig filled in from a file). */
function fromEnvironment(env: Env): string | null {
  for (const k of KEYS) {
    const v = env[k];
    if (!v?.trim()) continue;
    if (env === process.env && APPLIED_TO_PROCESS.get(k) === v) continue;
    return v.trim();
  }
  return null;
}

/** The sandbox a run started from `cwd` uses when it doesn't name one, and where that comes from. */
export function configuredSandbox(cwd = process.cwd(), env: Env = process.env): SandboxChoice {
  const pick = (raw: string, source: SandboxSource, path: string | null): SandboxChoice => {
    const n = raw.toLowerCase();
    return isProviderName(n) ? { name: n, source, path } : { name: null, source, path, invalid: raw };
  };
  const e = fromEnvironment(env);
  if (e) return pick(e, "environment", null);
  // Tests (and `capcomd setup`'s demo) skip the persisted settings.
  if (!env.CAPCOMD_NO_CONFIG) {
    const proj = projectConfigPath(cwd, env);
    const p = proj ? named(readConfig(proj).env) : null;
    if (p) return pick(p, "project", proj);
    const user = userConfigPath(env);
    const u = named(readConfig(user).env);
    if (u) return pick(u, "user", user);
  }
  return { name: null, source: "engine", path: null };
}

/** "docker (project: /p/.capcomd/config.json)" */
export function describeSandbox(c: SandboxChoice): string {
  const name = c.name ?? (c.invalid ? `"${c.invalid}" (not a sandbox capcomd knows)` : "the engine's own");
  const from = c.source === "run" ? "chosen for the run" : c.source === "environment" ? "CAPCOMD_SANDBOX in the environment"
    : c.source === "project" ? `project: ${c.path}` : c.source === "user" ? `user config: ${c.path}` : "nothing configured here: the engine's CAPCOMD_SANDBOX";
  return `${name} (${from})`;
}

/**
 * A sandbox someone named for a run (`capcomd run new --sandbox`, capcomd_run_new `sandbox`): one capcomd knows, and,
 * for a listed one, up now (Docker answers; a boxd key is configured). Returns the normalized name.
 */
export async function askedSandbox(raw: string, env: Env = process.env): Promise<ProviderName> {
  const { RelayError } = await import("../core/errors");
  const R = await import("../providers/registry");
  const n = raw.trim().toLowerCase();
  if (!R.isProviderName(n)) throw new RelayError("usage", `sandbox ${JSON.stringify(raw)} isn't one capcomd knows`, `Pass one of: ${R.LISTED_PROVIDERS.join(", ")} (or leave it out: the project's sandbox applies).`, { code: "sandbox" });
  if (R.isListedProvider(n)) {
    const s = await (await import("../api/run-options")).sandboxAvailable(n, env);
    if (!s.available) throw new RelayError("config", `sandbox ${n} isn't available: ${s.reason}`, n === "docker" ? "Start Docker (Docker Desktop, OrbStack, Colima), or name another sandbox." : "Run `capcomd setup accounts` (a boxd API key), or name another sandbox.", { code: "sandbox" });
  }
  return n;
}
