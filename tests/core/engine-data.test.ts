// Engine data under capcomd's home (src/engine/data.ts): path resolution, the one-time copy from ~/.rivetkit, the
// per-version backup and the newer-engine refusal. Scratch dirs and a fake engine only: never the real ~/.rivetkit.
import { afterAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import {
  copiesLegacyData, dbDir, engineDataDir, engineLogTail, engineVersionOf, holdersOf, isDefaultDataDir, legacyRivetkitDb, listBackups, migrateLegacyEngineData,
  migrationMarkerOf, pidFileOf, prepareEngineData, readVersionRecord, recordEngineVersion, treeStats, versionFileOf,
} from "../../src/engine/data";
import { CLI, REPO, testPort } from "../helpers/engine";

const roots: string[] = [];
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "capcomd-engine-data-")); roots.push(d); return d; };
afterAll(() => { for (const d of roots) rmSync(d, { recursive: true, force: true }); });

/** A db dir that looks like RocksDB's: a LOCK, a manifest and some table files. */
function fakeDb(dir: string, files = 5, size = 1000): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "LOCK"), "");
  writeFileSync(join(dir, "CURRENT"), "MANIFEST-000001\n");
  for (let i = 0; i < files; i++) writeFileSync(join(dir, `00000${i}.sst`), Buffer.alloc(size, i));
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
    expect(engineDataDir(6420, { CAPCOMD_CHAOS_ENGINE_DATA: "/y" })).toBe("/y");
    expect(isDefaultDataDir({})).toBe(true);
    expect(isDefaultDataDir({ CAPCOMD_ENGINE_DATA: "/x" })).toBe(false);
    expect(dbDir("/c/engine/6420")).toBe("/c/engine/6420/db");
    expect(pidFileOf("/c/engine/6420")).toBe("/c/engine/6420/engine.pid");
    expect(versionFileOf("/c/engine/6420")).toBe("/c/engine/6420/engine-version.json");
    expect(legacyRivetkitDb({ HOME: "/h" })).toBe("/h/.rivetkit/var/engine/db");
  });

  test("serve copies from ~/.rivetkit only on 6420 with the default data dir, and decides before it sets CAPCOMD_ENGINE_DATA", () => {
    expect(copiesLegacyData(6420, {})).toBe(true);
    expect(copiesLegacyData(6420, { CAPCOMD_HOME: "/c" })).toBe(true);
    expect(copiesLegacyData(7000, {})).toBe(false);
    expect(copiesLegacyData(6420, { CAPCOMD_ENGINE_DATA: "/x" })).toBe(false);
    // serve sets CAPCOMD_ENGINE_DATA for its engine on every start, so asking after that always said no and the
    // first 2.3.31 start on 6420 opened an empty db (live Mac, 2026-10-28). A serve test can't take 6420, so: the order.
    const serve = readFileSync(join(REPO, "src", "cli", "commands", "serve.ts"), "utf8");
    const asked = serve.indexOf("data.copiesLegacyData(port)");
    expect(asked).toBeGreaterThan(-1);
    expect(asked).toBeLessThan(serve.indexOf("process.env.CAPCOMD_ENGINE_DATA = dataDir"));
    expect(serve).not.toContain("isDefaultDataDir()");
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

describe("one-time copy from ~/.rivetkit", () => {
  const setup = () => {
    const home = scratch();
    const legacy = join(home, ".rivetkit", "var", "engine", "db");
    fakeDb(legacy);
    return { home, legacy, data: join(home, ".capcomd", "engine", "6420") };
  };

  test("copies, verifies, writes a marker, and leaves the source untouched", () => {
    const { legacy, data } = setup();
    const before = fingerprint(legacy);
    const r = migrateLegacyEngineData({ dataDir: data, legacyDb: legacy, engineVersion: "2.3.31", capcomdVersion: "0.6.0", holders: () => [] });
    expect(r.action).toBe("copied");
    if (r.action !== "copied") return;
    expect(r.message).toContain(dbDir(data));
    expect(r.message).toContain("left untouched");
    expect(treeStats(dbDir(data))).toEqual(treeStats(legacy));
    expect(readFileSync(join(dbDir(data), "000003.sst"))).toEqual(readFileSync(join(legacy, "000003.sst")));
    expect(fingerprint(legacy)).toBe(before);
    const marker = JSON.parse(readFileSync(migrationMarkerOf(data), "utf8"));
    expect(marker).toMatchObject({ source: legacy, copiedTo: dbDir(data), files: 7, engineVersion: "2.3.31", capcomdVersion: "0.6.0", sourceLeftUntouched: true });
    expect(typeof marker.copiedAt).toBe("string");
    expect(readdirSync(data).filter((n) => n.startsWith("db.copying"))).toEqual([]);
  });

  test("idempotent: never copies twice, even after the copy is gone or the source changed", () => {
    const { legacy, data } = setup();
    expect(migrateLegacyEngineData({ dataDir: data, legacyDb: legacy, holders: () => [] }).action).toBe("copied");
    writeFileSync(join(legacy, "000009.sst"), "new");
    expect(migrateLegacyEngineData({ dataDir: data, legacyDb: legacy, holders: () => [] })).toEqual({ action: "none", reason: "already copied" });
    expect(existsSync(join(dbDir(data), "000009.sst"))).toBe(false);
    rmSync(dbDir(data), { recursive: true });
    expect(migrateLegacyEngineData({ dataDir: data, legacyDb: legacy, holders: () => [] }).action).toBe("none");
    expect(existsSync(dbDir(data))).toBe(false);
  });

  test("nothing to do when capcomd already has a db, or there's no rivetkit db", () => {
    const { legacy, data } = setup();
    fakeDb(dbDir(data), 1);
    const mine = fingerprint(dbDir(data));
    expect(migrateLegacyEngineData({ dataDir: data, legacyDb: legacy, holders: () => [] })).toMatchObject({ action: "none" });
    expect(fingerprint(dbDir(data))).toBe(mine);
    expect(existsSync(migrationMarkerOf(data))).toBe(false);
    const other = scratch();
    expect(migrateLegacyEngineData({ dataDir: join(other, "d"), legacyDb: join(other, "nope"), holders: () => [] })).toMatchObject({ action: "none", reason: "no rivetkit db to copy" });
  });

  test("refuses when it can't tell whether the source is held, or when it's opened during the copy", () => {
    const { legacy, data } = setup();
    expect(migrateLegacyEngineData({ dataDir: data, legacyDb: legacy, holders: () => null })).toMatchObject({ action: "refused" });
    let calls = 0;
    const r = migrateLegacyEngineData({ dataDir: data, legacyDb: legacy, holders: () => (++calls === 1 ? [] : [4242]) });
    expect(r.action).toBe("refused");
    if (r.action === "refused") expect(r.message).toContain("4242");
    expect(existsSync(dbDir(data))).toBe(false);
    expect(readdirSync(data).filter((n) => n.startsWith("db.copying"))).toEqual([]);
    expect(existsSync(migrationMarkerOf(data))).toBe(false);
  });

  test("an empty db dir in capcomd's place doesn't block the copy", () => {
    const { legacy, data } = setup();
    mkdirSync(dbDir(data), { recursive: true });
    expect(migrateLegacyEngineData({ dataDir: data, legacyDb: legacy, holders: () => [] }).action).toBe("copied");
    expect(treeStats(dbDir(data)).files).toBe(7);
  });

  test("refuses while a process holds the source open (a real holder, found by holdersOf), copying nothing", async () => {
    const { legacy, data } = setup();
    const before = fingerprint(legacy);
    // A fake engine: keeps the db's LOCK open, like rivet-engine does for its whole life.
    const hold = spawn("sh", ["-c", `exec 3<"${join(legacy, "LOCK")}"; exec sleep 60`], { stdio: "ignore" });
    try {
      let held: number[] = [];
      for (let i = 0; i < 50 && !held.includes(hold.pid!); i++) { await Bun.sleep(100); held = holdersOf(legacy) ?? []; }
      expect(held).toContain(hold.pid!);
      const r = migrateLegacyEngineData({ dataDir: data, legacyDb: legacy });
      expect(r.action).toBe("refused");
      if (r.action === "refused") {
        expect(r.message).toContain(String(hold.pid));
        expect(r.message).toContain("stop that engine");
      }
      expect(existsSync(dbDir(data))).toBe(false);
      expect(existsSync(migrationMarkerOf(data))).toBe(false);
      expect(fingerprint(legacy)).toBe(before);
    } finally { hold.kill("SIGKILL"); }
    // Once the holder is gone, the next start copies.
    for (let i = 0; i < 50 && holdersOf(legacy)?.length; i++) await Bun.sleep(100);
    expect(migrateLegacyEngineData({ dataDir: data, legacyDb: legacy }).action).toBe("copied");
  }, 30_000);
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

  test("the engine's last stderr lines are there to show when it didn't come up", () => {
    const data = join(scratch(), "e");
    const logs = join(data, ".rivetkit", "var", "logs", "rivet-engine");
    mkdirSync(logs, { recursive: true });
    writeFileSync(join(logs, "engine-1-stderr.log"), "old\n");
    writeFileSync(join(logs, "engine-2-stderr.log"), "a\nRivet Engine has been rolled back to a previous version\n");
    expect(engineLogTail(data)).toContain("rolled back");
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
