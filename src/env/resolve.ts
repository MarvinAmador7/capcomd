// Env snapshot naming, local ledger, and worker-side resolution.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { env as envVar } from "../utils/env";

export const ENV_PREFIX = "capcomd-env-";
export const ENV_SCHEMA = 1;

export interface EnvManifest {
  schema: number;
  /** Pinned versions requested (what installs when the image lacks a tool). */
  pins: { claude: string; codex: string; node: string };
  /** sha256 of the repo lockfile, or "none". */
  lockHash: string;
  lockFile: string;
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
  const canon = JSON.stringify({ schema: m.schema, pins: m.pins, lockHash: m.lockHash, repo: m.repo.replace(/\.git$/, "").toLowerCase() });
  return ENV_PREFIX + createHash("sha256").update(canon).digest("hex").slice(0, 16);
}

export function ledgerPath(source: Record<string, string | undefined> = process.env): string {
  return envVar("ENV_LEDGER", source) ?? resolve(new URL("../..", import.meta.url).pathname, ".relay", "envs.json");
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
  const cur = readLedger(ledgerPath(source)).current;
  if (!cur) return undefined;
  const repo = envVar("REPO", source);
  if (repo && cur.manifest.repo && norm(repo) !== norm(cur.manifest.repo)) return undefined;
  return cur.name;
}
const norm = (u: string) => u.replace(/\.git$/, "").replace(/^git@github\.com:/, "https://github.com/").toLowerCase();
