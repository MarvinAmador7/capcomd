// Plugin API §16.1: everyone who briefs an orchestrate agent is told what the mode means (it sees everything and runs
// nothing; give it no task that needs it to run code itself (its helpers write and test the code); checks run at verify and merge, and their results are readable),
// and `capcomd logs` shows a refused tool call as `refused <call>: <reason>`.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { plannerBrief } from "../../src/recipes/planner-agent";
import { orchestrationSkill } from "../../src/subagents/skill";
import { abilityText, ORCHESTRATE_TEXT } from "../../src/profiles";
import { LEAD_DESCRIPTION, PLANNER_DESCRIPTION } from "../../src/config/project-setup";
import { setupProfiles } from "../helpers/setup-profiles";
import { INSTRUCTIONS } from "../../src/mcp/server";
import { logLinesOf, REFUSAL } from "../../src/agents/runner";
import { claude } from "../../src/plugins/agent-claude";
import type { AgentRunState } from "../../packages/plugin/src/seams";

const ROOT = join(import.meta.dir, "..", "..");
const gates = { checks: ["unit"], reviewer: "reviewer", target: "capcomd/goal", base: "main" };
const limits = { allowSpawn: true, maxChildren: 3, maxDepth: 1, maxTotalDescendants: undefined, allowedChildProfiles: ["worker"], budgetShare: 1 } as any;
// What a brief must never ask of an orchestrate agent.
const RUNS_CODE = /how to check the result|run `bun test`|`bun run |\bthen (run|test) (it|the)\b|sync (my|your) branch/i;

describe("the mode, explained", () => {
  // The invariants, not the sentences: each text says the agent runs nothing, names how it sees the latest work and the
  // checks' results (capcomd fetch, capcomd check, result.combined), and never asks it to run code.
  test("the planner's brief: sees everything, runs nothing, reads the checks' results; never asks a lead to run code", () => {
    const b = plannerBrief("build textstat", gates, { orchestrate: true });
    for (const t of ["You orchestrate", "run nothing", "`capcomd fetch`", "`capcomd check`", "result.combined", "A lead orchestrates as you do"]) expect(b).toContain(t);
    expect(b).not.toMatch(RUNS_CODE);
    // A planner that executes isn't told it orchestrates.
    const exec = plannerBrief("build textstat", gates);
    expect(exec).not.toContain("You orchestrate");
    expect(exec).not.toMatch(RUNS_CODE);
  });

  test("the lead's brief (the orchestration skill an orchestrate agent gets)", () => {
    const s = orchestrationSkill({ agentId: "agt-1", limits, budget: {}, mcp: true, goal: { branch: "capcomd/goal", base: "main" }, orchestrate: true });
    for (const t of ["## You orchestrate", "run nothing", "(capcomd_fetch)", "(capcomd_check)", "capcomd check [branch|agt]"]) expect(s).toContain(t);
    expect(s).not.toMatch(RUNS_CODE);
    expect(orchestrationSkill({ agentId: "agt-1", limits, budget: {}, mcp: true })).not.toContain("You orchestrate");
  });

  test("notes and lessons (ADR-025 §5.1): working notes in kv notes/<self>, lessons proposed in the result", () => {
    for (const orchestrate of [true, false]) {
      const s = orchestrationSkill({ agentId: "agt-1", limits, budget: {}, mcp: true, orchestrate });
      for (const t of ["## Notes and lessons", "capcomd kv put notes/agt-1", `"context": [{"title"`]) expect(s).toContain(t);
      expect(s).not.toMatch(RUNS_CODE);
    }
  });

  test("profile descriptions: setup's templates, capcomd_profiles / agents list `does`", () => {
    const by = setupProfiles({ dir: mkdtempSync(join(tmpdir(), "capcomd-ot-")), repo: "https://github.com/a/b.git", mode: "direct", target: "main", check: "bun test", agents: ["claude"], authOf: () => "subscription", cap: null }).specs;
    expect(by.lead!.description).toBe(LEAD_DESCRIPTION);
    expect(by.planner!.description).toBe(PLANNER_DESCRIPTION);
    for (const d of [LEAD_DESCRIPTION, PLANNER_DESCRIPTION, ORCHESTRATE_TEXT]) { expect(d).toContain("sees everything"); expect(d).toContain("runs nothing"); expect(d).toContain("capcomd check"); }
    const lead = abilityText(by.lead as any);
    expect(lead).toContain("spawns up to 3 worker helpers");
    expect(lead).toContain(ORCHESTRATE_TEXT);
    expect(abilityText(by.worker as any)).not.toContain("orchestrates");
  });

  test("the driver: the MCP server's instructions and the orchestration skill", () => {
    for (const t of ["toolMode orchestrate", "runs nothing", "capcomd_check"]) expect(INSTRUCTIONS).toContain(t);
    const skill = readFileSync(join(ROOT, "plugins", "capcomd", "skills", "capcomd-orchestration", "SKILL.md"), "utf8");
    for (const t of ["run nothing themselves", "`result.combined.text`", "`capcomd_check`"]) expect(skill).toContain(t);
  });
});

describe("capcomd logs: refusals", () => {
  const fresh = (): AgentRunState => ({ events: 0, turns: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, done: false });
  // Recorded from claude 2.1.303 in the orchestrate live probe (Docker, 2026-11-05).
  const use = (id: string, command: string) => JSON.stringify({ type: "assistant", message: { id: `m-${id}`, content: [{ type: "tool_use", id, name: "Bash", input: { command } }] } });
  const answer = (id: string, text: string) => JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: true, content: text }] } });

  test("a call Claude Code refused is `refused <call>: <reason>`; a call that failed stays `error`", () => {
    const st = fresh();
    const lines = [
      use("t1", "git push origin HEAD:main"), answer("t1", "Permission to use Bash with command git push origin HEAD:main has been denied."),
      use("t2", "bun test"), answer("t2", "This command requires approval"),
      use("t3", "id=$(capcomd spawn --task x); echo $id"), answer("t3", "A variable in this command can't be checked before it runs"),
      use("t4", "ls src"), answer("t4", "Exit code 2\nls: cannot access 'src': No such file or directory"),
    ].flatMap((l) => logLinesOf(claude.parse(l, (s) => s, st, { credentialMode: "subscription" })!));
    expect(lines).toEqual([
      'tool Bash {"command":"git push origin HEAD:main"}', 'refused Bash {"command":"git push origin HEAD:main"}: Permission to use Bash with command git push origin HEAD:main has been denied.',
      'tool Bash {"command":"bun test"}', 'refused Bash {"command":"bun test"}: This command requires approval',
      'tool Bash {"command":"id=$(capcomd spawn --task x); echo $id"}', `refused Bash {"command":"id=$(capcomd spawn --task x); echo $id"}: A variable in this command can't be checked before it runs`,
      'tool Bash {"command":"ls src"}', `error Bash {"command":"ls src"}: Exit code 2 ls: cannot access 'src': No such file or directory`,
    ]);
  });

  test("codex's refusals: an MCP tool needing an approval, a command its rules reject", () => {
    expect(REFUSAL.test("MCP tool call requires approval, but approval policy is never")).toBe(true);
    expect(REFUSAL.test("`/bin/bash -lc 'git push'` rejected: capcomd orchestrate mode")).toBe(true);
    expect(REFUSAL.test("error: test failed, 1 fail")).toBe(false);
  });
});
