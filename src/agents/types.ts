import type { AgentConfig, ClaudeUsage, RealAgent } from "./config";
import type { Redactor } from "./redact";
import type { AgentArchive } from "../../packages/plugin/src/seams";

export interface AgentEvent {
  type: string;
  subtype?: string;
  tool?: string;
  text?: string;
  /** ADR-019 §2: the tool calls this event makes, each as "name input" (the same string means the same call). */
  calls?: string[];
  /** The tool results it carries: the call they answer, and the error text when the call failed. */
  results?: Array<{ call: string; error?: string }>;
  /** Plugin API §16.4: the foreground shell commands this event starts (`started`, by the CLI's call id) and the calls it
   *  ends (`ended`), so the runner knows while the agent waits on one. */
  commands?: { started?: string[]; ended?: string[] };
  raw: Record<string, unknown>;
}

/** Accumulated while the agent streams; adapters update it from their own event format. */
export interface AgentRunState {
  events: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  /** Of inputTokens, how many were cache reads, when the CLI says (claude cache_read_input_tokens, codex cached_input_tokens). */
  cacheReadTokens?: number;
  /** The model the CLI says it ran (claude's init and messages), when it says. */
  model?: string;
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
  /** claude: each tool_use id's call ("name input"), so its tool_result can be matched to it. */
  toolCalls?: Record<string, string>;
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
  /** ADR-024 `tools.mcp`: its profile's MCP servers, started in the sandbox. `config` is a file with them and capcomd's
   *  own (when it has one) as `{mcpServers}` (Claude Code `--mcp-config`); `servers`, for a CLI that takes flags. */
  mcp?: { config: string; servers: Array<{ name: string; command: string[]; trust: "trusted" | "untrusted" }> };
  /** The supervisor feeds the prompt, and messages sent while it runs, on stdin (adapters with streamInput). */
  stdinPrompt?: boolean;
}

/**
 * One headless coding agent. The generic runner (runner.ts) does clone, detect/install,
 * credentials, background start, streaming, guards, cancel/timeout, commit and push.
 */
export interface AgentAdapter {
  kind: RealAgent;
  /** CLI binary name on PATH. */
  bin: string;
  /** npm package (installed pinned when the CLI is absent), or `install`: release archives checked by sha256. */
  npmPackage?: string;
  install?: { kind: "archive"; member: string; assets: { x86_64: AgentArchive; aarch64: AgentArchive } };
  pinnedVersion(cfg: AgentConfig): string;
  /** API key env name; also the boxd host-bound secret name. */
  secretName: string;
  /** Host the secret is bound to. */
  apiHost: string;
  /** Env the CLI needs for a credential value (real key or bxds_ placeholder). */
  credentialEnv(value: string): Record<string, string>;
  /** Extra env for the agent process. */
  baseEnv(): Record<string, string>;
  /** The CLI reads user messages on stdin while it runs (`send` reaches it mid-run; see ctx.stdinPrompt). */
  streamInput?: boolean;
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
  /** Interactive login argv (run in a PTY in the login VM); `login` names one of `logins`. */
  loginCommand(bin: string, login?: string): string[];
  /** Hosts the login VM may reach. */
  loginEgress: string[];
  /** The plan logins the CLI offers when it has more than one (each with the hosts its login VM reaches). */
  logins?: Array<{ name: string; label: string; egress: string[]; refused?: string; metered?: boolean }>;
  /** Shell printing `{"loggedIn": <boolean>}` after a login: whether the CLI sees it (only the boolean leaves the VM). */
  loginCheck?(bin: string, q: (s: string) => string): string;
  /** Cheap headless call proving the login works; exit 0 + stdout containing "ok". */
  verifyCommand(bin: string, q: (s: string) => string): string;
  /** Interpret the finished run. */
  outcome(state: AgentRunState, exitCode: number): { ok: boolean; stopReason: string };
  /** A tool call the CLI refused, from one stderr line (a CLI that reports refusals only there: codex). */
  refusal?(line: string, r: Redactor): { call: string; reason: string } | null;
}
