import { describe, test, expect } from "bun:test";
import { leaseMachine, type LeaseContext } from "../../src/machines/lease";
import { initialTransition, transition } from "xstate";

describe("Lease Machine - Transition Table", () => {
  const createContext = (): Omit<LeaseContext, "epoch"> => ({
    taskId: "task-1",
    ttlMs: 60_000,
  });

  describe("free state", () => {
    test("can GRANT -> held", () => {
      const [snapshot] = initialTransition(leaseMachine, createContext());
      expect(snapshot.value).toBe("free");

      const event = {
        type: "GRANT" as const,
        workerId: "worker-1",
        now: 1000,
      };
      expect(snapshot.can(event)).toBe(true);

      const [next] = transition(leaseMachine, snapshot, event);
      expect(next.value).toBe("held");
      expect(next.context.workerId).toBe("worker-1");
      expect(next.context.epoch).toBe(1);
      expect(next.context.expiresAt).toBe(61000);
    });

    test("cannot HEARTBEAT", () => {
      const [snapshot] = initialTransition(leaseMachine, createContext());
      const event = {
        type: "HEARTBEAT" as const,
        epoch: 1,
        now: 1000,
      };
      expect(snapshot.can(event)).toBe(false);
    });
  });

  describe("held state", () => {
    const getHeldSnapshot = () => {
      const [snapshot] = initialTransition(leaseMachine, createContext());
      const [next] = transition(leaseMachine, snapshot, {
        type: "GRANT" as const,
        workerId: "worker-1",
        now: 1000,
      });
      return next;
    };

    test("can HEARTBEAT with matching epoch -> held (extended)", () => {
      const snapshot = getHeldSnapshot();
      const event = {
        type: "HEARTBEAT" as const,
        epoch: 1,
        now: 30000,
      };
      expect(snapshot.can(event)).toBe(true);

      const [next] = transition(leaseMachine, snapshot, event);
      expect(next.value).toBe("held");
      expect(next.context.expiresAt).toBe(90000);
    });

    test("cannot HEARTBEAT with wrong epoch", () => {
      const snapshot = getHeldSnapshot();
      const event = {
        type: "HEARTBEAT" as const,
        epoch: 2,
        now: 30000,
      };
      expect(snapshot.can(event)).toBe(false);
    });

    test("can RELEASE with matching epoch -> free (via released)", () => {
      const snapshot = getHeldSnapshot();
      const event = {
        type: "RELEASE" as const,
        epoch: 1,
      };
      expect(snapshot.can(event)).toBe(true);

      const [next] = transition(leaseMachine, snapshot, event);
      // released -> free happens immediately via always transition
      expect(next.value).toBe("free");
    });

    test("cannot RELEASE with wrong epoch", () => {
      const snapshot = getHeldSnapshot();
      const event = {
        type: "RELEASE" as const,
        epoch: 2,
      };
      expect(snapshot.can(event)).toBe(false);
    });

    test("can TIMEOUT -> free (via expired)", () => {
      const snapshot = getHeldSnapshot();
      const event = { type: "TIMEOUT" as const };
      expect(snapshot.can(event)).toBe(true);

      const [next] = transition(leaseMachine, snapshot, event);
      expect(next.value).toBe("free");
    });
  });

  describe("released state", () => {
    test("automatically transitions to free", () => {
      let [snapshot] = initialTransition(leaseMachine, createContext());
      [snapshot] = transition(leaseMachine, snapshot, {
        type: "GRANT" as const,
        workerId: "worker-1",
        now: 1000,
      });
      [snapshot] = transition(leaseMachine, snapshot, {
        type: "RELEASE" as const,
        epoch: 1,
      });

      expect(snapshot.value).toBe("free");
      expect(snapshot.context.workerId).toBeUndefined();
      expect(snapshot.context.expiresAt).toBeUndefined();
    });
  });

  describe("expired state", () => {
    test("automatically transitions to free", () => {
      let [snapshot] = initialTransition(leaseMachine, createContext());
      [snapshot] = transition(leaseMachine, snapshot, {
        type: "GRANT" as const,
        workerId: "worker-1",
        now: 1000,
      });
      [snapshot] = transition(leaseMachine, snapshot, {
        type: "TIMEOUT" as const,
      });

      expect(snapshot.value).toBe("free");
      expect(snapshot.context.workerId).toBeUndefined();
      expect(snapshot.context.expiresAt).toBeUndefined();
    });
  });

  describe("epoch increments", () => {
    test("epoch increments on each grant", () => {
      let [snapshot] = initialTransition(leaseMachine, createContext());
      expect(snapshot.context.epoch).toBe(0);

      [snapshot] = transition(leaseMachine, snapshot, {
        type: "GRANT" as const,
        workerId: "worker-1",
        now: 1000,
      });
      expect(snapshot.context.epoch).toBe(1);

      [snapshot] = transition(leaseMachine, snapshot, {
        type: "TIMEOUT" as const,
      });
      expect(snapshot.value).toBe("free");

      [snapshot] = transition(leaseMachine, snapshot, {
        type: "GRANT" as const,
        workerId: "worker-2",
        now: 2000,
      });
      expect(snapshot.context.epoch).toBe(2);
      expect(snapshot.context.workerId).toBe("worker-2");
    });
  });
});
