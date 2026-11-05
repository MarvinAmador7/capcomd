// Generic headless-agent runner: clone → detect/install CLI → resolve credential (boxd host-bound
// secret placeholder preferred, env injection fallback) → run in background → stream + guard →
// commit with capcomd trailers → push. Agent specifics live in adapters.ts. ADR-014, ADR-015.
import { SUPERVISOR_SOURCE } from "../utils/assets";
import type { SandboxProvider, VmId, ExecResult } from "../providers/sandbox";
import type { AgentConfig } from "./config";
import type { AgentAdapter, AgentEvent, AgentRunState } from "./types";
import { Redactor } from "./redact";
import { taskKey } from "../merge/config";
import { addSpanEvent, agentSpanId, setSpanAttributes, withSpan } from "../utils/tracing-simple";
import { readFileSync } from "fs";
import { StuckWatch, type Stuck } from "./stuck";
import { namingCalls, threadBuilder, type ItemDraft } from "../../packages/agent-thread/src/index";
import type { ThreadAttachment } from "../actors/scope";
import { withSkills, type AttachedSkill } from "./skills";
import { isTransientSandboxError } from "../providers/boxd-errors";
import { outageWindowMs, providerLabel, reportOutage, unreachable } from "../providers/resilient";
import { chooseWorkspace, LOCKFILES, parseTemplateMarker, startRef, TEMPLATE_CLAIM, TEMPLATE_LOCKHASH, TEMPLATE_MARKER, type WorkspaceChoice } from "./workspace";

/** Where an agent's checkpoints are pushed (ADR-019 §3); deleted once its work merges. */
export const checkpointRef = (agentId: string) => `refs/capcomd/checkpoints/${agentId}`;

/** ADR-019 §1: what the in-VM supervisor reports up (its outbox), or the runner on its behalf without one. */
export type SupervisorReport =
  | { type: "heartbeat"; events: number; lastEventAt: number; source: "supervisor" | "events" }
  | { type: "checkpoint"; sha: string; ref: string; reason: string; files: number };

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
  /** Its title as it starts (the driver's `--title`, its parent's or the user's): a commit subject before the brief. */
  title?: string;
  rework?: boolean;
  conflictFiles?: string[];
  /** verify's reviewer: check out this commit, review it, never commit or push (goal = the review brief). With
   *  `targetSha`, the commit merged onto the target at that commit: the tree verify's checks test. */
  review?: { sha: string; branch: string; target: string; targetSha?: string };
  /** Report mode: read-only work on the target (research, triage); the final message is the result, nothing is pushed. */
  report?: boolean;
  /** ADR-019 §6: a paused agent running again; its earlier work (if any) is already on the branch. */
  resumed?: boolean;
  /** `spawn --continue`: start the branch from another agent's stopped work (its branch or checkpoint ref). */
  from?: { agentId: string; ref: string; stopped: string };
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
  /** Stopped at a limit (timeout, max_turns, max_budget_usd, idle, quota): `sha` holds the work so far, with a Capcomd-Stop trailer. */
  limit?: string;
  /** limit "quota": when the provider's usage limit resets (ms epoch), if it said. */
  resetAt?: number;
  /**
   * Plugin API §16.1: an orchestrate agent whose checkout had changed files or new commits at the end of a turn or of
   * its run (a CLI whose rules a shell trick gets past: `echo x > f`, `sh -c`). The agent fails; nothing it wrote is
   * committed or pushed. `files`: the changed paths (at most 50), `total`: how many, `commits`: its local commits.
   */
  orchestrateWrites?: OrchestrateWrites;
}

/** What an orchestrate agent wrote although it may not (AgentResult.orchestrateWrites). */
export interface OrchestrateWrites { files: string[]; total: number; commits: number; at: "turn" | "end" }

/** "changed notes.txt, src/a.ts and 3 more, and made 1 commit": what an orchestrate agent wrote, in words. */
export function orchestrateWritesText(w: { files: string[]; total: number; commits: number }): string {
  const shown = w.files.slice(0, 10);
  const files = w.total ? `changed ${shown.join(", ")}${w.total > shown.length ? ` and ${w.total - shown.length} more` : ""}` : "";
  const commits = w.commits ? `made ${w.commits} local commit${w.commits === 1 ? "" : "s"}` : "";
  return [files, commits].filter(Boolean).join(", and ");
}

export interface AgentRunOptions {
  /** Real API key for env-injection fallback. Unused when the VM carries a bxds_ placeholder. */
  apiKey?: string;
  isCancelled?: () => Promise<boolean>;
  /** The operator asked to pause the agent: stop it like a limit ("paused"), keeping its work on the branch. */
  isPaused?: () => Promise<boolean>;
  onEvent?: (e: AgentEvent) => void;
  /**
   * ADR-019: spend so far (usd is 0 on a subscription), reported every few seconds while the agent runs. The engine
   * records it and answers with a limit to stop at (e.g. "max_budget_usd") when a budget is over, else null, and
   * when the agent was last given more budget (a new grant resets the stuck window).
   */
  onSpend?: (spent: { usd: number; turns: number; wallSeconds: number }, inboxAfter?: number) => Promise<{ stop: string | null; grantedAt?: number; used?: number | null; messages?: { seq: number; from: string; body: string; skills?: AttachedSkill[] }[] }>;
  /**
   * ADR-019 §1: reports from the in-VM supervisor: heartbeats while it is alive, and checkpoints (already pushed to
   * `ref`). A VM without node has no supervisor; heartbeats then come from the agent CLI's own events.
   */
  onReport?: (r: SupervisorReport) => void;
  /** Supervisor heartbeat interval (default 30s). */
  heartbeatMs?: number;
  /** What the agent does, a line per tool call, failed result, message and result (`capcomd logs`). */
  onLog?: (lines: string[]) => void;
  /**
   * harness.v1 thread items (packages/agent-thread) built from the same events: new items and new revs of open ones
   * (a tool call open → done), with the images tools returned to store as attachments.
   */
  onItems?: (items: ItemDraft[], attachments: ThreadAttachment[]) => void;
  /** How often spend is reported to onSpend (default 5s). */
  spendEveryMs?: number;
  /**
   * ADR-019 §2: the agent looks stuck (idle, spinning, failing), or no longer does (null). The first window is only
   * this notice; after the second the runner stops the agent itself (limit = the kind, work kept).
   */
  onNotice?: (n: { kind: Stuck["kind"]; detail: string } | null) => void;
  secrets?: string[];
  now?: () => number;
  /** ADR-017: install in-VM capcomd (CLI + MCP + skill). Only set for agents allowed to spawn. */
  subagents?: { skill: string; cliSource: string; rpcDir: string };
  /**
   * Capability agents.title, for an agent without `subagents`: a `capcomd` on its PATH that only names its tab (the
   * shim, src/primitives/title-rules.mjs: it checks the title and talks to nobody) and the lines that ask it to. Each
   * `capcomd title …` it runs by itself, as its tool calls show it, is `onTitle` (once per call id).
   */
  naming?: { shimSource: string; skill: string };
  onTitle?: (t: { title: string; callId: string }) => void;
  /**
   * ADR-021 §2: the run's idle machine lifetime (seconds; default AGENT_VM_TTL_SECONDS). The VM's delete deadline is
   * renewed to this from now every 10 minutes while the agent runs.
   */
  vmTtlSeconds?: number;
  /** Called after each renewal with the lifetime it renewed (the worker keeps its own reap alarm in step). */
  onRenew?: (seconds: number) => void;
  /**
   * The sandbox is this agent's own copy of its image (Docker): a warm template baked in by `capcomd env build` may be
   * used in place instead of a fresh clone (src/agents/workspace.ts). Off: always the clone, as before.
   */
  warmTemplate?: boolean;
}

export class AgentError extends Error {
  constructor(readonly kind: "cancelled" | "failed" | "no_changes" | "install" | "git" | "credentials" | "limit", message: string) {
    super(message);
    this.name = "AgentError";
  }
}

/** A worker VM is deleted this long after its last lease renewal, so a VM whose engine died is cleaned up: the default
 *  idle machine lifetime. A run's own (ADR-021 §2, recorded at `run new`) replaces it: AgentRunOptions.vmTtlSeconds. */
export const AGENT_VM_TTL_SECONDS = 3600;
const TTL_RENEW_MS = 10 * 60_000;
const SPEND_REPORT_MS = 5_000;

/** How a stop reads in errors and results (idle, spinning and failing aren't limits anyone set: ADR-019 §2). */
const STUCK_STOPS: Record<string, string> = {
  idle: "stopped after going idle (no output from the agent)",
  spinning: "stopped after spinning (the same tool call again and again, or working with no change in its workspace)",
  failing: "stopped after hitting the same error again and again (failing)",
  quota: "stopped by its provider's usage limit",
  paused: "paused by the operator",
};
export const stoppedAt = (limit: string) => STUCK_STOPS[limit] ?? `stopped at its ${limit} limit`;
/** The CLI's own stop reasons that mean "out of budget", not "broken" (claude result subtypes; `timeout` exit 124). */
const LIMIT_STOPS: Record<string, string> = { timeout: "timeout", error_max_turns: "max_turns", error_max_budget_usd: "max_budget_usd" };
/** The events that end an agent CLI's turn (Claude Code's `result`, codex's `turn.completed`): an orchestrate agent's
 *  checkout is looked at then. A provider whose turns end otherwise is looked at when it ends. */
const TURN_ENDS = new Set(["result", "turn_completed"]);

/** The supervisor program, uploaded into each VM next to the agent. */

export const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
export const SECRET_PLACEHOLDER_PREFIX = "bxds_";

/** Messages up to this many bytes are appended to the VM's inbox with one shell command; longer ones are uploaded. */
const INLINE_APPEND_MAX = 32 * 1024;

/** A message sent to a running agent (`capcomd send`), as the agent reads it: from its parent or the operator. */
export function messageText(m: { from: string; body: string; skills?: AttachedSkill[] }): string {
  const who = m.from === "operator" || m.from === "driver" ? "the operator" : `agent ${m.from} (your parent or an ancestor)`;
  return `Message from ${who}, sent while you work (capcomd send):\n\n${withSkills(m.body, m.skills)}`;
}

const cutLine = (x: string, n: number) => (x.length > n ? `${x.slice(0, n)}…` : x).replace(/\s+/g, " ");

/**
 * A failed tool result that is the CLI's permission system refusing the call, not the call failing: Claude Code's
 * denials ("Permission to use Bash with command … has been denied.", "This command requires approval", "… needs
 * approval", "… can't be checked before it runs", a disabled tool) and codex's (an MCP tool "requires approval, but
 * approval policy is never", a command its rules reject).
 */
export const REFUSAL = /has been denied|requires approval|needs approval|can't be checked before it runs|No such tool available|is disabled for this session|approval policy is `?never|\brejected: /i;

/** An event as `capcomd logs` lines: its tool calls, failed results (`refused …` when the CLI refused the call), text
 *  and final result. */
export function logLinesOf(ev: AgentEvent): string[] {
  const out: string[] = [];
  const cut = cutLine;
  const failed = (ev.results ?? []).filter((x) => x.error !== undefined);
  for (const c of ev.calls ?? []) if (!failed.some((f) => f.call === c)) out.push(`tool ${cut(c, 300)}`);
  for (const f of failed) out.push(`${REFUSAL.test(f.error ?? "") ? "refused" : "error"} ${cut(f.call, 200)}: ${cut(f.error ?? "", 300)}`);
  if (ev.text) out.push(`${ev.type === "result" ? "result" : "say"} ${cut(ev.text, 500)}`);
  else if (ev.type === "result") out.push(`result ${ev.subtype ?? ""}`.trim());
  return out;
}

/**
 * The subject of an agent's commit (and so of its pull request): the task's first line, cut at a word to fit 72
 * characters. The task and agent are named in the trailers, so the subject is only what the change does.
 */
export function commitSubject(goal: string, max = 72): string {
  const line = goal.split("\n")[0]!.trim().replace(/\s+/g, " ");
  if (line.length <= max) return line;
  let cut = line.slice(0, max - 1);
  // A parenthesis the cut leaves open is dropped with what's in it ("for tinycalc (TypeScript on Bun, strict…").
  const open = unclosedParen(cut);
  if (open > max / 3) return cut.slice(0, open).replace(/[\s,;:(\-]+$/, "");
  const at = cut.lastIndexOf(" ");
  cut = at > max / 2 ? cut.slice(0, at) : cut;
  return `${cut.replace(/[\s,;:(\-]+$/, "")}…`;
}

/** Where the first "(" with no ")" after it is, or -1. */
function unclosedParen(s: string): number {
  const stack: number[] = [];
  for (let i = 0; i < s.length; i++) { if (s[i] === "(") stack.push(i); else if (s[i] === ")") stack.pop(); }
  return stack.length ? stack[0]! : -1;
}

/** The first letter up, unless the subject starts with an identifier (printExpr, src/x.ts, parse_expr, v2): kept as written. */
const cap = (x: string) => (/^\S*(?:[a-z][A-Z]|[_$./\\0-9])/.test(x) ? x : x.charAt(0).toUpperCase() + x.slice(1));
/** The first sentence of `text`'s first line with words: markdown and a "Task:"/"Summary:" label dropped. */
function firstSentence(text: string): string {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^\s*(?:#+|[-*>]|\d+[.)])\s+/, "").replace(/[*_`]+/g, "").replace(/^(?:goal|task|summary)\s*:\s*/i, "").trim().replace(/\s+/g, " ");
    if (!/[A-Za-z]/.test(line) || /^(?:goal|task|summary|context|overview)$/i.test(line)) continue;
    const end = /[.!?](?=\s|$)|;\s|\s[—–]\s/.exec(line);
    return end ? line.slice(0, end.index) : line;
  }
  return "";
}

/** Verbs a commit subject starts with, in the imperative. Their past and -ing forms are recognized too (VERB_FORMS). */
const VERBS = ("add adjust align allow apply avoid build bump cache change check clean clarify configure connect convert copy correct cover create cut " +
  "define delete deprecate describe document drop emit enable ensure expose export extend extract finish fix format generate guard handle harden " +
  "hide implement import improve inline introduce keep land lay limit link load log make map mark merge migrate model move normalize note optimize " +
  "parse pass pin plumb polish port prepare preserve print protect prune read record reduce refactor register reject remove rename render reorder " +
  "replace report require reset resolve restore restructure return reuse revert rewrite rework run scaffold scope separate serialize set ship show " +
  "simplify skip sort specify split stop store strip stub support switch sync test tidy tighten track trim tweak unify update upgrade use validate " +
  "verify wire wrap write").split(" ");
const IRREGULAR: Record<string, string> = { built: "build", made: "make", wrote: "write", written: "write", rewrote: "rewrite", rewritten: "rewrite", laid: "lay",
  ran: "run", kept: "keep", cut: "cut", set: "set", split: "split", read: "read", shown: "show", hid: "hide", hidden: "hide" };
const VERB_SET = new Set(VERBS);
/** A lead word's imperative (added, adding, add → add; built → build), or null when it isn't one of VERBS. Not the -s
 *  form: "Tests pass" is not "Test pass". */
function imperativeOf(word: string): string | null {
  const w = word.toLowerCase();
  if (VERB_SET.has(w)) return w;
  if (IRREGULAR[w]) return IRREGULAR[w]!;
  const tries = w.endsWith("ied") ? [`${w.slice(0, -3)}y`] : w.endsWith("ed") ? [w.slice(0, -2), w.slice(0, -1), w.slice(0, -3)]
    : w.endsWith("ying") ? [w.slice(0, -3)] : w.endsWith("ing") ? [w.slice(0, -3), `${w.slice(0, -3)}e`, w.slice(0, -4)] : [];
  return tries.find((t) => VERB_SET.has(t)) ?? null;
}
const verbCap = (v: string) => v.charAt(0).toUpperCase() + v.slice(1);
/** "Adding the lexer" → "Add the lexer"; a sentence whose first word is no verb stays as it is. */
function imperativeLead(s: string): string {
  const [first, ...rest] = s.split(" ");
  const v = first ? imperativeOf(first) : null;
  return v ? [verbCap(v), ...rest].join(" ") : s;
}

/**
 * A summary's first sentence as a commit subject (imperative), or null when it doesn't read like one. "I added X" →
 * "Add X"; "X and Y are now implemented in Z" → "Implement X and Y in Z"; "Added X" → "Add X". A sentence that
 * doesn't say what was done ("All three fixes are in, and …", "Tinycalc (TypeScript on Bun)", "Done!") gives null.
 */
export function summarySubject(summary: string): string | null {
  let s = firstSentence(summary).replace(/^(?:ok(?:ay)?|great|sure|alright|so|now|finally)\b[,!:]?\s+/i, "");
  if (!s || /^(?:done|all done|here(?:'s| is)|i have finished|finished|summary)\b/i.test(s)) return null;
  let out: string | null = null;
  const said = /^(?:i|we)(?:'ve|'d| have| had)?\s+(?:now\s+|just\s+|also\s+|then\s+)?(\S+)\s+(.+)$/i.exec(s);
  const passive = /^(.+?)\s+(?:is|are|was|were|has been|have been)\s+(?:now\s+)?(?:all\s+|fully\s+)?(\S+)(?:\s+(.*))?$/i.exec(s);
  if (said) { const v = imperativeOf(said[1]!); out = v ? `${verbCap(v)} ${said[2]}` : null; }
  else if (passive && /(?:ed|en|ilt|ade|ote)$/i.test(passive[2]!) && imperativeOf(passive[2]!)) out = `${verbCap(imperativeOf(passive[2]!)!)} ${passive[1]}${passive[3] ? ` ${passive[3]}` : ""}`;
  else {
    const [first, second, third] = s.split(" ");
    // "Build is green", "Test suite passes": a noun that happens to be a verb, not what was done.
    if (first && imperativeOf(first) && ![second, third].some((x) => x && /^(?:is|are|was|were|pass(?:es|ed)?|fails?|works?)$/i.test(x))) out = imperativeLead(s);
  }
  if (!out) return null;
  out = out.replace(/[\s,;:]+(?:and|with|so|but)?\s*$/i, "").trim();
  return out.split(" ").length >= 2 && out.length <= 100 && !/[:,]$/.test(out) ? out : null;
}

/** A task brief as a subject: role framing ("You are …", "Your task is to …") dropped, its first sentence, its lead verb
 *  in the imperative ("You are landing X" → "Land X"). */
export function taskSubject(goal: string): string {
  const s = firstSentence(goal).replace(/^(?:you are|you're|you will be|your (?:task|job) is(?: to)?|please)\s+/i, "").replace(/^(?:going|asked|tasked|responsible) (?:to|with|for)\s+/i, "");
  return s ? cap(imperativeLead(s)) : goal.split("\n")[0]!.trim();
}
/** What a capcomd commit's subject says: the agent's own commit message, else its summary's first sentence as a subject
 *  (when one can be made of it: summarySubject), else its title (its own, else the driver's or its parent's), else the
 *  task brief's first sentence; never the raw brief. */
export function subjectFor(o: { own?: string | null; summary?: string | null; title?: string | null; goal: string }): string {
  const own = o.own?.trim();
  if (own) return own;
  const sum = summarySubject(o.summary ?? "");
  if (sum) return cap(sum);
  const title = o.title?.trim();
  if (title) return cap(title);
  return taskSubject(o.goal);
}

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
  if (t.from) lines.push(`- This continues the work of agent ${t.from.agentId}, which stopped (${t.from.stopped}) before finishing. Its changes are already in your checkout (see \`git log\` and \`git diff ${t.target}\`): continue from them instead of starting over.`);
  if (t.resumed) lines.push("- You were stopped earlier by your provider's usage limit or paused by the operator. Whatever you had done is already on this branch (see `git log`); continue the task from there instead of starting over.");
  if (t.conflictFiles?.length) lines.push(`- A previous attempt conflicted with ${t.target} in: ${t.conflictFiles.join(", ")}. Re-apply the change on top of the current ${t.target}.`);
  return lines.join("\n");
}

/** A reviewer works on a detached checkout of the commit under review (merged onto the target, when verify says where
 *  the target is: the tree its checks test) and only reports a verdict. */
export function buildReviewPrompt(t: AgentTask & { review: NonNullable<AgentTask["review"]> }): string {
  const { sha, branch, target, targetSha } = t.review;
  const where = targetSha
    ? [`You are reviewing a change. The repository is checked out at the change (commit ${sha}, branch ${branch}) merged onto ${target} as it is now (${targetSha}): the same tree capcomd's checks test.`,
      `See the change itself with \`git diff ${targetSha}...HEAD\` (what it adds to ${target}) and read the code around it. Run the project's tests if that helps you judge: they run on the merged tree.`]
    : [`You are reviewing a change. The repository is checked out at commit ${sha} (branch ${branch}), based on ${target}.`,
      `See the change with \`git diff origin/${target}...HEAD\` and read the code around it. Run the project's tests if that helps you judge.`];
  return [
    ...where,
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

/**
 * Stops the agent left running in `W` by an earlier runner of the same attempt: its process group (run.sh is a session
 * leader, its pid in agent.pid), only while it has no exit file and the pid still runs that run.sh (never a reused pid).
 */
export function stopStaleRun(W: string): string {
  const pid = sq(`${W}/agent.pid`), exit = sq(`${W}/agent.exit`), run = sq(`${W}/run.sh`);
  return `p=$(cat ${pid} 2>/dev/null); case "$p" in ''|*[!0-9]*) exit 0;; esac
[ -e ${exit} ] && exit 0
cmd=$(tr '\\0' ' ' 2>/dev/null < /proc/$p/cmdline || ps -o args= -p "$p" 2>/dev/null)
case "$cmd" in *${run}*) ;; *) exit 0;; esac
kill -TERM -"$p" 2>/dev/null
for i in 1 2 3 4 5 6 7 8 9 10; do kill -0 -"$p" 2>/dev/null || exit 0; sleep 0.5; done
kill -KILL -"$p" 2>/dev/null; true`;
}

export async function runAgent(adapter: AgentAdapter, provider: SandboxProvider, vmId: VmId, task: AgentTask, cfg: AgentConfig, opts: AgentRunOptions): Promise<AgentResult> {
  const r = new Redactor([opts.apiKey, ...(opts.secrets ?? [])]);
  const now = opts.now ?? Date.now;
  const W = `${cfg.workdir}/${task.taskId}-e${task.epoch}`;
  // The agent's checkout: a fresh clone here, or the env image's warm template used in place (warmWorkspace).
  let repo = `${W}/repo`;
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
    "git.branch": task.branch, ...(cfg.maxTurns ? { "agent.max_turns": cfg.maxTurns } : {}), ...(cfg.maxBudgetUsd ? { "agent.max_budget_usd": cfg.maxBudgetUsd } : {}),
  };

  let live: AgentRunState | null = null; // for cost/turns on failed or timed-out spans (TUI contract)
  return withSpan(`agent.${name.replace("-", "_")}`, attrs, async (span) => { try {
    must(await sh(`mkdir -p ${sq(W)} ${sq(home)}`), "mkdir");
    // A run of this attempt whose runner died (the daemon stopped or restarted, a host crash) may still be going here:
    // stop it before starting over, so two agent CLIs never work in one checkout or race on its exit file.
    await sh(stopStaleRun(W)).catch(() => {});

    // 1. The workspace: the image's warm template in place when it fits (Docker), else a fresh clone. Either way the
    //    branch and tree the agent starts from are the same.
    const wsStarted = now();
    // A reviewer reads one commit and never pushes: its own branch doesn't matter, so no round trip to ask for it.
    const existing = task.review ? null : await git(["ls-remote", "--heads", task.repoUrl, `refs/heads/${task.branch}`]);
    if (existing) must(existing, "git ls-remote");
    const branchExists = !!existing && existing.stdout.trim().length > 0;
    const T = templateDir(cfg);
    // A continuation starts from the stopped agent's work, until its own branch exists.
    const startFrom = task.from && !branchExists && !task.report ? "FETCH_HEAD" : null;
    // The warm template fits when chooseWorkspace says so from what's in the sandbox: its record and claim, then (only if
    // those fit) the fetches a fresh clone would make, the target's history and the start tree's lockfile.
    const warmWorkspace = async (): Promise<WorkspaceChoice> => {
      const read = await sh(`cat ${sq(`${T}/${TEMPLATE_MARKER}`)} 2>/dev/null; printf '\\n__CAPCOMD_CLAIM__%s' "$([ -e ${sq(`${T}/${TEMPLATE_CLAIM}`)} ] && echo yes)"`);
      const [text, claim] = read.stdout.split("\n__CAPCOMD_CLAIM__");
      const facts = { allowed: true, marker: parseTemplateMarker(text ?? ""), claimed: (claim ?? "").trim() === "yes", repoUrl: task.repoUrl, fetched: null, ancestor: null, startFound: null, startLockHash: null };
      // What it would say if everything still to look at fit: a clone already (no template, used, another repository).
      const early = chooseWorkspace({ ...facts, fetched: true, ancestor: true, startFound: true, startLockHash: facts.marker?.lockHash ?? "none" });
      if (early.path === "clone" || !facts.marker) return early;
      // The refs a fresh clone has (every branch, as remote-tracking refs), and the continued agent's work.
      const fetched = (await git(["fetch", "--no-tags", "--prune", "origin", "+refs/heads/*:refs/remotes/origin/*"], T, 300_000)).code === 0
        && (!startFrom || (await git(["fetch", "origin", task.from!.ref], T, 300_000)).code === 0);
      if (!fetched) return chooseWorkspace({ ...facts, fetched });
      const ref = startRef(task, branchExists);
      const look = await sh(`cd ${sq(T)} || exit 1
git merge-base --is-ancestor ${sq(facts.marker.commit)} ${sq(`origin/${task.target}`)} 2>/dev/null && echo ancestor=yes || echo ancestor=no
if git cat-file -e ${sq(`${ref}^{commit}`)} 2>/dev/null; then echo start=yes; L=none
  for f in ${LOCKFILES.join(" ")}; do if git cat-file -e ${sq(ref)}:"$f" 2>/dev/null; then L=$(git cat-file blob ${sq(ref)}:"$f" | sha256sum | cut -c1-64); break; fi; done
  echo "lock=$L"; else echo start=no; fi`);
      const val = (k: string) => new RegExp(`^${k}=(.*)$`, "m").exec(look.stdout)?.[1]?.trim() ?? null;
      const choice = chooseWorkspace({ ...facts, fetched, ancestor: look.code === 0 ? val("ancestor") === "yes" : null, startFound: look.code === 0 ? val("start") === "yes" : null, startLockHash: val("lock") });
      if (choice.path === "clone") return choice;
      // Claim it (mkdir is atomic): a later run in this sandbox finds it used and clones.
      const claimed = await sh(`mkdir ${sq(`${T}/${TEMPLATE_CLAIM}`)} 2>/dev/null && printf %s ${sq(W)} > ${sq(`${T}/${TEMPLATE_CLAIM}/by`)} && echo claimed; true`);
      return claimed.stdout.includes("claimed") ? choice : chooseWorkspace({ ...facts, claimed: true });
    };
    const workspace: WorkspaceChoice | null = opts.warmTemplate ? await warmWorkspace() : null;
    const inPlace = workspace?.path === "in_place";
    if (inPlace) repo = T;
    else {
      must(await sh(`rm -rf ${sq(repo)}`), "clean");
      must(await git(["clone", "--no-tags", "--branch", task.target, task.repoUrl, repo], undefined, 300_000), "git clone");
      if (branchExists) must(await git(["fetch", "origin", `+refs/heads/${task.branch}:refs/remotes/origin/${task.branch}`], repo), "git fetch branch");
    }

    if (task.review) {
      must(await git(["checkout", "-q", "--detach", task.review.sha], repo), "git checkout (review)");
      // The tree verify's checks test: the change merged onto the target as verify found it (an ancestor of the tip the
      // clone has, or else fetched). A conflict fails the review: the checks report it too, and the verify fails on them.
      const on = task.review.targetSha;
      if (on) {
        if ((await git(["cat-file", "-e", `${on}^{commit}`], repo)).code !== 0) must(await git(["fetch", "--no-tags", "origin", on], repo, 300_000), "git fetch (review target)");
        const m = await git(["-c", "user.name=capcomd", "-c", "user.email=capcomd@users.noreply.github.com", "-c", "commit.gpgsign=false", "merge", "-q", "--no-edit", "-m", `capcomd review: ${task.review.branch} merged onto ${task.target}`, on], repo);
        if (m.code !== 0) {
          await git(["merge", "--abort"], repo).catch(() => {});
          throw new AgentError("git", `the change (${task.review.sha.slice(0, 12)}) conflicts with ${task.target} at ${on.slice(0, 12)}, so there is no merged tree to review: ${(m.stderr || m.stdout).trim().slice(-300)}`);
        }
        addSpanEvent(span, "agent.review_tree", { "git.sha": task.review.sha, "git.target_sha": on });
      }
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
    if (startFrom) must(await git(["fetch", "origin", task.from!.ref], repo), "git fetch (continue)");
    if (!task.review) must(await git(["checkout", "-B", task.branch, startRef(task, branchExists)], repo), "git checkout");
    // In place, the local branches are what a fresh clone has: the target at its tip, and the task branch. Its
    // dependencies are already there (env build installed them for this lockfile).
    const local = inPlace ? must(await sh(`cd ${sq(repo)} && git branch -f --track ${sq(task.target)} ${sq(`origin/${task.target}`)} >/dev/null && git for-each-ref --format='%(refname:short)' refs/heads/ | while read -r b; do [ "$b" = ${sq(task.target)} ] || [ "$b" = ${sq(task.branch)} ] || git branch -D -q "$b"; done; [ -d node_modules ] && echo reused; true`), "git branch (target)") : null;

    // Reuse dependencies baked into the env snapshot when the lockfile matches (capcomd env build): a clone copies them,
    // unless an earlier run in this sandbox used (and changed) the template.
    const deps = local ?? await sh(`L=; for f in ${LOCKFILES.join(" ")}; do [ -f ${sq(repo)}/$f ] && { L=$(sha256sum ${sq(repo)}/$f | cut -c1-64); break; }; done
H=$(cat ${sq(T)}/.capcomd-lockhash 2>/dev/null || cat ${sq(`${T}/${TEMPLATE_LOCKHASH}`)} 2>/dev/null)
if [ -n "$L" ] && [ -d ${sq(T)}/node_modules ] && [ "$H" = "$L" ] && [ ! -e ${sq(repo)}/node_modules ] && [ ! -e ${sq(`${T}/${TEMPLATE_CLAIM}`)} ]; then
  cp -a ${sq(T)}/node_modules ${sq(repo)}/node_modules && echo node_modules >> ${sq(repo)}/.git/info/exclude && echo reused; fi; true`);
    const depsReused = deps.stdout.includes("reused");
    if (depsReused) addSpanEvent(span, "agent.deps_reused", {});
    // How long the workspace took (clone or in place, deps included), and with a warm template which path was taken and
    // why: the agent's log and its span, not the user's output.
    const wsMs = now() - wsStarted;
    setSpanAttributes(span, { "agent.workspace_ms": wsMs });
    if (workspace) {
      const ms = wsMs;
      addSpanEvent(span, "agent.workspace", { "agent.workspace": workspace.path, ...(workspace.path === "clone" ? { "agent.workspace_reason": workspace.reason } : {}), "agent.workspace_ms": ms });
      setSpanAttributes(span, { "agent.workspace": workspace.path });
      opts.onLog?.([workspace.path === "in_place" ? `[capcomd] workspace: the env image's warm checkout, in place (${ms} ms)` : `[capcomd] workspace: a fresh clone, ${workspace.reason} (${ms} ms)`]);
    }

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
      // CAPCOMD_CHECKOUT: the agent's checkout, where `capcomd fetch` has the host fetch into.
      const src = sa.cliSource.replace(/^#!.*\n/, `#!/usr/bin/env node\nprocess.env.CAPCOMD_RPC_DIR ||= ${JSON.stringify(sa.rpcDir)};\nprocess.env.CAPCOMD_CHECKOUT ||= ${JSON.stringify(repo)};\n`);
      // boxd's file upload does not create parent dirs (fakes did, hiding this): make them first.
      must(await sh(`mkdir -p ${sq(`${sa.rpcDir}/bin`)} && chmod 700 ${sq(sa.rpcDir)}`), "mkdir capcomd rpc dir", "install");
      await provider.upload(vmId, cli, new TextEncoder().encode(src));
      const mcpConfig = `${W}/capcomd-mcp.json`;
      await provider.upload(vmId, mcpConfig, new TextEncoder().encode(JSON.stringify({ mcpServers: { capcomd: { command: "node", args: [cli, "mcp"], env: { CAPCOMD_RPC_DIR: sa.rpcDir } } } })));
      must(await sh(`chmod 755 ${sq(cli)}`), "install capcomd", "install");
      capcomdCtx = { cli, mcpConfig };
      capcomdPrelude = `export PATH=${sq(`${sa.rpcDir}/bin`)}:"$PATH" CAPCOMD_RPC_DIR=${sq(sa.rpcDir)}`;
      if (adapter.kind === "claude-code") {
        if (cfg.allowedTools) cfg = { ...cfg, allowedTools: [...cfg.allowedTools, "Bash(capcomd:*)", "mcp__capcomd"] };
        appendSystemFile = `${W}/append-system.txt`;
        await provider.upload(vmId, appendSystemFile, new TextEncoder().encode([cfg.appendSystemPrompt ? r.text(cfg.appendSystemPrompt) : "", sa.skill].filter(Boolean).join("\n\n")));
      } else promptText = [promptText, sa.skill].join("\n\n");
    } else if (opts.naming) {
      // agents.title: any other gets a `capcomd` that only names its tab, checked locally, no RPC (the daemon reads the
      // call from its tool calls below). Without node it still prints a line; the call is read all the same.
      const bin = `${W}/bin`, shim = `${bin}/capcomd-title.mjs`;
      must(await sh(`mkdir -p ${sq(bin)}`), "mkdir capcomd shim dir", "install");
      await provider.upload(vmId, shim, new TextEncoder().encode(opts.naming.shimSource));
      await provider.upload(vmId, `${bin}/capcomd`, new TextEncoder().encode(`#!/bin/sh\ncommand -v node >/dev/null 2>&1 || { echo "noted: $*"; exit 0; }\nexec node ${sq(shim)} "$@"\n`));
      must(await sh(`chmod 755 ${sq(`${bin}/capcomd`)}`), "install capcomd shim", "install");
      capcomdPrelude = `export PATH=${sq(bin)}:"$PATH"`;
      if (adapter.kind === "claude-code") {
        if (cfg.allowedTools) cfg = { ...cfg, allowedTools: [...cfg.allowedTools, "Bash(capcomd title:*)"] };
        appendSystemFile = `${W}/append-system.txt`;
        await provider.upload(vmId, appendSystemFile, new TextEncoder().encode([cfg.appendSystemPrompt ? r.text(cfg.appendSystemPrompt) : "", opts.naming.skill].filter(Boolean).join("\n\n")));
      } else promptText = [promptText, opts.naming.skill].join("\n\n");
    }
    await provider.upload(vmId, `${W}/prompt.txt`, new TextEncoder().encode(r.text(promptText)));
    const jsonl = `${W}/agent.jsonl`, errFile = `${W}/agent.err`, exitFile = `${W}/agent.exit`, pidFile = `${W}/agent.pid`, outbox = `${W}/outbox.jsonl`;
    // ADR-019 §1: the supervisor runs the agent and reports up through the outbox. It needs node, which the npm CLIs
    // bring; a VM without it (a native CLI) runs the agent directly, as before.
    const ckptRef = checkpointRef(task.agentId ?? `${task.runId}/${task.taskId}`);
    // A node that really runs code (≥16 for the supervisor's ESM): a stub or an old one would silently run nothing.
    const supervised = (await sh(`node -e 'process.stdout.write(+process.versions.node.split(".")[0] >= 16 ? "yes" : "no")' 2>/dev/null; true`)).stdout.trim() === "yes";
    // Messages sent to it while it runs reach it through the supervisor, when its CLI reads input as it goes.
    const streaming = supervised && !!adapter.streamInput && !task.review;
    // Plugin API §16.1: a planner or lead that sees everything and runs nothing; whatever it writes is never committed.
    const orchestrate = cfg.toolMode === "orchestrate";
    const inboxFile = `${W}/inbox.jsonl`;
    const agentLine = `${cfg.timeoutMs ? `timeout -k 10 ${Math.ceil(cfg.timeoutMs / 1000)} ` : ""}${adapter.command({ bin: bin!, repo, promptFile: `${W}/prompt.txt`, jsonl, errFile, dir: W, cfg, systemFile, appendSystemFile, ...(capcomdCtx ? { capcomd: capcomdCtx } : {}), ...(streaming ? { stdinPrompt: true } : {}) }, sq)}`;
    if (supervised) {
      await provider.upload(vmId, `${W}/agent.sh`, new TextEncoder().encode(`${agentLine}\n`));
      await provider.upload(vmId, `${W}/supervisor.mjs`, new TextEncoder().encode(SUPERVISOR_SOURCE));
      await provider.upload(vmId, `${W}/supervisor.json`, new TextEncoder().encode(JSON.stringify({
        script: `${W}/agent.sh`, dir: W, repo, jsonl, outbox, ref: ckptRef, agentId: task.agentId ?? task.taskId,
        heartbeatMs: opts.heartbeatMs ?? 30_000, checkpointEveryMs: task.review || task.report || orchestrate ? 0 : cfg.checkpointEveryMs,
        // §16.1: an orchestrate agent's checkout is never snapshotted (a checkpoint is a commit, pushed to its ref).
        ...(orchestrate ? { checkpoints: false } : {}),
        ...(cfg.noChangeAfterMs ? { reportTree: true } : {}),
        ...(streaming ? { input: { prompt: `${W}/prompt.txt`, inbox: inboxFile } } : {}),
      })));
    }
    setSpanAttributes(span, { "agent.supervised": supervised, "agent.reads_messages": streaming });
    const script = [
      "#!/bin/sh",
      `cd ${sq(repo)} || exit 97`,
      `echo $$ > ${sq(pidFile)}`,
      ...(prelude ? [prelude] : []),
      ...(capcomdPrelude ? [capcomdPrelude] : []),
      supervised ? `node ${sq(`${W}/supervisor.mjs`)} ${sq(`${W}/supervisor.json`)}` : agentLine,
      `echo $? > ${sq(exitFile)}`,
    ].join("\n");
    await provider.upload(vmId, `${W}/run.sh`, new TextEncoder().encode(script + "\n"));
    // The credential exists only in this exec's env (inherited by the agent). Never logged.
    must(await sh(`rm -f ${sq(exitFile)} ${sq(jsonl)} ${sq(outbox)} ${sq(inboxFile)} ${sq(`${W}/checkpoint.request`)}; chmod +x ${sq(`${W}/run.sh`)}; setsid nohup ${sq(`${W}/run.sh`)} > /dev/null 2>&1 < /dev/null & echo started`,
      { ...adapter.baseEnv(), ...(credential ? adapter.credentialEnv(credential) : {}) }), `start ${name}`, "failed");

    const kill = async () => { await sh(`p=$(cat ${sq(pidFile)} 2>/dev/null) && kill -TERM -"$p" 2>/dev/null; sleep 1; [ -n "$p" ] && kill -KILL -"$p" 2>/dev/null; true`).catch(() => {}); };
    const deadline = cfg.timeoutMs ? now() + cfg.timeoutMs + 30_000 : Infinity;
    const state: AgentRunState = { events: 0, turns: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, done: false };
    live = state;
    const logLines: string[] = [];
    // The thread: parsed once here (markdown → blocks, links classified against the checkout), stored by the scope.
    // Ids are unique per agent and per run of it, so a re-run never overwrites an earlier run's items.
    const items = new Map<string, ItemDraft>(), images: ThreadAttachment[] = [];
    const thread = opts.onItems ? threadBuilder({
      cli: adapter.kind === "codex" ? "codex" : "claude", idPrefix: `itm-${task.agentId ?? `${task.taskId}-e${task.epoch}`}-${now().toString(36)}`, now,
      link: { root: repo }, onImage: (img) => images.push({ id: img.id, sha256: img.sha256, bytes: img.bytes, mime: img.mime, base64: img.base64 }),
    }) : null;
    const flushItems = () => { if (items.size || images.length) { opts.onItems?.([...items.values()], images.splice(0)); items.clear(); } };
    const namedCalls = new Set<string>();
    let lastTitle: string | null = null;
    let consumed = 0, outConsumed = 0, errConsumed = 0, beatEvents = 0, exitCode: number | null = null, renewedAt = 0, spendAt = now();
    // ADR-019 §2: stuck signals from what the agent does. Not a time limit: an agent may work for hours.
    const watch = new StuckWatch({ idleAfterMs: cfg.idleAfterMs, repeats: cfg.stuckRepeats, stopIdle: cfg.stopIdle, stopRepeats: cfg.stopStuck, noChangeAfterMs: cfg.noChangeAfterMs }, now());
    let noticed: string | null = null, grantSeen = 0, spendStep = 0, inboxSeq = 0;
    // The supervisor takes it at its next heartbeat; reviewers and reporting agents don't checkpoint.
    const requestCheckpoint = async (reason: string) => {
      if (supervised && !task.review && !task.report && !orchestrate) await sh(`printf %s ${sq(reason)} > ${sq(`${W}/checkpoint.request`)}`).catch(() => {});
    };
    // Plugin API §16.1: what an orchestrate agent changed in its checkout (it may change nothing): files, and commits on
    // no remote branch. Looked at when a turn ends (its CLI's result) and when it ends.
    let turnEnded = false;
    let wrote: OrchestrateWrites | null = null;
    const orchestrateChanges = async (at: OrchestrateWrites["at"]): Promise<OrchestrateWrites | null> => {
      const st = await git(["status", "--porcelain", "--untracked-files=all"], repo).catch(() => null);
      const files = st?.code === 0 ? st.stdout.split("\n").filter((l) => l.trim()).map((l) => l.slice(3).replace(/^"(.*)"$/, "$1")) : [];
      const rl = await git(["rev-list", "--count", "HEAD", "--not", "--remotes"], repo).catch(() => null);
      const commits = rl?.code === 0 ? Number(rl.stdout.trim()) || 0 : 0;
      return files.length || commits ? { files: files.slice(0, 50).map((f) => r.text(f).slice(0, 300)), total: files.length, commits, at } : null;
    };
    const startedAt = now();
    // A limit ends the run but keeps the work: it is committed and pushed below (Capcomd-Stop trailer) and the
    // caller stops the agent instead of retrying it, so hours of work aren't redone or lost at a cap.
    let limit: string | null = null;
    // A checkpoint the supervisor made in the VM is pushed from here: the agent holds no push credentials.
    const pushCheckpoint = async (c: { sha: string; reason: string; files: number }) => {
      if (orchestrate) return; // never pushed (the supervisor makes none for it either)
      const res = await git(["push", "--force", "--porcelain", "origin", `${c.sha}:${ckptRef}`], repo, 300_000).catch((e) => ({ code: 1, stdout: "", stderr: String(e) }));
      addSpanEvent(span, "agent.checkpoint", { "git.sha": c.sha, "agent.checkpoint_reason": c.reason, "agent.checkpoint_files": c.files, ...(res.code ? { "agent.checkpoint_error": r.text(res.stderr).slice(-300) } : {}) });
      if (!res.code) opts.onReport?.({ type: "checkpoint", sha: c.sha, ref: ckptRef, reason: c.reason, files: c.files });
    };
    const drain = async (final: boolean) => {
      // A CLI that reports refusals only on stderr (adapter.refusal): its new stderr lines too.
      const errTail = adapter.refusal ? `printf '\\n__CAPCOMD_ERR__\\n'; tail -n +${errConsumed + 1} ${sq(errFile)} 2>/dev/null | head -n 2000; ` : "";
      const res = await sh(`tail -n +${consumed + 1} ${sq(jsonl)} 2>/dev/null; printf '\\n__CAPCOMD_OUTBOX__\\n'; tail -n +${outConsumed + 1} ${sq(outbox)} 2>/dev/null; ${errTail}printf '\\n__CAPCOMD_EXIT__%s' "$(cat ${sq(exitFile)} 2>/dev/null)"`);
      const [rest0, exitPart] = res.stdout.split("\n__CAPCOMD_EXIT__");
      const [rest, errPart] = adapter.refusal ? (rest0 ?? "").split("\n__CAPCOMD_ERR__\n") : [rest0, undefined];
      const [body, outPart] = (rest ?? "").split("\n__CAPCOMD_OUTBOX__\n");
      if (errPart !== undefined) {
        const errLines = errPart.split("\n");
        // Complete lines only: the last one may still be being written (read next time), unless the run is over.
        if (!final && !errPart.endsWith("\n")) errLines.pop(); else if (errLines[errLines.length - 1] === "") errLines.pop();
        errConsumed += errLines.length;
        for (const l of errLines) {
          const ref = adapter.refusal!(l, r);
          if (!ref) continue;
          addSpanEvent(span, "agent.refused", { "agent.tool": ref.call.slice(0, 300), "agent.text": ref.reason });
          logLines.push(`refused ${cutLine(ref.call, 300)}: ${cutLine(ref.reason, 300)}`);
        }
      }
      // The supervisor's reports: complete lines only (a line still being written is read next time).
      let ckpt: { sha: string; reason: string; files: number } | null = null;
      for (const line of (outPart ?? "").split("\n")) {
        if (!line.trim()) continue;
        let rep: any;
        try { rep = JSON.parse(line); } catch { break; }
        outConsumed++;
        // Its start is a heartbeat too: the first interval hasn't passed yet.
        if (rep.type === "heartbeat" || rep.type === "start") opts.onReport?.({ type: "heartbeat", events: Number(rep.events ?? 0), lastEventAt: Number(rep.lastEventAt ?? now()), source: "supervisor" });
        if (rep.type === "heartbeat" && typeof rep.tree === "string") watch.observeTree(rep.tree, now());
        if (rep.type === "checkpoint" && typeof rep.sha === "string") ckpt = { sha: rep.sha, reason: String(rep.reason ?? ""), files: Number(rep.files ?? 0) };
        else if (rep.type === "delivered") addSpanEvent(span, "agent.message_delivered", { "agent.message_seq": Number(rep.seq ?? 0) });
        else if (rep.type === "error" || rep.type === "start" || rep.type === "exit") addSpanEvent(span, `agent.supervisor.${rep.type}`, { ...(rep.message ? { "agent.text": r.text(String(rep.message)) } : {}), ...(rep.code !== undefined ? { "agent.exit_code": rep.code } : {}) });
      }
      if (ckpt) await pushCheckpoint(ckpt);
      const lines = (body ?? "").split("\n");
      if (lines[lines.length - 1] === "") lines.pop();
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (!line.trim()) { consumed++; continue; }
        const ev = adapter.parse(line, r, state, cfg);
        if (!ev) { if (i === lines.length - 1 && !final) break; consumed++; continue; }
        consumed++; state.events++;
        watch.observe(ev, now());
        addSpanEvent(span, `agent.${ev.type}${ev.subtype ? `.${ev.subtype}` : ""}`, {
          ...(ev.tool ? { "agent.tool": ev.tool } : {}), ...(ev.text ? { "agent.text": ev.text } : {}),
        });
        opts.onEvent?.(ev);
        // agents.title: `capcomd title …` by itself names its tab (the shim only checked it).
        for (const n of namingCalls(ev.raw)) if (!namedCalls.has(n.callId)) { namedCalls.add(n.callId); lastTitle = n.title; opts.onTitle?.(n); }
        logLines.push(...logLinesOf(ev));
        if (thread) for (const d of thread.event(ev.raw)) items.set(d.id, d);
        if (orchestrate && TURN_ENDS.has(ev.type)) turnEnded = true;
      }
      if (logLines.length) { opts.onLog?.(logLines.splice(0)); }
      if (thread && final) for (const d of thread.finish()) items.set(d.id, d);
      flushItems();
      // The agent CLI's own events are a heartbeat too (PR #3's path, the only one without a supervisor): any sign of
      // life counts, so the supervisor's start-up and first interval don't open a gap.
      if (state.events > beatEvents) { beatEvents = state.events; opts.onReport?.({ type: "heartbeat", events: state.events, lastEventAt: now(), source: "events" }); }
      const code = (exitPart ?? "").trim();
      if (code !== "") exitCode = Number(code);
    };
    // While the sandbox provider doesn't answer (an outage), the agent keeps working in its VM: the runner keeps
    // looking, for up to the outage window, instead of failing it (src/providers/resilient.ts).
    let outageSince = 0;
    while (exitCode === null) {
      // The VM's delete deadline is a lease: renewed while the agent runs, so no fixed lifetime cuts long work short.
      if (provider.extendTtl && now() - renewedAt > TTL_RENEW_MS) {
        renewedAt = now();
        const ttl = opts.vmTtlSeconds ?? AGENT_VM_TTL_SECONDS;
        // A renewal the provider didn't answer is tried again in a minute (the deadline it moves is 15+ minutes away).
        await provider.extendTtl(vmId, ttl).then(() => opts.onRenew?.(ttl), () => { renewedAt = now() - TTL_RENEW_MS + 60_000; });
      }
      await new Promise((res) => setTimeout(res, cfg.pollMs));
      const looked = Date.now();
      try {
        await drain(false);
        if (outageSince) { outageSince = 0; reportOutage(null); addSpanEvent(span, "agent.sandbox_answered"); }
      } catch (e) {
        if (!isTransientSandboxError(e)) throw e;
        const t = Date.now(), windowMs = outageWindowMs(), msg = r.text(String((e as Error)?.message ?? e)).slice(0, 300);
        if (!outageSince) {
          outageSince = looked;
          addSpanEvent(span, "agent.sandbox_outage", { "agent.text": msg });
          reportOutage({ since: looked, what: "exec", error: msg, windowMs, provider: providerLabel(provider) });
        }
        if (t - outageSince >= windowMs) throw unreachable(providerLabel(provider), "exec", t - outageSince, msg, vmId);
        if (opts.isCancelled && (await opts.isCancelled().catch(() => false))) {
          await kill();
          addSpanEvent(span, "agent.cancelled");
          throw new AgentError("cancelled", `${name} cancelled for ${key}`);
        }
        await new Promise((res) => setTimeout(res, Math.min(5000, Math.max(cfg.pollMs, windowMs / 20))));
        continue;
      }
      if (exitCode !== null) break;
      // §16.1: an orchestrate agent that wrote something in the turn that just ended is stopped there (it fails below).
      if (turnEnded) {
        turnEnded = false;
        wrote = await orchestrateChanges("turn");
        if (wrote) { await kill(); await drain(true); break; }
      }
      // The provider's usage limit: retrying now only hits it again, so stop and keep the work (the agent is paused).
      if (state.quota) {
        await kill(); await drain(true);
        limit = "quota";
        break;
      }
      const guard = adapter.guard(state, cfg);
      if (guard) {
        await kill(); await drain(true);
        addSpanEvent(span, "agent.guard", { reason: guard });
        limit = guard.split(" ")[0]!;
        break;
      }
      // A budget is enforced by the engine from live spend (its own, an ancestor's or the run's), for every provider.
      if (opts.onSpend && now() - spendAt >= (opts.spendEveryMs ?? SPEND_REPORT_MS)) {
        spendAt = now();
        const usd = credentialMode === "subscription" ? 0 : Math.round(state.costUsd * 1e6) / 1e6;
        const rep = await opts.onSpend({ usd, turns: state.turns, wallSeconds: Math.round((now() - startedAt) / 1000) }, streaming ? inboxSeq : undefined).catch(() => null);
        // Messages sent to it since the last report: into the VM, where the supervisor hands them to the CLI. A
        // message means someone looked at the agent: its stuck window starts again (ADR-019 §2).
        const msgs = (rep?.messages ?? []).filter((m) => m.seq > inboxSeq);
        if (msgs.length) {
          const lines = msgs.map((m) => JSON.stringify({ seq: m.seq, text: messageText(m) })).join("\n") + "\n";
          // A long one (a big body, attached skills) goes up as a file: a shell argument can't hold it (128 KB on Linux).
          const part = `${inboxFile}.part`;
          const put = Buffer.byteLength(lines) <= INLINE_APPEND_MAX
            ? await sh(`printf %s ${sq(lines)} >> ${sq(inboxFile)}`).catch(() => null)
            : await provider.upload(vmId, part, new TextEncoder().encode(lines)).then(() => sh(`cat ${sq(part)} >> ${sq(inboxFile)} && rm -f ${sq(part)}`)).catch(() => null);
          if (put && !put.code) {
            inboxSeq = Math.max(...msgs.map((m) => m.seq));
            watch.reset(now());
            addSpanEvent(span, "agent.message", { "agent.messages": msgs.length, "agent.message_seq": inboxSeq });
          }
        }
        // A parent that gives more budget has looked at the agent: its stuck window starts again (ADR-019 §2).
        if (rep?.grantedAt && rep.grantedAt > grantSeen) {
          grantSeen = rep.grantedAt;
          watch.reset(now());
          addSpanEvent(span, "agent.granted");
        }
        // A checkpoint each time spend passes another quarter of its tightest budget (ADR-019 §3), so a budget stop
        // loses little work. A grant lowers the step, and passing it again checkpoints again.
        const step = rep?.used != null ? Math.min(3, Math.floor(rep.used * 4)) : 0;
        if (step > spendStep) await requestCheckpoint("spend");
        spendStep = step;
        const stop = rep?.stop;
        if (stop) {
          await kill(); await drain(true);
          addSpanEvent(span, "agent.budget", { reason: stop, "agent.cost_usd": usd });
          limit = stop;
          break;
        }
      }
      if (opts.isCancelled && (await opts.isCancelled().catch(() => false))) {
        await kill(); await drain(true);
        addSpanEvent(span, "agent.cancelled");
        throw new AgentError("cancelled", `${name} cancelled for ${key}`);
      }
      // The operator's pause: a stop that keeps the work (committed and pushed below); the agent resumes from it.
      if (opts.isPaused && (await opts.isPaused().catch(() => false))) {
        await kill(); await drain(true);
        addSpanEvent(span, "agent.paused");
        limit = "paused";
        break;
      }
      if (now() > deadline) {
        await kill(); await drain(true);
        limit = "timeout";
        break;
      }
      // A notice first (the parent hears it; the supervisor checkpoints the work); a stop after the second window only
      // when the profile set that window (no limits by default).
      const stuck = watch.check(now());
      if ((stuck?.kind ?? null) !== noticed) {
        noticed = stuck?.kind ?? null;
        addSpanEvent(span, stuck ? "agent.notice" : "agent.notice_cleared", stuck ? { "agent.notice": stuck.kind, "agent.text": stuck.detail } : {});
        opts.onNotice?.(stuck ? { kind: stuck.kind, detail: stuck.detail } : null);
        if (stuck) await requestCheckpoint("notice");
      }
      if (stuck?.stop) {
        await kill(); await drain(true);
        addSpanEvent(span, `agent.${stuck.kind}`, { "agent.text": stuck.detail });
        limit = stuck.kind;
        break;
      }
    }
    await drain(true);

    const out = adapter.outcome(state, exitCode ?? -1);
    limit ??= state.quota ? "quota" : LIMIT_STOPS[out.stopReason] ?? null;
    const resetAt = limit === "quota" && state.quota?.resetAt ? { resetAt: state.quota.resetAt } : {};
    if (limit === "quota") addSpanEvent(span, "agent.quota", { "agent.quota_message": r.text(state.quota?.message ?? ""), ...(state.quota?.resetAt ? { "agent.quota_reset_at": state.quota.resetAt } : {}) });
    const billing = credentialMode === "subscription" ? "subscription" : "api";
    const notionalCostUsd = state.costUsd;
    const costUsd = billing === "subscription" ? 0 : state.costUsd;
    const { turns } = state;
    setSpanAttributes(span, { "agent.billing": billing, "agent.notional_cost_usd": notionalCostUsd });
    setSpanAttributes(span, { "agent.exit_code": exitCode, "agent.cost_usd": costUsd, "agent.turns": turns, "agent.stop_reason": limit ?? out.stopReason, "agent.events": state.events, "gen_ai.response.cost": costUsd, "gen_ai.usage.input_tokens": state.inputTokens, "gen_ai.usage.output_tokens": state.outputTokens });
    if (limit) addSpanEvent(span, "agent.limit", { reason: limit });
    // §16.1: what an orchestrate agent wrote ends it failed whatever else happened (stopped at a turn's end, a limit, an
    // error of its CLI): that is the reason it gives.
    if (orchestrate) wrote ??= await orchestrateChanges("end");
    if (!limit && !out.ok && !wrote) {
      const err = await sh(`tail -c 2000 ${sq(errFile)} 2>/dev/null`);
      throw new AgentError("failed", `${name} stopped (${out.stopReason}, exit ${exitCode}) for ${key}: ${r.text(state.error ?? "")} ${r.text(err.stdout).slice(-800)}`.trim());
    }

    // A reviewer or a reporting agent only answers: nothing it changed is committed or pushed.
    if (task.review || task.report) {
      if (limit === "quota" || limit === "paused") return { sha: "", already: false, costUsd, turns, stopReason: limit, events: state.events, credentialMode, agentVersion: version, billing, notionalCostUsd, limit, ...resetAt };
      if (limit) throw new AgentError("limit", `${name} ${stoppedAt(limit)} for ${key} before answering`);
      setSpanAttributes(span, task.review ? { "agent.review": true } : { "agent.report": true });
      return { sha: "", already: false, costUsd, turns, stopReason: out.stopReason, events: state.events, credentialMode, agentVersion: version, billing, notionalCostUsd, resultText: r.text(state.resultText ?? "").slice(-(task.report ? 8000 : 4000)) };
    }

    // Plugin API §16.1: an orchestrate agent's work is its children's branches; it has none of its own to push.
    if (cfg.toolMode === "orchestrate") {
      setSpanAttributes(span, { "agent.no_changes": true, "agent.tool_mode": "orchestrate" });
      // What it changed anyway (a CLI whose rules a shell trick gets past: codex and `echo x > f`) fails it: the agent
      // is told nothing landed and why, its changes stay in its checkout, never committed or pushed, and its log and
      // trace say which files.
      const resultText = r.text(state.resultText ?? "").slice(-4000);
      if (wrote) {
        const what = orchestrateWritesText(wrote);
        addSpanEvent(span, "agent.orchestrate_discarded", { "agent.text": r.text(what), "agent.discarded_files": wrote.total, "agent.discarded_commits": wrote.commits, "agent.orchestrate_failed": true, "agent.orchestrate_at": wrote.at });
        setSpanAttributes(span, { "agent.orchestrate_wrote": true });
        opts.onLog?.([`[capcomd] orchestrate: it ${what}${wrote.at === "turn" ? " in a turn, so it was stopped there" : ""}; an orchestrate agent writes nothing, so it fails (its changes are discarded, never committed or pushed)`]);
        return { sha: "", already: false, costUsd, turns, stopReason: "orchestrate_wrote_files", events: state.events, credentialMode, agentVersion: version, billing, notionalCostUsd, ...(resultText ? { resultText } : {}), orchestrateWrites: wrote };
      }
      return { sha: "", already: false, costUsd, turns, stopReason: limit ?? out.stopReason, events: state.events, credentialMode, agentVersion: version, billing, notionalCostUsd, ...(resultText ? { resultText } : {}), ...(limit ? { limit } : {}), ...resetAt };
    }

    // 5. Commit with capcomd trailers and push the task branch.
    must(await git(["add", "-A"], repo), "git add");
    const status = await git(["status", "--porcelain"], repo);
    const ahead = await git(["rev-list", "--count", `origin/${task.target}..HEAD`], repo);
    if (!status.stdout.trim() && Number(ahead.stdout.trim()) === 0) {
      // ADR-017: an orchestrator's work is its children's branches; finishing without edits is fine. A paused agent
      // (quota, or the operator's pause) has nothing to keep yet either: it starts over when it resumes.
      if (opts.subagents || limit === "quota" || limit === "paused") { setSpanAttributes(span, { "agent.no_changes": true }); return { sha: "", already: false, costUsd, turns, stopReason: limit ?? out.stopReason, events: state.events, credentialMode, agentVersion: version, billing, notionalCostUsd, ...(limit ? { limit } : {}), ...resetAt }; }
      if (limit) throw new AgentError("limit", `${name} ${stoppedAt(limit)} for ${key} before changing anything`);
      throw new AgentError("no_changes", `${name} made no changes for ${key} (${out.stopReason})`);
    }
    // At a limit the stop is always recorded in a commit (empty if the agent committed everything itself), so a replay sees it.
    if (status.stdout.trim() || limit) {
      // The agent's own words for the change: its last commit's subject (not capcomd's), else its summary or title.
      const own = (await git(["log", "-1", "--format=%s", "--invert-grep", "--grep=^Capcomd-Task: ", `origin/${task.target}..HEAD`], repo)).stdout.trim();
      const subject = `${limit ? `WIP (stopped: ${limit}) ` : ""}${commitSubject(subjectFor({ own, summary: limit ? null : r.text(state.resultText ?? ""), title: lastTitle ?? task.title ?? null, goal: task.goal }))}`;
      const msg = `${subject}\n\n${r.text(state.resultText ?? "").slice(0, 1500)}\n\nCapcomd-Task: ${key}\nCapcomd-Epoch: ${task.epoch}\nCapcomd-Agent: ${name}@${version}\n${limit ? `Capcomd-Stop: ${limit}\n` : ""}`;
      await provider.upload(vmId, `${W}/commit-msg.txt`, new TextEncoder().encode(msg));
      must(await git(["-c", "user.name=capcomd", "-c", "user.email=capcomd@users.noreply.github.com", "commit", ...(limit ? ["--allow-empty"] : []), "-F", `${W}/commit-msg.txt`], repo), "git commit");
    }
    const sha = must(await git(["rev-parse", "HEAD"], repo), "rev-parse").stdout.trim();
    const lease = branchExists ? `--force-with-lease=refs/heads/${task.branch}` : `--force-with-lease=refs/heads/${task.branch}:`;
    must(await git(["push", "--porcelain", lease, "origin", `HEAD:refs/heads/${task.branch}`], repo, 300_000), "git push");
    setSpanAttributes(span, { "git.sha": sha });
    return { sha, already: false, costUsd, turns, stopReason: limit ?? out.stopReason, events: state.events, credentialMode, agentVersion: version, billing, notionalCostUsd, ...(limit ? { limit } : {}), ...resetAt };
  } catch (err) {
    // An agent cancelled mid-step (its machine destroyed under it, so a command failed before the cancel was seen) was
    // cancelled, not an error: said so in its trace, which the TUI and the apps read.
    let e = err;
    if (!(e instanceof AgentError) && opts.isCancelled && (await opts.isCancelled().catch(() => false))) {
      addSpanEvent(span, "agent.cancelled");
      e = new AgentError("cancelled", `${name} cancelled for ${key}`);
    }
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
