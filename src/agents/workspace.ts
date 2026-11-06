// Where an agent works in its sandbox. On Docker, `capcomd env build` bakes a warm checkout of the project into the
// env image (the template: full history, dependencies installed), and every container is its own copy-on-write copy of
// it, so the runner can use the template in place: fetch the target, `checkout -B`, work, commit. Otherwise (no warm
// template, a stale one, a changed lockfile, a sandbox whose files other agents share) it clones as before. The choice
// is `chooseWorkspace`, from facts the runner reads in the sandbox.

/** Lockfiles in the order capcomd looks for them (the first one present is the project's). */
export const LOCKFILES = ["bun.lock", "bun.lockb", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"];

/** The warm template's record, inside the template's .git (never in the working tree, so never committed). */
export const TEMPLATE_MARKER = ".git/capcomd-template.json";
/** The lockfile hash of the dependencies installed in the template (a warm one; older images keep it in the tree). */
export const TEMPLATE_LOCKHASH = ".git/capcomd-lockhash";
/** A run that uses the template in place claims it (mkdir is atomic): a later run in the same sandbox clones instead. */
export const TEMPLATE_CLAIM = ".git/capcomd-claim";

export interface TemplateMarker {
  schema: 1;
  /** The clone URL it was built from (token-free). */
  repo: string;
  /** The branch it was built from (the project's target). */
  target: string;
  /** The commit checked out in it. */
  commit: string;
  /** The lockfile at that commit and its sha256, or "none". */
  lockFile: string;
  lockHash: string;
  /** Its dependencies are installed (node_modules, for that lockfile). */
  depsInstalled: boolean;
}

export function parseTemplateMarker(text: string): TemplateMarker | null {
  try {
    const m = JSON.parse(text);
    if (m?.schema !== 1 || typeof m.repo !== "string" || typeof m.commit !== "string" || !/^[0-9a-f]{40}$/.test(m.commit)) return null;
    if (typeof m.target !== "string" || typeof m.lockFile !== "string" || typeof m.lockHash !== "string" || typeof m.depsInstalled !== "boolean") return null;
    return m as TemplateMarker;
  } catch { return null; }
}

/** Clone URLs as git sees the same repository: no trailing slash or `.git`, case-insensitive host for URLs. */
export function sameRepo(a: string, b: string): boolean {
  const norm = (u: string) => u.trim().replace(/\/+$/, "").replace(/\.git$/, "").replace(/^([a-z+]+:\/\/[^/]+)/i, (h) => h.toLowerCase());
  return !!a && norm(a) === norm(b);
}

export interface WorkspaceFacts {
  /** The sandbox is this agent's own copy of the image (Docker), so the template may change in place. */
  allowed: boolean;
  /** The template's record, when the image has a warm template. */
  marker: TemplateMarker | null;
  /** An earlier run in this sandbox already used the template (a retry of the same attempt): it isn't clean any more. */
  claimed: boolean;
  /** The run's clone URL. */
  repoUrl: string;
  /** The fetches into the template worked; null when not tried. */
  fetched: boolean | null;
  /** The template's commit is an ancestor of (or equal to) the target's tip; null when not known. */
  ancestor: boolean | null;
  /** The commit the agent starts from is in the template after the fetches; null when not known. */
  startFound: boolean | null;
  /** The sha256 of the lockfile in the tree the agent starts from ("none" without one); null when not known. */
  startLockHash: string | null;
}
export type WorkspaceChoice = { path: "in_place" } | { path: "clone"; reason: string };

/**
 * In place only when every fact says the template is this run's checkout, ready: allowed, warm, unused, the same
 * repository, fetched, not behind a rewritten target, holding the start commit, and its dependencies built for the
 * start tree's lockfile (a template without dependencies only needs the rest: there's nothing to mismatch). The
 * reason says why not.
 */
export function chooseWorkspace(f: WorkspaceFacts): WorkspaceChoice {
  const clone = (reason: string): WorkspaceChoice => ({ path: "clone", reason });
  if (!f.allowed) return clone("this sandbox doesn't keep a warm template per agent");
  if (!f.marker) return clone("no warm template in the image (capcomd env build --sandbox docker makes one; on boxd, capcomd env build --project)");
  if (f.claimed) return clone("the warm template was used by an earlier run in this sandbox");
  if (!sameRepo(f.marker.repo, f.repoUrl)) return clone("the warm template is of another repository");
  if (f.fetched === false) return clone("fetching into the warm template failed");
  if (f.ancestor === false) return clone(`the warm template's commit ${f.marker.commit.slice(0, 12)} isn't in the target's history (rebuild it)`);
  if (f.startFound === false) return clone("the commit to start from isn't in the warm template");
  if (f.fetched === null || f.ancestor === null || f.startFound === null || f.startLockHash === null) return clone("the warm template couldn't be checked");
  if (f.marker.depsInstalled && f.startLockHash !== f.marker.lockHash) return clone("the lockfile changed since the warm template was built");
  return { path: "in_place" };
}

/** The ref (or commit) the agent's checkout starts from, as the runner checks it out. */
export function startRef(t: { target: string; branch: string; rework?: boolean; report?: boolean; review?: { sha: string }; from?: unknown }, branchExists: boolean): string {
  if (t.review) return t.review.sha;
  if (t.from && !branchExists && !t.report) return "FETCH_HEAD";
  return branchExists && !t.rework ? `origin/${t.branch}` : `origin/${t.target}`;
}
