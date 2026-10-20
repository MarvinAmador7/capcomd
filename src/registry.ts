import { setup } from "rivetkit";
import { runActor } from "./actors/run";
import { plannerActor } from "./actors/planner";
import { taskBoardActor } from "./actors/taskboard";
import { workerActor } from "./actors/worker";
import { verifierActor } from "./actors/verifier";
import { judgeActor } from "./actors/judge";
import { scopeActor } from "./actors/scope";

export const registry = setup({
  use: {
    run: runActor,
    planner: plannerActor,
    taskBoard: taskBoardActor,
    worker: workerActor,
    verifier: verifierActor,
    judge: judgeActor,
    scope: scopeActor,
  },
});

export type Registry = typeof registry;
