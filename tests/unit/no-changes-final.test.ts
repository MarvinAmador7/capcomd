// Live re-check: a worker told not to change files ended `no_changes` and was run again (and again), as if another
// attempt could change that. A `no_changes` failure is final: one DRIVE_FAILED, then the agent fails, with its final
// words and the fix (spawn work that changes no files with --report), and the orchestration skill says so up front.
import { describe, expect, test } from "bun:test";
import { UserError } from "rivetkit";
import { classify, NO_CHANGES_HINT } from "../../src/actors/agent-workflow";
import { AgentError } from "../../src/agents/runner";
import { orchestrationSkill } from "../../src/subagents/skill";

describe("classify", () => {
  test("no_changes is final, says to spawn it with --report and keeps the agent's final words", async () => {
    const e = await classify(new AgentError("no_changes", "agt-1 made no changes for r1/agt-1 (end_turn)", "parse() drops the last token"));
    expect(e).toMatchObject({ kind: "no_changes", final: true, resultText: "parse() drops the last token" });
    expect(e.message).toBe(`agt-1 made no changes for r1/agt-1 (end_turn); ${NO_CHANGES_HINT}`);
    expect(NO_CHANGES_HINT).toBe("spawn it with --report for work that changes no files");
  });

  test("as the worker's push throws it (its kind as code, the final words in metadata), redacted", async () => {
    const e = await classify(new UserError("agt-1 made no changes", { code: "no_changes", metadata: { kind: "no_changes", resultText: "found it; token cct1.AAAAAAAAAAAA.BBBBBBBBBBBB" } }));
    expect(e).toMatchObject({ kind: "no_changes", final: true });
    expect(e.message).toContain(NO_CHANGES_HINT);
    expect(e.resultText).toContain("found it");
    expect(e.resultText).not.toContain("cct1.AAAA");
  });

  test("other failures are unchanged: retried, no hint, no final words", async () => {
    const e = await classify(Object.assign(new Error("git push failed"), { kind: "git", resultText: "x" }));
    expect(e).toEqual({ kind: "git", message: "git push failed", final: false });
  });
});

test("the orchestration skill: investigation and review-only children are spawned with --report", () => {
  const skill = orchestrationSkill({ agentId: "agt-p", limits: { allowSpawn: true, maxDepth: 1, maxChildren: 3, allowedChildProfiles: ["worker"], budgetShare: 0.5 }, budget: { turns: 40 }, mcp: true });
  expect(skill).toContain("Investigation and review-only children too: one spawned without `--report` that changes no files fails (no_changes), not retried.");
});
