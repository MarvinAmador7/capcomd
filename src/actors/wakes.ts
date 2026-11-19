// ADR-026 §3: waits happen between turns, never inside a tool call. Durable wake subscriptions in the scope actor.
//
// An agent that would otherwise sit in a polling loop (`capcomd verify`, `check`, `await`) ends its turn with "wake me
// when X" instead. The subscription is a row in the scope's database; the event that satisfies it is matched in the
// SAME transaction that appends the event to the scope's log (addEvent), and firing it appends a message to the agent's
// mailbox in that transaction too. So:
//   - no lost wakeup: arming checks the current state (an op that already ended, agents already finished, events after
//     the agent's cursor) in the arming transaction; anything later is matched as it is appended. There is no window
//     between "look" and "subscribe".
//   - no duplicate delivery: a wake fires once (armed → fired, guarded in SQL), and its message has the idempotency key
//     `wake-<id>`; arming is idempotent by the caller's key.
//   - ordering: the message's mailbox seq is assigned in the event's transaction, so the agent reads wakes in the order
//     their events were appended to the log, interleaved correctly with other messages.
// A time wake (`at`) and a deadline on any wake are the actor's durable alarms (c.schedule.at → wakeTimer), which
// survive an engine restart; a timer that fires after the wake already fired finds it fired and does nothing.
// Each change is an event of the agent's: agent.wake_armed, agent.woken, agent.wake_cancelled (an agent that ends has
// its armed wakes cancelled in the transaction that ends it: nothing would read their message).
//
// Delivery from the mailbox into the agent: the runner hands new messages to its CLI (the supervisor's stdin, a new
// user turn), pushed by the scope's `messagesChanged` broadcast. The supervisor keeps a waiting CLI's input open (warm).
// What isn't here yet (ADR-026 phase 2, the "cold" wake): an agent whose CLI has exited, started again on the message.
import type { RawAccess } from "rivetkit/db";
import { dottedType } from "../api/envelope";
import { SCOPE_EVENT_TYPES } from "../api/legacy-events";

export type WakeFilter =
  /** A verify, check or merge settles (or a merge parks for approval). */
  | { kind: "op"; op: string }
  /** Agents end (done, failed, cancelled): any of them, or all. */
  | { kind: "agents"; agents: string[]; mode: "any" | "all" }
  /** Any of these event types (optionally about one agent) appended after the cursor `after` (a scope event seq), about
   *  an agent in the subtree of `within` (what the arming agent may see: its parent's subtree, else its own). */
  | { kind: "events"; types: string[]; agent?: string; after: number; within?: string }
  /** Only the time: a check-in the agent scheduled for itself. */
  | { kind: "timer" };

export interface WakeRow {
  wakeId: string; agentId: string; filter: WakeFilter; note: string | null; state: "armed" | "fired" | "cancelled";
  at: number | null; createdAt: number; firedAt: number | null; firedSeq: number | null; messageSeq: number | null; reason: string | null;
}

export const WAKES_SQL = [
  `CREATE TABLE IF NOT EXISTS wakes (
    wake_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, idem_key TEXT UNIQUE, filter TEXT NOT NULL, note TEXT,
    state TEXT NOT NULL, at INTEGER, created_at INTEGER NOT NULL, fired_at INTEGER, fired_seq INTEGER, message_seq INTEGER, reason TEXT)`,
  "CREATE INDEX IF NOT EXISTS wakes_state ON wakes (state)",
  // The event that ended each op, by op id (an op wake armed after the op ended reads it here, not by scanning the log).
  "CREATE TABLE IF NOT EXISTS op_ends (op_id TEXT PRIMARY KEY, seq INTEGER NOT NULL, type TEXT NOT NULL)",
];

export const OP_END = new Set(["VERIFY_PASSED", "VERIFY_FAILED", "CHECK_PASSED", "CHECK_FAILED", "MERGED", "MERGE_FAILED", "MERGE_AWAITING_APPROVAL", "MERGE_DENIED"]);
const AGENT_END = new Set(["AGENT_DONE", "AGENT_FAILED", "AGENT_CANCELLED", "AGENT_REAPED"]);
const TERMINAL = new Set(["done", "failed", "cancelled"]);
/** The wakes' own events: never matched by a wake (a wake can't wake on another wake). */
const OWN = new Set(["AGENT_WAKE_ARMED", "AGENT_WOKEN", "AGENT_WAKE_CANCELLED"]);
/** Event types an events wake may name: the scope's own (by legacy or dotted name), minus the wakes'. */
const WAKEABLE = new Map<string, string>(SCOPE_EVENT_TYPES.filter((t) => !OWN.has(t)).flatMap((t) => [[t, t], [dottedType(t), t]] as [string, string][]));

/** Most a wake may be set ahead, and the default deadline of an event wake (its message then says it ran out). */
export const WAKE_MAX_MS = () => Number(process.env.CAPCOMD_WAKE_MAX_MS ?? 6 * 3600_000);

export const wakeRow = (r: any): WakeRow => ({
  wakeId: r.wake_id, agentId: r.agent_id, filter: JSON.parse(r.filter), note: r.note ?? null, state: r.state,
  at: r.at == null ? null : Number(r.at), createdAt: Number(r.created_at), firedAt: r.fired_at == null ? null : Number(r.fired_at),
  firedSeq: r.fired_seq == null ? null : Number(r.fired_seq), messageSeq: r.message_seq == null ? null : Number(r.message_seq), reason: r.reason ?? null,
});

export const opKindOf = (op: string): "verify" | "check" | "merge" => (op.startsWith("vfy-") ? "verify" : op.startsWith("chk-") ? "check" : "merge");

/** What fired a wake: the daemon's short sentence (trusted: ids, kinds, states), and the longer detail for the agent's
 *  message (a check's failure reason: may quote agent or check output, so it never goes in an event's text). */
interface Why { text: string; detail?: string; by: "event" | "time" | "deadline" }

/** How an op ended, in a few words: "verify vfy-… passed", "merge mrg-… is waiting for a person's approval". */
function opWhy(op: string, type: string, data: Record<string, any> | null): Why {
  const how = type.endsWith("_PASSED") ? "passed" : type.endsWith("_FAILED") ? "failed" : type === "MERGED" ? "merged" : type === "MERGE_AWAITING_APPROVAL" ? "is waiting for a person's approval" : type === "MERGE_DENIED" ? "was denied" : "ended";
  const why = data?.checks?.reason ?? data?.reason ?? data?.text;
  return { text: `${opKindOf(op)} ${op} ${how}`, ...(typeof why === "string" && why ? { detail: why.slice(0, 500) } : {}), by: "event" };
}

/** Is `agentId` `root` or below it? Walks up its parents (a tree is shallow). */
async function inSubtree(tx: RawAccess, root: string, agentId: string): Promise<boolean> {
  let cur: string | null = agentId;
  for (let i = 0; cur && i < 64; i++) {
    if (cur === root) return true;
    const r = (await tx.execute("SELECT parent FROM agents_v2 WHERE agent_id = ?", cur)) as any[];
    cur = r.length ? (r[0].parent ?? null) : null;
  }
  return false;
}

/** What the event means for one wake: a reason to fire, or null. */
async function satisfies(tx: RawAccess, f: WakeFilter, ev: { seq: number; type: string; agentId: string | null; data: Record<string, any> }): Promise<Why | null> {
  if (f.kind === "op") {
    if (!OP_END.has(ev.type) || ev.data?.id !== f.op) return null;
    return opWhy(f.op, ev.type, ev.data);
  }
  if (f.kind === "agents") {
    if (!AGENT_END.has(ev.type) || !ev.agentId || !f.agents.includes(ev.agentId)) return null;
    const rows = (await tx.execute(`SELECT agent_id, status FROM agents_v2 WHERE agent_id IN (${f.agents.map(() => "?").join(",")})`, ...f.agents)) as any[];
    return agentsWhy(f, rows, ev.agentId);
  }
  if (f.kind === "events") {
    if (ev.seq <= f.after || !f.types.includes(ev.type) || (f.agent && ev.agentId !== f.agent)) return null;
    // Only what the agent that armed it may see (src/subagents/rpc.ts `events`: its subtree, or its parent's).
    if (f.within && (!ev.agentId || !(await inSubtree(tx, f.within, ev.agentId)))) return null;
    return { text: `${dottedType(ev.type)}${ev.agentId ? ` from ${ev.agentId}` : ""}`, by: "event" };
  }
  return null;
}

/** The agents' end as a reason, or null while it isn't one (all: one still runs). `ended`: the agent that just ended. */
function agentsWhy(f: Extract<WakeFilter, { kind: "agents" }>, rows: any[], ended?: string): Why | null {
  const done = rows.filter((r) => TERMINAL.has(String(r.status)));
  if (f.mode === "all") {
    if (rows.length < f.agents.length || done.length < f.agents.length) return null;
    return { text: f.agents.length === 1 ? `${f.agents[0]} ended: ${done[0].status}` : `${f.agents.length} agents ended (${done.map((r) => `${r.agent_id}: ${r.status}`).join(", ")})`, by: "event" };
  }
  const first = done.find((r) => r.agent_id === ended) ?? done[0];
  return first ? { text: `${first.agent_id} ended: ${first.status}`, by: "event" } : null;
}

const nextHint = (f: WakeFilter): string => f.kind === "op"
  ? `\`capcomd ${opKindOf(f.op) === "verify" ? "verify --id" : opKindOf(f.op) === "check" ? "check --id" : "merge --id"} ${f.op}\` shows its full record.`
  : f.kind === "agents" ? "`capcomd status <agt>` shows each one's result." : "";

/** Every wake change's event goes through this (scope.ts addEvent, which skips matching for these types). */
export type AddEvent = (tx: RawAccess, type: "AGENT_WAKE_ARMED" | "AGENT_WOKEN" | "AGENT_WAKE_CANCELLED", agentId: string, data: Record<string, unknown>, key: string) => Promise<void>;

/** The agents a transaction put a message in front of (a wake fired): the scope tells their runners after it commits. */
const WOKEN = Symbol("capcomd.woken");
export function wokenIn(tx: RawAccess): string[] { return ((tx as any)[WOKEN] as string[] | undefined) ?? []; }
const noteWoken = (tx: RawAccess, agentId: string) => { ((tx as any)[WOKEN] ??= [] as string[]).push(agentId); };

/** agent.wake_armed's data: what it waits for, in the contract's terms (dotted event types). */
export function armedData(w: WakeRow): Record<string, unknown> {
  const f = w.filter;
  return {
    wakeId: w.wakeId, kind: f.kind,
    ...(f.kind === "op" ? { op: f.op, opKind: opKindOf(f.op) } : {}),
    ...(f.kind === "agents" ? { agents: f.agents, mode: f.mode } : {}),
    ...(f.kind === "events" ? { types: f.types.map(dottedType), ...(f.agent ? { agent: f.agent } : {}) } : {}),
    at: w.at, note: w.note,
  };
}

/**
 * Fire one wake (armed → fired) and put its message in the agent's mailbox, in the caller's transaction. Returns the
 * message seq, or null when it had already fired or was cancelled (a second match, a late timer: nothing happens).
 */
export async function fireWake(tx: RawAccess, w: WakeRow, why: Why, seq: number | null, addEvent: AddEvent): Promise<number | null> {
  const now = Date.now();
  // Inside the caller's transaction: the read and the update can't interleave with another fire.
  const cur = ((await tx.execute("SELECT state FROM wakes WHERE wake_id = ?", w.wakeId)) as any[])[0];
  if (!cur || cur.state !== "armed") return null;
  await tx.execute("UPDATE wakes SET state = 'fired', fired_at = ?, fired_seq = ?, reason = ? WHERE wake_id = ? AND state = 'armed'", now, seq, why.text, w.wakeId);
  const key = `wake-${w.wakeId}`;
  const dup = (await tx.execute("SELECT seq FROM messages WHERE idem_key = ?", key)) as any[];
  let m = dup.length ? Number(dup[0].seq) : 0;
  if (!m) {
    m = Number(((await tx.execute("SELECT COALESCE(MAX(seq), 0) AS m FROM messages")) as any[])[0]?.m ?? 0) + 1;
    const body = [`Wake-up ${w.wakeId}: ${why.text}${why.detail ? `: ${why.detail}` : ""}.`, w.note ? `Your note when you asked for it: ${w.note}` : "", nextHint(w.filter)].filter(Boolean).join("\n");
    await tx.execute("INSERT INTO messages (seq, to_agent, from_agent, body, at, idem_key, skills) VALUES (?, ?, ?, ?, ?, ?, NULL)", m, w.agentId, `wake-${w.wakeId}`, body, now, key);
  }
  await tx.execute("UPDATE wakes SET message_seq = ? WHERE wake_id = ?", m, w.wakeId);
  await addEvent(tx, "AGENT_WOKEN", w.agentId, { wakeId: w.wakeId, kind: w.filter.kind, by: why.by, text: why.text, causeSeq: seq, messageSeq: m, armedAt: w.createdAt }, `woken-${w.wakeId}`);
  noteWoken(tx, w.agentId);
  return m;
}

/** Cancel one armed wake (its agent asked, or ended), with its event. False when it wasn't armed. */
export async function cancelWake(tx: RawAccess, w: WakeRow, reason: "agent" | "ended", addEvent: AddEvent): Promise<boolean> {
  const cur = ((await tx.execute("SELECT state FROM wakes WHERE wake_id = ?", w.wakeId)) as any[])[0];
  if (!cur || cur.state !== "armed") return false;
  await tx.execute("UPDATE wakes SET state = 'cancelled', reason = ? WHERE wake_id = ? AND state = 'armed'", reason, w.wakeId);
  await addEvent(tx, "AGENT_WAKE_CANCELLED", w.agentId, { wakeId: w.wakeId, reason }, `wake-cancel-${w.wakeId}`);
  return true;
}

/**
 * Called by addEvent for every event it appends, in its transaction: index an op's end by its id, fire each armed wake
 * the event satisfies, and cancel the wakes of an agent that ended (nothing would read their message).
 */
export async function matchWakes(tx: RawAccess, ev: { seq: number; type: string; agentId: string | null; data: Record<string, any> }, addEvent: AddEvent): Promise<number> {
  if (OWN.has(ev.type)) return 0;
  if (OP_END.has(ev.type) && typeof ev.data?.id === "string") await tx.execute("INSERT OR REPLACE INTO op_ends (op_id, seq, type) VALUES (?, ?, ?)", ev.data.id, ev.seq, ev.type);
  const armed = ((await tx.execute("SELECT * FROM wakes WHERE state = 'armed' ORDER BY created_at, wake_id")) as any[]).map(wakeRow);
  if (!armed.length) return 0;
  let n = 0;
  for (const w of armed) {
    const why = await satisfies(tx, w.filter, ev);
    if (why && (await fireWake(tx, w, why, ev.seq, addEvent)) !== null) n++;
  }
  if (AGENT_END.has(ev.type) && ev.agentId) for (const w of armed) if (w.agentId === ev.agentId) await cancelWake(tx, w, "ended", addEvent);
  return n;
}

/**
 * Is the wake already satisfied by what happened before it was armed? The current state, not the log: an op that is
 * no longer running (its end event by op id), agents already ended, a matching event after the cursor.
 */
export async function alreadySatisfied(tx: RawAccess, f: WakeFilter): Promise<{ why: Why; seq: number | null } | null> {
  if (f.kind === "op") {
    const r = ((await tx.execute("SELECT state, result FROM ops WHERE op_id = ?", f.op)) as any[])[0];
    if (!r || r.state === "running") return null;
    const end = ((await tx.execute("SELECT seq, type FROM op_ends WHERE op_id = ?", f.op)) as any[])[0];
    const ev = end ? ((await tx.execute("SELECT data FROM scope_events WHERE seq = ?", Number(end.seq))) as any[])[0] : null;
    if (end && ev) return { why: opWhy(f.op, String(end.type), JSON.parse(ev.data)), seq: Number(end.seq) };
    // An op that ended before its end was indexed (a run from an older daemon): its record says how.
    const type = r.state === "passed" ? `${opKindOf(f.op).toUpperCase()}_PASSED` : r.state === "merged" ? "MERGED" : r.state === "awaiting_approval" ? "MERGE_AWAITING_APPROVAL" : opKindOf(f.op) === "merge" ? "MERGE_FAILED" : `${opKindOf(f.op).toUpperCase()}_FAILED`;
    return { why: opWhy(f.op, type, r.result ? JSON.parse(r.result) : null), seq: null };
  }
  if (f.kind === "agents") {
    const rows = (await tx.execute(`SELECT agent_id, status FROM agents_v2 WHERE agent_id IN (${f.agents.map(() => "?").join(",")})`, ...f.agents)) as any[];
    const why = agentsWhy(f, rows);
    return why ? { why, seq: null } : null;
  }
  if (f.kind === "events") {
    const evs = (await tx.execute(`SELECT seq, type, agent_id, data FROM scope_events WHERE seq > ? AND type IN (${f.types.map(() => "?").join(",")}) ORDER BY seq`, f.after, ...f.types)) as any[];
    for (const e of evs) {
      const why = await satisfies(tx, f, { seq: Number(e.seq), type: String(e.type), agentId: e.agent_id ?? null, data: JSON.parse(e.data) });
      if (why) return { why, seq: Number(e.seq) };
    }
  }
  return null;
}

/** Validate what an agent asked for (from the RPC): a filter it may hold. Event types by legacy or dotted name. */
export function parseFilter(v: any): WakeFilter {
  if (!v || typeof v !== "object") throw new Error("a wake needs a filter");
  if (v.kind === "op" && typeof v.op === "string" && /^(vfy|chk|mrg)-[A-Za-z0-9_-]{1,80}$/.test(v.op)) return { kind: "op", op: v.op };
  if (v.kind === "agents" && Array.isArray(v.agents) && v.agents.length && v.agents.length <= 50 && v.agents.every((a: unknown) => typeof a === "string" && /^agt-[A-Za-z0-9_-]{1,80}$/.test(a)))
    return { kind: "agents", agents: [...new Set<string>(v.agents)], mode: v.mode === "all" ? "all" : "any" };
  if (v.kind === "events" && Array.isArray(v.types) && v.types.length && v.types.length <= 20) {
    const types = v.types.map((t: unknown) => WAKEABLE.get(String(t)));
    if (types.some((t: string | undefined) => !t)) throw new Error(`not an event type a wake can wait for: ${v.types.filter((t: unknown) => !WAKEABLE.has(String(t))).map(String).join(", ").slice(0, 200)} (use the event's name, e.g. agent.done)`);
    return { kind: "events", types: [...new Set<string>(types)], ...(typeof v.agent === "string" && /^agt-/.test(v.agent) ? { agent: v.agent } : {}), after: Math.max(0, Number(v.after ?? 0) || 0), ...(typeof v.within === "string" ? { within: v.within } : {}) };
  }
  if (v.kind === "timer") return { kind: "timer" };
  throw new Error(`not a wake filter: ${JSON.stringify(v).slice(0, 200)}`);
}
