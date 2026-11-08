// The kernel's side of the hooks (docs/spec/plugin-api.md §6.6, §17.2 step 2): with no plugin listening a site does
// nothing at all (no payload, no await: the wrapped scope actions and sandbox calls answer exactly as before), and the
// kernel's patch rules let plugins only narrow what §6.6 says they may.
import { afterEach, describe, expect, test } from "bun:test";
import { PluginHost, type Candidate } from "../../packages/plugin/src/host/host";
import type { PluginContext, PluginModule } from "../../packages/plugin/src/context";
import { PluginError } from "../../packages/plugin/src/errors";
import type { AgentPreparing, AgentSpawning, RunCreating, SandboxEnsuring } from "../../packages/plugin/src/hooks";
import { applyPreparePatch, applyProfilePatch, applyRunPatch, applySandboxPatch, applySpawnPatch, hooks, principalOf, refusedError, skillHash, useHooks } from "../../src/plugins/hooks";
import { agentChange, changedHooks, mergeChange } from "../../src/plugins/changes";
import { hookedProvider, purposeOf } from "../../src/plugins/sandbox";
import { applyOverrides, type AgentSpec } from "../../src/profiles";
import { loadAgentConfig } from "../../src/agents/config";
import { FakeProvider } from "../../src/providers/fake";

const OPERATOR = { kind: "operator" as const, clientId: null };
const plugin = (name: string, hooks: Record<string, object>, activate: (ctx: PluginContext) => void): Candidate => ({
  source: "builtin",
  manifest: { schema: "capcomd.plugin/v1", name, version: "1.0.0", description: `The ${name} test plugin.`, apiVersion: 1, engines: { capcomd: ">=0.0.0" }, entry: { runtime: "in-process", module: "./index.ts" }, contributes: { hooks } },
  module: { activate } as PluginModule<never>,
});
async function hostWith(...c: Candidate[]) {
  const host = new PluginHost({ capcomd: "0.9.0", kernel: [], emit: () => {}, dataDir: (n) => `/tmp/capcomd-kernel-hooks/${n}` });
  await host.start(c);
  useHooks(host.hooks);
  return host;
}
afterEach(() => useHooks(null));

const widens = (f: () => unknown) => { try { f(); } catch (e) { return e instanceof PluginError ? e.code : "other"; } return "ok"; };

describe("no listener, nothing happens (§17.2 step 2)", () => {
  test("outside the daemon (no registry) every hook is silent and a fire allows", async () => {
    expect(hooks.listening("agent.spawning")).toBe(false);
    expect(hooks.listeningAny(["run.changed", "agent.changed"])).toBe(false);
    expect(hooks.order("verify.judging")).toEqual([]);
    const out = await hooks.fire("verify.starting", "modify", { verification: { vfyId: "vfy-1", runId: "run-1", ref: "a", target: "main", check: null }, acceptance: null, reviewer: null, requestedBy: OPERATOR }, { principal: OPERATOR, entity: "vfy-1", apply: (p) => p });
    expect(out.decision).toBe("allow");
  });

  test("a daemon whose plugins don't listen to a hook: that hook stays silent", async () => {
    await hostWith(plugin("lister", { "run.changed": {} }, (ctx) => { ctx.hooks.on("run.changed", () => {}); }));
    expect(hooks.listening("run.changed")).toBe(true);
    expect(hooks.listening("agent.spawning")).toBe(false);
    expect(hooks.order("run.changed")).toEqual(["lister"]);
  });

  test("a wrapped scope action answers as itself: the same value, synchronously, with no await added", () => {
    const actions = changedHooks({ bump: (_c: unknown, n: number) => n + 1, getThing: () => "read" }, { agent: (r) => r, op: (r) => r });
    expect(actions.bump({}, 41)).toBe(42);
    expect(actions.getThing()).toBe("read");
  });

  test("a wrapped provider's calls are the provider's own promises", () => {
    const raw = new FakeProvider();
    const p = hookedProvider(raw, "fake");
    expect(hookedProvider(p, "fake")).toBe(p);
    expect(p instanceof FakeProvider).toBe(true);
    const spec = { idemKey: "relay-test-hooks", isolated: true as const, ttlSeconds: 60, egressAllow: [], labels: { workerId: "agt-1", runId: "run-1" } };
    let made: unknown = null;
    const ensure = raw.ensure.bind(raw);
    raw.ensure = (s) => (made = ensure(s)) as ReturnType<FakeProvider["ensure"]>;
    const got = p.ensure(spec);
    expect(got).toBe(made as Promise<never>);
  });
});

describe("the kernel's patch rules (§6.6)", () => {
  const run = (budget = { usd: 10, turns: 100 }): RunCreating => ({ options: { runId: "run-1", label: null, goal: null, budget, checks: { test: "bun test" }, reviewer: null, target: null, goalBranch: null, sandbox: null, profile: null, driver: null, repo: null } });
  test("run.creating: the budget only lowers, the sandbox is a listed one, the checks can't be patched", () => {
    const listed = (n: string) => n === "docker" || n === "boxd";
    expect(applyRunPatch(run(), { budget: { usd: 2 }, label: " cheap ", sandbox: "Docker" }, listed).options).toMatchObject({ budget: { usd: 2, turns: 100 }, label: "cheap", sandbox: "docker", checks: { test: "bun test" } });
    expect(applyRunPatch(run(), { budget: { wallSeconds: 600 } }, listed).options.budget).toEqual({ usd: 10, turns: 100, wallSeconds: 600 });
    expect(widens(() => applyRunPatch(run(), { budget: { usd: 11 } }, listed))).toBe("widening");
    expect(widens(() => applyRunPatch(run(), { sandbox: "fake" }, listed))).toBe("invalid");
  });

  test("profile.resolved: narrowed exactly as a user's override; a widening is refused", () => {
    const base = { provider: "claude", auth: "subscription", maxTurns: 20, egress: ["github.com", "npmjs.org"] } as unknown as AgentSpec;
    const p = { profile: { name: "worker", version: 1, source: "user" as const }, spec: base as never, overrides: null };
    const narrow = (spec: Record<string, unknown>, set: Record<string, unknown>) => applyOverrides("worker", spec as unknown as AgentSpec, { set }) as unknown as Record<string, unknown>;
    expect(applyProfilePatch(p, { maxTurns: 5, egress: ["github.com"] }, narrow).spec).toMatchObject({ maxTurns: 5, egress: ["github.com"] });
    expect(widens(() => applyProfilePatch(p, { maxTurns: 50 }, narrow))).toBe("widening");
    expect(widens(() => applyProfilePatch(p, { egress: ["evil.example"] }, narrow))).toBe("widening");
  });

  test("agent.spawning: budget and grant narrow, contract keys are added, never changed", () => {
    const s: AgentSpawning = { spawn: { runId: "run-1", parent: "agt-p", profile: "lead", task: { text: "t", untrusted: true, by: "agt-p" }, contract: { script: "x" }, budget: { turns: 10 }, grant: { maxChildren: 3, allowedChildProfiles: ["worker", "critic"] }, review: false, operator: false }, spec: {} as never, parent: null };
    const n = applySpawnPatch(s, { budget: { turns: 4 }, grant: { maxChildren: 1, allowedChildProfiles: ["worker"] }, contract: { team: "a" } }).spawn;
    expect(n).toMatchObject({ budget: { turns: 4 }, grant: { maxChildren: 1, allowedChildProfiles: ["worker"] }, contract: { script: "x", team: "a" } });
    expect(widens(() => applySpawnPatch(s, { grant: { maxChildren: 5 } }))).toBe("widening");
    expect(widens(() => applySpawnPatch(s, { grant: { allowSpawn: true } }))).toBe("widening");
    expect(widens(() => applySpawnPatch(s, { grant: { allowedChildProfiles: ["planner"] } }))).toBe("widening");
    expect(widens(() => applySpawnPatch(s, { contract: { script: "rm -rf" } }))).toBe("widening");
    expect(widens(() => applySpawnPatch(s, { budget: { usd: -1 } }))).toBe("invalid");
  });

  test("agent.spawning: a contract key spawnAgent checks before the hook is checked the same way when a plugin adds it", () => {
    const s: AgentSpawning = { spawn: { runId: "run-1", parent: "agt-p", profile: "worker", task: { text: "t", untrusted: true, by: "agt-p" }, contract: { script: "x" }, budget: null, grant: null, review: false, operator: false }, spec: {} as never, parent: null };
    // `report` is `true` or absent (every consumer reads `=== true`; `capcomd results` shows any truthy one as a report).
    expect(applySpawnPatch(s, { contract: { report: true } }).spawn.contract).toEqual({ script: "x", report: true });
    expect(widens(() => applySpawnPatch(s, { contract: { report: "yes" } }))).toBe("invalid");
    expect(widens(() => applySpawnPatch(s, { contract: { report: false } }))).toBe("invalid");
    // `from` (where the agent starts: another agent's branch) is --continue's alone, as when the spawner sends it.
    expect(widens(() => applySpawnPatch(s, { contract: { from: { agentId: "agt-x", ref: "refs/heads/capcomd/run-2/agt-x", stopped: "done" } } }))).toBe("widening");
    const continued: AgentSpawning = { ...s, spawn: { ...s.spawn, contract: { from: { agentId: "agt-x", ref: "refs/heads/b", stopped: "done" } } } };
    expect(applySpawnPatch(continued, { contract: { from: { agentId: "agt-x", ref: "refs/heads/b", stopped: "done" }, team: "a" } }).spawn.contract).toMatchObject({ team: "a" });
    // `check` names one of the run's checks (its verify looks the name up).
    expect(applySpawnPatch(s, { contract: { check: "unit" } }).spawn.contract).toMatchObject({ check: "unit" });
    expect(widens(() => applySpawnPatch(s, { contract: { check: ["unit"] } }))).toBe("invalid");
  });

  test("agent.preparing: text is appended after the profile's, egress only shrinks", () => {
    const p: AgentPreparing = { agent: {} as never, spec: {} as never, prompt: { system: null, append: "Be brief.", skills: [] }, env: [], egress: ["github.com", "npmjs.org"], credentialMode: "subscription", sandbox: { provider: "fake", environment: null } };
    expect(applyPreparePatch(p, { prompt: { append: "Cite files." }, egress: ["github.com"] })).toMatchObject({ prompt: { append: "Be brief.\n\nCite files." }, egress: ["github.com"] });
    expect(widens(() => applyPreparePatch(p, { egress: ["evil.example"] }))).toBe("widening");
  });

  test("agent.preparing: skills are added pinned by their hash, once each (§6.6.7, step 8)", () => {
    const p: AgentPreparing = { agent: {} as never, spec: {} as never, prompt: { system: null, append: null, skills: [] }, env: [], egress: [], credentialMode: "subscription", sandbox: { provider: "fake", environment: null } };
    const skill = (name: string, text: string, hash = skillHash(text)) => ({ name, text, hash, source: "plugin" as const });
    const one = applyPreparePatch(p, { prompt: { skills: [skill("cite-files", "# Cite files\nName every file you change.")] } });
    expect(one.prompt.skills).toEqual([skill("cite-files", "# Cite files\nName every file you change.")]);
    // The next plugin sees it, and adds after it.
    expect(applyPreparePatch(one, { prompt: { skills: [skill("be-brief", "# Be brief")] } }).prompt.skills.map((s) => s.name)).toEqual(["cite-files", "be-brief"]);
    expect(widens(() => applyPreparePatch(one, { prompt: { skills: [skill("cite-files", "# Something else")] } }))).toBe("invalid");
    expect(widens(() => applyPreparePatch(p, { prompt: { skills: [skill("x", "# X", "0".repeat(64))] } }))).toBe("invalid");
    expect(widens(() => applyPreparePatch(p, { prompt: { skills: [skill("Bad Name", "# X")] } }))).toBe("invalid");
    expect(widens(() => applyPreparePatch(p, { prompt: { skills: [{ ...skill("x", "# X"), source: "anywhere" as never }] } }))).toBe("invalid");
    expect(widens(() => applyPreparePatch(p, { prompt: { skills: Array.from({ length: 9 }, (_, i) => skill(`s${i}`, `# ${i}`)) } }))).toBe("invalid");
  });

  test("agent.preparing: env adds new variables only, never a secret (§6.6.7, step 8)", () => {
    const p: AgentPreparing = { agent: {} as never, spec: {} as never, prompt: { system: null, append: null, skills: [] }, env: ["HOME", "PATH", "ANTHROPIC_API_KEY"], egress: [], credentialMode: "secret", sandbox: { provider: "fake", environment: null } };
    expect(applyPreparePatch(p, { env: { TEAM: "payments", LOG_LEVEL: "debug" } }).env).toEqual(["HOME", "PATH", "ANTHROPIC_API_KEY", "TEAM", "LOG_LEVEL"]);
    expect(widens(() => applyPreparePatch(p, { env: { PATH: "/evil/bin" } }))).toBe("widening");
    expect(widens(() => applyPreparePatch(p, { env: { ANTHROPIC_API_KEY: "x" } }))).toBe("widening");
    expect(widens(() => applyPreparePatch(p, { env: { CAPCOMD_RPC_DIR: "/tmp/x" } }))).toBe("widening");
    // Names the agent's environment doesn't have yet, but that would steer where its credential goes, what its runtimes
    // load, or which proxy and certificates it trusts: reserved, never a plugin's.
    for (const k of ["ANTHROPIC_BASE_URL", "CLAUDE_CONFIG_DIR", "OPENAI_BASE_URL", "CODEX_HOME", "NODE_OPTIONS", "NODE_EXTRA_CA_CERTS", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "BASH_ENV", "HTTPS_PROXY", "SSL_CERT_FILE", "GIT_SSH_COMMAND", "PYTHONPATH", "CAPCOMD_NEW"])
      expect([k, widens(() => applyPreparePatch(p, { env: { [k]: "https://example.test" } }))]).toEqual([k, "widening"]);
    expect(applyPreparePatch(p, { env: { NODEJS_TEAM: "x", GITHUB_ORG: "acme" } }).env).toContain("GITHUB_ORG");
    expect(widens(() => applyPreparePatch(p, { env: { lower: "1" } }))).toBe("invalid");
    expect(widens(() => applyPreparePatch(p, { env: { TOKEN: `ghp_${"a".repeat(36)}` } }))).toBe("invalid");
    expect(widens(() => applyPreparePatch(p, { env: { KEY: "sk-ant-abcdefghijklmnop" } }))).toBe("invalid");
    expect(widens(() => applyPreparePatch(p, { env: { N: 1 as never } }))).toBe("invalid");
  });

  test("agent.preparing: an attempt's spec reaches the agent's environment with only the names a plugin may add", () => {
    const spec = { provider: "claude", auth: "apikey", kind: "claude-code", pluginEnv: { PLUGIN_TEAM: "payments", ANTHROPIC_BASE_URL: "https://example.test", NODE_OPTIONS: "--require x", CAPCOMD_X: "1", lower: "1" } };
    expect(loadAgentConfig({ ANTHROPIC_API_KEY: "k" }, null, spec).pluginEnv).toEqual({ PLUGIN_TEAM: "payments" });
  });

  test("sandbox.ensuring: labels under plugin.<name>., size and lifetime never grow", () => {
    const p: SandboxEnsuring = { runId: "run-1", agentId: "agt-1", purpose: "agent", provider: "docker", spec: { idemKey: "k", isolated: true, ttlSeconds: 3600, egressAllow: [], labels: { workerId: "agt-1" }, size: { vcpu: 4 } } };
    expect(applySandboxPatch(p, { labels: { team: "infra" }, size: { vcpu: 2 }, ttlSeconds: 600 }, "costs").spec).toMatchObject({ labels: { workerId: "agt-1", "plugin.costs.team": "infra" }, size: { vcpu: 2 }, ttlSeconds: 600 });
    expect(widens(() => applySandboxPatch(p, { size: { vcpu: 8 } }, "costs"))).toBe("widening");
    expect(widens(() => applySandboxPatch(p, { ttlSeconds: 7200 }, "costs"))).toBe("widening");
    expect(widens(() => applySandboxPatch({ ...p, spec: { ...p.spec, size: undefined } }, { size: { vcpu: 2 } }, "costs"))).toBe("widening");
  });

  test("a plugin's refusal reaches the caller as plugin:<name>, with its text as the hint", () => {
    const e = refusedError("agent.spawning", { decision: "deny", plugin: "team-shape", text: "no more than 3 workers", reasons: [], failure: null });
    expect(e.toJSON().error).toMatchObject({ code: "conflict", reason: "plugin:team-shape", hint: "no more than 3 workers" });
    expect(principalOf("agt-1", "run-1")).toEqual({ kind: "agent", agentId: "agt-1", runId: "run-1" });
    expect(principalOf("client:app")).toEqual({ kind: "operator", clientId: "app" });
    expect(principalOf("driver:elicited").kind).toBe("driver");
  });
});

describe("what the kernel's records become (§6.6.8, §6.6.10, §6.6.16)", () => {
  const ev = (type: string, data: Record<string, unknown> = {}) => ({ seq: 1, at: 1_700_000_000_000, type, agentId: "agt-1", data });
  test("agent and merge events map onto their change kinds", () => {
    expect(agentChange(ev("AGENT_SPAWNED"))).toEqual({ kind: "spawned" });
    expect(agentChange(ev("AGENT_CHECKPOINT", { files: 3, sha: "abc", at: 1_700_000_000_000 }))).toMatchObject({ kind: "checkpointed", files: 3, commit: "abc" });
    expect(agentChange(ev("AGENT_DONE", { result: { summary: "ok" }, spent: { turns: 2 } }))).toMatchObject({ kind: "ended", status: "done", result: { ok: true, summary: { text: "ok", untrusted: true } } });
    expect(agentChange(ev("AGENT_REAPED"))).toMatchObject({ kind: "ended", status: "cancelled" });
    expect(agentChange(ev("KV_PUT"))).toBeNull();
    expect(mergeChange(ev("MERGED", { sha: "def", pr: { number: 7 } }), () => "apr-1")).toEqual({ kind: "landed", sha: "def", pr: 7, bypassedVetoes: [] });
    expect(mergeChange(ev("MERGE_AWAITING_APPROVAL", { id: "mrg-1" }), (id) => `apr-${id}`)).toEqual({ kind: "parked", approvalId: "apr-mrg-1" });
  });
  test("a machine's purpose comes from the labels capcomd gives it", () => {
    expect(purposeOf({ workerId: "agt-1", runId: "run-1" })).toBe("agent");
    expect(purposeOf({ purpose: "checks" })).toBe("check");
    expect(purposeOf({ purpose: "env-build" })).toBe("env_build");
    expect(purposeOf({ purpose: "doctor" })).toBe("doctor");
    expect(purposeOf({ purpose: "auth-status" })).toBe("login");
  });
});
