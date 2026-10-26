// `capcomd serve --port N` must bind N (and N+1, N+10), never the default :6420; a busy port
// exits nonzero; the readiness probe never hangs past its deadline. Live Mac bug 2026-10-20.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createServer, type Server } from "net";
import { spawn } from "child_process";
import { existsSync, lstatSync, mkdtempSync, readFileSync, renameSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { CLI, REPO, testPort } from "../helpers/engine";
import { privateHarnessSocket, staleSocket } from "../helpers/harness-socket";
import { serveHarnessSocket } from "../../src/api/socket";
import { harnessApp } from "../../src/api/server";
import { harnessState } from "../../src/api/state";
import { memorySource } from "../../src/api/source";

/** A foreign listener that accepts connections and never answers (worst case for clients). */
function blackhole(port: number): Promise<Server> {
  return new Promise((res, rej) => {
    const srv = createServer(() => {}).once("error", rej).once("listening", () => res(srv));
    srv.listen(port, "127.0.0.1");
  });
}
let foreign6420: Server | null = null;
beforeAll(async () => { foreign6420 = await blackhole(6420).catch(() => null); }); // if 6420 is already taken, that's a foreign holder too
afterAll(() => { foreign6420?.close(); });

function runServe(port: number, timeoutMs: number, sock = privateHarnessSocket()) {
  const dataDir = mkdtempSync(join(tmpdir(), "capcomd-serve-port-"));
  const pidFile = join(dataDir, "engine.pid");
  const child = spawn(process.execPath, [CLI, "serve", "--port", String(port)], { cwd: REPO, env: { ...process.env, CAPCOMD_CHAOS_ENGINE_DATA: dataDir, CAPCOMD_ENGINE_PIDFILE: pidFile, CAPCOMD_HARNESS_SOCKET: sock }, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let out = "";
  child.stdout!.on("data", (d) => (out += d)); child.stderr!.on("data", (d) => (out += d));
  const exited = new Promise<number | null>((r) => child.on("exit", (c) => r(c)));
  const enginePid = () => { try { return Number(readFileSync(pidFile, "utf8").trim()) || null; } catch { return null; } };
  const hardKill = () => { const e = enginePid(); try { process.kill(-child.pid!, "SIGKILL"); } catch {} if (e) try { process.kill(e, "SIGKILL"); } catch {} };
  const timer = setTimeout(hardKill, timeoutMs);
  return {
    child, exited, out: () => out, enginePid,
    // Graceful stop (SIGTERM): serve must reap its rivet-engine (own process group) on the way out.
    stop: async () => {
      clearTimeout(timer);
      const e = enginePid();
      try { process.kill(child.pid!, "SIGTERM"); } catch {}
      const done = await Promise.race([exited.then(() => true), Bun.sleep(15_000).then(() => false)]);
      if (!done) hardKill();
      await exited;
      return e;
    },
  };
}

const probe = async (port: number, env: Record<string, string> = {}) => {
  const t0 = Date.now();
  const r = Bun.spawn([process.execPath, `${REPO}/tests/chaos/ready-probe.ts`, String(port)], { cwd: REPO, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const [err, code] = await Promise.all([new Response(r.stderr).text(), r.exited]);
  return { code, ms: Date.now() - t0, err };
};

test("serve --port N binds N even when a foreign process holds :6420; on stop it removes its own harness socket", async () => {
  const port = await testPort();
  const sock = privateHarnessSocket();
  const s = runServe(port, 110_000, sock);
  try {
    const p = await probe(port, { CAPCOMD_READY_DEADLINE_MS: "90000" });
    expect(p.code).toBe(0);
    await Bun.sleep(2500); // let the watchdog log its first ✓ line
    expect(s.out()).not.toContain("Address already in use");
    expect(s.out()).not.toContain("127.0.0.1:6420");
    expect(s.out()).toContain(String(port));
    const engine = s.enginePid();
    expect(engine).toBeGreaterThan(1);
    await s.stop();
    await Bun.sleep(500);
    let alive = true; try { process.kill(engine!, 0); } catch { alive = false; }
    expect(alive).toBe(false); // serve reaped its engine
    expect(existsSync(sock)).toBe(false); // and removed the socket it bound
  } finally { await s.stop(); }
}, 120_000);

// A second daemon on the same harness socket used to replace the file: the first daemon's clients then got
// ECONNREFUSED for good (seen 2026-10-26 on ~/.capcomd/harness.sock). Here the "first daemon" is our own harness.
test("serve refuses a harness socket a live daemon is serving, names it, and leaves it alone", async () => {
  const sock = privateHarnessSocket();
  const live = await serveHarnessSocket(sock, harnessApp({ source: memorySource(), clients: () => [], state: harnessState(null) }).fetch);
  try {
    const before = lstatSync(sock).ino;
    const s = runServe(await testPort(), 20_000, sock);
    expect(await s.exited).toBe(1);
    expect(s.out()).toContain(sock);
    expect(s.out()).toContain("version test");
    expect(s.out()).toContain("--harness-socket");
    expect(s.out()).not.toContain("Starting Rivet engine"); // refused before any engine starts
    expect(s.enginePid()).toBeNull();
    expect(lstatSync(sock).ino).toBe(before);
    expect(((await (await fetch("http://localhost/v1/health", { unix: sock } as RequestInit)).json()) as any).api).toBe("harness.v1");
  } finally { live.close(); }
}, 30_000);

test("serve replaces a dead daemon's socket, and on stop leaves a socket that is no longer its own", async () => {
  const sock = privateHarnessSocket();
  staleSocket(sock);
  const s = runServe(await testPort(), 110_000, sock);
  let foreign: ReturnType<typeof Bun.serve> | null = null;
  try {
    let ok = false;
    for (let i = 0; i < 180 && !ok; i++) {
      ok = await fetch("http://localhost/v1/health", { unix: sock, signal: AbortSignal.timeout(1000) } as RequestInit).then((r) => r.ok, () => false);
      if (!ok) await Bun.sleep(500);
    }
    expect(ok).toBe(true);
    expect(s.out()).toContain(`harness.v1 API on ${sock}`);
    // Another daemon's socket now sits at the path: stopping serve must not delete it.
    const other = join(dirname(sock), "other.sock");
    foreign = Bun.serve({ unix: other, fetch: () => new Response("theirs") });
    renameSync(other, sock);
    const theirs = lstatSync(sock).ino;
    await s.stop();
    expect(existsSync(sock)).toBe(true);
    expect(lstatSync(sock).ino).toBe(theirs);
    expect(await (await fetch("http://localhost/", { unix: sock } as RequestInit)).text()).toBe("theirs");
  } finally { await s.stop(); foreign?.stop(true); }
}, 120_000);

test("serve exits nonzero when its port is busy, and says so", async () => {
  const port = await testPort();
  const holder = await blackhole(port + 1); // api-peer port taken
  try {
    const s = runServe(port, 20_000);
    const code = await s.exited;
    expect(code).toBe(1);
    expect(s.out()).toContain(`${port + 1}`);
    expect(s.out()).toContain("already in use");
  } finally { holder.close(); }
}, 30_000);

test("ready-probe never hangs past its deadline (black-hole listener)", async () => {
  const port = await testPort();
  const holder = await blackhole(port);
  try {
    const p = await probe(port, { CAPCOMD_READY_DEADLINE_MS: "3000", CAPCOMD_READY_ATTEMPT_MS: "1000" });
    expect(p.code).toBe(1);
    expect(p.ms).toBeLessThan(8000);
  } finally { holder.close(); }
}, 20_000);
