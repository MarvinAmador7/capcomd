import { createServer } from "net";
import { mkdirSync, readFileSync, rmSync } from "fs";
import { spawnSync } from "child_process";
import { homedir } from "os";
import { join } from "path";
import { createRequire } from "module";

/** True when 127.0.0.1:port can be bound right now (nobody else listens). */
function portFree(port: number): Promise<boolean> {
  return new Promise((res) => {
    const srv = createServer().once("error", () => res(false)).once("listening", () => srv.close(() => res(true)));
    srv.listen(port, "127.0.0.1");
  });
}

/**
 * Run the engine on --port. RivetKit reads the engine port from RIVET_RUN_ENGINE_PORT when the
 * registry config is parsed (at start), not from any argument: before this, `serve --port N`
 * logged N but bound the default :6420 (live Mac, 2026-10-20: "Address already in use" against an
 * old engine, and the serve process stayed up). Now:
 *  - the port goes to every listener RivetKit derives from it (engine guard, api-peer port+1,
 *    metrics port+10, the native endpoint/manager URL);
 *  - those ports are checked free before starting; a busy one exits 1 with the reason;
 *  - a watchdog exits 1 if the engine never answers on our port, or stops answering.
 */
export async function serve(opts: { port: number }) {
  const port = opts.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535 - 10) {
    console.error(`capcomd serve: invalid --port ${port}`);
    process.exit(2);
  }
  const busy: number[] = [];
  for (const p of [port, port + 1, port + 10]) if (!(await portFree(p))) busy.push(p);
  if (busy.length) {
    console.error(`capcomd serve: port${busy.length > 1 ? "s" : ""} ${busy.join(", ")} already in use (the engine needs ${port}, ${port + 1} and ${port + 10}); stop the other engine or pick another --port`);
    process.exit(1);
  }
  process.env.RIVET_RUN_ENGINE_PORT = String(port);
  // Own data dir per port (the default :6420 keeps rivetkit's default dir): a second engine on the
  // shared ~/.rivetkit/var/engine/db never becomes healthy while another engine holds its LOCK.
  const dataDir = process.env.CAPCOMD_ENGINE_DATA ?? process.env.CAPCOMD_CHAOS_ENGINE_DATA ?? (port === 6420 ? undefined : join(homedir(), ".capcomd", "engine", String(port)));
  const runDir = join(homedir(), ".capcomd", "engine");
  mkdirSync(runDir, { recursive: true });
  const pidFile = process.env.CAPCOMD_ENGINE_PIDFILE ?? join(runDir, `${port}.pid`);
  process.env.CAPCOMD_ENGINE_PIDFILE = pidFile;
  if (dataDir) process.env.CAPCOMD_ENGINE_DATA = dataDir;
  if (!process.env.RIVET_ENGINE_BINARY) {
    // Launch through the wrapper (data dir + pid file); it execs the real platform binary.
    const real = createRequire(import.meta.url)("@rivetkit/engine-cli").getEnginePath() as string;
    process.env.CAPCOMD_REAL_ENGINE = real;
    process.env.RIVET_ENGINE_BINARY = new URL("../../engine/engine-wrapper.sh", import.meta.url).pathname;
  }
  // A previous serve on this port that died without reaping its engine: that engine is not
  // listening (ports were free above) but may still hold the data dir. It is ours; stop it.
  const enginePid = () => { try { const n = Number(readFileSync(pidFile, "utf8").trim()); return n > 1 ? n : null; } catch { return null; } };
  // Alive AND still a rivet-engine (guards against a recycled pid; `ps` works on Linux and macOS). A zombie (exited,
  // not yet reaped) counts as gone.
  const isAlive = (pid: number) => {
    try { process.kill(pid, 0); } catch { return false; }
    const ps = (spawnSync("ps", ["-o", "stat=,command=", "-p", String(pid)], { encoding: "utf8" }).stdout ?? "").trim();
    return /rivet-engine/.test(ps) && !ps.startsWith("Z");
  };
  const stale = enginePid();
  if (stale && isAlive(stale)) {
    console.log(`  stopping a stale engine (pid ${stale}) left by an earlier serve on :${port}`);
    try { process.kill(stale, "SIGKILL"); } catch {}
    for (let i = 0; i < 50 && isAlive(stale); i++) await new Promise((r) => setTimeout(r, 100));
  }
  rmSync(pidFile, { force: true });
  // rivet-engine runs in its own process group: kill it whenever serve exits. On a signal, wait for it to go (its
  // graceful shutdown can take seconds on a slow host), then SIGKILL; `exit` can only ask, as a last resort.
  const reap = () => { const pid = enginePid(); if (pid && isAlive(pid)) { try { process.kill(pid, "SIGTERM"); } catch {} } rmSync(pidFile, { force: true }); };
  const stopEngine = async () => {
    const pid = enginePid();
    if (pid && isAlive(pid)) {
      try { process.kill(pid, "SIGTERM"); } catch {}
      for (let i = 0; i < 50 && isAlive(pid); i++) await new Promise((r) => setTimeout(r, 100));
      if (isAlive(pid)) try { process.kill(pid, "SIGKILL"); } catch {}
    }
    rmSync(pidFile, { force: true });
  };
  process.on("exit", reap);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, async () => { console.log("\nStopping engine..."); await stopEngine(); process.exit(0); });
  // rivet-services (unused by capcomd) binds a fixed :8642; never let it collide off the default port.
  if (port !== 6420 && process.env.RIVET_RUN_SERVICES === undefined) process.env.RIVET_RUN_SERVICES = "0";

  // RivetKit's native layer reads RIVET_* / engine-binary env when it loads, which in this CLI is
  // before serve runs; so start the engine in a child that has the env from the first instruction.
  if (process.env.CAPCOMD_SERVE_EXEC !== "1") {
    const { spawn } = await import("child_process");
    const child = spawn(process.execPath, process.argv.slice(1), { stdio: "inherit", env: { ...process.env, CAPCOMD_SERVE_EXEC: "1" } });
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => child.kill(sig));
    const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((r) => child.on("exit", (c, sg) => r([c, sg])));
    if (signal) { process.removeAllListeners(signal); process.kill(process.pid, signal); } // same death (137 for a SIGKILL killpoint)
    process.exit(code ?? 1);
  }

  console.log(`Starting Rivet engine on port ${port}...`);
  const { registry } = await import("../../registry");
  try {
    await registry.start();
  } catch (e) {
    console.error(`capcomd serve: engine failed to start: ${(e as Error).message}`);
    process.exit(1);
  }
  let endpoint: string | undefined;
  try { endpoint = registry.parseConfig().endpoint; } catch {}
  if (endpoint && !endpoint.includes(`:${port}`)) {
    console.error(`capcomd serve: RivetKit endpoint ${endpoint} does not use --port ${port}; refusing to run on the wrong port`);
    process.exit(1);
  }

  // Watchdog: up within 90s, then exit after ~20s of no answer (engine child died, port lost).
  const url = `http://127.0.0.1:${port}/`;
  const alive = () => fetch(url, { signal: AbortSignal.timeout(2000) }).then(() => true, () => false);
  const t0 = Date.now();
  let up = false, misses = 0;
  setInterval(async () => {
    if (await alive()) { if (!up) console.log(`✓ Rivet engine running at http://localhost:${port}`); up = true; misses = 0; return; }
    if (!up && Date.now() - t0 > 90_000) { console.error(`capcomd serve: engine never answered on :${port} within 90s; exiting`); process.exit(1); }
    if (up && ++misses >= 10) { console.error(`capcomd serve: engine on :${port} stopped answering; exiting`); process.exit(1); }
  }, 2000);

  console.log("  Press Ctrl+C to stop");
  await new Promise(() => {});
}
