// `capcomd plugins enable|disable <name>` (plugin API §5.4, §9.9, §10.2): the choice is `plugins.<name>.enabled` in the
// user's config, and a running daemon applies it at once through POST /v1/plugins/{name}/enable|disable (the CLI reaches
// it at the harness socket it recorded in state/plugins.json, with a token made for the call and deleted after). The
// plugin is a user's out-of-process plugin (the proc-gate fixture), so the daemon really starts and stops its process.
// With no daemon only the config changes; a built-in is refused (conflict) before anything is written.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capcomd, testPort } from "../helpers/engine";
import { Engine } from "../helpers/test-engine";
import { readConfig } from "../../src/config/store";
import { loadClients } from "../../src/api/clients";

const MAIN = join(import.meta.dir, "..", "plugins", "fixtures", "proc-gate", "main.ts");
const home = process.env.CAPCOMD_HOME!;
const pluginDir = join(home, "plugins", "proc-gate");
// The daemon and the CLI read the user's config here (the preload's CAPCOMD_NO_CONFIG would skip it).
const env = { CAPCOMD_NO_CONFIG: "" };
let engine: Engine | null = null;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cli = async (...args: string[]) => {
  const r = await capcomd(args, env);
  let j: any = null;
  try { j = JSON.parse(r.stdout.trim().split("\n").pop()!); } catch { /* text */ }
  return { ...r, j };
};
const enabled = () => readConfig(join(home, "config.json")).plugins?.["proc-gate"]?.enabled;
/** proc-gate as `capcomd plugins list` has it, once `ok` says it is as wanted (the daemon's listing when one runs). */
async function listed(ok: (p: any, daemon: any) => boolean, ms = 60_000) {
  let last: any = null;
  for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) {
    const j = (await cli("plugins", "list", "--json")).j;
    last = j?.plugins?.find((p: { name: string }) => p.name === "proc-gate");
    if (last && ok(last, j.daemon)) return last;
  }
  throw new Error(`proc-gate never got there: ${JSON.stringify(last)}`);
}
const start = async () => {
  engine ??= new Engine("plugins-enable", { port: await testPort(), dataDir: mkdtempSync(join(tmpdir(), "relay-test-plugins-enable-")), env });
  await engine.start(null);
};

beforeAll(() => {
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(join(pluginDir, "plugin.json"), JSON.stringify({
    schema: "capcomd.plugin/v1", name: "proc-gate", version: "1.0.0", description: "proc-gate, as a user's plugin", apiVersion: 1, engines: { capcomd: ">=0.0.0" },
    entry: { runtime: "process", command: ["bun", MAIN] }, scopes: ["read"], contributes: { hooks: { "run.changed": {} } },
  }));
  // Its data directory: it records what it sees there (and allows every observe call without a control file).
  mkdirSync(join(home, "state", "plugins", "proc-gate"), { recursive: true });
});
afterAll(async () => {
  try { await engine?.stop(); } finally { rmSync(pluginDir, { recursive: true, force: true }); rmSync(join(home, "config.json"), { force: true }); }
});

describe("with no daemon running", () => {
  test("disable and enable only write the config, and say so", async () => {
    const off = await cli("plugins", "disable", "proc-gate", "--json");
    expect(off.code).toBe(0);
    expect(off.j).toMatchObject({ ok: true, plugin: "proc-gate", enabled: false, config: join(home, "config.json"), daemon: null });
    expect(enabled()).toBe(false);
    expect(await listed((p) => p.state === "validated")).toMatchObject({ enabled: false, cause: "disabled" });
    const on = await cli("plugins", "enable", "proc-gate");
    expect(on.code).toBe(0);
    expect(on.stdout).toContain(`Enabled proc-gate in your config (${join(home, "config.json")}: plugins.proc-gate.enabled = true).`);
    expect(on.stdout).toContain("No daemon is running: the config is all that changed");
    expect(enabled()).toBe(true);
  });

  test("a built-in is refused (conflict) and nothing is written; an unknown plugin is not_found", async () => {
    const r = await cli("plugins", "disable", "forge-git", "--json");
    expect(r.code).toBe(1);
    expect(r.j).toMatchObject({ ok: false, error: { code: "conflict", message: "forge-git is built into capcomd: it can't be disabled" } });
    expect(readConfig(join(home, "config.json")).plugins?.["forge-git"]).toBeUndefined();
    expect((await cli("plugins", "enable", "nonesuch", "--json")).j).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect((await cli("plugins", "disable", "--json")).code).toBe(2);
  });
});

describe("against a running daemon", () => {
  beforeAll(start, 180_000);

  test("disable stops the plugin now, the config records it, and it stays off across a restart; enable brings it back", async () => {
    await listed((p, daemon) => !!daemon && p.state === "active");
    const off = await cli("plugins", "disable", "proc-gate", "--json");
    expect(off.code).toBe(0);
    expect(off.j.daemon).toMatchObject({ applied: true, plugin: { name: "proc-gate", state: "disposed", cause: "disabled", enabled: false } });
    expect(enabled()).toBe(false);
    expect(await listed((p, daemon) => !!daemon && p.state === "disposed")).toMatchObject({ cause: "disabled" });
    // The token the CLI made for the call is gone with it.
    expect(loadClients()).toEqual([]);

    await engine!.stop();
    await start();
    // The restarted daemon read the config: the plugin is held at validated, never started.
    expect(await listed((p, daemon) => !!daemon && daemon.pid !== off.j.daemon.pid)).toMatchObject({ state: "validated", enabled: false, cause: "disabled" });

    const on = await cli("plugins", "enable", "proc-gate");
    expect(on.code).toBe(0);
    expect(on.stdout).toMatch(/The running daemon \(pid \d+\) enabled it: active\./);
    expect(enabled()).toBe(true);
    const pid = (await cli("plugins", "list", "--json")).j.daemon.pid;
    await engine!.stop();
    await start();
    expect(await listed((p, daemon) => !!daemon && daemon.pid !== pid && p.state === "active")).toMatchObject({ enabled: true, cause: null });
    expect(loadClients()).toEqual([]);
  }, 300_000);

  test("a built-in is refused with conflict and keeps running", async () => {
    const r = await cli("plugins", "disable", "forge-git");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("forge-git is built into capcomd: it can't be disabled");
    const list = (await cli("plugins", "list", "--json")).j;
    expect(list.daemon).not.toBeNull();
    expect(list.plugins.find((p: { name: string }) => p.name === "forge-git")).toMatchObject({ state: "active", enabled: true });
  }, 60_000);
});
