// harness.v1 server (docs/harness-architecture.md §6-7): Hono app on the 0600 Unix socket. JSON routes are the oRPC
// contract (src/api/contract.ts) served by OpenAPIHandler; the SSE stream and the decision endpoint are native Hono
// routes because they need SSE framing, Last-Event-ID and Idempotency-Key. Every non-2xx body is ApiError {code, message}.
import { Hono, type Context } from "hono";
import { implement, ORPCError } from "@orpc/server";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { contract, StreamFrames, TRANSCRIPT_PAGE_MAX } from "./contract";
import { authenticate, loadClients, type AuthedClient, type ClientRecord, type ClientScope } from "./clients";
import { bodyHash, resolveDecide, type DecideBody, type StoredKey } from "./idempotency";
import { envelopes, messagesOf, type HarnessSource } from "./source";
import { isoTs } from "./envelope";

export const HEARTBEAT_MS = 15_000;
const STATUS_CODE: Record<number, string> = { 400: "invalid", 401: "unauthorized", 403: "forbidden", 404: "not_found", 409: "already_decided", 422: "invalid" };
const err = (c: Context, status: 401 | 403 | 404 | 409 | 422, code: string, message: string, extra: Record<string, unknown> = {}) => c.json({ code, message, ...extra }, status);

export type ServerOptions = { source: HarnessSource; clients?: () => ClientRecord[]; heartbeatMs?: number; pollMs?: number; snapshotSteps?: number };

export function harnessApp(o: ServerOptions) {
	const src = o.source;
	const clients = o.clients ?? (() => loadClients());
	const heartbeatMs = o.heartbeatMs ?? HEARTBEAT_MS;
	const pollMs = o.pollMs ?? 500;
	// (clientId, key) → stored outcome; approvalId → decision. In memory for phase 1 (lost on restart; the actor state is the truth).
	const keys = new Map<string, StoredKey>();
	const decisions = new Map<string, Record<string, unknown>>();

	const os = implement(contract).$context<{ client: AuthedClient }>();
	const nf = (what: string) => new ORPCError("NOT_FOUND", { message: `${what} not found` });
	const router = {
		health: os.health.handler(() => ({ ok: true as const, api: "harness.v1" as const, version: src.version })),
		projects: { list: os.projects.list.handler(() => src.projects()) },
		runs: {
			list: os.runs.list.handler(() => src.runs()),
			get: os.runs.get.handler(async ({ input }) => (await src.runs()).find((r) => r.id === input.runId) ?? (() => { throw nf(input.runId); })()),
			trace: os.runs.trace.handler(({ input }) => src.trace(input.runId)),
			messages: os.runs.messages.handler(async ({ input }) => messagesOf(await src.events(input.runId, 0)).filter((m) => m.seq > (input.after ?? 0))),
		},
		agents: {
			tree: os.agents.tree.handler(async ({ input }) => (await src.agents(input.runId)) ?? (() => { throw nf(input.runId); })()),
			transcript: os.agents.transcript.handler(async ({ input }) => {
				const limit = Math.min(input.limit ?? 200, TRANSCRIPT_PAGE_MAX);
				const items = await src.transcript(input.runId, input.agentId, input.after ?? 0, limit + 1);
				if (!items) throw nf(input.agentId);
				const page = items.slice(0, limit);
				return { items: page, next: items.length > limit ? page.at(-1)!.seq : null };
			}),
		},
		attachments: { get: os.attachments.get.handler(async ({ input }) => (await src.attachment(input.runId, input.attachmentId)) ?? (() => { throw nf(input.attachmentId); })()) },
		skills: { list: os.skills.list.handler(() => src.skills()) },
		events: {
			replay: os.events.replay.handler(async ({ input }) => {
				if (!input.scope.startsWith("run-")) return [];
				return envelopes(input.scope, await src.events(input.scope, 0)).filter((e) => e.seq > (input.after ?? 0));
			}),
		},
	};
	const rpc = new OpenAPIHandler(router);

	const app = new Hono<{ Variables: { client: AuthedClient } }>();
	app.use("*", async (c, next) => {
		if (c.req.method === "GET" && c.req.path === "/v1/health") return next();
		const cl = authenticate(c.req.header("authorization"), clients());
		if (!cl) return err(c, 401, "unauthorized", "missing or unknown bearer token (create one with `capcomd clients add`)");
		const need: ClientScope = c.req.method === "GET" ? "read" : c.req.path.startsWith("/v1/approvals/") ? "approve" : "steer";
		if (!cl.scopes.includes(need)) return err(c, 403, "forbidden", `token lacks the ${need} scope`);
		c.set("client", cl);
		return next();
	});

	app.post("/v1/approvals/:approvalId/decision", async (c) => {
		const approvalId = c.req.param("approvalId");
		const key = c.req.header("idempotency-key");
		if (!key || key.length < 8 || key.length > 200) return err(c, 422, "invalid", "Idempotency-Key header (8-200 chars) is required");
		const raw = await c.req.json().catch(() => null) as DecideBody | null;
		if (!raw || (raw.decision !== "approve" && raw.decision !== "deny") || (raw.reason !== undefined && typeof raw.reason !== "string")) return err(c, 422, "invalid", "body must be {decision: approve|deny, reason?}");
		const body: DecideBody = { decision: raw.decision, ...(raw.reason !== undefined ? { reason: raw.reason } : {}) };
		const client = c.get("client");
		const kid = `${client.clientId}\u0000${key}`;
		const where = await src.approval(approvalId);
		if (!where) return err(c, 404, "not_found", `approval ${approvalId} not found`);
		const existing = decisions.get(approvalId) ?? (where.pending ? null : where.decision ?? { approvalId, status: "approved", decidedBy: null, decidedAt: null, reason: null });
		const out = resolveDecide({ prior: keys.get(kid), approvalId, body, existingDecision: existing });
		if (out.kind === "replay") return c.json(out.result as object, out.status as 200);
		if (out.kind === "error") return err(c, 409, out.code, out.code === "already_decided" ? "approval already decided" : "Idempotency-Key reused with a different body", out.existing ? { decision: out.existing } : {});
		await src.decide(approvalId, body.decision === "approve", `client:${client.clientId}`, body.reason);
		const decision = { approvalId, status: body.decision === "approve" ? "approved" : "denied", decidedBy: { clientId: client.clientId, principal: client.name }, decidedAt: isoTs(Date.now()), reason: body.reason ?? null };
		decisions.set(approvalId, decision);
		keys.set(kid, { approvalId, bodyHash: bodyHash(approvalId, body), status: 200, result: decision });
		return c.json(decision, 200);
	});

	app.get("/v1/streams/:scope/events", (c) => {
		const scope = c.req.param("scope");
		if (!/^(daemon|prj-[A-Za-z0-9_-]+|run-[A-Za-z0-9_-]+)$/.test(scope)) return err(c, 422, "invalid", "scope is daemon, prj-<id> or run-<id>");
		const lastRaw = c.req.header("last-event-id");
		const last = lastRaw && /^\d+$/.test(lastRaw) ? Number(lastRaw) : null;
		const enc = new TextEncoder();
		let timer: ReturnType<typeof setInterval> | undefined, hb: ReturnType<typeof setInterval> | undefined, closed = false;
		const stream = new ReadableStream<Uint8Array>({
			start: async (ctl) => {
				const send = (event: string, data: unknown, id?: number) => { if (!closed) ctl.enqueue(enc.encode(`${id !== undefined ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); };
				const frame = (name: keyof typeof StreamFrames, data: unknown, id?: number) => send(name, data, id);
				hb = setInterval(() => { if (!closed) ctl.enqueue(enc.encode(": heartbeat\n\n")); }, heartbeatMs);
				ctl.enqueue(enc.encode(": connected\n\n"));
				if (!scope.startsWith("run-")) {
					// daemon and project scopes: run.created per run, in creation order; seq is the position.
					let seen = last ?? 0;
					const tick = async () => {
						const runs = [...await src.runs()].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
						runs.forEach((r, i) => {
							if (i + 1 <= seen || (scope.startsWith("prj-") && r.projectId !== scope)) return;
							send("run.created", { v: 1, id: `evt_${scope}_${i + 1}`, scope, seq: i + 1, entity: r.id, entitySeq: 1, type: "run.created", typeVersion: 1, durability: "durable", ts: r.createdAt ?? isoTs(Date.now()), epochMs: r.createdAt ? Date.parse(r.createdAt) : Date.now(), projectId: r.projectId, runId: r.id, agentId: null, text: "Run created.", data: { label: r.label, goal: r.goal, budget: null } }, i + 1);
						});
						seen = Math.max(seen, runs.length);
					};
					await tick();
					timer = setInterval(() => { tick().catch(() => {}); }, pollMs);
					return;
				}
				const runId = scope;
				const all = await src.events(runId, 0);
				const head = all.at(-1)?.seq ?? 0;
				let cursor: number;
				if (last !== null && last <= head) {
					cursor = last;
				} else {
					// Fresh connect, or a cursor this daemon never issued (store reset): snapshot, then live from snapshotSeq+1.
					if (last !== null) frame("stream.reset", { snapshotSeq: head, reason: "compacted" });
					const run = (await src.runs()).find((r) => r.id === runId) ?? null;
					if (run) frame("snapshot.run", { run });
					frame("snapshot.agents", { agents: (await src.agents(runId)) ?? [] });
					frame("snapshot.approvals", { approvals: await src.approvals(runId) });
					frame("snapshot.steps", { steps: envelopes(runId, all).slice(-(o.snapshotSteps ?? 200)) });
					frame("snapshot.threads", { messages: messagesOf(all).slice(-200) });
					frame("snapshot.end", { snapshotSeq: head }, head);
					cursor = head;
				}
				const counts = new Map<string, number>();
				for (const e of all) if (e.seq <= cursor) counts.set(e.agentId ?? runId, (counts.get(e.agentId ?? runId) ?? 0) + 1);
				let busy = false;
				const tick = async () => {
					if (busy || closed) return;
					busy = true;
					try {
						for (const e of await src.events(runId, cursor)) {
							const k = e.agentId ?? runId; const n = (counts.get(k) ?? 0) + 1; counts.set(k, n);
							const env = envelopes(runId, [e])[0]!; env.entitySeq = n;
							send(env.type, env, e.seq);
							cursor = e.seq;
						}
					} finally { busy = false; }
				};
				await tick();
				timer = setInterval(() => { tick().catch(() => {}); }, pollMs);
			},
			cancel: () => { closed = true; clearInterval(timer); clearInterval(hb); },
		});
		c.req.raw.signal?.addEventListener?.("abort", () => { closed = true; clearInterval(timer); clearInterval(hb); });
		return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } });
	});

	app.all("*", async (c) => {
		const { matched, response } = await rpc.handle(c.req.raw, { context: { client: c.get("client") } });
		if (!matched || !response) return err(c, 404, "not_found", `${c.req.method} ${c.req.path}`);
		if (response.ok) return response;
		const b = await response.json().catch(() => ({})) as { message?: string };
		const status = response.status === 400 ? 422 : response.status in STATUS_CODE ? response.status : 500;
		return c.json({ code: STATUS_CODE[status] ?? "internal", message: b.message ?? response.statusText }, status as 404);
	});
	return app;
}
