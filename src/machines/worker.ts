import { setup, assign } from "xstate";

export interface WorkerContext {
  workerId: string;
  vmId?: string;
  taskId?: string;
  epoch?: number;
}

export type WorkerEvent =
  | { type: "VM_READY"; vmId: string }
  | { type: "VM_FAILED"; error: string }
  | { type: "ASSIGN"; taskId: string; epoch: number }
  | { type: "TASK_DONE" }
  | { type: "DRAIN" }
  | { type: "VM_DESTROYED" };

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
      },
    },
    busy: {
      on: {
        TASK_DONE: {
          target: "idle",
          actions: ["clearTask"],
        },
        DRAIN: "draining",
      },
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
