// `capcomd service install|uninstall|status [--port N] [--dry-run]`: the engine as a background service, so
// nobody keeps a terminal open. macOS: a launchd agent (~/Library/LaunchAgents); Linux: a systemd user unit.
// It starts in the home directory, so only the user config applies (sandbox, the keychain's boxd key);
// repository settings come from each run (recorded at `run new`).
import { spawnSync } from "child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { capcomdHome } from "../../utils/home";
import { selfArgv } from "../../utils/self";
import { RelayError } from "../../core/errors";

export const LABEL = "dev.capcomd.engine";
export const UNIT = "capcomd-engine.service";

/** `argv`: the command that runs the engine (the single executable, or bun with the CLI's entry). */
export interface ServiceSpec { platform: NodeJS.Platform; argv: string[]; port: number; home: string; logFile: string; path: string }

export function serviceSpec(o: { port?: number; platform?: NodeJS.Platform } = {}): ServiceSpec {
  const home = homedir();
  const bunDir = dirname(process.execPath);
  // launchd/systemd start with a bare PATH: keep the dirs where capcomd (or bun), git, gh and node live.
  const path = [...new Set([bunDir, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"])].join(":");
  const port = o.port ?? 6420;
  return { platform: o.platform ?? process.platform, argv: selfArgv("serve", "--port", String(port)), port, home, logFile: join(capcomdHome(), "engine.log"), path };
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Where the service definition goes for `home` on `platform` (null: no service support there). */
export function servicePath(platform: NodeJS.Platform, home: string): string | null {
  if (platform === "darwin") return join(home, "Library", "LaunchAgents", `${LABEL}.plist`);
  if (platform === "linux") return join(home, ".config", "systemd", "user", UNIT);
  return null;
}

/** The service definition and where it goes. */
export function serviceFile(s: ServiceSpec): { path: string; body: string } {
  if (s.platform === "darwin") {
    return {
      path: servicePath("darwin", s.home)!,
      body: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>${s.argv.map((a) => `<string>${xml(a)}</string>`).join("")}</array>
  <key>WorkingDirectory</key><string>${xml(s.home)}</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${xml(s.path)}</string><key>HOME</key><string>${xml(s.home)}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>${xml(s.logFile)}</string>
  <key>StandardErrorPath</key><string>${xml(s.logFile)}</string>
</dict>
</plist>
`,
    };
  }
  if (s.platform === "linux") {
    return {
      path: servicePath("linux", s.home)!,
      body: `[Unit]
Description=capcomd engine (agent orchestration)
After=network-online.target

[Service]
ExecStart=${s.argv.join(" ")}
WorkingDirectory=${s.home}
Environment=PATH=${s.path}
Restart=on-failure
RestartSec=3
StandardOutput=append:${s.logFile}
StandardError=append:${s.logFile}

[Install]
WantedBy=default.target
`,
    };
  }
  throw new RelayError("config", `no background service support on ${s.platform}`, "Run `capcomd serve` in a terminal instead.");
}

const sh = (cmd: string, args: string[]) => { const r = spawnSync(cmd, args, { encoding: "utf8" }); return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() }; };
const uid = () => String(process.getuid?.() ?? "");

async function engineUp(port: number): Promise<boolean> {
  try { const r = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) }); return r.status > 0; } catch { return false; }
}

export async function serviceInstall(o: { port?: number; dryRun?: boolean } = {}) {
  const spec = serviceSpec(o);
  const f = serviceFile(spec);
  if (o.dryRun) return { installed: false, dryRun: true, path: f.path, body: f.body };
  mkdirSync(dirname(f.path), { recursive: true });
  mkdirSync(dirname(spec.logFile), { recursive: true });
  writeFileSync(f.path, f.body);
  if (spec.platform === "darwin") {
    sh("launchctl", ["bootout", `gui/${uid()}/${LABEL}`]); // replace a previous install
    const r = sh("launchctl", ["bootstrap", `gui/${uid()}`, f.path]);
    if (r.code !== 0) throw new RelayError("config", `launchctl bootstrap failed: ${r.out.slice(-300)}`, `Check ${f.path}; logs in ${spec.logFile}.`);
  } else {
    for (const args of [["--user", "daemon-reload"], ["--user", "enable", "--now", UNIT]]) {
      const r = sh("systemctl", args);
      if (r.code !== 0) throw new RelayError("config", `systemctl ${args.join(" ")} failed: ${r.out.slice(-300)}`, "A systemd user session is needed (on a server: `loginctl enable-linger $USER`).");
    }
  }
  let up = false;
  for (let i = 0; i < 40 && !(up = await engineUp(spec.port)); i++) await new Promise((r) => setTimeout(r, 500));
  return { installed: true, path: f.path, port: spec.port, running: up, log: spec.logFile };
}

export function serviceUninstall() {
  const spec = serviceSpec();
  const f = serviceFile(spec);
  if (spec.platform === "darwin") sh("launchctl", ["bootout", `gui/${uid()}/${LABEL}`]);
  else { sh("systemctl", ["--user", "disable", "--now", UNIT]); sh("systemctl", ["--user", "daemon-reload"]); }
  const had = existsSync(f.path);
  rmSync(f.path, { force: true });
  return { uninstalled: had, path: f.path };
}

export async function serviceStatus(o: { port?: number } = {}) {
  const spec = serviceSpec(o);
  const f = serviceFile(spec);
  const installed = existsSync(f.path);
  const loaded = installed && (spec.platform === "darwin" ? sh("launchctl", ["print", `gui/${uid()}/${LABEL}`]).code === 0 : sh("systemctl", ["--user", "is-active", "--quiet", UNIT]).code === 0);
  return { installed, loaded, running: await engineUp(spec.port), port: spec.port, path: f.path, log: spec.logFile };
}
