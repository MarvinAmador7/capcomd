// SPIKE (ADR draft "Durable agents and threads"): durable wake subscriptions in the scope actor.
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
//
// Delivery from the mailbox into the agent is today's path: a running agent's runner hands new messages to its CLI
// (the supervisor's stdin, a new user turn). What isn't here yet (the "cold" wake): an agent whose CLI has exited, its
// VM suspended or gone, started again on the message (a new epoch resumed in the same CLI session). See the ADR draft.
import type { RawAccess } from "rivetkit/db";

export type WakeFilter =
  /** A verify, check or merge settles (or a merge parks for approval). */
  | { kind: "op"; op: string }
  /** Agents end (done, failed, cancelled): any of them, or all. */
  | { kind: "agents"; agents: string[]; mode?: "any" | "all" }
  /** Any of these event types (optionally about one agent) appended after the cursor `after` (a scope event seq). */
  | { kind: "events"; types: string[]; agent?: string; after: number }
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
];

const OP_END = new Set(["VERIFY_PASSED", "VERIFY_FAILED", "CHECK_PASSED", "CHECK_FAILED", "MERGED", "MERGE_FAILED", "MERGE_AWAITING_APPROVAL", "MERGE_DENIED"]);
const AGENT_END = new Set(["AGENT_DONE", "AGENT_FAILED", "AGENT_CANCELLED"]);
const TERMINAL = new Set(["done", "failed", "cancelled"]);

export const wakeRow = (r: any): WakeRow => ({
  wakeId: r.wake_id, agentId: r.agent_id, filter: JSON.parse(r.filter), note: r.note ?? null, state: r.state,
  at: r.at == null ? null : Number(r.at), createdAt: Number(r.created_at), firedAt: r.fired_at == null ? null : Number(r.fired_at),
  firedSeq: r.fired_seq == null ? null : Number(r.fired_seq), messageSeq: r.message_seq == null ? null : Number(r.message_seq), reason: r.reason ?? null,
});

/** What the event means for one wake: a reason to fire (the message's first line), or null. */
async function satisfies(tx: RawAccess, f: WakeFilter, ev: { seq: number; type: string; agentId: string | null; data: Record<string, any> }): Promise<string | null> {
  if (f.kind === "op") {
    if (!OP_END.has(ev.type) || ev.data?.id !== f.op) return null;
    return opSentence(f.op, ev.type, ev.data);
  }
  if (f.kind === "agents") {
    if (!AGENT_END.has(ev.type) || !ev.agentId || !f.agents.includes(ev.agentId)) return null;
    if (f.mode === "all") {
      const rows = (await tx.execute(`SELECT agent_id, status FROM agents_v2 WHERE agent_id IN (${f.agents.map(() => "?").join(",")})`, ...f.agents)) as any[];
      if (rows.length < f.agents.length || rows.some((r) => !TERMINAL.has(String(r.status)))) return null;
      return `agents ${f.agents.join(", ")} all ended (${rows.map((r) => `${r.agent_id}: ${r.status}`).join(", ")})`;
    }
    return `agent ${ev.agentId} ended: ${ev.type === "AGENT_DONE" ? "done" : ev.type === "AGENT_FAILED" ? "failed" : "cancelled"}`;
  }
  if (f.kind === "events") {
    if (ev.seq <= f.after || !f.types.includes(ev.type) || (f.agent && ev.agentId !== f.agent)) return null;
    return `event ${ev.type}${ev.agentId ? ` (${ev.agentId})` : ""} at seq ${ev.seq}`;
  }
  return null;
}

function opSentence(op: string, type: string, data: Record<string, any>): string {
  const what = op.startsWith("vfy-") ? "verify" : op.startsWith("chk-") ? "check" : "merge";
  const how = type.endsWith("_PASSED") ? "passed" : type.endsWith("_FAILED") ? "failed" : type === "MERGED" ? "merged" : type === "MERGE_AWAITING_APPROVAL" ? "parked, awaiting a person's approval" : type === "MERGE_DENIED" ? "denied" : type.toLowerCase();
  const why = data?.text ?? data?.reason ?? data?.checks?.reason;
  const text = typeof why === "string" && why ? `: ${why.slice(0, 500)}` : "";
  return `${what} ${op} finished: ${how}${text}`;
}

const nextHint = (f: WakeFilter): string => f.kind === "op"
  ? `\`capcomd ${f.op.startsWith("vfy-") ? "verify --id" : f.op.startsWith("chk-") ? "check --id" : "merge --id"} ${f.op}\` shows its full record.`
  : f.kind === "agents" ? "`capcomd status <agt>` shows each one's result." : "";

/**
 * Fire one wake (armed → fired) and put its message in the agent's mailbox, in the caller's transaction. Returns the
 * message seq, or null when it had already fired or was cancelled (a second match, a late timer: nothing happens).
 */
export async function fireWake(tx: RawAccess, w: WakeRow, why: string, seq: number | null, addEvent: (tx: RawAccess, type: "MESSAGE_SENT", agentId: string, data: Record<string, unknown>, key: string, o: { wakes: false }) => Promise<void>): Promise<number | null> {
  const now = Date.now();
  // Inside the caller's transaction: the read and the update can't interleave with another fire.
  const cur = ((await tx.execute("SELECT state FROM wakes WHERE wake_id = ?", w.wakeId)) as any[])[0];
  if (!cur || cur.state !== "armed") return null;
  await tx.execute("UPDATE wakes SET state = 'fired', fired_at = ?, fired_seq = ?, reason = ? WHERE wake_id = ? AND state = 'armed'", now, seq, why, w.wakeId);
  const key = `wake-${w.wakeId}`;
  const dup = (await tx.execute("SELECT seq FROM messages WHERE idem_key = ?", key)) as any[];
  if (dup.length) return Number(dup[0].seq);
  const m = Number(((await tx.execute("SELECT COALESCE(MAX(seq), 0) AS m FROM messages")) as any[])[0]?.m ?? 0) + 1;
  const hint = nextHint(w.filter);
  const body = [`Wake-up ${w.wakeId}: ${why}.`, w.note ? `Your note when you asked for it: ${w.note}` : "", hint].filter(Boolean).join("\n");
  const from = `wake-${w.wakeId}`;
  await tx.execute("INSERT INTO messages (seq, to_agent, from_agent, body, at, idem_key, skills) VALUES (?, ?, ?, ?, ?, ?, NULL)", m, w.agentId, from, body, now, key);
  await tx.execute("UPDATE wakes SET message_seq = ? WHERE wake_id = ?", m, w.wakeId);
  await addEvent(tx, "MESSAGE_SENT", from, { to: w.agentId, seq: m, bytes: body.length, text: body, attachment: null, skills: [] }, `msg-${m}`, { wakes: false });
  return m;
}

/** Called by addEvent for every event it appends, in its transaction: fire each armed wake the event satisfies. */
export async function matchWakes(tx: RawAccess, ev: { seq: number; type: string; agentId: string | null; data: Record<string, any> }, addEvent: Parameters<typeof fireWake>[4]): Promise<number> {
  const armed = ((await tx.execute("SELECT * FROM wakes WHERE state = 'armed' ORDER BY created_at, wake_id")) as any[]).map(wakeRow);
  let n = 0;
  for (const w of armed) {
    const why = await satisfies(tx, w.filter, ev);
    if (why && (await fireWake(tx, w, why, ev.seq, addEvent)) !== null) n++;
  }
  return n;
}

/**
 * Is the wake already satisfied by what happened before it was armed? The current state, not the log: an op that is
 * no longer running, agents already ended, a matching event after the cursor.
 */
export async function alreadySatisfied(tx: RawAccess, f: WakeFilter): Promise<{ why: string; seq: number | null } | null> {
  if (f.kind === "op") {
    const r = ((await tx.execute("SELECT state FROM ops WHERE op_id = ?", f.op)) as any[])[0];
    if (!r || r.state === "running") return null;
    // The event that ended it (its data says how): the newest end event of that op.
    const evs = (await tx.execute("SELECT seq, type, data FROM scope_events WHERE type IN (" + [...OP_END].map(() => "?").join(",") + ") ORDER BY seq DESC", ...OP_END)) as any[];
    for (const e of evs) { const d = JSON.parse(e.data); if (d?.id === f.op) return { why: opSentence(f.op, String(e.type), d), seq: Number(e.seq) }; }
    return { why: `${f.op} is ${r.state}`, seq: null };
  }
  if (f.kind === "agents") {
    const rows = (await tx.execute(`SELECT agent_id, status FROM agents_v2 WHERE agent_id IN (${f.agents.map(() => "?").join(",")})`, ...f.agents)) as any[];
    const ended = rows.filter((r) => TERMINAL.has(String(r.status)));
    if (f.mode === "all" ? ended.length === f.agents.length && rows.length === f.agents.length : ended.length > 0)
      return { why: f.mode === "all" ? `agents ${f.agents.join(", ")} all ended (${ended.map((r) => `${r.agent_id}: ${r.status}`).join(", ")})` : `agent ${ended[0].agent_id} ended: ${ended[0].status}`, seq: null };
    return null;
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

/** Validate what an agent asked for (from the RPC): a filter it may hold. */
export function parseFilter(v: any): WakeFilter {
  if (!v || typeof v !== "object") throw new Error("a wake needs a filter");
  if (v.kind === "op" && typeof v.op === "string" && /^(vfy|chk|mrg)-[A-Za-z0-9_-]{1,80}$/.test(v.op)) return { kind: "op", op: v.op };
  if (v.kind === "agents" && Array.isArray(v.agents) && v.agents.length && v.agents.length <= 50 && v.agents.every((a: unknown) => typeof a === "string" && /^agt-/.test(a)))
    return { kind: "agents", agents: [...new Set<string>(v.agents)], mode: v.mode === "all" ? "all" : "any" };
  if (v.kind === "events" && Array.isArray(v.types) && v.types.length && v.types.length <= 20 && v.types.every((t: unknown) => typeof t === "string" && /^[A-Z_]{3,40}$/.test(t)))
    return { kind: "events", types: v.types, ...(typeof v.agent === "string" ? { agent: v.agent } : {}), after: Math.max(0, Number(v.after ?? 0) || 0) };
  if (v.kind === "timer") return { kind: "timer" };
  throw new Error(`not a wake filter: ${JSON.stringify(v).slice(0, 200)}`);
}
