// runs.create (POST /v1/runs): start a run exactly as `capcomd run --detach <goal>` does when typed in the project's
// directory. The daemon runs that command itself, so the CLI stays the one place that resolves profiles, the planner,
// the engine and the background process; this file only decides the directory and environment it runs in.
import { spawn } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { applyConfig, projectConfigPath, readConfig, userConfigPath } from "../config/store";
import { REPO_ENV_KEYS } from "../merge/config";
import { env as envVar } from "../utils/env";
import { selfArgv } from "../utils/self";
import { CreateRunError, type CreateRunInput } from "./source";

type Env = Record<string, string | undefined>;
const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };

/**
 * Where a run starts and with which settings.
 * - `repo` given: an absolute path to a project checkout (the nearest .capcomd/config.json from it, written by
 *   `capcomd setup project`). The daemon's own repository settings are dropped, so the project's apply in full (then
 *   the user's ~/.capcomd/config.json fills gaps, as for any CLI command); the run starts in that directory, so the
 *   project's agent profiles and run defaults (checks, reviewer, target) apply too.
 * - `repo` omitted: the daemon's own settings and directory, when they name a repository (CAPCOMD_REPO).
 * Either way, no repository is a CreateRunError: a run without one would only record dry-run merges.
 */
export function launchContext(repo: string | undefined, base: Env = process.env, cwd = process.cwd()): { cwd: string; env: Env; repo: string } {
	if (repo === undefined) {
		const r = envVar("REPO", base);
		if (!r) throw new CreateRunError("repo is required: this daemon has no default repository (CAPCOMD_REPO, e.g. in ~/.capcomd/config.json). Pass repo, the absolute path of a project checkout set up with `capcomd setup project`.");
		return { cwd, env: { ...base }, repo: r };
	}
	if (!isAbsolute(repo)) throw new CreateRunError(`repo must be an absolute path, got ${JSON.stringify(repo)}`);
	const dir = resolve(repo);
	if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new CreateRunError(`repo ${dir} is not a directory on this machine`);
	const project = projectConfigPath(dir);
	// The nearest config from a directory in $HOME can be capcomd's own (~/.capcomd/config.json): that is no project.
	if (!project || real(project) === real(userConfigPath(base))) throw new CreateRunError(`${dir} is not a capcomd project (no .capcomd/config.json in it or above it). Run \`capcomd setup project\` in it first.`);
	const env: Env = { ...base };
	for (const k of REPO_ENV_KEYS) { delete env[`CAPCOMD_${k}`]; delete env[`RELAY_${k}`]; }
	// CAPCOMD_NO_CONFIG (tests) skips the user's settings, never the project the request named.
	if (base.CAPCOMD_NO_CONFIG) { for (const [k, v] of Object.entries(readConfig(project).env ?? {})) if (env[k] === undefined && typeof v === "string") env[k] = v; }
	else applyConfig(env, dir);
	const r = envVar("REPO", env);
	if (!r) throw new CreateRunError(`${project} names no repository (CAPCOMD_REPO). Run \`capcomd setup project\` in ${dir}.`);
	return { cwd: dir, env, repo: r };
}

/** The CLI errors that mean "not like this" (422), as opposed to a daemon fault. */
const REFUSALS = new Set(["usage", "config", "not_found", "conflict"]);

/**
 * Run `capcomd run --detach --json` for `input` and wait for it to hand the run to its background process (a second or
 * two: it checks the profile and the engine, then forks). Resolves with the run's repository.
 */
export async function startDetachedRun(input: CreateRunInput & { runId: string }, o: { env?: Env; cwd?: string; timeoutMs?: number } = {}): Promise<{ repo: string; log: string | null }> {
	const ctx = launchContext(input.repo, o.env ?? process.env, o.cwd ?? process.cwd());
	const [cmd, ...args] = selfArgv("run", "--detach", "--json", "--run-id", input.runId,
		...(input.targetBranch ? [`--target-branch=${input.targetBranch}`] : []), ...(input.profile ? [`--profile=${input.profile}`] : []), "--", input.goal);
	const child = spawn(cmd!, args, { cwd: ctx.cwd, env: ctx.env as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "", stderr = "";
	child.stdout!.on("data", (b) => { stdout += b; });
	child.stderr!.on("data", (b) => { stderr += b; });
	const timeoutMs = o.timeoutMs ?? 60_000;
	const code = await new Promise<number | null>((done, fail) => {
		const t = setTimeout(() => { child.kill("SIGKILL"); fail(new Error(`capcomd run did not start the run within ${timeoutMs / 1000}s`)); }, timeoutMs);
		child.on("error", (e) => { clearTimeout(t); fail(e); });
		child.on("exit", (c) => { clearTimeout(t); done(c); });
	});
	let j: any = null;
	try { j = JSON.parse(stdout.trim().split("\n").pop() ?? ""); } catch { /* not JSON: reported below */ }
	if (code === 0 && j?.ok && j.runId === input.runId) return { repo: ctx.repo, log: typeof j.log === "string" ? j.log : null };
	const e = j?.error as { code?: string; message?: string; hint?: string } | undefined;
	if (e?.code && REFUSALS.has(e.code)) throw new CreateRunError(`${e.message ?? "capcomd run refused the run"}${e.hint && !e.hint.includes("--help") ? ` ${e.hint}` : ""}`);
	throw new Error(`capcomd run failed to start the run (exit ${code}): ${(e?.message ?? (stderr.trim() || stdout.trim())).slice(-500)}`);
}
