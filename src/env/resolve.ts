// Env snapshot naming, local ledger, and worker-side resolution.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { env as envVar } from "../utils/env";
import { stateDir } from "../utils/home";
import { providerStateFile } from "../providers/registry";

export const ENV_PREFIX = "capcomd-env-";
export const ENV_SCHEMA = 1;

export interface EnvManifest {
  schema: number;
  /** Pinned versions requested (what installs when the image lacks a tool). */
  pins: { claude: string; codex: string; node: string };
  /** sha256 of the repo lockfile, or "none" (no repo given, or no lockfile). */
  lockHash: string;
  lockFile: string;
  /** Repo whose deps were baked in ("" when none). */
  repo: string;
}
export interface EnvRecord {
  name: string;
  manifest: EnvManifest;
  /** Versions actually present in the snapshot, and where each came from. */
  versions: Record<string, { version: string; source: "image" | "installed" | "missing" }>;
  builtAt: string;
  buildMs: number;
  depsInstalled: boolean;
}
export interface EnvLedger { current?: EnvRecord; history: EnvRecord[] }

/** Content hash of pins + lockfile; same inputs → same snapshot name → build is skipped. */
export function envName(m: EnvManifest): string {
  // Repo is informational only: any repo with the same lockfile (or none) shares the snapshot.
  const canon = JSON.stringify({ schema: m.schema, pins: m.pins, lockHash: m.lockHash });
  return ENV_PREFIX + createHash("sha256").update(canon).digest("hex").slice(0, 16);
}

export function ledgerPath(source: Record<string, string | undefined> = process.env): string {
  return envVar("ENV_LEDGER", source) ?? join(stateDir(source), providerStateFile("envs.json", source));
}
export function readLedger(path = ledgerPath()): EnvLedger {
  if (!existsSync(path)) return { history: [] };
  try { const l = JSON.parse(readFileSync(path, "utf8")); return { history: [], ...l }; } catch { return { history: [] }; }
}
export function writeLedger(l: EnvLedger, path = ledgerPath()) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(l, null, 2) + "\n");
}

/**
 * Which snapshot real-agent workers boot from. CAPCOMD_ENV=image forces the default image;
 * CAPCOMD_ENV_SNAPSHOT names one explicitly; otherwise the ledger's current build (for this repo).
 */
export function resolveEnvSnapshot(source: Record<string, string | undefined> = process.env): string | undefined {
  if ((envVar("ENV", source) ?? "").toLowerCase() === "image") return undefined;
  const explicit = envVar("ENV_SNAPSHOT", source);
  if (explicit) return explicit;
  // Lockfile mismatch only means the worker installs deps itself; CLIs + git config still apply.
  return readLedger(ledgerPath(source)).current?.name;
}
