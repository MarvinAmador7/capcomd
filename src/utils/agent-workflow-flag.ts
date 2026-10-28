// ADR-022: CAPCOMD_AGENT_WORKFLOW=1 drives agents by a workflow in their worker actor instead of `agent-drive`
// processes. Its own module so the CLI can check it without loading rivetkit's workflow engine.
import { env } from "./env";

/** The flag. Read where it's used (the engine host and the CLI must agree: set it for both). */
export const agentWorkflowOn = (source: Record<string, string | undefined> = process.env) => env("AGENT_WORKFLOW", source) === "1";
