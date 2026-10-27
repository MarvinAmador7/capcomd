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

/** The harness socket path: --harness-socket > CAPCOMD_HARNESS_SOCKET > config harness.socket (unless CAPCOMD_NO_CONFIG) > ~/.capcomd/harness.sock. */
async function harnessSocket(flag?: string): Promise<string> {
  const { harnessSocketPath } = await import("../../api/socket");
  const { readConfig, userConfigPath, projectConfigPath } = await import("../../config/store");
  const config = process.env.CAPCOMD_NO_CONFIG ? {} : { ...readConfig(userConfigPath()), ...readConfig(projectConfigPath()) };
  return harnessSocketPath({ ...(flag ? { flag } : {}), config });
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
export async function serve(opts: { port: number; harnessSocket?: string }) {
  const port = opts.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535 - 10) {
    console.error(`capcomd serve: invalid --port ${port}`);
    process.exit(2);
  }
  // One harness.v1 socket per daemon: never take over one that another daemon is serving (it would lose its clients).
  // Checked before the engine starts (a clear error, nothing touched); serveHarnessSocket checks again when it binds.
  const { probeHarnessSocket, serveHarnessSocket, HarnessSocketInUseError } = await import("../../api/socket");
  const sock = await harnessSocket(opts.harnessSocket);
  const held = await probeHarnessSocket(sock);
  if (held.state === "live") {
    console.error(`capcomd serve: ${new HarnessSocketInUseError(sock, held.version, held.detail).message}`);
    process.exit(1);
  }
  const busy: number[] = [];
  for (const p of [port, port + 1, port + 10]) if (!(await portFree(p))) busy.push(p);
  if (busy.length) {
    console.error(`capcomd serve: port${busy.length > 1 ? "s" : ""} ${busy.join(", ")} already in use (the engine needs ${port}, ${port + 1} and ${port + 10}); stop the other engine or pick another --port`);
    process.exit(1);
  }
  process.env.RIVET_RUN_ENGINE_PORT = String(port);
  // What the engine host starts itself (a paused agent's driver, at its reset) talks to this engine.
  process.env.CAPCOMD_ENDPOINT = `http://127.0.0.1:${port}`;
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
    // The single executable carries the engine and extracts it once per version; from source it's the npm package's.
    const { embedded, engineWrapperPath, onDisk } = await import("../../utils/assets");
    const real = embedded.engine ? onDisk("rivet-engine", embedded.engine) : (createRequire(import.meta.url)("@rivetkit/engine-cli").getEnginePath() as string);
    process.env.CAPCOMD_REAL_ENGINE = real;
    process.env.RIVET_ENGINE_BINARY = engineWrapperPath();
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
  // rivet-services (RivetKit starts it on the default port) is a child of this process that only RivetKit's own shutdown
  // stops: after the watchdog's exit or a signal it was left running, kept :8642, and reconnected its envoy to the next
  // engine on this port, another daemon's (live Mac, 2026-10-27); that daemon's own services then failed to bind.
  const servicesPids = () => (spawnSync("ps", ["-ax", "-o", "pid=,ppid=,command="], { encoding: "utf8" }).stdout ?? "").split("\n").flatMap((l) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l);
    return m && Number(m[2]) === process.pid && /rivet-services/.test(m[3]!) ? [Number(m[1])] : [];
  });
  const gone = (pid: number) => { try { process.kill(pid, 0); } catch { return true; } return /^Z/.test((spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout ?? "").trim()); };
  // rivet-engine runs in its own process group: kill it whenever serve exits. On a signal, wait for it to go (its
  // graceful shutdown can take seconds on a slow host), then SIGKILL; `exit` can only ask, as a last resort.
  const reap = () => {
    for (const pid of servicesPids()) try { process.kill(pid, "SIGTERM"); } catch {}
    const pid = enginePid(); if (pid && isAlive(pid)) { try { process.kill(pid, "SIGTERM"); } catch {} }
    rmSync(pidFile, { force: true });
  };
  const stopEngine = async () => {
    const services = servicesPids();
    for (const pid of services) try { process.kill(pid, "SIGTERM"); } catch {}
    const pid = enginePid();
    if (pid && isAlive(pid)) {
      try { process.kill(pid, "SIGTERM"); } catch {}
      for (let i = 0; i < 50 && isAlive(pid); i++) await new Promise((r) => setTimeout(r, 100));
      if (isAlive(pid)) try { process.kill(pid, "SIGKILL"); } catch {}
    }
    for (let i = 0; i < 30 && services.some((p) => !gone(p)); i++) await new Promise((r) => setTimeout(r, 100));
    for (const p of services) if (!gone(p)) try { process.kill(p, "SIGKILL"); } catch {}
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
    const [cmd, ...args] = (await import("../../utils/self")).selfArgv(...process.argv.slice(2));
    const child = spawn(cmd!, args, { stdio: "inherit", env: { ...process.env, CAPCOMD_SERVE_EXEC: "1" } });
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

  // The daemon's durable state (idempotency keys, its own audit events): the harness API and the engine share it, so
  // machines the engine deletes (a worker's drain, the sweep below) are audited with the API's (ADR-021 §5).
  const { harnessState } = await import("../../api/state");
  const harnessStore = harnessState();
  const audit = await import("../../providers/machine-audit");
  audit.setMachineAuditSink((e) => { harnessStore.recordDaemonEvent(e); });

  // Docker doesn't delete containers by itself (ADR-020): remove capcomd's expired ones now and every 5 minutes.
  if ((await import("../../providers/registry")).sandboxName() === "docker") {
    const { DockerProvider, sweepIdle } = await import("../../providers/docker");
    const docker = new DockerProvider();
    const sweep = () => sweepIdle(docker).then((gone) => { if (gone.length) console.log(`  removed ${gone.length} expired sandbox container(s)`); }, () => {});
    void sweep();
    setInterval(sweep, 5 * 60_000).unref?.();
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

  // harness.v1 API on the 0600 Unix socket (flag > CAPCOMD_HARNESS_SOCKET > config harness.socket > ~/.capcomd/harness.sock).
  try {
    const { harnessApp } = await import("../../api/server");
    const { rivetSource } = await import("../../api/rivet-source");
    const harness = await serveHarnessSocket(sock, harnessApp({ source: rivetSource(), state: harnessStore }).fetch);
    // Removed on the way out only while it is still ours: never another daemon's socket.
    process.on("exit", () => harness.release());
    console.log(`✓ harness.v1 API on ${sock}`);
  } catch (e) {
    if (e instanceof HarnessSocketInUseError) { console.error(`capcomd serve: ${e.message}`); process.exit(1); }
    console.error(`capcomd serve: harness API failed to start: ${(e as Error).message}`);
  }
  console.log("  Press Ctrl+C to stop");
  await new Promise(() => {});
}
