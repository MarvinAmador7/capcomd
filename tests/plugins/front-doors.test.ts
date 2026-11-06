// Front doors as registrations (docs/spec/plugin-api.md §4.7.1, §4.7.2, §11.2, §17.2 step 8): the CLI's groups and the
// MCP server's tools are what the built-in front doors register (src/plugins/front/), the kernel's names are the ones
// no plugin may take, and a plugin's own command and tool (tests/plugins/fixtures/front-echo, loaded with
// CAPCOMD_TEST_PLUGINS) answer with the relay.v1 envelope and the caller's principal. The orchestration skill is an
// agent.preparing patch (src/plugins/skill-orchestration.ts). The kernel's tools listed exactly as before: tests/mcp.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PluginHost, type Candidate } from "../../packages/plugin/src/host/host";
import type { PluginModule } from "../../packages/plugin/src/context";
import { KERNEL_COMMANDS, loadManifest } from "../../packages/plugin/src/load";
import { samplePayload, testkit } from "../../packages/plugin/src/testkit";
import type { PluginManifest } from "../../packages/plugin/src/manifest";
import { BUILTINS, candidateOf, KERNEL_SURFACE } from "../../src/plugins/builtins";
import { DISPATCHER_COMMANDS, parseLoose } from "../../src/cli/front-doors";
import { MCP_TOOLS } from "../../src/plugins/front/mcp";
import { FRONT_GROUPS } from "../../src/plugins/front/groups";
import { kernelTools } from "../../src/mcp/tools";
import { SKILL_NAME, plugin as skillPlugin, manifest as skillManifest, skillKernel } from "../../src/plugins/skill-orchestration";
import { preparingAgent, skillHash } from "../../src/plugins/hooks";
import { unpreparedSkill } from "../../src/primitives/ops";
import { VERSION } from "../../src/utils/self";

const ROOT = join(import.meta.dir, "..", "..");
const CLI = join(ROOT, "src", "cli", "index.ts");
const ECHO = join(import.meta.dir, "fixtures", "front-echo");
const home = mkdtempSync(join(tmpdir(), "capcomd-front-doors-"));
const childEnv = (): Record<string, string> => ({ ...(process.env as Record<string, string>), NODE_ENV: "test", CAPCOMD_TEST_PLUGINS: ECHO, CAPCOMD_HOME: home, CAPCOMD_NO_CONFIG: "1", CAPCOMD_NO_ENGINE_AUTOSTART: "1", CAPCOMD_ENDPOINT: "http://127.0.0.1:1" });
const cli = (...args: string[]) => {
  const p = Bun.spawnSync([process.execPath, CLI, ...args], { cwd: home, env: childEnv(), stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
};
const name = (b: { manifest: unknown }) => (b.manifest as PluginManifest).name;

describe("the kernel's front doors", () => {
  test("KERNEL_COMMANDS are the CLI's commands: the dispatcher's own and the built-in front doors' (§4.7.1)", () => {
    const registered = BUILTINS.filter((b) => b.kernelSurface).flatMap((b) => ((b.manifest as PluginManifest).contributes?.cli ?? []).map((c) => c.name));
    expect(new Set(registered).size).toBe(registered.length);
    expect([...KERNEL_COMMANDS as readonly string[]].sort()).toEqual([...new Set([...DISPATCHER_COMMANDS, ...registered])].sort());
  });

  test("a front door is the kernel's only when the kernel's list names it: the same manifest from anyone else is refused", () => {
    for (const b of BUILTINS.filter((x) => x.kernelSurface)) {
      expect(loadManifest(b.manifest, { capcomd: VERSION, kernelSurface: true })).toMatchObject({ ok: true });
      if ((b.manifest as PluginManifest).contributes?.cli?.some((c) => (KERNEL_COMMANDS as readonly string[]).includes(c.name)))
        expect(loadManifest(b.manifest, { capcomd: VERSION })).toMatchObject({ ok: false, cause: "invalid_manifest", issues: expect.arrayContaining([expect.objectContaining({ message: expect.stringContaining("is a kernel command") })]) });
    }
    expect([...KERNEL_SURFACE].sort()).toEqual(["front-env", "front-hermes", "front-mcp", "front-primitives", "front-profiles", "front-run", "front-setup"]);
  });

  test("front-mcp declares the tools it registers, named capcomd_<tool>; a plugin's are capcomd_<plugin>_<tool>", async () => {
    expect(MCP_TOOLS.map((t) => t.name)).toEqual(kernelTools().map((t) => t.name));
    const host = new PluginHost({ capcomd: VERSION, kernel: [], emit: () => {}, dataDir: (n) => join(home, "data", n) });
    const echo: Candidate = { source: "builtin", dir: ECHO, kernelSurface: true };   // a plugin from a directory is never the kernel's
    await host.start([...BUILTINS.filter((b) => name(b) === "front-mcp").map(candidateOf), echo]);
    expect(host.get("front-mcp")).toMatchObject({ state: "active" });
    expect(host.get("echo")).toMatchObject({ state: "active" });
    const tools = host.contributions.list("mcp").map((c) => c.key);
    expect(tools.filter((t) => !t.startsWith("capcomd_echo_"))).toEqual(kernelTools().map((t) => `capcomd_${t.name}`));
    expect(tools).toContain("capcomd_echo_whoami");
    expect(host.contributions.get("cli", "mcp")?.plugin).toBe("front-mcp");
    expect(host.contributions.list("instructions").map((i) => i.plugin)).toEqual(["front-mcp", "echo"]);
  });

  test("a tool's arguments are an object schema; a command has a run function and usage lines", async () => {
    const host = new PluginHost({ capcomd: VERSION, kernel: [], emit: () => {}, dataDir: (n) => join(home, "data", n) });
    const m = (n: string) => ({ schema: "capcomd.plugin/v1", name: n, version: "1.0.0", description: "A test plugin.", apiVersion: 1, engines: { capcomd: ">=0.0.0" }, entry: { runtime: "in-process", module: "./index.ts" }, contributes: { mcp: [{ name: "t", summary: "A tool" }], cli: [{ name: n, summary: "A command" }] } });
    const run = async () => ({ schema: "relay.v1" as const, ok: true as const });
    await host.start([
      { source: "builtin", manifest: m("stringy"), module: { activate: (ctx) => { ctx.mcp.tool({ name: "t", description: "T", inputSchema: { type: "string" }, run }); } } as PluginModule<never> },
      { source: "builtin", manifest: m("usageless"), module: { activate: (ctx) => { ctx.cli.command({ name: "usageless", summary: "C", usage: undefined as never, run }); } } as PluginModule<never> },
    ]);
    expect(host.get("stringy")).toMatchObject({ state: "failed", cause: "activate_threw" });
    expect(host.message("stringy")).toContain('inputSchema is a JSON Schema of an object (type: "object"');
    expect(host.get("usageless")).toMatchObject({ state: "failed", cause: "activate_threw" });
  });

  test("every kernel command is registered once, by its group", async () => {
    const host = new PluginHost({ capcomd: VERSION, kernel: [], emit: () => {}, dataDir: (n) => join(home, "data", n) });
    await host.start(BUILTINS.filter((b) => b.kernelSurface).map(candidateOf));
    const commands = host.contributions.list("cli");
    expect(commands.map((c) => c.key).sort()).toEqual(KERNEL_COMMANDS.filter((c) => !(DISPATCHER_COMMANDS as readonly string[]).includes(c)).sort());
    expect(Object.fromEntries(commands.map((c) => [c.key, c.plugin]))).toMatchObject({ run: "front-run", spawn: "front-primitives", verify: "front-primitives", agents: "front-profiles", auth: "front-env", setup: "front-setup", mcp: "front-mcp", hermes: "front-hermes" });
    // Usage lines from the CLI's help, for `capcomd <command> --help`.
    expect(commands.find((c) => c.key === "merge")!.value.spec.usage[0]).toStartWith("capcomd merge <runId> --ref");
  });

  test("each group's module answers exactly the commands its front door declares", async () => {
    const modules: Record<string, string> = { "front-run": "run", "front-primitives": "primitives", "front-profiles": "profiles", "front-env": "env", "front-setup": "setup" };
    expect(FRONT_GROUPS.map((g) => g.manifest.name).sort()).toEqual(Object.keys(modules).sort());
    for (const g of FRONT_GROUPS) {
      const { COMMANDS } = await import(`../../src/cli/groups/${modules[g.manifest.name]}`);
      expect([g.manifest.name, Object.keys(COMMANDS).sort()]).toEqual([g.manifest.name, (g.manifest.contributes?.cli ?? []).map((c) => c.name).sort()]);
    }
  });

  test("a plugin command's flags: --k v, --k=v, a kernel flag keeps its type, a repeat is a list", () => {
    expect(parseLoose(["echo", "hi", "--channel", "general", "--json", "there", "--tag=a", "--tag", "b", "-y", "--force", "--", "--raw"])).toEqual({
      positionals: ["echo", "hi", "there", "--raw"], flags: { channel: "general", json: true, tag: ["a", "b"], yes: true, force: true },
    });
    expect(parseLoose(["--key", "-k1", "echo"]).flags).toEqual({ key: "-k1" });
  });
});

describe("a plugin's command answers with the envelope and the caller's principal (§4.7.1, §11.2)", () => {
  test("--json: the envelope as it is, run as the operator, with the plugin's own principal apart", () => {
    const r = cli("echo", "hello", "world", "--channel", "general", "--to", "x", "--json");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({
      schema: "relay.v1", ok: true, principal: { kind: "operator", clientId: null }, args: ["hello", "world"], flags: { channel: "general", to: "x" }, json: true,
      plugin: { kind: "plugin", name: "echo", scopes: [] }, text: "operator said: hello world",
    });
  });

  test("without --json: its text; a PluginError is the relay.v1 error with the matching exit code", () => {
    const r = cli("echo", "hi");
    expect(r).toMatchObject({ code: 0, out: "operator said: hi\n" });
    const missing = cli("echo", "missing", "thing", "--json");
    expect(missing.code).toBe(3);
    expect(JSON.parse(missing.out)).toEqual({ schema: "relay.v1", ok: false, error: { code: "not_found", message: "nothing called thing", hint: "Try `capcomd echo hello`.", reason: "plugin:echo" } });
    expect(cli("echo", "missing").err).toContain("✗ nothing called that");
    const bare = cli("echo", "bare", "--json");
    expect(bare.code).toBe(1);
    expect(JSON.parse(bare.out).error.message).toBe("the echo plugin's echo command didn't answer with a relay.v1 envelope");
  });

  test("--help: its usage; the whole help lists it under the plugins' commands", () => {
    expect(cli("echo", "--help")).toMatchObject({ code: 0, out: expect.stringContaining("Usage (the echo plugin):\n  capcomd echo [words…] [--flag value]") });
    const all = cli("--help");
    expect(all.out).toContain("capcomd serve");
    // After the built-ins' own plugin commands (capcomd context, the context router's).
    expect(all.out).toMatch(/Plugin commands:\n(?: {2}capcomd .+\n)* {2}capcomd echo\s+Say who called and what it was given {2}\(echo\)/);
    expect(all.out).toMatch(/ {2}capcomd context\s+The project's context \(ADR-025\): the brief a profile's agents start with, and lint.* {2}\(context\)/);
    // Without the plugin, the help is the kernel's and the built-ins' alone.
    const p = Bun.spawnSync([process.execPath, CLI, "--help"], { env: { ...childEnv(), CAPCOMD_TEST_PLUGINS: "" }, stdout: "pipe" });
    expect(p.stdout.toString()).not.toContain("capcomd echo");
    expect(p.stdout.toString()).toMatch(/Plugin commands:\n {2}capcomd context .*\(context\)\n\n$/);
  });

  test("a kernel command is the kernel's as before: its flags are checked, its output its own", () => {
    expect(cli("frobnicate")).toMatchObject({ code: 2, err: expect.stringContaining("unknown command: frobnicate") });
    expect(cli("status", "--bogus")).toMatchObject({ code: 2, err: expect.stringContaining("Unknown option '--bogus'") });
    const h = cli("hermes", "--json");
    expect(h.code).toBe(0);
    expect(JSON.parse(h.out)).toMatchObject({ schema: "relay.v1", ok: true, hermes: { found: expect.any(Boolean), ok: expect.any(Boolean) } });
  });
});

describe("a plugin's tool answers with the envelope and the driver's principal (§4.7.2, §11.2)", () => {
  let mcp: Client;
  beforeAll(async () => {
    mcp = new Client({ name: "front-doors-test", version: "0.0.1" });
    await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp"], cwd: home, stderr: "ignore", env: childEnv() }));
  }, 60_000);
  afterAll(async () => { await mcp?.close(); });

  test("listed with its JSON Schema beside capcomd's tools; its instructions under its name", async () => {
    const { tools } = await mcp.listTools();
    expect(tools.map((t) => t.name)).toEqual([...kernelTools().map((t) => `capcomd_${t.name}`), "capcomd_echo_whoami"]);
    expect(tools.find((t) => t.name === "capcomd_echo_whoami")).toMatchObject({ title: "Who am I", inputSchema: { type: "object", properties: { say: { type: "string", minLength: 1 } }, required: ["say"] }, annotations: { readOnlyHint: true } });
    const instructions = mcp.getInstructions() ?? "";
    expect(instructions).toStartWith("capcomd runs a team of coding agents for you");
    expect(instructions).toEndWith("\n\n## echo\nEcho answers with who called it.");
  });

  test("called: checked against its schema, extra arguments dropped, run as the driver", async () => {
    const res: any = await mcp.callTool({ name: "capcomd_echo_whoami", arguments: { say: "hi", sneaky: true } });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(res.content[0].text)).toEqual({ schema: "relay.v1", ok: true, principal: { kind: "driver", clientId: null }, args: { say: "hi" } });
    expect(res.structuredContent).toEqual(JSON.parse(res.content[0].text));
    const bad: any = await mcp.callTool({ name: "capcomd_echo_whoami", arguments: {} });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toContain("Input validation error");
    const refused: any = await mcp.callTool({ name: "capcomd_echo_whoami", arguments: { say: "fail" } });
    expect(refused.isError).toBe(true);
    expect(JSON.parse(refused.content[0].text)).toEqual({ schema: "relay.v1", ok: false, error: { code: "usage", message: "not for you", hint: "Ask the operator.", reason: "forbidden" } });
  });
});

describe("skill-orchestration: the orchestration skill as an agent.preparing patch (§6.6.7, step 8)", () => {
  const was = { ...skillKernel };
  afterAll(() => Object.assign(skillKernel, was));
  const limits = { allowSpawn: true, maxDepth: 1, maxChildren: 3, maxTotalDescendants: 6, allowedChildProfiles: ["worker"], budgetShare: 0.5 };
  const record = (o: Record<string, unknown> = {}) => ({ agentId: "agt-test1", parent: null, limits, budget: { usd: 4 }, spec: { provider: "claude" }, ...o }) as never;
  async function prepare(spec: Record<string, unknown>) {
    const fake = testkit.fakeContext(skillManifest);
    await testkit.load(fake, skillPlugin as PluginModule<Record<string, unknown>>);
    const p = samplePayload("agent.preparing");
    return (await fake.fire("agent.preparing", { ...p, spec: spec as never })).result;
  }

  test("an agent that may spawn gets the skill, pinned by its hash, written from its own limits and the run's goal branch", async () => {
    skillKernel.agent = async () => record();
    skillKernel.goal = async () => ({ branch: "capcomd/add-sum", base: "main" });
    const r = await prepare({ provider: "claude", auth: "subscription" });
    const skill = (r as { patch: { prompt: { skills: Array<{ name: string; hash: string; source: string; text: string }> } } }).patch.prompt.skills[0]!;
    expect(skill).toMatchObject({ name: SKILL_NAME, source: "builtin" });
    expect(skill.hash).toBe(skillHash(skill.text));
    expect(skill.text).toContain("# Orchestrating child agents (capcomd)");
    expect(skill.text).toContain("You are agent agt-test1.");
    expect(skill.text).toContain("maxChildren=3 running at once");
    expect(skill.text).toContain("Your merges land on capcomd/add-sum");
    expect(skill.text).toContain("You are the planner");
  });

  test("on the kernel's own call it reads the agent's record from the call, never the engine again", async () => {
    skillKernel.agent = was.agent;
    skillKernel.goal = async () => undefined;
    const p = samplePayload("agent.preparing");
    const r = await preparingAgent.run({ runId: p.agent.runId, agentId: p.agent.id, record: record({ agentId: p.agent.id }) }, () => prepare({ provider: "claude", auth: "subscription" }));
    const skill = (r as { patch: { prompt: { skills: Array<{ text: string }> } } }).patch.prompt.skills[0]!;
    expect(skill.text).toContain(`You are agent ${p.agent.id}.`);
  });

  test("an attempt no plugin prepared (its workflow resumed across an upgrade) still gets the skill, from the kernel", async () => {
    skillKernel.goal = async () => ({ branch: "capcomd/add-sum", base: "main" });
    const a = record();
    const text = await unpreparedSkill("run-none", a, null);
    // In its block, as a prepared attempt reads it (ADR-024 §7 step 5).
    expect(text).toStartWith(`<skill name="${SKILL_NAME}">\n`);
    expect(text).toEndWith("\n</skill>");
    expect(text).toContain("# Orchestrating child agents (capcomd)");
    expect(text).toContain("Your merges land on capcomd/add-sum");
    expect(await unpreparedSkill("run-none", a, { provider: "claude", skills: [{ name: SKILL_NAME }] })).toBeUndefined();
    // Prepared with only its profile's skills (no plugin attached it): the kernel's, still.
    expect(await unpreparedSkill("run-none", a, { provider: "claude", skills: [{ name: "tdd" }] })).toBe(text);
  });

  test("an agent that can't spawn, and a fake agent, get nothing", async () => {
    skillKernel.agent = async () => record({ limits: { ...limits, allowSpawn: false } });
    expect(await prepare({ provider: "claude", auth: "subscription" })).toEqual({ decision: "allow" });
    skillKernel.agent = async () => { throw new Error("a fake agent's record is never read"); };
    expect(await prepare({})).toEqual({ decision: "allow" });
  });

  test("it is a built-in every process loads, and fails closed: a spawner never starts without its skill", () => {
    const b = BUILTINS.find((x) => name(x) === "skill-orchestration")!;
    expect(b.everyProcess).toBe(true);
    expect(skillManifest.contributes?.hooks?.["agent.preparing"]).toEqual({ timeoutMs: 30_000, failure: "closed" });
  });
});
