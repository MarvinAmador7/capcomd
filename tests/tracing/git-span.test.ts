import { expect, test } from "bun:test";
import { gitSpanOf } from "../../src/dependencies";

// Trace spans for git commands inside a sandbox are named by the subcommand, past git's global options.
test("git span names skip global options and find a push's ref", () => {
  expect(gitSpanOf(["git", "clone", "--no-tags", "url", "repo"])).toEqual({ op: "clone" });
  expect(gitSpanOf(["git", "-c", "credential.helper=x", "push", "origin", "agent/abc"])).toEqual({ op: "push", ref: "agent/abc" });
  expect(gitSpanOf(["git", "-C", "/w", "push", "--force-with-lease", "origin", "agent/abc"])).toEqual({ op: "push", ref: "agent/abc" });
  expect(gitSpanOf(["git", "--no-pager", "log"])).toEqual({ op: "log" });
  expect(gitSpanOf(["git", "-c", "a=b"])).toEqual({ op: "git" });
});
