import { describe, test, expect } from "bun:test";
import { runMachine, type RunContext } from "../../src/machines/run";
import { initialTransition, transition } from "xstate";

describe("Run Machine - Transition Table", () => {
  describe("planning state", () => {
    test("can PLAN_READY -> executing", () => {
      const [snapshot] = initialTransition(runMachine, {
        runId: "test-run",
        goal: "Test goal",
        maxCost: 10.0,
      });

      expect(snapshot.value).toBe("planning");

      const event = { type: "PLAN_READY" as const, tasks: ["task-1", "task-2"] };
      expect(snapshot.can(event)).toBe(true);

      const [nextSnapshot] = transition(runMachine, snapshot, event);
      expect(nextSnapshot.value).toBe("executing");
      expect((nextSnapshot.context as RunContext).plan?.tasks).toEqual(["task-1", "task-2"]);
    });

    test("cannot ALL_TASKS_TERMINAL", () => {
      const [snapshot] = initialTransition(runMachine, {
        runId: "test-run",
        goal: "Test goal",
        maxCost: 10.0,
      });

      const event = { type: "ALL_TASKS_TERMINAL" as const };
      expect(snapshot.can(event)).toBe(false);
    });
  });

  describe("executing state", () => {
    test("can ALL_TASKS_TERMINAL -> judging", () => {
      const [snapshot] = initialTransition(runMachine, {
        runId: "test-run",
        goal: "Test goal",
        maxCost: 10.0,
      });

      const [execSnapshot] = transition(runMachine, snapshot, {
        type: "PLAN_READY",
        tasks: ["task-1"],
      });

      expect(execSnapshot.value).toBe("executing");

      const event = { type: "ALL_TASKS_TERMINAL" as const };
      expect(execSnapshot.can(event)).toBe(true);

      const [nextSnapshot] = transition(runMachine, execSnapshot, event);
      expect(nextSnapshot.value).toBe("judging");
    });

    test("cannot BUDGET_EXCEEDED from executing", () => {
      const [snapshot] = initialTransition(runMachine, {
        runId: "test-run",
        goal: "Test goal",
        maxCost: 10.0,
      });

      const [execSnapshot] = transition(runMachine, snapshot, {
        type: "PLAN_READY",
        tasks: ["task-1"],
      });

      const event = { type: "BUDGET_EXCEEDED" } as unknown as Parameters<typeof execSnapshot.can>[0];
      expect(execSnapshot.can(event)).toBe(false);
    });
  });

  describe("judging state", () => {
    test("can JUDGE_PASS -> completed", () => {
      const [snapshot] = initialTransition(runMachine, {
        runId: "test-run",
        goal: "Test goal",
        maxCost: 10.0,
      });

      const [execSnapshot] = transition(runMachine, snapshot, {
        type: "PLAN_READY",
        tasks: ["task-1"],
      });

      const [judgingSnapshot] = transition(runMachine, execSnapshot, {
        type: "ALL_TASKS_TERMINAL",
      });

      expect(judgingSnapshot.value).toBe("judging");

      const event = { type: "JUDGE_PASS" as const };
      expect(judgingSnapshot.can(event)).toBe(true);

      const [nextSnapshot] = transition(runMachine, judgingSnapshot, event);
      expect(nextSnapshot.value).toBe("completed");
    });

    test("can JUDGE_FAIL -> failed", () => {
      const [snapshot] = initialTransition(runMachine, {
        runId: "test-run",
        goal: "Test goal",
        maxCost: 10.0,
      });

      const [execSnapshot] = transition(runMachine, snapshot, {
        type: "PLAN_READY",
        tasks: ["task-1"],
      });

      const [judgingSnapshot] = transition(runMachine, execSnapshot, {
        type: "ALL_TASKS_TERMINAL",
      });

      const event = { type: "JUDGE_FAIL" as const, reason: "Did not meet requirements" };
      expect(judgingSnapshot.can(event)).toBe(true);

      const [nextSnapshot] = transition(runMachine, judgingSnapshot, event);
      expect(nextSnapshot.value).toBe("failed");
    });
  });

  describe("terminal states", () => {
    test("completed is final", () => {
      const [snapshot] = initialTransition(runMachine, {
        runId: "test-run",
        goal: "Test goal",
        maxCost: 10.0,
      });

      const [exec] = transition(runMachine, snapshot, { type: "PLAN_READY", tasks: ["task-1"] });
      const [judging] = transition(runMachine, exec, { type: "ALL_TASKS_TERMINAL" });
      const [completed] = transition(runMachine, judging, { type: "JUDGE_PASS" });

      expect(completed.value).toBe("completed");
      expect(completed.can({ type: "PLAN_READY", tasks: [] })).toBe(false);
      expect(completed.can({ type: "BUDGET_EXCEEDED" } as unknown as Parameters<typeof completed.can>[0])).toBe(false);
    });

    test("failed is final", () => {
      const [snapshot] = initialTransition(runMachine, {
        runId: "test-run",
        goal: "Test goal",
        maxCost: 10.0,
      });

      const [exec] = transition(runMachine, snapshot, { type: "PLAN_READY", tasks: ["task-1"] });
      const [judging] = transition(runMachine, exec, { type: "ALL_TASKS_TERMINAL" });
      const [failed] = transition(runMachine, judging, { type: "JUDGE_FAIL", reason: "Failed" });

      expect(failed.value).toBe("failed");
      expect(failed.can({ type: "JUDGE_PASS" })).toBe(false);
      expect(failed.can({ type: "ALL_TASKS_TERMINAL" })).toBe(false);
    });
  });
});
