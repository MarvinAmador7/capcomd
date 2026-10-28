import { spawn } from "child_process";
import { mkdirSync, openSync } from "fs";
import { join } from "path";
import { env } from "../utils/env";
import { stateDir } from "../utils/home";
import { selfArgv } from "../utils/self";
import { agentWorkflowOn } from "../utils/agent-workflow-flag";

/**
 * Start (or kick) what drives one agent. Today: a detached `capcomd agent-drive` process (logs in .relay/drivers/).
 * With CAPCOMD_AGENT_WORKFLOW=1 (ADR-022): the workflow of the worker actor of its current epoch, by a `start` message
 * (idempotent: a second start only wakes that actor, which resumes its workflow if a restart left it asleep).
 */
export async function startDriver(runId: string, agentId: string): Promise<void> {
  if (env("NO_DRIVER") === "1") return;
  if (agentWorkflowOn()) return startAgentWorkflow(runId, agentId);
  spawnDriver(runId, agentId);
}

function spawnDriver(runId: string, agentId: string): void {
  const dir = join(stateDir(), "drivers");
  mkdirSync(dir, { recursive: true });
  const fd = openSync(join(dir, `${agentId}.log`), "a");
  const [cmd, ...args] = selfArgv("agent-drive", runId, agentId);
  const p = spawn(cmd!, args, { detached: true, stdio: ["ignore", fd, fd], env: process.env });
  p.unref();
}

async function startAgentWorkflow(runId: string, agentId: string): Promise<void> {
  const { client } = await import("../core/relay");
  const c = client();
  try {
    const a = await c.scope.getOrCreate([runId]).getAgent({ agentId });
    if (!a || ["done", "failed", "cancelled"].includes(a.status)) return;
    const key = a.epoch > 1 ? [runId, agentId, `e${a.epoch}`] : [runId, agentId];
    await (c.worker.getOrCreate(key) as any).startAgent({ runId, agentId, epoch: a.epoch });
  } catch (e) {
    // An engine started without the flag has no workflow: drive it the old way rather than not at all.
    if ((e as any)?.code === "action_not_found") return spawnDriver(runId, agentId);
    // Like a driver that failed to start: the next await (or the engine, for a workflow already running) carries on.
    console.error(`capcomd: couldn't start ${agentId}'s workflow: ${(e as Error)?.message ?? e}`);
  }
}
