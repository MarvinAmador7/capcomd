// ADR-021 §2 (phase 2): provider settings the user can change. Today one, the idle machine lifetime: how long a machine
// capcomd made lives without its lease being renewed (a running agent renews it every 10 minutes), so one left behind
// (a crash, a stopped run) is deleted and stops billing. Precedence: CAPCOMD_SANDBOX_IDLE_SECONDS in capcomd's
// environment, then the user config (`~/.capcomd/config.json` `sandboxes.<name>.idleLifetime`, seconds), then the
// default (1 hour). Settings live in the user config, never the project's: they decide billing for the machine and
// account. `run new` records the value with the run (src/providers/run-sandbox.ts), so a change applies to new runs
// and needs no restart.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { userConfigPath } from "../config/store";

type Env = Record<string, string | undefined>;

export const IDLE_LIFETIME_ENV = "CAPCOMD_SANDBOX_IDLE_SECONDS";
/** 1 hour. */
export const IDLE_LIFETIME_DEFAULT = 3600;
/** 15 minutes: the lease is renewed every 10, so anything shorter would delete live machines between renewals. */
export const IDLE_LIFETIME_MIN = 900;
/** The presets the app offers (decided 2026-10-27): the same on every provider. */
export const IDLE_LIFETIME_PRESETS = [900, 3600, 14400, 43200] as const;

export type SettingSource = "default" | "env" | "config";
export interface IdleLifetime { seconds: number; source: SettingSource }

/** CAPCOMD_SANDBOX_IDLE_SECONDS as seconds: a positive whole number, raised to the 15-minute minimum; null when unset or
 *  not a number (then the user config and the default apply). */
export function idleLifetimeFromEnv(env: Env = process.env): number | null {
	const raw = env[IDLE_LIFETIME_ENV]?.trim();
	if (!raw || !/^\d+$/.test(raw)) return null;
	const n = Number(raw);
	if (!Number.isSafeInteger(n) || n <= 0) return null;
	return Math.max(n, IDLE_LIFETIME_MIN);
}

/** A lifetime capcomd accepts from its own records (the user config, a run's recorded settings): whole seconds, at
 *  least the minimum, at most a week. */
export function validLifetime(v: unknown): number | null {
	const n = typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v) : v;
	return typeof n === "number" && Number.isSafeInteger(n) && n >= IDLE_LIFETIME_MIN && n <= 7 * 86_400 ? n : null;
}

/** The user config file the settings live in; null when settings are off (CAPCOMD_NO_CONFIG, which tests set). */
export function settingsPath(env: Env = process.env): string | null {
	return env.CAPCOMD_NO_CONFIG ? null : userConfigPath(env);
}

/** Where provider settings are kept: the user config file, or memory (tests, the in-memory API source). */
export interface SettingsStore {
	/** The stored values for one provider (only valid ones). */
	read(name: string): { idleLifetime?: number };
	/** Whether a value can be written at all (false while settings are off). */
	writable(): boolean;
	write(name: string, id: "idleLifetime", value: number): void;
}

export class ConfigFileError extends Error {}

function readRaw(path: string): Record<string, unknown> {
	if (!existsSync(path)) return {};
	const text = readFileSync(path, "utf8");
	if (!text.trim()) return {};
	let v: unknown;
	try { v = JSON.parse(text); } catch { throw new ConfigFileError(`capcomd's user config (${path}) isn't valid JSON: fix it or remove it, then try again`); }
	if (!v || typeof v !== "object" || Array.isArray(v)) throw new ConfigFileError(`capcomd's user config (${path}) isn't a JSON object: fix it or remove it, then try again`);
	return v as Record<string, unknown>;
}

/**
 * The user config (`~/.capcomd/config.json`, or $CAPCOMD_HOME's). Writes keep every other key, go to a temporary file
 * in the same directory and are renamed over the old one (0600), so a reader never sees half a file.
 */
export function fileSettingsStore(path: string | null): SettingsStore {
	return {
		read(name) {
			if (!path) return {};
			let raw: Record<string, unknown>;
			try { raw = readRaw(path); } catch { return {}; }
			const all = raw.sandboxes;
			const mine = all && typeof all === "object" ? (all as Record<string, unknown>)[name] : undefined;
			const v = mine && typeof mine === "object" ? validLifetime((mine as Record<string, unknown>).idleLifetime) : null;
			return v !== null ? { idleLifetime: v } : {};
		},
		writable: () => path !== null,
		write(name, id, value) {
			if (!path) throw new ConfigFileError("capcomd's settings are off (CAPCOMD_NO_CONFIG is set in its environment)");
			const raw = readRaw(path);
			const all = raw.sandboxes && typeof raw.sandboxes === "object" && !Array.isArray(raw.sandboxes) ? { ...(raw.sandboxes as Record<string, unknown>) } : {};
			const mine = all[name] && typeof all[name] === "object" && !Array.isArray(all[name]) ? { ...(all[name] as Record<string, unknown>) } : {};
			mine[id] = value;
			all[name] = mine;
			const next = { ...raw, sandboxes: all };
			mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
			const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
			writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
			renameSync(tmp, path);
		},
	};
}

/** Settings in memory (tests and the in-memory API source). */
export function memorySettingsStore(initial: Record<string, { idleLifetime?: number }> = {}, o: { writable?: boolean } = {}): SettingsStore & { values: Record<string, { idleLifetime?: number }> } {
	const values: Record<string, { idleLifetime?: number }> = JSON.parse(JSON.stringify(initial));
	return {
		values,
		read: (name) => ({ ...(values[name] ?? {}) }),
		writable: () => o.writable ?? true,
		write(name, id, value) { (values[name] ??= {})[id] = value; },
	};
}

/** The idle lifetime machines on `name` get now: the environment variable, else the user config, else 1 hour. */
export function currentIdleLifetime(name: string, o: { env?: Env; store?: SettingsStore } = {}): IdleLifetime {
	const env = o.env ?? process.env;
	const fromEnv = idleLifetimeFromEnv(env);
	if (fromEnv !== null) return { seconds: fromEnv, source: "env" };
	const stored = (o.store ?? fileSettingsStore(settingsPath(env))).read(name).idleLifetime;
	if (stored !== undefined) return { seconds: stored, source: "config" };
	return { seconds: IDLE_LIFETIME_DEFAULT, source: "default" };
}

/** What `run new` records with a run (`_sandbox.settings`): the provider's settings as they are now. */
export function settingsForRun(name: string, o: { env?: Env; store?: SettingsStore } = {}): { idleLifetime: number } {
	return { idleLifetime: currentIdleLifetime(name, o).seconds };
}
