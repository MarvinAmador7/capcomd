import { expect, test } from "bun:test";
import { mergeApprovalText } from "../../src/api/source";

// A parked merge's approval: an agent's ref reads as its work, and the subject names the branch it pushed.
test("merge approvals name an agent's work and its branch, not the agent id", () => {
  expect(mergeApprovalText({ ref: "agt-mvqaogktz1lc5l", branch: "capcomd/run-x/agt-mvqaogktz1lc5l", target: "main" }))
    .toEqual({ question: "Merge this agent's work into main?", subject: { target: "main", ref: "capcomd/run-x/agt-mvqaogktz1lc5l" } });
  expect(mergeApprovalText({ ref: "fix/backfill", target: "main" }))
    .toEqual({ question: "Merge fix/backfill into main?", subject: { target: "main", ref: "fix/backfill" } });
  expect(mergeApprovalText({})).toEqual({ question: "Merge this work into the target?", subject: { target: null, ref: null } });
});
