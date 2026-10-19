import { describe, expect, test } from "bun:test";
import { initialTransition, transition } from "xstate";
import { taskMachine } from "../../src/machines/task";
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

describe("task machine approval", () => {
  const verifying = () => {
    let [s] = initialTransition(taskMachine, { taskId: "t", goal: "g", maxRetries: 3, targetBranch: "main" });
    [s] = transition(taskMachine, s, { type: "LEASE_GRANTED", epoch: 1, workerId: "w" });
    [s] = transition(taskMachine, s, { type: "WORKER_STARTED", epoch: 1 });
    [s] = transition(taskMachine, s, { type: "HANDOFF", epoch: 1, branch: "b", commitSha: "c" });
    [s] = transition(taskMachine, s, { type: "VERIFY_STARTED" });
    return s;
  };
  test("verifying -> awaiting_approval -> approved -> merged (merge runs after approval)", () => {
    let [s] = transition(taskMachine, verifying(), { type: "VERIFIED_AWAITING_APPROVAL" });
    expect(s.value).toBe("awaiting_approval");
    expect(s.can({ type: "VERIFIED_AND_MERGED" })).toBe(false);
    [s] = transition(taskMachine, s, { type: "APPROVED", approvedBy: "me", approvedAt: 1 });
    expect(s.value).toBe("approved");
    expect(s.context.approval).toEqual({ approvedBy: "me", approvedAt: 1 });
    const merge = { sha: "abc", mode: "pr" as const, strategy: "squash", how: "pr-squash", already: false, pr: 7 };
    [s] = transition(taskMachine, s, { type: "MERGED", merge });
    expect(s.value).toBe("merged");
    expect(s.context.merge).toEqual(merge);
  });
  test("merge conflict goes back to a worker (new epoch), then escalates when retries run out", () => {
    let s = verifying();
    const epoch = s.context.epoch;
    [s] = transition(taskMachine, s, { type: "MERGE_CONFLICT", files: ["a.ts"], at: 1 });
    expect(s.value).toBe("pending");
    expect(s.context.epoch).toBe(epoch + 1);
    expect(s.context.conflict).toMatchObject({ files: ["a.ts"], escalated: false });
    let [x] = initialTransition(taskMachine, { taskId: "t", goal: "g", maxRetries: 0 });
    [x] = transition(taskMachine, x, { type: "LEASE_GRANTED", epoch: 1, workerId: "w" });
    [x] = transition(taskMachine, x, { type: "WORKER_STARTED", epoch: 1 });
    [x] = transition(taskMachine, x, { type: "HANDOFF", epoch: 1, branch: "b", commitSha: "c" });
    [x] = transition(taskMachine, x, { type: "VERIFY_STARTED" });
    [x] = transition(taskMachine, x, { type: "MERGE_CONFLICT", files: ["a.ts"], at: 1 });
    expect(x.value).toBe("failed");
    expect(x.context.conflict?.escalated).toBe(true);
  });
  test("awaiting_approval can be cancelled", () => {
    let [s] = transition(taskMachine, verifying(), { type: "VERIFIED_AWAITING_APPROVAL" });
    [s] = transition(taskMachine, s, { type: "CANCEL" });
    expect(s.value).toBe("cancelled");
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
