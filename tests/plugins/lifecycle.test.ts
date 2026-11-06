// ADR-024 `lifecycle.onStart|onEnd` (docs/spec/plugin-api.md §6.6.8): who says whether the plugins a profile names can
// hear its agents. In the daemon its own host does (an active plugin listening to agent.changed); elsewhere the running
// daemon's listing; with no daemon nobody can, and nothing is refused for it. tests/scenarios/profile-runtime.test.ts
// has the spawns this refuses and the agent.changed the named plugin hears.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { PluginHost, type Candidate } from "../../packages/plugin/src/host/host";
import type { PluginContext, PluginModule } from "../../packages/plugin/src/context";
import { useHooks } from "../../src/plugins/hooks";
import { lifecycleCheck } from "../../src/plugins/lifecycle";

const plugin = (name: string, hooks: Record<string, object>, activate: (ctx: PluginContext) => void = () => {}): Candidate => ({
  source: "builtin",
  manifest: { schema: "capcomd.plugin/v1", name, version: "1.0.0", description: `The ${name} test plugin.`, apiVersion: 1, engines: { capcomd: ">=0.0.0" }, entry: { runtime: "in-process", module: "./index.ts" }, contributes: { hooks } },
  module: { activate } as PluginModule<never>,
});
afterEach(() => useHooks(null));

test("in the daemon: each named plugin must be active and listening to agent.changed", async () => {
  const host = new PluginHost({ capcomd: "0.9.0", kernel: [], emit: () => {}, dataDir: (n) => join(tmpdir(), "capcomd-lifecycle", n) });
  await host.start([
    plugin("notes", { "agent.changed": {} }, (ctx) => { ctx.hooks.on("agent.changed", () => undefined); }),
    plugin("quiet", { "run.changed": {} }, (ctx) => { ctx.hooks.on("run.changed", () => undefined); }),
  ]);
  useHooks(host.hooks);
  expect(await lifecycleCheck([])).toEqual({ problem: null, checked: true });
  expect(await lifecycleCheck(["notes"])).toEqual({ problem: null, checked: true });
  expect(await lifecycleCheck(["notes", "quiet", "gone"])).toEqual({ problem: "lifecycle names quiet, gone, which aren't active plugins listening to agent.changed on this daemon", checked: true });
  await host.stop();
});

test("elsewhere: the running daemon's listing says; with no daemon running, nobody can", async () => {
  const home = mkdtempSync(join(tmpdir(), "capcomd-lifecycle-home-"));
  const env = { CAPCOMD_HOME: home };
  expect(await lifecycleCheck(["notes"], env)).toEqual({ problem: null, checked: false });
  mkdirSync(join(home, "state"), { recursive: true });
  const row = (name: string, o: Record<string, unknown> = {}) => ({ name, version: "1.0.0", apiVersion: 1, runtime: "in-process", source: "builtin", state: "active", enabled: true, cause: null, hooks: ["agent.changed"], seams: [], hooksSuspended: false, stats: { calls: 0, failures: 0, p50Ms: null, p95Ms: null, lastFailureAt: null }, ...o });
  // This process stands in for the daemon that wrote it (a listing whose daemon is gone is no listing).
  writeFileSync(join(home, "state", "plugins.json"), JSON.stringify({ pid: process.pid, at: new Date().toISOString(), plugins: [row("notes"), row("off", { enabled: false, state: "disposed" }), row("deaf", { hooks: ["run.changed"] })] }));
  expect(await lifecycleCheck(["notes"], env)).toEqual({ problem: null, checked: true });
  expect((await lifecycleCheck(["notes", "off", "deaf"], env)).problem).toBe("lifecycle names off, deaf, which aren't active plugins listening to agent.changed on this daemon");
});
