// A run's goal branch: one branch per run, cut from the base the user picked, that every reviewed child lands on with
// no human step; when the planner finishes, the user opens a pull request from it into the base (or keeps it). This
// file holds what decides the names: the suggested branch for a goal, the checks a name must pass, and the origin's
// branches and default branch (GitHub first, with the user's own gh login; else `git ls-remote`). Never a made-up
// "main": a base nobody named and the remote doesn't report is unknown, and callers ask the user.
import { Git } from "./git";
import { isProtectedBranch } from "../utils/protected";

type Env = Record<string, string | undefined>;

/** The prefix of every suggested goal branch. */
export const GOAL_PREFIX = "capcomd/";
/** A suggested goal branch's slug is at most this long (the prefix and a collision suffix come on top). */
export const GOAL_SLUG_MAX = 40;

/** A branch name git takes (`git check-ref-format --branch`, narrowed to letters, digits, `.`, `_`, `-` and `/`). */
const REF_SAFE = /^(?!-)(?!\.)(?!.*\.\.)(?!.*\/\/)(?!.*\/[.-])(?!.*\.lock(?:\/|$))[A-Za-z0-9._/-]{1,200}(?<![./])$/;
export const isRefSafe = (name: string) => REF_SAFE.test(name) && name !== "HEAD";

/** The goal's first line as a branch slug: lowercase ASCII letters and digits joined by single hyphens, at most
 *  GOAL_SLUG_MAX characters, cut at a hyphen when it can be; "goal" when nothing is left. */
export function goalSlug(goal: string): string {
  const line = goal.split(/\r?\n/).find((l) => l.trim()) ?? "";
  const ascii = line.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
  let s = ascii.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (s.length > GOAL_SLUG_MAX) {
    const cut = s.slice(0, GOAL_SLUG_MAX);
    const at = cut.lastIndexOf("-");
    s = (at >= GOAL_SLUG_MAX / 2 ? cut.slice(0, at) : cut).replace(/-+$/, "");
  }
  return s || "goal";
}

/** `name` can't be created next to `existing`: the same branch, or one git can't hold beside it (a/b next to a). */
export function collides(name: string, existing: Iterable<string>): boolean {
  const n = name.toLowerCase();
  for (const e of existing) {
    const x = e.toLowerCase();
    if (x === n || x.startsWith(`${n}/`) || n.startsWith(`${x}/`)) return true;
  }
  return false;
}

/** The suggested goal branch: `capcomd/<slug>`, with -2, -3… when the remote has that name already. */
export function suggestGoalBranch(goal: string, existing: Iterable<string> = []): string {
  const list = [...existing];
  // A branch named "capcomd" itself would make every capcomd/… impossible: fall back to a flat name.
  const prefix = collides("capcomd/x", list.filter((b) => !b.toLowerCase().startsWith("capcomd/"))) ? "capcomd-" : GOAL_PREFIX;
  const base = `${prefix}${goalSlug(goal)}`;
  if (!collides(base, list)) return base;
  for (let i = 2; i < 1000; i++) if (!collides(`${base}-${i}`, list)) return `${base}-${i}`;
  return `${base}-${Date.now().toString(36)}`;
}

/** Why `name` can't be a run's goal branch (a sentence for the person), or null. Not checked here: whether it exists. */
export function goalBranchProblem(name: string, o: { base?: string | null; env?: Env } = {}): string | null {
  if (!isRefSafe(name)) return `"${name.slice(0, 80)}" isn't a branch name capcomd can create (letters, digits, ".", "_", "-" and "/"; no "..", no leading "-" or ".", no trailing "/" or ".").`;
  if (o.base && name === o.base) return `The goal branch can't be the base (${o.base}) itself: work lands on the goal branch, and the pull request goes from it into the base.`;
  if (isProtectedBranch(name, o.env ?? process.env)) return `${name} is a protected branch: reviewed work lands on the goal branch without asking anyone, so it can't be one. Pick another name.`;
  return null;
}

/** Why `base` can't be a run's base (a sentence), or null. */
export function baseProblem(base: string): string | null {
  return isRefSafe(base) ? null : `"${base.slice(0, 80)}" isn't a branch name.`;
}

/** The origin's branches and default branch, and where they were read. */
export interface BranchListing {
  /** The default branch the remote reports; null when it doesn't say (never guessed). */
  defaultBranch: string | null;
  /** Sorted, at most `max`. */
  branches: string[];
  /** github: the GitHub API with the user's gh login; git: `git ls-remote`; local: the checkout's own refs (no network). */
  source: "github" | "git" | "local";
  /** Why the better sources weren't used or failed (daemon-written), or null. */
  note: string | null;
}

export interface ListDeps {
  /** The GitHub API (REST) for `repo`, or null without a token. */
  github?: (() => Promise<{ api: string; token: string } | null>) | null;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const ghHeaders = (token: string) => ({ accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28", "user-agent": "capcomd" });

/** GitHub: the repository's default branch and its branches (up to `max`, 100 per page). Throws on any failure. */
async function fromGitHub(repo: string, gh: { api: string; token: string }, max: number, f: typeof fetch, timeoutMs: number) {
  const api = gh.api.replace(/\/$/, "");
  const get = async (path: string) => {
    const r = await f(`${api}${path}`, { headers: ghHeaders(gh.token), signal: AbortSignal.timeout(timeoutMs) });
    if (r.status !== 200) throw new Error(`GitHub answered ${r.status} for ${path.split("?")[0]}`);
    return r.json() as Promise<any>;
  };
  const info = await get(`/repos/${repo}`);
  const branches: string[] = [];
  for (let page = 1; branches.length < max && page <= 10; page++) {
    const rows = (await get(`/repos/${repo}/branches?per_page=100&page=${page}`)) as Array<{ name?: string }>;
    for (const b of rows) if (typeof b?.name === "string") branches.push(b.name);
    if (rows.length < 100) break;
  }
  return { defaultBranch: typeof info?.default_branch === "string" && info.default_branch ? info.default_branch : null, branches };
}

/** `git ls-remote`: the remote's HEAD (its default branch) and heads. Throws when the remote can't be read. */
async function fromGit(remote: string, cwd: string, timeoutMs: number) {
  const git = new Git(cwd);
  const heads = await git.run(["ls-remote", "--symref", remote, "HEAD", "refs/heads/*"], { timeoutMs });
  if (heads.code !== 0) throw new Error(heads.timedOut ? "git ls-remote timed out" : `git ls-remote failed: ${heads.stderr.trim().split("\n")[0]?.slice(0, 200) ?? ""}`);
  let defaultBranch: string | null = null;
  const branches: string[] = [];
  for (const line of heads.stdout.split("\n")) {
    const sym = /^ref: refs\/heads\/(\S+)\tHEAD$/.exec(line);
    if (sym) { defaultBranch = sym[1]!; continue; }
    const h = /^[0-9a-f]{40,64}\trefs\/heads\/(\S+)$/.exec(line);
    if (h) branches.push(h[1]!);
  }
  return { defaultBranch, branches };
}

/**
 * The origin's branches and its default branch: GitHub first (when `github` names owner/name and a token is at hand:
 * GITHUB_TOKEN, GH_TOKEN or `gh auth token`), else `git ls-remote`, else `local` (what the caller passes from the
 * checkout's own refs). A source that fails falls through to the next; `note` says why.
 */
export async function listBranches(o: { remote: string | null; github?: string | null; cwd: string; local?: () => { defaultBranch: string | null; branches: string[] }; max?: number }, deps: ListDeps = {}): Promise<BranchListing> {
  const max = o.max ?? 500, f = deps.fetch ?? fetch, timeoutMs = deps.timeoutMs ?? 15_000;
  const done = (r: { defaultBranch: string | null; branches: string[] }, source: BranchListing["source"], note: string | null): BranchListing =>
    ({ defaultBranch: r.defaultBranch, branches: [...new Set(r.branches)].sort().slice(0, max), source, note });
  const notes: string[] = [];
  if (o.github) {
    const gh = await (deps.github ?? defaultGitHub)()?.catch(() => null);
    if (gh) {
      try { return done(await fromGitHub(o.github, gh, max, f, timeoutMs), "github", null); }
      catch (e) { notes.push(`GitHub: ${(e as Error).message}`); }
    } else notes.push("GitHub: no login (GITHUB_TOKEN, GH_TOKEN or `gh auth login`)");
  }
  if (o.remote) {
    try { return done(await fromGit(o.remote, o.cwd, timeoutMs), "git", notes.join("; ") || null); }
    catch (e) { notes.push((e as Error).message); }
  }
  return done(o.local?.() ?? { defaultBranch: null, branches: [] }, "local", notes.join("; ") || null);
}

/** The user's own GitHub login (GITHUB_TOKEN, GH_TOKEN, else `gh auth token`) and CAPCOMD_GITHUB_API; null without one. */
export async function defaultGitHub(env: Env = process.env): Promise<{ api: string; token: string } | null> {
  const api = env.CAPCOMD_GITHUB_API ?? env.RELAY_GITHUB_API ?? "https://api.github.com";
  const t = env.GITHUB_TOKEN ?? env.GH_TOKEN;
  if (t) return { api, token: t };
  try {
    const proc = Bun.spawn([env.CAPCOMD_GH_CLI ?? "gh", "auth", "token"], { stdout: "pipe", stderr: "ignore", env: env as Record<string, string> });
    const timer = setTimeout(() => proc.kill("SIGKILL"), 5_000);
    const out = (await new Response(proc.stdout).text()).trim();
    clearTimeout(timer);
    return (await proc.exited) === 0 && out ? { api, token: out } : null;
  } catch { return null; }
}

/** How a run's base was decided. */
export type BaseSource = "given" | "project" | "remote";

/**
 * A new run's base and goal branch. Base: the one given, else the project's configured target, else the origin's
 * default branch (as the remote reports it). None of those: a RelayError with reason "base" (the client asks the user;
 * never a silent "main"). Goal branch: the one given (checked), else the suggestion for the goal. A given name the
 * remote has already is refused (reason "goalBranch") unless `reuse` says this run made it.
 */
export async function resolveGoalBranch(o: {
  goal: string; base?: string | null; goalBranch?: string | null; projectTarget?: string | null; remote: string | null; github?: string | null;
  cwd: string; env?: Env; reuse?: string | null;
}, deps: ListDeps = {}): Promise<{ base: string; goalBranch: string; baseSource: BaseSource; listing: BranchListing | null }> {
  const { RelayError } = await import("../core/errors");
  let listing: BranchListing | null = null;
  const list = async () => (listing ??= await listBranches({ remote: o.remote, github: o.github ?? null, cwd: o.cwd }, deps));
  let base = o.base ?? null, baseSource: BaseSource = "given";
  if (!base && o.projectTarget) { base = o.projectTarget; baseSource = "project"; }
  if (!base) { base = (await list()).defaultBranch; baseSource = "remote"; }
  if (!base) throw new RelayError("usage", "can't tell which branch this run starts from: no base was given, the project names no target branch, and the remote doesn't report a default branch", "Pick the base branch (e.g. --base dev).", { code: "base" });
  const bp = baseProblem(base);
  if (bp) throw new RelayError("usage", `base: ${bp}`, "Name an existing branch of the repository.", { code: "base" });
  const known = o.remote ? (await list()).branches : [];
  // The remote couldn't be listed (offline): the push that cuts the goal branch checks the base then.
  if ((listing as BranchListing | null)?.source !== "local" && known.length && !known.includes(base))
    throw new RelayError("not_found", `base ${base} isn't a branch of ${o.github ?? o.remote}`, "Pick one of the repository's branches.", { code: "base" });
  if (o.goalBranch) {
    const gp = goalBranchProblem(o.goalBranch, { base, env: o.env });
    if (gp) throw new RelayError("usage", `goal branch: ${gp}`, "Pick another goal branch name.", { code: "goalBranch" });
    if (o.goalBranch !== o.reuse && known.includes(o.goalBranch))
      throw new RelayError("conflict", `goal branch ${o.goalBranch} already exists on the remote`, "Pick a new name: each run's work lands on a branch of its own.", { code: "goalBranch" });
    return { base, goalBranch: o.goalBranch, baseSource, listing };
  }
  const name = suggestGoalBranch(o.goal, known);
  // A suggestion that lands on a protected pattern (CAPCOMD_PROTECTED_BRANCHES="capcomd/*"): say so rather than guess.
  const gp = goalBranchProblem(name, { base, env: o.env });
  if (gp) throw new RelayError("usage", `goal branch: ${gp}`, "Name the goal branch yourself (--goal-branch).", { code: "goalBranch" });
  return { base, goalBranch: name, baseSource, listing };
}
