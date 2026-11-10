// Secret references fail closed (docs/spec/plugin-api.md §10.3, owner decisions 2026-11-10): an explicit reference (the
// user's config, CAPCOMD_PLUGIN_<NAME>_<KEY>) that doesn't resolve is refused, config_invalid, and nothing stands in for
// it: sandbox-boxd never falls back to BOXD_API_KEY, which may be another boxd account's key. The default reference
// (env:BOXD_API_KEY, nothing set) works as before. `keychain:` references aren't built: refused when the config is
// loaded, from any layer, with the hint to use env:<VAR>. `capcomd plugins validate`, `plugins show` and `doctor` say why.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginError } from "../../packages/plugin/src/errors";
import type { PluginManifest } from "../../packages/plugin/src/manifest";
import type { SandboxProvider as SandboxSeam } from "../../packages/plugin/src/seams";
import { conformanceCall } from "../../packages/plugin/src/conformance";
import { RelayError } from "../../src/core/errors";
import { runPreflight } from "../../src/core/preflight";
import { sandboxAvailable } from "../../src/api/run-options";
import { KEYCHAIN_HINT, pluginSettings } from "../../src/plugins/config";
import { builtinCandidates, kernelHost } from "../../src/plugins/host";
import { builtinSecret, refusedSecrets, resolveSecret, SecretRefused } from "../../src/plugins/secrets";
import { boxdApiKey, boxdKeyAvailable, manifest as boxd } from "../../src/plugins/builtin/sandbox-boxd";
import { sandboxProvider } from "../../src/plugins/sandboxes";

const ROOT = join(import.meta.dir, "..", "..");
const EXPLICIT = '{"$secret":"env:MY_BOXD_KEY"}';
type Env = Record<string, string | undefined>;

/** A home of its own, with `plugins` in the user's config when given. */
function home(plugins?: unknown): Env {
  const h = mkdtempSync(join(tmpdir(), "capcomd-secretrefs-"));
  mkdirSync(join(h, ".capcomd"), { recursive: true });
  if (plugins !== undefined) writeFileSync(join(h, ".capcomd", "config.json"), JSON.stringify({ plugins }));
  return { HOME: h, CAPCOMD_HOME: join(h, ".capcomd") };
}

/** `env`, recording every variable read from it. */
function watched(env: Env): { env: Env; read: string[] } {
  const read: string[] = [];
  return { env: new Proxy(env, { get: (t, k: string) => { read.push(k); return t[k]; } }), read };
}

describe("an explicit reference that doesn't resolve is refused, never replaced with BOXD_API_KEY", () => {
  for (const [label, base] of [
    ["CAPCOMD_PLUGIN_SANDBOX_BOXD_APIKEY", { ...home(), CAPCOMD_NO_CONFIG: "1", CAPCOMD_PLUGIN_SANDBOX_BOXD_APIKEY: EXPLICIT }],
    ["the user's config", home({ "sandbox-boxd": { apiKey: { $secret: "env:MY_BOXD_KEY" } } })],
  ] as const) test(`set in ${label}`, () => {
    const { env, read } = watched({ ...base, BOXD_API_KEY: "bxd_another_account" });
    const e = (() => { try { builtinSecret(boxd, "apiKey", env); } catch (x) { return x; } })();
    expect(e).toBeInstanceOf(SecretRefused);
    expect(e).toMatchObject({ failure: "config_invalid", ref: "env:MY_BOXD_KEY", message: expect.stringContaining("references env:MY_BOXD_KEY, and MY_BOXD_KEY is not set"), hint: expect.stringContaining("Export MY_BOXD_KEY") });
    // The kernel's provider: refused before BoxdProvider exists (given no key, it would take BOXD_API_KEY).
    const p = (() => { try { sandboxProvider("boxd", env); } catch (x) { return x; } })();
    expect(p).toBeInstanceOf(RelayError);
    expect(p).toMatchObject({ code: "config", reason: "config_invalid", message: expect.stringContaining("env:MY_BOXD_KEY") });
    expect(() => boxdApiKey(env)).toThrow("env:MY_BOXD_KEY");
    expect(read).toContain("MY_BOXD_KEY");
    expect(read).not.toContain("BOXD_API_KEY");
  });

  test("the place is unavailable with the reason and the fix; preflight never checks BOXD_API_KEY instead", async () => {
    const env = { ...home(), CAPCOMD_NO_CONFIG: "1", CAPCOMD_PLUGIN_SANDBOX_BOXD_APIKEY: EXPLICIT, BOXD_API_KEY: "bxd_another_account", CAPCOMD_SANDBOX: "boxd" };
    expect(await boxdKeyAvailable(env)).toEqual({ ok: false, reason: expect.stringContaining("env:MY_BOXD_KEY"), fix: expect.stringContaining("Export MY_BOXD_KEY") });
    expect(await sandboxAvailable("boxd", env)).toEqual({ available: false, reason: expect.stringMatching(/env:MY_BOXD_KEY.*Export MY_BOXD_KEY/) });
    const listed: Array<string | undefined> = [];
    const checks = await runPreflight(env, { boxdList: async (k) => { listed.push(k); return []; }, boxdMachine: async () => ({ credentials: true, detail: "inside", inside: true }) });
    expect(checks.find((c) => c.name === "boxd")).toEqual({ name: "boxd", ok: false, detail: expect.stringContaining("env:MY_BOXD_KEY") });
    expect(listed).toEqual([]);
    // Once it resolves, that key is the one used and checked, not BOXD_API_KEY.
    const set = { ...env, MY_BOXD_KEY: "bxd_chosen" };
    expect(boxdApiKey(set)).toEqual({ key: "bxd_chosen", ref: "env:MY_BOXD_KEY" });
    expect(await boxdKeyAvailable(set)).toEqual({ ok: true });
    await runPreflight(set, { boxdList: async (k) => { listed.push(k); return []; } });
    expect(listed).toEqual(["bxd_chosen"]);
  });

  test("a value that isn't a reference is refused too, not passed over for the default", () => {
    const { env, read } = watched({ ...home(), CAPCOMD_NO_CONFIG: "1", CAPCOMD_PLUGIN_SANDBOX_BOXD_APIKEY: "bxd_pasted_value", BOXD_API_KEY: "bxd_another_account" });
    expect(() => builtinSecret(boxd, "apiKey", env)).toThrow(expect.objectContaining({ failure: "config_invalid", code: "invalid" }));
    expect(read).not.toContain("BOXD_API_KEY");
  });

  test("in the daemon's host: the boxd seam loads, says why it's unavailable, and its calls fail config_invalid", async () => {
    const before = { ...process.env };
    process.env.CAPCOMD_PLUGIN_SANDBOX_BOXD_APIKEY = EXPLICIT;
    process.env.BOXD_API_KEY = "bxd_another_account";
    delete process.env.MY_BOXD_KEY;
    try {
      const host = kernelHost({ log: false });
      const c = builtinCandidates(process.env).find((x) => (x.manifest as { name?: string } | undefined)?.name === "sandbox-boxd")!;
      expect(c.configErrors).toBeUndefined();
      const [r] = await host.start([c]);
      expect(r).toMatchObject({ name: "sandbox-boxd", state: "active" });
      const seam = host.contributions.get("seam", "sandbox/boxd")!.value.impl as SandboxSeam;
      expect(await seam.available(conformanceCall())).toMatchObject({ ok: false, reason: expect.stringContaining("env:MY_BOXD_KEY") });
      await expect(seam.list("relay-", conformanceCall())).rejects.toMatchObject({ reason: "config_invalid", message: expect.stringContaining("env:MY_BOXD_KEY") });
      await host.stop();
    } finally {
      for (const k of ["CAPCOMD_PLUGIN_SANDBOX_BOXD_APIKEY", "BOXD_API_KEY", "MY_BOXD_KEY"]) if (before[k] === undefined) delete process.env[k]; else process.env[k] = before[k];
    }
  });
});

describe("the default reference, nothing set, works as before", () => {
  test("only BOXD_API_KEY set: that key, available", async () => {
    const env = { ...home(), CAPCOMD_NO_CONFIG: "1", BOXD_API_KEY: "bxd_default" };
    expect(builtinSecret(boxd, "apiKey", env)).toBe("bxd_default");
    expect(boxdApiKey(env)).toEqual({ key: "bxd_default", ref: null });
    expect(await boxdKeyAvailable(env)).toEqual({ ok: true });
    expect(await sandboxAvailable("boxd", env)).toEqual({ available: true, reason: null });
    expect(refusedSecrets(boxd, ["apiKey"], env, null, { builtin: true })).toEqual([]);
    const listed: Array<string | undefined> = [];
    expect((await runPreflight({ ...env, CAPCOMD_SANDBOX: "boxd" }, { boxdList: async (k) => { listed.push(k); return []; } })).find((c) => c.name === "boxd")).toEqual({ name: "boxd", ok: true, detail: "BOXD_API_KEY accepted (machines.list)" });
    expect(listed).toEqual(["bxd_default"]);
  });
  test("nothing set at all: no key, as before (the provider's own fallbacks), not a refusal", async () => {
    const env = { ...home(), CAPCOMD_NO_CONFIG: "1" };
    expect(builtinSecret(boxd, "apiKey", env)).toBeUndefined();
    expect(boxdApiKey(env)).toEqual({ key: undefined, ref: null });
    expect(await boxdKeyAvailable(env)).toEqual({ ok: false, reason: "No boxd API key", fix: expect.any(String) });
    expect(() => resolveSecret(boxd, "apiKey", env, null, { builtin: true })).toThrow(expect.objectContaining({ code: "not_found" }));
    expect((() => { try { resolveSecret(boxd, "apiKey", env, null, { builtin: true }); } catch (e) { return e; } })()).not.toBeInstanceOf(SecretRefused);
  });
});

describe("keychain: references are refused when the config is loaded, with the hint to use env:<VAR>", () => {
  const KEYCHAIN = { $secret: "keychain:boxd-work" };
  test("from the user's config, CAPCOMD_PLUGIN_*, the project's config, or a manifest's default", () => {
    const user = home({ "sandbox-boxd": { apiKey: KEYCHAIN } });
    expect(pluginSettings(boxd, { env: user, source: "builtin" }).errors).toEqual([{ path: "apiKey", layer: "user", message: expect.stringContaining(`keychain:boxd-work: ${KEYCHAIN_HINT}`) }]);
    const env = { ...home(), CAPCOMD_PLUGIN_SANDBOX_BOXD_APIKEY: JSON.stringify(KEYCHAIN) };
    expect(pluginSettings(boxd, { env, source: "builtin" }).errors).toEqual([{ path: "apiKey", layer: "env", message: expect.stringContaining("env:<VAR>") }]);
    const repo = mkdtempSync(join(tmpdir(), "capcomd-secretrefs-repo-"));
    mkdirSync(join(repo, ".capcomd"), { recursive: true });
    writeFileSync(join(repo, ".capcomd", "config.json"), JSON.stringify({ plugins: { "my-plugin": { token: KEYCHAIN } } }));
    const mine = { name: "my-plugin", config: { type: "object", additionalProperties: false, properties: { token: { type: "object", "x-secret": true } } } };
    expect(pluginSettings(mine, { env: home(), cwd: repo, source: "project", dir: "/p/my-plugin" }).errors).toEqual([{ path: "token", layer: "project", message: expect.stringContaining("env:<VAR>") }]);
    const byDefault = { name: "my-plugin", config: { type: "object", additionalProperties: false, properties: { token: { type: "object", "x-secret": true, default: KEYCHAIN } } } };
    expect(pluginSettings(byDefault, { env: home(), source: "user", dir: "/p/my-plugin" }).errors).toEqual([{ path: "token", layer: "default", message: expect.stringContaining("env:<VAR>") }]);
    expect(pluginSettings(byDefault, { env: home(), source: "builtin", dir: null }).errors).toEqual([{ path: "token", layer: "default", message: expect.stringContaining("env:<VAR>") }]);
    // A user's env: reference over that default: the default is never used, so nothing is refused.
    expect(pluginSettings(byDefault, { env: home({ "my-plugin": { token: { $secret: "env:MY_TOKEN" } } }), source: "user", dir: "/p/my-plugin" }).errors).toEqual([]);
  });

  test("the daemon fails sandbox-boxd config_invalid before it starts, saying to use env:<VAR>; a resolution anyway is refused", async () => {
    const env = home({ "sandbox-boxd": { apiKey: KEYCHAIN } });
    const c = builtinCandidates({ ...env, BOXD_API_KEY: "bxd_another_account" }).find((x) => (x.manifest as { name?: string } | undefined)?.name === "sandbox-boxd")!;
    expect(c.configErrors).toEqual([{ path: "apiKey", layer: "user", message: expect.stringContaining("env:<VAR>") }]);
    const host = kernelHost({ log: false });
    const [r] = await host.start([c]);
    expect(r).toMatchObject({ state: "failed", cause: "config_invalid" });
    expect(host.message("sandbox-boxd")).toContain("keychain:boxd-work");
    expect(host.message("sandbox-boxd")).toContain("env:<VAR>");
    await host.stop();
    const { env: w, read } = watched({ ...env, BOXD_API_KEY: "bxd_another_account" });
    expect(() => builtinSecret(boxd, "apiKey", w)).toThrow(expect.objectContaining({ failure: "config_invalid", code: "unsupported", hint: KEYCHAIN_HINT }));
    expect(read).not.toContain("BOXD_API_KEY");
    expect(() => resolveSecret(boxd, "apiKey", w, null, { builtin: true })).toThrow(PluginError);
  });
});

describe("capcomd plugins validate, plugins show and doctor say why", () => {
  const cli = (args: string[], extra: Env) => {
    const env: Env = { PATH: process.env.PATH, ...home(), CAPCOMD_NO_CONFIG: "1", BOXD_API_KEY: "bxd_another_account", ...extra };
    const p = Bun.spawnSync([process.execPath, join(ROOT, "src", "cli", "index.ts"), ...args], { env: env as Record<string, string>, stdout: "pipe", stderr: "pipe" });
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
  };
  const explicit = { CAPCOMD_PLUGIN_SANDBOX_BOXD_APIKEY: EXPLICIT };

  test("plugins validate: the refused reference is an issue of sandbox-boxd", () => {
    const r = cli(["plugins", "validate", "sandbox-boxd", "--json"], explicit);
    expect(r.code).toBe(1);
    const v = JSON.parse(r.out).plugins[0];
    expect(v).toMatchObject({ name: "sandbox-boxd", ok: false });
    expect(v.issues).toEqual([{ path: "plugins.sandbox-boxd.apiKey", message: expect.stringMatching(/config_invalid.*env:MY_BOXD_KEY.*Export MY_BOXD_KEY/) }]);
    expect(cli(["plugins", "validate", "sandbox-boxd", "--json"], {}).code).toBe(0);
  });

  test("plugins validate: a directory plugin's keychain default is an issue, with the hint", () => {
    const dir = mkdtempSync(join(tmpdir(), "capcomd-secretrefs-plugin-"));
    writeFileSync(join(dir, "plugin.json"), JSON.stringify({
      schema: "capcomd.plugin/v1", name: "kc-plugin", version: "1.0.0", description: "a keychain default", apiVersion: 1, engines: { capcomd: ">=0.0.0" },
      entry: { runtime: "process", command: ["./run.sh"] }, contributes: { hooks: { "run.changed": {} } },
      config: { type: "object", additionalProperties: false, properties: { token: { type: "object", "x-secret": true, default: { $secret: "keychain:kc-token" } } } },
    }));
    writeFileSync(join(dir, "run.sh"), "#!/bin/sh\n", { mode: 0o755 });
    const r = cli(["plugins", "validate", dir, "--json"], {});
    const v = JSON.parse(r.out).plugins[0];
    expect(v.issues).toEqual([{ path: "config.properties.token.default", message: expect.stringContaining("env:<VAR>") }]);
  });

  test("plugins show: the refused secret and its fix; a keychain reference fails the plugin, why: says so", () => {
    const r = cli(["plugins", "show", "sandbox-boxd"], explicit);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/secret apiKey refused \(config_invalid\): .*env:MY_BOXD_KEY.*Export MY_BOXD_KEY/);
    const j = JSON.parse(cli(["plugins", "show", "sandbox-boxd", "--json"], explicit).out);
    expect(j.refusedSecrets).toEqual([{ key: "apiKey", layer: "env", ref: "env:MY_BOXD_KEY", message: expect.any(String), hint: expect.any(String) }]);
    const kc = cli(["plugins", "show", "sandbox-boxd"], { CAPCOMD_PLUGIN_SANDBOX_BOXD_APIKEY: '{"$secret":"keychain:boxd-work"}' });
    expect(kc.out).toContain("failed (config_invalid)");
    expect(kc.out).toMatch(/why: .*keychain:boxd-work.*env:<VAR>/);
  });

  test("doctor: refused before any machine, with the reference and the fix", () => {
    const r = cli(["doctor"], { ...explicit, CAPCOMD_SANDBOX: "boxd" });
    expect(r.code).toBe(2);
    expect(r.err).toContain("env:MY_BOXD_KEY");
    expect(r.err).toContain("Export MY_BOXD_KEY");
  });
});
