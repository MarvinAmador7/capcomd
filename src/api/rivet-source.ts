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
import { approvalIdFor, mergeApprovalText, parseApprovalId, projectIdOf, type HarnessSource, type PendingApproval } from "./source";
import { startDetachedRun } from "./create-run";
import { workspaceOf } from "./workspace";
import { mirrorFor, workTips } from "./run-files";
import { RUN_REPO_KV } from "../merge/run-config";
import { sandboxSurface, taskLine, type MachineOwner } from "./sandboxes";
import { MACHINE_PREFIX, type SandboxProvider } from "../providers/sandbox";
import { sandboxName, type ListedProvider } from "../providers/registry";
import { jobOwnerText, liveJobMachines } from "../providers/machines";
import { fileSettingsStore, settingsPath } from "../providers/settings";

const lower = (p: string | null) => (p ? p.toLowerCase() : null);
const cap = (t: string) => (Buffer.byteLength(t) <= INLINE_TEXT_MAX_BYTES ? t : Buffer.from(t).subarray(0, INLINE_TEXT_MAX_BYTES).toString("utf8").replace(/\uFFFD+$/, ""));
const scope = (runId: string) => client().scope.getOrCreate([runId]);
/** A run's scope only when it already exists: reading a run's log must never create an empty scope actor (a stream
 * probing hundreds of runs this engine never had created hundreds of actors). A missing scope reads as no events. */
const existingScope = (runId: string) => (client().scope as any).get([runId]) as ReturnType<typeof scope>;
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
export function agentRuntime(spec: unknown): { provider: "claude" | "codex" | null; model: string | null; effort: string | null } {
	const s = (spec && typeof spec === "object" ? spec : {}) as Record<string, unknown>;
	if (s.kind === "fake") return { provider: null, model: null, effort: null };
	const provider = s.provider === "claude" || s.provider === "codex" ? s.provider : s.kind === "claude-code" ? "claude" : s.kind === "codex" ? "codex" : null;
	const str = (v: unknown) => (provider && typeof v === "string" && v ? v : null);
	return { provider, model: str(s.model), effort: str(s.effort) };
}

const LIVE = new Set(["pending", "running", "paused"]);
/**
 * The machines capcomd's live agents hold now (ADR-021 §3), from capcomd's own records: each pending, running or
 * paused agent of the recent runs whose worker actor holds a VM that isn't destroyed. Never from provider labels.
 * Reads existing actors only (a missing scope or worker is skipped, never created).
 */
export async function machineOwners(limit = 500): Promise<MachineOwner[]> {
	const { vmNameFor } = await import("../providers/boxd");
	let daemon: string | null = null;
	try { daemon = sandboxName(); } catch { /* unknown CAPCOMD_SANDBOX */ }
	const perRun = await Promise.all(recentRuns(limit).map(async (r) => {
		const agents = (await existingScope(r.runId).listAgents({}).catch(() => [])) as any[];
		const live = agents.filter((a) => LIVE.has(a.status));
		const rows = await Promise.all(live.map(async (a): Promise<MachineOwner | null> => {
			const epoch = Number(a.epoch ?? 1);
			const w = (client().worker as any).get(epoch > 1 ? [r.runId, a.agentId, `e${epoch}`] : [r.runId, a.agentId]);
			const wk = await w.getWorker({ workerId: a.agentId }).catch(() => null);
			const ctx = wk?.context ?? {};
			if (!wk || wk.state === "destroyed" || wk.state === "failed" || typeof ctx.vmId !== "string" || !ctx.vmId) return null;
			const sandbox = typeof ctx.sandbox === "string" && ctx.sandbox ? ctx.sandbox : daemon;
			if (!sandbox) return null;
			return {
				sandbox, vmId: ctx.vmId, name: typeof ctx.idemKey === "string" ? vmNameFor(ctx.idemKey, MACHINE_PREFIX) : null,
				runId: r.runId, agentId: a.agentId, role: lower(a.profile ?? null), task: taskLine(a.task),
				workerState: String(wk.state), createdAt: Number.isFinite(Number(ctx.createdAt)) ? Number(ctx.createdAt) : null,
			};
		}));
		return rows.filter((x): x is MachineOwner => !!x);
	}));
	return [...perRun.flat(), ...jobOwners()];
}

/** Machines capcomd's own jobs hold now (checks, logins, environment builds): the machines ledger, never provider labels. */
export function jobOwners(env: Record<string, string | undefined> = process.env): MachineOwner[] {
	return liveJobMachines(env).map((m) => ({
		sandbox: m.sandbox, vmId: null, name: m.name, kind: m.kind, runId: m.runId, agentId: null, task: null,
		...jobOwnerText(m), workerState: "busy", createdAt: m.createdAt,
	}));
}

// One list-only provider per place: the daemon's own (getDependencies) for its sandbox; for another, a provider made
// once here (a DockerProvider has no side effects; boxd shares the daemon's per-sandbox one).
const listers = new Map<string, SandboxProvider>();
async function lister(name: ListedProvider): Promise<SandboxProvider> {
	let p = listers.get(name);
	if (p) return p;
	const deps = await import("../dependencies");
	if (name === "docker" && sandboxName() !== "docker") p = new (await import("../providers/docker")).DockerProvider();
	else p = deps.providerNamed(name);
	listers.set(name, p);
	return p;
}

export function rivetSource(): HarnessSource {
	const runsIndex = () => recentRuns(500);
	const runs = async () => Promise.all(runsIndex().map(async (r) => {
		const meta = (await scope(r.runId).getScope({}).catch(() => null)) as { goal?: string | null; ended?: { state: string } | null } | null;
		const agents = meta ? await scope(r.runId).listAgents({}).catch(() => []) : [];
		const live = (agents as Array<{ status: string }>).some((a) => a.status === "running" || a.status === "pending" || a.status === "paused");
		// A run that ended by itself (it couldn't start its planner, or was stopped before any agent ran): failed / cancelled.
		return { id: r.runId, projectId: projectIdOf(r.repo), label: r.label, state: !meta ? "unknown" : live ? "running" : meta.ended ? meta.ended.state : agents.length ? "idle" : "new", goal: meta?.goal ?? null, repo: r.repo, createdAt: isoTs(r.createdAt) };
	}));
	const surface = sandboxSurface({
		// The user config (~/.capcomd/config.json `sandboxes`); off with CAPCOMD_NO_CONFIG.
		settings: fileSettingsStore(settingsPath()),
		logins: async () => (await import("./settings")).logins(),
		availability: async (name) => {
			const { sandboxAvailable } = await import("./run-options");
			let current: string | null = null;
			try { current = sandboxName(); } catch { /* unknown CAPCOMD_SANDBOX: no default */ }
			return { ...(await sandboxAvailable(name)), default: current === name };
		},
		list: async (name) => (await lister(name)).list(MACHINE_PREFIX),
		owners: () => machineOwners(),
	});
	return {
		version: VERSION,
		...surface,
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
		events: async (runId, after) => (await existingScope(runId).getEvents({ since: after }).catch(() => [])) as any,
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
		runOptions: async (repo) => (await import("./run-options")).runOptionsFor(repo),
		skill: (name) => readSkill(name),
		logins: async () => (await import("./settings")).logins(),
		environments: async () => (await import("./settings")).environments(),
		service: async () => (await import("./settings")).serviceState(),
		approvals: async (runId) => {
			const ops = (await scope(runId).listOps({ state: "awaiting_approval", kind: "merge" }).catch(() => [])) as any[];
			return ops.map((op): PendingApproval => {
				const text = mergeApprovalText(op.data);
				return { approvalId: approvalIdFor(runId, op.id), kind: "merge", status: "pending", question: text.question,
					requestedBy: { agentId: (op.data.agentId as string) ?? null, runId }, subject: text.subject, expiresAt: null };
			});
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
			const r = await cancelAny(runId, agentId, `cancelled by ${by}`, by);
			// A run that hadn't ended is cancelled even with no agent left to stop (runEnded): only an ended run is the noop.
			if (r.kind === "agents") return { changed: r.agents.cancelled, pending: [], noop: r.agents.cancelled.length || r.agents.runEnded ? null : agentId ? `nothing to cancel in ${runId}: every agent has ended` : `nothing to cancel: ${runId} has ended` };
			return { changed: r.agents?.cancelled ?? [], pending: [], noop: r.run.changed ? null : `${runId} is ${r.run.state}; nothing to cancel` };
		},
		send: async (runId, to, body, key, skills) => {
			const r = await sendToAgent(runId, { to, from: "operator", body, key, ...(skills?.length ? { skills } : {}) });
			return { seq: r.seq, note: r.note };
		},
	};
}
