// Built-in plugin agent-fx (docs/spec/plugin-api.md §7.3, §17.1): fx (https://fx.sh, Vercel Labs' coding agent CLI) as
// the `fx` agent seam. fx runs as `fx acp`, its Agent Client Protocol server, behind a small bridge (fx-bridge.mjs, run
// by node next to the agent) that speaks ACP to it and prints what happens as JSON lines: this provider's stream. The
// streams in tests/agents/fixtures/fx were recorded from fx 0.0.16 itself (a scripted model server, no real model).
import { definePlugin } from "../../packages/plugin/src/context";
import type { AgentEvent, AgentProvider, AgentRunState } from "../../packages/plugin/src/seams";
import { agentManifest, classifyAgentError, ORCHESTRATE_DENIED_COMMANDS, ORCHESTRATE_READ_COMMANDS, ORCHESTRATE_READ_EXACT, parseJson, toolCall } from "./agent-common";
// @ts-ignore: a text import of a JS file gives its source (Bun), which TypeScript would type as the module itself
import bridgeSource from "./fx-bridge.mjs" with { type: "text" };

/** Pinned version. fx is 0.0.x: any release may change its protocol, so capcomd runs exactly the one it was tested with. */
export const FX_VERSION = "0.0.16";

/** The pinned release archives (https://releases.fx.sh/<version>/<asset>, the same files as the GitHub release's), with
 *  their sha256 kept here: an archive is checked before it is unpacked, and one that doesn't match is never run. */
export const FX_RELEASE = {
  host: "releases.fx.sh",
  assets: {
    x86_64: { url: `https://releases.fx.sh/v${FX_VERSION}/fx-linux-x86_64.tar.gz`, sha256: "f0fb822c7be546c80bcc89d50521bc1454435e0c6f586e8420c4e2b84fa80599" },
    aarch64: { url: `https://releases.fx.sh/v${FX_VERSION}/fx-linux-aarch64.tar.gz`, sha256: "ca9441b104357e2105039dbfd4c2eaf0d6ee65a84085f23f51e880c95cbf46af" },
  },
} as const;

/** The bridge's source, written next to each run (`command`). */
export const FX_BRIDGE_SOURCE: string = bridgeSource;

/**
 * fx's own plan logins as capcomd makes them (`capcomd auth login fx [vercel|grok]`): fx's login runs in a PTY in a login
 * VM, as codex's does, and the VM is snapshotted with it; each login is one private file in `$FX_HOME` (0600), and fx
 * runs on the fx provider it signs in to. `egress`: what the login and the model calls on it reach. Vercel's is an OAuth
 * device flow against vercel.com (its session reaches the AI Gateway); Grok's a browser login whose code is pasted back.
 */
export const FX_LOGINS = [
  { name: "vercel", label: "Vercel", file: "auth.json", fxProvider: "gateway", egress: ["vercel.com", "api.vercel.com", "ai-gateway.vercel.sh"] },
  { name: "grok", label: "Grok", file: "grok-auth.json", fxProvider: "grok", egress: ["auth.x.ai", "accounts.x.ai", "cli-chat-proxy.grok.com", "api.x.ai"] },
] as const;
/** fx's ChatGPT login (`fx login codex`) is a browser login whose callback is the login VM's own localhost:1455, with no
 *  device code and no code to paste: capcomd doesn't forward a port from a login VM to this machine, so it isn't made. */
export const FX_CODEX_LOGIN_REFUSED = "fx's ChatGPT login (`fx login codex`) sends your browser back to localhost:1455 inside the login machine, which your browser can't reach, and has no code to paste, so capcomd can't make it. For a ChatGPT plan use capcomd's own codex provider: `capcomd auth login codex`, and profiles with provider: codex.";
const FX_LOGIN_HOSTS = [...new Set(FX_LOGINS.flatMap((l) => l.egress))];

/** USD per million tokens when the operator gives none (CAPCOMD_FX_USD_PER_MTOK_IN, _OUT): fx reports tokens, never cost,
 *  and the model behind the AI Gateway can be anyone's, so the estimate errs towards stopping early. */
export const FX_DEFAULT_USD_PER_MTOK = { in: 5, out: 25 } as const;

/** A turn that ended because the provider is out of credits or quota (fx's text for it, ADR-019 §6). */
const FX_QUOTA = /insufficient_quota|credit_card_required|usage_limit_reached|out of credits|exceeded your current quota|HTTP 402\b/i;
/** A turn that ended on the credential: fx's own words for it (`<source> authentication failed · HTTP 401`, a refresh
 *  that failed, a key the Gateway refused, no credential at all). */
const FX_AUTH = /authentication failed|credential refresh failed|API access denied|fx needs access to Vercel AI Gateway|HTTP 401\b|HTTP 403\b/i;
/** fx's step limit (FX_MAX_AGENT_STEPS, set from the profile's maxTurns) ends a turn with this notice. */
const FX_STEP_LIMIT = /^Agent step limit reached/;

/**
 * §16.1 as fx permission rules ($HOME/.fx/settings.json `permission`; the last matching rule wins): reads, searches and
 * capcomd's own tools allowed; the read-only commands allowed (an allow rule matches only a command with no chaining or
 * substitution); edits, fx's own subagents and `denyCommands` denied (a deny rule matches inside a chained command too);
 * the options of allowed git commands that run a command or write a file denied; everything else asked, and every ask
 * refused by the bridge. fx runs with `--permission-mode ask` for it (FX_PERMISSION_MODE): full access skips every rule.
 */
export function fxOrchestrateRules(denyCommands: readonly string[]): Record<string, unknown> {
  const bash: Record<string, string> = { "*": "ask" };
  for (const c of ORCHESTRATE_READ_COMMANDS) { bash[c] = "allow"; bash[`${c} *`] = "allow"; }
  for (const c of ORCHESTRATE_READ_EXACT) bash[c] = "allow";
  for (const c of denyCommands) { bash[c] = "deny"; bash[`${c} *`] = "deny"; }
  for (const c of ["git fetch *--upload-pack*", "git grep *-O*", "git grep *--open-files-in-pager*", "git * --output*", "git *--output=*"]) bash[c] = "deny";
  return {
    "*": "ask",
    read: "allow", glob: "allow", grep: "allow", skill: "allow", read_tool_result: "allow", capability_search: "allow", mcp_select_tool: "allow",
    "mcp_capcomd_*": "allow",
    edit: "deny", subagent: "deny", install_skill: "deny",
    bash,
  };
}

/** What this provider keeps on the run's state between lines. */
type FxState = AgentRunState & {
  /** Each tool call id's call ("name input") and whether fx marked it its own bookkeeping (not a turn). */
  fxCalls?: Record<string, { call: string; internal: boolean; command: boolean }>;
  /** The stop reason the last turn ended with, and its last message (fx's reason, when it failed). */
  fxStop?: string;
  /** Set by an error the next turn's success doesn't clear (a quota, a bridge failure). */
  fxFinal?: boolean;
};

const DESCRIPTION = {
  name: "fx", label: "fx", bin: "fx", pinnedVersion: FX_VERSION,
  install: { kind: "archive" as const, member: "fx", assets: FX_RELEASE.assets },
  secretName: "AI_GATEWAY_API_KEY", apiHost: "ai-gateway.vercel.sh",
  // FX_EFFORT; fx checks the level against the model's own and refuses one it lacks when the agent starts.
  efforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"], defaultEffort: null,
  // The bridge takes messages on stdin while fx works: a steering prompt at fx's next model call, else the next turn.
  streamInput: true,
  // A plan login is one of fx's own (FX_LOGINS), snapshotted like codex's; an AI Gateway key otherwise.
  loginEgress: FX_LOGIN_HOSTS,
  logins: [...FX_LOGINS.map((l) => ({ name: l.name, label: l.label, egress: [...l.egress] })), { name: "codex", label: "ChatGPT", egress: [] as string[], refused: FX_CODEX_LOGIN_REFUSED }],
  // §16.1: fx's own permission rules hold an orchestrate agent (fxOrchestrateRules): only the read tools and the
  // read-only commands are allowed, denyCommands are denied, and anything else fx would ask about is refused. Whatever
  // it writes anyway never lands: the kernel never commits or pushes its checkout, and reports what it discarded.
  toolPolicies: { orchestrate: { allowed: [] as string[], disallowed: [] as string[], denyCommands: ORCHESTRATE_DENIED_COMMANDS } },
};

/** Reads `fx status --json` on stdin and prints only whether fx has a credential: `{"loggedIn": <boolean>}`. */
const FX_STATUS_BOOLEAN = `let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>{let a=null;for(const t of [s,s.trim().split("\\n").pop()]){try{a=JSON.parse(t).auth;break}catch{}}console.log(JSON.stringify({loggedIn:typeof a==="string"&&a!==""&&a!=="missing"}))})`;

const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export const fx: AgentProvider = {
  describe: () => ({
    ...DESCRIPTION, install: { ...DESCRIPTION.install, assets: { ...DESCRIPTION.install.assets } }, efforts: [...DESCRIPTION.efforts], loginEgress: [...DESCRIPTION.loginEgress],
    logins: DESCRIPTION.logins.map((l) => ({ ...l, egress: [...l.egress] })),
    toolPolicies: { orchestrate: { allowed: [], disallowed: [], denyCommands: [...DESCRIPTION.toolPolicies.orchestrate.denyCommands] } },
  }),
  async available(input) {
    const { credentialReady } = await import("../agents/run-driver");
    const r = credentialReady("fx", input.auth);
    return r.ready ? { ok: true } : { ok: false, reason: r.reason ?? "no credential", fix: input.auth === "subscription" ? "Run `capcomd auth login fx` (a Vercel login), or `capcomd auth login fx grok` (a Grok plan)." : "Set AI_GATEWAY_API_KEY (an AI Gateway API key: https://vercel.com/docs/ai-gateway)." };
  },
  classifyError: (e) => classifyAgentError(e, "Set AI_GATEWAY_API_KEY (an AI Gateway API key), or `capcomd secrets sync` it; on a plan login, run `capcomd auth login fx` again."),
  credentialEnv: (v) => ({ AI_GATEWAY_API_KEY: v }),
  baseEnv: () => ({ CI: "1", NO_COLOR: "1", FX_AUTO_UPGRADE: "0", FX_NO_OPEN_BROWSER: "1" }),
  command(ctx, q) {
    const policy = !!ctx.cfg.denyCommands?.length;
    // capcomd's own server, and the profile's trusted ones: fx runs with full access, so an untrusted server's tools
    // would run unasked. They aren't started (the agent's log says which); an orchestrate agent starts none of them.
    const servers = [...(ctx.capcomd ? ["capcomd"] : []), ...(ctx.mcp?.servers ?? []).filter((s) => s.trust === "trusted" && !policy).map((s) => s.name)];
    const untrusted = (ctx.mcp?.servers ?? []).filter((s) => s.trust !== "trusted").map((s) => s.name);
    const workdir = ctx.dir.replace(/\/[^/]*$/, "");
    const config = {
      bin: ctx.bin, cwd: ctx.repo, prompt: ctx.promptFile, stdin: !!ctx.stdinPrompt,
      ...(ctx.mcp || ctx.capcomd ? { mcpConfig: ctx.mcp?.config ?? ctx.capcomd!.mcpConfig, mcpServers: servers } : {}),
      ...(untrusted.length ? { untrustedMcp: untrusted } : {}),
      ...(ctx.cfg.model ? { model: ctx.cfg.model } : {}), ...(ctx.cfg.effort ? { effort: ctx.cfg.effort } : {}),
      // On a plan login, the fx provider it signed in to (the prelude's CAPCOMD_FX_PROVIDER); else the AI Gateway's.
      ...(ctx.cfg.credentialMode === "subscription" ? {} : { provider: "gateway" }),
      permission: policy ? { mode: "ask", rules: fxOrchestrateRules(ctx.cfg.denyCommands!) } : { mode: "full-access" },
      logFile: `${ctx.dir}/fx-acp.log`,
      // The context bundles its brief cites (ADR-025 §6.2) are beside the checkout, outside fx's workspace.
      addDirs: [`${workdir}/context`],
      ...(ctx.cfg.maxTurns ? { maxSteps: ctx.cfg.maxTurns } : {}),
    };
    const bridge = `${ctx.dir}/fx-bridge.mjs`, file = `${ctx.dir}/fx-bridge.json`;
    // One program the runner's `timeout` wraps: the shell that writes the bridge and its config, then becomes node.
    const inner = `printf '%s' ${sh(FX_BRIDGE_SOURCE)} > ${sh(bridge)} && printf '%s' ${sh(JSON.stringify(config))} > ${sh(file)} && exec node ${sh(bridge)} ${sh(file)}`;
    return `sh -c ${q(inner)} > ${q(ctx.jsonl)} 2> ${q(ctx.errFile)}${ctx.stdinPrompt ? "" : " < /dev/null"}`;
  },
  parse(line, redact, run, cfg) {
    const state = run as FxState;
    const raw = parseJson(line, redact);
    if (!raw || typeof raw.type !== "string") return null;
    const ev: AgentEvent = { type: raw.type, raw };
    const calls = (state.fxCalls ??= {});
    switch (raw.type) {
      case "init":
        ev.subtype = "init";
        if (cfg.model) state.model = cfg.model;
        break;
      case "session":
        if (typeof raw.model === "string" && raw.model) state.model = raw.model;
        break;
      case "message":
        if (raw.role === "thought") { ev.type = "thinking"; break; }
        if (typeof raw.text === "string" && raw.text.trim()) ev.text = raw.text.slice(0, 500);
        break;
      case "notice":
        if (typeof raw.text === "string") ev.text = raw.text.slice(0, 500);
        break;
      case "update": {
        const u = raw.update ?? {};
        ev.subtype = String(u.sessionUpdate ?? "");
        if (u.sessionUpdate === "tool_call" && u.toolCallId) {
          const id = String(u.toolCallId);
          const input = u.rawInput ?? {};
          const command = u.kind === "execute" && typeof input.command === "string";
          const mcp = u._meta?.fx?.toolCall?.mcp;
          const call = command ? toolCall("command", input.command) : mcp ? toolCall(`${mcp.server}.${mcp.tool}`, input) : toolCall(u.name ?? u.kind ?? "tool", input);
          calls[id] = { call, internal: u._meta?.fx?.toolCall?.internal === true, command };
          ev.tool = command ? `Bash(${String(input.command).slice(0, 80)})` : String(u.name ?? u.kind ?? "tool");
          ev.calls = [call];
          // A command it runs is waited on from its start to its end (plugin API §16.4).
          if (command && input.action !== "interact" && input.action !== "stop") ev.commands = { started: [id] };
        } else if (u.sessionUpdate === "tool_call_update" && (u.status === "completed" || u.status === "failed") && u.toolCallId) {
          const id = String(u.toolCallId);
          const c = calls[id];
          const exit = u.command_result?.exit_code;
          const failed = u.status === "failed" || (exit !== undefined && exit !== null && Number(exit) !== 0);
          const text = Array.isArray(u.content) ? u.content.map((x: any) => (typeof x?.content?.text === "string" ? x.content.text : "")).join("\n") : "";
          if (c) {
            ev.results = [{ call: c.call, ...(failed ? { error: (text || `exit ${exit ?? u.status}`).slice(-1000) } : {}) }];
            if (!c.internal) state.turns++;
          }
          ev.commands = { ended: [id] };
          delete calls[id];
        } else if (u.sessionUpdate === "session_info_update" && u._meta?.fx?.modelResponseRecovery) {
          // fx retrying the model (a rate limit, a dropped connection): a notice, not an error.
          const m = u._meta.fx.modelResponseRecovery.message;
          if (typeof m === "string" && m) ev.text = m.slice(0, 300);
        }
        break;
      }
      case "permission":
        // The refusal shows as the call's failed result (tool_permission_denied), which follows.
        ev.subtype = String(raw.decision ?? "");
        break;
      case "steer":
        ev.subtype = String(raw.delivery ?? "");
        break;
      case "quota":
        state.quota = { message: String(raw.message ?? "usage limit").slice(0, 300) };
        state.error = state.quota.message;
        state.stopReason = "quota";
        state.fxFinal = true;
        ev.text = state.quota.message;
        break;
      case "error":
        state.error = `${raw.where ? `${raw.where}: ` : ""}${String(raw.message ?? "error")}`.slice(0, 300);
        state.stopReason = FX_AUTH.test(String(raw.message ?? "")) ? "auth" : "error";
        state.fxFinal = true;
        ev.text = state.error;
        break;
      case "result": {
        const u = raw.usage ?? {};
        const n = (k: string, alt?: string) => Number(u[k] ?? (alt ? u[alt] : 0) ?? 0) || 0;
        const read = n("cacheReadTokens", "cachedReadTokens"), write = n("cacheWriteTokens", "cachedWriteTokens");
        const input = n("inputTokens") + read + write, output = n("outputTokens") + n("reasoningTokens", "thoughtTokens");
        state.inputTokens += input;
        state.cacheReadTokens = (state.cacheReadTokens ?? 0) + read;
        state.outputTokens += output;
        const rate = cfg.usdPerMtok ?? FX_DEFAULT_USD_PER_MTOK;
        // A cache read costs a tenth of an input token, as most providers bill it.
        state.costUsd += ((input - read) * rate.in + read * rate.in * 0.1 + output * rate.out) / 1e6;
        const stop = String(raw.stopReason ?? "unknown"), last = typeof raw.lastText === "string" ? raw.lastText : "";
        state.done = true;
        state.fxStop = stop;
        if (last.trim()) state.resultText = last;
        if (stop === "end_turn") {
          // A later turn that ends well (the agent answered a message) clears what an earlier turn's failure set.
          if (!state.fxFinal) { delete state.error; state.stopReason = "success"; }
        } else if (stop !== "cancelled" || !state.quota) {
          // fx's reason is the turn's last message (an operational one: auth, credits, the step limit); a cancelled
          // turn's last message is only what the agent last said.
          const why = (stop === "cancelled" ? "the turn was cancelled" : last.trim() || `turn ended: ${stop}`).slice(0, 300);
          state.error = why;
          state.stopReason = FX_STEP_LIMIT.test(last) ? "max_turns" : FX_AUTH.test(last) ? "auth" : stop === "refused" ? "refusal" : stop === "max_output_tokens" ? "max_tokens" : stop;
          if (FX_QUOTA.test(last)) { state.quota = { message: why }; state.stopReason = "quota"; state.fxFinal = true; }
        }
        ev.subtype = stop;
        if (last.trim()) ev.text = last.slice(0, 500);
        break;
      }
      default:
        break;
    }
    return ev;
  },
  // A plan login (FX_LOGINS) is its file in $FX_HOME (fx's ~/.fx); the prelude drops the keys fx would prefer to it and
  // names the fx provider it signed in to (CAPCOMD_FX_PROVIDER, which the bridge runs fx on).
  subscriptionCheck: (home, q) => FX_LOGINS.map((l) => `[ -s ${q(`${home}/.fx/${l.file}`)} ] && echo file`).join("; ") + "; true",
  subscriptionPrelude: (home, q) => `unset AI_GATEWAY_API_KEY VERCEL_OIDC_TOKEN; export FX_HOME=${q(`${home}/.fx`)}; ` +
    FX_LOGINS.map((l, i) => `${i ? "elif" : "if"} [ -s "$FX_HOME/${l.file}" ]; then export CAPCOMD_FX_PROVIDER=${l.fxProvider}`).join("; ") + "; fi",
  loginCommand(bin, login = FX_LOGINS[0].name) {
    if (!FX_LOGINS.some((l) => l.name === login)) throw new Error(login === "codex" ? FX_CODEX_LOGIN_REFUSED : `fx has no login ${JSON.stringify(login)} capcomd can make (${FX_LOGINS.map((l) => l.name).join(" or ")})`);
    // FX_NO_OPEN_BROWSER: fx prints the URL (and Vercel's device code) for the user's own browser.
    return ["env", "FX_NO_OPEN_BROWSER=1", "FX_AUTO_UPGRADE=0", bin, "login", login];
  },
  verifyCommand: (bin, q) => `FX_AUTO_UPGRADE=0 FX_PROVIDER="\${CAPCOMD_FX_PROVIDER:-gateway}" ${q(bin)} ask --json --no-save --full-access 'Reply with exactly the word ok' < /dev/null | grep -q '"exit_code":0' && echo ok`,
  // fx's own word on the login (`fx status --json` auth: "fx login", or "missing"); only the boolean is printed.
  loginCheck: (bin, q) => `FX_AUTO_UPGRADE=0 FX_PROVIDER="\${CAPCOMD_FX_PROVIDER:-gateway}" ${q(bin)} status --json 2>/dev/null < /dev/null | node -e ${q(FX_STATUS_BOOLEAN)}`,
  guard(state, cfg) {
    if (cfg.maxTurns && state.turns > cfg.maxTurns) return `max_turns (${state.turns} > ${cfg.maxTurns} tool steps)`;
    // fx reports tokens only when a turn ends, so a budget stops the agent at a turn's end.
    if (cfg.maxBudgetUsd && cfg.credentialMode !== "subscription" && state.costUsd > cfg.maxBudgetUsd) return `max_budget_usd (~$${state.costUsd.toFixed(3)} > $${cfg.maxBudgetUsd})`;
    return null;
  },
  outcome(state, exitCode) {
    if (exitCode === 124) return { ok: false, stopReason: "timeout" };
    if (exitCode !== 0 || state.error || !state.done) return { ok: false, stopReason: state.stopReason ?? `exit_${exitCode}` };
    return { ok: true, stopReason: "success" };
  },
};

export const manifest = agentManifest("agent-fx", "fx", "fx (Vercel Labs' coding agent) as an agent provider: runs fx acp headless in the agent's sandbox, through a bridge that prints its ACP session as JSON lines.");
export const plugin = definePlugin({ activate(ctx) { ctx.seams.agent(fx); } });
