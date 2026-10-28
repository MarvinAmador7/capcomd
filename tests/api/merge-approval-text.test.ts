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

// The diff read when the merge was parked rides in the subject: files, how many, lines added and removed.
test("a parked merge's diff becomes subject.files, filesTotal, added and removed", () => {
  const diff = { files: [{ path: "src/a.ts", status: "modified" as const, added: 3, removed: 1 }], filesTotal: 1, added: 3, removed: 1 };
  expect(mergeApprovalText({ ref: "agt-x", branch: "capcomd/run-x/agt-x", target: "main", diff }).subject)
    .toEqual({ target: "main", ref: "capcomd/run-x/agt-x", ...diff });
  expect(mergeApprovalText({ ref: "agt-x", target: "main", diff: "nonsense" }).subject).toEqual({ target: "main", ref: "agt-x" });
});
