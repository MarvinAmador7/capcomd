// A child's hand-back card in its parent's thread (scope actor `handoffOf`): a reviewer's is its verdict, never a bare
// "Finished.", since a reviewer declares no summary (its final message is the verdict).
import { expect, test } from "bun:test";
import { handoffOf } from "../../src/actors/scope";
import { verdictSummary } from "../../src/plugins/gate-reviewer/review";

test("a reviewer's card is its verdict and reasons; one with no verdict says so", () => {
  const verdict = { passed: true, reasons: ["home-window.jpg is 2880x1800", "typecheck could not be confirmed: no node_modules"] };
  const card = handoffOf("agt-p", "agt-r", "done", { verdict, verification: null, branch: null, commit: null, costUsd: 0 });
  expect(card.child).toEqual({ agentId: "agt-r", status: "done", verdict });
  expect(card.text).toBe("**Passed review**\n\n- home-window.jpg is 2880x1800\n- typecheck could not be confirmed: no node_modules");
  expect(handoffOf("agt-p", "agt-r", "done", { verdict: null }).text).toBe("Finished without a verdict.");
});

test("a reviewer's summary that restates its verdict (verdictSummary) isn't shown twice", () => {
  const verdict = { passed: false, reasons: ["src/add.ts:3 returns a - b"] };
  const card = handoffOf("agt-p", "agt-r", "done", { verdict, summary: verdictSummary(verdict) });
  expect(card.text).toBe("**Didn't pass review**\n\n- src/add.ts:3 returns a - b");
  // A summary of its own (not the verdict restated) is kept.
  expect(handoffOf("agt-p", "agt-r", "done", { verdict, summary: "Looked at the adder." }).text).toContain("Looked at the adder.");
});

test("other children keep their summary, report or error, then Finished. / Failed.", () => {
  expect(handoffOf("agt-p", "agt-c", "done", { summary: "Added the page." }).text).toBe("Added the page.");
  expect(handoffOf("agt-p", "agt-c", "done", {}).text).toBe("Finished.");
  expect(handoffOf("agt-p", "agt-c", "failed", {}).text).toBe("Failed.");
  expect(handoffOf("agt-p", "agt-c", "failed", { error: "checks failed" }).child).toEqual({ agentId: "agt-c", status: "failed" });
});
