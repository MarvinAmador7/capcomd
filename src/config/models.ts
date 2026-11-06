// The models a run's planner can be started on, per harness (GET /v1/run-options `drivers[].models`, POST /v1/runs
// `model`, `capcomd run --planner-model`). Nothing else in capcomd lists them: a profile names one model, the CLIs take
// any id. This is the one curated table; the project's own profiles add the models they name (so a model the project
// already runs on is always offered), and a chosen model reaches the CLI as the profile's `model` does: Claude Code
// `--model <id>`, Codex `-m <id>` (src/agents/adapters.ts).
import { agentsFilePath, readProfiles, type Provider } from "../profiles";
import type { Driver } from "../agents/run-driver";
import { agentSeam } from "../plugins/agents";

type Env = Record<string, string | undefined>;

export interface HarnessModel {
	/** What the CLI takes (`--model` / `-m`). */
	id: string;
	/** What to call it in a menu: "Opus 5.5". */
	name: string;
	/** One short line beside the name: "Most capable". */
	note: string;
}

/** Newest first per harness, the order a menu lists them. */
export const HARNESS_MODELS: Record<Driver, readonly HarnessModel[]> = {
	claude: [
		{ id: "claude-opus-5-5", name: "Opus 5.5", note: "Most capable" },
		{ id: "claude-sonnet-5-5", name: "Sonnet 5.5", note: "Balanced" },
		{ id: "claude-haiku-5-5", name: "Haiku 5.5", note: "Fastest" },
	],
	codex: [
		// Unverified: the id follows the approved prototype's "GPT-5.6"; check it against `codex -m` before relying on it.
		{ id: "gpt-5.6", name: "GPT-5.6", note: "Codex" },
	],
};

/**
 * The models `provider` offers for a run in this project (`source`: its env, so its agents file): the curated table,
 * then any other model the project's profiles on that provider name (as their id, noted with the profile). Never throws:
 * an unreadable agents file adds nothing.
 */
export function harnessModels(provider: Provider, source: Env = process.env): HarnessModel[] {
	const out: HarnessModel[] = [...((HARNESS_MODELS as Record<Provider, readonly HarnessModel[] | undefined>)[provider] ?? [])];
	let agents: Record<string, { provider?: string; model?: string }> = {};
	try { agents = readProfiles(agentsFilePath(source), source).agents; } catch { /* no profiles: the table alone */ }
	for (const [name, spec] of Object.entries(agents)) {
		if (spec.provider !== provider || !spec.model || out.some((m) => m.id === spec.model)) continue;
		out.push({ id: spec.model, name: spec.model, note: `From the ${name} profile` });
	}
	return out;
}

/** Why `model` can't run the planner on `provider` here, or null when it's one the harness offers. */
export function modelProblem(provider: Provider, model: string, source: Env = process.env): string | null {
	const list = harnessModels(provider, source);
	if (list.some((m) => m.id === model)) return null;
	const label = agentSeam(provider)?.describe().label ?? provider;
	return `model ${JSON.stringify(model)} isn't a ${label} model capcomd offers: use one of ${list.map((m) => m.id).join(", ")}`;
}
