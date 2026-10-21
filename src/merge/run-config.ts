// A run carries its repository settings: `run new` records the caller's CAPCOMD_REPO, merge mode, target,
// test command, GitHub repo, protected branches… (kv `_repo`), and engine-side code (the verifier, the
// worker's push) reads them from the run. So an engine started without them, e.g. a background service,
// still works, and one engine can serve runs on different repositories.
import { loadMergeConfig, repoEnvOf, type MergeConfig } from "./config";

export const RUN_REPO_KV = "_repo";

/** The repo settings recorded for a run ({} when none, or when the engine can't be asked). */
export async function runRepoEnv(runId: string | undefined): Promise<Record<string, string>> {
  if (!runId) return {};
  try {
    const { client } = await import("../core/relay");
    const look = (async () => (await (client().scope as any).get([runId]).kvGet({ k: RUN_REPO_KV }))?.value)().catch(() => null);
    const v: any = await Promise.race([look, new Promise((r) => setTimeout(() => r(null), 3000))]);
    return v && typeof v === "object" ? (v as Record<string, string>) : {};
  } catch { return {}; }
}

/** This process's env with the run's recorded repo settings on top (the run's settings win). */
export async function runEnv(runId: string | undefined): Promise<Record<string, string | undefined>> {
  return { ...process.env, ...(await runRepoEnv(runId)) };
}

/** The merge config for a run: its recorded repository, else this process's environment. */
export async function mergeConfigFor(runId: string | undefined): Promise<MergeConfig | null> {
  return loadMergeConfig(await runEnv(runId));
}

export { repoEnvOf };
