import { env as envVar } from "../utils/env";

export type AgentKind = "fake" | "claude-code" | "codex";
export type RealAgent = Exclude<AgentKind, "fake">;

/** CAPCOMD_AGENT=claude-code|codex selects a real worker; default (unset/"fake") keeps the local fake work. */
export function agentFromEnv(source: Record<string, string | undefined> = process.env, profile?: string | null): AgentKind {
  // CAPCOMD_AGENT may be a provider kind or a profile name; else the agents file's default; else fake.
  const { resolveAgent } = require("./profiles") as typeof import("./profiles");
  return resolveAgent(profile, source).kind;
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

/**
 * ChatGPT-plan codex: model calls + model list refresh go to chatgpt.com/backend-api, token refresh
 * to auth.openai.com, feature flags/experiments to ab.chatgpt.com (live Mac run 2026-10-20: doctor
 * failed "error sending request for url https://chatgpt.com/backend-api/..." without them).
 */
export const CODEX_SUBSCRIPTION_HOSTS = ["chatgpt.com", "auth.openai.com", "ab.chatgpt.com"];

export type EgressAuth = "apikey" | "subscription";
/**
 * Provider + auth egress sets (beyond BASE_EGRESS). One table so runs, doctor and login agree.
 * claude subscription uses a setup-token (long-lived OAuth token) against api.anthropic.com.
 */
export const PROVIDER_EGRESS: Record<RealAgent, Record<EgressAuth, string[]>> = {
  "claude-code": { apikey: ["api.anthropic.com"], subscription: ["api.anthropic.com"] },
  codex: { apikey: ["api.openai.com"], subscription: ["api.openai.com", ...CODEX_SUBSCRIPTION_HOSTS] },
};
/** Full VM allowlist for one agent and auth mode: base hosts + that provider's set. */
export function egressFor(kind: RealAgent, auth: EgressAuth): string[] {
  return [...new Set([...BASE_EGRESS.slice(0, 1), ...PROVIDER_EGRESS[kind][auth], ...BASE_EGRESS.slice(1)])];
}

/**
 * Credential mode, strictly one of API key or subscription per agent (no fallback between them):
 * CAPCOMD_CREDENTIALS (override) → the profile's `auth` → CAPCOMD_AUTH → inferred only when exactly one
 * of {local API key, auth-login profile} exists; both or neither is a configuration error.
 * apikey maps to "auto" (boxd secret placeholder, else the local key), or "secret"/"env" when forced.
 */
export function credentialModeFor(kind: AgentKind, source: Record<string, string | undefined> = process.env, auth?: "apikey" | "subscription"): AgentConfig["credentialMode"] {
  const explicit = envVar("CREDENTIALS", source)?.toLowerCase();
  if (explicit) {
    if (!["secret", "env", "subscription", "auto"].includes(explicit)) throw new Error(`CAPCOMD_CREDENTIALS=${explicit} is invalid (subscription|auto|secret|env)`);
    return explicit as AgentConfig["credentialMode"];
  }
  if (!isRealAgent(kind)) return "auto";
  const a = auth ?? (envVar("AUTH", source)?.toLowerCase() as typeof auth | undefined);
  if (a) {
    if (a !== "apikey" && a !== "subscription") throw new Error(`CAPCOMD_AUTH=${a} is invalid (apikey|subscription)`);
    return a === "subscription" ? "subscription" : "auto";
  }
  const { profileFor } = require("../auth/profiles") as typeof import("../auth/profiles");
  const keyName = kind === "codex" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
  const hasKey = !!source[keyName]?.trim(), hasSub = !!profileFor(kind, source);
  if (hasKey && hasSub) throw new Error(`${kind}: both ${keyName} and a subscription login are configured; choose one (agent profile auth, or CAPCOMD_AUTH=apikey|subscription)`);
  if (!hasKey && !hasSub) throw new Error(`${kind}: no credentials configured; set auth (agent profile or CAPCOMD_AUTH) and either ${keyName} or \`capcomd auth login ${kind === "codex" ? "codex" : "claude"}\``);
  return hasSub ? "subscription" : "auto";
}

export interface AgentConfig {
  version: string;
  codexVersion: string;
  nodeVersion: string;
  /** Optional limits (ADR-019): undefined means none. */
  maxTurns?: number;
  maxBudgetUsd?: number;
  timeoutMs?: number;
  /** No events from the agent CLI for this long: it has hung, so it is stopped (its work kept). */
  idleAfterMs: number;
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
  /** Profile name this config came from (null: env only). */
  profile: string | null;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  /**
   * "subscription" (Claude/ChatGPT plan login from `capcomd auth login`; no API key), "auto" (prefer a
   * boxd host-bound secret placeholder, else env injection), "secret" (require it), "env".
   * Default: subscription when an auth profile exists for the agent, else auto.
   */
  credentialMode: "auto" | "secret" | "env" | "subscription";
}

const list = (v: string | undefined, d: string[]) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : d);

export function loadAgentConfig(source: Record<string, string | undefined> = process.env, profileName?: string | null): AgentConfig {
  const { resolveAgent } = require("./profiles") as typeof import("./profiles");
  const ra = resolveAgent(profileName, source);
  const spec = ra.spec;
  const specNum: Record<string, number | undefined> = { AGENT_MAX_TURNS: spec?.maxTurns, AGENT_MAX_BUDGET_USD: spec?.maxBudgetUsd, AGENT_TIMEOUT_MS: spec?.timeoutMs, AGENT_IDLE_MS: spec?.idleAfterMs };
  const opt = (name: string) => {
    const v = envVar(name, source);
    const n = v === undefined ? specNum[name] : Number(v);
    if (n !== undefined && (!Number.isFinite(n) || n <= 0)) throw new Error(`CAPCOMD_${name} must be a positive number`);
    return n;
  };
  const num = (name: string, d: number) => opt(name) ?? d;
  const kind = ra.kind;
  const sandbox = (envVar("CODEX_SANDBOX", source) ?? spec?.sandbox ?? "workspace-write") as AgentConfig["codexSandbox"];
  if (!["read-only", "workspace-write", "danger-full-access"].includes(sandbox)) throw new Error(`CAPCOMD_CODEX_SANDBOX=${sandbox} is invalid`);
  const cred = credentialModeFor(kind, source, spec?.auth);
  return {
    version: envVar("CLAUDE_CODE_VERSION", source) ?? CLAUDE_CODE_VERSION,
    codexVersion: envVar("CODEX_VERSION", source) ?? CODEX_VERSION,
    nodeVersion: envVar("AGENT_NODE_VERSION", source) ?? NODE_VERSION,
    maxTurns: opt("AGENT_MAX_TURNS"),
    maxBudgetUsd: opt("AGENT_MAX_BUDGET_USD"),
    timeoutMs: opt("AGENT_TIMEOUT_MS"),
    idleAfterMs: num("AGENT_IDLE_MS", 30 * 60_000),
    pollMs: num("AGENT_POLL_MS", 2000),
    allowedTools: list(envVar("AGENT_ALLOWED_TOOLS", source), spec?.allowedTools ?? DEFAULT_ALLOWED_TOOLS),
    disallowedTools: list(envVar("AGENT_DISALLOWED_TOOLS", source), spec?.disallowedTools ?? DEFAULT_DISALLOWED_TOOLS),
    model: envVar("AGENT_MODEL", source) ?? spec?.model,
    profile: ra.name,
    systemPrompt: spec?.systemPrompt,
    appendSystemPrompt: spec?.appendSystemPrompt,
    workdir: envVar("AGENT_WORKDIR", source) ?? "/var/tmp/capcomd",
    claudeBin: envVar("AGENT_CLAUDE_BIN", source),
    agentBin: envVar("AGENT_BIN", source),
    egress: list(envVar("AGENT_EGRESS", source), spec?.egress ?? (isRealAgent(kind) ? egressFor(kind, cred === "subscription" ? "subscription" : "apikey") : AGENT_EGRESS)),
    codexSandbox: sandbox,
    codexUsdPerMtokIn: num("CODEX_USD_PER_MTOK_IN", 1.25),
    codexUsdPerMtokOut: num("CODEX_USD_PER_MTOK_OUT", 10),
    credentialMode: cred,
  };
}
