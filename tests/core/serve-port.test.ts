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

function runServe(port: number, timeoutMs: number, sock = privateHarnessSocket(), env: Record<string, string> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "capcomd-serve-port-"));
  const pidFile = join(dataDir, "engine.pid");
  const child = spawn(process.execPath, [CLI, "serve", "--port", String(port)], { cwd: REPO, env: { ...process.env, CAPCOMD_CHAOS_ENGINE_DATA: dataDir, CAPCOMD_ENGINE_PIDFILE: pidFile, CAPCOMD_HARNESS_SOCKET: sock, ...env }, stdio: ["ignore", "pipe", "pipe"], detached: true });
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

const alive = (pid: number) => { try { process.kill(pid, 0); } catch { return false; } return !/^Z/.test(Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)]).stdout.toString().trim()); };
/** The rivet-services process under serve `root` (serve runs the engine host in a child), once it answers on `port`. */
async function servicesUnder(root: number, port: number): Promise<number | null> {
  for (let i = 0; i < 120; i++) {
    const rows = Bun.spawnSync(["ps", "-ax", "-o", "pid=,ppid=,command="]).stdout.toString().split("\n").flatMap((l) => {
      const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l);
      return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3]! }] : [];
    });
    const tree = new Set([root]);
    for (let grew = true; grew;) { grew = false; for (const r of rows) if (tree.has(r.ppid) && !tree.has(r.pid)) { tree.add(r.pid); grew = true; } }
    const svc = rows.find((r) => tree.has(r.pid) && /rivet-services/.test(r.cmd));
    const up = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) }).then(() => true, () => false);
    if (svc && up) return svc.pid;
    await Bun.sleep(500);
  }
  return null;
}

// rivet-services (what RivetKit starts next to the engine on the default port) used to outlive serve: after the
// watchdog's exit it kept :8642 and reconnected its envoy to the next engine on the port, another daemon's, whose own
// services then failed to bind (live Mac, 2026-10-27). Here on a private port (RIVET_PORT) so it never meets :8642.
test("serve stops the rivet-services it started, on the watchdog's exit and on SIGTERM; the next serve gets its own", async () => {
  const port = await testPort();
  const svcPort = port + 5;
  const env = { RIVET_RUN_SERVICES: "1", RIVET_PORT: String(svcPort) };
  const s1 = runServe(port, 110_000, privateHarnessSocket(), env);
  let s2: ReturnType<typeof runServe> | null = null, svc1: number | null = null, svc2: number | null = null;
  try {
    expect((await probe(port, { CAPCOMD_READY_DEADLINE_MS: "90000" })).code).toBe(0);
    svc1 = await servicesUnder(s1.child.pid!, svcPort);
    expect(svc1).toBeGreaterThan(1);
    // The engine dies: the watchdog exits serve after ~20s without an answer; its services must go with it.
    for (let i = 0; i < 40 && !s1.out().includes("Rivet engine running"); i++) await Bun.sleep(250); // watchdog saw it up
    process.kill(s1.enginePid()!, "SIGKILL");
    expect(await s1.exited).toBe(1);
    expect(s1.out()).toContain("stopped answering");
    for (let i = 0; i < 20 && alive(svc1!); i++) await Bun.sleep(250);
    expect(alive(svc1!)).toBe(false);

    s2 = runServe(port, 110_000, privateHarnessSocket(), env);
    expect((await probe(port, { CAPCOMD_READY_DEADLINE_MS: "90000" })).code).toBe(0);
    svc2 = await servicesUnder(s2.child.pid!, svcPort);
    expect(svc2).toBeGreaterThan(1);
    expect(svc2).not.toBe(svc1);
    expect(s2.out()).not.toContain("Address already in use");
    await s2.stop();
    for (let i = 0; i < 20 && alive(svc2!); i++) await Bun.sleep(250);
    expect(alive(svc2!)).toBe(false);
  } finally {
    await s1.stop(); await s2?.stop();
    for (const p of [svc1, svc2]) if (p && alive(p)) try { process.kill(p, "SIGKILL"); } catch {}
  }
}, 240_000);

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
