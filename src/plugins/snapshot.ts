// The running daemon's plugin listing (`<home>/state/plugins.json`, written by `capcomd serve`'s host, src/plugins/host.ts):
// how a process that isn't the daemon (the CLI, the MCP server, a run's driver) knows which plugins the daemon has, since
// it has no API token for `GET /v1/plugins` (docs/spec/plugin-api.md §13.2). `capcomd plugins list` shows it; a profile's
// seams are checked against it (§7.1, ADR-024 §9), as its lifecycle plugins are (src/plugins/lifecycle.ts).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PluginSummary } from "../../packages/plugin/src/host/host";
import { stateDir } from "../utils/home";
import { inDaemon } from "./hooks";

type Env = Record<string, string | undefined>;

/** Where the running daemon keeps its plugin listing for `capcomd plugins list` (the CLI has no API token). */
export const pluginsSnapshotPath = (env: Env = process.env) => join(stateDir(env), "plugins.json");
export type PluginsSnapshot = { pid: number; at: string; plugins: PluginSummary[] };

/** The running daemon's listing, or null when there is none or the daemon that wrote it is gone. */
export function readSnapshot(path = pluginsSnapshotPath()): PluginsSnapshot | null {
  if (!existsSync(path)) return null;
  try {
    const s = JSON.parse(readFileSync(path, "utf8")) as PluginsSnapshot;
    process.kill(s.pid, 0);
    return Array.isArray(s.plugins) ? s : null;
  } catch { return null; }
}

export type SeamKind = "sandbox" | "agent";

/** The seams of `kind` the running daemon's active plugins provide, by name; null in the daemon (its own host is the
 *  answer) and when no daemon runs. An entry of the listing that isn't the shape the daemon writes provides nothing
 *  (every profile command reads this, so a damaged listing must not stop them). */
export function daemonSeamNames(kind: SeamKind, env: Env = process.env): string[] | null {
  if (inDaemon()) return null;
  const snap = readSnapshot(pluginsSnapshotPath(env));
  if (!snap) return null;
  const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
  return snap.plugins.filter((p) => isObject(p) && p.state === "active" && p.enabled === true && Array.isArray(p.seams))
    .flatMap((p) => p.seams!.filter((s) => isObject(s) && s.kind === kind && typeof s.name === "string").map((s) => s.name));
}

/**
 * Whether a profile may name the seam `name` (spec §7.1: a seam name is checked at validation, ADR-024 §9): `active`
 * when it is one here (`here`: the daemon's own seams in the daemon, the built-ins elsewhere) or, outside the daemon,
 * one the running daemon lists as active, since a plugin from the user's home or the project is loaded only there;
 * `missing` when neither has it; `unchecked` when neither has it and no daemon runs to ask (the daemon checks it again
 * when it resolves the profile, so this is a warning, never a pass).
 */
export function seamPresence(kind: SeamKind, name: string, here: boolean, env: Env = process.env): "active" | "missing" | "unchecked" {
  if (here) return "active";
  const listed = daemonSeamNames(kind, env);
  if (!listed) return inDaemon() ? "missing" : "unchecked";
  return listed.includes(name) ? "active" : "missing";
}

const UNCONFIRMED = "and no daemon is running to say whether one of its plugins provides it";
const CHECKED_LATER = " (the daemon checks when an agent uses the profile)";
/** The warning reading profiles gives for a seam `unchecked` (`at`: the profile, `field`: where it names the seam). */
export const unconfirmedSeam = (at: string, field: string, kind: SeamKind, name: string): string =>
  `${at}: ${field} "${name}" isn't a built-in ${kind} provider, ${UNCONFIRMED}${CHECKED_LATER}`;
/** An unconfirmedSeam warning without what it says about later (a write refuses one, src/profiles/write.ts); null for
 *  any other warning. */
export const unconfirmedOf = (warning: string): string | null =>
  warning.includes(UNCONFIRMED) && warning.endsWith(CHECKED_LATER) ? warning.slice(0, -CHECKED_LATER.length) : null;
