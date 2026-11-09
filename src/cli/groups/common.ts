// What the kernel's command groups share (src/cli/groups/*.ts, registered by the built-in front doors in
// src/plugins/front/): the parsed command line, the relay.v1 envelope they print, and the usage error.
import { RelayError, SCHEMA } from "../../core/errors";
import { loadTrace } from "../commands/trace";

/** One command as the dispatcher parsed it (src/cli/index.ts): `positionals[0]` is the command's own name. */
export interface Cmd {
  command: string;
  positionals: string[];
  /** The flags, parsed with the CLI's own table (a repeated flag: a list). */
  values: Record<string, any>;
  json: boolean;
}
/** A kernel command: it prints its own output (text, the relay.v1 envelope with --json, or a stream) and returns the
 *  exit code (src/core/errors.ts EXIT). */
export type KernelCommand = (c: Cmd) => Promise<number>;

export function usage(message: string): never {
  throw new RelayError("usage", message, "Run `capcomd --help` for usage.");
}

/** Plugins only the daemon runs that an operation this process ran itself couldn't ask (plugin API §6.1), on stderr:
 *  scripts read stdout. */
export function saySkipped(what: string, skipped: ReadonlyArray<{ plugin: string; hooks: readonly string[] }>, why: string): void {
  if (skipped.length) console.error(`capcomd: ${what}: not asked: ${skipped.map((u) => `${u.plugin} (${u.hooks.join(", ")})`).join(", ")}, because ${why}.`);
}

/** Why `capcomd spawn` and `capcomd run` can't ask the daemon's plugins: they run where the command's project is. */
export const RUNS_HERE = "this command runs in this process (it reads the project and settings where you typed it), and only the daemon runs those plugins";
export const RUNS_HERE_HINT = "A spawn or a run typed here can't reach the daemon's plugins yet (plugin API §6.1): an agent's spawns run in the daemon. Turn the plugin off (`plugins.<name>.enabled: false` in ~/.capcomd/config.json) to do it from here.";

/** One relay.v1 envelope on stdout. */
export const out = (obj: Record<string, unknown>) => console.log(JSON.stringify({ schema: SCHEMA, ok: true, ...obj }));

export const jsonish = (v: unknown) => { if (typeof v !== "string") return v; try { return JSON.parse(v); } catch { return v; } };

export function deepMerge(a: Record<string, any>, b: Record<string, any>): Record<string, any> {
  const o: Record<string, any> = { ...a };
  for (const [k, v] of Object.entries(b)) o[k] = v && typeof v === "object" && !Array.isArray(v) && o[k] && typeof o[k] === "object" ? deepMerge(o[k], v) : v;
  return o;
}

/** A run's trace from where the run wrote it (its CAPCOMD_TRACE_DIR at `run new`), when this shell's dir has none. */
export async function runTraceAt(runId: string) {
  const dir = await (await import("../../primitives/ops")).runTraceDir(runId).catch(() => undefined);
  return dir ? loadTrace(runId, dir) : null;
}
