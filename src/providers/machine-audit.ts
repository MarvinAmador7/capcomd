// ADR-021 §5: the audit of machines capcomd deletes. Durable `daemon`-scope events, kept with the settings audit
// (harness state: one store, one seq counter):
//   sandbox.resource_action  {sandbox, resourceId, action, owner, clientId}  a client's action changed a machine
//   sandbox.resource_deleted {sandbox, resourceId, cause}                    a machine capcomd deleted, and why:
//     action        a client's Delete (POST …/resources/{id}/actions/delete)
//     idle_lifetime its idle lifetime ran out (Docker's sweep; a worker's own lifetime alarm)
//     run_ended     its agent ended (finished, failed, handed off or cancelled) and its worker destroyed it
// Only what capcomd itself does and sees: boxd's own platform-side deletes aren't observed.
//
// Deletes happen in two places in the daemon: the API (an orphan's Delete, the audit of an agent's Delete) and the
// engine (a worker draining its machine, Docker's sweep). The API records its events itself; the engine reports
// through the sink `capcomd serve` sets (no sink, e.g. an engine in a test process: nothing is recorded). An agent's
// Delete cancels the agent, and its worker then destroys the machine: while that Delete is in flight the worker's
// report is left to the API (one event, cause `action`); if the request gave up before the worker finished, the
// worker's late report still says `action`.
import { descriptorOf, isListedProvider, PROVIDER_LABEL } from "./registry";

export type DeleteCause = "action" | "idle_lifetime" | "run_ended";
/** A daemon event as state.recordDaemonEvent takes it. */
export interface AuditRecord { type: string; entity: string; text: string; data: Record<string, unknown> }
export type AuditSink = (e: AuditRecord) => void;

let sink: AuditSink | null = null;
/** Where the engine's reports go (`capcomd serve`: the harness state); null stops recording them. */
export function setMachineAuditSink(s: AuditSink | null): void { sink = s; }

const placeOf = (sandbox: string) => (isListedProvider(sandbox) ? PROVIDER_LABEL[sandbox] : descriptorOf(sandbox)?.label ?? sandbox);

const WHY: Record<DeleteCause, string> = {
	action: "deleted from capcomd",
	idle_lifetime: "deleted after its idle lifetime ran out",
	run_ended: "deleted when its agent ended",
};
/** sandbox.resource_deleted: "Cloud: machine relay-3f9c… was deleted when its agent ended." */
export function resourceDeletedEvent(sandbox: string, resourceId: string, cause: DeleteCause): AuditRecord {
	return {
		type: "sandbox.resource_deleted", entity: `sandbox:${sandbox}`,
		text: `${placeOf(sandbox)}: machine ${resourceId} was ${WHY[cause]}.`,
		data: { sandbox, resourceId, cause },
	};
}

/** Who a machine belonged to when a client acted on it (the resource's owner as the API serves it). */
export interface ActionOwner { kind: string; runId: string | null; agentId: string | null; role: string | null; task?: string | null; label?: string | null }
/** sandbox.resource_action: "Cloud: Delete on machine relay-3f9c…: cancelled worker agt-41 of run-8kq2." */
export function resourceActionEvent(sandbox: string, resourceId: string, action: string, owner: ActionOwner | null, clientId: string): AuditRecord {
	const what = action === "delete" ? "Delete" : action;
	const who = !owner ? "no agent was using it"
		: owner.kind === "agent" ? `cancelled ${owner.role ?? "agent"} ${owner.agentId ?? ""}${owner.runId ? ` of ${owner.runId}` : ""}`.replace(/\s+/g, " ").trim()
		: `it was capcomd's own (${owner.label ?? owner.kind})`;
	// The owner as recorded: ids and the role only (the task is agent-written text, never copied into the audit).
	const rec = owner ? { kind: owner.kind, runId: owner.runId, agentId: owner.agentId, role: owner.role } : null;
	return {
		type: "sandbox.resource_action", entity: `sandbox:${sandbox}`,
		text: `${placeOf(sandbox)}: ${what} on machine ${resourceId}: ${who}.`,
		data: { sandbox, resourceId, action, owner: rec, clientId },
	};
}

/** How long a finished action keeps swallowing duplicate reports, and how long one that gave up waits for a late one. */
export const ACTION_CLAIM_MS = 5 * 60_000;
type Claim = { mode: "in_flight" | "done" | "late"; until: number; reported: boolean };
const claims = new Map<string, Claim>();
const keyOf = (sandbox: string, id: string) => `${sandbox}\u0000${id}`;
function live(k: string, now: number): Claim | null {
	const c = claims.get(k);
	if (c && c.until > now) return c;
	if (c) claims.delete(k);
	return null;
}

/**
 * A client's action on a machine starts: while it is in flight (and for a while after it is `done`), a delete the
 * engine reports for that machine is left to the API, which records the action's own events. `gaveUp` (no answer in
 * time) makes the engine's later report the action's; `cancel` (it never acted) forgets it.
 */
export function beginMachineAction(sandbox: string, id: string, now = Date.now()) {
	const k = keyOf(sandbox, id);
	const claim: Claim = { mode: "in_flight", until: now + ACTION_CLAIM_MS, reported: false };
	claims.set(k, claim);
	return {
		/** The action finished; the engine's reports from now on are duplicates for a while. */
		done(t = Date.now()) { claim.mode = "done"; claim.until = t + ACTION_CLAIM_MS; claims.set(k, claim); },
		/** The action failed before it could act: nothing of it to wait for. */
		cancel() { if (claims.get(k) === claim) claims.delete(k); },
		/** The action may still land (the provider didn't answer in time): a late report is the action's. */
		gaveUp(t = Date.now()) { claim.mode = "late"; claim.until = t + ACTION_CLAIM_MS; claims.set(k, claim); },
	};
}

/**
 * The engine deleted a machine (`cause`: why it did). Recorded through the sink, unless a client's action on it is in
 * flight or just finished (the API records that one), and only for places clients see.
 */
export function reportMachineDeleted(sandbox: string | null | undefined, resourceId: string | null | undefined, cause: Exclude<DeleteCause, "action">, now = Date.now()): void {
	if (!sandbox || !resourceId || !isListedProvider(sandbox)) return;
	const c = live(keyOf(sandbox, resourceId), now);
	if (c && c.mode !== "late") return;
	if (c?.reported) return;
	if (c) c.reported = true;
	try { sink?.(resourceDeletedEvent(sandbox, resourceId, c ? "action" : cause)); } catch { /* the audit never fails a delete */ }
}

/** Tests: forget every claim. */
export function resetMachineAudit(): void { claims.clear(); sink = null; }
