// Setting a checkout up as a capcomd project, without asking anything: the facts about a folder (its git root, origin,
// branches, a check to suggest), the answers turned into a plan (the project config and the agent profiles), and the
// plan written. `capcomd setup project` (src/cli/commands/setup.ts) asks the questions and calls this; the harness API
// (POST /v1/projects, src/api/projects.ts) takes the answers from the app and calls the same code, so both write the
// same files: <checkout>/.capcomd/config.json and a profile file per profile in <checkout>/.capcomd/profiles/
// (ADR-024 §6, §7 step 9: `<name>.yaml`, schema capcomd.profile/v2).
import { spawnSync } from "child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "fs";
import { dirname, isAbsolute, join, relative } from "path";
import { configText, mergeConfig, readConfig, userConfigPath, type CapcomdConfig } from "./store";
import { AgentConfigError, BUNDLED_PROFILES, PROFILE_SCHEMA, profileFileText, readProfiles, writeAtomic, type ProfileDoc, type ProfileSet } from "../profiles";
import { CONSOLIDATOR_PROFILE } from "../context/consolidate";

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

/** git@github.com:o/r.git → https://github.com/o/r.git, for any host (capcomd's host git uses the https remote, where a
 *  forge's credential for it applies: docs/spec/plugin-api.md §7.4 remoteCredential). */
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

/** The project's package manager, from its lockfile (else the check's own command, else npm for a package.json). */
function packageManager(dir: string, check: string): "bun" | "pnpm" | "yarn" | "npm" | null {
  if (existsSync(join(dir, "bun.lock")) || existsSync(join(dir, "bun.lockb"))) return "bun";
  if (existsSync(join(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(dir, "yarn.lock"))) return "yarn";
  const first = /^\s*(bun|pnpm|yarn|npm)\b/.exec(check)?.[1] as "bun" | "pnpm" | "yarn" | "npm" | undefined;
  if (first) return first;
  return existsSync(join(dir, "package.json")) ? "npm" : null;
}

/**
 * The Bash rules a read-only reviewer needs to run the project's tests: each command of the check (its first two
 * words, e.g. `bun run test && bun x tsc` → `Bash(bun run:*)`, `Bash(bun x:*)`), and the test runner of the project's
 * package manager or toolchain (`bun test`, `npm test`, `pnpm test`, `yarn test`, `cargo test`, `go test`, `pytest`).
 */
export function testTools(check: string, dir: string): string[] {
  const rules = new Set<string>();
  for (const part of check.split(/&&|\|\||;|\|/)) {
    const words = part.trim().split(/\s+/).filter((w) => w && !/^[A-Z_][A-Z0-9_]*=/.test(w));
    if (words.length) rules.add(`Bash(${words.slice(0, 2).join(" ")}:*)`);
  }
  const pm = packageManager(dir, check);
  if (pm) for (const sub of ["test", "run"]) rules.add(`Bash(${pm} ${sub}:*)`);
  if (existsSync(join(dir, "Cargo.toml"))) rules.add("Bash(cargo test:*)");
  if (existsSync(join(dir, "go.mod"))) rules.add("Bash(go test:*)");
  if (["pyproject.toml", "setup.py", "pytest.ini"].some((f) => existsSync(join(dir, f)))) { rules.add("Bash(pytest:*)"); rules.add("Bash(python -m pytest:*)"); }
  return [...rules];
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
  /** The branch runs start from and merge into; null: none known (runs then ask for their base; never a guessed main). */
  target: string | null;
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
  /** The agents file the project's profiles are read with (.capcomd/agents.json, which needn't exist): its profiles/
   *  folder beside it is the project's layer. */
  agentsPath: string;
  /** Where the profiles go: .capcomd/profiles/, one `<name>.yaml` each. */
  profilesDir: string;
  /** What goes into .capcomd/config.json (merged into what's there). */
  patch: CapcomdConfig;
  cap: string | null;
  /** The profiles to add, in order, as profile files (ADR-024 §6): one worker per agent, a read-only reviewer and a
   *  lead that extend the worker, the consolidator the planner spawns last, and a planner that extends the worker and
   *  may spawn the rest. Each written at version 1; the first worker is the default when the project has none. */
  profiles: Array<[string, ProfileDoc]>;
}

/** What the orchestrate profiles `capcomd setup` writes are for (their `description`; plugin API §16.1). */
export const LEAD_DESCRIPTION = "Leads a part: splits it among its worker helpers, then verifies and merges their work. Orchestrates: sees everything (code, git history, every agent's logs and check output) and runs nothing (no edits, commits, installs, builds or tests), so give it no task that needs it to run code itself (its helpers write and test the code); its helpers' checks run at verify and merge (and on the combined code with capcomd check), and it reads their results.";
export const PLANNER_DESCRIPTION = "Plans a goal: splits it among workers and leads, then verifies and merges their work. Orchestrates: sees everything (code, git history, every agent's logs and check output) and runs nothing (no edits, commits, installs, builds or tests); checks run at verify and merge (and on the combined code with capcomd check), and it reads their results.";

/** What the consolidator `capcomd setup` writes is for (ADR-025 §5.2). */
export const CONSOLIDATOR_DESCRIPTION = "Consolidates a run's lessons into the project's memory (.capcomd/context/): the planner spawns it last. It reads the run's candidate lessons, the memory and the run's verifies and merges, and answers with the changes to make; capcomd writes them on its branch, which a person reviews before it lands. It edits nothing itself.";
/** What a consolidator may use: reading the checkout and its history, nothing that writes. */
export const CONSOLIDATOR_TOOLS = ["Read", "Glob", "Grep", "LS", "Bash(git log:*)", "Bash(git show:*)", "Bash(git diff:*)", "Bash(cat:*)", "Bash(ls:*)"];
/** The project's memory (ADR-025 §6.1): every profile setup writes is briefed with it. A planner and a lead list it, a
 *  worker gets the same index, and a reviewer (which inherits it from the worker) only its facts: the kernel gives
 *  review and report agents no memory lines (D11). */
export const PROJECT_MEMORY = { providers: [{ name: "memory" }] };

/** The `#` lines at the top of each profile file setup writes: what the profile is for, and that it is yours. */
const NOTES: Record<string, string> = {
  worker: "A worker: does one part of the work in its own sandbox. reviewer, lead and planner extend it, so a model or\nlimit set here is theirs too unless they set their own.",
  reviewer: "Reviews each change before it merges (run.reviewer in .capcomd/config.json): read-only tools, plus the commands\nof the project's check.",
  lead: "Leads a part: up to 3 worker helpers at once, one level down. It orchestrates: it sees everything and runs nothing.",
  planner: "Plans a run: spawns workers and leads, and the consolidator last. It orchestrates: it sees everything and runs nothing.",
  [CONSOLIDATOR_PROFILE]: "Turns a run's lessons into changes to .capcomd/context/, which a person reviews before they land (review: human).\nNo model of its own: it runs on the run's strongest.",
};
const HEADER = "Written by `capcomd setup project`; yours to change (`capcomd profiles set`, or by hand).\n`capcomd profiles show <name>` says where each value comes from.";

/** The two files' contents for these answers. No turn, time or money limits on the profiles (ADR-019). */
export function planProject(a: ProjectAnswers): ProjectPlan {
  const gh = githubRepoOf(a.repo);
  const provider = a.agents.includes("claude") ? "claude" : "codex";
  const auth = a.authOf(provider);
  const workers = a.agents.map((x) => (x === provider ? "worker" : `${x}-worker`));
  const v2 = (name: string, doc: ProfileDoc): [string, ProfileDoc] => [name, { schema: PROFILE_SCHEMA, name, version: 1, ...doc }];
  const profiles: Array<[string, ProfileDoc]> = [
    // A worker per agent, briefed with the project's memory; the first one is what the others extend.
    ...a.agents.map((x, i) => v2(workers[i]!, { harness: { provider: x, auth: a.authOf(x) }, context: PROJECT_MEMORY })),
    // Reads and runs the check, never edits; it may answer as a report (permissions.report).
    v2("reviewer", { extends: "worker", tags: ["review"], tools: { allowed: ["Read", "Glob", "Grep", "LS", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git show:*)", "Bash(cat:*)", "Bash(ls:*)", ...testTools(a.check, a.dir)] }, permissions: { report: true } }),
    // A module lead: up to 3 worker helpers at once, one level down. The driver spawns it for a part with two or more
    // independent sub-parts; it verifies and merges its helpers' work itself (capcomd verify runs the checks). It
    // orchestrates (plugin API §16.1): it sees everything and runs nothing; its helpers do and check the work.
    v2("lead", { extends: "worker", description: LEAD_DESCRIPTION, tools: { mode: "orchestrate" }, children: { allowSpawn: true, maxChildren: 3, maxDepth: 1, allowedChildProfiles: workers } }),
    // ADR-025 §5.2: the planner's last child, when the run's agents proposed lessons. Its own harness, not the worker's:
    // no model (it runs on the run's strongest, D6) whatever the worker's is. Read-only (codex: a read-only sandbox),
    // briefed with the project's memory, and its branch waits for a person (review: human, D5).
    v2(CONSOLIDATOR_PROFILE, { description: CONSOLIDATOR_DESCRIPTION, harness: { provider, auth }, tools: { allowed: CONSOLIDATOR_TOOLS }, context: { ...PROJECT_MEMORY, review: "human" }, sandbox: { codex: "read-only" } }),
    // No fan-out limits either: the planner may spawn workers, and leads for parts that split further, as it sees fit
    // (set children.* to bound it). It orchestrates too: every change is a worker's. It extends the worker, not the
    // lead, so the lead's caps (3 helpers, one level) aren't its own.
    v2("planner", { extends: "worker", description: PLANNER_DESCRIPTION, tags: ["plan"], tools: { mode: "orchestrate" }, children: { allowSpawn: true, allowedChildProfiles: [...workers, "lead", CONSOLIDATOR_PROFILE] } }),
  ];
  const capcomd = join(a.dir, ".capcomd");
  return {
    dir: a.dir, configPath: join(capcomd, "config.json"), agentsPath: join(capcomd, "agents.json"), profilesDir: join(capcomd, "profiles"), cap: a.cap, profiles,
    patch: {
      env: { CAPCOMD_REPO: a.repo, CAPCOMD_MERGE_MODE: a.mode, ...(a.target ? { CAPCOMD_MERGE_TARGET: a.target } : {}), ...(gh ? { CAPCOMD_GITHUB_REPO: gh } : {}) },
      run: { ...(a.check ? { checks: { unit: a.check } } : {}), reviewer: "reviewer" },
    },
  };
}

/** A plan that can't be written as asked (a .capcomd that leads out of the checkout, profiles that can't be read). */
export class ProjectWriteError extends Error {}

/** `consolidator`: what stops the project's planner from spawning the consolidator, when something does (consolidatorAdvice). */
export interface ProjectWrite { config: CapcomdConfig; configChanged: boolean; made: string[]; kept: string[]; consolidator: ConsolidatorAdvice | null }

/** Why a project's planner can't spawn the consolidator, and the command that lets it. */
export interface ConsolidatorAdvice { missing: "profile" | "planner"; detail: string; command: string }

/**
 * Every project gets the context consolidator, so its planner can spawn it (ADR-025 D17, the owner's decision of
 * 2026-11-08): `capcomd setup project` writes it. A project set up before it existed, or whose profiles were moved
 * from agents.json (`capcomd profiles migrate`), may lack it, or keep a planner that doesn't list it: the planner it
 * writes lists it, but one the project has is yours and setup never changes it. This says which, and the command that
 * fixes it: `profile` (no context-consolidator: setup adds it) or `planner` (the project's `planner` may spawn, but not
 * it). Null when the planner can spawn it, or the project has no `planner` that may spawn (a driver leads its runs).
 */
export function consolidatorAdvice(set: ProfileSet): ConsolidatorAdvice | null {
  const planner = set.profiles.planner;
  const children = planner?.spec.children;
  const allowed = children?.allowedChildProfiles ?? [];
  if (!children?.allowSpawn || !allowed.length || allowed.includes(CONSOLIDATOR_PROFILE)) return null;
  if (!Object.hasOwn(set.profiles, CONSOLIDATOR_PROFILE)) {
    return { missing: "profile", command: "capcomd setup project", detail: `the project has no ${CONSOLIDATOR_PROFILE} profile, so its planner can't turn a run's lessons into memory` };
  }
  return {
    missing: "planner", command: `capcomd profiles set planner --set children.allowedChildProfiles=${[...allowed, CONSOLIDATOR_PROFILE].join(",")}`,
    detail: `the project's planner may spawn ${allowed.join(", ")} but not ${CONSOLIDATOR_PROFILE}, so a run's lessons don't reach the project's memory (its changes still wait for a person)`,
  };
}

/** Whether the project's own layer names a default: its agents.json's `default`, or a profile file's `default: true`. */
function projectDefault(set: ProfileSet, agentsPath: string): boolean {
  try { if (JSON.parse(readFileSync(agentsPath, "utf8")).default !== undefined) return true; } catch { /* none, or unreadable: the loader said */ }
  return Object.values(set.profiles).some((p) => p.manifest.default === true && p.applied[p.setBy.default ?? -1]?.layer === "project");
}

/**
 * Write a plan: the project config merged into what's there (as `capcomd setup` always has), and each profile added as
 * `.capcomd/profiles/<name>.yaml` unless the project has a profile of that name (an agents.json entry or a profile
 * file: your edits survive), or the profiles wouldn't resolve with it (a kept `worker` a template can't extend, say).
 * Each file is checked with every profile before it is written (the loader's overlay), and written atomically.
 * `strict` (the API): refuse a .capcomd, config.json, agents.json or profiles/ whose real path leaves the checkout, and
 * profiles that don't read, before writing anything. Without it (the CLI), profiles that don't read keep every profile.
 */
export function writeProject(plan: ProjectPlan, o: { strict?: boolean; env?: Env } = {}): ProjectWrite {
  const env = o.env ?? process.env;
  if (o.strict) checkContained(plan);
  // Profiles first (in memory), so a strict write refuses before touching the config.
  let set: ProfileSet | null;
  try { set = readProfiles(plan.agentsPath, env); } catch (e) {
    if (!(e instanceof AgentConfigError)) throw e;
    if (o.strict) throw new ProjectWriteError(`The project's profiles can't be read (${e.message}). Fix them or move them away, then set the project up again.`);
    set = null;
  }
  const made: string[] = [], kept: string[] = [], overlay = new Map<string, string>();
  // The first worker is the default when the project has none (never a reviewer or a planner: a run that names no
  // profile gets a worker).
  let hasDefault = set ? projectDefault(set, plan.agentsPath) : true;
  for (const [name, doc] of plan.profiles) {
    const file = join(plan.profilesDir, `${name}.yaml`);
    const there = set && Object.hasOwn(set.profiles, name) && set.profiles[name]!.source === "project";
    if (!set || there || ["yaml", "yml", "json"].some((x) => exists(join(plan.profilesDir, `${name}.${x}`))) || exists(join(plan.profilesDir, name))) { kept.push(name); continue; }
    const isDefault = !hasDefault && name === plan.profiles[0]![0];
    overlay.set(file, profileFileText(isDefault ? { ...doc, default: true } : doc, `${NOTES[name] ?? NOTES.worker}\n\n${HEADER}`));
    try { readProfiles(plan.agentsPath, env, BUNDLED_PROFILES, overlay); } catch (e) {
      if (!(e instanceof AgentConfigError)) throw e;
      overlay.delete(file); kept.push(name); continue;
    }
    made.push(name);
    hasDefault ||= isDefault;
  }
  const cur = readConfig(plan.configPath);
  const patch: CapcomdConfig = { ...plan.patch, ...(plan.cap ? { driver: { ...cur.driver, maxRunBudget: plan.cap } } : {}) };
  const config = mergeConfig(cur, patch);
  const before = existsSync(plan.configPath) ? readFileSync(plan.configPath, "utf8") : null;
  const text = configText(config);
  mkdirSync(dirname(plan.configPath), { recursive: true });
  atomicWrite(plan.configPath, text, 0o600);
  for (const [file, body] of overlay) writeAtomic(file, body);
  // A kept planner is the project's: said, never changed (ADR-025 D17).
  let consolidator: ConsolidatorAdvice | null = null;
  if (set) { try { consolidator = consolidatorAdvice(readProfiles(plan.agentsPath, env)); } catch (e) { if (!(e instanceof AgentConfigError)) throw e; } }
  return { config, configChanged: before !== text, made, kept, consolidator };
}

function atomicWrite(path: string, text: string, mode: number) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now().toString(36)}`;
  writeFileSync(tmp, text, { mode });
  renameSync(tmp, path);
}

const inside = (child: string, parent: string) => { const r = relative(parent, child); return r === "" || (!!r && !r.startsWith("..") && !isAbsolute(r)); };
/** .capcomd and what setup writes in it must stay inside the checkout (no symlink out of it), and .capcomd and
 *  .capcomd/profiles must be folders. */
function checkContained(plan: ProjectPlan) {
  let root: string;
  try { root = realpathSync(plan.dir); } catch { throw new ProjectWriteError(`${plan.dir} doesn't exist any more.`); }
  const out = (p: string) => new ProjectWriteError(`${p} leads outside the checkout (a symlink), so capcomd won't write there. Remove the link, or set the project up with \`capcomd setup project\` in Terminal.`);
  for (const d of [join(plan.dir, ".capcomd"), plan.profilesDir]) {
    if (!exists(d)) continue;
    let real: string;
    try { real = realpathSync(d); } catch { throw out(d); }
    if (!inside(real, root)) throw out(d);
    if (!lstatSync(real).isDirectory()) throw new ProjectWriteError(`${d} isn't a folder, so capcomd can't keep the project's settings in it.`);
  }
  for (const f of [plan.configPath, plan.agentsPath, ...plan.profiles.map(([n]) => join(plan.profilesDir, `${n}.yaml`))]) {
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
export function projectValues(dir: string, env: Env = process.env): ProjectValues | null {
  const cfg = readConfig(join(dir, ".capcomd", "config.json"));
  const repo = cfg.env?.CAPCOMD_REPO;
  if (typeof repo !== "string" || !repo) return null;
  let agents: string[] = [];
  try {
    // The workers setup made: "worker" (the first agent) and "<agent>-worker", in the project's own profiles.
    const set = readProfiles(join(dir, ".capcomd", "agents.json"), env);
    const ws = Object.values(set.profiles).filter((p) => p.source === "project" && (p.name === "worker" || p.name.endsWith("-worker"))).map((p) => p.spec.provider);
    agents = (["claude", "codex"] as const).filter((p) => ws.includes(p));
  } catch { /* unreadable: none */ }
  const m = /^usd=([0-9.]+)/.exec(cfg.driver?.maxRunBudget ?? "");
  return {
    repo, mode: cfg.env?.CAPCOMD_MERGE_MODE ?? null, target: cfg.run?.target ?? cfg.env?.CAPCOMD_MERGE_TARGET ?? null,
    check: cfg.run?.checks?.unit ?? "", agents, budgetUsd: m ? Number(m[1]) : null,
  };
}
