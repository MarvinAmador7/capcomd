// ADR-021 phases 1-2: the provider surface for a place's details screen. GET /v1/sandboxes (each listed provider's
// descriptor and whether it's available), GET /v1/sandboxes/{name} (its settings and info rows as typed fields),
// PATCH /v1/sandboxes/{name}/settings (change a setting: checked here, stored in the user config, src/providers/settings.ts),
// GET /v1/sandboxes/{name}/resources[/{id}] (the machines capcomd's agents run on there, with the command that opens
// a shell in one). Settings and info are local reads (never a provider call); resources join capcomd's own records
// (which agent holds which machine) with the provider's list, asked at most every 10 s per provider, single-flight,
// with a 3 s timeout, answering with the last good list (`stale`) when it fails. Every string a client shows is
// written here from fixed templates: never a provider's error text, never a credential.
// Phase 3: POST /v1/sandboxes/{name}/resources/{id}/actions/delete (capability sandboxes.actions). An agent's machine
// is deleted by cancelling that agent (its lifecycle destroys the machine); an orphan by the provider. Bounded: the
// action comes from a closed list the provider declares, the id must be a machine capcomd lists there, the state is
// read again right before acting, and one action runs at a time per machine.
import { createHash } from "node:crypto";
import { redactShapes } from "../agents/redact";
import { env as envVar } from "../utils/env";
import { isoTs } from "./envelope";
import { SandboxConfigError } from "../providers/boxd-errors";
import { descriptorOf, isListedProvider, LISTED_PROVIDERS, POSTED_ACTIONS, PROVIDER_LABEL, PROVIDERS, RESOURCE_ACTIONS, SERVED_ACTIONS, type ListedProvider, type ProviderDescriptor, type ResourceAction } from "../providers/registry";
import { SandboxNotFoundError } from "../providers/boxd-errors";
import { beginMachineAction } from "../providers/machine-audit";
import { MACHINE_PREFIX, type VmInfo } from "../providers/sandbox";
import { ConfigFileError, currentIdleLifetime, IDLE_LIFETIME_DEFAULT, IDLE_LIFETIME_PRESETS, IDLE_LIFETIME_ENV, IDLE_LIFETIME_MIN, type IdleLifetime, type SettingsStore } from "../providers/settings";
/** What the Logins row reads of GET /v1/logins. */
export type LoginLike = { provider: "claude" | "codex"; sandbox: string; loggedIn: boolean; hostBound: boolean };

type Env = Record<string, string | undefined>;

// ---- Fields (ADR-021 §2): choice, toggle, info, status; every one has a daemon-written `display` ----
export type FieldType = "choice" | "toggle" | "info" | "status";
export interface Field {
	id: string;
	type: FieldType;
	label: string;
	help: string | null;
	value: string | null;
	display: string;
	default: string | null;
	choices: Array<{ value: string; label: string }>;
	/** Where the value comes from: default (the descriptor's), env (an environment variable wins), config (the user
	 *  config), daemon (an info row the daemon works out). */
	source: "default" | "env" | "config" | "daemon";
	editable: boolean;
	appliesTo: "new_runs" | null;
	needsRestart: boolean;
	/** A status row's dot: ok, warn, bad or none; null on every other type. */
	state: "ok" | "warn" | "bad" | "none" | null;
}
export interface Descriptor {
	name: string; descriptorVersion: number; label: string; kind: string; vendor: string; title: string; mark: string; listed: boolean;
	caps: ProviderDescriptor["caps"]; settings: string[]; info: string[]; resourceKinds: string[]; actions: string[];
}
export interface SandboxSummary extends Descriptor { available: boolean; reason: string | null; default: boolean }
export interface SandboxDetail { descriptor: Descriptor; settings: Field[]; info: Field[]; rev: string }

/** A descriptor as clients get it: its actions limited to the ones this daemon serves (open_terminal, delete). */
export function servedDescriptor(d: ProviderDescriptor): Descriptor {
	return {
		name: d.name, descriptorVersion: d.descriptorVersion, label: d.label, kind: d.kind, vendor: d.vendor, title: d.title, mark: d.mark, listed: d.listed,
		caps: { ...d.caps }, settings: [...d.settings], info: [...d.info], resourceKinds: [...d.resourceKinds],
		actions: d.actions.filter((a) => SERVED_ACTIONS.includes(a)),
	};
}

/** The idle lifetime presets, the same on every provider (ADR-021, decided 2026-10-27). */
export const IDLE_LIFETIME_CHOICES: ReadonlyArray<{ value: string; label: string }> = IDLE_LIFETIME_PRESETS.map((n) => ({ value: String(n), label: durationLabel(n) }));

/** "15 minutes", "1 hour", "90 seconds". */
export function durationLabel(seconds: number): string {
	const unit = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
	if (seconds > 0 && seconds % 3600 === 0) return unit(seconds / 3600, "hour");
	if (seconds > 0 && seconds % 60 === 0) return unit(seconds / 60, "minute");
	return unit(seconds, "second");
}

/**
 * The idle machine lifetime (ADR-021 §2): a lease a running agent renews every 10 minutes, so a machine left behind is
 * deleted this long after its last renewal. `life`: what applies now and where it comes from; `writable`: whether the
 * daemon can store a change (false while settings are off). An environment variable wins and makes it read-only.
 */
export function idleLifetimeField(d: ProviderDescriptor, life: IdleLifetime, writable = true): Field {
	const sweep = d.caps.idleLifetime === "sweep";
	const env = life.source === "env";
	return {
		id: "idleLifetime", type: "choice", label: "Delete idle machines after",
		help: sweep
			? "A container left behind (a crash, a stopped run) is deleted after this. capcomd checks every 5 minutes, so one can run up to 5 minutes over."
			: "A machine left behind (a crash, a stopped run) is deleted after this, so it stops billing.",
		value: String(life.seconds), display: env ? `Set by ${IDLE_LIFETIME_ENV} in capcomd's environment` : durationLabel(life.seconds),
		default: String(IDLE_LIFETIME_DEFAULT), choices: IDLE_LIFETIME_CHOICES.map((c) => ({ ...c })),
		source: life.source, editable: !env && writable, appliesTo: "new_runs", needsRestart: false, state: null,
	};
}

const AI_NAME: Record<LoginLike["provider"], string> = { claude: "Claude Code", codex: "Codex" };
/** The Logins row: a summary of GET /v1/logins?sandbox=name. "Bound" only when every logged-in login is bound to its
 *  AI's API host; otherwise it names the ones that aren't. */
export function loginsField(name: string, all: LoginLike[]): Field {
	const here = all.filter((l) => l.sandbox === name && l.loggedIn);
	const loose = here.filter((l) => !l.hostBound).map((l) => AI_NAME[l.provider]);
	const value = !here.length ? "none" : !loose.length ? "bound" : loose.length === here.length ? "unbound" : "partial";
	const display = value === "none" ? "No logins yet"
		: value === "bound" ? "Bound"
		: `${loose.join(" and ")} ${loose.length === 1 ? "isn't" : "aren't"} bound to ${loose.length === 1 ? "its" : "their"} API host`;
	const hostBound = descriptorOf(name)?.caps.hostBoundSecrets ?? false;
	return {
		id: "logins", type: "info", label: "Logins",
		help: hostBound
			? "A bound login is swapped in on the way to its AI's API, so agents only ever see a placeholder. Plan logins kept in the agent environment aren't bound."
			: "Logins here are kept in the agent environment or passed to the agent, so agents can read them.",
		value, display, default: null, choices: [], source: "daemon", editable: false, appliesTo: null, needsRestart: false, state: null,
	};
}

/** The Checkpoints row: git checkpoints by the in-VM supervisor (ADR-019 §3), the same on every provider. */
export function checkpointsField(source: Env = process.env): Field {
	const set = envVar("AGENT_CHECKPOINT_MS", source);
	const n = set === undefined || set.trim() === "" ? NaN : Number(set);
	const ms = Number.isFinite(n) && n >= 0 ? Math.floor(n) : 10 * 60_000;
	const secs = Math.round(ms / 1000);
	const every = secs <= 0 ? null : `every ${durationLabel(secs).replace(/^1 /, "")}`;
	return {
		id: "checkpoints", type: "info", label: "Checkpoints",
		help: "Agents save their work to a git checkpoint as they go, so a machine that's lost costs at most the work since the last one.",
		value: String(ms), display: every ? `After each commit and ${every}` : "After each commit", default: null, choices: [], source: "daemon",
		editable: false, appliesTo: null, needsRestart: false, state: null,
	};
}

/** GET /v1/sandboxes/{name}: null for a provider clients don't see. */
export function sandboxDetail(name: string, o: { env?: Env; logins: LoginLike[]; idleLifetime: IdleLifetime; writable?: boolean }): SandboxDetail | null {
	if (!isListedProvider(name)) return null;
	const d: ProviderDescriptor = PROVIDERS[name];
	const settings = d.settings.map((id) => (id === "idleLifetime" && d.caps.idleLifetime !== "none" ? idleLifetimeField(d, o.idleLifetime, o.writable ?? true) : null)).filter((f): f is Field => !!f);
	const info = d.info.map((id) => (id === "logins" ? loginsField(name, o.logins) : checkpointsField(o.env))).filter((f): f is Field => !!f);
	// rev: changes whenever a setting's value, source or editability does (PATCH …/settings checks it).
	const rev = createHash("sha256").update(JSON.stringify([d.descriptorVersion, settings.map((f) => [f.id, f.value, f.source, f.editable])])).digest("hex").slice(0, 16);
	return { descriptor: servedDescriptor(d), settings, info, rev };
}

// ---- PATCH /v1/sandboxes/{name}/settings (ADR-021 §2, §4; capability sandboxes.settings) ----
export interface SettingsPatch { values: Record<string, unknown>; rev: string }
export interface SettingChange { id: string; from: string | null; to: string }
export type SettingsOutcome =
	| { ok: true; detail: SandboxDetail; changes: SettingChange[] }
	| { ok: false; status: 404 | 409 | 422; code: "not_found" | "conflict" | "invalid"; message: string; rev?: string };

/** The body as sent, or why it isn't one: `{values: {id: value}, rev}`. */
export function parseSettingsPatch(raw: unknown): SettingsPatch | string {
	const shape = "body must be {values: {id: value}, rev} (rev from GET /v1/sandboxes/{name})";
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return shape;
	const b = raw as Record<string, unknown>;
	if (typeof b.rev !== "string" || !b.rev || b.rev.length > 200) return shape;
	if (!b.values || typeof b.values !== "object" || Array.isArray(b.values)) return shape;
	const keys = Object.keys(b.values);
	if (!keys.length) return "values must name at least one setting";
	if (keys.length > 16) return "values names too many settings";
	return { values: b.values as Record<string, unknown>, rev: b.rev };
}

/**
 * Checks a change against the place's fields as they are now, without writing anything: the rev must be the current
 * one (409 conflict), and every value must be a setting this place has (422), editable here (422: an environment
 * variable sets it), one of its choices and, for the idle lifetime, at least 15 minutes (422). The messages are
 * daemon-written and name only trusted things (setting ids are echoed only once known).
 */
export function checkSettingsPatch(detail: SandboxDetail, patch: SettingsPatch): { ok: true; writes: Array<{ field: Field; value: string }> } | Extract<SettingsOutcome, { ok: false }> {
	const bad = (message: string) => ({ ok: false as const, status: 422 as const, code: "invalid" as const, message });
	const writes: Array<{ field: Field; value: string }> = [];
	for (const [id, raw] of Object.entries(patch.values)) {
		const field = detail.settings.find((f) => f.id === id);
		if (!field) {
			const known = detail.settings.map((f) => f.id);
			return bad(`${/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(id) ? `"${id}" isn't` : "that isn't"} a setting of ${detail.descriptor.name}${known.length ? ` (its settings: ${known.join(", ")})` : " (it has none)"}`);
		}
		if (!field.editable) {
			return bad(field.source === "env" && field.id === "idleLifetime"
				? `${field.label} is set by ${IDLE_LIFETIME_ENV} in capcomd's environment, so it can't be changed here`
				: `${field.label} can't be changed here`);
		}
		const value = typeof raw === "string" ? raw.trim() : typeof raw === "number" && Number.isFinite(raw) ? String(raw) : null;
		if (value === null) return bad(`${id}: send one of its choices' values as a string (${field.choices.map((c) => `"${c.value}"`).join(", ")})`);
		if (field.id === "idleLifetime" && /^\d+$/.test(value) && Number(value) < IDLE_LIFETIME_MIN) {
			return bad(`${field.label}: ${durationLabel(Number(value) || 0)} is under the ${IDLE_LIFETIME_MIN / 60}-minute minimum (a running agent renews its machine every 10 minutes)`);
		}
		const choice = field.choices.find((c) => c.value === value);
		if (!choice) return bad(`${field.label}: use one of ${field.choices.map((c) => `${c.value} (${c.label})`).join(", ")}`);
		writes.push({ field, value });
	}
	if (patch.rev !== detail.rev) return { ok: false, status: 409, code: "conflict", message: "These settings changed since you read them: read them again (GET /v1/sandboxes/{name}) and send the new rev", rev: detail.rev };
	return { ok: true, writes };
}

// ---- Resources (ADR-021 §3) ----
export type ResourceState = "starting" | "running" | "asleep" | "orphaned" | "stopping" | "unknown";
/** Who uses a machine (capcomd's own records): an agent, or capcomd itself for a short job (ADR-021 §3). */
export const OWNER_KINDS = ["agent", "check", "login", "env_build", "doctor"] as const;
export type OwnerKind = (typeof OWNER_KINDS)[number];
export interface ResourceOwner {
	/** agent: an agent's machine (run, agent, role = its profile, task). check: a run's checks (verify). login:
	 *  `capcomd auth login` or `auth status`. env_build: `capcomd env build`. doctor: `capcomd env doctor`. */
	kind: OwnerKind;
	runId: string | null; agentId: string | null; role: string | null; task: string | null;
	/** A daemon-written line for capcomd's own machines ("Checks for run-8kq2", "Logging in to Claude Code"); null for agents. */
	label: string | null;
}
export interface Resource {
	id: string; kind: "machine"; state: ResourceState; owner: ResourceOwner | null;
	createdAt: string | null; deleteAfter: string | null; actions: string[];
	/** An action on it can't be undone (delete): the app asks first, with `confirm`. */
	destructive: boolean;
	/** What the app asks before a destructive action, written here from fixed templates; null without one. */
	confirm: string | null;
}
export interface ResourcePage { resources: Resource[]; asOf: string | null; stale: boolean; error: string | null; next: string | null }
export interface ResourceDetail extends Resource { terminalCommand: string | null }

/** A machine capcomd's records say is in use right now: an agent's (its worker actor), or one of capcomd's own short
 *  jobs (checks, logins, environment builds: the machines ledger, src/providers/machines.ts). */
export interface MachineOwner {
	/** The provider it was made on (the run's own sandbox, else the daemon's). */
	sandbox: string;
	/** The provider's id for it (worker context vmId); null when only its name is known. */
	vmId: string | null;
	/** Its name (capcomd's prefix + a hash of its idempotency key); null when unknown. */
	name: string | null;
	/** Default agent. */
	kind?: OwnerKind;
	runId: string | null; agentId: string | null; role: string | null; task: string | null;
	label?: string | null;
	/** The worker's lifecycle state: provisioning, idle, busy, draining (capcomd's own jobs: busy). */
	workerState: string;
	createdAt: number | null;
	/** An agent's live descendants (pending, running, paused): cancelling the agent stops them too. */
	descendants?: number;
}

/** Ids capcomd ever hands out or accepts for a machine: no shell metacharacters, no spaces, no quotes. */
export const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;
/** A machine id clients may name: safe characters and capcomd's prefix. */
export const isMachineId = (id: string) => SAFE_ID.test(id) && id.startsWith(MACHINE_PREFIX);

/** The first line of an agent's task, redacted and cut to 200 characters (agent- or user-written: untrusted). */
export function taskLine(task: unknown): string | null {
	if (typeof task !== "string") return null;
	const line = redactShapes(task).split("\n").map((l) => l.trim()).find(Boolean);
	if (!line) return null;
	return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

/** How many of `live` descend from `agentId` (parent links). */
export function liveDescendants(live: Array<{ agentId: string; parent?: string | null }>, agentId: string): number {
	const byId = new Map(live.map((a) => [a.agentId, a]));
	let n = 0;
	for (const a of live) {
		const seen = new Set<string>();
		for (let p = a.parent ?? null; p && !seen.has(p); p = byId.get(p)?.parent ?? null) {
			seen.add(p);
			if (p === agentId) { n++; break; }
		}
	}
	return n;
}

/** "Add an abs(a) function to math.ts…": a task line cut at a word to about 40 characters, for a question. */
function shortTask(t: string): string {
	if (t.length <= 40) return t;
	const cut = t.slice(0, 40);
	const at = cut.lastIndexOf(" ");
	return `${(at >= 20 ? cut.slice(0, at) : cut).replace(/[\s.,;:–—-]+$/, "")}…`;
}

/**
 * What the app asks before a Delete (ADR-021 question 6): for an agent's machine it names the agent and says the work
 * since its last checkpoint is lost ("Delete worker's machine? This stops the worker on “Add an abs(a) function…”.
 * Work since its last checkpoint is lost."); for one left behind, that no agent uses it. Fixed templates around
 * trusted ids and the agent's task line (already redacted and cut).
 */
export function deleteConfirm(o: Pick<MachineOwner, "role" | "agentId" | "task" | "descendants"> | null): string {
	if (!o) return "Delete this machine? No agent is using it.";
	const role = o.role && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(o.role) ? o.role : null;
	const who = role ?? (o.agentId && SAFE_ID.test(o.agentId) ? o.agentId : "this agent");
	const the = role ? `the ${role}` : who;
	const task = o.task ? ` on “${shortTask(o.task)}”` : "";
	const n = o.descendants ?? 0;
	const kids = n > 0 ? ` and ${n === 1 ? "the agent" : `the ${n} agents`} it started` : "";
	return `Delete ${who}'s machine? This stops ${the}${task}${kids}. Work since ${n > 0 ? "their last checkpoints" : "its last checkpoint"} is lost.`;
}

const STARTING = new Set(["created", "creating", "starting", "pending", "booting", "provisioning", "restarting"]);
const STOPPING = new Set(["stopping", "removing", "deleting", "destroying"]);
function providerState(s: string): ResourceState {
	const v = s.toLowerCase();
	return v === "running" ? "running" : STARTING.has(v) ? "starting" : STOPPING.has(v) ? "stopping" : "unknown";
}

/**
 * capcomd's records joined with the provider's list. A listed machine with an owner takes the owner's run, agent and
 * role; one with capcomd's prefix and no live owner is `orphaned` (a machine left behind), or `unknown` while capcomd's
 * records can't be read. An owned machine the provider doesn't list yet is `starting` while its worker provisions;
 * without any list (the provider never answered) owned machines show as `unknown`. Sorted by id.
 */
export function joinResources(name: string, rows: VmInfo[] | null, owners: MachineOwner[] | null): Resource[] {
	const d = descriptorOf(name);
	const serves = (a: ResourceAction) => !!d?.actions.includes(a) && SERVED_ACTIONS.includes(a);
	// capcomd's own short jobs (checks, logins, environment builds) get no actions: nothing may stop them from here,
	// and a login's machine holds a credential while it runs.
	const actions = (state: ResourceState, o?: MachineOwner) => {
		const out: string[] = [];
		const agent = !!o && (o.kind ?? "agent") === "agent";
		const settled = state !== "starting" && state !== "stopping";
		if ((agent || !o) && settled && d?.caps.shell && serves("open_terminal")) out.push("open_terminal");
		// Delete: an agent's machine (cancels the agent; needs its run and id), or one left behind (orphaned: capcomd's
		// records were read and nothing owns it). Never while it starts or stops, nor when ownership is unknown.
		if (serves("delete") && settled && (agent ? !!o!.runId && !!o!.agentId : state === "orphaned")) out.push("delete");
		return out;
	};
	const shaped = (r: Omit<Resource, "destructive" | "confirm">, o?: MachineOwner): Resource => {
		const del = r.actions.includes("delete");
		return { ...r, destructive: del, confirm: del ? deleteConfirm(o ?? null) : null };
	};
	const mine = (owners ?? []).filter((o) => o.sandbox === name);
	const byVm = new Map(mine.filter((o) => o.vmId).map((o) => [o.vmId!, o]));
	const byName = new Map(mine.filter((o) => o.name).map((o) => [o.name!, o]));
	const ts = (n: number | null | undefined) => (typeof n === "number" && Number.isFinite(n) ? isoTs(n) : null);
	const ownerOf = (o: MachineOwner): ResourceOwner => ({ kind: o.kind ?? "agent", runId: o.runId, agentId: o.agentId, role: o.role, task: o.task, label: o.label ?? null });
	const out = new Map<string, Resource>();
	const used = new Set<MachineOwner>();
	for (const r of rows ?? []) {
		if (!isMachineId(r.name)) continue;
		const o = byVm.get(r.id) ?? byName.get(r.name);
		let state: ResourceState;
		if (o) {
			used.add(o);
			state = o.workerState === "draining" ? "stopping" : o.workerState === "provisioning" ? "starting" : providerState(r.state);
		} else state = owners === null ? "unknown" : providerState(r.state) === "stopping" ? "stopping" : "orphaned";
		out.set(r.name, shaped({ id: r.name, kind: "machine", state, owner: o ? ownerOf(o) : null, createdAt: ts(r.createdAt ?? o?.createdAt), deleteAfter: ts(r.deleteAt), actions: actions(state, o) }, o));
	}
	for (const o of mine) {
		if (used.has(o) || !o.name || !isMachineId(o.name) || out.has(o.name)) continue;
		const state: ResourceState | null = o.workerState === "provisioning" ? "starting" : rows === null ? "unknown" : null;
		if (!state) continue; // the provider listed its machines and this one isn't there: gone
		out.set(o.name, shaped({ id: o.name, kind: "machine", state, owner: ownerOf(o), createdAt: ts(o.createdAt), deleteAfter: null, actions: actions(state, o) }, o));
	}
	return [...out.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * The command that opens a shell in a resource, built only from trusted ids (never a provider string): the agent's
 * run and id for an owned machine, else the place and the machine's id. Every word passes the app's safe-command rule
 * (a plain `capcomd …` invocation: no quotes, `$`, `;`, `&`, `|`, redirections or backticks). null when it has no
 * shell action.
 */
export function terminalCommandFor(name: string, r: Resource): string | null {
	if (!r.actions.includes("open_terminal") || !isListedProvider(name) || !isMachineId(r.id)) return null;
	if (r.owner && r.owner.kind !== "agent") return null;
	if (r.owner?.runId && r.owner.agentId && SAFE_ID.test(r.owner.runId) && SAFE_ID.test(r.owner.agentId)) return `capcomd sandbox shell ${r.owner.runId} ${r.owner.agentId}`;
	return `capcomd sandbox shell --sandbox ${name} --machine ${r.id}`;
}

/** A provider list error as a daemon-written sentence (never the provider's own text, which can carry anything). */
function listError(name: string, e: unknown): string {
	const who = descriptorOf(name)?.vendor ?? name;
	if ((e as { timeout?: boolean })?.timeout) return `${who} didn't answer within ${LIST_TIMEOUT_MS / 1000} seconds`;
	if (e instanceof SandboxConfigError) return `${who} isn't set up or isn't reachable (run capcomd setup check)`;
	return `${who} couldn't list its machines`;
}

export const LIST_TTL_MS = 10_000;
export const LIST_TIMEOUT_MS = 3_000;
const OWNERS_TIMEOUT_MS = 10_000;
/** An action reads the machine again right before acting: the provider's list and capcomd's records, within this. */
export const ACTION_LOOKUP_TIMEOUT_MS = 10_000;
/** How long an action waits for its effect (the provider's delete; an agent's cancel, which destroys its machine). */
export const ACTION_TIMEOUT_MS = 30_000;

function within<T>(p: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([p, new Promise<T>((_, no) => { timer = setTimeout(() => no(Object.assign(new Error("timed out"), { timeout: true })), ms); })]).finally(() => clearTimeout(timer));
}

export interface ResourceDeps {
	/** The provider's machines with capcomd's prefix (`provider.list(MACHINE_PREFIX)`). */
	list(name: ListedProvider): Promise<VmInfo[]>;
	/** Machines capcomd's live agents hold (all providers). */
	owners(): Promise<MachineOwner[]>;
	now?: () => number;
	ttlMs?: number;
	timeoutMs?: number;
	/** Deletes a machine at the provider (`provider.destroy` with its provider id): an orphan's Delete. */
	destroy?(name: ListedProvider, vmId: string): Promise<void>;
	/** Cancels one agent through the normal cancel path (as POST …/cancel and `capcomd cancel <run> <agt>`: agent.cancelled,
	 *  and its lifecycle destroys its machine): an owned machine's Delete. `changed`: this call cancelled it. */
	cancelAgent?(runId: string, agentId: string, by: string): Promise<{ changed: boolean }>;
	lookupTimeoutMs?: number;
	actionTimeoutMs?: number;
}

// ---- Actions (ADR-021 §3, §5; capability sandboxes.actions) ----
export type ActionOutcome =
	| { ok: true; resource: Resource | null; changed: boolean; owner: ResourceOwner | null }
	| { ok: false; status: 404 | 409 | 503; code: "not_found" | "conflict" | "unavailable"; message: string };

const ownerKey = (r: Resource) => (r.owner ? `${r.owner.kind}|${r.owner.runId ?? ""}|${r.owner.agentId ?? ""}` : "none");
/** Why a machine can't take an action now (a 409's sentence), from what capcomd knows of it. */
function refusal(r: Resource): string {
	if (r.owner && r.owner.kind !== "agent") return `capcomd is using this machine itself (${r.owner.label ?? r.owner.kind}) and deletes it when that's done.`;
	if (r.state === "starting") return "This machine is still starting, so it can't be deleted yet.";
	if (r.state === "stopping") return "This machine is already being deleted.";
	if (r.state === "unknown" || !r.owner) return "capcomd can't tell right now whether an agent uses this machine, so it won't delete it. Try again in a moment.";
	return "This machine can't be deleted right now.";
}
/** Who uses a machine now, for "changed since you looked". */
function userNow(r: Resource): string {
	if (!r.owner) return "no agent is using it now";
	if (r.owner.kind !== "agent") return `capcomd is using it now (${r.owner.label ?? r.owner.kind})`;
	const id = r.owner.agentId && SAFE_ID.test(r.owner.agentId) ? ` ${r.owner.agentId}` : "";
	return `${r.owner.role ? `the ${r.owner.role}` : "an agent"}${id} is using it now`;
}

/** The resources half of the surface: one cache per provider, refreshed at most every ttlMs, one refresh at a time. */
export function resourceCatalog(deps: ResourceDeps) {
	const now = deps.now ?? Date.now;
	const ttl = deps.ttlMs ?? LIST_TTL_MS;
	const timeout = deps.timeoutMs ?? LIST_TIMEOUT_MS;
	type Entry = { triedAt: number; inflight: Promise<void> | null; rows: VmInfo[] | null; asOf: number | null; owners: MachineOwner[] | null; error: string | null };
	const cache = new Map<string, Entry>();
	let lastOwners: MachineOwner[] | null = null;
	const refresh = (name: ListedProvider, e: Entry) => {
		e.triedAt = now();
		e.inflight = (async () => {
			const [rows, owners] = await Promise.allSettled([within(Promise.resolve().then(() => deps.list(name)), timeout), within(Promise.resolve().then(() => deps.owners()), OWNERS_TIMEOUT_MS)]);
			if (owners.status === "fulfilled") lastOwners = owners.value;
			e.owners = owners.status === "fulfilled" ? owners.value : lastOwners;
			if (rows.status === "fulfilled") { e.rows = rows.value; e.asOf = now(); e.error = null; }
			else e.error = listError(name, rows.reason);
		})().finally(() => { e.inflight = null; });
		return e.inflight;
	};
	const current = async (name: ListedProvider) => {
		let e = cache.get(name);
		if (!e) { e = { triedAt: 0, inflight: null, rows: null, asOf: null, owners: null, error: null }; cache.set(name, e); }
		if (e.inflight) await e.inflight;
		else if (now() - e.triedAt >= ttl) await refresh(name, e);
		return { resources: joinResources(name, e.rows, e.owners), asOf: e.asOf, stale: e.error !== null, error: e.error };
	};
	const lookupTimeout = deps.lookupTimeoutMs ?? ACTION_LOOKUP_TIMEOUT_MS;
	const actionTimeout = deps.actionTimeoutMs ?? ACTION_TIMEOUT_MS;
	/** Machines with an action under way (place + id): one at a time each. */
	const acting = new Set<string>();
	const entryOf = (name: ListedProvider) => {
		let e = cache.get(name);
		if (!e) { e = { triedAt: 0, inflight: null, rows: null, asOf: null, owners: null, error: null }; cache.set(name, e); }
		return e;
	};
	/**
	 * The machine as it is now, for an action: the provider's list and capcomd's records, both fresh (never the cache,
	 * never the last good owners: acting on a guess could delete a machine an agent just took). Stored in the cache too,
	 * so the next read shows it. Throws a 503 outcome when either doesn't answer.
	 */
	const lookup = async (name: ListedProvider): Promise<{ rows: VmInfo[]; owners: MachineOwner[] }> => {
		const e = entryOf(name);
		if (e.inflight) await e.inflight.catch(() => {});
		const who = descriptorOf(name)?.vendor ?? name;
		const [rows, owners] = await Promise.allSettled([within(Promise.resolve().then(() => deps.list(name)), lookupTimeout), within(Promise.resolve().then(() => deps.owners()), lookupTimeout)]);
		if (rows.status === "rejected") {
			const late = (rows.reason as { timeout?: boolean })?.timeout;
			throw unavailable(late ? `${who} didn't answer within ${lookupTimeout / 1000} seconds, so nothing was deleted. Try again in a moment.` : `${who} couldn't list its machines, so nothing was deleted. Try again in a moment.`);
		}
		if (owners.status === "rejected") throw unavailable("capcomd couldn't read which agents use its machines, so nothing was deleted. Try again in a moment.");
		lastOwners = owners.value;
		Object.assign(e, { triedAt: now(), rows: rows.value, asOf: now(), owners: owners.value, error: null });
		return { rows: rows.value, owners: owners.value };
	};
	const unavailable = (message: string) => Object.assign(new Error(message), { outcome: { ok: false as const, status: 503 as const, code: "unavailable" as const, message } });
	return {
		/**
		 * POST …/resources/{id}/actions/{action}: today only delete. `by` names the client (client:<id>), as run controls do.
		 * An agent's machine: that agent is cancelled through the normal cancel path, and its lifecycle destroys the
		 * machine (the provider is never called for it here). An orphan: the provider deletes it. A machine of capcomd's
		 * own jobs: 409. The id must be a machine capcomd lists at this place; the machine is read again just before
		 * acting (409 when who uses it changed; already gone: 200 with changed false).
		 */
		async act(name: string, id: string, action: string, by: string): Promise<ActionOutcome> {
			const fail = (status: 404 | 409 | 503, message: string): ActionOutcome => ({ ok: false, status, code: status === 404 ? "not_found" : status === 409 ? "conflict" : "unavailable", message });
			if (!isListedProvider(name)) return fail(404, `sandbox ${name.slice(0, 64)} not found`);
			const d = PROVIDERS[name] as ProviderDescriptor;
			const known = (RESOURCE_ACTIONS as readonly string[]).includes(action) ? (action as ResourceAction) : null;
			if (!known) return fail(404, `${/^[a-z_]{1,32}$/.test(action) ? action : "that"} isn't an action on machines (actions: ${POSTED_ACTIONS.join(", ")})`);
			if (!POSTED_ACTIONS.includes(known)) return fail(404, `${known} isn't posted: GET /v1/sandboxes/{name}/resources/{id} for its terminalCommand`);
			if (!d.actions.includes(known) || !SERVED_ACTIONS.includes(known)) return fail(404, `${d.vendor} machines have no ${known} action`);
			const place = PROVIDER_LABEL[name];
			if (!isMachineId(id)) return fail(404, `${SAFE_ID.test(id) ? `machine ${id}` : "that machine"} isn't one of capcomd's machines on ${place}`);
			const seen = (await current(name)).resources.find((r) => r.id === id);
			if (!seen) return fail(404, `machine ${id} isn't one of capcomd's machines on ${place}`);
			if (!seen.actions.includes(known)) return fail(409, refusal(seen));
			const k = `${name}\u0000${id}`;
			if (acting.has(k)) return fail(409, "Another Delete of this machine is still under way.");
			acting.add(k);
			try {
				let fresh: { rows: VmInfo[]; owners: MachineOwner[] };
				try { fresh = await lookup(name); } catch (e) { const o = (e as { outcome?: ActionOutcome }).outcome; if (o) return o; throw e; }
				const now_ = joinResources(name, fresh.rows, fresh.owners).find((r) => r.id === id);
				// Gone already (deleted by its idle lifetime, its agent's end, or someone else): nothing left to do.
				if (!now_) { entryOf(name).triedAt = 0; return { ok: true, resource: null, changed: false, owner: seen.owner }; }
				if (ownerKey(now_) !== ownerKey(seen)) return fail(409, `This machine changed since you looked: ${userNow(now_)}. Look again before deleting it.`);
				if (!now_.actions.includes(known)) return fail(409, refusal(now_));
				const claim = beginMachineAction(name, id);
				const who = d.vendor;
				const secs = actionTimeout / 1000;
				const o = now_.owner;
				try {
					if (o) {
						if (!deps.cancelAgent) { claim.cancel(); return fail(503, "This daemon can't stop agents from here, so nothing was deleted."); }
						const r = await within(Promise.resolve().then(() => deps.cancelAgent!(o.runId!, o.agentId!, by)), actionTimeout);
						if (!r.changed) { claim.cancel(); return fail(409, `${o.agentId} has already ended, so this machine is no longer its own. Look again in a moment.`); }
					} else {
						const row = fresh.rows.find((r) => r.name === id);
						if (!row || !deps.destroy) { claim.cancel(); return fail(503, `capcomd can't delete ${who} machines from here, so nothing was deleted.`); }
						try { await within(Promise.resolve().then(() => deps.destroy!(name, row.id)), actionTimeout); } catch (e) {
							if (e instanceof SandboxNotFoundError) { claim.cancel(); entryOf(name).triedAt = 0; return { ok: true, resource: null, changed: false, owner: null }; }
							throw e;
						}
					}
				} catch (e) {
					if ((e as { timeout?: boolean })?.timeout) {
						claim.gaveUp();
						entryOf(name).triedAt = 0;
						return fail(503, o ? `capcomd asked ${o.agentId} to stop, but ${who} didn't confirm its machine was deleted within ${secs} seconds. Look again in a moment.` : `${who} didn't answer within ${secs} seconds. Look again in a moment: the machine may still be deleted.`);
					}
					claim.cancel();
					return fail(503, o ? `capcomd couldn't stop ${o.agentId} just now, so nothing was deleted. Try again in a moment.` : `${who} couldn't delete the machine just now. Try again in a moment.`);
				}
				claim.done();
				entryOf(name).triedAt = 0;
				return { ok: true, resource: { ...now_, state: "stopping", actions: [], destructive: false, confirm: null }, changed: true, owner: o };
			} finally { acting.delete(k); }
		},
		/** One page: `limit` (≤ 200, default 100) resources after `cursor` (the last id of the previous page). */
		async page(name: string, o: { limit?: number; cursor?: string } = {}): Promise<ResourcePage | null> {
			if (!isListedProvider(name)) return null;
			const c = await current(name);
			const limit = Math.max(1, Math.min(o.limit ?? 100, 200));
			const after = o.cursor ? c.resources.filter((r) => r.id > o.cursor!) : c.resources;
			const page = after.slice(0, limit);
			return { resources: page, asOf: c.asOf !== null ? isoTs(c.asOf) : null, stale: c.stale, error: c.error, next: after.length > page.length ? page.at(-1)!.id : null };
		},
		/** One resource and the command that opens a shell in it; null when capcomd doesn't list it. */
		async get(name: string, id: string): Promise<ResourceDetail | null> {
			if (!isListedProvider(name) || !isMachineId(id)) return null;
			const r = (await current(name)).resources.find((x) => x.id === id);
			return r ? { ...r, terminalCommand: terminalCommandFor(name, r) } : null;
		},
		reset() { cache.clear(); lastOwners = null; },
	};
}

// ---- The whole surface, as a HarnessSource implements it ----
export interface SurfaceDeps extends ResourceDeps {
	/** capcomd's environment (CAPCOMD_SANDBOX_IDLE_SECONDS, CAPCOMD_AGENT_CHECKPOINT_MS); default process.env. */
	env?: Env;
	/** GET /v1/logins (all places): the Logins info row summarizes it. */
	logins(): Promise<LoginLike[]>;
	/** Whether a listed place can be used now and is the daemon's default (as GET /v1/run-options says). */
	availability(name: ListedProvider): Promise<{ available: boolean; reason: string | null; default: boolean }>;
	/** Where provider settings are kept (the user config). */
	settings: SettingsStore;
}
export function sandboxSurface(deps: SurfaceDeps) {
	const catalog = resourceCatalog(deps);
	const env = () => deps.env ?? process.env;
	const detail = async (name: ListedProvider) => sandboxDetail(name, { env: env(), logins: await deps.logins(), idleLifetime: currentIdleLifetime(name, { env: env(), store: deps.settings }), writable: deps.settings.writable() })!;
	return {
		sandboxes: async (): Promise<SandboxSummary[]> => Promise.all(LISTED_PROVIDERS.map(async (n) => ({ ...servedDescriptor(PROVIDERS[n]), ...(await deps.availability(n)) }))),
		sandbox: async (name: string): Promise<SandboxDetail | null> => (isListedProvider(name) ? detail(name) : null),
		/**
		 * PATCH /v1/sandboxes/{name}/settings: checks the change against the fields as they are now and stores it in the
		 * user config. The check and the write run with no await between them, so two requests with the same rev can't
		 * both pass. `changes` lists what really changed (a value sent as it already was isn't a change).
		 */
		updateSandboxSettings: async (name: string, patch: SettingsPatch): Promise<SettingsOutcome> => {
			if (!isListedProvider(name)) return { ok: false, status: 404, code: "not_found", message: `sandbox ${name.slice(0, 64)} not found` };
			const logins = await deps.logins();
			const build = () => sandboxDetail(name, { env: env(), logins, idleLifetime: currentIdleLifetime(name, { env: env(), store: deps.settings }), writable: deps.settings.writable() })!;
			const before = build();
			const checked = checkSettingsPatch(before, patch);
			if (!checked.ok) return checked;
			const changes: SettingChange[] = [];
			for (const w of checked.writes) {
				// A value stored as the field shows it now (from the default or the config) is still written, so the
				// choice is the user's from now on; it's a change only when the value differs.
				try { deps.settings.write(name, w.field.id as "idleLifetime", Number(w.value)); } catch (e) {
					if (e instanceof ConfigFileError) return { ok: false, status: 422, code: "invalid", message: e.message };
					throw e;
				}
				if (w.field.value !== w.value) changes.push({ id: w.field.id, from: w.field.value, to: w.value });
			}
			return { ok: true, detail: build(), changes };
		},
		sandboxResources: (name: string, o: { limit?: number; cursor?: string } = {}) => catalog.page(name, o),
		sandboxResource: (name: string, id: string) => catalog.get(name, id),
		sandboxAction: (name: string, id: string, action: string, by: string) => catalog.act(name, id, action, by),
	};
}
export type SandboxSurface = ReturnType<typeof sandboxSurface>;
