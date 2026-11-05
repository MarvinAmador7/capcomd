// A run's goal branch: one branch per run, cut from the base the user picked, that every reviewed child lands on with
// no human step; when the planner finishes, the user opens a pull request from it into the base (or keeps it). This
// file holds what decides the names: the suggested branch for a goal, the checks a name must pass, and the origin's
// branches and default branch (as the project's forge reads them: its service first, else `git ls-remote`). Never a
// made-up "main": a base nobody named and the remote doesn't report is unknown, and callers ask the user.
import type { MergeConfig } from "./config";
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
  /** The forge's name (github: the GitHub API with the user's own login) when its service answered; git: `git
   *  ls-remote`; local: the checkout's own refs (no network). */
  source: string;
  /** Why the better sources weren't used or failed (daemon-written), or null. */
  note: string | null;
}

/** Tests: stand-ins for what the forge would ask the network (`github`: the user's login and the service's API; a
 *  fetch), and how long one read may take. */
export interface ListDeps {
  github?: (() => Promise<{ api: string; token: string } | null>) | null;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/**
 * The origin's branches and its default branch, as the project's forge reads them (docs/spec/plugin-api.md §7.4
 * `listBranches`): the forge `merge.forge` names (a repository named outright in `github`, as CAPCOMD_GITHUB_REPO does,
 * names `github`), else the first whose `matches(remote)`. The forge asks its service when it can, else the remote
 * itself; when the remote can't be read at all, `local` (what the caller passes from the checkout's own refs). `note`
 * says why a better source wasn't used.
 */
export async function listBranches(o: {
  remote: string | null; github?: string | null; forge?: string | null; merge?: MergeConfig | null; cwd: string;
  local?: () => { defaultBranch: string | null; branches: string[] }; max?: number;
}, deps: ListDeps = {}): Promise<BranchListing> {
  const max = o.max ?? 500, timeoutMs = deps.timeoutMs ?? 15_000;
  const sorted = (b: string[]) => [...new Set(b)].sort().slice(0, max);
  const local = (note: string | null): BranchListing => {
    const r = o.local?.() ?? { defaultBranch: null, branches: [] };
    return { defaultBranch: r.defaultBranch, branches: sorted(r.branches), source: "local", note };
  };
  if (!o.remote) return local(null);
  const F = await import("../plugins/forges");
  let forge;
  try { forge = await F.forgeFor({ remote: o.remote, forge: o.forge ?? o.merge?.forge ?? (o.github ? "github" : null) }); }
  catch (e) { return local((e as Error).message); }
  if (!forge) return local(`no active forge reads ${o.remote}`);
  const scope = { merge: o.merge ?? null, repo: o.github ?? null, stubs: { login: deps.github ?? null, ...(deps.fetch ? { fetch: deps.fetch } : {}) } };
  try {
    // The service, then the remote: each read bounded inside the forge, the two by this call.
    const remote = o.remote;
    const r = await F.withForge(scope, 2 * timeoutMs + 5_000, (c) => forge.listBranches({ remote, cwd: o.cwd, max }, c));
    return { defaultBranch: r.defaultBranch, branches: sorted(r.branches), source: r.source === "service" ? forge.describe().name : "git", note: r.note };
  } catch (e) { return local((e as Error).message); }
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
  /** The project's merge settings: its forge (`merge.forge`) reads the remote, with them (§7.4). */
  merge?: MergeConfig | null;
  cwd: string; env?: Env; reuse?: string | null;
}, deps: ListDeps = {}): Promise<{ base: string; goalBranch: string; baseSource: BaseSource; listing: BranchListing | null }> {
  const { RelayError } = await import("../core/errors");
  // A forge the project names that isn't active is refused now (§7.1), not read around.
  const off = await (await import("../plugins/forges")).inactiveForge(o.merge?.forge);
  if (off) throw new RelayError("config", off.message, off.hint, { code: "forge" });
  let listing: BranchListing | null = null;
  const list = async () => (listing ??= await listBranches({ remote: o.remote, github: o.github ?? null, merge: o.merge ?? null, cwd: o.cwd }, deps));
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
