// What the built-in agent providers (agent-claude, agent-codex; docs/spec/plugin-api.md §7.3) share: reading a JSON
// line, a tool call's identity for the stuck watch, and how a runner error is classified. Plugin code only: it imports
// the plugin API, never the kernel.
import { redactJson, type ErrorClass } from "../../packages/plugin/src/seams";
import type { PluginManifest } from "../../packages/plugin/src/manifest";
import { VERSION } from "../utils/self";

/** One line of a CLI's JSON stream, redacted; null for a partial or non-object line. */
export function parseJson(line: string, redact: (s: string) => string): any | null {
  let raw: any;
  try { raw = JSON.parse(line); } catch { return null; }
  if (!raw || typeof raw !== "object") return null;
  return redactJson(raw, redact);
}

/** A tool call's identity for the stuck watch (ADR-019 §2): the same name and input is the same call. */
export const toolCall = (name: unknown, input: unknown) => `${String(name)} ${JSON.stringify(input ?? {})}`.slice(0, 1000);
export const contentText = (c: unknown) =>
  (typeof c === "string" ? c : Array.isArray(c) ? c.map((x: any) => (typeof x?.text === "string" ? x.text : "")).join("\n") : "").slice(0, 1000);

/** §7.2.3 for an agent run: the runner's AgentError kinds (`src/agents/runner.ts`) as the kernel's classes. */
export function classifyAgentError(e: unknown, login: string): ErrorClass {
  const kind = e && typeof e === "object" && "kind" in e ? String((e as { kind: unknown }).kind) : "";
  if (kind === "credentials") return { kind: "auth", retryable: false, hint: login };
  if (kind === "cancelled") return { kind: "not_found", retryable: false };
  return { kind: "unknown", retryable: false };
}

/** A built-in agent provider's manifest (§4.1: built-ins carry the capcomd version and accept only it). */
export function agentManifest(name: string, seam: string, description: string): PluginManifest {
  return {
    schema: "capcomd.plugin/v1", name, version: VERSION, description, apiVersion: 1,
    engines: { capcomd: VERSION }, entry: { runtime: "in-process", module: `./${name}.ts` },
    provides: [`seam:agent/${seam}`], contributes: { seams: [{ kind: "agent", name: seam }] },
  } as PluginManifest;
}

/**
 * docs/spec/plugin-api.md §16.1: what an `orchestrate` agent (a planner, a lead) may run in its shell. It sees
 * everything: the repository's history and any branch (fetched, logged, shown, diffed, or checked out detached to read
 * with the file tools), the files, and capcomd's whole read surface (`capcomd …`: events, logs, trace, status, verify
 * and merge reports with their check output). It runs nothing that changes code or executes it: no edits, commits,
 * merges, rebases or pushes (its children's work lands through `capcomd verify`/`merge`), no installs, no builds or
 * tests (the checks run at verify and merge, and their output is readable). Each entry is a command prefix: the
 * command's first words.
 */
export const ORCHESTRATE_READ_COMMANDS: readonly string[] = [
  "capcomd",
  "git fetch", "git log", "git show", "git diff", "git status", "git ls-tree", "git ls-files", "git rev-parse", "git rev-list",
  "git blame", "git grep", "git cat-file", "git merge-base", "git describe", "git shortlog", "git for-each-ref",
  "git branch -a", "git branch -r", "git branch -v", "git branch -vv", "git branch --list", "git branch --show-current", "git branch --contains",
  "git remote -v", "git switch --detach", "git checkout --detach",
  "ls", "cat", "head", "tail", "wc", "grep", "rg", "jq", "sort", "uniq", "cut", "tr", "diff", "file", "stat", "tree", "pwd",
  "echo", "basename", "dirname", "realpath",
];
/** Exact read-only commands (no arguments) that a prefix would make too wide (`git branch` alone lists; with a name, it creates one). */
export const ORCHESTRATE_READ_EXACT: readonly string[] = ["git branch", "git remote"];
/** What an orchestrate agent never runs: changes to code or history, installs, builds and tests. */
export const ORCHESTRATE_DENIED_COMMANDS: readonly string[] = [
  "git commit", "git push", "git merge", "git rebase", "git reset", "git pull", "git cherry-pick", "git revert", "git am", "git apply",
  "git add", "git rm", "git mv", "git restore", "git clean", "git stash", "git tag", "git worktree", "git update-ref", "git checkout -b",
  "git checkout -B", "git switch -c", "git switch -C", "git branch -d", "git branch -D", "git branch -m", "git branch -M", "git branch -f",
  "bun test", "bun run", "bun install", "bun add", "bun remove", "bun x", "bun build", "bunx", "npm", "npx", "pnpm", "yarn",
  "pip", "pip3", "uv", "cargo", "go", "make", "pytest", "jest", "vitest", "tsc", "node", "deno", "python", "python3",
  "rm", "mv", "cp", "touch", "mkdir", "tee", "sed -i", "chmod",
];
