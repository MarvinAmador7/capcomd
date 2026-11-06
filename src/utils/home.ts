// Where capcomd keeps local state. A dev checkout (the package root has .git) keeps the layout it always
// had: <repo>/.relay (ledgers), <repo>/.traces, <repo>/.capcomd/agents.json. An installed CLI (or any
// CLI with CAPCOMD_HOME set) uses ~/.capcomd (or $CAPCOMD_HOME): state/, traces/, agents.json, so state
// survives upgrades instead of living inside node_modules. Per-file overrides (CAPCOMD_AUTH_LEDGER, …) win.
import { existsSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";

export const PACKAGE_ROOT = resolve(new URL("../..", import.meta.url).pathname);
type Source = Record<string, string | undefined>;

/** The single executable (`bun build --compile`, scripts/build-binary.ts): its modules live in Bun's virtual $bunfs. */
export const COMPILED = import.meta.url.includes("$bunfs") || import.meta.url.includes("~BUN");

/** A git checkout of capcomd itself (development), as opposed to an installed package or binary. */
export const isDevCheckout = () => !COMPILED && existsSync(join(PACKAGE_ROOT, ".git"));
const useHome = (source: Source) => !!source.CAPCOMD_HOME || !isDevCheckout();

/** ~/.capcomd, or $CAPCOMD_HOME. */
export function capcomdHome(source: Source = process.env): string {
  return source.CAPCOMD_HOME ? resolve(source.CAPCOMD_HOME) : join(homedir(), ".capcomd");
}

/** Local ledgers: auth profiles, env snapshots, the boxd VM ledger, run logs, driver pids. */
export function stateDir(source: Source = process.env): string {
  return useHome(source) ? join(capcomdHome(source), "state") : join(PACKAGE_ROOT, ".relay");
}

/** A file at the top of the capcomd home (~/.capcomd/<name>, or $CAPCOMD_HOME/<name>): the daemon's harness-state.json,
 *  the engine autostart's engine.log. A dev checkout keeps it with its other state, <repo>/.relay/<name>. */
export function homeFile(name: string, source: Source = process.env): string {
  return useHome(source) ? join(capcomdHome(source), name) : join(PACKAGE_ROOT, ".relay", name);
}

/** Span files (`<runId>.ndjson`). */
export function tracesDir(source: Source = process.env): string {
  return useHome(source) ? join(capcomdHome(source), "traces") : join(PACKAGE_ROOT, ".traces");
}

/** Agent profiles (v1): the current project's .capcomd/agents.json when the project has profiles (that file, or a
 *  .capcomd/profiles/ directory beside it), else the user's (or the checkout's). The project's v2 profiles are the
 *  ones next to this file (src/profiles/load.ts profileLayers). */
export function defaultAgentsFile(source: Source = process.env, cwd = process.cwd()): string {
  const project = join(cwd, ".capcomd", "agents.json");
  if (existsSync(project) || existsSync(join(cwd, ".capcomd", "profiles"))) return project;
  return useHome(source) ? join(capcomdHome(source), "agents.json") : join(PACKAGE_ROOT, ".capcomd", "agents.json");
}

/** The user's v2 profiles (ADR-024 §2.1): ~/.capcomd/profiles (or $CAPCOMD_HOME/profiles; the checkout's
 *  .capcomd/profiles in a dev checkout), next to the user's agents.json. */
export function userProfilesDir(source: Source = process.env): string {
  return useHome(source) ? join(capcomdHome(source), "profiles") : join(PACKAGE_ROOT, ".capcomd", "profiles");
}
