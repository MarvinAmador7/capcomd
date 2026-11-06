// A plugin's config, layered (docs/spec/plugin-api.md §10.2): its schema's defaults, then `plugins.<name>` in the user's
// ~/.capcomd/config.json, then in the project's .capcomd/config.json (the daemon's, found from where it runs), then the
// environment, CAPCOMD_PLUGIN_<NAME>_<KEY> (name and key upper-cased, `-` and `.` as `_`; a value that reads as JSON is
// that value, else a string, and it replaces the key's value). The files' objects merge key by key, `null` deletes.
// `enabled` is reserved at every layer: false keeps the plugin at `validated` (§5.4), true turns on a built-in that is
// off until asked for (the watchdog, which `capcomd setup` turns on). A project's `enabled` counts only for a plugin of
// that project, and only to turn it off: a repository can't switch off a gate the operator runs, nor on what they turned
// off. Each layer is checked against the schema (the subset manifests use: types, bounds, enums, required,
// additionalProperties); an error fails the plugin `config_invalid` (§10.4) rather than run it with defaults, except in
// a project's layer for a plugin not the project's: that layer is set aside (reported, left out), or breaking its value
// would switch the plugin off just the same. A secret
// property (`x-secret`) holds a reference (§10.3), never a value: the user's or the environment's (src/plugins/secrets.ts
// reads it); a project may not set one (it could point a plugin at another of the daemon's variables). It is never in
// the config. CAPCOMD_NO_CONFIG (tests) skips the files, not the environment.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { projectConfigPath, readConfig, userConfigPath } from "../config/store";

type Env = Record<string, string | undefined>;
type Json = unknown;
export type ConfigLayer = "user" | "project" | "env";
/** `setAside`: a project's settings for a plugin that isn't the project's, refused and left out; the plugin runs on its
 *  other layers (a repository can't switch off the operator's plugins by breaking their config). */
export interface ConfigIssue { path: string; message: string; layer: ConfigLayer; setAside?: true }
export interface PluginSettings {
  /** `plugins.<name>.enabled` from the last layer that set it; undefined when none did. */
  enabled?: boolean;
  /** The layers over the schema's defaults (the host adds the defaults). */
  config: Record<string, unknown>;
  /** What the schema refused, each with the layer that set it. */
  errors: ConfigIssue[];
  /** The last layer that set each top-level key of `config`. */
  sources: Record<string, ConfigLayer>;
}

/** A secret reference (§10.3): `{"$secret": "env:<VAR>"}` or `{"$secret": "keychain:<account>"}`. */
export const SECRET_REF = /^(env:[A-Za-z_][A-Za-z0-9_]*|keychain:[A-Za-z0-9._@-]{1,128})$/;
export const secretRefOf = (v: unknown): string | null =>
  isObject(v) && Object.keys(v).length === 1 && typeof v.$secret === "string" && SECRET_REF.test(v.$secret) ? v.$secret : null;

type Schema = {
  type?: string | string[]; properties?: Record<string, Schema>; additionalProperties?: boolean | Schema; required?: string[];
  enum?: Json[]; minimum?: number; maximum?: number; exclusiveMinimum?: number; exclusiveMaximum?: number; minLength?: number; maxLength?: number;
  items?: Schema; "x-secret"?: boolean; $ref?: string;
};

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** JSON merge-patch (RFC 7396): objects merge recursively, anything else replaces, `null` deletes. */
export function mergePatch(target: unknown, patch: unknown): unknown {
  if (!isObject(patch)) return patch;
  const out: Record<string, unknown> = isObject(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = mergePatch(out[k], v);
  }
  return out;
}

/** What a layer sets, without its deletions (a null in an object only removes what a layer below set). */
const withoutNulls = (v: unknown): unknown => isObject(v) ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null).map(([k, x]) => [k, withoutNulls(x)])) : v;

/** The environment's name for a plugin's key: CAPCOMD_PLUGIN_<NAME>_<KEY>. */
export const envName = (plugin: string, key: string) => `CAPCOMD_PLUGIN_${plugin}_${key}`.toUpperCase().replace(/[-.]/g, "_");

/** The manifest's config schema (a `$ref` read from the plugin's directory). */
export function schemaOf(m: { config?: unknown }, dir: string | null): Schema | null {
  let s = m.config as Schema | undefined;
  if (s && typeof s.$ref === "string") {
    if (!dir) return null;
    try { s = JSON.parse(readFileSync(join(dir, s.$ref), "utf8")) as Schema; } catch { return null; }
  }
  return isObject(s) ? s : null;
}

/** The environment layer: the schema's top-level keys (and `enabled`) that have a variable. */
function envLayer(name: string, schema: Schema | null, env: Env): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ["enabled", ...Object.keys(schema?.properties ?? {})]) {
    const raw = env[envName(name, key)];
    if (raw === undefined || raw === "") continue;
    try { out[key] = JSON.parse(raw); } catch { out[key] = raw; }
  }
  return out;
}

function typeOk(t: string, v: unknown): boolean {
  switch (t) {
    case "object": return isObject(v);
    case "array": return Array.isArray(v);
    case "string": return typeof v === "string";
    case "boolean": return typeof v === "boolean";
    case "integer": return typeof v === "number" && Number.isInteger(v);
    case "number": return typeof v === "number" && Number.isFinite(v);
    case "null": return v === null;
    default: return true;
  }
}

/** What `v` breaks of `s` (the subset of JSON Schema plugin manifests use), as `path: message`. */
export function checkSchema(s: Schema, v: unknown, path = ""): Array<{ path: string; message: string }> {
  const out: Array<{ path: string; message: string }> = [];
  const at = path || "(config)";
  const types = s.type === undefined ? [] : Array.isArray(s.type) ? s.type : [s.type];
  if (types.length && !types.some((t) => typeOk(t, v))) return [{ path: at, message: `must be ${types.join(" or ")}` }];
  if (s.enum && !s.enum.some((e) => JSON.stringify(e) === JSON.stringify(v))) out.push({ path: at, message: `must be one of ${s.enum.map((e) => JSON.stringify(e)).join(", ")}` });
  if (typeof v === "number") {
    if (s.minimum !== undefined && v < s.minimum) out.push({ path: at, message: `must be at least ${s.minimum}` });
    if (s.maximum !== undefined && v > s.maximum) out.push({ path: at, message: `must be at most ${s.maximum}` });
    if (s.exclusiveMinimum !== undefined && v <= s.exclusiveMinimum) out.push({ path: at, message: `must be more than ${s.exclusiveMinimum}` });
    if (s.exclusiveMaximum !== undefined && v >= s.exclusiveMaximum) out.push({ path: at, message: `must be less than ${s.exclusiveMaximum}` });
  }
  if (typeof v === "string") {
    if (s.minLength !== undefined && v.length < s.minLength) out.push({ path: at, message: `must be at least ${s.minLength} characters` });
    if (s.maxLength !== undefined && v.length > s.maxLength) out.push({ path: at, message: `must be at most ${s.maxLength} characters` });
  }
  if (Array.isArray(v) && s.items) v.forEach((x, i) => out.push(...checkSchema(s.items!, x, `${path}[${i}]`)));
  if (isObject(v)) {
    for (const r of s.required ?? []) if (!(r in v)) out.push({ path: path ? `${path}.${r}` : r, message: "is required" });
    for (const [k, x] of Object.entries(v)) {
      const p = path ? `${path}.${k}` : k;
      const prop = s.properties?.[k];
      if (prop) out.push(...checkSchema(prop, x, p));
      else if (s.additionalProperties === false) out.push({ path: p, message: "is not a setting of this plugin" });
      else if (isObject(s.additionalProperties)) out.push(...checkSchema(s.additionalProperties, x, p));
    }
  }
  return out;
}

/** The layers of plugin `m`'s config (§10.2), checked against its schema. */
/** The two config files' `plugins` (none under CAPCOMD_NO_CONFIG), read once for every plugin of a process. */
export function pluginConfigFiles(o: { env?: Env; cwd?: string } = {}): Record<"user" | "project", Record<string, unknown>> {
  const env = o.env ?? process.env;
  if (env.CAPCOMD_NO_CONFIG) return { user: {}, project: {} };
  return { user: readConfig(userConfigPath(env)).plugins ?? {}, project: readConfig(projectConfigPath(o.cwd ?? process.cwd(), env)).plugins ?? {} };
}

export function pluginSettings(m: { name: string; config?: unknown }, o: { dir?: string | null; env?: Env; cwd?: string; files?: ReturnType<typeof pluginConfigFiles>; source?: "builtin" | "user" | "project" } = {}): PluginSettings {
  const env = o.env ?? process.env;
  const schema = schemaOf(m, o.dir ?? null);
  const secret = new Set(Object.entries(schema?.properties ?? {}).filter(([, p]) => p?.["x-secret"] === true).map(([k]) => k));
  const files = o.files ?? pluginConfigFiles({ env, ...(o.cwd ? { cwd: o.cwd } : {}) });
  const layers: Array<[ConfigLayer, unknown]> = [["user", files.user[m.name]], ["project", files.project[m.name]], ["env", envLayer(m.name, schema, env)]];
  const errors: ConfigIssue[] = [];
  let config: Record<string, unknown> = {};
  const sources: Record<string, ConfigLayer> = {};
  let enabled: boolean | undefined;
  const foreign = o.source !== "project";
  for (const [layer, raw] of layers) {
    if (raw === undefined) continue;
    const before = errors.length;
    const setAside = () => { for (const e of errors.slice(before)) e.setAside = true; };
    if (!isObject(raw)) { errors.push({ path: m.name, message: "must be an object of the plugin's settings", layer }); if (layer === "project" && foreign) setAside(); continue; }
    const { enabled: on, ...rest } = raw;
    if (on !== undefined) {
      if (typeof on !== "boolean") errors.push({ path: "enabled", message: "must be true or false", layer });
      else if (layer !== "project") enabled = on;
      else if (!on && o.source === "project" && enabled === undefined) enabled = false;
    }
    for (const k of Object.keys(rest)) {
      if (!secret.has(k)) continue;
      if (layer === "project") errors.push({ path: k, message: "is a secret: only your own config (or CAPCOMD_PLUGIN_*) may set its reference", layer });
      else if (rest[k] !== null && !secretRefOf(rest[k])) errors.push({ path: k, message: 'is a secret: give a reference, {"$secret": "env:<VAR>"}, never the value', layer });
      delete rest[k];
    }
    // Each layer on its own, so an error names where it came from; a null only deletes what a layer below set.
    if (schema) for (const e of checkSchema({ ...schema, required: [] }, withoutNulls(rest))) errors.push({ ...e, layer });
    if (layer === "project" && foreign && errors.length > before) { setAside(); continue; }
    // A variable is the whole value of its key (CAPCOMD_PLUGIN_X_SCHEDULES='{}': none), not a patch of it.
    if (layer === "env") for (const [k, v] of Object.entries(rest)) { if (v === null) delete config[k]; else config[k] = v; }
    else config = mergePatch(config, rest) as Record<string, unknown>;
    for (const k of Object.keys(rest)) { if (k in config) sources[k] = layer; else delete sources[k]; }
  }
  return { ...(enabled === undefined ? {} : { enabled }), config, errors, sources };
}
