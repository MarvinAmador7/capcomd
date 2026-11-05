// forge-github (docs/spec/plugin-api.md §15.2, §17.1): GitHub as the forge. What src/merge/pr.ts did once the work was
// integrated and checked (find or open the pull request, merge it at the checked head, hand it to auto-merge and wait),
// the pull requests of a run's goal branch (POST /v1/runs/{runId}/pull-request, capcomd_pr_open, `capcomd pr open`),
// `gh repo create` for POST /v1/projects/publish, and a remote's default branch. A direct land is the same CAS push as
// forge-git's. The REST adapter stays src/merge/github.ts (tests inject a fake one with setGitHubApi); the project's
// settings (CAPCOMD_GITHUB_API, _POLL_MS, _TIMEOUT_MS, _REPO) reach it through the kernel's forge scope.
import { spawn } from "node:child_process";
import { definePlugin, type PluginModule } from "../../../packages/plugin/src/context";
import { PluginError } from "../../../packages/plugin/src/errors";
import type { PluginManifest } from "../../../packages/plugin/src/manifest";
import type { ErrorClass, Forge, LandOutcome, LandRequest, PullRequestRef, SeamCall } from "../../../packages/plugin/src/seams";
import type { Untrusted } from "../../../packages/plugin/src/shapes";
import { githubRepoFromRemote } from "../../merge/config";
import { GitHubHttpError, githubAt, type GitHubApi, type PullRequest } from "../../merge/github";
import { killpoint } from "../../utils/killpoint";
import { VERSION } from "../../utils/self";
import { casPush, lsRemoteDefault } from "./git";
import { scoped } from "./scope";

export interface GitHubForgeConfig { api: string; pollMs: number; timeoutMs: number }
const DEFAULTS: GitHubForgeConfig = { api: "https://api.github.com", pollMs: 5000, timeoutMs: 30 * 60_000 };
/** How long `gh repo create … --push` may take. */
const PUBLISH_TIMEOUT_MS = 180_000;

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  if (signal.aborted) return resolve();
  const t = setTimeout(done, ms);
  function done() { clearTimeout(t); signal.removeEventListener("abort", done); resolve(); }
  signal.addEventListener("abort", done, { once: true });
});
const trailerLines = (t: Record<string, string>) => Object.entries(t).map(([k, v]) => `${k}: ${v}`).join("\n");
const firstLine = (s: string) => (s.split("\n").map((l) => l.trim()).find(Boolean) ?? "").slice(0, 300);

export class GitHubForge implements Forge {
  constructor(private readonly cfg: GitHubForgeConfig = DEFAULTS) {}

  describe() { return { name: "github", label: "GitHub", pullRequests: true }; }
  matches(remote: string) { return githubRepoFromRemote(remote) !== null; }
  classifyError(e: unknown): ErrorClass {
    if (e instanceof GitHubHttpError) {
      if (e.rateLimited) return { kind: "quota", retryable: true, retryAfterMs: 60_000, hint: "GitHub rate limit; the merge retries in a minute." };
      if (e.status === 401 || e.status === 403) return { kind: "auth", retryable: false, hint: "Set GITHUB_TOKEN or run `gh auth login`." };
      if (e.status === 404) return { kind: "not_found", retryable: false };
      if (e.status >= 500) return { kind: "transient", retryable: true };
    }
    if (e instanceof PluginError) {
      if (e.code === "unavailable") return { kind: "auth", retryable: false, hint: e.hint ?? "Set GITHUB_TOKEN or run `gh auth login`." };
      if (e.code === "timeout") return { kind: "timeout", retryable: true };
      if (e.code === "invalid" || e.code === "unsupported") return { kind: "config", retryable: false, hint: e.hint ?? e.message };
    }
    return { kind: "unknown", retryable: false };
  }

  /** The project's settings when the kernel gave them (the run's merge config), else this plugin's own. */
  private settings(): GitHubForgeConfig {
    const m = scoped().merge?.github;
    return { api: m?.api ?? process.env.CAPCOMD_GITHUB_API ?? this.cfg.api, pollMs: m?.pollMs ?? this.cfg.pollMs, timeoutMs: m?.timeoutMs ?? this.cfg.timeoutMs };
  }
  /** owner/name: the request's, else the project's (CAPCOMD_GITHUB_REPO), else the remote's. */
  private repo(remote: string, given?: string | null): string {
    const r = given ?? scoped().merge?.github.repo ?? githubRepoFromRemote(remote);
    if (!r) throw new PluginError("invalid", `${remote} isn't a GitHub repository`, "Set CAPCOMD_GITHUB_REPO to owner/name, or use a github.com remote.");
    return r;
  }
  private async api(): Promise<GitHubApi> {
    try { return await githubAt(this.settings().api); }
    catch (e) { throw new PluginError("unavailable", (e as Error).message, "Set GITHUB_TOKEN or run `gh auth login`."); }
  }
  private ref(p: PullRequest, repo: string, input: { head: string; base: string }): PullRequestRef {
    const web = this.settings().api.replace(/\/$/, "") === "https://api.github.com" ? `https://github.com/${repo}/pull/${p.number}` : null;
    return { number: p.number, url: p.html_url ?? web, state: p.merged ? "merged" : p.state, head: p.head?.ref ?? input.head, base: p.base?.ref ?? input.base, mergeSha: p.merge_commit_sha ?? null };
  }

  async land(req: LandRequest, c: SeamCall): Promise<LandOutcome> {
    if (req.mode === "direct") return casPush(req, c);
    const repo = this.repo(req.remote, req.repo), s = this.settings(), gh = await this.api();
    const head = req.branchSha ?? req.sha;
    // Idempotent by the branch: a merged pull request for it is the landing (a replay after a crash).
    const existing = await gh.findPullByHead(repo, req.branch, req.target);
    if (existing?.merged && existing.merge_commit_sha) return { status: "merged", sha: existing.merge_commit_sha, already: true, how: "pr-already-merged", pr: existing.number };
    let pr = existing && existing.state === "open" ? existing : await gh.createPull(repo, { head: req.branch, base: req.target, title: req.subject, body: req.body });

    killpoint("merge.pr.before_merge");
    const merge = () => gh.mergePull(repo, pr.number, { merge_method: req.strategy, sha: head, commit_title: `${req.subject} (#${pr.number})`, commit_message: trailerLines(req.trailers) });
    let res = await merge();
    if (!res.merged && (res.status === 405 || res.status === 409)) {
      // Protection, pending required checks or a merge queue: hand it to auto-merge and wait.
      await gh.enableAutoMerge(repo, pr, req.strategy).catch(() => false);
      const deadline = Math.min(Date.now() + s.timeoutMs, Date.parse(c.deadline));
      for (;;) {
        pr = await gh.getPull(repo, pr.number);
        if (pr.merged && pr.merge_commit_sha) break;
        if (pr.state === "closed") return { status: "failed", reason: `PR #${pr.number} was closed without merging`, retryable: false };
        if (pr.mergeable_state === "dirty") return { status: "conflict", targetSha: "", detail: `PR #${pr.number} conflicts with ${req.target}` };
        if (Date.now() > deadline || c.signal.aborted) return { status: "failed", reason: `PR #${pr.number} not merged after ${s.timeoutMs}ms (${res.message ?? pr.mergeable_state})`, retryable: true };
        await sleep(s.pollMs, c.signal);
        // Some repos have no auto-merge: retry the merge call once checks may have passed.
        if (pr.mergeable_state === "clean") {
          res = await merge();
          if (res.merged) { pr = await gh.getPull(repo, pr.number); break; }
        }
      }
    } else if (!res.merged) {
      return { status: "failed", reason: `GitHub refused merge of PR #${pr.number} (${res.status}): ${res.message}`, retryable: false };
    } else {
      pr = await gh.getPull(repo, pr.number);
    }
    return { status: "merged", sha: pr.merge_commit_sha ?? res.sha ?? "", already: false, how: `pr-${req.strategy}`, pr: pr.number };
  }

  async openPullRequest(input: { remote: string; head: string; base: string; title: string; body: Untrusted | string }, _c: SeamCall): Promise<PullRequestRef> {
    const repo = this.repo(input.remote), gh = await this.api();
    const body = typeof input.body === "string" ? input.body : input.body.text;
    return this.ref(await gh.createPull(repo, { head: input.head, base: input.base, title: input.title, body }), repo, input);
  }

  async findPullRequest(input: { remote: string; head: string; base: string }, _c: SeamCall): Promise<PullRequestRef | null> {
    const repo = this.repo(input.remote), gh = await this.api();
    const p = await gh.findPullByHead(repo, input.head, input.base);
    return p ? this.ref(p, repo, input) : null;
  }

  /** `gh repo create <owner>/<name> --private|--public --source <path> --remote origin --push`, with the user's own gh
   *  login (CAPCOMD_GH_CLI names the binary). A name GitHub has already is `conflict`; anything else `unavailable`. */
  async publishRepository(input: { path: string; owner: string | null; name: string; visibility: "private" | "public" }, c: SeamCall): Promise<{ remote: string; url: string | null }> {
    const env = { ...process.env, ...(scoped().env ?? {}) };
    const full = input.owner ? `${input.owner}/${input.name}` : input.name;
    const timeoutMs = Math.max(1, Math.min(PUBLISH_TIMEOUT_MS, Date.parse(c.deadline) - Date.now()));
    const made = await gh(env.CAPCOMD_GH_CLI || "gh", ["repo", "create", full, `--${input.visibility}`, "--source", input.path, "--remote", "origin", "--push"], { cwd: input.path, env, timeoutMs, signal: c.signal });
    if (made.code !== 0) {
      if (/already exists/i.test(made.err + made.out)) throw new PluginError("conflict", `${full} already exists on GitHub.`, "Choose another name.");
      const why = firstLine(made.err) || firstLine(made.out);
      throw new PluginError("unavailable", `The GitHub CLI couldn't publish ${full}: ${why || `exit ${made.code}`}.`, "Check `gh auth status`, then publish again.", true);
    }
    return { remote: `https://github.com/${full}.git`, url: `https://github.com/${full}` };
  }

  async defaultBranch(remote: string, c: SeamCall): Promise<string | null> {
    const repo = scoped().merge?.github.repo ?? githubRepoFromRemote(remote);
    if (repo) {
      try {
        const token = await (await import("../../merge/github")).githubToken();
        const r = await fetch(`${this.settings().api.replace(/\/$/, "")}/repos/${repo}`, { signal: c.signal, headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28", "user-agent": "capcomd" } });
        if (r.status === 200) { const b = (await r.json()) as { default_branch?: unknown }; if (typeof b.default_branch === "string" && b.default_branch) return b.default_branch; }
      } catch { /* no login or no answer: ask git */ }
    }
    return lsRemoteDefault(remote, c);
  }
}

/** Run the GitHub CLI without blocking: exit code, stdout, stderr (each capped); 127 when it can't start. */
function gh(cmd: string, args: string[], o: { cwd: string; env: Record<string, string | undefined>; timeoutMs: number; signal: AbortSignal }): Promise<{ code: number; out: string; err: string }> {
  return new Promise((done) => {
    let p: ReturnType<typeof spawn>;
    const env = Object.fromEntries(Object.entries({ ...o.env, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0" }).filter(([, v]) => v !== undefined)) as NodeJS.ProcessEnv;
    try { p = spawn(cmd, args, { cwd: o.cwd, env, stdio: ["ignore", "pipe", "pipe"] }); } catch (e) { return done({ code: 127, out: "", err: (e as Error).message }); }
    const out: Buffer[] = [], err: Buffer[] = [];
    let outLen = 0, errLen = 0;
    p.stdout!.on("data", (b: Buffer) => { if (outLen < 1 << 20) { out.push(b); outLen += b.length; } });
    p.stderr!.on("data", (b: Buffer) => { if (errLen < 64 << 10) { err.push(b); errLen += b.length; } });
    const kill = () => p.kill("SIGKILL");
    const t = setTimeout(kill, o.timeoutMs);
    o.signal.addEventListener("abort", kill, { once: true });
    const finish = (code: number, e?: string) => { clearTimeout(t); o.signal.removeEventListener("abort", kill); done({ code, out: Buffer.concat(out).toString("utf8"), err: e ?? Buffer.concat(err).toString("utf8") }); };
    p.on("error", (e) => finish(127, e.message));
    p.on("close", (c, sig) => finish(c ?? (sig ? 137 : 1)));
  });
}

export const manifest = {
  schema: "capcomd.plugin/v1",
  name: "forge-github",
  version: VERSION,
  description: "GitHub as the forge: lands verified work by push or by pull request, opens and finds pull requests, publishes repositories.",
  apiVersion: 1,
  engines: { capcomd: VERSION },
  entry: { runtime: "in-process", module: "./github.ts" },
  provides: ["seam:forge/github"],
  contributes: { seams: [{ kind: "forge", name: "github" }] },
  config: {
    type: "object",
    additionalProperties: false,
    properties: {
      api: { type: "string", format: "uri", default: DEFAULTS.api, description: "The REST API base when the project names none (CAPCOMD_GITHUB_API wins)" },
      pollMs: { type: "integer", minimum: 10, default: DEFAULTS.pollMs, description: "How often to look at a pull request that isn't mergeable yet (CAPCOMD_GITHUB_POLL_MS wins)" },
      timeoutMs: { type: "integer", minimum: 1000, default: DEFAULTS.timeoutMs, description: "How long to wait for a pull request to become mergeable (CAPCOMD_GITHUB_TIMEOUT_MS wins)" },
    },
  },
} satisfies PluginManifest;

export const plugin: PluginModule<GitHubForgeConfig> = definePlugin<GitHubForgeConfig>({
  activate(ctx) { ctx.seams.forge(new GitHubForge({ ...DEFAULTS, ...ctx.config.get() })); },
});
