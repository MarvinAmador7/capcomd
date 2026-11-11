// The runner's agent adapters. Claude Code and Codex are the built-in agent-provider plugins (src/plugins/agent-claude.ts,
// agent-codex.ts; docs/spec/plugin-api.md §7.3); every provider reaches the runner through the agent seam
// (src/plugins/agents.ts), by the kind its profile resolves to.
import type { AgentRunState } from "./types";
import type { AgentConfig } from "./config";
import { adapterOf, agentAdapter, allAdapters } from "../plugins/agents";
import { claude } from "../plugins/agent-claude";
import { codex } from "../plugins/agent-codex";
import type { AgentAdapter } from "./types";
import type { EnvPins } from "../env/resolve";

export { codexResetAt } from "../plugins/agent-codex";

/** The built-in providers as adapters (tests, and code that means these two CLIs). */
export const claudeAdapter: AgentAdapter = adapterOf(claude);
export const codexAdapter: AgentAdapter = adapterOf(codex);

/** The active provider for an agent kind (`claude-code`, `codex`, or another provider's name). */
export function adapterFor(kind: string): AgentAdapter {
  return agentAdapter(kind);
}
/** Every active provider, in load order. */
export const activeAdapters = (): AgentAdapter[] => allAdapters();
/** The CLI pins an env image is named by (src/env/resolve.ts envName): Claude Code's, Codex's, node's, and each
 *  release-archive CLI's (fx's), so a new pin names a new image and `capcomd env build` builds it instead of keeping
 *  the old one. */
export const envPins = (cfg: AgentConfig): EnvPins => ({
  claude: cfg.version, codex: cfg.codexVersion, node: cfg.nodeVersion,
  ...Object.fromEntries(activeAdapters().filter((a) => a.install).map((a) => [a.bin, a.pinnedVersion(cfg)])),
});
export type { AgentRunState };
export type { AgentConfig };
