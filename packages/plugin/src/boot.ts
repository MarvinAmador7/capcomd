// `testkit.bootWith` (spec §14.3): a real daemon for a plugin's own tests. It runs the `capcomd` the test names (the
// installed CLI by default) as `capcomd serve` in a home of its own (a temp dir: its engine data, sockets, clients and
// state), on the fake sandbox with scripted agents (CAPCOMD_SPAWN_EXEC=script: an agent without a contract script ends
// `done` at once; `{"script": "exit 1"}` fails it) and the profiles `planner`, `worker` and `reviewer`. The plugins are the user's (`<home>/plugins/<name>`, a link to each
// directory), loaded and started by the daemon like any other; the test drives it over the harness.v1 socket with an
// operator's token, or through the CLI. Nothing of the developer's own capcomd is read or touched: no CAPCOMD_* of the
// caller's environment reaches the daemon, CAPCOMD_NO_CONFIG is set, and the home is removed afterwards.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { socketRequest } from "./client";
import { PluginError } from "./errors";
import { readManifest } from "./load";

export interface BootOptions {
  /** How to run capcomd, as an argv prefix (`["bun", "/path/to/capcomd/src/cli/index.ts"]`). Default: the
   *  CAPCOMD_TESTKIT_BIN environment variable (a path), else `capcomd` on the PATH. */
  capcomd?: string[];
  /** Settings per plugin (`plugins.<name>`, spec §10.2), handed to the daemon as CAPCOMD_PLUGIN_<NAME>_<KEY> (JSON).
   *  A secret's is a reference (`{"$secret": "env:VAR"}`) and VAR goes in `env` (§10.3). */
  config?: Record<string, Record<string, unknown>>;
  /** More environment for the daemon and the CLI (after the kit's own: it may override them). */
  env?: Record<string, string>;
  /** The agent profiles (`capcomd.agents/v1`'s `agents`), instead of the kit's planner, worker and reviewer. */
  profiles?: Record<string, unknown>;
  /** The engine's port; it binds port, port+1 and port+10. Default: a free block above 20000. */
  port?: number;
  /** How long the daemon and each plugin get to be up (the plugin `active`). Default 120 s. */
  readyMs?: number;
  /** Keep the daemon's home (its log, the plugins' data) after it stops, for a failure to be read. */
  keep?: boolean;
}

export interface BootedDaemon {
  /** The harness.v1 socket, and an operator's token for it (scopes read, steer, approve, configure). */
  socket: string;
  token: string;
  /** The daemon's home (CAPCOMD_HOME): `state/plugins/<name>/` is each plugin's data directory. */
  home: string;
  /** The environment the daemon and the CLI run with. */
  env: Record<string, string>;
  /** A harness.v1 request with the operator's token; `body` is sent as JSON. */
  fetch(path: string, init?: { method?: string; body?: unknown; idempotencyKey?: string }): Promise<Response>;
  /** `capcomd <args>` against this daemon: its exit code, output, and the JSON it printed (with `--json`), if any. */
  cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string; json: any }>;
  /** The daemon's log so far (its plugins' lines among them). */
  log(): string;
  stop(): Promise<void>;
}

/** Scripted agents run under these (any provider will do: no agent CLI runs). */
const PROFILES = {
  planner: { provider: "claude", auth: "subscription", maxTurns: 60, children: { allowSpawn: true, maxDepth: 2, maxChildren: 4, maxTotalDescendants: 12, allowedChildProfiles: ["worker"], budgetShare: 0.5 } },
  worker: { provider: "claude", auth: "subscription", maxTurns: 20 },
  reviewer: { provider: "claude", auth: "subscription", maxTurns: 8 },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const free = (port: number) => new Promise<boolean>((res) => {
  const srv = createServer().once("error", () => res(false)).once("listening", () => srv.close(() => res(true)));
  srv.listen(port, "127.0.0.1");
});
async function freePortBlock(): Promise<number> {
  for (let i = 0; i < 50; i++) {
    const base = 20000 + Math.floor(Math.random() * 2000) * 20;
    if ((await free(base)) && (await free(base + 1)) && (await free(base + 10))) return base;
  }
  throw new PluginError("unavailable", "no free port block for the daemon's engine (it binds port, port+1 and port+10)");
}

/** The caller's environment without anything capcomd (or its engine) reads, so the daemon can't reach the developer's
 *  own daemon, home, config, logins or sandboxes; nor git's GIT_* (a test run from a git hook has GIT_DIR, GIT_WORK_TREE
 *  or GIT_INDEX_FILE set, and every git the daemon and the CLI run would act on the developer's repository). */
export function cleanEnv(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !/^(CAPCOMD_|RELAY_|RIVET_|RIVETKIT_|BOXD_|GIT_)/.test(k) && !["GITHUB_TOKEN", "GH_TOKEN"].includes(k)) out[k] = v;
  return out;
}

/** CAPCOMD_PLUGIN_<NAME>_<KEY>, as the kernel reads it (src/plugins/config.ts `envName`). */
const envName = (plugin: string, key: string) => `CAPCOMD_PLUGIN_${plugin}_${key}`.toUpperCase().replace(/[-.]/g, "_");

function run(argv: string[], o: { env: Record<string, string>; cwd: string }): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(argv[0]!, argv.slice(1), { env: o.env, cwd: o.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    p.stdout!.setEncoding("utf8").on("data", (d: string) => { stdout += d; });
    p.stderr!.setEncoding("utf8").on("data", (d: string) => { stderr += d; });
    p.once("error", reject);
    p.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}
const jsonOf = (s: string): any => {
  try { return JSON.parse(s); } catch { /* one object per line: the last */ }
  try { return JSON.parse(s.trim().split("\n").pop() ?? ""); } catch { return null; }
};

export async function bootWith(plugins: Array<{ dir: string }>, fn: (daemon: BootedDaemon) => Promise<void>, o: BootOptions = {}): Promise<void> {
  const capcomd = o.capcomd ?? [process.env.CAPCOMD_TESTKIT_BIN || "capcomd"];
  const readyMs = o.readyMs ?? 120_000;
  // Manifests first: a plugin that doesn't validate is the test's failure, said before any daemon starts.
  const named = plugins.map(({ dir }) => {
    const r = readManifest(dir);
    if (!r.ok) throw new PluginError("invalid", `${dir}: ${r.issues.map((i) => `${i.path || "manifest"}: ${i.message}`).join("; ")}`);
    return { dir: realpathSync(dir), name: r.manifest.name };
  });
  // Short: the sockets live here, and a Unix socket's path must stay under ~104 bytes.
  const home = mkdtempSync(join(tmpdir(), "cpk-"));
  const work = join(home, "work"), socket = join(home, "h.sock"), logPath = join(home, "serve.log");
  const log = () => { try { return readFileSync(logPath, "utf8"); } catch { return ""; } };
  let child: ChildProcess | null = null;
  const stop = async () => {
    const c = child;
    child = null;
    if (!c || c.exitCode !== null || c.signalCode !== null) return;
    const exited = new Promise<void>((r) => c.once("exit", () => r()));
    // serve stops its engine and its plugins' processes on SIGTERM (spec §5.5, §9.7); SIGKILL if it hangs.
    c.kill("SIGTERM");
    const t = setTimeout(() => c.kill("SIGKILL"), 30_000);
    await exited;
    clearTimeout(t);
  };
  try {
    mkdirSync(work);
    mkdirSync(join(home, "plugins"));
    for (const p of named) symlinkSync(p.dir, join(home, "plugins", p.name), "dir");
    writeFileSync(join(home, "agents.json"), JSON.stringify({ schema: "capcomd.agents/v1", agents: o.profiles ?? PROFILES }));
    const port = o.port ?? (await freePortBlock());
    const env: Record<string, string> = {
      ...cleanEnv(),
      CAPCOMD_HOME: home, CAPCOMD_NO_CONFIG: "1", CAPCOMD_HARNESS_SOCKET: socket, CAPCOMD_ENDPOINT: `http://127.0.0.1:${port}`,
      CAPCOMD_AGENTS_FILE: join(home, "agents.json"), CAPCOMD_SANDBOX: "fake", CAPCOMD_SPAWN_EXEC: "script", CAPCOMD_SKIP_PREFLIGHT: "1", CAPCOMD_NO_ENGINE_AUTOSTART: "1",
      ...Object.fromEntries(Object.entries(o.config ?? {}).flatMap(([plugin, keys]) => Object.entries(keys).map(([k, v]) => [envName(plugin, k), JSON.stringify(v)]))),
      ...(o.env ?? {}),
    };
    const cli = async (args: string[]) => { const r = await run([...capcomd, ...args], { env, cwd: work }); return { ...r, json: jsonOf(r.stdout) }; };
    const added = await cli(["clients", "add", "testkit", "--scopes", "read,steer,approve,configure"]);
    const token = added.json?.token as string | undefined;
    if (!token) throw new PluginError("unavailable", `could not make a client token with ${capcomd.join(" ")}: ${added.stderr || added.stdout}`);
    const fd = openSync(logPath, "a");
    child = spawn(capcomd[0]!, [...capcomd.slice(1), "serve", "--port", String(port)], { env, cwd: work, stdio: ["ignore", fd, fd] });
    closeSync(fd);
    const exited = new Promise<string>((r) => child!.once("exit", (code, signal) => r(String(code ?? signal))));
    const request = (method: string, path: string, body?: unknown, headers?: Record<string, string>) => socketRequest(socket, token, method, path, body, headers);
    // `ok` answers true (up), false (not yet) or an Error (it never will be).
    const until = async (what: string, ok: () => Promise<boolean | Error>) => {
      for (const end = Date.now() + readyMs; Date.now() < end; await sleep(250)) {
        if (child && (child.exitCode !== null || child.signalCode !== null)) throw new PluginError("unavailable", `capcomd serve exited (${await exited}) before ${what}:\n${log().slice(-3000)}`);
        const r = await ok().catch(() => false);
        if (r instanceof Error) throw r;
        if (r) return;
      }
      throw new PluginError("timeout", `not ${what} within ${readyMs} ms:\n${log().slice(-3000)}`);
    };
    await until("up (GET /v1/health)", async () => (await request("GET", "/v1/health")).status === 200);
    for (const p of named) {
      await until(`active: the ${p.name} plugin`, async () => {
        const s = JSON.parse((await request("GET", `/v1/plugins/${encodeURIComponent(p.name)}`)).body) as { state?: string; cause?: string | null };
        if (s.state === "failed" || (s.state === "validated" && s.cause)) return new PluginError("unavailable", `the ${p.name} plugin is ${s.state} (${s.cause ?? "no cause"}):\n${log().slice(-3000)}`);
        return s.state === "active";
      });
    }
    await fn({
      socket, token, home, env, cli, log, stop,
      async fetch(path, init = {}) {
        const r = await request(init.method ?? "GET", path, init.body, init.idempotencyKey ? { "idempotency-key": init.idempotencyKey } : {});
        return new Response(r.body || null, { status: r.status, headers: { "content-type": String(r.headers["content-type"] ?? "application/json") } });
      },
    });
  } finally {
    await stop();
    if (!o.keep) rmSync(home, { recursive: true, force: true });
  }
}
