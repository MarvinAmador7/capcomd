// GET /v1/run-options and the checks POST /v1/runs makes for `driver` and `sandbox`: who can drive a run (the planner
// agent's provider) and where its agents can run, with whether each can be used right now. Cheap checks only: the
// environment, the login ledger, the agents file; Docker's reachability is asked of the docker CLI at most every few
// seconds and shared by concurrent requests.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { agentModel } from "../agents/config";
import { credentialReady, DEFAULT_PLANNER, DRIVER_LABEL, DRIVERS, plannerDriver, plannerProfile } from "../agents/run-driver";
import { profileFor } from "../auth/profiles";
import { bootSnapshot, EnvironmentProblem } from "../env/resolve";
import { lifecycleCheck } from "../plugins/lifecycle";
import { agentsFilePath, lifecyclePlugins, profileFacts, providerDefaultEffort, providerEfforts, providerKind, readProfiles, type ProfileSet, type ResolvedProfile } from "../profiles";
import { untrustedProfileProblem, untrustedSandboxProblem } from "../profiles/trust";
import { cliVersionProblem } from "../env/cli-version";
import { readConfig, userConfigPath } from "../config/store";
import { LISTED_PROVIDERS, PROVIDER_LABEL, sandboxName, type ListedProvider } from "../providers/registry";
import { withSandbox } from "../providers/run-sandbox";
import { egressProblem, envSnapshotProblem, isolationProblem } from "../primitives/ops";
import { capcomdHome } from "../utils/home";
import { harnessModels, type HarnessModel } from "../config/models";

type Env = Record<string, string | undefined>;
/** Where a run can go: the listed providers (src/providers/registry.ts), docker then boxd. */
export const RUN_SANDBOXES = LISTED_PROVIDERS;
export type RunSandbox = ListedProvider;
export const SANDBOX_LABEL: Record<RunSandbox, string> = PROVIDER_LABEL;

export interface DriverFit { available: boolean; reason: string | null }
export interface DriverOption { provider: "claude" | "codex"; label: string; model: string | null; models: HarnessModel[]; efforts: string[]; effort: string | null; available: boolean; reason: string | null; default: boolean; sandboxes: Record<RunSandbox, DriverFit> }
export interface SandboxOption { name: RunSandbox; label: string; available: boolean; reason: string | null; default: boolean }
export interface PlannerOption { name: string; title: string | null; provider: string; model: string | null; default: boolean; available: boolean; reason: string | null }
export interface RunOptionsBody { drivers: DriverOption[]; sandboxes: SandboxOption[]; planners: PlannerOption[] }

// ---- Docker: is a daemon reachable? (`docker version`, cached) ----
const DOCKER_TTL_MS = 5_000;
let docker: { at: number; result: Promise<{ ok: boolean; reason: string | null }> } | null = null;
export function resetDockerCheck() { docker = null; }
async function askDocker(source: Env): Promise<{ ok: boolean; reason: string | null }> {
	const { dockerBin } = await import("../providers/docker");
	const bin = dockerBin(source);
	let p: ReturnType<typeof Bun.spawn>;
	try { p = Bun.spawn([bin, "version", "--format", "{{.Server.Version}}"], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: source as Record<string, string> }); }
	catch { return { ok: false, reason: "Docker isn't installed" }; }
	const timer = setTimeout(() => p.kill(), 3_000);
	const [out, code] = await Promise.all([new Response(p.stdout as ReadableStream).text(), p.exited]).finally(() => clearTimeout(timer));
	return code === 0 && out.trim() ? { ok: true, reason: null } : { ok: false, reason: "Docker isn't running" };
}
/** Is a Docker daemon reachable? Asked at most every few seconds; `ask` (tests) replaces the docker CLI. */
export function dockerReachable(source: Env = process.env, ask: (s: Env) => Promise<{ ok: boolean; reason: string | null }> = askDocker): Promise<{ ok: boolean; reason: string | null }> {
	if (!docker || Date.now() - docker.at > DOCKER_TTL_MS) docker = { at: Date.now(), result: ask(source).catch(() => ({ ok: false, reason: "Docker isn't running" })) };
	return docker.result;
}

/** A boxd API key is configured: BOXD_API_KEY, or the key `capcomd setup` stored (keychain or credentials file). */
export function boxdKeyConfigured(source: Env = process.env): boolean {
	if (source.BOXD_API_KEY?.trim()) return true;
	if (source.CAPCOMD_NO_CONFIG) return false;
	const where = readConfig(userConfigPath(source)).boxdKey;
	if (where === "file") {
		const f = join(capcomdHome(source), "credentials");
		return existsSync(f) && typeof (readConfig(f) as Record<string, unknown>).BOXD_API_KEY === "string";
	}
	// The keychain is read when a CLI starts (applyConfig): a daemon started with it has BOXD_API_KEY set. Saying so here
	// spares a keychain prompt per request; a run started on boxd reads the keychain itself.
	return where === "keychain";
}

type Availability = { available: boolean; reason: string | null };
/** Each listed provider's availability check: cheap and local (a key is configured; the docker CLI answers, cached). */
const AVAILABLE: Record<RunSandbox, (source: Env, ask?: Parameters<typeof dockerReachable>[1]) => Promise<Availability>> = {
	boxd: async (source) => (boxdKeyConfigured(source) ? { available: true, reason: null } : { available: false, reason: "No boxd API key (run capcomd setup)" }),
	docker: async (source, ask) => { const d = await dockerReachable(source, ask); return { available: d.ok, reason: d.reason }; },
};
export async function sandboxAvailable(name: RunSandbox, source: Env = process.env, ask?: Parameters<typeof dockerReachable>[1]): Promise<Availability> {
	return AVAILABLE[name](source, ask);
}

/**
 * Can `provider` drive a run in sandbox `name` (drivers[].sandboxes)? Logins and agent environments are per sandbox
 * (src/providers/registry.ts providerStateFile), so the planner's check runs as that sandbox sees it, then the env
 * snapshot a real agent there boots from. Local files only. Whether the sandbox itself is up is sandboxAvailable.
 */
export function driverFit(provider: "claude" | "codex", name: RunSandbox, source: Env = process.env): DriverFit {
	const s = withSandbox(source, name);
	const where = { name, label: SANDBOX_LABEL[name] };
	let d: ReturnType<typeof plannerDriver>;
	try { d = plannerDriver(provider, undefined, s, undefined, where); } catch (e) { return { available: false, reason: (e as Error).message }; }
	if (!d.ok) return { available: false, reason: d.reason };
	if (envSnapshotProblem(provider, s)) return { available: false, reason: `No agent environment for ${where.label} yet (run \`capcomd env build --sandbox ${name}\`)` };
	return { available: true, reason: null };
}

/**
 * Can a run start with planner profile `p` now (GET /v1/run-options `planners`)? What its spawn would refuse, asked
 * before the run instead of at it (ADR-024 §8): its login, its project skills' and persona's trust, the trust of a
 * project's file that sets its `sandbox.provider` (a run started without a sandbox of its own), a `sandbox.provider`
 * outside the run's isolation, its `sandbox.environment` on its sandbox (its profile's `sandbox.provider`, else the
 * run's), an agent environment there, the CLI it recorded against `harness.cliVersion`, an egress limit that sandbox can't enforce, and the plugins its `lifecycle` names (the spawn's own
 * checks, src/primitives/ops.ts). Local files, and the daemon's plugin host (or, outside the daemon, its listing; with no daemon to
 * ask, a lifecycle isn't held against it: the spawn asks again). The first problem is the reason.
 */
export async function plannerReadiness(p: ResolvedProfile, source: Env = process.env): Promise<DriverFit> {
	const rt = p.runtime, provider = p.spec.provider;
	const s = withSandbox(source, rt.sandboxProvider);
	const where = rt.sandboxProvider ? { name: rt.sandboxProvider, label: (SANDBOX_LABEL as Record<string, string>)[rt.sandboxProvider] ?? rt.sandboxProvider } : undefined;
	const login = credentialReady(provider, p.spec.auth, s, where);
	if (!login.ready) return { available: false, reason: login.reason };
	const untrusted = untrustedProfileProblem(p.name, p.skills, p.persona, source);
	if (untrusted) return { available: false, reason: `${untrusted} (run \`capcomd profiles trust ${p.name}\`)` };
	const unmoved = untrustedSandboxProblem(p.name, rt.sandboxProvider, p.machineFiles, source);
	if (unmoved) return { available: false, reason: `${unmoved} (run \`capcomd profiles trust ${p.name}\`, or start the run with its own sandbox)` };
	const outside = isolationProblem(p.name, rt.sandboxProvider, source);
	if (outside) return { available: false, reason: `${outside} (name an isolated sandbox in its sandbox.provider, or remove it)` };
	if (rt.environment) {
		// A plan login kept in an image boots that image: the profile's environment must be the one it was made from.
		const kept = p.spec.auth === "subscription" ? profileFor(providerKind(provider), s) : null;
		try { bootSnapshot({ environment: rt.environment, real: false, login: kept ? { agent: providerKind(provider), ...(kept.snapshot ? { snapshot: kept.snapshot } : {}), env: kept.env } : null }, s); } catch (e) {
			if (!(e instanceof EnvironmentProblem)) throw e;
			return { available: false, reason: `profile ${p.name}: ${e.message}` };
		}
	}
	const env = envSnapshotProblem(provider, s, rt.environment);
	if (env) return { available: false, reason: env };
	const cli = cliVersionProblem({ name: p.name, provider, auth: p.spec.auth, range: rt.cliVersion, environment: rt.environment }, s);
	if (cli) return { available: false, reason: `${cli} (build an environment with a CLI in that range, or change its harness.cliVersion)` };
	const unkept = egressProblem(p.name, p.spec.egress, s);
	if (unkept) return { available: false, reason: `${unkept} (remove its egress, or run it on boxd)` };
	const unheard = (await lifecycleCheck(lifecyclePlugins(rt.lifecycle), source)).problem;
	if (unheard) return { available: false, reason: `profile ${p.name} can't be spawned: its ${unheard} (\`capcomd plugins list\` shows each plugin and its state)` };
	return { available: true, reason: null };
}

/** GET /v1/run-options `planners` (ADR-024 §5): every profile that can plan (it may spawn), in the profiles' order. */
export async function plannerOptions(source: Env = process.env): Promise<PlannerOption[]> {
	let set: ProfileSet;
	try { set = readProfiles(agentsFilePath(source), source); } catch { return []; } // GET /v1/profiles says why
	const planners = Object.values(set.profiles).filter((p) => p.spec.children?.allowSpawn);
	// A check that throws (a sandbox.provider this host doesn't know, say) leaves that planner not ready, in the daemon's
	// words (never the error's text); the others are still listed.
	const ready = (p: ResolvedProfile) => plannerReadiness(p, source).catch((): DriverFit => ({ available: false, reason: `profile ${p.name} can't be checked here (\`capcomd profiles validate\` says why)` }));
	return Promise.all(planners.map(async (p): Promise<PlannerOption> => ({
		name: p.name, title: profileFacts(p).title, provider: p.spec.provider, model: agentModel(p.spec, source) ?? null, default: p.name === DEFAULT_PLANNER,
		...(await ready(p)),
	})));
}

/** GET /v1/run-options?repo=: for a run of that project (its settings and agent profiles), as POST /v1/runs starts it. */
export async function runOptionsFor(repo: string | undefined, base: Env = process.env, ask?: Parameters<typeof dockerReachable>[1]): Promise<RunOptionsBody> {
	if (repo === undefined) return runOptions(base, ask);
	const { projectSource } = await import("./create-run");
	return runOptions(projectSource(repo, base), ask);
}

/** GET /v1/run-options. Both drivers and both sandboxes, always, in that order. */
export async function runOptions(source: Env = process.env, ask?: Parameters<typeof dockerReachable>[1]): Promise<RunOptionsBody> {
	let current: string | null = null;
	try { current = sandboxName(source); } catch { /* unknown CAPCOMD_SANDBOX: no default */ }
	const sandboxes = await Promise.all(RUN_SANDBOXES.map(async (name): Promise<SandboxOption> => ({ name, label: SANDBOX_LABEL[name], ...(await sandboxAvailable(name, source, ask)), default: current === name })));
	// The daemon's default planner profile: its provider is the default driver.
	const planner = plannerProfile(undefined, source);
	let defaultProvider: string | null = null;
	try { if (planner) defaultProvider = readProfiles(agentsFilePath(source), source).agents[planner]?.provider ?? null; } catch { /* unreadable agents file: no default */ }
	const drivers = DRIVERS.map((provider): DriverOption => {
		let d: ReturnType<typeof plannerDriver>;
		try { d = plannerDriver(provider, undefined, source); } catch (e) { d = { ok: false, code: "planner", reason: (e as Error).message, model: null, defaultEffort: providerDefaultEffort(provider) }; }
		const sandboxes = Object.fromEntries(RUN_SANDBOXES.map((n) => [n, driverFit(provider, n, source)])) as Record<RunSandbox, DriverFit>;
		return { provider, label: DRIVER_LABEL[provider], model: d.model, models: harnessModels(provider, source), efforts: [...providerEfforts(provider)], effort: d.defaultEffort, available: d.ok, reason: d.ok ? null : d.reason, default: defaultProvider === provider, sandboxes };
	});
	return { drivers, sandboxes, planners: await plannerOptions(source) };
}
