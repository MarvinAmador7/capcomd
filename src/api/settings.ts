// What the menu bar's Settings window shows: GET /v1/logins, /v1/environments and /v1/service. Cheap reads of local
// state only (the login and env ledgers of each sandbox, the env build marker, the service definition and, at most once
// every few seconds and for at most a second, launchctl/systemctl). Never a credential value: `how` and `detail` are
// written here from what kind of login it is, not from what the ledger holds.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { AGENT_API_HOST } from "../agents/config";
import { PROVIDER_KIND } from "../agents/profiles";
import { profileFor } from "../auth/profiles";
import { env as envVar } from "../utils/env";
import { withSandbox } from "../providers/run-sandbox";
import { LISTED_PROVIDERS, type ListedProvider } from "../providers/registry";
import { buildInProgress, buildMarkerPath, ledgerPath, readBuildMarker, readLedger, resolveEnvSnapshot, type EnvRecord } from "../env/resolve";
import { LABEL, servicePath, UNIT } from "../cli/commands/service";
import { isoTs } from "./envelope";

type Env = Record<string, string | undefined>;
/** The places Settings shows: the listed providers (src/providers/registry.ts), docker then boxd. */
export const SETTINGS_SANDBOXES = LISTED_PROVIDERS;
export type SettingsSandbox = ListedProvider;
const PROVIDERS = ["claude", "codex"] as const;
const API_KEY: Record<(typeof PROVIDERS)[number], string> = { claude: "ANTHROPIC_API_KEY", codex: "OPENAI_API_KEY" };

export interface LoginState { provider: "claude" | "codex"; sandbox: SettingsSandbox; loggedIn: boolean; how: "plan" | "api_key" | null; detail: string | null; hostBound: boolean; boundTo: string | null; command: string }
export interface EnvironmentState { sandbox: SettingsSandbox; status: "ready" | "missing" | "building" | "failed"; name: string | null; versions: Record<string, string>; builtAt: string | null; command: string }
export interface ServiceState { installed: boolean; loaded: boolean; installCommand: string; uninstallCommand: string }

/**
 * GET /v1/logins: who each AI's agents log in as, in each sandbox (plan logins are per sandbox: its auth ledger). A plan
 * login wins over an API key (it is what a subscription profile uses); an API key counts when the daemon has it in its
 * environment, or (boxd only) when CAPCOMD_CREDENTIALS=secret keeps it as a boxd secret. `hostBound`/`boundTo`: the
 * login is a host-bound secret (the ledger's `store: "secret"`, or CAPCOMD_CREDENTIALS=secret), so agents only see a
 * placeholder and the platform swaps the value in on the way to `boundTo`. `sandbox` limits it to one place.
 */
export function logins(source: Env = process.env, only?: SettingsSandbox): LoginState[] {
	return PROVIDERS.flatMap((provider) => SETTINGS_SANDBOXES.filter((x) => !only || x === only).map((sandbox): LoginState => {
		const s = withSandbox(source, sandbox);
		const command = `capcomd auth login ${provider} --sandbox ${sandbox}`;
		const host = AGENT_API_HOST[PROVIDER_KIND[provider]];
		const unbound = { hostBound: false, boundTo: null };
		const plan = profileFor(PROVIDER_KIND[provider], s);
		if (plan) {
			const detail = plan.store === "secret" ? `Kept as a boxd secret bound to ${host}` : plan.store === "snapshot" ? "Saved in the agent environment" : null;
			return { provider, sandbox, loggedIn: true, how: "plan", detail, ...(plan.store === "secret" ? { hostBound: true, boundTo: host } : unbound), command };
		}
		const key = API_KEY[provider];
		if (s[key]?.trim()) return { provider, sandbox, loggedIn: true, how: "api_key", detail: `${key} is set for capcomd`, ...unbound, command };
		if (sandbox === "boxd" && envVar("CREDENTIALS", s)?.toLowerCase() === "secret")
			return { provider, sandbox, loggedIn: true, how: "api_key", detail: `Kept as a boxd secret bound to ${host}`, hostBound: true, boundTo: host, command };
		return { provider, sandbox, loggedIn: false, how: null, detail: null, ...unbound, command };
	}));
}

const SNAPSHOT_NAME = /^[A-Za-z0-9._-]{1,128}$/;
const VERSION = /^[A-Za-z0-9.+_-]{1,64}$/;
/** The tool versions in an environment: its manifest pins, with what the build actually found or installed on top. */
function versionsOf(r: EnvRecord | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	if (!r) return out;
	for (const [k, v] of Object.entries(r.manifest?.pins ?? {})) if (typeof v === "string" && VERSION.test(v)) out[k] = v;
	for (const [k, v] of Object.entries(r.versions ?? {})) {
		const ver = (v as { version?: unknown; source?: unknown } | null)?.version;
		if ((v as { source?: unknown } | null)?.source !== "missing" && typeof ver === "string" && ver !== "unknown" && VERSION.test(ver) && SNAPSHOT_NAME.test(k)) out[k] = ver;
	}
	return out;
}

/**
 * GET /v1/environments: the agent environment each sandbox's agents boot from (its env ledger). `building` while a
 * `capcomd env build` for it is running (its marker, with a live pid); `failed` when the last build failed (name,
 * versions and builtAt then still describe the environment agents use, if any); else `ready` or `missing`.
 */
export function environments(source: Env = process.env, now = Date.now(), only?: SettingsSandbox): EnvironmentState[] {
	return SETTINGS_SANDBOXES.filter((x) => !only || x === only).map((sandbox): EnvironmentState => {
		const s = withSandbox(source, sandbox);
		const ledger = ledgerPath(s);
		const l = readLedger(ledger);
		const resolved = resolveEnvSnapshot(s);
		const name = resolved && SNAPSHOT_NAME.test(resolved) ? resolved : null;
		const record = name ? (l.current?.name === name ? l.current : l.history?.find((h) => h?.name === name)) : undefined;
		const built = record ? Date.parse(record.builtAt) : NaN;
		const marker = readBuildMarker(buildMarkerPath(ledger));
		const status = buildInProgress(marker, now) ? "building" : marker?.state === "failed" ? "failed" : name ? "ready" : "missing";
		return { sandbox, status, name, versions: versionsOf(record), builtAt: Number.isFinite(built) ? isoTs(built) : null, command: `capcomd env build --sandbox ${sandbox}` };
	});
}

// ---- The background service: its definition file, and whether launchd/systemd has it loaded (cached) ----
export const SERVICE_TTL_MS = 5_000;
export const SERVICE_PROBE_MS = 1_000;
export type LoadedProbe = (platform: NodeJS.Platform) => Promise<boolean>;
let loadedCache: { key: string; at: number; result: Promise<boolean> } | null = null;
export function resetServiceCheck() { loadedCache = null; }

/** Exit status 0 within `timeoutMs` (killed and false after it). */
export async function exitsZero(argv: string[], timeoutMs = SERVICE_PROBE_MS): Promise<boolean> {
	let p: ReturnType<typeof Bun.spawn>;
	try { p = Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore" }); } catch { return false; }
	const timer = setTimeout(() => p.kill(), timeoutMs);
	try { return (await p.exited) === 0; } finally { clearTimeout(timer); }
}
/** launchctl print / systemctl is-active, as `capcomd service status` asks. */
export const askLoaded: LoadedProbe = (platform) => platform === "darwin"
	? exitsZero(["launchctl", "print", `gui/${process.getuid?.() ?? ""}/${LABEL}`])
	: platform === "linux" ? exitsZero(["systemctl", "--user", "is-active", "--quiet", UNIT]) : Promise.resolve(false);

/** GET /v1/service. `home`, `platform` and `probe` are for tests (the real service is never touched there). */
export async function serviceState(o: { home?: string; platform?: NodeJS.Platform; probe?: LoadedProbe } = {}): Promise<ServiceState> {
	const platform = o.platform ?? process.platform;
	const path = servicePath(platform, o.home ?? homedir());
	const installed = !!path && existsSync(path);
	let loaded = false;
	if (installed) {
		const key = `${platform}:${path}`;
		if (!loadedCache || loadedCache.key !== key || Date.now() - loadedCache.at > SERVICE_TTL_MS)
			loadedCache = { key, at: Date.now(), result: (o.probe ?? askLoaded)(platform).catch(() => false) };
		loaded = await loadedCache.result;
	}
	return { installed, loaded, installCommand: "capcomd service install", uninstallCommand: "capcomd service uninstall" };
}
