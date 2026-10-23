// Claude Code and Codex adapters for the generic runner.
import type { AgentAdapter, AgentEvent, AgentRunState } from "./types";
import type { AgentConfig, RealAgent } from "./config";
import { AGENT_API_HOST, claudeCostUsd } from "./config";
import type { Redactor } from "./redact";

function parseJson(line: string, r: Redactor): any | null {
  let raw: any;
  try { raw = JSON.parse(line); } catch { return null; }
  if (!raw || typeof raw !== "object") return null;
  return r.value(raw);
}

/**
 * Provider usage limits (ADR-019 §6), from the CLIs' own code at the pinned versions (claude 2.1.303 `lt()`/`zWo()`,
 * codex-rs 0.163.0 `UsageLimitReachedError`). A plain 429 is retried by the CLI itself and isn't one of these.
 */
const CLAUDE_USAGE_LIMIT = /^(You['’]ve hit your|You['’]ve reached your|You['’]re out of usage credits)/;
const CODEX_USAGE_LIMIT = /^(You['’]ve hit your usage limit|Quota exceeded\. Check your plan|Your workspace is out of credits|You hit your spend cap)/;

/**
 * codex prints a usage limit's reset only as VM-local clock text ("Try again at 3:05 PM." today, else
 * "Try again at Oct 25th, 2026 3:05 PM."); the VM runs it with TZ=UTC. Best effort: undefined if absent or unparsable.
 */
export function codexResetAt(message: string, now = Date.now()): number | undefined {
  const m = /try again at (.+?)\.?$/i.exec(message.trim());
  if (!m) return undefined;
  const t = /^(?:([A-Z][a-z]{2}) (\d{1,2})(?:st|nd|rd|th)?, (\d{4}) )?(\d{1,2}):(\d{2}) ?([AP]M)$/i.exec(m[1]!.trim());
  if (!t) return undefined;
  const h = (Number(t[4]) % 12) + (t[6]!.toUpperCase() === "PM" ? 12 : 0), min = Number(t[5]);
  const d = new Date(now);
  if (t[1]) {
    const mon = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(t[1].toLowerCase());
    return mon < 0 ? undefined : Date.UTC(Number(t[3]), mon, Number(t[2]), h, min);
  }
  const at = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, min);
  return at < now - 60_000 ? at + 86_400_000 : at;
}

/** Claude Code `--output-format stream-json`: system/assistant/user/result events. */
export const claudeAdapter: AgentAdapter = {
  kind: "claude-code",
  bin: "claude",
  npmPackage: "@anthropic-ai/claude-code",
  pinnedVersion: (cfg) => cfg.version,
  secretName: "ANTHROPIC_API_KEY",
  apiHost: AGENT_API_HOST["claude-code"],
  credentialEnv: (v) => ({ ANTHROPIC_API_KEY: v }),
  baseEnv: () => ({ CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", CI: "1" }),
  command: (ctx, q) =>
    `${q(ctx.bin)} -p "$(cat ${q(ctx.promptFile)})" --output-format stream-json --verbose` +
    (ctx.cfg.maxTurns ? ` --max-turns ${ctx.cfg.maxTurns}` : "") +
    (ctx.cfg.maxBudgetUsd ? ` --max-budget-usd ${ctx.cfg.maxBudgetUsd}` : "") +
    ` --allowedTools ${q(ctx.cfg.allowedTools.join(","))} --disallowedTools ${q(ctx.cfg.disallowedTools.join(","))}` +
    (ctx.cfg.model ? ` --model ${q(ctx.cfg.model)}` : "") +
    (ctx.systemFile ? ` --system-prompt "$(cat ${q(ctx.systemFile)})"` : "") +
    (ctx.appendSystemFile ? ` --append-system-prompt "$(cat ${q(ctx.appendSystemFile)})"` : "") +
    (ctx.capcomd ? ` --mcp-config ${q(ctx.capcomd.mcpConfig)}` : "") +
    ` > ${q(ctx.jsonl)} 2> ${q(ctx.errFile)} < /dev/null`,
  parse(line, r, state) {
    const raw = parseJson(line, r);
    if (!raw) return null;
    const ev: AgentEvent = { type: String(raw.type ?? "unknown"), raw };
    if (raw.subtype) ev.subtype = String(raw.subtype);
    const content = raw.message?.content;
    if (Array.isArray(content)) {
      const tool = content.find((c: any) => c?.type === "tool_use");
      if (tool) ev.tool = String(tool.name);
      const text = content.filter((c: any) => c?.type === "text").map((c: any) => c.text).join("\n");
      if (text) ev.text = text.slice(0, 500);
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
      state.inputTokens = all.reduce((x, v) => x + v.input + v.cacheWrite + v.cacheRead, 0);
      state.outputTokens = all.reduce((x, v) => x + v.output, 0);
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
  loginEgress: ["api.anthropic.com", "console.anthropic.com", "platform.claude.com", "claude.ai", "claude.com"],
  verifyCommand: (bin, q) => `${q(bin)} -p 'Reply with exactly the word ok' --max-turns 1 --output-format text < /dev/null`,
  // --max-turns / --max-budget-usd are enforced by the CLI itself.
  guard: () => null,
  outcome(state, exitCode) {
    if (exitCode === 124) return { ok: false, stopReason: "timeout" };
    if (exitCode !== 0 || !state.done || state.error) return { ok: false, stopReason: state.stopReason ?? `exit_${exitCode}` };
    return { ok: true, stopReason: state.stopReason ?? "success" };
  },
};

const CODEX_TOOL_ITEMS = new Set(["command_execution", "file_change", "mcp_tool_call", "web_search"]);

/**
 * Codex `codex exec --json` (JSONL: thread.started, turn.started, turn.completed{usage}, turn.failed,
 * item.started/updated/completed, error). Source: https://developers.openai.com/codex/noninteractive
 * and the `codex exec` flag table at https://learn.chatgpt.com/docs/developer-commands (checked 2026-10-19).
 * codex has no turn/budget flags, so the runner enforces both: "turns" = tool steps
 * (command_execution/file_change/mcp_tool_call/web_search items), cost = tokens × configured rates.
 */
export const codexAdapter: AgentAdapter = {
  kind: "codex",
  bin: "codex",
  npmPackage: "@openai/codex",
  pinnedVersion: (cfg) => cfg.codexVersion,
  secretName: "OPENAI_API_KEY",
  apiHost: AGENT_API_HOST.codex,
  // codex exec reads CODEX_API_KEY for API-key auth in automation.
  credentialEnv: (v) => ({ CODEX_API_KEY: v, OPENAI_API_KEY: v }),
  // TZ=UTC: codex prints a usage limit's reset as local clock time (codexResetAt).
  baseEnv: () => ({ CI: "1", NO_COLOR: "1", TZ: "UTC" }),
  command: (ctx, q) =>
    `${q(ctx.bin)} exec --json --color never --ephemeral --sandbox ${ctx.cfg.codexSandbox} -C ${q(ctx.repo)}` +
    (ctx.cfg.model ? ` -m ${q(ctx.cfg.model)}` : "") +
    (ctx.capcomd ? ` -c ${q('mcp_servers.capcomd.command="node"')} -c ${q(`mcp_servers.capcomd.args=["${ctx.capcomd.cli}","mcp"]`)}` : "") +
    ` -o ${q(`${ctx.dir}/last-message.txt`)} "$(cat ${q(ctx.promptFile)})"` +
    ` > ${q(ctx.jsonl)} 2> ${q(ctx.errFile)} < /dev/null`,
  parse(line, r, state, cfg) {
    const raw = parseJson(line, r);
    if (!raw) return null;
    const type = String(raw.type ?? "unknown");
    const ev: AgentEvent = { type: type.replace(/\./g, "_"), raw };
    const item = raw.item;
    if (item && typeof item === "object") {
      ev.subtype = String(item.type ?? "");
      if (type === "item.completed" && CODEX_TOOL_ITEMS.has(item.type)) { state.turns++; ev.tool = item.type === "command_execution" ? `Bash(${String(item.command ?? "").slice(0, 80)})` : String(item.type); }
      if (item.type === "agent_message" && typeof item.text === "string") { ev.text = item.text.slice(0, 500); if (type === "item.completed") state.resultText = item.text; }
    }
    if (type === "turn.completed") {
      const u = raw.usage ?? {};
      state.inputTokens += Number(u.input_tokens ?? 0);
      state.outputTokens += Number(u.output_tokens ?? 0) + Number(u.reasoning_output_tokens ?? 0);
      state.costUsd = (state.inputTokens * cfg.codexUsdPerMtokIn + state.outputTokens * cfg.codexUsdPerMtokOut) / 1e6;
      state.done = true;
      state.stopReason = "success";
    }
    if (type === "turn.failed" || type === "error") {
      state.error = String(raw.error?.message ?? raw.message ?? type).slice(0, 300);
      // A usage limit isn't retried by codex (retryable errors read "Reconnecting…", "exceeded retry limit…").
      if (CODEX_USAGE_LIMIT.test(state.error.trim())) {
        const reset = codexResetAt(state.error);
        state.quota = { message: state.error, ...(reset ? { resetAt: reset } : {}) };
      }
      state.stopReason = type === "error" ? "error" : "turn_failed";
      ev.text = state.error;
    }
    return ev;
  },
  // ChatGPT-plan login: `codex login --device-auth` writes $CODEX_HOME/auth.json when
  // cli_auth_credentials_store = "file" (https://learn.chatgpt.com/docs/auth).
  subscriptionCheck: (home, q) => `[ -s ${q(`${home}/.codex/auth.json`)} ] && echo file; true`,
  subscriptionPrelude: (home, q) => `unset CODEX_API_KEY OPENAI_API_KEY; export CODEX_HOME=${q(`${home}/.codex`)}`,
  loginCommand: (bin) => [bin, "login", "--device-auth"],
  loginEgress: ["auth.openai.com", "chatgpt.com", "api.openai.com"],
  verifyCommand: (bin, q) => `${q(bin)} exec --json --color never --ephemeral --skip-git-repo-check --sandbox read-only 'Reply with exactly the word ok' < /dev/null | grep -q '"turn.completed"' && echo ok`,
  guard(state, cfg) {
    if (cfg.maxTurns && state.turns > cfg.maxTurns) return `max_turns (${state.turns} > ${cfg.maxTurns} tool steps)`;
    // On a plan login the token cost is notional; the turn guard and timeout still apply.
    if (cfg.maxBudgetUsd && cfg.credentialMode !== "subscription" && state.costUsd > cfg.maxBudgetUsd) return `max_budget_usd (~$${state.costUsd.toFixed(3)} > $${cfg.maxBudgetUsd})`;
    return null;
  },
  outcome(state, exitCode) {
    if (exitCode === 124) return { ok: false, stopReason: "timeout" };
    if (exitCode !== 0 || state.error || !state.done) return { ok: false, stopReason: state.stopReason ?? `exit_${exitCode}` };
    return { ok: true, stopReason: "success" };
  },
};

export function adapterFor(kind: RealAgent): AgentAdapter {
  return kind === "codex" ? codexAdapter : claudeAdapter;
}
export const ALL_ADAPTERS: AgentAdapter[] = [claudeAdapter, codexAdapter];
export type { AgentRunState };
export type { AgentConfig };
