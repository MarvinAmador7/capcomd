import { setup } from "rivetkit";
import { runActor } from "./actors/run";
import { plannerActor } from "./actors/planner";
import { taskBoardActor } from "./actors/taskboard";
import { workerActor } from "./actors/worker";
import { verifierActor } from "./actors/verifier";
import { judgeActor } from "./actors/judge";
import { scopeActor } from "./actors/scope";

/**
 * Action payload limits (rivetkit defaults: 64 KB in, 1 MB out). Thread items carry up to 64 KB of blocks plus their
 * text, and a tool's image (≤ 5 MB, base64) is stored and read back as an attachment, so both are raised to 8 MB.
 */
export const MAX_ACTION_MESSAGE_BYTES = 8 * 1024 * 1024;

export const registry = setup({
  maxIncomingMessageSize: MAX_ACTION_MESSAGE_BYTES,
  maxOutgoingMessageSize: MAX_ACTION_MESSAGE_BYTES,
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
