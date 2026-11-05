// forge-git (docs/spec/plugin-api.md §7.4, §17.1): the built-in forge for any remote, loaded last (`order: post`) so
// it is the default only when no other forge claims the remote. It lands by push alone: the compare-and-swap of the
// integrated, checked commit onto the target that src/merge/direct.ts made itself before. The kernel keeps the target
// lock, the fetch, the integration, the checks and the retries; no pull requests (`pullRequests: false`).
import { definePlugin, type PluginModule } from "../../../packages/plugin/src/context";
import { PluginError } from "../../../packages/plugin/src/errors";
import type { PluginManifest } from "../../../packages/plugin/src/manifest";
import type { ErrorClass, Forge, LandOutcome, LandRequest, PullRequestRef, SeamCall } from "../../../packages/plugin/src/seams";
import { Git } from "../../merge/git";
import { remoteDefaultBranch, remoteGit } from "../../merge/host-git";
import { VERSION } from "../../utils/self";

/** A push git refused because a lease didn't hold: someone moved the ref since the kernel looked. */
export const LEASE_REJECTED = /stale info|\(fetch first\)|non-fast-forward|\[rejected\]|failed to update ref|cannot lock ref|reference already exists|incorrect old value/i;
const NETWORK = /could not resolve host|connection (?:timed out|refused|reset)|timed out|unable to access|early eof/i;

/**
 * The CAS push (ADR-013), from the kernel's clone: `req.sha` onto `req.target`, leased at `req.targetSha`; with
 * `req.leaseBranch`, the branch leased at `req.branchSha` in the same atomic push. Any forge that lands by push uses it.
 * To `req.remote` by its URL, from a host repo only (src/merge/host-git.ts): a clone whose settings or hooks changed
 * since capcomd made it is refused, not pushed from.
 */
export async function casPush(req: LandRequest, c: SeamCall): Promise<LandOutcome> {
  const target = `refs/heads/${req.target}`, branch = `refs/heads/${req.branch}`;
  const lease = req.leaseBranch && req.branchSha;
  if (c.signal.aborted) throw new PluginError("timeout", `git push to ${req.target} was cancelled`, undefined, true);
  const git = new Git(req.workdir);
  const push = await remoteGit(git, lease
    ? ["push", "--porcelain", "--atomic", `--force-with-lease=${target}:${req.targetSha}`, `--force-with-lease=${branch}:${req.branchSha}`, req.remote, `${req.sha}:${target}`, `${req.branchSha}:${branch}`]
    : ["push", "--porcelain", `--force-with-lease=${target}:${req.targetSha}`, req.remote, `${req.sha}:${target}`], req.remote, { signal: c.signal });
  if (c.signal.aborted) throw new PluginError("timeout", `git push to ${req.target} was cancelled`, undefined, true);
  if (push.code === 0) {
    // "=" for the target: it was there already (a replay after a crash between the push and its record).
    const already = push.stdout.split("\n").some((l) => l.startsWith("=") && l.includes(`:${target}\t`));
    // A push by URL leaves the clone's remote-tracking refs alone: moved here, as a push to `origin` did, so the clone's
    // view of the target is this push (the next merge's fast path reads it).
    const moved = [`update refs/remotes/origin/${req.target} ${req.sha}`, ...(lease ? [`update refs/remotes/origin/${req.branch} ${req.branchSha}`] : [])];
    await git.run(["update-ref", "--stdin"], { input: moved.join("\n") + "\n" }).catch(() => {});
    return { status: "merged", sha: req.sha, already, how: "push", pr: null };
  }
  const text = (push.stdout + push.stderr).trim();
  if (LEASE_REJECTED.test(text)) return { status: "conflict", targetSha: "", detail: text };
  // No atomic pushes on this remote: the kernel fetches and lands again, leasing the target alone.
  return { status: "failed", reason: text || `git push exited ${push.code}`, retryable: !!lease && /atomic/i.test(text) };
}

/** The remote's default branch (`git ls-remote --symref <remote> HEAD`, outside any repository), or null when it doesn't say. */
export async function lsRemoteDefault(remote: string, c: SeamCall): Promise<string | null> {
  return remoteDefaultBranch(remote, { signal: c.signal, timeoutMs: Math.max(1, Date.parse(c.deadline) - Date.now()) });
}

/** The classification every push-based forge shares (§7.2.3). */
export function classifyGitError(e: unknown): ErrorClass {
  if (e instanceof PluginError) {
    if (e.code === "timeout") return { kind: "timeout", retryable: true };
    if (e.code === "not_found") return { kind: "not_found", retryable: false };
    if (e.code === "unsupported" || e.code === "invalid") return { kind: "config", retryable: false, hint: e.hint ?? e.message };
  }
  if (NETWORK.test(String((e as Error)?.message ?? e))) return { kind: "transient", retryable: true };
  return { kind: "unknown", retryable: false };
}

const noPullRequests = () => new PluginError("unsupported", "the git forge lands by push only: it has no pull requests", "Set the merge mode to direct, or name a forge that has pull requests (merge.forge).");

export class GitForge implements Forge {
  describe() { return { name: "git", label: "Git", pullRequests: false }; }
  matches(_remote: string) { return true; }
  classifyError(e: unknown) { return classifyGitError(e); }
  async land(req: LandRequest, c: SeamCall): Promise<LandOutcome> {
    if (req.mode === "pr") throw noPullRequests();
    return casPush(req, c);
  }
  async openPullRequest(): Promise<PullRequestRef> { throw noPullRequests(); }
  async findPullRequest(): Promise<PullRequestRef | null> { throw noPullRequests(); }
  async publishRepository(): Promise<{ remote: string; url: string | null }> {
    throw new PluginError("unsupported", "the git forge can't create repositories", "Create the repository where it is hosted, then add it as origin.");
  }
  defaultBranch(remote: string, c: SeamCall) { return lsRemoteDefault(remote, c); }
}

export const manifest = {
  schema: "capcomd.plugin/v1",
  name: "forge-git",
  version: VERSION,
  description: "Any git remote as the forge: lands verified work with a compare-and-swap push. No pull requests.",
  apiVersion: 1,
  engines: { capcomd: VERSION },
  entry: { runtime: "in-process", module: "./git.ts" },
  // Last among the forges: it matches every remote, so it is the default only when no other forge claims one (§7.1).
  order: "post",
  provides: ["seam:forge/git"],
  contributes: { seams: [{ kind: "forge", name: "git" }] },
} satisfies PluginManifest;

export const plugin: PluginModule<Record<string, never>> = definePlugin({
  activate(ctx) { ctx.seams.forge(new GitForge()); },
});
