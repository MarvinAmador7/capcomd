import { createServer } from "net";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";
import { createRequire } from "module";

/** True when 127.0.0.1:port can be bound right now (nobody else listens). */
function portFree(port: number): Promise<boolean> {
  return new Promise((res) => {
    const srv = createServer().once("error", () => res(false)).once("listening", () => srv.close(() => res(true)));
    srv.listen(port, "127.0.0.1");
  });
}

/** "pid N (command)" of whoever listens on 127.0.0.1:port, when lsof can tell; else null. */
function portOwner(port: number): string | null {
  try {
    const out = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"], { encoding: "utf8", timeout: 2000 }).stdout ?? "";
    const pid = /^p(\d+)/m.exec(out)?.[1], cmd = /^c(.+)/m.exec(out)?.[1];
    return pid ? `pid ${pid}${cmd ? ` (${cmd})` : ""}` : null;
  } catch { return null; }
}

/** pid's descendants, all levels, read before any is signalled (a dead parent's children are reparented out of reach). */
function descendants(pid: number): number[] {
  const kids = (spawnSync("pgrep", ["-P", String(pid)], { encoding: "utf8", timeout: 2000 }).stdout ?? "").split(/\s+/).filter(Boolean).map(Number);
  return kids.flatMap((k) => [k, ...descendants(k)]);
}

/** True while pid is a live rivet-services (not a zombie, not a pid recycled to another program). */
function isServices(pid: number): boolean {
  const ps = (spawnSync("ps", ["-o", "stat=,command=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 }).stdout ?? "").trim();
  return /rivet-services/.test(ps) && !ps.startsWith("Z");
}

/** The rivet-services processes among pid's descendants. */
const servicesUnder = (pid: number) => descendants(pid).filter(isServices);

/** The harness socket path: --harness-socket > CAPCOMD_HARNESS_SOCKET > config harness.socket (unless CAPCOMD_NO_CONFIG) > ~/.capcomd/harness.sock. */
export async function harnessSocket(flag?: string): Promise<string> {
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
  // rivet-services, when it runs (RivetKit's default: on the default port only; RIVET_RUN_SERVICES=0/1 overrides, and
  // off the default port serve turns it off below), binds RIVET_PORT, 8642 by default, whatever --port is.
  const services = process.env.RIVET_RUN_SERVICES === undefined ? port === 6420 : process.env.RIVET_RUN_SERVICES === "1";
  const needed = [port, port + 1, port + 10, ...(services ? [Number(process.env.RIVET_PORT) || 8642] : [])];
  const busy: number[] = [];
  for (const p of needed) if (!(await portFree(p))) busy.push(p);
  if (busy.length) {
    for (const p of busy) { const who = portOwner(p); if (who) console.error(`capcomd serve: :${p} is held by ${who}`); }
    console.error(`capcomd serve: port${busy.length > 1 ? "s" : ""} ${busy.join(", ")} already in use (the engine needs ${needed.slice(0, -1).join(", ")} and ${needed.at(-1)}); stop the other engine or pick another --port`);
    process.exit(1);
  }
  process.env.RIVET_RUN_ENGINE_PORT = String(port);
  // This is the daemon: its verifies are judged by its own plugins, loaded below (src/plugins/hooks.ts gates).
  (await import("../../plugins/hooks")).daemonHooks();
  // What the engine host starts itself (a paused agent's driver, at its reset) talks to this engine.
  process.env.CAPCOMD_ENDPOINT = `http://127.0.0.1:${port}`;
  // Every engine keeps its data under capcomd's home, one dir per port (src/engine/data.ts): never rivetkit's shared
  // ~/.rivetkit, which other rivetkit projects also use (a newer one stamps the db and ours then refuses to open it).
  const data = await import("../../engine/data");
  const dataDir = data.engineDataDir(port);
  mkdirSync(dataDir, { recursive: true });
  const pidFile = process.env.CAPCOMD_ENGINE_PIDFILE ?? data.pidFileOf(dataDir);
  process.env.CAPCOMD_ENGINE_PIDFILE = pidFile;
  process.env.CAPCOMD_ENGINE_DATA = dataDir;
  // rivetkit's own files (engine logs, runtime stamp) go under the data dir too: <data>/.rivetkit/.
  process.env.RIVETKIT_STORAGE_PATH = dataDir;
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
  // (Before the per-port layout, its pid file was <home>/engine/<port>.pid.)
  const readPid = (f: string) => { try { const n = Number(readFileSync(f, "utf8").trim()); return n > 1 ? n : null; } catch { return null; } };
  const enginePid = () => readPid(pidFile);
  // Alive AND still a rivet-engine (guards against a recycled pid; `ps` works on Linux and macOS). A zombie (exited,
  // not yet reaped) counts as gone.
  const isAlive = (pid: number) => {
    try { process.kill(pid, 0); } catch { return false; }
    const ps = (spawnSync("ps", ["-o", "stat=,command=", "-p", String(pid)], { encoding: "utf8" }).stdout ?? "").trim();
    return /rivet-engine/.test(ps) && !ps.startsWith("Z");
  };
  const gone = (pid: number) => { try { process.kill(pid, 0); } catch { return true; } return /^Z/.test((spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout ?? "").trim()); };
  // The engine leads its own process group: signal its descendants, that group and the engine itself, so nothing it
  // started outlives it. Only an engine this serve can vouch for: one that is alive and still a rivet-engine, or one
  // that is gone (a group under its pid can then only be the one it led, since a pid isn't reused while its group
  // lives). A pid recycled to another program is left alone.
  const killTree = (pid: number, sig: NodeJS.Signals) => {
    if (!isAlive(pid) && !gone(pid)) return;
    const tree = descendants(pid);
    try { process.kill(-pid, sig); } catch {}
    try { process.kill(pid, sig); } catch {}
    for (const k of tree) { try { process.kill(-k, sig); } catch {} try { process.kill(k, sig); } catch {} }
  };
  for (const f of [pidFile, data.legacyPidFile(port)]) {
    const stale = readPid(f);
    if (stale && isAlive(stale)) {
      console.log(`  stopping a stale engine (pid ${stale}) left by an earlier serve on :${port}`);
      killTree(stale, "SIGKILL");
      for (let i = 0; i < 50 && isAlive(stale); i++) await new Promise((r) => setTimeout(r, 100));
    }
    if (f !== pidFile) rmSync(f, { force: true });
  }
  // Once per start (not again in the engine host below): the version guard. The engine's version is recorded only once
  // it answers (below), so the record never names an engine that didn't open it.
  if (process.env.CAPCOMD_SERVE_EXEC !== "1") {
    const real = process.env.CAPCOMD_REAL_ENGINE ?? process.env.CAPCOMD_TEST_REAL_ENGINE ?? process.env.RIVET_ENGINE_BINARY!;
    const engineVersion = data.engineVersionOf(real);
    if (engineVersion) process.env.CAPCOMD_ENGINE_VERSION = engineVersion;
    const held = data.holdersOf(data.dbDir(dataDir));
    if (held === null || held.length) { console.error(`capcomd serve: ${data.dbDir(dataDir)} is in use by ${data.describeHolders(held)} (another engine on this data dir?); stop it and retry.`); process.exit(1); }
    if (engineVersion === null) console.log(`  couldn't read the engine's version (${real} --version); starting without the version check or backup`);
    const p = data.prepareEngineData({ dataDir, engineVersion });
    if (p.action === "refused") { console.error(`capcomd serve: ${p.message}`); process.exit(1); }
    if (p.action === "backed-up") console.log(`  ${p.message}`);
    if (p.action === "set-aside") {
      // Its runs are gone with it: they leave the run list (rows from before that engine's last write; a run another
      // engine holds is newer), kept beside it in runs-rivet-v2.jsonl.
      let left = "";
      try {
        const r = (await import("../../primitives/ops")).setAsideRuns(data.newestWrite(data.dbDir(p.to)));
        if (r.moved) left = ` ${r.moved} run${r.moved === 1 ? "" : "s"} from before it left the run list (kept in ${r.to}).`;
      } catch (e) { left = ` The run list still names its runs (${(e as Error).message}).`; }
      console.log(`  ${p.message}${left}`);
    }
  }
  rmSync(pidFile, { force: true });
  // rivet-services (RivetKit starts it on the default port) is a child of this process that only RivetKit's own shutdown
  // stops: after the watchdog's exit or a signal it was left running, kept :8642, and reconnected its envoy to the next
  // engine on this port, another daemon's (live Mac, 2026-10-27); that daemon's own services then failed to bind.
  const servicesPids = () => (spawnSync("ps", ["-ax", "-o", "pid=,ppid=,command="], { encoding: "utf8" }).stdout ?? "").split("\n").flatMap((l) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l);
    return m && Number(m[2]) === process.pid && /rivet-services/.test(m[3]!) ? [Number(m[1])] : [];
  });
  // rivet-engine runs in its own process group: kill it and its tree whenever serve exits. On a signal, wait for it to go
  // (its graceful shutdown can take seconds on a slow host), then SIGKILL; `exit` can only ask, as a last resort.
  const reap = () => {
    for (const pid of servicesPids()) try { process.kill(pid, "SIGTERM"); } catch {}
    // An engine that already died may have left its group behind: SIGKILL what's left of it.
    const pid = enginePid(); if (pid) killTree(pid, isAlive(pid) ? "SIGTERM" : "SIGKILL");
    rmSync(pidFile, { force: true });
  };
  const stopEngine = async () => {
    const services = servicesPids();
    for (const pid of services) try { process.kill(pid, "SIGTERM"); } catch {}
    const pid = enginePid();
    if (pid) {
      killTree(pid, "SIGTERM");
      for (let i = 0; i < 50 && isAlive(pid); i++) await new Promise((r) => setTimeout(r, 100));
      killTree(pid, "SIGKILL"); // the engine, if it's still up, and anything it left behind in its group
    }
    for (let i = 0; i < 30 && services.some((p) => !gone(p)); i++) await new Promise((r) => setTimeout(r, 100));
    for (const p of services) if (!gone(p)) try { process.kill(p, "SIGKILL"); } catch {}
    rmSync(pidFile, { force: true });
  };
  process.on("exit", reap);
  // The plugin host, once it has started (below): plugins dispose in reverse load order before the engine stops (§5.5).
  let plugins: { stop(): Promise<void> } | null = null;
  // The actors' drain, once the registry has started (below).
  let drain: (() => Promise<unknown>) | null = null;
  // The engine host's stop (the outer serve below waits for it). rivetkit's own SIGINT/SIGTERM handlers are off
  // (src/registry.ts `shutdown.disableSignalHandlers`): they re-raised the signal once rivetkit had drained, which killed
  // this process before it had stopped the rivet-services it started (rivetkit 3.x, services 0.2.5: still up 5 s later).
  if (process.env.CAPCOMD_SERVE_EXEC === "1") for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, async () => {
    if (plugins) {
      // §5.5 stop step 1: daemon.stopping, with 5 s for its listeners to finish, then the plugins dispose.
      const { hooks } = await import("../../plugins/hooks");
      if (hooks.listening("daemon.stopping")) {
        hooks.fire("daemon.stopping", "observe", { reason: "signal", deadline: new Date(Date.now() + 5000).toISOString() }, { principal: { kind: "operator", clientId: null }, entity: "daemon" });
        await Promise.race([hooks.idle(), new Promise((r) => setTimeout(r, 5000))]);
      }
      await plugins.stop().catch((e: Error) => console.error(`capcomd serve: stopping plugins: ${e.message}`));
    }
    console.log("\nStopping engine...");
    if (drain) await Promise.race([drain().catch(() => {}), new Promise((r) => setTimeout(r, 6000))]);
    await stopEngine();
    process.exit(0);
  });
  // rivet-services (unused by capcomd) binds a fixed :8642; never let it collide off the default port.
  if (port !== 6420 && process.env.RIVET_RUN_SERVICES === undefined) process.env.RIVET_RUN_SERVICES = "0";

  // RivetKit's native layer reads RIVET_* / engine-binary env when it loads, which in this CLI is
  // before serve runs; so start the engine in a child that has the env from the first instruction.
  if (process.env.CAPCOMD_SERVE_EXEC !== "1") {
    const { spawn } = await import("child_process");
    const [cmd, ...args] = (await import("../../utils/self")).selfArgv(...process.argv.slice(2));
    const child = spawn(cmd!, args, { stdio: "inherit", env: { ...process.env, CAPCOMD_SERVE_EXEC: "1" } });
    // On a signal the engine host stops its plugins, its engine and the rivet-services it started, then exits: wait for
    // it (20 s at most, then SIGKILL), so whoever signalled serve sees it exit only once they're gone. The services under
    // it are read first: once the host has exited they're reparented out of reach, and any it left are stopped here.
    let stopping = false, orphans: number[] = [];
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => {
      if (!stopping) {
        stopping = true;
        orphans = servicesUnder(child.pid!);
        setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 20_000).unref();
      }
      child.kill(sig);
    });
    const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((r) => child.on("exit", (c, sg) => r([c, sg])));
    if (stopping) {
      for (let i = 0; i < 10 && orphans.some((p) => isServices(p)); i++) await new Promise((r) => setTimeout(r, 100));
      for (const p of orphans) if (isServices(p)) try { process.kill(p, "SIGKILL"); } catch {}
      await stopEngine(); // the engine, if the host didn't get to it
      process.exit(0);
    }
    if (signal) { process.removeAllListeners(signal); process.kill(process.pid, signal); } // same death (137 for a SIGKILL killpoint)
    process.exit(code ?? 1);
  }

  console.log(`Starting Rivet engine on port ${port}...`);
  const { registry } = await import("../../registry");
  try {
    await registry.start();
    drain = () => registry.shutdown();
  } catch (e) {
    console.error(`capcomd serve: engine failed to start: ${(e as Error).message}`);
    const tail = data.engineLogTail(dataDir);
    if (tail) console.error(`  the engine's last words (${dataDir}/.rivetkit/var/logs/rivet-engine/):\n${tail.replace(/^/gm, "    ")}`);
    process.exit(1);
  }
  let endpoint: string | undefined;
  try { endpoint = registry.parseConfig().endpoint; } catch {}
  if (endpoint && !endpoint.includes(`:${port}`)) {
    console.error(`capcomd serve: RivetKit endpoint ${endpoint} does not use --port ${port}; refusing to run on the wrong port`);
    process.exit(1);
  }

  // The daemon's durable state (idempotency keys, its own audit events): the harness API and the engine share it, so
  // machines the engine deletes (a worker's drain, the idle sweep) are audited with the API's (ADR-021 §5).
  const { harnessState } = await import("../../api/state");
  const harnessStore = harnessState();
  const audit = await import("../../providers/machine-audit");
  audit.setMachineAuditSink((e) => { harnessStore.recordDaemonEvent(e); });

  // harness.v1 requests not yet answered ("METHOD /path#n"), named when the watchdog gives up.
  const inflight = new Set<string>();
  // Watchdog: up within 90s, then exit after ~20s of no answer (engine child died, port lost). It stops the engine and
  // what it started before exiting (the exit handler can only ask them to go).
  let dying = false;
  const die = async (msg: string, tail?: string | null) => {
    if (dying) return;
    dying = true;
    console.error(msg);
    if (tail) console.error(tail);
    if (inflight.size) console.error(`  ${inflight.size} harness request(s) in flight: ${[...inflight].slice(0, 20).join(", ")}${inflight.size > 20 ? ", …" : ""}`);
    await stopEngine();
    process.exit(1);
  };
  const url = `http://127.0.0.1:${port}/`;
  const alive = () => fetch(url, { signal: AbortSignal.timeout(2000) }).then(() => true, () => false);
  // An engine that exited under us starts again in place, on the same data, with the argv and RIVET__* settings
  // rivetkit first gave it (src/engine/engine-wrapper.sh records them). rivet-engine 3.x renews a 30 s topology lease;
  // after the machine slept longer than that it fences itself on wake and exits ("topology fenced this worker: lease
  // expired …", rivet engine/packages/topology/src/config.rs `LeaseTiming`, not configurable), and rivetkit only logs
  // the crash. Its actors' state is in the engine's storage; rivetkit's envoy reconnects to the new engine by itself,
  // and the harness API stays open meanwhile. Before, serve exited ("stopped answering") and launchd restarted it: on
  // a Mac that sleeps, every wake. At most 5 restarts in 10 minutes; then, or when the new engine never answers, serve
  // exits as before.
  const launch = (): { argv: string[]; env: Record<string, string> } | null => {
    try {
      const argv = readFileSync(join(dataDir, "engine-launch.argv"), "utf8").split("\0").slice(0, -1);
      const env = Object.fromEntries(readFileSync(join(dataDir, "engine-launch.env"), "utf8").split("\0").slice(0, -1)
        .flatMap((kv) => { const i = kv.indexOf("="); return i > 0 && kv.startsWith("RIVET__") ? [[kv.slice(0, i), kv.slice(i + 1)]] : []; }));
      return argv.length ? { argv, env } : null;
    } catch { return null; }
  };
  const restarts: number[] = [];
  let restarting = false;
  const restartEngine = async (old: number) => {
    const how = launch();
    const now = Date.now();
    while (restarts.length && now - restarts[0]! > 600_000) restarts.shift();
    if (!how) return die(`capcomd serve: the engine on :${port} exited (pid ${old}) and can't be started again in place (no launch record); exiting`);
    if (restarts.length >= 5) return die(`capcomd serve: the engine on :${port} exited ${restarts.length + 1} times in 10 minutes; exiting`, data.engineLogTail(dataDir));
    restarts.push(now);
    restarting = true;
    console.error(`capcomd serve: the engine on :${port} exited (pid ${old}, as after the machine slept); starting it again on the same data`);
    killTree(old, "SIGKILL"); // anything left in its process group
    const logs = join(dataDir, ".rivetkit", "var", "logs", "rivet-engine");
    mkdirSync(logs, { recursive: true });
    const stamp = Math.floor(Date.now() / 1000);
    const { spawn } = await import("child_process");
    // Its own process group, as rivetkit starts it: a signal to serve's group never reaches it twice; stopEngine and
    // the exit handler stop it by the pid the wrapper records.
    const out = openSync(join(logs, `engine-${stamp}-stdout.log`), "a"), err = openSync(join(logs, `engine-${stamp}-stderr.log`), "a");
    const child = spawn(how.argv[0]!, how.argv.slice(1), { env: { ...process.env, ...how.env }, detached: true, stdio: ["ignore", out, err] });
    child.on("error", () => {});
    closeSync(out); closeSync(err);
    for (let i = 0; i < 45 && !dying; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      if (await alive()) { misses = 0; restarting = false; return; }
      if (child.exitCode !== null) break;
    }
    restarting = false;
    const tail = data.engineLogTail(dataDir);
    return die(`capcomd serve: the engine on :${port} didn't come back after a restart; exiting`, tail && `  the engine's last words:\n${tail.replace(/^/gm, "    ")}`);
  };
  const t0 = Date.now();
  let up = false, misses = 0, lastTick = Date.now();
  setInterval(async () => {
    if (dying || restarting) return;
    // serve itself was suspended (the machine slept): the misses before it say nothing about the engine now.
    const tick = Date.now();
    if (tick - lastTick > 10_000) misses = 0;
    lastTick = tick;
    if (await alive()) {
      if (!up) {
        console.log(`✓ Rivet engine running at http://localhost:${port}`);
        // It opened the data: record which engine did (its /health says; else the binary's --version).
        const health: any = await fetch(`${url}health`, { signal: AbortSignal.timeout(2000) }).then((r) => r.json(), () => null);
        const version = typeof health?.version === "string" ? health.version : process.env.CAPCOMD_ENGINE_VERSION;
        if (version) try { data.recordEngineVersion(dataDir, version, (await import("../../utils/self")).VERSION); } catch {}
      }
      up = true; misses = 0; return;
    }
    if (!up && Date.now() - t0 > 90_000) {
      const tail = data.engineLogTail(dataDir);
      return die(`capcomd serve: engine never answered on :${port} within 90s; exiting`, tail && `  the engine's last words:\n${tail.replace(/^/gm, "    ")}`);
    }
    // Not answering because it exited (its pid file names a process that is gone): start it again in place.
    const pid = enginePid();
    if (up && pid && gone(pid)) return restartEngine(pid);
    if (up && ++misses >= 10) return die(`capcomd serve: engine on :${port} stopped answering; exiting`);
  }, 2000);

  // Open the API once capcomd's actors can answer (rivetkit's envoy has registered with the engine; registry.start()
  // doesn't wait for it): a client that connects right after a restart, like the menu bar, would otherwise exhaust the
  // engine's wake retries on every run it reads. Bounded by rivetkit (30 s); the API opens either way.
  await registry.startAndWait().catch((e: Error) => console.error(`capcomd serve: actors not ready yet (${e.message}); opening the harness API anyway`));

  // Plugins (docs/spec/plugin-api.md §5.5): discovered, validated and resolved, then loaded one at a time, after the
  // actors answer and before the API opens, so a client never sees a half-loaded daemon. A plugin that fails is listed
  // with its cause and the daemon goes on.
  const P = await import("../../plugins/host");
  // Background jobs and timers (§16.2): a plugin's timer is on the daemon's stream; plugins start theirs as they load.
  const J = await import("../../jobs/service");
  J.useDaemonEvents((e) => harnessStore.recordDaemonEvent(e));
  // Triggers (§16.3): the intake's events are on the daemon's stream too, and its sweep ends subscriptions.
  (await import("../../triggers/intake")).startTriggers((e) => harnessStore.recordDaemonEvent(e));
  // Out-of-process plugins (§9) connect to a socket of their own, bound now: they open their sessions while they load
  // (§5.5 step 4), before the harness socket opens to clients. It serves the same API, to their tokens only.
  const { pluginSocketPath } = await import("../../api/socket");
  const pluginSock = pluginSocketPath(sock);
  const host = P.kernelHost({ record: (e) => harnessStore.recordDaemonEvent(e), events: { daemon: (after) => harnessStore.daemonEvents(after) }, snapshot: P.pluginsSnapshotPath(), socket: sock, endpoint: process.env.CAPCOMD_ENDPOINT, jobs: true, triggers: true, process: { socket: pluginSock } });
  process.on("exit", () => P.releaseSnapshot());
  const { harnessApp, pluginsOnly } = await import("../../api/server");
  const { rivetSource } = await import("../../api/rivet-source");
  const { pluginStore } = await import("../../plugins/storage");
  const { kernelFrontDoor } = await import("../../api/front-door");
  const app = harnessApp({ source: rivetSource(), state: harnessStore, plugins: () => host.list(), pluginHost: host, pluginStorage: (name) => pluginStore(name, P.pluginDataDir(name)), frontDoor: kernelFrontDoor() });
  try {
    const plugSocket = await serveHarnessSocket(pluginSock, pluginsOnly((req) => app.fetch(req)));
    process.on("exit", () => plugSocket.release());
  } catch (e) {
    // Without it the out-of-process plugins can't connect: they fail their handshake; the daemon goes on.
    console.error(`capcomd serve: the plugin socket ${pluginSock} didn't open: ${(e as Error).message}`);
  }
  let started = false;
  try { await host.start(P.builtinCandidates()); started = true; } catch (e) { console.error(`capcomd serve: plugins failed to start: ${(e as Error).message}`); }
  plugins = host;
  // The kernel's hook sites fire through this host's registry from now on (§17.2 step 2), and its sandbox seams are
  // the places runs use (§17.2 step 3). A host that didn't start may hold only some of them: the daemon then keeps the
  // built-in sandboxes it activated itself, rather than fail every run on a place it lost.
  const H = await import("../../plugins/hooks");
  H.useHooks(host.hooks);
  const SB = await import("../../plugins/sandboxes");
  if (started) SB.useSandboxHost(host);
  // The timers of the daemon and its runs, from their records (§16.2 rule 6), now that their listeners are loaded. (A
  // place that doesn't delete idle machines by itself, Docker, sweeps on its plugin's own timer.)
  await J.resumeTimers().catch((e) => console.error(`capcomd serve: re-arming timers: ${(e as Error).message}`));
  // And the agent providers are the ones its plugins registered (§7.3, §17.2 step 4); a host that didn't start leaves
  // the built-ins.
  if (started) (await import("../../plugins/agents")).useAgentSeams(host.contributions);
  // Merges land and pull requests open through this host's forges (§7.4, step 6); a host that didn't start leaves the
  // daemon on a host of the forge plugins alone, as the CLI uses.
  if (started) (await import("../../plugins/forges")).useForges(host);
  // And the context providers a profile names are its plugins' (ADR-025 §3.1).
  if (started) (await import("../../context/providers")).useContextHost(host);

  // harness.v1 API on the 0600 Unix socket (flag > CAPCOMD_HARNESS_SOCKET > config harness.socket > ~/.capcomd/harness.sock).
  try {
    let seq = 0;
    const harness = await serveHarnessSocket(sock, async (req: Request) => {
      const key = `${req.method} ${new URL(req.url).pathname}#${++seq}`;
      inflight.add(key);
      try { return await app.fetch(req); } finally { inflight.delete(key); }
    });
    // Removed on the way out only while it is still ours: never another daemon's socket.
    process.on("exit", () => harness.release());
    console.log(`✓ harness.v1 API on ${sock}`);
  } catch (e) {
    if (e instanceof HarnessSocketInUseError) { console.error(`capcomd serve: ${e.message}`); process.exit(1); }
    console.error(`capcomd serve: harness API failed to start: ${(e as Error).message}`);
  }
  // §5.5 start step 5: the daemon is up, with its final plugin list.
  if (H.hooks.listening("daemon.started")) {
    const { CAPABILITY_NAMES } = await import("../../api/contract");
    const { LISTED_PROVIDERS } = await import("../../providers/registry");
    const listed = (s: string) => (s === "active" || s === "failed" || s === "disposed" ? s : "validated");
    H.hooks.fire("daemon.started", "observe", { version: (await import("../../utils/self")).VERSION, api: { socket: sock, capabilities: [...CAPABILITY_NAMES] }, plugins: host.list().map((p) => ({ name: p.name, version: p.version, runtime: p.runtime, state: listed(p.state) })), sandboxes: [...LISTED_PROVIDERS] },
      { principal: { kind: "operator", clientId: null }, entity: "daemon" });
  }
  console.log("  Press Ctrl+C to stop");
  await new Promise(() => {});
}
