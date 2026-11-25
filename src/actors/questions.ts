// ADR-026 §4: ask and stop. An agent that needs a decision asks (`capcomd ask "<question>" --recommend "<answer>"`), and
// its turn ends: it holds no machine and no slot while it waits. The question is a row in the scope's database, addressed
// to its parent (or, at the root, to the user), and an approval of kind `question` on the API.
//
// The rules (ADR-026 §4, §9.1, §9.4):
//   - One open question per agent. Asking records it on the agent (agents_v2.asked, what Agent.asked shows) and appends
//     agent.asked in the same transaction: a parent's `await` (blocking or `--wake`) returns on it, as on a notice.
//   - The answer is a message to the asker: it is appended to its thread and wakes the same conversation through the
//     waking ladder (an idle agent continues as its next attempt; a working one reads it as its next turn). A plain
//     message from the parent, an ancestor or the user IS the answer; so is an approval decision with an `answer`.
//   - A parent that can't decide passes it up: to its own parent, or to the user at the root.
//   - The user can always answer, and the user's answer wins: it replaces an agent's answer (the asker is told so), and
//     an agent can't answer once the user has.
//   - Its agent cancelled (or reaped): the question is withdrawn.
import type { RawAccess } from "rivetkit/db";
import { questionDraft, type ItemDraft } from "../../packages/agent-thread/src/index";

export interface QuestionRow {
  questionId: string; agentId: string; epoch: number; to: string | null; question: string; recommend: string; options: string[];
  why: string | null; holds: string | null; state: "open" | "answered" | "withdrawn"; askedAt: number;
  answer: string | null; answeredBy: string | null; note: string | null; answeredAt: number | null; messageSeq: number | null;
  /** The agents it was passed up from, in order (each one that couldn't decide). */
  passed: string[];
}

/** What agents_v2.asked keeps while a question is open (harness.v1 Agent.asked). */
export type AskedState = { questionId: string; question: string; recommend: string; options: string[]; why: string | null; holds: string | null; to: string | null; at: number };

/** agents_v2.asked for an open question. */
export const askedState = (q: QuestionRow): AskedState => ({ questionId: q.questionId, question: q.question, recommend: q.recommend, options: q.options, why: q.why, holds: q.holds, to: q.to, at: q.askedAt });

export const QUESTIONS_SQL = [
  `CREATE TABLE IF NOT EXISTS questions (
    question_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, epoch INTEGER NOT NULL, idem_key TEXT UNIQUE, to_agent TEXT,
    question TEXT NOT NULL, recommend TEXT NOT NULL, options TEXT NOT NULL, why TEXT, holds TEXT, state TEXT NOT NULL,
    asked_at INTEGER NOT NULL, answer TEXT, answered_by TEXT, note TEXT, answered_at INTEGER, message_seq INTEGER, passed TEXT)`,
  "CREATE INDEX IF NOT EXISTS questions_agent ON questions (agent_id, state)",
];

export const questionRow = (r: any): QuestionRow => ({
  questionId: r.question_id, agentId: r.agent_id, epoch: Number(r.epoch), to: r.to_agent ?? null, question: r.question, recommend: r.recommend,
  options: JSON.parse(r.options), why: r.why ?? null, holds: r.holds ?? null, state: r.state, askedAt: Number(r.asked_at),
  answer: r.answer ?? null, answeredBy: r.answered_by ?? null, note: r.note ?? null, answeredAt: r.answered_at == null ? null : Number(r.answered_at),
  messageSeq: r.message_seq == null ? null : Number(r.message_seq), passed: r.passed ? JSON.parse(r.passed) : [],
});

/** Most a question, an option, a reason and "what waits on it" may be (characters), and how many options besides the
 *  recommended one. The card shows a reason as one line under the recommended option (two, then "more"). */
export const ASK_LIMITS = { question: 500, option: 200, why: 600, holds: 300, options: 5, note: 2000 } as const;

/** One line of agent-written text: trimmed, inner whitespace folded, cut to `max`. */
const line = (v: unknown, max: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** Validate what an agent asks (from the RPC): a question, its recommended answer, other options, an optional reason and
 *  what waits on it. The recommended answer is the first option; the others follow, without repeats. */
export function parseAsk(v: any): { question: string; recommend: string; options: string[]; why: string | null; holds: string | null } {
  const question = line(v?.question, ASK_LIMITS.question);
  if (!question) throw new Error("ask needs the question");
  const recommend = line(v?.recommend, ASK_LIMITS.option);
  if (!recommend) throw new Error("ask needs your recommended answer (--recommend): the answer you would pick, so whoever answers can just take it");
  const raw = Array.isArray(v?.options) ? v.options : v?.options !== undefined ? [v.options] : [];
  const seen = new Set([recommend.toLowerCase()]);
  const options = [recommend];
  for (const o of raw.map((x: unknown) => line(x, ASK_LIMITS.option)).filter(Boolean)) {
    if (seen.has(o.toLowerCase())) continue;
    seen.add(o.toLowerCase());
    options.push(o);
  }
  if (options.length > ASK_LIMITS.options + 1) throw new Error(`at most ${ASK_LIMITS.options} options besides the recommended one`);
  const why = line(v?.why, ASK_LIMITS.why) || null;
  const holds = line(v?.holds, ASK_LIMITS.holds) || null;
  return { question, recommend, options, why, holds };
}

/** Whether an answer is the recommended one (the card says when it wasn't). */
export const isRecommended = (q: Pick<QuestionRow, "recommend">, answer: string) => answer.trim().toLowerCase() === q.recommend.trim().toLowerCase();

/** A sender whose message answers a question: a person (the operator, an app's client, the driving harness), not an agent,
 *  a wake, a job or capcomd itself. */
export const isPerson = (from: string) => !/^(agt-|wake-|job-|capcomd)/.test(from);

/** Who answered, in the asker's words. */
const whoSaid = (by: string) => (isPerson(by) ? "the user" : by);

/**
 * The message that tells the asker its answer (an approval decided with an answer, or `capcomd answer`). A plain message
 * that answers is delivered as it was written instead.
 */
export function answerMessage(q: QuestionRow, o: { by: string; answer: string; note: string | null; replaces?: string | null }): string {
  return [
    `Answer to your question ${q.questionId} from ${whoSaid(o.by)}${o.replaces ? ` (it replaces ${whoSaid(o.replaces)}'s answer: go by this one)` : ""}: ${o.answer}`,
    o.note ? `Their note: ${o.note}` : "",
  ].filter(Boolean).join("\n");
}

/**
 * The question as its addressee (a parent agent) reads it: in its mailbox, or in the wake-up of an `await --wake` on the
 * asker. Agent-written parts are the asker's own words; the commands are capcomd's.
 */
export function questionMessage(q: QuestionRow, o: { up: string | null; passedFrom?: string | null }): string {
  const others = q.options.slice(1);
  return [
    o.passedFrom ? `${o.passedFrom} couldn't decide ${q.agentId}'s question ${q.questionId} and passed it to you:` : `${q.agentId} asked you a question (${q.questionId}) and stopped until it's answered:`,
    q.question,
    `Recommended: ${q.recommend}${q.why ? ` (${q.why})` : ""}`,
    others.length ? `Other options: ${others.join("; ")}` : "",
    q.holds ? `Waiting on this: ${q.holds}` : "",
    questionHint(q, o.up),
  ].filter(Boolean).join("\n");
}

/** How the addressee answers: in its own words, the recommendation, or passing it up when it can't decide. */
export function questionHint(q: QuestionRow, up: string | null): string {
  return `Answer: capcomd answer ${q.questionId} "<your answer>" [--note "why"], or capcomd answer ${q.questionId} --recommended. ` +
    `Can't decide: capcomd answer ${q.questionId} --up passes it to ${up ?? "the user"}. It continues by itself once answered.`;
}

/** agent.asked's data: the question as the contract carries it (agent-written parts are untrusted text). */
export function askedData(q: QuestionRow): Record<string, unknown> {
  return { questionId: q.questionId, to: q.to, question: q.question, recommend: q.recommend, options: q.options, why: q.why, holds: q.holds };
}

export type AddEvent = (tx: RawAccess, type: "AGENT_ANSWERED" | "AGENT_QUESTION_WITHDRAWN", agentId: string, data: Record<string, unknown>, key: string) => Promise<void>;

/** The open question of an agent, in the caller's transaction (or null). */
export async function openQuestion(tx: RawAccess, agentId: string): Promise<QuestionRow | null> {
  const r = (await tx.execute("SELECT * FROM questions WHERE agent_id = ? AND state = 'open' ORDER BY asked_at DESC LIMIT 1", agentId)) as any[];
  return r.length ? questionRow(r[0]) : null;
}

/**
 * ADR-026 §1 (the thread is the record): the question as a thread item (kind `question`). In the asker's thread its id
 * is the same from the ask to the answer (each change a new rev). `holder`: another agent's thread that keeps it (one it
 * was asked of, one that answered it, or the asker's root when it is the user's): `itm-<holder>-asked-<qst>`, the same
 * question at the same state, placed at `at` (when it reached that agent). `replaces`: the agent whose answer a person's
 * answer replaced.
 */
export function questionItem(q: QuestionRow, o: { rev: number; replaces?: string | null; holder?: string; at?: number }): ItemDraft {
  const iso = (ms: number | null) => (ms == null ? null : new Date(ms).toISOString());
  const answered = q.state === "answered";
  return questionDraft({
    id: o.holder ? `itm-${o.holder}-asked-${q.questionId}` : `itm-${q.agentId}-question-${q.questionId}`, rev: o.rev, at: o.holder ? o.at ?? Date.now() : q.askedAt,
    question: {
      questionId: q.questionId, asker: q.agentId, state: q.state, question: q.question, options: q.options.map((label, i) => ({ label, recommended: i === 0 })),
      why: q.why, holds: q.holds, to: q.to, passedBy: q.passed,
      answer: answered ? q.answer : null, recommended: answered && q.answer != null ? isRecommended(q, q.answer) : null,
      by: answered ? q.answeredBy : null, note: answered ? q.note : null, replaces: answered ? o.replaces ?? null : null,
      reason: q.state === "withdrawn" ? "cancelled" : null, askedAt: iso(q.askedAt)!, decidedAt: q.state === "open" ? null : iso(q.answeredAt),
    },
    holder: !!o.holder,
  });
}

/**
 * Record an answer (the caller already put the message, `seq`, in the asker's mailbox), in the caller's transaction: the
 * question is answered (a person's answer may replace an agent's), the asker no longer shows a question, and
 * agent.answered says by whom and whether it was the recommendation. Returns whose answer it replaced (or null).
 */
export async function recordAnswer(tx: RawAccess, q: QuestionRow, o: { by: string; answer: string; note: string | null; seq: number }, addEvent: AddEvent): Promise<{ replaces: string | null }> {
  const now = Date.now();
  const replaces = q.state === "answered" ? q.answeredBy : null;
  const answer = o.answer.slice(0, ASK_LIMITS.note), note = o.note ? o.note.slice(0, ASK_LIMITS.note) : null;
  await tx.execute("UPDATE questions SET state = 'answered', answer = ?, answered_by = ?, note = ?, answered_at = ?, message_seq = ? WHERE question_id = ?",
    answer, o.by, note, now, o.seq, q.questionId);
  await tx.execute("UPDATE agents_v2 SET asked = NULL WHERE agent_id = ?", q.agentId);
  await addEvent(tx, "AGENT_ANSWERED", q.agentId, {
    questionId: q.questionId, by: o.by, answer, recommended: isRecommended(q, answer), note, messageSeq: o.seq, replaces,
  }, replaces ? `answer-${q.questionId}-${o.seq}` : `answer-${q.questionId}`);
  return { replaces };
}

/** Withdraw an agent's open question (it was cancelled, or reaped with its parent), in the caller's transaction. Returns
 *  the withdrawn question's id (or null when it had none open). */
export async function withdrawQuestions(tx: RawAccess, agentId: string, reason: "cancelled", addEvent: AddEvent): Promise<string | null> {
  const q = await openQuestion(tx, agentId);
  if (!q) return null;
  await tx.execute("UPDATE questions SET state = 'withdrawn', answered_at = ? WHERE question_id = ? AND state = 'open'", Date.now(), q.questionId);
  await tx.execute("UPDATE agents_v2 SET asked = NULL WHERE agent_id = ?", agentId);
  await addEvent(tx, "AGENT_QUESTION_WITHDRAWN", agentId, { questionId: q.questionId, reason }, `withdraw-${q.questionId}`);
  return q.questionId;
}
