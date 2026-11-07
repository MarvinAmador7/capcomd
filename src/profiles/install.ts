// Profile packages (ADR-024 §2.5, §7 step 7): installing one from a git repository, updating and removing it, and
// exporting a profile as a package to share. The machinery is the plugins' (src/install/: the source, the fetch through
// the host's own repo with no checkout, LOCK and its content hash), so a profile's LOCK is a plugin's with
// `kind: "profile"`: one format, one hash rule.
//
//  - `install <owner/repo>[#<name>][@<ref>]` writes the package directory (the one whose profile.yaml names the
//    profile) into the user's profiles (~/.capcomd/profiles/<name>/), or with `project` the project's
//    (.capcomd/profiles/<name>/, in the checkout, to commit), with its LOCK. Profiles are data: a package holding an
//    executable file or an override.yaml (the user's, laid over it) is refused, and so is one the profiles wouldn't
//    resolve with (a file named outside its directory, an `extends` nothing here answers): checked in place, and taken
//    out again when they don't. A project's package is text from the repository like any profile there: its skills
//    wait for `capcomd profiles trust` (./trust.ts).
//  - `update <name>` fetches again from the LOCK's source and reports what changed (files, each skill's hash, commit,
//    content hash) before replacing the package's files; an override.yaml beside them, and any file the user added
//    there (one the LOCK doesn't list), is the user's and stays.
//  - `export <name>` writes a profile as a package directory: its own files with `extends` kept, or `flat`, resolved
//    into one manifest with the skills it is pinned with. Nothing of capcomd's state goes in it, and no LOCK.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parse as parseYaml, parseDocument, stringify as toYaml } from "yaml";
import { RelayError } from "../core/errors";
import { stateDir, userProfilesDir } from "../utils/home";
import { fetchPackage, FetchError } from "../install/fetch";
import { diffTrees, hashTree, readLock, treeHash, writeLock, LOCK_FILE, LOCK_SCHEMA, TreeError, type Lock, type TreeFile } from "../install/lock";
import { parseSource, SourceError, type PackageSource } from "../install/source";
import { revokeTrust } from "../install/trust";
import { agentsFilePath, BUNDLED_PROFILES, LOOKS_LIKE_FILE, profileLayers, readProfiles, type ProfileSet, type ResolvedProfile } from "./load";
import { AgentConfigError, NAME } from "./v1";
import { PROFILE_JSON_SCHEMA, PROFILE_SCHEMA, checkManifest, fromFlat, type ProfileDoc } from "./v2";
import { PROFILE_TRUST_KIND } from "./trust";

type Env = Record<string, string | undefined>;
const MANIFEST_FILE = /^profile\.(ya?ml|json)$/;
/** An override.yaml in a package's directory is the user's (or the project's): never a package's, never replaced. */
const OVERRIDE_FILE = /^override\.(ya?ml|json)$/;
const SKILL_FILE = /^skills\/([^/]+)\/SKILL\.md$/;
const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

const usage = (e: unknown): never => {
  if (e instanceof SourceError) throw new RelayError("usage", e.message, "A source is owner/repo[#name][@ref], a git URL or a local repository path, with the same #name and @ref.");
  if (e instanceof FetchError || e instanceof TreeError) throw new RelayError("run_failed", e.message, "Check the source and the ref; a profile package is a directory of plain files.");
  throw e;
};

/** Where `install` puts a package: the user's profiles, or with `project` the project's (next to its agents file). */
export function packagesDir(o: { project?: boolean; path?: string; env?: Env } = {}): { layer: "project" | "user"; dir: string } {
  const layers = profileLayers(o.path ?? agentsFilePath(o.env ?? process.env), o.env ?? process.env);
  const l = layers.find((x) => x.layer === (o.project ? "project" : "user"));
  if (!l) throw new RelayError("usage", "not in a project: its profiles are .capcomd/profiles/ next to .capcomd/agents.json", "Run it in the project's checkout (capcomd setup project makes one), or leave out --project for your own profiles.");
  return l;
}

/** The profiles' problem as `capcomd profiles validate` says it, or null when they resolve. */
function problems(path: string, env: Env): string | null {
  try { readProfiles(path, env); return null; } catch (e) {
    if (e instanceof AgentConfigError) return e.message;
    throw e;
  }
}

/**
 * The agents files whose profiles a change in `layer` must leave readable: this one's, and for the user's layer also the
 * user's own as every other project reads them (no project layer over them). A package this project hides (a project
 * profile of the same name wins) isn't resolved here, so only that read finds what is wrong with it.
 */
function views(path: string, env: Env, layer: "project" | "user"): string[] {
  const own = join(dirname(userProfilesDir(env)), "agents.json");
  return layer === "user" && profileLayers(path, env).length > 1 ? [path, own] : [path];
}

/**
 * Change the files with `apply`, then read the profiles (each of `paths`): when that change left them with a problem
 * they didn't have (a new one, not one the project had already), `undo` it and refuse. A reader in between sees the
 * change for as long as one read takes.
 */
function checkedChange(paths: string[], env: Env, what: string, apply: () => void, undo: () => void) {
  const was = paths.map((p) => problems(p, env));
  apply();
  const now = paths.map((p) => problems(p, env));
  const i = now.findIndex((n, j) => n && n !== was[j]);
  if (i >= 0) {
    undo();
    const whose = i === 0 ? "the profiles" : "your profiles, as every other project reads them,";
    throw new RelayError("config", `${what} would leave ${whose} unreadable, so nothing was changed: ${now[i]}`, "capcomd profiles validate says what is wrong with the files as they are.", { code: "invalid_profile" });
  }
}

/** The package in a repository's tree: the one whose manifest names `#name`, else the root's profile.yaml, else the only one. */
function pickProfile(want: string | null) {
  return (paths: string[], read: (p: string) => string | null): string => {
    const found: Array<{ dir: string; name: string }> = [];
    for (const p of paths) {
      const base = p.slice(p.lastIndexOf("/") + 1);
      if (!MANIFEST_FILE.test(base) || p.includes("node_modules/")) continue;
      let doc: unknown = null;
      try { const text = read(p) ?? ""; doc = p.endsWith(".json") ? JSON.parse(text) : parseYaml(text, { maxAliasCount: 100, prettyErrors: false }); } catch { /* not a manifest */ }
      if (isMap(doc) && typeof doc.name === "string") found.push({ dir: p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "", name: doc.name });
    }
    if (want) {
      const named = found.filter((f) => f.name === want);
      if (named.length === 1) return named[0]!.dir;
      if (named.length > 1) throw new FetchError(`the repository has ${named.length} profiles named ${want}: ${named.map((f) => f.dir || "(root)").join(", ")}`);
      throw new FetchError(`the repository has no profile named ${want}${found.length ? ` (it has ${found.map((f) => f.name).join(", ")})` : ""}`);
    }
    if (found.some((f) => f.dir === "")) return "";
    if (found.length === 1) return found[0]!.dir;
    throw new FetchError(found.length ? `the repository has several profiles: name one with #<name> (${found.map((f) => f.name).join(", ")})` : "the repository has no capcomd profile (a profile.yaml with its name)");
  };
}

/** A fetched package as a profile package: one manifest naming it, no program, no override; its name and version. */
function checkPackage(dir: string, files: Record<string, TreeFile>, want: string | null): { name: string; version: number | null } {
  const refuse = (m: string, hint = "A profile package is a profile.yaml and the text files it names (prompts, a persona, skills/<name>/SKILL.md)."): never => { throw new RelayError("config", m, hint, { code: "invalid_profile" }); };
  const manifests = Object.keys(files).filter((p) => MANIFEST_FILE.test(p));
  if (manifests.length !== 1) refuse(manifests.length ? `the package has ${manifests.length} manifests (${manifests.join(", ")}): keep one` : "the package has no profile.yaml");
  const exec = Object.keys(files).filter((p) => files[p]!.mode === "100755");
  if (exec.length) refuse(`profiles are data, and the package has ${exec.length === 1 ? "an executable file" : "executable files"}: ${exec.slice(0, 5).join(", ")}${exec.length > 5 ? ", …" : ""}`, "A profile carries no programs: its MCP servers run in the agent's sandbox, its lifecycle names plugins you installed (ADR-024 §2.5).");
  const ov = Object.keys(files).filter((p) => OVERRIDE_FILE.test(p));
  if (ov.length) refuse(`the package has ${ov.join(", ")}: an override is yours or the project's, laid over the profile it names, never a package's`);
  const file = manifests[0]!;
  let raw: unknown;
  try { const text = readFileSync(join(dir, file), "utf8"); raw = file.endsWith(".json") ? JSON.parse(text) : parseYaml(text, { uniqueKeys: true, maxAliasCount: 100, prettyErrors: false }); } catch { refuse(`its ${file} can't be read (capcomd profiles validate on a copy says where)`); }
  const name = isMap(raw) && typeof raw.name === "string" ? raw.name : null;
  if (!name || !NAME.test(name)) refuse(`its ${file} has no profile name (name: matching ${NAME.source})`);
  if (want && name !== want) refuse(`the profile in that directory is ${name}, not ${want}`, "Name it by the name in its profile.yaml.");
  const errs = checkManifest(raw, "profile", name!);
  if (errs.length) refuse(`its ${file} is refused: ${errs.join("; ")}`);
  const v = (raw as ProfileDoc).version;
  return { name: name!, version: typeof v === "number" ? v : null };
}

/** Fetch `src` into a fresh directory (its name starts with a dot: no layer reads it) under `parent`, and check it. */
async function stage(src: PackageSource, parent: string, want: string | null, env: Env): Promise<{ staging: string; name: string; version: number | null; lock: Lock }> {
  mkdirSync(parent, { recursive: true });
  const staging = join(parent, `.staging-${process.pid}-${Math.random().toString(36).slice(2, 10)}`);
  try {
    const fetched = await fetchPackage(src, { workdir: join(stateDir(env), "installs"), into: staging, pick: pickProfile(want) }).catch(usage);
    let tree: ReturnType<typeof hashTree>;
    try { tree = hashTree(staging); } catch (e) { return usage(e); }
    const { name, version } = checkPackage(staging, tree.files, want);
    const lock: Lock = {
      schema: LOCK_SCHEMA, kind: PROFILE_TRUST_KIND, name, version: version === null ? null : String(version), source: src.spec, remote: src.remote, ref: src.ref,
      commit: fetched.commit, path: fetched.path, installedAt: new Date().toISOString(), files: tree.files, hash: tree.hash,
    };
    return { staging, name, version, lock };
  } catch (e) {
    rmSync(staging, { recursive: true, force: true });
    throw e;
  }
}

export interface InstalledProfile {
  name: string; version: number | null; source: string; commit: string; hash: string; dir: string; layer: "project" | "user";
  /** The profile of that name this project uses instead (a higher layer's), or null. */
  hiddenBy: string | null;
}

/**
 * `capcomd profiles install <source>`: the package into the user's profiles, or with `project` the project's. A profile
 * of that name already in that layer is a conflict (`update` replaces an installed one).
 */
export async function installProfile(spec: string, o: { project?: boolean; path?: string; env?: Env; cwd?: string } = {}): Promise<InstalledProfile> {
  const env = o.env ?? process.env, path = o.path ?? agentsFilePath(env);
  let src: PackageSource;
  try { src = parseSource(spec, o.cwd); } catch (e) { return usage(e); }
  const target = packagesDir({ project: o.project, path, env });
  const { staging, name, version, lock } = await stage(src, target.dir, src.name, env);
  const dest = join(target.dir, name);
  try {
    let before: ProfileSet | null = null;
    try { before = readProfiles(path, env); } catch (e) { if (!(e instanceof AgentConfigError)) throw e; }
    const there = before && Object.hasOwn(before.profiles, name) && before.profiles[name]!.source === target.layer ? before.profiles[name]!.path : null;
    const file = [dest, ...["yaml", "yml", "json"].map((x) => join(target.dir, `${name}.${x}`))].find((p) => existsSync(p)) ?? there;
    if (file) throw new RelayError("conflict", `profile ${name} is already in ${target.layer === "project" ? "the project's" : "your"} profiles (${file})`, readLock(dest)?.kind === PROFILE_TRUST_KIND ? `Update it with capcomd profiles update ${name}${o.project ? " --project" : ""}.` : "Remove or rename that one first: two profiles can't share a name in one place.");
    writeLock(staging, lock);
    checkedChange(views(path, env, target.layer), env, `installing ${name}`, () => renameSync(staging, dest), () => rmSync(dest, { recursive: true, force: true }));
  } finally { rmSync(staging, { recursive: true, force: true }); }
  let hiddenBy: string | null = null;
  try { const r = readProfiles(path, env).profiles[name]; if (r && r.source !== target.layer) hiddenBy = r.path ?? "a bundled profile"; } catch { /* checked above */ }
  return { name, version, source: lock.source, commit: lock.commit, hash: lock.hash, dir: dest, layer: target.layer, hiddenBy };
}

/** The installed package `name`: the project's, then the user's (`project`: only the project's). */
function installedPackage(name: string, o: { project?: boolean; path: string; env: Env }): { dir: string; layer: "project" | "user"; lock: Lock } {
  const layers = profileLayers(o.path, o.env).filter((l) => !o.project || l.layer === "project");
  if (o.project && !layers.length) packagesDir({ project: true, path: o.path, env: o.env });
  if (NAME.test(name)) for (const l of layers) {
    const dir = join(l.dir, name), lock = readLock(dir);
    if (lock && lock.kind === PROFILE_TRUST_KIND && lock.name === name) return { dir, layer: l.layer, lock };
  }
  throw new RelayError("not_found", `no profile ${name} installed${o.project ? " in this project" : ""}`, "capcomd profiles install <owner/repo>#<name> installs one; a profile you wrote yourself changes with its files.");
}

/** A package's files as its LOCK hashes them: every file but LOCK and the user's override (which isn't the package's). */
function packageTree(dir: string): { files: Record<string, TreeFile>; hash: string } {
  const files = Object.fromEntries(Object.entries(hashTree(dir).files).filter(([p]) => !OVERRIDE_FILE.test(p)));
  return { files, hash: treeHash(files) };
}

/** What an installed package is against its LOCK (null: not one capcomd installed). */
export function packageState(dir: string): { lock: Lock; modified: ReturnType<typeof diffTrees> | null; error?: string } | null {
  const lock = readLock(dir);
  if (!lock || lock.kind !== PROFILE_TRUST_KIND) return null;
  try {
    const t = packageTree(dir);
    return { lock, modified: t.hash === lock.hash ? null : diffTrees(lock.files, t.files) };
  } catch (e) { return { lock, modified: null, error: (e as Error).message }; }
}

/** A profile's installed package, when its own file is one: where it came from and whether its files changed since. */
export function installedFacts(r: ResolvedProfile): { source: string; commit: string; ref: string | null; hash: string; installedAt: string; modified: string[] | null; error?: string } | null {
  const own = r.applied.find((a) => a.as === "profile");
  if (!own?.path || !MANIFEST_FILE.test(basename(own.path))) return null;
  const s = packageState(dirname(own.path));
  if (!s) return null;
  const m = s.modified;
  return { source: s.lock.source, commit: s.lock.commit, ref: s.lock.ref, hash: s.lock.hash, installedAt: s.lock.installedAt, modified: m ? [...m.changed, ...m.added, ...m.removed] : null, ...(s.error ? { error: s.error } : {}) };
}

/** What `capcomd profiles validate` adds about installed packages: each one whose files changed since it was installed. */
export function packageWarnings(set: ProfileSet): string[] {
  const out: string[] = [];
  for (const [n, r] of Object.entries(set.profiles)) {
    const f = installedFacts(r);
    if (f?.error) out.push(`profiles.${n}: its package can't be hashed against its LOCK (${f.error})`);
    else if (f?.modified) out.push(`profiles.${n}: edited since it was installed (${f.modified.join(", ")}); capcomd profiles update ${n} would replace the edits (an override.yaml beside it, and files you added, are kept)`);
  }
  return out;
}

export interface ProfileUpdate {
  name: string; dir: string; layer: "project" | "user";
  from: { version: string | null; commit: string; hash: string };
  to: { version: string | null; commit: string; hash: string };
  added: string[]; removed: string[]; changed: string[];
  /** Each skill whose SKILL.md the update adds, changes or removes, with its sha256 before and after (null: none). */
  skills: Array<{ name: string; from: string | null; to: string | null }>;
  /** The package's files edited since it was installed (the update replaces those it changed or removed), or null. */
  modified: ReturnType<typeof diffTrees> | null;
  /** The files you added to the package's directory (not in its LOCK, not an override.yaml): the update keeps them. */
  kept: string[];
  updated: boolean;
}

/**
 * The files under an installed package's directory that its LOCK doesn't list, an override.yaml aside: the user's, kept
 * by an update. Walked without hashTree's refusals (a link out, a big file), so whatever can't be hashed is still kept.
 */
function userFiles(dir: string, lock: Lock): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const e of readdirSync(rel ? join(dir, rel) : dir).sort()) {
      const r = rel ? `${rel}/${e}` : e;
      if (!rel && (e === LOCK_FILE || OVERRIDE_FILE.test(e))) continue;
      if (lstatSync(join(dir, r)).isDirectory()) walk(r);
      else if (!Object.hasOwn(lock.files, r)) out.push(r);
    }
  };
  walk("");
  return out;
}

/** The file at `abs` is `f` as a LOCK hashes it (same content or link target, same mode). */
function sameFile(abs: string, f: TreeFile): boolean {
  try {
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) return f.mode === "120000" && createHash("sha256").update(readlinkSync(abs)).digest("hex") === f.sha256;
    return f.mode === (st.mode & 0o111 ? "100755" : "100644") && createHash("sha256").update(readFileSync(abs)).digest("hex") === f.sha256;
  } catch { return false; }
}

/**
 * Of the user's files `kept`, those the new package has a file at, or a file where one of them needs a directory, or a
 * directory where one of them is a file: the update can't keep them where they are. Names are compared as macOS's file
 * system does (case and Unicode form folded), so a Notes.md of yours never lands on the package's notes.md.
 */
function clashes(kept: string[], next: Record<string, TreeFile>): string[] {
  const fold = (p: string) => p.normalize("NFC").toLowerCase();
  const files = new Set(Object.keys(next).map(fold));
  const dirs = new Set([...files].flatMap((f) => f.split("/").slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join("/"))));
  return kept.filter((k) => {
    const p = fold(k);
    return files.has(p) || dirs.has(p) || p.split("/").slice(0, -1).some((_, i, a) => files.has(a.slice(0, i + 1).join("/")));
  });
}

/**
 * `capcomd profiles update <name>`: fetch again from the LOCK's source (its ref: a branch moves, a tag or commit
 * doesn't) and report every changed file, each skill's hash and the new content hash; `dryRun` stops there. The
 * package's files are replaced together; an override.yaml and every file the user added beside them (one its LOCK
 * doesn't list) stay, and a new package file in the place of one of those is a conflict. The profiles must still resolve.
 */
export async function updateProfile(name: string, o: { project?: boolean; path?: string; env?: Env; dryRun?: boolean } = {}): Promise<ProfileUpdate> {
  const env = o.env ?? process.env, path = o.path ?? agentsFilePath(env);
  const { dir, layer, lock } = installedPackage(name, { project: o.project, path, env });
  let src: PackageSource;
  try { src = parseSource(lock.source); } catch (e) { return usage(e); }
  const { staging, name: got, lock: next } = await stage(src, dirname(dir), src.name ?? name, env);
  try {
    if (got !== name) throw new RelayError("conflict", `${lock.source} now holds the profile ${got}, not ${name}`, "Install it under its new name.");
    let modified: ReturnType<typeof diffTrees> | null = null;
    try { const t = packageTree(dir); if (t.hash !== lock.hash) modified = diffTrees(lock.files, t.files); } catch { modified = { added: [], removed: [], changed: ["(the package can't be hashed)"] }; }
    const diff = diffTrees(lock.files, next.files);
    const skills = [...new Set([...diff.added, ...diff.removed, ...diff.changed].filter((p) => SKILL_FILE.test(p)))].sort()
      .map((p) => ({ name: SKILL_FILE.exec(p)![1]!, from: lock.files[p] ? `sha256:${lock.files[p]!.sha256}` : null, to: next.files[p] ? `sha256:${next.files[p]!.sha256}` : null }));
    // Files the user added beside the package's are theirs: kept where they are (one the new package ships as it is
    // becomes the package's). One the new package needs the place of is a conflict, before anything changes.
    const kept = userFiles(dir, lock).filter((p) => !(Object.hasOwn(next.files, p) && sameFile(join(dir, p), next.files[p]!)));
    const clash = clashes(kept, next.files);
    if (clash.length) throw new RelayError("conflict", `the update of ${name} needs the place of ${clash.length === 1 ? "a file" : "files"} you added to ${dir}: ${clash.join(", ")}`, "Move them out of the profile's directory (or delete them), then update again; nothing was changed.");
    const out: ProfileUpdate = { name, dir, layer, from: { version: lock.version, commit: lock.commit, hash: lock.hash }, to: { version: next.version, commit: next.commit, hash: next.hash }, ...diff, skills, modified, kept, updated: false };
    const replaces = !!modified && (modified.changed.length > 0 || modified.removed.length > 0);
    if (o.dryRun || (next.hash === lock.hash && !replaces && next.commit === lock.commit)) return out;
    writeLock(staging, next);
    // The user's override and files come along into the new directory once it is in place (never through the staging
    // directory, which goes whatever happens); the old one goes once the profiles resolve with the new.
    const theirs = [...readdirSync(dir).filter((f) => OVERRIDE_FILE.test(f)), ...kept];
    const old = join(dirname(dir), `.old-${name}-${process.pid}-${Date.now()}`);
    const back = (moved: string[]) => {
      for (const f of moved) renameSync(join(dir, f), join(old, f));
      renameSync(dir, staging);
      renameSync(old, dir);
    };
    checkedChange(views(path, env, layer), env, `updating ${name}`, () => {
      renameSync(dir, old);
      try { renameSync(staging, dir); } catch (e) { renameSync(old, dir); throw e; }
      const moved: string[] = [];
      try {
        for (const f of theirs) {
          mkdirSync(dirname(join(dir, f)), { recursive: true });
          renameSync(join(old, f), join(dir, f));
          moved.push(f);
        }
      } catch (e) { back(moved.reverse()); throw e; }
    }, () => back([...theirs].reverse()));
    rmSync(old, { recursive: true, force: true });
    return { ...out, updated: true };
  } finally { rmSync(staging, { recursive: true, force: true }); }
}

/**
 * Remove the installed package `name` (`capcomd profiles rm` of one): its directory and any trust given to its skills.
 * One holding an override.yaml (the user's) is refused, and so is a removal that leaves another profile without its
 * parent.
 */
export function removeInstalledProfile(name: string, o: { project?: boolean; path?: string; env?: Env } = {}): { name: string; dir: string; layer: "project" | "user" } {
  const env = o.env ?? process.env, path = o.path ?? agentsFilePath(env);
  const { dir, layer } = installedPackage(name, { project: o.project, path, env });
  const ov = readdirSync(dir).filter((f) => OVERRIDE_FILE.test(f));
  if (ov.length) throw new RelayError("conflict", `${dir} holds ${ov.join(", ")}, which is yours, not the package's`, "Move or delete it first, then remove the profile.");
  const skills = listSkills(dir);
  const gone = join(dirname(dir), `.removed-${name}-${process.pid}-${Date.now()}`);
  checkedChange(views(path, env, layer), env, `removing ${name}`, () => renameSync(dir, gone), () => renameSync(gone, dir));
  // trust.json held by another change past its wait: the package goes back, so the refusal's "nothing was changed" holds.
  try { for (const s of skills) revokeTrust(PROFILE_TRUST_KIND, s, env); } catch (e) { renameSync(gone, dir); throw e; }
  rmSync(gone, { recursive: true, force: true });
  return { name, dir, layer };
}

/** The SKILL.md files of a package directory, made real as trust keeps them (their trust goes with the package). */
function listSkills(dir: string): string[] {
  try { return readdirSync(join(dir, "skills")).map((n) => join(dir, "skills", n, "SKILL.md")).filter((p) => existsSync(p)).map((p) => realpathSync(p)); } catch { return []; }
}

export interface ExportedProfile { name: string; dir: string; flat: boolean; files: string[]; extends: string | null }

/** A manifest in the schema's order (who it is, then its blocks), as capcomd writes profile files. */
function ordered(doc: ProfileDoc): ProfileDoc {
  const order = Object.keys(PROFILE_JSON_SCHEMA.properties), rank = (k: string) => { const i = order.indexOf(k); return i < 0 ? order.length : i; };
  return Object.fromEntries(Object.entries(doc).sort(([a], [b]) => rank(a) - rank(b)));
}

/**
 * `capcomd profiles export <name>`: the profile as a package directory `<out>/<name>/` to put in a repository (and
 * install from it). Without `flat`, its own files: its package directory as it is (not its LOCK or an override.yaml),
 * or its single file or agents.json entry as a profile.yaml, `extends` kept. With `flat`, what it resolves to: one
 * manifest with its ancestors and overrides laid in, no `extends`, its prompts and persona as files, and every skill it
 * is pinned with from a package in `skills/`. `default` is never exported: which profile is the default is the user's.
 */
export function exportProfile(name: string, o: { out?: string; flat?: boolean; path?: string; env?: Env; cwd?: string } = {}): ExportedProfile {
  const env = o.env ?? process.env, path = o.path ?? agentsFilePath(env);
  let set: ProfileSet;
  try { set = readProfiles(path, env); } catch (e) {
    if (e instanceof AgentConfigError) throw new RelayError("config", `the profiles can't be read: ${e.message}`, "capcomd profiles validate says what is wrong.");
    throw e;
  }
  const r = Object.hasOwn(set.profiles, name) ? set.profiles[name]! : undefined;
  if (!r) throw new RelayError("not_found", `profile "${name}" not found`, "capcomd profiles list");
  const dest = join(resolve(o.cwd ?? process.cwd(), o.out ?? "."), name);
  if (existsSync(dest)) throw new RelayError("conflict", `${dest} already exists`, "Export to another directory (--out DIR), or remove that one first.");
  const files = new Map<string, Buffer | string | { link: string }>();
  const own = r.applied.find((a) => a.as === "profile")!;
  const noDefault = (doc: ProfileDoc) => { const { default: _, ...rest } = doc; return rest; };
  let parent: string | null = null;

  if (o.flat) {
    const doc: ProfileDoc = { ...noDefault(r.manifest) };
    delete doc.extends;
    // The persona, from the directory of the file that named it (first: its name is the manifest's).
    const persona = isMap(doc.identity) ? doc.identity.persona : undefined;
    const by = r.setBy["identity.persona"];
    const from = by === undefined ? null : r.applied[by]?.path;
    if (typeof persona === "string" && from) files.set(persona, readFileSync(join(dirname(from), persona)));
    // Prompts as files when they hold more than a line (or would read as a file's name), else inline; a name the
    // persona has taken gets a prefix.
    if (isMap(doc.prompt)) {
      const prompt = { ...doc.prompt };
      for (const [k, name] of [["system", "system.md"], ["append", "prompt.md"]] as const) {
        const t = prompt[k], file = files.has(name) ? `${k}-${name}` : name;
        if (typeof t === "string" && (t.includes("\n") || LOOKS_LIKE_FILE.test(t))) { files.set(file, t); prompt[k] = file; }
      }
      doc.prompt = prompt;
    }
    // Each skill it is pinned with from a package, into this one's skills/; the user's and capcomd's stay named.
    if (Array.isArray(doc.skills)) doc.skills = doc.skills.map((s) => {
      if (!isMap(s)) return s;
      const pinned = r.skills.find((x) => x.name === s.name && x.path);
      if (!pinned || s.source === "user") return s;
      files.set(`skills/${s.name}/SKILL.md`, pinned.text);
      const { source: _, ...rest } = s;
      return rest;
    });
    files.set("profile.yaml", toYaml(ordered({ schema: PROFILE_SCHEMA, ...doc, name })));
  } else if (r.format === "v2" && own.path && MANIFEST_FILE.test(basename(own.path))) {
    // A package: its files as they are (not LOCK, not the user's override.yaml), its manifest without `default`.
    const dir = dirname(own.path);
    let tree: Record<string, TreeFile>;
    try { tree = hashTree(dir).files; } catch (e) { throw new RelayError("config", `${dir}: ${(e as Error).message}`, "A profile package is a directory of plain files."); }
    for (const [p, f] of Object.entries(tree)) {
      if (OVERRIDE_FILE.test(p)) continue;
      const abs = join(dir, p);
      if (p === basename(own.path)) files.set(p, withoutDefault(readFileSync(abs, "utf8"), p.endsWith(".json")));
      else files.set(p, f.mode === "120000" ? { link: readlinkSync(abs) } : readFileSync(abs));
    }
    const ext = readManifestOf(own.path).extends;
    parent = typeof ext === "string" ? ext : null;
  } else if (r.format === "v2" && own.path) {
    // A single file (<name>.yaml): it becomes the package's profile.yaml.
    const json = own.path.endsWith(".json");
    files.set(json ? "profile.json" : "profile.yaml", withoutDefault(readFileSync(own.path, "utf8"), json));
    const ext = readManifestOf(own.path).extends;
    parent = typeof ext === "string" ? ext : null;
  } else {
    // An agents.json entry (or a bundled profile): its v2 manifest.
    const doc = r.format === "v1" ? fromFlat(name, r.spec) : (BUNDLED_PROFILES[name] ?? r.manifest);
    files.set("profile.yaml", toYaml(ordered({ schema: PROFILE_SCHEMA, ...noDefault(doc), name })));
    parent = typeof doc.extends === "string" ? doc.extends : null;
  }

  // Written beside the destination first, then renamed into place: never half a package.
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = join(dirname(dest), `.${name}.export-${process.pid}`);
  rmSync(tmp, { recursive: true, force: true });
  try {
    for (const [p, body] of files) {
      const to = join(tmp, p);
      mkdirSync(dirname(to), { recursive: true });
      if (typeof body === "object" && !Buffer.isBuffer(body)) symlinkSync(body.link, to); else writeFileSync(to, body);
    }
    renameSync(tmp, dest);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
  return { name, dir: dest, flat: !!o.flat, files: [...files.keys()].sort(), extends: parent };
}

/** A manifest file's text without its `default` (a YAML file keeps its comments and layout). */
function withoutDefault(text: string, json: boolean): string {
  if (json) { const d = JSON.parse(text) as ProfileDoc; if (!("default" in d)) return text; delete d.default; return JSON.stringify(d, null, 2) + "\n"; }
  const doc = parseDocument(text);
  if (!doc.has("default")) return text;
  doc.delete("default");
  return String(doc);
}

function readManifestOf(path: string): ProfileDoc {
  try { const text = readFileSync(path, "utf8"); const d = path.endsWith(".json") ? JSON.parse(text) : parseYaml(text); return isMap(d) ? d : {}; } catch { return {}; }
}
