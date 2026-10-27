// harness.v1 client contract (docs/harness-architecture.md §6-7). Phase 0: schemas and procedures, no server yet.
// openapi/capcomd.json and docs/events.md are generated from this file (scripts/gen-harness-contract.ts --check in CI).
import { eventIterator, oc } from "@orpc/contract";
import { z } from "zod";
import { HarnessEvent, Timestamp, TIMESTAMP_DOC } from "./envelope";
import { AgentProvider, AgentResult, LegacyEventData, UntrustedText } from "./legacy-events";
import { AttachmentRef, INLINE_TEXT_MAX_BYTES } from "./inline-cap";
import { LIFECYCLE_TYPES, LifecycleCause, RunLifecycleData } from "./lifecycle";
import { ACTIVITY_KINDS } from "../agents/activity";
import { AgentWorkspace } from "./workspace";
import { SKILL_MAX_BYTES, SKILLS_PER_MESSAGE_MAX } from "../agents/skills";
import { isListedProvider, LISTED_PROVIDERS, PROVIDER_LABEL } from "../providers/registry";
import { IDLE_LIFETIME_CHOICES } from "./sandboxes";
import { CODE_MAX_LINES, DIFF_LINE_MAX_CHARS, DIFF_MAX_LINES, ITEM_MAX_BYTES, TABLE_MAX_COLS, TABLE_MAX_ROWS, THREAD_FORMAT, ThreadItem } from "../../packages/agent-thread/src/index";

export { ThreadItem };

export const ApprovalId = z.string().regex(/^apr-[A-Za-z0-9]+$/).describe("Stable approval id, carried on approval events; decide with it directly");
export const ApprovalKind = z.enum(["merge", "budget", "egress", "secret", "spawn_widen", "custom"]);
export const ApprovalStatus = z.enum(["pending", "approved", "denied", "expired", "withdrawn"]);
export const AgentStatus = z.enum(["pending", "running", "paused", "done", "failed", "cancelled", "handed-off"]);

/** Stream/replay scope: the daemon, a project or a run. */
export const Scope = z.string().regex(/^(daemon|prj-[A-Za-z0-9_-]+|run-[A-Za-z0-9_-]+)$/).describe("daemon, prj-<id> or run-<id>");

/** Every non-2xx response. Switch on `code`. */
export const ApiError = z.looseObject({
	code: z.enum(["unauthorized", "forbidden", "not_found", "already_decided", "idempotency_conflict", "conflict", "invalid", "internal", "unavailable"])
		.describe("conflict (409): the run or agent is in a state the action can't apply to (nothing to pause, resume or cancel; a message to an agent that has ended), or a machine changed since it was read. unavailable (503, capability sandboxes.actions): a provider didn't answer during an action. Treat a code you don't know as a generic error"),
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
	state: z.string().describe("new, idle, running or unknown; failed or cancelled when the run ended without its agents ending it (a failed start, Stop on a run with no agent running: `run.ended`); starting in the runs.create response, before the run's process has registered it"),
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
	workspace: AgentWorkspace.nullable(),
	provider: AgentProvider.nullable().describe("The AI provider the agent runs on: claude or codex; null for a fake (local stand-in) agent"),
	model: z.string().nullable().describe("The model the agent runs with, when the daemon knows it (the profile's model or CAPCOMD_AGENT_MODEL); null: the provider CLI's default, or a fake agent"),
	effort: z.string().nullable().describe("The reasoning effort the agent runs with (its profile's, the run's chosen level for its planner, or CAPCOMD_AGENT_EFFORT): one of its provider's levels (GET /v1/run-options `efforts`); null: the provider CLI's default, or a fake agent"),
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
/** GET …/thread: an agent's thread items (packages/agent-thread), by write cursor. */
export const THREAD_PAGE_MAX = 500;
export const ThreadPage = z.object({
	items: z.array(ThreadItem).describe("Items created or changed after `after`, in write order (seq). Place each by `order`; a later rev of the same id replaces the earlier one"),
	next: z.number().int().nonnegative().nullable().describe("More are waiting: pass this as `after`. null: you have everything; keep the last item's seq as your cursor"),
});
export const THREAD_DOC = `An agent's thread: typed items with stable ids, each message parsed once by the daemon into a sanitized block tree (format \`${THREAD_FORMAT}\`), so a client renders it without parsing markdown.
\`after\` is a run-wide write cursor (\`seq\`): items created *or changed* since come back, in write order, so a tool item is seen \`open\` at the call and again \`done\` (isError, durationMs when the CLI reports one) at its result. Sort by \`order\`; the highest \`rev\` of an id wins.
Kinds: say, thinking (\`redacted\` when the CLI withheld it), tool (\`tool.summary\` is one daemon-built line), error, result (omitted when it only repeats the last say), plan (the agent's todo list as a task list), handoff (a child that finished: its summary, artifacts as links and media), other (an event the daemon doesn't know, as one plain line). Render an unknown kind as a plain line of \`text\`.
Every string in an item is agent-written plain text (x-untrusted): never HTML, never a link followed or media loaded without the user's click. Links carry the daemon's \`target\` (web: show \`host\`, and the full URL when \`mismatch\`; file, artifact, agent, run; none: plain text). Media: \`remote\` never loads by itself; \`attachment\` and \`inline\` come from GET /v1/runs/{runId}/attachments/{id}/content, \`workspace\` from GET /v1/runs/{runId}/agents/{agentId}/workspace?path=.
Caps (block boundaries only): ${ITEM_MAX_BYTES} bytes of blocks and of \`text\` per item (whole trailing blocks dropped, \`truncated\` says how many); code blocks keep their first ${CODE_MAX_LINES} lines (\`truncatedLines\`); tables ${TABLE_MAX_ROWS} rows × ${TABLE_MAX_COLS} columns (\`truncatedRows\`/\`truncatedCols\`); a tool's \`diff\` its first ${DIFF_MAX_LINES} lines of ${DIFF_LINE_MAX_CHARS} characters at most (\`truncatedLines\`; \`added\`/\`removed\` count the whole change).
Reserved for token streaming (not emitted yet): a say or thinking item may be \`open\` with its last block \`{t:"open", text}\` (the unfinished block as plain text) and \`rev\` rising as it grows. Live updates: \`?thread=1\` on a run stream (agent.thread_item_changed frames).`;

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
/** GET /v1/runs/{runId}/files: one row per (agent, file) the run's work changes. */
export const FILES_MAX = 500;
export const FILES_AGENTS_MAX = 100;
export const FileStatus = z.enum(["added", "modified", "deleted", "renamed", "copied", "typechange", "unknown"]);
export const FileChange = z.object({
	path: UntrustedText,
	oldPath: UntrustedText.nullable(),
	status: FileStatus,
	added: z.number().int().nonnegative().nullable().describe("Lines added; null for a binary file"),
	removed: z.number().int().nonnegative().nullable().describe("Lines removed; null for a binary file"),
	agentId: z.string().describe("The agent whose work changes the file"),
});
export const FileSource = z.object({
	agentId: z.string(),
	from: z.enum(["commit", "checkpoint"]).describe("commit: the commit it pushed (done, failed or paused); checkpoint: its latest checkpoint while it works"),
	sha: z.string().describe("The commit compared"),
	base: z.string().nullable().describe("Where its branch left the target (the diff's base); null when unknown"),
	files: z.number().int().nonnegative().nullable().describe("Files it changes; null when they could not be read (see error)"),
	error: z.string().nullable().describe("Why its files are missing (daemon-written, trusted)"),
});
export const RunFiles = z.object({
	runId: z.string(),
	asOf: z.number().int().nonnegative().describe("Seq of the run's last event this answer reflects (same seq as the run stream)"),
	computedAt: Timestamp,
	target: z.string().nullable().describe("Target branch the work is compared with; null when the run has no repository"),
	files: z.array(FileChange).describe("Sorted by path, then agentId"),
	total: z.number().int().nonnegative().describe("Rows before the cut to `limit`"),
	truncated: z.boolean().describe("Rows were left out: more than `limit`, or more agents with work than the server diffs"),
	sources: z.array(FileSource).describe("Each agent with work: what was compared, or why it could not be"),
});
export const FILES_DOC = `Files the run's agents changed, with lines added and removed: \`git diff --numstat\` of each agent's latest work (the commit it pushed, else its latest checkpoint) against where its branch left the run's target branch. One row per (agent, file), sorted by path; \`added\`/\`removed\` are null for binary files. Paths are agent-written (x-untrusted).
\`agentId\` limits it to one agent; \`limit\` (default and max ${FILES_MAX}) caps the rows, and only the ${FILES_AGENTS_MAX} agents with the newest work are diffed: \`truncated\` says rows were left out, \`total\` counts the rows before the cut.
Refetch when the run stream shows agent.checkpointed, agent.done, agent.failed, agent.paused or merge.succeeded with a seq above \`asOf\`. Work the daemon cannot read (no repository, a deleted branch) is a \`sources[].error\`, not an HTTP error.`;
export const Skill = z.object({
	name: ProfileName,
	description: z.string(),
	source: z.enum(["bundled", "user"]),
});
export const Attachment = z.object({
	attachment: AttachmentRef,
	text: UntrustedText.describe("Agent-written text: the body (base64 when encoding is base64). Render as plain text, never markdown, links or actions"),
	encoding: z.enum(["utf8", "base64"]).describe("base64: an image a tool returned (its bytes are at …/content)"),
});
/** Raw-bytes routes (served natively; their OpenAPI response is binary). */
export const BINARY_ROUTES = ["agents.workspace", "attachments.content"] as const;
export const WORKSPACE_FILE_DOC = `A file of the agent's latest work (the commit it pushed, else its latest checkpoint), for \`workspace\` media and file links in its thread. Raw bytes, at most 5 MB.
\`path\` is relative to the repository root, '/'-separated and normalized (no \`..\`, no \`.git\`): anything else is 422. Only regular files: a directory, symlink or submodule is 404 (no listings).
Content-Type is sniffed from the bytes (png, jpeg, gif, webp; video and audio by extension; UTF-8 text as text/plain), never svg or HTML: everything else is application/octet-stream with Content-Disposition: attachment. A file the agent has not checkpointed yet is 404 until it does.`;
export const ATTACHMENT_CONTENT_DOC = "An attachment's bytes with its media type: images a tool returned (`inline` media) and long bodies (text/plain). Served with nosniff and a sandboxing CSP.";
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

export const THREAD_STREAM_DOC = `Live thread items: \`?thread=1\` on a run stream (with or without \`feed=lifecycle\`) adds \`agent.thread_item_changed\` frames, each carrying a full item as GET /v1/runs/{runId}/agents/{agentId}/thread serves it.
Like agent.activity_changed they are ephemeral (\`durability: "ephemeral"\`): sent only live, never replayed, and their SSE frames carry no \`id:\`, so they never move the Last-Event-ID cursor. Envelope \`seq\` is the last durable seq at the time, \`entitySeq\` 0, \`entity\` the agent.
Coalesced: the daemon looks for new writes at most four times a second and sends only the latest rev of each item, so an item gets at most four frames a second. Frames start with writes after the client connected, and only connections that asked for \`thread=1\` cost anything.
On (re)connect: open the stream, then read the thread route from your cursor (the highest item \`seq\` you have), then apply frames. Nothing is lost between the two; an item may arrive both ways, and the highest \`rev\` of an id wins.`;

export const STREAM_DOC =`SSE. Each event frame: \`id: <seq>\`, \`event: <type>\`, \`data: <envelope JSON>\`. Resume by sending \`Last-Event-ID: <seq>\`.
If that seq was compacted away, or this client's buffer overflowed (slow reader), the server sends \`event: stream.reset\` with {snapshotSeq, reason},
then \`snapshot.*\` frames ending with \`snapshot.end\`, then live events from snapshotSeq+1. Handle both reasons the same way: drop local state, apply the snapshot.
A \`: heartbeat\` comment every 15s; treat ~45s of silence as a dead socket. There is no global stream: subscribe to \`daemon\` and open a run stream on drill-in.
The SSE \`event:\` field is the frame type: the envelope's dotted \`type\` for events, else \`stream.reset\` or \`snapshot.*\`.
Run scopes accept \`?feed=lifecycle\`: no snapshot.steps/threads, only lifecycle events (below) after the snapshot, and \`?activity=1\`: live, ephemeral agent.activity_changed frames (at most one per agent per second), and \`?thread=1\`: live, ephemeral agent.thread_item_changed frames (Agent threads, below).
Timestamps (ts, decidedAt, expiresAt): ${TIMESTAMP_DOC}.`;

/** SSE event payloads (data field) by dotted type. docs/events.md is generated from this map. */
export const EventData = {
	...LegacyEventData,
	"agent.step": LegacyEventData["agent.step"].describe("Capability agent.steps. One finished step of an agent's history, in the order it took them: a streak of one kind of tool call (reading files, editing, running the tests), reported once the agent moved on to another kind or ended. Durable: replayed by GET /v1/events and on run streams like any event (not on the lifecycle feed). The envelope text is the step in past tense (\"Read 4 files\", \"Ran the tests\"); `agentId`/`entity` is the agent. At most 500 per agent; a cancelled agent's unfinished last step is not recorded"),
	"agent.status_changed": z.looseObject({ agentId: z.string(), status: AgentStatus }),
	"agent.activity_changed": z.looseObject({ agentId: z.string(), status: AgentStatus, activity: AgentActivity.nullable() }).describe("Ephemeral, only on run streams with ?activity=1: the agent's new Agent.activity. The envelope text is the same line"),
	"agent.thread_item_changed": z.looseObject({ agentId: z.string(), item: ThreadItem }).describe("Ephemeral, only on run streams with ?thread=1: an item created or changed, as GET …/thread serves it (latest rev wins). The envelope text is daemon-written"),
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
	"sandbox.settings_changed": z.looseObject({
		sandbox: z.string().describe("The place (a listed provider's name)"),
		id: z.string().describe("The setting's id (idleLifetime)"),
		from: z.string().nullable().describe("The value before (as the field's `value` showed it)"),
		to: z.string().describe("The value now"),
		clientId: z.string().describe("The API client that changed it (cli-…)"),
	}).describe("Capability sandboxes.settings. Durable, on the `daemon` stream only (and GET /v1/events?scope=daemon): a place's setting was changed with PATCH /v1/sandboxes/{name}/settings. `entity` is sandbox:<name>; the envelope text says what changed, from daemon-written labels"),
	"sandbox.resource_action": z.looseObject({
		sandbox: z.string().describe("The place (a listed provider's name)"),
		resourceId: z.string().describe("The machine's id (as GET …/resources lists it)"),
		action: z.string().describe("The action: delete"),
		owner: z.looseObject({
			kind: z.string().describe("agent (more may come)"),
			runId: z.string().nullable(),
			agentId: z.string().nullable(),
			role: z.string().nullable(),
		}).nullable().describe("Who used the machine when the action ran: the agent that was cancelled (ids and role only, never its task); null for a machine left behind"),
		clientId: z.string().describe("The API client that acted (cli-…)"),
	}).describe("Capability sandboxes.actions. Durable, on the `daemon` stream only (and GET /v1/events?scope=daemon): a client's action on a machine (POST /v1/sandboxes/{name}/resources/{id}/actions/{action}) changed something. `entity` is sandbox:<name>; the envelope text is daemon-written (\"Cloud: Delete on machine relay-…: cancelled worker agt-41 of run-8kq2.\"). A Delete is followed by sandbox.resource_deleted with cause action"),
	"sandbox.resource_deleted": z.looseObject({
		sandbox: z.string().describe("The place (a listed provider's name)"),
		resourceId: z.string().describe("The machine's id"),
		cause: z.string().describe("Why capcomd deleted it: action (a client's Delete), idle_lifetime (its idle lifetime ran out: Docker's sweep, or its worker's own lifetime), run_ended (its agent ended and its worker destroyed it). Treat an unknown cause as a deletion for a reason you don't know"),
	}).describe("Capability sandboxes.actions. Durable, on the `daemon` stream only (and GET /v1/events?scope=daemon): a machine capcomd deleted. Only deletes capcomd makes and sees: a provider deleting a machine on its own (boxd's delete-after) isn't reported. `entity` is sandbox:<name>; the envelope text is daemon-written (\"Local: machine relay-… was deleted after its idle lifetime ran out.\")"),
} as const;
export type EventType = keyof typeof EventData;

const DecideBody = z.object({ decision: z.enum(["approve", "deny"]), reason: UntrustedText.optional() });
const IdempotencyHeaders = z.object({ "idempotency-key": z.string().min(8).max(200) });

/** Body of a steer message (POST …/agents/{agentId}/messages): at most this many bytes of UTF-8. */
export const MESSAGE_BODY_MAX_BYTES = 1024 * 1024;
export const RunAction = z.enum(["pause", "resume", "cancel"]);
/** Result of POST /v1/runs/{runId}/pause|resume|cancel. The state change itself arrives as events on the run's streams. */
export const RunControl = z.object({
	runId: z.string(),
	action: RunAction,
	changed: z.array(z.string()).describe("Agents this call changed now. Each is confirmed by agent.paused / agent.resumed / agent.cancelled on the run stream"),
	pending: z.array(z.string()).describe("pause only (else empty): running agents asked to stop. Each stops at its next check with its work pushed to its branch, confirmed by agent.paused (or agent.done / agent.failed when it finished first)"),
});
/** Result of POST /v1/runs/{runId}/agents/{agentId}/pause|resume (capability agent.pause). */
export const AgentControl = z.object({
	runId: z.string(),
	agentId: z.string().describe("The agent the call named; changed and pending may also list its descendants"),
	action: z.enum(["pause", "resume"]),
	changed: z.array(z.string()).describe("Agents this call changed now (the agent and its descendants, target first). Each is confirmed by agent.paused / agent.resumed on the run stream"),
	pending: z.array(z.string()).describe("pause only (else empty): running agents asked to stop. Each stops at its next check with its work pushed to its branch, confirmed by agent.paused (or agent.done / agent.failed when it finished first)"),
});
const SendBody = z.object({
	body: z.string().min(1).describe(`Message text (UTF-8, at most ${MESSAGE_BODY_MAX_BYTES} bytes). Delivered to a running Claude agent at its next step; a Codex agent reads it only from its inbox (see note)`),
	skills: z.array(z.string()).max(SKILLS_PER_MESSAGE_MAX).optional().describe(`Capability steer.skills. Names from GET /v1/skills (at most ${SKILLS_PER_MESSAGE_MAX}; a repeated name is sent once): the agent gets each skill's SKILL.md with the message. ` +
		`An unknown name, or SKILL.md files over ${SKILL_MAX_BYTES} bytes together, is 422 \`invalid\` and sends nothing. The confirming message.sent echoes them as data.skills`),
});
/** Result of POST /v1/runs/{runId}/agents/{agentId}/messages. */
export const SentMessage = z.object({
	runId: z.string(),
	to: z.string().describe("The agent the message was sent to"),
	from: z.string().describe("Sender as threads show it: operator"),
	seq: z.number().int().positive().describe("Thread message seq. The confirming message.sent event carries the same value as data.seq (with data.to = the agent), as does Message.seq in GET /v1/runs/{runId}/messages and snapshot.threads"),
	note: z.string().nullable().describe("When the agent won't read it right away (a Codex agent reads messages only from its inbox); null when it will"),
});

const WRITE_DOC = "Needs the steer scope. `Idempotency-Key` (8-200 chars) is scoped to the calling client and kept 24h: same key + same request: 200 with the first result (replay); " +
	"same key on a different request (another route, run, agent or body): 409 `idempotency_conflict`. Errors: 404 `not_found` (unknown run or agent), 409 `conflict` (state), 422 `invalid`.";

/**
 * GET /v1/health `capabilities`: features added to harness.v1 after clients shipped, so a client checks for one
 * instead of guessing from the version. A name is never reused for something else; a client ignores names it doesn't know.
 */
export const CAPABILITIES = {
	"run.controls": "POST /v1/runs/{runId}/pause, /resume and /cancel",
	"agents.messages": "POST /v1/runs/{runId}/agents/{agentId}/messages: steer an agent with a message",
	"steer.skills": "POST …/agents/{agentId}/messages takes `skills`: names from GET /v1/skills, sent to the agent with the message",
	"agent.pause": "POST /v1/runs/{runId}/agents/{agentId}/pause and /resume: one agent and its descendants",
	"runs.options": "POST /v1/runs takes `driver` (claude or codex), `effort` (the driver's reasoning effort) and `sandbox` (docker or boxd); GET /v1/run-options lists them and whether each is available",
	"runs.options.repo": "GET /v1/run-options takes `repo` (a project checkout, as POST /v1/runs `repo`): the options for a run of that project, with its own agent profiles",
	"runs.options.sandbox": "GET /v1/run-options `drivers[].sandboxes`: whether each driver can run in each sandbox (logins and agent environments are per sandbox); POST /v1/runs refuses a `driver` and `sandbox` that can't go together (422)",
	"agent.steps": "agent.step events: one durable event per finished step of an agent (its kind, count, start and end), in order, replayed by GET /v1/events and delivered on run streams",
	logins: "GET /v1/logins: whether agents can log in to Claude and Codex in each sandbox, how (plan or API key), and the command that logs in",
	environments: "GET /v1/environments: each sandbox's agent environment (ready, missing, building or failed), its tool versions, and the command that builds it",
	service: "GET /v1/service: whether capcomd runs as a background service (installed, loaded), and the commands that install and uninstall it",
	sandboxes: "GET /v1/sandboxes and /v1/sandboxes/{name}: each place agents run as a provider descriptor (label, kind, caps, which settings, info rows and actions it has), with its settings and info as typed fields; GET /v1/logins and /v1/environments take `sandbox`, and logins carry `hostBound` and `boundTo`",
	"sandboxes.resources": "GET /v1/sandboxes/{name}/resources and …/resources/{id}: the machines capcomd's agents run on at that place (owned by an agent, or orphaned), and the `capcomd sandbox shell` command that opens a shell in one",
	"sandboxes.settings": "PATCH /v1/sandboxes/{name}/settings (the `configure` scope): change a place's settings (the idle machine lifetime); fields carry `editable` and `source`, and each change is a sandbox.settings_changed event on the daemon stream. Machines of capcomd's own jobs (checks, logins, environment builds) carry an owner of their `kind` instead of reading as orphaned",
	"sandboxes.actions": "POST /v1/sandboxes/{name}/resources/{id}/actions/delete (the steer scope, an Idempotency-Key): delete a machine. An agent's machine is deleted by cancelling that agent, a machine left behind by its provider; capcomd's own jobs' machines can't be. Resources carry `destructive` and the daemon's `confirm` question; sandbox.resource_action and sandbox.resource_deleted audit it on the daemon stream",
} as const;
export const CAPABILITY_NAMES = Object.keys(CAPABILITIES) as (keyof typeof CAPABILITIES)[];
export const CAPABILITIES_DOC = "a list of names, one per feature added after harness.v1 first shipped; a client checks for the name before offering the feature, and ignores names it doesn't know. " +
	CAPABILITY_NAMES.map((k) => `\`${k}\`: ${CAPABILITIES[k]}`).join("; ") + ".";

/** A place clients may name: a listed provider (src/providers/registry.ts). A string on the wire, so a new provider is
 *  no API change; the daemon refuses names it doesn't list. */
export const SandboxName = z.string().refine(isListedProvider, { message: `not a place agents run: use one of ${LISTED_PROVIDERS.join(", ")}` })
	.describe(`A place agents run: a listed provider's name (GET /v1/sandboxes), today ${LISTED_PROVIDERS.map((n) => `${n} ("${PROVIDER_LABEL[n]}")`).join(", ")}. More may be added: treat an unknown name as a place you don't know`);
/** runs.create: the goal is user-written text, stored as the run's goal (Run.goal); at most this many UTF-8 bytes. */
export const GOAL_MAX_BYTES = 16 * 1024;
export const BranchName = z.string().regex(/^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*[./]$)[A-Za-z0-9._/-]{1,200}$/).describe("Branch name, e.g. capcomd/integration");
export const CreateRunBody = z.object({
	goal: z.string().min(1)
		.refine((g) => g.trim().length > 0, "goal is empty")
		.refine((g) => Buffer.byteLength(g.trim()) <= GOAL_MAX_BYTES, `goal is longer than ${GOAL_MAX_BYTES} bytes (UTF-8)`)
		.refine((g) => !g.includes("\u0000"), "goal contains a NUL character")
		.refine((g) => !/^\s*\[agent:/i.test(g), "goal starts with an [agent:…] directive; pick the profile with `profile` instead")
		.describe(`What the run should do, as the user wrote it (leading and trailing whitespace trimmed; at most ${GOAL_MAX_BYTES} bytes, UTF-8). Stored as the run's goal.`),
	repo: z.string().refine((p) => p.startsWith("/"), "repo must be an absolute path").optional()
		.describe("Absolute path of a project checkout on the daemon's machine, one `capcomd setup project` ran in: its .capcomd/config.json gives the run's repository, merge mode, target, checks and agent profiles. Omitted: the daemon's own repository settings (CAPCOMD_REPO); 422 when it has none."),
	profile: ProfileName.max(63).optional().describe("Agent profile, as `capcomd run --profile`: the worker of the built-in recipe. Refused (422) when the run uses a planner agent, which picks its own workers."),
	targetBranch: BranchName.optional().describe("Branch the run's work merges into (`capcomd run --target-branch`); default: the project's target."),
	driver: AgentProvider.optional().describe("Capability runs.options. Who drives the run: the provider of its planner agent (`capcomd run --planner-provider`). The run uses the project's planner profile on that provider: as it is when it already uses it, else with the provider swapped and that provider's model and login (another of the project's profiles on it, else the provider's defaults). Implies a planner agent, so not with `profile`. 422 when there is no planner profile or the provider can't run (no login or API key). Omitted: the planner profile's own provider. GET /v1/run-options lists both."),
	effort: z.string().min(1).max(32).optional().describe("Capability runs.options. The reasoning effort of the run's planner (the driver): one of that driver's `efforts` in GET /v1/run-options (the `driver` given, else the default driver), else 422. Omitted: the driver's `effort` there (the planner profile's level, else the provider's default)."),
	sandbox: SandboxName.optional().describe("Capability runs.options. Where this run's agents and checks run (`capcomd run --sandbox`): a listed place's name (GET /v1/run-options `sandboxes`), today docker (containers on the daemon's machine) or boxd (cloud VMs), for this run only; the daemon's own CAPCOMD_SANDBOX is unchanged. 422 when it isn't one, or isn't available (Docker not running, no boxd API key). Omitted: the daemon's sandbox."),
});
export const CREATE_RUN_DOC = "Start a run on a goal, always detached (`capcomd run --detach <goal>` in the project's directory): returns at once with the new run, `state: \"starting\"`; " +
	"the `daemon` and `prj-…` streams then announce it with `run.created` like a run started from the CLI. Needs the `steer` scope. " +
	"`Idempotency-Key` is scoped to the calling client: same key + same body replays the first response (201, header `Idempotent-Replayed: true`) without starting another run; " +
	"same key + different body: 409 `idempotency_conflict`. Keys are kept 24 h; a request that failed (422, 500) is not recorded, so retrying it with the same key tries again. " +
	"422 `invalid` for a bad body, a `repo` that isn't a project checkout, no repository at all, `profile` with `driver`, a `driver` or `sandbox` that isn't available, or a run `capcomd run` itself refuses (unknown profile, no planner profile); `message` says which.";

/** GET /v1/run-options: the choices POST /v1/runs takes for `driver` and `sandbox`, and whether each can be used now. */
export const DriverFit = z.object({
	available: z.boolean(),
	reason: z.string().nullable().describe("Why not, one short sentence naming the command that fixes it (trusted), e.g. \"Not logged in to Claude Code for Local (run `capcomd auth login claude --sandbox docker`)\", \"No agent environment for Local yet (run `capcomd env build --sandbox docker`)\"; null when available"),
});
export const DriverOption = z.object({
	provider: AgentProvider,
	label: z.string().describe("What to call it: \"Claude Code\" or \"Codex\""),
	model: z.string().nullable().describe("The model the planner would run with on this provider; null: the provider CLI's default"),
	efforts: z.array(z.string()).describe("Reasoning effort levels this provider takes, lowest to highest (POST /v1/runs `effort`); empty when the daemon can't set its effort"),
	effort: z.string().nullable().describe("The level a run gets when none is chosen: the planner profile's, else the provider's default; null: the provider CLI decides (claude: by model)"),
	available: z.boolean(),
	reason: z.string().nullable().describe("Why it isn't available, one short sentence written by the daemon (trusted), e.g. \"Not logged in to Codex (run capcomd auth login codex)\"; null when available"),
	default: z.boolean().describe("The provider of the daemon's planner profile: what a run without `driver` uses"),
	sandboxes: z.record(z.string(), DriverFit).describe("Capability runs.options.sandbox. Keyed by place name: one entry per `sandboxes[]` entry (today docker and boxd). Whether this provider can drive a run in each sandbox: `available` and `reason` above are for the daemon's own sandbox, these for a run's `sandbox` (logins and agent environments are per sandbox). Whether the sandbox itself is up is `sandboxes[]`. POST /v1/runs with `driver` (or the default driver) and `sandbox` is 422 with this `reason` when it isn't available"),
});
export const SandboxOption = z.object({
	name: z.string().describe(`A listed place's name, today ${LISTED_PROVIDERS.join(" or ")}`),
	label: z.string().describe("What to call it: \"Local\" (docker) or \"Cloud\" (boxd)"),
	available: z.boolean(),
	reason: z.string().nullable().describe("Why it isn't available (trusted), e.g. \"Docker isn't running\", \"No boxd API key (run capcomd setup)\"; null when available"),
	default: z.boolean().describe("The daemon's own CAPCOMD_SANDBOX: what a run without `sandbox` uses (none is default when the daemon runs another sandbox)"),
});
export const RunOptions = z.object({
	drivers: z.array(DriverOption).describe("Always claude, then codex"),
	sandboxes: z.array(SandboxOption).describe("Every listed place, in order: today docker, then boxd"),
});
export const RUN_OPTIONS_DOC = "Capability runs.options. Who can drive a new run and where it can run: the values POST /v1/runs takes for `driver` and `sandbox`, each with whether it can be used now and why not, and (capability runs.options.sandbox) whether each driver can run in each sandbox. Needs the `read` scope. Cheap checks (logins, API keys, the boxd key, agent environments, whether Docker answers, cached a few seconds), so poll it freely. " +
	"`repo` (capability runs.options.repo): the answer for a run of that project, as POST /v1/runs with the same `repo` starts it: its settings and agent profiles (.capcomd/agents.json from `capcomd setup project`), not the daemon's. 422 `invalid` when it isn't a project checkout, with the message POST /v1/runs gives.";
export const RunOptionsQuery = z.object({
	repo: z.string().refine((p) => p.startsWith("/"), "repo must be an absolute path").optional()
		.describe("Capability runs.options.repo. Absolute path of a project checkout on the daemon's machine, as POST /v1/runs `repo`. Omitted: the daemon's own settings and profiles."),
});

/** GET /v1/logins, /v1/environments, /v1/service: what the app's Settings window shows. Local state only. */
const SettingsSandbox = z.string().describe(`Where agents run: a listed place's name, today ${LISTED_PROVIDERS.map((n) => `${n} ("${PROVIDER_LABEL[n]}")`).join(" or ")}`);
export const Login = z.object({
	provider: AgentProvider,
	sandbox: SettingsSandbox,
	loggedIn: z.boolean().describe("Agents of this provider can log in in this sandbox"),
	how: z.enum(["plan", "api_key"]).nullable().describe("plan: a plan login (`capcomd auth login`) saved for this sandbox; api_key: ANTHROPIC_API_KEY / OPENAI_API_KEY is set for the daemon, or (boxd) kept as a boxd secret with CAPCOMD_CREDENTIALS=secret. A plan login wins when there are both. null when not logged in"),
	detail: z.string().nullable().describe("Where the login lives, one short sentence written by the daemon (trusted, never a credential), e.g. \"Kept as a boxd secret bound to api.anthropic.com\", \"Saved in the agent environment\"; null when not logged in"),
	hostBound: z.boolean().describe("Capability sandboxes. The login is a host-bound secret: the platform swaps it in on the way to `boundTo`, so agents only ever see a placeholder (a plan login stored as a secret, or CAPCOMD_CREDENTIALS=secret). false when not logged in, or when agents can read it (kept in the agent environment, or an API key passed to the agent)"),
	boundTo: z.string().nullable().describe("Capability sandboxes. The host the login is bound to (the AI's API host, e.g. api.anthropic.com) when `hostBound`; else null"),
	command: z.string().describe("The CLI that logs in there, e.g. `capcomd auth login claude --sandbox docker` (interactive: run it in a terminal)"),
});
export const Logins = z.object({ logins: z.array(Login).describe("Claude, then Codex, each in every listed place (today four: claude in docker, claude in boxd, codex in docker, codex in boxd); with `sandbox`, that place's only") });
export const LOGINS_DOC = "Capability logins. Who agents can log in as, per AI and per sandbox (plan logins are saved per sandbox). Needs the `read` scope. Local files and the daemon's environment only (no VM, container or network call), so poll it freely. Never contains a credential. " +
	"`sandbox` (capability sandboxes): only that place's logins; 404 `not_found` for a name that isn't a listed place.";
export const SandboxQuery = z.object({ sandbox: z.string().optional().describe("Capability sandboxes. Only this place (a listed place's name, GET /v1/sandboxes); 404 when it isn't one") });
export const Environment = z.object({
	sandbox: SettingsSandbox,
	status: z.enum(["ready", "missing", "building", "failed"]).describe("building: a `capcomd env build` for this sandbox is running now; failed: the last build failed (`name`, `versions` and `builtAt` then still describe the environment agents use, if any); ready: agents boot from `name`; missing: none built yet (agents can't run real CLIs there)"),
	name: z.string().nullable().describe("The environment agents boot from (an env snapshot); null when none"),
	versions: z.record(z.string(), z.string()).describe("Tool versions in it by tool (claude, codex, node): what the build found or installed, else its pins; empty when unknown"),
	builtAt: Timestamp.nullable().describe("When it was built; null when unknown or none"),
	command: z.string().describe("The CLI that builds (or rebuilds) it, e.g. `capcomd env build --sandbox docker`"),
});
export const Environments = z.object({ environments: z.array(Environment).describe("One per listed place, in order (today two: docker, then boxd); with `sandbox`, that place's only") });
export const ENVIRONMENTS_DOC = "Capability environments. The agent environment (env snapshot) each sandbox's agents boot from. Needs the `read` scope. Local files only (the env ledger and the build's marker), so poll it freely. " +
	"`sandbox` (capability sandboxes): only that place's environment; 404 `not_found` for a name that isn't a listed place.";
export const ServiceStatus = z.object({
	installed: z.boolean().describe("The service definition is installed (`capcomd service install`: a launchd agent on macOS, a systemd user unit on Linux)"),
	loaded: z.boolean().describe("launchd (systemd) has it loaded: it starts capcomd at login and restarts it when it crashes"),
	installCommand: z.string().describe("`capcomd service install`"),
	uninstallCommand: z.string().describe("`capcomd service uninstall`"),
});
export const SERVICE_DOC = "Capability service. Whether capcomd runs as a background service. Needs the `read` scope. Reads the service definition, and asks launchd (systemd) whether it is loaded at most every few seconds, for at most a second.";


/** ADR-021: the provider surface for a place's details screen (GET /v1/sandboxes…). */
export const SandboxCaps = z.object({
	isolation: z.string().describe("Where an agent's commands run: vm, container (or host, for test fakes). More may be added"),
	snapshots: z.boolean().describe("Saved images to boot from: agent environments (`capcomd env build`) and plan logins"),
	hostBoundSecrets: z.boolean().describe("Logins can be bound to their AI's API host, so agents only see a placeholder"),
	egressAllowlist: z.boolean().describe("A profile's `egress` can limit which hosts agents reach"),
	interactive: z.boolean().describe("A command with a terminal (interactive logins)"),
	idleLifetime: z.string().describe("Who deletes a machine left behind: platform (the provider itself), sweep (capcomd, every 5 minutes), none. More may be added"),
	shell: z.boolean().describe("A shell into a live machine (`capcomd sandbox shell`)"),
});
export const SandboxDescriptor = z.object({
	name: z.string().describe("What the API and CAPCOMD_SANDBOX call it"),
	descriptorVersion: z.number().int().positive().describe("1. Bumped only by a breaking change to this shape; additions never bump it"),
	label: z.string().describe("What to call the place: \"Local\", \"Cloud\""),
	kind: z.string().describe("local or cloud: how to group it and which glyph to fall back to. Render an unknown kind as cloud"),
	vendor: z.string().describe("Who provides it: what the title says after the dot (\"Docker\", \"boxd\")"),
	title: z.string().describe("\"Cloud · boxd\""),
	mark: z.string().describe("Id of a mark the app bundles (docker, boxd); fall back to the kind's glyph for an id you don't have. Never an image"),
	listed: z.boolean().describe("Always true here (unlisted test providers are never served)"),
	caps: SandboxCaps.describe("What it can do. Ignore caps you don't know"),
	settings: z.array(z.string()).describe("Setting ids its details show (idleLifetime). Ignore ids you don't know"),
	info: z.array(z.string()).describe("Info row ids its details show (logins, checkpoints). Ignore ids you don't know"),
	resourceKinds: z.array(z.string()).describe("Kinds of resource it lists (machine)"),
	actions: z.array(z.string()).describe("Resource actions this daemon serves for it, from a closed list: open_terminal, delete (capability sandboxes.actions; more come with later capabilities). Ignore actions you don't know"),
});
export const SandboxSummary = SandboxDescriptor.extend({
	available: z.boolean().describe("It can be used now (as GET /v1/run-options `sandboxes[].available`)"),
	reason: z.string().nullable().describe("Why not, written by the daemon (trusted), e.g. \"Docker isn't running\"; null when available"),
	default: z.boolean().describe("The daemon's own CAPCOMD_SANDBOX: what a run without `sandbox` uses"),
});
export const Sandboxes = z.object({ sandboxes: z.array(SandboxSummary).describe("Every listed place, in order: today docker, then boxd") });
export const FieldChoice = z.object({ value: z.string(), label: z.string().describe("Daemon-written, e.g. \"1 hour\"") });
export const SandboxField = z.object({
	id: z.string().describe("Stable id: idleLifetime (settings); logins, checkpoints (info). More may be added"),
	type: z.string().describe("choice (a Picker of `choices`), toggle, info or status (read-only rows). Render a type you don't know as a read-only row of `label` and `display`"),
	label: z.string().describe("Row title (daemon-written)"),
	help: z.string().nullable().describe("A footnote under the row (daemon-written, trusted); null when none"),
	value: z.string().nullable().describe("The current value as a string (a choice's `value`: idleLifetime in seconds; a toggle's \"true\"/\"false\"; an info row's machine-readable value, e.g. logins: bound, partial, unbound, none; checkpoints: the interval in ms)"),
	display: z.string().describe("The value as a sentence the daemon writes (\"1 hour\", \"Bound\", \"After each commit and every 10 minutes\"): what a row shows"),
	default: z.string().nullable().describe("A setting's default value; null for info rows"),
	choices: z.array(FieldChoice).describe(`A choice's options, in order (idleLifetime: ${IDLE_LIFETIME_CHOICES.map((c) => `${c.value} "${c.label}"`).join(", ")}); empty for other types`),
	source: z.string().describe("Where the value comes from: default (the place's default), env (an environment variable wins: editable is false and display says which, e.g. \"Set by CAPCOMD_SANDBOX_IDLE_SECONDS in capcomd's environment\"), config (capcomd's user config: the user chose it), daemon (an info row the daemon works out)"),
	editable: z.boolean().describe("Capability sandboxes.settings: the user can change it here with PATCH /v1/sandboxes/{name}/settings (needs the configure scope). false for info rows, a setting an environment variable sets, and every row of a daemon without sandboxes.settings"),
	appliesTo: z.string().nullable().describe("new_runs: a change applies to runs started after it; null for info rows"),
	needsRestart: z.boolean().describe("A change needs the daemon restarted"),
	state: z.string().nullable().describe("A status row's dot: ok, warn, bad or none (render an unknown value as none); null on every other type"),
});
export const SandboxDetail = z.object({
	descriptor: SandboxDescriptor,
	settings: z.array(SandboxField).describe("Its settings, in the descriptor's order (idleLifetime: how long a machine left behind lives, in seconds; at least 900)"),
	info: z.array(SandboxField).describe("Read-only rows: logins (a summary of GET /v1/logins?sandbox=name: \"Bound\" only when every logged-in login here is bound to its AI's API host, else which aren't), checkpoints (when agents save their work)"),
	rev: z.string().describe("Changes whenever a setting's value, source or editability does; PATCH …/settings sends it back (a stale one is 409 conflict)"),
});
export const SettingsBody = z.object({
	values: z.record(z.string(), z.string()).describe("Setting id → the new value, one of the field's `choices` values (idleLifetime: \"900\", \"3600\", \"14400\" or \"43200\", seconds)"),
	rev: z.string().min(1).max(200).describe("The `rev` of the GET /v1/sandboxes/{name} the change was made from"),
});
export const SETTINGS_DOC = "Capability sandboxes.settings. Change a place's settings: the body names each setting by id with a value from its `choices`, and the `rev` it was read with. Needs the `configure` scope (403 `forbidden` without it: settings change what future runs do, like how long their machines and billing live). " +
	"Stored in capcomd's user config (`~/.capcomd/config.json` `sandboxes.<name>.<id>`), never in a project's; it applies to runs started after it (`appliesTo: new_runs`: each run records the settings it started with), and needs no restart. Answers like GET /v1/sandboxes/{name}, with the new values and `rev`. " +
	"Every change is audited: a durable sandbox.settings_changed event on the `daemon` stream ({sandbox, id, from, to, clientId}). " +
	"409 `conflict` when `rev` isn't the current one (the body carries the current `rev`: read the place again, then retry). 422 `invalid` for a setting the place doesn't have, a value not in its `choices`, an idle lifetime under 15 minutes, or a setting that isn't editable (an environment variable such as CAPCOMD_SANDBOX_IDLE_SECONDS sets it); `message` says which. 404 `not_found` for a name that isn't a listed place.";
export const SANDBOX_DOC = "Capability sandboxes. One place agents run: its descriptor, its settings and its info rows as typed fields the app renders generically (an unknown field type renders as a read-only `label` and `display`). " +
	"Needs the `read` scope. Local reads only (no provider call), so poll it freely. Never contains a credential: every `display`, `help` and `reason` is written by the daemon. 404 `not_found` for a name that isn't a listed place. " +
	"`v`: the descriptor version the client understands (only 1 exists).";
export const ResourceOwner = z.object({
	kind: z.string().describe("Capability sandboxes.settings. Who uses it: agent (an agent's machine), or one of capcomd's own short jobs: check (a run's checks), login (`capcomd auth login` or `auth status`), env_build (`capcomd env build`), doctor (`capcomd env doctor`). Treat an unknown kind like a job of capcomd's: never left behind. Absent from older daemons: agent"),
	runId: z.string().nullable().describe("The run (agent, check); null for a job that belongs to no run"),
	agentId: z.string().nullable().describe("The agent (kind agent); null otherwise"),
	role: z.string().nullable().describe("An agent's profile (planner, worker, reviewer…), null when it has none; for capcomd's own jobs a word for the job: checks, login, environment"),
	task: UntrustedText.nullable().describe("Agent-written text: render as plain text, never markdown, links or actions. The first line of the agent's task, at most 200 characters; null for capcomd's own jobs"),
	label: z.string().nullable().describe("Capability sandboxes.settings. For capcomd's own jobs, a daemon-written line (\"Checks for run-8kq2\", \"Logging in to Claude Code\", \"Building the agent environment\"); null for agents"),
});
export const SandboxResource = z.object({
	id: z.string().describe("The machine's name at the provider: capcomd's prefix (relay-) and letters, digits, `.`, `_`, `-` (at most 128). Stable for the machine's life"),
	kind: z.string().describe("machine. More may be added"),
	state: z.string().describe("starting, running, orphaned (this capcomd made it, by its machines ledger, and nothing in capcomd uses it now: no live agent and none of capcomd's own jobs; a machine left behind, deleted when its idle lifetime is up), stopping, unknown (the provider or capcomd's records didn't answer, or who uses it can't be told); asleep is reserved (no machine sleeps today). Treat an unknown state as unknown"),
	owner: ResourceOwner.nullable().describe("Who uses it, from capcomd's own records (never from provider labels): an agent (its worker), or one of capcomd's own jobs (a ledger capcomd writes when it makes the machine); null when orphaned or unknown"),
	createdAt: Timestamp.nullable().describe("When it was created; null when unknown"),
	deleteAfter: Timestamp.nullable().describe("When it will be deleted if nothing renews it (the provider's delete-after time; Docker: capcomd's sweep, up to 5 minutes later); null when unknown. A running agent renews it every 10 minutes"),
	actions: z.array(z.string()).describe("Actions this daemon serves on it now: open_terminal (GET …/resources/{id} `terminalCommand`); delete (capability sandboxes.actions: POST …/resources/{id}/actions/delete; an agent's machine while it isn't starting or stopping, and one left behind). Machines of capcomd's own jobs have none. Ignore actions you don't know"),
	destructive: z.boolean().optional().describe("Capability sandboxes.actions. An action here can't be undone (delete): ask first, with `confirm`, and a destructive button. Absent from older daemons: false"),
	confirm: z.string().nullable().optional().describe("Capability sandboxes.actions. The question to ask before deleting it, written by the daemon: for an agent's machine it names the agent and says its work since the last checkpoint is lost (\"Delete worker's machine? This stops the worker on “Add an abs(a) function…”. Work since its last checkpoint is lost.\"); for one left behind, \"Delete this machine? No agent is using it.\" The quoted task is the agent's (untrusted): show it as plain text. null without a destructive action"),
});
export const ResourcePage = z.object({
	resources: z.array(SandboxResource).describe("Sorted by id"),
	asOf: Timestamp.nullable().describe("When the provider's list this answer reflects was taken; null when it never answered"),
	stale: z.boolean().describe("The last attempt to list failed (`error`): resources come from the last list that worked, and capcomd's records"),
	error: z.string().nullable().describe("Why the provider's list failed, written by the daemon (trusted), e.g. \"boxd didn't answer within 3 seconds\"; null when it worked"),
	next: z.string().nullable().describe("More resources: pass as `cursor` for the next page; null at the end"),
});
export const ResourceDetail = SandboxResource.extend({
	terminalCommand: z.string().nullable().describe("The command that opens a shell in this machine (run it in Terminal): `capcomd sandbox shell <runId> <agentId>` for an agent's machine, `capcomd sandbox shell --sandbox <name> --machine <id>` for an orphan. Built from trusted ids only: a plain capcomd invocation of letters, digits and `._-` words. null without open_terminal"),
});
export const RESOURCES_PAGE_MAX = 200;
export const RESOURCES_DOC = "Capability sandboxes.resources. The machines capcomd's agents run on at this place: capcomd's own records (which agent holds which machine) joined with the provider's list of machines with capcomd's prefix; one with no live owner is `orphaned` when it's in this capcomd's machines ledger (it made it), and isn't listed otherwise (another capcomd's machine: a boxd org lists every member's, and a second capcomd on this Mac sees the same containers). " +
	"Needs the `read` scope. The provider is asked at most every 10 s (one request at a time, 3 s timeout), never once per machine; when it fails, the answer is still 200, from the last list that worked, with `stale: true` and `error`. " +
	`\`limit\` (default 100, at most ${RESOURCES_PAGE_MAX}) and \`cursor\` (the previous page's \`next\`) page through them. 404 \`not_found\` for a name that isn't a listed place.`;
export const ResourceActionResult = z.object({
	resource: SandboxResource.nullable().describe("The machine as capcomd saw it just before acting, now `stopping` with no actions when this call deleted it; null when it was already gone"),
	changed: z.boolean().describe("This call deleted it (true), or it was already gone (false). A replay answers what the first call did"),
});
export const ACTION_DOC = "Capability sandboxes.actions. Act on one machine; today the only action is delete (no body, no parameters). Needs the steer scope (403 `forbidden` without it), like cancelling a run. " +
	"An agent's machine: that agent (and the agents it started) is cancelled through the normal cancel path, as POST …/cancel and `capcomd cancel <runId> <agt>` do (agent.cancelled on the run stream), and its lifecycle destroys the machine; the provider is never called for it directly. " +
	"A machine left behind (`orphaned`): the provider deletes it. A machine of capcomd's own jobs (checks, logins, environment builds): 409 `conflict`. " +
	"The id must be a machine capcomd lists at this place (only ids with capcomd's prefix, and only machines a live owner holds or this capcomd's machines ledger records: another capcomd's machine is 404 and never reaches the provider; no batch or wildcard ids). Right before acting the daemon reads the machine again: when who uses it changed (an orphan an agent now uses, an agent that ended) it is 409 `conflict` and nothing is deleted; a machine already gone is 200 with `changed: false`. " +
	"One action at a time per machine (another one under way: 409). 503 `unavailable` when the provider (or capcomd's records) doesn't answer in time: nothing was deleted, or, when the agent was already asked to stop, its machine may still go. " +
	"404 `not_found` for a place that isn't listed, an unknown machine, an unknown action, open_terminal (read with GET …/resources/{id}), or an action the place's provider doesn't declare. " +
	"Audited on the daemon stream: sandbox.resource_action {sandbox, resourceId, action, owner, clientId}, then sandbox.resource_deleted {sandbox, resourceId, cause: action}. " +
	"`Idempotency-Key` (8-200 chars, required: 422 `invalid` without it) is scoped to the calling client and kept 24h: same key + same request: 200 with the first result (replay, nothing deleted twice); the same key on another machine or action: 409 `idempotency_conflict`. Only a 200 is kept: after an error, a retry looks again.";
export const RESOURCE_DOC = "Capability sandboxes.resources. One machine (as in …/resources, from the same cached list) and `terminalCommand`, the command that opens a shell in it. 404 `not_found` when capcomd doesn't list it at this place (only ids with capcomd's prefix are ever looked up).";

export const contract = {
	health: oc.route({ method: "GET", path: "/v1/health", description: "Liveness; no token needed. `capabilities` is how a client feature-detects (Capabilities in docs/harness-contract.md)." })
		.output(z.object({ ok: z.literal(true), api: z.literal("harness.v1"), version: z.string(), capabilities: z.array(z.string()).optional().describe(`Features this daemon has: ${CAPABILITIES_DOC} This daemon always sends it; optional because daemons from before capabilities don't: treat a missing list as empty`) })),
	projects: {
		list: oc.route({ method: "GET", path: "/v1/projects" }).output(z.array(Project)),
	},
	runs: {
		list: oc.route({ method: "GET", path: "/v1/runs" }).output(z.array(Run)),
		create: oc.route({ method: "POST", path: "/v1/runs", successStatus: 201, inputStructure: "detailed", description: CREATE_RUN_DOC })
			.input(z.object({ headers: z.object({ "idempotency-key": z.string().min(8).max(200) }), body: CreateRunBody }))
			.output(Run),
		get: oc.route({ method: "GET", path: "/v1/runs/{runId}" }).input(z.object({ runId: z.string() })).output(Run),
		trace: oc.route({ method: "GET", path: "/v1/runs/{runId}/trace", description: "Trace spans of the run, in start order." }).input(z.object({ runId: z.string() })).output(z.array(Span)),
		messages: oc.route({ method: "GET", path: "/v1/runs/{runId}/messages", description: "Thread history of the run." })
			.input(z.object({ runId: z.string(), after: z.coerce.number().int().nonnegative().optional() })).output(z.array(Message)),
		lifecycle: oc.route({ method: "GET", path: "/v1/runs/{runId}/lifecycle", description: LIFECYCLE_DOC })
			.input(z.object({ runId: z.string(), after: z.coerce.number().int().nonnegative().optional() })).output(z.array(HarnessEvent)),
		files: oc.route({ method: "GET", path: "/v1/runs/{runId}/files", description: FILES_DOC })
			.input(z.object({ runId: z.string(), agentId: z.string().optional(), limit: z.coerce.number().int().positive().max(FILES_MAX).optional() })).output(RunFiles),
		pause: oc.route({
			method: "POST", path: "/v1/runs/{runId}/pause", inputStructure: "detailed",
			description: `Pause every pending or running agent of the run (no body). An agent that hasn't started is paused now (\`changed\`); a running one is asked to stop (\`pending\`): ` +
				"at its next check it stops, its work is committed and pushed to its branch, and it is paused. Confirmed by agent.paused per agent and run.paused once every live agent is paused. " +
				`409 \`conflict\` when no agent is pending or running. ${WRITE_DOC}`,
		}).input(z.object({ params: z.object({ runId: z.string() }), headers: IdempotencyHeaders })).output(RunControl),
		resume: oc.route({
			method: "POST", path: "/v1/runs/{runId}/resume", inputStructure: "detailed",
			description: "Run every paused agent of the run again now (no body): paused here, with `capcomd pause`, or by a provider usage limit (that login's recorded limit is cleared). " +
				"Each continues from its work on its branch as its next attempt. Confirmed by agent.resumed per agent and run.resumed. " +
				`409 \`conflict\` when no agent is paused. ${WRITE_DOC}`,
		}).input(z.object({ params: z.object({ runId: z.string() }), headers: IdempotencyHeaders })).output(RunControl),
		cancel: oc.route({
			method: "POST", path: "/v1/runs/{runId}/cancel", inputStructure: "detailed",
			description: "Stop the run (no body): every agent that hasn't ended is cancelled and its VM destroyed (`capcomd cancel <runId>`). " +
				"Confirmed by agent.cancelled per agent and run.cancelled. " +
				`409 \`conflict\` when the run has already ended (a run with no agent running is cancelled, not refused). ${WRITE_DOC}`,
		}).input(z.object({ params: z.object({ runId: z.string() }), headers: IdempotencyHeaders })).output(RunControl),
	},
	agents: {
		tree: oc.route({ method: "GET", path: "/v1/runs/{runId}/agents" }).input(z.object({ runId: z.string() })).output(z.array(Agent)),
		transcript: oc.route({
			method: "GET", path: "/v1/runs/{runId}/agents/{agentId}/transcript",
			description: `Full transcript, paged: \`after\` is the last seq you have, \`limit\` at most ${TRANSCRIPT_PAGE_MAX}. Each item's text is at most ${INLINE_TEXT_MAX_BYTES} bytes (§5 limits).`,
		}).input(z.object({ runId: z.string(), agentId: z.string(), after: z.coerce.number().int().nonnegative().optional(), limit: z.coerce.number().int().positive().max(TRANSCRIPT_PAGE_MAX).optional() }))
			.output(TranscriptPage),
		thread: oc.route({ method: "GET", path: "/v1/runs/{runId}/agents/{agentId}/thread", description: `The agent's thread items (format ${THREAD_FORMAT}), paged by write cursor: \`after\` is the highest seq you have, \`limit\` at most ${THREAD_PAGE_MAX}. See "Agent threads" in docs/harness-contract.md.` })
			.input(z.object({ runId: z.string(), agentId: z.string(), after: z.coerce.number().int().nonnegative().optional(), limit: z.coerce.number().int().positive().max(THREAD_PAGE_MAX).optional() }))
			.output(ThreadPage),
		workspace: oc.route({ method: "GET", path: "/v1/runs/{runId}/agents/{agentId}/workspace", description: "A file of the agent's latest work, raw bytes (workspace media). See \"Agent threads\" in docs/harness-contract.md." })
			.input(z.object({ runId: z.string(), agentId: z.string(), path: z.string().min(1).max(1024) })).output(z.string().describe("The file's bytes")),
		send: oc.route({
			method: "POST", path: "/v1/runs/{runId}/agents/{agentId}/messages", inputStructure: "detailed",
			description: "Steer: send the agent a message from the operator (`capcomd send <runId> <agt> <text>`). Returns the thread `seq`; the message.sent event on the run stream " +
				"with the same `data.seq` (and `data.to` = agentId) confirms it, so a client can match its optimistic bubble. 409 `conflict` when the agent has ended (nothing would read it). " +
				`422 \`invalid\` when \`body\` is empty or over ${MESSAGE_BODY_MAX_BYTES} bytes, or a skill is unknown or too many. The same key with other \`skills\` is another request (409 \`idempotency_conflict\`). ${WRITE_DOC}`,
		}).input(z.object({ params: z.object({ runId: z.string(), agentId: z.string() }), headers: IdempotencyHeaders, body: SendBody })).output(SentMessage),
		pause: oc.route({
			method: "POST", path: "/v1/runs/{runId}/agents/{agentId}/pause", inputStructure: "detailed",
			description: "Capability agent.pause. Pause one agent and its descendants (no body), as `capcomd pause <runId> <agt>`; the rest of the run keeps working. " +
				"One that hasn't started is paused now (`changed`); a running one is asked to stop (`pending`): at its next check (about every 2 s) it stops, its work is committed and pushed to its branch (`Capcomd-Stop: paused`), and it is paused. " +
				"Confirmed by agent.paused per agent (data.result.limit \"paused\", data.result.by client:<id>). The run's own state follows its agents: run.paused when this leaves every live agent of the run paused, else the run stays running. " +
				`409 \`conflict\` when neither the agent nor any descendant is pending or running. ${WRITE_DOC}`,
		}).input(z.object({ params: z.object({ runId: z.string(), agentId: z.string() }), headers: IdempotencyHeaders })).output(AgentControl),
		resume: oc.route({
			method: "POST", path: "/v1/runs/{runId}/agents/{agentId}/resume", inputStructure: "detailed",
			description: "Capability agent.pause. Run the agent and its paused descendants again now (no body), as `capcomd resume <runId> <agt>`: paused here, by a run pause, or by a provider usage limit (that login's recorded limit is cleared). " +
				"Each continues from its work on its branch as its next attempt. Confirmed by agent.resumed per agent, and run.resumed when the run was paused. " +
				`409 \`conflict\` when neither the agent nor any descendant is paused. ${WRITE_DOC}`,
		}).input(z.object({ params: z.object({ runId: z.string(), agentId: z.string() }), headers: IdempotencyHeaders })).output(AgentControl),
	},
	attachments: {
		get: oc.route({ method: "GET", path: "/v1/runs/{runId}/attachments/{attachmentId}", description: "Full text of an over-64 KB body, or an image a tool returned (base64, `encoding: \"base64\"`; prefer …/content for its bytes)." })
			.input(z.object({ runId: z.string(), attachmentId: z.string().regex(/^att-[0-9a-f]+$/) })).output(Attachment),
		content: oc.route({ method: "GET", path: "/v1/runs/{runId}/attachments/{attachmentId}/content", description: ATTACHMENT_CONTENT_DOC })
			.input(z.object({ runId: z.string(), attachmentId: z.string().regex(/^att-[0-9a-f]+$/) })).output(z.string().describe("The attachment's bytes")),
	},
	runOptions: {
		get: oc.route({ method: "GET", path: "/v1/run-options", description: RUN_OPTIONS_DOC }).input(RunOptionsQuery).output(RunOptions),
	},
	logins: {
		list: oc.route({ method: "GET", path: "/v1/logins", description: LOGINS_DOC }).input(SandboxQuery).output(Logins),
	},
	environments: {
		list: oc.route({ method: "GET", path: "/v1/environments", description: ENVIRONMENTS_DOC }).input(SandboxQuery).output(Environments),
	},
	sandboxes: {
		list: oc.route({ method: "GET", path: "/v1/sandboxes", description: "Capability sandboxes. Every listed place agents run, as its provider descriptor, with whether it can be used now (as GET /v1/run-options says) and whether it is the daemon's default. Needs the `read` scope. Local checks only, so poll it freely." })
			.input(z.object({ v: z.coerce.number().int().positive().optional().describe("Descriptor version the client understands (only 1 exists)") })).output(Sandboxes),
		get: oc.route({ method: "GET", path: "/v1/sandboxes/{name}", description: SANDBOX_DOC })
			.input(z.object({ name: z.string(), v: z.coerce.number().int().positive().optional().describe("Descriptor version the client understands (only 1 exists)") })).output(SandboxDetail),
		resources: oc.route({ method: "GET", path: "/v1/sandboxes/{name}/resources", description: RESOURCES_DOC })
			.input(z.object({ name: z.string(), limit: z.coerce.number().int().positive().max(RESOURCES_PAGE_MAX).optional(), cursor: z.string().max(200).optional().describe("The previous page's `next`") })).output(ResourcePage),
		resource: oc.route({ method: "GET", path: "/v1/sandboxes/{name}/resources/{id}", description: RESOURCE_DOC })
			.input(z.object({ name: z.string(), id: z.string() })).output(ResourceDetail),
		settings: oc.route({ method: "PATCH", path: "/v1/sandboxes/{name}/settings", inputStructure: "detailed", description: SETTINGS_DOC })
			.input(z.object({ params: z.object({ name: z.string() }), body: SettingsBody })).output(SandboxDetail),
		action: oc.route({ method: "POST", path: "/v1/sandboxes/{name}/resources/{id}/actions/{action}", inputStructure: "detailed", description: ACTION_DOC })
			.input(z.object({ params: z.object({ name: z.string(), id: z.string(), action: z.string().describe("delete") }), headers: IdempotencyHeaders })).output(ResourceActionResult),
	},
	service: {
		get: oc.route({ method: "GET", path: "/v1/service", description: SERVICE_DOC }).output(ServiceStatus),
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
			.input(z.object({ params: z.object({ scope: Scope }), query: z.object({ feed: z.enum(["lifecycle"]).optional().describe("Run scopes: lifecycle events only"), activity: z.enum(["0", "1"]).optional().describe("Run scopes: 1 adds live, ephemeral agent.activity_changed frames (at most one per agent per second)"), thread: z.enum(["0", "1"]).optional().describe("Run scopes: 1 adds live, ephemeral agent.thread_item_changed frames (at most four per item per second)") }), headers: z.object({ "last-event-id": z.string().regex(/^\d+$/).optional() }) }))
			.output(eventIterator(HarnessEvent)),
	},
	approvals: {
		decide: oc
			.route({
				method: "POST", path: "/v1/approvals/{approvalId}/decision", inputStructure: "detailed",
				description: "No prior read needed. `Idempotency-Key` is scoped to the calling client. Same key + same body: 200 with the first result (replay). " +
					"Same key + different body: 409 `idempotency_conflict`. New key on an approval already decided: 409 `already_decided` with the existing `decision` (who, when).",
			})
			.input(z.object({ params: z.object({ approvalId: ApprovalId }), headers: IdempotencyHeaders, body: DecideBody }))
			.output(Decision),
	},
};
