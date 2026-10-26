// `capcomd mcp` starts the engine when nothing answers (ADR-018 §2), and only on this machine.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { testPort } from "../helpers/engine";
import { ensureEngine, localPort } from "../../src/core/engine-start";

const saved = { ...process.env };
let started: number | undefined;
afterAll(() => {
  if (started) { try { process.kill(started, "SIGTERM"); } catch {} }
  for (const k of ["CAPCOMD_ENDPOINT", "CAPCOMD_HOME", "CAPCOMD_NO_ENGINE_AUTOSTART", "CAPCOMD_ENGINE_DATA", "CAPCOMD_ENGINE_PIDFILE"]) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
});

test("only a local endpoint is started", () => {
  expect(localPort("http://127.0.0.1:7123")).toBe(7123);
  expect(localPort("http://localhost")).toBe(6420);
  expect(localPort("https://engine.example.com:6420")).toBeNull();
});

test("no engine and autostart off: a typed error that says how to start one", async () => {
  process.env.CAPCOMD_ENDPOINT = `http://127.0.0.1:${await testPort()}`;
  process.env.CAPCOMD_NO_ENGINE_AUTOSTART = "1";
  const e: any = await ensureEngine({ timeoutMs: 2000 }).catch((x) => x);
  expect(e.code).toBe("engine_unreachable");
  expect(e.hint).toContain("capcomd serve");
});

test("no engine: starts `capcomd serve` detached, waits for it, and a second call finds it up", async () => {
  delete process.env.CAPCOMD_NO_ENGINE_AUTOSTART;
  process.env.CAPCOMD_HOME = mkdtempSync(join(tmpdir(), "capcomd-autostart-"));
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
