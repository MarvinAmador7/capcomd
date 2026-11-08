// A plugin's secrets (docs/spec/plugin-api.md §10.3): a property its config schema marks `"x-secret": true` holds a
// reference, never a value, and the host resolves it for that plugin only. The reference is the user's (`plugins.<name>.
// <key>` in ~/.capcomd/config.json, off with CAPCOMD_NO_CONFIG), else CAPCOMD_PLUGIN_<NAME>_<KEY> holding one, else,
// for a built-in only, the schema's default; never a project's (§10.2: a repository can't point a plugin at another of
// the daemon's variables; the host refuses one there, config_invalid), nor a third-party manifest's own default (its
// author would choose which of yours it gets). `env:<VAR>` is the daemon's environment variable, never one of the
// kernel's own (`kernelSecretRef` in src/plugins/config.ts) for a plugin that isn't a shipped built-in, whichever layer
// names it: the host fails that plugin config_invalid before it starts, and a resolution that gets here anyway is
// `forbidden` without reading the variable.
// `keychain:<account>` isn't resolved yet: the boxd key `capcomd setup` keeps in the OS keychain still reaches the daemon
// as BOXD_API_KEY (src/config/store.ts applyConfig), which is what sandbox-boxd's default reference names.
import { PluginError } from "../../packages/plugin/src/errors";
import { envName, kernelSecretRef, schemaOf, secretRefOf } from "./config";
import { readConfig, userConfigPath } from "../config/store";

type Env = Record<string, string | undefined>;
type Prop = { "x-secret"?: unknown; default?: unknown } | undefined;
type Manifest = { name: string; config?: unknown };

/** Whose a secret's reference may be: `builtin: false` (a plugin from a directory, a user's or a project's) leaves the
 *  schema's default out. Its author would pick which of the daemon's variables it gets (GITHUB_TOKEN, BOXD_API_KEY, a
 *  provider key): only the user points it at one (§10.3). Only `builtin: true` for a plugin without a directory (a
 *  shipped built-in; the kernel vouches for it) may resolve one of the kernel's own variables. */
export type SecretOrigin = { builtin?: boolean };

/** The reference `key` holds, when `key` is a secret `m` declares; a PluginError otherwise. `dir`: the plugin's
 *  directory, where a `$ref` schema is read from. */
export function secretRef(m: Manifest, key: string, env: Env = process.env, dir: string | null = null, o: SecretOrigin = {}): string {
  const prop = schemaOf(m, dir)?.properties?.[key] as Prop;
  if (!prop || prop["x-secret"] !== true) throw new PluginError("forbidden", `${key} is not a secret the ${m.name} plugin declares (§10.3)`);
  const user = env.CAPCOMD_NO_CONFIG ? undefined : ((readConfig(userConfigPath(env)).plugins as Record<string, unknown> | undefined)?.[m.name] as Record<string, unknown> | undefined)?.[key];
  const fromEnv = (() => { const v = env[envName(m.name, key)]; try { return v === undefined ? undefined : JSON.parse(v); } catch { return undefined; } })();
  for (const v of [user, fromEnv]) {
    const ref = secretRefOf(v);
    if (ref) return ref;
  }
  const ref = o.builtin === false ? undefined : (prop.default as { $secret?: unknown } | undefined)?.$secret;
  if (typeof ref !== "string" || !ref) throw new PluginError("not_found", `no reference is set for the ${m.name} plugin's ${key}${o.builtin === false ? ` (set plugins.${m.name}.${key} to {"$secret": "env:<VAR>"} in ~/.capcomd/config.json, or ${envName(m.name, key)}: a plugin's own default reference is followed for capcomd's built-ins only, §10.3)` : ""}`);
  return ref;
}

/** `key`'s value for plugin `m`, or a PluginError: `not_found` when the reference resolves to nothing, `forbidden` when
 *  it names one of the kernel's own variables and `m` isn't a shipped built-in (`builtin: true`, no `dir`). */
export function resolveSecret(m: Manifest, key: string, env: Env = process.env, dir: string | null = null, o: SecretOrigin = {}): string {
  const ref = secretRef(m, key, env, dir, o);
  const owned = o.builtin === true && dir === null ? null : kernelSecretRef(ref);
  if (owned) throw new PluginError("forbidden", `the ${m.name} plugin's ${key} names ${owned}`);
  const named = /^env:([A-Za-z_][A-Za-z0-9_]*)$/.exec(ref);
  if (named) {
    const v = env[named[1]!];
    if (v === undefined || v === "") throw new PluginError("not_found", `the ${m.name} plugin's ${key} (${ref}) is not set`);
    return v;
  }
  if (ref.startsWith("keychain:")) throw new PluginError("unsupported", `keychain references are not resolved yet (${m.name}.${key}); use env:<VAR>`);
  throw new PluginError("invalid", `${m.name}.${key}: ${JSON.stringify(ref)} is not a secret reference (env:<VAR> or keychain:<account>)`);
}

/** The same for the kernel's own use of a built-in's provider: undefined when it resolves to nothing. */
export function secretOrUndefined(m: Manifest, key: string, env: Env = process.env): string | undefined {
  try { return resolveSecret(m, key, env, null, { builtin: true }); } catch { return undefined; }
}
