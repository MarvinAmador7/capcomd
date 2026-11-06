// Writing profiles (ADR-024 §2.4, §5, §7 step 6): `capcomd profiles add|set|rm` and PUT /v1/profiles/{name}. A write
// changes the one file a profile is defined in (its profile.yaml, <name>.yaml or agents.json entry), never an ancestor
// it extends or an override.yaml laid over it, and bumps that file's `version` (an agents.json entry has none: it stays
// 1). Every write is checked as the files would be after it (readProfiles through an overlay): one that would leave any
// profile unreadable, or that a later file would hide, changes nothing. A YAML file keeps its comments and layout.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { isMap as isYamlMap, isScalar, parseDocument, stringify as toYaml, type Document } from "yaml";
import { agentsFilePath, agentsFileText, BUNDLED_PROFILES, profileLayers, readProfiles, writeAtomic, type ProfileOverlay, type ProfileSet, type ResolvedProfile } from "./load";
import { compareValuePaths, profileValues } from "./describe";
import { AGENTS_SCHEMA, AgentConfigError, NAME, type AgentsFile } from "./v1";
import { PROFILE_JSON_SCHEMA, PROFILE_SCHEMA, V2_PATH, type ProfileDoc } from "./v2";

type Env = Record<string, string | undefined>;

/** Why a write was refused: not_found (no such profile), conflict (`rev` is stale, or `add` of a name that exists),
 *  invalid (a field or value, or the profiles it would leave), read_only (a file capcomd doesn't edit). */
export type ProfileWriteProblem = "not_found" | "conflict" | "invalid" | "read_only";
export class ProfileWriteError extends Error {
  constructor(readonly code: ProfileWriteProblem, message: string, readonly field?: string) { super(message); this.name = "ProfileWriteError"; }
}

/**
 * What a write sets, by v2 path (`limits.maxTurns`, `tags`, or a whole block: `children`) or v1 name (`maxTurns`, kept
 * as an alias as `--set` does): the new value, or null to remove it from the profile's own file (an inherited value
 * then shows again).
 */
export type ProfileEdit = Record<string, unknown>;
/** One value that changed, by v2 path, as `capcomd profiles show` lists values (undefined: unset). */
export interface ProfileChange { path: string; from: unknown; to: unknown }
export interface ProfileWrite {
  name: string;
  /** The file written (or that would have been). */
  file: string;
  format: "v1" | "v2";
  changed: boolean;
  version: number;
  previousVersion: number;
  /** Every profile before and after the write (the same set when nothing changed). */
  before: ProfileSet;
  after: ProfileSet;
  changes: ProfileChange[];
}
export interface WriteOptions {
  /** The agents file the profiles are read with (agentsFilePath()). */
  path?: string;
  source?: Env;
  /** The profile's `rev` the change was made from (profileRev): a write over a profile that changed since is a conflict. */
  rev?: string;
}

/** What the files laid together make of a profile, as a short hash: it changes with any of them, hand edits included. */
export function profileRev(p: ResolvedProfile): string {
  return createHash("sha256").update(JSON.stringify([p.version, p.applied, p.manifest, p.setBy])).digest("hex").slice(0, 16);
}

/** Set by capcomd, never by a write: who the profile is, its version (bumped), where an installed one came from (ADR-024 §2.5). */
const NOT_WRITTEN = new Set(["$schema", "schema", "name", "version", "sharing"]);
const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** An edit's keys as v2 paths: `maxTurns` → `limits.maxTurns`, `sandbox: "read-only"` → `sandbox.codex` (a map is the block). */
export function editPaths(edit: ProfileEdit): Array<[string[], unknown]> {
  return Object.entries(edit).map(([k, v]): [string[], unknown] => {
    const alias = Object.hasOwn(V2_PATH, k) && !(k === "sandbox" && isMap(v)) ? (V2_PATH as Record<string, string>)[k]! : k;
    const path = alias.split(".");
    if (path.length > 2 || path.some((p) => !p)) throw new ProfileWriteError("invalid", `${k}: a profile's value is named by its block and key (limits.maxTurns), or by a top-level field (tags)`, k);
    if (NOT_WRITTEN.has(path[0]!)) throw new ProfileWriteError("invalid", `${alias}: capcomd sets it (${path[0] === "version" ? "every write bumps it" : path[0] === "sharing" ? "`capcomd profiles install` writes it" : "it is who the profile is"}), a write can't`, alias);
    return [path, v];
  });
}

/** The edits laid on a plain manifest (a JSON profile file, or one `add` creates). */
function applyToObject(doc: ProfileDoc, edits: Array<[string[], unknown]>): ProfileDoc {
  const out: ProfileDoc = structuredClone(doc);
  for (const [[a, b], v] of edits) {
    if (b === undefined) { if (v === null) delete out[a!]; else out[a!] = v; continue; }
    const block = isMap(out[a!]) ? (out[a!] as Record<string, unknown>) : {};
    if (v === null) delete block[b]; else block[b] = v;
    if (Object.keys(block).length) out[a!] = block; else delete out[a!];
  }
  return out;
}

/** The edits laid on a YAML manifest, keeping its comments and layout. */
function applyToYaml(doc: Document, edits: Array<[string[], unknown]>) {
  // A scalar replaced by a scalar keeps its node, and so the comment after it.
  const put = (map: { get(k: string, keep: true): unknown; set(k: string, v: unknown): void }, k: string, v: unknown) => {
    const node = map.get(k, true);
    if (isScalar(node) && (v === null || typeof v !== "object")) node.value = v;
    else map.set(k, doc.createNode(v));
  };
  for (const [[a, b], v] of edits) {
    if (b === undefined) { if (v === null) doc.delete(a); else put(doc, a!, v); continue; }
    const block = doc.get(a, true);
    if (v === null) {
      if (!isYamlMap(block)) continue;
      block.delete(b);
      if (!block.items.length) doc.delete(a);
    } else if (isYamlMap(block)) put(block as never, b, v);
    else doc.set(a, doc.createNode({ [b]: v }));
  }
}

/** `version` set to `n`, right after `name` when the file has none yet. */
function withVersion(doc: ProfileDoc, n: number): ProfileDoc {
  if (Object.hasOwn(doc, "version")) return { ...doc, version: n };
  const out: ProfileDoc = {};
  for (const [k, v] of Object.entries(doc)) { out[k] = v; if (k === "name") out.version = n; }
  if (!Object.hasOwn(out, "version")) return { version: n, ...out };
  return out;
}
function yamlVersion(doc: Document, n: number) {
  const root = doc.contents;
  if (!isYamlMap(root)) return;
  if (root.has("version")) { root.set("version", n); return; }
  const at = root.items.findIndex((p) => isScalar(p.key) && p.key.value === "name");
  root.items.splice(at + 1, 0, doc.createPair("version", n));
}

/** A v2 path as the v1 field it is in an agents.json entry: [field], or [block, key] in a block kept whole; null: none. */
export function v1Field(path: string[]): string[] | null {
  const [a, b] = path;
  // A block the flat spec keeps whole (`children`, `jobs`, `context`), or one key of it.
  const whole = Object.entries(V2_PATH).find(([, p]) => p === a)?.[0];
  if (whole) return b === undefined ? [whole] : [whole, b];
  const field = Object.entries(V2_PATH).find(([, p]) => p === path.join("."))?.[0];
  return field ? [field] : null;
}

/** The paths of an edit an agents.json entry can't hold (`extends`, `tags`, `identity.title`, …): `add` writes a
 *  profile file for them. */
export function onlyInProfileFile(edit: ProfileEdit): string[] {
  return editPaths(edit).filter(([p]) => p[0] !== "default" && !v1Field(p)).map(([p]) => p.join("."));
}

/** An edit an agents.json entry can hold (onlyInProfileFile is empty) as that entry; removals and `default` aside. */
export function agentsEntryOf(edit: ProfileEdit): Record<string, unknown> {
  const entry: Record<string, unknown> = {};
  for (const [p, v] of editPaths(edit)) {
    const field = p[0] === "default" || v === null ? null : v1Field(p);
    if (!field) continue;
    const [k, sub] = field as [string, string?];
    if (sub === undefined) entry[k] = v;
    else entry[k] = { ...(isMap(entry[k]) ? (entry[k] as Record<string, unknown>) : {}), [sub]: v };
  }
  return entry;
}

/** A manifest in the schema's order (who it is, then its blocks), as capcomd writes profile files. */
export function orderedManifest(doc: ProfileDoc): ProfileDoc {
  const order = Object.keys(PROFILE_JSON_SCHEMA.properties), rank = (k: string) => { const i = order.indexOf(k); return i < 0 ? order.length : i; };
  return Object.fromEntries(Object.entries(doc).sort(([a], [b]) => rank(a) - rank(b)));
}
/** A new profile file's YAML: the manifest in the schema's order, after `comment` (each of its lines a `#` line). */
export function profileFileText(doc: ProfileDoc, comment?: string): string {
  const head = comment ? comment.split("\n").map((l) => (l ? `# ${l}` : "#")).join("\n") + "\n" : "";
  return head + toYaml(orderedManifest(doc));
}

/** The profile files' layer for new ones: the project's profiles/ (or the user's, when the agents file is). */
const newFileDir = (path: string, source: Env) => profileLayers(path, source)[0]!.dir;

/** The profiles as they are, or a write's refusal saying why they can't be read. */
function current(path: string, source: Env): ProfileSet {
  try { return readProfiles(path, source); } catch (e) {
    if (e instanceof AgentConfigError) throw new ProfileWriteError("invalid", `the profiles can't be read, so nothing was changed: ${e.message}`);
    throw e;
  }
}
/** The profiles as `overlay` would leave them, or the write's refusal. */
function checked(path: string, source: Env, overlay: ProfileOverlay): ProfileSet {
  try { return readProfiles(path, source, BUNDLED_PROFILES, overlay); } catch (e) {
    if (e instanceof AgentConfigError) throw new ProfileWriteError("invalid", `the change would leave the profiles unreadable, so nothing was changed: ${e.message}`);
    throw e;
  }
}

/** What changed between two resolutions of a profile, value by value (not its version, which every write bumps). */
export function profileChanges(before: ResolvedProfile | undefined, after: ResolvedProfile | undefined): ProfileChange[] {
  const a = new Map((before ? profileValues(before) : []).map((v) => [v.path, v.value]));
  const b = new Map((after ? profileValues(after) : []).map((v) => [v.path, v.value]));
  const paths = [...new Set([...a.keys(), ...b.keys()])].filter((p) => p !== "version").sort(compareValuePaths);
  return paths.filter((p) => JSON.stringify(a.get(p)) !== JSON.stringify(b.get(p))).map((p) => ({ path: p, from: a.get(p), to: b.get(p) }));
}

/** A write whose values a later file (an override.yaml) would hide is refused: it would change the file and nothing else. */
function checkVisible(name: string, edits: Array<[string[], unknown]>, after: ProfileSet) {
  const r = after.profiles[name];
  if (!r) return;
  const own = r.applied.findIndex((x) => x.as === "profile");
  for (const [path, v] of edits) {
    if (v === null || path[0] === "default") continue;
    const keys = path.length === 1 && isMap(v) ? Object.keys(v).map((k) => `${path[0]}.${k}`) : [path.join(".")];
    for (const k of keys) {
      const by = r.setBy[k];
      if (by === undefined || by === own) continue;
      const f = r.applied[by]!;
      throw new ProfileWriteError("invalid", `${k}: ${f.path ?? "a bundled file"} (${f.as === "override" ? `an override of ${f.name}` : f.as}) sets it after this profile's own file, so a change here wouldn't show: change it there`, k);
    }
  }
}

/**
 * Change profile `name`'s own file (`capcomd profiles set`, PUT /v1/profiles/{name}): the edits laid over it, its
 * version bumped (a v2 file), checked as the files would be after it. Throws ProfileWriteError. Nothing is written when
 * nothing would change.
 */
export function editProfile(name: string, edit: ProfileEdit, o: WriteOptions = {}): ProfileWrite {
  const path = o.path ?? agentsFilePath(), source = o.source ?? process.env;
  const before = current(path, source);
  const r = Object.hasOwn(before.profiles, name) ? before.profiles[name]! : undefined;
  if (!r) throw new ProfileWriteError("not_found", `profile "${name}" not found`);
  if (o.rev !== undefined && o.rev !== profileRev(r)) throw new ProfileWriteError("conflict", `profile "${name}" changed since it was read (its rev is now ${profileRev(r)}): read it again, then retry`);
  const own = r.applied.find((x) => x.as === "profile")!;
  if (!own.path) throw new ProfileWriteError("read_only", `profile "${name}" is bundled with capcomd, which a write doesn't change: add a profile of that name to your own profiles instead`);
  const file = own.path, edits = editPaths(edit);
  const old = readFileSync(file, "utf8");
  let text: string, changed: boolean, version = r.version;

  if (own.path === path && r.format === "v1") {
    // An agents.json entry: the v1 fields, and the file's `default`.
    const f = JSON.parse(old) as AgentsFile & { $schema?: string };
    const entry: Record<string, unknown> = structuredClone(f.agents[name] as unknown as Record<string, unknown>);
    let def = f.default;
    for (const [p, v] of edits) {
      if (p[0] === "default" && p.length === 1) { if (v === true) def = name; else if (def === name) def = undefined; continue; }
      const field = v1Field(p);
      if (!field) throw new ProfileWriteError("invalid", `${p.join(".")}: an agents.json entry can't hold it (only the v1 fields: \`capcomd profiles schema v1\`); put the profile in a profile file (${join(newFileDir(path, source), `${name}.yaml`)}) to set it`, p.join("."));
      const [k, sub] = field as [string, string?];
      if (sub === undefined) { if (v === null) delete entry[k]; else entry[k] = v; continue; }
      const block = isMap(entry[k]) ? { ...(entry[k] as Record<string, unknown>) } : {};
      if (v === null) delete block[sub]; else block[sub] = v;
      if (Object.keys(block).length) entry[k] = block; else delete entry[k];
    }
    const { $schema: _, ...rest } = f;
    const next: AgentsFile = { ...rest, schema: AGENTS_SCHEMA, agents: { ...f.agents, [name]: entry as never } };
    if (def === undefined) delete next.default; else next.default = def;
    changed = JSON.stringify(next) !== JSON.stringify(rest);
    text = agentsFileText(next);
  } else if (file.endsWith(".json")) {
    const doc = JSON.parse(old) as ProfileDoc;
    const next = applyToObject(doc, edits);
    changed = JSON.stringify(next) !== JSON.stringify(doc);
    if (changed) version = (typeof doc.version === "number" ? doc.version : 1) + 1;
    text = JSON.stringify(withVersion(next, version), null, 2) + "\n";
  } else {
    const doc = parseDocument(old);
    const was = JSON.stringify(doc.toJS());
    applyToYaml(doc, edits);
    changed = JSON.stringify(doc.toJS()) !== was;
    if (changed) { const cur = doc.get("version"); version = (typeof cur === "number" ? cur : 1) + 1; yamlVersion(doc, version); }
    text = String(doc);
  }
  if (!changed) return { name, file, format: r.format, changed: false, version: r.version, previousVersion: r.version, before, after: before, changes: [] };
  const after = checked(path, source, new Map([[file, text]]));
  checkVisible(name, edits, after);
  writeAtomic(file, text);
  return { name, file, format: r.format, changed: true, version: after.profiles[name]!.version, previousVersion: r.version, before, after, changes: profileChanges(r, after.profiles[name]) };
}

/**
 * Add profile `name` as a profile file (`capcomd profiles add --extends …`): `<the project's profiles>/<name>.yaml`, or
 * the user's when the agents file is the user's, at version 1. A name that is already a profile anywhere is a conflict.
 */
export function addProfileFile(name: string, edit: ProfileEdit, o: WriteOptions = {}): ProfileWrite {
  const path = o.path ?? agentsFilePath(), source = o.source ?? process.env;
  if (!NAME.test(name)) throw new ProfileWriteError("invalid", `profile name "${name}" must match ${NAME.source}`, "name");
  const before = current(path, source);
  const there = Object.hasOwn(before.profiles, name) ? before.profiles[name]! : undefined;
  if (there) throw new ProfileWriteError("conflict", `profile "${name}" already exists (${there.path ?? "bundled with capcomd"})`);
  const file = join(newFileDir(path, source), `${name}.yaml`);
  if (existsSync(file)) throw new ProfileWriteError("conflict", `${file} already exists`);
  const text = profileFileText(applyToObject({ schema: PROFILE_SCHEMA, name, version: 1 }, editPaths(edit)));
  const after = checked(path, source, new Map([[file, text]]));
  writeAtomic(file, text);
  return { name, file, format: "v2", changed: true, version: 1, previousVersion: 0, before, after, changes: profileChanges(undefined, after.profiles[name]) };
}

/**
 * Remove profile `name` (`capcomd profiles rm`): its agents.json entry (the file's default moves to the first entry
 * left) or its single profile file. A package (a directory with its own files) and a bundled profile aren't removed; a
 * removal that would leave another profile without its parent or an override without its profile is refused.
 */
export function removeProfile(name: string, o: WriteOptions = {}): ProfileWrite {
  const path = o.path ?? agentsFilePath(), source = o.source ?? process.env;
  const before = current(path, source);
  const r = Object.hasOwn(before.profiles, name) ? before.profiles[name]! : undefined;
  if (!r) throw new ProfileWriteError("not_found", `profile "${name}" not found`);
  const own = r.applied.find((x) => x.as === "profile")!;
  if (!own.path) throw new ProfileWriteError("read_only", `profile "${name}" is bundled with capcomd, which can't be removed`);
  const file = own.path;
  let next: string | null = null;
  if (file === path && r.format === "v1") {
    const f = JSON.parse(readFileSync(file, "utf8")) as AgentsFile & { $schema?: string };
    const { $schema: _, ...rest } = f;
    const { [name]: _gone, ...agents } = f.agents;
    const out: AgentsFile = { ...rest, agents, default: f.default === name ? Object.keys(agents)[0] : f.default };
    if (!out.default) delete out.default;
    next = agentsFileText(out);
  } else if (/^profile\.(ya?ml|json)$/.test(basename(file))) {
    throw new ProfileWriteError("read_only", `profile "${name}" is a package (${file} and the files beside it): remove its directory yourself`);
  }
  const after = checked(path, source, new Map([[file, next]]));
  if (next === null) unlinkSync(file); else writeAtomic(file, next);
  return { name, file, format: r.format, changed: true, version: r.version, previousVersion: r.version, before, after, changes: profileChanges(r, undefined) };
}
