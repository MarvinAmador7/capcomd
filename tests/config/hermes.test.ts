// capcomd in Hermes: detection (files only, Hermes never runs), the config.yaml edit (structural, comments and other
// servers kept, idempotent), the skills, `setup agent` / `setup check`, and the registered command answering MCP.
import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { parse as parseYaml } from "yaml";
import { detectHermes, editHermesConfig, HERMES_ALLOWED_TOOLS, HERMES_DENY, hermesAllowlist, hermesStatus, installHermesSkills, mergedEntry, type HermesEntry } from "../../src/cli/commands/hermes";

const CLI = new URL("../../src/cli/index.ts", import.meta.url).pathname;
const run = (args: string[], o: { cwd: string; env: Record<string, string> }) => {
  const p = Bun.spawnSync([process.execPath, CLI, ...args], { cwd: o.cwd, env: { ...process.env, ...o.env }, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
};
const json = (s: string) => JSON.parse(s.trim().split("\n").pop()!);
const yamlOf = (s: string) => parseYaml(s, { version: "1.1" });
const WANT: HermesEntry = { command: "/opt/capcomd/bin/capcomd", args: ["mcp"], cwd: "/home/me/app", trust: "untrusted" };
const NOWHERE = { CAPCOMD_HERMES_CLI: "/nonexistent/hermes" };

/** A user home with a set-up Hermes in it (config.yaml as given). */
function hermesHomeWith(config: string | null): string {
  const home = mkdtempSync(join(tmpdir(), "capcomd-hermes-home-"));
  mkdirSync(join(home, ".hermes"), { recursive: true });
  if (config !== null) writeFileSync(join(home, ".hermes", "config.yaml"), config);
  return home;
}

// Shapes from Hermes's docs (website/docs/user-guide/features/mcp.md, reference/mcp-config-reference.md,
// user-guide/security.md) and a `hermes setup`-style file with comments.
const WITH_SERVERS = `# Hermes config (hand-edited)
model:
  default: "anthropic/claude-sonnet-4"   # my model

mcp_servers:
  # GitHub, issues only
  github:
    command: "npx"
    args: ["-y", "@modelcontextprotocol/server-github"]
    env:
      GITHUB_PERSONAL_ACCESS_TOKEN: "\${GITHUB_TOKEN}"
    tools:
      include: [list_issues, create_issue]
  legacy:
    url: "https://mcp.legacy.internal"
    enabled: false

# approvals
approvals:
  mode: smart                     # smart | manual | off
  timeout: 300
command_allowlist:
  - "mcp:github/create_issue"
`;

describe("detection: files only, never runs Hermes", () => {
  test("no ~/.hermes and no hermes CLI: not found", () => {
    const home = mkdtempSync(join(tmpdir(), "capcomd-hermes-none-"));
    expect(detectHermes({ PATH: "", ...NOWHERE }, home)).toMatchObject({ found: false, homeExists: false, home: join(home, ".hermes") });
  });

  test("~/.hermes with a config: found; HERMES_HOME and the sticky profile choose the home, like Hermes", () => {
    const home = hermesHomeWith("model: {}\n");
    expect(detectHermes({ PATH: "", ...NOWHERE }, home)).toMatchObject({ found: true, homeExists: true, config: join(home, ".hermes", "config.yaml"), profile: null });
    // `hermes profile use coder` writes ~/.hermes/active_profile; plain `hermes` then reads ~/.hermes/profiles/coder.
    mkdirSync(join(home, ".hermes", "profiles", "coder"), { recursive: true });
    writeFileSync(join(home, ".hermes", "profiles", "coder", "config.yaml"), "");
    writeFileSync(join(home, ".hermes", "active_profile"), "coder\n");
    expect(detectHermes({ PATH: "", ...NOWHERE }, home)).toMatchObject({ home: join(home, ".hermes", "profiles", "coder"), profile: "coder" });
    writeFileSync(join(home, ".hermes", "active_profile"), "default\n");
    expect(detectHermes({ PATH: "", ...NOWHERE }, home).home).toBe(join(home, ".hermes"));
    const custom = mkdtempSync(join(tmpdir(), "capcomd-hermes-custom-"));
    writeFileSync(join(custom, ".env"), "");
    expect(detectHermes({ PATH: "", HERMES_HOME: custom, ...NOWHERE }, home)).toMatchObject({ found: true, home: custom, config: join(custom, "config.yaml") });
  });

  test("the CLI without a home (installed, never set up): found, and the CLI is not run", () => {
    const home = mkdtempSync(join(tmpdir(), "capcomd-hermes-cli-"));
    const bin = join(home, "bin");
    mkdirSync(bin);
    const marker = join(home, "ran");
    writeFileSync(join(bin, "hermes"), `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
    chmodSync(join(bin, "hermes"), 0o755);
    expect(detectHermes({ PATH: bin }, home)).toMatchObject({ found: true, homeExists: false, bin: join(bin, "hermes") });
    expect(hermesStatus({ PATH: bin }, home)).toMatchObject({ ok: false, hint: expect.stringContaining("hermes setup") });
    expect(existsSync(marker)).toBe(false);
  });
});

describe("editing config.yaml", () => {
  test("an empty file: mcp_servers.capcomd, the allowlist and the deny rule", () => {
    const r = editHermesConfig("", WANT);
    if (!r.ok) throw new Error(r.error);
    const y = yamlOf(r.text);
    expect(y.mcp_servers.capcomd).toEqual({ command: WANT.command, args: ["mcp"], cwd: WANT.cwd, trust: "untrusted" });
    expect(y.command_allowlist).toEqual(hermesAllowlist());
    expect(y.approvals).toEqual({ deny: HERMES_DENY });
    expect(r.changes).toHaveLength(3);
  });

  test("other servers, comments and settings are kept byte for byte; capcomd is added beside them", () => {
    const r = editHermesConfig(WITH_SERVERS, WANT);
    if (!r.ok) throw new Error(r.error);
    // Every original line is still there, in order (only lines were inserted).
    const out = r.text.split("\n");
    let i = 0;
    for (const line of WITH_SERVERS.split("\n")) { while (i < out.length && out[i] !== line) i++; expect(i).toBeLessThan(out.length); i++; }
    for (const c of ["# Hermes config (hand-edited)", "# my model", "# GitHub, issues only", "# smart | manual | off", "# approvals"]) expect(r.text).toContain(c);
    const y = yamlOf(r.text), before = yamlOf(WITH_SERVERS);
    expect(y.mcp_servers.github).toEqual(before.mcp_servers.github);
    expect(y.mcp_servers.legacy).toEqual(before.mcp_servers.legacy);
    expect(Object.keys(y.mcp_servers)).toEqual(["github", "legacy", "capcomd"]);
    expect(y.model).toEqual(before.model);
    expect(y.approvals).toEqual({ mode: "smart", timeout: 300, deny: HERMES_DENY });
    expect(y.command_allowlist).toEqual(["mcp:github/create_issue", ...hermesAllowlist()]);
  });

  test("re-running changes nothing and never duplicates", () => {
    const once = editHermesConfig(WITH_SERVERS, WANT);
    if (!once.ok) throw new Error(once.error);
    const twice = editHermesConfig(once.text, WANT);
    expect(twice).toEqual({ ok: true, text: once.text, changes: [] });
    expect(once.text.match(/^ {2}capcomd:/gm)).toHaveLength(1);
    expect(once.text.match(/capcomd approve\*/g)).toHaveLength(1);
  });

  test("an existing capcomd entry is updated in place, keeping the user's own keys", () => {
    const src = `mcp_servers:\n    capcomd:\n        command: capcomd\n        args: [mcp]\n        timeout: 600\n        env:\n            CAPCOMD_ENDPOINT: "http://127.0.0.1:7000"\n    other:\n        url: "https://x.example"\n`;
    const r = editHermesConfig(src, { ...WANT, env: { CAPCOMD_HOME: "/home/me/.capcomd" } });
    if (!r.ok) throw new Error(r.error);
    expect(r.changes[0]).toStartWith("updated mcp_servers.capcomd");
    const y = yamlOf(r.text);
    expect(y.mcp_servers.capcomd).toEqual({ command: WANT.command, args: ["mcp"], cwd: WANT.cwd, env: { CAPCOMD_ENDPOINT: "http://127.0.0.1:7000", CAPCOMD_HOME: "/home/me/.capcomd" }, trust: "untrusted", timeout: 600 });
    expect(y.mcp_servers.other).toEqual({ url: "https://x.example" });
    expect(r.text).toContain("\n    other:\n        url: \"https://x.example\"\n"); // its indentation, untouched
    // No project this time: the entry keeps the directory it had.
    expect(mergedEntry(y.mcp_servers.capcomd, { command: "c", args: ["mcp"], trust: "untrusted" }).cwd).toBe(WANT.cwd);
  });

  test("flow and empty shapes ({} and [], or no value) become blocks", () => {
    for (const src of ["mcp_servers: {}\ncommand_allowlist: []\napprovals: {mode: manual}\n", "mcp_servers:\ncommand_allowlist:\napprovals:\n", "mcp_servers: {gh: {url: \"https://g\"}}\n"]) {
      const r = editHermesConfig(src, WANT);
      if (!r.ok) throw new Error(`${src}: ${r.error}`);
      const y = yamlOf(r.text), before = yamlOf(src) ?? {};
      expect(y.mcp_servers.capcomd.command).toBe(WANT.command);
      if (before.mcp_servers?.gh) expect(y.mcp_servers.gh).toEqual({ url: "https://g" });
      if (before.approvals?.mode) expect(y.approvals.mode).toBe("manual");
      expect(y.command_allowlist).toEqual(hermesAllowlist());
      expect(editHermesConfig(r.text, WANT)).toMatchObject({ ok: true, changes: [] });
    }
  });

  test("a file it can't edit safely is refused, with the reason", () => {
    expect(editHermesConfig("mcp_servers: [a, b]\n", WANT)).toMatchObject({ ok: false, error: "mcp_servers isn't a mapping" });
    expect(editHermesConfig("command_allowlist: oops\n", WANT)).toMatchObject({ ok: false, error: "command_allowlist isn't a list" });
    expect(editHermesConfig("- just\n- a list\n", WANT)).toMatchObject({ ok: false, error: "its top level isn't a mapping" });
    expect(editHermesConfig("a: [\n", WANT).ok).toBe(false);
    // Hermes (ruamel) rejects duplicate keys, so a file with them isn't one to edit.
    expect(editHermesConfig("mcp_servers: {}\nmcp_servers: {}\n", WANT).ok).toBe(false);
  });
});

test("skills: installed, updated when unedited, kept when Hermes or the user edited them", () => {
  const home = mkdtempSync(join(tmpdir(), "capcomd-hermes-skills-"));
  const r1 = installHermesSkills(home);
  expect(r1.added.sort()).toEqual(["capcomd-orchestration", "capcomd-setup"]);
  const orch = join(home, "skills", "capcomd", "capcomd-orchestration", "SKILL.md");
  expect(readFileSync(orch, "utf8")).toStartWith("---\nname: capcomd-orchestration\ndescription: ");
  expect(installHermesSkills(home).current.sort()).toEqual(["capcomd-orchestration", "capcomd-setup"]);
  // An older copy capcomd wrote is updated (the manifest has its hash)…
  const manifest = join(home, "skills", "capcomd", ".capcomd.json");
  const m = JSON.parse(readFileSync(manifest, "utf8"));
  writeFileSync(orch, "old version\n");
  m.skills["capcomd-orchestration"] = new Bun.CryptoHasher("sha256").update("old version\n").digest("hex");
  writeFileSync(manifest, JSON.stringify(m));
  expect(installHermesSkills(home).updated).toEqual(["capcomd-orchestration"]);
  // …an edited one is kept.
  writeFileSync(orch, "my own notes\n");
  expect(installHermesSkills(home).kept).toEqual(["capcomd-orchestration"]);
  expect(readFileSync(orch, "utf8")).toBe("my own notes\n");
});

describe("capcomd setup agent / setup check with Hermes", () => {
  const repo = mkdtempSync(join(tmpdir(), "capcomd-hermes-repo-"));
  Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: repo });
  Bun.spawnSync(["git", "remote", "add", "origin", "git@github.com:acme/app.git"], { cwd: repo });
  mkdirSync(join(repo, ".capcomd"));
  writeFileSync(join(repo, ".capcomd", "config.json"), JSON.stringify({ env: { CAPCOMD_REPO: "https://github.com/acme/app.git" }, run: { checks: { unit: "true" } } }));
  const envFor = (home: string) => ({ HOME: home, CAPCOMD_HOME: join(home, ".capcomd"), CAPCOMD_CLAUDE_CLI: "/nonexistent/claude", CAPCOMD_CODEX_CLI: "/nonexistent/codex", ...NOWHERE, HERMES_HOME: "", BOXD_API_KEY: "" });
  const hermesOf = (r: { out: string }) => json(r.out).steps.find((s: any) => s.step === "hermes");

  test("no Hermes: no Hermes step, the Claude Code skill as before", () => {
    const home = mkdtempSync(join(tmpdir(), "capcomd-hermes-nohermes-"));
    const r = run(["setup", "agent", "--yes", "--json"], { cwd: repo, env: envFor(home) });
    expect(hermesOf(r)).toBeUndefined();
    expect(existsSync(join(home, ".hermes"))).toBe(false);
    const c = run(["setup", "check", "--json"], { cwd: repo, env: envFor(home) });
    expect(hermesOf(c)).toMatchObject({ ok: true, detail: expect.stringContaining("Hermes not found") });
  });

  test("with Hermes: registers capcomd mcp (in this project), installs the skills; again keeps it; check reports it", () => {
    const home = hermesHomeWith(WITH_SERVERS);
    const env = envFor(home);
    const r = run(["setup", "agent", "--yes", "--json"], { cwd: join(repo, ".capcomd"), env });
    expect(r.code).toBe(0);
    const step = hermesOf(r);
    expect(step.ok).toBe(true);
    expect(step.detail).toContain("added mcp_servers.capcomd");
    expect(step.detail).toContain("merges into protected branches wait for you");
    const cfgPath = join(home, ".hermes", "config.yaml");
    const text = readFileSync(cfgPath, "utf8");
    const y = yamlOf(text);
    expect(y.mcp_servers.capcomd).toMatchObject({ command: process.execPath, args: [CLI, "mcp"], cwd: Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { cwd: repo }).stdout.toString().trim(), env: { CAPCOMD_HOME: join(home, ".capcomd") }, trust: "untrusted" });
    expect(y.mcp_servers.github).toEqual(yamlOf(WITH_SERVERS).mcp_servers.github);
    expect(text).toContain("# GitHub, issues only");
    expect(readFileSync(`${cfgPath}.capcomd.bak`, "utf8")).toBe(WITH_SERVERS);
    for (const s of ["capcomd-orchestration", "capcomd-setup"]) expect(existsSync(join(home, ".hermes", "skills", "capcomd", s, "SKILL.md"))).toBe(true);
    // Nothing decided about approvals without the user: the project's config is unchanged.
    expect(JSON.parse(readFileSync(join(repo, ".capcomd", "config.json"), "utf8")).driver).toBeUndefined();

    const again = run(["setup", "agent", "--yes", "--json"], { cwd: repo, env });
    expect(hermesOf(again).detail).toContain("already had capcomd");
    expect(hermesOf(again).detail).toContain("capcomd-orchestration, capcomd-setup current");
    expect(readFileSync(cfgPath, "utf8")).toBe(text);

    const c = run(["setup", "check", "--json"], { cwd: repo, env });
    const steps = json(c.out).steps;
    expect(steps.find((s: any) => s.step === "hermes")).toMatchObject({ ok: true, detail: expect.stringContaining("capcomd in Hermes") });
    expect(steps.find((s: any) => s.step === "agent plugin")).toMatchObject({ ok: true, detail: "not in Claude Code (Hermes has capcomd)" });
  });

  test("--no-hermes leaves Hermes alone; check says how to add it", () => {
    const home = hermesHomeWith(WITH_SERVERS);
    const r = run(["setup", "agent", "--yes", "--no-hermes", "--json"], { cwd: repo, env: envFor(home) });
    expect(hermesOf(r)).toBeUndefined();
    expect(readFileSync(join(home, ".hermes", "config.yaml"), "utf8")).toBe(WITH_SERVERS);
    expect(existsSync(join(home, ".hermes", "skills"))).toBe(false);
    const c = run(["setup", "check", "--json"], { cwd: repo, env: envFor(home) });
    expect(hermesOf(c)).toMatchObject({ ok: false, hint: expect.stringContaining("capcomd setup agent") });
  });

  test("--approvals client-confirmed lets Hermes approve after asking; not when Hermes's approvals are off", () => {
    const proj = mkdtempSync(join(tmpdir(), "capcomd-hermes-proj-"));
    Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: proj });
    mkdirSync(join(proj, ".capcomd"));
    writeFileSync(join(proj, ".capcomd", "config.json"), JSON.stringify({ driver: { maxRunBudget: "usd=5" } }));
    const bad = hermesHomeWith("");
    const rb = run(["setup", "agent", "--yes", "--approvals", "sometimes", "--json"], { cwd: proj, env: envFor(bad) });
    expect(hermesOf(rb).ok).toBe(false);
    expect(readFileSync(join(bad, ".hermes", "config.yaml"), "utf8")).toBe("");
    const off = hermesHomeWith("approvals:\n  mode: off\n");
    const r0 = run(["setup", "agent", "--yes", "--approvals", "client-confirmed", "--json"], { cwd: proj, env: envFor(off) });
    expect(hermesOf(r0).detail).toContain("approvals.mode is off");
    expect(JSON.parse(readFileSync(join(proj, ".capcomd", "config.json"), "utf8")).driver).toEqual({ maxRunBudget: "usd=5" });
    const home = hermesHomeWith("");
    const r = run(["setup", "agent", "--yes", "--approvals", "client-confirmed", "--json"], { cwd: proj, env: envFor(home) });
    expect(hermesOf(r).detail).toContain("driver.approvals: client-confirmed");
    expect(JSON.parse(readFileSync(join(proj, ".capcomd", "config.json"), "utf8")).driver).toEqual({ maxRunBudget: "usd=5", approvals: "client-confirmed" });
    run(["setup", "agent", "--yes", "--approvals", "human", "--json"], { cwd: proj, env: envFor(home) });
    expect(JSON.parse(readFileSync(join(proj, ".capcomd", "config.json"), "utf8")).driver.approvals).toBe("human");
  });

  test("a config.yaml Hermes can't read is left alone, with the snippet to add by hand", () => {
    const home = hermesHomeWith("mcp_servers: [oops\n");
    const r = run(["setup", "agent", "--yes", "--json"], { cwd: repo, env: envFor(home) });
    expect(hermesOf(r)).toMatchObject({ ok: false, detail: expect.stringContaining("can't read") });
    expect(readFileSync(join(home, ".hermes", "config.yaml"), "utf8")).toBe("mcp_servers: [oops\n");
  });

  test("the command setup wrote answers MCP: initialize, tools/list (as Hermes starts it: only its own env)", async () => {
    const home = hermesHomeWith("");
    const r = run(["setup", "agent", "--yes", "--json"], { cwd: repo, env: envFor(home) });
    expect(hermesOf(r).ok).toBe(true);
    const entry = yamlOf(readFileSync(join(home, ".hermes", "config.yaml"), "utf8")).mcp_servers.capcomd;
    // Hermes passes a stdio server PATH, HOME, USER, LANG, LC_ALL, TERM, SHELL, TMPDIR, XDG_* and the entry's env.
    // The rest is this test's isolation: no engine is started, and nothing listens on that endpoint.
    const env: Record<string, string> = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, USER: process.env.USER ?? "me", LANG: "C", TERM: "dumb", SHELL: "/bin/sh", TMPDIR: tmpdir(),
      ...entry.env, CAPCOMD_NO_ENGINE_AUTOSTART: "1", CAPCOMD_ENDPOINT: "http://127.0.0.1:28799", CAPCOMD_HARNESS_SOCKET: join(home, "h.sock") };
    const client = new Client({ name: "hermes-like", version: "0" });
    await client.connect(new StdioClientTransport({ command: entry.command, args: entry.args, cwd: entry.cwd, env, stderr: "ignore" }));
    try {
      expect(client.getServerVersion()?.name).toBe("capcomd");
      const tools = (await client.listTools()).tools;
      const names = tools.map((t) => t.name);
      expect(names).toContain("capcomd_spawn");
      // The allowlist is exactly the write tools that aren't destructive: Hermes asks before the destructive ones.
      const writes = tools.filter((t) => !t.annotations?.readOnlyHint && !t.annotations?.destructiveHint).map((t) => t.name).sort();
      expect(writes).toEqual([...HERMES_ALLOWED_TOOLS].sort());
      expect(tools.filter((t) => t.annotations?.destructiveHint).map((t) => t.name).sort()).toEqual(["capcomd_approve", "capcomd_cancel", "capcomd_merge"]);
      // capcomd_setup, from Hermes's capcomd: the project's gates (from cwd) and Hermes reported as set up.
      const res: any = await client.callTool({ name: "capcomd_setup", arguments: {} });
      const body = JSON.parse(res.content[0].text);
      expect(body.gates.checks).toEqual({ unit: "true" });
      expect(body.steps.find((s: any) => s.step === "hermes")).toMatchObject({ ok: true });
    } finally { await client.close(); }
  }, 60_000);
});

test("on a boxd machine without a key: setup records the machine, so the capcomd Hermes starts (no BOXD_VM_* in its env) uses its credentials", async () => {
  const { hermesStep } = await import("../../src/cli/commands/setup");
  const { prompter } = await import("../../src/cli/prompt");
  const saved = { HERMES_HOME: process.env.HERMES_HOME, CAPCOMD_HOME: process.env.CAPCOMD_HOME, CAPCOMD_HERMES_CLI: process.env.CAPCOMD_HERMES_CLI, BOXD_API_KEY: process.env.BOXD_API_KEY };
  const hh = mkdtempSync(join(tmpdir(), "capcomd-hermes-vm-"));
  writeFileSync(join(hh, "config.yaml"), "");
  Object.assign(process.env, { HERMES_HOME: hh, CAPCOMD_HOME: mkdtempSync(join(tmpdir(), "capcomd-hermes-vm-home-")), CAPCOMD_HERMES_CLI: "/nonexistent/hermes" });
  delete process.env.BOXD_API_KEY;
  try {
    const away = mkdtempSync(join(tmpdir(), "capcomd-hermes-vm-cwd-"));
    const s = await hermesStep(prompter({ yes: true }), {}, away, async () => ({ inside: true, credentials: true, name: "hermes-vm", detail: "inside boxd machine hermes-vm: using its credentials" }));
    expect(s?.ok).toBe(true);
    expect(s?.detail).toContain("boxd: using machine hermes-vm's credentials");
    expect(JSON.parse(readFileSync(join(process.env.CAPCOMD_HOME!, "config.json"), "utf8")).env).toEqual({ CAPCOMD_BOXD_MACHINE: "hermes-vm" });
    // Outside a machine nothing is recorded.
    const home2 = mkdtempSync(join(tmpdir(), "capcomd-hermes-vm-home2-"));
    process.env.CAPCOMD_HOME = home2;
    await hermesStep(prompter({ yes: true }), {}, away, async () => ({ inside: false, credentials: false, detail: "not in a boxd machine" }));
    expect(existsSync(join(home2, "config.json"))).toBe(false);
  } finally { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});
