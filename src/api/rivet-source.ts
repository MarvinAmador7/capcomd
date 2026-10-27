// HarnessSource over the Rivet scope actors: what `capcomd serve` exposes on the harness socket.
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { client, generateRunId } from "../core/relay";
import { redactShapes } from "../agents/redact";
import { listSkills, readSkill } from "../agents/skills";
import { cancelAny, decideMerge, pauseAgents, recentRuns, resumeAgents, runTarget, sendToAgent } from "../primitives/ops";
import { mergeConfigFor } from "../merge/run-config";
import { tracePath } from "../utils/tracing-simple";
import { VERSION } from "../utils/self";
import { isoTs } from "./envelope";
import { agentActivity, describeEvent } from "./describe";
import { inlineOrAttach, INLINE_TEXT_MAX_BYTES } from "./inline-cap";
import { approvalIdFor, parseApprovalId, projectIdOf, type HarnessSource, type PendingApproval } from "./source";
import { startDetachedRun } from "./create-run";
import { workspaceOf } from "./workspace";
import { mirrorFor, workTips } from "./run-files";
import { RUN_REPO_KV } from "../merge/run-config";

const lower = (p: string | null) => (p ? p.toLowerCase() : null);
const cap = (t: string) => (Buffer.byteLength(t) <= INLINE_TEXT_MAX_BYTES ? t : Buffer.from(t).subarray(0, INLINE_TEXT_MAX_BYTES).toString("utf8").replace(/\uFFFD+$/, ""));
const scope = (runId: string) => client().scope.getOrCreate([runId]);
/** Thread items in actor calls of at most ITEMS_PER_CALL rows (an item can be ~150 KB; a call answers at most 8 MB). */
const ITEMS_PER_CALL = 25;
async function itemsAfter(runId: string, after: number, limit: number, agentId?: string): Promise<any[]> {
	const out: any[] = [];
	for (let cur = after; out.length < limit;) {
		const rows = (await scope(runId).getItems({ ...(agentId ? { agentId } : {}), after: cur, limit: Math.min(ITEMS_PER_CALL, limit - out.length) })) as any[];
		out.push(...rows);
		if (rows.length < Math.min(ITEMS_PER_CALL, limit - out.length + rows.length)) break;
		cur = rows.at(-1)!.seq;
	}
	return out;
}

/** harness.v1 Agent.provider/model from the spec recorded at spawn ({...profile, kind, model}): the profile's provider,
 * else the runner's (an agent chosen by CAPCOMD_AGENT has no profile); a fake agent has neither. */
export function agentRuntime(spec: unknown): { provider: "claude" | "codex" | null; model: string | null } {
	const s = (spec && typeof spec === "object" ? spec : {}) as Record<string, unknown>;
	if (s.kind === "fake") return { provider: null, model: null };
	const provider = s.provider === "claude" || s.provider === "codex" ? s.provider : s.kind === "claude-code" ? "claude" : s.kind === "codex" ? "codex" : null;
	return { provider, model: provider && typeof s.model === "string" && s.model ? s.model : null };
}

export function rivetSource(): HarnessSource {
	const runsIndex = () => recentRuns(500);
	const runs = async () => Promise.all(runsIndex().map(async (r) => {
		const meta = (await scope(r.runId).getScope({}).catch(() => null)) as { goal?: string | null } | null;
		const agents = meta ? await scope(r.runId).listAgents({}).catch(() => []) : [];
		const live = (agents as Array<{ status: string }>).some((a) => a.status === "running" || a.status === "pending" || a.status === "paused");
		return { id: r.runId, projectId: projectIdOf(r.repo), label: r.label, state: !meta ? "unknown" : live ? "running" : agents.length ? "idle" : "new", goal: meta?.goal ?? null, repo: r.repo, createdAt: isoTs(r.createdAt) };
	}));
	return {
		version: VERSION,
		runs,
		projects: async () => {
			const by = new Map<string, { id: string; name: string; repo: string | null; goal: string | null; runIds: string[] }>();
			for (const r of (await runs()).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))) {
				if (!r.projectId) continue;
				const p = by.get(r.projectId) ?? { id: r.projectId, name: basename(r.repo ?? r.projectId), repo: r.repo, goal: null, runIds: [] };
				p.runIds.push(r.id);
				p.goal ??= r.goal;
				by.set(r.projectId, p);
			}
			return [...by.values()];
		},
		agents: async (runId) => {
			if (!runsIndex().some((r) => r.runId === runId) && !(await scope(runId).getScope({}).catch(() => null))) return null;
			const all = (await scope(runId).listAgents({})) as any[];
			// Agents spawned before the workspace was recorded: the run's repository, where every agent works today.
			const runRepo = all.some((a) => !a.workspace)
				? ((await scope(runId).kvGet({ k: RUN_REPO_KV }).catch(() => null))?.value as Record<string, string> | undefined)?.CAPCOMD_REPO ?? runsIndex().find((r) => r.runId === runId)?.repo ?? null
				: null;
			return all.map((a) => {
				const inl = inlineOrAttach(redactShapes(String(a.task ?? "")));
				return {
					id: a.agentId, runId, parent: a.parent, depth: a.depth, profile: lower(a.profile), status: a.status,
					text: describeEvent("agent.status_changed", { status: a.status }, a.agentId), activity: agentActivity(a.activity, a.status),
					task: inl.text, taskAttachment: inl.attachment, result: a.result ?? null, workspace: a.workspace ?? workspaceOf(runRepo),
					...agentRuntime(a.spec), updatedAt: a.updatedAt ? isoTs(a.updatedAt) : null,
				};
			});
		},
		events: async (runId, after) => (await scope(runId).getEvents({ since: after }).catch(() => [])) as any,
		transcript: async (runId, agentId, after, limit) => {
			const a = await scope(runId).getAgent({ agentId }).catch(() => null);
			if (!a) return null;
			const lines = (await scope(runId).getLogs({ agentId, after, tail: limit })) as Array<{ seq: number; at: number; stream: string; line: string }>;
			return lines.map((l) => ({ seq: l.seq, at: isoTs(l.at), stream: l.stream, text: cap(l.line) }));
		},
		attachment: async (runId, id) => {
			const r = await scope(runId).getAttachment({ id }).catch(() => null);
			if (!r) return null;
			// Tool images are stored base64 with a `;base64` media type suffix (scope.putItems).
			const b64 = r.mediaType.endsWith(";base64");
			return { attachment: { id: r.id, bytes: r.bytes, sha256: r.sha256, mediaType: b64 ? r.mediaType.slice(0, -7) : r.mediaType }, text: r.body, encoding: b64 ? "base64" : "utf8" };
		},
		attachmentContent: async (runId, id) => {
			const r = await scope(runId).getAttachment({ id }).catch(() => null);
			if (!r) return null;
			const b64 = r.mediaType.endsWith(";base64");
			return { mime: b64 ? r.mediaType.slice(0, -7) : r.mediaType, bytes: new Uint8Array(Buffer.from(r.body, b64 ? "base64" : "utf8")) };
		},
		thread: async (runId, agentId, after, limit) => {
			const a = await scope(runId).getAgent({ agentId }).catch(() => null);
			if (!a) return null;
			return itemsAfter(runId, after, limit, agentId);
		},
		threadAfter: async (runId, after, limit) => itemsAfter(runId, after, limit).catch(() => []),
		threadHead: async (runId) => Number(await scope(runId).itemsHead().catch(() => 0)),
		workspaceFile: async (runId, agentId, path) => {
			const a = await scope(runId).getAgent({ agentId }).catch(() => null);
			if (!a) return null;
			const tip = workTips((await scope(runId).getEvents({ since: 0 }).catch(() => [])) as any).find((w) => w.agentId === agentId);
			if (!tip) return { error: "not_found", message: "the agent has no pushed work or checkpoint yet" };
			const cfg = await mergeConfigFor(runId).catch(() => null);
			if (!cfg) return { error: "unavailable", message: "no repository is configured for this run" };
			return mirrorFor({ remote: cfg.remote, target: cfg.target, workdir: cfg.workdir }).readFile(tip, path);
		},
		trace: async (runId) => {
			const p = tracePath(runId);
			if (!existsSync(p)) return [];
			return readFileSync(p, "utf8").split("\n").filter(Boolean).flatMap((l) => {
				try {
					const s = JSON.parse(l);
					return [{ traceId: s.traceId, spanId: s.spanId, parentSpanId: s.parentSpanId ?? null, name: s.name, start: isoTs(s.startTime), end: s.endTime ? isoTs(s.endTime) : null, status: Number(s.status?.code ?? 0), attributes: s.attributes ?? {} }];
				} catch { return []; }
			}).sort((a, b) => a.start.localeCompare(b.start));
		},
		skills: () => listSkills(),
		skill: (name) => readSkill(name),
		approvals: async (runId) => {
			const ops = (await scope(runId).listOps({ state: "awaiting_approval", kind: "merge" }).catch(() => [])) as any[];
			return ops.map((op): PendingApproval => ({
				approvalId: approvalIdFor(runId, op.id), kind: "merge", status: "pending", question: `Merge ${op.data.ref ?? "this work"} into ${op.data.target ?? "the target"}?`,
				requestedBy: { agentId: (op.data.agentId as string) ?? null, runId }, subject: { target: op.data.target ?? null, ref: op.data.ref ?? null }, expiresAt: null,
			}));
		},
		approval: async (approvalId) => {
			const id = parseApprovalId(approvalId);
			if (!id) return null;
			const op = (await scope(id.runId).getOp({ opId: id.opId }).catch(() => null)) as any;
			if (!op || op.kind !== "merge") return null;
			const pending = op.state === "awaiting_approval";
			const by = (op.data?.by ?? op.result?.by) as string | undefined;
			return { runId: id.runId, pending, decision: pending ? null : { approvalId, status: op.state === "denied" || op.data?.denied ? "denied" : "approved", decidedBy: by ? { clientId: by, principal: by } : null, decidedAt: op.updatedAt ? isoTs(op.updatedAt) : null, reason: null } };
		},
		decide: async (approvalId, approve, by, reason) => {
			const id = parseApprovalId(approvalId)!;
			await decideMerge(id.runId, id.opId, { approve, by, ...(reason ? { reason } : {}) });
		},
		createRun: async (input) => {
			const runId = generateRunId();
			const { repo } = await startDetachedRun({ ...input, runId });
			// What GET /v1/runs/{runId} shows once the run's process has registered it, but for the state.
			return { id: runId, projectId: projectIdOf(repo), label: input.goal, state: "starting", goal: input.goal, repo, createdAt: isoTs(Date.now()) };
		},
		// The repository verify and merge use for this run (its recorded settings, else the daemon's), and its target.
		repo: async (runId) => {
			const cfg = await mergeConfigFor(runId).catch(() => null);
			if (!cfg) return null;
			return { remote: cfg.remote, target: (await runTarget(runId).catch(() => undefined)) ?? cfg.target, workdir: cfg.workdir };
		},
		// The CLI's own paths (capcomd pause / resume / cancel / send), so the API changes state exactly as they do.
		control: async (runId, action, by, agentId) => {
			const who = agentId ? `${agentId} and its descendants have` : `${runId} has`;
			if (action === "pause") {
				const r = await pauseAgents(runId, agentId, by);
				return { changed: r.paused, pending: r.pausing, noop: r.paused.length || r.pausing.length ? null : `${who} no pending or running agent to pause` };
			}
			if (action === "resume") {
				// With an agent, nothing paused in its subtree is a conflict (the CLI's error), reported as the noop.
				const r = await resumeAgents(runId, agentId, by).catch((e) => { if ((e as { code?: string }).code === "conflict") return { resumed: [] as string[] }; throw e; });
				return { changed: r.resumed, pending: [], noop: r.resumed.length ? null : `${who} no paused agent to resume` };
			}
			const r = await cancelAny(runId, agentId, `cancelled by ${by}`);
			if (r.kind === "agents") return { changed: r.agents.cancelled, pending: [], noop: r.agents.cancelled.length ? null : `nothing to cancel in ${runId}: every agent has ended` };
			return { changed: r.agents?.cancelled ?? [], pending: [], noop: r.run.changed ? null : `${runId} is ${r.run.state}; nothing to cancel` };
		},
		send: async (runId, to, body, key, skills) => {
			const r = await sendToAgent(runId, { to, from: "operator", body, key, ...(skills?.length ? { skills } : {}) });
			return { seq: r.seq, note: r.note };
		},
	};
}
