// Persisted settings: `capcomd setup` writes them, every command reads them. They are defaults for the
// environment, applied when the CLI starts: a real environment variable always wins, then the project's
// .capcomd/config.json (found from the current directory upward), then ~/.capcomd/config.json.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { homedir } from "os";
import { capcomdHome } from "../utils/home";

export interface CapcomdConfig {
  /** CAPCOMD_* (and BOXD_*) defaults, e.g. CAPCOMD_SANDBOX, CAPCOMD_REPO, CAPCOMD_MERGE_TARGET. */
  env?: Record<string, string>;
  /** Where the boxd API key lives: the OS keychain, or the environment only. */
  boxdKey?: "keychain" | "file" | "env";
  /** Defaults for `run new` when its flags are absent (project config). */
  run?: { checks?: Record<string, string>; reviewer?: string; target?: string };
  /**
   * What an agent driving capcomd over MCP may do (ADR-018 §4). `approvals`: "human" (default) leaves merges into
   * protected branches to a person; "client-confirmed" lets the tool approve after the client's own confirmation.
   * `maxRunBudget`: a cap per run, e.g. "usd=20,turns=400" (units over it are refused, not clamped).
   */
  driver?: { approvals?: "human" | "client-confirmed"; maxRunBudget?: string };
  /** harness.v1 API (docs/harness-architecture.md §6). `socket`: Unix socket path (default ~/.capcomd/harness.sock), e.g. a macOS app-group container. */
  harness?: { socket?: string };
}

type Source = Record<string, string | undefined>;
export const userConfigPath = (source: Source = process.env) => join(capcomdHome(source), "config.json");

/** The nearest .capcomd/config.json from `cwd` upward (stops at the home directory or the filesystem root). */
export function projectConfigPath(cwd = process.cwd()): string | null {
  const home = resolve(homedir());
  for (let d = resolve(cwd); ; d = dirname(d)) {
    const p = join(d, ".capcomd", "config.json");
    if (existsSync(p)) return p;
    if (d === home || dirname(d) === d) return null;
  }
}

export function readConfig(path: string | null): CapcomdConfig {
  if (!path || !existsSync(path)) return {};
  try { const v = JSON.parse(readFileSync(path, "utf8")); return v && typeof v === "object" ? v : {}; } catch { return {}; }
}

/** Merge `patch` into the config at `path` (env maps merge key by key). */
export function writeConfig(path: string, patch: CapcomdConfig): CapcomdConfig {
  const cur = readConfig(path);
  const next: CapcomdConfig = { ...cur, ...patch, env: { ...(cur.env ?? {}), ...(patch.env ?? {}) }, run: { ...(cur.run ?? {}), ...(patch.run ?? {}) } };
  if (!Object.keys(next.env!).length) delete next.env;
  if (!Object.keys(next.run!).length) delete next.run;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  return next;
}

export interface Applied { user: string | null; project: string | null; keys: string[]; boxdKeyFrom: "env" | "keychain" | "file" | null }

/**
 * Fill `env` with the persisted defaults (never overriding what's set). The boxd key comes from the OS
 * keychain when the user config says so and BOXD_API_KEY isn't already set.
 */
export function applyConfig(env: Source = process.env, cwd = process.cwd(), keychain: () => string | null = defaultKeychain): Applied {
  const userPath = userConfigPath(env);
  const user = readConfig(userPath);
  const projectPath = projectConfigPath(cwd);
  const project = readConfig(projectPath);
  const keys: string[] = [];
  for (const [k, v] of Object.entries({ ...(user.env ?? {}), ...(project.env ?? {}) })) {
    if (env[k] === undefined && typeof v === "string") { env[k] = v; keys.push(k); }
  }
  let boxdKeyFrom: Applied["boxdKeyFrom"] = env.BOXD_API_KEY ? "env" : null;
  if (!env.BOXD_API_KEY && user.boxdKey === "keychain") {
    const k = keychain();
    if (k) { env.BOXD_API_KEY = k; boxdKeyFrom = "keychain"; }
  }
  // No OS keychain and the user agreed: a 0600 file next to the config.
  if (!env.BOXD_API_KEY && user.boxdKey === "file") {
    const k = readConfig(join(capcomdHome(env), "credentials")) as Record<string, unknown>;
    if (typeof k.BOXD_API_KEY === "string") { env.BOXD_API_KEY = k.BOXD_API_KEY; boxdKeyFrom = "file"; }
  }
  return { user: existsSync(userPath) ? userPath : null, project: projectPath, keys, boxdKeyFrom };
}

/** `run new` defaults from the project config (flags win). */
export function runDefaults(cwd = process.cwd()): NonNullable<CapcomdConfig["run"]> {
  return readConfig(projectConfigPath(cwd)).run ?? {};
}

/** The driver policy: the project's settings over the user's. */
export function driverPolicy(cwd = process.cwd(), env: Source = process.env): NonNullable<CapcomdConfig["driver"]> {
  if (env.CAPCOMD_NO_CONFIG) return {};
  return { ...(readConfig(userConfigPath(env)).driver ?? {}), ...(readConfig(projectConfigPath(cwd)).driver ?? {}) };
}

function defaultKeychain(): string | null {
  try { return (require("./keychain") as typeof import("./keychain")).keychainGet(); } catch { return null; }
}
