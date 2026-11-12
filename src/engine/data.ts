// Where the Rivet engine keeps its data, and the guards around it (docs/durability.md → "Engine data").
//
// Every engine capcomd starts keeps everything under capcomd's own home (`~/.capcomd`, or $CAPCOMD_HOME), one
// directory per port:
//
//   <home>/engine/<port>/db                    the engine's storage: db/log and db/objects (Rivet 3.x; engine-wrapper.sh)
//   <home>/engine/<port>/engine.pid            the running engine's pid (engine-wrapper.sh writes it)
//   <home>/engine/<port>/engine-version.json   the engine version that last opened db (capcomd writes it)
//   <home>/engine/<port>/backups/<v>-<UTC>/    db/ and engine-version.json as they were before an engine of another
//                                              version opened it (newest 3)
//   <home>/engine/<port>/rivet-v2/             what a Rivet 2.x engine kept here (its RocksDB db/, engine-version.json,
//                                              backups/), set aside once by the first 3.x start (setAsideOlderData)
//   <home>/engine/<port>/.rivetkit/            rivetkit's own engine logs and runtime stamp (RIVETKIT_STORAGE_PATH)
//
// so a capcomd install never reads or writes rivetkit's shared default `~/.rivetkit`, which any other rivetkit
// project on the machine also uses (a newer one stamps the db and the pinned engine then refuses to open it).
import { spawnSync } from "child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import { basename, join } from "path";
import { capcomdHome } from "../utils/home";

type Env = Record<string, string | undefined>;
export const DEFAULT_PORT = 6420;
export const KEEP_BACKUPS = 3;

/** The data dir for an engine on `port`: CAPCOMD_ENGINE_DATA (or the test engine's, CAPCOMD_TEST_ENGINE_DATA) wins, else <home>/engine/<port>. */
export function engineDataDir(port: number, env: Env = process.env): string {
  return env.CAPCOMD_ENGINE_DATA ?? env.CAPCOMD_TEST_ENGINE_DATA ?? join(capcomdHome(env), "engine", String(port));
}

/** True when the data dir is capcomd's default for the port (no explicit override). */
export const isDefaultDataDir = (env: Env = process.env) => !env.CAPCOMD_ENGINE_DATA && !env.CAPCOMD_TEST_ENGINE_DATA;

export const dbDir = (data: string) => join(data, "db");
export const pidFileOf = (data: string) => join(data, "engine.pid");
export const versionFileOf = (data: string) => join(data, "engine-version.json");
export const backupsDirOf = (data: string) => join(data, "backups");
/** Where a Rivet 2.x engine's data is set aside (setAsideOlderData). */
export const setAsideDirOf = (data: string) => join(data, "rivet-v2");

/** Before this layout, the pid file of a non-default port lived at <home>/engine/<port>.pid. */
export const legacyPidFile = (port: number, env: Env = process.env) => join(capcomdHome(env), "engine", `${port}.pid`);

/** The engine binary's version (`rivet-engine --version` prints "Rivet 3.1.1"), or null when it can't say. */
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

/** The newest modification time (ms) of any file under `dir`: when an engine last wrote its data there. 0 if none. */
export function newestWrite(dir: string): number {
  let newest = 0;
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) newest = Math.max(newest, statSync(p).mtimeMs);
    }
  };
  if (existsSync(dir)) walk(dir);
  return newest;
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
  | { action: "set-aside"; from: string; to: string; message: string }
  | { action: "backed-up"; from: string; backup: string; message: string }
  | { action: "already-backed-up"; from: string; backup: string }
  | { action: "refused"; message: string };

const major = (v: string) => Number(/^v?(\d+)/.exec(v)?.[1] ?? NaN);

/**
 * Whether the db in `dataDir` was written by an engine of an older major version than `engineVersion`, which can't
 * open it: its record names an older major, or (no record) it is Rivet 2.x's RocksDB (a CURRENT file at its top; 3.x
 * keeps log/ and objects/ there instead).
 */
export function olderMajorData(dataDir: string, engineVersion: string): boolean {
  const record = readVersionRecord(dataDir);
  if (record) return major(record.version) < major(engineVersion);
  return major(engineVersion) >= 3 && existsSync(join(dbDir(dataDir), "CURRENT"));
}

/**
 * A Rivet 3.x engine can't read the data a 2.x engine kept (a RocksDB; 3.x keeps a log and object store), and capcomd
 * doesn't carry it over: on the first 3.x start, what the 2.x engine left here (db/, engine-version.json, backups/, the
 * old migrated-from-rivetkit.json) moves together to rivet-v2/ (rivet-v2-<UTC>/ if that is taken) and the engine starts
 * empty. Nothing is deleted, and nothing of it is left where the 3.x engine or the backups would mistake it for theirs.
 * A start that stopped halfway finishes the move from its .partial dir.
 */
function setAsideOlderData(dataDir: string, engineVersion: string, now: Date): PrepareResult {
  const old = readVersionRecord(dataDir)?.version ?? "2.x";
  const base = setAsideDirOf(dataDir);
  const dest = existsSync(base) ? `${base}-${stamp(now)}` : base;
  const tmp = `${base}.partial`;
  mkdirSync(tmp, { recursive: true });
  for (const name of ["db", "engine-version.json", "backups", "migrated-from-rivetkit.json"]) {
    const from = join(dataDir, name);
    if (existsSync(from) && !existsSync(join(tmp, name))) renameSync(from, join(tmp, name));
  }
  renameSync(tmp, dest);
  return { action: "set-aside", from: old, to: dest,
    message: `Rivet engine ${engineVersion} can't open the data Rivet ${old} kept in ${dbDir(dataDir)}: moved it to ${dest} and starting with empty engine data (runs from before the upgrade are gone).` };
}

/**
 * Before an engine of `engineVersion` opens the db in `dataDir`:
 *  - no db yet, or the same version last opened it: nothing to do;
 *  - an engine of an OLDER MAJOR version wrote it (Rivet 2.x under a 3.x engine): set it aside, start empty
 *    (setAsideOlderData);
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
  const now = (o.now ?? (() => new Date()))();
  if (existsSync(`${setAsideDirOf(o.dataDir)}.partial`) || (hasData(db) && olderMajorData(o.dataDir, engineVersion))) return setAsideOlderData(o.dataDir, engineVersion, now);
  if (!hasData(db)) return { action: "fresh" };
  if (record && record.version === engineVersion) return { action: "same" };
  if (record && Bun.semver.order(record.version, engineVersion) > 0) {
    const newest = listBackups(o.dataDir)[0];
    return { action: "refused", message: `the engine data in ${db} was last opened by Rivet engine ${record.version}, newer than this capcomd's ${engineVersion}, which can't open it (Rivet refuses to roll an engine back): run the newer capcomd, or stop capcomd and restore ${newest ? `the newest backup's db/ and engine-version.json (${newest})` : `a backup of ${db}`} in place of the current ones.` };
  }
  const old = record?.version ?? "unknown";
  const newest = listBackups(o.dataDir)[0];
  if (newest && basename(newest).startsWith(`${old}-`) && basename(newest).slice(old.length + 1) >= stamp(new Date(record?.openedAt ?? 0))) return { action: "already-backed-up", from: old, backup: newest };
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

/** The last lines rivetkit's engine wrote to its newest log here: why an engine didn't come up. Its stderr log, or its
 *  stdout log when that is empty (Rivet 3.x logs there). */
export function engineLogTail(dataDir: string, lines = 12): string {
  try {
    const dir = join(dataDir, ".rivetkit", "var", "logs", "rivet-engine");
    const newest = readdirSync(dir).filter((n) => n.endsWith("-stderr.log")).sort().pop();
    if (!newest) return "";
    const read = (n: string) => { try { return readFileSync(join(dir, n), "utf8").trimEnd(); } catch { return ""; } };
    const text = read(newest) || read(newest.replace(/-stderr\.log$/, "-stdout.log"));
    return text ? text.split("\n").slice(-lines).join("\n") : "";
  } catch { return ""; }
}
