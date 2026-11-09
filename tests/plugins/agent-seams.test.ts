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
import { AGENTS_SCHEMA, applyOverrides, providerDefaultEffort, providerEfforts, resolveAgent, validateFile, validateSpec, type AgentSpec } from "../../src/profiles";
import { Redactor } from "../../src/agents/redact";
import { logins } from "../../src/api/settings";
import { claude, ORCHESTRATE_ALLOWED, ORCHESTRATE_DISALLOWED } from "../../src/plugins/agent-claude";
import { codex, codexDenyRules } from "../../src/plugins/agent-codex";
import { ORCHESTRATE_DENIED_COMMANDS } from "../../src/plugins/agent-common";
import { agentProviderNames, agentSeam, useAgentSeams } from "../../src/plugins/agents";
import { BUILTINS, candidateOf } from "../../src/plugins/builtins";
import { VERSION } from "../../src/utils/self";

const ROOT = join(import.meta.dir, "..", "..");
const SESSIONS = join(ROOT, "packages", "agent-thread", "fixtures", "sessions");
const q = (s: string) => `'${s}'`;
const fresh = (): AgentRunState => ({ events: 0, turns: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, done: false });
const ctx = (cfg: ReturnType<typeof loadAgentConfig>) => ({ bin: "agent", repo: "/r", promptFile: "/p", jsonl: "/j", errFile: "/e", dir: "/w", cfg });

function host() {
  return new PluginHost({ capcomd: VERSION, kernel: [], emit: () => {}, dataDir: (n) => join(tmpdir(), "capcomd-agent-seams", n) });
}
const builtins = (): Candidate[] => BUILTINS.map(candidateOf);
/** A Claude Code Bash rule: `Bash(<prefix>:*)` (the command's first words), `Bash(<exact>)`, or `*` as any text. */
interface Rule { text: string; prefix: boolean; wild: boolean }
const ruleOf = (t: string): Rule => {
  const body = t.slice("Bash(".length, -1);
  return body.endsWith(":*") ? { text: body.slice(0, -2), prefix: true, wild: false } : { text: body, prefix: false, wild: body.includes("*") };
};
function matchRule(r: Rule, cmd: string): boolean {
  if (r.wild) return new RegExp(`^${r.text.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(cmd);
  return r.prefix ? cmd === r.text || cmd.startsWith(`${r.text} `) : cmd === r.text;
}

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
    // The host's seam is the plugin's, its calls counted for its stats (§13.5).
    expect(agentSeam("claude")!.describe()).toEqual(claude.describe());
    expect(agentSeam("claude")!.baseEnv()).toEqual(claude.baseEnv());
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
  { name: "codex-0.163.0", text: stream("codex-0.163.0.jsonl"), state: { done: true, inputTokens: 1000, outputTokens: 150 }, outcome: { ok: true, stopReason: "success" } },
  { name: "codex-0.166.0", text: stream("codex-0.166.0.jsonl"), state: { done: true, turns: 1 }, outcome: { ok: true, stopReason: "success" } },
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
    // With no allowlist: a read-only sandbox, or command rules that refuse at least commits and pushes.
    const open: AgentProvider = { ...codex, describe: () => ({ ...codex.describe(), toolPolicies: { orchestrate: { allowed: [], disallowed: [], denyCommands: ["bun test"] } } }) };
    expect(runAgentConformance(open, { name: "codex" }).find((r) => !r.ok)?.message).toContain("needs sandbox \"read-only\" or denyCommands that refuse git commit and git push");
    expect(runAgentConformance(codex, { name: "codex" }).every((r) => r.ok)).toBe(true);
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
    // The recording has a stream reconnect ("error" event) mid-turn; the turn then completed, so the run succeeded.
    expect(all.state.error).toBeUndefined();
    expect(codex.outcome(all.state, 0)).toEqual({ ok: true, stopReason: "success" });
    expect(all.events.find((e) => e?.type === "error")?.text).toContain("Reconnecting");
    const failed = replay(codex, "codex-0.163.0-turn-failed.jsonl");
    expect(failed.state.quota?.message).toContain("usage limit");
    expect(codex.outcome(failed.state, 1)).toEqual({ ok: false, stopReason: "turn_failed" });
    const v166 = replay(codex, "codex-0.166.0.jsonl");
    expect(v166.events.every((e) => e !== null)).toBe(true);
    expect(v166.state).toMatchObject({ done: true, turns: 1, inputTokens: 37293, outputTokens: 46, resultText: "ok" });
    expect(codex.outcome(v166.state, 0)).toEqual({ ok: true, stopReason: "success" });
  });

  test("codex: a reconnect the turn recovers from is not a failure; a final error or a failed turn still is", () => {
    const run = (...events: object[]) => {
      const state = fresh();
      for (const e of events) codex.parse(JSON.stringify(e), (s) => s, state, { credentialMode: "auto" });
      return { state, out: codex.outcome(state, 0) };
    };
    const started = [{ type: "thread.started", thread_id: "t" }, { type: "turn.started" }];
    const reconnect = { type: "error", message: "Reconnecting... 1/5 (stream disconnected before completion)" };
    const completed = { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } };
    const recovered = run(...started, reconnect, { type: "error", message: "Reconnecting... waiting for network" }, completed);
    expect(recovered.out).toEqual({ ok: true, stopReason: "success" });
    expect([recovered.state.error, recovered.state.done]).toEqual([undefined, true]);
    // An error the stream ends on (codex gave up) fails the run, with its text.
    const gaveUp = run(...started, reconnect, { type: "error", message: "exceeded retry limit, last status: 503" });
    expect(gaveUp.out).toEqual({ ok: false, stopReason: "error" });
    expect(gaveUp.state.error).toBe("exceeded retry limit, last status: 503");
    // A critical error: codex prints it as `error`, then fails the turn. A turn.failed stays final.
    const critical = run(...started, { type: "error", message: "boom" }, { type: "turn.failed", error: { message: "boom" } }, { type: "error", message: "Reconnecting... 1/5" }, completed);
    expect(critical.out).toEqual({ ok: false, stopReason: "turn_failed" });
    expect(critical.state.error).toBe("boom");
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

  test("claude: the read tools, capcomd and read-only commands allowed; edits and the commands that change or run code denied; no bypassPermissions", () => {
    const path = agentsFile({ planner: { provider: "claude", ...PLANNER, disallowedTools: ["WebFetch"] }, worker: { ...WORKER, disallowedTools: ["WebFetch"] } });
    const cfg = loadAgentConfig({ CAPCOMD_AGENTS_FILE: path, ANTHROPIC_API_KEY: "k" }, "planner");
    expect(cfg.toolMode).toBe("orchestrate");
    expect(cfg.allowedTools).toEqual([...ORCHESTRATE_ALLOWED]);
    expect(cfg.disallowedTools).toEqual(["WebFetch", ...ORCHESTRATE_DISALLOWED]);
    for (const t of ["Read", "Glob", "Grep", "LS", "Bash(capcomd:*)", "Bash(git fetch:*)", "Bash(git log:*)", "Bash(git show:*)", "Bash(git diff:*)", "Bash(git status:*)", "Bash(git branch -a:*)", "Bash(git ls-tree:*)", "Bash(git rev-parse:*)", "Bash(git blame:*)", "Bash(git switch --detach:*)", "Bash(git branch)"])
      expect(cfg.allowedTools).toContain(t);
    for (const t of ["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash(git commit:*)", "Bash(git push:*)", "Bash(git merge:*)", "Bash(git rebase:*)", "Bash(bun test:*)", "Bash(bun run:*)", "Bash(bun install:*)", "Bash(npm:*)", "Bash(git fetch *--upload-pack*)"])
      expect(cfg.disallowedTools).toContain(t);
    expect(cfg.disallowedTools).not.toContain("Bash");
    const cmd = claudeAdapter.command(ctx(cfg), q);
    expect(cmd).toContain(`--allowedTools '${ORCHESTRATE_ALLOWED.join(",")}'`);
    expect(cmd).toContain(`--disallowedTools 'WebFetch,${ORCHESTRATE_DISALLOWED.join(",")}'`);
    expect(cmd).not.toContain("bypassPermissions");
    // A profile's own allowlist is narrowed to the policy, never widened by it.
    const narrowed = loadAgentConfig({ CAPCOMD_AGENTS_FILE: agentsFile({ p: { provider: "claude", ...PLANNER, allowedTools: ["Read", "Edit", "Bash(npm test:*)"] }, worker: { ...WORKER, allowedTools: ["Read"] } }), ANTHROPIC_API_KEY: "k" }, "p");
    expect(narrowed.allowedTools).toEqual(["Read"]);
    // The pinned spec the engine runs from carries the mode too.
    const pinned = loadAgentConfig({ ANTHROPIC_API_KEY: "k" }, "planner", { provider: "claude", ...PLANNER, kind: "claude-code" });
    expect(pinned.allowedTools).toEqual([...ORCHESTRATE_ALLOWED]);
  });

  test("claude: no deny rule swallows an allowed command (a deny outranks every allow)", () => {
    const allows = ORCHESTRATE_ALLOWED.filter((t) => t.startsWith("Bash(")).map(ruleOf);
    const denies = ORCHESTRATE_DISALLOWED.filter((t) => t.startsWith("Bash(")).map(ruleOf);
    for (const d of denies) for (const a of allows) {
      // A deny prefix that starts an allowed prefix (word by word) would refuse every command the allow names.
      if (!d.wild) expect(`${a.text} `.startsWith(`${d.text} `)).toBe(false);
      else expect(matchRule(d, a.text)).toBe(false);
    }
  });

  // Every allowed and refused case of §16.1, through Claude Code's rule semantics as the live probe (claude 2.1.303,
  // Docker, 2026-11-05) showed them: a compound line runs only when each command in it is allowed and none denied; a
  // command no rule names is refused (headless, allowlist mode). claude also refuses, by itself, a command whose
  // shell variables or nested commands it can't check (`id=$(capcomd spawn …); capcomd await $id`).
  test.each([
    ["git fetch origin", true], ["git fetch -q origin goal && git log --oneline -3 origin/goal", true], ["git log --oneline | head -5", true],
    ["git show origin/goal:src/b.ts", true], ["git diff origin/main origin/goal --stat", true], ["git status", true], ["git branch -a", true], ["git branch", true],
    ["git ls-tree -r --name-only origin/goal", true], ["git rev-parse HEAD origin/goal", true], ["git blame src/a.ts | head -3", true],
    ["git grep -n world origin/goal", true], ["git switch --detach origin/goal && ls src", true], ["ls src && cat src/a.ts", true],
    ["capcomd await agt-1 && capcomd verify --ref agt-1", true], ["capcomd spawn --task \"x y\" --key p2", true], ["capcomd logs agt-1 --tail 50", true],
    ["capcomd fetch main", true], ["capcomd events --after 3", true], ["capcomd inspect agt-1", true],
    ["git commit --allow-empty -m x", false], ["git push origin HEAD:main", false], ["git merge origin/goal", false], ["git rebase origin/main", false],
    ["git reset --hard HEAD~1", false], ["git stash", false], ["git checkout -b newbranch", false], ["git branch -D main", false], ["git pull", false],
    ["bun test", false], ["bun run build", false], ["npm install left-pad", false], ["bunx tsc --noEmit", false], ["cd /tmp && bun test", false],
    ["touch notes2.txt", false], ["rm README.md", false], ["sed -i s/readme/x/ README.md", false], ["make", false], ["node src/cli.ts", false],
    ["git fetch --upload-pack='touch /tmp/x' origin", false], ["git fetch origin --upload-pack='touch /tmp/x'", false], ["git log --output=/tmp/x -1", false],
    ["git diff --output=/tmp/x origin/main", false], ["git grep -O'touch /tmp/x' world origin/goal", false], ["git -c core.pager=x log -1", false],
  ])("claude orchestrate: %s → allowed %p", (line, allowed) => {
    const allows = ORCHESTRATE_ALLOWED.filter((t) => t.startsWith("Bash(")).map(ruleOf);
    const denies = ORCHESTRATE_DISALLOWED.filter((t) => t.startsWith("Bash(")).map(ruleOf);
    const parts = line.split(/\s*(?:&&|\|\||;|\|)\s*/).filter(Boolean).map((p) => (p.startsWith("cd ") ? null : p)).filter((p): p is string => p !== null);
    const ok = parts.every((p) => allows.some((a) => matchRule(a, p)) && !denies.some((d) => matchRule(d, p)));
    expect(ok).toBe(allowed);
  });

  test("codex: command rules forbid what changes or runs code; its sandbox stays the agent's (read-only can't fetch, nor start in Docker); capcomd's tools approved", () => {
    const path = agentsFile({ planner: { provider: "codex", ...PLANNER, sandbox: "danger-full-access" }, worker: WORKER });
    const cfg = loadAgentConfig({ CAPCOMD_AGENTS_FILE: path, OPENAI_API_KEY: "k" }, "planner");
    expect(cfg).toMatchObject({ toolMode: "orchestrate", codexSandbox: "danger-full-access", denyCommands: [...ORCHESTRATE_DENIED_COMMANDS] });
    expect(cfg.allowedTools).toBeUndefined();
    const cmd = codexAdapter.command({ ...ctx(cfg), capcomd: { cli: "/rpc/bin/capcomd", mcpConfig: "/w/mcp.json" } }, q);
    expect(cmd).toContain("--sandbox danger-full-access");
    expect(cmd).not.toContain("--sandbox read-only");
    // The rules are written where codex reads user rules, before it starts.
    expect(cmd.indexOf("capcomd-orchestrate.rules")).toBeLessThan(cmd.indexOf(" exec --json"));
    expect(cmd).toContain(`mkdir -p "\${CODEX_HOME:-$HOME/.codex}/rules"`);
    expect(cmd).toContain(`'mcp_servers.capcomd.default_tools_approval_mode="approve"'`);
    // `bash -c`, not `bash -lc`: a login shell's /etc/profile resets PATH (capcomd, bun: "command not found" in Docker).
    expect(cmd).toContain(" -c allow_login_shell=false");
    // An execute codex agent gets no rules.
    const exec = loadAgentConfig({ CAPCOMD_AGENTS_FILE: agentsFile({ w: { provider: "codex", auth: "apikey" } }), OPENAI_API_KEY: "k" }, "w");
    expect(codexAdapter.command(ctx(exec), q)).not.toContain("rules");
    // A profile that asks for a read-only sandbox keeps it (the policy never loosens a sandbox).
    const ro = loadAgentConfig({ CAPCOMD_AGENTS_FILE: agentsFile({ planner: { provider: "codex", ...PLANNER, sandbox: "read-only" }, worker: { ...WORKER, sandbox: "read-only" } }), OPENAI_API_KEY: "k" }, "planner");
    expect(ro.codexSandbox).toBe("read-only");
  });

  test("codex: the rules file is codex execpolicy, one forbidden prefix rule per denied command", () => {
    const rules = codexDenyRules(["git push", "bun test"]);
    expect(rules.split("\n").filter(Boolean)).toEqual([
      expect.stringMatching(/^prefix_rule\(pattern = \["git","push"\], decision = "forbidden", justification = ".*capcomd orchestrate mode.*"\)$/),
      expect.stringMatching(/^prefix_rule\(pattern = \["bun","test"\], decision = "forbidden", justification = ".*"\)$/),
    ]);
    // Everything §16.1 refuses that a command's first words name; what it allows isn't (codex 0.163/0.166
    // `execpolicy check`, and the live probe in the codex image: push, commit, merge, bun test, `cd x && bun test` refused).
    const denied = (line: string) => ORCHESTRATE_DENIED_COMMANDS.some((d) => `${line} `.startsWith(`${d} `));
    for (const c of ["git push origin HEAD:main", "git commit -m x", "git merge origin/goal", "git rebase main", "bun test", "bun run build", "npm install x", "bun install", "make", "rm -rf src"]) expect(denied(c)).toBe(true);
    for (const c of ["git fetch origin", "git log --oneline", "git show origin/goal:src/b.ts", "git diff a b", "git status", "capcomd spawn --task x", "capcomd fetch", "ls src", "cat README.md"]) expect(denied(c)).toBe(false);
  });

  test("codex: a refused command, which codex 0.163 reports only on stderr, is read from its log line", () => {
    const line = '2026-11-05T19:13:04.307231Z ERROR codex_core::tools::router: error=exec_command failed: CreateProcess { message: "Rejected(\\"`/bin/bash -lc \'git push origin HEAD:main\'` rejected: capcomd orchestrate mode: this agent sees everything and runs nothing that changes or runs code.\\")" }';
    expect(codex.refusal!(line, (s) => s)).toEqual({ call: 'command "git push origin HEAD:main"', reason: "capcomd orchestrate mode: this agent sees everything and runs nothing that changes or runs code." });
    expect(codex.refusal!("2026-11-05T19:13:04Z INFO codex_core: started", (s) => s)).toBeNull();
    expect(claude.refusal).toBeUndefined();
  });

  test("an execute agent is unchanged", () => {
    const cfg = loadAgentConfig({ CAPCOMD_AGENTS_FILE: agentsFile({ w: { provider: "claude", auth: "apikey" } }), ANTHROPIC_API_KEY: "k" }, "w");
    expect([cfg.toolMode, cfg.allowedTools, cfg.disallowedTools]).toEqual([undefined, undefined, []]);
    expect(claudeAdapter.command(ctx(cfg), q)).toContain("--permission-mode bypassPermissions");
  });
});
