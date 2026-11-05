// What a built-in forge reads about the operation it serves (docs/spec/plugin-api.md §7.4): the project's merge settings
// (CAPCOMD_GITHUB_API, its poll interval and wait, the repository) and the environment the caller runs tools in
// (CAPCOMD_GH_CLI). The kernel sets it around each forge call; a forge that finds none uses its own config. Until a
// project's layer of a plugin's config exists (§10.2), this is how a run's recorded settings reach its forge.
import { AsyncLocalStorage } from "node:async_hooks";
import type { MergeConfig } from "../../merge/config";

export interface ForgeScope {
  merge?: MergeConfig | null;
  env?: Record<string, string | undefined>;
}

export const forgeScope = new AsyncLocalStorage<ForgeScope>();
export const scoped = (): ForgeScope => forgeScope.getStore() ?? {};
