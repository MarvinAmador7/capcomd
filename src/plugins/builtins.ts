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

export type Builtin = Required<Pick<Candidate, "manifest" | "module">> & {
  /** A gate the kernel needs wherever a verify or a merge runs, not only in the daemon (src/plugins/hooks.ts `gates`). */
  everyProcess?: boolean;
};

const shipped = (m: object) => ({ ...m, version: VERSION, engines: { capcomd: VERSION } });

export const BUILTINS: ReadonlyArray<Builtin> = [
  ...SANDBOX_BUILTINS,
  // §7.3, §17.2 step 4: the agent providers.
  { manifest: agentClaude.manifest, module: agentClaude.plugin },
  { manifest: agentCodex.manifest, module: agentCodex.plugin },
  { manifest: shipped(gateReviewerManifest), module: gateReviewer as Builtin["module"], everyProcess: true },
];
