// Payloads of today's scope events (src/actors/scope.ts addEvent), keyed by their harness.v1 dotted name.
// Loose objects: known fields are typed, extra fields pass through. tests/api/legacy-events.test.ts fails when
// scope.ts emits a type that isn't listed here.
import { z } from "zod";

const S = z.string(), N = z.number(), nS = z.string().nullable(), U = z.unknown();
const o = (shape: z.ZodRawShape) => z.looseObject(shape);
const task = { taskId: S, holder: S, epoch: N };

export const LegacyEventData = {
	"run.new": o({ budget: U, label: nS }),
	"run.granted": o({ add: U, budget: U, by: U }),
	"agent.spawned": o({ parent: nS, depth: N, profile: U, budget: U, limits: U, agent: U, task: S, key: nS, operator: z.boolean(), review: z.boolean().optional() }),
	"agent.started": o({}),
	"agent.checkpoint": o({}),
	"agent.paused": o({ result: U, until: U }),
	"agent.resumed": o({ epoch: N, by: nS }),
	"agent.granted": o({ add: U, budget: U, by: U }),
	"agent.adopted": o({ from: S, to: S }),
	"agent.reaped": o({ orphanOf: S, parentStatus: S }),
	"agent.cancelled": o({ reason: nS, by: S }),
	"deadlock.detected": o({ cycle: z.array(S) }),
	"drive.failed": o({ kind: S, error_kind: S, message: S, attempt: N, driver: U, consecutive: N }),
	"token.revoked": o({ jti: S, reason: nS }),
	"message.sent": o({ to: U, seq: N, bytes: N }),
	"merge.awaiting_approval": o({ id: S, target: U, ref: U, reason: U }),
	"merge.approved": o({ id: S, by: U }),
	"merge.denied": o({ id: S }),
	"task.added": o({ taskId: S, title: S, after: z.array(S).optional() }),
	"task.claimed": o({ ...task, leaseUntil: N, takeoverFrom: S.optional() }),
	"task.lease_expired": o(task),
	"task.done": o({ ...task, result: U.optional() }),
	"task.released": o(task),
} as const;
