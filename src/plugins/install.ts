// Installing, updating, removing and trusting third-party plugins (docs/spec/plugin-api.md §4.4, §4.8, §17.2 step 12).
//
//  - A user's plugin is installed from a git repository into <home>/plugins/<name>/ with a LOCK (source, commit, every
//    file's sha256 and the content hash: src/install/lock.ts). The daemon runs it out of process (§9) from its next
//    start, or after `enable`. Only a `process` plugin installs (a third-party plugin never runs in process, §5.2), only
//    one whose manifest passes §4.9 (a path that leaves its directory is refused), and only one the running capcomd is
//    in `engines` for, unless the operator exempted that exact version (`allow-version`, <home>/plugins/compatibility.json).
//  - A project's plugins are `.capcomd/plugins/<name>/` in the checkout, or the project config's `plugins.use` entries,
//    fetched by `capcomd plugins install --project` into the user's home (<home>/plugins/.project/<key>/<name>/, never the
//    checkout). Neither runs until the operator trusts its content hash (`capcomd plugins trust <name>`,
//    src/install/trust.ts): opening a repository runs no code on the host. A changed file is a changed hash, and the
//    plugin waits for trust again.
//  - `update` fetches again from the LOCK's source and reports what changed (files, hash, commit) before replacing it.
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { RelayError } from "../core/errors";
import { readManifest } from "../../packages/plugin/src/load";
import { SEMVER_PATTERN, type PluginManifest } from "../../packages/plugin/src/manifest";
import { capcomdHome, stateDir } from "../utils/home";
import { VERSION } from "../utils/self";
import { projectConfigPath, readConfig, writeConfig } from "../config/store";
import { projectDirOf } from "../config/projects";
import { fetchPackage, keyOf, FetchError } from "../install/fetch";
import { diffTrees, hashTree, inside, lockState, readLock, writeLock, LOCK_SCHEMA, TreeError, type Lock } from "../install/lock";
import { parseSource, SourceError, type PackageSource } from "../install/source";
import { recordTrust, revokeTrust, trustState } from "../install/trust";
import { BUILTINS } from "./builtins";

type Env = Record<string, string | undefined>;
const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };

/** <home>/plugins: the user's plugins (§4.8 step 2). */
export const userPluginsDir = (env: Env = process.env) => join(capcomdHome(env), "plugins");
/** Where a project's `plugins.use` entries are fetched to: the user's home, keyed by the project's directory. */
export const projectCacheDir = (project: string, env: Env = process.env) => join(userPluginsDir(env), ".project", keyOf(project));
/** The project the daemon (or this command) works in: the checkout with the nearest .capcomd/config.json. */
export const projectOf = (cwd = process.cwd(), env: Env = process.env) => projectDirOf(cwd, env);

// ---- allow-version (§4.4) ----------------------------------------------------------------------------------------

export const compatibilityPath = (env: Env = process.env) => join(userPluginsDir(env), "compatibility.json");
type Exemption = { name: string; version: string; at: string; by: string };

function exemptions(env: Env): Exemption[] {
  try {
    const d = JSON.parse(readFileSync(compatibilityPath(env), "utf8")) as { allow?: unknown };
    return Array.isArray(d.allow) ? (d.allow as Exemption[]).filter((e) => e && typeof e.name === "string" && typeof e.version === "string") : [];
  } catch { return []; }
}

/** The operator exempted exactly `name@version` from the `engines` check (§4.4). */
export const isExempt = (name: string, version: string, env: Env = process.env) => exemptions(env).some((e) => e.name === name && e.version === version);

/** `capcomd plugins allow-version <name@version> --accept-risk`: that version only, never a range. */
export function allowVersion(spec: string, o: { acceptRisk: boolean; by?: string; env?: Env }): Exemption {
  const env = o.env ?? process.env;
  const at = spec.lastIndexOf("@");
  const name = spec.slice(0, at), version = spec.slice(at + 1);
  if (at <= 0 || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(name) || !new RegExp(SEMVER_PATTERN).test(version))
    throw new RelayError("usage", `not <name>@<version>: ${JSON.stringify(spec).slice(0, 100)}`, "Name one exact version, e.g. capcomd plugins allow-version slack-notifier@1.2.0 --accept-risk.");
  if (!o.acceptRisk) throw new RelayError("usage", `allowing ${name}@${version} runs it on a capcomd it wasn't tested with`, "Pass --accept-risk to record the exemption for that exact version.");
  const e: Exemption = { name, version, at: new Date().toISOString(), by: o.by ?? "operator" };
  mkdirSync(userPluginsDir(env), { recursive: true, mode: 0o700 });
  writeFileSync(compatibilityPath(env), JSON.stringify({ schema: "capcomd.compatibility/v1", allow: [...exemptions(env).filter((x) => !(x.name === name && x.version === version)), e] }, null, 2) + "\n", { mode: 0o600 });
  return e;
}

// ---- fetching a plugin --------------------------------------------------------------------------------------------

const usage = (e: unknown): never => {
  if (e instanceof SourceError) throw new RelayError("usage", e.message, "A source is owner/repo[#name][@ref], a git URL or a local repository path, with the same #name and @ref.");
  if (e instanceof FetchError || e instanceof TreeError) throw new RelayError("run_failed", e.message, "Check the source and the ref; the package must be a directory of plain files.");
  throw e;
};

/** The plugin directory in a repository's tree: the one named `#name`, else the root's plugin.json, else the only one. */
function pickPlugin(want: string | null) {
  return (paths: string[], read: (p: string) => string | null): string => {
    const found: Array<{ dir: string; name: string }> = [];
    for (const p of paths) {
      if (!(p === "plugin.json" || p.endsWith("/plugin.json")) || p.includes("node_modules/")) continue;
      let m: { schema?: unknown; name?: unknown } | null = null;
      try { m = JSON.parse(read(p) ?? "null"); } catch { /* not a manifest */ }
      if (m && m.schema === "capcomd.plugin/v1" && typeof m.name === "string") found.push({ dir: p === "plugin.json" ? "" : p.slice(0, -"/plugin.json".length), name: m.name });
    }
    if (want) {
      const named = found.filter((f) => f.name === want);
      if (named.length === 1) return named[0]!.dir;
      if (named.length > 1) throw new FetchError(`the repository has ${named.length} plugins named ${want}: ${named.map((f) => f.dir || "(root)").join(", ")}`);
      throw new FetchError(`the repository has no plugin named ${want}${found.length ? ` (it has ${found.map((f) => f.name).join(", ")})` : ""}`);
    }
    const root = found.find((f) => f.dir === "");
    if (root) return "";
    if (found.length === 1) return found[0]!.dir;
    throw new FetchError(found.length ? `the repository has several plugins: name one with #<name> (${found.map((f) => f.name).join(", ")})` : "the repository has no capcomd plugin (a plugin.json with schema capcomd.plugin/v1)");
  };
}

/** §4.9 and the install rules on a fetched directory: the manifest, `process` only, not a built-in's name. */
function checkPlugin(dir: string, want: string | null, env: Env): PluginManifest {
  let loaded = readManifest(dir, { capcomd: VERSION });
  if (!loaded.ok && loaded.cause === "incompatible" && loaded.manifest && isExempt(loaded.manifest.name, loaded.manifest.version, env)) loaded = readManifest(dir, { capcomd: VERSION, exempt: true });
  if (!loaded.ok) {
    const what = loaded.issues.map((i) => `${i.path}: ${i.message}`).join("; ");
    if (loaded.cause === "incompatible" && loaded.manifest) throw new RelayError("config", `${loaded.manifest.name}@${loaded.manifest.version} doesn't support capcomd ${VERSION}: ${what}`, `Install a version that does, or record an exemption: capcomd plugins allow-version ${loaded.manifest.name}@${loaded.manifest.version} --accept-risk.`, { code: "incompatible" });
    throw new RelayError("config", `its manifest is refused: ${what}`, "Run capcomd plugins validate on the plugin's directory for the full list.", { code: "invalid_manifest" });
  }
  const m = loaded.manifest;
  if (want && m.name !== want) throw new RelayError("config", `the plugin in that directory is ${m.name}, not ${want}`, "Name it by the name in its plugin.json.");
  if (m.entry.runtime !== "process") throw new RelayError("config", `${m.name} runs in process: only capcomd's built-in plugins do (plugin API §5.2)`, "A third-party plugin runs as its own process (entry.runtime: process).", { code: "untrusted" });
  if (BUILTINS.some((b) => (b.manifest as { name: string }).name === m.name)) throw new RelayError("conflict", `${m.name} is one of capcomd's built-in plugins`, "A plugin can't take a built-in's name.");
  return m;
}

const lockOf = (m: PluginManifest, src: PackageSource, fetched: { commit: string; path: string }, tree: ReturnType<typeof hashTree>): Lock => ({
  schema: LOCK_SCHEMA, kind: "plugin", name: m.name, version: m.version, source: src.spec, remote: src.remote, ref: src.ref,
  commit: fetched.commit, path: fetched.path, installedAt: new Date().toISOString(), files: tree.files, hash: tree.hash,
});

/** Fetch `src` into a fresh directory under `parent` and check it; the caller moves it into place or removes it. */
async function stage(src: PackageSource, parent: string, want: string | null, env: Env): Promise<{ staging: string; manifest: PluginManifest; lock: Lock }> {
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const staging = join(parent, `.staging-${process.pid}-${Math.random().toString(36).slice(2, 10)}`);
  try {
    const fetched = await fetchPackage(src, { workdir: join(stateDir(env), "installs"), into: staging, pick: pickPlugin(want) }).catch(usage);
    const manifest = checkPlugin(staging, want, env);
    let tree: ReturnType<typeof hashTree>;
    try { tree = hashTree(staging); } catch (e) { return usage(e); }
    return { staging, manifest, lock: lockOf(manifest, src, fetched, tree) };
  } catch (e) {
    rmSync(staging, { recursive: true, force: true });
    throw e;
  }
}

export interface Installed { name: string; version: string; source: string; commit: string; hash: string; dir: string; project: string | null }

/**
 * `capcomd plugins install <source>`: the user's plugin, or with `project` one of that project's `plugins.use` (the
 * source is added to the list). A plugin of that name already there is a conflict: `update` replaces one.
 */
export async function installPlugin(spec: string, o: { env?: Env; cwd?: string; project?: string | null } = {}): Promise<Installed> {
  const env = o.env ?? process.env;
  let src: PackageSource;
  try { src = parseSource(spec, o.cwd); } catch (e) { return usage(e); }
  const parent = o.project ? projectCacheDir(o.project, env) : userPluginsDir(env);
  const { staging, manifest, lock } = await stage(src, parent, src.name, env);
  const dest = join(parent, manifest.name);
  try {
    if (existsSync(dest)) throw new RelayError("conflict", `${manifest.name} is already installed${o.project ? " for this project" : ""}`, `Update it with capcomd plugins update ${manifest.name}${o.project ? " --project" : ""}, or remove it first.`);
    if (o.project && existsSync(join(o.project, ".capcomd", "plugins", manifest.name))) throw new RelayError("conflict", `the project has its own plugin ${manifest.name} (.capcomd/plugins/${manifest.name})`, "Two plugins can't share a name.");
    writeLock(staging, lock);
    renameSync(staging, dest);
  } finally { rmSync(staging, { recursive: true, force: true }); }
  if (o.project) useInProject(o.project, lock.source, env);
  return { name: manifest.name, version: manifest.version, source: lock.source, commit: lock.commit, hash: lock.hash, dir: dest, project: o.project ?? null };
}

/** The project's `plugins.use` (§4.8 step 3), as its config lists it. */
export function projectUses(project: string, env: Env = process.env): string[] {
  const use = (readConfig(projectConfigPath(project, env)).plugins as Record<string, unknown> | undefined)?.use;
  return Array.isArray(use) ? use.filter((u): u is string => typeof u === "string") : [];
}

function useInProject(project: string, source: string, env: Env) {
  const path = projectConfigPath(project, env) ?? join(project, ".capcomd", "config.json");
  const cur = readConfig(path);
  const uses = projectUses(project, env);
  if (uses.some((u) => { try { return parseSource(u, project).spec === source; } catch { return false; } })) return;
  writeConfig(path, { plugins: { ...(cur.plugins ?? {}), use: [...uses, source] } as never });
}

/** `capcomd plugins install --project`: fetch every `plugins.use` entry the user's home doesn't hold yet. */
export async function installProjectUses(project: string, o: { env?: Env } = {}): Promise<Array<Installed | { source: string; error: string } | { source: string; present: string }>> {
  const env = o.env ?? process.env;
  const out: Array<Installed | { source: string; error: string } | { source: string; present: string }> = [];
  const have = cachedUses(project, env);
  for (const u of projectUses(project, env)) {
    let spec: string;
    try { spec = parseSource(u, project).spec; } catch (e) { out.push({ source: u, error: (e as Error).message }); continue; }
    const hit = have.find((h) => h.lock.source === spec);
    if (hit) { out.push({ source: u, present: hit.lock.name }); continue; }
    try { out.push(await installPlugin(u, { env, cwd: project, project })); } catch (e) { out.push({ source: u, error: (e as Error).message }); }
  }
  return out;
}

/** The `plugins.use` entries fetched for `project`: their directories and LOCKs. */
export function cachedUses(project: string, env: Env = process.env): Array<{ dir: string; lock: Lock }> {
  const parent = projectCacheDir(project, env);
  let names: string[] = [];
  try { names = readdirSync(parent).sort(); } catch { return []; }
  return names.filter((n) => !n.startsWith(".")).flatMap((n) => { const lock = readLock(join(parent, n)); return lock ? [{ dir: join(parent, n), lock }] : []; });
}

// ---- update and remove --------------------------------------------------------------------------------------------

export interface Updated {
  name: string;
  from: { version: string | null; commit: string; hash: string };
  to: { version: string; commit: string; hash: string };
  added: string[]; removed: string[]; changed: string[];
  /** Files changed on disk since the LOCK (an edit the update replaces), or null when there were none. */
  modified: { added: string[]; removed: string[]; changed: string[] } | null;
  updated: boolean;
}

/** The installed plugin `name`: the user's, or with `project` that project's fetched `plugins.use` one. */
function installedDir(name: string, o: { env: Env; project: string | null }): string {
  const dir = join(o.project ? projectCacheDir(o.project, o.env) : userPluginsDir(o.env), name);
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name) || !existsSync(join(dir, "plugin.json"))) {
    const vendored = o.project && existsSync(join(o.project, ".capcomd", "plugins", name, "plugin.json"));
    throw new RelayError("not_found", `no plugin ${name} installed${o.project ? " for this project" : ""}`, vendored ? `${name} is the project's own (.capcomd/plugins/${name}): it changes with the repository.` : "List them with capcomd plugins list.");
  }
  return dir;
}

/**
 * `capcomd plugins update <name>`: fetch again from the LOCK's source (its ref: a branch moves, a tag or commit
 * doesn't) and report every changed file and the new hash; `dryRun` stops there. The daemon runs the new code from its
 * next start or `enable`; a project's plugin needs trusting again (its hash changed).
 */
export async function updatePlugin(name: string, o: { env?: Env; project?: string | null; dryRun?: boolean } = {}): Promise<Updated> {
  const env = o.env ?? process.env;
  const dir = installedDir(name, { env, project: o.project ?? null });
  const lock = readLock(dir);
  if (!lock) throw new RelayError("config", `${name} has no LOCK: capcomd didn't install it`, `Remove it and install it from its repository (capcomd plugins install <owner/repo>#${name}).`);
  let src: PackageSource;
  try { src = parseSource(lock.source); } catch (e) { return usage(e); }
  const parent = o.project ? projectCacheDir(o.project, env) : userPluginsDir(env);
  const { staging, manifest, lock: next } = await stage(src, parent, src.name ?? name, env);
  try {
    if (manifest.name !== name) throw new RelayError("conflict", `${lock.source} now holds ${manifest.name}, not ${name}`, "Install it under its new name.");
    const disk = lockState(dir);
    const modified = disk && "diff" in disk && disk.modified ? disk.diff : null;
    const out: Updated = { name, from: { version: lock.version, commit: lock.commit, hash: lock.hash }, to: { version: manifest.version, commit: next.commit, hash: next.hash }, ...diffTrees(lock.files, next.files), modified, updated: false };
    if (o.dryRun || (next.hash === lock.hash && !modified && next.commit === lock.commit)) return out;
    writeLock(staging, next);
    const old = join(parent, `.old-${name}-${process.pid}-${Date.now()}`);
    renameSync(dir, old);
    try { renameSync(staging, dir); } catch (e) { renameSync(old, dir); throw e; }
    rmSync(old, { recursive: true, force: true });
    return { ...out, updated: true };
  } finally { rmSync(staging, { recursive: true, force: true }); }
}

/** `capcomd plugins remove <name>`: its files and any trust given to them; its data (<home>/state/plugins/<name>) stays. */
export function removePlugin(name: string, o: { env?: Env; project?: string | null } = {}): { name: string; dir: string; project: string | null } {
  const env = o.env ?? process.env;
  const dir = installedDir(name, { env, project: o.project ?? null });
  const lock = readLock(dir);
  revokeTrust("plugin", dir, env);
  rmSync(dir, { recursive: true, force: true });
  if (o.project && lock) {
    const path = projectConfigPath(o.project, env);
    const uses = projectUses(o.project, env);
    const kept = uses.filter((u) => { try { return parseSource(u, o.project!).spec !== lock.source; } catch { return true; } });
    if (path && kept.length !== uses.length) writeConfig(path, { plugins: { ...(readConfig(path).plugins ?? {}), use: kept } as never });
  }
  return { name, dir, project: o.project ?? null };
}

// ---- the project's plugins and trust (§4.8 step 3) ----------------------------------------------------------------

export interface ProjectPlugin {
  name: string;
  dir: string;
  /** `vendored`: the checkout's .capcomd/plugins/<name>; `use`: a `plugins.use` entry fetched to the user's home. */
  from: "vendored" | "use";
  manifest: PluginManifest | null;
  issues: string[];
  hash: string | null;
  trust: "trusted" | "changed" | "untrusted";
  trustedHash: string | null;
}

/** The directories of `project`'s plugins: its own `.capcomd/plugins/<name>/` in name order, then (with `uses`) its
 *  `plugins.use` entries fetched to the user's home, in the list's order. */
export function projectPluginDirs(project: string, env: Env = process.env, uses = true): string[] {
  return projectPluginSources(project, env, uses).map((d) => d.dir);
}

function projectPluginSources(project: string, env: Env, uses: boolean): Array<{ dir: string; from: ProjectPlugin["from"] }> {
  const dirs: Array<{ dir: string; from: ProjectPlugin["from"] }> = [];
  const own = join(project, ".capcomd", "plugins");
  let names: string[] = [];
  try { names = readdirSync(own).sort(); } catch { /* none */ }
  // Only a directory that really is in the checkout: trust goes to a place made real (src/install/trust.ts), so a link
  // to a plugin another project holds would bring that project's trust here.
  const checkout = real(project);
  for (const n of names) if (!n.startsWith(".") && existsSync(join(own, n, "plugin.json")) && inside(checkout, real(join(own, n)))) dirs.push({ dir: join(own, n), from: "vendored" });
  if (uses) {
    const cached = cachedUses(project, env);
    for (const u of projectUses(project, env)) {
      let spec: string;
      try { spec = parseSource(u, project).spec; } catch { continue; }
      const hit = cached.find((c) => c.lock.source === spec);
      if (hit && !dirs.some((d) => d.dir === hit.dir)) dirs.push({ dir: hit.dir, from: "use" });
    }
  }
  return dirs;
}

/** Every plugin of `project`, with its content hash and whether the operator trusts it. */
export function projectPluginList(project: string, env: Env = process.env, uses = !env.CAPCOMD_NO_CONFIG): ProjectPlugin[] {
  return projectPluginSources(project, env, uses).map(({ dir, from }) => {
    const loaded = readManifest(dir, { capcomd: VERSION });
    const manifest = loaded.manifest;
    let hash: string | null = null;
    const issues = loaded.ok ? [] : loaded.issues.map((i) => `${i.path}: ${i.message}`);
    try { hash = trustHash(dir, env); } catch (e) { issues.push((e as Error).message); }
    const t = hash ? trustState("plugin", dir, hash, env) : { state: "untrusted" as const, entry: null };
    return { name: manifest?.name ?? dir.split("/").pop()!, dir, from, manifest, issues, hash, trust: t.state, trustedHash: t.entry?.hash ?? null };
  });
}

/** The hash a project plugin is trusted by: every file of it. Only a `plugins.use` copy in the user's home leaves out
 *  the LOCK capcomd wrote there; a checkout's `LOCK` is the project's file like any other (`command: ["sh", "LOCK"]`). */
function trustHash(dir: string, env: Env): string {
  return hashTree(dir, { withLock: !inside(real(userPluginsDir(env)), real(dir)) }).hash;
}

/** Whether the project plugin at `dir` may run: its content now is exactly what the operator trusted. */
export function projectPluginTrusted(dir: string, env: Env = process.env): { trusted: boolean; hash: string | null } {
  let hash: string | null = null;
  try { hash = trustHash(dir, env); } catch { return { trusted: false, hash: null }; }
  return { trusted: trustState("plugin", dir, hash, env).state === "trusted", hash };
}

/** `capcomd plugins trust <name>`: trust the project plugin's content as it is now (its hash). */
export function trustPlugin(name: string, o: { project: string; env?: Env; by?: string; hash?: string }): ProjectPlugin {
  const env = o.env ?? process.env;
  const p = projectPluginList(o.project, env).find((x) => x.name === name);
  if (!p) throw new RelayError("not_found", `this project has no plugin ${name}`, "Its plugins are .capcomd/plugins/<name>/ and the `plugins.use` entries fetched with capcomd plugins install --project.");
  if (!p.hash) throw new RelayError("config", `${name} can't be trusted: ${p.issues.join("; ")}`, "Fix the plugin's files first.");
  if (o.hash && o.hash !== p.hash) throw new RelayError("conflict", `${name} changed since it was shown (now ${p.hash})`, "Look at it again and trust what is there now.");
  recordTrust({ kind: "plugin", name, dir: p.dir, hash: p.hash, by: o.by ?? "operator" }, env);
  return { ...p, trust: "trusted", trustedHash: p.hash };
}
