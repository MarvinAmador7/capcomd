// ADR-026 §3: a filtered, cursor-resumable wait on GET /v1/events (capability events.wait), for drivers and the app.
//
// `type` and `agent` filter a scope's durable events; `wait` holds the request until one matches or the wait runs out.
// The answer's `cursor` is the highest seq the daemon scanned, matching or not, so a client that resumes from it never
// rescans what didn't match, and never misses what did: every look reads all events after the cursor (no "look, then
// subscribe" window, since there is no subscription: each poll reads from where the last one stopped).
//
// Board's before-or-after rule for state filters (as `wake.arm` checks the current state in its arming transaction,
// src/actors/wakes.ts `alreadySatisfied`): a wait on a state-like event of named agents (agent.done, agent.failed,
// agent.cancelled, agent.paused, agent.asked) whose agent is already in that state, reached before the cursor, answers at
// once with `reached` instead of waiting for an event that already happened. The agents are read before the events, and
// an agent's state changes in the transaction that appends its event, so a state seen there with no matching event after
// the cursor was reached at or before it.
import { dottedType, EVENT_TYPE_PATTERN, type HarnessEvent } from "./envelope";

/** Longest `wait`, in seconds: the front doors' bounded wait (FRONT_WAIT_MAX_MS), under the socket's 60 s idle timeout. */
export const EVENTS_WAIT_MAX_S = 45;
/** Most events one filtered answer carries; the cursor is then the last one's seq. */
export const EVENTS_PAGE_MAX = 1000;
export const EVENTS_TYPES_MAX = 20;
export const EVENTS_AGENTS_MAX = 50;

const TYPE_RE = new RegExp(EVENT_TYPE_PATTERN);
const AGENT_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

/** A repeatable query value (`type=a&type=b`) or a comma list (`type=a,b`), or both: the names, trimmed, deduplicated. */
export const listParam = (v: string | string[] | undefined): string[] =>
	[...new Set(([] as string[]).concat(v ?? []).flatMap((x) => String(x).split(",")).map((x) => x.trim()).filter(Boolean))];

/** The requested types as the envelope names them: a legacy name (AGENT_DONE) is taken as its dotted one (agent.done).
 *  Throws with the offending names when one isn't an event type. */
export function eventTypes(raw: string[]): string[] {
	if (raw.length > EVENTS_TYPES_MAX) throw new Error(`at most ${EVENTS_TYPES_MAX} types`);
	const bad: string[] = [];
	const out = raw.map((t) => {
		if (/^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/.test(t)) return dottedType(t);
		if (!TYPE_RE.test(t)) bad.push(t);
		return t;
	});
	if (bad.length) throw new Error(`not an event type: ${bad.join(", ").slice(0, 200)} (use the event's name, e.g. agent.done)`);
	return [...new Set(out)];
}

export function agentIds(raw: string[]): string[] {
	if (raw.length > EVENTS_AGENTS_MAX) throw new Error(`at most ${EVENTS_AGENTS_MAX} agents`);
	const bad = raw.filter((a) => !AGENT_RE.test(a));
	if (bad.length) throw new Error(`not an agent id: ${bad.join(", ").slice(0, 200)}`);
	return raw;
}

export type EventFilter = { types: string[]; agents: string[] };
/** Does the envelope pass the filter? An agent matches the event's agentId or its entity. */
export const matches = (f: EventFilter, e: HarnessEvent) =>
	(!f.types.length || f.types.includes(e.type)) && (!f.agents.length || f.agents.some((a) => e.agentId === a || e.entity === a));

/** The agent states an event type reports, for the before-or-after rule: the state an agent is in once that event
 *  happened, until another event moves it on. */
type AgentState = { id: string; status: string; asked?: unknown };
export const STATE_TYPES: Record<string, (a: AgentState) => boolean> = {
	"agent.done": (a) => a.status === "done",
	"agent.failed": (a) => a.status === "failed",
	"agent.cancelled": (a) => a.status === "cancelled",
	"agent.paused": (a) => a.status === "paused",
	"agent.asked": (a) => a.asked !== null && a.asked !== undefined,
};

export type Reached = { agentId: string; type: string; event: HarnessEvent | null };
/**
 * Before-or-after: the named agents (read before the events were) already in a state one of the types reports. `log`
 * is the scope's events up to the cursor (the event that put each there is the latest of its type about the agent).
 */
export function reachedStates(f: EventFilter, agents: AgentState[] | null, log: HarnessEvent[], after: number): Reached[] {
	if (!agents || !f.agents.length) return [];
	const types = f.types.filter((t) => t in STATE_TYPES);
	if (!types.length) return [];
	const out: Reached[] = [];
	for (const id of f.agents) {
		const a = agents.find((x) => x.id === id);
		if (!a) continue;
		for (const t of types) {
			if (!STATE_TYPES[t]!(a)) continue;
			const ev = log.findLast((e) => e.seq <= after && e.type === t && e.agentId === id) ?? null;
			out.push({ agentId: id, type: t, event: ev });
		}
	}
	return out;
}
