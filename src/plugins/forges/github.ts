// forge-github (docs/spec/plugin-api.md §15.2, §17.1): GitHub as the forge. What src/merge/pr.ts did once the work was
// integrated and checked (find or open the pull request, merge it at the checked head, hand it to auto-merge and wait),
// the pull requests of a run's goal branch (POST /v1/runs/{runId}/pull-request, capcomd_pr_open, `capcomd pr open`),
// `gh repo create` for POST /v1/projects/publish, a remote's branches and default branch (the GitHub API with the
// user's own login, else `git ls-remote`), and whether that login is on this machine (`gh auth status` for the GitHub
// CLI, a token for the API; `gh api user` for who it is), and that token as the credential for the kernel's host git
// over https to github.com (`remoteCredential`). A direct land is the same CAS push as forge-git's. The REST
// adapter is ./github-rest.ts (tests inject a fake one with setGitHubApi); the project's settings (CAPCOMD_GITHUB_API,
// _POLL_MS, _TIMEOUT_MS, _REPO) and the caller's environment (CAPCOMD_GH_CLI, GITHUB_TOKEN) reach it through the
// kernel's forge scope.
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { definePlugin, type PluginModule } from "../../../packages/plugin/src/context";
import { PluginError } from "../../../packages/plugin/src/errors";
import type { PluginManifest } from "../../../packages/plugin/src/manifest";
import type { ErrorClass, Forge, ForgeAccount, ForgeBranches, ForgeLogin, ForgeLoginUse, ForgeRemoteCredential, LandOutcome, LandRequest, PullRequestRef, SeamCall } from "../../../packages/plugin/src/seams";
import type { Untrusted } from "../../../packages/plugin/src/shapes";
import { githubRepoFromRemote } from "../../merge/config";
import { GitHubHttpError, githubAt, hasGitHubOverride, type GitHubApi, type PullRequest } from "./github-rest";
import { killpoint } from "../../utils/killpoint";
import { VERSION } from "../../utils/self";
import { casPush, lsRemoteBranches, readMs } from "./git";
import { scoped, scopedEnv } from "./scope";
import { SOURCE_DEFAULTS, startGitHubSource, type GitHubSourceConfig } from "./github-source";

type Env = Record<string, string | undefined>;

export interface GitHubForgeConfig { api: string; pollMs: number; timeoutMs: number }
const DEFAULTS: GitHubForgeConfig = { api: "https://api.github.com", pollMs: 5000, timeoutMs: 30 * 60_000 };
/** How many more times a merge call GitHub failed with a 5xx is made (each after a poll interval and a fresh look). */
const MERGE_5XX_RETRIES = 3;
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

  describe() { return { name: "github", label: "GitHub", pullRequests: true, publish: true }; }
  matches(remote: string) { return githubRepoFromRemote(remote) !== null; }
  classifyError(e: unknown): ErrorClass {
    if (e instanceof GitHubHttpError) {
      if (e.rateLimited) return { kind: "quota", retryable: true, retryAfterMs: 60_000, hint: "GitHub rate limit; the merge retries in a minute." };
      if (e.status === 401 || e.status === 403) return { kind: "auth", retryable: false, hint: "Set GITHUB_TOKEN or run `gh auth login`." };
      if (e.status === 404) return { kind: "not_found", retryable: false };
      if (e.status >= 500) return { kind: "transient", retryable: true };
    }
    if (e instanceof PluginError) {
      if (e.code === "unavailable") return { kind: "auth", retryable: false, hint: e.hint ?? "Run `gh auth login` (or set GITHUB_TOKEN)." };
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
    catch (e) { throw new PluginError("unavailable", (e as Error).message, "Run `gh auth login` (or set GITHUB_TOKEN)."); }
  }
  private ref(p: PullRequest, repo: string, input: { head: string; base: string }): PullRequestRef {
    const web = this.settings().api.replace(/\/$/, "") === "https://api.github.com" ? `https://github.com/${repo}/pull/${p.number}` : null;
    // Its conversation is the github source's thread owner/name#number (./github-source.ts).
    return { number: p.number, url: p.html_url ?? web, state: p.merged ? "merged" : p.state, head: p.head?.ref ?? input.head, base: p.base?.ref ?? input.base, mergeSha: p.merge_commit_sha ?? null, thread: { source: "github", thread: `${repo}#${p.number}` } };
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
    let res = await merge(), tries = 1;
    // GitHub's own failure (a 5xx, often with no body; seen live as a bare 500): the merge may have happened all the
    // same. Look at the pull request again, then ask again, a few times before calling it failed.
    for (; !res.merged && res.status >= 500 && tries <= MERGE_5XX_RETRIES && !c.signal.aborted; tries++) {
      await sleep(s.pollMs, c.signal);
      if (c.signal.aborted) break;
      const now = await gh.getPull(repo, pr.number).catch(() => null);
      if (now?.merged && now.merge_commit_sha) return { status: "merged", sha: now.merge_commit_sha, already: false, how: `pr-${req.strategy}`, pr: now.number };
      if (now) pr = now;
      res = await merge();
    }
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
    } else if (!res.merged && res.status >= 500) {
      return { status: "failed", reason: `GitHub failed to merge PR #${pr.number} (${res.status}, ${tries} ${tries === 1 ? "try" : "tries"})${res.message ? `: ${res.message}` : ""}; merge again later`, retryable: false };
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

  /**
   * GitHub first (owner/name named outright, the project's CAPCOMD_GITHUB_REPO, or the remote's; with the user's own
   * login: GITHUB_TOKEN, GH_TOKEN or `gh auth token`): the default branch and every page of branches. Else, or when
   * GitHub doesn't answer, `git ls-remote`, with the reason in `note`. Neither: rejected with both reasons.
   */
  async listBranches(input: { remote: string; cwd: string; max: number }, c: SeamCall): Promise<ForgeBranches> {
    const s = scoped();
    const repo = s.repo ?? s.merge?.github.repo ?? githubRepoFromRemote(input.remote);
    const notes: string[] = [];
    if (repo) {
      const login = await (s.stubs?.login ?? (() => this.apiLogin(scopedEnv())))()?.catch(() => null);
      if (login) {
        try { return { ...(await fromGitHub(repo, login, input.max, s.stubs?.fetch ?? fetch, c)), source: "service", note: null }; }
        catch (e) { notes.push(`GitHub: ${(e as Error).message}`); }
      } else notes.push("GitHub: no login (GITHUB_TOKEN, GH_TOKEN or `gh auth login`)");
    }
    try { return { ...(await lsRemoteBranches(input, c)), note: notes.join("; ") || null }; }
    catch (e) { throw new PluginError("unavailable", [...notes, (e as Error).message].join("; "), undefined, true); }
  }

  /**
   * For git over https to github.com (§11.7): the user's token (GITHUB_TOKEN, GH_TOKEN or `gh auth token`) as the
   * password for https://github.com. null for any other remote (ssh, another host, a URL with a user in it) or without a
   * token. The kernel's host git applies it; nothing here runs git.
   */
  async remoteCredential(input: { remote: string }, _c: SeamCall): Promise<ForgeRemoteCredential | null> {
    if (!/^https:\/\/github\.com\//i.test(input.remote.trim())) return null;
    const token = await userToken(scopedEnv());
    return token ? { origin: "https://github.com", username: "x-access-token", password: token } : null;
  }

  /** The API (CAPCOMD_GITHUB_API, the project's when the kernel gave it) and the user's token for it; null without one. */
  private async apiLogin(env: Env): Promise<{ api: string; token: string } | null> {
    const api = scoped().merge?.github.api ?? env.CAPCOMD_GITHUB_API ?? env.RELAY_GITHUB_API ?? this.cfg.api;
    const token = await userToken(env);
    return token ? { api, token } : null;
  }

  /**
   * pullRequests: a token for the API (GITHUB_TOKEN, GH_TOKEN or `gh auth token`; a test's injected API needs none).
   * publish: the GitHub CLI logged in (`gh auth status`, which `gh repo create` needs); with `accounts`, who it is and
   * its organizations (`gh api user`, `gh api user/orgs`). Each asked at most every 30 s per gh binary.
   */
  async login(input: { use: ForgeLoginUse; accounts?: boolean }, _c: SeamCall): Promise<ForgeLogin> {
    const env = scopedEnv();
    if (input.use === "pullRequests") {
      if (hasGitHubOverride() || (await userToken(env))) return { ok: true, accounts: [] };
      return { ok: false, reason: "there is no GitHub login on this machine", fix: "run `gh auth login` (or set GITHUB_TOKEN)" };
    }
    if (input.accounts) {
      const accounts = await ghAccounts(env).catch(() => null);
      if (accounts) return { ok: true, accounts };
    } else if (await ghAuthStatus(env)) return { ok: true, accounts: [] };
    return { ok: false, reason: "the GitHub CLI isn't logged in on this machine", fix: "run `gh auth login` in Terminal" };
  }
}

/** GitHub: the repository's default branch and its branches (up to `max`, 100 per page). Throws on any failure. */
async function fromGitHub(repo: string, login: { api: string; token: string }, max: number, f: typeof fetch, c: SeamCall) {
  const api = login.api.replace(/\/$/, "");
  const headers = { accept: "application/vnd.github+json", authorization: `Bearer ${login.token}`, "x-github-api-version": "2022-11-28", "user-agent": "capcomd" };
  const get = async (path: string) => {
    const r = await f(`${api}${path}`, { headers, signal: AbortSignal.any([c.signal, AbortSignal.timeout(readMs(c))]) });
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
  return { defaultBranch: typeof info?.default_branch === "string" && info.default_branch ? info.default_branch : null, branches: [...new Set(branches)].sort().slice(0, max) };
}

// ---- the user's own login (asked at most every 30 s per gh binary) ----
const LOGIN_TTL_MS = 30_000;
const ghBin = (env: Env) => env.CAPCOMD_GH_CLI || "gh";
const cache = new Map<string, { at: number; result: Promise<unknown> }>();
function cached<T>(key: string, make: () => Promise<T>, keepFailures = true): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < LOGIN_TTL_MS) return hit.result as Promise<T>;
  const result = make();
  cache.set(key, { at: Date.now(), result });
  if (!keepFailures) result.catch(() => cache.delete(key));
  return result;
}
/** Forget what was asked (tests). */
export function resetGitHubLogins() { cache.clear(); }
const never = new AbortController().signal;

/** The user's API token: GITHUB_TOKEN or GH_TOKEN, else `gh auth token` (within 5 s); null without one. Never logged. */
async function userToken(env: Env): Promise<string | null> {
  const t = env.GITHUB_TOKEN ?? env.GH_TOKEN;
  if (t) return t;
  const bin = ghBin(env);
  return cached(`token:${bin}`, async () => {
    const r = await gh(bin, ["auth", "token"], { cwd: homedir(), env, timeoutMs: 5_000, signal: never });
    const out = r.out.trim();
    return r.code === 0 && out ? out : null;
  });
}

/** `gh auth status` exits 0 within 5 s. */
function ghAuthStatus(env: Env): Promise<boolean> {
  const bin = ghBin(env);
  return cached(`status:${bin}`, async () => (await gh(bin, ["auth", "status"], { cwd: homedir(), env, timeoutMs: 5_000, signal: never })).code === 0);
}

/** The gh user, then the organizations they belong to (`gh api user`, `gh api user/orgs`). A failure isn't kept. */
function ghAccounts(env: Env): Promise<ForgeAccount[]> {
  const bin = ghBin(env);
  return cached(`accounts:${bin}`, async () => {
    const u = await gh(bin, ["api", "user"], { cwd: homedir(), env, timeoutMs: 10_000, signal: never });
    if (u.code !== 0) throw new Error(firstLine(u.err) || "gh api user failed");
    const login = String(JSON.parse(u.out)?.login ?? "");
    if (!login) throw new Error("gh api user named no login");
    const o = await gh(bin, ["api", "user/orgs"], { cwd: homedir(), env, timeoutMs: 10_000, signal: never });
    let orgs: string[] = [];
    try { orgs = o.code === 0 ? (JSON.parse(o.out) as Array<{ login?: unknown }>).map((x) => String(x?.login ?? "")).filter(Boolean) : []; } catch { /* none */ }
    return [{ login, kind: "user" as const }, ...[...new Set(orgs)].filter((x) => x !== login).map((x) => ({ login: x, kind: "org" as const }))];
  }, false);
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
  provides: ["seam:forge/github", "source:github"],
  // The source's timer and its triggers (./github-source.ts).
  scopes: ["read", "steer"],
  contributes: {
    seams: [{ kind: "forge", name: "github" }],
    sources: [{ name: "github", summary: "Comments on the issues and pull requests of sourceRepos, and of the threads runs follow (thread owner/name#number)" }],
    hooks: { "job.changed": { changes: ["fired"] } },
  },
  config: {
    type: "object",
    additionalProperties: false,
    properties: {
      api: { type: "string", format: "uri", default: DEFAULTS.api, description: "The REST API base when the project names none (CAPCOMD_GITHUB_API wins)" },
      pollMs: { type: "integer", minimum: 10, default: DEFAULTS.pollMs, description: "How often to look at a pull request that isn't mergeable yet (CAPCOMD_GITHUB_POLL_MS wins)" },
      timeoutMs: { type: "integer", minimum: 1000, default: DEFAULTS.timeoutMs, description: "How long to wait for a pull request to become mergeable (CAPCOMD_GITHUB_TIMEOUT_MS wins)" },
      sourceRepos: { type: "array", items: { type: "string", pattern: "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$" }, default: SOURCE_DEFAULTS.sourceRepos, description: "The trigger source github: owner/name repositories whose issue and pull-request comments are triggers (none: the source reads nothing)" },
      sourceEveryMs: { type: "integer", minimum: 10000, default: SOURCE_DEFAULTS.sourceEveryMs, description: "How often the source reads new comments" },
      sourceCommand: { type: "string", default: SOURCE_DEFAULTS.sourceCommand, description: "A comment line starting with this addresses capcomd" },
      sourceMentions: { type: "boolean", default: SOURCE_DEFAULTS.sourceMentions, description: "An @-mention of the GitHub login, by someone else, addresses capcomd too. Only for a login that is capcomd's own account: a mention of your own login addresses you" },
    },
  },
} satisfies PluginManifest;

export const plugin: PluginModule<GitHubForgeConfig & Partial<GitHubSourceConfig>> = definePlugin<GitHubForgeConfig & Partial<GitHubSourceConfig>>({
  activate(ctx) {
    const cfg = { ...DEFAULTS, ...SOURCE_DEFAULTS, ...ctx.config.get() };
    ctx.seams.forge(new GitHubForge(cfg));
    startGitHubSource(ctx, {
      api: process.env.CAPCOMD_GITHUB_API ?? cfg.api, sourceRepos: Array.isArray(cfg.sourceRepos) ? cfg.sourceRepos : [], sourceEveryMs: cfg.sourceEveryMs,
      sourceCommand: typeof cfg.sourceCommand === "string" ? cfg.sourceCommand : SOURCE_DEFAULTS.sourceCommand, sourceMentions: cfg.sourceMentions === true,
    });
  },
});
