// The built-in plugins (docs/spec/plugin-api.md §4.8): a static list bundled into the package and the single
// executable, each a manifest and its module imported here (src/utils/assets.ts rule: import, never read a package
// file at run time). capcomd's own providers, forges, gates and front doors, as they become plugins (§17.2 steps 3-8).
import type { Candidate } from "../../packages/plugin/src/host/host";
import { SANDBOX_BUILTINS } from "./builtin/sandboxes";
import * as agentClaude from "./agent-claude";
import * as agentCodex from "./agent-codex";

export const BUILTINS: ReadonlyArray<Required<Pick<Candidate, "manifest" | "module">>> = [
  ...SANDBOX_BUILTINS,
  // §7.3, §17.2 step 4: the agent providers.
  { manifest: agentClaude.manifest, module: agentClaude.plugin },
  { manifest: agentCodex.manifest, module: agentCodex.plugin },
];
