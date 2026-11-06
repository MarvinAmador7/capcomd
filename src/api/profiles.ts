// GET /v1/profiles (capability profiles; ADR-024 §5): every agent profile a run of the daemon, or of a project (`repo`),
// can use, as `capcomd profiles list --json` lists them: where each was found and the files laid together to make it,
// what it does, and whether its login is there. Local files only.
import type { z } from "zod";
import { AgentConfigError, agentsFilePath, profileLayers, profileRows, readProfiles } from "../profiles";
import { readiness } from "../cli/commands/profiles";
import type { Profiles } from "./contract";

type Env = Record<string, string | undefined>;

/** The profiles a run with this environment sees (its CAPCOMD_AGENTS_FILE and CAPCOMD_HOME). */
export function profilesOf(source: Env = process.env): z.infer<typeof Profiles> {
	const file = agentsFilePath(source);
	const layers = profileLayers(file, source);
	let set: ReturnType<typeof readProfiles>;
	try { set = readProfiles(file, source); } catch (e) {
		if (e instanceof AgentConfigError) return { file, layers, default: null, profiles: [], warnings: [], error: e.message };
		throw e;
	}
	const profiles = profileRows(set).map((r) => {
		const ready = readiness(r.name, set.agents[r.name]!, source);
		return {
			name: r.name, version: r.version, source: r.source, format: r.format, path: r.path, default: r.default, description: r.description ?? null, tags: r.tags,
			provider: r.provider, auth: r.auth, model: r.model, effort: r.effort, toolMode: r.toolMode, canSpawn: r.canSpawn, canLead: r.canLead, does: r.does,
			ready: ready.ready, readiness: ready.detail, applied: r.applied,
		};
	});
	return { file, layers, default: set.default ?? null, profiles, warnings: set.warnings, error: null };
}

/** GET /v1/profiles?repo=: a project's profiles, as POST /v1/runs with that `repo` resolves them (CreateRunError, a
 *  422, when it isn't a project); the daemon's own without one. */
export async function profilesFor(repo: string | undefined, base: Env = process.env): Promise<z.infer<typeof Profiles>> {
	if (repo === undefined) return profilesOf(base);
	const { projectSource } = await import("./create-run");
	return profilesOf(projectSource(repo, base));
}
