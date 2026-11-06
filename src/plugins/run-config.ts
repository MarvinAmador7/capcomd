// A run's plugin config (docs/spec/plugin-api.md §10.2 layer 5): `plugins: {<name>: {…}}` in POST /v1/runs, or
// `capcomd run --plugin-config <name>.<key>=<value>`, only for the properties a plugin's schema marks `x-per-run`, each
// checked against its own schema when the run is created (refused otherwise: a 422 naming `plugins.<name>.<path>`). It
// is run data, not plugin config: the kernel writes it to the plugin's run storage under `config` (the run's kv
// `plugin/<name>/config`, which the plugin reads and can't write), so a listener on a run-scoped hook reads
// `await ctx.storage.get({runId}, "config")`. The plugins are the ones the daemon would load (their manifests, read
// without running them).
import { RelayError } from "../core/errors";
import { readManifest, loadManifest } from "../../packages/plugin/src/load";
import { runConfigIssues } from "../../packages/plugin/src/config";
import { PLUGIN_NAME_PATTERN, type PluginManifest } from "../../packages/plugin/src/manifest";
import { VERSION } from "../utils/self";

type Env = Record<string, string | undefined>;
export type RunPluginConfig = Record<string, Record<string, unknown>>;

/** The key a plugin's run overrides live under in its run storage (src/plugins/storage.ts: the plugin can't write it). */
export const RUN_CONFIG_KEY = "config";
export const runConfigKv = (name: string) => `plugin/${name}/${RUN_CONFIG_KEY}`;

/** A run's plugin config that can't be used: `field` is the body's path, `plugins.<name>.<path>`. */
export class RunConfigError extends RelayError {
  constructor(readonly field: string, message: string) {
    super("usage", `${field}: ${message}`, "A run may set only a plugin's per-run settings (x-per-run in its config schema); capcomd plugins list names the plugins.", { code: "plugins" });
  }
}

/** `--plugin-config <name>.<key>[.<sub>…]=<value>`, repeatable: the value is JSON when it parses, else the string. */
export function parsePluginConfigFlags(flags: string[]): RunPluginConfig {
  const out: RunPluginConfig = {};
  for (const f of flags) {
    const eq = f.indexOf("=");
    const path = eq > 0 ? f.slice(0, eq).split(".") : [];
    if (path.length < 2 || path.some((p) => !p)) throw new RelayError("usage", `--plugin-config ${JSON.stringify(f).slice(0, 120)}: not <plugin>.<key>=<value>`, "e.g. --plugin-config slack-notifier.channel=#ops");
    const raw = f.slice(eq + 1);
    let value: unknown;
    try { value = JSON.parse(raw); } catch { value = raw; }
    let at = (out[path[0]!] ??= {}) as Record<string, unknown>;
    for (const p of path.slice(1, -1)) at = (at[p] && typeof at[p] === "object" && !Array.isArray(at[p]) ? at[p] : (at[p] = {})) as Record<string, unknown>;
    at[path.at(-1)!] = value;
  }
  return out;
}

/** The `--plugin-config` flags that give `cfg` again (what `capcomd run --detach` and POST /v1/runs pass on). */
export const pluginConfigFlags = (cfg: RunPluginConfig): string[] =>
  Object.entries(cfg).flatMap(([name, values]) => Object.entries(values).map(([k, v]) => `--plugin-config=${name}.${k}=${JSON.stringify(v)}`));

/** The manifests of the plugins the daemon would load (src/plugins/host.ts builtinCandidates), by name. */
async function manifests(env: Env, cwd: string): Promise<Map<string, { manifest: PluginManifest; dir: string | null }>> {
  const { builtinCandidates } = await import("./host");
  const out = new Map<string, { manifest: PluginManifest; dir: string | null }>();
  for (const c of builtinCandidates(env, cwd)) {
    const l = c.dir ? readManifest(c.dir, { capcomd: VERSION }) : loadManifest(c.manifest, { capcomd: VERSION });
    if (l.ok && !out.has(l.manifest.name)) out.set(l.manifest.name, { manifest: l.manifest, dir: c.dir ?? null });
  }
  return out;
}

/** Check a run's plugin config (§10.4): each plugin known, each key one of its `x-per-run` settings and valid. */
export async function checkRunPluginConfig(cfg: unknown, o: { env?: Env; cwd?: string } = {}): Promise<RunPluginConfig> {
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) throw new RunConfigError("plugins", "an object of plugin names to their per-run settings");
  const entries = Object.entries(cfg as Record<string, unknown>);
  if (!entries.length) return {};
  const known = await manifests(o.env ?? process.env, o.cwd ?? process.cwd());
  const out: RunPluginConfig = {};
  for (const [name, values] of entries) {
    if (!new RegExp(PLUGIN_NAME_PATTERN).test(name)) throw new RunConfigError(`plugins.${name.slice(0, 64)}`, "not a plugin name");
    const k = known.get(name);
    if (!k) throw new RunConfigError(`plugins.${name}`, `no plugin ${name} here`);
    const issues = runConfigIssues(k.manifest, k.dir, values);
    if (issues.length) throw new RunConfigError(`plugins.${name}.${issues[0]!.path}`, issues[0]!.message);
    out[name] = values as Record<string, unknown>;
  }
  return out;
}

/** Record a run's plugin config in its kv (once the run exists): the kernel's write, which the plugin only reads. */
export async function writeRunPluginConfig(runId: string, cfg: RunPluginConfig): Promise<void> {
  const { kvWrite } = await import("../primitives/state");
  for (const [name, values] of Object.entries(cfg)) await kvWrite(runId, { k: runConfigKv(name), value: values, writer: "operator" });
}
