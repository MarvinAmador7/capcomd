// Generic headless-agent runner: clone → detect/install CLI → resolve credential (boxd host-bound
// secret placeholder preferred, env injection fallback) → run in background → stream + guard →
// commit with capcomd trailers → push. Agent specifics live in adapters.ts. ADR-014, ADR-015.
import type { SandboxProvider, VmId, ExecResult } from "../providers/sandbox";
import type { AgentConfig } from "./config";
import type { AgentAdapter, AgentEvent, AgentRunState } from "./types";
import { Redactor } from "./redact";
import { taskKey } from "../merge/config";
import { addSpanEvent, agentSpanId, setSpanAttributes, withSpan } from "../utils/tracing-simple";

export interface AgentTask {
  /** ADR-017 / TUI contract: scope agent id and its parent (null at root), stamped on agent.* spans. */
  agentId?: string;
  parentAgentId?: string | null;
  runId: string;
  taskId: string;
  epoch: number;
  branch: string;
  target: string;
  /** Clone URL (token-free). Credentials come from the provider's git credential hook. */
  repoUrl: string;
  goal: string;
  rework?: boolean;
  conflictFiles?: string[];
  /** verify's reviewer: check out this commit, review it, never commit or push (goal = the review brief). */
  review?: { sha: string; branch: string; target: string };
  /** Report mode: read-only work on the target (research, triage); the final message is the result, nothing is pushed. */
  report?: boolean;
}

export interface AgentResult {
  sha: string;
  already: boolean;
  costUsd: number;
  turns: number;
  stopReason: string;
  events: number;
  /** How the API credential reached the agent: boxd host-bound secret placeholder, or env injection. */
  credentialMode?: "secret" | "env" | "subscription";
  /** "subscription": costUsd is 0 and notionalCostUsd holds what the CLI estimated. */
  billing?: "api" | "subscription";
  notionalCostUsd?: number;
  agentVersion?: string;
  /** The agent's final message (a reviewer's verdict comes from it). */
  resultText?: string;
  /** Stopped at a limit (timeout, max_turns, max_budget_usd): `sha` holds the work so far, with a Capcomd-Stop trailer. */
  limit?: string;
}

export interface AgentRunOptions {
  /** Real API key for env-injection fallback. Unused when the VM carries a bxds_ placeholder. */
  apiKey?: string;
  isCancelled?: () => Promise<boolean>;
  onEvent?: (e: AgentEvent) => void;
  secrets?: string[];
  now?: () => number;
  /** ADR-017: install in-VM capcomd (CLI + MCP + skill). Only set for agents allowed to spawn. */
  subagents?: { skill: string; cliSource: string; rpcDir: string };
}

export class AgentError extends Error {
  constructor(readonly kind: "cancelled" | "failed" | "no_changes" | "install" | "git" | "credentials" | "limit", message: string) {
    super(message);
    this.name = "AgentError";
  }
}

/** The CLI's own stop reasons that mean "out of budget", not "broken" (claude result subtypes; `timeout` exit 124). */
const LIMIT_STOPS: Record<string, string> = { timeout: "timeout", error_max_turns: "max_turns", error_max_budget_usd: "max_budget_usd" };

export const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
export const SECRET_PLACEHOLDER_PREFIX = "bxds_";

export function buildPrompt(t: AgentTask): string {
  const lines = [
    `You are working in a git checkout of the repository on branch ${t.branch} (based on ${t.target}).`,
    `Task: ${t.goal}`,
    "",
    "Rules:",
    "- Make the smallest change that completes the task. Run the project's tests to confirm.",
    "- Do not commit, push, or change git remotes; capcomd commits and pushes your working tree.",
    "- Do not print environment variables or credentials.",
  ];
  if (t.conflictFiles?.length) lines.push(`- A previous attempt conflicted with ${t.target} in: ${t.conflictFiles.join(", ")}. Re-apply the change on top of the current ${t.target}.`);
  return lines.join("\n");
}

/** A reviewer works on a detached checkout of the commit under review and only reports a verdict. */
export function buildReviewPrompt(t: AgentTask & { review: NonNullable<AgentTask["review"]> }): string {
  const { sha, branch, target } = t.review;
  return [
    `You are reviewing a change. The repository is checked out at commit ${sha} (branch ${branch}), based on ${target}.`,
    `See the change with \`git diff origin/${target}...HEAD\` and read the code around it. Run the project's tests if that helps you judge.`,
    "",
    t.goal,
    "",
    "Rules:",
    "- Do not edit files, commit, push, or change git remotes. Nothing you change is kept.",
    "- Do not print environment variables or credentials.",
    "- Judge only against the acceptance criteria and the task above; don't fail it for unrelated style.",
    '- End your reply with one line of JSON and nothing after it: {"passed": true|false, "reasons": ["..."]}',
    "  Give concrete reasons either way; on a fail, say what must change.",
  ].join("\n");
}

/** A reporting agent reads the repository and answers; its final message is returned to whoever asked. */
export function buildReportPrompt(t: AgentTask): string {
  return [
    `You are working in a read-only git checkout of the repository at ${t.target}.`,
    `Task: ${t.goal}`,
    "",
    "Rules:",
    "- Do not edit files, commit, push, or change git remotes. Nothing you change is kept.",
    "- Do not print environment variables or credentials.",
    "- Your final message is your report: it is returned to whoever asked. Make it complete and specific (file paths, line numbers, commands); keep it under about 8KB.",
  ].join("\n");
}

export const agentHome = (cfg: AgentConfig) => `${cfg.workdir}/home`;
export const templateDir = (cfg: AgentConfig) => `${cfg.workdir}/template`;
export const agentPath = (home: string) => `${home}/node/bin:${home}/npm/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;

/** Prints `bin=<path>` / `version=<v>` / `node=<v>` for whatever is already installed. */
export function detectScript(a: AgentAdapter): string {
  return `b=$(command -v ${a.bin} 2>/dev/null) && echo "bin=$b" && echo "version=$("$b" --version 2>/dev/null | head -1)"; n=$(command -v node 2>/dev/null) && echo "node=$("$n" -v 2>/dev/null)"; true`;
}
export interface Detected { bin?: string; version?: string; node?: string }
export function parseDetect(out: string): Detected {
  const d: Detected = {};
  for (const line of out.split("\n")) {
    const m = /^(bin|version|node)=(.*)$/.exec(line.trim());
    if (m && m[2]) (d as any)[m[1]!] = m[2].trim();
  }
  if (d.version) d.version = /\d+\.\d+\.\d+[\w.\-]*/.exec(d.version)?.[0] ?? d.version;
  return d;
}

/** Installs pinned Node (only if no node ≥ 18 is present) and the pinned agent CLI into home/npm. */
export function installScript(cfg: AgentConfig, home: string, a: AgentAdapter): string {
  const v = cfg.nodeVersion;
  const pin = a.pinnedVersion(cfg);
  return `set -e
mkdir -p ${sq(home)} && cd ${sq(home)}
NODE=$(command -v node || true)
if [ -n "$NODE" ] && [ "$("$NODE" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge 18 ]; then NPM=$(dirname "$NODE")/npm; else
  if [ ! -x node/bin/node ] || [ "$(node/bin/node -v)" != "v${v}" ]; then
    case "$(uname -m)" in x86_64) arch=x64;; aarch64|arm64) arch=arm64;; *) echo "unsupported arch $(uname -m)" >&2; exit 1;; esac
    rm -rf node node.tgz
    curl -fsSL "https://nodejs.org/dist/v${v}/node-v${v}-linux-$arch.tar.gz" -o node.tgz
    mkdir node && tar -xzf node.tgz -C node --strip-components=1 && rm node.tgz
  fi
  NPM=${home}/node/bin/npm
fi
if [ "$(npm/bin/${a.bin} --version 2>/dev/null | grep -oE '[0-9]+\\.[0-9]+\\.[0-9]+' | head -1)" != "${pin}" ]; then
  "$NPM" install -g --prefix "${home}/npm" --no-fund --no-audit "${a.npmPackage}@${pin}"
fi
npm/bin/${a.bin} --version`;
}

export async function runAgent(adapter: AgentAdapter, provider: SandboxProvider, vmId: VmId, task: AgentTask, cfg: AgentConfig, opts: AgentRunOptions): Promise<AgentResult> {
  const r = new Redactor([opts.apiKey, ...(opts.secrets ?? [])]);
  const now = opts.now ?? Date.now;
  const W = `${cfg.workdir}/${task.taskId}-e${task.epoch}`;
  const repo = `${W}/repo`;
  const home = agentHome(cfg);
  const baseEnv = { PATH: agentPath(home), HOME: home };
  const name = adapter.kind;

  const sh = async (script: string, env: Record<string, string> = {}, timeoutMs = 120_000): Promise<ExecResult> =>
    provider.exec(vmId, ["sh", "-c", script], { env: { ...baseEnv, ...env }, timeoutMs });
  const git = async (args: string[], cwd?: string, timeoutMs = 120_000): Promise<ExecResult> => {
    const res = await provider.exec(vmId, ["git", ...args], { env: { ...baseEnv }, timeoutMs, ...(cwd ? { cwd } : {}) });
    return { code: res.code, stdout: r.text(res.stdout), stderr: r.text(res.stderr) };
  };
  const must = (res: ExecResult, what: string, kind: AgentError["kind"] = "git") => {
    if (res.code !== 0) throw new AgentError(kind, `${what} failed (exit ${res.code}): ${r.text(res.stderr || res.stdout).slice(-800)}`);
    return res;
  };
  const key = taskKey(task.runId, task.taskId);
  const attrs = {
    "agent.kind": name, "agent.profile": cfg.profile ?? "", "relay.run_id": task.runId, "relay.task_id": task.taskId, "relay.epoch": task.epoch,
    ...(task.agentId ? { "relay.agent_id": task.agentId, "relay.parent_agent_id": task.parentAgentId ?? null } : {}),
    "git.branch": task.branch, "agent.max_turns": cfg.maxTurns, "agent.max_budget_usd": cfg.maxBudgetUsd,
  };

  let live: AgentRunState | null = null; // for cost/turns on failed or timed-out spans (TUI contract)
  return withSpan(`agent.${name.replace("-", "_")}`, attrs, async (span) => { try {
    must(await sh(`mkdir -p ${sq(W)} ${sq(home)}`), "mkdir");

    // 1. Clone.
    const existing = await git(["ls-remote", "--heads", task.repoUrl, `refs/heads/${task.branch}`]);
    must(existing, "git ls-remote");
    const branchExists = existing.stdout.trim().length > 0;
    must(await sh(`rm -rf ${sq(repo)}`), "clean");
    must(await git(["clone", "--no-tags", "--branch", task.target, task.repoUrl, repo], undefined, 300_000), "git clone");
    if (branchExists) must(await git(["fetch", "origin", `+refs/heads/${task.branch}:refs/remotes/origin/${task.branch}`], repo), "git fetch branch");

    if (task.review) {
      must(await git(["checkout", "-q", "--detach", task.review.sha], repo), "git checkout (review)");
    } else if (branchExists && !task.rework && !task.report) {
      const head = await git(["log", "-1", "--format=%H%x00%(trailers:key=Capcomd-Task,valueonly,separator=)%x00%(trailers:key=Capcomd-Epoch,valueonly,separator=)%x00%(trailers:key=Capcomd-Stop,valueonly,separator=)", `origin/${task.branch}`], repo);
      const [sha, k, ep, stop] = head.stdout.trim().split("\0");
      if (head.code === 0 && k?.trim() === key && Number(ep) === task.epoch && sha) {
        addSpanEvent(span, "agent.reused_push", { sha });
        setSpanAttributes(span, { "git.sha": sha, "agent.already": true });
        // A push that stopped at a limit is still a stop when it is replayed, not a finished task.
        return { sha, already: true, costUsd: 0, turns: 0, stopReason: "already_pushed", events: 0, ...(stop?.trim() ? { limit: stop.trim() } : {}) };
      }
    }
    if (!task.review) must(await git(["checkout", "-B", task.branch, branchExists && !task.rework ? `origin/${task.branch}` : `origin/${task.target}`], repo), "git checkout");

    // Reuse dependencies baked into the env snapshot when the lockfile matches (capcomd env build).
    const T = templateDir(cfg);
    const deps = await sh(`L=; for f in bun.lock bun.lockb package-lock.json pnpm-lock.yaml yarn.lock; do [ -f ${sq(repo)}/$f ] && { L=$(sha256sum ${sq(repo)}/$f | cut -c1-64); break; }; done
if [ -n "$L" ] && [ -d ${sq(T)}/node_modules ] && [ "$(cat ${sq(T)}/.capcomd-lockhash 2>/dev/null)" = "$L" ] && [ ! -e ${sq(repo)}/node_modules ]; then
  cp -a ${sq(T)}/node_modules ${sq(repo)}/node_modules && echo node_modules >> ${sq(repo)}/.git/info/exclude && echo reused; fi; true`);
    const depsReused = deps.stdout.includes("reused");
    if (depsReused) addSpanEvent(span, "agent.deps_reused", {});

    // 2. Detect the CLI (image or snapshot may already have it); install the pin only if absent.
    let bin = adapter.kind === "claude-code" ? (cfg.agentBin ?? cfg.claudeBin) : cfg.agentBin;
    let version = adapter.pinnedVersion(cfg);
    if (!bin) {
      const det = parseDetect((await sh(detectScript(adapter))).stdout);
      if (det.bin) { bin = det.bin; version = det.version ?? "unknown"; addSpanEvent(span, "agent.detected", { "agent.bin": det.bin, "agent.version": version }); }
      else {
        const install = await withSpan("agent.install", { "agent.version": adapter.pinnedVersion(cfg), "agent.node_version": cfg.nodeVersion }, async () =>
          sh(installScript(cfg, home, adapter), {}, 600_000));
        must(install, `${name} install`, "install");
        bin = `${home}/npm/bin/${adapter.bin}`;
        version = adapter.pinnedVersion(cfg);
      }
    }
    setSpanAttributes(span, { "agent.version": version, "agent.deps_reused": depsReused });

    // 3. Credential: a boxd host-bound secret shows up as a bxds_ placeholder (the real key is substituted
    //    only on egress to the API host). Fall back to injecting the key into the start exec's env.
    let credential: string | undefined;
    let credentialMode: "secret" | "env" | "subscription" = "env";
    let prelude = "";
    if (cfg.credentialMode === "subscription") {
      const chk = (await sh(adapter.subscriptionCheck(home, sq))).stdout;
      if (!/secret|file/.test(chk)) throw new AgentError("credentials", `no ${name} subscription login in this VM; run \`capcomd auth login ${name === "claude-code" ? "claude" : "codex"}\``);
      credentialMode = "subscription";
      prelude = adapter.subscriptionPrelude(home, sq);
    } else {
      if (cfg.credentialMode !== "env") {
        const pe = await sh(`printenv ${adapter.secretName} 2>/dev/null; true`);
        const v = pe.stdout.trim();
        if (v.startsWith(SECRET_PLACEHOLDER_PREFIX)) { credential = v; credentialMode = "secret"; }
      }
      if (!credential) {
        if (cfg.credentialMode === "secret") throw new AgentError("credentials", `CAPCOMD_CREDENTIALS=secret but the VM has no ${adapter.secretName} placeholder; run \`capcomd secrets sync\``);
        if (!opts.apiKey) throw new AgentError("credentials", `no ${adapter.secretName}: run \`capcomd auth login\`, set the key locally, or \`capcomd secrets sync\``);
        credential = opts.apiKey;
      }
    }
    setSpanAttributes(span, { "agent.credential_mode": credentialMode });

    // 4. Run headless in the background; the JSON event stream lands in a file we tail.
    // Profile prompts: claude takes flags; codex has none, so they wrap the prompt text.
    let promptText = task.review ? buildReviewPrompt(task as AgentTask & { review: NonNullable<AgentTask["review"]> }) : task.report ? buildReportPrompt(task) : buildPrompt(task);
    let systemFile: string | undefined, appendSystemFile: string | undefined;
    if (adapter.kind === "claude-code") {
      if (cfg.systemPrompt) { systemFile = `${W}/system.txt`; await provider.upload(vmId, systemFile, new TextEncoder().encode(r.text(cfg.systemPrompt))); }
      if (cfg.appendSystemPrompt) { appendSystemFile = `${W}/append-system.txt`; await provider.upload(vmId, appendSystemFile, new TextEncoder().encode(r.text(cfg.appendSystemPrompt))); }
    } else {
      promptText = [cfg.systemPrompt, promptText, cfg.appendSystemPrompt].filter(Boolean).join("\n\n");
    }
    // ADR-017: agents allowed to spawn get capcomd (CLI on PATH + MCP server) and the skill.
    let capcomdCtx: { cli: string; mcpConfig: string } | undefined;
    let capcomdPrelude = "";
    if (opts.subagents) {
      const sa = opts.subagents;
      const cli = `${sa.rpcDir}/bin/capcomd`;
      const src = sa.cliSource.replace(/^#!.*\n/, `#!/usr/bin/env node\nprocess.env.CAPCOMD_RPC_DIR ||= ${JSON.stringify(sa.rpcDir)};\n`);
      // boxd's file upload does not create parent dirs (fakes did, hiding this): make them first.
      must(await sh(`mkdir -p ${sq(`${sa.rpcDir}/bin`)} && chmod 700 ${sq(sa.rpcDir)}`), "mkdir capcomd rpc dir", "install");
      await provider.upload(vmId, cli, new TextEncoder().encode(src));
      const mcpConfig = `${W}/capcomd-mcp.json`;
      await provider.upload(vmId, mcpConfig, new TextEncoder().encode(JSON.stringify({ mcpServers: { capcomd: { command: "node", args: [cli, "mcp"], env: { CAPCOMD_RPC_DIR: sa.rpcDir } } } })));
      must(await sh(`chmod 755 ${sq(cli)}`), "install capcomd", "install");
      capcomdCtx = { cli, mcpConfig };
      capcomdPrelude = `export PATH=${sq(`${sa.rpcDir}/bin`)}:"$PATH" CAPCOMD_RPC_DIR=${sq(sa.rpcDir)}`;
      if (adapter.kind === "claude-code") {
        cfg = { ...cfg, allowedTools: [...cfg.allowedTools, "Bash(capcomd:*)", "mcp__capcomd"] };
        appendSystemFile = `${W}/append-system.txt`;
        await provider.upload(vmId, appendSystemFile, new TextEncoder().encode([cfg.appendSystemPrompt ? r.text(cfg.appendSystemPrompt) : "", sa.skill].filter(Boolean).join("\n\n")));
      } else promptText = [promptText, sa.skill].join("\n\n");
    }
    await provider.upload(vmId, `${W}/prompt.txt`, new TextEncoder().encode(r.text(promptText)));
    const jsonl = `${W}/agent.jsonl`, errFile = `${W}/agent.err`, exitFile = `${W}/agent.exit`, pidFile = `${W}/agent.pid`;
    const script = [
      "#!/bin/sh",
      `cd ${sq(repo)} || exit 97`,
      `echo $$ > ${sq(pidFile)}`,
      ...(prelude ? [prelude] : []),
      ...(capcomdPrelude ? [capcomdPrelude] : []),
      `timeout -k 10 ${Math.ceil(cfg.timeoutMs / 1000)} ${adapter.command({ bin: bin!, repo, promptFile: `${W}/prompt.txt`, jsonl, errFile, dir: W, cfg, systemFile, appendSystemFile, ...(capcomdCtx ? { capcomd: capcomdCtx } : {}) }, sq)}`,
      `echo $? > ${sq(exitFile)}`,
    ].join("\n");
    await provider.upload(vmId, `${W}/run.sh`, new TextEncoder().encode(script + "\n"));
    // The credential exists only in this exec's env (inherited by the agent). Never logged.
    must(await sh(`rm -f ${sq(exitFile)} ${sq(jsonl)}; chmod +x ${sq(`${W}/run.sh`)}; setsid nohup ${sq(`${W}/run.sh`)} > /dev/null 2>&1 < /dev/null & echo started`,
      { ...adapter.baseEnv(), ...(credential ? adapter.credentialEnv(credential) : {}) }), `start ${name}`, "failed");

    const kill = async () => { await sh(`p=$(cat ${sq(pidFile)} 2>/dev/null) && kill -TERM -"$p" 2>/dev/null; sleep 1; [ -n "$p" ] && kill -KILL -"$p" 2>/dev/null; true`).catch(() => {}); };
    const deadline = now() + cfg.timeoutMs + 30_000;
    const state: AgentRunState = { events: 0, turns: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, done: false };
    live = state;
    let consumed = 0, exitCode: number | null = null;
    // A limit ends the run but keeps the work: it is committed and pushed below (Capcomd-Stop trailer) and the
    // caller stops the agent instead of retrying it, so hours of work aren't redone or lost at a cap.
    let limit: string | null = null;
    const drain = async (final: boolean) => {
      const res = await sh(`tail -n +${consumed + 1} ${sq(jsonl)} 2>/dev/null; printf '\\n__CAPCOMD_EXIT__%s' "$(cat ${sq(exitFile)} 2>/dev/null)"`);
      const [body, exitPart] = res.stdout.split("\n__CAPCOMD_EXIT__");
      const lines = (body ?? "").split("\n");
      if (lines[lines.length - 1] === "") lines.pop();
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (!line.trim()) { consumed++; continue; }
        const ev = adapter.parse(line, r, state, cfg);
        if (!ev) { if (i === lines.length - 1 && !final) break; consumed++; continue; }
        consumed++; state.events++;
        addSpanEvent(span, `agent.${ev.type}${ev.subtype ? `.${ev.subtype}` : ""}`, {
          ...(ev.tool ? { "agent.tool": ev.tool } : {}), ...(ev.text ? { "agent.text": ev.text } : {}),
        });
        opts.onEvent?.(ev);
      }
      const code = (exitPart ?? "").trim();
      if (code !== "") exitCode = Number(code);
    };
    while (exitCode === null) {
      await new Promise((res) => setTimeout(res, cfg.pollMs));
      await drain(false);
      if (exitCode !== null) break;
      const guard = adapter.guard(state, cfg);
      if (guard) {
        await kill(); await drain(true);
        addSpanEvent(span, "agent.guard", { reason: guard });
        limit = guard.split(" ")[0]!;
        break;
      }
      if (opts.isCancelled && (await opts.isCancelled().catch(() => false))) {
        await kill(); await drain(true);
        addSpanEvent(span, "agent.cancelled");
        throw new AgentError("cancelled", `${name} cancelled for ${key}`);
      }
      if (now() > deadline) {
        await kill(); await drain(true);
        limit = "timeout";
        break;
      }
    }
    await drain(true);

    const out = adapter.outcome(state, exitCode ?? -1);
    limit ??= LIMIT_STOPS[out.stopReason] ?? null;
    const billing = credentialMode === "subscription" ? "subscription" : "api";
    const notionalCostUsd = state.costUsd;
    const costUsd = billing === "subscription" ? 0 : state.costUsd;
    const { turns } = state;
    setSpanAttributes(span, { "agent.billing": billing, "agent.notional_cost_usd": notionalCostUsd });
    setSpanAttributes(span, { "agent.exit_code": exitCode, "agent.cost_usd": costUsd, "agent.turns": turns, "agent.stop_reason": limit ?? out.stopReason, "agent.events": state.events, "gen_ai.response.cost": costUsd, "gen_ai.usage.input_tokens": state.inputTokens, "gen_ai.usage.output_tokens": state.outputTokens });
    if (limit) addSpanEvent(span, "agent.limit", { reason: limit });
    if (!limit && !out.ok) {
      const err = await sh(`tail -c 2000 ${sq(errFile)} 2>/dev/null`);
      throw new AgentError("failed", `${name} stopped (${out.stopReason}, exit ${exitCode}) for ${key}: ${r.text(state.error ?? "")} ${r.text(err.stdout).slice(-800)}`.trim());
    }

    // A reviewer or a reporting agent only answers: nothing it changed is committed or pushed.
    if (task.review || task.report) {
      if (limit) throw new AgentError("limit", `${name} stopped at its ${limit} limit for ${key} before answering`);
      setSpanAttributes(span, task.review ? { "agent.review": true } : { "agent.report": true });
      return { sha: "", already: false, costUsd, turns, stopReason: out.stopReason, events: state.events, credentialMode, agentVersion: version, billing, notionalCostUsd, resultText: r.text(state.resultText ?? "").slice(-(task.report ? 8000 : 4000)) };
    }

    // 5. Commit with capcomd trailers and push the task branch.
    must(await git(["add", "-A"], repo), "git add");
    const status = await git(["status", "--porcelain"], repo);
    const ahead = await git(["rev-list", "--count", `origin/${task.target}..HEAD`], repo);
    if (!status.stdout.trim() && Number(ahead.stdout.trim()) === 0) {
      // ADR-017: an orchestrator's work is its children's branches; finishing without edits is fine.
      if (opts.subagents) { setSpanAttributes(span, { "agent.no_changes": true }); return { sha: "", already: false, costUsd, turns, stopReason: out.stopReason, events: state.events, credentialMode, agentVersion: version, billing, notionalCostUsd, ...(limit ? { limit } : {}) }; }
      if (limit) throw new AgentError("limit", `${name} stopped at its ${limit} limit for ${key} before changing anything`);
      throw new AgentError("no_changes", `${name} made no changes for ${key} (${out.stopReason})`);
    }
    // At a limit the stop is always recorded in a commit (empty if the agent committed everything itself), so a replay sees it.
    if (status.stdout.trim() || limit) {
      const subject = `${limit ? `WIP (stopped: ${limit}) ` : ""}${task.taskId}: ${task.goal.split("\n")[0]!.slice(0, 60)}`;
      const msg = `${subject}\n\n${r.text(state.resultText ?? "").slice(0, 1500)}\n\nCapcomd-Task: ${key}\nCapcomd-Epoch: ${task.epoch}\nCapcomd-Agent: ${name}@${version}\n${limit ? `Capcomd-Stop: ${limit}\n` : ""}`;
      await provider.upload(vmId, `${W}/commit-msg.txt`, new TextEncoder().encode(msg));
      must(await git(["-c", "user.name=capcomd", "-c", "user.email=capcomd@users.noreply.github.com", "commit", ...(limit ? ["--allow-empty"] : []), "-F", `${W}/commit-msg.txt`], repo), "git commit");
    }
    const sha = must(await git(["rev-parse", "HEAD"], repo), "rev-parse").stdout.trim();
    const lease = branchExists ? `--force-with-lease=refs/heads/${task.branch}` : `--force-with-lease=refs/heads/${task.branch}:`;
    must(await git(["push", "--porcelain", lease, "origin", `HEAD:refs/heads/${task.branch}`], repo, 300_000), "git push");
    setSpanAttributes(span, { "git.sha": sha });
    return { sha, already: false, costUsd, turns, stopReason: limit ?? out.stopReason, events: state.events, credentialMode, agentVersion: version, billing, notionalCostUsd, ...(limit ? { limit } : {}) };
  } catch (e) {
    // Failed/timed-out spans still carry what was spent so far (subscription billing: cost 0, notional set).
    const st = live as AgentRunState | null;
    const sub = span.attributes["agent.billing"] === "subscription" || span.attributes["agent.credential_mode"] === "subscription";
    setSpanAttributes(span, {
      "agent.cost_usd": st && !sub ? st.costUsd : 0, "agent.notional_cost_usd": st?.costUsd ?? 0, "agent.turns": st?.turns ?? 0,
      "agent.error_kind": e instanceof AgentError ? e.kind : "error", ...(span.attributes["agent.stop_reason"] ? {} : { "agent.stop_reason": e instanceof AgentError ? e.kind : "error" }),
    });
    throw e;
  } }, task.agentId ? { parentSpanId: agentSpanId(task.runId, task.agentId) } : {});
}
