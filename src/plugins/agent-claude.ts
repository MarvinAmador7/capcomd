// Built-in plugin agent-claude (docs/spec/plugin-api.md §7.3, §17.1): Claude Code as the `claude` agent seam. What was
// src/agents/adapters.ts claudeAdapter and the claude rows of the PROVIDER_* tables; the kernel's runner reads it
// through the seam (src/plugins/agents.ts).
import { definePlugin } from "../../packages/plugin/src/context";
import type { AgentEvent, AgentProvider, AgentRunState } from "../../packages/plugin/src/seams";
import { agentManifest, classifyAgentError, contentText, ORCHESTRATE_DENIED_COMMANDS, ORCHESTRATE_READ_COMMANDS, ORCHESTRATE_READ_EXACT, parseJson, toolCall } from "./agent-common";

/** Pinned version, installed only when the VM image/snapshot does not already have the CLI. */
export const CLAUDE_CODE_VERSION = "2.1.303";

/**
 * Provider usage limits (ADR-019 §6), from the CLI's own code at the pinned version (claude 2.1.303 `lt()`/`zWo()`).
 * A plain 429 is retried by the CLI itself and isn't one of these.
 */
const CLAUDE_USAGE_LIMIT = /^(You['’]ve hit your|You['’]ve reached your|You['’]re out of usage credits)/;

/**
 * USD per million tokens, for Claude's spend while it runs (claude reports a cost only when it finishes; that total
 * replaces the estimate). Matched against the model in each message, first match wins; cache writes cost 1.25×
 * input, cache reads `cacheRead` (else 0.1× input). Anthropic list prices, 2026-10. An unknown model is priced as
 * the dearer older Opus, so a budget errs towards stopping early.
 */
export const CLAUDE_USD_PER_MTOK: Array<[RegExp, { in: number; out: number; cacheRead?: number }]> = [
  [/fable-5-1|mythos-5-1/, { in: 10, out: 50, cacheRead: 0.25 }],
  [/fable|mythos/, { in: 10, out: 50 }],
  [/opus-5-5/, { in: 4, out: 20, cacheRead: 0.2 }],
  [/sonnet-5/, { in: 2, out: 10, cacheRead: 0.2 }],
  [/haiku-5-5/, { in: 0.1, out: 0.5 }],
  [/sonnet/, { in: 3, out: 15 }],
  [/haiku/, { in: 1, out: 5 }],
  [/.*/, { in: 5, out: 25 }],
];
export interface ClaudeUsage { model?: string; input: number; cacheWrite: number; cacheRead: number; output: number }
export function claudeCostUsd(u: ClaudeUsage): number {
  const p = CLAUDE_USD_PER_MTOK.find(([re]) => re.test(u.model ?? ""))![1];
  return (u.input * p.in + u.cacheWrite * p.in * 1.25 + u.cacheRead * (p.cacheRead ?? p.in * 0.1) + u.output * p.out) / 1e6;
}

/** What this provider keeps on the run's state between lines. */
type ClaudeState = AgentRunState & {
  /** Per message id, the usage claude reported so far (each content block repeats its message's usage). */
  usage?: Record<string, ClaudeUsage>;
  /** The latest rejected rate_limit_event's reset (ms epoch), used if a usage-limit stop follows. */
  quotaResetHint?: number;
  /** Each tool_use id's call ("name input"), so its tool_result can be matched to it. */
  toolCalls?: Record<string, string>;
};

/** §16.1's orchestrate commands as Claude Code permission rules: `Bash(<prefix>:*)`, `Bash(<exact command>)`. */
export const ORCHESTRATE_ALLOWED: readonly string[] = ["Read", "Glob", "Grep", "LS", ...ORCHESTRATE_READ_COMMANDS.map((c) => `Bash(${c}:*)`), ...ORCHESTRATE_READ_EXACT.map((c) => `Bash(${c})`)];
export const ORCHESTRATE_DISALLOWED: readonly string[] = [
  "Edit", "Write", "MultiEdit", "NotebookEdit", ...ORCHESTRATE_DENIED_COMMANDS.map((c) => `Bash(${c}:*)`),
  // Options of allowed git commands that run a command or write a file, anywhere on the line (claude 2.1.303 matches
  // `*` in a rule as any text): `fetch --upload-pack=<cmd>` runs it, `grep -O<cmd>` opens results in it, `--output=<f>`
  // writes the log or diff to a file.
  "Bash(git fetch *--upload-pack*)", "Bash(git grep *-O*)", "Bash(git grep *--open-files-in-pager*)", "Bash(git * --output*)",
];

const DESCRIPTION = {
  name: "claude", label: "Claude Code", bin: "claude", npmPackage: "@anthropic-ai/claude-code", pinnedVersion: CLAUDE_CODE_VERSION,
  secretName: "ANTHROPIC_API_KEY", apiHost: "api.anthropic.com",
  // §7.3: the kernel's to set and read, never a plugin's: where Claude Code reads its key, its endpoint and its settings (ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL, CLAUDE_CONFIG_DIR).
  envPrefixes: ["ANTHROPIC_", "CLAUDE_"],
  // `--effort <level>` (Claude Code `--help`), lowest to highest; unset: the CLI decides (by model).
  efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: null,
  // Messages written to stdin while it works are read at its next model call; it exits when stdin closes.
  streamInput: true,
  loginEgress: ["api.anthropic.com", "console.anthropic.com", "platform.claude.com", "claude.ai", "claude.com"],
  // §16.1: an orchestrate agent sees everything and runs nothing. With an allowlist claude runs without
  // bypassPermissions, so a tool (or a Bash command) the list doesn't name is refused headless. The allowlist is the
  // read tools, capcomd and the read-only commands (git's among them: fetch, log, show, diff, a detached checkout to read
  // a branch); the denylist names the edit tools and the commands that change or run code, so they are refused by name.
  // No denied prefix starts an allowed one: a deny rule outranks every allow (a bare `Bash` deny would take
  // `Bash(capcomd:*)` with it).
  toolPolicies: { orchestrate: { allowed: ORCHESTRATE_ALLOWED, disallowed: ORCHESTRATE_DISALLOWED } },
};

/** Claude Code `--output-format stream-json`: system/assistant/user/result events. */
export const claude: AgentProvider = {
  describe: () => ({ ...DESCRIPTION, envPrefixes: [...DESCRIPTION.envPrefixes], efforts: [...DESCRIPTION.efforts], loginEgress: [...DESCRIPTION.loginEgress], toolPolicies: { orchestrate: { allowed: [...DESCRIPTION.toolPolicies.orchestrate.allowed], disallowed: [...DESCRIPTION.toolPolicies.orchestrate.disallowed] } } }),
  async available(input) {
    const { credentialReady } = await import("../agents/run-driver");
    const r = credentialReady("claude", input.auth);
    return r.ready ? { ok: true } : { ok: false, reason: r.reason ?? "no credential", fix: input.auth === "apikey" ? "Set ANTHROPIC_API_KEY." : "Run `capcomd auth login claude`." };
  },
  classifyError: (e) => classifyAgentError(e, "Run `capcomd auth login claude`, or set ANTHROPIC_API_KEY."),
  credentialEnv: (v) => ({ ANTHROPIC_API_KEY: v }),
  // IS_SANDBOX: the VM is the sandbox, so permissions may be bypassed even as root (claude refuses that otherwise).
  baseEnv: () => ({ CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", CI: "1", IS_SANDBOX: "1" }),
  command: (ctx, q) =>
    `${q(ctx.bin)} -p ${ctx.stdinPrompt ? "--input-format stream-json" : `"$(cat ${q(ctx.promptFile)})"`} --output-format stream-json --verbose` +
    (ctx.cfg.maxTurns ? ` --max-turns ${ctx.cfg.maxTurns}` : "") +
    (ctx.cfg.maxBudgetUsd ? ` --max-budget-usd ${ctx.cfg.maxBudgetUsd}` : "") +
    // No allowlist: every tool, with no permission prompts (nobody is there to answer them headless).
    (ctx.cfg.allowedTools ? ` --allowedTools ${q(ctx.cfg.allowedTools.join(","))}` : " --permission-mode bypassPermissions") +
    (ctx.cfg.disallowedTools?.length ? ` --disallowedTools ${q(ctx.cfg.disallowedTools.join(","))}` : "") +
    (ctx.cfg.model ? ` --model ${q(ctx.cfg.model)}` : "") +
    (ctx.cfg.effort ? ` --effort ${q(ctx.cfg.effort)}` : "") +
    (ctx.systemFile ? ` --system-prompt "$(cat ${q(ctx.systemFile)})"` : "") +
    (ctx.appendSystemFile ? ` --append-system-prompt "$(cat ${q(ctx.appendSystemFile)})"` : "") +
    // The profile's MCP servers' file holds capcomd's own too (ctx.mcp.config); else capcomd's alone.
    (ctx.mcp || ctx.capcomd ? ` --mcp-config ${q(ctx.mcp?.config ?? ctx.capcomd!.mcpConfig)}` : "") +
    ` > ${q(ctx.jsonl)} 2> ${q(ctx.errFile)}${ctx.stdinPrompt ? "" : " < /dev/null"}`,
  parse(line, redact, run) {
    const state = run as ClaudeState;
    const raw = parseJson(line, redact);
    if (!raw) return null;
    const ev: AgentEvent = { type: String(raw.type ?? "unknown"), raw };
    if (raw.subtype) ev.subtype = String(raw.subtype);
    if (ev.type === "system" && raw.subtype === "init" && typeof raw.model === "string") state.model = raw.model;
    const content = raw.message?.content;
    if (Array.isArray(content)) {
      const tool = content.find((c: any) => c?.type === "tool_use");
      if (tool) ev.tool = String(tool.name);
      const text = content.filter((c: any) => c?.type === "text").map((c: any) => c.text).join("\n");
      if (text) ev.text = text.slice(0, 500);
      // Tool calls and their results (matched by tool_use id), for the stuck watch.
      const uses = content.filter((c: any) => c?.type === "tool_use");
      if (uses.length) ev.calls = uses.map((u: any) => { const call = toolCall(u.name, u.input); if (u.id) (state.toolCalls ??= {})[String(u.id)] = call; return call; });
      const results = content.filter((c: any) => c?.type === "tool_result" && state.toolCalls?.[String(c.tool_use_id)]);
      if (results.length) ev.results = results.map((x: any) => ({ call: state.toolCalls![String(x.tool_use_id)]!, ...(x.is_error ? { error: contentText(x.content) } : {}) }));
      // A Bash call it waits on (not one it sent to the background) runs until its result comes (plugin API §16.4).
      const started = uses.filter((u: any) => u.name === "Bash" && u.id && u.input?.run_in_background !== true).map((u: any) => String(u.id));
      const ended = content.filter((c: any) => c?.type === "tool_result" && c.tool_use_id).map((c: any) => String(c.tool_use_id));
      if (started.length || ended.length) ev.commands = { ...(started.length ? { started } : {}), ...(ended.length ? { ended } : {}) };
    }
    // Live spend (ADR-019): claude reports a cost only in its final result, so meanwhile it is estimated from each
    // message's usage. A message streams as several events with the same id and usage: counted once.
    const m = raw.message;
    if (ev.type === "assistant" && m?.id && m.usage && !state.done) {
      const u = m.usage;
      (state.usage ??= {})[String(m.id)] = {
        model: typeof m.model === "string" ? m.model : undefined, input: Number(u.input_tokens ?? 0),
        cacheWrite: Number(u.cache_creation_input_tokens ?? 0), cacheRead: Number(u.cache_read_input_tokens ?? 0), output: Number(u.output_tokens ?? 0),
      };
      const all = Object.values(state.usage);
      state.costUsd = all.reduce((x, v) => x + claudeCostUsd(v), 0);
      // Turns, likewise: one per model response until the result's num_turns replaces the count.
      state.turns = all.length;
      state.inputTokens = all.reduce((x, v) => x + v.input + v.cacheWrite + v.cacheRead, 0);
      state.cacheReadTokens = all.reduce((x, v) => x + v.cacheRead, 0);
      state.outputTokens = all.reduce((x, v) => x + v.output, 0);
      // The session's model: a subagent's messages (parent_tool_use_id set) may run on another one (Explore on haiku).
      if (typeof m.model === "string" && m.model !== "<synthetic>" && !raw.parent_tool_use_id) state.model = m.model;
    }
    // Usage limit: a rejected rate_limit_event carries the reset (epoch s); the stop itself is a synthetic assistant
    // message and an is_error result with api_error "usage_limit_reached" (internal, so the text prefix too).
    if (ev.type === "rate_limit_event" && raw.rate_limit_info?.status === "rejected" && Number(raw.rate_limit_info.resetsAt) > 0)
      state.quotaResetHint = Number(raw.rate_limit_info.resetsAt) * 1000;
    const errText = ev.type === "result" ? (typeof raw.result === "string" ? raw.result : "") : ev.text ?? "";
    if ((ev.type === "assistant" || (ev.type === "result" && raw.is_error)) && (raw.api_error === "usage_limit_reached" || (raw.error === "rate_limit" || ev.type === "result") && CLAUDE_USAGE_LIMIT.test(errText))) {
      const reset = Number(raw.api_error_params?.rate_limit_info?.resetsAt) * 1000 || state.quotaResetHint;
      state.quota = { message: errText.slice(0, 300), ...(reset ? { resetAt: reset } : {}) };
    }
    if (ev.type === "result") {
      if (typeof raw.result === "string") { ev.text = raw.result.slice(0, 500); state.resultText = raw.result; }
      state.done = true;
      state.costUsd = Number(raw.total_cost_usd ?? 0);
      state.turns = Number(raw.num_turns ?? 0);
      // Tokens processed, cache reads/writes included (they are input the model consumed).
      const u = raw.usage ?? {};
      state.inputTokens = Number(u.input_tokens ?? 0) + Number(u.cache_creation_input_tokens ?? 0) + Number(u.cache_read_input_tokens ?? 0);
      state.cacheReadTokens = Number(u.cache_read_input_tokens ?? 0);
      state.outputTokens = Number(u.output_tokens ?? 0);
      state.stopReason = String(raw.subtype ?? "result");
      if (raw.is_error) state.error = state.stopReason;
    }
    return ev;
  },
  // `claude setup-token` prints a one-year CLAUDE_CODE_OAUTH_TOKEN (https://code.claude.com/docs/en/authentication).
  // It ranks below ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN, so those are unset first.
  subscriptionCheck: (home, q) => `case "$(printenv CLAUDE_CODE_OAUTH_TOKEN)" in bxds_*) echo secret;; esac; [ -s ${q(`${home}/.capcomd-auth/claude.env`)} ] && echo file; [ -s ${q(`${home}/.claude/.credentials.json`)} ] && echo file; true`,
  subscriptionPrelude: (home, q) => `unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN; [ -s ${q(`${home}/.capcomd-auth/claude.env`)} ] && . ${q(`${home}/.capcomd-auth/claude.env`)}; export CLAUDE_CODE_OAUTH_TOKEN`,
  loginCommand: (bin) => [bin, "setup-token"],
  verifyCommand: (bin, q) => `${q(bin)} -p 'Reply with exactly the word ok' --max-turns 1 --output-format text < /dev/null`,
  // --max-turns / --max-budget-usd are enforced by the CLI itself.
  guard: () => null,
  outcome(state, exitCode) {
    if (exitCode === 124) return { ok: false, stopReason: "timeout" };
    if (exitCode !== 0 || !state.done || state.error) return { ok: false, stopReason: state.stopReason ?? `exit_${exitCode}` };
    return { ok: true, stopReason: state.stopReason ?? "success" };
  },
};

export const manifest = agentManifest("agent-claude", "claude", "Claude Code as an agent provider: runs the claude CLI headless in the agent's sandbox and reads its stream-json events.");
export const plugin = definePlugin({ activate(ctx) { ctx.seams.agent(claude); } });
