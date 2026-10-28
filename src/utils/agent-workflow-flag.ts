// ADR-022: agents are driven by a workflow in their worker actor (the default), or, with CAPCOMD_AGENT_WORKFLOW=0 (an
// escape hatch for one release), by a detached `capcomd agent-drive` process each. The engine host's setting decides:
// it's what the worker actors run, so a CLI follows the engine it talks to (engineDrivesAgents), whatever its own env
// says. Its own module so the CLI can check it without loading rivetkit's workflow engine.
import { env } from "./env";

/** This process's setting: on unless CAPCOMD_AGENT_WORKFLOW=0. The engine host's is the one that counts. */
export const agentWorkflowOn = (source: Record<string, string | undefined> = process.env) => env("AGENT_WORKFLOW", source) !== "0";

const modes = new Map<string, Promise<boolean>>();
let told = false;

/**
 * Whether the engine this process talks to drives agents with the workflow (asked once per endpoint; a scope actor
 * answers with the engine host's setting). An engine too old to say has no workflow. When this process's own setting
 * says otherwise, one line on stderr says the engine's wins.
 */
export function engineDrivesAgents(runId: string): Promise<boolean> {
  const endpoint = process.env.CAPCOMD_ENDPOINT ?? env("ENDPOINT") ?? "default";
  let mode = modes.get(endpoint);
  if (!mode) {
    mode = (async () => {
      const { client } = await import("../core/relay");
      try { return !!((await (client().scope.getOrCreate([runId]) as any).driveMode()) as { agentWorkflow: boolean }).agentWorkflow; }
      catch (e) { if ((e as any)?.code === "action_not_found") return false; throw e; }
    })();
    modes.set(endpoint, mode);
    mode.catch(() => modes.delete(endpoint)); // not answered: ask again next time
    void mode.then((engineOn) => {
      const mine = env("AGENT_WORKFLOW");
      if (told || mine === undefined || (mine !== "0") === engineOn) return;
      told = true;
      process.stderr.write(`capcomd: the engine drives agents ${engineOn ? "with its workflow" : "with agent-drive processes (CAPCOMD_AGENT_WORKFLOW=0)"}; this command's CAPCOMD_AGENT_WORKFLOW=${mine} doesn't apply (set it where the engine runs)\n`);
    }, () => {});
  }
  return mode;
}
