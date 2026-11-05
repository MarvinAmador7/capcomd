// A plugin's secrets (docs/spec/plugin-api.md §10.3): a property its config schema marks `"x-secret": true` holds a
// reference, never a value, and the host resolves it for that plugin only. `env:<VAR>` is the daemon's environment
// variable. The reference is the schema's default until config layering (§10.2) lands with the config service; so is
// `keychain:<account>`: the boxd key `capcomd setup` keeps in the OS keychain still reaches the daemon as BOXD_API_KEY
// (src/config/store.ts applyConfig), which is what sandbox-boxd's default reference names.
import { PluginError } from "../../packages/plugin/src/errors";

type Env = Record<string, string | undefined>;
type Schema = { properties?: Record<string, { "x-secret"?: unknown; default?: unknown } | undefined> };
type Manifest = { name: string; config?: unknown };

/** The reference `key` holds, when `key` is a secret `m` declares; a PluginError otherwise. */
export function secretRef(m: Manifest, key: string): string {
  const prop = (m.config as Schema | undefined)?.properties?.[key];
  if (!prop || prop["x-secret"] !== true) throw new PluginError("forbidden", `${key} is not a secret the ${m.name} plugin declares (§10.3)`);
  const ref = (prop.default as { $secret?: unknown } | undefined)?.$secret;
  if (typeof ref !== "string" || !ref) throw new PluginError("not_found", `no reference is set for the ${m.name} plugin's ${key}`);
  return ref;
}

/** `key`'s value for plugin `m`, or a PluginError: `not_found` when the reference resolves to nothing. */
export function resolveSecret(m: Manifest, key: string, env: Env = process.env): string {
  const ref = secretRef(m, key);
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
  try { return resolveSecret(m, key, env); } catch { return undefined; }
}
