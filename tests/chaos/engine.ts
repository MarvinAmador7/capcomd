import { spawn, type ChildProcess } from "child_process";
import { openSync, readFileSync, readdirSync, readlinkSync } from "fs";

const PORT = 6420;
const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function descendantPids(root: number): number[] {
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

function openDbPaths(pid: number): string[] {
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
      if (/sqlite|\.db|rivet/i.test(target) && target.startsWith("/")) {
        paths.push(target);
      }
    } catch {
      // fd closed
    }
  }
  return paths;
}

async function pidsListening(port: number): Promise<number[]> {
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

export function tailFile(path: string, max = 2000): string {
  try {
    const text = readFileSync(path, "utf8");
    return text.slice(-max);
  } catch {
    return "";
  }
}

export class Engine {
  readonly logPath: string;
  private child: ChildProcess | null = null;
  private dataFiles: string[] = [];
  private stopping = false;
  sawKill = false;

  constructor(label: string) {
    this.logPath = `/tmp/relay-chaos-${label.replace(/[^a-zA-Z0-9._-]/g, "_")}.log`;
  }

  private noteKill = (code: number | null) => {
    if (this.stopping) return;
    if (code === 137 || tailFile(this.logPath).includes("[KILLPOINT]")) {
      this.sawKill = true;
    }
  };

  async start(killpoint: string | null): Promise<void> {
    this.stopping = false;
    this.sawKill = false;
    const env = { ...process.env };
    delete env.RELAY_KILLPOINT;
    if (killpoint) env.RELAY_KILLPOINT = killpoint;

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
    const child = spawn("bun", ["src/cli/index.ts", "serve", "--port", String(PORT)], {
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
    this.dataFiles = [...files];
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
        const response = await fetch(`http://127.0.0.1:${PORT}/`, {
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
    if (!httpUp) {
      throw new Error(`engine http not ready\n${tailFile(this.logPath)}`);
    }

    const probe = spawn(
      "bun",
      ["tests/chaos/ready-probe.ts", String(PORT)],
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
      for (const victim of victims) {
        try {
          process.kill(victim, "SIGKILL");
        } catch {
          // already exited
        }
      }
    }

    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const listeners = await pidsListening(PORT);
      const lockers = pidsHolding(this.dataFiles);
      const holders = [...new Set([...listeners, ...lockers])];
      if (holders.length === 0) {
        this.child = null;
        return;
      }
      for (const holder of holders) {
        try {
          process.kill(holder, "SIGKILL");
        } catch {
          // raced
        }
      }
      await sleep(100);
    }

    throw new Error(
      `timed out waiting for :${PORT} and data locks to release (files=${this.dataFiles.join(",")})`
    );
  }
}

export function runClient(runId: string): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env.RELAY_KILLPOINT;
    const child = spawn(
      "bun",
      ["src/cli/index.ts", "run", "--run-id", runId, "ChaosGoal"],
      {
        cwd: ROOT,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      }
    );

    let output = "";
    child.stdout?.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      output += chunk.toString();
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 30_000);

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, output });
    });
  });
}
