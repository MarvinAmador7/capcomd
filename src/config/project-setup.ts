// Setting a checkout up as a capcomd project, without asking anything: the facts about a folder (its git root, origin,
// branches, a check to suggest), the answers turned into a plan (the project config and the agent profiles), and the
// plan written. `capcomd setup project` (src/cli/commands/setup.ts) asks the questions and calls this; the harness API
// (POST /v1/projects, src/api/projects.ts) takes the answers from the app and calls the same code, so both write the
// same two files: <checkout>/.capcomd/config.json and <checkout>/.capcomd/agents.json.
import { spawnSync } from "child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "fs";
import { dirname, isAbsolute, join, relative } from "path";
import { configText, mergeConfig, readConfig, userConfigPath, type CapcomdConfig } from "./store";
import { AGENTS_SCHEMA, readAgentsFile, validateFile, validateSpec, writeAgentsFile, type AgentSpec, type AgentsFile } from "../agents/profiles";

type Env = Record<string, string | undefined>;

// ── git facts (local only: no fetch, no network) ─────────────────────────────────────────────
const git = (args: string[], cwd: string) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 10_000 });
  return { code: r.status ?? 1, out: (r.stdout ?? "").trim() };
};
/** The checkout `d` is in (`git rev-parse --show-toplevel`), or null when it isn't one. */
export function gitRoot(d: string): string | null {
  const r = git(["rev-parse", "--show-toplevel"], d);
  return r.code === 0 && r.out ? r.out : null;
}
/** origin's URL as git has it ("" when there is no origin). */
export const originUrl = (dir: string) => git(["remote", "get-url", "origin"], dir).out;
/** origin's default branch (origin/HEAD), "" when git doesn't know it. */
export const originHead = (dir: string) => git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], dir).out.replace(/^origin\//, "");
/** origin's branches as the local refs know them (no fetch), sorted; HEAD left out. */
export function remoteBranches(dir: string, max = 200): string[] {
  const r = git(["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin"], dir);
  if (r.code !== 0) return [];
  return [...new Set(r.out.split("\n").map((s) => s.trim().replace(/^origin\//, "")).filter((s) => s && s !== "HEAD" && s !== "origin"))].sort().slice(0, max);
}

/** git@github.com:o/r.git → https://github.com/o/r.git (VMs clone over https with a per-push credential). */
export function httpsRemote(url: string): string {
  const m = /^git@([^:]+):(.+?)(\.git)?$/.exec(url.trim());
  if (m) return `https://${m[1]}/${m[2]}.git`;
  const s = /^ssh:\/\/git@([^/]+)\/(.+?)(\.git)?$/.exec(url.trim());
  return s ? `https://${s[1]}/${s[2]}.git` : url.trim();
}
/** owner/repo for a GitHub remote, else null. */
export function githubRepoOf(url: string): string | null {
  const m = /github\.com[/:]([^/]+)\/([^/]+?)(\.git)?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}
/** A test command from the project's files: package.json "test" (bun or npm), else null. */
export function suggestCheck(dir: string): string | null {
  const pj = join(dir, "package.json");
  if (!existsSync(pj)) return null;
  try {
    const p = JSON.parse(readFileSync(pj, "utf8"));
    const usesBun = existsSync(join(dir, "bun.lock")) || existsSync(join(dir, "bun.lockb"));
    if (p.scripts?.test) return usesBun ? "bun run test" : "npm test";
    return usesBun ? "bun test" : null;
  } catch { return null; }
}

/** The path with its symlinks resolved, as far as they exist (the rest appended). */
export function realish(f: string): string {
  const d = dirname(f);
  if (d === f) return f;
  try { return join(realpathSync(d), f.slice(d.length + 1)); } catch { return join(realish(d), f.slice(d.length + 1)); }
}
/** `dir`'s .capcomd/config.json would be capcomd's own user config (the home directory, or CAPCOMD_HOME's parent). */
export const isUserConfigDir = (dir: string, env: Env = process.env) => realish(join(dir, ".capcomd", "config.json")) === realish(userConfigPath(env));

/** A spend cap per run from what was typed ("20", "usd=20"; empty or "none": no cap). */
export function parseBudget(raw: string): { cap: string | null } | { error: string } {
  const t = raw.trim();
  if (!t || t === "none") return { cap: null };
  const usd = Number(t.replace(/^usd=/, ""));
  if (!(usd > 0)) return { error: `"${t}" isn't an amount in USD` };
  return { cap: budgetCap(usd) };
}
export const budgetCap = (usd: number) => `usd=${usd}`;

// ── answers → plan → files ───────────────────────────────────────────────────────────────────
export interface ProjectAnswers {
  /** The checkout (its settings go in its .capcomd/). */
  dir: string;
  /** The repository agents work on, as an https URL. */
  repo: string;
  mode: string;
  target: string;
  /** The check every change must pass ("" for none). */
  check: string;
  /** claude and/or codex, in the order chosen. */
  agents: string[];
  /** How each agent logs in: subscription or apikey. */
  authOf: (agent: string) => string;
  /** driver.maxRunBudget ("usd=20"), null for none. */
  cap: string | null;
}
export interface ProjectPlan {
  dir: string;
  configPath: string;
  agentsPath: string;
  /** What goes into .capcomd/config.json (merged into what's there). */
  patch: CapcomdConfig;
  cap: string | null;
  /** The profiles to add, in order: one worker per agent, a read-only reviewer, a planner that may spawn the workers. */
  profiles: Array<[string, Record<string, unknown>]>;
}

/** The two files' contents for these answers. No turn, time or money limits on the profiles (ADR-019). */
export function planProject(a: ProjectAnswers): ProjectPlan {
  const gh = githubRepoOf(a.repo);
  const provider = a.agents.includes("claude") ? "claude" : "codex";
  const auth = a.authOf(provider);
  const workers = a.agents.map((x) => (x === provider ? "worker" : `${x}-worker`));
  const profiles: Array<[string, Record<string, unknown>]> = [
    ...a.agents.map((x, i): [string, Record<string, unknown>] => [workers[i]!, { provider: x, auth: a.authOf(x) }]),
    ["reviewer", { provider, auth, allowedTools: ["Read", "Glob", "Grep", "LS", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git show:*)", "Bash(cat:*)", "Bash(ls:*)", ...(a.check ? [`Bash(${a.check.split(" ").slice(0, 2).join(" ")}:*)`] : [])] }],
    // No fan-out limits either: the planner may spawn workers as it sees fit (set children.* to bound it).
    ["planner", { provider, auth, children: { allowSpawn: true, allowedChildProfiles: workers } }],
  ];
  return {
    dir: a.dir, configPath: join(a.dir, ".capcomd", "config.json"), agentsPath: join(a.dir, ".capcomd", "agents.json"), cap: a.cap, profiles,
    patch: {
      env: { CAPCOMD_REPO: a.repo, CAPCOMD_MERGE_MODE: a.mode, CAPCOMD_MERGE_TARGET: a.target, ...(gh ? { CAPCOMD_GITHUB_REPO: gh } : {}) },
      run: { ...(a.check ? { checks: { unit: a.check } } : {}), reviewer: "reviewer" },
    },
  };
}

/** A plan that can't be written as asked (a .capcomd that leads out of the checkout, an unreadable agents file). */
export class ProjectWriteError extends Error {}

export interface ProjectWrite { config: CapcomdConfig; configChanged: boolean; made: string[]; kept: string[] }

/**
 * Write a plan: the project config merged into what's there (as `capcomd setup` always has), and each profile added
 * unless one of that name exists (your edits survive). Both files are replaced atomically (tmp + rename).
 * `strict` (the API): refuse a .capcomd, config.json or agents.json whose real path leaves the checkout, and an agents
 * file that doesn't read, before writing anything. Without it (the CLI), an unreadable agents file keeps every profile.
 */
export function writeProject(plan: ProjectPlan, o: { strict?: boolean } = {}): ProjectWrite {
  if (o.strict) checkContained(plan);
  // Profiles first (in memory), so a strict write refuses before touching the config.
  let file: AgentsFile | null;
  try { file = readAgentsFile(plan.agentsPath); } catch (e) {
    if (o.strict) throw new ProjectWriteError(`${plan.agentsPath} can't be read (${(e as Error).message}). Fix it or move it away, then set the project up again.`);
    file = null;
  }
  const made: string[] = [], kept: string[] = [];
  for (const [name, spec] of plan.profiles) {
    // As `capcomd agents add <name> --spec …` (one per profile): an existing name, or a profile the file won't take, is kept.
    if (!file || file.agents[name] || validateSpec(name, spec).length) { kept.push(name); continue; }
    const next: AgentsFile = { ...file, schema: AGENTS_SCHEMA, agents: { ...file.agents, [name]: spec as unknown as AgentSpec } };
    if (!next.default) next.default = name;
    if (validateFile(next).length) { kept.push(name); continue; }
    file = next; made.push(name);
  }
  const cur = readConfig(plan.configPath);
  const patch: CapcomdConfig = { ...plan.patch, ...(plan.cap ? { driver: { ...cur.driver, maxRunBudget: plan.cap } } : {}) };
  const config = mergeConfig(cur, patch);
  const before = existsSync(plan.configPath) ? readFileSync(plan.configPath, "utf8") : null;
  const text = configText(config);
  mkdirSync(dirname(plan.configPath), { recursive: true });
  atomicWrite(plan.configPath, text, 0o600);
  if (made.length && file) writeAgentsFile(file, plan.agentsPath);
  return { config, configChanged: before !== text, made, kept };
}

function atomicWrite(path: string, text: string, mode: number) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now().toString(36)}`;
  writeFileSync(tmp, text, { mode });
  renameSync(tmp, path);
}

const inside = (child: string, parent: string) => { const r = relative(parent, child); return r === "" || (!!r && !r.startsWith("..") && !isAbsolute(r)); };
/** .capcomd and its two files must stay inside the checkout (no symlink out of it), and .capcomd must be a folder. */
function checkContained(plan: ProjectPlan) {
  let root: string;
  try { root = realpathSync(plan.dir); } catch { throw new ProjectWriteError(`${plan.dir} doesn't exist any more.`); }
  const dot = join(plan.dir, ".capcomd");
  const out = (p: string) => new ProjectWriteError(`${p} leads outside the checkout (a symlink), so capcomd won't write there. Remove the link, or set the project up with \`capcomd setup project\` in Terminal.`);
  if (exists(dot)) {
    let real: string;
    try { real = realpathSync(dot); } catch { throw out(dot); }
    if (!inside(real, root)) throw out(dot);
    if (!lstatSync(real).isDirectory()) throw new ProjectWriteError(`${dot} isn't a folder, so capcomd can't keep the project's settings in it.`);
  }
  for (const f of [plan.configPath, plan.agentsPath]) {
    if (!exists(f)) continue;
    let real: string;
    try { real = realpathSync(f); } catch { throw out(f); }   // a dangling link
    if (!inside(real, root)) throw out(f);
  }
}
const exists = (p: string) => { try { lstatSync(p); return true; } catch { return false; } };

// ── what a project has now ───────────────────────────────────────────────────────────────────
export interface ProjectValues { repo: string | null; mode: string | null; target: string | null; check: string; agents: string[]; budgetUsd: number | null }

/** The settings `capcomd setup project` wrote in `dir` (null when its .capcomd/config.json names no repository). */
export function projectValues(dir: string): ProjectValues | null {
  const cfg = readConfig(join(dir, ".capcomd", "config.json"));
  const repo = cfg.env?.CAPCOMD_REPO;
  if (typeof repo !== "string" || !repo) return null;
  let agents: string[] = [];
  try {
    const f = readAgentsFile(join(dir, ".capcomd", "agents.json"));
    // The workers setup made: "worker" (the first agent) and "<agent>-worker".
    const ws = Object.entries(f.agents).filter(([n]) => n === "worker" || n.endsWith("-worker")).map(([, s]) => s.provider);
    agents = (["claude", "codex"] as const).filter((p) => ws.includes(p));
  } catch { /* unreadable: none */ }
  const m = /^usd=([0-9.]+)/.exec(cfg.driver?.maxRunBudget ?? "");
  return {
    repo, mode: cfg.env?.CAPCOMD_MERGE_MODE ?? null, target: cfg.run?.target ?? cfg.env?.CAPCOMD_MERGE_TARGET ?? null,
    check: cfg.run?.checks?.unit ?? "", agents, budgetUsd: m ? Number(m[1]) : null,
  };
}
