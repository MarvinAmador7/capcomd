// `capcomd update` (alias `upgrade`): the version check, how each install kind updates, and the engine service's
// restart. The package managers, brew, the registry and the service are fakes: nothing here touches the real global
// install, Homebrew or launchd/systemd.
import { describe, expect, test } from "bun:test";
import { bunGlobalDir, installArgv, packageManager, upgrade, type EngineService, type UpdateDeps } from "../../src/cli/commands/upgrade";
import { installedService } from "../../src/cli/commands/service";
import { COMMANDS } from "../../src/cli/groups/setup";
import { FRONT_SETUP } from "../../src/plugins/front/groups";
import { commandHelp } from "../../src/cli/help";
import { capcomd } from "../helpers/engine";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const HOME = "/home/me";
const BUN_PKG = `${HOME}/.bun/install/global/node_modules/capcomd`;
const NPM_ROOT = "/usr/local/lib/node_modules";

interface Calls { runs: string[][]; runOpts: Array<{ toStderr: boolean }>; captures: string[][]; restarts: number; waited: Array<[number, string]>; installs: string[] }

function fakeService(o: { installed?: boolean; loaded?: boolean; restartCode?: number; up?: boolean; upVersion?: string } = {}, calls: Calls): EngineService {
  return {
    installed: () => (o.installed ? { path: `${HOME}/Library/LaunchAgents/dev.capcomd.engine.plist`, port: 6420 } : null),
    loaded: () => o.loaded ?? !!o.installed,
    restartCommand: () => "launchctl kickstart -k gui/501/dev.capcomd.engine",
    restart: () => { calls.restarts++; return { code: o.restartCode ?? 0, out: o.restartCode ? "Could not find service" : "" }; },
    waitUp: async (port, version) => { calls.waited.push([port, version]); return o.up === false ? { running: false } : { running: true, version: o.upVersion ?? version }; },
  };
}

function deps(o: Partial<Omit<UpdateDeps, "writable">> & {
  registry?: Record<string, unknown>; runCode?: number; npmRoot?: string | null; writable?: boolean; after?: string | null;
  brew?: { stable: string; linked: string; linkedAfter?: string }; svc?: Parameters<typeof fakeService>[0];
} = {}) {
  const { registry, runCode, npmRoot, writable, after, brew, svc, ...over } = o;
  const calls: Calls = { runs: [], runOpts: [], captures: [], restarts: 0, waited: [], installs: [] };
  let ran = false;
  const d: UpdateDeps = {
    version: "0.12.2", kind: "npm", packageRoot: BUN_PKG, env: {}, home: HOME,
    json: async (url) => { const k = url.replace(/^https:\/\/[^/]+\//, ""); return k in (registry ?? {}) ? registry![k] : null; },
    run: (argv, ro) => { calls.runs.push(argv); calls.runOpts.push(ro); ran = true; return runCode ?? 0; },
    capture: (argv) => {
      calls.captures.push(argv);
      if (argv[0] === "npm") return npmRoot === null ? { code: 1, out: "" } : { code: 0, out: npmRoot ?? NPM_ROOT };
      if (argv[0] === "brew" && brew) {
        const linked = ran ? (brew.linkedAfter ?? brew.linked) : brew.linked;
        return { code: 0, out: JSON.stringify({ formulae: [{ name: "capcomd", versions: { stable: brew.stable }, linked_keg: linked, installed: [{ version: linked }] }] }) };
      }
      return { code: 1, out: "" };
    },
    writable: () => writable ?? true,
    real: (p) => p,
    packageVersion: () => (after === undefined ? (ran ? "0.12.3" : "0.12.2") : after),
    installBinary: async (tag) => { calls.installs.push(tag); return { path: `${HOME}/.capcomd/bin/capcomd`, pruned: ["0.12.1"] }; },
    service: fakeService(svc, calls),
    ...over,
  };
  return { d, calls };
}

const LATEST = { "capcomd/latest": { version: "0.12.3" } };

describe("capcomd update: the version first", () => {
  test("already up to date: nothing runs, nothing restarts", async () => {
    const { d, calls } = deps({ registry: { "capcomd/latest": { version: "0.12.2" } }, svc: { installed: true } });
    expect(await upgrade({}, d)).toEqual({ current: "0.12.2", kind: "npm", latest: "0.12.2", upgraded: false });
    expect(calls.runs).toEqual([]);
    expect(calls.restarts).toBe(0);
    // A newer local build than npm's latest (a release candidate after it) isn't downgraded either.
    const rc = deps({ version: "0.13.0-rc.1", registry: LATEST });
    expect((await upgrade({}, rc.d)).upgraded).toBe(false);
    expect(rc.calls.runs).toEqual([]);
  });
  test("--to: that version from the registry (a downgrade too); the same version is a no-op; an unknown one is refused", async () => {
    const { d, calls } = deps({ registry: { "capcomd/0.12.0": { version: "0.12.0" } }, after: "0.12.0" });
    const r = await upgrade({ to: "v0.12.0" }, d);
    expect(r).toMatchObject({ upgraded: true, latest: "0.12.0", command: "bun add -g capcomd@0.12.0" });
    expect(calls.runs).toEqual([["bun", "add", "-g", "capcomd@0.12.0"]]);
    const same = deps({ registry: { "capcomd/0.12.2": { version: "0.12.2" } } });
    expect((await upgrade({ to: "0.12.2" }, same.d)).upgraded).toBe(false);
    expect(same.calls.runs).toEqual([]);
    await expect(upgrade({ to: "9.9.9" }, deps().d)).rejects.toThrow(/capcomd 9.9.9 isn't published on npm/);
  });
});

describe("capcomd update: npm package installs", () => {
  test("Bun's global install: bun add -g, streamed (to stderr under --json)", async () => {
    const { d, calls } = deps({ registry: LATEST });
    const r = await upgrade({ json: true }, d);
    expect(r).toMatchObject({ current: "0.12.2", latest: "0.12.3", kind: "npm", manager: "bun", upgraded: true, command: "bun add -g capcomd@0.12.3" });
    expect(calls.runs).toEqual([["bun", "add", "-g", "capcomd@0.12.3"]]);
    expect(calls.runOpts).toEqual([{ toStderr: true }]);
    expect(calls.captures).toEqual([]);   // Bun's own dir matched: npm isn't asked
  });
  test("npm's global install (under `npm root -g`): npm install -g", async () => {
    const { d, calls } = deps({ registry: LATEST, packageRoot: `${NPM_ROOT}/capcomd` });
    expect(await upgrade({}, d)).toMatchObject({ manager: "npm", upgraded: true, command: "npm install -g capcomd@0.12.3" });
    expect(calls.runs).toEqual([["npm", "install", "-g", "capcomd@0.12.3"]]);
  });
  test("an install it can't place: it says what to run, and runs nothing", async () => {
    for (const npmRoot of [NPM_ROOT, null]) {
      const { d, calls } = deps({ registry: LATEST, packageRoot: "/opt/elsewhere/node_modules/capcomd", npmRoot });
      const r = await upgrade({}, d);
      expect(r).toMatchObject({ upgraded: false, latest: "0.12.3", how: "bun add -g capcomd@0.12.3 (or npm install -g capcomd@0.12.3)" });
      expect(r.reason).toContain("can't tell which package manager installed /opt/elsewhere/node_modules/capcomd");
      expect(calls.runs).toEqual([]);
    }
  });
  test("a global dir you can't write: the command to run, no sudo", async () => {
    const { d, calls } = deps({ registry: LATEST, packageRoot: `${NPM_ROOT}/capcomd`, writable: false });
    const r = await upgrade({}, d);
    expect(r).toMatchObject({ upgraded: false, how: "npm install -g capcomd@0.12.3", manager: "npm" });
    expect(r.reason).toContain(`${NPM_ROOT} isn't writable by you`);
    expect(calls.runs).toEqual([]);
  });
  test("the package manager fails: its exit and the command to run by hand; no restart", async () => {
    const { d, calls } = deps({ registry: LATEST, runCode: 1, svc: { installed: true } });
    const e = await upgrade({}, d).catch((x) => x);
    expect(e.message).toBe("`bun add -g capcomd@0.12.3` failed (exit 1); capcomd 0.12.2 is unchanged");
    expect(e.hint).toBe("Run it yourself to see why: bun add -g capcomd@0.12.3");
    expect(calls.restarts).toBe(0);
  });
  test("it finished but the package is still the old version: refused, no restart", async () => {
    const { d, calls } = deps({ registry: LATEST, after: "0.12.2", svc: { installed: true } });
    await expect(upgrade({}, d)).rejects.toThrow(/finished, but the capcomd at .* is 0.12.2, not 0.12.3/);
    expect(calls.restarts).toBe(0);
  });
  test("--dry-run: the version change and the command; nothing runs or restarts", async () => {
    const { d, calls } = deps({ registry: LATEST, svc: { installed: true } });
    expect(await upgrade({ dryRun: true }, d)).toEqual({ current: "0.12.2", kind: "npm", latest: "0.12.3", manager: "bun", upgraded: false, dryRun: true, command: "bun add -g capcomd@0.12.3", engine: { restarted: false, wouldRestart: true, port: 6420 } });
    expect(calls.runs).toEqual([]);
    expect(calls.restarts).toBe(0);
    const noRestart = deps({ registry: LATEST, svc: { installed: true } });
    expect((await upgrade({ dryRun: true, restart: false }, noRestart.d)).engine).toEqual({ restarted: false, wouldRestart: false, port: 6420 });
  });
});

describe("capcomd update: Homebrew, the binary, a checkout", () => {
  test("Homebrew: brew upgrade capcomd, then the linked version decides whether it changed", async () => {
    const { d, calls } = deps({ kind: "homebrew", brew: { stable: "0.12.3", linked: "0.12.2", linkedAfter: "0.12.3" }, svc: { installed: true } });
    expect(await upgrade({}, d)).toMatchObject({ kind: "homebrew", upgraded: true, latest: "0.12.3", command: "brew upgrade capcomd", engine: { restarted: true, running: true, version: "0.12.3" } });
    expect(calls.runs).toEqual([["brew", "upgrade", "capcomd"]]);
    expect(calls.restarts).toBe(1);
    // Already current: brew does nothing, so capcomd restarts nothing.
    const cur = deps({ kind: "homebrew", brew: { stable: "0.12.2", linked: "0.12.2" }, svc: { installed: true } });
    expect(await upgrade({}, cur.d)).toMatchObject({ upgraded: false, latest: "0.12.2" });
    expect(cur.calls.restarts).toBe(0);
  });
  test("Homebrew: --dry-run runs nothing; --to is refused; a failing brew says so", async () => {
    const { d, calls } = deps({ kind: "homebrew", brew: { stable: "0.12.3", linked: "0.12.2" } });
    expect(await upgrade({ dryRun: true }, d)).toMatchObject({ dryRun: true, latest: "0.12.3", command: "brew upgrade capcomd", upgraded: false });
    expect(calls.runs).toEqual([]);
    await expect(upgrade({ to: "0.12.3" }, d)).rejects.toThrow(/--to doesn't apply to a Homebrew install/);
    const bad = deps({ kind: "homebrew", runCode: 1, brew: { stable: "0.12.3", linked: "0.12.2" } });
    await expect(upgrade({}, bad.d)).rejects.toThrow("`brew upgrade capcomd` failed (exit 1)");
  });
  test("the binary: from the GitHub release, replaced in place, then the service restarted", async () => {
    const { d, calls } = deps({ kind: "binary", registry: { "repos/MarvinAmador7/capcomd/releases/latest": { tag_name: "v0.12.3" } }, svc: { installed: true } });
    expect(await upgrade({}, d)).toMatchObject({ kind: "binary", upgraded: true, latest: "0.12.3", path: `${HOME}/.capcomd/bin/capcomd`, pruned: ["0.12.1"], engine: { restarted: true, running: true } });
    expect(calls.installs).toEqual(["v0.12.3"]);
    expect(calls.waited).toEqual([[6420, "0.12.3"]]);
    const dry = deps({ kind: "binary", registry: { "repos/MarvinAmador7/capcomd/releases/latest": { tag_name: "v0.12.3" } } });
    expect(await upgrade({ dryRun: true }, dry.d)).toMatchObject({ dryRun: true, upgraded: false, latest: "0.12.3" });
    expect(dry.calls.installs).toEqual([]);
    const cur = deps({ kind: "binary", registry: { "repos/MarvinAmador7/capcomd/releases/latest": { tag_name: "v0.12.2" } } });
    expect((await upgrade({}, cur.d)).upgraded).toBe(false);
    expect(cur.calls.installs).toEqual([]);
  });
  test("a development checkout: the advice only; never git", async () => {
    const { d, calls } = deps({ kind: "checkout", registry: LATEST });
    expect(await upgrade({}, d)).toEqual({ current: "0.12.2", kind: "checkout", upgraded: false, how: "git pull && bun install", reason: "a development checkout" });
    expect(calls.runs).toEqual([]);
    expect(calls.captures).toEqual([]);
  });
});

describe("capcomd update: the engine service afterwards", () => {
  test("no service installed: no restart, the `capcomd serve` hint", async () => {
    const { d, calls } = deps({ registry: LATEST });
    expect((await upgrade({}, d)).engine).toEqual({ restarted: false, hint: "If you run the engine with `capcomd serve`, restart it to run 0.12.3." });
    expect(calls.restarts).toBe(0);
  });
  test("--no-restart: the service is left alone, with the command that restarts it", async () => {
    const { d, calls } = deps({ registry: LATEST, svc: { installed: true } });
    const e = (await upgrade({ restart: false }, d)).engine!;
    expect(e.restarted).toBe(false);
    expect(e.hint).toContain("launchctl kickstart -k gui/501/dev.capcomd.engine");
    expect(calls.restarts).toBe(0);
  });
  test("installed but not loaded: not started behind the user's back", async () => {
    const { d, calls } = deps({ registry: LATEST, svc: { installed: true, loaded: false } });
    expect((await upgrade({}, d)).engine!.hint).toContain("isn't loaded; it runs 0.12.3 when it next starts");
    expect(calls.restarts).toBe(0);
  });
  test("restarted and probed: the version it came back with; a failed restart or a silent engine is reported", async () => {
    const ok = deps({ registry: LATEST, svc: { installed: true } });
    expect((await upgrade({}, ok.d)).engine).toEqual({ restarted: true, port: 6420, running: true, version: "0.12.3" });
    const failed = deps({ registry: LATEST, svc: { installed: true, restartCode: 113 } });
    expect((await upgrade({}, failed.d)).engine).toMatchObject({ restarted: false, detail: "Could not find service", hint: "Restart it yourself: launchctl kickstart -k gui/501/dev.capcomd.engine" });
    const silent = deps({ registry: LATEST, svc: { installed: true, up: false } });
    expect((await upgrade({}, silent.d)).engine).toMatchObject({ restarted: true, running: false });
  });
});

describe("where an install lives", () => {
  test("Bun's global dir from the environment; the install commands", () => {
    expect(bunGlobalDir({}, HOME)).toBe(`${HOME}/.bun/install/global`);
    expect(bunGlobalDir({ BUN_INSTALL: "/opt/bun" }, HOME)).toBe("/opt/bun/install/global");
    expect(bunGlobalDir({ BUN_INSTALL: "/opt/bun", BUN_INSTALL_GLOBAL_DIR: "/g" }, HOME)).toBe("/g");
    expect(installArgv("bun", "1.2.3")).toEqual(["bun", "add", "-g", "capcomd@1.2.3"]);
    expect(installArgv("npm", "1.2.3")).toEqual(["npm", "install", "-g", "capcomd@1.2.3"]);
  });
  test("bun vs npm by the package's real path; a lookalike path is neither", () => {
    const at = (root: string, npm: string | null = NPM_ROOT, env = {}) => packageManager(root, { env, home: HOME, npmRoot: () => npm, real: (p) => p })?.pm ?? null;
    expect(at(BUN_PKG)).toBe("bun");
    expect(at("/opt/bun/install/global/node_modules/capcomd", NPM_ROOT, { BUN_INSTALL: "/opt/bun" })).toBe("bun");
    expect(at(`${NPM_ROOT}/capcomd`)).toBe("npm");
    expect(at(`${NPM_ROOT}/capcomd`, null)).toBe(null);
    expect(at(`${NPM_ROOT}/other/node_modules/capcomd`)).toBe(null);
    expect(at(`${HOME}/.bun/install/global/node_modules/capcomd-fork`)).toBe(null);
    // A symlinked global dir: compared by real paths.
    const real = (p: string) => p.replace("/link/", "/real/");
    expect(packageManager("/real/node_modules/capcomd", { env: { BUN_INSTALL_GLOBAL_DIR: "/link/" }, home: HOME, npmRoot: () => null, real })?.pm).toBe("bun");
  });
  test("the installed service's port, read from its definition", () => {
    const home = mkdtempSync(join(tmpdir(), "capcomd-update-svc-"));
    try {
      expect(installedService("darwin", home)).toBe(null);
      mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
      writeFileSync(join(home, "Library", "LaunchAgents", "dev.capcomd.engine.plist"), "<array><string>/b/capcomd</string><string>serve</string><string>--port</string><string>6533</string></array>");
      expect(installedService("darwin", home)!.port).toBe(6533);
      mkdirSync(join(home, ".config", "systemd", "user"), { recursive: true });
      writeFileSync(join(home, ".config", "systemd", "user", "capcomd-engine.service"), "ExecStart=/b/capcomd serve --port 6421\n");
      expect(installedService("linux", home)!.port).toBe(6421);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

describe("the command and its alias", () => {
  test("`upgrade` is `update`: one handler, both listed, help names update", async () => {
    expect(COMMANDS.upgrade).toBe(COMMANDS.update);
    const cli = FRONT_SETUP.manifest.contributes!.cli!.map((c) => c.name);
    expect(cli).toContain("update");
    expect(cli).toContain("upgrade");
    expect(commandHelp("update")).toContain("capcomd update [--to X.Y.Z] [--dry-run] [--no-restart]");
    expect(commandHelp("update")).toContain("(alias: upgrade)");
  });
  test("from this checkout, update and upgrade --dry-run --json give the same advice and run nothing", async () => {
    const [a, b] = await Promise.all([capcomd(["update", "--dry-run", "--json"]), capcomd(["upgrade", "--dry-run", "--no-restart", "--json"])]);
    expect(a.code).toBe(0);
    expect(JSON.parse(a.stdout)).toMatchObject({ ok: true, kind: "checkout", upgraded: false, how: "git pull && bun install" });
    expect(JSON.parse(b.stdout)).toEqual(JSON.parse(a.stdout));
    const t = await capcomd(["update"]);
    expect(t.stdout).toContain("runs from a development checkout; update it with: git pull && bun install");
  });
});
