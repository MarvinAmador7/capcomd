// `capcomd update [--to X.Y.Z] [--dry-run] [--no-restart]` (alias `capcomd upgrade`): bring capcomd up to the latest
// release however it was installed. The single executable replaces itself from the GitHub release (install.sh's
// download); a Bun or npm global install runs `bun add -g` / `npm install -g`; Homebrew runs `brew upgrade`; a dev
// checkout only says what to do. When the version changed and the engine runs as capcomd's background service, the
// service is restarted so it runs the new version.
import { spawnSync } from "child_process";
import { createHash } from "crypto";
import { accessSync, chmodSync, constants, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
import { basename, dirname, join } from "path";
import { RelayError } from "../../core/errors";
import { capcomdHome, COMPILED, isDevCheckout, PACKAGE_ROOT } from "../../utils/home";
import { VERSION } from "../../utils/self";
import { engineUp, installedService, restartArgv, restartService, serviceLoaded } from "./service";

export const REPO = "MarvinAmador7/capcomd";
const REGISTRY = "https://registry.npmjs.org";
const INSTALL_SH = "curl -fsSL https://raw.githubusercontent.com/MarvinAmador7/capcomd/main/install.sh | sh";

export type InstallKind = "binary" | "homebrew" | "npm" | "checkout";
export type PackageManager = "bun" | "npm";

/** This machine's release asset, as install.sh names it. */
export function assetName(platform = process.platform, arch = process.arch): string {
  if ((platform !== "darwin" && platform !== "linux") || (arch !== "arm64" && arch !== "x64")) throw new RelayError("config", `no capcomd build for ${platform}-${arch}`, "Builds exist for macOS and Linux, x64 and arm64.");
  return `capcomd-${platform}-${arch}`;
}

/** How this capcomd was installed, which decides how it updates. */
export function installKind(execPath = process.execPath, compiled = COMPILED): InstallKind {
  if (!compiled) return isDevCheckout() ? "checkout" : "npm";
  let real = execPath;
  try { real = realpathSync(execPath); } catch {}
  return /\/Cellar\/capcomd\//.test(real) ? "homebrew" : "binary";
}

/** a < b for X.Y.Z[-pre] versions (a prerelease sorts before its release). */
export function olderThan(a: string, b: string): boolean {
  const p = (v: string) => { const [core, pre] = v.replace(/^v/, "").split("-", 2); return { n: core!.split(".").map(Number), pre }; };
  const x = p(a), y = p(b);
  for (let i = 0; i < 3; i++) if ((x.n[i] ?? 0) !== (y.n[i] ?? 0)) return (x.n[i] ?? 0) < (y.n[i] ?? 0);
  if (x.pre === y.pre) return false;
  if (!x.pre) return false;
  if (!y.pre) return true;
  return x.pre < y.pre;
}

/** Bun's global install directory: $BUN_INSTALL_GLOBAL_DIR, else $BUN_INSTALL/install/global (~/.bun by default). */
export function bunGlobalDir(env: Record<string, string | undefined>, home: string): string {
  return env.BUN_INSTALL_GLOBAL_DIR || join(env.BUN_INSTALL || join(home, ".bun"), "install", "global");
}

/**
 * Which package manager's global install this package is (its real path): Bun's when it is
 * <bun global dir>/node_modules/capcomd, npm's when it is <`npm root -g`>/capcomd. null when it is neither: the caller
 * then says what to run instead of guessing.
 */
export function packageManager(packageRoot: string, o: { env: Record<string, string | undefined>; home: string; npmRoot: () => string | null; real?: (p: string) => string }): { pm: PackageManager; dir: string } | null {
  const real = (p: string) => { try { return (o.real ?? realpathSync)(p); } catch { return p; } };
  const root = real(packageRoot).replace(/\/+$/, "");
  const bun = real(bunGlobalDir(o.env, o.home));
  if (root === join(bun, "node_modules", "capcomd")) return { pm: "bun", dir: bun };
  const npm = o.npmRoot();
  if (npm && root === join(real(npm), "capcomd")) return { pm: "npm", dir: real(npm) };
  return null;
}

/** The command that installs capcomd@version globally with `pm`. */
export function installArgv(pm: PackageManager, version: string): string[] {
  return pm === "bun" ? ["bun", "add", "-g", `capcomd@${version}`] : ["npm", "install", "-g", `capcomd@${version}`];
}

/** The engine's background service, as `update` restarts it (src/cli/commands/service.ts). */
export interface EngineService {
  /** The installed service (its definition and port), or null when none is installed. */
  installed(): { path: string; port: number } | null;
  /** Loaded (launchd) or active (systemd): running, or set to run. */
  loaded(): boolean;
  /** The command that restarts it, for the hints. */
  restartCommand(): string;
  restart(): { code: number; out: string };
  /** Wait for the restarted engine: whether it answers, and the version its daemon reports. */
  waitUp(port: number, version: string): Promise<{ running: boolean; version?: string }>;
}

/** What `update` reaches outside itself; tests give their own. */
export interface UpdateDeps {
  version: string;
  kind: InstallKind;
  /** The npm package's directory (a Bun or npm install). */
  packageRoot: string;
  env: Record<string, string | undefined>;
  home: string;
  /** GET a JSON document; null when it is not there (404). Throws a RelayError when it can't be fetched. */
  json(url: string): Promise<any | null>;
  /** Run a command with its output streamed (to stderr when `toStderr`, so --json's stdout stays one envelope). */
  run(argv: string[], o: { toStderr: boolean }): number;
  /** Run a command and capture its output. */
  capture(argv: string[]): { code: number; out: string };
  writable(dir: string): boolean;
  real(p: string): string;
  /** The version of the package at packageRoot, read again (after an install). */
  packageVersion(): string | null;
  /** Download the release's binary, check its sha256, replace the running one, prune old extracted engines. */
  installBinary(tag: string, latest: string): Promise<{ path: string; pruned: string[] }>;
  service: EngineService;
}

export interface UpdateOptions { to?: string; dryRun?: boolean; restart?: boolean; json?: boolean }

/** After an update: what happened to the engine. */
export interface EngineRestart {
  restarted: boolean;
  /** Dry run: whether it would restart the service. */
  wouldRestart?: boolean;
  running?: boolean;
  version?: string;
  port?: number;
  hint?: string;
  detail?: string;
}

export interface UpdateResult {
  current: string;
  latest?: string;
  kind: InstallKind;
  /** The package manager of a Bun or npm install, when known. */
  manager?: PackageManager;
  upgraded: boolean;
  dryRun?: boolean;
  /** The command run (or, in a dry run, that would run). */
  command?: string;
  /** Not run: the command to run yourself, and why. */
  how?: string;
  reason?: string;
  path?: string;
  pruned?: string[];
  engine?: EngineRestart;
}

const shown = (argv: string[]) => argv.join(" ");

export async function upgrade(o: UpdateOptions = {}, d: UpdateDeps = realDeps()): Promise<UpdateResult> {
  const current = d.version;
  const to = o.to?.replace(/^v/, "");
  const base = { current, kind: d.kind };
  if (d.kind === "checkout") return { ...base, upgraded: false, how: "git pull && bun install", reason: "a development checkout" };

  if (d.kind === "homebrew") {
    if (to) throw new RelayError("usage", "--to doesn't apply to a Homebrew install: Homebrew installs its formula's version", `Run \`capcomd update\` without --to, or install that version with install.sh: ${INSTALL_SH.replace("| sh", `| CAPCOMD_VERSION=${to} sh`)}`);
    const argv = ["brew", "upgrade", "capcomd"];
    if (o.dryRun) {
      const latest = brewInfo(d)?.stable;
      return { ...base, ...(latest ? { latest } : {}), upgraded: false, dryRun: true, command: shown(argv), engine: await engineAfter(o, d, true) };
    }
    const code = d.run(argv, { toStderr: !!o.json });
    if (code !== 0) throw new RelayError("run_failed", `\`${shown(argv)}\` failed (exit ${code}); capcomd ${current} is unchanged`, `Run it yourself to see why: ${shown(argv)}`);
    const now = brewInfo(d)?.linked ?? current;
    if (now === current) return { ...base, latest: current, upgraded: false, command: shown(argv) };
    return { ...base, latest: now, upgraded: true, command: shown(argv), engine: await engineAfter(o, d, false, now) };
  }

  if (d.kind === "npm") {
    const doc = await d.json(`${REGISTRY}/capcomd/${to ?? "latest"}`);
    if (!doc?.version) throw new RelayError("not_found", to ? `capcomd ${to} isn't published on npm` : "npm has no latest capcomd", "Check the version: https://www.npmjs.com/package/capcomd?activeTab=versions");
    const latest = String(doc.version);
    if (to ? latest === current : !olderThan(current, latest)) return { ...base, latest, upgraded: false };
    const found = packageManager(d.packageRoot, { env: d.env, home: d.home, real: d.real, npmRoot: () => { const r = d.capture(["npm", "root", "-g"]); return r.code === 0 && r.out ? r.out.trim().split("\n").pop()! : null; } });
    if (!found) return { ...base, latest, upgraded: false, how: `${shown(installArgv("bun", latest))} (or ${shown(installArgv("npm", latest))})`, reason: `capcomd can't tell which package manager installed ${d.packageRoot}` };
    const argv = installArgv(found.pm, latest);
    const ran = { ...base, latest, manager: found.pm };
    if (!d.writable(found.dir)) return { ...ran, upgraded: false, how: shown(argv), reason: `${found.dir} isn't writable by you (capcomd doesn't use sudo)` };
    if (o.dryRun) return { ...ran, upgraded: false, dryRun: true, command: shown(argv), engine: await engineAfter(o, d, true) };
    const code = d.run(argv, { toStderr: !!o.json });
    if (code !== 0) throw new RelayError("run_failed", `\`${shown(argv)}\` failed (exit ${code}); capcomd ${current} is unchanged`, `Run it yourself to see why: ${shown(argv)}`);
    const now = d.packageVersion();
    if (now !== latest) throw new RelayError("run_failed", `\`${shown(argv)}\` finished, but the capcomd at ${d.packageRoot} is ${now ?? "unreadable"}, not ${latest}`, `Check \`${found.pm === "bun" ? "bun pm ls -g" : "npm ls -g capcomd"}\`, or run it yourself: ${shown(argv)}`);
    return { ...ran, upgraded: true, command: shown(argv), engine: await engineAfter(o, d, false, latest) };
  }

  // The single executable.
  const tag = to ? `v${to}` : (await d.json(`https://api.github.com/repos/${REPO}/releases/latest`))?.tag_name as string | undefined;
  if (!tag) throw new RelayError("run_failed", "GitHub has no latest capcomd release", `Install by hand: ${INSTALL_SH}`);
  const latest = tag.replace(/^v/, "");
  if (to ? latest === current : !olderThan(current, latest)) return { ...base, latest, upgraded: false };
  if (o.dryRun) return { ...base, latest, upgraded: false, dryRun: true, command: `download ${assetName()} ${tag} from github.com/${REPO}/releases`, engine: await engineAfter(o, d, true) };
  const { path, pruned } = await d.installBinary(tag, latest);
  return { ...base, latest, upgraded: true, path, ...(pruned.length ? { pruned } : {}), engine: await engineAfter(o, d, false, latest) };
}

function brewInfo(d: UpdateDeps): { stable?: string; linked?: string } | null {
  const r = d.capture(["brew", "info", "--json=v2", "capcomd"]);
  if (r.code !== 0) return null;
  try {
    const f = JSON.parse(r.out)?.formulae?.[0];
    return { stable: f?.versions?.stable, linked: f?.linked_keg ?? f?.installed?.at(-1)?.version };
  } catch { return null; }
}

/** The engine after an update to `version` (or, in a dry run, what would happen to it). */
async function engineAfter(o: UpdateOptions, d: UpdateDeps, dryRun: boolean, version = ""): Promise<EngineRestart> {
  const svc = d.service.installed();
  const loaded = !!svc && d.service.loaded();
  const serve = `If you run the engine with \`capcomd serve\`, restart it${version ? ` to run ${version}` : ""}.`;
  if (dryRun) return { restarted: false, wouldRestart: loaded && o.restart !== false, ...(svc ? { port: svc.port } : {}) };
  if (!svc) return { restarted: false, hint: serve };
  if (o.restart === false) return { restarted: false, port: svc.port, hint: `The engine service still runs the old version until it restarts: ${d.service.restartCommand()}` };
  if (!loaded) return { restarted: false, port: svc.port, hint: `The engine service (${svc.path}) isn't loaded; it runs ${version} when it next starts (\`capcomd service install\` starts it now). ${serve}` };
  const r = d.service.restart();
  if (r.code !== 0) return { restarted: false, port: svc.port, detail: r.out.slice(-300), hint: `Restart it yourself: ${d.service.restartCommand()}` };
  const up = await d.service.waitUp(svc.port, version);
  return { restarted: true, port: svc.port, running: up.running, ...(up.version ? { version: up.version } : {}), ...(up.running ? {} : { hint: "It isn't answering yet: `capcomd service status`, and its log in ~/.capcomd/engine.log." }) };
}

async function fetchJson(url: string): Promise<any | null> {
  let r: Response;
  try { r = await fetch(url, { headers: { "user-agent": `capcomd/${VERSION}`, accept: "application/json" }, redirect: "follow", signal: AbortSignal.timeout(30_000) }); }
  catch (e) { throw new RelayError("run_failed", `GET ${url}: ${(e as Error).message}`, `Check your network, or install by hand: ${INSTALL_SH}`); }
  if (r.status === 404) return null;
  if (!r.ok) throw new RelayError("run_failed", `GET ${url}: ${r.status} ${r.statusText}`, `Check your network, or install by hand: ${INSTALL_SH}`);
  return r.json();
}

async function get(url: string): Promise<Response> {
  const r = await fetch(url, { headers: { "user-agent": `capcomd/${VERSION}` }, redirect: "follow" });
  if (!r.ok) throw new RelayError("run_failed", `GET ${url}: ${r.status} ${r.statusText}`, `Check your network, or install by hand: ${INSTALL_SH}`);
  return r;
}

/** The single executable's update: download, sha256 check, atomic replace, prune the old versions' engines. */
async function installBinary(tag: string, latest: string): Promise<{ path: string; pruned: string[] }> {
  const name = assetName();
  const base = `https://github.com/${REPO}/releases/download/${tag}`;
  const bin = Buffer.from(await (await get(`${base}/${name}`)).arrayBuffer());
  const want = (await (await get(`${base}/${name}.sha256`)).text()).trim().split(/\s+/)[0];
  const got = createHash("sha256").update(bin).digest("hex");
  if (got !== want) throw new RelayError("conflict", `checksum mismatch for ${name} ${tag} (expected ${want}, got ${got}); nothing was changed`, "Retry; if it persists, report it.");
  // Next to the running binary, then renamed over it: atomic, and a running capcomd (the engine) keeps its file.
  const self = realpathSync(process.execPath);
  const tmp = join(dirname(self), `.capcomd.${process.pid}.tmp`);
  writeFileSync(tmp, bin);
  chmodSync(tmp, 0o755);
  renameSync(tmp, self);
  // The engines extracted by older versions (~/.capcomd/bin/<version>/), except the running one's.
  const pruned: string[] = [];
  const cache = join(capcomdHome(), "bin");
  try { for (const v of readdirSync(cache)) if (/^\d+\.\d+\.\d+/.test(v) && v !== VERSION && v !== latest) { rmSync(join(cache, v), { recursive: true, force: true }); pruned.push(v); } } catch {}
  return { path: self, pruned };
}

/** The real machine: fetch, spawn, the filesystem, the service. */
export function realDeps(): UpdateDeps {
  return {
    version: VERSION,
    kind: installKind(),
    packageRoot: PACKAGE_ROOT,
    env: process.env,
    home: homedir(),
    json: fetchJson,
    run: (argv, o) => {
      // The bun that runs this capcomd, rather than whichever is first on PATH.
      const exe = argv[0] === "bun" && basename(process.execPath).startsWith("bun") ? process.execPath : argv[0]!;
      const r = spawnSync(exe, argv.slice(1), { stdio: ["ignore", o.toStderr ? 2 : "inherit", "inherit"] });
      return r.error ? 127 : r.status ?? 1;   // 127: not found, as a shell says it
    },
    capture: (argv) => { const r = spawnSync(argv[0]!, argv.slice(1), { encoding: "utf8", timeout: 60_000 }); return { code: r.status ?? 1, out: `${r.stdout ?? ""}`.trim() }; },
    writable: (dir) => { try { accessSync(dir, constants.W_OK); return true; } catch { return false; } },
    real: (p) => realpathSync(p),
    packageVersion: () => { try { return JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")).version ?? null; } catch { return null; } },
    installBinary,
    service: {
      installed: () => installedService(),
      loaded: () => serviceLoaded(),
      restartCommand: () => restartArgv().join(" "),
      restart: () => restartService(),
      waitUp: (port, version) => waitForDaemon(port, version),
    },
  };
}

/** The restarted engine: its daemon's harness socket answering with `version` (60 s), else the engine port answering. */
async function waitForDaemon(port: number, version: string): Promise<{ running: boolean; version?: string }> {
  const { harnessSocketPath, probeHarnessSocket } = await import("../../api/socket");
  const { readConfig, userConfigPath } = await import("../../config/store");
  // The service starts in the home directory with launchd's or systemd's environment: only the user config applies.
  const sock = harnessSocketPath({ env: {}, config: process.env.CAPCOMD_NO_CONFIG ? {} : readConfig(userConfigPath({})) });
  let seen: string | undefined;
  for (let i = 0; i < 120; i++) {
    const s = await probeHarnessSocket(sock, 1500);
    if (s.state === "live" && s.version) { seen = s.version; if (!version || s.version === version) return { running: true, version: s.version }; }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (seen) return { running: true, version: seen };
  return { running: await engineUp(port) };
}
