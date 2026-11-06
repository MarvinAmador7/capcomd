// A plugin's settings (docs/spec/plugin-api.md §10.2, §10.4; src/plugins/config.ts): the user's, then the project's
// `plugins.<name>`, then CAPCOMD_PLUGIN_<NAME>_<KEY>, over the schema's defaults; `enabled` at any layer; what the schema
// refuses fails the plugin `config_invalid` with `plugin.config_refused`. A built-in that is off until asked for (the
// watchdog).
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginHost } from "../../packages/plugin/src/host/host";
import type { HostEvent } from "../../packages/plugin/src/host/registry";
import { definePlugin } from "../../packages/plugin/src/context";
import { PluginError } from "../../packages/plugin/src/errors";
import type { PluginManifest } from "../../packages/plugin/src/manifest";
import { checkSchema, envName, mergePatch, pluginSettings } from "../../src/plugins/config";
import { builtinCandidates } from "../../src/plugins/host";
import { mergeConfig } from "../../src/config/store";

const SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    everyMs: { type: "integer", minimum: 1000, default: 60_000 },
    mode: { type: "string", enum: ["quiet", "loud"], default: "quiet" },
    labels: { type: "object", additionalProperties: { type: "string" } },
    token: { "x-secret": true, default: { $secret: "env:TOKEN" } },
  },
};
const M = { name: "my-plugin", config: SCHEMA };

/** A home with a user config and a project checkout with its own, each `plugins.my-plugin` as given. */
function place(user: unknown, project: unknown) {
  const home = mkdtempSync(join(tmpdir(), "capcomd-pcfg-home-"));
  const repo = mkdtempSync(join(tmpdir(), "capcomd-pcfg-repo-"));
  mkdirSync(join(home, ".capcomd"), { recursive: true });
  mkdirSync(join(repo, ".capcomd"), { recursive: true });
  if (user !== undefined) writeFileSync(join(home, ".capcomd", "config.json"), JSON.stringify({ plugins: { "my-plugin": user } }));
  if (project !== undefined) writeFileSync(join(repo, ".capcomd", "config.json"), JSON.stringify({ plugins: { "my-plugin": project } }));
  return { env: { HOME: home, CAPCOMD_HOME: join(home, ".capcomd") } as Record<string, string | undefined>, cwd: repo };
}

describe("layers (§10.2)", () => {
  test("user, then project, then the environment: objects merge, null deletes, enabled from the last layer that says", () => {
    const p = place({ everyMs: 5000, labels: { a: "1", b: "2" }, enabled: false }, { labels: { b: null, c: "3" }, enabled: true });
    expect(pluginSettings(M, p)).toEqual({ enabled: true, config: { everyMs: 5000, labels: { a: "1", c: "3" } }, errors: [] });
    const env = { ...p.env, CAPCOMD_PLUGIN_MY_PLUGIN_EVERYMS: "2000", CAPCOMD_PLUGIN_MY_PLUGIN_MODE: "loud", CAPCOMD_PLUGIN_MY_PLUGIN_ENABLED: "false" };
    expect(pluginSettings(M, { ...p, env })).toEqual({ enabled: false, config: { everyMs: 2000, mode: "loud", labels: { a: "1", c: "3" } }, errors: [] });
    expect(envName("sandbox-docker", "idle.lifetime")).toBe("CAPCOMD_PLUGIN_SANDBOX_DOCKER_IDLE_LIFETIME");
  });

  test("what the schema refuses is named with its layer; a secret is never read from a layer; CAPCOMD_NO_CONFIG skips the files", () => {
    const p = place({ everyMs: 10, colour: "red", token: { $secret: "env:OTHER" } }, { mode: "noisy", enabled: "yes" });
    const s = pluginSettings(M, { ...p, env: { ...p.env, CAPCOMD_PLUGIN_MY_PLUGIN_EVERYMS: "fast" } });
    expect(s.errors).toEqual([
      { path: "everyMs", message: "must be at least 1000", layer: "user" },
      { path: "colour", message: "is not a setting of this plugin", layer: "user" },
      { path: "enabled", message: "must be true or false", layer: "project" },
      { path: "mode", message: "must be one of \"quiet\", \"loud\"", layer: "project" },
      { path: "everyMs", message: "must be integer", layer: "env" },
    ]);
    expect(s.config).not.toHaveProperty("token");
    const off = pluginSettings(M, { ...p, env: { ...p.env, CAPCOMD_NO_CONFIG: "1", CAPCOMD_PLUGIN_MY_PLUGIN_EVERYMS: "3000" } });
    expect(off).toEqual({ config: { everyMs: 3000 }, errors: [] });
  });

  test("the merge and the schema check", () => {
    expect(mergePatch({ a: { b: 1, c: 2 }, d: [1] }, { a: { c: null, e: 3 }, d: [2] })).toEqual({ a: { b: 1, e: 3 }, d: [2] });
    expect(checkSchema({ type: "object", required: ["x"], properties: { x: { type: "array", items: { type: "number", maximum: 2 } } } }, { x: [1, 3] })).toEqual([{ path: "x[1]", message: "must be at most 2" }]);
    // `capcomd setup` adds a plugin's settings without dropping another's or the plugin's other keys.
    expect(mergeConfig({ plugins: { a: { enabled: false, x: 1 }, b: { y: 2 } } }, { plugins: { a: { enabled: true } } })).toEqual({ plugins: { a: { enabled: true, x: 1 }, b: { y: 2 } } });
  });
});

describe("the host and the built-ins", () => {
  const manifest: PluginManifest = {
    schema: "capcomd.plugin/v1", name: "my-plugin", version: "1.0.0", description: "test", apiVersion: 1, engines: { capcomd: ">=0.0.0" },
    entry: { runtime: "in-process", module: "./index.ts" }, contributes: { hooks: { "run.changed": {} } }, config: SCHEMA,
  };
  const seen: Array<Record<string, unknown>> = [];
  const module = definePlugin<Record<string, unknown>>({ activate(ctx) { seen.push(ctx.config.get()); ctx.hooks.on("run.changed", () => {}); } });
  const host = (events: HostEvent[]) => new PluginHost({ capcomd: "1.0.0", kernel: [], emit: (e) => { events.push(e); }, dataDir: (n) => `/nonexistent/${n}` });

  test("invalid settings fail the plugin config_invalid with plugin.config_refused per layer; it never runs with defaults", async () => {
    const events: HostEvent[] = [];
    const h = host(events);
    const [r] = await h.start([{ source: "builtin", manifest, module, configErrors: [{ path: "everyMs", message: "must be at least 1000", layer: "user" }, { path: "mode", message: "must be one of", layer: "env" }] }]);
    expect(r).toMatchObject({ name: "my-plugin", state: "failed", cause: "config_invalid" });
    expect(events.filter((e) => e.type === "plugin.config_refused").map((e) => e.data)).toEqual([
      { plugin: "my-plugin", errors: [{ path: "everyMs", message: "must be at least 1000" }], layer: "user" },
      { plugin: "my-plugin", errors: [{ path: "mode", message: "must be one of" }], layer: "env" },
    ]);
    expect(seen).toEqual([]);
    // Disabled, its settings aren't its problem yet; valid ones reach ctx.config over the defaults.
    const [off] = await host([]).start([{ source: "builtin", manifest, module, enabled: false, configErrors: [{ path: "x", message: "bad", layer: "user" }] }]);
    expect(off).toMatchObject({ state: "validated", enabled: false, cause: "disabled" });
    await host([]).start([{ source: "builtin", manifest, module, config: { everyMs: 2000 } }]);
    expect(seen).toEqual([{ everyMs: 2000, mode: "quiet" }]);
  });

  test("the watchdog is a built-in that's off until enabled; its settings come from the layers", () => {
    const wd = (env: Record<string, string | undefined>) => builtinCandidates({ ...process.env, ...env }).find((c) => (c.manifest as { name?: string })?.name === "watchdog")!;
    expect(wd({}).enabled).toBe(false);
    const on = wd({ CAPCOMD_PLUGIN_WATCHDOG_ENABLED: "true", CAPCOMD_PLUGIN_WATCHDOG_STALLEDAFTERMS: "3000" });
    expect(on).toMatchObject({ enabled: true, config: { stalledAfterMs: 3000 } });
    expect(wd({ CAPCOMD_PLUGIN_WATCHDOG_ENABLED: "true", CAPCOMD_PLUGIN_WATCHDOG_EVERYMS: "5" }).configErrors).toEqual([{ path: "everyMs", message: "must be at least 1000", layer: "env" }]);
    // Every other built-in is on, as before.
    for (const c of builtinCandidates()) if ((c.manifest as { name: string }).name !== "watchdog") expect(c.enabled).toBe(true);
  });
});
