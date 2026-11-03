// The in-place-vs-clone decision (src/agents/workspace.ts): when an agent may use the env image's warm template.
import { describe, expect, test } from "bun:test";
import { chooseWorkspace, parseTemplateMarker, sameRepo, startRef, type TemplateMarker, type WorkspaceFacts } from "../../src/agents/workspace";

const C = "a".repeat(40);
const marker: TemplateMarker = { schema: 1, repo: "https://github.com/acme/widgets.git", target: "main", commit: C, lockFile: "bun.lock", lockHash: "h1", depsInstalled: true };
const fits: WorkspaceFacts = { allowed: true, marker, claimed: false, repoUrl: "https://github.com/acme/widgets.git", fetched: true, ancestor: true, startFound: true, startLockHash: "h1" };
const reason = (f: Partial<WorkspaceFacts>) => { const c = chooseWorkspace({ ...fits, ...f }); return c.path === "clone" ? c.reason : "in_place"; };

describe("chooseWorkspace", () => {
  test("in place when the warm template is this repo's, unused, fetched, behind the target, and its lockfile matches", () => {
    expect(chooseWorkspace(fits)).toEqual({ path: "in_place" });
    // Equal to the target (nothing new) is an ancestor too: the caller asks `merge-base --is-ancestor`.
    expect(reason({ repoUrl: "https://github.com/acme/widgets" })).toBe("in_place");
  });
  test("not on a sandbox whose files other agents share (boxd, the fakes)", () => {
    expect(reason({ allowed: false })).toContain("doesn't keep a warm template");
  });
  test("no template in the image (an older image, or a shallow one)", () => {
    expect(reason({ marker: null })).toContain("no warm template");
  });
  test("a stale template: its commit isn't in the target's history (the target was rewritten)", () => {
    expect(reason({ ancestor: false })).toContain("isn't in the target's history");
  });
  test("the lockfile changed: the template's node_modules is for another lockfile", () => {
    expect(reason({ startLockHash: "h2" })).toContain("lockfile changed");
    expect(reason({ startLockHash: "none" })).toContain("lockfile changed"); // the lockfile was removed
    // Without installed dependencies there is nothing to mismatch: the clone wouldn't have reused any either.
    expect(reason({ marker: { ...marker, depsInstalled: false }, startLockHash: "h2" })).toBe("in_place");
  });
  test("an earlier run in this sandbox used it (a retry of the attempt): its tree isn't clean any more", () => {
    expect(reason({ claimed: true })).toContain("earlier run");
  });
  test("another repository, a failed fetch, a start commit it doesn't have, or facts it couldn't read", () => {
    expect(reason({ repoUrl: "https://github.com/acme/other.git" })).toContain("another repository");
    expect(reason({ fetched: false })).toContain("fetching");
    expect(reason({ startFound: false })).toContain("isn't in the warm template");
    expect(reason({ ancestor: null })).toContain("couldn't be checked");
    expect(reason({ startLockHash: null })).toContain("couldn't be checked");
  });
});

describe("startRef: what the agent's branch starts from, as both paths check it out", () => {
  const t = { target: "main", branch: "capcomd/r1/agt-1" };
  test("a new branch starts from the target; an existing one from itself; rework from the target again", () => {
    expect(startRef(t, false)).toBe("origin/main");
    expect(startRef(t, true)).toBe("origin/capcomd/r1/agt-1");
    expect(startRef({ ...t, rework: true }, true)).toBe("origin/main");
  });
  test("review mode is the detached commit; a continuation starts from the stopped agent's work until its branch exists", () => {
    expect(startRef({ ...t, review: { sha: C } }, true)).toBe(C);
    expect(startRef({ ...t, from: { ref: "refs/capcomd/checkpoints/agt-0" } }, false)).toBe("FETCH_HEAD");
    expect(startRef({ ...t, from: { ref: "x" } }, true)).toBe("origin/capcomd/r1/agt-1");
    expect(startRef({ ...t, from: { ref: "x" }, report: true }, false)).toBe("origin/main");
  });
});

test("parseTemplateMarker refuses anything that isn't a whole record; sameRepo ignores .git and a trailing slash", () => {
  expect(parseTemplateMarker(JSON.stringify(marker))).toEqual(marker);
  expect(parseTemplateMarker("")).toBeNull();
  expect(parseTemplateMarker(JSON.stringify({ ...marker, commit: "abc" }))).toBeNull();
  expect(parseTemplateMarker(JSON.stringify({ ...marker, depsInstalled: "yes" }))).toBeNull();
  expect(sameRepo("https://GitHub.com/acme/widgets.git/", "https://github.com/acme/widgets")).toBe(true);
  expect(sameRepo("/tmp/x/origin.git", "/tmp/x/origin.git")).toBe(true);
  expect(sameRepo("", "")).toBe(false);
});
