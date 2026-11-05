// What a built-in forge reads about the operation it serves (docs/spec/plugin-api.md §7.4): the project's merge settings
// (CAPCOMD_GITHUB_API, its poll interval and wait, the repository) and the environment the caller runs tools in
// (CAPCOMD_GH_CLI, a GITHUB_TOKEN). The kernel sets it around each forge call; a forge that finds none uses its own
// config. Until a project's layer of a plugin's config exists (§10.2), this is how a run's recorded settings reach its
// forge.
import { AsyncLocalStorage } from "node:async_hooks";
import type { MergeConfig } from "../../merge/config";

export interface ForgeScope {
  merge?: MergeConfig | null;
  env?: Record<string, string | undefined>;
  /** The repository as its service names it (owner/name), when the caller named it outright (CAPCOMD_GITHUB_REPO). */
  repo?: string | null;
  /** Tests: stand-ins for what a built-in forge would ask the network (the user's login and API, a fetch). */
  stubs?: { login?: (() => Promise<{ api: string; token: string } | null>) | null; fetch?: typeof fetch };
}

export const forgeScope = new AsyncLocalStorage<ForgeScope>();
export const scoped = (): ForgeScope => forgeScope.getStore() ?? {};
/** The environment a forge's tools run in: this process's, with the caller's on top. */
export const scopedEnv = (): Record<string, string | undefined> => ({ ...process.env, ...(scoped().env ?? {}) });
