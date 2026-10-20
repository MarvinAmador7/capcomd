import { expect, test } from "bun:test";
import { zeroMergedVerdict } from "../../src/actors/judge";
import { isNoopGoal } from "../../src/core/relay";

test("judge: 0 merged fails the run unless the goal is tagged [noop]", () => {
  expect(zeroMergedVerdict([])).toMatchObject({ passed: false });
  expect(zeroMergedVerdict([], false)?.feedback).toContain("[noop]");
  expect(zeroMergedVerdict([], true)).toBeNull();
  expect(zeroMergedVerdict(["task-1"])).toBeNull();
  expect(isNoopGoal("[noop] confirm the repo is already clean")).toBe(true);
  expect(isNoopGoal("[agent:cx] [NOOP] audit only")).toBe(true);
  expect(isNoopGoal("ship the feature")).toBe(false);
});
