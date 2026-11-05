// Agent providers as plugins (docs/spec/plugin-api.md §7.3, §16.1, §17.2 step 4): the built-in agent-claude and
// agent-codex plugins register the `claude` and `codex` agent seams; a profile's provider is an active seam's name
// (an unknown or disabled one is refused at validation); the recorded CLI streams replay through each seam's `parse`
// and `outcome` (§14.2); and `toolMode: orchestrate` applies the provider's tool policy and can't be lifted.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginHost, type Candidate } from "../../packages/plugin/src/host/host";
import type { PluginContext, PluginModule } from "../../packages/plugin/src/context";
import type { AgentProvider, AgentRunState } from "../../packages/plugin/src/seams";
import { testkit } from "../../packages/plugin/src/testkit";
import { runAgentConformance } from "../../packages/plugin/src/agent-conformance";
import { adapterFor, claudeAdapter, codexAdapter } from "../../src/agents/adapters";
import { CLAUDE_CODE_VERSION, CODEX_VERSION, loadAgentConfig } from "../../src/agents/config";
import { AGENTS_SCHEMA, applyOverrides, providerDefaultEffort, providerEfforts, resolveAgent, validateFile, validateSpec, type AgentSpec } from "../../src/agents/profiles";
import { Redactor } from "../../src/agents/redact";
import { logins } from "../../src/api/settings";
import { claude } from "../../src/plugins/agent-claude";
import { codex } from "../../src/plugins/agent-codex";
import { agentProviderNames, agentSeam, useAgentSeams } from "../../src/plugins/agents";
import { BUILTINS } from "../../src/plugins/builtins";
import { VERSION } from "../../src/utils/self";

const ROOT = join(import.meta.dir, "..", "..");
const SESSIONS = join(ROOT, "packages", "agent-thread", "fixtures", "sessions");
const q = (s: string) => `'${s}'`;
const fresh = (): AgentRunState => ({ events: 0, turns: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, done: false });
const ctx = (cfg: ReturnType<typeof loadAgentConfig>) => ({ bin: "agent", repo: "/r", promptFile: "/p", jsonl: "/j", errFile: "/e", dir: "/w", cfg });

function host() {
  return new PluginHost({ capcomd: VERSION, kernel: [], emit: () => {}, dataDir: (n) => join(tmpdir(), "capcomd-agent-seams", n) });
}
const builtins = (): Candidate[] => BUILTINS.map((b) => ({ source: "builtin", manifest: b.manifest, module: b.module }));
function agentsFile(agents: Record<string, unknown>) {
  const path = join(mkdtempSync(join(tmpdir(), "capcomd-agent-seams-")), "agents.json");
  writeFileSync(path, JSON.stringify({ schema: AGENTS_SCHEMA, agents }));
  return path;
}

afterEach(() => useAgentSeams(null));

describe("the built-in agent plugins (§7.3, §17.1)", () => {
  test("agent-claude and agent-codex load in the host and register the claude and codex seams", async () => {
    const h = host();
    const listed = await h.start(builtins());
    expect(listed.filter((p) => p.name.startsWith("agent-")).map((p) => [p.name, p.state, p.seams])).toEqual([
      ["agent-claude", "active", [{ kind: "agent", name: "claude" }]],
      ["agent-codex", "active", [{ kind: "agent", name: "codex" }]],
    ]);
    useAgentSeams(h.contributions);
    expect(agentProviderNames()).toEqual(["claude", "codex"]);
    expect(agentSeam("claude")).toBe(claude);
    await h.stop();
    expect(agentProviderNames()).toEqual([]);
  });

  test("describe() carries what the PROVIDER_* tables and the version pins did", () => {
    expect(claude.describe()).toMatchObject({ name: "claude", label: "Claude Code", bin: "claude", npmPackage: "@anthropic-ai/claude-code", pinnedVersion: CLAUDE_CODE_VERSION, secretName: "ANTHROPIC_API_KEY", apiHost: "api.anthropic.com", efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: null, streamInput: true });
    expect(codex.describe()).toMatchObject({ name: "codex", label: "Codex", bin: "codex", npmPackage: "@openai/codex", pinnedVersion: CODEX_VERSION, secretName: "OPENAI_API_KEY", apiHost: "api.openai.com", efforts: ["minimal", "low", "medium", "high"], defaultEffort: "medium", streamInput: false });
    expect([providerEfforts("codex"), providerDefaultEffort("codex"), providerDefaultEffort("claude")]).toEqual([["minimal", "low", "medium", "high"], "medium", null]);
    // The runner's adapters are the seams, by the kinds capcomd has always used.
    expect([claudeAdapter.kind, codexAdapter.kind, adapterFor("claude-code").bin, adapterFor("codex").bin]).toEqual(["claude-code", "codex", "claude", "codex"]);
  });
});

describe("a profile's provider is an active seam's name (§7.1)", () => {
  test("an unknown provider is refused at validation, by `capcomd agents validate` too", () => {
    expect(validateSpec("x", { provider: "claude", auth: "apikey" })).toEqual([]);
    expect(validateSpec("x", { provider: "gemini", auth: "apikey" })).toEqual([`agents.x: provider "gemini" isn't an active agent provider (one of claude, codex; see \`capcomd plugins list\`)`]);
    const p = Bun.spawnSync([process.execPath, join(ROOT, "src", "cli", "index.ts"), "agents", "validate", "--json", "--spec", JSON.stringify({ provider: "gemini", auth: "apikey" })], {
      env: { ...process.env, CAPCOMD_HOME: mkdtempSync(join(tmpdir(), "capcomd-agent-seams-home-")), CAPCOMD_NO_CONFIG: "1" }, stdout: "pipe", stderr: "pipe",
    });
    expect(p.exitCode).toBe(2);
    expect(JSON.parse(p.stdout.toString())).toMatchObject({ ok: false, errors: [expect.stringContaining(`provider "gemini" isn't an active agent provider`)] });
  });

  test("in the daemon, a provider whose plugin is disabled is refused: at validation, at resolution and by the runner", async () => {
    const h = host();
    await h.start(builtins());
    useAgentSeams(h.contributions);
    await h.disable("agent-codex");
    expect(agentProviderNames()).toEqual(["claude"]);
    expect(validateSpec("cx", { provider: "codex", auth: "apikey" }).join()).toContain(`provider "codex" isn't an active agent provider (one of claude;`);
    expect(() => resolveAgent("cx", {}, { provider: "codex", auth: "apikey", kind: "codex" })).toThrow(`provider "codex" isn't an active agent provider`);
    expect(() => adapterFor("codex")).toThrow("isn't an active agent provider");
    // The Settings logins still list the built-in's login, bound to its API host.
    const scratch = mkdtempSync(join(tmpdir(), "capcomd-agent-seams-home-"));
    expect(logins({ CAPCOMD_HOME: scratch, CAPCOMD_CREDENTIALS: "secret" }, "boxd").find((l) => l.provider === "codex")).toMatchObject({ loggedIn: true, boundTo: "api.openai.com" });
    await h.enable("agent-codex");
    expect(agentProviderNames()).toEqual(["claude", "codex"]);
    await h.stop();
  });

  test("another plugin's agent seam is a provider like the built-ins", async () => {
    const echo: AgentProvider = {
      ...codex,
      describe: () => ({ ...codex.describe(), name: "echo", label: "Echo", bin: "echo-agent", efforts: ["low"], defaultEffort: null }),
      command: (c, quote) => `${quote(c.bin)} --model ${c.cfg.model ?? "-"} > ${quote(c.jsonl)}`,
    };
    const m = { schema: "capcomd.plugin/v1", name: "agent-echo", version: "1.0.0", description: "A test agent provider.", apiVersion: 1, engines: { capcomd: ">=0.0.0" }, entry: { runtime: "in-process", module: "./index.ts" }, provides: ["seam:agent/echo"], contributes: { seams: [{ kind: "agent", name: "echo" }] } };
    const h = host();
    await h.start([...builtins(), { source: "builtin", manifest: m, module: { activate: (c: PluginContext) => { c.seams.agent(echo); } } as PluginModule<never> }]);
    useAgentSeams(h.contributions);
    expect(agentProviderNames()).toEqual(["claude", "codex", "echo"]);
    expect(validateSpec("e", { provider: "echo", auth: "apikey", effort: "low" })).toEqual([]);
    expect(validateSpec("e", { provider: "echo", auth: "apikey", effort: "high" }).join()).toContain("effort must be one of low for provider echo");
    const path = agentsFile({ e: { provider: "echo", auth: "apikey", model: "m1" } });
    expect(resolveAgent("e", { CAPCOMD_AGENTS_FILE: path })).toMatchObject({ name: "e", kind: "echo" });
    const cfg = loadAgentConfig({ CAPCOMD_AGENTS_FILE: path, ECHO_API_KEY: "x" }, "e");
    const a = adapterFor("echo");
    expect([a.kind, a.bin, a.pinnedVersion(cfg)]).toEqual(["echo", "echo-agent", CODEX_VERSION]);
    expect(a.command(ctx(cfg), q)).toBe("'agent' --model m1 > '/j'");
    await h.stop();
  });
});

// §14.2: the test kit's agent suite, as every agent plugin runs it, with the recorded streams and their golden state.
const stream = (file: string) => readFileSync(join(SESSIONS, file), "utf8");
testkit.conformance.agent(() => claude, { name: "claude", streams: [
  { name: "claude-2.1.303", text: stream("claude-2.1.303.jsonl"), state: { done: true, turns: 9, costUsd: 0.42, stopReason: "success" }, outcome: { ok: true, stopReason: "success" } },
  { name: "claude-2.1.303-usage-limit", text: stream("claude-2.1.303-usage-limit.jsonl"), outcome: { ok: false } },
] });
testkit.conformance.agent(() => codex, { name: "codex", streams: [
  { name: "codex-0.163.0", text: stream("codex-0.163.0.jsonl"), state: { done: true, inputTokens: 1000, outputTokens: 150 } },
  { name: "codex-0.163.0-turn-failed", text: stream("codex-0.163.0-turn-failed.jsonl"), exitCode: 1, outcome: { ok: false, stopReason: "turn_failed" } },
] });

describe("the agent suite in `capcomd plugins validate --conformance` (§14)", () => {
  test("a built-in agent provider passes it; a policy that lets an orchestrator edit fails it", () => {
    const p = Bun.spawnSync([process.execPath, join(ROOT, "src", "cli", "index.ts"), "plugins", "validate", "agent-codex", "--conformance", "--json"], {
      env: { ...process.env, CAPCOMD_HOME: mkdtempSync(join(tmpdir(), "capcomd-agent-seams-home-")), CAPCOMD_NO_CONFIG: "1" }, stdout: "pipe", stderr: "pipe",
    });
    expect(p.exitCode).toBe(0);
    const v = JSON.parse(p.stdout.toString());
    const names = v.plugins[0].conformance.map((c: { name: string; ok: boolean; skipped: boolean }) => [c.name, c.ok, c.skipped]);
    expect(names).toContainEqual(["toolPolicies.orchestrate contains no edit or write tool (§16.1)", true, false]);
    expect(names.every(([, ok, skipped]: [string, boolean, boolean]) => ok && !skipped)).toBe(true);
    const loose: AgentProvider = { ...claude, describe: () => ({ ...claude.describe(), toolPolicies: { orchestrate: { allowed: ["Read", "Edit"], disallowed: [] } } }) };
    expect(runAgentConformance(loose, { name: "claude" }).find((r) => !r.ok)?.message).toBe("the orchestrate allowlist names Edit");
  });
});

describe("conformance: the recorded streams through parse and outcome (§7.3, §14.2)", () => {
  const replay = (p: AgentProvider, file: string, redact = (s: string) => s) => {
    const state = fresh();
    const lines = readFileSync(join(SESSIONS, file), "utf8").split("\n").filter(Boolean);
    const events = lines.map((l) => p.parse(l, redact, state, { credentialMode: "auto" }));
    return { state, events, lines };
  };

  test("claude: a finished session, and one stopped by its usage limit", () => {
    const ok = replay(claude, "claude-2.1.303.jsonl");
    expect(ok.events.every((e) => e !== null)).toBe(true);
    expect(ok.state).toMatchObject({ done: true, turns: 9, costUsd: 0.42, stopReason: "success" });
    expect(claude.outcome(ok.state, 0)).toEqual({ ok: true, stopReason: "success" });
    expect(claude.outcome(ok.state, 124)).toEqual({ ok: false, stopReason: "timeout" });
    const limited = replay(claude, "claude-2.1.303-usage-limit.jsonl");
    expect(limited.state.quota).toEqual({ message: "You've hit your limit · resets 4pm (UTC)", resetAt: 1761494400 * 1000 });
    expect(claude.outcome(limited.state, 0).ok).toBe(false);
    expect(claude.parse("{partial", (s) => s, fresh(), { credentialMode: "auto" })).toBeNull();
  });

  test("codex: a finished session, and a failed turn", () => {
    const all = replay(codex, "codex-0.163.0.jsonl");
    expect(all.events.every((e) => e !== null)).toBe(true);
    expect(all.state).toMatchObject({ done: true, inputTokens: 1000, outputTokens: 150, stopReason: "success" });
    // The recording has a stream reconnect ("error" event) mid-turn, which the provider counts as the run's error.
    expect(all.state.error).toContain("Reconnecting");
    const state = fresh();
    for (const l of all.lines.filter((l) => !l.startsWith('{"type":"error"'))) codex.parse(l, (s) => s, state, { credentialMode: "auto" });
    expect(codex.outcome(state, 0)).toEqual({ ok: true, stopReason: "success" });
    const failed = replay(codex, "codex-0.163.0-turn-failed.jsonl");
    expect(failed.state.quota?.message).toContain("usage limit");
    expect(codex.outcome(failed.state, 1)).toEqual({ ok: false, stopReason: "turn_failed" });
  });

  test("parse passes every string through the redact it is given, and a credential's key hides its value", () => {
    for (const p of [claude, codex]) {
      const seen: string[] = [];
      const line = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "key sk-ant-abcdefghijkl" }] }, item: { type: "agent_message", text: "key sk-ant-abcdefghijkl" }, api_token: "plain" });
      const ev = p.parse(line, (s) => { seen.push(s); return new Redactor().text(s); }, fresh(), { credentialMode: "auto" })!;
      expect(seen.length).toBeGreaterThan(0);
      expect(JSON.stringify(ev)).not.toContain("sk-ant-abcdefghijkl");
      expect(ev.raw.api_token).toBe("[REDACTED]");
    }
    // The runner's adapter hands the seam its Redactor's text, with the run's secrets in it.
    const ev = claudeAdapter.parse(JSON.stringify({ type: "result", result: "the secret-value-123 leaked" }), new Redactor(["secret-value-123"]), fresh(), {} as never)!;
    expect(ev.text).toBe("the [REDACTED] leaked");
  });

  test("command sends stdout to ctx.jsonl; guard stops at the limits", () => {
    const cfg = loadAgentConfig({ CAPCOMD_AGENTS_FILE: agentsFile({ c: { provider: "claude", auth: "apikey", maxTurns: 3 }, x: { provider: "codex", auth: "apikey", maxTurns: 3 } }), ANTHROPIC_API_KEY: "k", OPENAI_API_KEY: "k" }, "x");
    for (const a of [claudeAdapter, codexAdapter]) expect(a.command(ctx(cfg), q)).toContain(" > '/j' 2> '/e'");
    expect(codexAdapter.guard({ ...fresh(), turns: 4 }, cfg)).toContain("max_turns");
    expect(codexAdapter.guard({ ...fresh(), turns: 3 }, cfg)).toBeNull();
    // Claude Code enforces --max-turns itself.
    expect(claudeAdapter.guard({ ...fresh(), turns: 99 }, cfg)).toBeNull();
  });
});

describe("toolMode: orchestrate (§16.1)", () => {
  const PLANNER = { auth: "apikey", toolMode: "orchestrate", children: { allowSpawn: true, allowedChildProfiles: ["worker"] } };
  const WORKER = { provider: "claude", auth: "apikey" };

  test("validation: orchestrate needs children.allowSpawn; its children may execute", () => {
    expect(validateSpec("p", { provider: "claude", auth: "apikey", toolMode: "orchestrate" }).join()).toContain("toolMode orchestrate needs children.allowSpawn");
    expect(validateSpec("p", { provider: "claude", auth: "apikey", toolMode: "plan" }).join()).toContain(`toolMode must be "execute" or "orchestrate"`);
    expect(validateFile({ schema: AGENTS_SCHEMA, agents: { planner: { provider: "claude", ...PLANNER }, worker: { provider: "codex", auth: "apikey" } } })).toEqual([]);
  });

  test("the mode is a limit: an override can't give an orchestrate agent its tools back", () => {
    const base = { provider: "claude", ...PLANNER } as AgentSpec;
    expect(() => applyOverrides("planner", base, { set: { toolMode: "execute" } })).toThrow("toolMode orchestrate → execute");
    expect(applyOverrides("planner", base, { set: { toolMode: "execute" }, operator: true }).toolMode).toBe("execute");
    expect(applyOverrides("lead", { provider: "claude", auth: "apikey", children: { allowSpawn: true, allowedChildProfiles: ["worker"] } } as AgentSpec, { set: { toolMode: "orchestrate" } }).toolMode).toBe("orchestrate");
  });

  test("claude: reading and capcomd only, edit tools denied, no bypassPermissions", () => {
    const path = agentsFile({ planner: { provider: "claude", ...PLANNER, disallowedTools: ["WebFetch"] }, worker: { ...WORKER, disallowedTools: ["WebFetch"] } });
    const cfg = loadAgentConfig({ CAPCOMD_AGENTS_FILE: path, ANTHROPIC_API_KEY: "k" }, "planner");
    expect(cfg).toMatchObject({ toolMode: "orchestrate", allowedTools: ["Read", "Glob", "Grep", "LS", "Bash(capcomd:*)"], disallowedTools: ["WebFetch", "Edit", "Write", "MultiEdit", "NotebookEdit"] });
    const cmd = claudeAdapter.command(ctx(cfg), q);
    expect(cmd).toContain("--allowedTools 'Read,Glob,Grep,LS,Bash(capcomd:*)'");
    expect(cmd).toContain("--disallowedTools 'WebFetch,Edit,Write,MultiEdit,NotebookEdit'");
    expect(cmd).not.toContain("bypassPermissions");
    // A profile's own allowlist is narrowed to the policy, never widened by it.
    const narrowed = loadAgentConfig({ CAPCOMD_AGENTS_FILE: agentsFile({ p: { provider: "claude", ...PLANNER, allowedTools: ["Read", "Edit", "Bash(npm test:*)"] }, worker: { ...WORKER, allowedTools: ["Read"] } }), ANTHROPIC_API_KEY: "k" }, "p");
    expect(narrowed.allowedTools).toEqual(["Read"]);
    // The pinned spec the engine runs from carries the mode too.
    const pinned = loadAgentConfig({ ANTHROPIC_API_KEY: "k" }, "planner", { provider: "claude", ...PLANNER, kind: "claude-code" });
    expect(pinned.allowedTools).toEqual(["Read", "Glob", "Grep", "LS", "Bash(capcomd:*)"]);
  });

  test("codex: its sandbox is the limit, read-only whatever the profile asks", () => {
    const path = agentsFile({ planner: { provider: "codex", ...PLANNER, sandbox: "danger-full-access" }, worker: WORKER });
    const cfg = loadAgentConfig({ CAPCOMD_AGENTS_FILE: path, OPENAI_API_KEY: "k" }, "planner");
    expect(cfg).toMatchObject({ toolMode: "orchestrate", codexSandbox: "read-only" });
    expect(cfg.allowedTools).toBeUndefined();
    expect(codexAdapter.command(ctx(cfg), q)).toContain("--sandbox read-only");
  });

  test("an execute agent is unchanged", () => {
    const cfg = loadAgentConfig({ CAPCOMD_AGENTS_FILE: agentsFile({ w: { provider: "claude", auth: "apikey" } }), ANTHROPIC_API_KEY: "k" }, "w");
    expect([cfg.toolMode, cfg.allowedTools, cfg.disallowedTools]).toEqual([undefined, undefined, []]);
    expect(claudeAdapter.command(ctx(cfg), q)).toContain("--permission-mode bypassPermissions");
  });
});
