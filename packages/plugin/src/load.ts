// Manifest loading (spec §4.9): the schema, the cross-field rules the schema cannot state, path containment, the
// `engines` check (§4.4) and the kernel-command collision check (§4.7.1). What `capcomd plugins validate`, the host
// (§5.4 `discovered → validated`) and the test kit all run; no plugin code runs here.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { HOOKS, type HookName } from "./hooks";
import { parseManifest, type PluginManifest } from "./manifest";
import { parseRange, satisfies } from "./semver";

/** The kernel's own commands: the ones its dispatcher answers itself (`src/cli/front-doors.ts` `DISPATCHER_COMMANDS`)
 *  and the ones its built-in front doors register (`front-*`): a plugin's CLI group may not take one (§4.7.1).
 *  `tests/plugins/front-doors.test.ts` keeps it equal to the CLI's. */
export const KERNEL_COMMANDS = [
  "agent-drive", "agents", "approve", "auth", "await", "budget", "cancel", "clients", "doctor", "env", "events", "goal",
  "grant", "help", "inspect", "kv", "logs", "mcp", "merge", "pause", "plugins", "pr", "profiles", "replay", "resume", "run", "sandbox",
  "secrets", "send", "serve", "service", "setup", "skills", "spawn", "status", "task", "title", "token", "trace", "tree",
  "tui", "ui", "upgrade", "verify", "version", "wait-any", "check", "hermes", "triggers",
] as const;

const PROCESS_PROTOCOL = 1;

/** The plugin API majors this host serves (§12.1). */
export const API_VERSIONS: readonly number[] = [1];

export type ManifestIssue = { path: string; message: string };
export type LoadedManifest =
  | { ok: true; manifest: PluginManifest; warnings: ManifestIssue[] }
  /** `invalid_manifest` for the schema and the cross-field rules; `incompatible` for `apiVersion` and `engines`. */
  | { ok: false; cause: "invalid_manifest" | "incompatible"; issues: ManifestIssue[]; manifest: PluginManifest | null; raw: unknown };

export interface CheckOptions {
  /** The plugin's directory, for path containment. Omitted for a manifest that comes from code (a built-in). */
  dir?: string;
  /** The running capcomd version for the `engines` check; omitted: the check is skipped. */
  capcomd?: string;
  /** An operator's exemption for this exact `name@version` (§4.4 `allow-version`). */
  exempt?: boolean;
  /** One of the kernel's own front doors (a built-in the kernel names, `Candidate.kernelSurface`): its CLI groups are
   *  the kernel's commands, so the collision check doesn't apply to it. */
  kernelSurface?: boolean;
}

/** Inside `dir` after resolving symlinks (a path that does not exist yet is compared as written). */
function contained(dir: string, path: string): boolean {
  const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };
  const rel = relative(real(dir), real(join(dir, path)));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** §4.9 on a parsed manifest: everything but the schema itself. */
export function checkManifest(m: PluginManifest, o: CheckOptions = {}): { invalid: ManifestIssue[]; incompatible: ManifestIssue[]; warnings: ManifestIssue[] } {
  const invalid: ManifestIssue[] = [], incompatible: ManifestIssue[] = [], warnings: ManifestIssue[] = [];
  for (const [hook, decl] of Object.entries(m.contributes?.hooks ?? {})) {
    const meta = HOOKS[hook as HookName];
    if (decl?.timeoutMs !== undefined && decl.timeoutMs > meta.timeoutMs.max)
      invalid.push({ path: `contributes.hooks.${hook}.timeoutMs`, message: `${decl.timeoutMs} ms is over ${hook}'s maximum of ${meta.timeoutMs.max} ms (§6.4)` });
    if (decl?.failure === "closed" && meta.mode === "observe")
      warnings.push({ path: `contributes.hooks.${hook}.failure`, message: `${hook} is an observe hook: failure is always open (§6.5)` });
  }
  // Protocol 1 carries hooks and events only (§9.6): a seam, a source, a context provider (ADR-025: in process only) or a
  // front door of a process plugin would never be
  // registered, so its manifest can't declare one (its `provides` would order and resolve others by a lie).
  if (m.entry.runtime === "process")
    for (const k of ["seams", "sources", "context", "cli", "mcp", "api", "ui"] as const)
      if (m.contributes?.[k]?.length) invalid.push({ path: `contributes.${k}`, message: `an out-of-process plugin contributes hooks and events only in protocol ${PROCESS_PROTOCOL}; ${k} are in-process (§9.6)` });
  for (const [i, c] of (m.contributes?.cli ?? []).entries())
    if (!o.kernelSurface && (KERNEL_COMMANDS as readonly string[]).includes(c.name)) invalid.push({ path: `contributes.cli.${i}.name`, message: `\`capcomd ${c.name}\` is a kernel command (§4.7.1)` });
  if (!parseRange(m.engines.capcomd)) invalid.push({ path: "engines.capcomd", message: `not a semver range: ${JSON.stringify(m.engines.capcomd)}` });
  else if (o.capcomd && !o.exempt && !satisfies(o.capcomd, m.engines.capcomd))
    incompatible.push({ path: "engines.capcomd", message: `capcomd ${o.capcomd} is outside ${m.engines.capcomd} (§4.4)` });
  if (o.dir) {
    const paths: Array<[string, string]> = [];
    if (m.entry.runtime === "in-process") paths.push(["entry.module", m.entry.module]);
    else if (m.entry.command[0]!.startsWith("./")) paths.push(["entry.command.0", m.entry.command[0]!]);
    if (m.config && "$ref" in m.config && typeof m.config.$ref === "string") paths.push(["config.$ref", m.config.$ref]);
    for (const [path, p] of paths) {
      if (!contained(o.dir, p)) invalid.push({ path, message: `${p} resolves outside the plugin's directory (§4.9)` });
      else if (!existsSync(join(o.dir, p))) invalid.push({ path, message: `${p} does not exist` });
    }
  }
  return { invalid, incompatible, warnings };
}

/** The observers that make a plugin notifier-shaped (§16.5): it hears about every run and every agent. */
const NOTIFIER_HOOKS = ["run.changed", "agent.changed"] as const satisfies readonly HookName[];

/**
 * The attention-budget warnings of `capcomd plugins validate --strict` (§16.5): a notifier-shaped plugin (it observes
 * `run.changed` and `agent.changed`) whose config has no `quiet` option leaves the operator no way to turn it down short
 * of disabling it. `schema` is the plugin's config schema with any `$ref` already read; null when it has none.
 */
export function attentionWarnings(m: PluginManifest, schema: { properties?: Record<string, unknown> } | null): ManifestIssue[] {
  const hooks = m.contributes?.hooks ?? {};
  if (!NOTIFIER_HOOKS.every((h) => Object.hasOwn(hooks, h))) return [];
  if (schema?.properties && Object.hasOwn(schema.properties, "quiet")) return [];
  return [{
    path: "config.properties.quiet",
    message: "it observes run.changed and agent.changed, so it can speak about every run and agent, but its config has no quiet option: add a `quiet` property (a boolean; `x-per-run` lets a run set it) so people can turn it down without disabling it (§16.5)",
  }];
}

/** Parse and check a manifest value (§4.9). */
export function loadManifest(raw: unknown, o: CheckOptions = {}): LoadedManifest {
  // A major this host doesn't serve is `incompatible` (§12.5), not a schema error: the schema only knows major 1.
  const api = raw && typeof raw === "object" ? (raw as { apiVersion?: unknown }).apiVersion : undefined;
  if (typeof api === "number" && !API_VERSIONS.includes(api))
    return { ok: false, cause: "incompatible", issues: [{ path: "apiVersion", message: `plugin API ${api} is not served (this host serves ${API_VERSIONS.join(", ")})` }], manifest: null, raw };
  const r = parseManifest(raw);
  if (!r.ok) return { ok: false, cause: "invalid_manifest", issues: r.issues, manifest: null, raw };
  const c = checkManifest(r.manifest, o);
  if (c.invalid.length) return { ok: false, cause: "invalid_manifest", issues: c.invalid, manifest: r.manifest, raw };
  if (c.incompatible.length) return { ok: false, cause: "incompatible", issues: c.incompatible, manifest: r.manifest, raw };
  return { ok: true, manifest: r.manifest, warnings: c.warnings };
}

/** `<dir>/plugin.json`, parsed and checked (§4.9). */
export function readManifest(dir: string, o: Omit<CheckOptions, "dir"> = {}): LoadedManifest {
  const file = join(dir, "plugin.json");
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(file, "utf8")); } catch (e) {
    return { ok: false, cause: "invalid_manifest", issues: [{ path: "(root)", message: `${file}: ${(e as Error).message}` }], manifest: null, raw: null };
  }
  return loadManifest(raw, { ...o, dir });
}
