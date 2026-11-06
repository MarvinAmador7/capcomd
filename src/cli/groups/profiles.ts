// front-profiles's command (src/plugins/front/groups.ts): agent profiles (`capcomd agents`, src/cli/commands/agents.ts).
import { type Cmd, type KernelCommand } from "./common";

/** `capcomd agents` */
async function agentsCommand({ positionals, values }: Cmd): Promise<number> {
  const { agentsCommand } = await import("../commands/agents");
  return await agentsCommand(positionals, values as any);
}

export const COMMANDS: Record<string, KernelCommand> = {
  "agents": agentsCommand,
};
