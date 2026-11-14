// Engine data under capcomd's home (src/engine/data.ts): path resolution, Rivet 2.x data set aside under a 3.x engine,
// the per-version backup and the newer-engine refusal. Scratch dirs and a fake engine only: never the real ~/.rivetkit.
import { afterAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import {
  backupsDirOf, dbDir, engineDataDir, engineLogTail, engineVersionOf, holdersOf, isDefaultDataDir, listBackups, newestWrite, pidFileOf,
  prepareEngineData, readVersionRecord, recordEngineVersion, setAsideDirOf, treeStats, versionFileOf,
} from "../../src/engine/data";
import { setAsideRuns } from "../../src/primitives/ops";
import { CLI, REPO, testPort } from "../helpers/engine";

const roots: string[] = [];
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "capcomd-engine-data-")); roots.push(d); return d; };
afterAll(() => { for (const d of roots) rmSync(d, { recursive: true, force: true }); });

/** A db dir that looks like RocksDB's (Rivet 2.x): a LOCK, a manifest and some table files. */
function fakeDb(dir: string, files = 5, size = 1000): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "LOCK"), "");
  writeFileSync(join(dir, "CURRENT"), "MANIFEST-000001\n");
  for (let i = 0; i < files; i++) writeFileSync(join(dir, `00000${i}.sst`), Buffer.alloc(size, i));
}
/** A db dir that looks like Rivet 3.x's: a log and an object store. */
function fakeDb3(dir: string): void {
  mkdirSync(join(dir, "log", "shards", "0"), { recursive: true });
  mkdirSync(join(dir, "objects", "rivet"), { recursive: true });
  writeFileSync(join(dir, "log", "shards", "0", "FORMAT"), "1\n");
  writeFileSync(join(dir, "objects", "rivet", "manifest"), "m");
}
/** Every file's path, size and mtime: to prove a tree wasn't touched. */
const fingerprint = (dir: string) => {
  const out: string[] = [];
  const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else { const s = statSync(p); out.push(`${p}:${s.size}:${s.mtimeMs}`); } } };
  walk(dir);
  return out.join("\n");
};

describe("paths", () => {
  test("every port, 6420 included, lives under capcomd's home; CAPCOMD_HOME is respected; explicit dirs win", () => {
    expect(engineDataDir(6420, {})).toBe(join(homedir(), ".capcomd", "engine", "6420"));
    expect(engineDataDir(7000, {})).toBe(join(homedir(), ".capcomd", "engine", "7000"));
    expect(engineDataDir(6420, { CAPCOMD_HOME: "/c" })).toBe("/c/engine/6420");
    expect(engineDataDir(6420, { CAPCOMD_HOME: "/c", CAPCOMD_ENGINE_DATA: "/x" })).toBe("/x");
    expect(engineDataDir(6420, { CAPCOMD_TEST_ENGINE_DATA: "/y" })).toBe("/y");
    expect(isDefaultDataDir({})).toBe(true);
    expect(isDefaultDataDir({ CAPCOMD_ENGINE_DATA: "/x" })).toBe(false);
    expect(dbDir("/c/engine/6420")).toBe("/c/engine/6420/db");
    expect(pidFileOf("/c/engine/6420")).toBe("/c/engine/6420/engine.pid");
    expect(versionFileOf("/c/engine/6420")).toBe("/c/engine/6420/engine-version.json");
    expect(setAsideDirOf("/c/engine/6420")).toBe("/c/engine/6420/rivet-v2");
  });

  test("the engine's version comes from `--version` (a fake engine here)", () => {
    const d = scratch();
    const fake = join(d, "rivet-engine");
    writeFileSync(fake, "#!/bin/sh\n[ \"$1\" = --version ] && { echo 'Rivet 9.8.7'; echo 'Git SHA: x'; exit 0; }\nexit 3\n");
    chmodSync(fake, 0o755);
    expect(engineVersionOf(fake)).toBe("9.8.7");
    expect(engineVersionOf(join(d, "missing"))).toBeNull();
  });
});

test("holdersOf finds a process that holds a file in the dir open (an engine holds its data open for its whole life)", async () => {
  const dir = join(scratch(), "db");
  fakeDb(dir);
  expect(holdersOf(dir)).toEqual([]);
  const hold = spawn("sh", ["-c", `exec 3<"${join(dir, "LOCK")}"; exec sleep 60`], { stdio: "ignore" });
  try {
    let held: number[] = [];
    for (let i = 0; i < 50 && !held.includes(hold.pid!); i++) { await Bun.sleep(100); held = holdersOf(dir) ?? []; }
    expect(held).toContain(hold.pid!);
  } finally { hold.kill("SIGKILL"); }
  expect(holdersOf(join(dir, "missing"))).toEqual([]);
}, 30_000);

describe("Rivet 2.x data under a 3.x engine: set aside once, start empty", () => {
  const at = (s: string) => () => new Date(s);

  test("what the 2.x engine left (db, its record, backups, the old copy marker) moves together to rivet-v2/; the next start is fresh", () => {
    const data = join(scratch(), "e");
    fakeDb(dbDir(data));
    recordEngineVersion(data, "2.3.31", "0.10.1", new Date("2026-11-01T00:00:00Z"));
    mkdirSync(join(backupsDirOf(data), "2.3.30-2026-10-20T00-00-00Z", "db"), { recursive: true });
    writeFileSync(join(data, "migrated-from-rivetkit.json"), "{}\n");
    const old = fingerprint(dbDir(data));
    const r = prepareEngineData({ dataDir: data, engineVersion: "3.1.1", now: at("2026-11-12T00:00:00Z") });
    expect(r).toMatchObject({ action: "set-aside", from: "2.3.31", to: setAsideDirOf(data) });
    if (r.action !== "set-aside") return;
    expect(r.message).toContain("Rivet engine 3.1.1 can't open the data Rivet 2.3.31 kept in");
    expect(r.message).toContain(setAsideDirOf(data));
    expect(r.message).toContain("starting with empty engine data");
    expect(readdirSync(setAsideDirOf(data)).sort()).toEqual(["backups", "db", "engine-version.json", "migrated-from-rivetkit.json"]);
    expect(fingerprint(join(setAsideDirOf(data), "db"))).toBe(old.replaceAll(`${data}/db/`, `${setAsideDirOf(data)}/db/`)); // moved as it was
    for (const n of ["db", "engine-version.json", "backups", "migrated-from-rivetkit.json", "rivet-v2.partial"]) expect(existsSync(join(data, n))).toBe(false);
    expect(listBackups(data)).toEqual([]); // 2.x backups are not offered as this engine's
    expect(prepareEngineData({ dataDir: data, engineVersion: "3.1.1" }).action).toBe("fresh");
  });

  test("an unrecorded RocksDB is 2.x data too; a second cut (2.x run again meanwhile) gets its own dir", () => {
    const data = join(scratch(), "e");
    fakeDb(dbDir(data));
    expect(prepareEngineData({ dataDir: data, engineVersion: "3.1.1", now: at("2026-11-12T00:00:00Z") })).toMatchObject({ action: "set-aside", from: "2.x", to: setAsideDirOf(data) });
    fakeDb(dbDir(data));
    recordEngineVersion(data, "2.3.31");
    expect(prepareEngineData({ dataDir: data, engineVersion: "3.1.1", now: at("2026-11-13T00:00:00Z") })).toMatchObject({ action: "set-aside", to: `${setAsideDirOf(data)}-2026-11-13T00-00-00Z` });
    expect(existsSync(join(setAsideDirOf(data), "db", "CURRENT"))).toBe(true);
    expect(existsSync(join(`${setAsideDirOf(data)}-2026-11-13T00-00-00Z`, "engine-version.json"))).toBe(true);
  });

  test("a set-aside that stopped halfway is finished by the next start", () => {
    const data = join(scratch(), "e");
    fakeDb(join(`${setAsideDirOf(data)}.partial`, "db"));
    recordEngineVersion(data, "2.3.31");
    expect(prepareEngineData({ dataDir: data, engineVersion: "3.1.1" })).toMatchObject({ action: "set-aside", from: "2.3.31" });
    expect(readdirSync(setAsideDirOf(data)).sort()).toEqual(["db", "engine-version.json"]);
    expect(existsSync(`${setAsideDirOf(data)}.partial`)).toBe(false);
  });

  test("3.x data is never set aside: unrecorded it is backed up as before, and 3.0 → 3.1 is an ordinary upgrade", () => {
    const a = join(scratch(), "e");
    fakeDb3(dbDir(a));
    expect(prepareEngineData({ dataDir: a, engineVersion: "3.1.1" })).toMatchObject({ action: "backed-up", from: "unknown" });
    const b = join(scratch(), "e");
    fakeDb3(dbDir(b));
    recordEngineVersion(b, "3.0.7");
    expect(prepareEngineData({ dataDir: b, engineVersion: "3.1.1" })).toMatchObject({ action: "backed-up", from: "3.0.7" });
    expect(existsSync(setAsideDirOf(a)) || existsSync(setAsideDirOf(b))).toBe(false);
  });

  test("its runs leave the run list: rows created up to the 2.x engine's last write move to runs-rivet-v2.jsonl", () => {
    const dir = scratch();
    const index = join(dir, "runs.jsonl");
    const row = (runId: string, createdAt: number) => JSON.stringify({ runId, label: null, repo: null, cwd: dir, createdAt });
    writeFileSync(index, [row("run-old-1", 1000), row("run-old-2", 2000), "not json", row("run-new", 5000)].join("\n") + "\n");
    const saved = process.env.CAPCOMD_RUNS_INDEX;
    process.env.CAPCOMD_RUNS_INDEX = index;
    try {
      expect(setAsideRuns(2000)).toEqual({ moved: 2, to: join(dir, "runs-rivet-v2.jsonl") });
      expect(readFileSync(index, "utf8").split("\n").filter(Boolean).map((l) => l.startsWith("{") ? JSON.parse(l).runId : l)).toEqual(["not json", "run-new"]);
      expect(readFileSync(join(dir, "runs-rivet-v2.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).runId)).toEqual(["run-old-1", "run-old-2"]);
      expect(setAsideRuns(2000).moved).toBe(0);
      expect(setAsideRuns(0).moved).toBe(0);
    } finally { if (saved === undefined) delete process.env.CAPCOMD_RUNS_INDEX; else process.env.CAPCOMD_RUNS_INDEX = saved; }
    const db = join(dir, "db");
    fakeDb(db, 2);
    expect(newestWrite(db)).toBeGreaterThan(0);
    expect(newestWrite(join(dir, "none"))).toBe(0);
  });
});

describe("version guard and backups", () => {
  const at = (s: string) => () => new Date(s);
  /** What serve does once the engine answered. */
  const opened = (data: string, v: string, t: string) => recordEngineVersion(data, v, "0.6.0", new Date(t));
  const names = (data: string) => listBackups(data).map((p) => p.split("/").pop());

  test("a fresh dir needs nothing; the same version again does nothing; the version is recorded only by the engine opening it", () => {
    const data = join(scratch(), "e");
    expect(prepareEngineData({ dataDir: data, engineVersion: "2.3.31" }).action).toBe("fresh");
    expect(readVersionRecord(data)).toBeNull();
    fakeDb(dbDir(data));
    opened(data, "2.3.31", "2026-10-01T00:00:00Z");
    expect(prepareEngineData({ dataDir: data, engineVersion: "2.3.31" }).action).toBe("same");
    expect(listBackups(data)).toEqual([]);
    expect(readVersionRecord(data)).toMatchObject({ version: "2.3.31", capcomdVersion: "0.6.0" });
  });

  test("another version backs db/ and its record up first, as <old>-<UTC>, and keeps the newest 3", () => {
    const data = join(scratch(), "e");
    fakeDb(dbDir(data));
    const live = fingerprint(dbDir(data));
    // Unrecorded (e.g. a dir from before capcomd recorded versions, or the copy from ~/.rivetkit): backed up as "unknown".
    expect(prepareEngineData({ dataDir: data, engineVersion: "2.3.27", now: at("2026-10-01T00:00:00Z") })).toMatchObject({ action: "backed-up", from: "unknown" });
    expect(names(data)).toEqual(["unknown-2026-10-01T00-00-00Z"]);
    expect(treeStats(join(listBackups(data)[0]!, "db"))).toEqual(treeStats(dbDir(data)));
    expect(fingerprint(dbDir(data))).toBe(live); // the live db isn't changed by a backup
    opened(data, "2.3.27", "2026-10-01T00:00:01Z");
    const steps: Array<[string, string]> = [["2.3.29", "2026-10-02T00:00:00Z"], ["2.3.30", "2026-10-03T00:00:00Z"], ["2.3.31", "2026-10-04T00:00:00Z"]];
    for (const [v, t] of steps) { expect(prepareEngineData({ dataDir: data, engineVersion: v, now: at(t) }).action).toBe("backed-up"); opened(data, v, t.replace("00Z", "01Z")); }
    expect(names(data)).toEqual(["2.3.30-2026-10-04T00-00-00Z", "2.3.29-2026-10-03T00-00-00Z", "2.3.27-2026-10-02T00-00-00Z"]);
    // Each backup carries the record of the engine that had opened it, so a restore needs no guesswork.
    expect(JSON.parse(readFileSync(join(listBackups(data)[0]!, "engine-version.json"), "utf8")).version).toBe("2.3.30");
    expect(readdirSync(join(data, "backups")).some((n) => n.endsWith(".partial"))).toBe(false);
  });

  test("an engine that never came up isn't backed up again on every retry", () => {
    const data = join(scratch(), "e");
    fakeDb(dbDir(data));
    opened(data, "2.3.27", "2026-10-01T00:00:00Z");
    expect(prepareEngineData({ dataDir: data, engineVersion: "2.3.31", now: at("2026-10-02T00:00:00Z") }).action).toBe("backed-up");
    // No recordEngineVersion: the 2.3.31 engine didn't answer. The next starts find that backup.
    for (const t of ["2026-10-02T00:01:00Z", "2026-10-02T00:02:00Z", "2026-10-02T00:03:00Z"]) {
      expect(prepareEngineData({ dataDir: data, engineVersion: "2.3.31", now: at(t) })).toMatchObject({ action: "already-backed-up", from: "2.3.27" });
    }
    expect(names(data)).toEqual(["2.3.27-2026-10-02T00-00-00Z"]);
  });

  test("a db last opened by a NEWER engine is refused, naming both versions and the newest backup; nothing changes", () => {
    const data = join(scratch(), "e");
    fakeDb(dbDir(data));
    opened(data, "2.3.27", "2026-10-01T00:00:00Z");
    prepareEngineData({ dataDir: data, engineVersion: "2.3.31", now: at("2026-10-02T00:00:00Z") });
    opened(data, "2.3.31", "2026-10-02T00:00:01Z");
    const newest = listBackups(data)[0]!;
    const before = fingerprint(data);
    const r = prepareEngineData({ dataDir: data, engineVersion: "2.3.27", now: at("2026-10-03T00:00:00Z") });
    expect(r.action).toBe("refused");
    if (r.action === "refused") {
      expect(r.message).toContain("2.3.31");
      expect(r.message).toContain("2.3.27");
      expect(r.message).toContain(newest);
    }
    expect(fingerprint(data)).toBe(before);
  });

  test("an engine whose version can't be read is let through unchanged", () => {
    const data = join(scratch(), "e");
    fakeDb(dbDir(data));
    expect(prepareEngineData({ dataDir: data, engineVersion: null }).action).toBe("unknown-engine");
    expect(existsSync(versionFileOf(data))).toBe(false);
  });

  test("the engine's last log lines are there to show when it didn't come up: its stderr, else its stdout (Rivet 3.x)", () => {
    const data = join(scratch(), "e");
    const logs = join(data, ".rivetkit", "var", "logs", "rivet-engine");
    mkdirSync(logs, { recursive: true });
    writeFileSync(join(logs, "engine-1-stderr.log"), "old\n");
    writeFileSync(join(logs, "engine-2-stderr.log"), "a\nRivet Engine has been rolled back to a previous version\n");
    expect(engineLogTail(data)).toContain("rolled back");
    writeFileSync(join(logs, "engine-3-stderr.log"), "");
    writeFileSync(join(logs, "engine-3-stdout.log"), "b\nunknown field `file_system`\n");
    expect(engineLogTail(data)).toContain("unknown field");
    expect(engineLogTail(join(scratch(), "none"))).toBe("");
  });
});

// The guard runs in `capcomd serve` before any engine starts: a newer-stamped dir exits 1 with the sentence, and
// no engine (nor ~/.rivetkit) is ever touched. The serve gets a scratch HOME and data dir, and a private port.
test("serve refuses a data dir last opened by a newer engine before starting anything", async () => {
  const home = scratch();
  const data = join(home, "engine-data");
  fakeDb(dbDir(data));
  writeFileSync(versionFileOf(data), JSON.stringify({ version: "99.0.0", openedAt: "2026-01-01T00:00:00Z" }));
  const port = await testPort();
  const r = spawnSync(process.execPath, [CLI, "serve", "--port", String(port)], {
    cwd: REPO, encoding: "utf8", timeout: 60_000,
    env: { ...process.env, HOME: home, CAPCOMD_HOME: join(home, ".capcomd"), CAPCOMD_ENGINE_DATA: data, CAPCOMD_ENDPOINT: `http://127.0.0.1:${port}` },
  });
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("last opened by Rivet engine 99.0.0");
  expect(existsSync(pidFileOf(data))).toBe(false);
  expect(existsSync(join(home, ".rivetkit"))).toBe(false);
  expect(readVersionRecord(data)?.version).toBe("99.0.0");
}, 70_000);

// The hard cut, end to end: `capcomd serve` on a dir a Rivet 2.x engine left (a RocksDB and its record) says so in one
// line, moves it to rivet-v2/, takes that engine's runs out of the run list, and the 3.x engine starts on empty data.
test("serve sets Rivet 2.x data aside, says so once, and starts the 3.x engine empty", async () => {
  const home = scratch();
  const data = join(home, "engine-data");
  fakeDb(dbDir(data));
  writeFileSync(versionFileOf(data), JSON.stringify({ version: "2.3.31", openedAt: "2026-11-01T00:00:00Z" }));
  const index = join(home, "runs.jsonl");
  const row = (runId: string, createdAt: number) => JSON.stringify({ runId, label: null, repo: null, cwd: home, createdAt });
  writeFileSync(index, row("run-before", Date.now() - 60_000) + "\n");
  const port = await testPort();
  const child = spawn(process.execPath, [CLI, "serve", "--port", String(port)], {
    cwd: REPO, stdio: ["ignore", "pipe", "pipe"], detached: true,
    env: { ...process.env, HOME: home, CAPCOMD_HOME: join(home, ".capcomd"), CAPCOMD_ENGINE_DATA: data, CAPCOMD_RUNS_INDEX: index, CAPCOMD_ENDPOINT: `http://127.0.0.1:${port}` },
  });
  let out = "";
  child.stdout!.on("data", (d) => (out += d)); child.stderr!.on("data", (d) => (out += d));
  const exited = new Promise((r) => child.on("exit", r));
  try {
    for (let i = 0; i < 360 && !out.includes("Rivet engine running"); i++) await Bun.sleep(250);
    expect(out).toContain("Rivet engine running");
    const said = out.split("\n").filter((l) => l.includes("can't open the data Rivet 2.3.31"));
    expect(said.length).toBe(1);
    expect(said[0]).toContain(`moved it to ${setAsideDirOf(data)}`);
    expect(said[0]).toContain("1 run from before it left the run list");
    expect(existsSync(join(setAsideDirOf(data), "db", "CURRENT"))).toBe(true);
    expect(existsSync(join(dbDir(data), "CURRENT"))).toBe(false); // the 3.x engine's own data, nothing mixed in
    expect(readFileSync(index, "utf8")).toBe("");
    expect(readFileSync(join(home, "runs-rivet-v2.jsonl"), "utf8")).toContain("run-before");
    // Recorded once the watchdog has read the new engine's /health, after its ✓ line; the 2.x record was moved away.
    for (let i = 0; i < 40 && !/^3\./.test(readVersionRecord(data)?.version ?? ""); i++) await Bun.sleep(250);
    expect(readVersionRecord(data)?.version).toMatch(/^3\./);
  } finally {
    try { process.kill(child.pid!, "SIGTERM"); } catch {}
    await Promise.race([exited, Bun.sleep(25_000)]);
    try { process.kill(-child.pid!, "SIGKILL"); } catch {}
  }
}, 120_000);
