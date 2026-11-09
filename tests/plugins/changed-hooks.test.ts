// The *.changed hooks from the scope's event log (docs/spec/plugin-api.md §6.6.4, .8, .14, .16, .18, src/plugins/changes.ts)
// and run.creating's sandbox rule (§6.6.3), the step 2 follow-ups: a listener that goes away and comes back is told only
// what changed while it listened; each change carries who caused it (§3.2), never just the operator; a run.creating
// patch can only pick a sandbox some active plugin provides.
import { afterEach, describe, expect, test } from "bun:test";
import { PluginHost, type Candidate } from "../../packages/plugin/src/host/host";
import { ContributionStore } from "../../packages/plugin/src/host/context";
import type { PluginContext, PluginModule } from "../../packages/plugin/src/context";
import { PluginError } from "../../packages/plugin/src/errors";
import type { HookCall, RunCreating } from "../../packages/plugin/src/hooks";
import type { Principal } from "../../packages/plugin/src/shapes";
import { applyRunPatch, hooks, useHooks } from "../../src/plugins/hooks";
import { causeOf, changedHooks } from "../../src/plugins/changes";
import { useSandboxHost } from "../../src/plugins/sandboxes";

const plugin = (name: string, hooks: Record<string, object>, activate: (ctx: PluginContext) => void): Candidate => ({
  source: "builtin",
  manifest: { schema: "capcomd.plugin/v1", name, version: "1.0.0", description: `The ${name} test plugin.`, apiVersion: 1, engines: { capcomd: ">=0.0.0" }, entry: { runtime: "in-process", module: "./index.ts" }, contributes: { hooks } },
  module: { activate } as PluginModule<never>,
});
afterEach(() => { useHooks(null); useSandboxHost(null); });

/** A scope actor's actions over an in-memory event log: `step` commits one AGENT_STEP for agt-1 (spawned by agt-p). */
function scope(actorId: string) {
  const events: Array<{ seq: number; at: number; type: string; agent_id: string | null; data: string }> = [];
  const agent = { agentId: "agt-1", runId: "run-t", parent: "agt-p", depth: 1, profile: "worker", status: "running", task: "write a", spec: {}, createdAt: 1, updatedAt: 1, epoch: 1 };
  const db = {
    async execute(sql: string, ...args: unknown[]): Promise<any[]> {
      if (sql.startsWith("SELECT COALESCE(MAX(seq), 0)")) return [{ s: events.at(-1)?.seq ?? 0 }];
      if (sql.startsWith("SELECT * FROM scope_events WHERE seq > ?")) return events.filter((e) => e.seq > Number(args[0]));
      if (sql.startsWith("SELECT * FROM agents_v2")) return [agent];
      return [];
    },
  };
  const c = { db, key: ["run-t"], actorId };
  const actions = changedHooks({
    step: async (_c: unknown, n: number) => { events.push({ seq: events.length + 1, at: 1_700_000_000_000, type: "AGENT_STEP", agent_id: "agt-1", data: JSON.stringify({ kind: "edit", n, startedAt: 1, endedAt: 2 }) }); return n; },
  }, { agent: (r) => r, op: (r) => r });
  return { step: (n: number) => actions.step(c, n) };
}

describe("the change tap (§6.6.8)", () => {
  test("a listener that goes away and comes back is told only what changed while it listened, not the gap late", async () => {
    const told: HookCall[] = [];
    const host = new PluginHost({ capcomd: "0.9.0", kernel: [], emit: () => {}, dataDir: (n) => `/tmp/capcomd-changed-hooks/${n}` });
    await host.start([plugin("watcher", { "agent.changed": {} }, (ctx) => { ctx.hooks.on("agent.changed", (call) => { told.push(call as HookCall); }); })]);
    useHooks(host.hooks);
    const s = scope("act-gap");
    expect(await s.step(1)).toBe(1);
    await hooks.idle();
    // Nobody listens: steps 2 and 3 are committed and told to no one.
    useHooks(null);
    await s.step(2);
    await s.step(3);
    // It listens again: only what changes from now on.
    useHooks(host.hooks);
    await s.step(4);
    await hooks.idle();
    const steps = told.map((c) => (c.payload as { change: { step: { n: number } } }).change.step.n);
    expect(steps).toEqual([1, 4]);
    // An agent's own step is the agent's doing, not the operator's.
    expect(told[0]!.principal).toEqual({ kind: "agent", agentId: "agt-1", runId: "run-t" });
    await host.stop();
  });
});

describe("who caused a change (§3.2)", () => {
  const ev = (type: string, data: Record<string, unknown> = {}, agentId: string | null = "agt-1") => ({ seq: 1, at: 0, type, agentId, data });
  const agent = (agentId: string): Principal => ({ kind: "agent", agentId, runId: "run-1" });
  const operator: Principal = { kind: "operator", clientId: null };
  test("an agent's own work is its own; its spawn and start are its spawner's", () => {
    expect(causeOf(ev("AGENT_SPAWNED", { parent: "agt-p" }), "run-1")).toEqual(agent("agt-p"));
    expect(causeOf(ev("AGENT_SPAWNED", { parent: null }), "run-1")).toEqual(operator);
    expect(causeOf(ev("AGENT_STARTED"), "run-1", null, { parent: "agt-p" })).toEqual(agent("agt-p"));
    for (const t of ["AGENT_STEP", "AGENT_CHECKPOINT", "AGENT_NOTICE", "AGENT_DONE", "AGENT_FAILED"]) expect(causeOf(ev(t), "run-1")).toEqual(agent("agt-1"));
  });
  test("a pause, resume, cancel or title names who did it", () => {
    expect(causeOf(ev("AGENT_CANCELLED", { by: "run" }), "run-1")).toEqual(operator);
    expect(causeOf(ev("AGENT_CANCELLED", { by: "agt-p" }), "run-1")).toEqual(agent("agt-p"));
    expect(causeOf(ev("AGENT_RESUMED", { by: "client:mac" }), "run-1")).toEqual({ kind: "operator", clientId: "mac" });
    expect(causeOf(ev("AGENT_PAUSED", { result: { by: "driver" } }), "run-1")).toEqual({ kind: "driver", clientId: null });
    expect(causeOf(ev("AGENT_REAPED", { orphanOf: "agt-p" }), "run-1")).toEqual(agent("agt-p"));
    expect(causeOf(ev("RUN_TITLED", { setBy: "agt-p" }, null), "run-1")).toEqual(agent("agt-p"));
    expect(causeOf(ev("RUN_NEW", {}, null), "run-1")).toEqual(operator);
  });
  test("a verification's and a merge's changes are their asker's; a decision is its approver's", () => {
    const asked = { data: { askedBy: "agt-p" } };
    for (const t of ["VERIFY_STARTED", "VERIFY_PASSED", "MERGE_STARTED", "MERGED", "MERGE_FAILED", "MERGE_AWAITING_APPROVAL"]) expect(causeOf(ev(t, { id: "x" }), "run-1", asked)).toEqual(agent("agt-p"));
    expect(causeOf(ev("VERIFY_PASSED", { id: "vfy-1" }), "run-1", { data: {} })).toEqual(operator);
    expect(causeOf(ev("MERGE_APPROVED", { id: "mrg-1", by: "driver" }), "run-1", asked)).toEqual({ kind: "driver", clientId: null });
    expect(causeOf(ev("MERGE_DENIED", { id: "mrg-1", by: "client:mac" }), "run-1", asked)).toEqual({ kind: "operator", clientId: "mac" });
  });
  test("what a plugin did through its primitives is the plugin's (§8.4): its spawn, its verification and merge, its title, its grant", () => {
    const plugin: Principal = { kind: "plugin", name: "context-memory", scopes: [] };
    expect(causeOf(ev("AGENT_SPAWNED", { parent: null, by: "plugin:context-memory" }), "run-1")).toEqual(plugin);
    expect(causeOf(ev("AGENT_SPAWNED", { parent: "agt-p", by: "plugin:context-memory" }), "run-1")).toEqual(plugin);
    const requested = { data: { requester: "plugin:context-memory" } };
    for (const t of ["VERIFY_STARTED", "VERIFY_PASSED", "MERGE_STARTED", "MERGE_FAILED", "MERGE_AWAITING_APPROVAL"]) expect(causeOf(ev(t, { id: "x" }), "run-1", requested)).toEqual(plugin);
    expect(causeOf(ev("AGENT_TITLED", { setBy: "plugin:context-memory" }), "run-1")).toEqual(plugin);
    expect(causeOf(ev("RUN_ENDED", { by: "plugin:context-memory" }, null), "run-1")).toEqual(plugin);
    // Not a plugin's name: the operator, as before.
    expect(causeOf(ev("AGENT_CANCELLED", { by: "plugin:" }), "run-1")).toEqual(operator);
  });
});

describe("run.creating's sandbox (§6.6.3)", () => {
  const run = (): RunCreating => ({ options: { runId: "run-1", label: null, goal: null, budget: {}, checks: {}, reviewer: null, target: null, goalBranch: null, sandbox: null, profile: null, driver: null, repo: null } });
  const listed = (n: string) => n === "docker" || n === "boxd";
  const code = (f: () => unknown) => { try { f(); } catch (e) { return e instanceof PluginError ? e.code : "other"; } return "ok"; };
  test("listed isn't enough: a provider no active plugin provides is refused", () => {
    expect(code(() => applyRunPatch(run(), { sandbox: "boxd" }, listed, (n) => n !== "boxd"))).toBe("invalid");
    expect(applyRunPatch(run(), { sandbox: "Docker" }, listed, () => true).options.sandbox).toBe("docker");
  });
  test("by default, availability is what the plugin host provides (the daemon's, else this process's built-ins)", () => {
    expect(applyRunPatch(run(), { sandbox: "docker" }, listed).options.sandbox).toBe("docker");
    // The daemon's host with the docker plugin disabled (here: no sandbox plugin active at all).
    useSandboxHost({ contributions: new ContributionStore() });
    expect(code(() => applyRunPatch(run(), { sandbox: "docker" }, listed))).toBe("invalid");
  });
});
