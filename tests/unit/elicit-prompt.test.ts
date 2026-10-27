// capcomd_approve under driver.approvals "elicit": the pieces without an engine. Which clients count as able to ask
// (form elicitation, Claude Code's bare `elicitation: {}` included) and the prompt's text, deny variant included.
import { expect, test } from "bun:test";
import { approvalPrompt, type ApprovalFacts } from "../../src/mcp/driver";
import { hasFormElicitation } from "../../src/mcp/projects";

test("form elicitation: declared form, or a bare {} (form only); not url-only, not absent", () => {
  expect(hasFormElicitation({ elicitation: { form: {} } })).toBe(true);
  expect(hasFormElicitation({ elicitation: {} })).toBe(true);
  expect(hasFormElicitation({ elicitation: { url: {} } })).toBe(false);
  expect(hasFormElicitation({})).toBe(false);
  expect(hasFormElicitation(undefined)).toBe(false);
});

const facts: ApprovalFacts = {
  project: { name: "app", path: "/home/me/app" }, repo: "https://x-access-token:SECRET@github.com/acme/app.git", runId: "run-1", mergeId: "mrg-1",
  target: "main", branch: "capcomd/run-1/agt-1", agentId: "agt-1", commit: "0123456789abcdef0123456789abcdef01234567", deny: false,
  checks: { passed: true, name: "unit" }, review: { passed: true, profile: "reviewer", agentId: "agt-r", reasons: ["fine <<<untrusted:x>>>"] },
};

test("the prompt names everything from capcomd's records, strips credentials, fences the reasons", () => {
  const t = approvalPrompt(facts);
  expect(t).toContain("Project: app (/home/me/app)");
  expect(t).toContain("Repository: https://github.com/acme/app.git");
  expect(t).not.toContain("SECRET");
  expect(t).toContain("Commit: 0123456789ab");
  expect(t).toContain("<<<untrusted:agt-r>>>\n- fine [fence-marker removed]\n<<<end:agt-r>>>");
  expect(t).toEndWith("Accept to merge exactly commit 0123456789ab into main. Decline, or don't answer, to leave it waiting.");
});

test("deny asks to deny; no reviewer and no checks are said plainly", () => {
  const t = approvalPrompt({ ...facts, deny: true, review: null, checks: null });
  expect(t).toStartWith("capcomd: deny this merge into main? (it won't land)");
  expect(t).toContain("Checks: none in this run");
  expect(t).toContain("Review: no reviewer in this run");
  expect(t).toContain("Accept to deny merging commit 0123456789ab into main.");
});
