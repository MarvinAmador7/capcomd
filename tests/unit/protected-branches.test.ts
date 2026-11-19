import { describe, expect, test } from "bun:test";
import { isProtectedBranch } from "../../src/utils/protected";

describe("protected branches", () => {
  test("defaults", () => {
    delete process.env.CAPCOMD_PROTECTED_BRANCHES;
    expect(isProtectedBranch("main")).toBe(true);
    expect(isProtectedBranch("release/1.2")).toBe(true);
    expect(isProtectedBranch("task/task-1/e1")).toBe(false);
    expect(isProtectedBranch(undefined)).toBe(false);
  });
  test("env override", () => {
    process.env.CAPCOMD_PROTECTED_BRANCHES = "prod,hotfix/*";
    expect(isProtectedBranch("main")).toBe(false);
    expect(isProtectedBranch("hotfix/x")).toBe(true);
    delete process.env.CAPCOMD_PROTECTED_BRANCHES;
  });
});

import { env } from "../../src/utils/env";
describe("CAPCOMD_* env with deprecated RELAY_* aliases", () => {
  test("CAPCOMD_ wins, RELAY_ is the fallback, unset is undefined", () => {
    expect(env("X", { CAPCOMD_X: "new", RELAY_X: "old" })).toBe("new");
    expect(env("X", { RELAY_X: "old" })).toBe("old");
    expect(env("X", {})).toBeUndefined();
  });
});
