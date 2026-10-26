// Where an agent works (harness.v1 Agent.workspace and agent.spawned.workspace), so a client can show a folder chip
// per agent and the distinct folders of a run. Every agent today works at the root of its run's repository (the
// worker clones the run's CAPCOMD_REPO), so `path` is always null for now; the field is there for agents scoped to
// a sub-folder, whose label is then that path.
import { z } from "zod";

export const AgentWorkspace = z.looseObject({
	repo: z.string().describe("Repository the agent works in: absolute path or remote URL, without credentials. Today always the run's repository"),
	path: z.string().nullable().describe("Sub-folder of `repo` the agent is scoped to, relative, '/'-separated; null = the whole repository (always null today)"),
	label: z.string().min(1).describe("Short display name, show it verbatim: `path` when set (e.g. \"ids/v1\"), else the repository's base name without .git (e.g. \"matchkey\")"),
}).describe("Where the agent works; null when its run has no repository. Absent on agent.spawned events written by older daemons");
export type AgentWorkspace = z.infer<typeof AgentWorkspace>;

/** docs/harness-contract.md "Agent workspace" (generated). */
export const WORKSPACE_DOC = `\`Agent.workspace\` (\`agents.tree\`, \`snapshot.agents\`) and \`agent.spawned\` \`data.workspace\` say where an agent works, so a client can show a folder chip per agent and a run's distinct folders.
Show \`label\` verbatim: the sub-folder (\`path\`, e.g. \`ids/v1\`) when the agent is scoped to one, else the repository's base name (\`matchkey\`). Group by \`repo\` + \`path\` for distinct folders.
Today every agent works at the root of its run's repository (the one \`capcomd run new\` recorded, else the engine's \`CAPCOMD_REPO\`), so \`repo\` equals the run's repository without credentials and \`path\` is null.
\`workspace\` is null when the run has no repository. It is fixed when the agent is spawned; agents spawned by older daemons report the run's repository, and their \`agent.spawned\` events have no \`workspace\`.`;

/** `https://user:token@host/x` → `https://host/x`: a repo URL may carry credentials; never publish them. */
export const stripCredentials = (repo: string) => repo.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i, "$1");

/** Base name of a path or remote URL (`/src/matchkey/`, `git@github.com:org/matchkey.git` → `matchkey`). */
export function repoLabel(repo: string): string {
	const trimmed = repo.replace(/[/\\]+$/, "").replace(/\.git$/i, "");
	const base = trimmed.split(/[/\\:]/).filter(Boolean).pop();
	return base || repo;
}

/** The workspace of an agent working in `repo` (scoped to `path`, if any); null when there is no repository. */
export function workspaceOf(repo: string | null | undefined, path: string | null = null): AgentWorkspace | null {
	if (!repo) return null;
	const sub = path ? path.replace(/\\/g, "/").replace(/^\.?\/+|\/+$/g, "") || null : null;
	return { repo: stripCredentials(repo), path: sub, label: sub ?? repoLabel(repo) };
}
