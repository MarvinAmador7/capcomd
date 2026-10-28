// Where the Rivet engine keeps its data, and the guards around it (docs/durability.md → "Engine data").
//
// Every engine capcomd starts keeps everything under capcomd's own home (`~/.capcomd`, or $CAPCOMD_HOME), one
// directory per port:
//
//   <home>/engine/<port>/db                    the engine's RocksDB (RIVET__FILE_SYSTEM__PATH, set by engine-wrapper.sh)
//   <home>/engine/<port>/engine.pid            the running engine's pid (engine-wrapper.sh writes it)
//   <home>/engine/<port>/engine-version.json   the engine version that last opened db (capcomd writes it)
//   <home>/engine/<port>/backups/<v>-<UTC>/    db/ and engine-version.json as they were before an engine of another
//                                              version opened it (newest 3)
//   <home>/engine/<port>/migrated-from-rivetkit.json   the one-time copy from ~/.rivetkit (6420 only)
//   <home>/engine/<port>/.rivetkit/            rivetkit's own engine logs and runtime stamp (RIVETKIT_STORAGE_PATH)
//
// so a capcomd install never reads or writes rivetkit's shared default `~/.rivetkit`, which any other rivetkit
// project on the machine also uses (a newer one stamps the db and the pinned engine then refuses to open it).
import { spawnSync } from "child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import { homedir } from "os";
import { basename, join } from "path";
import { capcomdHome } from "../utils/home";

type Env = Record<string, string | undefined>;
export const DEFAULT_PORT = 6420;
export const KEEP_BACKUPS = 3;

/** The data dir for an engine on `port`: CAPCOMD_ENGINE_DATA (or the chaos harness's) wins, else <home>/engine/<port>. */
export function engineDataDir(port: number, env: Env = process.env): string {
  return env.CAPCOMD_ENGINE_DATA ?? env.CAPCOMD_CHAOS_ENGINE_DATA ?? join(capcomdHome(env), "engine", String(port));
}

/** True when the data dir is capcomd's default for the port (no explicit override). */
export const isDefaultDataDir = (env: Env = process.env) => !env.CAPCOMD_ENGINE_DATA && !env.CAPCOMD_CHAOS_ENGINE_DATA;

export const dbDir = (data: string) => join(data, "db");
export const pidFileOf = (data: string) => join(data, "engine.pid");
export const versionFileOf = (data: string) => join(data, "engine-version.json");
export const backupsDirOf = (data: string) => join(data, "backups");
export const migrationMarkerOf = (data: string) => join(data, "migrated-from-rivetkit.json");

/** Where rivetkit itself kept the default engine's db before capcomd had its own: $HOME/.rivetkit/var/engine/db. */
export function legacyRivetkitDb(env: Env = process.env): string {
  return join(env.HOME || homedir(), ".rivetkit", "var", "engine", "db");
}

/** Before this layout, the pid file of a non-default port lived at <home>/engine/<port>.pid. */
export const legacyPidFile = (port: number, env: Env = process.env) => join(capcomdHome(env), "engine", `${port}.pid`);

/** The engine binary's version (`rivet-engine --version` prints "Rivet 2.3.31"), or null when it can't say. */
export function engineVersionOf(binary: string): string | null {
  const r = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] });
  const m = /Rivet\s+v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(`${r.stdout ?? ""}\n${r.stderr ?? ""}`);
  return m ? m[1]! : null;
}

/** Files (recursively) and their total bytes. */
export function treeStats(dir: string): { files: number; bytes: number } {
  let files = 0, bytes = 0;
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) { files++; bytes += statSync(p).size; }
    }
  };
  if (existsSync(dir)) walk(dir);
  return { files, bytes };
}

const hasData = (db: string) => existsSync(db) && readdirSync(db).length > 0;

/**
 * Pids of processes that have a file in `dir` open (an engine holds its RocksDB LOCK and files open for its whole
 * life), or null when that can't be told (lsof failed and there's no /proc): callers then refuse rather than guess.
 * `lsof +d` on macOS (and Linux when it has lsof), /proc/<pid>/fd on Linux otherwise. Our own pid is left out.
 */
export function holdersOf(path: string): number[] | null {
  if (!existsSync(path)) return [];
  const dir = realpathSync(path); // lsof and /proc report resolved paths (/var → /private/var on macOS)
  const found = new Set<number>();
  // Open files only: not a shell whose working directory happens to be there.
  const lsof = spawnSync("lsof", ["-a", "-d", "^cwd,^rtd,^txt", "-t", "+d", dir], { encoding: "utf8", timeout: 20_000 });
  if (!lsof.error && lsof.signal === null) {
    for (const l of (lsof.stdout ?? "").split("\n")) { const n = Number(l.trim()); if (n > 0) found.add(n); }
  } else if (existsSync("/proc")) {
    const prefix = `${dir}/`;
    for (const p of readdirSync("/proc")) {
      if (!/^\d+$/.test(p)) continue;
      let fds: string[] = [];
      try { fds = readdirSync(`/proc/${p}/fd`); } catch { continue; }
      for (const fd of fds) {
        let target = "";
        try { target = readlinkSync(`/proc/${p}/fd/${fd}`); } catch {}
        if (target === dir || target.startsWith(prefix)) { found.add(Number(p)); break; }
      }
    }
  } else return null;
  found.delete(process.pid);
  return [...found];
}

/** "process 1234" / "processes 1, 2", or why we couldn't tell. */
export const describeHolders = (held: number[] | null) => held === null ? "possibly another process (lsof couldn't check)" : `process${held.length > 1 ? "es" : ""} ${held.join(", ")}`;

export type MigrationResult =
  | { action: "none"; reason: string }
  | { action: "copied"; from: string; to: string; files: number; bytes: number; message: string }
  | { action: "refused"; message: string };

/**
 * The one-time copy of rivetkit's shared default db into capcomd's own data dir, for an engine on the default port
 * when capcomd's dir has no db yet. Copies (never moves or deletes) into a temporary dir, checks that nothing opened
 * the source meanwhile and that the copy matches it (files, bytes), then renames it into place and writes a marker;
 * the source is left as it was. Refuses while any process holds the source open (an engine still running on it), or
 * when that can't be told. Idempotent: once the marker exists it never copies again.
 */
export function migrateLegacyEngineData(o: {
  dataDir: string; legacyDb: string; engineVersion?: string | null; capcomdVersion?: string;
  holders?: (dir: string) => number[] | null; now?: () => Date;
}): MigrationResult {
  const db = dbDir(o.dataDir);
  const marker = migrationMarkerOf(o.dataDir);
  const holders = o.holders ?? holdersOf;
  if (existsSync(marker)) return { action: "none", reason: "already copied" };
  if (hasData(db)) return { action: "none", reason: "capcomd's data dir already has a db" };
  if (!hasData(o.legacyDb)) return { action: "none", reason: "no rivetkit db to copy" };
  const refuse = (held: number[] | null) => ({ action: "refused" as const, message: `capcomd now keeps its engine data in ${db}, but the old data in ${o.legacyDb} is open by ${describeHolders(held)} (an engine still running on it?): stop that engine (or the old capcomd serve) and start capcomd again to copy it.` });
  const held = holders(o.legacyDb);
  if (held === null || held.length) return refuse(held);
  mkdirSync(o.dataDir, { recursive: true });
  const tmp = join(o.dataDir, `db.copying-${process.pid}`);
  rmSync(tmp, { recursive: true, force: true });
  let copied: { files: number; bytes: number };
  try {
    cpSync(o.legacyDb, tmp, { recursive: true, preserveTimestamps: true, errorOnExist: true, force: false });
    // Nothing may have opened it meanwhile, and the copy must match it file for file.
    const late = holders(o.legacyDb);
    if (late === null || late.length) { rmSync(tmp, { recursive: true, force: true }); return refuse(late); }
    copied = treeStats(tmp);
    const source = treeStats(o.legacyDb);
    if (copied.files !== source.files || copied.bytes !== source.bytes) throw new Error(`the copy doesn't match the source (source ${source.files} files/${source.bytes} bytes, copy ${copied.files}/${copied.bytes}); was something writing to it?`);
    if (hasData(db)) throw new Error(`${db} appeared while copying`);
    rmSync(db, { recursive: true, force: true }); // an empty dir only (hasData was false)
    renameSync(tmp, db);
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    return { action: "refused", message: `capcomd couldn't copy its engine data from ${o.legacyDb} to ${db}: ${(e as Error).message}. Nothing was changed; the old data is untouched.` };
  }
  const at = (o.now ?? (() => new Date()))().toISOString();
  writeFileSync(marker, JSON.stringify({ source: o.legacyDb, copiedTo: db, copiedAt: at, files: copied.files, bytes: copied.bytes,
    engineVersion: o.engineVersion ?? null, capcomdVersion: o.capcomdVersion ?? null, sourceLeftUntouched: true }, null, 2) + "\n");
  return { action: "copied", from: o.legacyDb, to: db, files: copied.files, bytes: copied.bytes,
    message: `capcomd now keeps its engine data in ${db}: copied ${copied.files} files (${(copied.bytes / 1048576).toFixed(1)} MB) from ${o.legacyDb}, which is left untouched.` };
}

export interface VersionRecord { version: string; openedAt: string; capcomdVersion?: string | null }

export function readVersionRecord(dataDir: string): VersionRecord | null {
  try { const r = JSON.parse(readFileSync(versionFileOf(dataDir), "utf8")); return typeof r?.version === "string" ? r : null; } catch { return null; }
}

/** UTC timestamp safe in a file name: 2026-10-27T21-44-05Z. */
export const stamp = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-");

/** Backups, newest first (names are <version>-<UTC stamp>; the stamp orders them). */
export function listBackups(dataDir: string): string[] {
  const dir = backupsDirOf(dataDir);
  if (!existsSync(dir)) return [];
  const key = (n: string) => /(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z)$/.exec(n)?.[1] ?? "";
  return readdirSync(dir).filter((n) => key(n)).sort((a, b) => (key(b) > key(a) ? 1 : key(b) < key(a) ? -1 : b.localeCompare(a))).map((n) => join(dir, n));
}

export type PrepareResult =
  | { action: "fresh" | "same" | "unknown-engine" }
  | { action: "backed-up"; from: string; backup: string; message: string }
  | { action: "already-backed-up"; from: string; backup: string }
  | { action: "refused"; message: string };

/**
 * Before an engine of `engineVersion` opens the db in `dataDir`:
 *  - no db yet, or the same version last opened it: nothing to do;
 *  - a NEWER engine last opened it: refuse (the engine would refuse too: it stamps its version into the db and
 *    won't open one stamped newer), naming both versions and the newest backup;
 *  - another (older, or unrecorded) version: copy db (and its version record) to backups/<old>-<UTC>/ first, keeping
 *    the newest `keep`; not again while that backup is newer than the record (an engine that never came up).
 * Writes nothing else: the version is recorded once the engine answers (recordEngineVersion).
 */
export function prepareEngineData(o: { dataDir: string; engineVersion: string | null; keep?: number; now?: () => Date }): PrepareResult {
  const engineVersion = o.engineVersion;
  if (!engineVersion) return { action: "unknown-engine" };
  const db = dbDir(o.dataDir);
  const record = readVersionRecord(o.dataDir);
  if (!hasData(db)) return { action: "fresh" };
  if (record && record.version === engineVersion) return { action: "same" };
  if (record && Bun.semver.order(record.version, engineVersion) > 0) {
    const newest = listBackups(o.dataDir)[0];
    return { action: "refused", message: `the engine data in ${db} was last opened by Rivet engine ${record.version}, newer than this capcomd's ${engineVersion}, which can't open it (Rivet refuses to roll an engine back): run the newer capcomd, or stop capcomd and restore ${newest ? `the newest backup's db/ and engine-version.json (${newest})` : `a backup of ${db}`} in place of the current ones.` };
  }
  const old = record?.version ?? "unknown";
  const newest = listBackups(o.dataDir)[0];
  if (newest && basename(newest).startsWith(`${old}-`) && basename(newest).slice(old.length + 1) >= stamp(new Date(record?.openedAt ?? 0))) return { action: "already-backed-up", from: old, backup: newest };
  const now = (o.now ?? (() => new Date()))();
  const backups = backupsDirOf(o.dataDir);
  const dest = join(backups, `${old}-${stamp(now)}`);
  const tmp = `${dest}.partial`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  cpSync(db, join(tmp, "db"), { recursive: true, preserveTimestamps: true });
  if (record) cpSync(versionFileOf(o.dataDir), join(tmp, "engine-version.json"));
  renameSync(tmp, dest);
  for (const extra of listBackups(o.dataDir).slice(o.keep ?? KEEP_BACKUPS)) rmSync(extra, { recursive: true, force: true });
  return { action: "backed-up", from: old, backup: dest, message: `engine ${old} → ${engineVersion}: backed up ${db} to ${dest} first (the newest ${o.keep ?? KEEP_BACKUPS} backups are kept).` };
}

/** The engine that just answered on this data dir is the one that last opened it. */
export function recordEngineVersion(dataDir: string, version: string, capcomdVersion?: string, now = new Date()): void {
  mkdirSync(dataDir, { recursive: true });
  const tmp = `${versionFileOf(dataDir)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version, openedAt: now.toISOString(), capcomdVersion: capcomdVersion ?? null } satisfies VersionRecord, null, 2) + "\n");
  renameSync(tmp, versionFileOf(dataDir));
}

/** The last lines rivetkit's engine wrote to its newest stderr log here: why an engine didn't come up. */
export function engineLogTail(dataDir: string, lines = 12): string {
  try {
    const dir = join(dataDir, ".rivetkit", "var", "logs", "rivet-engine");
    const newest = readdirSync(dir).filter((n) => n.endsWith("-stderr.log")).sort().pop();
    if (!newest) return "";
    return readFileSync(join(dir, newest), "utf8").trimEnd().split("\n").slice(-lines).join("\n");
  } catch { return ""; }
}
