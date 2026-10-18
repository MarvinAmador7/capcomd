import { describe, expect, test } from "bun:test";
import { initialTransition, transition } from "xstate";
import { taskMachine } from "../../src/machines/task";
import { isProtectedBranch } from "../../src/utils/protected";

describe("protected branches", () => {
  test("defaults", () => {
    delete process.env.RELAY_PROTECTED_BRANCHES;
    expect(isProtectedBranch("main")).toBe(true);
    expect(isProtectedBranch("release/1.2")).toBe(true);
    expect(isProtectedBranch("task/task-1/e1")).toBe(false);
    expect(isProtectedBranch(undefined)).toBe(false);
  });
  test("env override", () => {
    process.env.RELAY_PROTECTED_BRANCHES = "prod,hotfix/*";
    expect(isProtectedBranch("main")).toBe(false);
    expect(isProtectedBranch("hotfix/x")).toBe(true);
    delete process.env.RELAY_PROTECTED_BRANCHES;
  });
});

describe("task machine approval", () => {
  const verifying = () => {
    let [s] = initialTransition(taskMachine, { taskId: "t", goal: "g", maxRetries: 3, targetBranch: "main" });
    [s] = transition(taskMachine, s, { type: "LEASE_GRANTED", epoch: 1, workerId: "w" });
    [s] = transition(taskMachine, s, { type: "WORKER_STARTED", epoch: 1 });
    [s] = transition(taskMachine, s, { type: "HANDOFF", epoch: 1, branch: "b", commitSha: "c" });
    [s] = transition(taskMachine, s, { type: "VERIFY_STARTED" });
    return s;
  };
  test("verifying -> awaiting_approval -> merged", () => {
    let [s] = transition(taskMachine, verifying(), { type: "VERIFIED_AWAITING_APPROVAL" });
    expect(s.value).toBe("awaiting_approval");
    expect(s.can({ type: "VERIFIED_AND_MERGED" })).toBe(false);
    [s] = transition(taskMachine, s, { type: "APPROVED", approvedBy: "me", approvedAt: 1 });
    expect(s.value).toBe("merged");
    expect(s.context.approval).toEqual({ approvedBy: "me", approvedAt: 1 });
  });
  test("awaiting_approval can be cancelled", () => {
    let [s] = transition(taskMachine, verifying(), { type: "VERIFIED_AWAITING_APPROVAL" });
    [s] = transition(taskMachine, s, { type: "CANCEL" });
    expect(s.value).toBe("cancelled");
  });
});
