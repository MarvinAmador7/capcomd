import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { env as envVar } from "../utils/env";

export type MergeMode = "pr" | "direct";
export type MergeStrategy = "squash" | "rebase" | "merge";

/**
 * Per-repo merge configuration. Sources, later wins:
 *   1. built-in defaults (mode=pr, strategy=squash, target=main)
 *   2. `.capcomd.json` → `{ "merge": { ... } }` at the root of the target branch (read after fetch)
 *   3. CAPCOMD_* env (RELAY_* deprecated aliases)
 * No CAPCOMD_REPO → no repository: merges are recorded as `mode: "none"` (explicit dry run).
 */
export interface MergeConfig {
  /** Remote URL or path (bare repo). */
  remote: string;
  mode: MergeMode;
  strategy: MergeStrategy;
  /** Default target branch when the run doesn't name one. */
  target: string;
  /** Shell command run in the merged worktree; empty = no tests configured. */
  testCommand: string;
  /** Push-rejection retries (direct mode). */
  maxPushRetries: number;
  /** Sign commits capcomd creates (git -S / --gpg-sign). Uses the user's git signing config. */
  signCommits: boolean;
  /** Where capcomd keeps its clones and locks. */
  workdir: string;
  /** GitHub (pr mode). */
  github: { repo: string | null; api: string; pollMs: number; timeoutMs: number };
}

export function repoConfigured(source: Record<string, string | undefined> = process.env): boolean {
  return !!envVar("REPO", source);
}

const MODES = new Set(["pr", "direct"]);
const STRATEGIES = new Set(["squash", "rebase", "merge"]);

export function loadMergeConfig(source: Record<string, string | undefined> = process.env, repoFile?: unknown): MergeConfig | null {
  const remote = envVar("REPO", source);
  if (!remote) return null;
  const file = ((repoFile as any)?.merge ?? {}) as Partial<Record<string, any>>;
  const pick = (name: string, fileKey: string, dflt: string) => envVar(name, source) ?? (file[fileKey] !== undefined ? String(file[fileKey]) : dflt);
  const mode = pick("MERGE_MODE", "mode", "pr");
  const strategy = pick("MERGE_STRATEGY", "strategy", "squash");
  if (!MODES.has(mode)) throw new Error(`CAPCOMD_MERGE_MODE=${mode} (expected pr|direct)`);
  if (!STRATEGIES.has(strategy)) throw new Error(`CAPCOMD_MERGE_STRATEGY=${strategy} (expected squash|rebase|merge)`);
  return {
    remote,
    mode: mode as MergeMode,
    strategy: strategy as MergeStrategy,
    target: pick("MERGE_TARGET", "target", "main"),
    testCommand: pick("TEST_COMMAND", "test", ""),
    maxPushRetries: Number(pick("MERGE_MAX_RETRIES", "maxPushRetries", "5")),
    signCommits: ["1", "true"].includes(pick("SIGN_COMMITS", "signCommits", "false")),
    workdir: envVar("WORKDIR", source) ?? join(homedir(), ".capcomd", "work"),
    github: {
      repo: envVar("GITHUB_REPO", source) ?? (file.github ? String(file.github) : null) ?? githubRepoFromRemote(remote),
      api: envVar("GITHUB_API", source) ?? "https://api.github.com",
      pollMs: Number(envVar("GITHUB_POLL_MS", source) ?? 5000),
      timeoutMs: Number(envVar("GITHUB_TIMEOUT_MS", source) ?? 30 * 60_000),
    },
  };
}

/** Re-read config with `.capcomd.json` from a checked-out target tree (env still wins). */
export function withRepoFile(base: MergeConfig, worktree: string, source: Record<string, string | undefined> = process.env): MergeConfig {
  const path = join(worktree, ".capcomd.json");
  if (!existsSync(path)) return base;
  try {
    return { ...loadMergeConfig(source, JSON.parse(readFileSync(path, "utf8")))!, workdir: base.workdir };
  } catch {
    return base;
  }
}

export function githubRepoFromRemote(remote: string): string | null {
  const m = remote.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

/** capcomd/<run>/<task>: one branch per task, cut from the target tip. */
export function taskBranch(runId: string, taskId: string): string {
  return `capcomd/${runId}/${taskId}`;
}

/** Trailer that identifies a task's change in history (idempotency key). */
export function taskKey(runId: string, taskId: string): string {
  return `${runId}/${taskId}`;
}
