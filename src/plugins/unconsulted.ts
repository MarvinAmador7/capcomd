// The plugins an operation a front door runs itself can't ask (docs/spec/plugin-api.md §6.1, the owner's decision of
// 2026-11-08): only the daemon runs the user's plugins and a trusted project's (always out of process, §5.2), so a hook
// fired in the CLI or `capcomd mcp` reaches the built-ins alone. A front door's verify, merge and approval go to the
// daemon when one hosts its engine (src/primitives/front-door.ts); one it runs itself (no daemon; `run new`, `spawn`,
// which run where the command's project and environment are) asks this first, and treats a listener it can't ask as a
// call that failed (§6.5): a gate's, or one declared `failure: closed`, refuses the operation (fail-closed); any other is
// skipped, and the front door says so.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HOOKS, type HookName } from "../../packages/plugin/src/hooks";
import { RelayError } from "../core/errors";
import { inDaemon } from "./hooks";

type Env = Record<string, string | undefined>;
/** A plugin only the daemon runs that listens to some of an operation's hooks: `closed` when a call it can't answer
 *  denies the operation (a gate, or `failure: closed`). */
export type Unconsulted = { plugin: string; hooks: HookName[]; closed: boolean };

/** The plugins only the daemon runs (the user's, a trusted project's; enabled) that listen to one of `hooks`, in name
 *  order. None in the daemon (its own host asks them). */
export async function daemonOnlyListeners(hooks: readonly HookName[], env: Env = process.env, cwd = process.cwd()): Promise<Unconsulted[]> {
  if (inDaemon() || !hooks.length) return [];
  const H = await import("./host");
  const { projectPluginTrusted } = await import("./install");
  const files = (await import("./config")).pluginConfigFiles({ env, cwd });
  const out: Unconsulted[] = [];
  for (const c of [...H.userPlugins(env), ...H.projectPlugins(env, cwd)]) {
    if (!c.dir) continue;
    let m: { name?: unknown; contributes?: { hooks?: Record<string, { failure?: unknown } | undefined> } };
    try { m = JSON.parse(readFileSync(join(c.dir, "plugin.json"), "utf8")); } catch { continue; } // one that can't be read never runs
    if (typeof m?.name !== "string") continue;
    if (H.configured(c, env, files).enabled === false) continue;
    if (c.source === "project" && !projectPluginTrusted(c.dir).trusted) continue;
    const listens = Object.entries(m.contributes?.hooks ?? {}).filter(([h]) => hooks.includes(h as HookName));
    if (!listens.length) continue;
    const closed = listens.some(([h, d]) => HOOKS[h as HookName].gate || d?.failure === "closed");
    out.push({ plugin: m.name, hooks: listens.map(([h]) => h as HookName), closed });
  }
  return out.sort((a, b) => (a.plugin < b.plugin ? -1 : a.plugin > b.plugin ? 1 : 0));
}

/**
 * Before an operation this process runs itself (`what`: how the front door names it, e.g. `capcomd verify`): refused
 * when a plugin it can't ask must answer it (`why`: the reason the daemon isn't asked, said in the refusal), else the
 * listeners it skips, for the front door to say (an empty list: nothing skipped).
 */
export async function unconsulted(what: string, hooks: readonly HookName[], why: string, o: { env?: Env; cwd?: string; hint?: string } = {}): Promise<Unconsulted[]> {
  const found = await daemonOnlyListeners(hooks, o.env ?? process.env, o.cwd ?? process.cwd());
  const closed = found.filter((u) => u.closed);
  if (closed.length) {
    const names = closed.map((u) => `${u.plugin} (${u.hooks.join(", ")})`).join(", ");
    throw new RelayError("config", `${what} was refused: ${closed.length === 1 ? "the plugin" : "the plugins"} ${names} must judge it, and ${why}`,
      o.hint ?? "Start the daemon (`capcomd serve`) and retry: it asks them. Or turn the plugin off (`plugins.<name>.enabled: false` in ~/.capcomd/config.json) if it shouldn't judge this.",
      { code: "plugins_unconsulted" });
  }
  return found;
}

/** What a front door says about the listeners an operation skipped (one line), or null for none. */
export function unconsultedText(what: string, skipped: readonly Unconsulted[], why: string): string | null {
  if (!skipped.length) return null;
  return `capcomd: ${what}: not asked: ${skipped.map((u) => `${u.plugin} (${u.hooks.join(", ")})`).join(", ")}, because ${why}.`;
}
