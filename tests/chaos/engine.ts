import { env as envVar } from "../../src/utils/env";
import { spawn, spawnSync, type ChildProcess } from "child_process";
import { createRequire } from "module";
import { homedir } from "os";
import { join } from "path";
import { openSync, readFileSync, readdirSync, readlinkSync } from "fs";

const DEFAULT_PORT = 6420;
const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
export async function serveRunnerPids(port: number = DEFAULT_PORT): Promise<number[]> {
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
  /** Isolated engine data dir (fast mode). Default: rivetkit's ~/.rivetkit/var/engine. */
  dataDir?: string;
  /** Real git merges: a bare repo under dataDir/git (direct mode, target `trunk`). Needs dataDir. */
  repo?: boolean;
  /** Extra env for the engine/runner process (e.g. test knobs like CAPCOMD_FAKE_PUSH_DELAY_MS). */
  env?: Record<string, string>;
  /** Which `capcomd run` path the client drives. Default legacy: the killpoint gate was written
   *  against the legacy loop, so it is pinned there even though the recipe is the CLI default. */
  runPath?: "legacy" | "recipe";
}

/** Merge env for a repo-backed case. Shared by the runner (verifier merges) and the client. */
export function repoEnv(opts: EngineOpts): NodeJS.ProcessEnv {
  if (!opts.repo || !opts.dataDir) return {};
  return {
    CAPCOMD_REPO: `${opts.dataDir}/git/origin.git`,
    CAPCOMD_WORKDIR: `${opts.dataDir}/git/work`,
    CAPCOMD_MERGE_MODE: "direct",
    CAPCOMD_MERGE_STRATEGY: process.env.CAPCOMD_CHAOS_MERGE_STRATEGY ?? "squash",
    CAPCOMD_MERGE_TARGET: "trunk",
    CAPCOMD_TEST_COMMAND: 'test -f "tasks/$CAPCOMD_TASK_ID.md"',
  };
}

// The platform's engine binary, resolved the same way `capcomd serve` does.
const REAL_ENGINE = createRequire(import.meta.url)("@rivetkit/engine-cli").getEnginePath() as string;

export function engineEnv(opts: EngineOpts): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const port = opts.port ?? DEFAULT_PORT;
  env.CAPCOMD_ENDPOINT = `http://127.0.0.1:${port}`;
  if (opts.port !== undefined) {
    env.RIVET_RUN_ENGINE_PORT = String(port);
    // rivet-services (agentOS/durable streams, unused by relay) binds a fixed :8642 and
    // runs outside the runner's process group; parallel workers would share it.
    env.RIVET_RUN_SERVICES = "0";
  }
  Object.assign(env, repoEnv(opts));
  if (opts.env) Object.assign(env, opts.env);
  if (opts.dataDir) {
    env.RIVET_ENGINE_BINARY = `${ROOT}/tests/chaos/engine-wrapper.sh`;
    env.CAPCOMD_CHAOS_REAL_ENGINE = REAL_ENGINE;
    env.CAPCOMD_CHAOS_ENGINE_DATA = opts.dataDir;
    // The wrapper records the engine pid here; stop() trusts it where /proc/<pid>/environ is unreadable.
    env.CAPCOMD_ENGINE_PIDFILE = join(opts.dataDir, "engine.pid");
  }
  return env;
}

export class Engine {
  readonly logPath: string;
  readonly port: number;
  readonly opts: EngineOpts;
  private child: ChildProcess | null = null;
  private dataFiles: string[] = [];
  private stopping = false;
  sawKill = false;

  constructor(label: string, opts: EngineOpts = {}) {
    this.opts = opts;
    this.port = opts.port ?? DEFAULT_PORT;
    this.logPath = `/tmp/relay-chaos-${label.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 180)}.log`;
  }

  /** Every port this engine instance owns (guard, api-peer, metrics). */
  private ports(): number[] {
    return [this.port, this.port + 1, this.port + 10];
  }

  private noteKill = (code: number | null) => {
    if (this.stopping) return;
    if (code === 137 || tailFile(this.logPath).includes("[KILLPOINT]")) {
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
      void this.killPortHolders();
    }
  };

  /**
   * In isolated (fast) mode, only SIGKILL processes that belong to this instance: the
   * runner and its engine both carry RIVET_RUN_ENGINE_PORT=<port> in their environment.
   * Guards every non-group kill against PID reuse and path/port mistakes hitting a sibling worker.
   */
  private owns(pid: number): boolean {
    if (this.opts.port === undefined) return true;
    if (!HAS_PROC) {
      // No readable environ: ours = our serve child or its descendants, our engine (pid file), or a
      // serve runner for this exact port (stragglers from an earlier start of this instance).
      const root = this.child?.pid;
      if (root && (pid === root || descendantPids(root).includes(pid))) return true;
      if (this.opts.dataDir) {
        try { if (Number(readFileSync(join(this.opts.dataDir, "engine.pid"), "utf8").trim()) === pid) return true; } catch {}
      }
      return new RegExp(`src/cli/index\\.ts serve --port ${this.port}( |$)`).test(sh("ps", ["-o", "command=", "-p", String(pid)]).trim());
    }
    try {
      return readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes(`RIVET_RUN_ENGINE_PORT=${this.port}`);
    } catch {
      return false;
    }
  }

  private kill(pid: number): void {
    if (!this.owns(pid)) {
      console.log(`    refusing to kill pid ${pid}: not owned by engine :${this.port}`);
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
    const env = { ...process.env, ...engineEnv(this.opts) };
    delete env.CAPCOMD_KILLPOINT;
    delete env.RELAY_KILLPOINT;
    if (killpoint) env.CAPCOMD_KILLPOINT = killpoint;

    await this.spawnUntilReady(env);
  }

  /**
   * A freshly restarted engine occasionally never registers its runner
   * (`actor_ready_timeout` for 45s+, seen in chaos seed 8). That's a readiness
   * problem, not data loss, so cold-restart the engine on the same data dir
   * (no wipe) up to twice before giving up. Each retry is logged.
   */
  private async spawnUntilReady(env: NodeJS.ProcessEnv): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.spawnOnce(env);
        return;
      } catch (error) {
        if (attempt >= 3) throw error;
        const msg = error instanceof Error ? error.message : String(error);
        console.log(`    engine-not-ready attempt=${attempt}, cold restart: ${msg.replace(/\s+/g, " ").slice(0, 160)}`);
        await this.stop();
        this.stopping = false;
      }
    }
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
    child.on("exit", (code) => this.noteKill(code));
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
    const root = `${(this.opts.dataDir ?? `${homedir()}/.rivetkit/var`).replace(/\/$/, "")}/`;
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
    if (envVar("CHAOS_TS")) console.log(`    [ts] http-up`, Date.now());
    if (!httpUp) {
      throw new Error(`engine http not ready\n${tailFile(this.logPath)}`);
    }

    const probe = spawn(
      process.execPath,
      ["tests/chaos/ready-probe.ts", String(this.port)],
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
    if (envVar("CHAOS_TS")) console.log(`    [ts] probe-done`, Date.now(), outcome.output.replace(/\s+/g, " ").slice(-200));
    if (outcome.code === 0 && outcome.output.includes("ready")) return;
    const detail = outcome.output.replace(/\s+/g, " ").slice(-300);
    throw new Error(`engine not ready: ${detail}`);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const pid = this.child?.pid;
    const victims = new Set<number>();
    if (pid) {
      victims.add(pid);
      for (const child of descendantPids(pid)) victims.add(child);
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // group already gone
      }
      for (const victim of victims) this.kill(victim);
    }

    // Defense in depth: no runner from an earlier engine may outlive stop(). A
    // straggler reconnects to the next engine and steals actor assignments.
    for (const straggler of await serveRunnerPids(this.port)) {
      this.kill(straggler);
    }

    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const listeners = (await Promise.all(this.ports().map((p) => pidsListening(p)))).flat();
      const lockers = pidsHolding(this.dataFiles);
      const holders = [...new Set([...listeners, ...lockers])];
      if (holders.length === 0) {
        this.child = null;
        return;
      }
      for (const holder of holders) this.kill(holder);
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
      ["src/cli/index.ts", "run", `--${opts.runPath ?? "legacy"}`, "--run-id", runId, "ChaosGoal"],
      {
        cwd: ROOT,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      }
    );

    let output = "";
    const t0 = Date.now();
    child.stdout?.on("data", (chunk) => {
      if (envVar("CHAOS_TS")) output += `[+${Date.now() - t0}ms] `;
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
