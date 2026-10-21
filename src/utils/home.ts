// Where capcomd keeps local state. A dev checkout (the package root has .git) keeps the layout it always
// had: <repo>/.relay (ledgers), <repo>/.traces, <repo>/.capcomd/agents.json. An installed CLI (or any
// CLI with CAPCOMD_HOME set) uses ~/.capcomd (or $CAPCOMD_HOME): state/, traces/, agents.json, so state
// survives upgrades instead of living inside node_modules. Per-file overrides (CAPCOMD_AUTH_LEDGER, …) win.
import { existsSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";

export const PACKAGE_ROOT = resolve(new URL("../..", import.meta.url).pathname);
type Source = Record<string, string | undefined>;

/** A git checkout of capcomd itself (development), as opposed to an installed package. */
export const isDevCheckout = () => existsSync(join(PACKAGE_ROOT, ".git"));
const useHome = (source: Source) => !!source.CAPCOMD_HOME || !isDevCheckout();

/** ~/.capcomd, or $CAPCOMD_HOME. */
export function capcomdHome(source: Source = process.env): string {
  return source.CAPCOMD_HOME ? resolve(source.CAPCOMD_HOME) : join(homedir(), ".capcomd");
}

/** Local ledgers: auth profiles, env snapshots, the boxd VM ledger, run logs, driver pids. */
export function stateDir(source: Source = process.env): string {
  return useHome(source) ? join(capcomdHome(source), "state") : join(PACKAGE_ROOT, ".relay");
}

/** Span files (`<runId>.ndjson`). */
export function tracesDir(source: Source = process.env): string {
  return useHome(source) ? join(capcomdHome(source), "traces") : join(PACKAGE_ROOT, ".traces");
}

/** Agent profiles: the current project's .capcomd/agents.json when it has one, else the user's (or the checkout's). */
export function defaultAgentsFile(source: Source = process.env, cwd = process.cwd()): string {
  const project = join(cwd, ".capcomd", "agents.json");
  if (existsSync(project)) return project;
  return useHome(source) ? join(capcomdHome(source), "agents.json") : join(PACKAGE_ROOT, ".capcomd", "agents.json");
}
