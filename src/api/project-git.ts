// POST /v1/projects/git-init, GET /v1/projects/publish-options and POST /v1/projects/publish (capability projects.git):
// take a plain folder to a GitHub checkout from the app, so it can then be set up (src/api/projects.ts). Git-init starts
// a repository in a folder that isn't in one; publish makes the first commit when there is none (refusing likely secrets
// and folders that need a .gitignore first), then the forge that publishes (docs/spec/plugin-api.md §7.4; forge-github:
// the GitHub CLI) creates the repository, adds it as origin and pushes. Whether its login is here and who it can publish
// as are the forge's `login`. Every refusal is a daemon-written sentence with the field it is about.
//
// git runs as a child process (never blocking the daemon), in the daemon's environment, and so does the forge's tool
// (CAPCOMD_GH_CLI names the gh binary; tests use a fake one that pushes to a local bare repository).
import { spawn } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { userConfigPath } from "../config/store";
import { inspectProject, isHome, tilde, type ProjectDeps, type ProjectInspection, type ProblemCode } from "./projects";

type Env = Record<string, string | undefined>;

/** The most files a first commit may hold: past it, the folder almost certainly needs a .gitignore first. */
export const MAX_FIRST_COMMIT_FILES = 2000;
/** How long the forge may take to create the repository and push to it. */
const PUBLISH_TIMEOUT_MS = 180_000;

export interface PublishAccount { login: string; kind: "user" | "org" }
export interface BlockedFile { path: string; reason: string }
export interface PublishOptions {
	path: string; root: string; ghReady: boolean; accounts: PublishAccount[]; suggestedName: string; hasCommits: boolean;
	branch: string; files: number; blocked: BlockedFile[];
}
export interface PublishInput { path: string; owner: string; name: string; visibility: "private" | "public" }

export type Refusal = { ok: false; status: 409 | 422 | 503; code: "conflict" | "invalid" | "unavailable"; message: string; field?: string; problem?: ProblemCode };
export type GitInitOutcome = Refusal | { ok: true; inspection: ProjectInspection; event: { entity: string; text: string; data: { path: string; name: string; branch: string } } };
export type OptionsOutcome = Refusal | { ok: true; options: PublishOptions };
export type PublishOutcome = Refusal | {
	ok: true; inspection: ProjectInspection;
	event: { entity: string; text: string; data: { path: string; name: string; owner: string; repo: string; visibility: string; firstCommit: boolean; files: number | null } };
};

const bad = (message: string, field: string, problem?: ProblemCode): Refusal => ({ ok: false, status: 422, code: "invalid", message, field, ...(problem ? { problem } : {}) });

// ---- processes ----
export interface Ran { code: number; out: string; err: string }
/** Run `cmd` without blocking: its exit code, stdout (up to 64 MB) and stderr (up to 64 KB). 127 when it can't start. */
export function run(cmd: string, args: string[], o: { cwd: string; env: Env; timeoutMs?: number }): Promise<Ran> {
	return new Promise((done) => {
		let p: ReturnType<typeof spawn>;
		const env = Object.fromEntries(Object.entries({ ...process.env, ...o.env, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0" }).filter(([, v]) => v !== undefined)) as NodeJS.ProcessEnv;
		try { p = spawn(cmd, args, { cwd: o.cwd, env, stdio: ["ignore", "pipe", "pipe"] }); } catch (e) { return done({ code: 127, out: "", err: (e as Error).message }); }
		const out: Buffer[] = [], err: Buffer[] = [];
		let outLen = 0, errLen = 0;
		p.stdout!.on("data", (b: Buffer) => { if (outLen < 64 << 20) { out.push(b); outLen += b.length; } });
		p.stderr!.on("data", (b: Buffer) => { if (errLen < 64 << 10) { err.push(b); errLen += b.length; } });
		const t = setTimeout(() => p.kill("SIGKILL"), o.timeoutMs ?? 30_000);
		const finish = (code: number, e?: string) => { clearTimeout(t); done({ code, out: Buffer.concat(out).toString("utf8"), err: e ?? Buffer.concat(err).toString("utf8") }); };
		p.on("error", (e) => finish(127, e.message));
		p.on("close", (c, sig) => finish(c ?? (sig ? 137 : 1)));
	});
}
const git = (args: string[], cwd: string, env: Env, timeoutMs?: number) => run("git", args, { cwd, env, timeoutMs });
/** The first line of a tool's error output, short enough for a sentence. */
const firstLine = (s: string) => (s.split("\n").map((l) => l.trim()).find(Boolean) ?? "").slice(0, 300);

// ---- who you can publish as ----
/** The user, then the organizations they belong to, as the forge that publishes says (plugin API §7.4 `login` with
 *  `accounts`; for GitHub, `gh api user` and `gh api user/orgs`, asked at most every 30 s). Empty when it can't say. */
export async function publishAccounts(env: Env): Promise<PublishAccount[]> {
	const F = await import("../plugins/forges");
	const forge = await F.publishForge();
	if (!forge) return [];
	const l = await F.forgeLogin(forge, { use: "publish", accounts: true }, { env });
	return l.ok ? l.accounts : [];
}

// ---- names ----
/** A GitHub repository name: letters, digits, ".", "_" and "-", up to 100, not "." or "..". */
export const REPO_NAME = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;
/** A GitHub user or organization login. */
export const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
/** A folder's name as GitHub would take it: other characters become "-", runs of "-" collapse, ends trimmed. */
export function repoNameFor(folder: string): string {
	const n = folder.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-{2,}/g, "-").replace(/^[-.]+|-+$/g, "").slice(0, 100);
	return REPO_NAME.test(n) ? n : "project";
}

// ---- likely secrets ----
/**
 * Why a file looks like it holds a secret (and must not go into a first commit), or null. Deliberately simple, by name:
 * `.env` and `.env.*` (but `.env.example`, `.env.sample`, `.env.template`), private keys (`*.pem`, `*.key`, `*.p12`,
 * `*.pfx`, `id_rsa`/`id_dsa`/`id_ecdsa`/`id_ed25519` without `.pub`), `.netrc`, `.git-credentials`, and an `.npmrc` that
 * holds an auth token (the only one read).
 */
export function secretReason(rel: string, root: string): string | null {
	const b = basename(rel);
	if (b === ".env" || (b.startsWith(".env.") && ![".env.example", ".env.sample", ".env.template"].includes(b))) return "an environment file, which usually holds secrets";
	if (/^id_(rsa|dsa|ecdsa|ed25519)(?!.*\.pub$)/.test(b)) return "an SSH private key";
	if (/\.(pem|key)$/i.test(b)) return "a private key or certificate";
	if (/\.(p12|pfx)$/i.test(b)) return "a certificate bundle with its private key";
	if (b === ".netrc" || b === ".git-credentials") return "saved login credentials";
	if (b === ".npmrc") {
		try {
			const f = join(root, rel);
			if (statSync(f).size <= 256 << 10 && /_auth(Token)?\s*=/.test(readFileSync(f, "utf8"))) return "an npm config with an auth token";
		} catch { /* unreadable: not read */ }
	}
	return null;
}

// ---- git facts ----
const hasCommits = async (root: string, env: Env) => (await git(["rev-parse", "--verify", "-q", "HEAD"], root, env)).code === 0;
const currentBranch = async (root: string, env: Env) => (await git(["symbolic-ref", "--short", "-q", "HEAD"], root, env)).out.trim() || "main";
const zList = (s: string) => [...new Set(s.split("\0").filter(Boolean))];
/** What publishing would put on GitHub: HEAD's files when there are commits, else what `git add -A` would commit (tracked
 *  and untracked files that aren't ignored). */
async function publishedFiles(root: string, env: Env, committed: boolean): Promise<string[]> {
	const r = committed ? await git(["ls-tree", "-r", "-z", "--name-only", "HEAD"], root, env, 60_000)
		: await git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], root, env, 60_000);
	if (r.code !== 0) throw new Error(`git couldn't list the files in ${root}: ${firstLine(r.err)}`);
	return zList(r.out);
}
const blockedIn = (files: string[], root: string) => files.flatMap((f) => { const reason = secretReason(f, root); return reason ? [{ path: f, reason }] : []; });
/** git has a name and an email to commit with (config, or the GIT_AUTHOR_* environment). */
async function hasIdentity(root: string, env: Env) {
	const merged = { ...process.env, ...env };
	const name = merged.GIT_AUTHOR_NAME || (await git(["config", "user.name"], root, env)).out.trim();
	const email = merged.GIT_AUTHOR_EMAIL || (await git(["config", "user.email"], root, env)).out.trim();
	return !!name && !!email;
}

// ---- POST /v1/projects/git-init ----
const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };
const within = (child: string, parent: string) => { const r = relative(parent, child); return r === "" || (!!r && !r.startsWith("..") && !r.startsWith("/")); };

/** Start a git repository (`git init -b main`, no commit) in a folder inspect reports as not_git. */
export async function initGit(path: string, deps: ProjectDeps): Promise<GitInitOutcome> {
	const env = deps.env;
	const i = await inspectProject(path, deps);
	const p = i.problems[0];
	if (i.root) return { ok: false, status: 409, code: "conflict", message: `${tilde(resolve(path), env)} is already in a git checkout (${tilde(i.root, env)}). Look at the folder again.` };
	if (!p) return bad(`${tilde(resolve(path), env)} can't be made a git checkout.`, "path");
	if (p.code !== "not_git") return bad(p.message, "path", p.code);
	const dir = real(path);
	const shown = tilde(dir, env);
	// Never a repository around the home folder (/, /Users) or inside capcomd's own state.
	const home = real(env.HOME ?? homedir());
	if (dir === "/" || within(home, dir)) return bad(`${shown} holds your home folder, so capcomd won't start a repository there. Choose your project's own folder.`, "path", "home");
	if (within(dir, real(dirname(userConfigPath(env)))) || isHome(dir, env)) return bad(`${shown} is where capcomd keeps its own settings. Choose your project's own folder.`, "path", "home");
	const r = await git(["init", "-q", "-b", "main"], dir, env);
	if (r.code !== 0) return bad(`git couldn't start a repository in ${shown}: ${firstLine(r.err) || `exit ${r.code}`}.`, "path");
	const after = await inspectProject(path, deps);
	const root = after.root ?? dir;
	const name = after.name ?? basename(root);
	return { ok: true, inspection: after, event: { entity: `project:${name}`, text: `Started a git repository in ${name} (${tilde(root, env)}), on branch main.`, data: { path: root, name, branch: "main" } } };
}

// ---- GET /v1/projects/publish-options and POST /v1/projects/publish ----
/** Only a checkout without origin can be published. */
function gate(i: ProjectInspection, path: string, env: Env): Refusal | null {
	const p = i.problems[0];
	if (!i.root) return bad(p?.message ?? `${tilde(resolve(path), env)} isn't a git checkout.`, "path", p?.code);
	if (p && p.code !== "no_origin") {
		if (p.code === "not_github") return { ok: false, status: 409, code: "conflict", message: `${tilde(i.root, env)} already has an origin (${i.repo}), so there's nothing to publish.` };
		return bad(p.message, "path", p.code);
	}
	if (!p) return { ok: false, status: 409, code: "conflict", message: `${tilde(i.root, env)} is already on GitHub (${i.github ?? i.repo}), so there's nothing to publish.` };
	return null;
}
const GH_NEEDED = "Publishing needs the GitHub CLI logged in on this Mac (run `gh auth login` in Terminal), then publish again.";

/** What the publish form needs: who you can publish as, a name, and what the first commit would hold. Writes nothing. */
export async function publishOptions(path: string, deps: ProjectDeps): Promise<OptionsOutcome> {
	const env = deps.env;
	const i = await inspectProject(path, deps);
	const no = gate(i, path, env);
	if (no) return no;
	const root = i.root!;
	const ghReady = await deps.ghReady().catch(() => false);
	const accounts = ghReady ? await publishAccounts(env).catch(() => []) : [];
	const committed = await hasCommits(root, env);
	const files = await publishedFiles(root, env, committed);
	return {
		ok: true,
		options: {
			path, root, ghReady, accounts, suggestedName: repoNameFor(basename(root)), hasCommits: committed, branch: await currentBranch(root, env),
			files: files.length, blocked: blockedIn(files, root).slice(0, 50),
		},
	};
}

const publishing = new Set<string>();
/**
 * Publish a checkout without origin to GitHub: the first commit when there is none (`git add -A`, "Initial commit"), then
 * the forge that publishes creates the repository (forge-github: `gh repo create <owner>/<name> --source <root> --push`).
 */
export async function publishProject(input: PublishInput, deps: ProjectDeps): Promise<PublishOutcome> {
	const env = deps.env;
	const i = await inspectProject(input.path, deps);
	const no = gate(i, input.path, env);
	if (no) return no;
	const root = i.root!;
	if (publishing.has(root)) return { ok: false, status: 409, code: "conflict", message: `${tilde(root, env)} is being published already. Wait for it to finish.` };
	publishing.add(root);
	try { return await publish(input, i, root, deps); } finally { publishing.delete(root); }
}

async function publish(input: PublishInput, i: ProjectInspection, root: string, deps: ProjectDeps): Promise<PublishOutcome> {
	const env = deps.env, at = tilde(root, env);
	if (!(await deps.ghReady().catch(() => false))) return bad(GH_NEEDED, "gh");
	if (!OWNER.test(input.owner)) return bad(`"${input.owner.slice(0, 80)}" isn't a GitHub account name.`, "owner");
	if (!REPO_NAME.test(input.name)) return bad(`"${input.name.slice(0, 80)}" isn't a name GitHub takes: use letters, digits, ".", "_" and "-" (up to 100).`, "name");
	const accounts = await publishAccounts(env).catch(() => [] as PublishAccount[]);
	if (accounts.length && !accounts.some((a) => a.login.toLowerCase() === input.owner.toLowerCase()))
		return bad(`The GitHub CLI isn't logged in as ${input.owner} or a member of it: choose ${accounts.map((a) => a.login).join(", ")}.`, "owner");
	const committed = await hasCommits(root, env);
	let files: number | null = null;
	if (!committed) {
		const list = await publishedFiles(root, env, false);
		const blocked = blockedIn(list, root);
		if (blocked.length) {
			const names = blocked.slice(0, 5).map((b) => b.path).join(", ") + (blocked.length > 5 ? ` and ${blocked.length - 5} more` : "");
			return bad(`${names} ${blocked.length === 1 ? "looks like it holds" : "look like they hold"} secrets, and the first commit would publish ${blocked.length === 1 ? "it" : "them"}. Add ${blocked.length === 1 ? "it" : "them"} to .gitignore, then publish again.`, "files");
		}
		if (list.length > MAX_FIRST_COMMIT_FILES)
			return bad(`The first commit would hold ${list.length} files (more than ${MAX_FIRST_COMMIT_FILES}), which usually means dependencies or build output are in it. Add a .gitignore for them, then publish again.`, "files");
		if (!list.length) return bad(`${at} has no files to commit yet. Add your project's files, then publish.`, "files");
		if (!(await hasIdentity(root, env)))
			return bad("git doesn't know who you are, so it can't make the first commit. Set your name and email (`git config --global user.name \"Your Name\"` and `git config --global user.email you@example.com` in Terminal), then publish again.", "identity");
		const add = await git(["add", "-A"], root, env, 120_000);
		if (add.code !== 0) return bad(`git couldn't add ${at}'s files: ${firstLine(add.err) || `exit ${add.code}`}.`, "files");
		const commit = await git(["commit", "-q", "-m", "Initial commit"], root, env, 120_000);
		if (commit.code !== 0) return bad(`git couldn't make the first commit in ${at}: ${firstLine(commit.err) || firstLine(commit.out) || `exit ${commit.code}`}.`, "files");
		files = list.length;
	}
	const branch = await currentBranch(root, env);
	const full = `${input.owner}/${input.name}`;
	// The forge that creates repositories (docs/spec/plugin-api.md §7.4 `publish`) creates it, adds it as origin and pushes.
	const F = await import("../plugins/forges");
	const kept = files !== null ? " The first commit is made; publishing again pushes it." : "";
	const forge = await F.publishForge();
	let made: { remote: string; url: string | null };
	try {
		if (!forge) throw new Error("no active forge creates repositories (see `capcomd plugins list`)");
		made = await F.withForge({ env }, PUBLISH_TIMEOUT_MS, (c) => forge.publishRepository({ path: root, owner: input.owner, name: input.name, visibility: input.visibility }, c));
	} catch (e) {
		const p = e as { name?: string; code?: string; hint?: string; message: string };
		if (p.name === "PluginError" && p.code === "conflict")
			return { ok: false, status: 409, code: "conflict", field: "name", message: `${p.message}${p.hint ? ` ${p.hint}` : ""}${kept}` };
		return { ok: false, status: 503, code: "unavailable", message: `${p.message}${kept}` };
	}
	// origin/HEAD, as a clone would have it (local only): inspect's defaultBranch.
	await git(["remote", "set-head", "origin", branch], root, env);
	const after = await inspectProject(input.path, deps);
	const name = after.name ?? basename(root);
	return {
		ok: true, inspection: after,
		event: {
			entity: `project:${name}`,
			// Where the forge says it is (https://github.com/acme/app → github.com/acme/app).
			text: `Published ${name} (${at}) to ${made.url ? made.url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/\/$/, "") : full}, ${input.visibility}${files !== null ? `, with a first commit of ${files} file${files === 1 ? "" : "s"}` : ""}.`,
			data: { path: root, name, owner: input.owner, repo: full, visibility: input.visibility, firstCommit: files !== null, files },
		},
	};
}
