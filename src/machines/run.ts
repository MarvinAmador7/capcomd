import { setup, assign } from "xstate";

export interface RunContext {
  runId: string;
  goal: string;
  budget: {
    maxCost: number;
    spent: number;
  };
  plan?: {
    tasks: string[];
    version: number;
  };
  providerOutages: number;
  /** Set when the run failed for a non-retryable reason (e.g. sandbox credentials rejected). */
  failure?: { kind: "config"; reason: string; retryable: false };
}

export type RunEvent =
  | { type: "PLAN_READY"; tasks: string[] }
  | { type: "ALL_TASKS_TERMINAL" }
  | { type: "JUDGE_PASS" }
  | { type: "JUDGE_REPLAN"; newTasks: string[] }
  | { type: "JUDGE_FAIL"; reason: string }
  | { type: "CANCEL" }
  | { type: "PROVIDER_OUTAGE" }
  | { type: "PROVIDER_RECOVERED" }
  | { type: "CONFIG_ERROR"; reason: string };

export const runMachine = setup({
  types: {
    context: {} as RunContext,
    events: {} as RunEvent,
  },
  guards: {
    withinBudget: ({ context }) => {
      return context.budget.spent < context.budget.maxCost;
    },
  },
  actions: {
    storePlan: assign({
      plan: ({ context, event }) => {
        if (event.type === "PLAN_READY") {
          return {
            tasks: event.tasks,
            version: context.plan ? context.plan.version + 1 : 1,
          };
        } else if (event.type === "JUDGE_REPLAN") {
          return {
            tasks: event.newTasks,
            version: context.plan ? context.plan.version + 1 : 1,
          };
        }
        return context.plan;
      },
    }),
    incrementOutages: assign({
      providerOutages: ({ context }) => context.providerOutages + 1,
    }),
    storeFailure: assign({
      failure: ({ event }) => ({ kind: "config" as const, reason: event.type === "CONFIG_ERROR" ? event.reason : "config error", retryable: false as const }),
    }),
  },
}).createMachine({
  id: "run",
  initial: "planning",
  context: ({ input }: any) => ({
    ...input,
    providerOutages: 0,
  }),
  states: {
    planning: {
      on: {
        PLAN_READY: {
          target: "executing",
          actions: ["storePlan"],
        },
        CANCEL: "cancelled",
        CONFIG_ERROR: { target: "failed", actions: ["storeFailure"] },
      },
    },
    executing: {
      on: {
        ALL_TASKS_TERMINAL: "judging",
        CANCEL: "cancelled",
        CONFIG_ERROR: { target: "failed", actions: ["storeFailure"] },
        PROVIDER_OUTAGE: {
          target: "degraded",
          actions: ["incrementOutages"],
        },
      },
    },
    degraded: {
      on: {
        PROVIDER_RECOVERED: "executing",
        CONFIG_ERROR: { target: "failed", actions: ["storeFailure"] },
        CANCEL: "cancelled",
      },
    },
    judging: {
      on: {
        JUDGE_PASS: "completed",
        JUDGE_REPLAN: {
          target: "planning",
          guard: "withinBudget",
          actions: ["storePlan"],
        },
        JUDGE_FAIL: "failed",
      },
    },
    completed: {
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
