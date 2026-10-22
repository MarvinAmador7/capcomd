// Claude Code and Codex adapters for the generic runner.
import type { AgentAdapter, AgentEvent, AgentRunState } from "./types";
import type { AgentConfig, RealAgent } from "./config";
import { AGENT_API_HOST } from "./config";
import type { Redactor } from "./redact";

function parseJson(line: string, r: Redactor): any | null {
  let raw: any;
  try { raw = JSON.parse(line); } catch { return null; }
  if (!raw || typeof raw !== "object") return null;
  return r.value(raw);
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
  baseEnv: () => ({ CI: "1", NO_COLOR: "1" }),
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
