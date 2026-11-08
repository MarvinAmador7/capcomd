import { env as envVar } from "../utils/env";
import { OPEN_EGRESS } from "../providers/sandbox";
import { agentSeam, orchestrateConfig, providerOfKind } from "../plugins/agents";
import { CLAUDE_CODE_VERSION } from "../plugins/agent-claude";
import { CODEX_VERSION } from "../plugins/agent-codex";
import { reservedEnvName } from "../plugins/hooks";
import { pinnedRuntime, type McpServer } from "../profiles/runtime";
export { CLAUDE_USD_PER_MTOK, claudeCostUsd, type ClaudeUsage } from "../plugins/agent-claude";
export { CLAUDE_CODE_VERSION, CODEX_VERSION };

/** A real agent's kind: an active agent provider's (docs/spec/plugin-api.md §7.3), `claude-code` for Claude Code. */
export type RealAgent = string;
export type AgentKind = "fake" | RealAgent;

/** CAPCOMD_AGENT=claude-code|codex selects a real worker; default (unset/"fake") keeps the local fake work. */
// `pinned`: the spec recorded with the agent (profiles.ts pinnedAgent), which wins over a lookup by name.
export function agentFromEnv(source: Record<string, string | undefined> = process.env, profile?: string | null, pinned?: unknown): AgentKind {
  // CAPCOMD_AGENT may be a provider kind or a profile name; else the agents file's default; else fake.
  const { resolveAgent } = require("../profiles") as typeof import("../profiles");
  return resolveAgent(profile, source, pinned).kind;
}
export const isRealAgent = (k: AgentKind): k is RealAgent => k !== "fake";

/** Pinned node, installed only when the VM image/snapshot does not already have it (the CLIs' pins are their providers'). */
export const NODE_VERSION = "22.23.3";

/** Hosts every agent VM needs (clone/push, bootstrap registries). */
export const BASE_EGRESS = ["github.com", "registry.npmjs.org", "nodejs.org"];
/** An agent's API host (its provider's `describe().apiHost`); boxd host-bound secrets are bound to exactly this host. */
export function agentApiHost(kind: RealAgent): string {
  const p = agentSeam(providerOfKind(kind));
  if (!p) throw new Error(`no active agent provider for ${kind}`);
  return p.describe().apiHost;
}
/** claude-code allowlist (kept for compatibility). */
export const AGENT_EGRESS = ["github.com", "api.anthropic.com", "registry.npmjs.org", "nodejs.org"];
export function agentEgress(kind: RealAgent): string[] {
  return [...BASE_EGRESS.slice(0, 1), agentApiHost(kind), ...BASE_EGRESS.slice(1)];
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
export const PROVIDER_EGRESS: Record<"claude-code" | "codex", Record<EgressAuth, string[]>> = {
  "claude-code": { apikey: ["api.anthropic.com"], subscription: ["api.anthropic.com"] },
  codex: { apikey: ["api.openai.com"], subscription: ["api.openai.com", ...CODEX_SUBSCRIPTION_HOSTS] },
};
/** Full VM allowlist for one agent and auth mode: base hosts + that provider's set (another provider: its API host). */
export function egressFor(kind: RealAgent, auth: EgressAuth): string[] {
  return [...new Set([...BASE_EGRESS.slice(0, 1), ...((PROVIDER_EGRESS as Record<RealAgent, Record<EgressAuth, string[]> | undefined>)[kind]?.[auth] ?? [agentApiHost(kind)]), ...BASE_EGRESS.slice(1)])];
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
  const provider = providerOfKind(kind);
  const keyName = agentSeam(provider)?.describe().secretName ?? `${provider.toUpperCase()}_API_KEY`;
  const hasKey = !!source[keyName]?.trim(), hasSub = !!profileFor(kind, source);
  if (hasKey && hasSub) throw new Error(`${kind}: both ${keyName} and a subscription login are configured; choose one (agent profile auth, or CAPCOMD_AUTH=apikey|subscription)`);
  if (!hasKey && !hasSub) throw new Error(`${kind}: no credentials configured; set auth (agent profile or CAPCOMD_AUTH) and either ${keyName} or \`capcomd auth login ${provider}\``);
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
  /** ADR-019 §2: no events from the agent CLI for this long is a notice ("idle"); twice as long stops it (work kept)
   *  when `stopIdle`. */
  idleAfterMs: number;
  /** The same tool call, or the same error, this many times is a notice ("spinning", "failing"); twice stops it
   *  when `stopStuck`. */
  stuckRepeats: number;
  /** No limits by default: a stuck agent is only noticed, and stopped only when its profile (or the env) sets the
   *  window: idleAfterMs for idle, stuckRepeats for spinning and failing. */
  stopIdle: boolean;
  stopStuck: boolean;
  /** Opt-in (0: off): working with no change in the workspace for this long is spinning; twice stops it. */
  noChangeAfterMs: number;
  /** ADR-019 §3: the in-VM supervisor checkpoints the workspace this often (0: never). */
  checkpointEveryMs: number;
  pollMs: number;
  /** Unset: every tool, without permission prompts (the VM is the boundary; agents never hold push credentials). */
  allowedTools?: string[];
  disallowedTools: string[];
  /** Command prefixes the CLI's own rules refuse (an orchestrate agent's, plugin API §16.1; codex execpolicy). */
  denyCommands?: string[];
  model?: string;
  /** Reasoning effort (claude --effort, codex model_reasoning_effort); unset: the CLI's default. */
  effort?: string;
  /** Working dir inside the VM (persistent disk, so a snapshot keeps installs and the dep template). */
  workdir: string;
  /** Override the agent binary (tests: fake claude/codex). When set, detect/install is skipped. */
  claudeBin?: string;
  agentBin?: string;
  /** The VM's egress allowlist; [OPEN_EGRESS] (the default) is unrestricted. */
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
  /** The profile's `toolMode` (docs/spec/plugin-api.md §16.1), when `orchestrate`: the agent reads, spawns and decides,
   *  with its provider's tool policy applied to the lists above, and never commits or pushes. Unset: `execute`. */
  toolMode?: "orchestrate";
  /** Variables agent.preparing's plugins added for this attempt (docs/spec/plugin-api.md §6.6.7): checked new names and
   *  values that look like no secret, set in the agent's process environment. */
  pluginEnv?: Record<string, string>;
  /** Its profile's MCP servers (ADR-024 `tools.mcp`, pinned at spawn): its CLI starts them in its sandbox. */
  mcp?: McpServer[];
  /** The context bundles this attempt's brief cites (ADR-025 §6.2; src/primitives/ops.ts `agentPreparing`): each
   *  repository at its commit, placed by the runner at `dir` (under `<workdir>/context/`) before the agent starts. */
  contextBundles?: ContextBundleSpec[];
}

/** A context bundle as the attempt's spec records it: `path`, the directory in the repository that is placed (else the
 *  whole tree). */
export interface ContextBundleSpec { provider: string; name: string; remote: string; branch: string | null; commit: string; dir: string; path?: string }
/** A bundle's directory in its repository (ContextBundle.path): plain names separated by `/`, no `.` or `..`, nothing
 *  git reads as a pattern. */
export const BUNDLE_PATH = /^(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

/** The agent work directory in the sandbox (CAPCOMD_AGENT_WORKDIR, default /var/tmp/capcomd): checkouts, the warm
 *  template, context bundles. */
export const agentWorkdir = (source: Record<string, string | undefined> = process.env): string => envVar("AGENT_WORKDIR", source) ?? "/var/tmp/capcomd";

const BUNDLE_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;
/** The context bundles of the attempt's spec, each checked again here (a spec is data): a plain provider and name, a full
 *  commit, its directory exactly `<workdir>/context/<provider>/<name>`, a plain path in the repository when it names one. */
function contextBundlesOf(spec: unknown, workdir: string): ContextBundleSpec[] | null {
  const raw = (spec as { contextBundles?: unknown } | null | undefined)?.contextBundles;
  if (!Array.isArray(raw)) return null;
  const ok = raw.filter((b): b is ContextBundleSpec => !!b && typeof b === "object" && typeof b.provider === "string" && BUNDLE_NAME.test(b.provider) && typeof b.name === "string" && BUNDLE_NAME.test(b.name)
    && typeof b.remote === "string" && !!b.remote && typeof b.commit === "string" && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(b.commit) && (b.branch === null || typeof b.branch === "string")
    && b.dir === `${workdir}/context/${b.provider}/${b.name}` && (b.path === undefined || (typeof b.path === "string" && BUNDLE_PATH.test(b.path))));
  return ok.length ? ok.map(({ provider, name, remote, branch, commit, dir, path }) => ({ provider, name, remote, branch, commit, dir, ...(path !== undefined ? { path } : {}) })) : null;
}

/** The variables agent.preparing's plugins added, from the attempt's spec (src/primitives/ops.ts `agentPreparing`). */
function pluginEnvOf(spec: unknown): Record<string, string> | null {
  const e = (spec as { pluginEnv?: unknown } | null | undefined)?.pluginEnv;
  if (!e || typeof e !== "object" || Array.isArray(e)) return null;
  const ok = Object.entries(e).filter((x): x is [string, string] => /^[A-Z][A-Z0-9_]*$/.test(x[0]) && !reservedEnvName(x[0]) && typeof x[1] === "string");
  return ok.length ? Object.fromEntries(ok) : null;
}

/** The reasoning effort an agent runs with: CAPCOMD_AGENT_EFFORT, else its profile's; undefined means the CLI's default. */
export function agentEffort(spec: { effort?: string } | null | undefined, source: Record<string, string | undefined> = process.env): string | undefined {
  return envVar("AGENT_EFFORT", source) ?? spec?.effort;
}

/** The model an agent runs with: CAPCOMD_AGENT_MODEL, else its profile's; undefined means the CLI's own default. */
export function agentModel(spec: { model?: string } | null | undefined, source: Record<string, string | undefined> = process.env): string | undefined {
  return envVar("AGENT_MODEL", source) ?? spec?.model;
}

const list = (v: string | undefined, d: string[]) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : d);

export function loadAgentConfig(source: Record<string, string | undefined> = process.env, profileName?: string | null, pinned?: unknown): AgentConfig {
  const { resolveAgent } = require("../profiles") as typeof import("../profiles");
  const ra = resolveAgent(profileName, source, pinned);
  const spec = ra.spec;
  const specNum: Record<string, number | undefined> = { AGENT_MAX_TURNS: spec?.maxTurns, AGENT_MAX_BUDGET_USD: spec?.maxBudgetUsd, AGENT_TIMEOUT_MS: spec?.timeoutMs, AGENT_IDLE_MS: spec?.idleAfterMs, AGENT_STUCK_REPEATS: spec?.stuckRepeats, AGENT_NO_CHANGE_MS: spec?.noChangeAfterMs, AGENT_CHECKPOINT_MS: spec?.checkpointEveryMs };
  const opt = (name: string) => {
    const v = envVar(name, source);
    const n = v === undefined ? specNum[name] : Number(v);
    if (n !== undefined && (!Number.isFinite(n) || n <= 0)) throw new Error(`CAPCOMD_${name} must be a positive number`);
    return n;
  };
  const num = (name: string, d: number) => opt(name) ?? d;
  const kind = ra.kind;
  // No restrictions by default: the VM is the isolation boundary.
  const sandbox = (envVar("CODEX_SANDBOX", source) ?? spec?.sandbox ?? "danger-full-access") as AgentConfig["codexSandbox"];
  if (!["read-only", "workspace-write", "danger-full-access"].includes(sandbox)) throw new Error(`CAPCOMD_CODEX_SANDBOX=${sandbox} is invalid`);
  const cred = credentialModeFor(kind, source, spec?.auth);
  // ADR-024 `tools.mcp`: pinned at spawn on its spec; a profile resolved by name has them on the resolution.
  const mcp = ra.runtime?.mcp ?? pinnedRuntime(spec).mcp;
  const cfg: AgentConfig = {
    version: envVar("CLAUDE_CODE_VERSION", source) ?? CLAUDE_CODE_VERSION,
    codexVersion: envVar("CODEX_VERSION", source) ?? CODEX_VERSION,
    nodeVersion: envVar("AGENT_NODE_VERSION", source) ?? NODE_VERSION,
    maxTurns: opt("AGENT_MAX_TURNS"),
    maxBudgetUsd: opt("AGENT_MAX_BUDGET_USD"),
    timeoutMs: opt("AGENT_TIMEOUT_MS"),
    idleAfterMs: num("AGENT_IDLE_MS", 30 * 60_000),
    stuckRepeats: num("AGENT_STUCK_REPEATS", 8),
    stopIdle: opt("AGENT_IDLE_MS") !== undefined,
    stopStuck: opt("AGENT_STUCK_REPEATS") !== undefined,
    noChangeAfterMs: opt("AGENT_NO_CHANGE_MS") ?? 0,
    checkpointEveryMs: num("AGENT_CHECKPOINT_MS", 10 * 60_000),
    pollMs: num("AGENT_POLL_MS", 2000),
    ...(envVar("AGENT_ALLOWED_TOOLS", source) !== undefined || spec?.allowedTools ? { allowedTools: list(envVar("AGENT_ALLOWED_TOOLS", source), spec?.allowedTools ?? []) } : {}),
    disallowedTools: list(envVar("AGENT_DISALLOWED_TOOLS", source), spec?.disallowedTools ?? []),
    model: agentModel(spec, source),
    effort: agentEffort(spec, source),
    profile: ra.name,
    systemPrompt: spec?.systemPrompt,
    appendSystemPrompt: spec?.appendSystemPrompt,
    workdir: agentWorkdir(source),
    claudeBin: envVar("AGENT_CLAUDE_BIN", source),
    agentBin: envVar("AGENT_BIN", source),
    egress: list(envVar("AGENT_EGRESS", source), spec?.egress ?? (isRealAgent(kind) ? [OPEN_EGRESS] : AGENT_EGRESS)),
    codexSandbox: sandbox,
    codexUsdPerMtokIn: num("CODEX_USD_PER_MTOK_IN", 1.25),
    codexUsdPerMtokOut: num("CODEX_USD_PER_MTOK_OUT", 10),
    credentialMode: cred,
    ...(pluginEnvOf(spec) ? { pluginEnv: pluginEnvOf(spec)! } : {}),
    // An orchestrate agent runs nothing (§16.1): never a server, whatever made it orchestrate after its profile was checked.
    ...(mcp && isRealAgent(kind) && spec?.toolMode !== "orchestrate" ? { mcp } : {}),
    ...(contextBundlesOf(spec, agentWorkdir(source)) ? { contextBundles: contextBundlesOf(spec, agentWorkdir(source))! } : {}),
  };
  if (spec?.toolMode !== "orchestrate" || !isRealAgent(kind)) return cfg;
  // §16.1: the provider's policy on top of the profile's lists and the env's; nothing here widens it.
  const provider = agentSeam(spec.provider);
  if (!provider) throw new Error(`agent provider ${spec.provider} isn't active`);
  return { ...orchestrateConfig(cfg, provider), toolMode: "orchestrate" };
}
