import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "fs";
import { tmpdir, userInfo } from "os";
import { join } from "path";
import { applyConfig, projectConfigPath, readConfig, runDefaults, userConfigPath, writeConfig } from "../../src/config/store";
import { keychainGet, keychainKind, keychainSet, type Runner } from "../../src/config/keychain";

const tmp = () => mkdtempSync(join(tmpdir(), "capcomd-cfg-"));

describe("persisted config", () => {
  test("env defaults: real env wins, then the project, then the user; the keychain fills BOXD_API_KEY", () => {
    const home = tmp(), proj = tmp();
    const env: Record<string, string | undefined> = { CAPCOMD_HOME: home, CAPCOMD_MERGE_MODE: "direct" };
    writeConfig(userConfigPath(env), { env: { CAPCOMD_SANDBOX: "boxd", CAPCOMD_MERGE_TARGET: "main", CAPCOMD_MERGE_MODE: "pr" }, boxdKey: "keychain" });
    writeConfig(join(proj, ".capcomd", "config.json"), { env: { CAPCOMD_REPO: "https://github.com/o/r.git", CAPCOMD_MERGE_TARGET: "staging" } });
    const sub = join(proj, "src", "deep"); mkdirSync(sub, { recursive: true });
    const a = applyConfig(env, sub, () => "bxd_from_keychain");
    expect(env).toMatchObject({ CAPCOMD_SANDBOX: "boxd", CAPCOMD_REPO: "https://github.com/o/r.git", CAPCOMD_MERGE_TARGET: "staging", CAPCOMD_MERGE_MODE: "direct", BOXD_API_KEY: "bxd_from_keychain" });
    expect(a).toMatchObject({ project: join(proj, ".capcomd", "config.json"), boxdKeyFrom: "keychain" });
    expect(a.keys.sort()).toEqual(["CAPCOMD_MERGE_TARGET", "CAPCOMD_REPO", "CAPCOMD_SANDBOX"]);
    const own = { CAPCOMD_HOME: home, BOXD_API_KEY: "bxd_mine" } as Record<string, string | undefined>;
    expect(applyConfig(own, sub, () => "bxd_from_keychain").boxdKeyFrom).toBe("env"); // a real env var wins
    expect(own.BOXD_API_KEY).toBe("bxd_mine");
  });

  test("writeConfig merges env and run maps, files are private (0600); a broken file reads as empty", () => {
    const home = tmp();
    const p = join(home, "config.json");
    writeConfig(p, { env: { A: "1" }, run: { checks: { unit: "bun test" } } });
    writeConfig(p, { env: { B: "2" }, run: { reviewer: "reviewer" } });
    expect(readConfig(p)).toEqual({ env: { A: "1", B: "2" }, run: { checks: { unit: "bun test" }, reviewer: "reviewer" } });
    expect(statSync(p).mode & 0o777).toBe(0o600);
    writeFileSync(p, "{not json");
    expect(readConfig(p)).toEqual({});
  });

  test("project config is found from below; run defaults come from it", () => {
    const proj = tmp();
    writeConfig(join(proj, ".capcomd", "config.json"), { run: { checks: { unit: "bun test" }, target: "capcomd/staging" } });
    const deep = join(proj, "a", "b"); mkdirSync(deep, { recursive: true });
    expect(projectConfigPath(deep)).toBe(join(proj, ".capcomd", "config.json"));
    expect(runDefaults(deep)).toEqual({ checks: { unit: "bun test" }, target: "capcomd/staging" });
    expect(projectConfigPath(tmp())).toBeNull();
  });

  test("the search stops at HOME and at the account's home, and capcomd's user config is never a project's", () => {
    // Above HOME: not looked at.
    const t = tmp(), home = join(t, "home"), proj = join(home, "code", "app");
    mkdirSync(proj, { recursive: true });
    writeConfig(join(t, ".capcomd", "config.json"), { env: { CAPCOMD_SANDBOX: "boxd" } });
    expect(projectConfigPath(proj, { HOME: home, CAPCOMD_HOME: join(t, "ch") })).toBeNull();
    // capcomd's user config (CAPCOMD_HOME's) sits where a project's would: still not a project.
    const u = tmp(), sub = join(u, "src"); mkdirSync(sub);
    writeConfig(join(u, ".capcomd", "config.json"), { env: { CAPCOMD_SANDBOX: "boxd" } });
    expect(projectConfigPath(sub, { HOME: tmp(), CAPCOMD_HOME: join(u, ".capcomd") })).toBeNull();
    // A scratch HOME (tests, agents) never lets the walk reach the account's real ~/.capcomd/config.json.
    expect(projectConfigPath(userInfo().homedir, { HOME: tmp(), CAPCOMD_HOME: tmp() })).toBeNull();
  });
});

describe("keychain", () => {
  test("macOS: the value goes on stdin to `security -i`, never into argv; lookups read it back", () => {
    const calls: Array<{ cmd: string; args: string[]; input?: string }> = [];
    let stored = "";
    const r: Runner = (cmd, args, input) => {
      calls.push({ cmd, args, input });
      if (cmd === "sh") return { code: 0, stdout: "/usr/bin/security" };
      if (cmd === "security" && args[0] === "-i") { stored = /-w "(.*)"\n$/.exec(input ?? "")![1]!; return { code: 0, stdout: "" }; }
      if (cmd === "security" && args[0] === "find-generic-password") return { code: 0, stdout: stored + "\n" };
      return { code: 1, stdout: "" };
    };
    expect(keychainKind(r, "darwin")).toBe("macos");
    keychainSet("bxd_secret_value", r, "macos");
    expect(keychainGet(r, "macos")).toBe("bxd_secret_value");
    expect(calls.every((c) => !c.args.join(" ").includes("bxd_secret_value"))).toBe(true);
    expect(calls.find((c) => c.args[0] === "-i")!.input).toContain('-w "bxd_secret_value"');
  });
  test("Linux: secret-tool with the value on stdin; no keychain → none", () => {
    let stored = "";
    const r: Runner = (cmd, args, input) => cmd === "sh" ? { code: 0, stdout: "x" } : args[0] === "store" ? ((stored = input ?? ""), { code: 0, stdout: "" }) : { code: 0, stdout: stored };
    keychainSet("bxd_linux", r, "secret-service");
    expect(keychainGet(r, "secret-service")).toBe("bxd_linux");
    expect(keychainKind((() => ({ code: 1, stdout: "" })) as Runner, "linux")).toBeNull();
    expect(keychainGet(r, null)).toBeNull();
  });
});
