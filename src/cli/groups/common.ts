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
