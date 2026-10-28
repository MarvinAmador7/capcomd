// Where the Rivet engine keeps its data, and the guards around it (docs/durability.md → "Engine data").
//
// Every engine capcomd starts keeps everything under capcomd's own home (`~/.capcomd`, or $CAPCOMD_HOME), one
// directory per port:
//
//   <home>/engine/<port>/db                    the engine's RocksDB (RIVET__FILE_SYSTEM__PATH, set by engine-wrapper.sh)
//   <home>/engine/<port>/engine.pid            the running engine's pid (engine-wrapper.sh writes it)
//   <home>/engine/<port>/engine-version.json   the engine version that last opened db (capcomd writes it)
//   <home>/engine/<port>/backups/<v>-<UTC>/    db as it was before an engine of another version opened it (newest 3)
//   <home>/engine/<port>/migrated-from-rivetkit.json   the one-time copy from ~/.rivetkit (6420 only)
//   <home>/engine/<port>/.rivetkit/            rivetkit's own engine logs and runtime stamp (RIVETKIT_STORAGE_PATH)
//
// so a capcomd install never reads or writes rivetkit's shared default `~/.rivetkit`, which any other rivetkit
// project on the machine also uses (a newer one stamps the db and the pinned engine then refuses to open it).
import { spawnSync } from "child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
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

/** Semver order (pre-releases sort before their release). */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => { const [core, pre] = v.split("-", 2) as [string, string | undefined]; return { nums: core.split(".").map((n) => Number(n) || 0), pre }; };
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) if ((x.nums[i] ?? 0) !== (y.nums[i] ?? 0)) return (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
  if (x.pre === y.pre) return 0;
  if (x.pre === undefined) return 1;
  if (y.pre === undefined) return -1;
  return x.pre < y.pre ? -1 : 1;
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
 * life). `lsof +d` on macOS (and Linux when it has lsof), /proc/<pid>/fd on Linux otherwise. Our own pid is left out.
 */
export function holdersOf(path: string): number[] {
  if (!existsSync(path)) return [];
  const dir = realpathSync(path); // lsof and /proc report resolved paths (/var → /private/var on macOS)
  const found = new Set<number>();
  // Open files only: not a shell whose working directory happens to be there.
  const lsof = spawnSync("lsof", ["-a", "-d", "^cwd,^rtd,^txt", "-t", "+d", dir], { encoding: "utf8", timeout: 20_000 });
  if (!lsof.error) {
    for (const l of (lsof.stdout ?? "").split("\n")) { const n = Number(l.trim()); if (n > 0) found.add(n); }
  } else if (existsSync("/proc")) {
    const prefix = dir.endsWith("/") ? dir : `${dir}/`;
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
  }
  found.delete(process.pid);
  return [...found];
}

export type MigrationResult =
  | { action: "none"; reason: string }
  | { action: "copied"; from: string; to: string; files: number; bytes: number; message: string }
  | { action: "refused"; message: string };

/**
 * The one-time copy of rivetkit's shared default db into capcomd's own data dir, for an engine on the default port
 * when capcomd's dir has no db yet. Copies (never moves or deletes) into a temporary dir, checks the file count and
 * bytes against the source, then renames it into place and writes a marker; the source is left as it was, as a
 * backup. Refuses while any process holds the source open (an engine still running on it). Idempotent: once the
 * marker exists it never copies again.
 */
export function migrateLegacyEngineData(o: {
  dataDir: string; legacyDb: string; engineVersion?: string | null; capcomdVersion?: string;
  holders?: (dir: string) => number[]; now?: () => Date;
}): MigrationResult {
  const db = dbDir(o.dataDir);
  const marker = migrationMarkerOf(o.dataDir);
  if (existsSync(marker)) return { action: "none", reason: "already copied" };
  if (hasData(db)) return { action: "none", reason: "capcomd's data dir already has a db" };
  if (!hasData(o.legacyDb)) return { action: "none", reason: "no rivetkit db to copy" };
  const held = (o.holders ?? holdersOf)(o.legacyDb);
  if (held.length) {
    return { action: "refused", message: `capcomd now keeps its engine data in ${db}, but the old data in ${o.legacyDb} is still open by process${held.length > 1 ? "es" : ""} ${held.join(", ")} (an engine still running on it): stop that engine (or the old capcomd serve) and start capcomd again to copy it.` };
  }
  const before = treeStats(o.legacyDb);
  mkdirSync(o.dataDir, { recursive: true });
  const tmp = join(o.dataDir, `db.copying-${process.pid}`);
  rmSync(tmp, { recursive: true, force: true });
  try {
    cpSync(o.legacyDb, tmp, { recursive: true, preserveTimestamps: true, errorOnExist: true, force: false });
    const copied = treeStats(tmp), after = treeStats(o.legacyDb);
    if (copied.files !== before.files || copied.bytes !== before.bytes || after.files !== before.files || after.bytes !== before.bytes) {
      throw new Error(`the copy doesn't match the source (source ${before.files} files/${before.bytes} bytes, now ${after.files}/${after.bytes}; copy ${copied.files}/${copied.bytes}); was something writing to it?`);
    }
    if (hasData(db)) throw new Error(`${db} appeared while copying`);
    rmSync(db, { recursive: true, force: true }); // an empty dir only (hasData was false)
    renameSync(tmp, db);
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    return { action: "refused", message: `capcomd couldn't copy its engine data from ${o.legacyDb} to ${db}: ${(e as Error).message}. Nothing was changed; the old data is untouched.` };
  }
  const at = (o.now ?? (() => new Date()))().toISOString();
  writeFileSync(marker, JSON.stringify({ source: o.legacyDb, copiedTo: db, copiedAt: at, files: before.files, bytes: before.bytes,
    engineVersion: o.engineVersion ?? null, capcomdVersion: o.capcomdVersion ?? null, sourceLeftUntouched: true }, null, 2) + "\n");
  return { action: "copied", from: o.legacyDb, to: db, files: before.files, bytes: before.bytes,
    message: `capcomd now keeps its engine data in ${db}: copied ${before.files} files (${(before.bytes / 1048576).toFixed(1)} MB) from ${o.legacyDb}, which is left untouched as a backup.` };
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
  | { action: "no-backup"; from: string; message: string }
  | { action: "refused"; message: string };

/**
 * Before an engine of `engineVersion` opens the db in `dataDir`:
 *  - no db yet, or the same version last opened it: nothing to do;
 *  - a NEWER engine last opened it: refuse (the engine would refuse too: it stamps its version into the db and
 *    won't open one stamped newer), naming both versions and the newest backup;
 *  - another (older, or unrecorded) version: copy db to backups/<old>-<UTC>/ first, keeping the newest `keep`.
 * Then records `engineVersion` as the one that last opened it. `skipBackup` (with a reason) is for a db that was
 * just copied from a source that stays untouched: that source is the backup.
 */
export function prepareEngineData(o: { dataDir: string; engineVersion: string | null; capcomdVersion?: string; keep?: number; now?: () => Date; skipBackup?: string }): PrepareResult {
  const engineVersion = o.engineVersion;
  if (!engineVersion) return { action: "unknown-engine" };
  const db = dbDir(o.dataDir);
  const now = (o.now ?? (() => new Date()))();
  const record = readVersionRecord(o.dataDir);
  const write = () => {
    mkdirSync(o.dataDir, { recursive: true });
    const tmp = `${versionFileOf(o.dataDir)}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: engineVersion, openedAt: now.toISOString(), capcomdVersion: o.capcomdVersion ?? null } satisfies VersionRecord, null, 2) + "\n");
    renameSync(tmp, versionFileOf(o.dataDir));
  };
  if (!hasData(db)) { write(); return { action: "fresh" }; }
  if (record && record.version === engineVersion) { write(); return { action: "same" }; }
  if (record && compareVersions(record.version, engineVersion) > 0) {
    const newest = listBackups(o.dataDir)[0];
    return { action: "refused", message: `the engine data in ${db} was last opened by Rivet engine ${record.version}, newer than this capcomd's ${engineVersion}, which can't open it (Rivet refuses to roll an engine back): run the newer capcomd, or restore ${newest ? `the newest backup (${newest}) into ${db}` : `a backup of ${db}`} and delete ${versionFileOf(o.dataDir)}.` };
  }
  const old = record?.version ?? "unknown";
  if (o.skipBackup) { write(); return { action: "no-backup", from: old, message: o.skipBackup }; }
  const backups = backupsDirOf(o.dataDir);
  mkdirSync(backups, { recursive: true });
  const dest = join(backups, `${old}-${stamp(now)}`);
  const tmp = `${dest}.partial`;
  rmSync(tmp, { recursive: true, force: true });
  cpSync(db, tmp, { recursive: true, preserveTimestamps: true });
  renameSync(tmp, dest);
  for (const extra of listBackups(o.dataDir).slice(o.keep ?? KEEP_BACKUPS)) rmSync(extra, { recursive: true, force: true });
  write();
  return { action: "backed-up", from: old, backup: dest, message: `engine ${old} → ${o.engineVersion}: backed up ${db} to ${dest} first (the newest ${o.keep ?? KEEP_BACKUPS} backups are kept).` };
}
