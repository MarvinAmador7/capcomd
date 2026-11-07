// The sandbox providers as built-in plugins (docs/spec/plugin-api.md §17.2 step 3, §7.2, §10.3, §14): each loads and
// disposes cleanly (§14.1); the test fakes pass the seam conformance suite (§14.2; Docker's container semantics stay in
// tests/providers/conformance.test.ts, boxd needs an account); classifyError is where the kernel learns what a
// provider's error means (§7.2.3), so what isBoxdAuthError said before, sandboxAuthError says now; a seam with no
// kernel provider of its own (a third-party plugin's) is adapted to the kernel's shape; the boxd key is a secret
// reference; and `capcomd plugins validate [--conformance]` reports all of it.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginError } from "../../packages/plugin/src/errors";
import { loadManifest } from "../../packages/plugin/src/load";
import type { PluginManifest } from "../../packages/plugin/src/manifest";
import type { SandboxProvider as SandboxSeam } from "../../packages/plugin/src/seams";
import { testkit } from "../../packages/plugin/src/testkit";
import { conformanceCall } from "../../packages/plugin/src/conformance";
import { SANDBOX_BUILTINS } from "../../src/plugins/builtin/sandboxes";
import { BOXD_AUTH_REASON, classifyBoxdError } from "../../src/plugins/builtin/sandbox-boxd";
import { classifyDockerError } from "../../src/plugins/builtin/sandbox-docker";
import { sandboxFake, sandboxFakeHost } from "../../src/plugins/builtin/sandbox-fake";
import { kernelHost } from "../../src/plugins/host";
import { resolveSecret, secretOrUndefined } from "../../src/plugins/secrets";
import { sandboxAuthError, sandboxErrorClass, sandboxProvider, sandboxSeam } from "../../src/plugins/sandboxes";
import { isBoxdAuthError, mapBoxdError, SandboxAuthError, SandboxNotFoundError, SandboxUnavailableError } from "../../src/providers/boxd-errors";
import { FakeProvider } from "../../src/providers/fake";
import { kernelSandbox, NATIVE } from "../../src/providers/seam";

const ROOT = join(import.meta.dir, "..", "..");
const manifestOf = (b: { manifest: unknown }) => { const r = loadManifest(b.manifest); if (!r.ok) throw new Error(JSON.stringify(r.issues)); return r.manifest; };
/** A built-in's seam, activated in a fresh fake context (sandbox plugins activate synchronously). */
function seamOf(b: (typeof SANDBOX_BUILTINS)[number]): SandboxSeam {
  const fake = testkit.fakeContext(manifestOf(b));
  b.module.activate(fake.ctx as never);
  return fake.seam("sandbox")!;
}

describe("the built-in sandbox plugins load and dispose (§14.1)", () => {
  for (const b of SANDBOX_BUILTINS) test(b.manifest.name, async () => {
    const m = manifestOf(b);
    expect(m.version).toBe((await import("../../package.json")).version);
    expect(m.contributes?.seams).toEqual([{ kind: "sandbox", name: b.descriptor.name }]);
    await testkit.loadDispose(m, b.module as never);
  });
});

testkit.conformance.sandbox(() => seamOf(sandboxFake), { name: "fake", exec: false });
testkit.conformance.sandbox(() => seamOf(sandboxFakeHost), { name: "fake-host", scratch: realpathSync(tmpdir()) });

describe("classifyError replaces the kernel's knowledge of provider errors (§7.2.3)", () => {
  class AuthenticationError extends Error {}
  class NotFoundError extends Error {}
  const AUTH = [
    mapBoxdError(new AuthenticationError("invalid or expired API key"), undefined, "machines.create"),
    new Error("actor error: AuthenticationError: invalid or expired API key"),
    { grpcCode: 16, message: "x" },
    "BOXD_API_KEY was rejected by boxd (AuthenticationError: invalid or expired api key)",
    Object.assign(new Error("machines.create failed: BOXD_API_KEY was rejected by boxd"), { code: "sandbox_auth" }),
  ];
  const NOT_AUTH = [new Error("timeout"), new SandboxNotFoundError("gone"), new Error("connect ECONNREFUSED 127.0.0.1:9443"), "something else", null];

  test("sandboxAuthError says what isBoxdAuthError said, with boxd's hint as the run's reason", () => {
    for (const e of AUTH) {
      expect(isBoxdAuthError(e)).toBe(true);
      expect(sandboxAuthError(e)).toEqual({ kind: "auth", retryable: false, hint: BOXD_AUTH_REASON });
      expect(sandboxAuthError(e, "docker")?.hint).toBe(BOXD_AUTH_REASON);
    }
    for (const e of NOT_AUTH) { expect(isBoxdAuthError(e)).toBe(false); expect(sandboxAuthError(e)).toBeNull(); }
    expect(BOXD_AUTH_REASON).toStartWith("boxd rejected BOXD_API_KEY (invalid or expired). Check BOXD_API_KEY");
  });
  test("each plugin classifies its own errors; Docker never says auth", () => {
    expect(classifyBoxdError(new NotFoundError("no machine"))).toEqual({ kind: "not_found", retryable: false });
    expect(classifyBoxdError(Object.assign(new Error("Deadline exceeded after 60s"), { grpcCode: 4 }))).toMatchObject({ kind: "timeout", retryable: true });
    expect(classifyBoxdError(new PluginError("not_found", "gone"))).toEqual({ kind: "not_found", retryable: false });
    expect(classifyDockerError(new Error("Error response from daemon: No such container: relay-x"))).toEqual({ kind: "not_found", retryable: false });
    expect(classifyDockerError(new Error("Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?"))).toMatchObject({ kind: "transient", retryable: true });
    expect(classifyDockerError(new Error("permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock"))).toMatchObject({ kind: "config" });
    expect(classifyDockerError(new SandboxAuthError("rejected"))).not.toMatchObject({ kind: "auth" });
    expect(sandboxErrorClass(new SandboxUnavailableError("down"), "fake")).toEqual({ kind: "transient", retryable: true });
    expect(sandboxErrorClass(new Error("VM vm-9 not found"), "fake")).toEqual({ kind: "not_found", retryable: false });
  });
});

describe("the kernel asks the seams for its providers (§7.1)", () => {
  test("a built-in's seam hands the kernel its own provider, built for the env asked for", () => {
    const p = sandboxProvider("fake", { CAPCOMD_FAKE_ENSURE_ERROR: "auth" });
    expect(p).toBeInstanceOf(FakeProvider);
    expect((p as FakeProvider).opts).toEqual({ failEnsure: "auth" });
    expect((sandboxProvider("fake-host", {}) as FakeProvider).opts).toEqual({ hostExec: true });
    expect(() => sandboxProvider("nope")).toThrow("no active plugin provides the nope sandbox");
  });

  test("a seam without one (a third-party plugin's) is adapted: SeamCalls from timeouts, its errors as the kernel's", async () => {
    const seam = sandboxSeam("fake-host")!;
    // The plugin API's object only: what a plugin out of the kernel's reach would register.
    const plain = Object.fromEntries(Object.keys(seam).map((k) => [k, (seam as never as Record<string, unknown>)[k]])) as unknown as SandboxSeam;
    expect(NATIVE in plain).toBe(false);
    const p = kernelSandbox(plain);
    expect(p).not.toBeInstanceOf(FakeProvider);
    const { id, created } = await p.ensure({ idemKey: `relay-adapted-${process.pid}`, egressAllow: ["*"], isolated: true, ttlSeconds: 600, labels: {} });
    expect(created).toBe(true);
    await p.waitReady(id, 5000);
    expect(await p.exec(id, ["sh", "-c", "echo hi; exit 2"])).toEqual({ code: 2, stdout: "hi\n", stderr: "" });
    const t0 = Date.now();
    expect((await p.exec(id, ["sleep", "5"], { timeoutMs: 300 })).code).toBe(124);
    expect(Date.now() - t0).toBeLessThan(3000);
    await p.destroy(id);
    await expect(p.exec(id, ["true"])).rejects.toBeInstanceOf(SandboxNotFoundError);
    const gone = kernelSandbox({ ...plain, waitReady: async () => { throw new PluginError("not_found", "no such machine"); } } as SandboxSeam);
    await expect(gone.waitReady("m-1", 1000)).rejects.toBeInstanceOf(SandboxNotFoundError);
    const down = kernelSandbox({ ...plain, list: async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:1"); } } as SandboxSeam);
    await expect(down.list("relay-")).rejects.toBeInstanceOf(SandboxUnavailableError);
  });

  test("the seam's own methods honour the SeamCall: an aborted call rejects timeout at once", async () => {
    const seam = seamOf(sandboxFakeHost);
    const ac = new AbortController();
    ac.abort();
    const e = await seam.list("relay-", { ...conformanceCall(), signal: ac.signal }).catch((x) => x);
    expect(e).toBeInstanceOf(PluginError);
    expect((e as PluginError).code).toBe("timeout");
  });
});

describe("the boxd API key is a secret reference (§10.3)", () => {
  const boxd = manifestOf(SANDBOX_BUILTINS.find((b) => b.manifest.name === "sandbox-boxd")!);
  test("apiKey is declared x-secret, references BOXD_API_KEY, and never shows in the config", () => {
    // The kernel resolves its own built-in's key (`builtin`); no other plugin may name BOXD_API_KEY (§10.3).
    expect(resolveSecret(boxd, "apiKey", { BOXD_API_KEY: "bxd_test" }, null, true)).toBe("bxd_test");
    expect(() => resolveSecret(boxd, "apiKey", { BOXD_API_KEY: "bxd_test" })).toThrow("one of capcomd's own variables");
    expect(secretOrUndefined(boxd, "apiKey", {})).toBeUndefined();
    expect(() => resolveSecret(boxd, "apiKey", {}, null, true)).toThrow("is not set");
    expect(() => resolveSecret(boxd, "org", { BOXD_API_KEY: "bxd_test" })).toThrow("is not a secret the sandbox-boxd plugin declares");
    const fake = testkit.fakeContext(boxd);
    expect(fake.ctx.config.get()).toEqual({});
  });
  test("the daemon's host resolves a plugin's own secret for it, and only its own", async () => {
    const seen: string[] = [];
    const manifest = {
      schema: "capcomd.plugin/v1", name: "secret-reader", version: "1.0.0", description: "reads its secret", apiVersion: 1, engines: { capcomd: ">=0.0.0" },
      entry: { runtime: "in-process", module: "./index.ts" }, contributes: { hooks: { "run.changed": {} } },
      config: { type: "object", additionalProperties: false, properties: { token: { type: "object", "x-secret": true, default: { $secret: "env:CAPCOMD_TEST_PLUGIN_TOKEN" } } } },
    } as unknown as PluginManifest;
    process.env.CAPCOMD_TEST_PLUGIN_TOKEN = "tok-123";
    try {
      const host = kernelHost();
      await host.start([{ source: "builtin", manifest, module: { async activate(ctx) {
        seen.push(await ctx.config.secret("token"));
        seen.push(await ctx.config.secret("apiKey").catch((e: PluginError) => e.code));
        seen.push(JSON.stringify(ctx.config.get()));
        ctx.hooks.on("run.changed", () => {});
      } } }]);
      expect(host.get("secret-reader")?.state).toBe("active");
      expect(seen).toEqual(["tok-123", "forbidden", "{}"]);
      await host.stop();
    } finally { delete process.env.CAPCOMD_TEST_PLUGIN_TOKEN; }
  });
});

describe("capcomd plugins validate (§4.9, §14)", () => {
  const home = mkdtempSync(join(tmpdir(), "capcomd-plugins-validate-"));
  const cli = (...args: string[]) => {
    const p = Bun.spawnSync([process.execPath, join(ROOT, "src", "cli", "index.ts"), "plugins", "validate", ...args], { env: { ...process.env, CAPCOMD_HOME: home, CAPCOMD_NO_CONFIG: "1" }, stdout: "pipe", stderr: "pipe" });
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
  };
  test("every built-in's manifest is valid", () => {
    const r = cli("--json");
    expect(r.code).toBe(0);
    const body = JSON.parse(r.out);
    expect(body.ok).toBe(true);
    expect(body.plugins.filter((p: { name: string }) => p.name.startsWith("sandbox-")).map((p: { name: string; ok: boolean; source: string }) => [p.name, p.ok, p.source]))
      .toEqual([["sandbox-docker", true, "builtin"], ["sandbox-boxd", true, "builtin"], ["sandbox-fake", true, "builtin"], ["sandbox-fake-host", true, "builtin"]]);
    expect(cli().out).toMatch(/✓ sandbox-boxd \S+ \(built-in\)/);
  });
  test("--conformance on a built-in runs the load/dispose check and the seam suite", () => {
    const r = cli("sandbox-fake", "--conformance", "--json");
    expect(r.code).toBe(0);
    const [p] = JSON.parse(r.out).plugins;
    expect(p.conformance[0]).toMatchObject({ name: "load, dispose and load again (§14.1)", ok: true });
    expect(p.conformance.filter((c: { skipped: boolean }) => !c.skipped).length).toBeGreaterThan(5);
    expect(p.conformance.every((c: { ok: boolean }) => c.ok)).toBe(true);
    expect(p.conformance.filter((c: { skipped: boolean }) => c.skipped).map((c: { name: string }) => c.name)).toEqual([expect.stringContaining("exec:"), expect.stringContaining("deadline")]);
  }, 60_000);
  test("a plugin directory: its module imported, the full suite run against its seam; a bad manifest and an unknown name refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "capcomd-plugin-dir-"));
    writeFileSync(join(dir, "plugin.json"), JSON.stringify({
      schema: "capcomd.plugin/v1", name: "host-sandbox", version: "1.0.0", description: "The fake-host sandbox, from a directory", apiVersion: 1,
      engines: { capcomd: ">=0.0.0" }, entry: { runtime: "in-process", module: "./index.ts" }, provides: ["seam:sandbox/fake-host"],
      contributes: { seams: [{ kind: "sandbox", name: "fake-host" }] },
    }));
    writeFileSync(join(dir, "index.ts"), `import { sandboxFakeHost } from ${JSON.stringify(join(ROOT, "src", "plugins", "builtin", "sandbox-fake.ts"))};\nexport const plugin = sandboxFakeHost.module;\n`);
    const r = cli(dir, "--conformance");
    expect(r.code).toBe(0);
    expect(r.out).toContain(`✓ host-sandbox 1.0.0 (${dir})`);
    expect(r.out).toContain("✓ a deadline or an abort during exec rejects timeout within 5 s");
    const bad = join(dir, "bad");
    mkdirSync(bad);
    writeFileSync(join(bad, "plugin.json"), JSON.stringify({ schema: "capcomd.plugin/v1", name: "Bad!", version: "1", description: "", apiVersion: 1, engines: { capcomd: "*" }, entry: { runtime: "in-process", module: "./x.ts" } }));
    const b = cli(bad, "--json");
    expect(b.code).toBe(1);
    expect(JSON.parse(b.out)).toMatchObject({ ok: false, plugins: [{ ok: false, source: "dir", issues: expect.arrayContaining([expect.objectContaining({ path: "name" })]) }] });
    expect(cli("no-such-plugin").code).toBe(3);
  }, 60_000);
  test("a plugin directory whose default secret names one of the kernel's own variables is refused (§10.3)", () => {
    const dir = mkdtempSync(join(tmpdir(), "capcomd-plugin-dir-"));
    const write = (ref: string) => writeFileSync(join(dir, "plugin.json"), JSON.stringify({
      schema: "capcomd.plugin/v1", name: "gh-notify", version: "1.0.0", description: "Posts to GitHub", apiVersion: 1,
      engines: { capcomd: ">=0.0.0" }, entry: { runtime: "process", command: ["./run.sh"] }, contributes: { hooks: { "run.changed": {} } },
      config: { type: "object", additionalProperties: false, properties: { token: { type: "object", "x-secret": true, default: { $secret: ref } } } },
    }));
    writeFileSync(join(dir, "run.sh"), "#!/bin/sh\n", { mode: 0o755 });
    write("env:GITHUB_TOKEN");
    const r = cli(dir);
    expect(r.code).toBe(1);
    expect(r.out).toContain("✗ config.properties.token.default: names env:GITHUB_TOKEN, one of capcomd's own variables");
    write("env:GH_NOTIFY_TOKEN");
    expect(cli(dir).code).toBe(0);
  });
});
