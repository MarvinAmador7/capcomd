// Files capcomd needs while it runs, bundled into it: from source they're read from the package, and the single
// executable (scripts/build-binary.ts) carries them inside, so it needs nothing installed beside it.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "fs";
import { join } from "path";
// @ts-ignore: a text import of a JS file gives its source (Bun), which TypeScript would type as the module itself
import supervisor from "../agents/supervisor.mjs" with { type: "text" };
// @ts-ignore: likewise
import vmCli from "../subagents/vm-cli.mjs" with { type: "text" };
// @ts-ignore: a file import (Bun) gives its path; TypeScript has no type for a .sh module
import engineWrapper from "../engine/engine-wrapper.sh" with { type: "file" };
// @ts-ignore: a text import (Bun) of a Markdown file gives its contents
import orchestrationSkill from "../../plugins/capcomd/skills/capcomd-orchestration/SKILL.md" with { type: "text" };
// @ts-ignore: likewise
import setupSkill from "../../plugins/capcomd/skills/capcomd-setup/SKILL.md" with { type: "text" };
import { capcomdHome, COMPILED } from "./home";
import { VERSION } from "./self";

/** The in-VM supervisor (ADR-019 §1), uploaded into each agent's VM. */
export const SUPERVISOR_SOURCE: string = supervisor;
/** The in-VM `capcomd` (ADR-017), uploaded into the VMs of agents that may spawn. */
export const VM_CLI_SOURCE: string = vmCli;
/** The orchestration skill, installed for Claude Code when there's no plugin host. */
export const ORCHESTRATION_SKILL: string = orchestrationSkill;
/** The setup skill, installed for Hermes (Claude Code and Codex get it with the plugin). */
export const SETUP_SKILL: string = setupSkill;
const ENGINE_WRAPPER: string = engineWrapper;

/** Set by the single executable's entry (scripts/build-binary.ts): the platform's rivet-engine, bundled as a file. */
export const embedded: { engine?: string } = {};

/**
 * A bundled file as a real file the OS can run. From source it already is one. Inside the single executable it is a
 * $bunfs path, so it is written once per version to ~/.capcomd/bin/<version>/<name> (atomically: a concurrent start
 * sees the old file or the whole new one).
 */
export function onDisk(name: string, bundled: string, mode = 0o755): string {
  if (!COMPILED) return bundled;
  const dir = join(capcomdHome(), "bin", VERSION);
  const out = join(dir, name);
  const want = statSync(bundled).size;
  if (existsSync(out) && statSync(out).size === want) return out;
  mkdirSync(dir, { recursive: true });
  const tmp = `${out}.${process.pid}.tmp`;
  writeFileSync(tmp, readFileSync(bundled));
  chmodSync(tmp, mode);
  renameSync(tmp, out);
  return out;
}

/** The engine launcher (src/engine/engine-wrapper.sh) as a runnable file. */
export const engineWrapperPath = () => onDisk("engine-wrapper.sh", ENGINE_WRAPPER);
