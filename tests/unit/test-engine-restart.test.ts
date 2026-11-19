// The test engine helper (tests/helpers/test-engine.ts) after a failed start: a cold restart never goes back into a port
// block it can't have (CI scenarios (4), 2026-11-19: two restarts into :55480 that "already in use"), a movable engine's
// first start moves to a fresh private port and data dir, and nothing the engine doesn't own is ever killed.
import { afterEach, expect, spyOn, test } from "bun:test";
import { spawn, type ChildProcess } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Engine, PortTakenError, ephemeralPortFloor, pidsListening, portBlockFree, portFree, testPort } from "../helpers/test-engine";

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** Another process listening on 127.0.0.1:port: not the engine's, so it must never be killed. */
async function foreignListener(port: number): Promise<ChildProcess> {
  const env = { ...process.env };
  delete env.RIVET_RUN_ENGINE_PORT;
  const child = spawn(process.execPath, ["-e", `require("net").createServer().listen(${port}, "127.0.0.1"); setInterval(() => {}, 1e9);`], { env, stdio: "ignore" });
  cleanup.push(() => child.kill("SIGKILL"));
  for (let i = 0; i < 100 && (await portFree(port)); i++) await Bun.sleep(50);
  expect(await portFree(port)).toBe(false);
  return child;
}

async function makeEngine(label: string, movable: boolean) {
  const port = await testPort();
  const dataDir = mkdtempSync(join(tmpdir(), `capcomd-engine-restart-${label}-`));
  cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const engine = new Engine(`engine-restart-${label}-${port}`, { port, dataDir, movable });
  cleanup.push(() => engine.stop().catch(() => {}));
  const log = spyOn(console, "log");
  cleanup.push(() => log.mockRestore());
  const logs = () => log.mock.calls.map((c) => c.join(" "));
  return { engine, port, dataDir, logs };
}

test("testPort picks a private block below the OS's ephemeral range, so no outgoing connection can take it", async () => {
  for (let i = 0; i < 20; i++) {
    const p = await testPort();
    expect(p).toBeGreaterThanOrEqual(20_000);
    if (ephemeralPortFloor() >= 24_000) expect(p + 10).toBeLessThan(ephemeralPortFloor());
    expect(p < 6410 || p > 6430).toBe(true);
  }
});

test("a movable engine whose first start fails on a port another process holds comes up on a fresh port and data dir; the holder is left alone", async () => {
  const { engine, port, dataDir, logs } = await makeEngine("movable", true);
  const holder = await foreignListener(port);
  await engine.start(null);
  expect(engine.port).not.toBe(port);
  expect(engine.dataDir).toBe(join(dataDir, `moved-${engine.port}`));
  expect(engine.endpoint).toBe(`http://127.0.0.1:${engine.port}`);
  expect((await fetch(`${engine.endpoint}/`)).status).toBeGreaterThan(0);
  expect(logs().some((l) => l.includes(`refusing to kill pid ${holder.pid}`))).toBe(true);
  expect(logs().some((l) => l.includes(`engine moves to :${engine.port}`))).toBe(true);
  expect(alive(holder.pid!)).toBe(true);
  await engine.stop();
  expect(await portBlockFree(engine.port)).toBe(true);
  expect(alive(holder.pid!)).toBe(true);
}, 120_000);

test("an engine that may not move fails at once, naming what holds its port, instead of restarting into it; the holder is left alone", async () => {
  const { engine, port, logs } = await makeEngine("fixed", false);
  const holder = await foreignListener(port);
  const err = await engine.start(null).then(() => null, (e) => e);
  expect(err).toBeInstanceOf(PortTakenError);
  expect(String(err.message)).toContain(`pid ${holder.pid}`);
  expect(engine.port).toBe(port);
  expect(logs().filter((l) => l.includes("engine-not-ready")).length).toBe(1);
  expect(logs().some((l) => l.includes("moves to"))).toBe(false);
  expect(alive(holder.pid!)).toBe(true);
}, 60_000);

// On Linux, a socket on 127.0.0.1:port without SO_REUSEADDR (an outgoing connection's local port, a connection to itself,
// or what either leaves in TIME_WAIT for 60s once closed) fails listen(port), with no process listening there: what CI's
// :55480 restarts ran into. A plain socket connected to itself stands in (Bun's own client sockets set reuse flags; BSD,
// macOS, lets the listen through anyway).
const python = Bun.which("python3");
test.skipIf(process.platform !== "linux" || !python)("a port block taken by no listener at all (a socket connected to itself) moves a movable engine too", async () => {
  const { engine, port, logs } = await makeEngine("ownerless", true);
  const held = spawn(python!, ["-Ic", `import socket, sys, time
s = socket.socket(); s.bind(("127.0.0.1", ${port})); s.connect(("127.0.0.1", ${port})); print("held", flush=True); time.sleep(600)`], { stdio: ["ignore", "pipe", "inherit"] });
  cleanup.push(() => held.kill("SIGKILL"));
  await new Promise((r) => held.stdout!.once("data", r));
  expect(await portFree(port)).toBe(false);
  expect(await pidsListening(port)).toEqual([]);
  await engine.start(null);
  expect(engine.port).not.toBe(port);
  expect(logs().some((l) => l.includes("by no process of its own"))).toBe(true);
  expect((await fetch(`${engine.endpoint}/`)).status).toBeGreaterThan(0);
  expect(held.exitCode).toBe(null);
}, 120_000);
