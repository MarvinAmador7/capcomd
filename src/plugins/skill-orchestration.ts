// skill-orchestration (plugin API §6.6.7, §17.1, §17.2 step 8): the orchestration skill (src/subagents/skill.ts) as an
// agent.preparing patch, where it was the runner's own prompt injection. An agent that may spawn (a real agent whose
// effective limits allow it, ADR-017) is prepared with the `capcomd-orchestration` skill: its limits and budget, the
// run's goal branch, whether it is the run's planner, and orchestrate mode when its profile has it. It is loaded in
// every process an agent is prepared in (the daemon, a run's driver), so it is the kernel's skill wherever it runs.
import { definePlugin } from "../../packages/plugin/src/context";
import type { PluginManifest } from "../../packages/plugin/src/manifest";
import { VERSION } from "../utils/self";
import type { ScopeAgent } from "../actors/scope";
import { ORCHESTRATION_SKILL_NAME } from "../profiles/skills";
import { preparingAgent, skillHash } from "./hooks";

/** The skill's name: the capcomd plugin's own orchestration skill (plugins/capcomd/skills/capcomd-orchestration). A
 *  profile may name it in its `skills` (src/profiles/skills.ts): it is this plugin's to attach, so the agent gets it once. */
export const SKILL_NAME = ORCHESTRATION_SKILL_NAME;

export const manifest: PluginManifest = {
  schema: "capcomd.plugin/v1", name: "skill-orchestration", version: VERSION,
  description: "The orchestration skill for agents that may spawn: how to delegate to child agents, their limits and budget, verify and merge, the run's goal branch, and orchestrate mode.",
  apiVersion: 1, engines: { capcomd: VERSION }, entry: { runtime: "in-process", module: "./skill-orchestration.ts" },
  // Closed: an agent that may spawn never starts without its skill (it wouldn't know how to delegate); the attempt
  // fails naming this plugin instead. It reads nothing that can fail on the kernel's own call (the agent's record comes
  // with it, the goal branch is optional), so closed never trips on a slow engine and the breaker (§6.5) stays shut.
  contributes: { hooks: { "agent.preparing": { timeoutMs: 30_000, failure: "closed" } } },
};

/** What the skill is written from: the agent's record and the run's goal branch (a test replaces it). */
export const skillKernel = {
  agent: async (runId: string, agentId: string): Promise<ScopeAgent> => {
    // The record the kernel prepares the agent from (src/primitives/ops.ts `agentPreparing`): nothing to read, so
    // nothing to fail. Read from the engine only when fired some other way.
    const p = preparingAgent.getStore();
    if (p && p.runId === runId && p.agentId === agentId) return p.record as ScopeAgent;
    const { getAgentOrThrow } = await import("../primitives/ops");
    for (let i = 0; ; i++) {
      try { return await getAgentOrThrow(runId, agentId); } catch (e) { if (i >= 2) throw e; await new Promise((r) => setTimeout(r, 1000 * (i + 1))); }
    }
  },
  goal: async (runId: string) => (await import("../primitives/ops")).runGoal(runId).catch(() => undefined),
};

/** The skill's text for agent `a` of run `runId` (also the kernel's, for an attempt no plugin prepared: src/primitives/
 *  ops.ts `unpreparedSkill`). */
export async function skillText(runId: string, a: ScopeAgent): Promise<string> {
  const { orchestrationSkill } = await import("../subagents/skill");
  return orchestrationSkill({
    agentId: a.agentId, limits: a.limits, budget: a.budget, mcp: true, goal: (await skillKernel.goal(runId)) ?? null, root: !a.parent,
    orchestrate: (a.spec as { toolMode?: string } | null)?.toolMode === "orchestrate",
  });
}

export const plugin = definePlugin({
  activate(ctx) {
    ctx.hooks.on("agent.preparing", async (call) => {
      const { agent, spec } = call.payload;
      // A fake agent (the tests' and the dry run's) has no provider and reads no prompt.
      if (!spec.provider) return { decision: "allow" };
      const a = await skillKernel.agent(agent.runId, agent.id);
      if (!a.limits.allowSpawn) return { decision: "allow" };
      const text = await skillText(agent.runId, a);
      return { decision: "allow", patch: { prompt: { skills: [{ name: SKILL_NAME, hash: skillHash(text), source: "builtin", text }] } } };
    });
  },
});
