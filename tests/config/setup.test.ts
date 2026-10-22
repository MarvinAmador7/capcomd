// capcomd setup: the parts that need no network (project, agent integration, check), driven non-interactively.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { githubRepoOf, httpsRemote, suggestCheck } from "../../src/cli/commands/setup";

const CLI = new URL("../../src/cli/index.ts", import.meta.url).pathname;
const run = (args: string[], o: { cwd: string; env: Record<string, string> }) => {
  const p = Bun.spawnSync([process.execPath, CLI, ...args], { cwd: o.cwd, env: { ...process.env, ...o.env }, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
};
const json = (s: string) => JSON.parse(s.trim().split("\n").pop()!);

describe("setup helpers", () => {
  test("ssh remotes become https; GitHub owner/repo; a check from package.json", () => {
    expect(httpsRemote("git@github.com:acme/app.git")).toBe("https://github.com/acme/app.git");
    expect(httpsRemote("ssh://git@github.com/acme/app")).toBe("https://github.com/acme/app.git");
    expect(httpsRemote("https://gitlab.com/x/y.git")).toBe("https://gitlab.com/x/y.git");
    expect(githubRepoOf("https://github.com/acme/app.git")).toBe("acme/app");
    expect(githubRepoOf("https://gitlab.com/x/y.git")).toBeNull();
    const d = mkdtempSync(join(tmpdir(), "capcomd-sugg-"));
    expect(suggestCheck(d)).toBeNull();
    writeFileSync(join(d, "package.json"), JSON.stringify({ scripts: { test: "vitest" } }));
    expect(suggestCheck(d)).toBe("npm test");
    writeFileSync(join(d, "bun.lock"), "");
    expect(suggestCheck(d)).toBe("bun run test");
  });
});

describe("setup steps (non-interactive)", () => {
  const home = mkdtempSync(join(tmpdir(), "capcomd-setup-home-"));
  const repo = mkdtempSync(join(tmpdir(), "capcomd-setup-repo-"));
  const env = { HOME: home, CAPCOMD_HOME: join(home, ".capcomd") };
  Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: repo });
  Bun.spawnSync(["git", "remote", "add", "origin", "git@github.com:acme/app.git"], { cwd: repo });
  writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
  writeFileSync(join(repo, "bun.lock"), "");
  mkdirSync(join(repo, "src"));

  test("project: detects the repo, writes the project config and worker/reviewer/planner profiles", () => {
    const r = run(["setup", "project", "--yes", "--agents", "claude,codex", "--mode", "direct", "--target", "capcomd/staging", "--json"], { cwd: join(repo, "src"), env });
    expect(r.code).toBe(0);
    const cfg = JSON.parse(readFileSync(join(repo, ".capcomd", "config.json"), "utf8"));
    expect(cfg).toEqual({
      env: { CAPCOMD_REPO: "https://github.com/acme/app.git", CAPCOMD_MERGE_MODE: "direct", CAPCOMD_MERGE_TARGET: "capcomd/staging", CAPCOMD_GITHUB_REPO: "acme/app" },
      run: { checks: { unit: "bun run test" }, reviewer: "reviewer" },
    });
    const agents = JSON.parse(readFileSync(join(repo, ".capcomd", "agents.json"), "utf8")).agents;
    expect(Object.keys(agents).sort()).toEqual(["codex-worker", "planner", "reviewer", "worker"]);
    expect(agents.planner.children.allowedChildProfiles).toEqual(["worker", "codex-worker"]);
    expect(agents.reviewer.allowedTools).toContain("Bash(bun run:*)");
    expect(agents.reviewer.allowedTools).not.toContain("Edit");
    // Re-running keeps existing profiles (your edits survive).
    const again = json(run(["setup", "project", "--yes", "--json"], { cwd: repo, env }).out);
    expect(again.steps.find((s: any) => s.step === "profiles").detail).toContain("kept existing worker, reviewer, planner");
  });

  test("agent: no Claude Code or Codex CLI: installs the orchestration skill and says how to add the MCP server", () => {
    const r = json(run(["setup", "agent", "--yes", "--json"], { cwd: repo, env: { ...env, CAPCOMD_CLAUDE_CLI: "/nonexistent/claude", CAPCOMD_CODEX_CLI: "/nonexistent/codex" } }).out);
    expect(r.ok).toBe(true);
    expect(r.steps[0].detail).toContain("claude mcp add capcomd -- capcomd mcp");
    expect(existsSync(join(home, ".claude", "skills", "capcomd-orchestration", "SKILL.md"))).toBe(true);
  });

  test("agent: with Claude Code and Codex, installs the plugin from the marketplace and replaces the old skill copy", () => {
    const bin = mkdtempSync(join(tmpdir(), "capcomd-setup-bin-"));
    const calls = join(bin, "calls.log");
    // Fake CLIs: record calls; claude reports the plugin installed afterwards.
    writeFileSync(join(bin, "claude"), `#!/bin/sh\necho "claude $@" >> ${JSON.stringify(calls)}\ncase "$1 $2" in\n  "plugin install") echo '{"outcome":"ok","plugin":"capcomd@capcomd"}' ;;\n  "plugin list") echo '[{"id":"capcomd@capcomd","enabled":true}]' ;;\nesac\nexit 0\n`);
    writeFileSync(join(bin, "codex"), `#!/bin/sh\necho "codex $@" >> ${JSON.stringify(calls)}\nexit 0\n`);
    Bun.spawnSync(["chmod", "+x", join(bin, "claude"), join(bin, "codex")]);
    const e = { ...env, CAPCOMD_CLAUDE_CLI: join(bin, "claude"), CAPCOMD_CODEX_CLI: join(bin, "codex"), CAPCOMD_PLUGIN_MARKETPLACE: "acme/capcomd-fork" };
    const r = json(run(["setup", "agent", "--yes", "--json"], { cwd: repo, env: e }).out);
    expect(r.ok).toBe(true);
    expect(r.steps.map((s: any) => s.step)).toEqual(["claude plugin", "codex plugin"]);
    const log = readFileSync(calls, "utf8");
    expect(log).toContain("claude plugin install capcomd --marketplace acme/capcomd-fork --json");
    expect(log).toContain("codex plugin marketplace add acme/capcomd-fork");
    expect(existsSync(join(home, ".claude", "skills", "capcomd-orchestration"))).toBe(false);
    const c = json(run(["setup", "check", "--json"], { cwd: repo, env: { ...e, BOXD_API_KEY: "" } }).out);
    expect(c.steps.find((s: any) => s.step === "agent plugin")).toMatchObject({ ok: true });
  });

  test("check: reports the project and the skill; no engine and no key show as not ok with a hint", () => {
    const r = run(["setup", "check", "--json"], { cwd: repo, env: { ...env, BOXD_API_KEY: "" } });
    const steps = json(r.out).steps as any[];
    expect(steps.find((s) => s.step === "project")).toMatchObject({ ok: true });
    expect(steps.find((s) => s.step === "agent plugin")).toMatchObject({ ok: false });
    expect(steps.find((s) => s.step === "boxd key")).toMatchObject({ ok: false });
    expect(r.code).toBe(1);
  });
});
