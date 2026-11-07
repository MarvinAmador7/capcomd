// harness.v1 server (docs/harness-architecture.md §6-7): Hono app on the 0600 Unix socket. JSON routes are the oRPC
// contract (src/api/contract.ts) served by OpenAPIHandler; the SSE stream and the write routes (decision, runs.create,
// run controls, messages) are native Hono routes because they need SSE framing, Last-Event-ID and Idempotency-Key.
// Every non-2xx body is ApiError {code, message}.
import { Hono, type Context } from "hono";
import { implement, ORPCError } from "@orpc/server";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import type { z } from "zod";
import { CAPABILITY_NAMES, contract, CreateRunBody, type PluginDetail, type Plugins, MESSAGE_BODY_MAX_BYTES, ProfileWriteBody, ProjectGitInitBody, ProjectPublishBody, ProjectSetupBody, PullRequestBody, StreamFrames, THREAD_PAGE_MAX, TRANSCRIPT_PAGE_MAX } from "./contract";
import { resolveSkills } from "../agents/skills";
import { mediaOfPath, sniffImage, workspacePath } from "../../packages/agent-thread/src/index";
import { authenticate, loadClients, pluginClients, type AuthedClient, type ClientRecord, type ClientScope } from "./clients";
import type { PluginDetail as HostPluginDetail, PluginProtocol, PluginSummary as HostPluginSummary } from "../../packages/plugin/src/host/host";
import type { ContributionStore } from "../../packages/plugin/src/host/context";
import type { Principal } from "../../packages/plugin/src/shapes";
import { Redactor } from "../agents/redact";
import { ProtocolError, type FrameSink } from "../../packages/plugin/src/host/process";
import { PluginError, type PluginErrorCode } from "../../packages/plugin/src/errors";
import type { PluginStore } from "../plugins/storage";
import { bodyHash, resolveDecide, type DecideBody } from "./idempotency";
import { CreateRunError, entityOf, envelopes, messagesOf, type CreateRunInput, type HarnessSource } from "./source";
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
/** POST routes that need the configure scope (projects.setup, projects.git). */
const CONFIGURE_POSTS = new Set(["/v1/projects", "/v1/projects/git-init", "/v1/projects/publish"]);
const err = (c: Context, status: 401 | 403 | 404 | 409 | 422 | 503, code: string, message: string, extra: Record<string, unknown> = {}) => c.json({ code, message, ...extra }, status);

/** agent.activity_changed: at most one frame per agent per this many ms (ACTIVITY_DOC). */
export const ACTIVITY_MS = 1000;
/** agent.thread_item_changed: the thread is polled at most this often, latest rev per item (at most four frames per item per second). */
export const THREAD_MS = 250;
/** GET …/thread: a page stops at about this many bytes of items (`next` says where to go on). */
export const THREAD_PAGE_MAX_BYTES = 4 * 1024 * 1024;
/** The daemon's plugin host as the gateway uses it (capabilities plugins and plugins.protocol, plugin API §9, §13.2). */
export type GatewayHost = {
	detail(name: string): HostPluginDetail | null;
	enable(name: string, by?: string): Promise<HostPluginSummary>;
	disable(name: string): Promise<HostPluginSummary>;
	protocol: PluginProtocol;
	/** What the plugins registered: their API routes (/v1/x/<name>/…) and feature flags (plugin API §4.7.3). */
	contributions: Pick<ContributionStore, "list">;
};
export type ServerOptions = {
	source: HarnessSource; clients?: () => ClientRecord[]; plugins?: () => z.infer<typeof Plugins>["plugins"]; heartbeatMs?: number; pollMs?: number; activityMs?: number; threadMs?: number; snapshotSteps?: number; state?: HarnessState;
	/** The plugin host behind GET /v1/plugins/{name}, the controls and the out-of-process protocol (absent: 404 / 409). */
	pluginHost?: GatewayHost;
	/** A plugin's private storage (src/plugins/storage.ts), for its /v1/plugins/{name}/storage routes. */
	pluginStorage?: (plugin: string) => PluginStore;
};

/** The out-of-process protocol's routes (plugin API §9.3-§9.6): only the plugin's own token, whatever its scopes. */
const PROTOCOL_ROUTE = /^\/v1\/plugins\/[^/]+\/(sessions|hooks|storage)(\/|$)/;
const PLUGIN_CONTROL = /^\/v1\/plugins\/[^/]+\/(enable|disable)$/;
const PLUGIN_STATUS: Record<PluginErrorCode, 403 | 404 | 409 | 422 | 503> = { forbidden: 403, not_found: 404, conflict: 409, invalid: 422, widening: 422, unsupported: 422, disposed: 409, timeout: 503, unavailable: 503 };
/** A plugin route's thrown PluginError (plugin API §4.7.3); any other code, or any other throw, is 500 "plugin error". */
const ROUTE_STATUS: Partial<Record<PluginErrorCode, 403 | 404 | 409 | 422 | 503>> = { forbidden: 403, not_found: 404, conflict: 409, invalid: 422, unavailable: 503 };
const PLUGIN_ROUTES = "/v1/x/";

/** A plugin route's params when `path` matches its `pattern`: a `{name}` segment takes one path segment; null otherwise. */
export function routeParams(pattern: string, path: string): Record<string, string> | null {
	const want = pattern.split("/"), got = path.split("/");
	if (want.length !== got.length) return null;
	const params: Record<string, string> = {};
	for (const [i, w] of want.entries()) {
		const name = /^\{([^{}]+)\}$/.exec(w)?.[1];
		if (name === undefined) { if (w !== got[i]) return null; continue; }
		if (!got[i]) return null;
		try { params[name] = decodeURIComponent(got[i]!); } catch { return null; }
	}
	return params;
}

/** Whom a plugin route runs as (plugin API §11.2): the caller, never the plugin. A read-only client is a viewer. */
function callerPrincipal(cl: AuthedClient): Principal {
	if (cl.plugin) return { kind: "plugin", name: cl.plugin, scopes: cl.scopes.filter((s): s is "read" | "steer" | "configure" => s !== "approve") };
	return cl.scopes.every((s) => s === "read") ? { kind: "viewer", clientId: cl.clientId } : { kind: "operator", clientId: cl.clientId };
}

/** The plugin socket's door (plugin API §5.5 step 4, §9.2): only a token the daemon minted for a plugin's process gets
 *  through, so nothing else sees the daemon there before its plugins have loaded and the harness socket opens. */
export function pluginsOnly(fetch: (req: Request) => Response | Promise<Response>): (req: Request) => Response | Promise<Response> {
	return (req) => authenticate(req.headers.get("authorization"), pluginClients())
		? fetch(req)
		: Response.json({ code: "unauthorized", message: "this socket serves the plugins capcomd starts (CAPCOMD_PLUGIN_TOKEN); clients use the harness socket" }, { status: 401 });
}

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
		// The kernel's features, then the flags active plugins added (x.<plugin>.<flag>, plugin API §4.7.3).
		health: os.health.handler(() => ({ ok: true as const, api: "harness.v1" as const, version: src.version, capabilities: [...CAPABILITY_NAMES, ...(o.pluginHost?.contributions.list("capability").map((e) => e.key) ?? [])] })),
		projects: {
			list: os.projects.list.handler(() => src.projects()),
			inspect: os.projects.inspect.handler(({ input }) => src.inspectProject(input.path)),
			known: os.projects.known.handler(async () => ({ projects: await src.knownProjects() })),
			// Served natively below (Idempotency-Key, the configure scope): this handler is never reached.
			setup: os.projects.setup.handler(() => { throw new ORPCError("NOT_FOUND", { message: "served natively" }); }),
			// Served natively below (refusals carry `field` and `problem`; the POSTs take an Idempotency-Key): never reached.
			gitInit: os.projects.gitInit.handler(() => { throw new ORPCError("NOT_FOUND", { message: "served natively" }); }),
			publishOptions: os.projects.publishOptions.handler(() => { throw new ORPCError("NOT_FOUND", { message: "served natively" }); }),
			publish: os.projects.publish.handler(() => { throw new ORPCError("NOT_FOUND", { message: "served natively" }); }),
			branches: os.projects.branches.handler(({ input }) => src.projectBranches(input)),
		},
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
			goal: os.runs.goal.handler(async ({ input }) => (await src.goal(input.runId)) ?? (() => { throw nf(`goal branch of ${input.runId}`); })()),
			// Served natively below (Idempotency-Key, the steer scope): never reached.
			pullRequest: os.runs.pullRequest.handler(() => { throw new ORPCError("NOT_FOUND", { message: "served natively" }); }),
			keepBranch: os.runs.keepBranch.handler(() => { throw new ORPCError("NOT_FOUND", { message: "served natively" }); }),
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
			// Capability agents.thread_tail: the newest items by position, about THREAD_PAGE_MAX_BYTES of them at most (always
			// at least one). The cursor is read first: a write after it comes back by GET …/thread?after=cursor.
			threadTail: os.agents.threadTail.handler(async ({ input }) => {
				const limit = Math.min(input.limit ?? 100, THREAD_PAGE_MAX);
				const cursor = await src.threadHead(input.runId);
				const items = await src.threadBefore(input.runId, input.agentId, input.before ?? null, limit + 1);
				if (!items) throw nf(input.agentId);
				const page: typeof items = [];   // newest first
				let bytes = 0;
				for (const it of items.slice(0, limit)) {
					const n = Buffer.byteLength(JSON.stringify(it));
					if (page.length && bytes + n > THREAD_PAGE_MAX_BYTES) break;
					page.push(it); bytes += n;
				}
				const before = items.length > page.length ? page.at(-1)!.order : null;
				return { items: page.reverse(), before, cursor };
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
		// Capability profiles: as GET /v1/run-options, a `repo` that isn't a project is 422.
		profiles: {
			list: os.profiles.list.handler(async ({ input }) => {
				try { return await src.profiles(input.repo); } catch (e) {
					if (e instanceof CreateRunError) throw new ORPCError("UNPROCESSABLE_CONTENT", { message: e.message });
					throw e;
				}
			}),
			// Capability profiles.edit: one profile as rows; 404 for a name that isn't one, 422 when they can't be read.
			get: os.profiles.get.handler(async ({ input }) => {
				let r: Awaited<ReturnType<typeof src.profile>>;
				try { r = await src.profile(input.name, input.repo); } catch (e) {
					if (e instanceof CreateRunError) throw new ORPCError("UNPROCESSABLE_CONTENT", { message: e.message });
					throw e;
				}
				if (r.ok) return r.detail;
				throw new ORPCError(r.status === 404 ? "NOT_FOUND" : "UNPROCESSABLE_CONTENT", { message: r.message });
			}),
			// Served natively below (Idempotency-Key, the configure scope): never reached.
			update: os.profiles.update.handler(() => { throw new ORPCError("NOT_FOUND", { message: "served natively" }); }),
		},
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
		// Capability plugins: the daemon's plugin host (src/plugins/host.ts), as it is now.
		plugins: {
			list: os.plugins.list.handler(() => ({ plugins: o.plugins?.() ?? [] })),
			get: os.plugins.get.handler(({ input }) => (o.pluginHost?.detail(input.name) as z.infer<typeof PluginDetail> | null) ?? (() => { throw nf(`plugin ${input.name.slice(0, 64)}`); })()),
			// Served natively below (Idempotency-Key, the configure scope; the protocol's own-token rule, SSE): never reached.
			enable: os.plugins.enable.handler(() => { throw new ORPCError("NOT_FOUND", { message: "served natively" }); }),
			disable: os.plugins.disable.handler(() => { throw new ORPCError("NOT_FOUND", { message: "served natively" }); }),
			openSession: os.plugins.openSession.handler(() => { throw new ORPCError("NOT_FOUND", { message: "served natively" }); }),
			hooks: os.plugins.hooks.handler(() => { throw new ORPCError("NOT_FOUND", { message: "served natively" }); }),
			answer: os.plugins.answer.handler(() => { throw new ORPCError("NOT_FOUND", { message: "served natively" }); }),
			emit: os.plugins.emit.handler(() => { throw new ORPCError("NOT_FOUND", { message: "served natively" }); }),
			storageList: os.plugins.storageList.handler(() => { throw new ORPCError("NOT_FOUND", { message: "served natively" }); }),
			storageGet: os.plugins.storageGet.handler(() => { throw new ORPCError("NOT_FOUND", { message: "served natively" }); }),
			storagePut: os.plugins.storagePut.handler(() => { throw new ORPCError("NOT_FOUND", { message: "served natively" }); }),
			storageDelete: os.plugins.storageDelete.handler(() => { throw new ORPCError("NOT_FOUND", { message: "served natively" }); }),
		},
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
		const cl = authenticate(c.req.header("authorization"), [...clients(), ...pluginClients()]);
		if (!cl) return err(c, 401, "unauthorized", "missing or unknown bearer token (create one with `capcomd clients add`)");
		c.set("client", cl);
		// A plugin's protocol routes need its own token, any scope (the route checks it, plugin API §9.3); a plugin's API
		// route needs the scope it declares, which the gateway checks once it found the route (§4.7.3).
		if (PROTOCOL_ROUTE.test(c.req.path) || c.req.path.startsWith(PLUGIN_ROUTES)) return next();
		// PATCH changes settings (capability sandboxes.settings), POST /v1/projects sets a folder up (projects.setup) and
		// …/git-init and …/publish start and publish its repository (projects.git), a plugin's enable and disable
		// (plugins), and PUT /v1/profiles/{name} changes a profile (profiles.edit): the configure scope, which steering a
		// run doesn't give.
		const configures = c.req.method === "PATCH" || (c.req.method === "POST" && (CONFIGURE_POSTS.has(c.req.path) || PLUGIN_CONTROL.test(c.req.path))) || (c.req.method !== "GET" && c.req.path.startsWith("/v1/profiles/"));
		const need: ClientScope = c.req.method === "GET" ? "read" : configures ? "configure" : c.req.path.startsWith("/v1/approvals/") ? "approve" : "steer";
		if (!cl.scopes.includes(need)) return err(c, 403, "forbidden", `token lacks the ${need} scope`);
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
			return err(c, 422, "invalid", i?.path.length ? `${i.path.join(".")}: ${i.message}` : "body must be a JSON object {goal, repo?, profile?, targetBranch?, driver?, effort?, model?, sandbox?, base?, goalBranch?, plugins?}", i?.path.length ? { field: String(i.path[0]) } : {});
		}
		const p = parsed.data;
		if (p.profile !== undefined && p.driver !== undefined) return err(c, 422, "invalid", "profile and driver can't be combined: driver runs the project's planner agent, which picks its own workers; send one of them");
		if (p.profile !== undefined && p.effort !== undefined) return err(c, 422, "invalid", "profile and effort can't be combined: effort is the planner agent's (the driver's), and profile picks the worker of a run without one");
		if (p.profile !== undefined && p.model !== undefined) return err(c, 422, "invalid", "profile and model can't be combined: model is the planner agent's (the driver's), and profile picks the worker of a run without one");
		if (p.effort !== undefined || p.model !== undefined || p.sandbox !== undefined) {
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
			if (p.model !== undefined) {
				if (!d) return err(c, 422, "invalid", `model needs a driver: ${p.repo !== undefined ? "this project" : "this daemon"} has no default planner profile (run capcomd setup), so send driver too`, { field: "model" });
				const ids = (d.models ?? []).map((m) => m.id);
				if (!ids.includes(p.model)) return err(c, 422, "invalid", `model ${JSON.stringify(p.model)} isn't a ${d.label} model capcomd offers: use one of ${ids.join(", ")}`, { field: "model" });
			}
			// Logins and agent environments are per sandbox: a driver that can't run in the chosen one is refused now, not
			// minutes later (capability runs.options.sandbox).
			const fit = p.sandbox !== undefined ? d?.sandboxes?.[p.sandbox] : undefined;
			if (fit && !fit.available) return err(c, 422, "invalid", `${d!.label} can't drive a run in ${PROVIDER_LABEL[p.sandbox as keyof typeof PROVIDER_LABEL] ?? p.sandbox}: ${fit.reason ?? "unavailable"}`);
		}
		// A run's plugin settings (capability plugins.config, plugin API §10.2 layer 5): per-run ones only, checked against
		// the plugins of the run's project (`capcomd run` checks them again where it starts the run).
		let plugins: Record<string, Record<string, unknown>> | undefined;
		if (p.plugins !== undefined && Object.keys(p.plugins).length) {
			const RC = await import("../plugins/run-config");
			try { plugins = await RC.checkRunPluginConfig(p.plugins, { ...(p.repo ? { cwd: p.repo } : {}) }); } catch (e) {
				if (e instanceof RC.RunConfigError) return err(c, 422, "invalid", e.message, { field: e.field });
				throw e;
			}
		}
		const input: CreateRunInput = { goal: p.goal.trim(), ...(plugins ? { plugins } : {}), ...(p.repo !== undefined ? { repo: p.repo } : {}), ...(p.profile !== undefined ? { profile: p.profile } : {}), ...(p.targetBranch !== undefined ? { targetBranch: p.targetBranch } : {}), ...(p.driver !== undefined ? { driver: p.driver } : {}), ...(p.effort !== undefined ? { effort: p.effort } : {}), ...(p.model !== undefined ? { model: p.model } : {}), ...(p.sandbox !== undefined ? { sandbox: p.sandbox as NonNullable<CreateRunInput["sandbox"]> } : {}),
			...(p.base !== undefined ? { base: p.base } : {}), ...(p.goalBranch !== undefined ? { goalBranch: p.goalBranch } : {}) };
		const kid = `${c.get("client").clientId}\u0000runs.create\u0000${key}`;
		// driver and sandbox are part of the body (another value: idempotency_conflict); a request without them hashes as
		// before they existed, so a retry across the upgrade still replays.
		const hash = JSON.stringify(["runs.create", input.goal, input.repo ?? null, input.profile ?? null, input.targetBranch ?? null, ...(input.driver || input.sandbox || input.effort ? [input.driver ?? null, input.sandbox ?? null, ...(input.effort ? [input.effort] : [])] : []),
			...(input.base !== undefined || input.goalBranch !== undefined ? [{ base: input.base ?? null, goalBranch: input.goalBranch ?? null }] : []),
			...(input.model !== undefined ? [{ model: input.model }] : []), ...(input.plugins ? [{ plugins: input.plugins }] : [])]);
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
			const out: Outcome = e instanceof CreateRunError ? { status: 422, body: { code: "invalid", message: e.message, ...(e.field ? { field: e.field } : {}) } } : { status: 500, body: { code: "internal", message: (e as Error).message } };
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
	// Only a success is stored: an error changed nothing, so a retry looks again. Concurrent duplicates share one apply.
	// `owner`: whose keys these are when not the client's (a plugin's, across its process's restarts and their tokens).
	const writing = new Map<string, { hash: string; done: Promise<Outcome> }>();
	const idempotent = async (c: Context, request: unknown[], apply: (client: AuthedClient, key: string) => Promise<Outcome>, owner?: string) => {
		const key = c.req.header("idempotency-key");
		if (!key || key.length < 8 || key.length > 200) return err(c, 422, "invalid", "Idempotency-Key header (8-200 chars) is required");
		const client = c.get("client");
		const kid = `${owner ?? client.clientId}\u0000${key}`;
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
			if (out.status === 200 || out.status === 201) state.recordKey(kid, { bodyHash: hash, status: out.status, result: out.body });
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

	// The user's title for an agent (capability agents.title): PUT sets it, DELETE clears it. Not rate limited (an agent's
	// own renames are); the scope gets its own key too, so a retry after a daemon restart records it once.
	const titleRoute = (c: Context, title: string | null) => {
		const runId = c.req.param("runId")!, agentId = c.req.param("agentId")!;
		return idempotent(c, ["agents.title", runId, agentId, title], async (client, key) => {
			const r = await src.setAgentTitle(runId, agentId, title, `harness:${client.clientId}:${key}`);
			if (!r) return (await src.agents(runId)) === null ? gone(`run ${runId}`) : gone(`agent ${agentId}`);
			if (!r.ok) return { status: 422, body: { code: "invalid", message: r.message, field: "title" } };
			return { status: 200, body: { runId, agentId, title: r.title, titleSource: r.titleSource, changed: r.changed } };
		});
	};
	app.put("/v1/runs/:runId/agents/:agentId/title", async (c) => {
		const raw = await c.req.json().catch(() => null) as { title?: unknown } | null;
		if (!raw || typeof raw.title !== "string" || raw.title.length > 200) return err(c, 422, "invalid", "body must be {title: 1 to 4 words}", { field: "title" });
		return titleRoute(c, raw.title);
	});
	app.delete("/v1/runs/:runId/agents/:agentId/title", (c) => titleRoute(c, null));

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

	// Goal branches (capability runs.goal_branch; the steer scope): open a pull request from the run's goal branch into its
	// base, or keep the branch. Both are idempotent in themselves; the Idempotency-Key rules are the other write routes'.
	app.post("/v1/runs/:runId/pull-request", async (c) => {
		const runId = c.req.param("runId");
		// The body is optional (`{"stopped": true}`: the person agreed to open one for a stopped run).
		const raw = await c.req.text().catch(() => "");
		let body: unknown = null;
		if (raw.trim()) { try { body = JSON.parse(raw); } catch { return err(c, 422, "invalid", "the body must be JSON: {\"stopped\": true}, or none"); } }
		const parsed = PullRequestBody.safeParse(body ?? {});
		if (!parsed.success) return err(c, 422, "invalid", "the body must be {\"stopped\": true}, or none");
		const stopped = parsed.data.stopped === true;
		return idempotent(c, ["runs.pullRequest", runId, ...(stopped ? ["stopped"] : [])], async (client) => {
			const r = await src.openPullRequest(runId, `client:${client.clientId}`, { stopped });
			return r.ok ? { status: 200, body: r.body } : { status: r.status, body: { code: r.code, message: r.message } };
		});
	});
	app.post("/v1/runs/:runId/keep-branch", (c) => {
		const runId = c.req.param("runId");
		return idempotent(c, ["runs.keepBranch", runId], async (client) => {
			const r = await src.keepBranch(runId, `client:${client.clientId}`);
			return r.ok ? { status: 200, body: r.body } : { status: r.status, body: { code: r.code, message: r.message } };
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

	// PUT /v1/profiles/{name} (capability profiles.edit; the configure scope, checked above): change a profile in its own
	// file. Both an Idempotency-Key (a replay answers the first 200 and writes once) and `rev` (a change made from a stale
	// read is 409). A write that changed something is audited on the daemon stream (profile.changed).
	app.put("/v1/profiles/:name", async (c) => {
		const name = c.req.param("name"), repo = c.req.query("repo");
		if (repo !== undefined && !repo.startsWith("/")) return err(c, 422, "invalid", "repo: repo must be an absolute path", { field: "repo" });
		const p = await bodyOf(c, ProfileWriteBody, "{values: {<field id>: <value> | null}, rev}");
		if (!p.body) return p.refused!;
		const b = p.body;
		return idempotent(c, ["profiles.update", name, repo ?? null, b.values, b.rev], async (client) => {
			let r: Awaited<ReturnType<typeof src.updateProfile>>;
			try { r = await src.updateProfile(name, repo, b); } catch (e) {
				if (e instanceof CreateRunError) return { status: 422, body: { code: "invalid", message: e.message } };
				throw e;
			}
			if (!r.ok) {
				const { ok: _, status, ...body } = r;
				return { status, body };
			}
			if (r.event) state.recordDaemonEvent({ type: "profile.changed", entity: r.event.entity, text: r.event.text, data: { ...r.event.data, clientId: client.clientId } });
			return { status: 200, body: r.detail };
		});
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

	// POST /v1/projects (capability projects.setup; the configure scope, checked above): set a folder up as a project. The
	// write-route Idempotency-Key rules: a replay answers the first 200 and writes nothing again; only a 200 is kept. A
	// setup that changed something is audited on the daemon stream (project.configured).
	app.post("/v1/projects", async (c) => {
		const parsed = ProjectSetupBody.safeParse(await c.req.json().catch(() => undefined));
		if (!parsed.success) {
			const i = parsed.error.issues[0];
			const field = typeof i?.path[0] === "string" ? i.path[0] : undefined;
			return err(c, 422, "invalid", i?.path.length ? `${i.path.join(".")}: ${i.message}` : "body must be a JSON object {path, mode, target, check?, agents, budgetUsd?, expect?, gitignore?}", field ? { field } : {});
		}
		const b = parsed.data;
		return idempotent(c, ["projects.setup", b.path, b.mode, b.target, b.check ?? null, b.agents, b.budgetUsd ?? null, b.expect ? (b.expect.repo ?? null) : "-", b.gitignore ?? false], async (client) => {
			const r = await src.setUpProject(b);
			if (!r.ok) {
				const { ok: _, status, ...body } = r;
				return { status, body };
			}
			if (r.changed) state.recordDaemonEvent({
				type: "project.configured", entity: `project:${r.project.name}`,
				text: r.event.text, data: { path: r.project.root, name: r.project.name, ...r.event.data, clientId: client.clientId },
			});
			return { status: 200, body: { project: r.project, changed: r.changed } };
		});
	});

	// Capability projects.git: start a folder's repository and publish it to GitHub, so it can then be set up (above). The
	// POSTs follow the write-route Idempotency-Key rules and are audited on the daemon stream; refusals carry the daemon's
	// sentence, the field it's about and the inspect problem code.
	const bodyOf = async <T>(c: Context, schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } } }, shape: string) => {
		const parsed = schema.safeParse(await c.req.json().catch(() => undefined));
		if (parsed.success) return { body: parsed.data };
		const i = parsed.error.issues[0];
		const field = typeof i?.path[0] === "string" ? i.path[0] : undefined;
		return { refused: err(c, 422, "invalid", i?.path.length ? `${i.path.join(".")}: ${i.message}` : `body must be a JSON object ${shape}`, field ? { field } : {}) };
	};
	const refusal = (r: { status: number; code: string; message: string; field?: string; problem?: string }): Outcome =>
		({ status: r.status, body: { code: r.code, message: r.message, ...(r.field ? { field: r.field } : {}), ...(r.problem ? { problem: r.problem } : {}) } });
	app.post("/v1/projects/git-init", async (c) => {
		const p = await bodyOf(c, ProjectGitInitBody, "{path}");
		if (!p.body) return p.refused!;
		const b = p.body;
		return idempotent(c, ["projects.gitInit", b.path], async (client) => {
			const r = await src.initGit(b.path);
			if (!r.ok) return refusal(r);
			state.recordDaemonEvent({ type: "project.git_initialized", entity: r.event.entity, text: r.event.text, data: { ...r.event.data, clientId: client.clientId } });
			return { status: 200, body: r.inspection };
		});
	});
	app.get("/v1/projects/publish-options", async (c) => {
		const path = c.req.query("path") ?? "";
		if (!path.startsWith("/") || path.length > 4096) return err(c, 422, "invalid", "path: path must be an absolute path", { field: "path" });
		const r = await src.publishOptions(path);
		if (!r.ok) { const o = refusal(r); return c.json(o.body, o.status as 422); }
		return c.json(r.options);
	});
	app.post("/v1/projects/publish", async (c) => {
		const p = await bodyOf(c, ProjectPublishBody, "{path, owner, name, visibility}");
		if (!p.body) return p.refused!;
		const b = p.body;
		return idempotent(c, ["projects.publish", b.path, b.owner, b.name, b.visibility], async (client) => {
			const r = await src.publishProject(b);
			if (!r.ok) return refusal(r);
			state.recordDaemonEvent({ type: "project.published", entity: r.event.entity, text: r.event.text, data: { ...r.event.data, clientId: client.clientId } });
			return { status: 200, body: r.inspection };
		});
	});

	// ---- plugins (capabilities plugins and plugins.protocol; plugin API §9, §13.2) ----------------------------------
	const host = o.pluginHost;
	const noHost = (c: Context) => err(c, 409, "conflict", "this daemon runs no plugin host");
	const caller = (c: Context) => { const cl = c.get("client") as AuthedClient; return { clientId: cl.clientId, plugin: cl.plugin ?? null }; };
	/** A refused protocol request (ProtocolError) or primitive (PluginError) as an ApiError; anything else is thrown on. */
	const refusedBy = (c: Context, e: unknown) => {
		if (e instanceof ProtocolError) return err(c, e.status, e.code, e.message);
		if (e instanceof PluginError) return err(c, PLUGIN_STATUS[e.code], e.code, e.message);
		throw e;
	};
	const control = (action: "enable" | "disable") => app.post(`/v1/plugins/:name/${action}`, async (c) => {
		const name = c.req.param("name");
		if (!host) return noHost(c);
		// A plugin never turns plugins on or off, whatever its scopes: disabling another's gate would bypass it (§11.3).
		if ((c.get("client") as AuthedClient).plugin) return err(c, 403, "forbidden", "a plugin's token can't enable or disable plugins");
		return idempotent(c, [`plugins.${action}`, name], async (client) => {
			const d = host.detail(name);
			if (!d) return gone(`plugin ${name.slice(0, 64)}`);
			// The kernel's own plugins hold the places, agents, forges and front doors the daemon runs on: they stay up.
			if (action === "disable" && d.source === "builtin") return { status: 409, body: { code: "conflict", message: `${name} is built into capcomd: it can't be disabled while the daemon runs` } };
			try { return { status: 200, body: action === "enable" ? await host.enable(name, `client:${client.clientId}`) : await host.disable(name) }; } catch (e) {
				if (e instanceof PluginError) return { status: PLUGIN_STATUS[e.code], body: { code: e.code, message: e.message } };
				throw e;
			}
		});
	});
	control("enable");
	control("disable");

	app.post("/v1/plugins/:name/sessions", async (c) => {
		if (!host) return noHost(c);
		const body = await c.req.json().catch(() => null);
		try { return c.json(host.protocol.open(c.req.param("name"), caller(c), body), 200); } catch (e) { return refusedBy(c, e); }
	});

	app.get("/v1/plugins/:name/hooks", (c) => {
		if (!host) return noHost(c);
		const lastRaw = c.req.header("last-event-id");
		const last = lastRaw && /^\d+$/.test(lastRaw) ? Number(lastRaw) : null;
		const enc = new TextEncoder();
		let ctl!: ReadableStreamDefaultController<Uint8Array>;
		let closed = false, hb: ReturnType<typeof setInterval> | undefined, detach: (() => void) | undefined;
		const end = () => { if (closed) return; closed = true; clearInterval(hb); detach?.(); };
		const stream = new ReadableStream<Uint8Array>({ start: (k) => { ctl = k; }, cancel: end });
		const sink: FrameSink = {
			frame: (f) => { if (!closed) ctl.enqueue(enc.encode(`id: ${f.seq}\nevent: ${f.frame}\ndata: ${JSON.stringify(f)}\n\n`)); },
			close: () => { if (closed) return; end(); try { ctl.close(); } catch { /* already closed */ } },
		};
		ctl.enqueue(enc.encode(": connected\n\n"));
		try { detach = host.protocol.attach(c.req.param("name"), caller(c), c.req.query("session") ?? "", last, sink); } catch (e) { closed = true; return refusedBy(c, e); }
		hb = setInterval(() => { if (!closed) ctl.enqueue(enc.encode(": heartbeat\n\n")); }, heartbeatMs);
		c.req.raw.signal?.addEventListener?.("abort", end);
		return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } });
	});

	app.post("/v1/plugins/:name/hooks/:callId", async (c) => {
		if (!host) return noHost(c);
		const body = await c.req.json().catch(() => null);
		try { await host.protocol.answer(c.req.param("name"), caller(c), c.req.param("callId"), body); return c.body(null, 204); } catch (e) { return refusedBy(c, e); }
	});

	// ctx.events.emit over the wire: the same checks as in process (the steer scope, a declared type, redaction, caps).
	app.post("/v1/plugins/:name/events", async (c) => {
		if (!host) return noHost(c);
		const name = c.req.param("name");
		let ctx;
		try { ctx = host.protocol.context(name, caller(c)); } catch (e) { return refusedBy(c, e); }
		const raw = await c.req.json().catch(() => null) as Record<string, unknown> | null;
		if (!raw || typeof raw.type !== "string" || typeof raw.stream !== "string" || typeof raw.text !== "string" || !raw.data || typeof raw.data !== "object" || Array.isArray(raw.data) || (raw.entity !== undefined && typeof raw.entity !== "string"))
			return err(c, 422, "invalid", "body must be EmitBody {type, stream, entity, text, data, durability?}");
		const e = { type: raw.type, stream: raw.stream, entity: (raw.entity as string | undefined) ?? "", text: raw.text, data: raw.data as Record<string, unknown>, ...(raw.durability !== undefined ? { durability: raw.durability as "durable" } : {}) };
		return idempotent(c, ["plugins.events", name, e], async () => {
			try { return { status: 201, body: await ctx.events.emit(e) }; } catch (x) {
				if (x instanceof PluginError) return { status: PLUGIN_STATUS[x.code], body: { code: x.code, message: x.message } };
				throw x;
			}
		}, `plugin:${name}`);
	});

	// The plugin's private storage (§8.4), the daemon scope or `?run=` a run's.
	const storage = async (c: Context, fn: (store: PluginStore, scope: "daemon" | { runId: string }) => Promise<Response>) => {
		if (!host || !o.pluginStorage) return noHost(c);
		const name = c.req.param("name")!;
		try {
			host.protocol.context(name, caller(c));
			const run = c.req.query("run");
			return await fn(o.pluginStorage(name), run ? { runId: run } : "daemon");
		} catch (e) { return refusedBy(c, e); }
	};
	app.get("/v1/plugins/:name/storage", (c) => storage(c, async (s, scope) => c.json({ entries: await s.list(scope, c.req.query("prefix") ?? "") }, 200)));
	app.get("/v1/plugins/:name/storage/:key{.+}", (c) => storage(c, async (s, scope) => {
		const e = await s.get(scope, c.req.param("key"));
		return e ? c.json(e, 200) : err(c, 404, "not_found", "no such key");
	}));
	app.put("/v1/plugins/:name/storage/:key{.+}", (c) => storage(c, async (s, scope) => {
		const raw = await c.req.json().catch(() => null) as { value?: unknown; expect?: unknown } | null;
		if (!raw || !("value" in raw) || (raw.expect !== undefined && raw.expect !== null && typeof raw.expect !== "string")) return err(c, 422, "invalid", "body must be {value, expect?: string | null}");
		const key = c.req.param("key");
		try { return c.json(await s.put(scope, key, raw.value, raw.expect as string | null | undefined), 200); } catch (e) {
			if (e instanceof PluginError && e.code === "conflict") return err(c, 409, "conflict", e.message, { current: await s.get(scope, key) });
			throw e;
		}
	}));
	app.delete("/v1/plugins/:name/storage/:key{.+}", (c) => storage(c, async (s, scope) => { await s.delete(scope, c.req.param("key")); return c.body(null, 204); }));

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
				for (const e of all) if (e.seq <= cursor) counts.set(entityOf(runId, e), (counts.get(entityOf(runId, e)) ?? 0) + 1);
				let busy = false;
				const tick = async () => {
					if (busy || closed) return;
					busy = true;
					try {
						const out: Array<{ event: string; data: unknown; seq: number }> = [];
						for (const e of await src.events(runId, cursor)) {
							const k = entityOf(runId, e); const n = (counts.get(k) ?? 0) + 1; counts.set(k, n);
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

	// Plugin API routes (capability plugins.routes; plugin API §4.7.3): METHOD /v1/x/<name>/<path>, served by the route an
	// active plugin registered with ctx.api.route (gone from the store once it is disposed). The caller's token needs the
	// route's declared scope; the handler runs as the caller, JSON in and out. A PluginError it throws keeps its code where
	// the spec maps one; anything else is 500 "plugin error", its message only in the daemon log. Never a stream: the
	// streams are the kernel's, a plugin publishes events instead.
	const redactor = new Redactor();
	app.all(`${PLUGIN_ROUTES}*`, async (c) => {
		const path = new URL(c.req.url).pathname;
		const name = path.slice(PLUGIN_ROUTES.length).split("/")[0]!;
		const method = c.req.method;
		const found = (host?.contributions.list("api") ?? [])
			.filter((e) => e.plugin === name && e.value.spec.method === method)
			.map((e) => ({ spec: e.value.spec, params: routeParams(`${PLUGIN_ROUTES}${name}${e.value.spec.path}`, path) }))
			.filter((r): r is { spec: typeof r.spec; params: Record<string, string> } => r.params !== null)
			// A literal segment wins over a parameter: the route with the fewest parameters.
			.sort((a, b) => Object.keys(a.params).length - Object.keys(b.params).length)[0];
		if (!found) return err(c, 404, "not_found", `${method} ${path.slice(0, 200)}: no active plugin serves it`);
		const client = c.get("client");
		if (!client.scopes.includes(found.spec.scope)) return err(c, 403, "forbidden", `token lacks the ${found.spec.scope} scope`);
		let body: unknown;
		const text = method === "GET" || method === "DELETE" ? "" : await c.req.text();
		if (text.trim()) try { body = JSON.parse(text); } catch { return err(c, 422, "invalid", "the body must be JSON"); }
		const failed = (message: string) => {
			console.log(JSON.stringify({ plugin: name, level: "error", message: redactor.text(`${method} ${path}: ${message}`), fields: {} }));
			return c.json({ code: "internal", message: "plugin error" }, 500);
		};
		let out: unknown;
		try {
			out = await found.spec.handler({ params: found.params, query: c.req.query(), body, principal: callerPrincipal(client), signal: c.req.raw.signal });
		} catch (e) {
			const status = e instanceof PluginError ? ROUTE_STATUS[e.code] : undefined;
			if (e instanceof PluginError && status) return err(c, status, e.code, e.message, e.hint ? { hint: e.hint } : {});
			return failed(e instanceof PluginError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e));
		}
		if (out === undefined) return c.body(null, 204);
		if (out instanceof Response || out instanceof ReadableStream || typeof out === "function")
			return failed("a route answers with a JSON value, never a Response or a stream (plugin API §4.7.3)");
		let json: string | undefined;
		try { json = JSON.stringify(out); } catch (e) { return failed(`its answer isn't JSON: ${(e as Error).message}`); }
		return c.body(json ?? "null", 200, { "content-type": "application/json" });
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
