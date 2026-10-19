import { env as envVar } from "../utils/env";

export type AgentKind = "fake" | "claude-code";

/** CAPCOMD_AGENT=claude-code selects the real worker; default (unset/"fake") keeps the local fake work. */
export function agentFromEnv(source: Record<string, string | undefined> = process.env): AgentKind {
  const v = (envVar("AGENT", source) ?? "fake").toLowerCase();
  if (v === "fake" || v === "claude-code") return v;
  throw new Error(`Unknown CAPCOMD_AGENT=${v} (expected fake|claude-code)`);
}

/** Pinned versions. Bump deliberately; the VM bootstrap installs exactly these. */
export const CLAUDE_CODE_VERSION = "2.1.303";
export const NODE_VERSION = "22.23.3";

export const DEFAULT_ALLOWED_TOOLS = [
  "Read", "Edit", "Write", "Glob", "Grep", "LS", "TodoWrite",
  "Bash(npm test:*)", "Bash(npm run test:*)", "Bash(npm install:*)", "Bash(npm ci:*)",
  "Bash(npx tsc:*)", "Bash(npx vitest:*)", "Bash(npx jest:*)", "Bash(node:*)",
  "Bash(bun test:*)", "Bash(bun install:*)", "Bash(bun run:*)",
  "Bash(ls:*)", "Bash(cat:*)", "Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)",
];
export const DEFAULT_DISALLOWED_TOOLS = ["Bash(git push:*)", "Bash(git remote:*)", "Bash(curl:*)", "Bash(wget:*)", "WebFetch", "WebSearch"];

/** Hosts the VM may reach in claude-code mode. Everything else is blocked by boxd egress. */
export const AGENT_EGRESS = ["github.com", "api.anthropic.com", "registry.npmjs.org", "nodejs.org"];

export interface AgentConfig {
  version: string;
  nodeVersion: string;
  maxTurns: number;
  maxBudgetUsd: number;
  timeoutMs: number;
  pollMs: number;
  allowedTools: string[];
  disallowedTools: string[];
  model?: string;
  /** Working dir inside the VM. */
  workdir: string;
  /** Override the claude binary (tests: fake claude). When set, install is skipped. */
  claudeBin?: string;
  egress: string[];
}

const list = (v: string | undefined, d: string[]) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : d);

export function loadAgentConfig(source: Record<string, string | undefined> = process.env): AgentConfig {
  const num = (name: string, d: number) => {
    const v = envVar(name, source);
    const n = v === undefined ? d : Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`CAPCOMD_${name} must be a positive number`);
    return n;
  };
  return {
    version: envVar("CLAUDE_CODE_VERSION", source) ?? CLAUDE_CODE_VERSION,
    nodeVersion: envVar("AGENT_NODE_VERSION", source) ?? NODE_VERSION,
    maxTurns: num("AGENT_MAX_TURNS", 30),
    maxBudgetUsd: num("AGENT_MAX_BUDGET_USD", 2),
    timeoutMs: num("AGENT_TIMEOUT_MS", 20 * 60_000),
    pollMs: num("AGENT_POLL_MS", 2000),
    allowedTools: list(envVar("AGENT_ALLOWED_TOOLS", source), DEFAULT_ALLOWED_TOOLS),
    disallowedTools: list(envVar("AGENT_DISALLOWED_TOOLS", source), DEFAULT_DISALLOWED_TOOLS),
    model: envVar("AGENT_MODEL", source),
    workdir: envVar("AGENT_WORKDIR", source) ?? "/tmp/capcomd",
    claudeBin: envVar("AGENT_CLAUDE_BIN", source),
    egress: list(envVar("AGENT_EGRESS", source), AGENT_EGRESS),
  };
}
