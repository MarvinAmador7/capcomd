// A plugin's config (spec §10): its schema (inline or a `$ref` beside the manifest), the defaults, the layers merged
// over them with JSON merge-patch semantics (§10.2), the `x-secret` properties that take references (§10.3), the
// `x-per-run` ones a run may override, and validation against the schema, naming the layer that broke it (§10.4).
// Pure: the kernel reads the layers' files (src/plugins/host.ts `configured`) and hands them over.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { PluginManifest } from "./manifest";

export type ConfigLayerName = "user" | "project" | "env" | "run";
/** One layer's `plugins.<name>` object (§10.2), without the reserved `enabled` key. */
export interface ConfigLayer { layer: ConfigLayerName; values: Record<string, unknown> }
export type ConfigSource = "default" | ConfigLayerName;
export type ConfigIssue = { path: string; message: string };

type Prop = { default?: unknown; "x-secret"?: unknown; "x-per-run"?: unknown };
type ObjectSchema = { type?: unknown; properties?: Record<string, Prop>; required?: unknown; [k: string]: unknown };

/** The manifest's config schema, its `$ref` read from the plugin's directory (null when it can't be). */
export function configSchema(m: PluginManifest, dir: string | null): ObjectSchema | null {
  let schema: unknown = m.config;
  if (schema && typeof schema === "object" && "$ref" in schema) {
    if (!dir) return null;
    try { schema = JSON.parse(readFileSync(join(dir, String((schema as { $ref: string }).$ref)), "utf8")); } catch { return null; }
  }
  return schema && typeof schema === "object" && !Array.isArray(schema) ? schema as ObjectSchema : null;
}

const props = (s: ObjectSchema | null): Record<string, Prop> => (s?.properties && typeof s.properties === "object" ? s.properties : {});

/** `plugins.<name>` defaults from the config schema (§10.1): top-level `properties.*.default`, secrets left out. */
export function configDefaults(m: PluginManifest, dir: string | null): Record<string, unknown> {
  return Object.fromEntries(Object.entries(props(configSchema(m, dir))).filter(([, p]) => p && "default" in p && p["x-secret"] !== true).map(([k, p]) => [k, structuredClone(p.default)]));
}

/** The `x-secret` properties of a plugin's config schema (§10.3). */
export function secretKeys(m: PluginManifest, dir: string | null): string[] {
  return Object.entries(props(configSchema(m, dir))).filter(([, p]) => p?.["x-secret"] === true).map(([k]) => k);
}

/** The `x-per-run` properties: what a run may override (§10.2 layer 5). */
export function perRunKeys(m: PluginManifest, dir: string | null): string[] {
  return Object.entries(props(configSchema(m, dir))).filter(([, p]) => p?.["x-per-run"] === true && p["x-secret"] !== true).map(([k]) => k);
}

/** JSON merge-patch (§10.2): objects merge key by key, arrays and values replace, null deletes. */
export function mergePatch(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else if (isObject(v) && isObject(out[k])) out[k] = mergePatch(out[k] as Record<string, unknown>, v);
    else out[k] = v;
  }
  return out;
}
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** A secret reference (§10.3): `{"$secret": "env:<VAR>"}` or `{"$secret": "keychain:<account>"}`. */
export const SECRET_REF = /^(env:[A-Za-z_][A-Za-z0-9_]*|keychain:[A-Za-z0-9._@-]{1,128})$/;
export const secretRefOf = (v: unknown): string | null => {
  if (!isObject(v) || Object.keys(v).length !== 1 || typeof v.$secret !== "string") return null;
  return SECRET_REF.test(v.$secret) ? v.$secret : null;
};

/** The schema with its secret properties left out: what the non-secret values are checked against. */
function withoutSecrets(s: ObjectSchema, secrets: string[]): ObjectSchema {
  if (!secrets.length) return s;
  const properties = Object.fromEntries(Object.entries(props(s)).filter(([k]) => !secrets.includes(k)));
  const required = Array.isArray(s.required) ? s.required.filter((k) => !secrets.includes(String(k))) : s.required;
  return { ...s, properties, ...(required !== undefined ? { required } : {}) };
}

/** `value`'s issues against a JSON Schema (zod reads it, as the MCP server reads a tool's): [] when it fits. */
export function schemaIssues(schema: unknown, value: unknown, prefix = ""): ConfigIssue[] {
  let check: z.ZodType;
  try { check = z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]); } catch (e) {
    return [{ path: prefix || "(schema)", message: `the plugin's config schema can't be read: ${(e as Error).message}` }];
  }
  const r = check.safeParse(value);
  if (r.success) return [];
  return r.error.issues.map((i) => ({ path: [prefix, ...i.path.map(String)].filter(Boolean).join(".") || "(root)", message: i.message }));
}

export type LayeredConfig =
  | { ok: true; values: Record<string, unknown>; sources: Record<string, ConfigSource> }
  | { ok: false; layer: ConfigLayerName; errors: ConfigIssue[] };

/**
 * Layers 1-4 of §10.2 over the schema's defaults, in order, later winning key by key; a secret property holds a
 * reference (§10.3) and stays out of `values` (the kernel resolves it for the plugin alone); a project may not set one
 * (a repository must not point a plugin at another of the daemon's variables). The merge is checked against the schema
 * after each layer, so an invalid one is named (§10.4): the first layer after which the values don't fit.
 */
export function layerConfig(m: PluginManifest, dir: string | null, layers: ConfigLayer[]): LayeredConfig {
  const schema = configSchema(m, dir);
  if (!schema) return layers.some((l) => Object.keys(l.values).length) ? { ok: false, layer: layers[0]!.layer, errors: [{ path: "(schema)", message: "the plugin's config schema can't be read" }] } : { ok: true, values: {}, sources: {} };
  const secrets = secretKeys(m, dir);
  const plain = withoutSecrets(schema, secrets);
  let values = configDefaults(m, dir);
  const sources: Record<string, ConfigSource> = Object.fromEntries(Object.keys(values).map((k) => [k, "default" as const]));
  for (const l of layers) {
    const errors: ConfigIssue[] = [];
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(l.values)) {
      if (!secrets.includes(k)) { patch[k] = v; continue; }
      if (l.layer === "project" || l.layer === "run") errors.push({ path: k, message: `${k} is a secret: only your own config (or CAPCOMD_PLUGIN_*) may set its reference (§10.3)` });
      else if (v !== null && !secretRefOf(v)) errors.push({ path: k, message: `${k} is a secret: give a reference, {"$secret": "env:<VAR>"} or {"$secret": "keychain:<account>"}, never the value (§10.3)` });
    }
    if (errors.length) return { ok: false, layer: l.layer, errors };
    if (!Object.keys(patch).length) continue;
    values = mergePatch(values, patch);
    for (const k of Object.keys(patch)) { if (k in values) sources[k] = l.layer; else delete sources[k]; }
    const issues = schemaIssues(plain, values);
    if (issues.length) return { ok: false, layer: l.layer, errors: issues };
  }
  return { ok: true, values, sources };
}

/**
 * A run's overrides for one plugin (§10.2 layer 5): only `x-per-run` properties, each checked against its own schema.
 * Issues' paths are under the property (`key.sub`).
 */
export function runConfigIssues(m: PluginManifest, dir: string | null, values: unknown): ConfigIssue[] {
  if (!isObject(values)) return [{ path: "(root)", message: "a run's plugin config is an object of the plugin's x-per-run settings" }];
  const schema = configSchema(m, dir);
  const per = perRunKeys(m, dir);
  const issues: ConfigIssue[] = [];
  for (const [k, v] of Object.entries(values)) {
    if (v === null && per.includes(k)) continue; // null: the plugin's own config for this run (merge-patch's delete)
    if (!per.includes(k)) { issues.push({ path: k, message: per.length ? `${k} can't be set per run (the ${m.name} plugin's per-run settings: ${per.join(", ")})` : `the ${m.name} plugin has no setting a run may override` }); continue; }
    issues.push(...schemaIssues(props(schema)[k], v, k));
  }
  return issues;
}
