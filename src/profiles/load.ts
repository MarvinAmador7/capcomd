// Where profiles come from and how a name resolves (ADR-024 §2.1, §2.3, §2.6, §6). A name is looked up in the
// project's `.capcomd/profiles/`, then the user's (`~/.capcomd/profiles/`), then the profiles bundled with capcomd; the
// first hit is the profile, its `extends` chain is laid under it and the `override.yaml` of its own and every higher
// layer over it. `agents.json` (v1) is still read: its entries are profiles of the layer it sits in, and a v2 profile
// of the same name in that layer wins. Every profile resolves to the flat v1 spec (./v1.ts AgentSpec, the pin), and
// the parent → child narrowing is checked on those, never on the files.
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { env as envVar } from "../utils/env";
import { defaultAgentsFile, userProfilesDir } from "../utils/home";
import { AGENTS_JSON_SCHEMA, AGENTS_SCHEMA, AgentConfigError, NAME, childNarrowing, validateFile, validateFileShape, validateSpec, type AgentSpec, type AgentsFile } from "./v1";
import { FILE_REF, checkManifest, fromFlat, inheritable, inheritableSetBy, layerOver, notApplied, setByOver, toFlat, v2Path, withContext, type ProfileDoc, type SetBy } from "./v2";
import { profileSkills, type ProfileSkill } from "./skills";

/** A JSON parse error as a profile file's error says it: where it went wrong, never what is there (readDoc). */
const jsonError = (e: unknown) => (e as Error).message.replace(/\s*["'`][^]*$/, "");

export function agentsFilePath(source: Record<string, string | undefined> = process.env): string {
  return envVar("AGENTS_FILE", source) ?? defaultAgentsFile(source);
}
/** The v1 file alone, as written (what `capcomd profiles add|set|rm` edit). Every reader of profiles uses readProfiles. */
export function readAgentsFile(path = agentsFilePath()): AgentsFile {
  if (!existsSync(path)) return { schema: AGENTS_SCHEMA, agents: {} };
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, "utf8")); } catch (e) { throw new AgentConfigError(`${path}: invalid JSON (${jsonError(e)})`); }
  const errs = validateFile(raw);
  if (errs.length) throw new AgentConfigError(`${path}: ${errs.join("; ")}`);
  return raw as AgentsFile;
}
export function writeAgentsFile(f: AgentsFile, path = agentsFilePath()) {
  const errs = validateFile(f);
  if (errs.length) throw new AgentConfigError(errs.join("; "));
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify({ $schema: AGENTS_JSON_SCHEMA.$id, ...f }, null, 2) + "\n");
  renameSync(tmp, path);
}

/** Where a profile came from (spec §6.6.5 `ProfileResolved.profile.source`; `installed` arrives with ADR-024 step 7). */
export type ProfileLayer = "project" | "user" | "bundled";
/** One file applied to a resolved profile: an ancestor it extends, the profile itself, or an override of it. */
export interface AppliedFile { as: "extends" | "profile" | "override"; name: string; layer: ProfileLayer; path: string | null }
export interface ResolvedProfile {
  name: string;
  /** Its `version`, else 1 (ADR-024 §2.4). */
  version: number;
  /** The layer it was found in (its overrides may come from higher ones). */
  source: ProfileLayer;
  /** Its manifest, or the agents.json that holds it; null for a bundled one. */
  path: string | null;
  format: "v1" | "v2";
  /** Everything laid together, first to last: its `extends` ancestors (root first), itself, then its overrides. */
  applied: AppliedFile[];
  /** The resolved manifest (v2 blocks, `memory` read as `context`, prompt files read in). */
  manifest: ProfileDoc;
  /** For each value of `manifest`, by path (`limits.maxTurns`, `tags`), the index in `applied` of the file that set it. */
  setBy: SetBy;
  /** What it pins (./v1.ts AgentSpec). */
  spec: AgentSpec;
  /** Its `skills`, read and hashed (./skills.ts), which an agent of it is pinned with too; not capcomd's orchestration
   *  skill, which every agent that may spawn gets by itself. */
  skills: ProfileSkill[];
}
/** Every profile a project sees, resolved: `agents` and `default` read as a v1 file's do, so every reader of
 *  `readAgentsFile(…).agents[name]` reads v2 profiles the same way. */
export interface ProfileSet extends AgentsFile { profiles: Record<string, ResolvedProfile>; warnings: string[] }

/** The profiles shipped with capcomd, the lowest layer. None yet: `capcomd setup project` writes its four into the
 *  project's agents.json until ADR-024 §7 step 9 ships them here as v2 templates. */
export const BUNDLED_PROFILES: Readonly<Record<string, ProfileDoc>> = {};

/**
 * The layers' directories, highest first: the project's (the `profiles/` next to the agents file: `.capcomd/agents.json`
 * → `.capcomd/profiles/`, so a run's CAPCOMD_AGENTS_FILE carries it) and the user's; one when they are the same place
 * (no project profiles: the agents file is the user's). The bundled layer has no directory.
 */
export function profileLayers(path = agentsFilePath(), source: Record<string, string | undefined> = process.env): Array<{ layer: "project" | "user"; dir: string }> {
  const root = join(dirname(resolve(path)), "profiles"), user = resolve(userProfilesDir(source));
  return root === user ? [{ layer: "user", dir: user }] : [{ layer: "project", dir: root }, { layer: "user", dir: user }];
}

/** `dir`: the package directory (`<name>/`) its file is in, where its `skills/` are; null for a single file. */
interface Entry { name: string; layer: ProfileLayer; path: string | null; dir: string | null; format: "v1" | "v2"; doc: ProfileDoc; spec?: AgentSpec }
interface Layer { layer: ProfileLayer; profiles: Map<string, Entry>; overrides: Map<string, Entry> }

const MANIFEST = /^(.+)\.(ya?ml|json)$/;
/**
 * A manifest's text as data: JSON by its extension, else YAML (JSON is YAML too; decision 4 in ADR-024 §9). A parse
 * error says where, never what is there: the message can reach an agent (a spawn it asked for), and the file may be a
 * link to anything on the host.
 */
function readDoc(path: string): unknown {
  const text = readFileSync(path, "utf8");
  if (path.endsWith(".json")) {
    try { return JSON.parse(text); } catch (e) { throw new Error(`invalid JSON: ${jsonError(e)}`); }
  }
  try { return parseYaml(text, { uniqueKeys: true, maxAliasCount: 100, prettyErrors: false }); } catch (e) {
    const at = (e as { pos?: [number, number] }).pos?.[0];
    const where = at === undefined ? "" : (() => { const before = text.slice(0, at).split("\n"); return ` at line ${before.length}, column ${before[before.length - 1]!.length + 1}`; })();
    throw new Error(`invalid YAML${where}: ${(e as Error).message.replace(/:.*$/s, "")}`);
  }
}

/** A prompt that is one word ending in .md or .txt is a file's name, not text. */
const LOOKS_LIKE_FILE = /^\S+\.(?:md|txt)$/;
/**
 * A manifest's file references, read: `prompt.system`/`prompt.append` that name a file (`prompt.md`) become its text,
 * and `identity.persona` must exist. Only in a profile directory, and only inside it (`..`, an absolute path and a
 * symlink out of it are refused): a package carries its files and reads nothing else of the host (ADR-024 §2.5).
 */
function readFiles(doc: ProfileDoc, dir: string | null, errs: string[], where: string): ProfileDoc {
  const inside = (ref: string, key: string): string | null => {
    if (!dir) { errs.push(`${where}: ${key} names a file (${ref}), which only a profile directory (<name>/profile.yaml) can hold`); return null; }
    let real: string;
    try { real = realpathSync(join(dir, ref)); } catch { errs.push(`${where}: ${key} names ${ref}, which isn't in ${dir}`); return null; }
    if (!real.startsWith(realpathSync(dir) + sep) || !statSync(real).isFile()) { errs.push(`${where}: ${key} names ${ref}, which leads outside the profile's directory`); return null; }
    return real;
  };
  const prompt = doc.prompt as Record<string, unknown> | null | undefined;
  let out = doc;
  if (prompt && typeof prompt === "object") {
    const next = { ...prompt };
    for (const k of ["system", "append"]) {
      const v = next[k];
      if (typeof v !== "string" || !LOOKS_LIKE_FILE.test(v)) continue;
      if (!FILE_REF.test(v)) { errs.push(`${where}: prompt.${k} names ${v}, which leads outside the profile's directory`); continue; }
      const real = inside(v, `prompt.${k}`);
      if (real) next[k] = readFileSync(real, "utf8");
    }
    out = { ...doc, prompt: next };
  }
  const persona = (doc.identity as Record<string, unknown> | null | undefined)?.persona;
  if (typeof persona === "string") inside(persona, "identity.persona");
  return out;
}

/** One layer's directory: `<name>/profile.yaml` (a package), `<name>.yaml` (a single file), `<name>/override.yaml`. */
function scanLayer(layer: "project" | "user", dir: string, errs: string[]): Layer {
  const out: Layer = { layer, profiles: new Map(), overrides: new Map() };
  if (!existsSync(dir)) return out;
  const found = new Map<string, Array<{ path: string; dir: string | null }>>(), overrides = new Map<string, string[]>();
  const add = <T>(m: Map<string, T[]>, k: string, v: T) => m.set(k, [...(m.get(k) ?? []), v]);
  let names: string[];
  try { names = readdirSync(dir).sort(); } catch (e) { errs.push(`${dir}: ${(e as Error).message}`); return out; }
  for (const f of names) {
    if (f.startsWith(".")) continue;
    const p = join(dir, f);
    let isDir: boolean;
    try { isDir = statSync(p).isDirectory(); } catch { continue; } // a dangling link
    if (isDir) {
      if (!NAME.test(f)) { errs.push(`${p}: a profile directory is named for its profile, which must match ${NAME.source}`); continue; }
      let inDir: string[];
      try { inDir = readdirSync(p); } catch (e) { errs.push(`${p}: ${(e as Error).message}`); continue; }
      const manifests = inDir.filter((x) => MANIFEST.exec(x)?.[1] === "profile"), ovs = inDir.filter((x) => MANIFEST.exec(x)?.[1] === "override");
      if (!manifests.length && !ovs.length) { errs.push(`${p}: has no profile.yaml (a profile) or override.yaml (changes to one)`); continue; }
      for (const m of manifests) add(found, f, { path: join(p, m), dir: p });
      for (const o of ovs) add(overrides, f, join(p, o));
      continue;
    }
    const m = MANIFEST.exec(f);
    if (!m) continue; // a README beside the profiles
    if (!NAME.test(m[1]!)) { errs.push(`${p}: a profile file is named for its profile, which must match ${NAME.source}`); continue; }
    add(found, m[1]!, { path: p, dir: null });
  }
  const load = (name: string, path: string, pdir: string | null, as: "profile" | "override"): Entry | null => {
    let raw: unknown;
    try { raw = readDoc(path); } catch (e) { errs.push(`${path}: can't be read (${(e as Error).message})`); return null; }
    const e = checkManifest(raw, as, name);
    if (e.length) { errs.push(...e.map((x) => `${path}: ${x}`)); return null; }
    const doc = readFiles(withContext(raw as ProfileDoc), pdir, errs, path);
    return { name, layer, path, dir: pdir, format: "v2", doc };
  };
  for (const [name, list] of found) {
    if (list.length > 1) { errs.push(`profile ${name} is defined more than once in ${dir} (${list.map((x) => x.path).join(", ")}): keep one`); continue; }
    const e = load(name, list[0]!.path, list[0]!.dir, "profile");
    if (e) out.profiles.set(name, e);
  }
  for (const [name, list] of overrides) {
    if (list.length > 1) { errs.push(`profile ${name} has more than one override in ${dir} (${list.join(", ")}): keep one`); continue; }
    const e = load(name, list[0]!, dirname(list[0]!), "override");
    if (e) out.overrides.set(name, e);
  }
  return out;
}

/**
 * Every profile this project sees, resolved (ADR-024 §3 `profiles.resolve`, for all names at once): the agents file at
 * `path` and the v2 layers around it. Throws AgentConfigError naming every problem, as readAgentsFile does for a v1
 * file. With no v2 profile anywhere it is exactly the v1 file (`readAgentsFile`). `bundled`: the lowest layer.
 */
export function readProfiles(path = agentsFilePath(), source: Record<string, string | undefined> = process.env, bundled: Readonly<Record<string, ProfileDoc>> = BUNDLED_PROFILES): ProfileSet {
  const errs: string[] = [], warnings: string[] = [];
  const dirs = profileLayers(path, source);
  const layers: Layer[] = [...dirs.map((d) => scanLayer(d.layer, d.dir, errs)), { layer: "bundled", profiles: new Map(), overrides: new Map() }];
  const bottom = layers[layers.length - 1]!;
  for (const [name, doc] of Object.entries(bundled)) {
    const e = checkManifest(doc, "profile", name);
    if (e.length) errs.push(...e.map((x) => `bundled profile ${name}: ${x}`));
    else bottom.profiles.set(name, { name, layer: "bundled", path: null, dir: null, format: "v2", doc: withContext(doc) });
  }
  const v1Layer = dirs[0]!.layer;

  if (!errs.length && layers.every((l) => !l.profiles.size && !l.overrides.size)) {
    const f = readAgentsFile(path);
    const profiles = Object.fromEntries(Object.entries(f.agents).map(([name, spec]): [string, ResolvedProfile] => {
      const manifest = fromFlat(name, spec);
      return [name, { name, version: 1, source: v1Layer, path, format: "v1", applied: [{ as: "profile", name, layer: v1Layer, path }], manifest, setBy: setByOver({}, {}, manifest, 0), spec, skills: [] }];
    }));
    return { ...f, profiles, warnings };
  }

  // The v1 file: its own checks (but `default`, which may name a v2 profile), then its entries join its layer.
  let v1: AgentsFile | null = null;
  if (existsSync(path)) {
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(path, "utf8")); } catch (e) { errs.push(`${path}: invalid JSON (${jsonError(e)})`); }
    if (raw !== undefined) {
      const e = validateFileShape(raw, () => true);
      if (e.length) errs.push(`${path}: ${e.join("; ")}`);
      else v1 = raw as AgentsFile;
    }
  }
  const v1Entries = new Map(Object.entries(v1?.agents ?? {}).map(([name, spec]): [string, Entry] => [name, { name, layer: v1Layer, path, dir: null, format: "v1", doc: fromFlat(name, spec), spec }]));
  for (const name of v1Entries.keys()) {
    const v2 = layers.find((l) => l.layer === v1Layer)!.profiles.get(name);
    if (v2) warnings.push(`${path}: agents.${name} is hidden by ${v2.path} (a v2 profile wins over agents.json)`);
  }

  /** The profile a name is, highest layer first; in the agents file's layer a v2 profile before its v1 entry. */
  const sourceOf = (name: string): { entry: Entry; at: number } | null => {
    for (let at = 0; at < layers.length; at++) {
      const e = layers[at]!.profiles.get(name) ?? (layers[at]!.layer === v1Layer ? v1Entries.get(name) : undefined);
      if (e) return { entry: e, at };
    }
    return null;
  };

  const done = new Map<string, ResolvedProfile | "failed">(), resolving: string[] = [];
  /** Each resolved profile's package directories, root first (its ancestors', its own, its overrides'): its skills'. */
  type Dir = { dir: string; layer: "project" | "user" };
  const dirsOf = new Map<string, Dir[]>();
  const dirOf = (e: Entry): Dir[] => (e.dir && e.layer !== "bundled" ? [{ dir: e.dir, layer: e.layer }] : []);
  const defaults: Array<{ name: string; at: number; v1: boolean }> = [];
  const resolveName = (name: string): ResolvedProfile | "failed" | undefined => {
    const known = done.get(name);
    if (known) return known;
    const src = sourceOf(name);
    if (!src) return undefined;
    if (resolving.includes(name)) {
      errs.push(`profiles.${name}: extends itself (${[...resolving.slice(resolving.indexOf(name)), name].join(" → ")}): a profile's ancestors can't include it`);
      return "failed";
    }
    const fail = (m?: string) => { if (m) errs.push(m); done.set(name, "failed"); return "failed" as const; };
    resolving.push(name);
    try {
      const { entry, at } = src;
      let doc: ProfileDoc = {}, setBy: SetBy = {};
      const applied: AppliedFile[] = [], dirs: Dir[] = [];
      const lay = (over: ProfileDoc, file: AppliedFile) => { setBy = setByOver(setBy, doc, over, applied.length); doc = layerOver(doc, over); applied.push(file); };
      const parent = entry.doc.extends as string | undefined;
      if (parent !== undefined) {
        const p = resolveName(parent);
        if (p === undefined) return fail(`${entry.path ?? `profiles.${name}`}: extends "${parent}", which isn't a profile here (this project's, your own or a bundled one; a profile never extends another project's)`);
        if (p === "failed") return fail(); // its own error says why
        doc = inheritable(p.manifest);
        setBy = inheritableSetBy(p.setBy);
        applied.push(...p.applied.map((a): AppliedFile => ({ ...a, as: "extends" })));
        dirs.push(...(dirsOf.get(parent) ?? []));
      }
      lay(entry.doc, { as: "profile", name, layer: entry.layer, path: entry.path });
      dirs.push(...dirOf(entry));
      let def: { at: number; on: boolean } | null = typeof entry.doc.default === "boolean" ? { at, on: entry.doc.default } : null;
      // Overrides: this layer's, then each one above it, so the project's comes last (§2.6).
      for (let i = at; i >= 0; i--) {
        const ov = layers[i]!.overrides.get(name);
        if (!ov) continue;
        lay(ov.doc, { as: "override", name, layer: ov.layer, path: ov.path });
        dirs.push(...dirOf(ov));
        if (typeof ov.doc.default === "boolean") def = { at: i, on: ov.doc.default };
      }
      const plainV1 = entry.format === "v1" && applied.length === 1;
      const spec = plainV1 ? entry.spec! : toFlat(doc);
      const e = plainV1 ? [] : validateSpec(name, spec, { prefix: `profiles.${name}`, key: v2Path });
      const sandbox = (doc.sandbox as Record<string, unknown> | undefined)?.provider;
      if (typeof sandbox === "string") {
        const { sandboxSeam } = require("../plugins/sandboxes") as typeof import("../plugins/sandboxes");
        if (!sandboxSeam(sandbox)) e.push(`profiles.${name}: sandbox.provider "${sandbox}" isn't an active sandbox provider (see \`capcomd plugins list\`)`);
      }
      // Its skills, read from the nearest directory that has each (an override's, its own, then its ancestors').
      const sk = profileSkills(`profiles.${name}`, doc.skills, [...dirs].reverse(), spec.children?.allowSpawn === true);
      e.push(...sk.errors);
      if (e.length) return fail(e.join("; "));
      dirsOf.set(name, dirs);
      if (def?.on) defaults.push({ name, at: def.at, v1: false });
      const notYet = notApplied(doc);
      if (notYet.length) warnings.push(`profiles.${name}: ${notYet.join(", ")} ${notYet.length > 1 ? "are" : "is"} read but not used yet by this capcomd`);
      const r: ResolvedProfile = { name, version: typeof doc.version === "number" ? doc.version : 1, source: entry.layer, path: entry.path, format: entry.format, applied, manifest: { ...doc, name }, setBy: { ...setBy, name: applied.findIndex((a) => a.as === "profile") }, spec, skills: sk.skills };
      done.set(name, r);
      return r;
    } finally { resolving.pop(); }
  };

  // Every name, in a stable order: the agents file's own, then each layer's (highest first).
  const order = [...new Set([...v1Entries.keys(), ...layers.flatMap((l) => [...l.profiles.keys()])])];
  for (const name of order) resolveName(name);
  for (const l of layers) for (const [name, ov] of l.overrides) {
    const src = sourceOf(name), at = layers.indexOf(l);
    if (!src) errs.push(`${ov.path}: overrides the profile ${name}, which isn't defined (this project's, your own or a bundled one)`);
    else if (src.at < at) warnings.push(`${ov.path}: doesn't apply: the ${src.entry.layer} profile ${name} (${src.entry.path ?? "bundled"}) is used, and only overrides at its layer or above apply to it`);
  }

  const profiles: Record<string, ResolvedProfile> = {};
  for (const name of order) { const r = done.get(name); if (r && r !== "failed") profiles[name] = r; }
  const agents = Object.fromEntries(Object.values(profiles).map((p) => [p.name, p.spec]));
  if (!errs.length) {
    errs.push(...childNarrowing(agents, (n) => (profiles[n]!.format === "v1" && profiles[n]!.applied.length === 1 ? `${path}: agents.${n}` : `profiles.${n}`)));
    if (v1?.default !== undefined) {
      if (!Object.hasOwn(profiles, v1.default)) errs.push(`${path}: default "${v1.default}" is not a defined agent`);
      else defaults.push({ name: v1.default, at: layers.findIndex((l) => l.layer === v1Layer), v1: true });
    }
  }
  // The highest layer's default; a v2 profile's `default: true` before the agents file's `default` in the same layer.
  defaults.sort((a, b) => a.at - b.at || Number(a.v1) - Number(b.v1));
  const top = defaults.filter((d) => d.at === defaults[0]?.at && !d.v1);
  if (top.length > 1) errs.push(`more than one ${layers[top[0]!.at]!.layer} profile says default: true (${top.map((d) => d.name).join(", ")}): keep one`);
  if (errs.length) throw new AgentConfigError(errs.join("; "));
  return { schema: AGENTS_SCHEMA, ...(defaults[0] ? { default: defaults[0].name } : {}), agents, profiles, warnings };
}
