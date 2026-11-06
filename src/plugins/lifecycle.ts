// ADR-024 `lifecycle.onStart|onEnd` (docs/spec/plugin-api.md §6.6.8): a profile names plugins that must be active for
// its agents. There is no per-profile hook: each named plugin listens to `agent.changed`, which fires in the daemon
// (§6.1) and carries the names (its `lifecycle`), so the plugin hears the starts and ends it was named for. The kernel's
// part is the guarantee: an agent whose profile names a plugin that isn't active, or doesn't listen to agent.changed,
// is refused at spawn and doesn't start (a config failure), never runs unheard.
import { gates, hooks, inDaemon } from "./hooks";

/**
 * Whether the plugins a profile's lifecycle names can hear its agents: `problem` says which can't (not active, or not
 * listening to agent.changed), null when each can. In the daemon, its own host says (once its plugins have loaded);
 * elsewhere (the CLI, a run's driver) the running daemon's listing (`capcomd plugins list`). With no daemon running
 * there is nobody to ask (`checked: false`, no problem): the daemon asks again when the agent starts.
 */
export async function lifecycleCheck(names: readonly string[], env: Record<string, string | undefined> = process.env): Promise<{ problem: string | null; checked: boolean }> {
  if (!names.length) return { problem: null, checked: true };
  let missing: string[];
  if (inDaemon()) {
    await gates();
    const listening = new Set(hooks.order("agent.changed"));
    missing = names.filter((n) => !listening.has(n));
  } else {
    const { pluginsSnapshotPath, readSnapshot } = await import("./host");
    const snap = readSnapshot(pluginsSnapshotPath(env));
    if (!snap) return { problem: null, checked: false };
    missing = names.filter((n) => !snap.plugins.some((p) => p.name === n && p.state === "active" && p.enabled && p.hooks.includes("agent.changed")));
  }
  if (!missing.length) return { problem: null, checked: true };
  return { problem: `lifecycle names ${missing.join(", ")}, which ${missing.length === 1 ? "isn't an active plugin" : "aren't active plugins"} listening to agent.changed on this daemon`, checked: true };
}

/** lifecycleCheck's problem alone (spawn, an agent's start). */
export const lifecycleProblem = async (names: readonly string[], env?: Record<string, string | undefined>): Promise<string | null> => (await lifecycleCheck(names, env)).problem;

/** What to do about a lifecycle problem. */
export const LIFECYCLE_HINT = "Enable the plugin (`capcomd plugins list` shows each plugin, its state and its hooks), or remove it from the profile's lifecycle.onStart/onEnd.";
