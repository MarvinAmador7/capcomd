// forge-github's trigger source, `github` (docs/spec/plugin-api.md §16.3.1, §16.3.6, §16.3.7, §17.2 step 10): comments
// on the issues and pull requests of the repositories the operator names (`plugins.forge-github.sourceRepos`), and on
// the threads runs follow (`ctx.triggers.subscriptions`: a goal branch's pull request once it is open), become triggers.
// It polls on the plugin's own timer (§16.2, every `sourceEveryMs`, 1 min by default; with nothing to read it calls
// nothing) with the user's GitHub login, keeps its read position per repository in `ctx.storage` (a restart replays
// nothing; the first poll of a repository only marks where it starts), drops what capcomd wrote itself (a comment
// carrying CAPCOMD_MARK, as its replies do: the login is usually the user's own, whose comments are theirs),
// and fills the actor and `addressed` from GitHub's facts: the comment's author, whether GitHub says it is a bot, and
// whether it addresses capcomd: a line starting with the command word (`sourceCommand`, `/capcomd`), or, with
// `sourceMentions` (a login that is capcomd's own account, not the user's), an @-mention of the login by someone else.
// A comment whose emit failed for now (the intake's `unavailable`) is tried again later, each wait twice the one before,
// and given up after RETRY_TRIES; it never holds back the comments after it. What a comment asks
// for is never judged here: the kernel's intake decides (src/triggers/intake.ts). Its reply path posts a run's short
// result as a comment on the thread, marked (`ctx.triggers.onReply`). Polling is the daemon's only (`ctx.jobs`,
// `ctx.triggers`).
import type { PluginContext } from "../../../packages/plugin/src/context";
import { PluginError } from "../../../packages/plugin/src/errors";
import type { Trigger } from "../../../packages/plugin/src/shapes";
import type { TriggerReply } from "../../../packages/plugin/src/shapes";
import { GitHubHttpError, githubAt, type GitHubApi, type IssueComment } from "./github-rest";
import { startSourceTimer } from "../sources/timer";

export interface GitHubSourceConfig { api: string; sourceRepos: string[]; sourceEveryMs: number; sourceCommand: string; sourceMentions?: boolean }
export const SOURCE_DEFAULTS = { sourceRepos: [] as string[], sourceEveryMs: 60_000, sourceCommand: "/capcomd", sourceMentions: false };
/** What a comment capcomd writes on GitHub carries (its replies, §16.3.7), so the source never reads its own words back
 *  as a request. */
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

/** The repositories to read, each with the threads to read in it: every thread of a configured one (null); of any other,
 *  only the threads runs follow (a goal branch's pull request is no reason to read the rest of its repository). */
async function reposToPoll(ctx: PluginContext<unknown>, cfg: GitHubSourceConfig): Promise<Map<string, Set<string> | null>> {
  const out = new Map<string, Set<string> | null>(cfg.sourceRepos.filter((r) => REPO.test(r)).map((r) => [r, null]));
  for (const s of await ctx.triggers.subscriptions({ source: "github" }).catch(() => [])) {
    const repo = THREAD.exec(s.thread)?.[1];
    if (!repo) continue;
    const threads = out.has(repo) ? out.get(repo) : new Set<string>();
    if (threads) out.set(repo, threads.add(s.thread));
  }
  return out;
}

/** How many times a comment the intake couldn't act on for now (`unavailable`) is tried before the source gives up on it,
 *  and the longest wait between two tries (they double from the poll interval). */
export const RETRY_TRIES = 8;
const RETRY_WAIT_MAX_MS = 3_600_000;
/** A repository's read position in `ctx.storage`. `since`: GitHub's `since` for the next read. `read`: the comments
 *  updated at or after `since` that were handled (GitHub's `since` includes its own second, and a comment waiting for
 *  another try holds `since` before it, so these come back at every poll, and without it each poll would hand them to the
 *  intake again: a `deduped` line each minute). `waiting`: the comments the intake couldn't act on for now, by id, with
 *  how many tries they had and when the next one is due (epoch ms). `retry`: an older position's one waiting comment. */
interface Position { since?: string; read?: number[]; waiting?: Record<string, { tries: number; next: number }>; retry?: number }

/** One round over every repository: each new comment is emitted, oldest first. Returns how many were. */
export async function pollGitHub(ctx: PluginContext<unknown>, cfg: GitHubSourceConfig, api?: GitHubApi): Promise<number> {
  const repos = await reposToPoll(ctx, cfg);
  // Nothing configured and no run following a thread: no call to GitHub (not even for the login).
  if (!repos.size) return 0;
  const gh = api ?? (await githubAt(cfg.api));
  if (!gh.listIssueComments) return 0;
  // The login is usually the user's own: a mention of it addresses them, not capcomd, unless the operator says so.
  const me = cfg.sourceMentions && gh.viewer ? await gh.viewer().catch(() => null) : null;
  let n = 0;
  for (const [repo, threads] of repos) {
    const key = `github/${repo}`;
    const pos = (await ctx.storage.get("daemon", key)) as Position | undefined;
    // The first look at a repository: comments from now on, not its history.
    if (!pos?.since) { await ctx.storage.put("daemon", key, { since: new Date().toISOString() }); continue; }
    let comments: IssueComment[];
    try { comments = await gh.listIssueComments(repo, pos.since); } catch (e) { ctx.log.warn(`github source: reading ${repo}'s comments failed`, { error: String((e as Error)?.message ?? e) }); continue; }
    const handled = new Set(pos.read ?? []);
    const before = pos.waiting ?? (pos.retry !== undefined ? { [pos.retry]: { tries: 1, next: 0 } } : {});
    const waiting: NonNullable<Position["waiting"]> = {};
    // `since` moves past each comment handled, and stops before the first one waiting for another try: from there,
    // the comments handled after it are kept in `read`, so a comment that keeps failing never holds back newer ones.
    let since = pos.since, held = false;
    const now = Date.now();
    for (const c of comments) {
      const was = before[c.id];
      if (!handled.has(c.id)) {
        if (was && was.next > now) { waiting[c.id] = was; held = true; continue; }
        // An edit of a comment from before the position isn't a new request (one waiting for another try is no edit).
        const got = Date.parse(c.created_at) < Date.parse(pos.since) && !was ? null : commentTrigger(repo, c, me, cfg.sourceCommand);
        // A comment on a thread nobody follows, in a repository only followed threads bring in, is read and passed over.
        const t = got && (!threads || threads.has(got.thread)) ? got : null;
        const again = t && await ctx.triggers.emit(t).then(() => { n++; return false; }, (e) => {
          ctx.log.warn(`github source: ${repo} comment ${c.id} was not taken`, { error: String((e as Error)?.message ?? e) });
          return e instanceof PluginError && e.retryable;
        });
        if (again) {
          // The intake couldn't act now (the trigger may come again): tried again later, each wait twice the one before.
          const tries = (was?.tries ?? 0) + 1;
          if (tries < RETRY_TRIES) {
            waiting[c.id] = { tries, next: now + Math.min(RETRY_WAIT_MAX_MS, Math.max(10_000, cfg.sourceEveryMs) * 2 ** (tries - 1)) };
            held = true;
            continue;
          }
          ctx.log.warn(`github source: gave up on ${repo} comment ${c.id} after ${tries} tries`, { url: c.html_url ?? null });
        }
        handled.add(c.id);
      }
      if (!held && Date.parse(c.updated_at) > Date.parse(since)) since = c.updated_at;
    }
    // What a later read from `since` returns again and was handled. A comment no longer in the read (deleted, or past
    // its 100) is forgotten: one that comes back is read again.
    const read = comments.filter((c) => handled.has(c.id) && Date.parse(c.updated_at) >= Date.parse(since)).map((c) => c.id);
    const next: Position = { since, ...(read.length ? { read } : {}), ...(Object.keys(waiting).length ? { waiting } : {}) };
    if (JSON.stringify(next) !== JSON.stringify({ since: pos.since, ...(pos.read?.length ? { read: pos.read } : {}), ...(pos.waiting && Object.keys(pos.waiting).length ? { waiting: pos.waiting } : {}), ...(pos.retry !== undefined ? { retry: pos.retry } : {}) })) await ctx.storage.put("daemon", key, next);
  }
  return n;
}

/** The words of a reply as a comment: the daemon's short result and the mark that makes it capcomd's own. */
export const replyBody = (text: string) => `${text}\n\n${CAPCOMD_MARK}`;

/** A reply's @-mentions as code (`@name`), which GitHub doesn't notify: the words are a planner's, which people outside
 *  capcomd can steer (a comment on a followed thread reaches it), and a reply posted with the user's login never pages
 *  anyone (§16.5 rule 1). An e-mail address is no mention. */
export const quietMentions = (text: string) => text.replace(/(^|[^A-Za-z0-9_`])@([A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\/[A-Za-z0-9_.-]+)?)/g, "$1`@$2`");

/** The source's reply path (§16.3.7): one comment on the thread the request came from (an issue's or a pull request's
 *  conversation; GitHub's comments have no replies of their own), marked so the next poll drops it. A refusal GitHub may
 *  take back (its rate limit, its own errors) is retryable; any other (no access, no such thread) is not. */
export async function replyOnGitHub(cfg: Pick<GitHubSourceConfig, "api">, r: TriggerReply, api?: GitHubApi): Promise<{ url: string | null }> {
  const m = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)$/.exec(r.thread);
  if (!m) throw new PluginError("invalid", `${r.thread} isn't a GitHub thread (owner/name#number)`);
  let gh: GitHubApi;
  try { gh = api ?? (await githubAt(cfg.api)); } catch (e) { throw new PluginError("unavailable", `no GitHub login to reply on ${r.thread}: ${(e as Error).message}`, "Log in (`gh auth login`, or GITHUB_TOKEN).", true); }
  if (!gh.createIssueComment) throw new PluginError("unsupported", "this GitHub adapter posts no comments");
  try {
    const c = await gh.createIssueComment(m[1]!, Number(m[2]), replyBody(quietMentions(r.text)));
    return { url: typeof c?.html_url === "string" ? c.html_url : null };
  } catch (e) {
    const again = e instanceof GitHubHttpError && (e.rateLimited || e.status >= 500);
    throw new PluginError(again ? "unavailable" : "invalid", `GitHub refused the reply on ${r.thread}: ${(e as Error).message}`, undefined, again);
  }
}

/** forge-github's `activate`: the source's reply path, its timer, and a poll when the timer fires (one at a time; a slow
 *  one isn't doubled). Its job.changed listener is registered whatever the settings, as the manifest declares it (a
 *  declaration the code never registers is a warning at every start, §4.7); it returns at once for any other job, and it
 *  is called only for `fired` (its manifest's `changes`), so its listening never makes the daemon read a running job's
 *  output (§6.6.19). A poll with no repository configured and no run following a GitHub thread calls nothing. */
export function startGitHubSource(ctx: PluginContext<unknown>, cfg: GitHubSourceConfig): void {
  let polling = false;
  ctx.hooks.on("job.changed", (call) => {
    const { job, change } = call.payload;
    if (job.plugin !== ctx.plugin.name || change.kind !== "fired" || job.spec.label !== SOURCE_TIMER || polling) return;
    polling = true;
    void pollGitHub(ctx, cfg).catch((e) => ctx.log.warn("github source: a poll failed", { error: String((e as Error)?.message ?? e) })).finally(() => { polling = false; });
  });
  ctx.triggers.onReply("github", (r) => replyOnGitHub(cfg, r));
  void armSource(ctx, cfg);
}

/** The source's one timer, in the daemon (a run may follow a pull request's thread whatever is configured: §16.3.6); a
 *  timer from other settings stops. */
async function armSource(ctx: PluginContext<unknown>, cfg: GitHubSourceConfig): Promise<void> {
  let keep: string | null = null;
  try {
    keep = (await startSourceTimer(ctx, `github-source-${cfg.sourceEveryMs}`, { kind: "timer", runId: null, owner: { plugin: true }, label: SOURCE_TIMER, everyMs: Math.max(10_000, cfg.sourceEveryMs) })).jobId;
  } catch (e) {
    if (e instanceof PluginError && e.code === "unsupported") return; // not the daemon
    ctx.log.warn("the github source's timer did not start", { error: String((e as Error)?.message ?? e) });
  }
  for (const j of await ctx.jobs.list({ state: "running" }).catch(() => [])) {
    if (j.spec.kind === "timer" && j.spec.label === SOURCE_TIMER && j.jobId !== keep) await ctx.jobs.cancel(j.jobId, "the github source's settings changed").catch(() => {});
  }
}
