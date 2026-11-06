// harness.v1 client contract (docs/harness-architecture.md §6-7). Phase 0: schemas and procedures, no server yet.
// openapi/capcomd.json and docs/events.md are generated from this file (scripts/gen-harness-contract.ts --check in CI).
import { eventIterator, oc } from "@orpc/contract";
import { z } from "zod";
import { HarnessEvent, Timestamp, TIMESTAMP_DOC } from "./envelope";
import { AgentProvider, AgentResult, AgentTitleSource, HeldBy, LegacyEventData, PROFILE_SOURCE_TEXT, PROFILE_VERSION_TEXT, ProfileSource, ProfileVersion, UntrustedText } from "./legacy-events";
import { RENAME_WINDOW_MS, RENAMES_MAX, TITLE_MAX_CHARS, TITLE_WORDS_MAX } from "../primitives/agent-title";
import { AttachmentRef, INLINE_TEXT_MAX_BYTES } from "./inline-cap";
import { LIFECYCLE_TYPES, LifecycleCause, RunLifecycleData } from "./lifecycle";
import { ACTIVITY_KINDS } from "../agents/activity";
import { AgentWorkspace } from "./workspace";
import { TITLE_MAX, TITLE_SOURCES } from "./run-title";
import { SKILL_MAX_BYTES, SKILLS_PER_MESSAGE_MAX } from "../agents/skills";
import { isListedProvider, LISTED_PROVIDERS, PROVIDER_LABEL } from "../providers/registry";
import { AGENT_MEMORY_CHOICES, IDLE_LIFETIME_CHOICES } from "./sandboxes";
import { PLUGIN_NAME_PATTERN } from "../../packages/plugin/src/manifest";
import { PLUGIN_STATES } from "../../packages/plugin/src/host/host";
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
	code: z.enum(["unauthorized", "forbidden", "not_found", "already_decided", "idempotency_conflict", "conflict", "stopped", "invalid", "internal", "unavailable"])
		.describe("stopped (409, capability runs.goal_branch): POST /v1/runs/{runId}/pull-request on a run whose planner stopped before it finished; the message is the question to ask the person, and the body `{\"stopped\": true}` opens it once they agree. conflict (409): the run or agent is in a state the action can't apply to (nothing to pause, resume or cancel; a message to an agent that has ended), or a machine changed since it was read, or a folder's origin changed since it was inspected (POST /v1/projects), or a folder is already a git checkout or already has an origin (capability projects.git), or a repository name is taken on GitHub (POST /v1/projects/publish, `field` name). unavailable (503, capability sandboxes.actions): a provider didn't answer during an action; (capability projects.git) the GitHub CLI couldn't publish. Treat a code you don't know as a generic error"),
	message: z.string(),
	decision: z.lazy(() => Decision).optional().describe("409 already_decided: the existing decision"),
	field: z.string().optional().describe("422 invalid from POST /v1/projects (capability projects.setup): the body field the message is about (path, mode, target, check, agents, budgetUsd). From the projects.git routes: path, owner, name, visibility, files (the first commit would publish likely secrets, or too many files), identity (git has no user.name/email), gh (the GitHub CLI isn't logged in); 409 name: the repository exists on GitHub"),
	problem: z.string().optional().describe("422 invalid from POST /v1/projects (and the projects.git routes): the inspect problem code that blocks the folder (not_git, home, no_origin, not_github, not_found)"),
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
	title: UntrustedText.nullable().describe(`A short name for the work, to show where a run is listed (a list row, a notification): one line, about ${TITLE_MAX} characters at most (longer text is cut where a clause ends, else at a word with "…"). Changes while the run goes on when a better one arrives (see titleSource); null when the run has no label, goal or task yet. Older daemons don't send it: use the goal's first line`),
	titleSource: z.enum(TITLE_SOURCES).nullable().describe("Where the title comes from, best first: label (the run's own label, from `capcomd run new --label` or the agent that started it, when it isn't just the goal), agent (capability agents.title: its planner named the run, `capcomd title --run` in its VM; run.titled), merge (the subject capcomd gave the merged work's commit and pull request, when exactly one agent's work merged), goal (the run's goal), task (its first agent's task, for a run with no goal). More may be added"),
	repo: z.string().nullable().describe("Repository the run works in (absolute path or remote URL)"),
	createdAt: Timestamp.nullable(),
	goalBranch: z.lazy(() => GoalBranchSummary).nullable().optional().describe("Capability runs.goal_branch. The run's goal branch and where it stands; null for a run without one (it merges into its target as before). Older daemons don't send it"),
});
/** Where a run's goal branch stands (Run.goalBranch.state, GET /v1/runs/{runId}/goal `state`). */
export const GoalBranchState = z.enum(["working", "ready", "stopped", "pr_opened", "kept"]).describe("working: the planner is at it (reviewed work lands as it goes); ready: the planner finished, the user decides (open a pull request or keep the branch); stopped: the planner failed or was cancelled (the branch keeps what landed; a pull request can still be opened); pr_opened: a pull request into the base is open (or was merged on GitHub); kept: the user kept the branch without one. Treat a state you don't know as working");
export const GoalPullRequest = z.object({
	number: z.number().int().positive(),
	url: z.string().nullable().describe("Its page on GitHub; null when the daemon can't tell (a GitHub Enterprise API without html_url)"),
});
export const GoalBranchSummary = z.object({
	branch: z.string().describe("The goal branch, e.g. capcomd/add-multiply (ref-safe: letters, digits, . _ - /)"),
	base: z.string().describe("The branch it was cut from, which the pull request goes into (e.g. dev)"),
	state: GoalBranchState,
	readyAt: Timestamp.nullable().describe("When the planner finished (run.goal_completed); null before"),
	pullRequest: GoalPullRequest.nullable().describe("The pull request opened from it (run.pr_opened); null before"),
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
	profileVersion: ProfileVersion.nullable().optional().describe(`${PROFILE_VERSION_TEXT}. null without a profile (a fake agent, CAPCOMD_AGENT naming a provider) or for an agent spawned before capcomd recorded it. Older daemons don't send it`),
	profileSource: ProfileSource.nullable().optional().describe(`${PROFILE_SOURCE_TEXT}. null when profileVersion is. Older daemons don't send it`),
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
	createdAt: Timestamp.nullable().optional().describe("When it was spawned (a client's elapsed clock starts here); null when unknown. Older daemons don't send it"),
	updatedAt: Timestamp.nullable(),
	title: UntrustedText.nullable().optional().describe(`Agent-written text: render as plain text, never markdown, links or actions. Capability agents.title. Its short name, for its tab, row or column header ("login redirect"): 1 to ${TITLE_WORDS_MAX} lowercase words, at most ${TITLE_MAX_CHARS} characters, one line. The user's (PUT …/title), else the latest the agent, its parent or the user's driving harness set, else the daemon's from the task's first words (titleSource derived); null only for an agent with no task text. Live: agent.titled. Older daemons don't send it: name the agent by its profile`),
	titleSource: AgentTitleSource.nullable().optional(),
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
/** GET …/thread/tail (capability agents.thread_tail): an agent's newest items by position, and cursors both ways. */
export const ThreadTail = z.object({
	items: z.array(ThreadItem).describe("The newest items placed before `before` (all of them when it was omitted), at most `limit`, oldest first (by `order`), each at its latest rev"),
	before: z.number().int().nonnegative().nullable().describe("Older items are waiting: pass this as `before` for the page above these (it is the first item's `order`). null: these reach the thread's start"),
	cursor: z.number().int().nonnegative().describe("The run's write cursor (a `seq`) from just before these were read: read GET …/thread with `after` = cursor and apply live frames to catch up. Any write after it comes back that way; nothing before it is missed"),
});
export const THREAD_TAIL_DOC = `Capability agents.thread_tail. The newest end of an agent's thread first, so a long thread opens on its latest messages: GET /v1/runs/{runId}/agents/{agentId}/thread/tail returns the newest \`limit\` items by position (\`order\`), each at its latest rev, with \`before\` (the page above them; null at the thread's start) and \`cursor\` (the write cursor from just before the read).
To open a thread: open the run stream with \`?thread=1\`, read the tail, then GET …/thread with \`after\` = cursor (and on, by \`next\`), and apply frames; the highest \`rev\` of an id wins, so an item that arrives two ways is shown once, and every write after \`cursor\` arrives one of those ways. Scrolling up: GET …/thread/tail?before=<before>, until \`before\` is null.
An item placed above what you have read can still change, and then arrives by cursor or frame: keep it (highest rev wins) but don't show it until a page above reaches it, so the thread has no gap. Without the capability, read GET …/thread from \`after\` = 0.`;
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
/** A merge approval's changed files (subject.files): its branch against where it left the target, biggest change first. */
export const APPROVAL_FILES_MAX = 20;
const ApprovalFile = z.object({
	path: UntrustedText,
	status: FileStatus,
	added: z.number().int().nonnegative().nullable().describe("Lines added; null for a binary file"),
	removed: z.number().int().nonnegative().nullable().describe("Lines removed; null for a binary file"),
});
const ApprovalSubject = z.looseObject({
	target: z.string().nullable().optional().describe("merge: the branch it lands on"),
	ref: z.string().nullable().optional().describe("merge: the branch (or ref) being merged"),
	files: z.array(ApprovalFile).max(APPROVAL_FILES_MAX).optional().describe(`merge: the files the branch changes, \`git diff --numstat\` of the verified commit against where its branch left the target, the ${APPROVAL_FILES_MAX} with the most changed lines first (then by path). Absent when the daemon couldn't read the diff (no repository, the remote unreachable) or on a daemon that predates it`),
	filesTotal: z.number().int().nonnegative().optional().describe("merge: how many files the branch changes (files lists at most the first ones)"),
	added: z.number().int().nonnegative().optional().describe("merge: lines added across all its files (binary files not counted)"),
	removed: z.number().int().nonnegative().optional().describe("merge: lines removed across all its files (binary files not counted)"),
	askedBy: z.string().optional().describe("merge: the agent that asked for it and waits on the decision (requestedBy.agentId is the agent whose work merges). Absent for an operator's merge and on older daemons"),
	heldBy: HeldBy.optional().describe("merge: a plugin held it for this approval (merge.landing): the plugin and its reason, which the question repeats. Approving satisfies only this hold: a merge another plugin then holds asks again. Absent when only the target's protection asks, and on older daemons"),
}).describe("Kind-specific detail: merge {target, ref, files, filesTotal, added, removed}, budget {add}, egress {host}, secret {name}, spawn_widen {limits}");

/** Frames on GET /v1/streams/{scope}/events besides ordinary events (SSE `event:` names). */
export const StreamFrames = {
	"stream.reset": z.looseObject({ snapshotSeq: z.number().int().nonnegative(), reason: z.enum(["compacted", "overflow"]) }),
	"snapshot.run": z.looseObject({ run: z.lazy(() => Run) }),
	"snapshot.agents": z.looseObject({ agents: z.array(z.lazy(() => Agent)) }),
	"snapshot.approvals": z.looseObject({ approvals: z.array(z.looseObject({ approvalId: ApprovalId, kind: ApprovalKind, status: ApprovalStatus, question: UntrustedText, requestedBy: RequestedBy, subject: ApprovalSubject,
		requestedAt: Timestamp.nullable().optional().describe("When it was asked (a merge: when it was parked); absent on daemons that predate it") })) }),
	"snapshot.steps": z.looseObject({ steps: z.array(z.lazy(() => HarnessEvent)).describe("Recent durable events of the scope, oldest first (step history)") }),
	"snapshot.threads": z.looseObject({ messages: z.array(z.lazy(() => Message)).describe("Recent thread messages, oldest first") }),
	"snapshot.end": z.looseObject({ snapshotSeq: z.number().int().nonnegative() }),
} as const;

export const LIFECYCLE_DOC = `Lifecycle feed: only run and agent state changes, and what the run and its agents are called (${LIFECYCLE_TYPES.join(", ")}). Tool calls and messages are not here; they stay in step and thread events.
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

/** The plugin host's own events (capability plugins; docs/spec/plugin-api.md §13.1, packages/plugin/src/events.ts).
 *  Durable, written by the host with daemon-written text; a plugin's `reason` or `message` inside them is untrusted. */
const PLUGIN_EVENT = "Capability plugins. Durable, on the `daemon` stream (and GET /v1/events?scope=daemon); `entity` is plugin:<name>; the envelope text is daemon-written";
const PluginEventData = {
	"plugin.loaded": z.looseObject({
		plugin: z.string(), version: z.string(), runtime: z.string().describe("in-process or process"),
		hooks: z.array(z.string()).describe("The hooks it listens to (spec §6.6)"), seams: z.array(z.string()).describe("The seams it implements, as <kind>/<name>"),
		ms: z.number().describe("How long it took to load"),
	}).describe(`${PLUGIN_EVENT}. A plugin became active (spec §5.4)`),
	"plugin.failed": z.looseObject({
		plugin: z.string(), version: z.string().nullable().describe("null when its manifest couldn't be read"),
		cause: z.string().describe("Why (spec §5.4): invalid_manifest, untrusted, unresolved, cycle, seam_conflict, config_invalid, activate_threw, activate_timeout, conflict, … Treat an unknown cause as a failure for a reason you don't know"),
		message: UntrustedText.describe("Agent-written text (here the host's details, which quote the plugin's manifest and errors): render as plain text"),
	}).describe(`${PLUGIN_EVENT}. A plugin failed to validate, resolve or load; it stays listed by GET /v1/plugins with its cause. An incompatible plugin is plugin.version_refused instead, a second plugin of one name plugin.duplicate_refused`),
	"plugin.disposed": z.looseObject({
		plugin: z.string(), cause: z.string().describe("daemon_stopping or disabled (more may come)"),
	}).describe(`${PLUGIN_EVENT}. An active plugin was unloaded`),
	"plugin.version_refused": z.looseObject({
		plugin: z.string(), version: z.string(), engines: z.string().describe("The capcomd versions it says it supports (a semver range)"),
		capcomd: z.string().describe("This capcomd's version"), apiVersion: z.number().describe("The plugin API major it codes against"),
	}).describe(`${PLUGIN_EVENT}. A plugin doesn't support this capcomd (spec §4.4): it is failed with cause incompatible`),
	"plugin.duplicate_refused": z.looseObject({
		plugin: z.string(), kept: z.string().describe("builtin, user or project: where the one kept came from"), refused: z.string().describe("Where the refused one came from"),
		path: z.string().describe("The refused plugin's directory, or (built-in)"),
	}).describe(`${PLUGIN_EVENT}. A second plugin with a name already discovered was refused (spec §4.8): it is failed with cause duplicate`),
	"plugin.hook_failed": z.looseObject({
		plugin: z.string(), hook: z.string(), callId: z.string(),
		kind: z.string().describe("timeout, threw, crashed, invalid_result, disconnected or suspended"),
		message: UntrustedText.describe("Agent-written text (here what went wrong, which may quote the plugin's error): render as plain text"),
		effect: z.string().describe("denied (the operation was refused, naming the plugin) or skipped (the listener was left out)"),
	}).describe(`${PLUGIN_EVENT}. One call to a plugin's hook listener produced no usable answer (spec §6.5)`),
	"plugin.suspended": z.looseObject({
		plugin: z.string(), failures: z.number().describe("Failed calls in a row"), lastHook: z.string(),
	}).describe(`${PLUGIN_EVENT}. The breaker tripped: the plugin's listeners are no longer called (its gate listeners deny) until it is enabled again or the daemon restarts (spec §6.5)`),
	"plugin.resumed": z.looseObject({
		plugin: z.string(), by: z.string().describe("Who resumed it"),
	}).describe(`${PLUGIN_EVENT}. A suspended plugin's listeners are called again`),
} as const;

/** SSE event payloads (data field) by dotted type. docs/events.md is generated from this map. */
export const EventData = {
	...LegacyEventData,
	"agent.step": LegacyEventData["agent.step"].describe("Capability agent.steps. One finished step of an agent's history, in the order it took them: a streak of one kind of tool call (reading files, editing, running the tests), reported once the agent moved on to another kind or ended. Durable: replayed by GET /v1/events and on run streams like any event (not on the lifecycle feed). The envelope text is the step in past tense (\"Read 4 files\", \"Ran the tests\"); `agentId`/`entity` is the agent. At most 500 per agent; a cancelled agent's unfinished last step is not recorded"),
	"plugin.gate_denied": LegacyEventData["plugin.gate_denied"].describe("Capability plugins. Durable, on the run's stream: a plugin's gate denied a verification or a merge (the operation failed with reason plugin:<name>), or held a merge for a person's approval. Also when the gate failed closed (its listener errored or timed out: `reason` says so). Written by capcomd, never by the plugin"),
	"plugin.gate_bypassed": LegacyEventData["plugin.gate_bypassed"].describe("Capability plugins. Durable, on the run's stream: `capcomd merge --operator` went on although these plugins denied or held the merge at merge.landing (spec §6.5); the merge's merge.succeeded result carries the same list as bypassedVetoes. Written by capcomd, never by the plugin"),
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
	"project.configured": z.looseObject({
		path: z.string().describe("The checkout's root (absolute)"),
		name: z.string().describe("Its name in capcomd's projects"),
		mode: z.string().describe("pr or direct"),
		target: z.string().describe("The target branch"),
		check: z.string().describe("The check command (\"\" for none), as the user typed it"),
		agents: z.array(z.string()).describe("claude and/or codex"),
		budgetUsd: z.number().nullable().describe("The spend cap per run in USD; null for none"),
		gitignored: z.boolean().optional().describe("`.capcomd/` was added to the checkout's .gitignore (the body asked for `gitignore`)"),
		clientId: z.string().describe("The API client that set it up (cli-…)"),
	}).describe("Capability projects.setup. Durable, on the `daemon` stream only (and GET /v1/events?scope=daemon): a client set a folder up as a capcomd project with POST /v1/projects and something changed (its settings, its profiles or capcomd's project list). `entity` is project:<name>; the envelope text is daemon-written (\"Set up app (~/src/app): pull requests into main, with Claude Code and Codex.\"). Never a secret"),
	"project.git_initialized": z.looseObject({
		path: z.string().describe("The folder (absolute), now a checkout's root"),
		name: z.string().describe("The name capcomd would give the project"),
		branch: z.string().describe("The branch it starts on (main)"),
		clientId: z.string().describe("The API client that asked (cli-…)"),
	}).describe("Capability projects.git. Durable, on the `daemon` stream only (and GET /v1/events?scope=daemon): a client started a git repository in a folder with POST /v1/projects/git-init (`git init -b main`, no commit). `entity` is project:<name>; the envelope text is daemon-written (\"Started a git repository in my-app (~/src/my-app), on branch main.\")"),
	"project.published": z.looseObject({
		path: z.string().describe("The checkout's root (absolute)"),
		name: z.string().describe("The name capcomd would give the project"),
		owner: z.string().describe("The GitHub account or organization it was created in"),
		repo: z.string().describe("owner/name on GitHub"),
		visibility: z.string().describe("private or public"),
		firstCommit: z.boolean().describe("capcomd made the first commit (the folder had none)"),
		files: z.number().nullable().describe("How many files that first commit holds; null when the checkout had commits already"),
		clientId: z.string().describe("The API client that published it (cli-…)"),
	}).describe("Capability projects.git. Durable, on the `daemon` stream only (and GET /v1/events?scope=daemon): a client published a checkout without origin to GitHub with POST /v1/projects/publish (the repository was created, added as origin and pushed). `entity` is project:<name>; the envelope text is daemon-written (\"Published my-app (~/src/my-app) to github.com/marvin/my-app, private, with a first commit of 24 files.\"). Names and counts only: never file names or contents"),
	"sandbox.resource_deleted": z.looseObject({
		sandbox: z.string().describe("The place (a listed provider's name)"),
		resourceId: z.string().describe("The machine's id"),
		cause: z.string().describe("Why capcomd deleted it: action (a client's Delete), idle_lifetime (its idle lifetime ran out: Docker's sweep, or its worker's own lifetime), run_ended (its agent ended and its worker destroyed it). Treat an unknown cause as a deletion for a reason you don't know"),
	}).describe("Capability sandboxes.actions. Durable, on the `daemon` stream only (and GET /v1/events?scope=daemon): a machine capcomd deleted. Only deletes capcomd makes and sees: a provider deleting a machine on its own (boxd's delete-after) isn't reported. `entity` is sandbox:<name>; the envelope text is daemon-written (\"Local: machine relay-… was deleted after its idle lifetime ran out.\")"),
	...PluginEventData,
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
	"runs.options.models": "GET /v1/run-options `drivers[].models`: the models each driver's planner can run on (an id, a display name and a one-line note); POST /v1/runs takes `model`, one of them",
	"agent.steps": "agent.step events: one durable event per finished step of an agent (its kind, count, start and end), in order, replayed by GET /v1/events and delivered on run streams",
	logins: "GET /v1/logins: whether agents can log in to Claude and Codex in each sandbox, how (plan or API key), and the command that logs in",
	environments: "GET /v1/environments: each sandbox's agent environment (ready, missing, building or failed), its tool versions, and the command that builds it",
	service: "GET /v1/service: whether capcomd runs as a background service (installed, loaded), and the commands that install and uninstall it",
	sandboxes: "GET /v1/sandboxes and /v1/sandboxes/{name}: each place agents run as a provider descriptor (label, kind, caps, which settings, info rows and actions it has), with its settings and info as typed fields; GET /v1/logins and /v1/environments take `sandbox`, and logins carry `hostBound` and `boundTo`",
	"sandboxes.resources": "GET /v1/sandboxes/{name}/resources and …/resources/{id}: the machines capcomd's agents run on at that place (owned by an agent, or orphaned), and the `capcomd sandbox shell` command that opens a shell in one",
	"sandboxes.settings": "PATCH /v1/sandboxes/{name}/settings (the `configure` scope): change a place's settings (the idle machine lifetime; Docker's memory per agent); fields carry `editable` and `source`, and each change is a sandbox.settings_changed event on the daemon stream. Machines of capcomd's own jobs (checks, logins, environment builds) carry an owner of their `kind` instead of reading as orphaned",
	"sandboxes.actions": "POST /v1/sandboxes/{name}/resources/{id}/actions/delete (the steer scope, an Idempotency-Key): delete a machine. An agent's machine is deleted by cancelling that agent, a machine left behind by its provider; capcomd's own jobs' machines can't be. Resources carry `destructive` and the daemon's `confirm` question; sandbox.resource_action and sandbox.resource_deleted audit it on the daemon stream",
	"projects.setup": "GET /v1/projects/inspect and POST /v1/projects (the `configure` scope, an Idempotency-Key): set up a folder on the daemon's machine as a capcomd project (a GitHub checkout), as `capcomd setup project` does, and add it to capcomd's projects; each setup is a project.configured event on the daemon stream",
	"projects.known": "GET /v1/projects/known: capcomd's projects with their checkout folders on the daemon's machine, and which is the default",
	"projects.git": "POST /v1/projects/git-init, GET /v1/projects/publish-options and POST /v1/projects/publish (the `configure` scope for the POSTs, each with an Idempotency-Key): take a plain folder to a GitHub checkout before setting it up: start a git repository in it, then create its GitHub repository with the GitHub CLI (the first commit made when there is none, likely secrets refused) and push. Audited as project.git_initialized and project.published on the daemon stream. POST /v1/projects takes `check` as optional and `gitignore`",
	"runs.goal_branch": "Goal branches: POST /v1/runs takes `base` and `goalBranch`; Run.goalBranch; GET /v1/projects/branches (the base menu and the suggested goal branch); GET /v1/runs/{runId}/goal (the branch against its base, what landed and what didn't, the planner's summary); POST /v1/runs/{runId}/pull-request and /keep-branch (the steer scope); run.goal_completed, run.pr_opened and run.branch_kept events",
	"agents.title": "Agent titles: Agent.title and titleSource (the user's, else the agent's own, its parent's or the driving harness's, else derived from the task); PUT and DELETE /v1/runs/{runId}/agents/{agentId}/title (the steer scope): the user's title, which sticks until they clear it; agent.titled on run streams and the lifecycle feed; Run.titleSource agent (the planner named the run) and run.titled",
	"agents.thread_tail": "GET /v1/runs/{runId}/agents/{agentId}/thread/tail: an agent's newest thread items by position, with `before` (the page above them, for scrolling up) and `cursor` (where GET …/thread and live frames take over), so a long thread opens on its latest messages",
	plugins: "GET /v1/plugins: every plugin the daemon discovered, in load order, with its lifecycle state, why it failed or is disabled, the hooks and seams it contributes and its hook call statistics; plugin.* events on the daemon stream audit the plugin host",
	profiles: "GET /v1/profiles: every agent profile a run can use (the daemon's, or with `repo` a project's): its version, the layer it was found in and the files laid together to make it, what it does, its provider, model and tool mode, and whether its login is there",
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
	targetBranch: BranchName.optional().describe("Branch the run's work merges into (`capcomd run --target-branch`); default: the project's target. With a goal branch (capability runs.goal_branch), the base: send `base` instead."),
	base: BranchName.optional().describe("Capability runs.goal_branch. The origin branch the run's goal branch is cut from and its pull request goes into (`capcomd run --base`), as the user picked it in the setup screen (GET /v1/projects/branches). Omitted: `targetBranch`, else the project's target, else the remote's default branch; when none of those is known, 422 with `field` base: ask the user. Never a guessed main"),
	goalBranch: z.union([BranchName, z.literal(false)]).optional().describe("Capability runs.goal_branch. The run's goal branch (`capcomd run --goal-branch`): verified, reviewed work lands on it with no approval, and the user decides on a pull request into `base` when the planner is done. Omitted: the daemon's suggestion for the goal (capcomd/<goal-slug>, never an existing branch). 422 with `field` goalBranch when it isn't a branch name capcomd can create, is the base, is protected, or exists on the remote. false: no goal branch (merges go into the target as before; for a run with a planner only, else ignored)"),
	driver: AgentProvider.optional().describe("Capability runs.options. Who drives the run: the provider of its planner agent (`capcomd run --planner-provider`). The run uses the project's planner profile on that provider: as it is when it already uses it, else with the provider swapped and that provider's model and login (another of the project's profiles on it, else the provider's defaults). Implies a planner agent, so not with `profile`. 422 when there is no planner profile or the provider can't run (no login or API key). Omitted: the planner profile's own provider. GET /v1/run-options lists both."),
	effort: z.string().min(1).max(32).optional().describe("Capability runs.options. The reasoning effort of the run's planner (the driver): one of that driver's `efforts` in GET /v1/run-options (the `driver` given, else the default driver), else 422. Omitted: the driver's `effort` there (the planner profile's level, else the provider's default)."),
	model: z.string().min(1).max(100).regex(/^[A-Za-z0-9._:\/-]+$/, "model must be a model id").optional().describe("Capability runs.options.models. The model the run's planner (the driver) runs on (`capcomd run --planner-model`): one of that driver's `models[].id` in GET /v1/run-options (the `driver` given, else the default driver), else 422. Passed to the agent CLI as a profile's model is (Claude Code `--model`, Codex `-m`). Omitted: the driver's `model` there (the planner profile's, else the CLI's default)."),
	sandbox: SandboxName.optional().describe("Capability runs.options. Where this run's agents and checks run (`capcomd run --sandbox`): a listed place's name (GET /v1/run-options `sandboxes`), today docker (containers on the daemon's machine) or boxd (cloud VMs), for this run only; the daemon's own CAPCOMD_SANDBOX is unchanged. 422 when it isn't one, or isn't available (Docker not running, no boxd API key). Omitted: the daemon's sandbox."),
});
export const CREATE_RUN_DOC = "Start a run on a goal, always detached (`capcomd run --detach <goal>` in the project's directory): returns at once with the new run, `state: \"starting\"`; " +
	"the `daemon` and `prj-…` streams then announce it with `run.created` like a run started from the CLI. Needs the `steer` scope. " +
	"`Idempotency-Key` is scoped to the calling client: same key + same body replays the first response (201, header `Idempotent-Replayed: true`) without starting another run; " +
	"same key + different body: 409 `idempotency_conflict`. Keys are kept 24 h; a request that failed (422, 500) is not recorded, so retrying it with the same key tries again. " +
	"422 `invalid` for a bad body, a `repo` that isn't a project checkout, no repository at all, `profile` with `driver`, a `driver` or `sandbox` that isn't available, or a run `capcomd run` itself refuses (unknown profile, no planner profile); `message` says which. " +
	"Capability runs.goal_branch: a run with a planner gets a goal branch, cut from `base` (the response's Run.goalBranch is null until the run registers; GET /v1/runs/{runId} then has it). A base that can't be determined, or a goal branch that can't be used, is 422 with `field` base or goalBranch and the daemon's sentence: show it next to that field.";

/** GET /v1/run-options: the choices POST /v1/runs takes for `driver` and `sandbox`, and whether each can be used now. */
export const DriverFit = z.object({
	available: z.boolean(),
	reason: z.string().nullable().describe("Why not, one short sentence naming the command that fixes it (trusted), e.g. \"Not logged in to Claude Code for Local (run `capcomd auth login claude --sandbox docker`)\", \"No agent environment for Local yet (run `capcomd env build --sandbox docker`)\"; null when available"),
});
export const DriverOption = z.object({
	provider: AgentProvider,
	label: z.string().describe("What to call it: \"Claude Code\" or \"Codex\""),
	model: z.string().nullable().describe("The model the planner would run with on this provider; null: the provider CLI's default"),
	models: z.array(z.object({
		id: z.string().describe("What POST /v1/runs `model` takes, and the CLI's `--model` / `-m`"),
		name: z.string().describe("What to call it in a menu, e.g. \"Opus 5.5\""),
		note: z.string().describe("One short line beside the name, e.g. \"Most capable\""),
	})).describe("Capability runs.options.models. The models this provider's planner can run on, in menu order: capcomd's own list, then any other model the project's profiles on this provider name"),
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
/** GET /v1/plugins (capability plugins): docs/spec/plugin-api.md §13.2. */
export const PluginSummary = z.object({
	name: z.string().regex(new RegExp(PLUGIN_NAME_PATTERN)).describe("The plugin's name: lowercase letters, digits and hyphens"),
	version: z.string().describe("The plugin's own version (0.0.0 when its manifest couldn't be read)"),
	apiVersion: z.literal(1).describe("The plugin API major it codes against"),
	runtime: z.enum(["in-process", "process"]).describe("in-process: built into capcomd; process: a program capcomd starts"),
	source: z.enum(["builtin", "user", "project"]).describe("Where it was found: shipped with capcomd, the user's plugins, or the project's"),
	state: z.enum(PLUGIN_STATES).describe("Its lifecycle state (spec §5.4): discovered, validated, resolved, loading, active, disposing, disposed or failed. Treat a state you don't know as failed"),
	enabled: z.boolean().describe("false while config holds it at validated (`plugins.<name>.enabled: false`)"),
	cause: z.string().nullable().describe("Why it is failed, disposed or not enabled (spec §5.4, e.g. invalid_manifest, incompatible, untrusted, unresolved, activate_threw, disabled, dispose_timeout); null otherwise. Treat a cause you don't know as a failure for a reason you don't know"),
	hooks: z.array(z.string()).describe("The hooks it listens to (spec §6.6): those it registered while active, those its manifest declares otherwise. Ignore names you don't know"),
	seams: z.array(z.object({ kind: z.enum(["sandbox", "agent", "forge"]), name: z.string() })).describe("The seams it implements (spec §7), each by the name runs and profiles select it by"),
	hooksSuspended: z.boolean().describe("The breaker tripped (plugin.suspended): its listeners aren't called, and its gate listeners deny, until it is enabled again or the daemon restarts"),
	stats: z.object({
		calls: z.number().int().describe("Hook calls since the daemon started"),
		failures: z.number().int().describe("Calls that failed (plugin.hook_failed)"),
		dropped: z.number().int().describe("Observe calls dropped because its queue was full (spec §6.2)"),
		p50Ms: z.number().nullable().describe("Median call time over its recent calls; null before the first"),
		p95Ms: z.number().nullable(),
		lastFailureAt: Timestamp.nullable(),
	}),
});
export const Plugins = z.object({ plugins: z.array(PluginSummary).describe("In load order, then the plugins that didn't load, in the order they were discovered") });
export const PLUGINS_DOC = "Capability plugins. Every plugin the daemon discovered, in load order, with its lifecycle state, why it failed or was disabled, the hooks and seams it contributes and its hook call statistics. Needs the `read` scope. Local reads only, so poll it freely. Never contains config values or secrets. " +
	"This capcomd ships no plugins yet, so the list is empty until it does.";
/** GET /v1/profiles (capability profiles): ADR-024 §5, the rows `capcomd profiles list --json` lists. */
const ProfileLayerName = z.string().describe("A layer profiles are found in, highest first: project (the project's .capcomd/profiles/ and its agents.json), user (~/.capcomd/profiles/, or the user's agents.json), bundled (shipped with capcomd). More may be added (installed packages): treat one you don't know as user");
export const ProfileFile = z.object({
	as: z.enum(["extends", "profile", "override"]).describe("What the file is to the profile: one of its `extends` ancestors (or an ancestor's override), the profile itself, or an override.yaml laid over it"),
	name: ProfileName.describe("The profile the file defines or overrides"),
	layer: ProfileLayerName,
	path: z.string().nullable().describe("The file on the daemon's machine (a profile.yaml, <name>.yaml, override.yaml, or the agents.json holding the entry); null for a profile bundled with capcomd"),
});
export const ProfileSummary = z.object({
	name: ProfileName,
	version: z.number().int().positive().describe("Its `version` (1 when its file sets none, and for every agents.json entry)"),
	source: ProfileLayerName.describe("The layer it was found in (an override from a higher layer may change it): today project, user or bundled. Treat one you don't know as user"),
	format: z.enum(["v1", "v2"]).describe("v1: an entry of an agents.json; v2: a profile file (profile.yaml)"),
	path: z.string().nullable().describe("The file that defines it, on the daemon's machine; null for a profile bundled with capcomd"),
	default: z.boolean().describe("What a run or a spawn that names no profile uses"),
	description: UntrustedText.nullable().describe("Agent-written text: render as plain text, never markdown, links or actions. Its description as its file says it (a project's profile files are in its repository, which agents change); null when it has none"),
	tags: z.array(z.string()).describe("Its tags as its file says them (lowercase words); empty when it has none"),
	provider: z.string().describe("The agent provider it runs on, by its plugin's name: claude or codex today (GET /v1/plugins lists the active ones)"),
	auth: z.enum(["apikey", "subscription"]).describe("How its agents log in: an API key, or a plan login (`capcomd auth login`)"),
	model: z.string().nullable().describe("Its model; null: the provider CLI's default"),
	effort: z.string().nullable().describe("Its reasoning effort (one of its provider's levels, GET /v1/run-options `efforts`); null: the provider CLI's default"),
	toolMode: z.enum(["execute", "orchestrate"]).describe("orchestrate: it sees everything and runs nothing (no edits, builds or tests); the agents it spawns do the work"),
	canSpawn: z.boolean().describe("It may spawn agents of its own"),
	canLead: z.string().nullable().describe("Who it spawns when it leads a part, in plain words written by the daemon, e.g. \"up to 3 worker helpers, one level\"; null when it can't lead"),
	does: z.string().describe("What it is for, one sentence written by the daemon from its settings (never from its description)"),
	ready: z.boolean().describe("Its login is there for the daemon's own sandbox (a plan login, or the API key); GET /v1/logins has every sandbox's"),
	readiness: z.string().describe("Why it is ready or not, one short sentence written by the daemon (never a credential), e.g. \"not logged in: capcomd auth login claude\""),
	applied: z.array(ProfileFile).describe("The files laid together to make it, first to last (a later one wins): its `extends` ancestors (root first), itself, then its overrides (the user's, then the project's)"),
});
export const Profiles = z.object({
	file: z.string().describe("The agents.json the profiles are read with, on the daemon's machine (it may not exist); the profiles/ folder beside it is the project's layer"),
	layers: z.array(z.object({ layer: ProfileLayerName, dir: z.string().describe("Where that layer's profile files are, on the daemon's machine (it may not exist)") })).describe("The folders profiles are looked up in, highest first (the bundled layer has none)"),
	default: ProfileName.nullable().describe("The default profile; null when none is set"),
	profiles: z.array(ProfileSummary).describe("Every profile, in a stable order: the agents.json's, then each layer's profile files, highest first. Empty when `error` is set"),
	warnings: z.array(z.string()).describe("What works but may not be meant, one sentence each, as `capcomd profiles validate` prints them: a profile file hiding an agents.json entry, an override that doesn't apply, a block this capcomd reads but doesn't use yet"),
	error: z.string().nullable().describe("Why the profiles can't be used, as `capcomd profiles validate` says it (every problem, naming each file, never a file's text); `profiles` is then empty, and a run that needs a profile is refused. null when they can be"),
});
export const PROFILES_DOC = "Capability profiles. Every agent profile a run can use, as `capcomd profiles list --json` lists them: the daemon's, or with `repo` a project's, as POST /v1/runs with the same `repo` resolves them. Needs the `read` scope. Local files only, so poll it freely. Never contains a credential or a prompt; `capcomd profiles show <name>` prints which file set each value. " +
	"422 `invalid` when `repo` isn't a project checkout, with the message POST /v1/runs gives; profiles that can't be read are a 200 with `error`.";
export const ProfilesQuery = z.object({
	repo: z.string().refine((p) => p.startsWith("/"), "repo must be an absolute path").optional()
		.describe("Absolute path of a project checkout on the daemon's machine, as POST /v1/runs `repo`: that project's profiles. Omitted: the daemon's own."),
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
	settings: z.array(z.string()).describe("Setting ids its details show (idleLifetime; agentMemory on a place with a memory cap, today docker). Ignore ids you don't know"),
	info: z.array(z.string()).describe("Info row ids its details show (logins, checkpoints; agentSlots on a place with a memory cap, today docker). Ignore ids you don't know"),
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
	id: z.string().describe("Stable id: idleLifetime, agentMemory (settings); logins, checkpoints, agentSlots (info). More may be added"),
	type: z.string().describe("choice (a Picker of `choices`), toggle, info or status (read-only rows). Render a type you don't know as a read-only row of `label` and `display`"),
	label: z.string().describe("Row title (daemon-written)"),
	help: z.string().nullable().describe("A footnote under the row (daemon-written, trusted); null when none"),
	value: z.string().nullable().describe("The current value as a string (a choice's `value`: idleLifetime in seconds, agentMemory in MB; a toggle's \"true\"/\"false\"; an info row's machine-readable value, e.g. logins: bound, partial, unbound, none; checkpoints: the interval in ms; agentSlots: how many agents run at once, null while Docker's memory isn't known)"),
	display: z.string().describe("The value as a sentence the daemon writes (\"1 hour\", \"Bound\", \"After each commit and every 10 minutes\"): what a row shows"),
	default: z.string().nullable().describe("A setting's default value; null for info rows"),
	choices: z.array(FieldChoice).describe(`A choice's options, in order (idleLifetime: ${IDLE_LIFETIME_CHOICES.map((c) => `${c.value} "${c.label}"`).join(", ")}; agentMemory: ${AGENT_MEMORY_CHOICES.map((c) => `${c.value} "${c.label}"`).join(", ")}); empty for other types`),
	source: z.string().describe("Where the value comes from: default (the place's default), env (an environment variable wins: editable is false and display says which, e.g. \"Set by CAPCOMD_SANDBOX_IDLE_SECONDS in capcomd's environment\"), config (capcomd's user config: the user chose it), daemon (an info row the daemon works out)"),
	editable: z.boolean().describe("Capability sandboxes.settings: the user can change it here with PATCH /v1/sandboxes/{name}/settings (needs the configure scope). false for info rows, a setting an environment variable sets, and every row of a daemon without sandboxes.settings"),
	appliesTo: z.string().nullable().describe("new_runs: a change applies to runs started after it (idleLifetime); new_agents: to agents that start after it, those waiting for a slot included (agentMemory); null for info rows. More may be added"),
	needsRestart: z.boolean().describe("A change needs the daemon restarted"),
	state: z.string().nullable().describe("A status row's dot: ok, warn, bad or none (render an unknown value as none); null on every other type"),
});
export const SandboxDetail = z.object({
	descriptor: SandboxDescriptor,
	settings: z.array(SandboxField).describe("Its settings, in the descriptor's order (idleLifetime: how long a machine left behind lives, in seconds; at least 900. agentMemory: how much of Docker's memory each agent gets, in MB, which sets agentSlots; CAPCOMD_DOCKER_AGENT_MEMORY_MB wins)"),
	info: z.array(SandboxField).describe("Read-only rows: logins (a summary of GET /v1/logins?sandbox=name: \"Bound\" only when every logged-in login here is bound to its AI's API host, else which aren't), checkpoints (when agents save their work), agentSlots (how many agents run at once here: Docker's memory over the agentMemory setting, 1 GB by default; more wait as pending and start as others finish)"),
	rev: z.string().describe("Changes whenever a setting's value, source or editability does; PATCH …/settings sends it back (a stale one is 409 conflict)"),
});
export const SettingsBody = z.object({
	values: z.record(z.string(), z.string()).describe("Setting id → the new value, one of the field's `choices` values (idleLifetime: \"900\", \"3600\", \"14400\" or \"43200\", seconds; agentMemory: \"512\", \"1024\", \"2048\" or \"4096\", MB)"),
	rev: z.string().min(1).max(200).describe("The `rev` of the GET /v1/sandboxes/{name} the change was made from"),
});
export const SETTINGS_DOC = "Capability sandboxes.settings. Change a place's settings: the body names each setting by id with a value from its `choices`, and the `rev` it was read with. Needs the `configure` scope (403 `forbidden` without it: settings change what future runs do, like how long their machines and billing live). " +
	"Stored in capcomd's user config (`~/.capcomd/config.json` `sandboxes.<name>.<id>`), never in a project's; the idle lifetime applies to runs started after it (`appliesTo: new_runs`: each run records the settings it started with), the memory per agent to agents that start after it (`appliesTo: new_agents`, those waiting for a slot included), and neither needs a restart. Answers like GET /v1/sandboxes/{name}, with the new values and `rev`. " +
	"Every change is audited: a durable sandbox.settings_changed event on the `daemon` stream ({sandbox, id, from, to, clientId}). " +
	"409 `conflict` when `rev` isn't the current one (the body carries the current `rev`: read the place again, then retry). 422 `invalid` for a setting the place doesn't have, a value not in its `choices`, an idle lifetime under 15 minutes, or a setting that isn't editable (an environment variable such as CAPCOMD_SANDBOX_IDLE_SECONDS or CAPCOMD_DOCKER_AGENT_MEMORY_MB sets it); `message` says which. 404 `not_found` for a name that isn't a listed place.";
export const SANDBOX_DOC = "Capability sandboxes. One place agents run: its descriptor, its settings and its info rows as typed fields the app renders generically (an unknown field type renders as a read-only `label` and `display`). " +
	"Needs the `read` scope. Local reads only (no provider call), so poll it freely. Never contains a credential: every `display`, `help` and `reason` is written by the daemon. 404 `not_found` for a name that isn't a listed place. " +
	"`v`: the descriptor version the client understands (only 1 exists).";
export const ResourceOwner = z.object({
	kind: z.string().describe("Capability sandboxes.settings. Who uses it: agent (an agent's machine), or one of capcomd's own short jobs: check (a run's checks), login (`capcomd auth login` or `auth status`), env_build (`capcomd env build`), doctor (`capcomd doctor`). Treat an unknown kind like a job of capcomd's: never left behind. Absent from older daemons: agent"),
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

/** GET /v1/projects/inspect, POST /v1/projects (capability projects.setup): set up a folder as a capcomd project. */
export const SetupAgentName = z.enum(["claude", "codex"]);
export const ProjectSettings = z.object({
	repo: z.string().nullable().describe("CAPCOMD_REPO: the repository agents work on"),
	mode: z.string().nullable().describe("pr (a pull request merged by capcomd) or direct (pushed to the target)"),
	target: z.string().nullable().describe("The branch work merges into"),
	check: z.string().describe("The check every change must pass (`run.checks.unit`); \"\" for none"),
	agents: z.array(z.string()).describe("The agents it has workers for: claude and/or codex"),
	budgetUsd: z.number().nullable().describe("The spend cap per run in USD (driver.maxRunBudget); null for none"),
});
export const ProjectProblemCode = z.enum(["not_found", "not_git", "home", "no_origin", "not_github"]);
export const ProjectProblem = z.object({
	code: z.string().describe(`What blocks setting it up: ${ProjectProblemCode.options.join(", ")} (not_found: no such folder; not_git: not a git checkout; home: the home folder, where capcomd keeps its own settings; no_origin: no origin remote; not_github: origin isn't on GitHub, so it's for \`capcomd setup project\` in Terminal). Treat an unknown code as a problem you show by its message`),
	message: z.string().describe("A sentence for the person, written by the daemon (trusted), e.g. \"~/notes isn't a git checkout. Choose your repository's folder, or clone it first.\""),
});
export const ProjectAgentInfo = z.object({
	provider: SetupAgentName,
	label: z.string().describe("\"Claude Code\" or \"Codex\""),
	loggedIn: z.boolean().describe("It has a login in at least one place (GET /v1/logins)"),
	auth: z.enum(["subscription", "apikey"]).describe("How its profiles would log in: subscription (a plan login, or none yet) or apikey (only an API key: it bills per use, so setup asks for a spend cap)"),
	places: z.array(z.object({ sandbox: z.string(), loggedIn: z.boolean(), how: z.enum(["plan", "api_key"]).nullable() })).describe("Its login in each place, as GET /v1/logins"),
});
export const KnownProjects = z.object({
	projects: z.array(z.object({
		name: z.string().describe("The project's name in capcomd's list"),
		path: z.string().describe("Absolute path of its checkout on the daemon's machine (it may have moved or gone since)"),
		default: z.boolean().describe("The default project: where a run without `repo` goes"),
	})).describe("In the order capcomd lists them"),
});
export const PROJECTS_KNOWN_DOC = "Capability projects.known. capcomd's projects (the list `capcomd setup project` and POST /v1/projects add to) with their checkout folders, for a client choosing where a first run goes. Read only; folders aren't checked (one may have moved).";
export const ProjectInspect = z.object({
	path: z.string().describe("The path as given"),
	root: z.string().nullable().describe("The git checkout it is in (its top level, symlinks resolved): a folder inside a checkout resolves to the checkout. null when it isn't in one"),
	name: z.string().nullable().describe("Its name in capcomd's projects (the one setup would give it when it isn't listed yet); null without a root"),
	configured: z.boolean().describe("Already a capcomd project: its .capcomd/config.json names a repository"),
	values: ProjectSettings.nullable().describe("When configured: what it has now (to prefill the form); else null"),
	repo: z.string().nullable().describe("origin as an https URL (the repository setup uses; never one the client sends); null without origin"),
	github: z.string().nullable().describe("owner/name when origin is on GitHub; else null"),
	ghReady: z.boolean().describe("`gh auth status` succeeds on the daemon's machine: pull requests (mode pr) can be opened and merged. false when it fails or origin isn't on GitHub"),
	defaultBranch: z.string().nullable().describe("origin's default branch as the local refs know it (origin/HEAD): the target to suggest. null when the local refs don't say (never a guessed main): ask, or read GET /v1/projects/branches (capability runs.goal_branch), which asks the remote"),
	branches: z.array(z.string()).describe("origin's branches from the local refs (no fetch), the default one included"),
	suggestedCheck: z.string().describe("The check `capcomd setup project` would suggest (package.json's test script: `bun run test`, `npm test`); \"\" for none"),
	suggestedMode: z.enum(["pr", "direct"]).describe("pr when ghReady, else direct (as the wizard suggests)"),
	suggestedAgents: z.array(SetupAgentName).describe("The agents with a login (claude when neither has one)"),
	agents: z.array(ProjectAgentInfo).describe("claude, then codex"),
	budgetAsked: z.boolean().describe("One of suggestedAgents would bill an API key, so the form asks for a spend cap per run. For another choice: any chosen agent whose `auth` is apikey"),
	problems: z.array(ProjectProblem).describe("What blocks setting it up; empty when it can be set up. POST /v1/projects refuses with the first one's message"),
});
export const PROJECTS_INSPECT_DOC = "Capability projects.setup. What the app needs to set up a folder as a capcomd project, without writing anything: the git checkout it is in, its origin (the repository setup uses), branches from the local refs, the check to suggest, whether pull requests can be opened (`gh auth status` on the daemon's machine, asked at most every 30 s), and the agents with how each would log in (from GET /v1/logins). " +
	"Needs the `read` scope. Local reads only (git refs, files, the login ledgers): no fetch, no network. A folder that can't be set up is still 200, with `problems`. 422 `invalid` for a relative path.";
export const ProjectSetupBody = z.object({
	path: z.string().min(1).max(4096).refine((p) => p.startsWith("/"), "path must be an absolute path").describe("The folder (as inspected): a checkout, or a folder inside one"),
	mode: z.enum(["pr", "direct"]).describe("pr: verified work lands as a pull request capcomd merges (needs `ghReady`); direct: pushed to the target branch"),
	target: BranchName.describe("The branch work merges into, e.g. main (merges into protected branches wait for an approval)"),
	check: z.string().max(2000).refine((c) => !/[\n\r\u0000]/.test(c), "check is one line").optional().describe("The command every change must pass, e.g. `bun run test`; \"\" for none (an existing check is kept). Omitted (capability projects.git): the project's current check when it's set up, else inspect's `suggestedCheck` (possibly none)"),
	agents: z.array(SetupAgentName).min(1).max(2).describe("claude, codex or both (each once): a worker profile per agent; the reviewer and planner use Claude Code when it's chosen"),
	budgetUsd: z.number().positive().optional().describe("A spend cap per run in USD, only when `budgetAsked` for these agents (one bills an API key); omitted: no limit"),
	expect: z.object({ repo: z.string().nullable().optional().describe("The `repo` inspect returned") }).optional().describe("What the form was filled from: when the folder's origin isn't `expect.repo` any more, 409 `conflict` and nothing is written. Send it"),
	gitignore: z.boolean().optional().describe("Capability projects.git. true: make sure git ignores `.capcomd/` in the checkout (one line appended to its .gitignore, which is created when missing; nothing when git already ignores it). Default false"),
});
export const ProjectSetupResult = z.object({
	project: z.object({
		path: z.string().describe("The path as given"),
		root: z.string().describe("The checkout that was set up: POST /v1/runs and GET /v1/run-options take it as `repo`"),
		name: z.string().describe("Its name in capcomd's projects"),
		configured: z.literal(true),
		values: ProjectSettings,
	}),
	changed: z.boolean().describe("Something changed: its settings, a profile added, or the folder added to capcomd's projects. A setup that changed nothing is still 200"),
});
export const PROJECTS_SETUP_DOC = "Capability projects.setup. Set a folder up as a capcomd project, as `capcomd setup project` does with the same answers: <checkout>/.capcomd/config.json (repository, merge mode, target, the check, the reviewer; a spend cap when asked), merged into what's there, and <checkout>/.capcomd/agents.json (a worker per agent, a read-only reviewer, a planner that may spawn the workers), keeping profiles that exist; then the folder joins capcomd's projects. Both files are written atomically, and only inside the checkout. " +
	"The repository is always the checkout's origin (GET /v1/projects/inspect `repo`), never a URL from the client; only GitHub checkouts. Needs the `configure` scope (403 `forbidden` without it), like changing a place's settings. " +
	"Everything is checked again: 422 `invalid` with the daemon's sentence and `field` (path, mode, target, check, agents, budgetUsd) for a folder inspect reports a problem for (`problem` is its code), pull requests without `ghReady`, a target that isn't a branch name, an unknown or repeated agent, a budget when none is asked (or not over 0), or a .capcomd that leads out of the checkout (a symlink). 409 `conflict` when origin isn't `expect.repo` (the body carries `repo`, the origin now). " +
	"Audited: a durable project.configured event on the `daemon` stream when something changed. " +
	"`Idempotency-Key` (8-200 chars, required) is scoped to the calling client and kept 24h: same key + same body: 200 with the first result (replay, nothing written again); same key + another body: 409 `idempotency_conflict`. Only a 200 is kept. Afterwards GET /v1/run-options?repo=<root> answers for the project.";

/** POST /v1/projects/git-init, GET /v1/projects/publish-options, POST /v1/projects/publish (capability projects.git). */
const AbsolutePath = z.string().min(1).max(4096).refine((p) => p.startsWith("/"), "path must be an absolute path");
export const ProjectGitInitBody = z.object({ path: AbsolutePath.describe("The folder (absolute) inspect reported as not_git") });
export const ProjectPublishOptions = z.object({
	path: z.string().describe("The path as given"),
	root: z.string().describe("The checkout that would be published"),
	ghReady: z.boolean().describe("The GitHub CLI is logged in on the daemon's machine (`gh auth status`, asked at most every 30 s). false: publishing is refused; show the person how to log in"),
	accounts: z.array(z.object({ login: z.string(), kind: z.enum(["user", "org"]).describe("user: the gh login; org: an organization it belongs to") }))
		.describe("Who the repository can be created as: the gh user first, then its organizations (`gh api`, asked at most every 30 s); empty when ghReady is false or GitHub didn't answer"),
	suggestedName: z.string().describe("The folder's name made a valid GitHub repository name (other characters become -)"),
	hasCommits: z.boolean().describe("The checkout has commits: publishing pushes them as they are. false: publishing makes the first commit (\"Initial commit\") of the files counted in `files`"),
	branch: z.string().describe("The branch that is pushed (the checkout's current one)"),
	files: z.number().int().describe("What publishing puts on GitHub: without commits, the files the first commit would hold (tracked, and untracked files that aren't ignored: `git add -A`); with commits, the files in HEAD"),
	blocked: z.array(z.object({ path: z.string().describe("Relative to the root"), reason: z.string().describe("Why it looks secret, e.g. \"an environment file, which usually holds secrets\"") }))
		.describe("Files among `files` that look like they hold secrets (by name: .env and .env.* except .env.example/.env.sample/.env.template, *.pem, *.key, *.p12, *.pfx, SSH private keys id_rsa/id_dsa/id_ecdsa/id_ed25519, .netrc, .git-credentials, and an .npmrc with an auth token), at most 50. Without commits, publishing refuses while any is listed: add them to .gitignore. With commits, they're already committed and only listed"),
});
export const PUBLISH_OPTIONS_DOC = "Capability projects.git. What the publish form needs for a checkout without origin (inspect's no_origin): whether the GitHub CLI is logged in, the accounts to publish as, a name, and what the first commit would hold. Needs the `read` scope; writes nothing; no network except `gh api` for the accounts. " +
	"422 `invalid` (`field` path, `problem` its code) for a folder inspect reports another problem for; 409 `conflict` for a checkout that already has an origin.";
export const ProjectPublishBody = z.object({
	path: AbsolutePath.describe("The checkout (as inspected), or a folder inside it"),
	owner: z.string().min(1).max(100).describe("A login from publish-options `accounts`"),
	name: z.string().min(1).max(100).describe("The repository's name on GitHub (letters, digits, ., _ and -)"),
	visibility: z.enum(["private", "public"]),
});
export const PROJECTS_GIT_INIT_DOC = "Capability projects.git. Start a git repository in a folder that isn't in one (`git init -b main`; no commit), so it can be published and set up. Only for a folder inspect reports as not_git, and never the home folder, a folder that holds it (/, /Users) or capcomd's own settings. " +
	"Needs the `configure` scope (403 `forbidden` without it). Returns the folder's inspect result as it is now (its problem is no_origin). 422 `invalid` with `field` path (and `problem`) for any other folder; 409 `conflict` when it is already in a checkout. " +
	"Audited: a durable project.git_initialized event on the `daemon` stream. `Idempotency-Key` (8-200 chars, required) as for POST /v1/projects: a replay answers the first 200 and runs nothing again.";
export const PROJECTS_PUBLISH_DOC = "Capability projects.git. Publish a checkout without origin to GitHub: when it has no commits, `git add -A` (what .gitignore ignores stays out) and a first commit \"Initial commit\"; then `gh repo create <owner>/<name> --private|--public --source <root> --remote origin --push` on the daemon's machine, which creates the repository, adds it as origin and pushes the current branch. Can take a while (it waits for the push). " +
	"Needs the `configure` scope (403 `forbidden` without it). Returns the checkout's inspect result as it is now (`github` set: it can be set up with POST /v1/projects). " +
	"Refusals carry the daemon's sentence and `field`: 422 `invalid` for a folder that isn't a checkout without origin (path, with `problem`), the GitHub CLI not logged in (gh), an owner that isn't in `accounts` or a name GitHub doesn't take (owner, name); without commits: likely secrets among the files (files; the sentence names them and says to add them to .gitignore), more than 2000 files (files: add a .gitignore), no files, or no git user.name/email (identity). 409 `conflict` with `field` name when the repository already exists on GitHub, and without a field when the checkout already has an origin or is being published. 503 `unavailable` when the GitHub CLI fails otherwise (its first line in the sentence). " +
	"A first commit that was made stays when the GitHub step fails: publishing again pushes it. Audited: a durable project.published event on the `daemon` stream (owner, name, visibility and a file count, never file names or contents). `Idempotency-Key` (8-200 chars, required) as for POST /v1/projects.";

/** GET /v1/projects/branches (capability runs.goal_branch): the setup screen's base menu and goal branch field. */
export const ProjectBranches = z.object({
	path: z.string().describe("The path as given"),
	root: z.string().nullable().describe("The checkout it is in; null when it isn't one (then everything else is empty)"),
	github: z.string().nullable().describe("owner/name when origin is on GitHub"),
	source: z.string().describe("Where the branches were read: the name of the project's forge when its service answered (github: the GitHub API with the user's own gh login; a forge plugin says its own name, so expect values beyond these), git (`git ls-remote origin`), local (the checkout's own refs: the remote couldn't be asked; see note)"),
	note: z.string().nullable().describe("Why a better source wasn't used (daemon-written, trusted), e.g. \"GitHub: no login (GITHUB_TOKEN, GH_TOKEN or `gh auth login`)\"; null when it was"),
	defaultBranch: z.string().nullable().describe("The repository's default branch as the remote reports it; null when it doesn't (never a guessed main)"),
	branches: z.array(z.string()).describe("The repository's branches, sorted (at most 500): the base menu"),
	projectTarget: z.string().nullable().describe("The project's configured target branch (`capcomd setup project`), when it has one"),
	suggestedBase: z.string().nullable().describe("What to preselect: `base` when given, else the project's target, else defaultBranch; null when none is known: the user must pick one (never a guessed main)"),
	suggestedGoalBranch: z.string().nullable().describe("With `goal`: capcomd/<goal-slug> (lowercase, hyphens, at most 40 characters of slug), with -2, -3… when the repository has that branch already; null without `goal`"),
	goalBranchProblem: z.string().nullable().describe("With `goalBranch`: why it can't be used (daemon-written, trusted: not a branch name, the base itself, protected, or already on the remote), shown under the field; null when it can"),
	baseProblem: z.string().nullable().describe("With `base`: why it can't be used (not a branch name, or not one of `branches` when they were read from the remote); null when it can"),
});
export const PROJECT_BRANCHES_DOC = "Capability runs.goal_branch. What the run setup screen needs for a project checkout: the repository's branches and default branch for the base menu (GitHub first, with the user's own GitHub login on the daemon's machine; else `git ls-remote origin`; else the checkout's local refs), the base to preselect (the project's target, else the default branch), and, with `goal`, the suggested goal branch; with `goalBranch` and `base`, whether that name can be used. " +
	"Needs the `read` scope. Writes nothing; asks the remote (the GitHub API or git, at most 15 s each), so call it when the screen opens and when the goal or a name changes (debounced), not in a loop. 422 `invalid` for a relative path. A folder that isn't a checkout is 200 with `root` null.";
export const ProjectBranchesQuery = z.object({
	path: AbsolutePath.describe("Absolute path of the project checkout (or a folder inside it), as POST /v1/runs `repo`"),
	goal: z.string().max(16 * 1024).optional().describe("The goal as typed: suggestedGoalBranch is made from its first line"),
	goalBranch: z.string().max(256).optional().describe("A goal branch name the user typed: goalBranchProblem says whether it can be used"),
	base: z.string().max(256).optional().describe("The base the user picked (checked; preselected)"),
});

/** GET /v1/runs/{runId}/goal (capability runs.goal_branch). */
export const GOAL_FILES_MAX = 200;
const GoalWork = z.object({
	agentId: z.string(),
	parent: z.string().nullable(),
	profile: z.string().nullable(),
	task: UntrustedText.describe("The first line of its task (at most 200 characters)"),
	title: UntrustedText.nullable().optional().describe("Its title (capability agents.title: 1–4 lowercase words, the agent's, its parent's or the user's, else derived from its task): what to show first, with `task` as the detail. Older daemons don't send it"),
	continues: z.array(z.string()).optional().describe("The agents whose work this one carries on (`spawn --continue`, e.g. after a merge conflict), nearest first. Their work landed, or didn't, with this one's, so they aren't listed on their own. Older daemons don't send it"),
	branch: z.string().nullable().describe("The branch it pushed"),
});
export const GoalLanded = GoalWork.extend({
	mergeId: z.string().describe("mrg-… of the merge that landed it"),
	sha: z.string().nullable().describe("The commit the merge made on the goal branch"),
	verifyId: z.string().nullable().describe("vfy-… of the verification that gated it"),
	mergedBy: z.string().nullable().describe("The agent that merged it (its parent: a lead or the planner); null for an operator's merge"),
	checks: z.object({ passed: z.boolean() }).nullable().describe("The project's checks on it (merged with the goal branch); null when none were recorded"),
	review: z.object({ passed: z.boolean(), agentId: z.string().nullable(), reasons: z.array(UntrustedText) }).nullable().describe("The run's reviewer agent's verdict; null when the run has no reviewer"),
});
export const GoalNotLanded = GoalWork.extend({
	status: AgentStatus.or(z.string()).describe("The agent's status"),
	reason: z.string().describe("Why it isn't on the goal branch: checks_failed, review_failed, merge_failed, denied, awaiting_approval, verifying, not_verified (done, never verified), not_merged (verified, never merged), failed, cancelled, still_working. Treat an unknown reason as not landed for a reason you don't know"),
	detail: UntrustedText.nullable().describe("More, when there is any: the failing check's reason, the reviewer's reasons, the agent's error (at most 1000 characters)"),
});
export const GoalView = z.object({
	runId: z.string(),
	branch: z.string(),
	base: z.string(),
	state: GoalBranchState,
	goal: UntrustedText.nullable().describe("The run's goal, as the user wrote it"),
	readyAt: Timestamp.nullable(),
	plannerId: z.string().nullable().describe("The planner agent (the run's root); null in a run its driver runs itself (an MCP or CLI driver, no planner agent)"),
	summary: UntrustedText.nullable().describe("The planner's own summary (`capcomd result --summary`), or in a driver's run the summary it gave when it marked the goal done: what it shows first; null while it works or when it wrote none"),
	driven: z.boolean().optional().describe("The run has no planner agent: its driver (the user's own agent, over MCP or the CLI) marks the goal done (`capcomd_goal {done: true}`, `capcomd goal done`), which makes it ready"),
	compare: z.object({
		baseSha: z.string().nullable(), headSha: z.string().nullable(),
		ahead: z.number().int().nonnegative().nullable().describe("Commits on the goal branch that the base doesn't have"),
		behind: z.number().int().nonnegative().nullable().describe("Commits on the base since the goal branch was cut (the pull request may need them merged in)"),
		commits: z.array(z.object({ sha: z.string(), subject: UntrustedText, at: Timestamp.nullable() })).describe("The goal branch's own commits, newest first, at most 50"),
		commitsTotal: z.number().int().nonnegative().nullable(),
		files: z.array(FileChange.omit({ agentId: true })).describe(`The files the goal branch changes against where it left the base (\`git diff --numstat\`), the ${GOAL_FILES_MAX} with the most changed lines first`),
		filesTotal: z.number().int().nonnegative().nullable(),
		added: z.number().int().nonnegative().nullable(), removed: z.number().int().nonnegative().nullable(),
		error: z.string().nullable().describe("Why the branches couldn't be compared (daemon-written): the remote unreachable, a branch deleted; the rest of the answer still holds"),
	}).describe("The goal branch against its base, fetched now"),
	landed: z.array(GoalLanded).describe("Each child whose work was merged onto the goal branch, in the order the agents were spawned"),
	notLanded: z.array(GoalNotLanded).describe("Each child with work that isn't on the goal branch, and why. Children with nothing of their own to land (reports, leads whose children landed) and children whose work another continued (listed under that one's `continues`) aren't listed"),
	pullRequest: GoalPullRequest.nullable().describe("The pull request opened from the goal branch, once there is one"),
	openPullRequest: z.object({
		available: z.boolean().describe("POST …/pull-request would open (or return) one now"),
		reason: z.string().nullable().describe("Why not, a sentence for the person (daemon-written, trusted) that says what to do: not on GitHub (the branch name is in it), no GitHub login (`gh auth login`), the planner still working, nothing landed yet; null when available"),
		repo: z.string().nullable().describe("owner/name on GitHub; null when it isn't on GitHub"),
		confirm: z.string().nullable().optional().describe("State stopped (the planner failed or was cancelled before it finished): the question to ask the person before opening a pull request with what landed (daemon-written, trusted), e.g. \"The planner stopped before it finished (it failed): 2 of 3 tasks landed on capcomd/add-x. Open a pull request with what landed?\"; then POST …/pull-request with `{\"stopped\": true}`. null otherwise. Older daemons don't send it"),
	}),
	decision: z.object({ choice: z.enum(["pull_request", "keep"]), by: z.string(), at: Timestamp }).nullable().describe("What the user chose; null before"),
});
export const GOAL_DOC = "Capability runs.goal_branch. A goal-branch run's result, for the planner's column and the run's \"ready\" card: the goal branch against its base (commits, files, lines; fetched now), each child that landed (its task, branch, checks and review), each that didn't and why, the planner's summary, and whether a pull request can be opened (`openPullRequest`, with the reason when it can't). " +
	"Works while the run is working too (what landed so far). Needs the `read` scope. Refetch on run.goal_completed, run.pr_opened, run.branch_kept and merge.succeeded. 404 `not_found` for an unknown run or a run without a goal branch (Run.goalBranch null).";
export const GoalPullRequestResult = z.object({
	runId: z.string(), branch: z.string(), base: z.string(),
	created: z.boolean().describe("This call opened it; false: it was open (or merged) already and is returned as it is"),
	pullRequest: GoalPullRequest.extend({ state: z.string().describe("open, closed or merged") }),
});
export const PullRequestBody = z.object({
	stopped: z.boolean().optional().describe("The person was asked about a stopped run (GET …/goal `openPullRequest.confirm`, or the 409 `stopped` message) and wants the pull request anyway. Ignored for a run that isn't stopped"),
});
export const PULL_REQUEST_DOC = "Capability runs.goal_branch. Open a GitHub pull request from the run's goal branch into its base (body optional: `{\"stopped\": true}`), with the user's own GitHub login on the daemon's machine (GITHUB_TOKEN, GH_TOKEN, else `gh auth token`). Title: the run's goal; description: the planner's summary, then what each agent landed and how it was reviewed, then what didn't. capcomd never merges it. " +
	"Idempotent: a pull request GitHub already has from the branch into the base (open or merged) is returned with `created: false`. Confirmed by run.pr_opened on the run stream (Run.goalBranch.state pr_opened). " +
	"A run whose planner stopped before it finished (state stopped: it failed or was cancelled) is 409 `stopped` with the question to ask the person (\"The planner stopped before it finished (it failed): 2 of 3 tasks landed on <branch>. Open a pull request with what landed?\"); once they agree, send `{\"stopped\": true}`, and the description says near the top that the run stopped. " +
	"409 `conflict` (the message says why and what to do): the planner is still working, nothing landed on the goal branch, the repository isn't on GitHub or there is no GitHub login (GET …/goal `openPullRequest` says so first), or GitHub refused it. 404 for an unknown run or one without a goal branch. " +
	"Needs the steer scope: it lands nothing (the base changes only when someone merges the pull request on GitHub), like starting a run, which pushes branches. " + WRITE_DOC;
export const KEEP_BRANCH_DOC = "Capability runs.goal_branch. Keep the goal branch without a pull request (no body): recorded so clients stop asking (Run.goalBranch.state kept; run.branch_kept on the run stream). Opening a pull request later is still allowed. 409 `conflict` while the planner works, or once a pull request was opened. Needs the steer scope. " + WRITE_DOC;

/** PUT /v1/runs/{runId}/agents/{agentId}/title (capability agents.title). */
export const AgentTitleBody = z.object({
	title: z.string().max(200).describe(`The user's title for the agent: 1 to ${TITLE_WORDS_MAX} words, at most ${TITLE_MAX_CHARS} characters. Trimmed, whitespace collapsed, lowercased, control and format characters dropped; refused (422 \`invalid\`, field title) when that leaves no words, or more words or characters than that`),
});
/** Result of PUT and DELETE …/title. The change itself arrives as agent.titled on the run's streams. */
export const AgentTitleResult = z.object({
	runId: z.string(),
	agentId: z.string(),
	title: UntrustedText.nullable().describe("Agent-written text: render as plain text, never markdown, links or actions. Agent.title after the call"),
	titleSource: AgentTitleSource.nullable().describe("Agent.titleSource after the call"),
	changed: z.boolean().describe("This call changed something (false: the same title again, or nothing to clear)"),
});
export const AGENT_TITLE_DOC = "Capability agents.title. The user's title for the agent (`{\"title\": \"login redirect\"}`): what its tab, row and column header say. " +
	"It sticks until the user clears it (DELETE): the agent's own renames (`capcomd title` in its VM), its parent's and the driving harness's are still recorded under it, and the latest of them shows once it is cleared. " +
	`The user's renames aren't rate limited (an agent's and a parent's are: one per ${RENAME_WINDOW_MS / 1000} s, ${RENAMES_MAX} per agent). Works on an agent that has ended. Confirmed by agent.titled (by user) on the run's streams. ` +
	"422 `invalid` (field title) for a title with no words, more than 4 words or more than 32 characters. " + WRITE_DOC;
export const AGENT_TITLE_CLEAR_DOC = "Capability agents.title. Clear the user's title for the agent (no body): Agent.title goes back to the latest title the agent, its parent or the driving harness set, else the derived one. Confirmed by agent.titled (by cleared) on the run's streams; `changed: false` when there was none. " + WRITE_DOC;

export const contract = {
	health: oc.route({ method: "GET", path: "/v1/health", description: "Liveness; no token needed. `capabilities` is how a client feature-detects (Capabilities in docs/harness-contract.md)." })
		.output(z.object({ ok: z.literal(true), api: z.literal("harness.v1"), version: z.string(), capabilities: z.array(z.string()).optional().describe(`Features this daemon has: ${CAPABILITIES_DOC} This daemon always sends it; optional because daemons from before capabilities don't: treat a missing list as empty`) })),
	projects: {
		list: oc.route({ method: "GET", path: "/v1/projects" }).output(z.array(Project)),
		known: oc.route({ method: "GET", path: "/v1/projects/known", description: PROJECTS_KNOWN_DOC }).output(KnownProjects),
		inspect: oc.route({ method: "GET", path: "/v1/projects/inspect", description: PROJECTS_INSPECT_DOC })
			.input(z.object({ path: z.string().min(1).max(4096).refine((p) => p.startsWith("/"), "path must be an absolute path").describe("Absolute path of a folder on the daemon's machine") })).output(ProjectInspect),
		setup: oc.route({ method: "POST", path: "/v1/projects", inputStructure: "detailed", description: PROJECTS_SETUP_DOC })
			.input(z.object({ headers: IdempotencyHeaders, body: ProjectSetupBody })).output(ProjectSetupResult),
		gitInit: oc.route({ method: "POST", path: "/v1/projects/git-init", inputStructure: "detailed", description: PROJECTS_GIT_INIT_DOC })
			.input(z.object({ headers: IdempotencyHeaders, body: ProjectGitInitBody })).output(ProjectInspect),
		publishOptions: oc.route({ method: "GET", path: "/v1/projects/publish-options", description: PUBLISH_OPTIONS_DOC })
			.input(z.object({ path: AbsolutePath.describe("Absolute path of the checkout (or a folder inside it)") })).output(ProjectPublishOptions),
		publish: oc.route({ method: "POST", path: "/v1/projects/publish", inputStructure: "detailed", description: PROJECTS_PUBLISH_DOC })
			.input(z.object({ headers: IdempotencyHeaders, body: ProjectPublishBody })).output(ProjectInspect),
		branches: oc.route({ method: "GET", path: "/v1/projects/branches", description: PROJECT_BRANCHES_DOC }).input(ProjectBranchesQuery).output(ProjectBranches),
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
		goal: oc.route({ method: "GET", path: "/v1/runs/{runId}/goal", description: GOAL_DOC }).input(z.object({ runId: z.string() })).output(GoalView),
		pullRequest: oc.route({ method: "POST", path: "/v1/runs/{runId}/pull-request", inputStructure: "detailed", description: PULL_REQUEST_DOC })
			.input(z.object({ params: z.object({ runId: z.string() }), headers: IdempotencyHeaders, body: PullRequestBody.optional() })).output(GoalPullRequestResult),
		keepBranch: oc.route({ method: "POST", path: "/v1/runs/{runId}/keep-branch", inputStructure: "detailed", description: KEEP_BRANCH_DOC })
			.input(z.object({ params: z.object({ runId: z.string() }), headers: IdempotencyHeaders })).output(z.object({ runId: z.string(), branch: z.string(), base: z.string(), kept: z.literal(true), changed: z.boolean().describe("This call recorded it (false: it was kept already)") })),
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
		threadTail: oc.route({ method: "GET", path: "/v1/runs/{runId}/agents/{agentId}/thread/tail", description: `Capability agents.thread_tail. The agent's newest thread items by position (\`order\`): \`before\` (from a previous page) for the items above, \`limit\` at most ${THREAD_PAGE_MAX}. \`cursor\` is where GET …/thread (\`after\`) and live frames take over. See "Agent threads" in docs/harness-contract.md.` })
			.input(z.object({ runId: z.string(), agentId: z.string(), before: z.coerce.number().int().nonnegative().optional(), limit: z.coerce.number().int().positive().max(THREAD_PAGE_MAX).optional() }))
			.output(ThreadTail),
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
		setTitle: oc.route({ method: "PUT", path: "/v1/runs/{runId}/agents/{agentId}/title", inputStructure: "detailed", description: AGENT_TITLE_DOC })
			.input(z.object({ params: z.object({ runId: z.string(), agentId: z.string() }), headers: IdempotencyHeaders, body: AgentTitleBody })).output(AgentTitleResult),
		clearTitle: oc.route({ method: "DELETE", path: "/v1/runs/{runId}/agents/{agentId}/title", inputStructure: "detailed", description: AGENT_TITLE_CLEAR_DOC })
			.input(z.object({ params: z.object({ runId: z.string(), agentId: z.string() }), headers: IdempotencyHeaders })).output(AgentTitleResult),
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
	plugins: {
		list: oc.route({ method: "GET", path: "/v1/plugins", description: PLUGINS_DOC }).output(Plugins),
	},
	profiles: {
		list: oc.route({ method: "GET", path: "/v1/profiles", description: PROFILES_DOC }).input(ProfilesQuery).output(Profiles),
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
