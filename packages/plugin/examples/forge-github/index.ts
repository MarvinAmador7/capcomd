// Worked example, spec §15.2: GitHub as a forge. Today's src/merge/github.ts HttpGitHub, src/merge/pr.ts prMerge and
// the `gh` calls (`gh repo create`, `gh auth status`, `gh api user`) become this module. The kernel
// keeps the target lock, the CAS on `targetSha`, integration and the checks (src/merge/direct.ts, integrate.ts).
import { definePlugin, PluginError, type ErrorClass, type Forge, type ForgeBranches, type ForgeLogin, type LandOutcome, type LandRequest, type PullRequestRef, type SeamCall } from "../../src/index";

interface Config { api: string; pollMs: number; timeoutMs: number }

class GitHubHttpError extends Error {
  constructor(readonly status: number, readonly body: string, readonly rateLimited: boolean) { super(`GitHub ${status}${rateLimited ? " (rate limited)" : ""}: ${body.slice(0, 300)}`); }
}

const repoOf = (remote: string): string | null => /github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/.exec(remote)?.[1] ?? null;

class GitHubForge implements Forge {
  constructor(private readonly cfg: Config, private readonly token: () => Promise<string>, private readonly git: (workdir: string, args: string[], c: SeamCall) => Promise<{ code: number; stdout: string; stderr: string }>) {}
  describe() { return { name: "github", label: "GitHub", pullRequests: true, publish: true }; }
  matches(remote: string) { return repoOf(remote) !== null; }
  classifyError(e: unknown): ErrorClass {
    if (e instanceof GitHubHttpError) {
      if (e.rateLimited) return { kind: "quota", retryable: true, retryAfterMs: 60_000, hint: "GitHub rate limit; the merge retries in a minute." };
      if (e.status === 401 || e.status === 403) return { kind: "auth", retryable: false, hint: "Set GITHUB_TOKEN or run `gh auth login`." };
      if (e.status === 404) return { kind: "not_found", retryable: false };
      if (e.status >= 500) return { kind: "transient", retryable: true };
    }
    return { kind: "unknown", retryable: false };
  }

  private async req<T>(method: string, path: string, c: SeamCall, body?: unknown): Promise<{ status: number; json: T | null; text: string }> {
    const res = await fetch(`${this.cfg.api.replace(/\/$/, "")}${path}`, {
      method, signal: c.signal,
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${await this.token()}`, "x-github-api-version": "2022-11-28", "user-agent": "capcomd", ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: T | null = null;
    try { json = text ? (JSON.parse(text) as T) : null; } catch { /* not JSON */ }
    const rateLimited = (res.status === 403 || res.status === 429) && (res.headers.get("x-ratelimit-remaining") === "0" || /rate limit/i.test(text));
    if (rateLimited) throw new GitHubHttpError(res.status, text, true);
    return { status: res.status, json, text };
  }

  async land(req: LandRequest, c: SeamCall): Promise<LandOutcome> {
    const repo = repoOf(req.remote);
    if (!repo) throw new PluginError("invalid", `${req.remote} is not a GitHub remote`);
    if (req.mode === "direct") {
      // A compare-and-swap push: the target must still be where the kernel integrated (ADR-013).
      const r = await this.git(req.workdir, ["push", "origin", `${req.sha}:refs/heads/${req.target}`, `--force-with-lease=refs/heads/${req.target}:${req.targetSha}`], c);
      if (r.code === 0) return { status: "merged", sha: req.sha, already: false, how: "push", pr: null };
      if (/stale info|rejected/.test(r.stderr)) {
        const head = await this.git(req.workdir, ["ls-remote", "origin", `refs/heads/${req.target}`], c);
        const targetSha = head.stdout.split("\t")[0] ?? "";
        return targetSha === req.sha ? { status: "merged", sha: req.sha, already: true, how: "push", pr: null } : { status: "conflict", targetSha };
      }
      return { status: "failed", reason: r.stderr.trim() || `git push exited ${r.code}`, retryable: /could not resolve host|timed out/i.test(r.stderr) };
    }
    // PR mode: the branch is pushed; find or create the PR, then merge it at exactly the head the kernel checked.
    const pr = (await this.findPullRequest({ remote: req.remote, head: req.branch, base: req.target }, c))
      ?? (await this.openPullRequest({ remote: req.remote, head: req.branch, base: req.target, title: req.subject, body: req.body }, c));
    if (pr.state === "merged") return { status: "merged", sha: pr.mergeSha ?? req.sha, already: true, how: "pr", pr: pr.number };
    const deadline = Date.parse(c.deadline);
    while (Date.now() < deadline && !c.signal.aborted) {
      const m = await this.req<{ merged?: boolean; sha?: string; message?: string }>("PUT", `/repos/${repo}/pulls/${pr.number}/merge`, c, { merge_method: req.strategy, sha: req.branchSha ?? req.sha, commit_title: req.subject, commit_message: req.body });
      if (m.status === 200 && m.json?.merged) return { status: "merged", sha: m.json.sha ?? req.sha, already: false, how: "pr", pr: pr.number };
      if (m.status === 409) { const head = await this.req<{ object: { sha: string } }>("GET", `/repos/${repo}/git/ref/heads/${req.target}`, c); return { status: "conflict", targetSha: head.json?.object.sha ?? "" }; }
      if (m.status !== 405) return { status: "failed", reason: m.json?.message ?? m.text, retryable: m.status >= 500 };
      await Bun.sleep(this.cfg.pollMs); // 405: not mergeable yet (checks, protection, queue)
    }
    return { status: "failed", reason: `pull request #${pr.number} was not mergeable by ${c.deadline}`, retryable: true };
  }

  async openPullRequest(input: { remote: string; head: string; base: string; title: string; body: string | { text: string } }, c: SeamCall): Promise<PullRequestRef> {
    const repo = repoOf(input.remote);
    if (!repo) throw new PluginError("invalid", `${input.remote} is not a GitHub remote`);
    const body = typeof input.body === "string" ? input.body : input.body.text;
    const r = await this.req<{ number: number; html_url?: string; state: "open" | "closed"; merged?: boolean }>("POST", `/repos/${repo}/pulls`, c, { head: input.head, base: input.base, title: input.title, body });
    if (r.status === 201 && r.json) return { number: r.json.number, url: r.json.html_url ?? null, state: "open", head: input.head, base: input.base };
    if (r.status === 422) { const existing = await this.findPullRequest(input, c); if (existing) return existing; }
    throw new GitHubHttpError(r.status, r.text, false);
  }

  async findPullRequest(input: { remote: string; head: string; base: string }, c: SeamCall): Promise<PullRequestRef | null> {
    const repo = repoOf(input.remote);
    if (!repo) return null;
    const owner = repo.split("/")[0];
    const r = await this.req<Array<{ number: number; html_url?: string; state: "open" | "closed"; merged_at: string | null; merge_commit_sha?: string | null }>>("GET", `/repos/${repo}/pulls?state=all&head=${encodeURIComponent(`${owner}:${input.head}`)}&base=${encodeURIComponent(input.base)}&per_page=10`, c);
    if (r.status !== 200 || !r.json) throw new GitHubHttpError(r.status, r.text, false);
    const pick = r.json.find((p) => p.merged_at) ?? r.json.find((p) => p.state === "open");
    return pick ? { number: pick.number, url: pick.html_url ?? null, state: pick.merged_at ? "merged" : pick.state, head: input.head, base: input.base, mergeSha: pick.merged_at ? pick.merge_commit_sha ?? null : null } : null;
  }

  async publishRepository(input: { path: string; owner: string | null; name: string; visibility: "private" | "public" }, c: SeamCall) {
    const r = await this.req<{ clone_url: string; html_url: string }>("POST", input.owner ? `/orgs/${input.owner}/repos` : "/user/repos", c, { name: input.name, private: input.visibility === "private" });
    if (r.status !== 201 || !r.json) throw new GitHubHttpError(r.status, r.text, false);
    await this.git(input.path, ["remote", "add", "origin", r.json.clone_url], c);
    return { remote: r.json.clone_url, url: r.json.html_url };
  }

  async listBranches(input: { remote: string; cwd: string; max: number }, c: SeamCall): Promise<ForgeBranches> {
    const repo = repoOf(input.remote);
    let note: string | null = null;
    if (repo) {
      try {
        const info = await this.req<{ default_branch: string }>("GET", `/repos/${repo}`, c);
        const page = await this.req<Array<{ name: string }>>("GET", `/repos/${repo}/branches?per_page=100`, c);
        if (info.status === 200 && page.status === 200) return { defaultBranch: info.json?.default_branch ?? null, branches: (page.json ?? []).map((b) => b.name).sort().slice(0, input.max), source: "service", note: null };
        note = `GitHub answered ${info.status === 200 ? page.status : info.status}`;
      } catch (e) { note = `GitHub: ${(e as Error).message}`; }
    }
    // The remote itself: its HEAD is the default branch.
    const r = await this.git(input.cwd, ["ls-remote", "--symref", input.remote, "HEAD", "refs/heads/*"], c);
    if (r.code !== 0) throw new PluginError("unavailable", [note, `git ls-remote failed: ${r.stderr.trim().split("\n")[0] ?? ""}`].filter(Boolean).join("; "));
    const defaultBranch = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(r.stdout)?.[1] ?? null;
    const branches = [...r.stdout.matchAll(/^[0-9a-f]{40,64}\trefs\/heads\/(\S+)$/gm)].map((m) => m[1]!).sort().slice(0, input.max);
    return { defaultBranch, branches, source: "git", note };
  }

  /** The token opens and merges pull requests and creates repositories alike; `accounts`: who it is, and its orgs. */
  async login(input: { use: "pullRequests" | "publish"; accounts?: boolean }, c: SeamCall): Promise<ForgeLogin> {
    try {
      if (!input.accounts) { await this.token(); return { ok: true, accounts: [] }; }
      const user = await this.req<{ login: string }>("GET", "/user", c);
      if (user.status !== 200 || !user.json?.login) return { ok: false, reason: `GitHub answered ${user.status} for /user`, fix: "Set the token, or run `gh auth login`." };
      const orgs = await this.req<Array<{ login: string }>>("GET", "/user/orgs", c);
      return { ok: true, accounts: [{ login: user.json.login, kind: "user" }, ...(orgs.json ?? []).map((o) => ({ login: o.login, kind: "org" as const }))] };
    } catch (e) {
      return { ok: false, reason: (e as Error).message, fix: "Set the token, or run `gh auth login`." };
    }
  }
}

async function git(workdir: string, args: string[], c: SeamCall) {
  const proc = Bun.spawn(["git", ...args], { cwd: workdir, stdout: "pipe", stderr: "pipe" });
  const onAbort = () => proc.kill("SIGKILL");
  c.signal.addEventListener("abort", onAbort, { once: true });
  try { const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]); return { code, stdout, stderr }; }
  finally { c.signal.removeEventListener("abort", onAbort); }
}

export const plugin = definePlugin<Config>({
  activate(ctx) {
    // The token is a secret property: read on use, never kept in config or logs. Unset: `gh auth token`, as today.
    const token = async () => {
      try { return await ctx.config.secret("token"); } catch (e) {
        if (!(e instanceof PluginError) || e.code !== "not_found") throw e;
        const proc = Bun.spawn(["gh", "auth", "token"], { stdout: "pipe", stderr: "ignore" });
        const out = (await new Response(proc.stdout).text()).trim();
        if ((await proc.exited) !== 0 || !out) throw new PluginError("unavailable", "PR mode needs a GitHub token", "Set GITHUB_TOKEN or run `gh auth login`.");
        return out;
      }
    };
    ctx.seams.forge(new GitHubForge(ctx.config.get(), token, git));
  },
});
