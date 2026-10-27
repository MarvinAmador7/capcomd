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
	code: z.enum(["unauthorized", "forbidden", "not_found", "already_decided", "idempotency_conflict", "conflict", "invalid", "internal"])
		.describe("conflict (409): the run or agent is in a state the action can't apply to (nothing to pause, resume or cancel; a message to an agent that has ended)"),
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
	state: z.string().describe("new, idle, running or unknown; starting in the runs.create response, before the run's process has registered it"),
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
} as const;
export const CAPABILITY_NAMES = Object.keys(CAPABILITIES) as (keyof typeof CAPABILITIES)[];
export const CAPABILITIES_DOC = "a list of names, one per feature added after harness.v1 first shipped; a client checks for the name before offering the feature, and ignores names it doesn't know. " +
	CAPABILITY_NAMES.map((k) => `\`${k}\`: ${CAPABILITIES[k]}`).join("; ") + ".";

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
});
export const CREATE_RUN_DOC = "Start a run on a goal, always detached (`capcomd run --detach <goal>` in the project's directory): returns at once with the new run, `state: \"starting\"`; " +
	"the `daemon` and `prj-…` streams then announce it with `run.created` like a run started from the CLI. Needs the `steer` scope. " +
	"`Idempotency-Key` is scoped to the calling client: same key + same body replays the first response (201, header `Idempotent-Replayed: true`) without starting another run; " +
	"same key + different body: 409 `idempotency_conflict`. Keys are kept 24 h; a request that failed (422, 500) is not recorded, so retrying it with the same key tries again. " +
	"422 `invalid` for a bad body, a `repo` that isn't a project checkout, no repository at all, or a run `capcomd run` itself refuses (unknown profile, no planner profile); `message` says which.";

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
				`409 \`conflict\` when nothing is left to cancel. ${WRITE_DOC}`,
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
