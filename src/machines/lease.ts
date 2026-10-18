import { setup, assign } from "xstate";

export interface LeaseContext {
  taskId: string;
  workerId?: string;
  epoch: number;
  expiresAt?: number;
  ttlMs: number;
}

export type LeaseEvent =
  | { type: "GRANT"; workerId: string; now: number }
  | { type: "HEARTBEAT"; epoch: number; now: number }
  | { type: "RELEASE"; epoch: number }
  | { type: "TIMEOUT" };

export const leaseMachine = setup({
  types: {
    context: {} as LeaseContext,
    events: {} as LeaseEvent,
  },
  guards: {
    epochMatches: ({ context, event }) => {
      if ("epoch" in event) {
        return event.epoch === context.epoch;
      }
      return false;
    },
  },
  actions: {
    grantLease: assign({
      workerId: ({ event }) => {
        if (event.type === "GRANT") {
          return event.workerId;
        }
        return undefined;
      },
      epoch: ({ context }) => context.epoch + 1,
      expiresAt: ({ context, event }) => {
        if (event.type === "GRANT") {
          return event.now + context.ttlMs;
        }
        return undefined;
      },
    }),
    extendLease: assign({
      expiresAt: ({ context, event }) => {
        if (event.type === "HEARTBEAT") {
          return event.now + context.ttlMs;
        }
        return context.expiresAt;
      },
    }),
    clearLease: assign({
      workerId: undefined,
      expiresAt: undefined,
    }),
  },
}).createMachine({
  id: "lease",
  initial: "free",
  context: ({ input }: any) => ({
    ...input,
    epoch: 0,
  }),
  states: {
    free: {
      on: {
        GRANT: {
          target: "held",
          actions: ["grantLease"],
        },
      },
    },
    held: {
      on: {
        HEARTBEAT: {
          target: "held",
          guard: "epochMatches",
          actions: ["extendLease"],
        },
        RELEASE: {
          target: "released",
          guard: "epochMatches",
        },
        TIMEOUT: "expired",
      },
    },
    released: {
      always: {
        target: "free",
        actions: ["clearLease"],
      },
    },
    expired: {
      always: {
        target: "free",
        actions: ["clearLease"],
      },
    },
  },
});
