// Where the harness.v1 server reads from. The server only speaks this interface: the Rivet-backed source reads the
// scope actors (src/primitives/ops.ts); tests use memorySource so tests/api stays fast and engine-free.
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Agent, AgentStatus, Attachment, Decision, Message, Project, Run, Skill, Span, ThreadItem, TranscriptItem } from "./contract";
import type { WorkspaceFile } from "./run-files";
import { dottedType, isoTs, type HarnessEvent } from "./envelope";
import { describeEvent } from "./describe";
import type { RunRepo } from "./run-files";

export type RawEvent = { seq: number; at: number; type: string; agentId: string | null; data: Record<string, unknown> };
export type PendingApproval = { approvalId: string; kind: "merge"; status: "pending"; question: string; requestedBy: { agentId: string | null; runId: string }; subject: Record<string, unknown>; expiresAt: null };
type O<T extends z.ZodType> = z.infer<T>;

/** runs.create input after validation (goal trimmed). */
export type CreateRunInput = { goal: string; repo?: string; profile?: string; targetBranch?: string };
/** A run that can't be started as asked (bad repo, no repository, refused by `capcomd run`): 422 with this message. */
export class CreateRunError extends Error {}

/** A project groups runs on one repository: its id is derived from the run's repository (CAPCOMD_REPO). */
export const projectIdOf = (repo: string | null) => (repo ? `prj-${createHash("sha256").update(repo).digest("hex").slice(0, 12)}` : null);

export interface HarnessSource {
	version: string;
	runs(): Promise<O<typeof Run>[]>;
	projects(): Promise<O<typeof Project>[]>;
	agents(runId: string): Promise<O<typeof Agent>[] | null>;
	/** Durable events of a run scope after `after` (legacy names; the server maps them to envelopes). */
	events(runId: string, after: number): Promise<RawEvent[]>;
	transcript(runId: string, agentId: string, after: number, limit: number): Promise<O<typeof TranscriptItem>[] | null>;
	attachment(runId: string, id: string): Promise<O<typeof Attachment> | null>;
	/** An agent's thread items after `after` (seq), in write order; null when the run or agent is unknown. */
	thread(runId: string, agentId: string, after: number, limit: number): Promise<O<typeof ThreadItem>[] | null>;
	/** The whole run's thread writes after `after` (live frames). */
	threadAfter(runId: string, after: number, limit: number): Promise<O<typeof ThreadItem>[]>;
	/** The run's newest thread write (0 when none). */
	threadHead(runId: string): Promise<number>;
	/** An attachment's bytes and media type. */
	attachmentContent(runId: string, id: string): Promise<{ mime: string; bytes: Uint8Array } | null>;
	/** A file of an agent's latest work (path already normalized); null when the run or agent is unknown. */
	workspaceFile(runId: string, agentId: string, path: string): Promise<WorkspaceFile | null>;
	trace(runId: string): Promise<O<typeof Span>[]>;
	skills(): Promise<O<typeof Skill>[]>;
	approvals(runId: string): Promise<PendingApproval[]>;
	/** Locate an approval: its run, and the decision when already decided. */
	approval(approvalId: string): Promise<{ runId: string; pending: boolean; decision?: Record<string, unknown> | null } | null>;
	decide(approvalId: string, approve: boolean, by: string, reason?: string): Promise<void>;
	/** Start a run, detached; resolves once it is started (not finished). Throws CreateRunError for a 422. */
	createRun(input: CreateRunInput): Promise<O<typeof Run>>;
	/** The run's repository and target branch (GET /v1/runs/{runId}/files); null when the run has none. */
	repo(runId: string): Promise<RunRepo | null>;
	/** Pause, resume or cancel the run's agents (`by`: client:<id>). `noop` explains why nothing changed (→ 409 conflict). */
	control(runId: string, action: RunAction, by: string): Promise<ControlResult>;
	/** Send `to` a message from the operator; idempotent by `key`. */
	send(runId: string, to: string, body: string, key: string): Promise<{ seq: number; note: string | null }>;
}
export type RunAction = "pause" | "resume" | "cancel";
export type ControlResult = { changed: string[]; pending: string[]; noop: string | null };

/** Legacy scope event → harness.v1 envelope. entitySeq counts per entity in seq order within what the caller saw. */
export function toEnvelope(runId: string, e: RawEvent, entitySeq: number, projectId: string | null = null): HarnessEvent {
	const type = /^[A-Z]/.test(e.type) ? dottedType(e.type) : e.type;
	return {
		v: 1, id: `evt_${runId}_${e.seq}`, scope: runId, seq: e.seq, entity: e.agentId ?? runId, entitySeq, type, typeVersion: 1,
		durability: "durable", ts: isoTs(e.at), epochMs: e.at, projectId, runId, agentId: e.agentId, text: describeEvent(type, e.data, e.agentId), data: e.data,
	};
}
export function envelopes(runId: string, evs: RawEvent[], projectId: string | null = null): HarnessEvent[] {
	const n = new Map<string, number>();
	return evs.map((e) => { const k = e.agentId ?? runId; const s = (n.get(k) ?? 0) + 1; n.set(k, s); return toEnvelope(runId, e, s, projectId); });
}

/** message.sent events → thread messages. */
export function messagesOf(evs: RawEvent[]): O<typeof Message>[] {
	return evs.filter((e) => e.type === "MESSAGE_SENT" || e.type === "message.sent").map((e) => ({
		seq: Number(e.data.seq), from: e.agentId ?? "operator", to: typeof e.data.to === "string" ? e.data.to : JSON.stringify(e.data.to), at: isoTs(e.at),
		text: (e.data.text as string | null) ?? null, attachment: (e.data.attachment as any) ?? null,
	}));
}

export const approvalIdFor = (runId: string, opId: string) => `apr-${Buffer.from(`${runId}\u0000${opId}`).toString("hex")}`;
export function parseApprovalId(id: string): { runId: string; opId: string } | null {
	const m = /^apr-([0-9a-f]+)$/.exec(id);
	if (!m) return null;
	const [runId, opId] = Buffer.from(m[1]!, "hex").toString("utf8").split("\u0000");
	return runId && opId ? { runId, opId } : null;
}

/** In-memory source for tests and fixtures. */
export function memorySource(seed: Partial<{
	runs: O<typeof Run>[]; agents: Record<string, O<typeof Agent>[]>; events: Record<string, RawEvent[]>; approvals: Record<string, PendingApproval[]>; repos: Record<string, RunRepo>;
	/** Thread items by run (tests push more as the agent "works"). */
	items: Record<string, O<typeof ThreadItem>[]>;
	attachments: Record<string, Record<string, { mime: string; bytes: Uint8Array }>>;
	files: Record<string, Record<string, Record<string, Uint8Array>>>;
}> = {}): HarnessSource & { push(runId: string, e: Omit<RawEvent, "seq">): RawEvent; decided: Array<{ approvalId: string; approve: boolean; by: string }>; created: CreateRunInput[] } {
	const events = seed.events ?? {};
	const approvals = seed.approvals ?? {};
	const runs = seed.runs ?? [];
	const decided: Array<{ approvalId: string; approve: boolean; by: string }> = [];
	const created: CreateRunInput[] = [];
	const sent = new Map<string, number>(); // message idempotency key → seq
	const push = (runId: string, e: Omit<RawEvent, "seq">) => { const l = (events[runId] ??= []); const r = { ...e, seq: (l.at(-1)?.seq ?? 0) + 1 }; l.push(r); return r; };
	// Agent state changes as the scope actor writes them (a running agent pauses at once here: there is no runner).
	const STEP: Record<RunAction, { from: string[]; to: O<typeof AgentStatus>; type: string; data: (by: string) => Record<string, unknown>; noop: string }> = {
		pause: { from: ["pending", "running"], to: "paused", type: "AGENT_PAUSED", data: (by) => ({ result: { limit: "paused", by }, until: null }), noop: "no pending or running agent to pause" },
		resume: { from: ["paused"], to: "running", type: "AGENT_RESUMED", data: (by) => ({ epoch: 2, by }), noop: "no paused agent to resume" },
		cancel: { from: ["pending", "running", "paused"], to: "cancelled", type: "AGENT_CANCELLED", data: (by) => ({ reason: `cancelled by ${by}`, by: "run" }), noop: "nothing to cancel: every agent has ended" },
	};
	return {
		version: "test",
		decided,
		created,
		push,
		control: async (runId, action, by) => {
			const s = STEP[action];
			const out: ControlResult = { changed: [], pending: [], noop: null };
			for (const a of seed.agents?.[runId] ?? []) {
				if (!s.from.includes(a.status)) continue;
				(action === "pause" && a.status === "running" ? out.pending : out.changed).push(a.id);
				a.status = s.to;
				push(runId, { at: Date.now(), type: s.type, agentId: a.id, data: s.data(by) });
			}
			if (!out.changed.length && !out.pending.length) out.noop = `${runId}: ${s.noop}`;
			return out;
		},
		send: async (runId, to, body, key) => {
			const prior = sent.get(key);
			if (prior !== undefined) return { seq: prior, note: null };
			const seq = messagesOf(events[runId] ?? []).reduce((m, x) => Math.max(m, x.seq), 0) + 1;
			push(runId, { at: Date.now(), type: "MESSAGE_SENT", agentId: "operator", data: { to, seq, bytes: Buffer.byteLength(body), text: body, attachment: null } });
			sent.set(key, seq);
			return { seq, note: null };
		},
		runs: async () => runs,
		projects: async () => [],
		agents: async (r) => seed.agents?.[r] ?? (seed.runs?.some((x) => x.id === r) ? [] : null),
		events: async (r, after) => (events[r] ?? []).filter((e) => e.seq > after),
		transcript: async () => [],
		attachment: async (r, id) => { const a = seed.attachments?.[r]?.[id]; return a ? { attachment: { id, bytes: a.bytes.length, sha256: "0".repeat(64), mediaType: a.mime }, text: Buffer.from(a.bytes).toString(a.mime.startsWith("text/") ? "utf8" : "base64"), encoding: a.mime.startsWith("text/") ? "utf8" as const : "base64" as const } : null; },
		thread: async (r, agentId, after, limit) => {
			if (!seed.agents?.[r]?.some((a) => a.id === agentId)) return null;
			return (seed.items?.[r] ?? []).filter((i) => i.agentId === agentId && i.seq > after).sort((a, b) => a.seq - b.seq).slice(0, limit);
		},
		threadAfter: async (r, after, limit) => (seed.items?.[r] ?? []).filter((i) => i.seq > after).sort((a, b) => a.seq - b.seq).slice(0, limit),
		threadHead: async (r) => Math.max(0, ...(seed.items?.[r] ?? []).map((i) => i.seq)),
		attachmentContent: async (r, id) => seed.attachments?.[r]?.[id] ?? null,
		workspaceFile: async (r, agentId, path) => {
			if (!seed.agents?.[r]?.some((a) => a.id === agentId)) return null;
			const b = seed.files?.[r]?.[agentId]?.[path];
			return b ? { bytes: b, path, sha: "0".repeat(40) } : { error: "not_found", message: `${path} is not in the agent's latest work` };
		},
		trace: async () => [],
		skills: async () => [],
		approvals: async (r) => (approvals[r] ?? []).filter((a) => !decided.some((d) => d.approvalId === a.approvalId)),
		approval: async (id) => {
			for (const [runId, l] of Object.entries(approvals)) if (l.some((a) => a.approvalId === id)) return { runId, pending: !decided.some((d) => d.approvalId === id) };
			return null;
		},
		decide: async (approvalId, approve, by) => { decided.push({ approvalId, approve, by }); },
		createRun: async (input) => {
			created.push(input);
			const repo = input.repo ?? "/default-repo";
			const run = { id: `run-mem-${created.length}`, projectId: projectIdOf(repo), label: input.goal, state: "starting", goal: input.goal, repo, createdAt: isoTs(Date.now()) };
			runs.push(run);
			return run;
		},
		repo: async (r) => seed.repos?.[r] ?? null,
	};
}
export type { Decision };
