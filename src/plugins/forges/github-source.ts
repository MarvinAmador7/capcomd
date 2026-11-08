// forge-github's trigger source, `github` (docs/spec/plugin-api.md §16.3.1, §16.3.6, §17.2 step 10): comments on the
// issues and pull requests of the repositories the operator names (`plugins.forge-github.sourceRepos`), and of the
// threads runs follow (`ctx.triggers.subscriptions`), become triggers. It polls on the plugin's own timer (§16.2, every
// `sourceEveryMs`, 1 min by default) with the user's GitHub login, keeps its read position per repository in
// `ctx.storage` (a restart replays nothing; the first poll of a repository only marks where it starts), drops what
// capcomd wrote itself (a comment carrying CAPCOMD_MARK: the login is usually the user's own, whose comments are theirs),
// and fills the actor and `addressed` from GitHub's facts: the comment's author, whether GitHub says it is a bot, and
// whether it addresses capcomd: a line starting with the command word (`sourceCommand`, `/capcomd`), or, with
// `sourceMentions` (a login that is capcomd's own account, not the user's), an @-mention of the login by someone else.
// A comment whose emit failed for now (the intake's `unavailable`) is read again at the next poll. What a comment asks
// for is never judged here: the kernel's intake decides (src/triggers/intake.ts). Daemon only (`ctx.jobs`,
// `ctx.triggers`).
import type { PluginContext } from "../../../packages/plugin/src/context";
import { PluginError } from "../../../packages/plugin/src/errors";
import type { Trigger } from "../../../packages/plugin/src/shapes";
import { githubAt, type GitHubApi, type IssueComment } from "./github-rest";
import { startSourceTimer } from "../sources/timer";

export interface GitHubSourceConfig { api: string; sourceRepos: string[]; sourceEveryMs: number; sourceCommand: string; sourceMentions?: boolean }
export const SOURCE_DEFAULTS = { sourceRepos: [] as string[], sourceEveryMs: 60_000, sourceCommand: "/capcomd", sourceMentions: false };
/** What a comment capcomd writes on GitHub carries (none yet: replies are a later step's), so the source never reads its
 *  own words back as a request. */
export const CAPCOMD_MARK = "<!-- capcomd -->";
export const SOURCE_TIMER = "github comments";
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
/** A thread is `owner/name#number`, the conversation's own name on GitHub. */
const THREAD = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#\d+$/;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** One comment as a trigger, or null for capcomd's own (§16.3.1: a source drops its bot's messages). `me`: a login whose
 *  @-mention addresses capcomd (null: only the command word does). */
export function commentTrigger(repo: string, c: IssueComment, me: string | null, command = SOURCE_DEFAULTS.sourceCommand): Trigger | null {
  const login = c.user?.login, body = c.body ?? "";
  if (!login || body.includes(CAPCOMD_MARK)) return null;
  const number = Number(/\/(\d+)$/.exec(c.issue_url ?? "")?.[1]);
  if (!Number.isInteger(number) || number <= 0) return null;
  const commanded = !!command.trim() && new RegExp(`^\\s*${escape(command.trim())}(?![A-Za-z0-9_-])`, "im").test(body);
  const mentioned = !!me && login.toLowerCase() !== me.toLowerCase() && new RegExp(`(^|[^A-Za-z0-9-])@${escape(me)}(?![A-Za-z0-9-])`, "i").test(body);
  const mention = commanded || mentioned;
  return {
    source: "github", id: `comment-${c.id}`, thread: `${repo}#${number}`, at: c.created_at,
    actor: { id: login, display: login, bot: c.user?.type === "Bot" || login.endsWith("[bot]") },
    addressed: mention ? "mention" : null,
    text: { text: c.body ?? "", untrusted: true, by: `github:${login}` },
    replyTo: c.html_url ?? null,
    data: { repo, number, commentId: c.id, url: c.html_url ?? null, pullRequest: /\/pull\/\d+/.test(c.html_url ?? "") },
  };
}

/** The repositories to read: the configured ones and those of the threads runs follow. */
async function reposToPoll(ctx: PluginContext<unknown>, cfg: GitHubSourceConfig): Promise<string[]> {
  const followed = (await ctx.triggers.subscriptions({ source: "github" }).catch(() => [])).map((s) => THREAD.exec(s.thread)?.[1]).filter((r): r is string => !!r);
  return [...new Set([...cfg.sourceRepos.filter((r) => REPO.test(r)), ...followed])];
}

/** One round over every repository: each new comment is emitted, oldest first. Returns how many were. */
export async function pollGitHub(ctx: PluginContext<unknown>, cfg: GitHubSourceConfig, api?: GitHubApi): Promise<number> {
  const gh = api ?? (await githubAt(cfg.api));
  if (!gh.listIssueComments) return 0;
  // The login is usually the user's own: a mention of it addresses them, not capcomd, unless the operator says so.
  const me = cfg.sourceMentions && gh.viewer ? await gh.viewer().catch(() => null) : null;
  let n = 0;
  for (const repo of await reposToPoll(ctx, cfg)) {
    const key = `github/${repo}`;
    // `retry`: a comment whose emit failed for now, read again from `since` and not taken for an old one's edit.
    // `read`: the comments updated at `since` itself that were read: GitHub's `since` includes that second, so they come
    // back at every poll, and without it each poll would hand them to the intake again (a `deduped` line each minute).
    const pos = (await ctx.storage.get("daemon", key)) as { since?: string; read?: number[]; retry?: number } | undefined;
    // The first look at a repository: comments from now on, not its history.
    if (!pos?.since) { await ctx.storage.put("daemon", key, { since: new Date().toISOString() }); continue; }
    let comments: IssueComment[];
    try { comments = await gh.listIssueComments(repo, pos.since); } catch (e) { ctx.log.warn(`github source: reading ${repo}'s comments failed`, { error: String((e as Error)?.message ?? e) }); continue; }
    const before = new Set(pos.read ?? []);
    let since = pos.since, read = new Set(before), retry: number | undefined;
    for (const c of comments) {
      if (before.has(c.id) && Date.parse(c.updated_at) === Date.parse(pos.since)) continue;
      // An edit of a comment from before the position isn't a new request.
      const t = Date.parse(c.created_at) < Date.parse(pos.since) && c.id !== pos.retry ? null : commentTrigger(repo, c, me, cfg.sourceCommand);
      if (t) {
        const again = await ctx.triggers.emit(t).then(() => { n++; return false; }, (e) => {
          ctx.log.warn(`github source: ${repo} comment ${c.id} was not taken`, { error: String((e as Error)?.message ?? e) });
          return e instanceof PluginError && e.retryable;
        });
        // The intake couldn't act now (the trigger may come again): the position stays before it, for the next poll.
        if (again) { retry = c.id; break; }
      }
      if (Date.parse(c.updated_at) > Date.parse(since)) { since = c.updated_at; read = new Set(); }
      if (Date.parse(c.updated_at) === Date.parse(since)) read.add(c.id);
    }
    const same = since === pos.since && read.size === before.size && [...read].every((id) => before.has(id));
    if (!same || retry !== pos.retry) await ctx.storage.put("daemon", key, { since, ...(read.size ? { read: [...read] } : {}), ...(retry !== undefined ? { retry } : {}) });
  }
  return n;
}

/** forge-github's `activate`: the source's timer, and a poll when it fires (one at a time; a slow one isn't doubled).
 *  Its job.changed listener is registered whatever the settings, as the manifest declares it (a declaration the code
 *  never registers is a warning at every start, §4.7). With no repositories configured it never polls (a timer left from
 *  other settings is being cancelled), and it returns at once for any other job; the built-in sandboxes listen there
 *  already, so the daemon reads background jobs' output either way (§6.6.19). */
export function startGitHubSource(ctx: PluginContext<unknown>, cfg: GitHubSourceConfig): void {
  let polling = false;
  ctx.hooks.on("job.changed", (call) => {
    const { job, change } = call.payload;
    if (job.plugin !== ctx.plugin.name || change.kind !== "fired" || job.spec.label !== SOURCE_TIMER || polling || !cfg.sourceRepos.length) return;
    polling = true;
    void pollGitHub(ctx, cfg).catch((e) => ctx.log.warn("github source: a poll failed", { error: String((e as Error)?.message ?? e) })).finally(() => { polling = false; });
  });
  void armSource(ctx, cfg);
}

/** The source's one timer: started when repositories are configured (nothing configured, no calls to GitHub; a run
 *  that follows a GitHub thread is a trigger's, which needs one first); a timer from other settings stops. */
async function armSource(ctx: PluginContext<unknown>, cfg: GitHubSourceConfig): Promise<void> {
  let keep: string | null = null;
  if (cfg.sourceRepos.length) {
    try {
      keep = (await startSourceTimer(ctx, `github-source-${cfg.sourceEveryMs}`, { kind: "timer", runId: null, owner: { plugin: true }, label: SOURCE_TIMER, everyMs: Math.max(10_000, cfg.sourceEveryMs) })).jobId;
    } catch (e) {
      if (e instanceof PluginError && e.code === "unsupported") return; // not the daemon
      ctx.log.warn("the github source's timer did not start", { error: String((e as Error)?.message ?? e) });
    }
  }
  for (const j of await ctx.jobs.list({ state: "running" }).catch(() => [])) {
    if (j.spec.kind === "timer" && j.spec.label === SOURCE_TIMER && j.jobId !== keep) await ctx.jobs.cancel(j.jobId, "the github source's settings changed").catch(() => {});
  }
}
