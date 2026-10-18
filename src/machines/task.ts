import { setup, assign } from "xstate";

export interface TaskContext {
  taskId: string;
  goal: string;
  epoch: number;
  workerId?: string;
  retryCount: number;
  maxRetries: number;
  handoffData?: {
    branch: string;
    commitSha: string;
  };
  verificationResult?: {
    passed: boolean;
    reason?: string;
  };
}

export type TaskEvent =
  | { type: "LEASE_GRANTED"; epoch: number; workerId: string }
  | { type: "WORKER_STARTED"; epoch: number }
  | { type: "LEASE_EXPIRED" }
  | { type: "HANDOFF"; epoch: number; branch: string; commitSha: string }
  | { type: "VERIFY_STARTED" }
  | { type: "VERIFIED_AND_MERGED" }
  | { type: "VERIFY_FAILED"; reason: string }
  | { type: "CANCEL" };

export const taskMachine = setup({
  types: {
    context: {} as TaskContext,
    events: {} as TaskEvent,
  },
  guards: {
    epochMatches: ({ context, event }) => {
      if ("epoch" in event) {
        return event.epoch === context.epoch;
      }
      return false;
    },
    withinBudget: ({ context }) => {
      return context.retryCount < context.maxRetries;
    },
  },
  actions: {
    incrementEpoch: assign({
      epoch: ({ context }) => context.epoch + 1,
    }),
    incrementRetry: assign({
      retryCount: ({ context }) => context.retryCount + 1,
    }),
    assignWorker: assign({
      workerId: ({ event }) => {
        if (event.type === "LEASE_GRANTED") {
          return event.workerId;
        }
        return undefined;
      },
      epoch: ({ event }) => {
        if (event.type === "LEASE_GRANTED") {
          return event.epoch;
        }
        return 0;
      },
    }),
    storeHandoff: assign({
      handoffData: ({ event }) => {
        if (event.type === "HANDOFF") {
          return {
            branch: event.branch,
            commitSha: event.commitSha,
          };
        }
        return undefined;
      },
    }),
    storeVerificationResult: assign({
      verificationResult: ({ event }) => {
        if (event.type === "VERIFY_FAILED") {
          return {
            passed: false,
            reason: event.reason,
          };
        } else if (event.type === "VERIFIED_AND_MERGED") {
          return {
            passed: true,
          };
        }
        return undefined;
      },
    }),
  },
}).createMachine({
  id: "task",
  initial: "pending",
  context: ({ input }: any) => ({
    epoch: 0,
    retryCount: 0,
    ...input,
  }),
  states: {
    pending: {
      on: {
        LEASE_GRANTED: {
          target: "leased",
          actions: ["assignWorker"],
        },
        CANCEL: "cancelled",
      },
    },
    leased: {
      on: {
        WORKER_STARTED: {
          target: "running",
          guard: "epochMatches",
        },
        LEASE_EXPIRED: {
          target: "pending",
          actions: ["incrementEpoch"],
        },
        CANCEL: "cancelled",
      },
    },
    running: {
      on: {
        HANDOFF: {
          target: "handed_off",
          guard: "epochMatches",
          actions: ["storeHandoff"],
        },
        LEASE_EXPIRED: [
          {
            target: "pending",
            guard: "withinBudget",
            actions: ["incrementRetry", "incrementEpoch"],
          },
          {
            target: "failed",
            actions: ["incrementRetry"],
          },
        ],
        CANCEL: "cancelled",
      },
    },
    handed_off: {
      on: {
        VERIFY_STARTED: "verifying",
      },
    },
    verifying: {
      on: {
        VERIFIED_AND_MERGED: {
          target: "merged",
          actions: ["storeVerificationResult"],
        },
        VERIFY_FAILED: [
          {
            target: "pending",
            guard: "withinBudget",
            actions: ["storeVerificationResult", "incrementRetry", "incrementEpoch"],
          },
          {
            target: "failed",
            actions: ["storeVerificationResult", "incrementRetry"],
          },
        ],
      },
    },
    merged: {
      type: "final",
    },
    failed: {
      type: "final",
    },
    cancelled: {
      type: "final",
    },
  },
});
