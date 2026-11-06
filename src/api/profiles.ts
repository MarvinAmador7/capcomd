// GET /v1/profiles (capability profiles; ADR-024 §5): every agent profile a run of the daemon, or of a project (`repo`),
// can use, as `capcomd profiles list --json` lists them: where each was found and the files laid together to make it,
// what it does, and whether its login is there. GET and PUT /v1/profiles/{name} (capability profiles.edit; ADR-024 §3,
// §7 step 6): one profile as the rows a client edits, and a change to them in the profile's own file (./write.ts).
// Local files only.
import type { z } from "zod";
import { AgentConfigError, agentsFilePath, editOf, editProfile, PROFILE_FIELDS, profileFields, profileLayers, profileRev, profileRow, profileRows, ProfileWriteError, readProfiles, type ProfileChange, type ProfileSet, type ResolvedProfile } from "../profiles";
import { readiness } from "../cli/commands/profiles";
import type { ProfileDetail, Profiles, ProfileSummary, ProfileWritten } from "./contract";

type Env = Record<string, string | undefined>;

function summaryOf(set: ProfileSet, p: ResolvedProfile, source: Env): z.infer<typeof ProfileSummary> {
	const r = profileRow(p, set.default === p.name);
	const ready = readiness(r.name, p.spec, source);
	return {
		name: r.name, version: r.version, source: r.source, format: r.format, path: r.path, default: r.default, description: r.description ?? null, tags: r.tags,
		provider: r.provider, auth: r.auth, model: r.model, effort: r.effort, toolMode: r.toolMode, canSpawn: r.canSpawn, canLead: r.canLead, does: r.does,
		ready: ready.ready, readiness: ready.detail, applied: r.applied,
	};
}

/** The profiles a run with this environment sees (its CAPCOMD_AGENTS_FILE and CAPCOMD_HOME). */
export function profilesOf(source: Env = process.env): z.infer<typeof Profiles> {
	const file = agentsFilePath(source);
	const layers = profileLayers(file, source);
	let set: ReturnType<typeof readProfiles>;
	try { set = readProfiles(file, source); } catch (e) {
		if (e instanceof AgentConfigError) return { file, layers, default: null, profiles: [], warnings: [], error: e.message };
		throw e;
	}
	return { file, layers, default: set.default ?? null, profiles: profileRows(set).map((r) => summaryOf(set, set.profiles[r.name]!, source)), warnings: set.warnings, error: null };
}

/** The environment of GET /v1/profiles?repo=: a project's, as POST /v1/runs with that `repo` resolves its profiles
 *  (CreateRunError, a 422, when it isn't a project); the daemon's own without one. */
async function sourceFor(repo: string | undefined, base: Env): Promise<Env> {
	if (repo === undefined) return base;
	const { projectSource } = await import("./create-run");
	return projectSource(repo, base);
}

/** GET /v1/profiles?repo=. */
export async function profilesFor(repo: string | undefined, base: Env = process.env): Promise<z.infer<typeof Profiles>> {
	return profilesOf(await sourceFor(repo, base));
}

/** A refusal of GET or PUT /v1/profiles/{name}, as the route answers it. */
export type ProfileRefusal = { ok: false; status: 404 | 409 | 422; code: string; message: string; field?: string; rev?: string };
const refused = (status: ProfileRefusal["status"], code: string, message: string, extra: { field?: string; rev?: string } = {}): ProfileRefusal => ({ ok: false, status, code, message, ...extra });

function detailOf(set: ProfileSet, p: ResolvedProfile, source: Env): z.infer<typeof ProfileDetail> {
	const own = p.applied.find((a) => a.as === "profile");
	// Its own warnings: a block not used yet, an agents.json entry it hides, an override of it that doesn't apply.
	const mine = (w: string) => w.includes(`profiles.${p.name}:`) || w.includes(`agents.${p.name} is hidden`) || w.includes(` profile ${p.name} (`);
	return { profile: summaryOf(set, p, source), fields: profileFields(p), rev: profileRev(p), writesTo: own?.path ?? null, warnings: set.warnings.filter(mine) };
}

export type ProfileLookup = { ok: true; detail: z.infer<typeof ProfileDetail> } | ProfileRefusal;
export type ProfileUpdate = { ok: true; detail: z.infer<typeof ProfileWritten>; event: ProfileChangedEvent | null } | ProfileRefusal;

/** GET /v1/profiles/{name}?repo=: one profile as rows, or why not (404 unknown, 422 the profiles can't be read). */
export async function profileFor(name: string, repo: string | undefined, base: Env = process.env): Promise<ProfileLookup> {
	const source = await sourceFor(repo, base);
	let set: ProfileSet;
	try { set = readProfiles(agentsFilePath(source), source); } catch (e) {
		if (e instanceof AgentConfigError) return refused(422, "invalid", `the profiles can't be read: ${e.message}`);
		throw e;
	}
	const p = Object.hasOwn(set.profiles, name) ? set.profiles[name]! : undefined;
	return p ? { ok: true, detail: detailOf(set, p, source) } : refused(404, "not_found", `profile "${name}" not found`);
}

const FIELD = new Map(PROFILE_FIELDS.map((f) => [f.id, f]));
/** A changed value in the rows' encoding (null: unset, a prompt, or a value outside the rows). */
function encoded(path: string, v: unknown): string | null {
	const f = FIELD.get(path);
	if (!f || f.prompt || v === undefined || v === null) return null;
	return typeof v === "string" ? v : JSON.stringify(v);
}
export const changesOf = (changes: ProfileChange[]) => changes.map((c) => ({ path: c.path, from: encoded(c.path, c.from), to: encoded(c.path, c.to) }));

/** A value the event's text may say: capcomd's own words (a number, a toggle, a choice) or a name; never a file's free text. */
const SAYABLE = /^[A-Za-z0-9][A-Za-z0-9._:@\[\]*-]{0,63}$/;
function say(path: string, v: unknown): string | null {
	const f = FIELD.get(path);
	if (!f || f.prompt || f.untrusted) return null;
	if (v === undefined || v === null) return "unset";
	if (typeof v === "number" || typeof v === "boolean") return String(v);
	if (typeof v === "string") return SAYABLE.test(v) ? v : null;
	if (Array.isArray(v) && v.length <= 6 && v.every((x) => typeof x === "string" && SAYABLE.test(x))) return `[${v.join(", ")}]`;
	return null;
}
/** profile.changed's text, daemon-written: "Profile reviewer changed: limits.maxTurns 20 → 40." */
export function profileChangedText(name: string, changes: ProfileChange[]): string {
	const parts = changes.slice(0, 5).map((c) => { const a = say(c.path, c.from), b = say(c.path, c.to); return a !== null && b !== null ? `${c.path} ${a} → ${b}` : `${c.path} changed`; });
	const more = changes.length > 5 ? `, and ${changes.length - 5} more` : "";
	return `Profile ${name} changed: ${parts.join(", ")}${more}.`;
}

/** What a PUT that changed a profile records on the daemon stream (profile.changed), without the client. */
export interface ProfileChangedEvent { entity: string; text: string; data: Record<string, unknown> }

// One write at a time in this process: each reads the files, checks and writes them.
let writes: Promise<unknown> = Promise.resolve();

/**
 * PUT /v1/profiles/{name}?repo=: change the rows `values` names in the profile's own file (./write.ts editProfile), from
 * the `rev` they were read at. Answers like GET, with what changed, and the event to record when something did.
 */
export async function updateProfileFor(name: string, repo: string | undefined, body: { values: Record<string, string | null>; rev: string }, base: Env = process.env): Promise<ProfileUpdate> {
	const source = await sourceFor(repo, base);
	const run = writes.then((): ProfileUpdate => {
		const path = agentsFilePath(source);
		let set: ProfileSet;
		try { set = readProfiles(path, source); } catch (e) {
			if (e instanceof AgentConfigError) return refused(422, "invalid", `the profiles can't be read, so nothing was changed: ${e.message}`);
			throw e;
		}
		const p = Object.hasOwn(set.profiles, name) ? set.profiles[name]! : undefined;
		if (!p) return refused(404, "not_found", `profile "${name}" not found`);
		if (body.rev !== profileRev(p)) return refused(409, "conflict", `profile "${name}" changed since it was read: read it again, then retry`, { rev: profileRev(p) });
		const e = editOf(p, body.values);
		if ("field" in e) return refused(422, "invalid", e.message, { field: e.field });
		try {
			const w = editProfile(name, e.edit, { path, source, rev: body.rev });
			const after = w.after.profiles[name]!;
			const changes = changesOf(w.changes);
			const detail = { ...detailOf(w.after, after, source), changed: w.changed, changes };
			const event = w.changed ? {
				entity: `profile:${name}`, text: profileChangedText(name, w.changes),
				data: { name, version: w.version, previousVersion: w.previousVersion, layer: after.source, path: w.file, changes },
			} : null;
			return { ok: true as const, detail, event };
		} catch (err) {
			if (!(err instanceof ProfileWriteError)) throw err;
			return refused(err.code === "not_found" ? 404 : err.code === "conflict" ? 409 : 422, err.code === "read_only" ? "invalid" : err.code, err.message, err.field ? { field: err.field } : {});
		}
	});
	writes = run.catch(() => {});
	return run;
}
