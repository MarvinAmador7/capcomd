// Claude Code worker (ADR-014), now a thin wrapper over the generic runner (ADR-015).
import type { SandboxProvider, VmId } from "../providers/sandbox";
import type { AgentConfig } from "./config";
import type { AgentEvent } from "./types";
import type { Redactor } from "./redact";
import { claudeAdapter } from "./adapters";
import { runAgent, installScript as genericInstall, type AgentTask, type AgentResult, type AgentRunOptions } from "./runner";

export { AgentError, buildPrompt, runAgent } from "./runner";
export type { AgentTask, AgentResult, AgentRunOptions } from "./runner";
export type { AgentEvent } from "./types";

export function parseStreamLine(line: string, r: Redactor): AgentEvent | null {
  return claudeAdapter.parse(line, r, { events: 0, turns: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, done: false }, {} as AgentConfig);
}
export function installScript(cfg: AgentConfig, home: string): string {
  return genericInstall(cfg, home, claudeAdapter);
}
export function runClaudeCode(provider: SandboxProvider, vmId: VmId, task: AgentTask, cfg: AgentConfig, opts: AgentRunOptions): Promise<AgentResult> {
  return runAgent(claudeAdapter, provider, vmId, task, cfg, opts);
}
