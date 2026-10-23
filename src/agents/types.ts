import type { AgentConfig, ClaudeUsage, RealAgent } from "./config";
import type { Redactor } from "./redact";

export interface AgentEvent {
  type: string;
  subtype?: string;
  tool?: string;
  text?: string;
  raw: Record<string, unknown>;
}

/** Accumulated while the agent streams; adapters update it from their own event format. */
export interface AgentRunState {
  events: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** Per message id, the usage claude reported so far (each content block repeats its message's usage). */
  usage?: Record<string, ClaudeUsage>;
  /** Final summary text (claude `result`, codex last agent_message). */
  resultText?: string;
  /** Adapter saw a terminal result event. */
  done: boolean;
  /** Adapter saw an error/failed event. */
  error?: string;
  stopReason?: string;
  /** ADR-019 §6: the provider's usage limit was reached (a pause, not a failure); resetAt in ms epoch when given. */
  quota?: { message: string; resetAt?: number };
  /** claude: the latest rejected rate_limit_event's reset (ms epoch), used if a usage-limit stop follows. */
  quotaResetHint?: number;
}

export interface AgentCommandCtx {
  bin: string;
  repo: string;
  promptFile: string;
  /** Where stdout (the JSON event stream) must go. */
  jsonl: string;
  errFile: string;
  /** Files with the profile's system prompt / append (claude flags). */
  systemFile?: string;
  appendSystemFile?: string;
  /** Extra per-run files (e.g. codex last message). */
  dir: string;
  cfg: AgentConfig;
  /** ADR-017: in-VM capcomd for agents allowed to spawn (MCP server script + its config). */
  capcomd?: { cli: string; mcpConfig: string };
}

/**
 * One headless coding agent. The generic runner (runner.ts) does clone, detect/install,
 * credentials, background start, streaming, guards, cancel/timeout, commit and push.
 */
export interface AgentAdapter {
  kind: RealAgent;
  /** CLI binary name on PATH. */
  bin: string;
  /** npm package (installed pinned when the CLI is absent). */
  npmPackage: string;
  pinnedVersion(cfg: AgentConfig): string;
  /** API key env name; also the boxd host-bound secret name. */
  secretName: string;
  /** Host the secret is bound to. */
  apiHost: string;
  /** Env the CLI needs for a credential value (real key or bxds_ placeholder). */
  credentialEnv(value: string): Record<string, string>;
  /** Extra env for the agent process. */
  baseEnv(): Record<string, string>;
  /** Shell command (one line) that runs the agent headless; stdout must go to ctx.jsonl. */
  command(ctx: AgentCommandCtx, q: (s: string) => string): string;
  /** Parse one JSON line, update state; null for partial/invalid lines. */
  parse(line: string, r: Redactor, state: AgentRunState, cfg: AgentConfig): AgentEvent | null;
  /** Reason to stop the agent now (turn/budget guard), or null. */
  guard(state: AgentRunState, cfg: AgentConfig): string | null;
  /** Subscription mode (ADR-015 §5). Shell that prints "secret" and/or "file" when a plan login is present. */
  subscriptionCheck(home: string, q: (s: string) => string): string;
  /** Lines run in run.sh before the agent: drop API keys, load the plan login. */
  subscriptionPrelude(home: string, q: (s: string) => string): string;
  /** Interactive login argv (run in a PTY in the login VM). */
  loginCommand(bin: string): string[];
  /** Hosts the login VM may reach. */
  loginEgress: string[];
  /** Cheap headless call proving the login works; exit 0 + stdout containing "ok". */
  verifyCommand(bin: string, q: (s: string) => string): string;
  /** Interpret the finished run. */
  outcome(state: AgentRunState, exitCode: number): { ok: boolean; stopReason: string };
}
