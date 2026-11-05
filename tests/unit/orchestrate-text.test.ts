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
import { abilityText, ORCHESTRATE_TEXT } from "../../src/agents/profiles";
import { LEAD_DESCRIPTION, PLANNER_DESCRIPTION, planProject } from "../../src/config/project-setup";
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
  test("the planner's brief: sees everything, runs nothing, reads the checks' results; never asks a lead to run code", () => {
    const b = plannerBrief("build textstat", gates, { orchestrate: true });
    expect(b).toContain("You orchestrate: you see everything and run nothing.");
    expect(b).toContain("`capcomd fetch` brings in the latest branches");
    expect(b).toContain("You can't edit, commit, install, build or run tests: checks run at verify and merge, and you read their results.");
    expect(b).toContain("A lead orchestrates as you do: it runs nothing, so never ask it to run tests, builds or the program");
    expect(b).toContain("result.combined");
    expect(b).toContain("a shell variable like `id=$(capcomd spawn …)` can't be checked");
    // capcomd check: how it knows the combined code works, running nothing itself; and what writing costs it.
    expect(b).toContain("`capcomd check` runs the run's checks on capcomd/goal as it is");
    expect(b).toContain("Anything you write fails you");
    expect(b).not.toMatch(RUNS_CODE);
    // A planner that executes isn't told it orchestrates.
    const exec = plannerBrief("build textstat", gates);
    expect(exec).not.toContain("You orchestrate");
    expect(exec).not.toMatch(RUNS_CODE);
  });

  test("the lead's brief (the orchestration skill an orchestrate agent gets)", () => {
    const s = orchestrationSkill({ agentId: "agt-1", limits, budget: {}, mcp: true, goal: { branch: "capcomd/goal", base: "main" }, orchestrate: true });
    expect(s).toContain("## You orchestrate: you see everything and run nothing");
    expect(s).toContain("`capcomd fetch` (capcomd_fetch) brings in the latest branches");
    expect(s).toContain("install packages, or run builds, tests or the program: those are refused");
    expect(s).toContain("Report those results; don't try to re-run them yourself.");
    expect(s).toContain("`capcomd check` (capcomd_check) runs the run's checks on your target as it is");
    expect(s).toContain("capcomd check [branch|agt]");
    expect(s).toContain("Anything you write fails you");
    expect(s).not.toMatch(RUNS_CODE);
    expect(orchestrationSkill({ agentId: "agt-1", limits, budget: {}, mcp: true })).not.toContain("You orchestrate");
  });

  test("profile descriptions: setup's templates, capcomd_profiles / agents list `does`", () => {
    const by = Object.fromEntries(planProject({ dir: mkdtempSync(join(tmpdir(), "capcomd-ot-")), repo: "https://github.com/a/b.git", mode: "direct", target: "main", check: "bun test", agents: ["claude"], authOf: () => "subscription", cap: null }).profiles);
    expect(by.lead!.description).toBe(LEAD_DESCRIPTION);
    expect(by.planner!.description).toBe(PLANNER_DESCRIPTION);
    for (const d of [LEAD_DESCRIPTION, PLANNER_DESCRIPTION]) { expect(d).toContain("sees everything"); expect(d).toContain("runs nothing (no edits, commits, installs, builds or tests)"); expect(d).toContain("checks run at verify and merge"); expect(d).toContain("on the combined code with capcomd check"); }
    expect(ORCHESTRATE_TEXT).toContain("capcomd check runs them on the combined code when it asks");
    expect(LEAD_DESCRIPTION).toContain("give it no task that needs it to run code itself (its helpers write and test the code)");
    const lead = abilityText(by.lead as any);
    expect(lead).toContain("leads a part: spawns up to 3 worker helpers, one level");
    expect(lead).toContain(ORCHESTRATE_TEXT);
    expect(ORCHESTRATE_TEXT).toContain("give it no task that needs it to run code itself (its helpers write and test the code). Checks run at verify and merge, and their results are readable");
    expect(abilityText(by.worker as any)).not.toContain("orchestrates");
  });

  test("the driver: the MCP server's instructions and the orchestration skill", () => {
    expect(INSTRUCTIONS).toContain("A lead or planner with toolMode orchestrate (capcomd_profiles) sees everything and runs nothing: give it no task that needs it to run code itself (its helpers write and test the code)");
    const skill = readFileSync(join(ROOT, "plugins", "capcomd", "skills", "capcomd-orchestration", "SKILL.md"), "utf8");
    expect(skill).toContain("they see everything");
    expect(skill).toContain("and run nothing themselves (no edits, commits, installs, builds or tests).\nA lead still takes a part as before: its helpers write and test the code.");
    expect(skill).toContain("`result.combined.text`");
    expect(INSTRUCTIONS).toContain("capcomd_check (capcomd check in its VM) runs them on the combined code on demand");
    expect(skill).toContain("`capcomd_check` (`capcomd check` in its VM) runs the run's checks on the combined code as it is");
    expect(skill).toContain("An orchestrate agent that writes a file or commits anyway fails");
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
