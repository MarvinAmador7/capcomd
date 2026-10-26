// harness.v1 §7.4: POST /v1/approvals/{approvalId}/decision idempotency, as a pure function the server (phase 1) calls
// inside the same transaction as the decision write. Keys are scoped per client: (clientId, key).
export type DecideBody = { decision: "approve" | "deny"; reason?: string };
/** A recorded outcome under (clientId, key): approvals.decide sets approvalId, runs.create sets runId. */
export type StoredKey = { approvalId?: string; runId?: string; bodyHash: string; status: number; result: unknown };
export type Outcome =
	| { kind: "apply" }
	| { kind: "replay"; status: number; result: unknown }
	| { kind: "error"; status: 409; code: "idempotency_conflict" | "already_decided"; existing?: unknown };

export const bodyHash = (approvalId: string, b: DecideBody) => JSON.stringify([approvalId, b.decision, b.reason ?? null]);

export function resolveDecide(o: { prior: StoredKey | undefined; approvalId: string; body: DecideBody; existingDecision: unknown | null }): Outcome {
	const h = bodyHash(o.approvalId, o.body);
	if (o.prior) return o.prior.bodyHash === h ? { kind: "replay", status: o.prior.status, result: o.prior.result } : { kind: "error", status: 409, code: "idempotency_conflict" };
	if (o.existingDecision) return { kind: "error", status: 409, code: "already_decided", existing: o.existingDecision };
	return { kind: "apply" };
}
