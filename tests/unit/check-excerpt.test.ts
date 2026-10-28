// A failed check's excerpt on the agent's result (verification.checks.excerpt): the lines that name the failure.
import { expect, test } from "bun:test";
import { checkExcerpt } from "../../src/primitives/ops";

test("the last lines that name the failure, without colour codes", () => {
  const out = [
    "bun test v1.4.2", "", "src/prorate.test.ts:", "\x1b[32m(pass)\x1b[0m prorates a full month", "\x1b[31m(fail)\x1b[0m rounds half up [2.00ms]",
    "error: expect(received).toBe(expected)", "Expected: 10.33", "Received: 10.34", "", " 13 pass", " 1 fail", "Ran 14 tests across 1 file. [48.00ms]",
  ].join("\n");
  expect(checkExcerpt(out)).toBe("Expected: 10.33\nReceived: 10.34\n 1 fail");
});

test("no line names a failure: the last three; empty output: none; long lines are cut", () => {
  expect(checkExcerpt("one\ntwo\nthree\nfour\n")).toBe("two\nthree\nfour");
  expect(checkExcerpt("\n  \n")).toBeNull();
  expect(checkExcerpt(`error: ${"x".repeat(300)}`)!.length).toBe(160);
});
