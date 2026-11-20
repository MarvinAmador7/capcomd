import { setup, assign } from "xstate";

export interface WorkerContext {
  workerId: string;
  vmId?: string;
  taskId?: string;
  epoch?: number;
  /** ADR-026 §6: while parked, when it was parked and when its machine is deleted (its retention). */
  parked?: { at: number; deleteAt: number };
  /** The machine's idempotency key and the place it is on (set at provisioning). */
  idemKey?: string;
  sandbox?: string;
  /** ADR-026 §5 path 2: this attempt's machine is the agent's parked one, woken (its checkout and session are there). */
  woke?: boolean;
}

export type WorkerEvent =
  | { type: "VM_READY"; vmId: string }
  | { type: "VM_FAILED"; error: string }
  | { type: "ASSIGN"; taskId: string; epoch: number }
  | { type: "TASK_DONE" }
  | { type: "DRAIN" }
  | { type: "VM_DESTROYED" }
  /** ADR-026 §6: its agent's turn ended and its machine was hibernated, kept for a message to wake. */
  | { type: "PARK"; at: number; deleteAt: number }
  /** ADR-026 §5 path 2: the agent's next attempt (another epoch's worker) took the parked machine over. */
  | { type: "HANDED_OVER"; to: string };

export const workerMachine = setup({
  types: {
    context: {} as WorkerContext,
    events: {} as WorkerEvent,
  },
  actions: {
    storeVm: assign({
      vmId: ({ event }) => {
        if (event.type === "VM_READY") {
          return event.vmId;
        }
        return undefined;
      },
    }),
    assignTask: assign({
      taskId: ({ event }) => {
        if (event.type === "ASSIGN") {
          return event.taskId;
        }
        return undefined;
      },
      epoch: ({ event }) => {
        if (event.type === "ASSIGN") {
          return event.epoch;
        }
        return undefined;
      },
    }),
    clearTask: assign({
      taskId: undefined,
      epoch: undefined,
    }),
    storeParked: assign({
      parked: ({ event }) => (event.type === "PARK" ? { at: event.at, deleteAt: event.deleteAt } : undefined),
    }),
  },
}).createMachine({
  id: "worker",
  initial: "provisioning",
  context: ({ input }: any) => ({
    ...input,
  }),
  states: {
    provisioning: {
      on: {
        VM_READY: {
          target: "idle",
          actions: ["storeVm"],
        },
        VM_FAILED: "failed",
      },
    },
    idle: {
      on: {
        ASSIGN: {
          target: "busy",
          actions: ["assignTask"],
        },
        DRAIN: "draining",
        PARK: { target: "parked", actions: ["storeParked"] },
      },
    },
    busy: {
      on: {
        TASK_DONE: {
          target: "idle",
          actions: ["clearTask"],
        },
        DRAIN: "draining",
        PARK: { target: "parked", actions: ["clearTask", "storeParked"] },
      },
    },
    // ADR-026 §6: the machine is hibernated. It is deleted (DRAIN) when its retention passes, its place has too many
    // parked, its run is archived, its agent is cancelled or the user deletes it; or the agent's next attempt takes it.
    parked: {
      on: {
        DRAIN: "draining",
        HANDED_OVER: "released",
      },
    },
    // The machine is another worker's now (the agent's next attempt): nothing of this worker's to destroy.
    released: {
      type: "final",
    },
    draining: {
      on: {
        VM_DESTROYED: "destroyed",
      },
    },
    failed: {
      on: {
        VM_DESTROYED: "destroyed",
      },
    },
    destroyed: {
      type: "final",
    },
  },
});
