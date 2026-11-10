// Plugin API §6.1 (the owner's decision of 2026-11-08): a front door's verify, merge and approve go to the daemon that
// hosts its engine; with none, the CLI runs them itself only when nothing it can't ask must judge them. The user's
// plugins run only in the daemon (out of process), so here, with no daemon: one that listens to a gate refuses the
// operation (fail-closed, as a gate call that failed, §6.5), and one that listens to another hook is named on stderr
// and skipped. `capcomd spawn` and `capcomd run new` run where they're typed even with a daemon: the same rule. No
// engine either (CAPCOMD_ENDPOINT is the preload's closed port): what isn't refused fails engine_unreachable after.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { capcomd } from "../helpers/engine";
import { sameEngine } from "../../src/cli/daemon";

const home = process.env.CAPCOMD_HOME!;
const pluginDir = join(home, "plugins", "acme");
const plugin = (hooks: Record<string, object>) => {
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(join(pluginDir, "plugin.json"), JSON.stringify({
    schema: "capcomd.plugin/v1", name: "acme", version: "1.0.0", description: "a user's plugin", apiVersion: 1, engines: { capcomd: ">=0.0.0" },
    entry: { runtime: "process", command: ["bun", "${PLUGIN_ROOT}/main.js"] }, scopes: ["read"], contributes: { hooks },
  }));
};
const cli = async (args: string[], env: Record<string, string> = {}) => {
  const r = await capcomd([...args, "--json"], env);
  let j: any = null;
  try { j = JSON.parse(r.stdout.trim().split("\n").pop()!); } catch { /* text */ }
  return { ...r, j };
};
afterEach(() => {
  rmSync(pluginDir, { recursive: true, force: true });
  rmSync(join(home, "state", "plugins.json"), { force: true });
  rmSync(join(home, "config.json"), { force: true });
});

describe("with no daemon for the engine", () => {
  test("a plugin that judges verify, merge or approve refuses them: nothing runs that it couldn't judge", async () => {
    plugin({ "verify.judging": {}, "merge.landing": {}, "approval.deciding": {} });
    for (const [args, hook] of [
      [["verify", "run-1", "--ref", "agt-1", "--checks", "true"], "verify.judging"],
      [["merge", "run-1", "--ref", "agt-1", "--require", "vfy-1"], "merge.landing"],
      [["approve", "run-1", "mrg-1"], "approval.deciding"],
    ] as const) {
      const r = await cli([...args]);
      expect(r.code).toBe(2);
      expect(r.j.error).toMatchObject({ code: "config", reason: "plugins_unconsulted" });
      expect(r.j.error.message).toContain(`acme (`);
      expect(r.j.error.message).toContain(hook);
      expect(r.j.error.message).toContain("no daemon runs for this engine");
      expect(r.j.error.hint).toContain("capcomd serve");
    }
  }, 60_000);

  test("a plugin that only observes is named on stderr and skipped: the verify goes on (here, to an engine that isn't there)", async () => {
    plugin({ "verify.changed": {} });
    const r = await cli(["verify", "run-1", "--ref", "agt-1", "--checks", "true"]);
    expect(r.stderr).toContain("capcomd verify: not asked: acme (verify.changed), because no daemon runs for this engine to ask them.");
    expect(r.code).toBe(4);
    expect(r.j.error.code).toBe("engine_unreachable");
  }, 30_000);

  test("a plugin turned off in the user's config isn't one to ask", async () => {
    plugin({ "verify.judging": {} });
    writeFileSync(join(home, "config.json"), JSON.stringify({ plugins: { acme: { enabled: false } } }));
    const r = await cli(["verify", "run-1", "--ref", "agt-1", "--checks", "true"], { CAPCOMD_NO_CONFIG: "" });
    expect(r.j.error.code).toBe("engine_unreachable");
    expect(r.stderr).not.toContain("acme");
  }, 30_000);

  test("a daemon that hosts another engine, or doesn't answer, is no daemon for this one", async () => {
    plugin({ "merge.landing": {} });
    const snap = (o: object) => {
      mkdirSync(join(home, "state"), { recursive: true });
      writeFileSync(join(home, "state", "plugins.json"), JSON.stringify({ pid: process.pid, at: new Date().toISOString(), plugins: [], ...o }));
    };
    snap({ endpoint: "http://127.0.0.1:20123", socket: join(home, "nobody.sock") });
    let r = await cli(["merge", "run-1", "--ref", "agt-1", "--require", "vfy-1"]);
    expect(r.j.error).toMatchObject({ reason: "plugins_unconsulted" });
    expect(r.j.error.message).toContain("no daemon runs for this engine");
    // This engine's (the preload's endpoint), at a socket nobody serves: nothing was sent, so it is refused the same way.
    snap({ endpoint: "http://localhost:9", socket: join(home, "nobody.sock") });
    r = await cli(["merge", "run-1", "--ref", "agt-1", "--require", "vfy-1"]);
    expect(r.j.error).toMatchObject({ reason: "plugins_unconsulted" });
    expect(r.j.error.message).toContain("doesn't answer");
  }, 30_000);
});

test("a daemon is the front door's when its listing names the same engine: the same port on loopback, else the same origin", () => {
  expect(sameEngine("http://127.0.0.1:6420", "http://localhost:6420/")).toBe(true);
  expect(sameEngine("http://127.0.0.1:6420", "http://127.0.0.1:6421")).toBe(false);
  expect(sameEngine("http://[::1]:7000", "http://127.0.0.1:7000")).toBe(true);
  expect(sameEngine("http://engine.example:6420", "http://127.0.0.1:6420")).toBe(false);
  expect(sameEngine("https://engine.example", "https://engine.example:443/")).toBe(true);
  expect(sameEngine("not a url", "http://127.0.0.1:6420")).toBe(false);
});

describe("spawn and run new run where they're typed", () => {
  test("a closed listener refuses them; an open one (the default) is named and skipped", async () => {
    plugin({ "agent.spawning": { failure: "closed" }, "run.creating": {} });
    const s = await cli(["spawn", "run-1", "--task", "x"]);
    expect(s.code).toBe(2);
    expect(s.j.error).toMatchObject({ code: "config", reason: "plugins_unconsulted" });
    expect(s.j.error.message).toContain("acme (agent.spawning)");
    expect(s.j.error.hint).toContain("an agent's spawns run in the daemon");
    const n = await cli(["run", "new"]);
    expect(n.stderr).toContain("capcomd run new: not asked: acme (run.creating)");
    expect(n.j.error.code).toBe("engine_unreachable");
  }, 30_000);
});
