// ADR-026 §7: typed payloads. A schema is registered once under `name@version` and never changes (a new shape is a new
// version); every payload written under it is checked against it first, and a payload that doesn't fit is refused with
// what to fix, field by field (Vercel Board's model). Schemas use a small JSON Schema subset, bounded so that a
// schema and every payload it admits stay small:
//   - type: object, string, number, integer, boolean or array (one type: no unions, no null);
//   - object: `properties` (at most MAX_PROPERTIES) and `required`; an object is closed: a field it doesn't name is refused;
//   - string: `maxLength` (required, at most MAX_STRING), `minLength`, `enum`;
//   - number and integer: `minimum`, `maximum`, `enum`;
//   - array: `items` (one schema) and `maxItems` (required, at most MAX_ITEMS), `minItems`;
//   - `description` anywhere. Nothing else ($ref, anyOf, patterns, formats): registration refuses it.
// A schema nests at most MAX_DEPTH levels and a payload is at most PAYLOAD_MAX_BYTES of JSON.

export const MAX_DEPTH = 4;
export const MAX_PROPERTIES = 24;
export const MAX_ENUM = 24;
export const MAX_STRING = 4000;
export const MAX_ITEMS = 100;
export const SCHEMA_MAX_BYTES = 16 * 1024;
export const PAYLOAD_MAX_BYTES = 8 * 1024;
/** `name@version`: a lowercase name and a positive version. */
export const SCHEMA_ID = /^([a-z][a-z0-9-]{0,39})@([1-9][0-9]{0,3})$/;

export type JsonType = "object" | "string" | "number" | "integer" | "boolean" | "array";
export interface JsonSchema {
  type: JsonType;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: Array<string | number>;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
}

export interface RegisteredSchema { id: string; name: string; version: number; description: string; schema: JsonSchema }

export class SchemaError extends Error {}

const KEYS: Record<JsonType, string[]> = {
  object: ["properties", "required"],
  string: ["maxLength", "minLength", "enum"],
  number: ["minimum", "maximum", "enum"],
  integer: ["minimum", "maximum", "enum"],
  boolean: [],
  array: ["items", "maxItems", "minItems"],
};
const isCount = (x: unknown, max: number) => Number.isInteger(x) && (x as number) >= 0 && (x as number) <= max;

/** Why `s` isn't a schema of the subset (the first problem found), or null when it is. `at` names where, for the message. */
export function schemaProblem(s: unknown, at = "the schema", depth = 1): string | null {
  if (!s || typeof s !== "object" || Array.isArray(s)) return `${at} is not an object`;
  const o = s as Record<string, unknown>;
  const type = o.type as JsonType;
  if (typeof type !== "string" || !(type in KEYS)) return `${at}: type must be one of ${Object.keys(KEYS).join(", ")}`;
  for (const k of Object.keys(o)) if (k !== "type" && k !== "description" && !KEYS[type].includes(k)) return `${at}: "${k}" is not allowed on a ${type} (allowed: ${["description", ...KEYS[type]].join(", ")})`;
  if (o.description !== undefined && (typeof o.description !== "string" || o.description.length > 500)) return `${at}: description must be a string of at most 500 characters`;
  if (o.enum !== undefined) {
    const want = type === "string" ? "string" : "number";
    if (!Array.isArray(o.enum) || !o.enum.length || o.enum.length > MAX_ENUM || o.enum.some((v) => typeof v !== want)) return `${at}: enum must list 1 to ${MAX_ENUM} ${want}s`;
  }
  if (type === "string") {
    if (o.enum === undefined && !isCount(o.maxLength, MAX_STRING)) return `${at}: a string needs maxLength (at most ${MAX_STRING})`;
    if (o.maxLength !== undefined && !isCount(o.maxLength, MAX_STRING)) return `${at}: maxLength must be at most ${MAX_STRING}`;
    if (o.minLength !== undefined && (!isCount(o.minLength, MAX_STRING) || (o.maxLength !== undefined && (o.minLength as number) > (o.maxLength as number)))) return `${at}: minLength must be at most maxLength`;
  }
  if (type === "number" || type === "integer") {
    for (const k of ["minimum", "maximum"]) if (o[k] !== undefined && !Number.isFinite(o[k])) return `${at}: ${k} must be a number`;
  }
  if (type === "array") {
    if (!isCount(o.maxItems, MAX_ITEMS)) return `${at}: an array needs maxItems (at most ${MAX_ITEMS})`;
    if (o.minItems !== undefined && (!isCount(o.minItems, MAX_ITEMS) || (o.minItems as number) > (o.maxItems as number))) return `${at}: minItems must be at most maxItems`;
    if (depth >= MAX_DEPTH) return `${at}: nested more than ${MAX_DEPTH} levels`;
    return schemaProblem(o.items, `${at}.items`, depth + 1);
  }
  if (type === "object") {
    const props = o.properties;
    if (!props || typeof props !== "object" || Array.isArray(props)) return `${at}: an object needs properties`;
    const names = Object.keys(props);
    if (!names.length || names.length > MAX_PROPERTIES) return `${at}: an object has 1 to ${MAX_PROPERTIES} properties`;
    if (o.required !== undefined && (!Array.isArray(o.required) || o.required.some((r) => typeof r !== "string" || !names.includes(r)))) return `${at}: required must name its properties`;
    if (depth >= MAX_DEPTH) return `${at}: nested more than ${MAX_DEPTH} levels`;
    for (const n of names) {
      if (!/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(n)) return `${at}: "${n}" is not a property name (letters, digits, _)`;
      const p = schemaProblem((props as Record<string, unknown>)[n], `${at}.${n}`, depth + 1);
      if (p) return p;
    }
  }
  return null;
}

const registry = new Map<string, RegisteredSchema>();
/** A schema's identity: its JSON with keys in order (so the same shape written in another order is the same schema). */
const canonical = (x: unknown): string =>
  Array.isArray(x) ? `[${x.map(canonical).join(",")}]`
    : x && typeof x === "object" ? `{${Object.keys(x).sort().map((k) => `${JSON.stringify(k)}:${canonical((x as any)[k])}`).join(",")}}`
    : JSON.stringify(x);
const freeze = <T>(x: T): T => { if (x && typeof x === "object") { for (const v of Object.values(x)) freeze(v); Object.freeze(x); } return x; };

/**
 * Register `id` (`name@version`). Immutable: registering it again with the same schema does nothing, with another one
 * throws (a changed shape is a new version). A schema outside the subset throws, saying what is wrong.
 */
export function registerSchema(id: string, schema: JsonSchema, description = ""): RegisteredSchema {
  const m = SCHEMA_ID.exec(id);
  if (!m) throw new SchemaError(`"${id}" is not a schema id: name@version, e.g. handback@1`);
  const problem = schemaProblem(schema);
  if (problem) throw new SchemaError(`${id}: ${problem}`);
  if (schema.type !== "object") throw new SchemaError(`${id}: a payload schema is an object`);
  if (Buffer.byteLength(JSON.stringify(schema)) > SCHEMA_MAX_BYTES) throw new SchemaError(`${id}: the schema is over ${SCHEMA_MAX_BYTES} bytes`);
  const prev = registry.get(id);
  if (prev) {
    if (canonical(prev.schema) === canonical(schema)) return prev;
    throw new SchemaError(`${id} is already registered with another shape: a registered schema never changes; register ${m[1]}@${Number(m[2]) + 1} instead`);
  }
  const r = freeze({ id, name: m[1]!, version: Number(m[2]), description, schema: structuredClone(schema) });
  registry.set(id, r);
  return r;
}

export function getSchema(id: string): RegisteredSchema | null { return registry.get(id) ?? null; }
export function listSchemas(): RegisteredSchema[] { return [...registry.values()].sort((a, b) => a.id.localeCompare(b.id)); }

/** Where a value is, as a model reads it: `changed[0].path`. */
const join = (at: string, k: string | number) => (typeof k === "number" ? `${at}[${k}]` : at ? `${at}.${k}` : k);
const kindOf = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "an array" : typeof v === "object" ? "an object" : `a ${typeof v}`);

/** Every problem with `v` against `s`, each as "where: what", in the payload's order (at most 20). */
export function validate(s: JsonSchema, v: unknown, at = "", out: string[] = []): string[] {
  if (out.length >= 20) return out;
  const where = at || "the payload";
  const t = s.type;
  const typeOk = t === "array" ? Array.isArray(v) : t === "object" ? !!v && typeof v === "object" && !Array.isArray(v)
    : t === "integer" ? Number.isInteger(v) : t === "number" ? typeof v === "number" && Number.isFinite(v) : typeof v === t;
  if (!typeOk) { out.push(`${where}: must be ${t === "integer" ? "an integer" : t === "array" || t === "object" ? `an ${t}` : `a ${t}`}, not ${kindOf(v)}`); return out; }
  if (s.enum && !s.enum.includes(v as string | number)) { out.push(`${where}: must be one of ${s.enum.map((e) => JSON.stringify(e)).join(", ")}`); return out; }
  if (t === "string") {
    const n = [...(v as string)].length;
    if (s.minLength !== undefined && n < s.minLength) out.push(`${where}: ${s.minLength === 1 ? "must not be empty" : `must be at least ${s.minLength} characters`}`);
    if (s.maxLength !== undefined && n > s.maxLength) out.push(`${where}: at most ${s.maxLength} characters (it has ${n})`);
  } else if (t === "number" || t === "integer") {
    if (s.minimum !== undefined && (v as number) < s.minimum) out.push(`${where}: at least ${s.minimum}`);
    if (s.maximum !== undefined && (v as number) > s.maximum) out.push(`${where}: at most ${s.maximum}`);
  } else if (t === "array") {
    const a = v as unknown[];
    if (s.minItems !== undefined && a.length < s.minItems) out.push(`${where}: at least ${s.minItems} ${s.minItems === 1 ? "item" : "items"}`);
    if (s.maxItems !== undefined && a.length > s.maxItems) out.push(`${where}: at most ${s.maxItems} items (it has ${a.length})`);
    else a.forEach((x, i) => validate(s.items!, x, join(at, i), out));
  } else if (t === "object") {
    const o = v as Record<string, unknown>, props = s.properties ?? {};
    for (const k of Object.keys(o)) if (!(k in props)) out.push(`${join(at, k)}: not a field here (fields: ${Object.keys(props).join(", ")})`);
    for (const r of s.required ?? []) if (o[r] === undefined) out.push(`${join(at, r)}: required`);
    for (const [k, p] of Object.entries(props)) if (o[k] !== undefined) validate(p, o[k], join(at, k), out);
  }
  return out.slice(0, 20);
}

export type Checked = { ok: true; schema: string; value: Record<string, unknown> } | { ok: false; schema: string; errors: string[] };

/** Check a payload written under `id`: an unknown schema, a payload over PAYLOAD_MAX_BYTES and every field that doesn't fit are errors. */
export function checkPayload(id: string, value: unknown): Checked {
  const r = registry.get(id);
  if (!r) return { ok: false, schema: id, errors: [`${id} is not a registered schema (registered: ${listSchemas().map((x) => x.id).join(", ") || "none"})`] };
  let bytes = 0;
  try { bytes = Buffer.byteLength(JSON.stringify(value) ?? ""); } catch { return { ok: false, schema: id, errors: ["the payload is not JSON"] }; }
  if (bytes > PAYLOAD_MAX_BYTES) return { ok: false, schema: id, errors: [`the payload is ${bytes} bytes; at most ${PAYLOAD_MAX_BYTES}: say less`] };
  const errors = validate(r.schema, value);
  return errors.length ? { ok: false, schema: id, errors } : { ok: true, schema: id, value: value as Record<string, unknown> };
}
