// ADR-024 §7 step 8: the profile blocks that change where and with what an agent runs (`tools.mcp`,
// `sandbox.provider|environment|size`, `lifecycle.onStart|onEnd`): read from the resolved profile, checked, never
// reachable by an override, and what the runner, the adapters and the machine's boot make of them. The scenarios with
// scripted agents (tests/scenarios/profile-runtime.test.ts) cover spawn, the machine and the hooks.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { AGENTS_SCHEMA, applyOverrides, notApplied, pinnedMachine, pinnedRuntime, readProfiles, resolveAgent } from "../../src/profiles";
import { loadAgentConfig } from "../../src/agents/config";
import { claudeAdapter, codexAdapter } from "../../src/agents/adapters";
import { bootSnapshot, EnvironmentProblem, writeLedger } from "../../src/env/resolve";
import { FakeProvider } from "../../src/providers/fake";

/** A project (repo/.capcomd/) and a CAPCOMD_HOME (home/) with these files; `P/` is the project's profiles. */
function world(files: Record<string, string>, agents?: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), "capcomd-prof-rt-"));
  const dir = join(root, "repo", ".capcomd");
  mkdirSync(dir, { recursive: true });
  if (agents) writeFileSync(join(dir, "agents.json"), JSON.stringify({ schema: AGENTS_SCHEMA, agents }));
  const at = (rel: string) => join(root, rel.replace(/^P\//, "repo/.capcomd/profiles/"));
  for (const [rel, body] of Object.entries(files)) { mkdirSync(dirname(at(rel)), { recursive: true }); writeFileSync(at(rel), body); }
  const source = { CAPCOMD_HOME: join(root, "home"), CAPCOMD_AGENTS_FILE: join(dir, "agents.json") };
  return { root, source, load: () => readProfiles(source.CAPCOMD_AGENTS_FILE, source) };
}
const yaml = (lines: string[]) => lines.join("\n") + "\n";
const errorOf = (f: () => unknown) => { try { f(); } catch (e) { return (e as Error).message; } return ""; };

describe("the runtime blocks of a profile", () => {
  test("read from the resolved profile (extends and overrides laid first) and pinned beside the flat spec, not in it", () => {
    const w = world({
      "P/base.yaml": yaml([
        "name: base", "harness: { provider: claude, auth: subscription }",
        "tools:", "  mcp:", "    - { name: semgrep, command: [semgrep-mcp, --quiet] }", "    - { name: docs, command: [docs-mcp], trust: trusted }",
        "sandbox: { provider: fake-host, environment: image, size: { vcpu: 2 } }",
        "lifecycle: { onStart: [hook-recorder], onEnd: [hook-recorder, notes] }",
      ]),
      "P/child.yaml": yaml(["name: child", "extends: base", "sandbox: { size: { vcpu: 4 }, environment: null }", "lifecycle: { onStart: null }"]),
    });
    const set = w.load();
    expect(set.profiles.base!.runtime).toEqual({
      mcp: [{ name: "semgrep", command: ["semgrep-mcp", "--quiet"], trust: "untrusted" }, { name: "docs", command: ["docs-mcp"], trust: "trusted" }],
      sandboxProvider: "fake-host", environment: "image", size: { vcpu: 2 }, lifecycle: { onStart: ["hook-recorder"], onEnd: ["hook-recorder", "notes"] },
    });
    // A child replaces a value, merges a block one level, and removes with null, as for every block.
    expect(set.profiles.child!.runtime).toMatchObject({ sandboxProvider: "fake-host", size: { vcpu: 4 }, lifecycle: { onStart: [], onEnd: ["hook-recorder", "notes"] } });
    expect(set.profiles.child!.runtime.environment).toBeUndefined();
    // The flat spec (agents.json's shape) has none of them; nothing is "read but not used" any more.
    expect(set.agents.base).toEqual({ provider: "claude", auth: "subscription" });
    expect(set.warnings).toEqual([]);
    expect(notApplied(set.profiles.base!.manifest)).toEqual([]);
    expect(resolveAgent("base", w.source).runtime).toEqual(set.profiles.base!.runtime);
    // An agents.json profile has none.
    expect(world({}, { v1: { provider: "claude", auth: "apikey" } }).load().profiles.v1!.runtime).toEqual({});
  });

  test("checked: an orchestrate profile gets no MCP server, capcomd's own name is taken, plugins are named as plugins", () => {
    const lead = world({ "P/lead.yaml": yaml(["name: lead", "harness: { provider: claude, auth: apikey }", "tools: { mode: orchestrate, mcp: [{ name: x, command: [x] }] }", "children: { allowSpawn: true, allowedChildProfiles: [lead] }"]) });
    expect(errorOf(() => lead.load())).toContain("profiles.lead: tools.mcp: an orchestrate agent runs nothing");
    const taken = world({ "P/w.yaml": yaml(["name: w", "harness: { provider: claude, auth: apikey }", "tools: { mcp: [{ name: capcomd, command: [x] }] }"]) });
    expect(errorOf(() => taken.load())).toContain("capcomd is the name of capcomd's own server");
    const bad = world({ "P/w.yaml": yaml(["name: w", "harness: { provider: claude, auth: apikey }", "lifecycle: { onEnd: [Not A Plugin] }"]) });
    expect(errorOf(() => bad.load())).toContain("lifecycle.onEnd: must be a list of plugin names");
    const nowhere = world({ "P/w.yaml": yaml(["name: w", "harness: { provider: claude, auth: apikey }", "sandbox: { provider: nowhere }"]) });
    expect(errorOf(() => nowhere.load())).toContain(`sandbox.provider "nowhere" isn't an active sandbox provider`);
    // The fix names a command that exists: builds are listed by `capcomd env status` (there is no `env build --name`).
    const unnamed = world({ "P/w.yaml": yaml(["name: w", "harness: { provider: claude, auth: apikey }", "sandbox: { environment: Not.A.Build }"]) });
    expect(errorOf(() => unnamed.load())).toContain("sandbox.environment: must be default, image or a build's name (capcomd env status lists them)");
  });

  test("an override that makes a profile with MCP servers orchestrate is refused at spawn, and its CLI would get none", async () => {
    const w = world({ "P/w.yaml": yaml(["name: w", "harness: { provider: claude, auth: apikey }", "tools: { mcp: [{ name: docs, command: [docs-mcp], trust: trusted }] }"]) });
    const { encodeAgentRef } = await import("../../src/profiles");
    const { spawnChecks } = await import("../../src/primitives/ops");
    const ref = encodeAgentRef("w", { set: { toolMode: "orchestrate", children: { allowSpawn: true, allowedChildProfiles: ["w"] } }, operator: true });
    const saved = { home: process.env.CAPCOMD_HOME, file: process.env.CAPCOMD_AGENTS_FILE };
    Object.assign(process.env, w.source);
    try {
      expect(() => spawnChecks("w", { CAPCOMD_SANDBOX: "fake" })).not.toThrow();
      let err: any = null;
      try { spawnChecks(ref, { CAPCOMD_SANDBOX: "fake" }); } catch (e) { err = e; }
      expect(err).toMatchObject({ code: "config", reason: "orchestrate_mcp" });
      expect(err?.message).toContain("profiles.w: tools.mcp: an orchestrate agent runs nothing");
    } finally {
      for (const [k, v] of [["CAPCOMD_HOME", saved.home], ["CAPCOMD_AGENTS_FILE", saved.file]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
    // Pinned on an orchestrate agent anyway (a record made otherwise): its config has no servers.
    expect(loadAgentConfig({}, "w", { provider: "claude", auth: "apikey", kind: "claude-code", toolMode: "orchestrate", children: { allowSpawn: true, allowedChildProfiles: ["w"] }, mcp: [{ name: "docs", command: ["docs-mcp"], trust: "trusted" }] }).mcp).toBeUndefined();
  });

  test("no override reaches them: a parent can't add a server to its child or move it to another sandbox", () => {
    const base = { provider: "claude", auth: "apikey" } as const;
    for (const set of [{ "sandbox.provider": "fake-host" }, { sandbox: { provider: "fake-host" } }, { "tools.mcp": [{ name: "x", command: ["x"] }] }, { "lifecycle.onEnd": [] }, { sandboxProvider: "fake-host" }, { mcp: [] }])
      expect(() => applyOverrides("w", base, { set, operator: true })).toThrow("override invalid");
  });

  test("the pinned blocks are read defensively: what this capcomd can't read is left out", () => {
    expect(pinnedRuntime({ mcp: [{ name: "ok", command: ["a", "b"] }, { name: "Bad", command: ["x"] }, { name: "capcomd", command: ["x"] }, { name: "e", command: [] }, { name: "n", command: ["x", 1] }], sandboxProvider: "docker", environment: "../x", size: { vcpu: 3 }, lifecycle: { onEnd: ["p"] } }))
      .toEqual({ mcp: [{ name: "ok", command: ["a", "b"], trust: "untrusted" }], sandboxProvider: "docker", lifecycle: { onStart: [], onEnd: ["p"] } });
    expect(pinnedRuntime(null)).toEqual({});
    expect(pinnedMachine({ provider: "claude", sandboxProvider: "boxd", environment: "default", size: { vcpu: 8 }, mcp: [] })).toEqual({ sandbox: "boxd", environment: "default", size: { vcpu: 8 } });
  });
});

describe("sandbox.environment: what the machine boots from", () => {
  const ledger = () => {
    const path = join(mkdtempSync(join(tmpdir(), "capcomd-envs-")), "envs.json");
    const rec = (name: string) => ({ name, manifest: { schema: 1, pins: { claude: "1", codex: "1", node: "1" }, lockHash: "none", lockFile: "none", repo: "" }, versions: {}, builtAt: "2026-11-06T00:00:00Z", buildMs: 1, depsInstalled: false });
    writeLedger({ current: rec("capcomd-env-new"), history: [rec("capcomd-env-old"), rec("capcomd-env-new")] }, path);
    return { CAPCOMD_ENV_LEDGER: path, CAPCOMD_SANDBOX: "fake" };
  };

  test("default is the current build (a real agent's, as before); image the plain image; a build by its name", () => {
    const src = ledger();
    expect(bootSnapshot({ real: true }, src)).toBe("capcomd-env-new");
    expect(bootSnapshot({ environment: "default", real: true }, src)).toBe("capcomd-env-new");
    // A fake (scripted) agent boots an environment only when its profile names one, as before.
    expect(bootSnapshot({ real: false }, src)).toBeUndefined();
    expect(bootSnapshot({ environment: "image", real: true }, src)).toBeUndefined();
    expect(bootSnapshot({ environment: "capcomd-env-old", real: false }, src)).toBe("capcomd-env-old");
    expect(() => bootSnapshot({ environment: "capcomd-env-gone", real: true }, src)).toThrow(EnvironmentProblem);
    expect(errorOf(() => bootSnapshot({ environment: "capcomd-env-gone", real: true }, src))).toContain("isn't an environment of the fake sandbox (`capcomd env status --sandbox fake`");
  });

  test("a plan login kept in an image: its image, unless the profile names another environment (then refused)", () => {
    const src = ledger();
    const login = { agent: "claude-code", snapshot: "capcomd-auth-claude-new", env: "capcomd-env-new" };
    expect(bootSnapshot({ real: true, login }, src)).toBe("capcomd-auth-claude-new");
    expect(bootSnapshot({ environment: "capcomd-env-new", real: true, login }, src)).toBe("capcomd-auth-claude-new");
    expect(errorOf(() => bootSnapshot({ environment: "capcomd-env-old", real: true, login }, src))).toContain("the claude-code plan login is kept in an image made from the environment capcomd-env-new");
    expect(() => bootSnapshot({ environment: "image", real: true, login }, src)).toThrow(EnvironmentProblem);
    // A login in a host-bound secret (no image) goes with any environment.
    expect(bootSnapshot({ environment: "capcomd-env-old", real: true, login: { agent: "claude-code", env: "capcomd-env-new" } }, src)).toBe("capcomd-env-old");
  });
});

describe("tools.mcp: the agent's CLI gets the servers", () => {
  const servers = [{ name: "semgrep", command: ["semgrep-mcp", "--quiet"], trust: "untrusted" as const }, { name: "docs", command: ["docs-mcp"], trust: "trusted" as const }];
  const ctx = (cfg: any, more: Record<string, unknown> = {}) => ({ bin: "claude", repo: "/r", promptFile: "/p", jsonl: "/j", errFile: "/e", dir: "/w", cfg, ...more });
  const q = (s: string) => `'${s}'`;

  test("Claude Code reads them from one file with capcomd's own; Codex takes each as flags, a trusted one approved", () => {
    const cfg = loadAgentConfig({ CAPCOMD_AGENT: "claude-code", CAPCOMD_AUTH: "apikey" });
    expect(claudeAdapter.command(ctx(cfg, { mcp: { config: "/w/mcp.json", servers } }) as any, q)).toContain("--mcp-config '/w/mcp.json'");
    // capcomd's alone, as before, when the profile has none; both: the profile's file (it holds capcomd's too).
    expect(claudeAdapter.command(ctx(cfg, { capcomd: { cli: "/c", mcpConfig: "/w/capcomd-mcp.json" } }) as any, q)).toContain("--mcp-config '/w/capcomd-mcp.json'");
    const both = claudeAdapter.command(ctx(cfg, { capcomd: { cli: "/c", mcpConfig: "/w/capcomd-mcp.json" }, mcp: { config: "/w/mcp.json", servers } }) as any, q);
    expect(both.match(/--mcp-config/g)!.length).toBe(1);
    expect(both).toContain("--mcp-config '/w/mcp.json'");
    expect(claudeAdapter.command(ctx(cfg) as any, q)).not.toContain("--mcp-config");

    const cx = codexAdapter.command(ctx(loadAgentConfig({ CAPCOMD_AGENT: "codex", CAPCOMD_AUTH: "apikey" })) as any, q);
    expect(cx).not.toContain("mcp_servers");
    const withServers = codexAdapter.command(ctx(loadAgentConfig({ CAPCOMD_AGENT: "codex", CAPCOMD_AUTH: "apikey" }), { mcp: { config: "/w/mcp.json", servers } }) as any, q);
    expect(withServers).toContain(`-c 'mcp_servers.semgrep.command="semgrep-mcp"' -c 'mcp_servers.semgrep.args=["--quiet"]'`);
    expect(withServers).toContain(`-c 'mcp_servers.docs.command="docs-mcp"' -c 'mcp_servers.docs.args=[]' -c 'mcp_servers.docs.default_tools_approval_mode="approve"'`);
    expect(withServers).not.toContain("mcp_servers.semgrep.default_tools_approval_mode");
  });

  test("a real agent's config carries its pinned servers; the runner writes them with capcomd's, and says what is missing", async () => {
    // From the spec pinned at spawn (the daemon need not see the profile).
    const pinned = { provider: "claude", auth: "apikey", kind: "claude-code", mcp: servers };
    expect(loadAgentConfig({}, "w", pinned).mcp).toEqual(servers);
    expect(loadAgentConfig({ CAPCOMD_SPAWN_EXEC: "fake" }, "w", { ...pinned, mcp: undefined }).mcp).toBeUndefined();

    const { bareRepo } = await import("../merge/gitfixture");
    const { runClaudeCode } = await import("../../src/agents/claude-code");
    const { taskBranch } = await import("../../src/merge/config");
    const FAKE = new URL("./fake-claude.sh", import.meta.url).pathname;
    const VM_CLI = new URL("../../src/subagents/vm-cli.mjs", import.meta.url).pathname;
    const run = async (o: { allowed?: string; subagents?: boolean }) => {
      const r = await bareRepo();
      const workdir = mkdtempSync(join(tmpdir(), "capcomd-agent-mcp-"));
      const rpcDir = mkdtempSync(join(tmpdir(), "capcomd-rpcdir-"));
      const provider = new FakeProvider({ hostExec: true });
      const { id } = await provider.ensure({ idemKey: `t-${Math.random()}`, isolated: true, ttlSeconds: 60, egressAllow: [], labels: {} });
      await provider.waitReady(id, 1000);
      // `sh` is on every PATH: a server whose program is there isn't reported missing.
      const mcp = [...servers, { name: "shell", command: ["sh", "-c", "true"], trust: "untrusted" as const }];
      const cfg = { ...loadAgentConfig({ CAPCOMD_AGENT_WORKDIR: workdir, CAPCOMD_AGENT_CLAUDE_BIN: FAKE, CAPCOMD_AGENT_POLL_MS: "50", ...(o.allowed ? { CAPCOMD_AGENT_ALLOWED_TOOLS: o.allowed } : {}) }), mcp };
      const task = { runId: "r1", taskId: "task-1", epoch: 1, branch: taskBranch("r1", "task-1"), target: "main", repoUrl: r.bare, goal: "make the failing test pass" };
      const logs: string[] = [];
      await runClaudeCode(provider, id, task, cfg, { apiKey: "sk-ant-x", onLog: (l: string[]) => logs.push(...l), ...(o.subagents ? { subagents: { skill: "skill", cliSource: readFileSync(VM_CLI, "utf8"), rpcDir } } : {}) } as any);
      const W = join(workdir, "task-1-e1");
      return { argv: readFileSync(join(W, "argv.txt"), "utf8").split("\n"), W, logs, rpcDir };
    };
    const plain = await run({});
    const file = plain.argv[plain.argv.indexOf("--mcp-config") + 1]!;
    expect(file).toBe(join(plain.W, "mcp.json"));
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ mcpServers: { semgrep: { command: "semgrep-mcp", args: ["--quiet"] }, docs: { command: "docs-mcp", args: [] }, shell: { command: "sh", args: ["-c", "true"] } } });
    expect(plain.argv[plain.argv.indexOf("--permission-mode") + 1]).toBe("bypassPermissions");
    expect(plain.logs).toContain("[capcomd] MCP servers from its profile: semgrep, docs (trusted), shell");
    expect(plain.logs).toContain("[capcomd] not found in its sandbox: semgrep-mcp, docs-mcp (an MCP server's program must be in its environment)");

    // An allowlist gets the trusted server's tools (as capcomd's own), not the untrusted ones'; capcomd's server joins the file.
    const listed = await run({ allowed: "Read,Edit", subagents: true });
    expect(listed.argv[listed.argv.indexOf("--allowedTools") + 1]).toBe("Read,Edit,Bash(capcomd:*),mcp__capcomd,mcp__docs");
    const both = JSON.parse(readFileSync(listed.argv[listed.argv.indexOf("--mcp-config") + 1]!, "utf8")).mcpServers;
    expect(Object.keys(both)).toEqual(["semgrep", "docs", "shell", "capcomd"]);
    expect(both.capcomd).toMatchObject({ command: "node", args: [join(listed.rpcDir, "bin", "capcomd"), "mcp"] });
  }, 60_000);
});
