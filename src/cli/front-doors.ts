// The CLI's front doors (plugin API §4.7.1, §17.2 step 8): a command is a registration (`ctx.cli.command`) in this
// process's plugin host (src/plugins/host.ts `localHost`), which loads the built-in front doors (src/plugins/front/) and,
// in tests, CAPCOMD_TEST_PLUGINS. The dispatcher (./index.ts) looks a command up here.
//  - The kernel's own groups are the built-ins the kernel names (`kernelSurface`, src/plugins/builtins.ts): parsed with
//    the kernel's flag table, they print their own output and answer `{exit}`.
//  - Any other plugin's command runs with the caller's principal (the operator) and answers with a relay.v1 envelope,
//    printed here: as one JSON line with --json, else its `text` (or the envelope as JSON). A PluginError it throws is
//    printed as `{schema, ok: false, error}` with the matching exit code (src/core/errors.ts EXIT).
import type { CliCommandSpec, Envelope } from "../../packages/plugin/src/context";
import { PluginError, type PluginErrorCode } from "../../packages/plugin/src/errors";
import { EXIT, RelayError, SCHEMA, toRelayError, type ErrorCode } from "../core/errors";
import { FLAGS } from "./flags";

/** Who runs a command on the host's own CLI (§3.2, §11.2): the operator. */
export const OPERATOR = { kind: "operator", clientId: null } as const;

/** What the dispatcher answers itself: the host's own commands, never a plugin's (KERNEL_COMMANDS has them too). */
export const DISPATCHER_COMMANDS = ["serve", "plugins", "help", "version", "tui"] as const;

export interface FrontDoor {
  plugin: string;
  spec: CliCommandSpec;
  /** One of the kernel's own front doors. */
  kernel: boolean;
}

/** The command `name` as this process's plugins registered it, or null when none did. */
export async function frontDoor(name: string): Promise<FrontDoor | null> {
  const { localHost } = await import("../plugins/host");
  const { KERNEL_SURFACE } = await import("../plugins/builtins");
  const c = (await localHost()).contributions.get("cli", name);
  return c ? { plugin: c.plugin, spec: c.value.spec, kernel: KERNEL_SURFACE.has(c.plugin) } : null;
}

/**
 * Why `capcomd <name>` has no command here: the plugin that declares it (its listing's `commands`, as GET /v1/plugins has
 * it) isn't active in this process, named with its state and cause; else no plugin adds it, an unknown command.
 */
export async function noCommand(name: string): Promise<RelayError> {
  const { localHost } = await import("../plugins/host");
  const host = await localHost();
  const p = host.list().find((x) => x.commands?.includes(name));
  if (!p) return new RelayError("usage", `unknown command: ${name}`, "Run `capcomd --help` for usage.");
  const why = host.message(p.name);
  const off = !p.enabled && (p.cause === "disabled" || p.state === "validated");
  // The environment's `enabled` wins over the config `capcomd plugins enable` writes (§10.2): name the variable instead.
  const { envName } = await import("../plugins/config");
  const variable = envName(p.name, "enabled");
  const byEnv = off && (() => { try { return JSON.parse(process.env[variable] ?? "") === false; } catch { return false; } })();
  return new RelayError("config", `capcomd ${name} is the ${p.name} plugin's command, and ${p.name} isn't running: ${p.state}${p.cause ? ` (${p.cause})` : ""}${why ? `: ${why}` : ""}`,
    byEnv ? `${variable}=${process.env[variable]} in the environment turns it off, over your config: unset it to turn ${p.name} on.`
      : off ? `Turn it on: capcomd plugins enable ${p.name}` : `capcomd plugins show ${p.name} says more.`, { code: `plugin:${p.name}` });
}

/** `--help` for a plugin's command (its usage lines), or with null a list of every plugin's command; "" when none. */
export async function pluginHelp(name: string | null): Promise<string> {
  const { localHost } = await import("../plugins/host");
  const { KERNEL_SURFACE } = await import("../plugins/builtins");
  const theirs = (await localHost()).contributions.list("cli").filter((c) => !KERNEL_SURFACE.has(c.plugin));
  if (name !== null) {
    const c = theirs.find((x) => x.key === name);
    return c ? `\nUsage (the ${c.plugin} plugin):\n${(c.value.spec.usage.length ? c.value.spec.usage : [`capcomd ${name}`]).map((l) => `  ${l}`).join("\n")}\n\n${c.value.spec.summary}\n` : "";
  }
  if (!theirs.length) return "";
  const w = Math.max(...theirs.map((c) => c.key.length));
  return `\nPlugin commands:\n${theirs.map((c) => `  capcomd ${c.key.padEnd(w)}  ${c.value.spec.summary}  (${c.plugin})`).join("\n")}\n`;
}

type Flags = Record<string, string | boolean | string[]>;

/**
 * A plugin command's words and flags: `--k=v`, `--k v` (the next word, unless it starts with `-`; a flag of the
 * kernel's table keeps its type, so `--json` never takes a value), `-h`/`-y`, `--` ends the flags; a repeated flag is a
 * list. Also how the dispatcher finds the command word in a line the kernel's strict parse refused.
 */
export function parseLoose(argv: string[]): { positionals: string[]; flags: Flags } {
  const positionals: string[] = [];
  const flags: Flags = {};
  const set = (k: string, v: string | boolean) => {
    const had = flags[k];
    if (had === undefined || (had === true && v === true)) { flags[k] = v; return; }
    flags[k] = [...(Array.isArray(had) ? had : [String(had)]), String(v)];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") { positionals.push(...argv.slice(i + 1)); break; }
    if (a.startsWith("--") && a.length > 2) {
      const eq = a.indexOf("=");
      if (eq > 2) { set(a.slice(2, eq), a.slice(eq + 1)); continue; }
      const k = a.slice(2), known = FLAGS[k], next = argv[i + 1];
      if (known?.type === "boolean") { set(k, true); continue; }
      if (next !== undefined && (known?.type === "string" || !next.startsWith("-"))) { set(k, next); i++; continue; }
      set(k, true);
      continue;
    }
    const short = /^-([a-zA-Z])$/.exec(a);
    const named = short ? Object.entries(FLAGS).find(([, o]) => o.short === short[1])?.[0] : undefined;
    if (named) { set(named, true); continue; }
    positionals.push(a);
  }
  return { positionals, flags };
}

/** How a plugin's refusal reads on the CLI (§8.3, read the other way). */
const CODE_OF: Record<PluginErrorCode, ErrorCode> = {
  forbidden: "usage", unsupported: "config", widening: "usage", invalid: "usage", conflict: "conflict", not_found: "not_found",
  disposed: "run_failed", timeout: "run_failed", unavailable: "run_failed",
};
/** `hint`: the next step when the plugin gave none. */
export function relayErrorOf(e: unknown, plugin: string, hint: string): RelayError {
  if (e instanceof RelayError) return e;
  if (e instanceof PluginError) return new RelayError(CODE_OF[e.code], e.message, e.hint ?? hint, { code: e.code === "forbidden" ? "forbidden" : `plugin:${plugin}`, ...(e.retryable ? { retryable: true } : {}) });
  return toRelayError(e);
}

/** A relay.v1 envelope, as a command or a tool must answer (§4.7.1, §4.7.2). */
export const isEnvelope = (r: unknown): r is Envelope => !!r && typeof r === "object" && !Array.isArray(r) && (r as { schema?: unknown }).schema === SCHEMA && (r as { ok?: unknown }).ok === true;

/** Print a command's answer and return its exit code: a kernel front door's `{exit}`, else its envelope (§4.7.1). */
export function printAnswer(door: FrontDoor, r: unknown, json: boolean): number {
  if (door.kernel && r && typeof r === "object" && typeof (r as { exit?: unknown }).exit === "number") return (r as { exit: number }).exit;
  if (!isEnvelope(r)) throw new RelayError("run_failed", `the ${door.plugin} plugin's ${door.spec.name} command didn't answer with a relay.v1 envelope`, `Report it to the ${door.plugin} plugin's author.`, { code: `plugin:${door.plugin}` });
  if (json) console.log(JSON.stringify(r));
  else console.log(typeof r.text === "string" ? r.text : JSON.stringify(r, null, 2));
  return EXIT.ok;
}

/** Run a plugin's command (not the kernel's) for the whole command line `argv`, print its answer, return the exit code. */
export async function runPluginCommand(door: FrontDoor, argv: string[]): Promise<number> {
  const { positionals, flags } = parseLoose(argv);
  const name = door.spec.name;
  const json = flags.json === true;
  if (flags.help === true) {
    console.log(await pluginHelp(name));
    return EXIT.ok;
  }
  // Ctrl-C asks the command to stop (its signal); a second one, or one it doesn't answer within 5 s, ends the process.
  const abort = new AbortController();
  const onSigint = () => {
    if (abort.signal.aborted) process.exit(130);
    abort.abort(new PluginError("timeout", "interrupted"));
    setTimeout(() => process.exit(130), 5_000).unref();
  };
  process.on("SIGINT", onSigint);
  try {
    const { json: _j, help: _h, ...rest } = flags;
    return printAnswer(door, await door.spec.run({ args: positionals.slice(1), flags: rest, json, principal: OPERATOR, signal: abort.signal }), json);
  } catch (e) {
    const err = relayErrorOf(e, door.plugin, `\`capcomd ${name} --help\` shows its usage.`);
    if (json) console.log(JSON.stringify(err.toJSON()));
    else console.error(`\n✗ ${err.message}\n  ${err.hint}`);
    return err.exitCode;
  } finally {
    process.off("SIGINT", onSigint);
  }
}
