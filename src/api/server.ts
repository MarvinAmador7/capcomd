// harness.v1 server (docs/harness-architecture.md §6-7): Hono app on the 0600 Unix socket. JSON routes are the oRPC
// contract (src/api/contract.ts) served by OpenAPIHandler; the SSE stream and the write routes (decision, runs.create,
// run controls, messages) are native Hono routes because they need SSE framing, Last-Event-ID and Idempotency-Key.
// Every non-2xx body is ApiError {code, message}.
import { Hono, type Context } from "hono";
import { implement, ORPCError } from "@orpc/server";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { CAPABILITY_NAMES, contract, CreateRunBody, MESSAGE_BODY_MAX_BYTES, StreamFrames, THREAD_PAGE_MAX, TRANSCRIPT_PAGE_MAX } from "./contract";
import { resolveSkills } from "../agents/skills";
import { mediaOfPath, sniffImage, workspacePath } from "../../packages/agent-thread/src/index";
import { authenticate, loadClients, type AuthedClient, type ClientRecord, type ClientScope } from "./clients";
import { bodyHash, resolveDecide, type DecideBody } from "./idempotency";
import { CreateRunError, envelopes, messagesOf, type CreateRunInput, type HarnessSource } from "./source";
import { isoTs } from "./envelope";
import { lifecycleEvents } from "./lifecycle";
import { harnessState, type DaemonEvent, type HarnessState } from "./state";
import { parseSettingsPatch } from "./sandboxes";
import { runFiles } from "./run-files";
import { isListedProvider, PROVIDER_LABEL } from "../providers/registry";
import { resourceActionEvent, resourceDeletedEvent } from "../providers/machine-audit";

export const HEARTBEAT_MS = 15_000;

/** What a raw-bytes route serves a file as (see the routes). */
export function servedType(bytes: Uint8Array, hint: string | null): { type: string; inline: boolean } {
	const img = sniffImage(bytes);
	if (img) return { type: img, inline: true };
	if (hint && /^(video|audio)\//.test(hint)) return { type: hint, inline: true };
	const text = bytes.length <= 5 * 1024 * 1024 && !bytes.includes(0) ? new TextDecoder("utf-8", { fatal: true }) : null;
	try { if (text) { text.decode(bytes); return { type: "text/plain; charset=utf-8", inline: true }; } } catch { /* not UTF-8 */ }
	return { type: "application/octet-stream", inline: false };
}
const STATUS_CODE: Record<number, string> = { 400: "invalid", 401: "unauthorized", 403: "forbidden", 404: "not_found", 409: "already_decided", 422: "invalid" };
const err = (c: Context, status: 401 | 403 | 404 | 409 | 422 | 503, code: string, message: string, extra: Record<string, unknown> = {}) => c.json({ code, message, ...extra }, status);

/** agent.activity_changed: at most one frame per agent per this many ms (ACTIVITY_DOC). */
export const ACTIVITY_MS = 1000;
/** agent.thread_item_changed: the thread is polled at most this often, latest rev per item (at most four frames per item per second). */
export const THREAD_MS = 250;
/** GET …/thread: a page stops at about this many bytes of items (`next` says where to go on). */
export const THREAD_PAGE_MAX_BYTES = 4 * 1024 * 1024;
export type ServerOptions = { source: HarnessSource; clients?: () => ClientRecord[]; heartbeatMs?: number; pollMs?: number; activityMs?: number; threadMs?: number; snapshotSteps?: number; state?: HarnessState };

export function harnessApp(o: ServerOptions) {
	const src = o.source;
	const clients = o.clients ?? (() => loadClients());
	const heartbeatMs = o.heartbeatMs ?? HEARTBEAT_MS;
	const pollMs = o.pollMs ?? 500;
	const activityMs = o.activityMs ?? ACTIVITY_MS;
	const threadMs = o.threadMs ?? THREAD_MS;
	// (clientId, key) → stored outcome and approvalId → decision, persisted so a retry after restart replays.
	const state = o.state ?? harnessState();
	// approvalId → in-flight decision; claimed synchronously before any await so concurrent requests cannot both decide.
	const inflight = new Map<string, { kid: string; hash: string; done: Promise<Record<string, unknown> | null> }>();
	// runs.create: (clientId, key) → in-flight start.
	type Outcome = { status: number; body: object };
	const creating = new Map<string, { hash: string; done: Promise<Outcome> }>();
	// Daemon/project streams: known runs missing from the list whose log was already read for run.deleted. Each is read
	// once per daemon (again only after it is listed and then missing again), never on every 500ms tick: a state file
	// holding hundreds of runs this daemon doesn't list (another ledger's) turned every tick into hundreds of actor calls.
	const deletionChecked = new Set<string>();

	/** A daemon-scope event (state.recordDaemonEvent) as the stream and GET /v1/events?scope=daemon send it. */
	const daemonEnvelope = (e: DaemonEvent) => ({
		v: 1 as const, id: `evt_daemon_${e.seq}`, scope: "daemon", seq: e.seq, entity: e.entity, entitySeq: e.entitySeq, type: e.type, typeVersion: 1,
		durability: "durable" as const, ts: isoTs(e.at), epochMs: e.at, projectId: null, runId: null, agentId: null, text: e.text, data: e.data,
	});
	const os = implement(contract).$context<{ client: AuthedClient }>();
	const nf = (what: string) => new ORPCError("NOT_FOUND", { message: `${what} not found` });
	const router = {
		health: os.health.handler(() => ({ ok: true as const, api: "harness.v1" as const, version: src.version, capabilities: [...CAPABILITY_NAMES] })),
		projects: { list: os.projects.list.handler(() => src.projects()) },
		runs: {
			list: os.runs.list.handler(() => src.runs()),
			get: os.runs.get.handler(async ({ input }) => (await src.runs()).find((r) => r.id === input.runId) ?? (() => { throw nf(input.runId); })()),
			trace: os.runs.trace.handler(({ input }) => src.trace(input.runId)),
			messages: os.runs.messages.handler(async ({ input }) => messagesOf(await src.events(input.runId, 0)).filter((m) => m.seq > (input.after ?? 0))),
			lifecycle: os.runs.lifecycle.handler(async ({ input }) => {
				if ((await src.agents(input.runId)) === null) throw nf(input.runId);
				return lifecycleEvents(input.runId, await src.events(input.runId, 0)).filter((e) => e.seq > (input.after ?? 0));
			}),
			files: os.runs.files.handler(async ({ input }) => {
				const agents = await src.agents(input.runId);
				if (agents === null) throw nf(input.runId);
				if (input.agentId && !agents.some((a) => a.id === input.agentId)) throw nf(input.agentId);
				const [events, repo] = await Promise.all([src.events(input.runId, 0), src.repo(input.runId)]);
				return runFiles({ runId: input.runId, events, repo, ...(input.agentId ? { agentId: input.agentId } : {}), ...(input.limit ? { limit: input.limit } : {}) });
			}),
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
			thread: os.agents.thread.handler(async ({ input }) => {
				const limit = Math.min(input.limit ?? 200, THREAD_PAGE_MAX);
				const items = await src.thread(input.runId, input.agentId, input.after ?? 0, limit + 1);
				if (!items) throw nf(input.agentId);
				// At most `limit` items and about THREAD_PAGE_MAX_BYTES of them (always at least one).
				const page: typeof items = [];
				let bytes = 0;
				for (const it of items.slice(0, limit)) {
					const n = Buffer.byteLength(JSON.stringify(it));
					if (page.length && bytes + n > THREAD_PAGE_MAX_BYTES) break;
					page.push(it); bytes += n;
				}
				return { items: page, next: items.length > page.length ? page.at(-1)!.seq : null };
			}),
			// Raw bytes: served by the native route below (this handler is never reached).
			workspace: os.agents.workspace.handler(() => { throw new ORPCError("NOT_FOUND", { message: "served natively" }); }),
		},
		attachments: {
			get: os.attachments.get.handler(async ({ input }) => (await src.attachment(input.runId, input.attachmentId)) ?? (() => { throw nf(input.attachmentId); })()),
			content: os.attachments.content.handler(() => { throw new ORPCError("NOT_FOUND", { message: "served natively" }); }),
		},
		runOptions: { get: os.runOptions.get.handler(async ({ input }) => {
			try { return await src.runOptions(input.repo); } catch (e) {
				if (e instanceof CreateRunError) throw new ORPCError("UNPROCESSABLE_CONTENT", { message: e.message });
				throw e;
			}
		}) },
		skills: { list: os.skills.list.handler(() => src.skills()) },
		// ?sandbox= (capability sandboxes): one place's rows; a name that isn't a listed place is 404.
		logins: { list: os.logins.list.handler(async ({ input }) => {
			if (input.sandbox !== undefined && !isListedProvider(input.sandbox)) throw nf(`sandbox ${input.sandbox.slice(0, 64)}`);
			return { logins: (await src.logins()).filter((l) => input.sandbox === undefined || l.sandbox === input.sandbox) };
		}) },
		environments: { list: os.environments.list.handler(async ({ input }) => {
			if (input.sandbox !== undefined && !isListedProvider(input.sandbox)) throw nf(`sandbox ${input.sandbox.slice(0, 64)}`);
			return { environments: (await src.environments()).filter((e) => input.sandbox === undefined || e.sandbox === input.sandbox) };
		}) },
		// ADR-021 (capabilities sandboxes, sandboxes.resources). Unlisted providers (the test fakes) are 404 like unknown ones.
		sandboxes: {
			list: os.sandboxes.list.handler(async () => ({ sandboxes: await src.sandboxes() })),
			get: os.sandboxes.get.handler(async ({ input }) => (await src.sandbox(input.name)) ?? (() => { throw nf(`sandbox ${input.name.slice(0, 64)}`); })()),
			resources: os.sandboxes.resources.handler(async ({ input }) => (await src.sandboxResources(input.name, { ...(input.limit ? { limit: input.limit } : {}), ...(input.cursor ? { cursor: input.cursor } : {}) })) ?? (() => { throw nf(`sandbox ${input.name.slice(0, 64)}`); })()),
			resource: os.sandboxes.resource.handler(async ({ input }) => {
				if (!isListedProvider(input.name)) throw nf(`sandbox ${input.name.slice(0, 64)}`);
				return (await src.sandboxResource(input.name, input.id)) ?? (() => { throw nf(`resource ${input.id.slice(0, 128)}`); })();
			}),
		},
		service: { get: os.service.get.handler(() => src.service()) },
		events: {
			replay: os.events.replay.handler(async ({ input }) => {
				if (input.scope === "daemon") return state.daemonEvents(input.after ?? 0).map(daemonEnvelope);
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
		// PATCH changes settings (capability sandboxes.settings): the configure scope, which steering a run doesn't give.
		const need: ClientScope = c.req.method === "GET" ? "read" : c.req.method === "PATCH" ? "configure" : c.req.path.startsWith("/v1/approvals/") ? "approve" : "steer";
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
		const hash = bodyHash(approvalId, body);
		const conflict = (existing?: unknown) => err(c, 409, "already_decided", "approval already decided", existing ? { decision: existing } : {});
		const pend = inflight.get(approvalId);
		if (pend) {
			if (pend.kid !== kid) return conflict();
			if (pend.hash !== hash) return err(c, 409, "idempotency_conflict", "Idempotency-Key reused with a different body");
			const r = await pend.done;
			return r ? c.json(r, 200) : err(c, 409, "already_decided", "approval decision failed; retry");
		}
		const prior = state.key(kid);
		if (!prior && !state.decision(approvalId)) {
			// claim before the first await
			let resolve!: (v: Record<string, unknown> | null) => void;
			const done = new Promise<Record<string, unknown> | null>((r) => (resolve = r));
			inflight.set(approvalId, { kid, hash, done });
			try {
				const where = await src.approval(approvalId);
				if (!where) { resolve(null); return err(c, 404, "not_found", `approval ${approvalId} not found`); }
				if (!where.pending) { resolve(null); return conflict(where.decision ?? { approvalId, status: "approved", decidedBy: null, decidedAt: null, reason: null }); }
				await src.decide(approvalId, body.decision === "approve", `client:${client.clientId}`, body.reason);
				const decision = { approvalId, status: body.decision === "approve" ? "approved" : "denied", decidedBy: { clientId: client.clientId, principal: client.name }, decidedAt: isoTs(Date.now()), reason: body.reason ?? null };
				state.recordDecision(kid, { approvalId, bodyHash: hash, status: 200, result: decision }, decision);
				resolve(decision);
				return c.json(decision, 200);
			} catch (e) { resolve(null); throw e; } finally { inflight.delete(approvalId); }
		}
		const where = prior ? true : await src.approval(approvalId);
		if (!where) return err(c, 404, "not_found", `approval ${approvalId} not found`);
		const out = resolveDecide({ prior, approvalId, body, existingDecision: state.decision(approvalId) ?? null });
		if (out.kind === "replay") return c.json(out.result as object, out.status as 200);
		if (out.kind === "error") return err(c, 409, out.code, out.code === "already_decided" ? "approval already decided" : "Idempotency-Key reused with a different body", out.existing ? { decision: out.existing } : {});
		return conflict();
	});

	// runs.create: start a run (always detached). Keys are scoped to (clientId, procedure) (§7.4); only a started run is
	// recorded, so a request that failed can be retried with the same key.
	app.post("/v1/runs", async (c) => {
		const key = c.req.header("idempotency-key");
		if (!key || key.length < 8 || key.length > 200) return err(c, 422, "invalid", "Idempotency-Key header (8-200 chars) is required");
		const parsed = CreateRunBody.safeParse(await c.req.json().catch(() => undefined));
		if (!parsed.success) {
			const i = parsed.error.issues[0];
			return err(c, 422, "invalid", i?.path.length ? `${i.path.join(".")}: ${i.message}` : "body must be a JSON object {goal, repo?, profile?, targetBranch?, driver?, effort?, sandbox?}");
		}
		const p = parsed.data;
		if (p.profile !== undefined && p.driver !== undefined) return err(c, 422, "invalid", "profile and driver can't be combined: driver runs the project's planner agent, which picks its own workers; send one of them");
		if (p.profile !== undefined && p.effort !== undefined) return err(c, 422, "invalid", "profile and effort can't be combined: effort is the planner agent's (the driver's), and profile picks the worker of a run without one");
		if (p.effort !== undefined || p.sandbox !== undefined) {
			// GET /v1/run-options for this run (the body's project, when it names one): the chosen driver, else the default.
			let drivers;
			try { drivers = (await src.runOptions(p.repo)).drivers; } catch (e) {
				if (e instanceof CreateRunError) return err(c, 422, "invalid", e.message);
				throw e;
			}
			const d = p.driver !== undefined ? drivers.find((x) => x.provider === p.driver) : drivers.find((x) => x.default);
			if (p.effort !== undefined) {
				if (!d) return err(c, 422, "invalid", `effort needs a driver: ${p.repo !== undefined ? "this project" : "this daemon"} has no default planner profile (run capcomd setup), so send driver too`);
				if (!d.efforts.includes(p.effort)) return err(c, 422, "invalid", d.efforts.length ? `effort ${JSON.stringify(p.effort)} isn't a ${d.label} level: use one of ${d.efforts.join(", ")}` : `${d.label}'s effort can't be set`);
			}
			// Logins and agent environments are per sandbox: a driver that can't run in the chosen one is refused now, not
			// minutes later (capability runs.options.sandbox).
			const fit = p.sandbox !== undefined ? d?.sandboxes?.[p.sandbox] : undefined;
			if (fit && !fit.available) return err(c, 422, "invalid", `${d!.label} can't drive a run in ${PROVIDER_LABEL[p.sandbox as keyof typeof PROVIDER_LABEL] ?? p.sandbox}: ${fit.reason ?? "unavailable"}`);
		}
		const input: CreateRunInput = { goal: p.goal.trim(), ...(p.repo !== undefined ? { repo: p.repo } : {}), ...(p.profile !== undefined ? { profile: p.profile } : {}), ...(p.targetBranch !== undefined ? { targetBranch: p.targetBranch } : {}), ...(p.driver !== undefined ? { driver: p.driver } : {}), ...(p.effort !== undefined ? { effort: p.effort } : {}), ...(p.sandbox !== undefined ? { sandbox: p.sandbox as NonNullable<CreateRunInput["sandbox"]> } : {}) };
		const kid = `${c.get("client").clientId}\u0000runs.create\u0000${key}`;
		// driver and sandbox are part of the body (another value: idempotency_conflict); a request without them hashes as
		// before they existed, so a retry across the upgrade still replays.
		const hash = JSON.stringify(["runs.create", input.goal, input.repo ?? null, input.profile ?? null, input.targetBranch ?? null, ...(input.driver || input.sandbox || input.effort ? [input.driver ?? null, input.sandbox ?? null, ...(input.effort ? [input.effort] : [])] : [])]);
		const conflict = () => err(c, 409, "idempotency_conflict", "Idempotency-Key reused with a different body");
		const replay = (r: Outcome) => c.json(r.body, r.status as 201, r.status === 201 ? { "idempotent-replayed": "true" } : {});
		const prior = state.key(kid);
		if (prior) return prior.bodyHash === hash ? replay({ status: prior.status, body: prior.result as object }) : conflict();
		const pend = creating.get(kid);
		if (pend) return pend.hash === hash ? replay(await pend.done) : conflict();
		// claim before the first await: a concurrent retry with this key waits for this outcome instead of starting a second run
		let resolve!: (o: Outcome) => void;
		creating.set(kid, { hash, done: new Promise<Outcome>((r) => (resolve = r)) });
		try {
			const run = await src.createRun(input);
			state.recordKey(kid, { runId: run.id, bodyHash: hash, status: 201, result: run });
			resolve({ status: 201, body: run });
			return c.json(run, 201);
		} catch (e) {
			const out: Outcome = e instanceof CreateRunError ? { status: 422, body: { code: "invalid", message: e.message } } : { status: 500, body: { code: "internal", message: (e as Error).message } };
			resolve(out);
			return c.json(out.body, out.status as 422);
		} finally { creating.delete(kid); }
	});

	// Raw bytes for thread media (contract: attachments.content, agents.workspace). The type comes from the bytes, never
	// from the agent: images by signature, video/audio by extension, UTF-8 text as text/plain, the rest a download.
	// Never HTML or svg; nosniff, and a CSP that runs nothing if a browser opens it anyway.
	const raw = (bytes: Uint8Array, hint: string | null) => {
		const t = servedType(bytes, hint);
		return new Response(bytes, { headers: { "content-type": t.type, "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox", "content-disposition": t.inline ? "inline" : "attachment", "cache-control": "private, no-store" } });
	};
	app.get("/v1/runs/:runId/attachments/:attachmentId/content", async (c) => {
		const id = c.req.param("attachmentId");
		if (!/^att-[0-9a-f]+$/.test(id)) return err(c, 422, "invalid", "attachmentId is att-<hex>");
		const a = await src.attachmentContent(c.req.param("runId"), id);
		return a ? raw(a.bytes, a.mime) : err(c, 404, "not_found", `${id} not found`);
	});
	app.get("/v1/runs/:runId/agents/:agentId/workspace", async (c) => {
		const asked = c.req.query("path") ?? "";
		const path = workspacePath(asked);
		if (!path || path !== asked) return err(c, 422, "invalid", "path must be relative to the repository root, '/'-separated and normalized (no .., no .git)");
		const f = await src.workspaceFile(c.req.param("runId"), c.req.param("agentId"), path);
		if (!f) return err(c, 404, "not_found", `${c.req.param("agentId")} not found`);
		if ("error" in f) return err(c, f.error === "too_large" ? 422 : 404, f.error === "too_large" ? "invalid" : "not_found", f.message);
		return raw(f.bytes, mediaOfPath(path)?.mime ?? null);
	});

	// Run controls and steer messages (steer scope). Same Idempotency-Key rules as decisions: the key is scoped to the
	// client; the same key + same request replays the first 200; the same key on another request is idempotency_conflict.
	// Only a 200 is stored: an error changed nothing, so a retry looks again. Concurrent duplicates share one apply.
	const writing = new Map<string, { hash: string; done: Promise<Outcome> }>();
	const idempotent = async (c: Context, request: unknown[], apply: (client: AuthedClient, key: string) => Promise<Outcome>) => {
		const key = c.req.header("idempotency-key");
		if (!key || key.length < 8 || key.length > 200) return err(c, 422, "invalid", "Idempotency-Key header (8-200 chars) is required");
		const client = c.get("client");
		const kid = `${client.clientId}\u0000${key}`;
		const hash = JSON.stringify(request);
		const reused = () => err(c, 409, "idempotency_conflict", "Idempotency-Key reused with a different request");
		const prior = state.key(kid);
		if (prior) return prior.bodyHash === hash ? c.json(prior.result as object, prior.status as 200) : reused();
		const pend = writing.get(kid);
		if (pend) {
			if (pend.hash !== hash) return reused();
			const r = await pend.done;
			return c.json(r.body, r.status as 200);
		}
		let settle!: (o: Outcome) => void, fail!: (e: unknown) => void;
		const done = new Promise<Outcome>((ok, no) => { settle = ok; fail = no; });
		done.catch(() => {});
		writing.set(kid, { hash, done });
		try {
			const out = await apply(client, key);
			if (out.status === 200) state.recordKey(kid, { bodyHash: hash, status: 200, result: out.body });
			settle(out);
			return c.json(out.body, out.status as 200);
		} catch (e) {
			fail(e);
			throw e;
		} finally { writing.delete(kid); }
	};
	const gone = (what: string): Outcome => ({ status: 404, body: { code: "not_found", message: `${what} not found` } });
	const ENDED = new Set(["done", "failed", "cancelled", "handed-off"]);

	for (const action of ["pause", "resume", "cancel"] as const) {
		app.post(`/v1/runs/:runId/${action}`, (c) => {
			const runId = c.req.param("runId");
			return idempotent(c, [`runs.${action}`, runId], async (client) => {
				if ((await src.agents(runId)) === null) return gone(`run ${runId}`);
				const r = await src.control(runId, action, `client:${client.clientId}`);
				if (r.noop) return { status: 409, body: { code: "conflict", message: r.noop } };
				return { status: 200, body: { runId, action, changed: r.changed, pending: r.pending } };
			});
		});
	}

	// Agent controls (capability agent.pause): the agent and its descendants, through the same paths as `capcomd pause|resume <runId> <agt>`.
	for (const action of ["pause", "resume"] as const) {
		app.post(`/v1/runs/:runId/agents/:agentId/${action}`, (c) => {
			const runId = c.req.param("runId"), agentId = c.req.param("agentId");
			return idempotent(c, [`agents.${action}`, runId, agentId], async (client) => {
				const agents = await src.agents(runId);
				if (agents === null) return gone(`run ${runId}`);
				if (!agents.some((x) => x.id === agentId)) return gone(`agent ${agentId}`);
				const r = await src.control(runId, action, `client:${client.clientId}`, agentId);
				if (r.noop) return { status: 409, body: { code: "conflict", message: r.noop } };
				return { status: 200, body: { runId, agentId, action, changed: r.changed, pending: r.pending } };
			});
		});
	}

	app.post("/v1/runs/:runId/agents/:agentId/messages", async (c) => {
		const runId = c.req.param("runId"), agentId = c.req.param("agentId");
		const raw = await c.req.json().catch(() => null) as { body?: unknown; skills?: unknown } | null;
		if (!raw || typeof raw.body !== "string" || !raw.body.length) return err(c, 422, "invalid", "body must be {body: non-empty string, skills?: [name]}");
		if (Buffer.byteLength(raw.body) > MESSAGE_BODY_MAX_BYTES) return err(c, 422, "invalid", `body is over ${MESSAGE_BODY_MAX_BYTES} bytes`);
		if (raw.skills !== undefined && (!Array.isArray(raw.skills) || raw.skills.some((x) => typeof x !== "string" || !x))) return err(c, 422, "invalid", "skills must be a list of skill names from GET /v1/skills");
		const body = raw.body;
		const names = (raw.skills ?? []) as string[];
		// Skills are part of the request: the same key with other skills is idempotency_conflict, like another body. A
		// request without skills hashes as before skill attach, so a retry across the upgrade still replays.
		return idempotent(c, ["agents.send", runId, agentId, body, ...(names.length ? [names] : [])], async (client, key) => {
			const agents = await src.agents(runId);
			if (agents === null) return gone(`run ${runId}`);
			const a = agents.find((x) => x.id === agentId);
			if (!a) return gone(`agent ${agentId}`);
			if (ENDED.has(a.status)) return { status: 409, body: { code: "conflict", message: `${agentId} is ${a.status}: nothing will read this message` } };
			// Read here (not before the key check), so a replay still answers after a skill is removed.
			const sk = await resolveSkills(names, { read: (n) => src.skill(n) });
			if ("error" in sk) return { status: 422, body: { code: "invalid", message: sk.error } };
			// The scope's own message key: a retry after a daemon restart (or after the 24h key window) still sends once.
			const r = await src.send(runId, agentId, body, `harness:${client.clientId}:${key}`, sk.skills);
			return { status: 200, body: { runId, to: agentId, from: "operator", seq: r.seq, note: r.note } };
		});
	});

	// PATCH /v1/sandboxes/{name}/settings (capability sandboxes.settings; the configure scope, checked above). No
	// Idempotency-Key: `rev` makes a retry safe (a retry after a change that landed is 409, and the value is already set).
	app.patch("/v1/sandboxes/:name/settings", async (c) => {
		const name = c.req.param("name");
		const patch = parseSettingsPatch(await c.req.json().catch(() => null));
		if (typeof patch === "string") return err(c, 422, "invalid", patch);
		const r = await src.updateSandboxSettings(name, patch);
		if (!r.ok) return err(c, r.status, r.code, r.message, r.rev !== undefined ? { rev: r.rev } : {});
		const client = c.get("client");
		const place = PROVIDER_LABEL[name as keyof typeof PROVIDER_LABEL] ?? name;
		for (const ch of r.changes) {
			const f = r.detail.settings.find((x) => x.id === ch.id);
			const say = (v: string | null) => (v === null ? "unset" : f?.choices.find((x) => x.value === v)?.label ?? v);
			state.recordDaemonEvent({
				type: "sandbox.settings_changed", entity: `sandbox:${name}`,
				text: `${place}: ${f?.label ?? ch.id} is now ${say(ch.to)} (was ${say(ch.from)}).`,
				data: { sandbox: name, id: ch.id, from: ch.from, to: ch.to, clientId: client.clientId },
			});
		}
		return c.json(r.detail, 200);
	});

	// POST /v1/sandboxes/{name}/resources/{id}/actions/{action} (capability sandboxes.actions; the steer scope, as
	// cancelling a run). Today only delete. The write-route Idempotency-Key rules (a replay answers the first 200 and
	// acts once). No body, no parameters: the machine and the action are the whole request. Each action that changed
	// something is audited on the daemon stream: sandbox.resource_action, then sandbox.resource_deleted (cause action).
	app.post("/v1/sandboxes/:name/resources/:id/actions/:action", (c) => {
		const name = c.req.param("name"), id = c.req.param("id"), action = c.req.param("action");
		return idempotent(c, ["sandboxes.action", name, id, action], async (client) => {
			const r = await src.sandboxAction(name, id, action, `client:${client.clientId}`);
			if (!r.ok) return { status: r.status, body: { code: r.code, message: r.message } };
			if (r.changed) {
				state.recordDaemonEvent(resourceActionEvent(name, id, action, r.owner, client.clientId));
				state.recordDaemonEvent(resourceDeletedEvent(name, id, "action"));
			}
			return { status: 200, body: { resource: r.resource, changed: r.changed } };
		});
	});

	app.get("/v1/streams/:scope/events", (c) => {
		const scope = c.req.param("scope");
		if (!/^(daemon|prj-[A-Za-z0-9_-]+|run-[A-Za-z0-9_-]+)$/.test(scope)) return err(c, 422, "invalid", "scope is daemon, prj-<id> or run-<id>");
		const lastRaw = c.req.header("last-event-id");
		const last = lastRaw && /^\d+$/.test(lastRaw) ? Number(lastRaw) : null;
		const enc = new TextEncoder();
		let timer: ReturnType<typeof setInterval> | undefined, hb: ReturnType<typeof setInterval> | undefined, threadTimer: ReturnType<typeof setInterval> | undefined, closed = false;
		const stream = new ReadableStream<Uint8Array>({
			start: async (ctl) => {
				const send = (event: string, data: unknown, id?: number) => { if (!closed) ctl.enqueue(enc.encode(`${id !== undefined ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); };
				// Frames sharing a seq (an agent event + the run.* event it caused) form a group: only the LAST frame carries `id: N`
				// and each group is written in one enqueue, so a cut mid-group resumes from N-1 and the group is resent
				// (clients dedupe by envelope id). Every stream path writes through here.
				const sendGroups = (fs: Array<{ event: string; data: unknown; seq: number }>) => {
					if (closed || !fs.length) return;
					let buf = "";
					fs.forEach((f, i) => {
						const lastOfGroup = fs[i + 1]?.seq !== f.seq;
						buf += `${lastOfGroup ? `id: ${f.seq}\n` : ""}event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`;
						if (lastOfGroup) { ctl.enqueue(enc.encode(buf)); buf = ""; }
					});
				};
				const frame = (name: keyof typeof StreamFrames, data: unknown, id?: number) => send(name, data, id);
				hb = setInterval(() => { if (!closed) ctl.enqueue(enc.encode(": heartbeat\n\n")); }, heartbeatMs);
				ctl.enqueue(enc.encode(": connected\n\n"));
				if (!scope.startsWith("run-")) {
					// daemon and project scopes: run.created per run; seq is the run's persisted seq (stable across deletes/ties).
					let seen = last ?? 0, busy = false;
					const tick = async () => {
						// One tick at a time: a slow engine must not stack a new tick (and its actor calls) every pollMs.
						if (busy || closed) return;
						busy = true;
						try { await daemonTick(); } finally { busy = false; }
					};
					const daemonTick = async () => {
						const all = await src.runs();
						const seqOf = state.seqs(all);
						// Drop a seq only on a confirmed deletion (run.deleted in the run's log), never because the list came back short.
						const listed = new Set(all.map((r) => r.id));
						for (const id of listed) deletionChecked.delete(id);
						for (const id of state.knownRuns()) {
							if (closed) return;
							if (listed.has(id) || deletionChecked.has(id)) continue;
							deletionChecked.add(id);
							if ((await src.events(id, 0).catch(() => [])).some((e) => e.type === "run.deleted" || e.type === "RUN_DELETED")) state.runDeleted(id);
						}
						const runs = [...all].sort((a, b) => seqOf.get(a.id)! - seqOf.get(b.id)!);
						let top = seen;
						const out: Array<{ event: string; data: unknown; seq: number }> = [];
						runs.forEach((r) => {
							const i = seqOf.get(r.id)! - 1;
							top = Math.max(top, i + 1);
							if (i + 1 <= seen || (scope.startsWith("prj-") && r.projectId !== scope)) return;
							out.push({ event: "run.created", seq: i + 1, data: { v: 1, id: `evt_${scope}_${i + 1}`, scope, seq: i + 1, entity: r.id, entitySeq: 1, type: "run.created", typeVersion: 1, durability: "durable", ts: r.createdAt ?? isoTs(Date.now()), epochMs: r.createdAt ? Date.parse(r.createdAt) : Date.now(), projectId: r.projectId, runId: r.id, agentId: null, text: "Run created.", data: { label: r.label, goal: r.goal, budget: null } } });
						});
						// The daemon's own durable events (settings changes): daemon stream only, from the same seq counter.
						if (scope === "daemon") for (const e of state.daemonEvents(seen)) { top = Math.max(top, e.seq); out.push({ event: e.type, seq: e.seq, data: daemonEnvelope(e) }); }
						out.sort((a, b) => a.seq - b.seq);
						sendGroups(out);
						seen = top;
					};
					await tick();
					timer = setInterval(() => { tick().catch(() => {}); }, pollMs);
					return;
				}
				const runId = scope;
				const all = await src.events(runId, 0);
				// ?activity=1: ephemeral agent.activity_changed frames (ACTIVITY_DOC). The agents are read at most once per
				// activityMs and a frame goes out only when an agent's line changed, so each agent gets at most one a second.
				// No SSE id (never a resume cursor); seq is the last durable seq seen; never replayed.
				const wantActivity = c.req.query("activity") === "1";
				const sentActivity = new Map<string, string>();
				let activityAt = 0, activityN = 0;
				const activitySig = (a: { activity: { kind: string; text: string } | null }) => (a.activity ? `${a.activity.kind}\u0000${a.activity.text}` : "");
				const seedActivity = (agents: Array<{ id: string; activity: { kind: string; text: string } | null }>) => { for (const a of agents) sentActivity.set(a.id, activitySig(a)); activityAt = Date.now(); };
				// ?thread=1: ephemeral agent.thread_item_changed frames (THREAD_STREAM_DOC). Only a connection that asked polls the
				// run's thread writes, at most every threadMs, and sends the latest rev of each item it found; no SSE id.
				const wantThread = c.req.query("thread") === "1";
				let durable = all.at(-1)?.seq ?? 0, threadN = 0;
				const startThread = async () => {
					if (!wantThread || closed) return;
					let tcur = await src.threadHead(runId).catch(() => 0), tbusy = false;
					threadTimer = setInterval(async () => {
						if (tbusy || closed) return;
						tbusy = true;
						try {
							const latest = new Map<string, Awaited<ReturnType<HarnessSource["threadAfter"]>>[number]>();
							for (const it of await src.threadAfter(runId, tcur, 500)) { latest.set(it.id, it); tcur = Math.max(tcur, it.seq); }
							for (const it of latest.values()) {
								const now = Date.now();
								send("agent.thread_item_changed", {
									v: 1, id: `evt_${runId}_thread_${it.id}_${it.rev}_${++threadN}`, scope: runId, seq: durable, entity: it.agentId, entitySeq: 0, type: "agent.thread_item_changed", typeVersion: 1,
									durability: "ephemeral", ts: isoTs(now), epochMs: now, projectId: null, runId, agentId: it.agentId, text: `Thread: ${it.kind} ${it.status === "open" ? "started" : "updated"}.`,
									data: { agentId: it.agentId, item: it },
								});
							}
						} catch { /* next tick */ } finally { tbusy = false; }
					}, threadMs);
				};
				const sendActivity = async (seq: number) => {
					durable = Math.max(durable, seq);
					if (!wantActivity || closed || Date.now() - activityAt < activityMs) return;
					activityAt = Date.now();
					for (const a of (await src.agents(runId)) ?? []) {
						const sig = activitySig(a);
						if ((sentActivity.get(a.id) ?? "") === sig) continue;
						sentActivity.set(a.id, sig);
						const now = Date.now();
						send("agent.activity_changed", {
							v: 1, id: `evt_${runId}_activity_${a.id}_${now}_${++activityN}`, scope: runId, seq, entity: a.id, entitySeq: 0, type: "agent.activity_changed", typeVersion: 1,
							durability: "ephemeral", ts: isoTs(now), epochMs: now, projectId: null, runId, agentId: a.id, text: a.activity?.text ?? a.text,
							data: { agentId: a.id, status: a.status, activity: a.activity },
						});
					}
				};
				if (c.req.query("feed") === "lifecycle") {
					// Lifecycle feed: snapshot of state (run, agents, approvals), then only lifecycle events. Folded from the full log each tick.
					const head = all.at(-1)?.seq ?? 0;
					let cursor: number;
					if (last !== null && last <= head) cursor = last;
					else {
						if (last !== null) frame("stream.reset", { snapshotSeq: head, reason: "compacted" });
						const run = (await src.runs()).find((r) => r.id === runId) ?? null;
						if (run) frame("snapshot.run", { run });
						const agents = (await src.agents(runId)) ?? [];
						frame("snapshot.agents", { agents });
						seedActivity(agents);
						frame("snapshot.approvals", { approvals: await src.approvals(runId) });
						frame("snapshot.end", { snapshotSeq: head }, head);
						cursor = head;
					}
					let busy = false;
					const tick = async () => {
						if (busy || closed) return;
						busy = true;
						try {
							const evs = await src.events(runId, 0);
							sendGroups(lifecycleEvents(runId, evs).filter((e) => e.seq > cursor).map((e) => ({ event: e.type, data: e, seq: e.seq })));
							cursor = Math.max(cursor, evs.at(-1)?.seq ?? 0);
							await sendActivity(cursor);
						} finally { busy = false; }
					};
					await tick();
					await startThread();
					timer = setInterval(() => { tick().catch(() => {}); }, pollMs);
					return;
				}
				const head = all.at(-1)?.seq ?? 0;
				let cursor: number;
				if (last !== null && last <= head) {
					cursor = last;
				} else {
					// Fresh connect, or a cursor this daemon never issued (store reset): snapshot, then live from snapshotSeq+1.
					if (last !== null) frame("stream.reset", { snapshotSeq: head, reason: "compacted" });
					const run = (await src.runs()).find((r) => r.id === runId) ?? null;
					if (run) frame("snapshot.run", { run });
					const agents = (await src.agents(runId)) ?? [];
					frame("snapshot.agents", { agents });
					seedActivity(agents);
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
						const out: Array<{ event: string; data: unknown; seq: number }> = [];
						for (const e of await src.events(runId, cursor)) {
							const k = e.agentId ?? runId; const n = (counts.get(k) ?? 0) + 1; counts.set(k, n);
							const env = envelopes(runId, [e])[0]!; env.entitySeq = n;
							out.push({ event: env.type, data: env, seq: e.seq });
							cursor = e.seq;
						}
						sendGroups(out);
						await sendActivity(cursor);
					} finally { busy = false; }
				};
				await tick();
				await startThread();
				timer = setInterval(() => { tick().catch(() => {}); }, pollMs);
			},
			cancel: () => { closed = true; clearInterval(timer); clearInterval(hb); clearInterval(threadTimer); },
		});
		c.req.raw.signal?.addEventListener?.("abort", () => { closed = true; clearInterval(timer); clearInterval(hb); clearInterval(threadTimer); });
		return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } });
	});

	// A thrown error (engine down, an actor's not_found/conflict) is still an ApiError body.
	app.onError((e, c) => {
		const code = (e as { code?: unknown }).code;
		if (code === "not_found") return err(c, 404, "not_found", e.message);
		if (code === "conflict") return err(c, 409, "conflict", e.message);
		return c.json({ code: "internal", message: e.message || "internal error" }, 500);
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
