// Plugin API §10: a plugin's config is its schema's defaults, then the user's config, the project's and the
// environment (layers 1-4, merge-patch, later winning), checked against the schema after each layer (an invalid one is
// named: config_invalid with plugin.config_refused, never run with defaults); secrets are references, never a project's;
// a run may set only x-per-run settings (layer 5), kept in the plugin's run storage under `config`.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { layerConfig, mergePatch, runConfigIssues } from "../../packages/plugin/src/config";
import { PluginHost, type Candidate } from "../../packages/plugin/src/host/host";
import type { HostEvent } from "../../packages/plugin/src/host/registry";
import { definePlugin } from "../../packages/plugin/src/context";
import type { PluginManifest } from "../../packages/plugin/src/manifest";
import { configured } from "../../src/plugins/host";
import { resolveSecret } from "../../src/plugins/secrets";
import { checkRunPluginConfig, parsePluginConfigFlags, pluginConfigFlags, RunConfigError } from "../../src/plugins/run-config";
import { pluginStore } from "../../src/plugins/storage";
import { addClient, loadClients } from "../../src/api/clients";
import { harnessApp } from "../../src/api/server";
import { memorySource } from "../../src/api/source";
import { harnessState } from "../../src/api/state";

const SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    channel: { type: "string", default: "#general", "x-per-run": true },
    quiet: { type: "boolean", default: false, "x-per-run": true },
    limits: { type: "object", additionalProperties: false, default: { perHour: 10 }, properties: { perHour: { type: "integer", minimum: 1 }, burst: { type: "integer" } } },
    tags: { type: "array", items: { type: "string" }, default: ["a"] },
    webhook: { type: "object", "x-secret": true, default: { $secret: "env:SLACK_WEBHOOK" } },
  },
};
const M = {
  schema: "capcomd.plugin/v1", name: "notify", version: "1.0.0", description: "a notifier", apiVersion: 1, engines: { capcomd: ">=0.0.0" },
  entry: { runtime: "in-process", module: "./index.ts" }, contributes: { events: ["sent"] }, config: SCHEMA,
} as unknown as PluginManifest;

describe("layers 1-4 (§10.2)", () => {
  test("defaults, then user, project and env, key by key with merge-patch; sources say where each value came from", () => {
    const r = layerConfig(M, null, [
      { layer: "user", values: { channel: "#ops", limits: { burst: 3 } } },
      { layer: "project", values: { tags: ["x", "y"], limits: { perHour: 5 } } },
      { layer: "env", values: { quiet: true, tags: null } },
    ]);
    expect(r).toEqual({ ok: true, values: { channel: "#ops", quiet: true, limits: { perHour: 5, burst: 3 } }, sources: { channel: "user", quiet: "env", limits: "project" } });
    expect(mergePatch({ a: { b: 1, c: [1] } }, { a: { c: [2], d: null } })).toEqual({ a: { b: 1, c: [2] } });
  });

  test("an invalid layer is named; a secret takes a reference, and never a project's", () => {
    expect(layerConfig(M, null, [{ layer: "user", values: { channel: "#ok" } }, { layer: "project", values: { limits: { perHour: 0 } } }]))
      .toEqual({ ok: false, layer: "project", errors: [{ path: "limits.perHour", message: expect.stringContaining(">=1") }] });
    expect(layerConfig(M, null, [{ layer: "env", values: { nope: 1 } }])).toMatchObject({ ok: false, layer: "env", errors: [{ path: "(root)", message: expect.stringContaining("nope") }] });
    expect(layerConfig(M, null, [{ layer: "user", values: { webhook: "https://hooks.slack.com/T0/B0/xyz" } }])).toMatchObject({ ok: false, layer: "user", errors: [{ path: "webhook", message: expect.stringContaining("never the value") }] });
    expect(layerConfig(M, null, [{ layer: "project", values: { webhook: { $secret: "env:GITHUB_TOKEN" } } }])).toMatchObject({ ok: false, layer: "project", errors: [{ path: "webhook", message: expect.stringContaining("only your own config") }] });
    // A user's reference is fine, and never among the values.
    const ok = layerConfig(M, null, [{ layer: "user", values: { webhook: { $secret: "env:MY_HOOK" } } }]);
    expect(ok).toMatchObject({ ok: true });
    expect(ok.ok && "webhook" in ok.values).toBe(false);
  });

  test("the kernel reads the user's and the project's config files and the environment; enabled is the user's (a project may turn off only its own)", () => {
    const home = mkdtempSync(join(tmpdir(), "capcomd-layers-home-"));
    const proj = realpathSync(mkdtempSync(join(tmpdir(), "capcomd-layers-proj-")));
    mkdirSync(join(proj, ".capcomd"));
    writeFileSync(join(home, "config.json"), JSON.stringify({ plugins: { notify: { channel: "#ops", webhook: { $secret: "env:MY_HOOK" } } } }));
    writeFileSync(join(proj, ".capcomd", "config.json"), JSON.stringify({ plugins: { notify: { enabled: false, quiet: true } } }));
    const env = { CAPCOMD_HOME: home, HOME: home, CAPCOMD_PLUGIN_NOTIFY_TAGS: '["e"]', CAPCOMD_PLUGIN_NOTIFY_CHANNEL: "#env" };
    const c: Candidate = { source: "builtin", manifest: M };
    const got = configured(c, env, proj);
    expect(got.layers).toEqual([
      { layer: "user", values: { channel: "#ops", webhook: { $secret: "env:MY_HOOK" } } },
      { layer: "project", values: { quiet: true } },
      { layer: "env", values: { channel: "#env", tags: ["e"] } },
    ]);
    // The project's `enabled: false` turns off a project's own plugin only.
    expect(got.enabled).toBeUndefined();
    expect(configured({ source: "project", dir: "/nowhere", manifest: M }, env, proj).enabled).toBe(false);
    writeFileSync(join(home, "config.json"), JSON.stringify({ plugins: { notify: { enabled: true } } }));
    expect(configured({ source: "project", dir: "/nowhere", manifest: M }, env, proj).enabled).toBe(true);
    expect(configured(c, { ...env, CAPCOMD_NO_CONFIG: "1" }, proj).layers).toEqual([{ layer: "env", values: { channel: "#env", tags: ["e"] } }]);
  });

  test("a secret's reference: the user's, else CAPCOMD_PLUGIN_<NAME>_<KEY>, else the schema's default; a project's is never read", () => {
    const home = mkdtempSync(join(tmpdir(), "capcomd-secret-home-"));
    const env: Record<string, string> = { CAPCOMD_HOME: home, SLACK_WEBHOOK: "default-value", MY_HOOK: "user-value", ENV_HOOK: "env-value" };
    expect(resolveSecret(M, "webhook", env)).toBe("default-value");
    expect(resolveSecret(M, "webhook", { ...env, CAPCOMD_PLUGIN_NOTIFY_WEBHOOK: '{"$secret":"env:ENV_HOOK"}' })).toBe("env-value");
    writeFileSync(join(home, "config.json"), JSON.stringify({ plugins: { notify: { webhook: { $secret: "env:MY_HOOK" } } } }));
    expect(resolveSecret(M, "webhook", { ...env, CAPCOMD_PLUGIN_NOTIFY_WEBHOOK: '{"$secret":"env:ENV_HOOK"}' })).toBe("user-value");
    expect(resolveSecret(M, "webhook", { ...env, CAPCOMD_NO_CONFIG: "1" })).toBe("default-value");
    expect(() => resolveSecret(M, "channel", env)).toThrow(/not a secret/);
  });

  test("the host: config_invalid with plugin.config_refused naming the layer; GET /v1/plugins/{name} has the values and their sources", async () => {
    const events: HostEvent[] = [];
    let seen: unknown = null;
    const module = definePlugin({ activate(ctx) { seen = ctx.config.get(); ctx.onDispose(() => {}); } }) as Candidate["module"];
    const h = new PluginHost({ capcomd: "0.9.0", kernel: [], emit: (e) => events.push(e), dataDir: (n) => join(tmpdir(), n) });
    await h.start([
      { source: "builtin", manifest: M, module, layers: [{ layer: "user", values: { channel: "#ops" } }, { layer: "env", values: { quiet: true } }] },
      { source: "builtin", manifest: { ...M, name: "notify-bad" }, module, layers: [{ layer: "project", values: { limits: { perHour: "lots" } } }] },
    ]);
    expect(h.get("notify")).toMatchObject({ state: "active" });
    expect(seen).toEqual({ channel: "#ops", quiet: true, limits: { perHour: 10 }, tags: ["a"] });
    expect(h.detail("notify")!.config).toEqual({ values: { channel: "#ops", quiet: true, limits: { perHour: 10 }, tags: ["a"] }, sources: { channel: "user", quiet: "env", limits: "default", tags: "default" } });
    expect(h.get("notify-bad")).toMatchObject({ state: "failed", cause: "config_invalid" });
    expect(events.find((e) => e.type === "plugin.config_refused")).toMatchObject({ stream: "daemon", entity: "plugin:notify-bad", data: { plugin: "notify-bad", layer: "project", errors: [{ path: "limits.perHour" }] } });
  });
});

describe("layer 5: a run's plugin config (§10.2)", () => {
  test("only x-per-run settings, each valid against its schema", () => {
    expect(runConfigIssues(M, null, { channel: "#run", quiet: null })).toEqual([]);
    expect(runConfigIssues(M, null, { limits: { perHour: 1 } })).toEqual([{ path: "limits", message: expect.stringContaining("can't be set per run (the notify plugin's per-run settings: channel, quiet)") }]);
    expect(runConfigIssues(M, null, { quiet: "yes" })).toEqual([{ path: "quiet", message: expect.any(String) }]);
    expect(runConfigIssues(M, null, { webhook: { $secret: "env:X" } })[0]!.path).toBe("webhook");
  });

  test("--plugin-config flags parse to the body's shape and back", () => {
    const cfg = parsePluginConfigFlags(["notify.channel=#ops", "notify.quiet=true", "other.a.b=[1,2]"]);
    expect(cfg).toEqual({ notify: { channel: "#ops", quiet: true }, other: { a: { b: [1, 2] } } });
    expect(parsePluginConfigFlags(pluginConfigFlags(cfg).map((f) => f.slice("--plugin-config=".length)))).toEqual(cfg);
    for (const bad of ["notify", "notify.=x", ".x=1", "notify.channel"]) expect(() => parsePluginConfigFlags([bad])).toThrow(/not <plugin>\.<key>=<value>/);
  });

  test("checked against the plugins the daemon would load: unknown plugins and other settings are refused with their field", async () => {
    const dir = join(process.env.CAPCOMD_HOME!, "plugins", "notify");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "plugin.json"), JSON.stringify({ ...M, entry: { runtime: "process", command: ["./run.sh"] }, contributes: { hooks: { "run.changed": {} } } }));
    writeFileSync(join(dir, "run.sh"), "#!/bin/sh\n");
    expect(await checkRunPluginConfig({ notify: { channel: "#run" } })).toEqual({ notify: { channel: "#run" } });
    const field = async (cfg: unknown) => { try { await checkRunPluginConfig(cfg); return null; } catch (e) { expect(e).toBeInstanceOf(RunConfigError); return (e as RunConfigError).field; } };
    expect(await field({ ghost: { a: 1 } })).toBe("plugins.ghost");
    expect(await field({ notify: { tags: ["x"] } })).toBe("plugins.notify.tags");
    expect(await field({ notify: { quiet: 3 } })).toBe("plugins.notify.quiet");
    expect(await field([])).toBe("plugins");
    // A built-in without per-run settings refuses any.
    expect(await field({ "forge-github": { pollMs: 50 } })).toBe("plugins.forge-github.pollMs");
  });

  test("the run's `config` in a plugin's run storage is the kernel's: the plugin can't write or delete it", async () => {
    const store = pluginStore("notify", mkdtempSync(join(tmpdir(), "capcomd-store-")));
    await expect(store.put({ runId: "run-x" }, "config", { channel: "#mine" })).rejects.toThrow(/written by capcomd/);
    await expect(store.delete({ runId: "run-x" }, "config")).rejects.toThrow(/written by capcomd/);
    // Its own daemon-scope `config` is its own.
    expect((await store.put("daemon", "config", { a: 1 })).value).toEqual({ a: 1 });
  });

  test("POST /v1/runs takes `plugins`: a setting that can't be set per run is 422 with its field; a good one reaches the run", async () => {
    const cpath = join(mkdtempSync(join(tmpdir(), "capcomd-cr-")), "clients.json");
    const token = addClient("app", ["read", "steer"], cpath).token;
    const src = memorySource();
    const app = harnessApp({ source: src, clients: () => loadClients(cpath), state: harnessState(null) });
    const post = (body: unknown, key: string) => app.request("/v1/runs", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify(body) });
    const bad = await post({ goal: "ship it", plugins: { "forge-github": { pollMs: 50 } } }, "key-plugins-1");
    expect(bad.status).toBe(422);
    expect(await bad.json()).toMatchObject({ code: "invalid", field: "plugins.forge-github.pollMs" });
    expect(src.created).toEqual([]);
    const dir = join(process.env.CAPCOMD_HOME!, "plugins", "notify");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "plugin.json"), JSON.stringify({ ...M, entry: { runtime: "process", command: ["./run.sh"] }, contributes: { hooks: { "run.changed": {} } } }));
    writeFileSync(join(dir, "run.sh"), "#!/bin/sh\n");
    const ok = await post({ goal: "ship it", plugins: { notify: { channel: "#run" } } }, "key-plugins-2");
    expect(ok.status).toBe(201);
    expect(src.created).toEqual([{ goal: "ship it", plugins: { notify: { channel: "#run" } } }]);
    expect((await post({ goal: "ship it", plugins: { notify: { channel: "#other" } } }, "key-plugins-2")).status).toBe(409);
  });
});
