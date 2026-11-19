import { env as envVar } from "../../src/utils/env";
import { spawn, spawnSync, type ChildProcess } from "child_process";
import { createRequire } from "module";
import { join, resolve } from "path";
import { tmpdir, userInfo } from "os";
import { mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync } from "fs";
import { createServer } from "net";
import { privateHarnessSocket } from "./harness-socket";

/**
 * Every engine (and every port a helper kills listeners on) must be private: an explicit port outside the default
 * engine's block (6420, +1, +10: a developer's daemon; the cleanup kills whatever listens there), and an explicit data
 * dir in a temp area (the OS temp dir, /tmp, or CAPCOMD_TEST_DATA_ROOT): never the user's real ~/.capcomd or
 * ~/.rivetkit, their home, the checkout or `/` (helpers delete it).
 */
export function assertPrivatePort(port: number | undefined, what = "a test helper"): number {
  if (port === undefined || !Number.isInteger(port)) throw new Error(`${what} needs an explicit private port (refusing the default :6420)`);
  if (port >= 6410 && port <= 6430) throw new Error(`${what}: port ${port} is in the default engine's block (6420, +1, +10); use a private port (tests/helpers/engine.ts testPort())`);
  return port;
}
export function assertPrivateDir(dir: string | undefined, what = "a test helper"): string {
  if (!dir) throw new Error(`${what} needs an explicit data dir (refusing the default, the user's real engine data)`);
  const d = realOrResolved(dir);
  const raw = [tmpdir(), "/tmp", "/private/tmp", "/var/folders", "/private/var/folders", envVar("TEST_DATA_ROOT")].filter(Boolean) as string[];
  const roots = [...new Set([...raw.map((r) => resolve(r)), ...raw.map(realOrResolved)])];
  if (!roots.some((r) => d !== r && d.startsWith(`${r}/`))) throw new Error(`${what}: refusing data dir ${d}: it must be inside a temp dir (${roots.join(", ")})`);
  const home = userInfo().homedir;
  for (const real of [join(home, ".capcomd"), join(home, ".rivetkit")]) if (d === real || d.startsWith(`${real}/`)) throw new Error(`${what}: refusing ${d}, inside the user's real ${real}`);
  return dir;
}
const realOrResolved = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };
export function assertPrivate(o: { port?: number; dataDir?: string }, what = "a test engine"): { port: number; dataDir: string } {
  return { port: assertPrivatePort(o.port, what), dataDir: assertPrivateDir(o.dataDir, what) };
}

const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True when 127.0.0.1:port can be listened on now, the same check `capcomd serve` makes before it starts. */
export function portFree(port: number): Promise<boolean> {
  return new Promise((res) => {
    const srv = createServer().once("error", () => res(false)).once("listening", () => srv.close(() => res(true)));
    srv.listen(port, "127.0.0.1");
  });
}
/** An engine's whole block: its port, port+1 (api-peer) and port+10 (metrics). */
export async function portBlockFree(port: number): Promise<boolean> {
  for (const p of [port, port + 1, port + 10]) if (!(await portFree(p))) return false;
  return true;
}

let ephemeralLow: number | undefined;
/**
 * The first port of the OS's ephemeral range (Linux 32768, macOS 49152). An outgoing connection can take any port from
 * there as its local port, and on Linux a socket on 127.0.0.1:N, even a closed one in TIME_WAIT for 60s, keeps
 * `listen(N)` failing with no process owning it: an engine port in that range can be taken from under a restart.
 */
export function ephemeralPortFloor(): number {
  if (ephemeralLow !== undefined) return ephemeralLow;
  let low = NaN;
  try {
    low = process.platform === "linux"
      ? Number(readFileSync("/proc/sys/net/ipv4/ip_local_port_range", "utf8").trim().split(/\s+/)[0])
      : Number(sh("sysctl", ["-n", "net.inet.ip.portrange.first"]).trim());
  } catch { /* unknown: below */ }
  return (ephemeralLow = Number.isInteger(low) && low > 1024 ? low : 32768);
}

/**
 * A free port block for a private engine: the engine binds port, port+1 (api-peer) and port+10 (metrics). Fixed
 * per-file ports overlapped (e2e 7661+10 = verify-merge 7671, ...: the 2/20 primitives flake), so blocks are picked at
 * random and checked before use: five interleaved blocks per 20 ports (base 20k+2j, j<5: 2j, 2j+1, 2j+10), from 20000
 * up to the OS's ephemeral range, which they stay below (ephemeralPortFloor: CI's scenarios (4), 2026-11-19, lost
 * :55480 to a socket no process owned).
 */
export async function testPort(): Promise<number> {
  const top = Math.min(ephemeralPortFloor(), 60_000);
  // A range too small to pick from (an odd ephemeral setting): the old 20000-59999.
  const groups = top - 20_000 >= 4_000 ? Math.floor((top - 20_000) / 20) : 2_000;
  for (let i = 0; i < 50; i++) {
    const n = Math.floor(Math.random() * groups * 5);
    const base = 20_000 + Math.floor(n / 5) * 20 + (n % 5) * 2;
    if (await portBlockFree(base)) return assertPrivatePort(base, "testPort");
  }
  throw new Error("no free engine port block");
}

// Linux reads /proc (fast, and what CI runs); other platforms (macOS) fall back to ps and lsof.
const HAS_PROC = process.platform === "linux";
const sh = (cmd: string, args: string[]) => spawnSync(cmd, args, { encoding: "utf8" }).stdout ?? "";

function processTable(): Array<{ pid: number; ppid: number }> {
  if (!HAS_PROC) {
    return sh("ps", ["-A", "-o", "pid=,ppid="]).split("\n").map((l) => l.trim().split(/\s+/).map(Number))
      .filter(([pid, ppid]) => pid! > 0 && Number.isFinite(ppid)).map(([pid, ppid]) => ({ pid: pid!, ppid: ppid! }));
  }
  const entries: Array<{ pid: number; ppid: number }> = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, "utf8");
      const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const ppid = Number(rest[1]);
      if (Number.isFinite(ppid)) entries.push({ pid: Number(name), ppid });
    } catch {
      // process exited while scanning
    }
  }
  return entries;
}

/** pid is a running process: not gone, not a zombie (exited, not yet reaped: nothing left to kill, no environ to read). */
function liveProcess(pid: number): boolean {
  if (!HAS_PROC) {
    const stat = sh("ps", ["-o", "stat=", "-p", String(pid)]).trim();
    return stat !== "" && !stat.startsWith("Z");
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return !/^[ZX]/.test(stat.slice(stat.lastIndexOf(")") + 2));
  } catch {
    return false;
  }
}

function descendantPids(root: number): number[] {
  const entries = processTable();
  const out: number[] = [];
  const stack = [root];
  const seen = new Set<number>([root]);
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    for (const entry of entries) {
      if (entry.ppid === current && !seen.has(entry.pid)) {
        seen.add(entry.pid);
        out.push(entry.pid);
        stack.push(entry.pid);
      }
    }
  }
  return out;
}

const DB_PATH = /sqlite|\.db|rivet/i;

function openDbPaths(pid: number): string[] {
  if (!HAS_PROC) {
    // lsof -F n: one "n<path>" line per open file.
    return sh("lsof", ["-nP", "-Fn", "-p", String(pid)]).split("\n")
      .filter((l) => l.startsWith("n/")).map((l) => l.slice(1)).filter((t) => DB_PATH.test(t));
  }
  const paths: string[] = [];
  let fds: string[] = [];
  try {
    fds = readdirSync(`/proc/${pid}/fd`);
  } catch {
    return paths;
  }
  for (const fd of fds) {
    try {
      const target = readlinkSync(`/proc/${pid}/fd/${fd}`);
      if (DB_PATH.test(target) && target.startsWith("/")) {
        paths.push(target);
      }
    } catch {
      // fd closed
    }
  }
  return paths;
}

export async function pidsListening(port: number): Promise<number[]> {
  const proc = Bun.spawn(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  return text
    .split(/\s+/)
    .map((part) => Number(part))
    .filter((pid) => Number.isFinite(pid) && pid > 0);
}

function pidsHolding(files: string[]): number[] {
  if (files.length === 0) return [];
  if (!HAS_PROC) return sh("lsof", ["-nP", "-t", "--", ...files]).split(/\s+/).map(Number).filter((n) => n > 0);
  const wanted = new Set(files);
  const holders: number[] = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    for (const path of openDbPaths(pid)) {
      if (wanted.has(path)) {
        holders.push(pid);
        break;
      }
    }
  }
  return holders;
}

/** PIDs of `src/cli/index.ts serve --port <port>` runners. Scoped by port so parallel workers never touch each other. */
export async function serveRunnerPids(port: number): Promise<number[]> {
  assertPrivatePort(port, "serveRunnerPids");
  const proc = Bun.spawn(["pgrep", "-f", `src/cli/index.ts serve --port ${port}( |$)`], { stdout: "pipe", stderr: "ignore" });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  return text.split(/\s+/).map(Number).filter((n) => n > 0 && n !== process.pid);
}

export function tailFile(path: string, max = 2000): string {
  try {
    const text = readFileSync(path, "utf8");
    return text.slice(-max);
  } catch {
    return "";
  }
}

export interface EngineOpts {
  /** Guard port. The engine also binds port+1 (api-peer) and port+10 (metrics). */
  port?: number;
  /** Isolated engine data dir (fast mode). Default: serve's own, <capcomd home>/engine/<port> (src/engine/data.ts). */
  dataDir?: string;
  /** Real git merges: a bare repo under dataDir/git (direct mode, target `trunk`). Needs dataDir. */
  repo?: boolean;
  /** Extra env for the engine/runner process (e.g. test knobs like CAPCOMD_FAKE_PUSH_DELAY_MS). */
  env?: Record<string, string>;
  /** Which `capcomd run` path the client drives. Default legacy: the killpoint gate was written
   *  against the legacy loop, so it is pinned there even though the recipe is the CLI default. */
  runPath?: "legacy" | "recipe";
  /**
   * A first start that fails and can't have its port block back (something else holds it) moves to a fresh private
   * port (testPort()) and a fresh data dir inside dataDir instead of failing. The caller reads engine.port or
   * engine.endpoint after start(). A restart (after a start that answered) never moves: its data is on that port's engine.
   */
  movable?: boolean;
}

/** Merge env for a repo-backed case. Shared by the runner (verifier merges) and the client. */
export function repoEnv(opts: EngineOpts): NodeJS.ProcessEnv {
  if (!opts.repo || !opts.dataDir) return {};
  return {
    CAPCOMD_REPO: `${opts.dataDir}/git/origin.git`,
    CAPCOMD_WORKDIR: `${opts.dataDir}/git/work`,
    CAPCOMD_MERGE_MODE: "direct",
    CAPCOMD_MERGE_STRATEGY: process.env.CAPCOMD_TEST_MERGE_STRATEGY ?? "squash",
    CAPCOMD_MERGE_TARGET: "trunk",
    CAPCOMD_TEST_COMMAND: 'test -f "tasks/$CAPCOMD_TASK_ID.md"',
  };
}

// The platform's engine binary, resolved the same way `capcomd serve` does.
const REAL_ENGINE = createRequire(import.meta.url)("@rivetkit/engine-cli").getEnginePath() as string;

export function engineEnv(opts: EngineOpts): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const { port } = assertPrivate(opts, "engineEnv");
  env.CAPCOMD_ENDPOINT = `http://127.0.0.1:${port}`;
  env.RIVET_RUN_ENGINE_PORT = String(port);
  // rivet-services (agentOS/durable streams, unused by relay) binds a fixed :8642 and
  // runs outside the runner's process group; parallel workers would share it.
  env.RIVET_RUN_SERVICES = "0";
  Object.assign(env, repoEnv(opts));
  if (opts.env) Object.assign(env, opts.env);
  if (opts.dataDir) {
    env.RIVET_ENGINE_BINARY = `${ROOT}/src/engine/engine-wrapper.sh`;
    env.CAPCOMD_TEST_REAL_ENGINE = REAL_ENGINE;
    env.CAPCOMD_TEST_ENGINE_DATA = opts.dataDir;
    // The wrapper records the engine pid here; stop() trusts it where /proc/<pid>/environ is unreadable.
    env.CAPCOMD_ENGINE_PIDFILE = join(opts.dataDir, "engine.pid");
  }
  return env;
}

/** stop() left the engine's ports or data files to processes that aren't this engine's (left alone, never killed). */
export class PortTakenError extends Error {}

const commandOf = (pid: number) => sh("ps", ["-o", "command=", "-p", String(pid)]).trim().slice(0, 120);

export class Engine {
  readonly logPath: string;
  readonly opts: EngineOpts;
  /** This engine's own harness.v1 socket (opts.env may name one): parallel engines never share or steal one. */
  readonly harnessSocket: string;
  private child: ChildProcess | null = null;
  private dataFiles: string[] = [];
  private stopping = false;
  /** Where it runs: opts' port and data dir, unless a failed first start moved it (opts.movable). */
  private at: { port: number; dataDir: string };
  /** It answered once: from then on its data matters, so it only ever comes back on the same port and data dir. */
  private wasReady = false;
  /** Pids a kill was refused for in this stop(), each said once. */
  private refused = new Set<number>();
  sawKill = false;

  constructor(label: string, opts: EngineOpts = {}) {
    this.opts = opts;
    this.at = assertPrivate(opts, `engine ${label}`);
    this.harnessSocket = opts.env?.CAPCOMD_HARNESS_SOCKET ?? privateHarnessSocket();
    this.logPath = `/tmp/relay-test-${label.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 180)}.log`;
  }

  /** The guard port. With opts.movable, read it (or endpoint) after start(): a failed first start may have moved it. */
  get port(): number {
    return this.at.port;
  }
  /** The engine's data dir now (opts.dataDir, or a fresh one inside it after a move). */
  get dataDir(): string {
    return this.at.dataDir;
  }
  get endpoint(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** Every port this engine instance owns (guard, api-peer, metrics). */
  private ports(): number[] {
    return [this.port, this.port + 1, this.port + 10];
  }

  /** The port-holder kill a killpoint started (noteKill): stop() waits for it, so a late one can't hit the next engine. */
  private killing: Promise<void> | null = null;

  private noteKill = (child: ChildProcess, code: number | null) => {
    // An earlier child's late exit (one a stop or a cold restart killed) says nothing about the engine running now.
    if (this.stopping || child !== this.child) return;
    // [DRIVER-KILL]: a driver killpoint fired in this engine host (ADR-022: the agent workflow runs the spool pump here).
    if (code === 137 || /\[KILLPOINT\]|\[DRIVER-KILL\]/.test(tailFile(this.logPath))) {
      this.sawKill = true;
      // A killpoint is a whole-host crash. The SIGKILLed runner can't reap its
      // rivet-engine child, so take the process group down. Otherwise a runner-less
      // engine keeps accepting requests and the client waits on it forever.
      const pid = this.child?.pid;
      if (pid) {
        try { process.kill(-pid, "SIGKILL"); } catch {}
      }
      // rivet-engine runs in its own process group, so the group kill above misses it.
      // Kill this instance's engine by its own ports (never a global pkill).
      this.killing = this.killPortHolders();
    }
  };

  /**
   * In isolated (fast) mode, only SIGKILL processes that belong to this instance: the
   * runner and its engine both carry RIVET_RUN_ENGINE_PORT=<port> in their environment.
   * Guards every non-group kill against PID reuse and path/port mistakes hitting a sibling worker.
   * Ask it of a live process: a killed one's environ can't be read (on Linux, from the moment it exits), so it is
   * never "owned", which is why stop() asks before its group kill.
   */
  private owns(pid: number): boolean {
    if (!HAS_PROC) {
      // No readable environ: ours = our serve child or its descendants, our engine (pid file), or a
      // serve runner for this exact port (stragglers from an earlier start of this instance).
      const root = this.child?.pid;
      if (root && (pid === root || descendantPids(root).includes(pid))) return true;
      try { if (Number(readFileSync(join(this.at.dataDir, "engine.pid"), "utf8").trim()) === pid) return true; } catch {}
      return new RegExp(`src/cli/index\\.ts serve --port ${this.port}( |$)`).test(sh("ps", ["-o", "command=", "-p", String(pid)]).trim());
    }
    try {
      return readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes(`RIVET_RUN_ENGINE_PORT=${this.port}`);
    } catch {
      return false;
    }
  }

  /** SIGKILL pid if it is still running and this engine's; a gone or zombie one has nothing left to kill. */
  private kill(pid: number): void {
    if (!liveProcess(pid)) return;
    if (!this.owns(pid)) {
      if (!this.refused.has(pid)) console.log(`    refusing to kill pid ${pid}: not owned by engine :${this.port} (${commandOf(pid)})`);
      this.refused.add(pid);
      return;
    }
    try { process.kill(pid, "SIGKILL"); } catch {}
  }

  private async killPortHolders(): Promise<void> {
    for (const port of this.ports()) {
      for (const pid of await pidsListening(port)) this.kill(pid);
    }
  }

  async start(killpoint: string | null): Promise<void> {
    this.stopping = false;
    this.sawKill = false;
    await this.spawnUntilReady(killpoint);
    this.wasReady = true;
  }

  private env(killpoint: string | null): NodeJS.ProcessEnv {
    // Port and engine data where it runs now; a repo-backed case's git stays under the data dir it was made in.
    const env: NodeJS.ProcessEnv = {
      ...process.env, ...engineEnv({ ...this.opts, ...this.at }), ...repoEnv(this.opts), ...(this.opts.env ?? {}),
      CAPCOMD_HARNESS_SOCKET: this.harnessSocket,
    };
    delete env.CAPCOMD_KILLPOINT;
    delete env.RELAY_KILLPOINT;
    if (killpoint) env.CAPCOMD_KILLPOINT = killpoint;
    return env;
  }

  /**
   * A freshly restarted engine occasionally never registers its runner
   * (`actor_ready_timeout` for 45s+, seen in a crash drill). That's a readiness
   * problem, not data loss, so cold-restart the engine on the same data dir
   * (no wipe) up to twice before giving up. Each retry is logged.
   *
   * A cold restart never goes into a port block it can't have: what holds it may be another process (never killed), or
   * no process at all (on Linux, a socket left on 127.0.0.1:port, even a closed one in TIME_WAIT for 60s, fails the next
   * serve's listen: CI scenarios (4), 2026-11-19, two restarts into :55480 that "already in use"). Then an engine that
   * never answered (a first start: no data to keep) and is opts.movable moves to a fresh private port and data dir;
   * any other fails here, saying what holds its port.
   */
  private async spawnUntilReady(killpoint: string | null): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.spawnOnce(this.env(killpoint));
        return;
      } catch (error) {
        if (attempt >= 3) throw error;
        const msg = error instanceof Error ? error.message : String(error);
        console.log(`    engine-not-ready attempt=${attempt}, cold restart: ${msg.replace(/\s+/g, " ").slice(0, 160)}`);
        let taken: PortTakenError | null = null;
        try {
          await this.stop();
        } catch (e) {
          if (!(e instanceof PortTakenError)) throw e; // its own processes outlived the stop: never leave them behind
          taken = e;
        }
        this.stopping = false;
        if (!taken && !(await portBlockFree(this.port))) {
          taken = new PortTakenError(`engine :${this.port}: its ports (${this.ports().join(", ")}) are still taken after it stopped, by no process of its own (on Linux, e.g. a socket on 127.0.0.1:${this.port} in TIME_WAIT)`);
        }
        if (!taken) continue;
        if (!this.opts.movable || this.wasReady) throw taken;
        await this.move(taken.message);
      }
    }
  }

  /** The port block can be listened on again, within ms. */
  private async blockFreeSoon(ms = 3_000): Promise<boolean> {
    const deadline = Date.now() + ms;
    for (;;) {
      if (await portBlockFree(this.port)) return true;
      if (Date.now() >= deadline) return false;
      await sleep(200);
    }
  }

  /** A fresh private port, and a fresh data dir inside opts.dataDir (private, and removed with it). */
  private async move(why: string): Promise<void> {
    const port = await testPort();
    const dataDir = join(this.opts.dataDir!, `moved-${port}`);
    this.at = assertPrivate({ port, dataDir }, `engine :${this.port} moving`);
    mkdirSync(dataDir, { recursive: true });
    this.dataFiles = [];
    console.log(`    engine moves to :${port} (data ${dataDir}): ${why.replace(/\s+/g, " ").slice(0, 200)}`);
  }

  private async spawnOnce(env: NodeJS.ProcessEnv): Promise<void> {
    const logFd = openSync(this.logPath, "a");
    const child = spawn(process.execPath, ["src/cli/index.ts", "serve", "--port", String(this.port)], {
      cwd: ROOT,
      env,
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
    this.child = child;
    child.on("exit", (code) => this.noteKill(child, code));
    await this.waitReady();
    this.captureDataFiles();
  }

  private captureDataFiles(): void {
    const pid = this.child?.pid;
    if (!pid) return;
    const files = new Set<string>(openDbPaths(pid));
    for (const child of descendantPids(pid)) {
      for (const path of openDbPaths(child)) files.add(path);
    }
    // Only this instance's engine data. The broad fd regex also matches shared files
    // (e.g. the rivetkit napi .node / rivet-engine binary), and treating those as "locks"
    // made stop() SIGKILL every other parallel worker's runner and engine.
    // Trailing slash: "/w1" must not prefix-match "/w10".."/w15" (fast attempt 2, run 1).
    const root = `${this.at.dataDir.replace(/\/$/, "")}/`;
    this.dataFiles = [...files].filter((path) => path.startsWith(root));
  }

  private async waitReady(): Promise<void> {
    const httpDeadline = Date.now() + 15_000;
    let httpUp = false;
    while (Date.now() < httpDeadline) {
      if (this.child?.exitCode !== null && this.child?.exitCode !== undefined) {
        throw new Error(
          `serve exited ${this.child.exitCode} during startup\n${tailFile(this.logPath)}`
        );
      }
      try {
        const response = await fetch(`http://127.0.0.1:${this.port}/`, {
          signal: AbortSignal.timeout(400),
        });
        if (response.status > 0) {
          httpUp = true;
          break;
        }
      } catch {
        await sleep(100);
      }
    }
    if (envVar("TEST_TS")) console.log(`    [ts] http-up`, Date.now());
    if (!httpUp) {
      throw new Error(`engine http not ready\n${tailFile(this.logPath)}`);
    }

    const probe = spawn(
      process.execPath,
      ["tests/helpers/ready-probe.ts", String(this.port)],
      { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] }
    );
    const outcome = await new Promise<{ code: number; output: string }>((resolve) => {
      let output = "";
      probe.stdout?.on("data", (chunk) => {
        output += chunk.toString();
      });
      probe.stderr?.on("data", (chunk) => {
        output += chunk.toString();
      });
      const timer = setTimeout(() => {
        probe.kill("SIGKILL");
      }, 50_000);
      probe.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? 1, output });
      });
    });
    if (envVar("TEST_TS")) console.log(`    [ts] probe-done`, Date.now(), outcome.output.replace(/\s+/g, " ").slice(-200));
    if (outcome.code === 0 && outcome.output.includes("ready")) return;
    const detail = outcome.output.replace(/\s+/g, " ").slice(-300);
    throw new Error(`engine not ready: ${detail}`);
  }

  /**
   * The daemon crashes: SIGKILL of its process group only. What it started in groups of their own (a scripted agent's
   * "VM", detached as a real VM is) keeps running, as after a real crash; then stop() takes what's left of the daemon
   * (its engine, by its ports and data files).
   */
  async crash(): Promise<void> {
    const pid = this.child?.pid;
    if (pid) try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ }
    await sleep(300);
    await this.stop();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.refused.clear();
    await this.killing?.catch(() => {});
    this.killing = null;
    const pid = this.child?.pid;
    if (pid) {
      const victims = [pid, ...descendantPids(pid)];
      // Which are ours, asked while they still run: after the group kill their environ can't be read (before this,
      // every stop logged "refusing to kill" for its own dead serve process).
      const ours = new Set(victims.filter((v) => this.owns(v)));
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // group already gone
      }
      for (const victim of victims) {
        if (ours.has(victim)) { try { process.kill(victim, "SIGKILL"); } catch {} } else this.kill(victim);
      }
    }

    // Defense in depth: no runner from an earlier engine may outlive stop(). A
    // straggler reconnects to the next engine and steals actor assignments.
    for (const straggler of await serveRunnerPids(this.port)) {
      this.kill(straggler);
    }

    const deadline = Date.now() + 8_000;
    let othersOnlySince: number | null = null;
    while (Date.now() < deadline) {
      const listeners = (await Promise.all(this.ports().map((p) => pidsListening(p)))).flat();
      const lockers = pidsHolding(this.dataFiles);
      // Every pid still listed, zombie or not: a multi-threaded engine's leader is a zombie while its other threads exit,
      // and its sockets stay open until the last one has.
      const holders = [...new Set([...listeners, ...lockers])];
      if (holders.length === 0) {
        this.child = null;
        // lsof can't see all of it: a dying engine whose leader is already a zombie lists no sockets, and still holds
        // them until its last thread exits (Linux, ~1s seen). The next start gets the block back, or decides why not.
        await this.blockFreeSoon();
        return;
      }
      for (const holder of holders) this.kill(holder);
      // Only other processes' (live, not ours: never killed) for a second: waiting longer won't free them.
      if (holders.every((h) => this.refused.has(h))) {
        othersOnlySince ??= Date.now();
        if (Date.now() - othersOnlySince >= 1_000) {
          this.child = null;
          throw new PortTakenError(`engine :${this.port}: its ports or data are held by ${holders.map((h) => `pid ${h} (${commandOf(h)})`).join(", ")}, not this engine's: left alone`);
        }
      } else othersOnlySince = null;
      await sleep(50);
    }

    throw new Error(
      `timed out waiting for :${this.port} and data locks to release (files=${this.dataFiles.join(",")})`
    );
  }
}

// 90s: still catches a CLI that never exits (seed 29), but tolerates rivetkit's ~30s
// actor-readiness stall after a cold engine restart (gate-2 push.mid evidence).
const CLIENT_TIMEOUT_MS = 90_000;

export function runClient(runId: string, opts: EngineOpts = {}): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    // CAPCOMD_SPAWN_EXEC=fake: recipe agents run the fake agent (the legacy worker already does).
    const env: NodeJS.ProcessEnv = { ...process.env, CAPCOMD_ENDPOINT: engineEnv(opts).CAPCOMD_ENDPOINT, ...repoEnv(opts), CAPCOMD_SPAWN_EXEC: "fake", CAPCOMD_AWAIT_POLL_MS: "200" };
    delete env.RELAY_ENDPOINT;
    delete env.CAPCOMD_KILLPOINT;
    delete env.RELAY_KILLPOINT;
    // process.execPath, not "bun": the latter is a /bin/sh wrapper, and the timeout's
    // SIGKILL would hit only the wrapper, leaving bun.exe holding the pipes ('close' never fires).
    const child = spawn(
      process.execPath,
      ["src/cli/index.ts", "run", `--${opts.runPath ?? "legacy"}`, "--run-id", runId, "TestGoal"],
      {
        cwd: ROOT,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      }
    );

    let output = "";
    const t0 = Date.now();
    child.stdout?.on("data", (chunk) => {
      if (envVar("TEST_TS")) output += `[+${Date.now() - t0}ms] `;
      output += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      output += chunk.toString();
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, CLIENT_TIMEOUT_MS);

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === null) output += `\n[client terminated by signal ${signal}]`;
      resolve({ code: code ?? 1, output });
    });
  });
}
