// A run's goal branch: one branch per run, cut from the base the user picked, that every reviewed child lands on with
// no human step; when the planner finishes, the user opens a pull request from it into the base (or keeps it). This
// file holds what decides the names: the suggested branch for a goal (named the way the repository's own branches are,
// learned from the remote's branch list, else the common `<type>/<slug>`; instant, no model call), the checks a name
// must pass, and the origin's branches and default branch (as the project's forge reads them: its service first, else
// `git ls-remote`). Never a made-up "main": a base nobody named and the remote doesn't report is unknown, and callers
// ask the user.
import type { MergeConfig } from "./config";
import { isProtectedBranch } from "../utils/protected";

type Env = Record<string, string | undefined>;

/** A suggested goal branch's slug is at most this long (the prefix, a ticket id and a collision suffix come on top). */
export const GOAL_SLUG_MAX = 40;
/** …and at most this many words. */
export const GOAL_SLUG_WORDS = 4;

/** A branch name git takes (`git check-ref-format --branch`, narrowed to letters, digits, `.`, `_`, `-` and `/`). */
const REF_SAFE = /^(?!-)(?!\.)(?!.*\.\.)(?!.*\/\/)(?!.*\/[.-])(?!.*\.lock(?:\/|$))[A-Za-z0-9._/-]{1,200}(?<![./])$/;
export const isRefSafe = (name: string) => REF_SAFE.test(name) && name !== "HEAD";

/** The goal's first non-blank line. */
const firstLine = (goal: string) => goal.split(/\r?\n/).find((l) => l.trim()) ?? "";
/** Lowercase ASCII letters and digits with everything else as single hyphens (accents dropped, apostrophes too). */
const normalise = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/['’]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
/** `s` cut to at most `max` characters, at a hyphen when it can be. */
function cutAt(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const at = cut.lastIndexOf("-");
  return (at >= max / 2 ? cut.slice(0, at) : cut).replace(/-+$/, "");
}

/** The goal's whole first line as a branch slug: lowercase ASCII letters and digits joined by single hyphens, at most
 *  GOAL_SLUG_MAX characters, cut at a hyphen when it can be; "goal" when nothing is left. */
export function goalSlug(goal: string): string {
  return cutAt(normalise(firstLine(goal)), GOAL_SLUG_MAX) || "goal";
}

/** The kinds of change a goal branch is named for (Conventional Commits' types). */
export type GoalType = "feat" | "fix" | "docs" | "refactor" | "test" | "ci" | "chore" | "perf";

// What makes a goal one kind of change: whole words (normalised, hyphen-joined) of its first line. The earliest
// match decides ("Fix the flaky tests" is a fix, "Add tests for the crash" a test); at one place, this order does.
const TYPE_WORDS: Array<[GoalType, RegExp]> = [
  ["fix", /^(?:fix|fixes|fixed|fixing|bug|bugs|bugfix|hotfix|broken|crash|crashes|crashing|regression|regressions|error|errors)$/],
  ["docs", /^(?:docs|doc|readme|documentation|document|documented|changelog)$/],
  ["refactor", /^(?:refactor|refactors|refactoring|rename|renames|restructure|reorganize|reorganise|simplify|tidy|cleanup)$/],
  ["test", /^(?:test|tests|testing|spec|specs|e2e|coverage)$/],
  ["ci", /^(?:ci|pipeline|pipelines|workflow|workflows)$/],
  ["chore", /^(?:chore|chores|bump|bumps|upgrade|upgrades|deps|dependency|dependencies)$/],
  ["perf", /^(?:perf|performance|faster|speed|speedup|optimize|optimise|optimization|optimisation|latency|slow|slower)$/],
];
// Two-word signals (checked before single words at the same place).
const TYPE_PAIRS: Array<[GoalType, string]> = [["refactor", "clean-up"], ["perf", "speed-up"], ["ci", "github-actions"]];
// A word that names something to build, not a change of that kind: "error handling" is a feature, not a fix.
const NOT_A_TYPE = new Set(["data-pipeline", "etl-pipeline", "error-handling", "error-message", "error-messages", "error-page",
  "error-state", "error-boundary", "errors-page", "test-connection", "speed-dial", "document-editor", "document-viewer",
  "workflow-editor", "workflow-builder", "approval-workflow"]);

/** The kind of change a goal reads as, and where its word is (index into the first line's words), or feat (-1). */
function typeOf(words: string[]): { type: GoalType; at: number; len: number } {
  for (let i = 0; i < words.length; i++) {
    const pair = `${words[i]}-${words[i + 1] ?? ""}`, prev = `${words[i - 1] ?? ""}-${words[i]}`;
    for (const [t, p] of TYPE_PAIRS) if (pair === p) return { type: t, at: i, len: 2 };
    if (NOT_A_TYPE.has(pair) || NOT_A_TYPE.has(prev)) continue;
    for (const [t, re] of TYPE_WORDS) if (re.test(words[i]!)) return { type: t, at: i, len: 1 };
  }
  return { type: "feat", at: -1, len: 0 };
}

/** The kind of change the goal's first line reads as: fix, docs, refactor, test, ci, chore, perf, else feat. */
export const goalType = (goal: string): GoalType => typeOf(normalise(firstLine(goal)).split("-").filter(Boolean)).type;

// Words a branch name does without: articles, pronouns, prepositions, filler, and the verbs any change starts with.
const STOP = new Set(("a an the to for of in on at by with from into onto via and or but so that this these those it its is are be been " +
  "was were when where which while who whom we our us i my me you your they them their he she can could should would will shall must may " +
  "might just also then than as after before if please some any each every there here what how why do does done make makes making " +
  "add adds adding added implement implements implementing create creates creating build builds building introduce introduces " +
  "update updates updating write writes writing new now get gets let lets allow allows enable enables use using").split(" "));
// A ticket id in the goal (ABC-123, as Jira and Linear write them): kept, never invented.
const TICKET = /\b([A-Z][A-Z0-9]{1,9})-(\d{1,7})\b/;

/** The goal's slug: its first line's meaningful words, at most GOAL_SLUG_WORDS of them and GOAL_SLUG_MAX characters.
 *  Left out: stopwords, a ticket id, the type's own name (fix, docs, tests…: the prefix says it), and the leading verb
 *  that made the type when two words or more are left ("Optimize the search query": search-query; "Don't crash…"
 *  keeps crash). The whole line's slug when no word is left ("Fix it": fix-it); "" when there's nothing but a ticket. */
export function goalBranchSlug(goal: string): string {
  const line = firstLine(goal).replace(TICKET, " ");
  const words = normalise(line).split("-").filter(Boolean);
  const t = typeOf(words);
  const own = new Set(SPELLINGS[t.type]);
  const meaningful = (skipVerb: boolean) => words.filter((w, i) => !STOP.has(w) && !own.has(w) && !(skipVerb && i >= t.at && i < t.at + t.len));
  const kept = t.at === 0 && meaningful(true).length >= 2 ? meaningful(true) : meaningful(false);
  return cutAt(kept.slice(0, GOAL_SLUG_WORDS).join("-"), GOAL_SLUG_MAX) || cutAt(words.join("-"), GOAL_SLUG_MAX);
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

// Branches that say nothing about how the project's people name theirs: capcomd's own, bots', agents', release lines
// and long-lived ones.
const NOT_A_PERSONS = new RegExp(`^(?:${["capcomd", "dependabot", "renovate", "gh-readonly-queue", "release", "releases", "changeset-release",
  "copilot", "codex", "claude", "cursor", "devin", "snyk", "imgbot", "all-contributors", "allcontributors", "github-actions", "pre-commit-ci",
  "gh-pages", "revert-\\d+"].join("|")})(?:[/-]|$)`, "i");
const LONG_LIVED = new Set(["main", "master", "trunk", "dev", "develop", "development", "staging", "stage", "production", "prod", "next",
  "canary", "beta", "alpha", "stable", "head"]);
// The spellings of each kind of change a repository may use as its branches' first part, conventional first.
const SPELLINGS: Record<GoalType, string[]> = {
  feat: ["feat", "feature", "features"], fix: ["fix", "bugfix", "bug", "fixes", "hotfix"], docs: ["docs", "doc", "documentation"],
  refactor: ["refactor", "refactoring"], test: ["test", "tests"], ci: ["ci"], chore: ["chore", "chores", "deps"], perf: ["perf", "performance"],
};
const TYPE_PREFIXES = new Set([...Object.values(SPELLINGS).flat(), "build", "style", "revert", "wip", "experiment", "spike"]);
// Branches it takes, and the share of them, before a habit counts as the project's convention.
const MIN_BRANCHES = 3, MOSTLY = 0.6;

/** How a repository names its branches, as far as its branches tell. */
export interface BranchConvention {
  /** types: `<type>/<slug>` in the repository's spelling; owner: `<owner>/<slug>` (or `<owner>/<type>/<slug>`);
   *  none: no clear habit, so the common `<type>/<slug>`. */
  style: "types" | "owner" | "none";
  /** The repository's spelling of each type it uses (`feature` for feat, `bugfix` for fix…). */
  spelling: Partial<Record<GoalType, string>>;
  /** style owner: the one first part most branches share (a person's `marvin`), and whether a type follows it. */
  owner?: string;
  ownerTypes?: boolean;
  /** Ticket ids (ABC-123) in the branches: lowercase or uppercase, or null when they don't use them. */
  tickets: "upper" | "lower" | null;
}

/** The branches that show a person's habit: no bots', agents', capcomd's, release or long-lived ones, not `ignore`. */
const learnable = (branches: Iterable<string>, ignore: Array<string | null | undefined>) => {
  const skip = new Set(ignore.filter(Boolean).map((b) => b!.toLowerCase()));
  return [...branches].filter((b) => !NOT_A_PERSONS.test(b) && !LONG_LIVED.has(b.toLowerCase()) && !skip.has(b.toLowerCase()));
};
const typeOfSpelling = (s: string): GoalType | null => {
  const l = s.toLowerCase();
  for (const [t, sp] of Object.entries(SPELLINGS) as Array<[GoalType, string[]]>) if (sp.includes(l)) return t;
  return null;
};
/** Each type's most used spelling among `firsts` (ties: the conventional one); hotfix only when it's the only one. */
function spellingsOf(firsts: string[]): Partial<Record<GoalType, string>> {
  const counts = new Map<string, number>();
  for (const f of firsts) if (typeOfSpelling(f)) counts.set(f, (counts.get(f) ?? 0) + 1);
  const out: Partial<Record<GoalType, string>> = {};
  for (const [t, sp] of Object.entries(SPELLINGS) as Array<[GoalType, string[]]>) {
    const seen = [...counts].filter(([f]) => sp.includes(f.toLowerCase()))
      .sort((a, b) => (b[1] - a[1]) || (sp.indexOf(a[0].toLowerCase()) - sp.indexOf(b[0].toLowerCase())));
    const best = seen.find(([f]) => f.toLowerCase() !== "hotfix") ?? seen[0];
    if (best) out[t] = best[0];
  }
  return out;
}

/** The repository's branch naming habit, learned from its branches (`ignore`: its default branch and base). */
export function branchConvention(branches: Iterable<string>, ignore: Array<string | null | undefined> = []): BranchConvention {
  const list = learnable(branches, ignore);
  const firsts = list.filter((b) => b.includes("/")).map((b) => b.split("/")[0]!);
  const spelling = spellingsOf(firsts);
  const ticketed = list.map((b) => /(?:^|[/-])([A-Za-z][A-Za-z0-9]{1,9})-\d{1,7}(?:-|$)/.exec(b)?.[1])
    .filter((x): x is string => !!x && !typeOfSpelling(x));
  const tickets = list.length >= MIN_BRANCHES && ticketed.length / list.length >= MOSTLY / 2
    ? (ticketed.filter((x) => x === x.toUpperCase()).length * 2 >= ticketed.length ? "upper" : "lower") : null;
  if (list.length < MIN_BRANCHES) return { style: "none", spelling, tickets };
  const typed = firsts.filter((f) => typeOfSpelling(f) || TYPE_PREFIXES.has(f.toLowerCase())).length;
  if (typed / list.length >= MOSTLY) return { style: "types", spelling, tickets };
  const byFirst = new Map<string, string[]>();
  for (const b of list.filter((x) => x.includes("/"))) { const f = b.split("/")[0]!; byFirst.set(f, [...(byFirst.get(f) ?? []), b]); }
  const [owner, mine] = [...byFirst].sort((a, b) => b[1].length - a[1].length)[0] ?? [];
  if (owner && mine && mine.length / list.length >= MOSTLY && isRefSafe(owner)) {
    const seconds = mine.map((b) => b.split("/")).filter((p) => p.length > 2).map((p) => p[1]!);
    const ownerTypes = seconds.filter((s) => typeOfSpelling(s)).length / mine.length >= MOSTLY;
    return { style: "owner", spelling: ownerTypes ? { ...spelling, ...spellingsOf(seconds) } : spelling, owner, ownerTypes, tickets };
  }
  return { style: "none", spelling, tickets };
}

/**
 * The suggested goal branch, named the way the repository names its branches (learned from `existing`, the remote's
 * branches; see branchConvention): `<type>/<slug>` in the repository's spelling (feature/, bugfix/…), or
 * `<owner>/<slug>` when most branches share one first part, else the common `<type>/<slug>` (feat/csv-export,
 * fix/login-crash). A ticket id in the goal (ABC-123) leads the slug; none is ever made up. -2, -3… when the remote
 * has that name already; a branch named like the prefix itself (`feat`) makes it a flat `feat-<slug>`.
 */
export function suggestGoalBranch(goal: string, existing: Iterable<string> = [], o: { defaultBranch?: string | null; base?: string | null } = {}): string {
  const list = [...existing];
  const c = branchConvention(list, [o.defaultBranch, o.base]);
  const type = goalType(goal);
  const ticket = TICKET.exec(firstLine(goal));
  // Lowercase like the rest of the name, unless the repository's branches write their ticket ids in capitals.
  const id = ticket ? (c.tickets === "upper" ? `${ticket[1]}-${ticket[2]}` : `${ticket[1]}-${ticket[2]}`.toLowerCase()) : null;
  const slug = [id, goalBranchSlug(goal)].filter(Boolean).join("-") || "goal";
  const kind = c.spelling[type] ?? type;
  const parts = c.style === "owner" ? [c.owner!, ...(c.ownerTypes ? [kind] : [])] : [kind];
  // A branch named like a prefix (a branch "feat", or "marvin") would make every name under it impossible: go flat.
  let prefix = "";
  for (const p of parts) {
    const under = `${prefix}${p}/`.toLowerCase();
    prefix += collides(`${under}x`, list.filter((b) => !b.toLowerCase().startsWith(under))) ? `${p}-` : `${p}/`;
  }
  const base = `${prefix}${slug}`;
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
  const name = suggestGoalBranch(o.goal, known, { defaultBranch: (listing as BranchListing | null)?.defaultBranch ?? null, base });
  // A suggestion that lands on a protected pattern (CAPCOMD_PROTECTED_BRANCHES="capcomd/*"): say so rather than guess.
  const gp = goalBranchProblem(name, { base, env: o.env });
  if (gp) throw new RelayError("usage", `goal branch: ${gp}`, "Name the goal branch yourself (--goal-branch).", { code: "goalBranch" });
  return { base, goalBranch: name, baseSource, listing };
}
