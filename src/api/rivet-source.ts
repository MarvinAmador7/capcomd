// HarnessSource over the Rivet scope actors: what `capcomd serve` exposes on the harness socket.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { client } from "../core/relay";
import { recentRuns, decideMerge } from "../primitives/ops";
import { tracePath } from "../utils/tracing-simple";
import { VERSION } from "../utils/self";
import { isoTs } from "./envelope";
import { describeEvent } from "./describe";
import { inlineOrAttach, INLINE_TEXT_MAX_BYTES } from "./inline-cap";
import { approvalIdFor, parseApprovalId, type HarnessSource, type PendingApproval } from "./source";

const projectIdOf = (repo: string | null) => (repo ? `prj-${createHash("sha256").update(repo).digest("hex").slice(0, 12)}` : null);
const lower = (p: string | null) => (p ? p.toLowerCase() : null);
const cap = (t: string) => (Buffer.byteLength(t) <= INLINE_TEXT_MAX_BYTES ? t : Buffer.from(t).subarray(0, INLINE_TEXT_MAX_BYTES).toString("utf8").replace(/\uFFFD+$/, ""));
const scope = (runId: string) => client().scope.getOrCreate([runId]);

function frontmatter(md: string): { name?: string; description?: string } {
	const m = /^---\n([\s\S]*?)\n---/.exec(md);
	const out: Record<string, string> = {};
	for (const l of (m?.[1] ?? "").split("\n")) { const k = /^(name|description):\s*(.*)$/.exec(l); if (k) out[k[1]!] = k[2]!.replace(/^["']|["']$/g, ""); }
	return out;
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
			return all.map((a) => {
				const inl = inlineOrAttach(String(a.task ?? ""));
				return {
					id: a.agentId, runId, parent: a.parent, depth: a.depth, profile: lower(a.profile), status: a.status,
					text: describeEvent("agent.status_changed", { status: a.status }, a.agentId),
					task: inl.text, taskAttachment: inl.attachment, result: a.result ?? null, updatedAt: a.updatedAt ? isoTs(a.updatedAt) : null,
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
			return r ? { attachment: { id: r.id, bytes: r.bytes, sha256: r.sha256, mediaType: r.mediaType }, text: r.body } : null;
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
		skills: async () => {
			const out: Array<{ name: string; description: string; source: "bundled" | "user" }> = [];
			const { ORCHESTRATION_SKILL } = await import("../utils/assets");
			const bundled = [ORCHESTRATION_SKILL];
			for (const md of bundled) { const f = frontmatter(md); if (f.name) out.push({ name: f.name.toLowerCase(), description: f.description ?? "", source: "bundled" }); }
			const dir = join(homedir(), ".claude", "skills");
			if (existsSync(dir)) for (const d of readdirSync(dir)) {
				const p = join(dir, d, "SKILL.md");
				if (!existsSync(p)) continue;
				const f = frontmatter(readFileSync(p, "utf8"));
				const name = (f.name ?? d).toLowerCase();
				if (/^[a-z0-9][a-z0-9._-]*$/.test(name) && !out.some((s) => s.name === name)) out.push({ name, description: f.description ?? "", source: "user" });
			}
			return out;
		},
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
	};
}
