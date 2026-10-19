// Claude Code worker adapter: runs `claude -p ... --output-format stream-json` headless inside the
// task's sandbox VM, streams its events into the trace, then commits with capcomd trailers and
// pushes the task branch. See docs/adr-014-claude-code-worker.md.
import type { SandboxProvider, VmId, ExecResult } from "../providers/sandbox";
import type { AgentConfig } from "./config";
import { Redactor } from "./redact";
import { taskKey } from "../merge/config";
import { activeSpan, addSpanEvent, setSpanAttributes, withSpan } from "../utils/tracing-simple";

export interface AgentTask {
  runId: string;
  taskId: string;
  epoch: number;
  branch: string;
  target: string;
  /** Clone URL (token-free). Credentials come from the provider's git credential hook. */
  repoUrl: string;
  goal: string;
  /** Start from the latest target instead of reusing the task branch (after a merge conflict). */
  rework?: boolean;
  conflictFiles?: string[];
}

export interface AgentEvent {
  type: string;
  subtype?: string;
  tool?: string;
  text?: string;
  raw: Record<string, unknown>;
}

export interface AgentResult {
  sha: string;
  already: boolean;
  costUsd: number;
  turns: number;
  stopReason: string;
  events: number;
}

export interface AgentRunOptions {
  apiKey: string;
  /** Polled while the agent runs; true kills the agent process group. */
  isCancelled?: () => Promise<boolean>;
  onEvent?: (e: AgentEvent) => void;
  /** Extra secrets to redact (e.g. git token). */
  secrets?: string[];
  now?: () => number;
}

export class AgentError extends Error {
  constructor(readonly kind: "cancelled" | "timeout" | "failed" | "no_changes" | "install" | "git", message: string) {
    super(message);
    this.name = "AgentError";
  }
}

const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

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

/** Parse one stream-json line into a compact, redacted event. Returns null for partial/invalid lines. */
export function parseStreamLine(line: string, r: Redactor): AgentEvent | null {
  let raw: any;
  try { raw = JSON.parse(line); } catch { return null; }
  if (!raw || typeof raw !== "object") return null;
  raw = r.value(raw);
  const ev: AgentEvent = { type: String(raw.type ?? "unknown"), raw };
  if (raw.subtype) ev.subtype = String(raw.subtype);
  const content = raw.message?.content;
  if (Array.isArray(content)) {
    const tool = content.find((c: any) => c?.type === "tool_use");
    if (tool) ev.tool = String(tool.name);
    const text = content.filter((c: any) => c?.type === "text").map((c: any) => c.text).join("\n");
    if (text) ev.text = text.slice(0, 500);
  }
  if (ev.type === "result" && typeof raw.result === "string") ev.text = raw.result.slice(0, 500);
  return ev;
}

export async function runClaudeCode(provider: SandboxProvider, vmId: VmId, task: AgentTask, cfg: AgentConfig, opts: AgentRunOptions): Promise<AgentResult> {
  const r = new Redactor([opts.apiKey, ...(opts.secrets ?? [])]);
  const now = opts.now ?? Date.now;
  const W = `${cfg.workdir}/${task.taskId}-e${task.epoch}`;
  const repo = `${W}/repo`;
  const home = `${cfg.workdir}/home`;
  const PATH = `${home}/node/bin:${home}/npm/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;
  const baseEnv = { PATH, HOME: home };

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
    "agent.kind": "claude-code", "agent.version": cfg.version, "relay.run_id": task.runId,
    "relay.task_id": task.taskId, "relay.epoch": task.epoch, "git.branch": task.branch,
    "agent.max_turns": cfg.maxTurns, "agent.max_budget_usd": cfg.maxBudgetUsd,
  };

  return withSpan("agent.claude_code", attrs, async (span) => {
    must(await sh(`mkdir -p ${sq(W)} ${sq(home)}`), "mkdir");

    // 1. Clone the target (credential hook supplies the token for this exec only).
    const existing = await git(["ls-remote", "--heads", task.repoUrl, `refs/heads/${task.branch}`]);
    must(existing, "git ls-remote");
    const branchExists = existing.stdout.trim().length > 0;
    must(await sh(`rm -rf ${sq(repo)}`), "clean");
    must(await git(["clone", "--no-tags", "--branch", task.target, task.repoUrl, repo], undefined, 300_000), "git clone");
    if (branchExists) must(await git(["fetch", "origin", `+refs/heads/${task.branch}:refs/remotes/origin/${task.branch}`], repo), "git fetch branch");

    // Idempotent resume: this epoch already pushed its commit (crash after push, before event).
    if (branchExists && !task.rework) {
      const head = await git(["log", "-1", "--format=%H%x00%(trailers:key=Capcomd-Task,valueonly,separator=)%x00%(trailers:key=Capcomd-Epoch,valueonly,separator=)", `origin/${task.branch}`], repo);
      const [sha, k, ep] = head.stdout.trim().split("\0");
      if (head.code === 0 && k?.trim() === key && Number(ep) === task.epoch && sha) {
        addSpanEvent(span, "agent.reused_push", { sha });
        setSpanAttributes(span, { "git.sha": sha, "agent.already": true });
        return { sha, already: true, costUsd: 0, turns: 0, stopReason: "already_pushed", events: 0 };
      }
    }
    must(await git(["checkout", "-B", task.branch, branchExists && !task.rework ? `origin/${task.branch}` : `origin/${task.target}`], repo), "git checkout");

    // 2. Install pinned Node + Claude Code (skipped when a claude binary is injected).
    let claude = cfg.claudeBin;
    if (!claude) {
      const install = await withSpan("agent.install", { "agent.version": cfg.version, "agent.node_version": cfg.nodeVersion }, async () =>
        sh(installScript(cfg, home), {}, 600_000));
      must(install, "claude-code install", "install");
      claude = `${home}/npm/bin/claude`;
    }

    // 3. Run headless in the background; stream-json lands in a file we tail.
    await provider.upload(vmId, `${W}/prompt.txt`, new TextEncoder().encode(r.text(buildPrompt(task))));
    const runner = [
      "#!/bin/sh",
      `cd ${sq(repo)} || exit 97`,
      `echo $$ > ${sq(`${W}/claude.pid`)}`,
      `timeout -k 10 ${Math.ceil(cfg.timeoutMs / 1000)} ${sq(claude)} -p "$(cat ${sq(`${W}/prompt.txt`)})" --output-format stream-json --verbose` +
        ` --max-turns ${cfg.maxTurns} --max-budget-usd ${cfg.maxBudgetUsd}` +
        ` --allowedTools ${sq(cfg.allowedTools.join(","))} --disallowedTools ${sq(cfg.disallowedTools.join(","))}` +
        (cfg.model ? ` --model ${sq(cfg.model)}` : "") +
        ` > ${sq(`${W}/claude.jsonl`)} 2> ${sq(`${W}/claude.err`)} < /dev/null`,
      `echo $? > ${sq(`${W}/claude.exit`)}`,
    ].join("\n");
    await provider.upload(vmId, `${W}/run.sh`, new TextEncoder().encode(runner + "\n"));
    must(await sh(`rm -f ${sq(`${W}/claude.exit`)} ${sq(`${W}/claude.jsonl`)}; chmod +x ${sq(`${W}/run.sh`)}; setsid nohup ${sq(`${W}/run.sh`)} > /dev/null 2>&1 < /dev/null & echo started`, {
      // The API key exists only in this exec's env (inherited by the claude process). Never logged.
      ANTHROPIC_API_KEY: opts.apiKey,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
      DISABLE_TELEMETRY: "1",
      CI: "1",
    }), "start claude", "failed");

    const kill = async () => { await sh(`p=$(cat ${sq(`${W}/claude.pid`)} 2>/dev/null) && kill -TERM -"$p" 2>/dev/null; sleep 1; [ -n "$p" ] && kill -KILL -"$p" 2>/dev/null; true`).catch(() => {}); };
    const deadline = now() + cfg.timeoutMs + 30_000;
    let consumed = 0, events = 0, exitCode: number | null = null;
    let result: any = null;
    const drain = async (final: boolean) => {
      const res = await sh(`tail -n +${consumed + 1} ${sq(`${W}/claude.jsonl`)} 2>/dev/null; printf '\\n__CAPCOMD_EXIT__%s' "$(cat ${sq(`${W}/claude.exit`)} 2>/dev/null)"`);
      const [body, exitPart] = res.stdout.split("\n__CAPCOMD_EXIT__");
      const lines = (body ?? "").split("\n");
      if (lines[lines.length - 1] === "") lines.pop();
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (!line.trim()) { consumed++; continue; }
        const ev = parseStreamLine(line, r);
        if (!ev) { if (i === lines.length - 1 && !final) break; consumed++; continue; } // partial last line: retry next poll
        consumed++; events++;
        if (ev.type === "result") result = ev.raw;
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
      if (opts.isCancelled && (await opts.isCancelled().catch(() => false))) {
        await kill(); await drain(true);
        addSpanEvent(span, "agent.cancelled");
        throw new AgentError("cancelled", `claude-code cancelled for ${key}`);
      }
      if (now() > deadline) {
        await kill(); await drain(true);
        throw new AgentError("timeout", `claude-code timed out after ${cfg.timeoutMs}ms for ${key}`);
      }
    }
    await drain(true);

    const costUsd = Number(result?.total_cost_usd ?? 0);
    const turns = Number(result?.num_turns ?? 0);
    const stopReason = String(result?.subtype ?? (exitCode === 124 ? "timeout" : `exit_${exitCode}`));
    setSpanAttributes(span, { "agent.exit_code": exitCode, "agent.cost_usd": costUsd, "agent.turns": turns, "agent.stop_reason": stopReason, "agent.events": events, "gen_ai.response.cost": costUsd });
    if (exitCode === 124) throw new AgentError("timeout", `claude-code hit the ${cfg.timeoutMs}ms timeout for ${key}`);
    if (exitCode !== 0 || !result || result.is_error) {
      const err = await sh(`tail -c 2000 ${sq(`${W}/claude.err`)} 2>/dev/null`);
      throw new AgentError("failed", `claude-code stopped (${stopReason}, exit ${exitCode}) for ${key}: ${r.text(err.stdout).slice(-800)}`);
    }

    // 4. Commit whatever the agent changed, with capcomd trailers, and push the task branch.
    must(await git(["add", "-A"], repo), "git add");
    const status = await git(["status", "--porcelain"], repo);
    const ahead = await git(["rev-list", "--count", `origin/${task.target}..HEAD`], repo);
    if (!status.stdout.trim() && Number(ahead.stdout.trim()) === 0) throw new AgentError("no_changes", `claude-code made no changes for ${key} (${stopReason})`);
    if (status.stdout.trim()) {
      const subject = `${task.taskId}: ${task.goal.split("\n")[0]!.slice(0, 60)}`;
      const msg = `${subject}\n\n${r.text(String(result.result ?? "")).slice(0, 1500)}\n\nCapcomd-Task: ${key}\nCapcomd-Epoch: ${task.epoch}\nCapcomd-Agent: claude-code@${cfg.version}\n`;
      await provider.upload(vmId, `${W}/commit-msg.txt`, new TextEncoder().encode(msg));
      must(await git(["-c", "user.name=capcomd", "-c", "user.email=capcomd@users.noreply.github.com", "commit", "-F", `${W}/commit-msg.txt`], repo), "git commit");
    }
    const sha = must(await git(["rev-parse", "HEAD"], repo), "rev-parse").stdout.trim();
    const lease = branchExists ? `--force-with-lease=refs/heads/${task.branch}` : `--force-with-lease=refs/heads/${task.branch}:`;
    must(await git(["push", "--porcelain", lease, "origin", `HEAD:refs/heads/${task.branch}`], repo, 300_000), "git push");
    setSpanAttributes(span, { "git.sha": sha });
    return { sha, already: false, costUsd, turns, stopReason, events };
  });
}

export function installScript(cfg: AgentConfig, home: string): string {
  const v = cfg.nodeVersion;
  return `set -e
cd ${sq(home)}
if [ ! -x node/bin/node ] || [ "$(node/bin/node -v)" != "v${v}" ]; then
  case "$(uname -m)" in x86_64) a=x64;; aarch64|arm64) a=arm64;; *) echo "unsupported arch $(uname -m)" >&2; exit 1;; esac
  rm -rf node node.tgz
  curl -fsSL "https://nodejs.org/dist/v${v}/node-v${v}-linux-$a.tar.gz" -o node.tgz
  mkdir node && tar -xzf node.tgz -C node --strip-components=1 && rm node.tgz
fi
if [ "$(npm/bin/claude --version 2>/dev/null | cut -d' ' -f1)" != "${cfg.version}" ]; then
  node/bin/npm install -g --prefix "${home}/npm" --no-fund --no-audit "@anthropic-ai/claude-code@${cfg.version}"
fi
npm/bin/claude --version`;
}

export { activeSpan };
