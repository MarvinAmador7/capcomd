// GET /v1/run-options and the checks POST /v1/runs makes for `driver` and `sandbox`: who can drive a run (the planner
// agent's provider) and where its agents can run, with whether each can be used right now. Cheap checks only: the
// environment, the login ledger, the agents file; Docker's reachability is asked of the docker CLI at most every few
// seconds and shared by concurrent requests.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DRIVER_LABEL, DRIVERS, plannerDriver, plannerProfile } from "../agents/run-driver";
import { agentsFilePath, PROVIDER_DEFAULT_EFFORT, PROVIDER_EFFORTS, readAgentsFile } from "../agents/profiles";
import { readConfig, userConfigPath } from "../config/store";
import { LISTED_PROVIDERS, PROVIDER_LABEL, sandboxName, type ListedProvider } from "../providers/registry";
import { withSandbox } from "../providers/run-sandbox";
import { envSnapshotProblem } from "../primitives/ops";
import { capcomdHome } from "../utils/home";

type Env = Record<string, string | undefined>;
/** Where a run can go: the listed providers (src/providers/registry.ts), docker then boxd. */
export const RUN_SANDBOXES = LISTED_PROVIDERS;
export type RunSandbox = ListedProvider;
export const SANDBOX_LABEL: Record<RunSandbox, string> = PROVIDER_LABEL;

export interface DriverFit { available: boolean; reason: string | null }
export interface DriverOption { provider: "claude" | "codex"; label: string; model: string | null; efforts: string[]; effort: string | null; available: boolean; reason: string | null; default: boolean; sandboxes: Record<RunSandbox, DriverFit> }
export interface SandboxOption { name: RunSandbox; label: string; available: boolean; reason: string | null; default: boolean }

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

/** GET /v1/run-options?repo=: for a run of that project (its settings and agent profiles), as POST /v1/runs starts it. */
export async function runOptionsFor(repo: string | undefined, base: Env = process.env, ask?: Parameters<typeof dockerReachable>[1]): Promise<{ drivers: DriverOption[]; sandboxes: SandboxOption[] }> {
	if (repo === undefined) return runOptions(base, ask);
	const { projectSource } = await import("./create-run");
	return runOptions(projectSource(repo, base), ask);
}

/** GET /v1/run-options. Both drivers and both sandboxes, always, in that order. */
export async function runOptions(source: Env = process.env, ask?: Parameters<typeof dockerReachable>[1]): Promise<{ drivers: DriverOption[]; sandboxes: SandboxOption[] }> {
	let current: string | null = null;
	try { current = sandboxName(source); } catch { /* unknown CAPCOMD_SANDBOX: no default */ }
	const sandboxes = await Promise.all(RUN_SANDBOXES.map(async (name): Promise<SandboxOption> => ({ name, label: SANDBOX_LABEL[name], ...(await sandboxAvailable(name, source, ask)), default: current === name })));
	// The daemon's default planner profile: its provider is the default driver.
	const planner = plannerProfile(undefined, source);
	let defaultProvider: string | null = null;
	try { if (planner) defaultProvider = readAgentsFile(agentsFilePath(source)).agents[planner]?.provider ?? null; } catch { /* unreadable agents file: no default */ }
	const drivers = DRIVERS.map((provider): DriverOption => {
		let d: ReturnType<typeof plannerDriver>;
		try { d = plannerDriver(provider, undefined, source); } catch (e) { d = { ok: false, code: "planner", reason: (e as Error).message, model: null, defaultEffort: PROVIDER_DEFAULT_EFFORT[provider] }; }
		const sandboxes = Object.fromEntries(RUN_SANDBOXES.map((n) => [n, driverFit(provider, n, source)])) as Record<RunSandbox, DriverFit>;
		return { provider, label: DRIVER_LABEL[provider], model: d.model, efforts: [...PROVIDER_EFFORTS[provider]], effort: d.defaultEffort, available: d.ok, reason: d.ok ? null : d.reason, default: defaultProvider === provider, sandboxes };
	});
	return { drivers, sandboxes };
}
