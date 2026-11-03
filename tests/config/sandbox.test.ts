// Which sandbox a project's runs use (src/config/sandbox.ts), and whether a Docker project's env image has its warm
// checkout (src/env/warm.ts).
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { configuredSandbox, describeSandbox } from "../../src/config/sandbox";
import { APPLIED_TO_PROCESS } from "../../src/config/store";
import { sameRepo, warmTemplateStatus } from "../../src/env/warm";
import type { EnvRecord } from "../../src/env/resolve";

function place(o: { user?: string; project?: string } = {}) {
  const home = mkdtempSync(join(tmpdir(), "capcomd-sbx-home-"));
  const proj = mkdtempSync(join(tmpdir(), "capcomd-sbx-proj-"));
  mkdirSync(join(home, ".capcomd"), { recursive: true });
  if (o.user) writeFileSync(join(home, ".capcomd", "config.json"), JSON.stringify({ env: { CAPCOMD_SANDBOX: o.user } }));
  mkdirSync(join(proj, ".capcomd"));
  writeFileSync(join(proj, ".capcomd", "config.json"), JSON.stringify(o.project ? { env: { CAPCOMD_SANDBOX: o.project } } : {}));
  return { proj, env: { HOME: home, CAPCOMD_HOME: join(home, ".capcomd") } as Record<string, string | undefined> };
}

describe("configuredSandbox", () => {
  test("the project's over the user config's; the user's outside a project; none: the engine's", () => {
    const a = place({ user: "boxd", project: "docker" });
    expect(configuredSandbox(a.proj, a.env)).toEqual({ name: "docker", source: "project", path: join(a.proj, ".capcomd", "config.json") });
    expect(configuredSandbox(tmpdir(), a.env)).toMatchObject({ name: "boxd", source: "user" });
    const b = place({ project: undefined });
    expect(configuredSandbox(b.proj, b.env)).toEqual({ name: null, source: "engine", path: null });
    expect(describeSandbox(configuredSandbox(a.proj, a.env))).toBe(`docker (project: ${join(a.proj, ".capcomd", "config.json")})`);
  });

  test("a real CAPCOMD_SANDBOX wins; one a config file filled into this process's environment doesn't", () => {
    const a = place({ user: "boxd", project: "docker" });
    expect(configuredSandbox(a.proj, { ...a.env, CAPCOMD_SANDBOX: "fake-host" })).toMatchObject({ name: "fake-host", source: "environment" });
    const saved = process.env.CAPCOMD_SANDBOX;
    const savedNo = process.env.CAPCOMD_NO_CONFIG;
    const savedHome = { HOME: process.env.HOME, CAPCOMD_HOME: process.env.CAPCOMD_HOME };
    try {
      // As applyConfig leaves it at startup in a folder where the user config's boxd applied.
      process.env.CAPCOMD_SANDBOX = "boxd";
      APPLIED_TO_PROCESS.set("CAPCOMD_SANDBOX", "boxd");
      delete process.env.CAPCOMD_NO_CONFIG;
      Object.assign(process.env, a.env);
      expect(configuredSandbox(a.proj)).toMatchObject({ name: "docker", source: "project" });
      APPLIED_TO_PROCESS.delete("CAPCOMD_SANDBOX");
      expect(configuredSandbox(a.proj)).toMatchObject({ name: "boxd", source: "environment" });
    } finally {
      APPLIED_TO_PROCESS.delete("CAPCOMD_SANDBOX");
      if (saved === undefined) delete process.env.CAPCOMD_SANDBOX; else process.env.CAPCOMD_SANDBOX = saved;
      if (savedNo !== undefined) process.env.CAPCOMD_NO_CONFIG = savedNo;
      for (const [k, v] of Object.entries(savedHome)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  test("CAPCOMD_NO_CONFIG skips the files; a name capcomd doesn't know is said as such", () => {
    const a = place({ project: "docker" });
    expect(configuredSandbox(a.proj, { ...a.env, CAPCOMD_NO_CONFIG: "1" })).toMatchObject({ name: null, source: "engine" });
    const b = place({ project: "kubernetes" });
    expect(configuredSandbox(b.proj, b.env)).toMatchObject({ name: null, source: "project", invalid: "kubernetes" });
  });
});

describe("warmTemplateStatus", () => {
  const env = { CAPCOMD_REPO: "https://github.com/acme/calc.git", CAPCOMD_MERGE_TARGET: "dev" };
  const rec = (o: { repo?: string; template?: boolean } = {}): EnvRecord => ({
    name: "capcomd-env-abc", builtAt: "2026-10-24T00:00:00Z", buildMs: 1000, depsInstalled: true, versions: {},
    manifest: { schema: 1, pins: { claude: "1", codex: "1", node: "22" }, lockHash: "x", lockFile: "bun.lock", repo: o.repo ?? "https://github.com/acme/calc.git", ...(o.template === false ? {} : { template: { commit: "a".repeat(40), target: "dev" } }) },
  });
  const drift = (state: "current" | "behind" | "lockfile" | "diverged") => async () => ({ state, behind: 0, lockChanged: false, message: `drift ${state}` });

  test("no image, no template, another repository's: the build is the step", async () => {
    expect(await warmTemplateStatus(env, { current: null })).toMatchObject({ state: "no-image", ok: false, command: "capcomd env build --sandbox docker" });
    expect(await warmTemplateStatus(env, { current: rec({ template: false }) })).toMatchObject({ state: "no-template", ok: false, command: "capcomd env build --sandbox docker" });
    expect(await warmTemplateStatus(env, { current: rec({ repo: "https://github.com/acme/other.git" }) })).toMatchObject({ state: "other-repo", ok: false, detail: expect.stringContaining("acme/other") });
    expect(await warmTemplateStatus({}, { current: rec() })).toMatchObject({ state: "no-repo", command: null });
  });

  test("its drift from the target: current needs nothing, a lockfile change or a rewrite needs the build", async () => {
    expect(await warmTemplateStatus(env, { current: rec({ repo: "git@github.com:acme/calc.git" }), drift: drift("current") })).toMatchObject({ state: "current", ok: true, command: null });
    expect(await warmTemplateStatus(env, { current: rec(), drift: drift("behind") })).toMatchObject({ state: "behind", ok: true, command: "capcomd env build --sandbox docker" });
    expect(await warmTemplateStatus(env, { current: rec(), drift: drift("lockfile") })).toMatchObject({ state: "lockfile", ok: false });
    expect(await warmTemplateStatus(env, { current: rec(), drift: drift("diverged") })).toMatchObject({ state: "diverged", ok: false });
  });

  test("the same repository in its https, ssh and token forms", () => {
    expect(sameRepo("https://github.com/Acme/Calc.git", "git@github.com:acme/calc.git")).toBe(true);
    expect(sameRepo("https://x-access-token:t@github.com/acme/calc", "https://github.com/acme/calc.git")).toBe(true);
    expect(sameRepo("https://github.com/acme/calc.git", "https://github.com/acme/calc2.git")).toBe(false);
  });
});
