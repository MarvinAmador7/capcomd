// A plugin's settings (docs/spec/plugin-api.md §10.2, §10.4; src/plugins/config.ts): the user's, then the project's
// `plugins.<name>`, then CAPCOMD_PLUGIN_<NAME>_<KEY>, over the schema's defaults; `enabled` at any layer; what the schema
// refuses fails the plugin `config_invalid` with `plugin.config_refused`. A built-in that is off until asked for (the
// watchdog). A plugin that isn't a shipped built-in never names one of the kernel's own variables as a secret (§10.3).
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginHost } from "../../packages/plugin/src/host/host";
import type { HostEvent } from "../../packages/plugin/src/host/registry";
import { definePlugin } from "../../packages/plugin/src/context";
import { PluginError } from "../../packages/plugin/src/errors";
import type { PluginManifest } from "../../packages/plugin/src/manifest";
import { checkSchema, envName, kernelSecretRef, mergePatch, pluginSettings } from "../../src/plugins/config";
import { builtinCandidates, kernelHost } from "../../src/plugins/host";
import { resolveSecret, secretOrUndefined } from "../../src/plugins/secrets";
import { manifest as boxdManifest } from "../../src/plugins/builtin/sandbox-boxd";
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
  test("user, then project, then the environment: objects merge, null deletes, enabled from the user or the environment", () => {
    const p = place({ everyMs: 5000, labels: { a: "1", b: "2" }, enabled: false }, { labels: { b: null, c: "3" }, enabled: true });
    // A project can't turn on what the user turned off (step 12): its `enabled` counts only to turn off its own plugin.
    expect(pluginSettings(M, p)).toEqual({ enabled: false, config: { everyMs: 5000, labels: { a: "1", c: "3" } }, errors: [], sources: { everyMs: "user", labels: "project" } });
    const env = { ...p.env, CAPCOMD_PLUGIN_MY_PLUGIN_EVERYMS: "2000", CAPCOMD_PLUGIN_MY_PLUGIN_MODE: "loud", CAPCOMD_PLUGIN_MY_PLUGIN_ENABLED: "true" };
    expect(pluginSettings(M, { ...p, env })).toEqual({ enabled: true, config: { everyMs: 2000, mode: "loud", labels: { a: "1", c: "3" } }, errors: [], sources: { everyMs: "env", labels: "project", mode: "env" } });
    expect(envName("sandbox-docker", "idle.lifetime")).toBe("CAPCOMD_PLUGIN_SANDBOX_DOCKER_IDLE_LIFETIME");
  });

  test("what the schema refuses is named with its layer; a secret is never in the config; CAPCOMD_NO_CONFIG skips the files", () => {
    const p = place({ everyMs: 10, colour: "red", token: { $secret: "env:OTHER" } }, { mode: "noisy", enabled: "yes" });
    const s = pluginSettings(M, { ...p, env: { ...p.env, CAPCOMD_PLUGIN_MY_PLUGIN_EVERYMS: "fast" } });
    expect(s.errors).toEqual([
      { path: "everyMs", message: "must be at least 1000", layer: "user" },
      { path: "colour", message: "is not a setting of this plugin", layer: "user" },
      // The project's, for a plugin that isn't the project's: set aside (reported, left out), never failing it.
      { path: "enabled", message: "must be true or false", layer: "project", setAside: true },
      { path: "mode", message: "must be one of \"quiet\", \"loud\"", layer: "project", setAside: true },
      { path: "everyMs", message: "must be integer", layer: "env" },
    ]);
    expect(s.config).not.toHaveProperty("token");
    const off = pluginSettings(M, { ...p, env: { ...p.env, CAPCOMD_NO_CONFIG: "1", CAPCOMD_PLUGIN_MY_PLUGIN_EVERYMS: "3000" } });
    expect(off).toEqual({ config: { everyMs: 3000 }, errors: [], sources: { everyMs: "env" } });
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

  test("a user's plugin whose default secret names the kernel's BOXD_API_KEY fails config_invalid; its secret is never read", async () => {
    const p = place(undefined, undefined);
    const dir = join(p.env.CAPCOMD_HOME!, "plugins", "boxd-peek");
    mkdirSync(dir, { recursive: true });
    const peek: PluginManifest = {
      ...manifest, name: "boxd-peek", entry: { runtime: "process", command: ["./run.sh"] },
      config: { type: "object", additionalProperties: false, properties: { apiKey: { type: "object", "x-secret": true, default: { $secret: "env:BOXD_API_KEY" } } } },
    };
    writeFileSync(join(dir, "plugin.json"), JSON.stringify(peek));
    writeFileSync(join(dir, "run.sh"), "#!/bin/sh\n", { mode: 0o755 });
    const c = builtinCandidates({ ...p.env, BOXD_API_KEY: "bxd_kernel" }, p.cwd).find((x) => x.dir === dir)!;
    expect(c.configErrors).toEqual([{ path: "apiKey", layer: "default", message: expect.stringContaining("names env:BOXD_API_KEY, one of capcomd's own variables") }]);
    const asked: string[] = [];
    const events: HostEvent[] = [];
    const h = new PluginHost({ capcomd: "1.0.0", kernel: [], emit: (e) => { events.push(e); }, dataDir: (n) => `/nonexistent/${n}`, secret: async (_m, key) => { asked.push(key); return "x"; } });
    const [r] = await h.start([c]);
    expect(r).toMatchObject({ name: "boxd-peek", state: "failed", cause: "config_invalid" });
    expect(h.message("boxd-peek")).toContain("default: plugins.boxd-peek.apiKey: is a secret whose default names env:BOXD_API_KEY");
    expect(events.find((e) => e.type === "plugin.config_refused")?.data).toMatchObject({ plugin: "boxd-peek", layer: "default" });
    expect(asked).toEqual([]);
    // Resolving it anyway is refused without reading the variable; only the kernel's own built-in may.
    const read: string[] = [];
    const env = new Proxy({ ...p.env, BOXD_API_KEY: "bxd_kernel" } as Record<string, string | undefined>, { get: (t, k: string) => { read.push(k); return t[k]; } });
    expect(() => resolveSecret(peek, "apiKey", env, dir)).toThrow(expect.objectContaining({ code: "forbidden" }));
    // A test plugin is `builtin` by source but has a directory: refused too.
    expect(() => resolveSecret(peek, "apiKey", env, dir, { builtin: true })).toThrow(expect.objectContaining({ code: "forbidden" }));
    // As the host asks for a third-party plugin's: its default isn't followed at all.
    expect(() => resolveSecret(peek, "apiKey", env, dir, { builtin: false })).toThrow(expect.objectContaining({ code: "not_found" }));
    expect(read).not.toContain("BOXD_API_KEY");
    expect(resolveSecret(peek, "apiKey", env, null, { builtin: true })).toBe("bxd_kernel");
  });

  test("the deprecated RELAY_* spelling, another case, or capcomd's keychain item is the kernel's too; resolving one is forbidden unread", () => {
    for (const ref of ["env:RELAY_RPC_KEY", "env:relay_git_token", "env:boxd_api_key", "env:Github_Token", "keychain:capcomd", "keychain:capcomd.boxd"]) expect(kernelSecretRef(ref)).toContain(ref);
    for (const ref of ["env:MY_RELAY_TOKEN", "keychain:github-token", "keychain:my-capcomd"]) expect(kernelSecretRef(ref)).toBeNull();
    const env = { ...place(undefined, undefined).env, CAPCOMD_PLUGIN_MY_PLUGIN_TOKEN: '{"$secret":"env:RELAY_RPC_KEY"}', RELAY_RPC_KEY: "rpc-secret" };
    expect(pluginSettings(M, { env, source: "user", dir: "/plugins/my-plugin" }).errors).toMatchObject([{ path: "token", layer: "env", message: expect.stringContaining("env:RELAY_RPC_KEY") }]);
    const user = place({ token: { $secret: "keychain:capcomd" } }, undefined);
    expect(pluginSettings(M, { ...user, source: "user", dir: "/plugins/my-plugin" }).errors).toMatchObject([{ path: "token", layer: "user", message: expect.stringContaining("keychain items") }]);
    // A test plugin (source builtin, with a directory) is held to the same rule as a user's.
    expect(pluginSettings(M, { env, source: "builtin", dir: "/tests/fixtures/my-plugin" }).errors).toMatchObject([{ path: "token", layer: "env" }]);
    expect(pluginSettings(M, { env, source: "builtin", dir: null }).errors).toEqual([]);
    const read: string[] = [];
    const watched = new Proxy(env as Record<string, string | undefined>, { get: (t, k: string) => { read.push(k); return t[k]; } });
    expect(() => resolveSecret(M, "token", watched, "/plugins/my-plugin", { builtin: false })).toThrow(expect.objectContaining({ code: "forbidden" }));
    expect(read).not.toContain("RELAY_RPC_KEY");
  });

  test("an override in the user's config or CAPCOMD_PLUGIN_* that names a kernel variable is refused; a variable of its own isn't", () => {
    const user = place({ token: { $secret: "env:GITHUB_TOKEN" } }, undefined);
    expect(pluginSettings(M, { ...user, source: "user", dir: "/plugins/my-plugin" }).errors).toEqual([{ path: "token", layer: "user", message: expect.stringContaining("names env:GITHUB_TOKEN, one of capcomd's own variables") }]);
    const env = { ...place(undefined, undefined).env, CAPCOMD_PLUGIN_MY_PLUGIN_TOKEN: '{"$secret":"env:CAPCOMD_RPC_KEY"}' };
    expect(pluginSettings(M, { env, source: "user", dir: "/plugins/my-plugin" }).errors).toMatchObject([{ path: "token", layer: "env" }]);
    for (const v of ["GH_TOKEN", "BOXD_API_KEY", "ANTHROPIC_API_KEY", "CAPCOMD_TOKEN_FILE"]) expect(kernelSecretRef(`env:${v}`)).toContain(v);
    expect(kernelSecretRef("env:MY_GH_TOKEN")).toBeNull();
    // The user's own variable over a kernel default: the default is never used, so the plugin runs.
    const kernelDefault = { name: "my-plugin", config: { ...SCHEMA, properties: { ...SCHEMA.properties, token: { "x-secret": true, default: { $secret: "env:GITHUB_TOKEN" } } } } };
    expect(pluginSettings(kernelDefault, { ...place({ token: { $secret: "env:MY_TOKEN" } }, undefined), source: "user", dir: "/plugins/my-plugin" }).errors).toEqual([]);
    expect(pluginSettings(kernelDefault, { ...place(undefined, undefined), source: "user", dir: "/plugins/my-plugin" }).errors).toMatchObject([{ path: "token", layer: "default" }]);
  });

  test("sandbox-boxd, the kernel's own, still resolves its default env:BOXD_API_KEY", async () => {
    const p = place(undefined, undefined);
    const c = builtinCandidates({ ...p.env, BOXD_API_KEY: "bxd_kernel" }, p.cwd).find((x) => (x.manifest as { name?: string } | undefined)?.name === "sandbox-boxd")!;
    expect(c.configErrors).toBeUndefined();
    expect(secretOrUndefined(boxdManifest, "apiKey", { BOXD_API_KEY: "bxd_kernel" })).toBe("bxd_kernel");
    // Through the daemon's host: a built-in (no directory) gets it from ctx.config.secret.
    const seen: string[] = [];
    const before = process.env.BOXD_API_KEY;
    process.env.BOXD_API_KEY = "bxd_kernel";
    try {
      const host = kernelHost({ log: false });
      await host.start([{ source: "builtin", manifest: { ...manifest, name: "sandbox-boxd", config: boxdManifest.config } as PluginManifest, module: { async activate(ctx) {
        seen.push(await ctx.config.secret("apiKey"));
        ctx.hooks.on("run.changed", () => {});
      } } }]);
      expect(seen).toEqual(["bxd_kernel"]);
      await host.stop();
    } finally {
      if (before === undefined) delete process.env.BOXD_API_KEY; else process.env.BOXD_API_KEY = before;
    }
  });

  test("the watchdog is a built-in that's off until enabled; its settings come from the layers", () => {
    const wd = (env: Record<string, string | undefined>) => builtinCandidates({ ...process.env, ...env }).find((c) => (c.manifest as { name?: string })?.name === "watchdog")!;
    expect(wd({}).enabled).toBe(false);
    const on = wd({ CAPCOMD_PLUGIN_WATCHDOG_ENABLED: "true", CAPCOMD_PLUGIN_WATCHDOG_STALLEDAFTERMS: "3000" });
    expect(on).toMatchObject({ enabled: true, config: { stalledAfterMs: 3000 } });
    expect(wd({ CAPCOMD_PLUGIN_WATCHDOG_ENABLED: "true", CAPCOMD_PLUGIN_WATCHDOG_EVERYMS: "5" }).configErrors).toEqual([{ path: "everyMs", message: "must be at least 1000", layer: "env" }]);
    // Every other built-in is on, as before.
    for (const c of builtinCandidates()) if (c.source === "builtin" && (c.manifest as { name: string }).name !== "watchdog") expect(c.enabled).toBe(true);
  });
});
