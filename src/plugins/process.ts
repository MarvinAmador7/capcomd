// How the daemon starts an out-of-process plugin (docs/spec/plugin-api.md §9.2, §9.3): a token minted for this start
// (src/api/clients.ts `mintPluginClient`: the manifest's scopes, held in memory, revoked when the process is gone), the
// manifest's command run in the plugin's directory in a process group of its own, with ONLY the base variables (PATH,
// HOME, USER, LANG, TERM, TMPDIR), the manifest's `entry.env` and the CAPCOMD_PLUGIN_* ones: no other CAPCOMD_* of the
// daemon's, no BOXD_*, no GITHUB_TOKEN, no provider key, never a secret (those go once in the handshake's answer, §10.3).
// stdin stays open while the daemon lives (a process should exit when it closes); stdout and stderr lines are the
// plugin's log (§13.3), redacted, its own token among what is redacted. Chaos (CAPCOMD_KILLPOINT): `plugin.hook.mid`
// kills the daemon, `plugin.process.crash` the plugin's process, right after a gate or modify call went out to it.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { ProcessLauncher, ProcessStart } from "../../packages/plugin/src/host/process";
import { PLUGIN_PROTOCOL_VERSION } from "../../packages/plugin/src/protocol";
import { mintPluginClient } from "../api/clients";
import { Redactor } from "../agents/redact";
import { killpoint, killpointOf } from "../utils/killpoint";

/** The daemon's variables a plugin's process gets (§9.2); everything else of the daemon's stays out. */
export const PLUGIN_BASE_ENV = ["PATH", "HOME", "USER", "LANG", "TERM", "TMPDIR"] as const;

type Line = { plugin: string; level: "debug" | "info" | "warn" | "error"; message: string; fields: Record<string, unknown> };

/** The environment for one start (§9.2): the base, then `entry.env`, then capcomd's own variables, which win. */
export function pluginEnv(o: { name: string; root: string; dataDir: string; socket: string; session: string; token: string; entryEnv?: Record<string, string>; from?: Record<string, string | undefined> }): Record<string, string> {
  const from = o.from ?? process.env;
  const sub = (s: string) => s.replaceAll("${PLUGIN_ROOT}", o.root).replaceAll("${PLUGIN_DATA}", o.dataDir);
  const env: Record<string, string> = {};
  for (const k of PLUGIN_BASE_ENV) if (from[k] !== undefined) env[k] = from[k]!;
  for (const [k, v] of Object.entries(o.entryEnv ?? {})) env[k] = sub(v);
  return {
    ...env,
    CAPCOMD_PLUGIN_NAME: o.name, CAPCOMD_PLUGIN_ROOT: o.root, CAPCOMD_PLUGIN_DATA: o.dataDir, CAPCOMD_PLUGIN_SOCKET: o.socket,
    CAPCOMD_PLUGIN_SESSION: o.session, CAPCOMD_PLUGIN_TOKEN: o.token, CAPCOMD_PLUGIN_PROTOCOL: String(PLUGIN_PROTOCOL_VERSION),
  };
}

/** One stdout or stderr line as a log line (§9.2): JSON with a `level` is structured, anything else is `info`. */
export function logLine(plugin: string, raw: string, redact: (s: string) => string): Line {
  const text = redact(raw);
  try {
    const j = JSON.parse(text) as { level?: unknown; message?: unknown; msg?: unknown };
    if (j && typeof j === "object" && typeof j.level === "string") {
      const level = (["debug", "info", "warn", "error"] as const).find((l) => l === j.level) ?? "info";
      const { level: _l, message, msg, ...fields } = j as Record<string, unknown>;
      return { plugin, level, message: String(message ?? msg ?? ""), fields };
    }
  } catch { /* a plain line */ }
  return { plugin, level: "info", message: text, fields: {} };
}

/** Which process the plugin's last start was (<data>/process.json): a daemon that died without stopping it leaves it. */
function recordStart(dataDir: string, pid: number, command: string) {
  try { writeFileSync(join(dataDir, "process.json"), JSON.stringify({ pid, command, daemon: process.pid }), { mode: 0o600 }); } catch { /* best effort */ }
}

/**
 * A process an earlier daemon started for this plugin and never stopped (it died: SIGKILL, a crash) is stopped before a
 * new one starts: its token died with that daemon, but it may still hold files or ports. Only while that pid still runs
 * the very command recorded (a recycled pid is left alone), and never one this daemon started.
 */
function reapStale(dataDir: string) {
  let rec: { pid?: unknown; command?: unknown; daemon?: unknown };
  try { rec = JSON.parse(readFileSync(join(dataDir, "process.json"), "utf8")); } catch { return; }
  if (typeof rec.pid !== "number" || rec.pid <= 1 || rec.daemon === process.pid || typeof rec.command !== "string") return;
  const running = (spawnSync("ps", ["-o", "command=", "-p", String(rec.pid)], { encoding: "utf8", timeout: 2000 }).stdout ?? "").trim();
  if (running !== rec.command) return;
  try { process.kill(-rec.pid, "SIGKILL"); } catch { try { process.kill(rec.pid, "SIGKILL"); } catch { /* gone */ } }
}

/** The daemon's launcher: `socket` is the plugin socket its processes connect to (CAPCOMD_PLUGIN_SOCKET). */
export function processLauncher(o: { socket: string; log(line: Line): void; secrets?: () => string[] }): ProcessLauncher {
  return {
    start({ manifest, root, dataDir, session }): ProcessStart {
      if (manifest.entry.runtime !== "process") throw new Error(`${manifest.name} is not an out-of-process plugin`);
      const minted = mintPluginClient(manifest.name, manifest.scopes ?? []);
      const redactor = new Redactor([minted.token, ...(o.secrets?.() ?? [])]);
      const redact = (s: string) => redactor.text(s);
      mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      const sub = (s: string) => s.replaceAll("${PLUGIN_ROOT}", root).replaceAll("${PLUGIN_DATA}", dataDir);
      const [first, ...args] = manifest.entry.command.map(sub);
      const cmd = first!.startsWith("./") ? join(root, first!) : first!;
      const env = pluginEnv({ name: manifest.name, root, dataDir, socket: o.socket, session, token: minted.token, ...(manifest.entry.env ? { entryEnv: manifest.entry.env } : {}) });
      reapStale(dataDir);
      let done!: (x: { code: number | null; signal: string | null }) => void;
      const exited = new Promise<{ code: number | null; signal: string | null }>((r) => { done = r; });
      let child: ReturnType<typeof spawn> | null = null;
      try {
        // Its own process group: the daemon's terminal signals don't reach it, and a kill takes what it started too.
        child = spawn(cmd, args, { cwd: root, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
      } catch (e) {
        o.log({ plugin: manifest.name, level: "error", message: `could not start ${cmd}: ${redact((e as Error).message)}`, fields: {} });
        done({ code: null, signal: null });
      }
      if (child) {
        child.on("error", (e) => { o.log({ plugin: manifest.name, level: "error", message: `could not start ${cmd}: ${redact(e.message)}`, fields: {} }); done({ code: null, signal: null }); });
        child.on("exit", (code, signal) => done({ code, signal }));
        child.stdin?.on("error", () => {});
        for (const stream of [child.stdout, child.stderr]) if (stream) createInterface({ input: stream }).on("line", (l) => { if (l.trim()) o.log(logLine(manifest.name, l, redact)); });
      }
      const pid = child?.pid ?? null;
      if (pid) recordStart(dataDir, pid, [cmd, ...args].join(" "));
      return {
        clientId: minted.client.id,
        pid,
        exited,
        kill: (signal) => {
          if (!pid) return;
          try { process.kill(-pid, signal); } catch { try { process.kill(pid, signal); } catch { /* gone */ } }
        },
        revoke: () => minted.revoke(),
      };
    },
    sent(_plugin, start) {
      // Chaos only: the daemon dies with the call in flight (the kernel's crash), or the plugin's process does.
      killpoint("plugin.hook.mid");
      killpointOf("plugin.process.crash", () => start.kill("SIGKILL"));
    },
  };
}
