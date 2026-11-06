// A project's settings for the context layer (its .capcomd/config.json `context`, ADR-025 §10): what its providers read
// besides an agent's profile, groundray's brain mappings (`brains`, each pinned to a commit). `run new` records them with
// the run (kv `_context`, reserved: an agent can't write it), as it records the repository's settings (`_repo`), so the
// process that prepares the run's agents (the daemon, the run's driver), whatever its directory, reads the project's,
// and every agent of the run reads the commit the run started with. Outside a run (`capcomd context brief`) they are
// read from the project's file.
import type { CapcomdConfig } from "../config/store";

export const RUN_CONTEXT_KV = "_context";
export type ContextSettings = NonNullable<CapcomdConfig["context"]>;

type Env = Record<string, string | undefined>;
const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** The project's `context` settings from its .capcomd/config.json (the nearest from `cwd`); {} without one, or with
 *  the persisted settings off (CAPCOMD_NO_CONFIG, which tests set), as for the project's sandbox. */
export function projectContext(cwd = process.cwd(), env: Env = process.env): ContextSettings {
  if (env.CAPCOMD_NO_CONFIG) return {};
  const { projectConfigPath, readConfig } = require("../config/store") as typeof import("../config/store");
  const c = readConfig(projectConfigPath(cwd, env)).context;
  return isMap(c) ? (c as ContextSettings) : {};
}

/** The settings run `runId` was started with (null: this process's project). {} when it recorded none (a run started
 *  before them, or a project without any) or the engine doesn't answer within 3 s. */
export async function contextSettings(runId: string | null): Promise<ContextSettings> {
  if (!runId) return projectContext();
  try {
    const { client } = await import("../core/relay");
    const look = (async () => (await (client().scope as any).get([runId]).kvGet({ k: RUN_CONTEXT_KV }))?.value)().catch(() => null);
    const v: unknown = await Promise.race([look, new Promise((r) => setTimeout(() => r(null), 3000))]);
    return isMap(v) ? (v as ContextSettings) : {};
  } catch { return {}; }
}

/** `run new`: record the project's settings with run `runId`, once (a retry keeps what the first call recorded). */
export async function recordRunContext(runId: string, cwd = process.cwd()): Promise<void> {
  const settings = projectContext(cwd);
  if (!Object.keys(settings).length) return;
  const { client } = await import("../core/relay");
  const prior = await client().scope.getOrCreate([runId]).kvGet({ k: RUN_CONTEXT_KV }).catch(() => null) as { deleted?: boolean } | null;
  if (prior && !prior.deleted) return;
  await (await import("../primitives/state")).kvWrite(runId, { k: RUN_CONTEXT_KV, value: settings, writer: "operator" });
}
