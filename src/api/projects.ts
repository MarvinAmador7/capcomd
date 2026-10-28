// GET /v1/projects/inspect and POST /v1/projects (capability projects.setup): set up a folder the app's user picked as a
// capcomd project, without Terminal. Inspect says what the form needs (the checkout, its origin, branches, a check, the
// agents and how each logs in) and what blocks setup, each in a daemon-written sentence with a stable code; the POST
// checks every answer again and writes what `capcomd setup project` writes, through the same code
// (src/config/project-setup.ts), then adds the folder to capcomd's projects. Only GitHub checkouts: the repository is
// always the checkout's origin, never a URL the client sends.
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { resolve } from "node:path";
import {
	githubRepoOf, gitRoot, httpsRemote, isUserConfigDir, originHead, originUrl, planProject, budgetCap, projectValues, ProjectWriteError,
	remoteBranches, suggestCheck, writeProject, type ProjectValues,
} from "../config/project-setup";
import { addProject, nameFor, readProjects, samePath } from "../config/projects";

type Env = Record<string, string | undefined>;
/** contract.ts BranchName's pattern (importing contract.ts from here makes an import cycle through source.ts). */
const BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*[./]$)[A-Za-z0-9._/-]{1,200}$/;
/** A row of GET /v1/logins (src/api/settings.ts LoginState). */
type LoginState = { provider: "claude" | "codex"; sandbox: string; loggedIn: boolean; how: "plan" | "api_key" | null };
export const SETUP_AGENTS = ["claude", "codex"] as const;
export type SetupAgent = (typeof SETUP_AGENTS)[number];
const AGENT_LABEL: Record<SetupAgent, string> = { claude: "Claude Code", codex: "Codex" };
export type ProblemCode = "not_found" | "not_git" | "home" | "no_origin" | "not_github";
export interface ProjectProblem { code: ProblemCode; message: string }
export interface ProjectAgent {
	provider: SetupAgent; label: string; loggedIn: boolean; auth: "subscription" | "apikey";
	places: Array<{ sandbox: string; loggedIn: boolean; how: "plan" | "api_key" | null }>;
}
export interface ProjectInspection {
	path: string; root: string | null; name: string | null; configured: boolean; values: ProjectValues | null;
	repo: string | null; github: string | null; ghReady: boolean; defaultBranch: string; branches: string[]; suggestedCheck: string;
	suggestedMode: "pr" | "direct"; suggestedAgents: SetupAgent[]; agents: ProjectAgent[]; budgetAsked: boolean; problems: ProjectProblem[];
}
export interface ProjectSetupInput { path: string; mode: "pr" | "direct"; target: string; check: string; agents: SetupAgent[]; budgetUsd?: number; expect?: { repo?: string | null } }
export type SetupOutcome =
	| { ok: true; project: { path: string; root: string; name: string; configured: true; values: ProjectValues }; changed: boolean; event: { text: string; data: { mode: string; target: string; check: string; agents: SetupAgent[]; budgetUsd: number | null } } }
	| { ok: false; status: 409 | 422; code: "conflict" | "invalid"; message: string; field?: string; problem?: ProblemCode; repo?: string | null };

export interface ProjectDeps {
	/** The daemon's environment (CAPCOMD_HOME: where capcomd's user config and project list are). */
	env: Env;
	/** GET /v1/logins: who each agent logs in as, per place. */
	logins: () => Promise<LoginState[]>;
	/** `gh auth status` succeeds on the daemon's machine (PR mode needs it). */
	ghReady: () => Promise<boolean>;
}

const tilde = (p: string, env: Env) => { const h = resolve(env.HOME ?? homedir()); return p === h ? "~" : p.startsWith(`${h}/`) ? `~${p.slice(h.length)}` : p; };
/** The home directory: capcomd's own settings live there, so it's never a project. */
const isHome = (p: string, env: Env) => samePath(p, env.HOME ?? homedir()) || samePath(p, userInfo().homedir) || isUserConfigDir(p, env);

/** How each agent would log in (a plan login anywhere wins, as GET /v1/logins says), and where it has a login. */
function agentsFrom(logins: LoginState[]): ProjectAgent[] {
	return SETUP_AGENTS.map((provider) => {
		const mine = logins.filter((l) => l.provider === provider);
		const plan = mine.some((l) => l.loggedIn && l.how === "plan"), key = mine.some((l) => l.loggedIn && l.how === "api_key");
		return { provider, label: AGENT_LABEL[provider], loggedIn: plan || key, auth: plan || !key ? "subscription" : "apikey",
			places: mine.map((l) => ({ sandbox: l.sandbox, loggedIn: l.loggedIn, how: l.how })) };
	});
}
const asks = (agents: ProjectAgent[], chosen: readonly string[]) => agents.some((a) => chosen.includes(a.provider) && a.auth === "apikey");

/** GET /v1/projects/inspect: the facts about `path` and what blocks setting it up. Writes nothing. */
export async function inspectProject(path: string, deps: ProjectDeps): Promise<ProjectInspection> {
	const env = deps.env;
	const agents = agentsFrom(await deps.logins().catch(() => []));
	const suggestedAgents = agents.filter((a) => a.loggedIn).map((a) => a.provider);
	const base: ProjectInspection = {
		path, root: null, name: null, configured: false, values: null, repo: null, github: null, ghReady: false, defaultBranch: "main", branches: [],
		suggestedCheck: "", suggestedMode: "direct", suggestedAgents: suggestedAgents.length ? suggestedAgents : ["claude"], agents, budgetAsked: false, problems: [],
	};
	base.budgetAsked = asks(agents, base.suggestedAgents);
	const dir = resolve(path);
	const shown = tilde(dir, env);
	const isDir = (() => { try { return existsSync(dir) && statSync(dir).isDirectory(); } catch { return false; } })();
	if (!isDir) return { ...base, problems: [{ code: "not_found", message: `${shown} isn't a folder on this Mac. Choose your repository's folder.` }] };
	if (isHome(dir, env)) return { ...base, problems: [{ code: "home", message: `${shown} is your home folder, where capcomd keeps its own settings. Choose your repository's folder.` }] };
	const root = gitRoot(dir);
	if (!root) return { ...base, problems: [{ code: "not_git", message: `${shown} isn't a git checkout. Choose your repository's folder, or clone it first.` }] };
	const at = tilde(root, env);
	const list = readProjects(env).list;
	const out: ProjectInspection = { ...base, root, name: list.find((x) => samePath(x.path, root))?.name ?? nameFor(root, list) };
	if (isHome(root, env)) return { ...out, problems: [{ code: "home", message: `${at} is your home folder, where capcomd keeps its own settings. Choose your repository's folder.` }] };
	const values = projectValues(root);
	const origin = originUrl(root);
	const repo = origin ? httpsRemote(origin) : null;
	const github = repo ? githubRepoOf(repo) : null;
	const branches = remoteBranches(root);
	const head = originHead(root);
	const ghReady = github ? await deps.ghReady().catch(() => false) : false;
	const problems: ProjectProblem[] = [];
	if (!repo) problems.push({ code: "no_origin", message: `${at} has no origin remote, so agents have no repository to push to. Add one (\`git remote add origin <url>\`), or choose another checkout.` });
	else if (!github) problems.push({ code: "not_github", message: `${at}'s origin (${repo}) isn't on GitHub. The app sets up GitHub checkouts; set this one up with \`capcomd setup project\` in Terminal.` });
	return {
		...out, configured: values !== null, values, repo, github, ghReady, defaultBranch: head || "main",
		branches: head && !branches.includes(head) ? [head, ...branches] : branches, suggestedCheck: suggestCheck(root) ?? "",
		suggestedMode: ghReady ? "pr" : "direct", problems,
	};
}

const bad = (message: string, field: string, extra: Partial<Extract<SetupOutcome, { ok: false }>> = {}): SetupOutcome => ({ ok: false, status: 422, code: "invalid", message, field, ...extra });

/**
 * POST /v1/projects, after the body's shape was checked: every answer again against the folder as it is now, then the
 * two files, then capcomd's project list.
 */
export async function setUpProject(input: ProjectSetupInput, deps: ProjectDeps): Promise<SetupOutcome> {
	const i = await inspectProject(input.path, deps);
	const p = i.problems[0];
	if (p) return bad(p.message, "path", { problem: p.code });
	const root = i.root!;
	// The folder changed since the client looked: its origin isn't the one the form showed.
	if (input.expect && "repo" in input.expect && (input.expect.repo ?? null) !== i.repo)
		return { ok: false, status: 409, code: "conflict", message: `${tilde(root, deps.env)}'s origin changed since you looked: it's ${i.repo ?? "gone"} now. Look at the folder again before setting it up.`, repo: i.repo };
	if (input.mode === "pr" && !i.ghReady)
		return bad("Pull requests need the GitHub CLI logged in on this Mac (run `gh auth login` in Terminal), so choose direct merges or log in first.", "mode");
	if (!BRANCH.test(input.target)) return bad(`"${input.target.slice(0, 80)}" isn't a branch name capcomd can merge into (letters, digits, ".", "_", "-" and "/").`, "target");
	const agents = SETUP_AGENTS.filter((a) => input.agents.includes(a));
	if (!agents.length || agents.length !== input.agents.length) return bad("Choose Claude Code, Codex or both, once each.", "agents");
	const asked = asks(i.agents, agents);
	if (input.budgetUsd !== undefined && !asked) return bad("None of these agents bills an API key, so there's no spend to cap: leave the budget out.", "budgetUsd");
	if (input.budgetUsd !== undefined && !(Number.isFinite(input.budgetUsd) && input.budgetUsd > 0)) return bad("The spend cap is an amount in USD over 0, or none for no limit.", "budgetUsd");
	const authOf = (a: string) => i.agents.find((x) => x.provider === a)?.auth ?? "subscription";
	const plan = planProject({ dir: root, repo: i.repo!, mode: input.mode, target: input.target, check: input.check, agents, authOf, cap: input.budgetUsd !== undefined ? budgetCap(input.budgetUsd) : null });
	let w;
	try { w = writeProject(plan, { strict: true }); } catch (e) {
		if (e instanceof ProjectWriteError) return bad(e.message, "path");
		throw e;
	}
	const listed = addProject(root, deps.env);
	return {
		ok: true, project: { path: input.path, root, name: listed.project.name, configured: true, values: projectValues(root)! },
		changed: w.configChanged || w.made.length > 0 || listed.added,
		event: {
			text: configuredText({ name: listed.project.name, root, mode: input.mode, target: input.target, agents }, deps.env),
			data: { mode: input.mode, target: input.target, check: input.check, agents, budgetUsd: input.budgetUsd ?? null },
		},
	};
}

/** The audit line on the daemon stream (project.configured): trusted fields only (a project name, a branch name, labels). */
export function configuredText(o: { name: string; root: string; mode: string; target: string; agents: SetupAgent[] }, env: Env): string {
	return `Set up ${o.name} (${tilde(o.root, env)}): ${o.mode === "pr" ? "pull requests" : "direct pushes"} into ${o.target}, with ${o.agents.map((a) => AGENT_LABEL[a]).join(" and ")}.`;
}

// ---- `gh auth status` on the daemon's machine, cached ----
const GH_TTL_MS = 30_000;
let ghCache: { at: number; result: Promise<boolean> } | null = null;
export function resetGhCheck() { ghCache = null; }
/** `gh auth status` exits 0 within 5 s (CAPCOMD_GH_CLI names the binary). Asked at most every 30 s. */
export function ghReady(env: Env = process.env): Promise<boolean> {
	if (ghCache && Date.now() - ghCache.at < GH_TTL_MS) return ghCache.result;
	const result = new Promise<boolean>((done) => {
		let p: ReturnType<typeof spawn>;
		try { p = spawn(env.CAPCOMD_GH_CLI ?? "gh", ["auth", "status"], { stdio: "ignore", env: env as NodeJS.ProcessEnv }); } catch { return done(false); }
		const t = setTimeout(() => { p.kill("SIGKILL"); done(false); }, 5_000);
		p.on("error", () => { clearTimeout(t); done(false); });
		p.on("exit", (c) => { clearTimeout(t); done(c === 0); });
	});
	ghCache = { at: Date.now(), result };
	return result;
}
