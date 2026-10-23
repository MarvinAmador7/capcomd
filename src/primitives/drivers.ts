import { spawn } from "child_process";
import { mkdirSync, openSync } from "fs";
import { join } from "path";
import { env } from "../utils/env";
import { stateDir } from "../utils/home";
import { selfArgv } from "../utils/self";

/** Launch a detached driver process for one agent (logs in .relay/drivers/). */
export function startDriver(runId: string, agentId: string) {
  if (env("NO_DRIVER") === "1") return;
  const dir = join(stateDir(), "drivers");
  mkdirSync(dir, { recursive: true });
  const fd = openSync(join(dir, `${agentId}.log`), "a");
  const [cmd, ...args] = selfArgv("agent-drive", runId, agentId);
  const p = spawn(cmd!, args, { detached: true, stdio: ["ignore", fd, fd], env: process.env });
  p.unref();
}
