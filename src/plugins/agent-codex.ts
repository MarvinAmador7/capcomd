// Built-in plugin agent-codex (docs/spec/plugin-api.md §7.3, §17.1): Codex as the `codex` agent seam. What was
// src/agents/adapters.ts codexAdapter and the codex rows of the PROVIDER_* tables; the kernel's runner reads it through
// the seam (src/plugins/agents.ts).
import { definePlugin } from "../../packages/plugin/src/context";
import type { AgentEvent, AgentProvider, AgentRunState } from "../../packages/plugin/src/seams";
import { agentManifest, classifyAgentError, ORCHESTRATE_DENIED_COMMANDS, parseJson, toolCall } from "./agent-common";

/** Pinned version, installed only when the VM image/snapshot does not already have the CLI. */
export const CODEX_VERSION = "0.163.0";

/** Provider usage limits (ADR-019 §6), from codex-rs 0.163.0 `UsageLimitReachedError`. A plain 429 is retried by the
 *  CLI itself and isn't one of these. */
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

/** codex's own field on the run's state: the event that set `error`. An "error" event's is cleared by a later
 *  turn.completed (the CLI retried and recovered); a "turn.failed" is final. */
type CodexRunState = AgentRunState & { errorFrom?: "error" | "turn.failed" };

const CODEX_TOOL_ITEMS =new Set(["command_execution", "file_change", "mcp_tool_call", "web_search"]);

const DESCRIPTION = {
  name: "codex", label: "Codex", bin: "codex", npmPackage: "@openai/codex", pinnedVersion: CODEX_VERSION,
  secretName: "OPENAI_API_KEY", apiHost: "api.openai.com",
  // `-c model_reasoning_effort=<level>`, lowest to highest; the CLI's own default is medium.
  efforts: ["minimal", "low", "medium", "high"], defaultEffort: "medium",
  streamInput: false,
  loginEgress: ["auth.openai.com", "chatgpt.com", "api.openai.com"],
  // §16.1: codex has no per-tool allowlist for its shell, and its own sandbox can't be the limit: `read-only` blocks
  // `git fetch` (it writes .git, and the sandbox has no network) and, in a container, can't start at all (bwrap needs
  // user namespaces, which Docker doesn't allow), so every command fails, reads included. So the sandbox stays the
  // agent's (the VM or container is the boundary, as for every agent) and the limit is codex's command rules
  // (execpolicy): the commands that change or run code are forbidden by prefix. Whatever an orchestrate agent writes
  // anyway never lands: the kernel never commits or pushes its checkout, and reports what it discarded.
  toolPolicies: { orchestrate: { allowed: [], disallowed: [], denyCommands: ORCHESTRATE_DENIED_COMMANDS } },
} as const;

/** The codex execpolicy rules (`$CODEX_HOME/rules/*.rules`, Starlark) that forbid `denyCommands`. */
export function codexDenyRules(denyCommands: readonly string[]): string {
  const why = "capcomd orchestrate mode: this agent sees everything and runs nothing that changes or runs code. Spawn a worker for it; checks run at capcomd verify and merge, `capcomd check` runs them on any branch, and their output is readable.";
  return denyCommands.map((c) => `prefix_rule(pattern = ${JSON.stringify(c.split(/\s+/))}, decision = "forbidden", justification = ${JSON.stringify(why)})`).join("\n") + "\n";
}
const CODEX_RULES = '"${CODEX_HOME:-$HOME/.codex}/rules"';

/**
 * Codex `codex exec --json` (JSONL: thread.started, turn.started, turn.completed{usage}, turn.failed,
 * item.started/updated/completed, error). Source: https://developers.openai.com/codex/noninteractive
 * and the `codex exec` flag table at https://learn.chatgpt.com/docs/developer-commands (checked 2026-10-19).
 * codex has no turn/budget flags, so the provider's guard enforces both: "turns" = tool steps
 * (command_execution/file_change/mcp_tool_call/web_search items), cost = tokens × configured rates.
 */
export const codex: AgentProvider = {
  describe: () => ({ ...DESCRIPTION, efforts: [...DESCRIPTION.efforts], loginEgress: [...DESCRIPTION.loginEgress], toolPolicies: { orchestrate: { allowed: [], disallowed: [], denyCommands: [...DESCRIPTION.toolPolicies.orchestrate.denyCommands] } } }),
  async available(input) {
    const { credentialReady } = await import("../agents/run-driver");
    const r = credentialReady("codex", input.auth);
    return r.ready ? { ok: true } : { ok: false, reason: r.reason ?? "no credential", fix: input.auth === "apikey" ? "Set OPENAI_API_KEY." : "Run `capcomd auth login codex`." };
  },
  classifyError: (e) => classifyAgentError(e, "Run `capcomd auth login codex`, or set OPENAI_API_KEY."),
  // codex exec reads CODEX_API_KEY for API-key auth in automation.
  credentialEnv: (v) => ({ CODEX_API_KEY: v, OPENAI_API_KEY: v }),
  // TZ=UTC: codex prints a usage limit's reset as local clock time (codexResetAt).
  baseEnv: () => ({ CI: "1", NO_COLOR: "1", TZ: "UTC" }),
  command: (ctx, q) =>
    // §16.1: the denied commands as codex's own rules, written where codex reads user rules before it starts.
    (ctx.cfg.denyCommands?.length ? `mkdir -p ${CODEX_RULES} && printf '%s' ${q(codexDenyRules(ctx.cfg.denyCommands))} > ${CODEX_RULES}/capcomd-orchestrate.rules && ` : "") +
    // allow_login_shell=false: codex runs its commands as `bash -c`, not `bash -lc`, whose /etc/profile (Debian's, in the
    // Docker env image) resets PATH, so the agent's own tools (node, bun, capcomd) were "command not found".
    `${q(ctx.bin)} exec --json --color never --ephemeral --sandbox ${ctx.cfg.sandbox ?? "danger-full-access"} -C ${q(ctx.repo)} -c allow_login_shell=false` +
    (ctx.cfg.model ? ` -m ${q(ctx.cfg.model)}` : "") +
    (ctx.cfg.effort ? ` -c ${q(`model_reasoning_effort="${ctx.cfg.effort}"`)}` : "") +
    // capcomd's tools are approved up front: `codex exec` asks for nothing (its approval policy is never), so a tool
    // that needs an approval is refused; what an agent may do with them is its capcomd token's limits.
    (ctx.capcomd ? ` -c ${q('mcp_servers.capcomd.command="node"')} -c ${q(`mcp_servers.capcomd.args=["${ctx.capcomd.cli}","mcp"]`)} -c ${q('mcp_servers.capcomd.default_tools_approval_mode="approve"')}` : "") +
    // The profile's MCP servers (ADR-024 `tools.mcp`), as TOML strings (JSON's quoting is TOML's); a trusted one's tools
    // approved up front like capcomd's, an untrusted one's left to codex's own approval rules.
    (ctx.mcp?.servers ?? []).map((s) => ` -c ${q(`mcp_servers.${s.name}.command=${JSON.stringify(s.command[0])}`)} -c ${q(`mcp_servers.${s.name}.args=${JSON.stringify(s.command.slice(1))}`)}` +
      (s.trust === "trusted" ? ` -c ${q(`mcp_servers.${s.name}.default_tools_approval_mode="approve"`)}` : "")).join("") +
    ` -o ${q(`${ctx.dir}/last-message.txt`)} "$(cat ${q(ctx.promptFile)})"` +
    ` > ${q(ctx.jsonl)} 2> ${q(ctx.errFile)} < /dev/null`,
  parse(line, redact, state, cfg) {
    const raw = parseJson(line, redact);
    if (!raw) return null;
    const type = String(raw.type ?? "unknown");
    const ev: AgentEvent = { type: type.replace(/\./g, "_"), raw };
    const item = raw.item;
    if (item && typeof item === "object") {
      ev.subtype = String(item.type ?? "");
      if (type === "item.completed" && CODEX_TOOL_ITEMS.has(item.type)) {
        state.turns++;
        ev.tool = item.type === "command_execution" ? `Bash(${String(item.command ?? "").slice(0, 80)})` : String(item.type);
        // codex reports a tool step once, done: it is both the call and its result (for the stuck watch).
        const call = item.type === "command_execution" ? toolCall("command", item.command) : item.type === "mcp_tool_call" ? toolCall(`${item.server}.${item.tool}`, item.arguments) : toolCall(item.type, item.changes ?? item.query);
        const failed = item.status === "failed" || (item.type === "command_execution" && Number(item.exit_code ?? 0) !== 0);
        const error = failed ? String(item.error?.message ?? item.aggregated_output ?? item.status ?? "failed").slice(-1000) : undefined;
        ev.calls = [call];
        ev.results = [{ call, ...(failed ? { error } : {}) }];
      }
      if (item.type === "agent_message" && typeof item.text === "string") { ev.text = item.text.slice(0, 500); if (type === "item.completed") state.resultText = item.text; }
    }
    const s = state as CodexRunState;
    if (type === "turn.completed") {
      const u = raw.usage ?? {};
      state.inputTokens += Number(u.input_tokens ?? 0);
      state.cacheReadTokens = (state.cacheReadTokens ?? 0) + Number(u.cached_input_tokens ?? 0);
      state.outputTokens += Number(u.output_tokens ?? 0) + Number(u.reasoning_output_tokens ?? 0);
      const rate = cfg.usdPerMtok ?? { in: 1.25, out: 10 };
      state.costUsd = (state.inputTokens * rate.in + state.outputTokens * rate.out) / 1e6;
      state.done = true;
      // codex exec ends a turn that hit a critical error with turn.failed, never turn.completed, so an `error` event
      // before a turn.completed was a stream error it retried and recovered from ("Reconnecting... 1/5 (stream
      // disconnected before completion)", "Reconnecting... waiting for network"): the run succeeded and keeps its work.
      if (s.errorFrom === "error") { delete state.error; delete state.quota; delete s.errorFrom; }
      if (s.errorFrom !== "turn.failed") state.stopReason = "success";
    }
    // A turn.failed is final: a later `error` event or turn.completed doesn't replace or clear it.
    if (type === "turn.failed" || (type === "error" && s.errorFrom !== "turn.failed")) {
      s.errorFrom = type;
      state.error = String(raw.error?.message ?? raw.message ?? type).slice(0, 300);
      // A usage limit isn't retried by codex (retryable errors read "Reconnecting…", "exceeded retry limit…").
      if (CODEX_USAGE_LIMIT.test(state.error.trim())) {
        const reset = codexResetAt(state.error);
        state.quota = { message: state.error, ...(reset ? { resetAt: reset } : {}) };
      }
      state.stopReason = type === "error" ? "error" : "turn_failed";
    }
    if (type === "turn.failed" || type === "error") ev.text = String(raw.error?.message ?? raw.message ?? type).slice(0, 300);
    return ev;
  },
  // ChatGPT-plan login: `codex login --device-auth` writes $CODEX_HOME/auth.json when
  // cli_auth_credentials_store = "file" (https://learn.chatgpt.com/docs/auth).
  subscriptionCheck: (home, q) => `[ -s ${q(`${home}/.codex/auth.json`)} ] && echo file; true`,
  subscriptionPrelude: (home, q) => `unset CODEX_API_KEY OPENAI_API_KEY; export CODEX_HOME=${q(`${home}/.codex`)}`,
  loginCommand: (bin) => [bin, "login", "--device-auth"],
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
  // codex 0.163 leaves a command its rules forbid out of `--json`; its log line on stderr is the only trace:
  //   … ERROR codex_core::tools::router: error=exec_command failed: CreateProcess { message: "Rejected(\"`/bin/bash -lc 'git push'` rejected: <why>\")" }
  refusal(line, redact) {
    const m = /Rejected\(\\?"`(.+?)` rejected: (.*?)\\?"\)/.exec(line);
    if (!m) return null;
    const shell = /^\/bin\/(?:ba)?sh -lc '(.*)'$/s.exec(m[1]!);
    const cmd = (shell ? shell[1]!.replace(/'\\''/g, "'") : m[1]!).replace(/\\"/g, '"');
    return { call: toolCall("command", redact(cmd)), reason: redact(m[2]!.replace(/\\"/g, '"')).slice(0, 500) };
  },
};

export const manifest = agentManifest("agent-codex", "codex", "Codex as an agent provider: runs codex exec headless in the agent's sandbox and reads its JSON events.");
export const plugin = definePlugin({ activate(ctx) { ctx.seams.agent(codex); } });
