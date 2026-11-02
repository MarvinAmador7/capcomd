// ADR-022: agents are driven by a workflow in their worker actor (the default), or, with CAPCOMD_AGENT_WORKFLOW=0 (an
// escape hatch for one release), by a detached `capcomd agent-drive` process each. The engine host's setting decides:
// it's what the worker actors run, so a CLI follows the engine it talks to (engineDrivesAgents), whatever its own env
// says. Its own module so the CLI can check it without loading rivetkit's workflow engine.
import { env } from "./env";

/** This process's setting: on unless CAPCOMD_AGENT_WORKFLOW=0. The engine host's is the one that counts. */
export const agentWorkflowOn = (source: Record<string, string | undefined> = process.env) => env("AGENT_WORKFLOW", source) !== "0";

/** The engine host itself (`capcomd serve` runs the actors in a child it marks): its own setting is the answer. */
const isEngineHost = () => process.env.CAPCOMD_SERVE_EXEC === "1";
const ASK_EVERY_MS = 60_000;
const modes = new Map<string, { at: number; mode: Promise<boolean> }>();
let told = false;

/**
 * Whether the engine this process talks to drives agents with the workflow. In the engine host, its own setting; from
 * anywhere else, the engine's answer (a scope actor's `driveMode`), asked again after a minute so a long-lived process
 * (the MCP server) follows an engine restarted with the other setting. An engine too old to answer has no workflow;
 * one that can't answer now is taken to have this process's setting, for this call only. Never rejects. When this
 * process's own setting says otherwise, one line on stderr says the engine's applies.
 */
export async function engineDrivesAgents(runId: string): Promise<boolean> {
  if (isEngineHost()) return agentWorkflowOn();
  const { client, endpoint } = await import("../core/relay");
  const key = endpoint();
  const known = modes.get(key);
  if (known && Date.now() - known.at < ASK_EVERY_MS) return known.mode;
  const mode = (async () => {
    try { return !!((await (client().scope.getOrCreate([runId]) as any).driveMode()) as { agentWorkflow: boolean }).agentWorkflow; }
    catch (e) { if ((e as any)?.code === "action_not_found") return false; throw e; }
  })();
  modes.set(key, { at: Date.now(), mode });
  try {
    const engineOn = await mode;
    const mine = env("AGENT_WORKFLOW");
    if (!told && mine !== undefined && (mine !== "0") !== engineOn) {
      told = true;
      process.stderr.write(`capcomd: the engine drives agents ${engineOn ? "with its workflow" : "with agent-drive processes (CAPCOMD_AGENT_WORKFLOW=0)"}; this command's CAPCOMD_AGENT_WORKFLOW=${mine} doesn't apply (set it where the engine runs)\n`);
    }
    return engineOn;
  } catch {
    modes.delete(key); // not answered: ask again next time
    return agentWorkflowOn();
  }
}
