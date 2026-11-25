// ADR-026 §5: waking an idle agent, fastest path first, never a dead end. An agent whose last attempt ended (done,
// failed, cancelled) is idle, not gone: a message to it starts its next attempt (src/actors/scope.ts `continueTx`), and
// that attempt picks up the same conversation:
//
//   1. warm      the CLI is still alive with its input open: the message is its next turn (phase 1, the runner's
//                mailbox). An idle agent has no live CLI, so a continued attempt starts at 2.
//   2. parked    its machine was hibernated when its turn ended (a planner or lead, ADR-026 §6): `parkedMachine` finds
//                it, the attempt's worker wakes it (src/actors/worker.ts `takeParked`, by the key recorded when it was
//                parked), and the CLI resumes its session there: the checkout and the session file are already in it,
//                so nothing is restored. A machine that is gone or won't wake: one line in its log, and path 3.
//   3. fresh     a new machine from the project's template, the agent's branch (or checkpoint) at its stable checkout
//                path (`${workdir}/<agentId>/repo`), its saved CLI session restored under that path (src/sessions `restoreSession`),
//                and the CLI resumed (`--resume <id>`) with the waking message as its first user turn.
//   4. thread    the session can't be resumed (none saved, a CLI too far apart, a corrupt file): a new session whose
//                prompt is built from the thread (bounded, newest first, the full last hand-back), and one quiet line
//                in the thread saying so.
//
// The system prompt of a resumed session is frozen at its first run, so what changed always arrives as the user turn.
import type { AttachedSkill } from "./skills";
import { messageText } from "./runner";

/** A message the continued attempt starts with (after the agent's durable delivery cursor). */
export type ContinueMessage = { seq: number; from: string; body: string; skills?: AttachedSkill[]; at?: number };
/** A thread item as the scope stores it (the fields a prompt reads). */
export type ContinueItem = {
  kind: string; text: string; at?: string; tool?: { name?: string; summary?: string } | null; child?: { agentId?: string; status?: string } | null;
  /** Kind question (ADR-026 §4): the question and what became of it. */
  question?: {
    asker?: string; state?: string; question?: string; options?: Array<{ label?: string; recommended?: boolean }>; answer?: string | null; recommended?: boolean | null;
    by?: string | null; note?: string | null; to?: string | null; passedBy?: string[]; replaces?: string | null;
  } | null;
};
/** What the scope gives a continued attempt (scope action `continuation`). */
export interface Continuation {
  task: string;
  /** Its last attempt's result (agent.done / agent.failed): its last hand-back. */
  result: Record<string, unknown> | null;
  /** The messages after its cursor: the one that woke it first. */
  messages: ContinueMessage[];
  /** Messages it had already read, newest first. */
  earlier: ContinueMessage[];
  /** Its thread, newest first. */
  items: ContinueItem[];
}

/** What the worker gives the runner for a continued attempt: the scope's record, the session store, the thread note. */
export interface ContinueHooks {
  load(): Promise<Continuation | null>;
  /** §5 path 3: put its saved session in the machine where its CLI looks for `cwd`; null when there is none to resume. */
  restore(o: { home: string; cwd: string }): Promise<{ sessionId: string; cli: "claude" | "codex" } | null>;
  /** §5 path 4: the one quiet line in its thread. */
  pickedUpFromThread(): Promise<void>;
  /** §5 path 2: the attempt runs on the agent's parked machine, woken: its session is looked for there first, and no
   *  "restoring the conversation" phase is shown. */
  parked?: boolean;
}

/** The thread line of §5 path 4 (the app shows it as a muted divider). */
export const PICKED_UP_TEXT = "Picked up from the thread: the earlier session couldn't be resumed.";

/** The bytes a thread prompt holds at most (the task and the last hand-back first, then the newest items that fit). */
export const THREAD_PROMPT_MAX_BYTES = 48 * 1024;
const LINE_MAX = 300;
const TASK_MAX = 12 * 1024;
const LAST_MAX = 12 * 1024;

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const one = (s: string) => cut(s.replace(/\s+/g, " ").trim(), LINE_MAX);

/** An agent's parked machine (ADR-026 §6), as the machines ledger records it when its worker parks it. */
export interface Parked {
  /** The machine's idempotency key (its name at the provider is derived from it): carried across attempts. */
  machineKey: string;
  /** Its name at the provider (capcomd's prefix + a hash of the key). */
  name: string;
  vmId: string;
  /** The place it is on. */
  sandbox: string;
  /** The worker that parked it (it hands it over to the next attempt's). */
  workerKey: string[];
  at: number;
  deleteAt: number;
}

/**
 * ADR-026 §5 path 2: the agent's parked (hibernated) machine, to wake instead of making a new one; null when it has none
 * (it was never parked, or it was deleted: its retention ran out, its run was archived, it was cancelled, the user
 * deleted it). From the machines ledger (src/providers/machines.ts), which the worker writes when it parks it.
 */
export async function parkedMachine(runId: string, agentId: string): Promise<Parked | null> {
  const { parkedMachines } = await import("../providers/machines");
  const m = parkedMachines({ runId, agentId }).filter((x) => x.parked.deleteAt > Date.now()).at(-1);
  return m ? { machineKey: m.parked.idemKey, name: m.name, vmId: m.parked.vmId, sandbox: m.sandbox, workerKey: [...m.workerKey], at: m.parked.at, deleteAt: m.parked.deleteAt } : null;
}

/** The waking message(s) as the first user turn of a resumed session (§5 path 3): what changed, in capcomd's words. */
export function wakePrompt(messages: ContinueMessage[]): string {
  if (!messages.length) return "Continue.";
  return messages.map((m) => messageText({ from: m.from, body: m.body, ...(m.skills?.length ? { skills: m.skills } : {}) })).join("\n\n---\n\n");
}

/** Who answered, as the asker reads it in its rebuilt thread. */
const answerer = (by: string) => (/^(agt-|wake-|job-|capcomd)/.test(by) ? by : "the user");

/**
 * A question (kind question) as the prompt says it: the agent's own, or another agent's that reached it (asked of it,
 * passed up by it, answered by it, or the user's while it is the root).
 */
function questionLine(q: NonNullable<ContinueItem["question"]>, self: string): string {
  const rec = q.options?.find((o) => o.recommended)?.label;
  if (q.asker && q.asker !== self) {
    const passed = q.passedBy ?? [];
    const ofSelf = passed.includes(self) || q.to === self;
    const head = `${q.asker} asked ${ofSelf ? "you" : q.to ? q.to : "the user"}: ${one(q.question ?? "")}${rec ? ` (they recommended: ${one(rec)})` : ""}`;
    if (q.state === "answered") {
      const who = q.by === self ? "you" : answerer(q.by ?? "");
      return `${head}; ${who} answered: ${one(q.answer ?? "")}${q.note ? ` (${q.by === self ? "your" : "their"} note: ${one(q.note)})` : ""}${q.replaces === self ? " (it replaced your answer)" : ""}`;
    }
    if (q.state === "withdrawn") return `${head}; the question was withdrawn (${q.asker} was cancelled)`;
    if (q.to === self) return `${head}; not answered yet`;
    return `${head}; ${passed.includes(self) ? "you passed it up" : "it was passed up"} to ${q.to ?? "the user"}, not answered yet`;
  }
  const asked = `you asked: ${one(q.question ?? "")}${rec ? ` (you recommended: ${one(rec)})` : ""}`;
  if (q.state === "answered") return `${asked}; ${answerer(q.by ?? "")} answered: ${one(q.answer ?? "")}${q.recommended === false ? " (not your recommendation)" : ""}${q.note ? `; their note: ${one(q.note)}` : ""}`;
  if (q.state === "withdrawn") return `${asked}; the question was withdrawn`;
  return `${asked}; not answered yet`;
}

/** One line of the thread for the prompt, or null for one that says nothing (thinking, an empty item). */
function itemLine(it: ContinueItem, self: string): string | null {
  const text = one(it.text ?? "");
  switch (it.kind) {
    case "question": return it.question ? questionLine(it.question, self) : text || null;
    case "say": case "result": return text ? `you said: ${text}` : null;
    case "tool": return `you ran ${one(it.tool?.name ?? "a tool")}: ${one(it.tool?.summary ?? text)}`;
    case "handoff": return `${it.child?.agentId ?? "a child"} handed back (${it.child?.status ?? "done"}): ${text}`;
    case "error": return text ? `error: ${text}` : null;
    case "plan": return text ? `your plan: ${text}` : null;
    case "note": return text ? `capcomd: ${text}` : null;
    case "thinking": return null;
    default: return text ? text : null;
  }
}

/**
 * §5 path 4: the prompt of a fresh session that continues an agent from its thread. Bounded: its task, its last
 * hand-back in full (each capped), then the thread newest first (messages it read and its items, one line each) until
 * the cap, then the new message(s) it is woken with, in full, last.
 */
export function threadPrompt(o: { agentId: string; branch: string; target: string; report?: boolean }, c: Continuation): string {
  const enc = new TextEncoder();
  const head: string[] = [
    `You are agent ${o.agentId}, continuing your earlier work in this run. Your earlier session couldn't be resumed, so this is the thread so far, rebuilt by capcomd.`,
    o.report ? `You are in a read-only checkout of the repository at ${o.target}.` : `You are in a git checkout of the repository on branch ${o.branch} (based on ${o.target}), with your work so far on it (see \`git log\` and \`git diff ${o.target}\`).`,
    "",
    "Your task, as you were first given it:",
    cut(c.task, TASK_MAX),
  ];
  const r = c.result ?? {};
  const last = [r.summary, r.report, r.error].find((x): x is string => typeof x === "string" && !!x.trim());
  if (last) head.push("", "Your last hand-back, in full:", cut(last, LAST_MAX));
  const tail: string[] = ["", c.messages.length > 1 ? "The new messages, which this turn answers:" : "The new message, which this turn answers:", wakePrompt(c.messages)];
  const rules = ["", "Rules:", "- Continue from where you were: don't redo work that is already on the branch or already landed.", "- Do not commit, push, or change git remotes; capcomd commits and pushes your working tree.", "- Do not print environment variables or credentials."];
  let budget = THREAD_PROMPT_MAX_BYTES - enc.encode([...head, ...tail, ...rules].join("\n")).length;
  // The thread, newest first: messages it had read and its items, merged by time.
  const timed: Array<{ at: number; line: string }> = [];
  for (const m of c.earlier) timed.push({ at: m.at ?? 0, line: `${m.from === "operator" || m.from === "driver" ? "the operator" : m.from.startsWith("wake-") ? "a wake-up" : m.from} wrote: ${one(m.body)}` });
  for (const it of c.items) { const line = itemLine(it, o.agentId); if (line) timed.push({ at: it.at ? Date.parse(it.at) || 0 : 0, line }); }
  timed.sort((a, b) => b.at - a.at);
  const lines: string[] = [];
  for (const t of timed) {
    const l = `- ${t.line}`;
    const n = enc.encode(l).length + 1;
    if (n > budget) { lines.push("- … (older thread left out)"); break; }
    budget -= n;
    lines.push(l);
  }
  const thread = lines.length ? ["", "The thread, newest first:", ...lines] : [];
  return [...head, ...thread, ...tail, ...rules].join("\n");
}
