// The engine data and the engine autostart with a real `capcomd serve` (each starts a Rivet engine). The rest of both,
// with scratch dirs and a fake engine only, is in test:fast: tests/core/engine-data.test.ts, tests/core/engine-start.test.ts.
import { afterAll, expect, test } from "bun:test";
import { spawn } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { dbDir, readVersionRecord, setAsideDirOf, versionFileOf } from "../../src/engine/data";
import { ensureEngine } from "../../src/core/engine-start";
import { CLI, REPO, testPort } from "../helpers/engine";

const saved = { ...process.env };
const roots: string[] = [];
let started: number | undefined;
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "capcomd-engine-live-")); roots.push(d); return d; };
afterAll(() => {
  if (started) { try { process.kill(started, "SIGTERM"); } catch {} }
  for (const k of ["CAPCOMD_ENDPOINT", "CAPCOMD_HOME", "CAPCOMD_NO_ENGINE_AUTOSTART", "CAPCOMD_ENGINE_DATA", "CAPCOMD_ENGINE_PIDFILE"]) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

/** A db dir that looks like RocksDB's (Rivet 2.x): a LOCK, a manifest and some table files. */
function fakeDb(dir: string, files = 5, size = 1000): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "LOCK"), "");
  writeFileSync(join(dir, "CURRENT"), "MANIFEST-000001\n");
  for (let i = 0; i < files; i++) writeFileSync(join(dir, `00000${i}.sst`), Buffer.alloc(size, i));
}

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

// `capcomd mcp` starts the engine when nothing answers (ADR-018 §2), and only on this machine.
test("no engine: starts `capcomd serve` detached, waits for it, and a second call finds it up", async () => {
  delete process.env.CAPCOMD_NO_ENGINE_AUTOSTART;
  process.env.CAPCOMD_HOME = scratch();
  // The engine's data and pid file too (serve keeps them under ~/.capcomd/engine otherwise); the harness socket is
  // the preload's private one (tests/helpers/isolate-config.ts).
  process.env.CAPCOMD_ENGINE_DATA = join(process.env.CAPCOMD_HOME, "engine");
  process.env.CAPCOMD_ENGINE_PIDFILE = join(process.env.CAPCOMD_HOME, "engine.pid");
  process.env.CAPCOMD_ENDPOINT = `http://127.0.0.1:${await testPort()}`;
  const r = await ensureEngine({ timeoutMs: 90_000 });
  started = r.pid;
  expect(r.started).toBe(true);
  expect(r.pid).toBeGreaterThan(1);
  expect(await ensureEngine({ timeoutMs: 5000 })).toEqual({ started: false });
}, 120_000);
