// harness.v1 client contract (docs/harness-architecture.md §6-7). Phase 0: schemas and procedures, no server yet.
// openapi/capcomd.json and docs/events.md are generated from this file (scripts/gen-harness-contract.ts --check in CI).
import { eventIterator, oc } from "@orpc/contract";
import { z } from "zod";
import { HarnessEvent, Timestamp, TIMESTAMP_DOC } from "./envelope";
import { AgentResult, LegacyEventData, UntrustedText } from "./legacy-events";
import { AttachmentRef, INLINE_TEXT_MAX_BYTES } from "./inline-cap";
import { LIFECYCLE_TYPES, LifecycleCause, RunLifecycleData } from "./lifecycle";
import { ACTIVITY_KINDS } from "../agents/activity";

export const ApprovalId = z.string().regex(/^apr-[A-Za-z0-9]+$/).describe("Stable approval id, carried on approval events; decide with it directly");
export const ApprovalKind = z.enum(["merge", "budget", "egress", "secret", "spawn_widen", "custom"]);
export const ApprovalStatus = z.enum(["pending", "approved", "denied", "expired", "withdrawn"]);
export const AgentStatus = z.enum(["pending", "running", "paused", "done", "failed", "cancelled", "handed-off"]);

/** Stream/replay scope: the daemon, a project or a run. */
export const Scope = z.string().regex(/^(daemon|prj-[A-Za-z0-9_-]+|run-[A-Za-z0-9_-]+)$/).describe("daemon, prj-<id> or run-<id>");

/** Every non-2xx response. Switch on `code`. */
export const ApiError = z.looseObject({
	code: z.enum(["unauthorized", "forbidden", "not_found", "already_decided", "idempotency_conflict", "invalid", "internal"]),
	message: z.string(),
	decision: z.lazy(() => Decision).optional().describe("409 already_decided: the existing decision"),
});
export const ERROR_STATUSES = [401, 404, 409, 422] as const;

/** One profile type everywhere (Agent.profile, agent.spawned.profile, skills): a lowercase name. */
export const ProfileName = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/).describe("Profile name, lowercase");

export const Run = z.object({
	id: z.string(),
	projectId: z.string().nullable(),
	label: z.string().nullable(),
	state: z.string(),
	goal: UntrustedText.nullable(),
	repo: z.string().nullable().describe("Repository the run works in (absolute path or remote URL)"),
	createdAt: Timestamp.nullable(),
});
/** A project groups runs on one repo toward one goal; a project holds any number of runs. */
export const Project = z.object({
	id: z.string().regex(/^prj-[A-Za-z0-9_-]+$/),
	name: z.string(),
	repo: z.string().nullable(),
	goal: UntrustedText.nullable(),
	runIds: z.array(z.string()).describe("Newest first"),
});
/** What a working agent is doing now. Written by the daemon from the agent's structured events (tool names, commands and
 * paths only pick the kind and are counted, never shown), so `text` is trusted. */
export const AgentActivity = z.object({
	text: z.string().describe("Plain-language line, sentence case, no period, written by the daemon (trusted): progressive while the agent works (\"Reading 4 files\"), past tense once it stopped (\"Read 4 files\")"),
	kind: z.string().describe(`Icon hint: ${ACTIVITY_KINDS.join(", ")}. More may be added: treat an unknown kind as tool`),
	at: Timestamp.describe("When the activity last changed"),
});
export const Agent = z.object({
	id: z.string(),
	runId: z.string(),
	parent: z.string().nullable(),
	depth: z.number().int(),
	profile: ProfileName.nullable(),
	status: AgentStatus,
	text: z.string().describe("Plain-language status line written by the daemon (trusted)"),
	activity: AgentActivity.nullable().describe("What it is doing now (or, once it stopped, the last thing it did); null until it reports a step. Live updates: agent.activity_changed with ?activity=1 on a run stream"),
	task: UntrustedText.nullable().describe("Task text, inline when ≤ 64 KB; null when over (see taskAttachment)"),
	taskAttachment: AttachmentRef.nullable(),
	result: AgentResult.nullable(),
	updatedAt: Timestamp.nullable(),
});
/** One thread message. Body inline when ≤ 64 KB (UTF-8), else `attachment`. */
export const Message = z.object({
	seq: z.number().int().nonnegative(),
	from: z.string(),
	to: z.string(),
	at: Timestamp,
	text: UntrustedText.nullable(),
	attachment: AttachmentRef.nullable(),
});
/** Transcript item: one line of the agent's worker output (model turns, tool calls, stderr), oldest first. */
export const TranscriptItem = z.object({
	seq: z.number().int().nonnegative(),
	at: Timestamp,
	stream: z.string().describe("stdout, stderr or a worker channel"),
	text: UntrustedText,
});
export const TRANSCRIPT_PAGE_MAX = 500;
export const TranscriptPage = z.object({
	items: z.array(TranscriptItem),
	next: z.number().int().nonnegative().nullable().describe("Pass as `after` for the next page; null at the end"),
});
/** Trace span (OpenTelemetry-shaped), from the run's trace file. */
export const Span = z.looseObject({
	traceId: z.string(),
	spanId: z.string(),
	parentSpanId: z.string().nullable(),
	name: z.string(),
	start: Timestamp,
	end: Timestamp.nullable(),
	status: z.number().int(),
	attributes: z.record(z.string(), z.unknown()),
});
export const Skill = z.object({
	name: ProfileName,
	description: z.string(),
	source: z.enum(["bundled", "user"]),
});
export const Attachment = z.object({ attachment: AttachmentRef, text: UntrustedText });
export const Decision = z.looseObject({
	approvalId: ApprovalId,
	status: ApprovalStatus,
	decidedBy: z.looseObject({ clientId: z.string(), principal: z.string() }).nullable(),
	decidedAt: Timestamp.nullable(),
	reason: z.string().meta({ "x-untrusted": true, description: "Agent-written text: render as plain text, never markdown, links or actions. Untrusted because an ancestor agent may decide approvals within its budget cap (decision 7)." }).nullable(),
});

const RequestedBy = z.object({ agentId: z.string().nullable(), runId: z.string() }).describe("Who asked; ancestors of agentId may decide within their budget cap");
const ApprovalSubject = z.record(z.string(), z.unknown()).describe("Kind-specific detail: merge {target, ref}, budget {add}, egress {host}, secret {name}, spawn_widen {limits}");

/** Frames on GET /v1/streams/{scope}/events besides ordinary events (SSE `event:` names). */
export const StreamFrames = {
	"stream.reset": z.looseObject({ snapshotSeq: z.number().int().nonnegative(), reason: z.enum(["compacted", "overflow"]) }),
	"snapshot.run": z.looseObject({ run: z.lazy(() => Run) }),
	"snapshot.agents": z.looseObject({ agents: z.array(z.lazy(() => Agent)) }),
	"snapshot.approvals": z.looseObject({ approvals: z.array(z.looseObject({ approvalId: ApprovalId, kind: ApprovalKind, status: ApprovalStatus, question: UntrustedText, requestedBy: RequestedBy, subject: ApprovalSubject })) }),
	"snapshot.steps": z.looseObject({ steps: z.array(z.lazy(() => HarnessEvent)).describe("Recent durable events of the scope, oldest first (step history)") }),
	"snapshot.threads": z.looseObject({ messages: z.array(z.lazy(() => Message)).describe("Recent thread messages, oldest first") }),
	"snapshot.end": z.looseObject({ snapshotSeq: z.number().int().nonnegative() }),
} as const;

export const LIFECYCLE_DOC = `Lifecycle feed: only run and agent state changes (${LIFECYCLE_TYPES.join(", ")}). Tool calls and messages are not here; they stay in step and thread events.
Each event carries a trusted \`data.cause\` code and the envelope's trusted \`text\`; \`seq\` is the source event's seq (a run.* event shares the seq of the agent event that caused it, sent right after it), so Last-Event-ID resume works the same.
Activity is not a state change, so it is not in this feed by default: a stream client opts in with \`?activity=1\` (Agent activity, below).`;

export const ACTIVITY_DOC = `Agent activity: \`?activity=1\` on a run stream (with or without \`feed=lifecycle\`) adds \`agent.activity_changed\` frames: what each agent is doing now, the line in Agent.activity.
They are ephemeral (\`durability: "ephemeral"\`): sent only live, never replayed, not in GET /v1/runs/{runId}/lifecycle or /v1/events, and their SSE frames carry no \`id:\`, so they never move the Last-Event-ID cursor.
Their envelope \`seq\` is the last durable seq at the time (not a cursor), \`entitySeq\` is 0 and \`id\` is unique per frame; the latest frame per agent wins.
Coalesced: at most one per agent per second, and only when the line changes. On connect, snapshot.agents carries the current activity; after a resume without a snapshot, each agent's current activity is sent once right away.
Why opt-in on the run stream: the lifecycle feed stays state changes only for clients that don't ask, the daemon stream stays one frame per run, and a client that follows a run's lifecycle gets the line on the same connection.`;

export const STREAM_DOC = `SSE. Each event frame: \`id: <seq>\`, \`event: <type>\`, \`data: <envelope JSON>\`. Resume by sending \`Last-Event-ID: <seq>\`.
If that seq was compacted away, or this client's buffer overflowed (slow reader), the server sends \`event: stream.reset\` with {snapshotSeq, reason},
then \`snapshot.*\` frames ending with \`snapshot.end\`, then live events from snapshotSeq+1. Handle both reasons the same way: drop local state, apply the snapshot.
A \`: heartbeat\` comment every 15s; treat ~45s of silence as a dead socket. There is no global stream: subscribe to \`daemon\` and open a run stream on drill-in.
The SSE \`event:\` field is the frame type: the envelope's dotted \`type\` for events, else \`stream.reset\` or \`snapshot.*\`.
Run scopes accept \`?feed=lifecycle\`: no snapshot.steps/threads, only lifecycle events (below) after the snapshot, and \`?activity=1\`: live, ephemeral agent.activity_changed frames (at most one per agent per second).
Timestamps (ts, decidedAt, expiresAt): ${TIMESTAMP_DOC}.`;

/** SSE event payloads (data field) by dotted type. docs/events.md is generated from this map. */
export const EventData = {
	...LegacyEventData,
	"agent.status_changed": z.looseObject({ agentId: z.string(), status: AgentStatus }),
	"agent.activity_changed": z.looseObject({ agentId: z.string(), status: AgentStatus, activity: AgentActivity.nullable() }).describe("Ephemeral, only on run streams with ?activity=1: the agent's new Agent.activity. The envelope text is the same line"),
	"approval.requested": z.looseObject({
		approvalId: ApprovalId,
		kind: ApprovalKind,
		question: UntrustedText,
		requestedBy: RequestedBy,
		subject: ApprovalSubject,
		expiresAt: Timestamp.nullable(),
		cause: LifecycleCause.optional(),
	}),
	"approval.decided": Decision.extend({ cause: LifecycleCause.optional() }).loose(),
	...RunLifecycleData,
} as const;
export type EventType = keyof typeof EventData;

const DecideBody = z.object({ decision: z.enum(["approve", "deny"]), reason: UntrustedText.optional() });

export const contract = {
	health: oc.route({ method: "GET", path: "/v1/health", description: "Liveness; no token needed." }).output(z.object({ ok: z.literal(true), api: z.literal("harness.v1"), version: z.string() })),
	projects: {
		list: oc.route({ method: "GET", path: "/v1/projects" }).output(z.array(Project)),
	},
	runs: {
		list: oc.route({ method: "GET", path: "/v1/runs" }).output(z.array(Run)),
		get: oc.route({ method: "GET", path: "/v1/runs/{runId}" }).input(z.object({ runId: z.string() })).output(Run),
		trace: oc.route({ method: "GET", path: "/v1/runs/{runId}/trace", description: "Trace spans of the run, in start order." }).input(z.object({ runId: z.string() })).output(z.array(Span)),
		messages: oc.route({ method: "GET", path: "/v1/runs/{runId}/messages", description: "Thread history of the run." })
			.input(z.object({ runId: z.string(), after: z.coerce.number().int().nonnegative().optional() })).output(z.array(Message)),
		lifecycle: oc.route({ method: "GET", path: "/v1/runs/{runId}/lifecycle", description: LIFECYCLE_DOC })
			.input(z.object({ runId: z.string(), after: z.coerce.number().int().nonnegative().optional() })).output(z.array(HarnessEvent)),
	},
	agents: {
		tree: oc.route({ method: "GET", path: "/v1/runs/{runId}/agents" }).input(z.object({ runId: z.string() })).output(z.array(Agent)),
		transcript: oc.route({
			method: "GET", path: "/v1/runs/{runId}/agents/{agentId}/transcript",
			description: `Full transcript, paged: \`after\` is the last seq you have, \`limit\` at most ${TRANSCRIPT_PAGE_MAX}. Each item's text is at most ${INLINE_TEXT_MAX_BYTES} bytes (§5 limits).`,
		}).input(z.object({ runId: z.string(), agentId: z.string(), after: z.coerce.number().int().nonnegative().optional(), limit: z.coerce.number().int().positive().max(TRANSCRIPT_PAGE_MAX).optional() }))
			.output(TranscriptPage),
	},
	attachments: {
		get: oc.route({ method: "GET", path: "/v1/runs/{runId}/attachments/{attachmentId}", description: "Full text of an over-64 KB body." })
			.input(z.object({ runId: z.string(), attachmentId: z.string().regex(/^att-[0-9a-f]+$/) })).output(Attachment),
	},
	skills: {
		list: oc.route({ method: "GET", path: "/v1/skills", description: "Skills for the picker: bundled capcomd skills and the user's ~/.claude/skills." }).output(z.array(Skill)),
	},
	events: {
		replay: oc
			.route({ method: "GET", path: "/v1/events", description: "Durable events of one scope after `after` (resume cursor = seq), same envelope as the stream." })
			.input(z.object({ scope: Scope, after: z.coerce.number().int().nonnegative().optional() }))
			.output(z.array(HarnessEvent)),
		stream: oc
			.route({ method: "GET", path: "/v1/streams/{scope}/events", inputStructure: "detailed", description: STREAM_DOC })
			.input(z.object({ params: z.object({ scope: Scope }), query: z.object({ feed: z.enum(["lifecycle"]).optional().describe("Run scopes: lifecycle events only"), activity: z.enum(["0", "1"]).optional().describe("Run scopes: 1 adds live, ephemeral agent.activity_changed frames (at most one per agent per second)") }), headers: z.object({ "last-event-id": z.string().regex(/^\d+$/).optional() }) }))
			.output(eventIterator(HarnessEvent)),
	},
	approvals: {
		decide: oc
			.route({
				method: "POST", path: "/v1/approvals/{approvalId}/decision", inputStructure: "detailed",
				description: "No prior read needed. `Idempotency-Key` is scoped to the calling client. Same key + same body: 200 with the first result (replay). " +
					"Same key + different body: 409 `idempotency_conflict`. New key on an approval already decided: 409 `already_decided` with the existing `decision` (who, when).",
			})
			.input(z.object({ params: z.object({ approvalId: ApprovalId }), headers: z.object({ "idempotency-key": z.string().min(8).max(200) }), body: DecideBody }))
			.output(Decision),
	},
};
