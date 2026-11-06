// The kernel's side of the hooks (docs/spec/plugin-api.md §6.6, §17.2 step 2): with no plugin listening a site does
// nothing at all (no payload, no await: the wrapped scope actions and sandbox calls answer exactly as before), and the
// kernel's patch rules let plugins only narrow what §6.6 says they may.
import { afterEach, describe, expect, test } from "bun:test";
import { PluginHost, type Candidate } from "../../packages/plugin/src/host/host";
import type { PluginContext, PluginModule } from "../../packages/plugin/src/context";
import { PluginError } from "../../packages/plugin/src/errors";
import type { AgentPreparing, AgentSpawning, RunCreating, SandboxEnsuring } from "../../packages/plugin/src/hooks";
import { applyPreparePatch, applyProfilePatch, applyRunPatch, applySandboxPatch, applySpawnPatch, hooks, principalOf, refusedError, useHooks } from "../../src/plugins/hooks";
import { agentChange, changedHooks, mergeChange } from "../../src/plugins/changes";
import { hookedProvider, purposeOf } from "../../src/plugins/sandbox";
import { applyOverrides, type AgentSpec } from "../../src/profiles";
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

  test("agent.preparing: text is appended after the profile's, egress only shrinks, env and skills wait for their step", () => {
    const p: AgentPreparing = { agent: {} as never, spec: {} as never, prompt: { system: null, append: "Be brief.", skills: [] }, env: [], egress: ["github.com", "npmjs.org"], credentialMode: "subscription", sandbox: { provider: "fake", environment: null } };
    expect(applyPreparePatch(p, { prompt: { append: "Cite files." }, egress: ["github.com"] })).toMatchObject({ prompt: { append: "Be brief.\n\nCite files." }, egress: ["github.com"] });
    expect(widens(() => applyPreparePatch(p, { egress: ["evil.example"] }))).toBe("widening");
    expect(widens(() => applyPreparePatch(p, { env: { FOO: "1" } }))).toBe("invalid");
    expect(widens(() => applyPreparePatch(p, { prompt: { skills: [] } }))).toBe("invalid");
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
