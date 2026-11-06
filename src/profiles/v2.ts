// Agent profiles v2 (ADR-024 §2.2, schema capcomd.profile/v2): the manifest a profile package (`<name>/profile.yaml`)
// or a single file (`<name>.yaml`) holds, how one is laid over another (`extends`, an `override.yaml`; §2.3, §2.6),
// and the flat v1 spec it resolves to, which is what an agent is pinned with (./v1.ts AgentSpec). Pure: reading the
// files and the layers is ./load.ts.
import { AGENTS_JSON_SCHEMA, CONTEXT_LIMITS, NAME, validateContext, type AgentSpec } from "./v1";

export const PROFILE_SCHEMA = "capcomd.profile/v2";

/** A manifest as read (YAML or JSON): blocks of plain values. Typed loosely: ./v2.ts checks it, ./v1.ts checks the pin. */
export type ProfileDoc = Record<string, unknown>;

/** Where each field of the flat spec is written in v2 (ADR-024 §6); `description` and `children` keep their names. */
export const V2_PATH: Readonly<Record<keyof AgentSpec, string>> = {
  provider: "harness.provider", auth: "harness.auth", model: "harness.model", effort: "harness.effort",
  description: "description",
  systemPrompt: "prompt.system", appendSystemPrompt: "prompt.append",
  allowedTools: "tools.allowed", disallowedTools: "tools.disallowed", toolMode: "tools.mode",
  sandbox: "sandbox.codex", egress: "sandbox.egress",
  maxTurns: "limits.maxTurns", maxBudgetUsd: "limits.maxBudgetUsd", timeoutMs: "limits.timeoutMs", idleAfterMs: "limits.idleAfterMs",
  stuckRepeats: "limits.stuckRepeats", noChangeAfterMs: "limits.noChangeAfterMs",
  checkpointEveryMs: "lifecycle.checkpointEveryMs",
  children: "children",
  context: "context",
};
/** A flat field's v2 path, for messages (`maxTurns` → `limits.maxTurns`); a name that isn't one is itself. */
export const v2Path = (field: string): string => (V2_PATH as Record<string, string>)[field] ?? field;

const str = { type: "string" }, text = { type: "string", minLength: 1 }, name = { type: "string", pattern: NAME.source };
const names = { type: "array", items: name, uniqueItems: true };
const strings = { type: "array", items: text };
const int = (minimum: number) => ({ type: "integer", minimum });
const v1 = AGENTS_JSON_SCHEMA.$defs.agent.properties;
/** A file next to the manifest, by a relative name (`SOUL.md`, `prompts/review.md`): never absolute, never `..`. */
export const FILE_REF = /^(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9_][A-Za-z0-9._/-]*\.(?:md|txt)$/;
const fileRef = { type: "string", pattern: FILE_REF.source };
export { CONTEXT_LIMITS };
const DAYS = /^[1-9][0-9]*d$/;

/** Each block and its keys. Fields the flat spec has are checked once resolved (./v1.ts validateSpec); the rest here. */
const BLOCKS: Record<string, Record<string, object>> = {
  identity: { title: text, persona: fileRef, avatar: { type: "object", additionalProperties: false, required: ["seed"], properties: { seed: text } } },
  harness: { provider: v1.provider, auth: v1.auth, model: v1.model, effort: v1.effort, cliVersion: { ...text, description: "A version range the environment's agent CLI must satisfy" } },
  prompt: {
    system: { ...str, description: "Replaces the CLI's system prompt; a file name (prompt.md) in a profile directory is read from it" },
    append: { ...str, description: "Appended to the system prompt; a file name (prompt.md) in a profile directory is read from it" },
  },
  tools: {
    mode: v1.toolMode, allowed: v1.allowedTools, disallowed: v1.disallowedTools,
    mcp: { type: "array", items: { type: "object", additionalProperties: false, required: ["name", "command"], properties: { name, command: { ...strings, minItems: 1 }, trust: { enum: ["trusted", "untrusted"] } } } },
  },
  context: {
    providers: { type: "array", items: { type: "object", required: ["name"], properties: { name }, description: "A context provider (context:<name>) and its own settings" } },
    limits: { type: "object", additionalProperties: false, properties: Object.fromEntries(CONTEXT_LIMITS.map((k) => [k, { anyOf: [int(1), { type: "null" }] }])) },
    review: { enum: ["human", "lint"] },
  },
  memory: {
    scope: { enum: ["none", "profile", "project", "user"] }, files: { ...strings, maxItems: 1 }, retain: { type: "string", pattern: DAYS.source },
  },
  sandbox: {
    provider: { ...name, description: "A sandbox plugin's name (capcomd plugins list)" }, environment: name,
    egress: v1.egress, codex: v1.sandbox, size: { type: "object", additionalProperties: false, properties: { vcpu: { enum: [1, 2, 4, 8] } } },
  },
  limits: { maxTurns: v1.maxTurns, maxBudgetUsd: v1.maxBudgetUsd, timeoutMs: v1.timeoutMs, idleAfterMs: v1.idleAfterMs, stuckRepeats: v1.stuckRepeats, noChangeAfterMs: v1.noChangeAfterMs },
  jobs: { foregroundMs: int(0), max: int(1), afterTurnMs: int(1000) },
  lifecycle: { checkpointEveryMs: v1.checkpointEveryMs, onStart: strings, onEnd: strings },
  children: AGENTS_JSON_SCHEMA.$defs.children.properties,
  permissions: { report: { type: "boolean" } },
  sharing: { source: text, license: text },
};
const TOP: Record<string, object> = {
  $schema: str, schema: { const: PROFILE_SCHEMA }, name, version: int(1), extends: name, default: { type: "boolean" },
  description: str, tags: names,
  skills: { type: "array", items: { type: "object", additionalProperties: false, required: ["name"], properties: { name, source: text, hash: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" } } } },
};
/** Keys a profile doesn't pass to one that extends it: who it is, not what it does. */
const OWN = new Set(["$schema", "schema", "name", "extends", "version", "default", "sharing"]);
/** Keys an override.yaml may not set (§2.6: the same schema, no name; it re-parents and re-versions nothing). */
const NOT_IN_OVERRIDE = new Set(["name", "extends", "version", "sharing"]);
const VENDOR = /^x-[a-z0-9][a-z0-9-]*$/;

const orNull = (s: object) => ({ anyOf: [s, { type: "null" }] });
/** JSON Schema (draft 2020-12) for a profile manifest (`profile.yaml`, `<name>.yaml`, `override.yaml`). */
export const PROFILE_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://capcomd.dev/schema/profile-v2.json",
  title: "capcomd agent profile",
  description: "Every block is optional; a resolved profile needs harness.provider and harness.auth. In a profile that extends another, and in an override, null removes an inherited value.",
  type: "object",
  additionalProperties: false,
  patternProperties: { [VENDOR.source]: { description: "A vendor extension a plugin may read" } },
  properties: {
    ...TOP,
    ...Object.fromEntries(Object.entries(BLOCKS).map(([b, props]) => [b, orNull({ type: "object", additionalProperties: false, properties: Object.fromEntries(Object.entries(props).map(([k, s]) => [k, orNull(s)])) })])),
  },
};

const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const has = (o: object, k: string) => Object.hasOwn(o, k);
const isInt = (v: unknown, min: number) => Number.isInteger(v) && (v as number) >= min;
const isStrings = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string" && x.length > 0);
const dupes = (l: string[]) => [...new Set(l.filter((x, i) => l.indexOf(x) !== i))];

/**
 * Check one manifest as written (before `extends` and overrides): its keys, and the values the flat spec has no field
 * for. `as`: a profile (`name` required, equal to the file's) or an override (no `name`, `extends`, `version`,
 * `sharing`). Errors are `<path>: <message>`. The flat fields are checked on the resolved profile instead, where a
 * child's value meets its parent's.
 */
export function checkManifest(raw: unknown, as: "profile" | "override", fileName: string): string[] {
  if (!isMap(raw)) return ["must be a map of blocks (YAML or JSON)"];
  const e: string[] = [];
  const at = (path: string, m: string) => e.push(`${path}: ${m}`);
  for (const [k, v] of Object.entries(raw)) {
    if (!has(TOP, k) && !has(BLOCKS, k) && !VENDOR.test(k)) { at(k, "unknown field (a vendor extension is spelled x-<name>)"); continue; }
    if (as === "override" && NOT_IN_OVERRIDE.has(k)) at(k, "an override.yaml can't set it (it changes the profile it overrides, which keeps its own)");
    if (v === null || !has(BLOCKS, k)) continue;
    if (!isMap(v)) { at(k, "must be a map (or null to remove it)"); continue; }
    for (const sub of Object.keys(v)) if (!has(BLOCKS[k]!, sub)) at(`${k}.${sub}`, "unknown field");
  }
  if (raw.schema !== undefined && raw.schema !== PROFILE_SCHEMA) at("schema", `must be "${PROFILE_SCHEMA}" (this capcomd reads that version)`);
  if (as === "profile") {
    if (raw.name === undefined) at("name", `is required (${fileName})`);
    else if (raw.name !== fileName) at("name", `is ${JSON.stringify(raw.name)}, but the file is the profile ${fileName}'s`);
  }
  if (raw.version !== undefined && !isInt(raw.version, 1)) at("version", "must be an integer >= 1");
  if (raw.extends !== undefined && (typeof raw.extends !== "string" || !NAME.test(raw.extends)))
    at("extends", "must be a profile's name: one of this project's, your own or a bundled one (never another project's, a path or a repository)");
  if (raw.default !== undefined && raw.default !== null && typeof raw.default !== "boolean") at("default", "must be true or false");
  if (raw.description !== undefined && raw.description !== null && typeof raw.description !== "string") at("description", "must be a string");
  if (raw.tags != null) {
    if (!Array.isArray(raw.tags) || raw.tags.some((t) => typeof t !== "string" || !NAME.test(t))) at("tags", "must be a list of lowercase words (a-z, 0-9, - and _)");
    else if (dupes(raw.tags).length) at("tags", `has duplicates (${dupes(raw.tags).join(", ")})`);
  }
  const block = (b: string) => (isMap(raw[b]) ? (raw[b] as Record<string, unknown>) : {});

  const id = block("identity");
  if (id.title != null && (typeof id.title !== "string" || !id.title)) at("identity.title", "must be a non-empty string");
  if (id.persona != null && (typeof id.persona !== "string" || !FILE_REF.test(id.persona))) at("identity.persona", "must name a .md or .txt file next to the manifest (SOUL.md)");
  if (id.avatar != null && !(isMap(id.avatar) && Object.keys(id.avatar).every((k) => k === "seed") && typeof id.avatar.seed === "string" && id.avatar.seed)) at("identity.avatar", "must be { seed: <text> }");
  const h = block("harness");
  if (h.cliVersion != null && (typeof h.cliVersion !== "string" || !h.cliVersion)) at("harness.cliVersion", "must be a non-empty string");

  if (raw.skills != null) {
    if (!Array.isArray(raw.skills)) at("skills", "must be a list of { name, source?, hash? }");
    else {
      raw.skills.forEach((s, i) => {
        const p = `skills[${i}]`;
        if (!isMap(s)) { at(p, "must be { name, source?, hash? }"); return; }
        for (const k of Object.keys(s)) if (!["name", "source", "hash"].includes(k)) at(`${p}.${k}`, "unknown field");
        if (typeof s.name !== "string" || !NAME.test(s.name)) at(`${p}.name`, "must be a skill's name");
        if (s.source !== undefined && (typeof s.source !== "string" || !s.source)) at(`${p}.source`, "must be a non-empty string");
        if (s.hash !== undefined && (typeof s.hash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(s.hash))) at(`${p}.hash`, "must be sha256:<64 hex digits>");
      });
      const n = raw.skills.filter(isMap).map((s) => String(s.name));
      if (dupes(n).length) at("skills", `names ${dupes(n).join(", ")} more than once`);
    }
  }

  const t = block("tools");
  if (t.mcp != null) {
    if (!Array.isArray(t.mcp)) at("tools.mcp", "must be a list of { name, command, trust? }");
    else {
      t.mcp.forEach((m, i) => {
        const p = `tools.mcp[${i}]`;
        if (!isMap(m)) { at(p, "must be { name, command, trust? }"); return; }
        for (const k of Object.keys(m)) if (!["name", "command", "trust"].includes(k)) at(`${p}.${k}`, "unknown field");
        if (typeof m.name !== "string" || !NAME.test(m.name)) at(`${p}.name`, "must be a server name (a-z, 0-9, - and _)");
        if (!isStrings(m.command) || !(m.command as unknown[]).length) at(`${p}.command`, "must be the command and its arguments, as a non-empty list");
        if (m.trust !== undefined && m.trust !== "trusted" && m.trust !== "untrusted") at(`${p}.trust`, `must be "trusted" or "untrusted"`);
      });
      const n = t.mcp.filter(isMap).map((m) => String(m.name));
      if (dupes(n).length) at("tools.mcp", `names ${dupes(n).join(", ")} more than once`);
    }
  }

  if (raw.context != null && raw.memory != null) at("memory", "is the old name of context: set one of them");
  e.push(...checkContext(block("context")), ...checkMemory(block("memory")));

  const sb = block("sandbox");
  if (sb.provider != null && (typeof sb.provider !== "string" || !NAME.test(sb.provider))) at("sandbox.provider", "must be a sandbox plugin's name (docker, boxd, …)");
  if (sb.environment != null && (typeof sb.environment !== "string" || !NAME.test(sb.environment))) at("sandbox.environment", "must be an environment's name (capcomd env build --name)");
  if (sb.size != null && !(isMap(sb.size) && Object.keys(sb.size).every((k) => k === "vcpu") && [1, 2, 4, 8].includes(sb.size.vcpu as number))) at("sandbox.size", "must be { vcpu: 1 | 2 | 4 | 8 }");

  const j = block("jobs");
  for (const [k, min] of [["foregroundMs", 0], ["max", 1], ["afterTurnMs", 1000]] as const) if (j[k] != null && !isInt(j[k], min)) at(`jobs.${k}`, `must be an integer >= ${min}`);
  const l = block("lifecycle");
  for (const k of ["onStart", "onEnd"]) if (l[k] != null && !isStrings(l[k])) at(`lifecycle.${k}`, "must be a list of plugin names");
  const pm = block("permissions");
  if (pm.report != null && typeof pm.report !== "boolean") at("permissions.report", "must be true or false");
  const sh = block("sharing");
  for (const k of ["source", "license"]) if (sh[k] != null && (typeof sh[k] !== "string" || !sh[k])) at(`sharing.${k}`, "must be a non-empty string");
  return e;
}

/** ADR-025 §10: `context.providers` (each a provider's name, the layers it reads and its own settings), `limits`,
 *  `review`: the pinned spec's own check (./v1.ts), so a v2 file and an agents.json entry say the same. Its unknown
 *  keys are the block check's above. */
const checkContext = (c: Record<string, unknown>): string[] => validateContext(Object.fromEntries(Object.entries(c).filter(([k]) => has(BLOCKS.context!, k))));

/** ADR-024's `memory` block, read as `context` (ADR-025 D2): the layers it names must exist. */
function checkMemory(m: Record<string, unknown>): string[] {
  const e: string[] = [];
  if (m.scope != null && !["none", "profile", "project", "user"].includes(m.scope as string)) e.push(`memory.scope: must be none, project, profile or user`);
  else if (m.scope === "profile" || m.scope === "user") e.push(`memory.scope: ${m.scope} memory isn't built (only a project's is: context.providers: [{name: memory}]); use project or none`);
  if (m.files != null && (!isStrings(m.files) || (m.files as string[]).length !== 1 || !FILE_REF.test((m.files as string[])[0]!)))
    e.push("memory.files: must name one index file (MEMORY.md); a memory is the files under .capcomd/context/ it indexes");
  if (m.retain != null && !(typeof m.retain === "string" && DAYS.test(m.retain))) e.push("memory.retain: must be a number of days (30d)");
  return e;
}

/**
 * The manifest with `memory` read as `context` (ADR-025 §4, §10): `scope: project` (or unset) is the built-in memory
 * provider on the project and run layers, `none` is no provider; one `files` entry is that provider's index; `retain`
 * applies to every kind of item; `memory: null` removes an inherited `context`. Call after checkManifest passed.
 */
export function withContext(doc: ProfileDoc): ProfileDoc {
  if (doc.memory === null) { const { memory: _, ...rest } = doc; return rest.context !== undefined ? rest : { ...rest, context: null }; }
  if (!isMap(doc.memory)) return doc;
  const { memory, ...rest } = doc as { memory: Record<string, unknown> } & ProfileDoc;
  const index = Array.isArray(memory.files) ? memory.files[0] : undefined, r = memory.retain;
  const providers = memory.scope === "none" ? [] : [{
    name: "memory", layers: ["project", "run"],
    ...(index !== undefined ? { index } : {}), ...(typeof r === "string" ? { retain: { lesson: r, feedback: r, reference: r } } : {}),
  }];
  return { ...rest, context: { providers } };
}

/** `identity` keys a profile keeps to itself: what the app shows it as (a lead that extends worker isn't "Worker"). */
const OWN_IDENTITY = new Set(["title", "avatar"]);
/**
 * What `base` passes on to a profile that extends it: everything but who it is (name, version, default, sharing, and
 * its title and avatar; its persona is passed on).
 */
export function inheritable(base: ProfileDoc): ProfileDoc {
  const out = Object.fromEntries(Object.entries(base).filter(([k]) => !OWN.has(k)));
  if (isMap(out.identity)) {
    const id = Object.fromEntries(Object.entries(out.identity).filter(([k]) => !OWN_IDENTITY.has(k)));
    if (Object.keys(id).length) out.identity = id; else delete out.identity;
  }
  return out;
}

const dropNulls = (m: Record<string, unknown>) => Object.fromEntries(Object.entries(m).filter(([, v]) => v !== null));

/**
 * `over` laid on `base` (ADR-024 §2.3): scalars and lists replace (a reader sees the whole list where it is written),
 * blocks merge one level, and `null` removes the key (a whole block, or one key in it).
 */
export function layerOver(base: ProfileDoc, over: ProfileDoc): ProfileDoc {
  const out: ProfileDoc = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v === null) { delete out[k]; continue; }
    const b = out[k];
    out[k] = isMap(v) ? dropNulls(isMap(b) ? { ...b, ...v } : v) : v;
  }
  return out;
}

const get = (doc: ProfileDoc, path: string): unknown => {
  const [a, b] = path.split(".") as [string, string?];
  return b === undefined ? doc[a] : isMap(doc[a]) ? (doc[a] as Record<string, unknown>)[b] : undefined;
};

/** The flat spec a resolved manifest pins (ADR-024 §3): the v1 fields, from where v2 writes them. Unchecked. */
export function toFlat(doc: ProfileDoc): AgentSpec {
  const flat: Record<string, unknown> = {};
  for (const [field, path] of Object.entries(V2_PATH)) {
    const v = get(doc, path);
    if (v !== undefined && v !== null) flat[field] = v;
  }
  return flat as unknown as AgentSpec;
}

/** A v1 entry as a v2 manifest (ADR-024 §6), so a v2 profile may extend it and an override may adjust it. */
export function fromFlat(name: string, spec: AgentSpec): ProfileDoc {
  const doc: ProfileDoc = { name };
  for (const [field, v] of Object.entries(spec)) {
    const [a, b] = v2Path(field).split(".") as [string, string?];
    if (b === undefined) doc[a] = v;
    else doc[a] = { ...((doc[a] as Record<string, unknown> | undefined) ?? {}), [b]: v };
  }
  return doc;
}

/** Each block's flat fields, by key: `limits` → { maxTurns: "maxTurns", … }. */
const BLOCK_FIELDS: Record<string, Record<string, string>> = {};
for (const [field, path] of Object.entries(V2_PATH)) {
  const [a, b] = path.split(".") as [string, string?];
  if (b !== undefined) (BLOCK_FIELDS[a] ??= {})[b] = field;
}

/**
 * Overrides (`--set`, `--overrides`, a `;ov=` ref) in the flat spec's fields: the v2 paths (`limits.maxTurns`,
 * `tools.mode`) and the v1 names (`maxTurns`, kept as aliases, ADR-024 §2.3) both work; `sandbox` is the v1 Codex
 * level unless it is a block. A path with no flat field is kept as written, so validation names it.
 */
export function flatOverrides(set: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(set)) {
    const fields = has(BLOCK_FIELDS, k) ? BLOCK_FIELDS[k] : undefined;
    if (!fields || (k === "sandbox" && !isMap(v)) || !(isMap(v) || v === null)) { out[k] = v; continue; }
    if (v === null) { for (const f of Object.values(fields)) out[f] = null; continue; }
    for (const [sub, x] of Object.entries(v)) out[has(fields, sub) ? fields[sub]! : `${k}.${sub}`] = x;
  }
  return out;
}

/** The v2 paths `--set` takes a comma list for. */
export const LIST_PATHS = ["sandbox.egress", "tools.allowed", "tools.disallowed"];

/**
 * What a resolved manifest sets that this capcomd reads but doesn't apply yet (ADR-024 §7 steps 5 and 8; ADR-025
 * §13; spec §16.2), so `validate` can say so instead of the setting silently doing nothing.
 */
export function notApplied(doc: ProfileDoc): string[] {
  const set = (path: string) => { const v = get(doc, path); return v !== undefined && v !== null && !(Array.isArray(v) && !v.length); };
  return ["identity.persona", "harness.cliVersion", "skills", "tools.mcp", "sandbox.provider", "sandbox.environment", "sandbox.size", "jobs", "lifecycle.onStart", "lifecycle.onEnd"].filter(set);
}
