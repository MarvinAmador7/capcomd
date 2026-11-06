// front-env's commands (src/plugins/front/groups.ts): environments, logins and secrets, and a shell in a sandbox.
import { type Cmd, type KernelCommand, usage } from "./common";

/** `capcomd env | secrets | auth | doctor` */
async function envCommand({ command, positionals, values }: Cmd): Promise<number> {
  const { envCommand } = await import("../commands/env");
  return await envCommand(command, positionals, values as any);
}

/** `capcomd sandbox` */
async function sandboxCommand({ positionals, values }: Cmd): Promise<number> {
  if (positionals[1] !== "shell") usage("usage: capcomd sandbox shell <runId> <agentId> | capcomd sandbox shell --sandbox <name> --machine <id>");
  const { localShellDeps, sandboxShell } = await import("../commands/sandbox");
  return await sandboxShell({ positionals: positionals.slice(2), ...(values.sandbox !== undefined ? { sandbox: values.sandbox as string } : {}), ...(values.machine !== undefined ? { machine: values.machine as string } : {}) }, localShellDeps());
}

export const COMMANDS: Record<string, KernelCommand> = {
  "env": envCommand,
  "secrets": envCommand,
  "auth": envCommand,
  "doctor": envCommand,
  "sandbox": sandboxCommand,
};
