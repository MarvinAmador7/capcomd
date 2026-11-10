// A plugin's secrets (docs/spec/plugin-api.md §10.3): a property its config schema marks `"x-secret": true` holds a
// reference, never a value, and the host resolves it for that plugin only. The reference is the user's (`plugins.<name>.
// <key>` in ~/.capcomd/config.json, off with CAPCOMD_NO_CONFIG), else CAPCOMD_PLUGIN_<NAME>_<KEY> holding one, else,
// for a built-in only, the schema's default; never a project's (§10.2: a repository can't point a plugin at another of
// the daemon's variables; the host refuses one there, config_invalid), nor a third-party manifest's own default (its
// author would choose which of yours it gets). `env:<VAR>` is the daemon's environment variable, never one of the
// kernel's own (`kernelSecretRef` in src/plugins/config.ts) for a plugin that isn't a shipped built-in, whichever layer
// names it: the host fails that plugin config_invalid before it starts, and a resolution that gets here anyway is
// `forbidden` without reading the variable.
// An explicit reference (the user's or CAPCOMD_PLUGIN_*'s) that doesn't resolve, or isn't a reference, is refused
// (`SecretRefused`, config_invalid; owner decision 2026-11-10): nothing stands in for it, so sandbox-boxd never falls
// back to BOXD_API_KEY, which may be another boxd account's key. Only the default reference, unresolved, is "not set".
// `keychain:<account>` isn't built yet: refused when the config is loaded (src/plugins/config.ts) and here, with the hint
// to use `env:<VAR>`. The boxd key `capcomd setup` keeps in the OS keychain still reaches the daemon as BOXD_API_KEY
// (src/config/store.ts applyConfig), which is what sandbox-boxd's default reference names.
import { PluginError, type PluginErrorCode } from "../../packages/plugin/src/errors";
import { envName, kernelSecretRef, KEYCHAIN_HINT, schemaOf, secretRefOf } from "./config";
import { readConfig, userConfigPath } from "../config/store";

type Env = Record<string, string | undefined>;
type Prop = { "x-secret"?: unknown; default?: unknown } | undefined;
type Manifest = { name: string; config?: unknown };

/** Whose a secret's reference may be: `builtin: false` (a plugin from a directory, a user's or a project's) leaves the
 *  schema's default out. Its author would pick which of the daemon's variables it gets (GITHUB_TOKEN, BOXD_API_KEY, a
 *  provider key): only the user points it at one (§10.3). Only `builtin: true` for a plugin without a directory (a
 *  shipped built-in; the kernel vouches for it) may resolve one of the kernel's own variables. */
export type SecretOrigin = { builtin?: boolean };

/** Where a secret's reference came from: the user's config, CAPCOMD_PLUGIN_<NAME>_<KEY>, or (a built-in's) its schema. */
export type SecretLayer = "user" | "env" | "default";

/**
 * A secret reference the kernel refuses, `config_invalid` (§10.3, owner decision 2026-11-10): an explicit one (the
 * user's config, CAPCOMD_PLUGIN_<NAME>_<KEY>) that doesn't resolve or isn't a reference, or any `keychain:` one. Nothing
 * is used in its place. `code` is what `ctx.config.secret` rejects with (`not_found` for a variable that isn't set,
 * `invalid`, `unsupported` for a keychain reference); the message names the reference, the hint the fix.
 */
export class SecretRefused extends PluginError {
  readonly failure = "config_invalid" as const;
  constructor(code: PluginErrorCode, readonly ref: string | null, readonly layer: SecretLayer, message: string, hint: string) {
    super(code, message, hint);
  }
}

/** Where the user sets `m`'s `key`, as a message names it. */
const whereSet = (m: Manifest, key: string, layer: SecretLayer) =>
  layer === "user" ? `plugins.${m.name}.${key} in ~/.capcomd/config.json` : layer === "env" ? envName(m.name, key) : `the ${m.name} plugin's default for ${key}`;

/** The reference `key` holds and the layer it came from, when `key` is a secret `m` declares; a PluginError otherwise
 *  (`not_found` when no layer sets one, a SecretRefused when a layer sets something that isn't a reference). `dir`: the
 *  plugin's directory, where a `$ref` schema is read from. */
export function secretSource(m: Manifest, key: string, env: Env = process.env, dir: string | null = null, o: SecretOrigin = {}): { ref: string; layer: SecretLayer } {
  const prop = schemaOf(m, dir)?.properties?.[key] as Prop;
  if (!prop || prop["x-secret"] !== true) throw new PluginError("forbidden", `${key} is not a secret the ${m.name} plugin declares (§10.3)`);
  const user = env.CAPCOMD_NO_CONFIG ? undefined : ((readConfig(userConfigPath(env)).plugins as Record<string, unknown> | undefined)?.[m.name] as Record<string, unknown> | undefined)?.[key];
  const raw = env[envName(m.name, key)];
  const fromEnv = raw === undefined || raw === "" ? undefined : (() => { try { return JSON.parse(raw) as unknown; } catch { return raw; } })();
  for (const [layer, v] of [["user", user], ["env", fromEnv]] as const) {
    if (v === undefined || v === null) continue;
    const ref = secretRefOf(v);
    if (!ref) throw new SecretRefused("invalid", null, layer, `${whereSet(m, key, layer)} is not a secret reference`, `Set it to {"$secret": "env:<VAR>"}, never the value itself.`);
    return { ref, layer };
  }
  const ref = o.builtin === false ? undefined : (prop.default as { $secret?: unknown } | undefined)?.$secret;
  if (typeof ref !== "string" || !ref) throw new PluginError("not_found", `no reference is set for the ${m.name} plugin's ${key}${o.builtin === false ? ` (set plugins.${m.name}.${key} to {"$secret": "env:<VAR>"} in ~/.capcomd/config.json, or ${envName(m.name, key)}: a plugin's own default reference is followed for capcomd's built-ins only, §10.3)` : ""}`);
  return { ref, layer: "default" };
}

/** The reference `key` holds, when `key` is a secret `m` declares; a PluginError otherwise. */
export function secretRef(m: Manifest, key: string, env: Env = process.env, dir: string | null = null, o: SecretOrigin = {}): string {
  return secretSource(m, key, env, dir, o).ref;
}

/** `key`'s value for plugin `m`, or a PluginError: `not_found` when the default reference resolves to nothing,
 *  `forbidden` when it names one of the kernel's own variables and `m` isn't a shipped built-in (`builtin: true`, no
 *  `dir`), a SecretRefused for an explicit reference that resolves to nothing and for any `keychain:` reference. */
export function resolveSecret(m: Manifest, key: string, env: Env = process.env, dir: string | null = null, o: SecretOrigin = {}): string {
  const { ref, layer } = secretSource(m, key, env, dir, o);
  const owned = o.builtin === true && dir === null ? null : kernelSecretRef(ref);
  if (owned) throw new PluginError("forbidden", `the ${m.name} plugin's ${key} names ${owned}`);
  const named = /^env:([A-Za-z_][A-Za-z0-9_]*)$/.exec(ref);
  if (named) {
    const v = env[named[1]!];
    // Blank is unset: a variable of spaces would otherwise reach a provider as its key (and preflight would skip it).
    if (v !== undefined && v.trim() !== "") return v;
    if (layer === "default") throw new PluginError("not_found", `the ${m.name} plugin's ${key} (${ref}) is not set`);
    throw new SecretRefused("not_found", ref, layer, `${whereSet(m, key, layer)} references ${ref}, and ${named[1]} is not set: capcomd uses no other key in its place`,
      `Export ${named[1]} where capcomd runs (the service reads it when it starts: capcomd service restart), or point ${whereSet(m, key, layer)} at a variable that is set.`);
  }
  if (ref.startsWith("keychain:")) throw new SecretRefused("unsupported", ref, layer, `${whereSet(m, key, layer)} references ${ref}: capcomd doesn't resolve keychain references yet`, KEYCHAIN_HINT);
  throw new PluginError("invalid", `${m.name}.${key}: ${JSON.stringify(ref)} is not a secret reference (env:<VAR>)`);
}

/** The same for the kernel's own use of a shipped built-in's provider: undefined only when no reference is set or the
 *  default one resolves to nothing (the provider then does what it does without one); an explicit reference that
 *  doesn't resolve, or a keychain one, is thrown (a SecretRefused), never replaced with another credential. */
export function builtinSecret(m: Manifest, key: string, env: Env = process.env): string | undefined {
  try { return resolveSecret(m, key, env, null, { builtin: true }); } catch (e) {
    if (e instanceof SecretRefused) throw e;
    return undefined;
  }
}

/** A value to redact (src/context/scan.ts): undefined whenever it doesn't resolve, refused or not. */
export function secretOrUndefined(m: Manifest, key: string, env: Env = process.env): string | undefined {
  try { return resolveSecret(m, key, env, null, { builtin: true }); } catch { return undefined; }
}

export interface RefusedSecret { key: string; layer: SecretLayer; ref: string | null; message: string; hint: string }

/** What the kernel refuses of `m`'s secret references `keys` as `env` and the user's config stand (`capcomd plugins
 *  show` and `validate` print them), one per refused key. No value is returned. */
export function refusedSecrets(m: Manifest, keys: string[], env: Env = process.env, dir: string | null = null, o: SecretOrigin = {}): RefusedSecret[] {
  const out: RefusedSecret[] = [];
  for (const key of keys) {
    try { resolveSecret(m, key, env, dir, o); } catch (e) {
      if (e instanceof SecretRefused) out.push({ key, layer: e.layer, ref: e.ref, message: e.message, hint: e.hint ?? "" });
    }
  }
  return out;
}
