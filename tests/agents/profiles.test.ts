import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { validateSpec, validateFile, resolveAgent, parseAgentDirective, readAgentsFile, AGENTS_JSON_SCHEMA, AGENTS_SCHEMA } from "../../src/agents/profiles";
import { loadAgentConfig, agentFromEnv } from "../../src/agents/config";
import { claudeAdapter, codexAdapter } from "../../src/agents/adapters";

const CLI = new URL("../../src/cli/index.ts", import.meta.url).pathname;
const cli = (args: string[], env: Record<string, string>) => {
  const p = Bun.spawnSync(["bun", CLI, ...args], { env: { ...process.env, ...env } as any });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
};
function file(agents: Record<string, unknown>, def?: string) {
  const path = join(mkdtempSync(join(tmpdir(), "capcomd-agents-")), "agents.json");
  writeFileSync(path, JSON.stringify({ schema: AGENTS_SCHEMA, ...(def ? { default: def } : {}), agents }));
  return path;
}

describe("agent profiles", () => {
  test("validation: provider + exactly one auth; unknown fields and bad limits rejected", () => {
    expect(validateSpec("ok", { provider: "claude", auth: "subscription", model: "sonnet", maxTurns: 5 })).toEqual([]);
    expect(validateSpec("n", { provider: "codex" }).join()).toContain("neither is configured");
    expect(validateSpec("b", { provider: "codex", auth: "apikey", apiKey: "x", subscription: true }).join()).toContain("both an API key and a subscription");
    expect(validateSpec("l", { provider: "codex", subscription: true }).join()).toContain('use auth: "subscription"');
    expect(validateSpec("x", { provider: "gpt", auth: "apikey" }).join()).toContain("provider");
    expect(validateSpec("x", { provider: "codex", auth: "apikey", egress: [] }).join()).toContain("must not be empty");
    expect(validateSpec("x", { provider: "codex", auth: "apikey", maxTurns: 0, sandbox: "yolo", temperature: 1 }).length).toBe(3);
    expect(validateSpec("Bad Name", { provider: "codex", auth: "apikey" }).join()).toContain("name must match");
    expect(validateFile({ schema: AGENTS_SCHEMA, default: "missing", agents: {} }).join()).toContain("not a defined agent");
    expect(AGENTS_JSON_SCHEMA.$defs.agent.required).toEqual(["provider", "auth"]);
    expect(() => readAgentsFile(file({ bad: { provider: "claude" } }))).toThrow("neither is configured");
  });

  test("resolution: explicit name → CAPCOMD_AGENT (kind or profile) → file default → fake", () => {
    const path = file({ fast: { provider: "claude", auth: "subscription" }, cx: { provider: "codex", auth: "apikey" } }, "fast");
    const src = { CAPCOMD_AGENTS_FILE: path };
    expect(resolveAgent(undefined, src)).toMatchObject({ name: "fast", kind: "claude-code" });
    expect(resolveAgent("cx", src)).toMatchObject({ name: "cx", kind: "codex" });
    expect(resolveAgent(undefined, { ...src, CAPCOMD_AGENT: "cx" })).toMatchObject({ name: "cx" });
    expect(resolveAgent(undefined, { ...src, CAPCOMD_AGENT: "codex" })).toMatchObject({ name: null, kind: "codex" });
    expect(() => resolveAgent("nope", src)).toThrow('unknown agent profile "nope"');
    expect(agentFromEnv({ CAPCOMD_AGENTS_FILE: join(tmpdir(), "none-xyz.json") })).toBe("fake");
    expect(parseAgentDirective("[agent:cx] make it pass")).toEqual({ agent: "cx", goal: "make it pass" });
    expect(parseAgentDirective("make it pass")).toEqual({ goal: "make it pass" });
  });

  test("profile fields drive the harness config; env stays an override; auth is strict", () => {
    const path = file({
      cx: { provider: "codex", auth: "apikey", model: "gpt-5-codex", maxTurns: 7, maxBudgetUsd: 0.5, timeoutMs: 60000, sandbox: "danger-full-access", egress: ["github.com", "api.openai.com"], systemPrompt: "SYS", appendSystemPrompt: "APP", allowedTools: ["Read"], disallowedTools: ["WebFetch"] },
      sub: { provider: "claude", auth: "subscription" },
    });
    const c = loadAgentConfig({ CAPCOMD_AGENTS_FILE: path, OPENAI_API_KEY: "sk-proj-x" }, "cx");
    expect(c).toMatchObject({ profile: "cx", model: "gpt-5-codex", maxTurns: 7, maxBudgetUsd: 0.5, timeoutMs: 60000, codexSandbox: "danger-full-access", egress: ["github.com", "api.openai.com"], systemPrompt: "SYS", appendSystemPrompt: "APP", allowedTools: ["Read"], disallowedTools: ["WebFetch"], credentialMode: "auto" });
    expect(loadAgentConfig({ CAPCOMD_AGENTS_FILE: path, CAPCOMD_AGENT_MAX_TURNS: "3" }, "cx").maxTurns).toBe(3);
    // Profile says subscription: a local API key does not change that (no fallback either way).
    expect(loadAgentConfig({ CAPCOMD_AGENTS_FILE: path, ANTHROPIC_API_KEY: "sk-ant-x" }, "sub").credentialMode).toBe("subscription");
    const sf = "/w/system.txt", af = "/w/append.txt";
    const cmd = claudeAdapter.command({ bin: "claude", repo: "/r", promptFile: "/p", jsonl: "/j", errFile: "/e", dir: "/w", cfg: c, systemFile: sf, appendSystemFile: af }, (s) => `'${s}'`);
    expect(cmd).toContain(`--system-prompt "$(cat '${sf}')"`);
    expect(cmd).toContain(`--append-system-prompt "$(cat '${af}')"`);
    expect(codexAdapter.command({ bin: "codex", repo: "/r", promptFile: "/p", jsonl: "/j", errFile: "/e", dir: "/w", cfg: c }, (s) => `'${s}'`)).toContain("-m 'gpt-5-codex'");
  });

  test("CLI: agents add/set/list/show/rm/schema/validate with --json (orchestrator-friendly)", () => {
    const path = join(mkdtempSync(join(tmpdir(), "capcomd-agcli-")), "agents.json");
    const env = { CAPCOMD_AGENTS_FILE: path, ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "" };
    const add = cli(["agents", "add", "reviewer", "--json", "--spec", JSON.stringify({ provider: "claude", auth: "apikey", model: "opus", appendSystemPrompt: "Be terse." })], env);
    expect(add.code).toBe(0);
    expect(JSON.parse(add.out)).toMatchObject({ ok: true, name: "reviewer", default: true });
    expect(cli(["agents", "add", "cx", "--provider", "codex", "--auth", "subscription", "--max-turns", "12", "--egress", "github.com,chatgpt.com"], env).code).toBe(0);
    expect(cli(["agents", "set", "cx", "--model", "gpt-5-codex", "--unset", "egress", "--default"], env).code).toBe(0);
    const list = JSON.parse(cli(["agents", "list", "--json"], env).out);
    expect(list.default).toBe("cx");
    expect(list.agents.map((a: any) => [a.name, a.provider, a.auth, a.ready])).toEqual([["reviewer", "claude", "apikey", false], ["cx", "codex", "subscription", false]]);
    const f = JSON.parse(readFileSync(path, "utf8"));
    expect(f.agents.cx).toEqual({ provider: "codex", auth: "subscription", maxTurns: 12, model: "gpt-5-codex" });
    const bad = cli(["agents", "add", "x", "--provider", "codex", "--json"], env);
    expect(bad.code).toBe(2);
    expect(bad.out + bad.err).toContain("neither is configured");
    expect(cli(["agents", "validate", "--json", "--spec", '{"provider":"codex","auth":"apikey"}'], env).code).toBe(0);
    expect(JSON.parse(cli(["agents", "schema", "--json"], env).out).$defs.agent.required).toEqual(["provider", "auth"]);
    expect(JSON.parse(cli(["agents", "show", "reviewer", "--json"], env).out).spec.model).toBe("opus");
    expect(JSON.parse(cli(["agents", "rm", "cx", "--json"], env).out)).toMatchObject({ removed: "cx", default: "reviewer" });
  }, 30_000);
});

import { validateChildren, widenings, applyOverrides, parseSetPairs, encodeAgentRef, decodeAgentRef, effectiveAgentRecord } from "../../src/agents/profiles";

describe("children policy + narrowing overrides", () => {
  const parent = { provider: "claude", auth: "subscription", maxTurns: 20, maxBudgetUsd: 2, egress: ["github.com", "api.anthropic.com"], allowedTools: ["Read", "Edit", "Bash(npm test:*)"], disallowedTools: ["WebFetch"], sandbox: "workspace-write",
    children: { allowSpawn: true, maxDepth: 2, maxChildren: 3, maxTotalDescendants: 6, allowedChildProfiles: ["worker"], budgetShare: 0.5 } } as const;
  const worker = { provider: "codex", auth: "subscription", maxTurns: 10, maxBudgetUsd: 1, egress: ["github.com"], allowedTools: ["Read"], disallowedTools: ["WebFetch", "WebSearch"], sandbox: "read-only" } as const;

  test("children block validation", () => {
    expect(validateSpec("p", parent)).toEqual([]);
    expect(validateChildren("p", { allowSpawn: true })).toEqual(["agents.p.children: allowSpawn requires at least one allowedChildProfiles entry"]);
    expect(validateChildren("p", { maxDepth: 0, budgetShare: 1.5, maxChildren: 9, maxTotalDescendants: 2, spawnAll: true }).length).toBe(4);
    expect(validateChildren("p", { allowedChildProfiles: ["a", "a"] }).join()).toContain("duplicates");
    expect(AGENTS_JSON_SCHEMA.$defs.children.properties.allowSpawn.default).toBe(false);
  });

  test("file level: child profiles must exist and be no wider than the parent", () => {
    expect(validateFile({ schema: AGENTS_SCHEMA, agents: { parent, worker } })).toEqual([]);
    expect(validateFile({ schema: AGENTS_SCHEMA, agents: { parent } }).join()).toContain('"worker" is not a defined agent');
    const wide = { ...worker, maxTurns: 50, egress: ["github.com", "evil.com"], sandbox: "danger-full-access", disallowedTools: [] };
    const errs = validateFile({ schema: AGENTS_SCHEMA, agents: { parent, worker: wide } }).join();
    for (const x of ["maxTurns 50 > 20", "egress adds evil.com", "sandbox workspace-write → danger-full-access", "disallowedTools drops WebFetch"]) expect(errs).toContain(x);
  });

  test("overrides: --set pairs / JSON narrow only; widening needs --operator; ref round-trips", () => {
    expect(parseSetPairs(["children.maxDepth=1", "maxTurns=5", "egress=github.com", "model=opus"])).toEqual({ children: { maxDepth: 1 }, maxTurns: 5, egress: ["github.com"], model: "opus" });
    expect(() => parseSetPairs(["nokey"])).toThrow("key=value");
    const narrowed = applyOverrides("parent", parent as any, { set: { maxTurns: 5, children: { maxDepth: 1, maxChildren: 1 }, egress: ["github.com"] } });
    expect(narrowed).toMatchObject({ maxTurns: 5, egress: ["github.com"], children: { maxDepth: 1, maxChildren: 1, maxTotalDescendants: 6, allowSpawn: true } });
    for (const [set, msg] of [
      [{ maxTurns: 99 }, "maxTurns 99 > 20"],
      [{ children: { maxDepth: 5 } }, "children.maxDepth 5 > 2"],
      [{ children: { allowedChildProfiles: ["worker", "other"] } }, "allowedChildProfiles adds other"],
      [{ allowedTools: ["Read", "Write"] }, "allowedTools adds Write"],
      [{ sandbox: "danger-full-access" }, "sandbox"],
      [{ auth: "apikey" }, "auth subscription → apikey"],
    ] as const) expect(() => applyOverrides("parent", parent as any, { set: set as any })).toThrow(msg);
    expect(widenings(worker as any, { ...worker, children: { allowSpawn: true, allowedChildProfiles: ["x"] } } as any)).toContain("children.allowSpawn false → true");
    expect(applyOverrides("parent", parent as any, { set: { maxTurns: 99 }, operator: true }).maxTurns).toBe(99);
    expect(() => applyOverrides("parent", parent as any, { set: { maxTurns: -1 }, operator: true })).toThrow("override invalid");
    const ref = encodeAgentRef("parent", { set: { children: { maxDepth: 1 } }, operator: true });
    expect(decodeAgentRef(ref)).toEqual({ name: "parent", overrides: { set: { children: { maxDepth: 1 } }, operator: true } });
    expect(parseAgentDirective(`[agent:${ref}] go`)).toEqual({ agent: ref, goal: "go" });
  });

  test("effective record + CLI run rejects widening before touching the engine", () => {
    const path = file({ parent, worker }, "parent");
    const dir = mkdtempSync(join(tmpdir(), "capcomd-eff-"));
    const led = join(dir, "auths.json");
    writeFileSync(led, JSON.stringify({ "claude-code": { agent: "claude-code", store: "snapshot", snapshot: "s", method: "setup-token", env: "e", createdAt: "t" } }));
    const rec = effectiveAgentRecord(encodeAgentRef("parent", { set: { maxTurns: 4, children: { maxDepth: 1 } } }), { CAPCOMD_AGENTS_FILE: path, CAPCOMD_AUTH_LEDGER: led });
    expect(rec).toMatchObject({ name: "parent", kind: "claude-code", overridden: true, operator: false, auth: "subscription", maxTurns: 4, children: { allowSpawn: true, maxDepth: 1, maxChildren: 3 } });
    expect(JSON.stringify(rec)).not.toMatch(/sk-|token/i);
    const env = { CAPCOMD_AGENTS_FILE: path, CAPCOMD_ENDPOINT: "http://127.0.0.1:1" };
    const r = cli(["run", "--json", "--profile", "parent", "--set", "children.maxDepth=9", "go"], env);
    expect(r.code).toBe(2);
    expect(r.out + r.err).toContain("children.maxDepth 9 > 2");
    expect(r.out + r.err).toContain("--operator");
    const bad = cli(["run", "--set", "maxTurns=1", "go"], env);
    expect(bad.out + bad.err).toContain("need --profile");
  }, 30_000);
});
