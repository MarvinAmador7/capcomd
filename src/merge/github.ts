/** Typed GitHub REST adapter (only what PR mode needs). Works against api.github.com or a fake. */
export interface PullRequest {
  number: number;
  node_id?: string;
  state: "open" | "closed";
  merged: boolean;
  merged_at?: string | null;
  merge_commit_sha: string | null;
  mergeable?: boolean | null;
  mergeable_state?: string;
  head: { ref: string; sha: string };
  base: { ref: string };
  html_url?: string;
}

export interface MergeResult { merged: boolean; sha?: string; message?: string; status: number }

export interface GitHubApi {
  findPullByHead(repo: string, head: string, base: string): Promise<PullRequest | null>;
  createPull(repo: string, p: { head: string; base: string; title: string; body: string }): Promise<PullRequest>;
  getPull(repo: string, number: number): Promise<PullRequest>;
  mergePull(repo: string, number: number, p: { merge_method: "squash" | "rebase" | "merge"; sha: string; commit_title?: string; commit_message?: string }): Promise<MergeResult>;
  /** Hand the PR to auto-merge / the merge queue. Best effort. */
  enableAutoMerge(repo: string, pr: PullRequest, method: "squash" | "rebase" | "merge"): Promise<boolean>;
}

export class GitHubHttpError extends Error {
  constructor(readonly status: number, readonly body: string, readonly rateLimited: boolean) {
    super(`GitHub ${status}${rateLimited ? " (rate limited)" : ""}: ${body.slice(0, 300)}`);
    this.name = "GitHubHttpError";
  }
}

export class HttpGitHub implements GitHubApi {
  constructor(readonly api: string, readonly token: string, readonly fetchImpl: typeof fetch = fetch) {}

  private async req(method: string, path: string, body?: unknown): Promise<{ status: number; json: any; text: string }> {
    const res = await this.fetchImpl(`${this.api.replace(/\/$/, "")}${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${this.token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "capcomd",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    const rateLimited = (res.status === 403 || res.status === 429) && (res.headers.get("x-ratelimit-remaining") === "0" || /rate limit/i.test(text));
    if (rateLimited) throw new GitHubHttpError(res.status, text, true);
    return { status: res.status, json, text };
  }

  async findPullByHead(repo: string, head: string, base: string): Promise<PullRequest | null> {
    const owner = repo.split("/")[0];
    const r = await this.req("GET", `/repos/${repo}/pulls?state=all&head=${encodeURIComponent(`${owner}:${head}`)}&base=${encodeURIComponent(base)}&per_page=10`);
    if (r.status !== 200) throw new GitHubHttpError(r.status, r.text, false);
    const list = (r.json as PullRequest[]) ?? [];
    // Prefer a merged PR (idempotency), then an open one.
    const merged = list.find((p) => p.merged_at || p.merged);
    if (merged) return this.getPull(repo, merged.number);
    const open = list.find((p) => p.state === "open");
    return open ? this.getPull(repo, open.number) : null;
  }

  async createPull(repo: string, p: { head: string; base: string; title: string; body: string }): Promise<PullRequest> {
    const r = await this.req("POST", `/repos/${repo}/pulls`, p);
    if (r.status === 201) return r.json;
    // 422 "A pull request already exists": a crash between create and record; find it.
    if (r.status === 422) {
      const existing = await this.findPullByHead(repo, p.head, p.base);
      if (existing) return existing;
    }
    throw new GitHubHttpError(r.status, r.text, false);
  }

  async getPull(repo: string, number: number): Promise<PullRequest> {
    const r = await this.req("GET", `/repos/${repo}/pulls/${number}`);
    if (r.status !== 200) throw new GitHubHttpError(r.status, r.text, false);
    return { ...r.json, merged: !!(r.json.merged || r.json.merged_at) };
  }

  async mergePull(repo: string, number: number, p: { merge_method: "squash" | "rebase" | "merge"; sha: string; commit_title?: string; commit_message?: string }): Promise<MergeResult> {
    const r = await this.req("PUT", `/repos/${repo}/pulls/${number}/merge`, p);
    if (r.status === 200) return { merged: !!r.json?.merged, sha: r.json?.sha, status: 200 };
    // 405 not mergeable (checks / protection / queue), 409 head moved, 422 invalid.
    return { merged: false, message: r.json?.message ?? r.text, status: r.status };
  }

  async enableAutoMerge(repo: string, pr: PullRequest, method: "squash" | "rebase" | "merge"): Promise<boolean> {
    if (!pr.node_id) return false;
    const graphql = this.api.replace(/\/$/, "") === "https://api.github.com" ? "/graphql" : "/graphql";
    const r = await this.req("POST", graphql, {
      query: "mutation($id:ID!,$m:PullRequestMergeMethod!){enablePullRequestAutoMerge(input:{pullRequestId:$id,mergeMethod:$m}){clientMutationId}}",
      variables: { id: pr.node_id, m: method.toUpperCase() },
    });
    return r.status === 200 && !r.json?.errors;
  }
}

/** Token: GITHUB_TOKEN / GH_TOKEN, else `gh auth token`. Never logged. */
export async function githubToken(): Promise<string> {
  const t = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (t) return t;
  const proc = Bun.spawn(["gh", "auth", "token"], { stdout: "pipe", stderr: "ignore" });
  const out = (await new Response(proc.stdout).text()).trim();
  if ((await proc.exited) !== 0 || !out) throw new Error("PR mode needs a GitHub token: set GITHUB_TOKEN or run `gh auth login`");
  return out;
}
