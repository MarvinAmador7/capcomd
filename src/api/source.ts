// Where the harness.v1 server reads from. The server only speaks this interface: the Rivet-backed source reads the
// scope actors (src/primitives/ops.ts); tests use memorySource so tests/api stays fast and engine-free.
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Agent, Attachment, Decision, Message, Project, Run, Skill, Span, TranscriptItem } from "./contract";
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
}

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
export function memorySource(seed: Partial<{ runs: O<typeof Run>[]; agents: Record<string, O<typeof Agent>[]>; events: Record<string, RawEvent[]>; approvals: Record<string, PendingApproval[]>; repos: Record<string, RunRepo> }> = {}): HarnessSource & { push(runId: string, e: Omit<RawEvent, "seq">): RawEvent; decided: Array<{ approvalId: string; approve: boolean; by: string }>; created: CreateRunInput[] } {
	const events = seed.events ?? {};
	const approvals = seed.approvals ?? {};
	const runs = seed.runs ?? [];
	const decided: Array<{ approvalId: string; approve: boolean; by: string }> = [];
	const created: CreateRunInput[] = [];
	return {
		version: "test",
		decided,
		created,
		push(runId, e) { const l = (events[runId] ??= []); const r = { ...e, seq: (l.at(-1)?.seq ?? 0) + 1 }; l.push(r); return r; },
		runs: async () => runs,
		projects: async () => [],
		agents: async (r) => seed.agents?.[r] ?? (seed.runs?.some((x) => x.id === r) ? [] : null),
		events: async (r, after) => (events[r] ?? []).filter((e) => e.seq > after),
		transcript: async () => [],
		attachment: async () => null,
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
