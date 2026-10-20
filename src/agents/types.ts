import type { AgentConfig, RealAgent } from "./config";
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
  /** Final summary text (claude `result`, codex last agent_message). */
  resultText?: string;
  /** Adapter saw a terminal result event. */
  done: boolean;
  /** Adapter saw an error/failed event. */
  error?: string;
  stopReason?: string;
}

export interface AgentCommandCtx {
  bin: string;
  repo: string;
  promptFile: string;
  /** Where stdout (the JSON event stream) must go. */
  jsonl: string;
  errFile: string;
  /** Extra per-run files (e.g. codex last message). */
  dir: string;
  cfg: AgentConfig;
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
  /** Interpret the finished run. */
  outcome(state: AgentRunState, exitCode: number): { ok: boolean; stopReason: string };
}
