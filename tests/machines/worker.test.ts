import { describe, test, expect } from "bun:test";
import { workerMachine, type WorkerContext } from "../../src/machines/worker";
import { initialTransition, transition } from "xstate";

describe("Worker Machine - Transition Table", () => {
  const createContext = (): Pick<WorkerContext, "workerId"> => ({
    workerId: "worker-1",
  });

  describe("provisioning state", () => {
    test("can VM_READY -> idle", () => {
      const [snapshot] = initialTransition(workerMachine, createContext());
      expect(snapshot.value).toBe("provisioning");

      const event = { type: "VM_READY" as const, vmId: "vm-123" };
      expect(snapshot.can(event)).toBe(true);

      const [next] = transition(workerMachine, snapshot, event);
      expect(next.value).toBe("idle");
      expect(next.context.vmId).toBe("vm-123");
    });

    test("can VM_FAILED -> failed", () => {
      const [snapshot] = initialTransition(workerMachine, createContext());
      const event = { type: "VM_FAILED" as const, error: "Creation timeout" };
      expect(snapshot.can(event)).toBe(true);

      const [next] = transition(workerMachine, snapshot, event);
      expect(next.value).toBe("failed");
    });

    test("cannot ASSIGN", () => {
      const [snapshot] = initialTransition(workerMachine, createContext());
      const event = {
        type: "ASSIGN" as const,
        taskId: "task-1",
        epoch: 1,
      };
      expect(snapshot.can(event)).toBe(false);
    });
  });

  describe("idle state", () => {
    const getIdleSnapshot = () => {
      const [snapshot] = initialTransition(workerMachine, createContext());
      const [next] = transition(workerMachine, snapshot, {
        type: "VM_READY" as const,
        vmId: "vm-123",
      });
      return next;
    };

    test("can ASSIGN -> busy", () => {
      const snapshot = getIdleSnapshot();
      const event = {
        type: "ASSIGN" as const,
        taskId: "task-1",
        epoch: 1,
      };
      expect(snapshot.can(event)).toBe(true);

      const [next] = transition(workerMachine, snapshot, event);
      expect(next.value).toBe("busy");
      expect(next.context.taskId).toBe("task-1");
      expect(next.context.epoch).toBe(1);
    });

    test("can DRAIN -> draining", () => {
      const snapshot = getIdleSnapshot();
      const event = { type: "DRAIN" as const };
      expect(snapshot.can(event)).toBe(true);

      const [next] = transition(workerMachine, snapshot, event);
      expect(next.value).toBe("draining");
    });

    test("cannot TASK_DONE", () => {
      const snapshot = getIdleSnapshot();
      const event = { type: "TASK_DONE" as const };
      expect(snapshot.can(event)).toBe(false);
    });
  });

  describe("busy state", () => {
    const getBusySnapshot = () => {
      let [snapshot] = initialTransition(workerMachine, createContext());
      [snapshot] = transition(workerMachine, snapshot, {
        type: "VM_READY" as const,
        vmId: "vm-123",
      });
      const [next] = transition(workerMachine, snapshot, {
        type: "ASSIGN" as const,
        taskId: "task-1",
        epoch: 1,
      });
      return next;
    };

    test("can TASK_DONE -> idle", () => {
      const snapshot = getBusySnapshot();
      const event = { type: "TASK_DONE" as const };
      expect(snapshot.can(event)).toBe(true);

      const [next] = transition(workerMachine, snapshot, event);
      expect(next.value).toBe("idle");
      expect(next.context.taskId).toBeUndefined();
      expect(next.context.epoch).toBeUndefined();
    });

    test("can DRAIN -> draining", () => {
      const snapshot = getBusySnapshot();
      const event = { type: "DRAIN" as const };
      expect(snapshot.can(event)).toBe(true);

      const [next] = transition(workerMachine, snapshot, event);
      expect(next.value).toBe("draining");
    });

    test("cannot ASSIGN again", () => {
      const snapshot = getBusySnapshot();
      const event = {
        type: "ASSIGN" as const,
        taskId: "task-2",
        epoch: 2,
      };
      expect(snapshot.can(event)).toBe(false);
    });
  });

  describe("draining state", () => {
    const getDrainingSnapshot = () => {
      let [snapshot] = initialTransition(workerMachine, createContext());
      [snapshot] = transition(workerMachine, snapshot, {
        type: "VM_READY" as const,
        vmId: "vm-123",
      });
      const [next] = transition(workerMachine, snapshot, {
        type: "DRAIN" as const,
      });
      return next;
    };

    test("can VM_DESTROYED -> destroyed", () => {
      const snapshot = getDrainingSnapshot();
      const event = { type: "VM_DESTROYED" as const };
      expect(snapshot.can(event)).toBe(true);

      const [next] = transition(workerMachine, snapshot, event);
      expect(next.value).toBe("destroyed");
    });

    test("cannot ASSIGN", () => {
      const snapshot = getDrainingSnapshot();
      const event = {
        type: "ASSIGN" as const,
        taskId: "task-1",
        epoch: 1,
      };
      expect(snapshot.can(event)).toBe(false);
    });
  });

  describe("failed state", () => {
    const getFailedSnapshot = () => {
      const [snapshot] = initialTransition(workerMachine, createContext());
      const [next] = transition(workerMachine, snapshot, {
        type: "VM_FAILED" as const,
        error: "Creation failed",
      });
      return next;
    };

    test("can VM_DESTROYED -> destroyed", () => {
      const snapshot = getFailedSnapshot();
      const event = { type: "VM_DESTROYED" as const };
      expect(snapshot.can(event)).toBe(true);

      const [next] = transition(workerMachine, snapshot, event);
      expect(next.value).toBe("destroyed");
    });
  });

  describe("destroyed state", () => {
    test("destroyed is final", () => {
      let [snapshot] = initialTransition(workerMachine, createContext());
      [snapshot] = transition(workerMachine, snapshot, {
        type: "VM_READY" as const,
        vmId: "vm-123",
      });
      [snapshot] = transition(workerMachine, snapshot, {
        type: "DRAIN" as const,
      });
      [snapshot] = transition(workerMachine, snapshot, {
        type: "VM_DESTROYED" as const,
      });

      expect(snapshot.value).toBe("destroyed");
      expect(snapshot.can({ type: "ASSIGN", taskId: "task-1", epoch: 1 })).toBe(
        false
      );
    });
  });
});

describe("Worker Machine - parked (ADR-026 §6)", () => {
  const ready = () => transition(workerMachine, initialTransition(workerMachine, { workerId: "agt-1" })[0], { type: "VM_READY" as const, vmId: "vm-1" })[0];
  const park = { type: "PARK" as const, at: 1000, deleteAt: 87_401_000 };

  test("idle (its task done) or busy -> parked, with when it was parked and when it is deleted", () => {
    const [p] = transition(workerMachine, ready(), park);
    expect(p.value).toBe("parked");
    expect(p.context).toMatchObject({ vmId: "vm-1", parked: { at: 1000, deleteAt: 87_401_000 } });
    const busy = transition(workerMachine, ready(), { type: "ASSIGN" as const, taskId: "t", epoch: 1 })[0];
    const [q] = transition(workerMachine, busy, park);
    expect(q.value).toBe("parked");
    expect(q.context.taskId).toBeUndefined();
  });

  test("parked -> draining (deleted) or released (the next attempt's worker took the machine); nothing else", () => {
    const [p] = transition(workerMachine, ready(), park);
    expect(transition(workerMachine, p, { type: "DRAIN" as const })[0].value).toBe("draining");
    const [r] = transition(workerMachine, p, { type: "HANDED_OVER" as const, to: "run/agt-1/e2" });
    expect(r.value).toBe("released");
    // Released owns nothing: no drain, no park, nothing destroyed.
    expect(r.can({ type: "DRAIN" as const })).toBe(false);
    expect(r.can(park)).toBe(false);
    expect(p.can({ type: "ASSIGN" as const, taskId: "t", epoch: 2 })).toBe(false);
    // Only a worker with its machine can park: not while provisioning, draining or destroyed.
    expect(initialTransition(workerMachine, { workerId: "agt-1" })[0].can(park)).toBe(false);
    expect(transition(workerMachine, ready(), { type: "DRAIN" as const })[0].can(park)).toBe(false);
  });
});
