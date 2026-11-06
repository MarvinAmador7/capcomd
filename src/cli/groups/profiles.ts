// front-profiles's commands (src/plugins/front/groups.ts): agent profiles (`capcomd profiles`, and `capcomd agents`, its
// old name for one minor release; src/cli/commands/profiles.ts).
import { type Cmd, type KernelCommand } from "./common";

/** `capcomd profiles`, and `capcomd agents` under its old name */
async function profilesCommand({ command, positionals, values }: Cmd): Promise<number> {
  const { profilesCommand } = await import("../commands/profiles");
  return await profilesCommand(positionals, values as any, command === "agents" ? "agents" : "profiles");
}

export const COMMANDS: Record<string, KernelCommand> = {
  "profiles": profilesCommand,
  "agents": profilesCommand,
};
