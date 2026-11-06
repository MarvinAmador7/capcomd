// The built-in plugins (docs/spec/plugin-api.md §4.8): a static list bundled into the package and the single
// executable, each a manifest and its module imported here (src/utils/assets.ts rule: import, never read a package
// file at run time). capcomd's own providers, forges, gates and front doors, as they become plugins (§17.2 steps 3-8).
// A built-in's version is capcomd's: it ships with it and supports only it.
import type { Candidate } from "../../packages/plugin/src/host/host";
import { VERSION } from "../utils/self";
import { SANDBOX_BUILTINS } from "./builtin/sandboxes";
import * as agentClaude from "./agent-claude";
import * as agentCodex from "./agent-codex";
import gateReviewerManifest from "./gate-reviewer/plugin.json" with { type: "json" };
import { plugin as gateReviewer } from "./gate-reviewer/index";
import * as forgeGit from "./forges/git";
import * as forgeGithub from "./forges/github";
import { FRONT_GROUPS } from "./front/groups";
import * as frontMcp from "./front/mcp";
import * as frontHermes from "./front/hermes";
import * as skillOrchestration from "./skill-orchestration";
import * as sourceSchedule from "./sources/schedule";

export type Builtin = Required<Pick<Candidate, "manifest" | "module">> & {
  /** A plugin the kernel needs in every process, not only the daemon: a gate wherever a verify runs (src/plugins/hooks.ts
   *  `gates`), a forge wherever work lands or a pull request opens (src/plugins/forges), a front door wherever a command
   *  or a tool is served (the CLI, `capcomd mcp`), the orchestration skill wherever an agent is prepared. See host.ts
   *  `localHost`. */
  everyProcess?: boolean;
  /** One of the kernel's own front doors (§4.2, §4.7.1): its CLI groups are the kernel's commands and its MCP tools are
   *  `capcomd_<tool>` (`Candidate.kernelSurface`). */
  kernelSurface?: boolean;
};

const shipped = (m: object) => ({ ...m, version: VERSION, engines: { capcomd: VERSION } });

export const BUILTINS: ReadonlyArray<Builtin> = [
  ...SANDBOX_BUILTINS,
  // §7.3, §17.2 step 4: the agent providers.
  { manifest: agentClaude.manifest, module: agentClaude.plugin },
  { manifest: agentCodex.manifest, module: agentCodex.plugin },
  { manifest: shipped(gateReviewerManifest), module: gateReviewer as Builtin["module"], everyProcess: true },
  // Forges (§7.4, step 6).
  { manifest: forgeGithub.manifest, module: forgeGithub.plugin, everyProcess: true },
  { manifest: forgeGit.manifest, module: forgeGit.plugin, everyProcess: true },
  // Front doors (§17.2 step 8): the CLI's groups, the MCP server's tools, capcomd in Hermes; and the orchestration
  // skill an agent that may spawn is prepared with (agent.preparing).
  ...FRONT_GROUPS.map((g) => ({ manifest: g.manifest, module: g.module as Builtin["module"], everyProcess: true, kernelSurface: true })),
  { manifest: frontMcp.manifest, module: frontMcp.plugin as Builtin["module"], everyProcess: true, kernelSurface: true },
  { manifest: frontHermes.manifest, module: frontHermes.plugin as Builtin["module"], everyProcess: true, kernelSurface: true },
  { manifest: skillOrchestration.manifest, module: skillOrchestration.plugin as Builtin["module"], everyProcess: true },
  // Trigger sources (§16.3, step 10): schedules. GitHub's comments are forge-github's own source.
  { manifest: sourceSchedule.manifest, module: sourceSchedule.plugin as Builtin["module"] },
];

/** The kernel's own front doors, by name: the dispatcher prints their output as theirs (src/cli/front-doors.ts). */
export const KERNEL_SURFACE: ReadonlySet<string> = new Set(BUILTINS.filter((b) => b.kernelSurface).map((b) => (b.manifest as { name: string }).name));

/** A built-in as the host discovers it (§4.8). */
export const candidateOf = (b: Builtin): Candidate => ({ source: "builtin", manifest: b.manifest, module: b.module, ...(b.kernelSurface ? { kernelSurface: true } : {}) });
