import { env as envVar } from "../utils/env";

export type AgentKind = "fake" | "claude-code" | "codex";
export type RealAgent = Exclude<AgentKind, "fake">;

/** CAPCOMD_AGENT=claude-code|codex selects a real worker; default (unset/"fake") keeps the local fake work. */
export function agentFromEnv(source: Record<string, string | undefined> = process.env): AgentKind {
  const v = (envVar("AGENT", source) ?? "fake").toLowerCase();
  if (v === "fake" || v === "claude-code" || v === "codex") return v;
  throw new Error(`Unknown CAPCOMD_AGENT=${v} (expected fake|claude-code|codex)`);
}
export const isRealAgent = (k: AgentKind): k is RealAgent => k !== "fake";

/** Pinned versions, installed only when the VM image/snapshot does not already have the CLI. */
export const CLAUDE_CODE_VERSION = "2.1.303";
export const CODEX_VERSION = "0.163.0";
export const NODE_VERSION = "22.23.3";

export const DEFAULT_ALLOWED_TOOLS = [
  "Read", "Edit", "Write", "Glob", "Grep", "LS", "TodoWrite",
  "Bash(npm test:*)", "Bash(npm run test:*)", "Bash(npm install:*)", "Bash(npm ci:*)",
  "Bash(npx tsc:*)", "Bash(npx vitest:*)", "Bash(npx jest:*)", "Bash(node:*)",
  "Bash(bun test:*)", "Bash(bun install:*)", "Bash(bun run:*)",
  "Bash(ls:*)", "Bash(cat:*)", "Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)",
];
export const DEFAULT_DISALLOWED_TOOLS = ["Bash(git push:*)", "Bash(git remote:*)", "Bash(curl:*)", "Bash(wget:*)", "WebFetch", "WebSearch"];

/** Hosts every agent VM needs (clone/push, bootstrap registries). */
export const BASE_EGRESS = ["github.com", "registry.npmjs.org", "nodejs.org"];
/** Each agent's API host; boxd host-bound secrets are bound to exactly this host. */
export const AGENT_API_HOST: Record<RealAgent, string> = { "claude-code": "api.anthropic.com", codex: "api.openai.com" };
/** claude-code allowlist (kept for compatibility). */
export const AGENT_EGRESS = ["github.com", "api.anthropic.com", "registry.npmjs.org", "nodejs.org"];
export function agentEgress(kind: RealAgent): string[] {
  return [...BASE_EGRESS.slice(0, 1), AGENT_API_HOST[kind], ...BASE_EGRESS.slice(1)];
}

export interface AgentConfig {
  version: string;
  codexVersion: string;
  nodeVersion: string;
  maxTurns: number;
  maxBudgetUsd: number;
  timeoutMs: number;
  pollMs: number;
  allowedTools: string[];
  disallowedTools: string[];
  model?: string;
  /** Working dir inside the VM (persistent disk, so a snapshot keeps installs and the dep template). */
  workdir: string;
  /** Override the agent binary (tests: fake claude/codex). When set, detect/install is skipped. */
  claudeBin?: string;
  agentBin?: string;
  egress: string[];
  /** codex exec --sandbox mode. The VM is the isolation boundary; workspace-write is the least privilege that edits. */
  codexSandbox: "read-only" | "workspace-write" | "danger-full-access";
  /** USD per million tokens, for the codex budget guard (codex exec reports tokens, not cost). */
  codexUsdPerMtokIn: number;
  codexUsdPerMtokOut: number;
  /** "auto" (prefer a boxd host-bound secret placeholder, else env injection), "secret" (require it), "env". */
  credentialMode: "auto" | "secret" | "env";
}

const list = (v: string | undefined, d: string[]) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : d);

export function loadAgentConfig(source: Record<string, string | undefined> = process.env): AgentConfig {
  const num = (name: string, d: number) => {
    const v = envVar(name, source);
    const n = v === undefined ? d : Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`CAPCOMD_${name} must be a positive number`);
    return n;
  };
  const kind = agentFromEnv(source);
  const sandbox = (envVar("CODEX_SANDBOX", source) ?? "workspace-write") as AgentConfig["codexSandbox"];
  if (!["read-only", "workspace-write", "danger-full-access"].includes(sandbox)) throw new Error(`CAPCOMD_CODEX_SANDBOX=${sandbox} is invalid`);
  const cred = (envVar("CREDENTIALS", source) ?? "auto") as AgentConfig["credentialMode"];
  if (!["auto", "secret", "env"].includes(cred)) throw new Error(`CAPCOMD_CREDENTIALS=${cred} is invalid (auto|secret|env)`);
  return {
    version: envVar("CLAUDE_CODE_VERSION", source) ?? CLAUDE_CODE_VERSION,
    codexVersion: envVar("CODEX_VERSION", source) ?? CODEX_VERSION,
    nodeVersion: envVar("AGENT_NODE_VERSION", source) ?? NODE_VERSION,
    maxTurns: num("AGENT_MAX_TURNS", 30),
    maxBudgetUsd: num("AGENT_MAX_BUDGET_USD", 2),
    timeoutMs: num("AGENT_TIMEOUT_MS", 20 * 60_000),
    pollMs: num("AGENT_POLL_MS", 2000),
    allowedTools: list(envVar("AGENT_ALLOWED_TOOLS", source), DEFAULT_ALLOWED_TOOLS),
    disallowedTools: list(envVar("AGENT_DISALLOWED_TOOLS", source), DEFAULT_DISALLOWED_TOOLS),
    model: envVar("AGENT_MODEL", source),
    workdir: envVar("AGENT_WORKDIR", source) ?? "/var/tmp/capcomd",
    claudeBin: envVar("AGENT_CLAUDE_BIN", source),
    agentBin: envVar("AGENT_BIN", source),
    egress: list(envVar("AGENT_EGRESS", source), kind === "codex" ? agentEgress("codex") : AGENT_EGRESS),
    codexSandbox: sandbox,
    codexUsdPerMtokIn: num("CODEX_USD_PER_MTOK_IN", 1.25),
    codexUsdPerMtokOut: num("CODEX_USD_PER_MTOK_OUT", 10),
    credentialMode: cred,
  };
}
