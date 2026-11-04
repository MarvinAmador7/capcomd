// verify's reviewer runs alongside the checks (#100) and reads the agent's commit merged onto the target as the verify
// found it; reviewFits says whether that is the tree the checks then tested. One that isn't is replaced, never counted.
import { describe, expect, test } from "bun:test";
import { reviewFits } from "../../src/primitives/ops";

const A = "a".repeat(40), B = "b".repeat(40), T1 = "1".repeat(40), T2 = "2".repeat(40);

describe("reviewFits", () => {
  test("the same commit on the same target fits", () => {
    expect(reviewFits({ sha: A, targetSha: T1 }, { taskSha: A, targetSha: T1 })).toBe(true);
  });
  test("the target moved between the reviewer's start and the checks' integration: replaced", () => {
    expect(reviewFits({ sha: A, targetSha: T1 }, { taskSha: A, targetSha: T2 })).toBe(false);
  });
  test("a reviewer of the branch alone doesn't fit checks that say which target they tested on", () => {
    expect(reviewFits({ sha: A }, { taskSha: A, targetSha: T1 })).toBe(false);
  });
  test("the branch moved: replaced", () => {
    expect(reviewFits({ sha: A, targetSha: T1 }, { taskSha: B, targetSha: T1 })).toBe(false);
  });
  test("checks that don't name a target (no repository: a dry run) compare the commit only", () => {
    expect(reviewFits({ sha: A }, { taskSha: A })).toBe(true);
    expect(reviewFits({ sha: A }, { taskSha: B })).toBe(false);
  });
});
