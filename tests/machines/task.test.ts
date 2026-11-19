import { describe, test, expect } from "bun:test";
import { taskMachine, type TaskContext } from "../../src/machines/task";
import { initialTransition, transition } from "xstate";

describe("Task Machine - Transition Table", () => {
  const createContext = (): TaskContext => ({
    taskId: "task-1",
    goal: "Test task",
    epoch: 0,
    retryCount: 0,
    maxRetries: 3,
  });

  describe("pending state", () => {
    test("can LEASE_GRANTED -> leased", () => {
      const [snapshot] = initialTransition(taskMachine, createContext());
      expect(snapshot.value).toBe("pending");

      const event = {
        type: "LEASE_GRANTED" as const,
        epoch: 1,
        workerId: "worker-1",
      };
      expect(snapshot.can(event)).toBe(true);

      const [next] = transition(taskMachine, snapshot, event);
      expect(next.value).toBe("leased");
      expect(next.context.epoch).toBe(1);
      expect(next.context.workerId).toBe("worker-1");
    });

    test("can CANCEL -> cancelled", () => {
      const [snapshot] = initialTransition(taskMachine, createContext());
      const event = { type: "CANCEL" as const };
      expect(snapshot.can(event)).toBe(true);

      const [next] = transition(taskMachine, snapshot, event);
      expect(next.value).toBe("cancelled");
    });

    test("cannot WORKER_STARTED", () => {
      const [snapshot] = initialTransition(taskMachine, createContext());
      const event = { type: "WORKER_STARTED" as const, epoch: 1 };
      expect(snapshot.can(event)).toBe(false);
    });

    test("cannot HANDOFF", () => {
      const [snapshot] = initialTransition(taskMachine, createContext());
      const event = {
        type: "HANDOFF" as const,
        epoch: 1,
        branch: "test",
        commitSha: "abc",
      };
      expect(snapshot.can(event)).toBe(false);
    });
  });

  describe("leased state", () => {
    const getLeasedSnapshot = () => {
      const [snapshot] = initialTransition(taskMachine, createContext());
      const [next] = transition(taskMachine, snapshot, {
        type: "LEASE_GRANTED" as const,
        epoch: 1,
        workerId: "worker-1",
      });
      return next;
    };

    test("can WORKER_STARTED with matching epoch -> running", () => {
      const snapshot = getLeasedSnapshot();
      const event = { type: "WORKER_STARTED" as const, epoch: 1 };
      expect(snapshot.can(event)).toBe(true);

      const [next] = transition(taskMachine, snapshot, event);
      expect(next.value).toBe("running");
    });

    test("cannot WORKER_STARTED with wrong epoch", () => {
      const snapshot = getLeasedSnapshot();
      const event = { type: "WORKER_STARTED" as const, epoch: 2 };
      expect(snapshot.can(event)).toBe(false);
    });

    test("can LEASE_EXPIRED -> pending", () => {
      const snapshot = getLeasedSnapshot();
      const event = { type: "LEASE_EXPIRED" as const };
      expect(snapshot.can(event)).toBe(true);

      const [next] = transition(taskMachine, snapshot, event);
      expect(next.value).toBe("pending");
      expect(next.context.epoch).toBe(2);
    });

    test("can CANCEL -> cancelled", () => {
      const snapshot = getLeasedSnapshot();
      const event = { type: "CANCEL" as const };
      expect(snapshot.can(event)).toBe(true);

      const [next] = transition(taskMachine, snapshot, event);
      expect(next.value).toBe("cancelled");
    });
  });

  describe("running state", () => {
    const getRunningSnapshot = () => {
      let [snapshot] = initialTransition(taskMachine, createContext());
      [snapshot] = transition(taskMachine, snapshot, {
        type: "LEASE_GRANTED" as const,
        epoch: 1,
        workerId: "worker-1",
      });
      const [next] = transition(taskMachine, snapshot, {
        type: "WORKER_STARTED" as const,
        epoch: 1,
      });
      return next;
    };

    test("can HANDOFF with matching epoch -> handed_off", () => {
      const snapshot = getRunningSnapshot();
      const event = {
        type: "HANDOFF" as const,
        epoch: 1,
        branch: "task/test",
        commitSha: "abc123",
      };
      expect(snapshot.can(event)).toBe(true);

      const [next] = transition(taskMachine, snapshot, event);
      expect(next.value).toBe("handed_off");
      expect(next.context.handoffData?.branch).toBe("task/test");
    });

    test("cannot HANDOFF with wrong epoch", () => {
      const snapshot = getRunningSnapshot();
      const event = {
        type: "HANDOFF" as const,
        epoch: 2,
        branch: "task/test",
        commitSha: "abc123",
      };
      expect(snapshot.can(event)).toBe(false);
    });

    test("can LEASE_EXPIRED within budget -> pending", () => {
      const snapshot = getRunningSnapshot();
      const event = { type: "LEASE_EXPIRED" as const };
      expect(snapshot.can(event)).toBe(true);

      const [next] = transition(taskMachine, snapshot, event);
      expect(next.value).toBe("pending");
      expect(next.context.retryCount).toBe(1);
      expect(next.context.epoch).toBe(2);
    });

    test("can LEASE_EXPIRED over budget -> failed", () => {
      let [snapshot] = initialTransition(taskMachine, {
        ...createContext(),
        retryCount: 3,
        maxRetries: 3,
      });
      [snapshot] = transition(taskMachine, snapshot, {
        type: "LEASE_GRANTED" as const,
        epoch: 1,
        workerId: "worker-1",
      });
      [snapshot] = transition(taskMachine, snapshot, {
        type: "WORKER_STARTED" as const,
        epoch: 1,
      });

      const event = { type: "LEASE_EXPIRED" as const };
      expect(snapshot.can(event)).toBe(true);

      const [next] = transition(taskMachine, snapshot, event);
      expect(next.value).toBe("failed");
    });

    test("can CANCEL -> cancelled", () => {
      const snapshot = getRunningSnapshot();
      const event = { type: "CANCEL" as const };
      expect(snapshot.can(event)).toBe(true);

      const [next] = transition(taskMachine, snapshot, event);
      expect(next.value).toBe("cancelled");
    });
  });

  describe("handed_off state", () => {
    const getHandedOffSnapshot = () => {
      let [snapshot] = initialTransition(taskMachine, createContext());
      [snapshot] = transition(taskMachine, snapshot, {
        type: "LEASE_GRANTED" as const,
        epoch: 1,
        workerId: "worker-1",
      });
      [snapshot] = transition(taskMachine, snapshot, {
        type: "WORKER_STARTED" as const,
        epoch: 1,
      });
      const [next] = transition(taskMachine, snapshot, {
        type: "HANDOFF" as const,
        epoch: 1,
        branch: "task/test",
        commitSha: "abc123",
      });
      return next;
    };

    test("can VERIFY_STARTED -> verifying", () => {
      const snapshot = getHandedOffSnapshot();
      const event = { type: "VERIFY_STARTED" as const };
      expect(snapshot.can(event)).toBe(true);

      const [next] = transition(taskMachine, snapshot, event);
      expect(next.value).toBe("verifying");
    });

    test("cannot CANCEL", () => {
      const snapshot = getHandedOffSnapshot();
      const event = { type: "CANCEL" as const };
      expect(snapshot.can(event)).toBe(false);
    });
  });

  describe("verifying state", () => {
    const getVerifyingSnapshot = () => {
      let [snapshot] = initialTransition(taskMachine, createContext());
      [snapshot] = transition(taskMachine, snapshot, {
        type: "LEASE_GRANTED" as const,
        epoch: 1,
        workerId: "worker-1",
      });
      [snapshot] = transition(taskMachine, snapshot, {
        type: "WORKER_STARTED" as const,
        epoch: 1,
      });
      [snapshot] = transition(taskMachine, snapshot, {
        type: "HANDOFF" as const,
        epoch: 1,
        branch: "task/test",
        commitSha: "abc123",
      });
      const [next] = transition(taskMachine, snapshot, {
        type: "VERIFY_STARTED" as const,
      });
      return next;
    };

    test("can VERIFIED_AND_MERGED -> merged", () => {
      const snapshot = getVerifyingSnapshot();
      const event = { type: "VERIFIED_AND_MERGED" as const };
      expect(snapshot.can(event)).toBe(true);

      const [next] = transition(taskMachine, snapshot, event);
      expect(next.value).toBe("merged");
      expect(next.context.verificationResult?.passed).toBe(true);
    });

    test("can VERIFY_FAILED within budget -> pending", () => {
      const snapshot = getVerifyingSnapshot();
      const event = {
        type: "VERIFY_FAILED" as const,
        reason: "Tests failed",
      };
      expect(snapshot.can(event)).toBe(true);

      const [next] = transition(taskMachine, snapshot, event);
      expect(next.value).toBe("pending");
      expect(next.context.retryCount).toBe(1);
      expect(next.context.verificationResult?.passed).toBe(false);
    });

    test("can VERIFY_FAILED over budget -> failed", () => {
      let [snapshot] = initialTransition(taskMachine, {
        ...createContext(),
        retryCount: 3,
        maxRetries: 3,
      });
      [snapshot] = transition(taskMachine, snapshot, {
        type: "LEASE_GRANTED" as const,
        epoch: 1,
        workerId: "worker-1",
      });
      [snapshot] = transition(taskMachine, snapshot, {
        type: "WORKER_STARTED" as const,
        epoch: 1,
      });
      [snapshot] = transition(taskMachine, snapshot, {
        type: "HANDOFF" as const,
        epoch: 1,
        branch: "task/test",
        commitSha: "abc123",
      });
      [snapshot] = transition(taskMachine, snapshot, {
        type: "VERIFY_STARTED" as const,
      });

      const event = {
        type: "VERIFY_FAILED" as const,
        reason: "Tests failed",
      };
      expect(snapshot.can(event)).toBe(true);

      const [next] = transition(taskMachine, snapshot, event);
      expect(next.value).toBe("failed");
    });
  });

  describe("terminal states", () => {
    test("merged is final", () => {
      let [snapshot] = initialTransition(taskMachine, createContext());
      [snapshot] = transition(taskMachine, snapshot, {
        type: "LEASE_GRANTED" as const,
        epoch: 1,
        workerId: "worker-1",
      });
      [snapshot] = transition(taskMachine, snapshot, {
        type: "WORKER_STARTED" as const,
        epoch: 1,
      });
      [snapshot] = transition(taskMachine, snapshot, {
        type: "HANDOFF" as const,
        epoch: 1,
        branch: "task/test",
        commitSha: "abc123",
      });
      [snapshot] = transition(taskMachine, snapshot, {
        type: "VERIFY_STARTED" as const,
      });
      [snapshot] = transition(taskMachine, snapshot, {
        type: "VERIFIED_AND_MERGED" as const,
      });

      expect(snapshot.value).toBe("merged");
      expect(snapshot.can({ type: "CANCEL" })).toBe(false);
    });

    test("failed is final", () => {
      let [snapshot] = initialTransition(taskMachine, {
        ...createContext(),
        retryCount: 3,
        maxRetries: 3,
      });
      [snapshot] = transition(taskMachine, snapshot, {
        type: "LEASE_GRANTED" as const,
        epoch: 1,
        workerId: "worker-1",
      });
      [snapshot] = transition(taskMachine, snapshot, {
        type: "WORKER_STARTED" as const,
        epoch: 1,
      });
      [snapshot] = transition(taskMachine, snapshot, {
        type: "LEASE_EXPIRED" as const,
      });

      expect(snapshot.value).toBe("failed");
      expect(snapshot.can({ type: "CANCEL" })).toBe(false);
    });

    test("cancelled is final", () => {
      const [snapshot] = initialTransition(taskMachine, createContext());
      const [next] = transition(taskMachine, snapshot, {
        type: "CANCEL" as const,
      });

      expect(next.value).toBe("cancelled");
      expect(next.can({ type: "LEASE_GRANTED", epoch: 1, workerId: "w1" })).toBe(
        false
      );
    });
  });
});

// Approval and merge conflicts.
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
