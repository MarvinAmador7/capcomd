// capcomd setup: the parts that need no network (project, agent integration, check), driven non-interactively.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { githubRepoOf, httpsRemote, projectStep, suggestCheck } from "../../src/cli/commands/setup";
import { LEAD_DESCRIPTION } from "../../src/config/project-setup";

// The test projects' remotes are made-up GitHub ones: setup asks them for their default branch (`git ls-remote`), which
// must fail at once here rather than try a real SSH connection (seconds on a machine with an SSH key).
process.env.GIT_SSH_COMMAND = "false";

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

describe("setup project outside a git checkout", () => {
  const home = mkdtempSync(join(tmpdir(), "capcomd-setup-nogit-home-"));
  const env = { HOME: home, CAPCOMD_HOME: join(home, ".capcomd") };
  const step = (cwd: string, extra: string[] = []) => json(run(["setup", "project", "--yes", "--mode", "direct", ...extra, "--json"], { cwd, env }).out).steps?.find((s: any) => s.step === "project");

  test("without --repo it says to run it in the repository, and writes nothing", () => {
    const d = mkdtempSync(join(tmpdir(), "capcomd-setup-nogit-"));
    expect(step(d)).toMatchObject({ ok: false, hint: expect.stringContaining("inside your repository") });
    expect(existsSync(join(d, ".capcomd"))).toBe(false);
  });

  test("never keeps project settings in the home directory (where capcomd's own config is)", () => {
    expect(step(home, ["--repo", "https://github.com/acme/app.git"])).toMatchObject({ ok: false, detail: expect.stringContaining("home directory") });
    expect(existsSync(join(home, ".capcomd", "config.json")) ? JSON.parse(readFileSync(join(home, ".capcomd", "config.json"), "utf8")).env?.CAPCOMD_REPO : undefined).toBeUndefined();
  });

  test("with --repo in another directory, that directory keeps them (as before)", () => {
    const d = mkdtempSync(join(tmpdir(), "capcomd-setup-nogit-repo-"));
    expect(step(d, ["--repo", "https://github.com/acme/app.git"])).toMatchObject({ ok: true });
    expect(JSON.parse(readFileSync(join(d, ".capcomd", "config.json"), "utf8")).env.CAPCOMD_REPO).toBe("https://github.com/acme/app.git");
  });
});

test("in a terminal outside a checkout: asks for the project's checkout, then offers its origin as the repository", async () => {
  const away = mkdtempSync(join(tmpdir(), "capcomd-setup-away-"));
  const proj = mkdtempSync(join(tmpdir(), "capcomd-setup-proj-"));
  Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: proj });
  Bun.spawnSync(["git", "remote", "add", "origin", "git@github.com:acme/widgets.git"], { cwd: proj });
  const asked: Array<[string, string]> = [];
  const p: any = {
    interactive: true,
    ask: async (q: string, d: string) => { asked.push([q, d]); return q.includes("isn't a git checkout") ? proj : d; },
    choose: async (_q: string, _o: unknown, d: string) => d, confirm: async () => true, secret: async () => "",
  };
  const saved = { HOME: process.env.HOME, CAPCOMD_HOME: process.env.CAPCOMD_HOME };
  process.env.CAPCOMD_HOME = mkdtempSync(join(tmpdir(), "capcomd-setup-away-home-"));
  try {
    const steps = await projectStep(p, { mode: "direct", agents: "claude" } as any, away);
    expect(asked[0]![0]).toContain("isn't a git checkout. Path to your project's checkout");
    expect(asked.find(([q]) => q === "Repository the agents work on")?.[1]).toBe("git@github.com:acme/widgets.git");
    expect(steps[0]).toMatchObject({ step: "project", ok: true });
    expect(JSON.parse(readFileSync(join(proj, ".capcomd", "config.json"), "utf8")).env.CAPCOMD_REPO).toBe("https://github.com/acme/widgets.git");
    expect(existsSync(join(away, ".capcomd"))).toBe(false);
  } finally { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
}, 60_000);

describe("setup steps (non-interactive)", () => {
  const home = mkdtempSync(join(tmpdir(), "capcomd-setup-home-"));
  const repo = mkdtempSync(join(tmpdir(), "capcomd-setup-repo-"));
  const env = { HOME: home, CAPCOMD_HOME: join(home, ".capcomd") };
  Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: repo });
  Bun.spawnSync(["git", "remote", "add", "origin", "git@github.com:acme/app.git"], { cwd: repo });
  writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
  writeFileSync(join(repo, "bun.lock"), "");
  mkdirSync(join(repo, "src"));

  test("project: detects the repo, writes the project config and worker/reviewer/lead/planner profiles", () => {
    const r = run(["setup", "project", "--yes", "--agents", "claude,codex", "--mode", "direct", "--target", "capcomd/staging", "--json"], { cwd: join(repo, "src"), env });
    expect(r.code).toBe(0);
    const cfg = JSON.parse(readFileSync(join(repo, ".capcomd", "config.json"), "utf8"));
    expect(cfg).toEqual({
      env: { CAPCOMD_REPO: "https://github.com/acme/app.git", CAPCOMD_MERGE_MODE: "direct", CAPCOMD_MERGE_TARGET: "capcomd/staging", CAPCOMD_GITHUB_REPO: "acme/app" },
      run: { checks: { unit: "bun run test" }, reviewer: "reviewer" },
    });
    const agents = JSON.parse(readFileSync(join(repo, ".capcomd", "agents.json"), "utf8")).agents;
    expect(Object.keys(agents).sort()).toEqual(["codex-worker", "context-consolidator", "lead", "planner", "reviewer", "worker"]);
    expect(agents.planner.children.allowedChildProfiles).toEqual(["worker", "codex-worker", "lead", "context-consolidator"]);
    // A module lead: the worker's provider and login, orchestrating (plugin API §16.1) up to 3 worker helpers, one level.
    expect(agents.lead).toEqual({ provider: "claude", auth: "subscription", description: LEAD_DESCRIPTION, toolMode: "orchestrate", children: { allowSpawn: true, maxChildren: 3, maxDepth: 1, allowedChildProfiles: ["worker", "codex-worker"] } });
    // The reviewer runs the check and the package manager's test runner (bun test as well as bun run).
    expect(agents.reviewer.allowedTools).toEqual(expect.arrayContaining(["Bash(bun run:*)", "Bash(bun test:*)"]));
    expect(agents.reviewer.allowedTools).not.toContain("Edit");
    // No turn, time or money limits on the profiles setup makes (ADR-019).
    for (const p of Object.values(agents) as any[]) expect([p.maxTurns, p.timeoutMs, p.maxBudgetUsd]).toEqual([undefined, undefined, undefined]);
    // Re-running keeps existing profiles (your edits survive).
    const again = json(run(["setup", "project", "--yes", "--json"], { cwd: repo, env }).out);
    expect(again.steps.find((s: any) => s.step === "profiles").detail).toContain("kept existing worker, reviewer, lead, context-consolidator, planner");
  });

  test("project: an existing project's agents.json keeps its profiles; setup only adds the missing lead", () => {
    const r3 = mkdtempSync(join(tmpdir(), "capcomd-setup-repo-"));
    Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: r3 });
    Bun.spawnSync(["git", "remote", "add", "origin", "git@github.com:acme/app.git"], { cwd: r3 });
    mkdirSync(join(r3, ".capcomd"));
    const mine = { provider: "claude", auth: "subscription", model: "opus", allowedTools: ["Read"] };
    writeFileSync(join(r3, ".capcomd", "agents.json"), JSON.stringify({ schema: "capcomd.agents/v1", default: "worker", agents: { worker: mine, reviewer: mine, planner: { ...mine, children: { allowSpawn: true, allowedChildProfiles: ["worker"] } } } }));
    expect(json(run(["setup", "project", "--yes", "--mode", "direct", "--json"], { cwd: r3, env }).out).ok).toBe(true);
    const after = JSON.parse(readFileSync(join(r3, ".capcomd", "agents.json"), "utf8"));
    expect(after.agents.worker).toEqual(mine);
    expect(after.agents.reviewer).toEqual(mine);
    expect(after.default).toBe("worker");
    expect(after.agents.lead.children).toMatchObject({ allowSpawn: true, maxChildren: 3, maxDepth: 1 });
  });

  test("project: an API-key login gets the spend cap per run it asks for (--budget), saved as driver.maxRunBudget", () => {
    const r2 = mkdtempSync(join(tmpdir(), "capcomd-setup-repo-"));
    Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: r2 });
    Bun.spawnSync(["git", "remote", "add", "origin", "git@github.com:acme/app.git"], { cwd: r2 });
    const out = json(run(["setup", "project", "--yes", "--auth", "apikey", "--budget", "20", "--mode", "direct", "--json"], { cwd: r2, env }).out);
    expect(out.ok).toBe(true);
    expect(JSON.parse(readFileSync(join(r2, ".capcomd", "config.json"), "utf8")).driver).toEqual({ maxRunBudget: "usd=20" });
    expect(JSON.parse(readFileSync(join(r2, ".capcomd", "agents.json"), "utf8")).agents.worker).toEqual({ provider: "claude", auth: "apikey" });
    const bad = json(run(["setup", "project", "--yes", "--auth", "apikey", "--budget", "lots", "--json"], { cwd: r2, env }).out);
    expect(bad.steps[0]).toMatchObject({ ok: false, detail: expect.stringContaining("isn't an amount") });
  });

  test("agent: no Claude Code or Codex CLI: installs the orchestration skill and says how to add the MCP server", () => {
    const r = json(run(["setup", "agent", "--yes", "--json"], { cwd: repo, env: { ...env, CAPCOMD_CLAUDE_CLI: "/nonexistent/claude", CAPCOMD_CODEX_CLI: "/nonexistent/codex" } }).out);
    expect(r.ok).toBe(true);
    expect(r.steps.find((s: any) => s.step === "agent skill").detail).toContain("claude mcp add capcomd -- capcomd mcp");
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
    // The checkout is a project: it's on capcomd's project list too (setup project put it there already).
    expect(r.steps.map((s: any) => s.step)).toEqual(["project list", "claude plugin", "codex plugin"]);
    const log = readFileSync(calls, "utf8");
    expect(log).toContain("claude plugin install capcomd --marketplace acme/capcomd-fork --json");
    expect(log).toContain("codex plugin marketplace add acme/capcomd-fork");
    expect(existsSync(join(home, ".claude", "skills", "capcomd-orchestration"))).toBe(false);
    const c = json(run(["setup", "check", "--json"], { cwd: repo, env: { ...e, BOXD_API_KEY: "" } }).out);
    expect(c.steps.find((s: any) => s.step === "agent plugin")).toMatchObject({ ok: true });
  });

  test("check: reports the project and the skill; no sandbox and no engine show as not ok with a hint", () => {
    const r = run(["setup", "check", "--json"], { cwd: repo, env: { ...env, BOXD_API_KEY: "" } });
    const steps = json(r.out).steps as any[];
    expect(steps.find((s) => s.step === "project")).toMatchObject({ ok: true });
    expect(steps.find((s) => s.step === "agent plugin")).toMatchObject({ ok: false });
    expect(steps.find((s) => s.step === "sandbox")).toMatchObject({ ok: false, sandbox: { name: null, source: "engine" }, hint: expect.stringContaining("setup project --sandbox") });
    expect(r.code).toBe(1);
  });

  test("project: goes on the projects list at once, --sandbox is the project's, and check reports it with its source", () => {
    const h = mkdtempSync(join(tmpdir(), "capcomd-setup-list-home-"));
    const e = { HOME: h, CAPCOMD_HOME: join(h, ".capcomd"), CAPCOMD_NO_CONFIG: "" };
    const r3 = mkdtempSync(join(tmpdir(), "capcomd-setup-list-repo-"));
    Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: r3 });
    Bun.spawnSync(["git", "remote", "add", "origin", "git@github.com:acme/calc.git"], { cwd: r3 });
    // The user's own config says boxd; the project says docker: the project's wins for its runs.
    mkdirSync(join(h, ".capcomd"), { recursive: true });
    writeFileSync(join(h, ".capcomd", "config.json"), JSON.stringify({ env: { CAPCOMD_SANDBOX: "boxd" } }));
    const out = json(run(["setup", "project", "--yes", "--mode", "direct", "--target", "dev", "--check", "true", "--sandbox", "docker", "--json"], { cwd: r3, env: e }).out);
    expect(out.ok).toBe(true);
    expect(out.steps.find((s: any) => s.step === "project list")).toMatchObject({ ok: true, detail: expect.stringContaining("capcomd_projects") });
    const user = JSON.parse(readFileSync(join(h, ".capcomd", "config.json"), "utf8"));
    expect(user.projects.list.map((p: any) => p.path)).toEqual([Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { cwd: r3 }).stdout.toString().trim()]);
    expect(user.projects.default).toBe(user.projects.list[0].name);
    expect(user.env.CAPCOMD_SANDBOX).toBe("boxd");
    expect(JSON.parse(readFileSync(join(r3, ".capcomd", "config.json"), "utf8")).env.CAPCOMD_SANDBOX).toBe("docker");
    // Docker, and no env image yet: setup says to build one (never builds it under --yes).
    expect(out.steps.find((s: any) => s.step === "env image")).toMatchObject({ ok: true, advice: true, command: "capcomd env build --sandbox docker" });
    // Running it again: still one entry. `setup agent` there doesn't add a second.
    run(["setup", "project", "--yes", "--json"], { cwd: r3, env: e });
    run(["setup", "agent", "--yes", "--no-hermes", "--no-plugin", "--default-project", "--json"], { cwd: r3, env: e });
    expect(JSON.parse(readFileSync(join(h, ".capcomd", "config.json"), "utf8")).projects.list).toHaveLength(1);
    const c = json(run(["setup", "check", "--json"], { cwd: r3, env: { ...e, CAPCOMD_DOCKER_BIN: "/nonexistent/docker" } }).out);
    expect(c.steps.find((s: any) => s.step === "sandbox")).toMatchObject({ ok: true, sandbox: { name: "docker", source: "project" }, detail: expect.stringContaining("project: ") });
    expect(c.steps.find((s: any) => s.step === "docker")).toMatchObject({ ok: false });
    expect(c.steps.find((s: any) => s.step === "boxd key")).toBeUndefined();
    expect(c.steps.find((s: any) => s.step === "env image")).toMatchObject({ advice: true, command: "capcomd env build --sandbox docker" });
    const bad = json(run(["setup", "project", "--yes", "--sandbox", "kubernetes", "--json"], { cwd: r3, env: e }).out);
    expect(bad.steps[0]).toMatchObject({ ok: false, detail: "--sandbox kubernetes?" });
  }, 60_000);

  test("service: turns the watchdog on in the user's config (plugin API §16.4); one you turned off stays off", () => {
    const h = mkdtempSync(join(tmpdir(), "capcomd-setup-wd-home-"));
    const e = { HOME: h, CAPCOMD_HOME: join(h, ".capcomd"), CAPCOMD_NO_CONFIG: "" };
    const user = () => JSON.parse(readFileSync(join(h, ".capcomd", "config.json"), "utf8"));
    mkdirSync(join(h, ".capcomd"), { recursive: true });
    writeFileSync(join(h, ".capcomd", "config.json"), JSON.stringify({ env: { CAPCOMD_SANDBOX: "docker" }, plugins: { other: { x: 1 } } }));
    const skipped = json(run(["setup", "service", "--yes", "--no-service", "--no-watchdog", "--json"], { cwd: h, env: e }).out);
    expect(skipped.steps.find((s: any) => s.step === "watchdog")).toMatchObject({ ok: true, detail: expect.stringContaining("off (--no-watchdog)") });
    expect(user().plugins).toEqual({ other: { x: 1 } });
    const r = json(run(["setup", "service", "--yes", "--no-service", "--json"], { cwd: h, env: e }).out);
    expect(r.steps.map((s: any) => s.step)).toEqual(["watchdog", "engine"]);
    expect(r.steps[0]).toMatchObject({ ok: true, detail: expect.stringContaining("on: an agent whose work hasn't changed for 15 min gets a stalled notice, and is stopped after 45 min") });
    expect(user()).toEqual({ env: { CAPCOMD_SANDBOX: "docker" }, plugins: { other: { x: 1 }, watchdog: { enabled: true } } });
    const c = json(run(["setup", "check", "--json"], { cwd: h, env: { ...e, BOXD_API_KEY: "" } }).out);
    expect(c.steps.find((s: any) => s.step === "watchdog")).toEqual({ step: "watchdog", ok: true, detail: "on" });
    // Your own settings show, and an "enabled": false stays.
    writeFileSync(join(h, ".capcomd", "config.json"), JSON.stringify({ plugins: { watchdog: { enabled: false, stalledAfterMs: 1_200_000 } } }));
    const off = json(run(["setup", "service", "--yes", "--no-service", "--json"], { cwd: h, env: e }).out);
    expect(off.steps[0].detail).toContain("off: turned off in plugins.watchdog");
    expect(user().plugins.watchdog).toEqual({ enabled: false, stalledAfterMs: 1_200_000 });
    expect(json(run(["setup", "check", "--json"], { cwd: h, env: { ...e, BOXD_API_KEY: "" } }).out).steps.find((s: any) => s.step === "watchdog").detail).toBe("off (`capcomd setup service` turns it on)");
    writeFileSync(join(h, ".capcomd", "config.json"), JSON.stringify({ plugins: { watchdog: { enabled: true, stalledAfterMs: 1_200_000, everyMs: 5 } } }));
    expect(json(run(["setup", "service", "--yes", "--no-service", "--json"], { cwd: h, env: e }).out).steps[0].detail).toBe("on: an agent whose work hasn't changed for 20 min gets a stalled notice, and is stopped after 45 min");
    expect(json(run(["setup", "check", "--json"], { cwd: h, env: { ...e, BOXD_API_KEY: "" } }).out).steps.find((s: any) => s.step === "watchdog")).toMatchObject({ ok: false, detail: expect.stringContaining("user: plugins.watchdog.everyMs must be at least 1000") });
    // A stop before the notice: the schema takes it, the watchdog's activation doesn't, and check says so.
    writeFileSync(join(h, ".capcomd", "config.json"), JSON.stringify({ plugins: { watchdog: { enabled: true, stalledAfterMs: 1_200_000, stopAfterMs: 600_000 } } }));
    expect(json(run(["setup", "check", "--json"], { cwd: h, env: { ...e, BOXD_API_KEY: "" } }).out).steps.find((s: any) => s.step === "watchdog")).toMatchObject({ ok: false, detail: "it won't load: plugins.watchdog.stopAfterMs is 600000: it must be 0 (never stop) or more than stalledAfterMs (1200000), since both count from the last progress" });
  }, 60_000);
});
