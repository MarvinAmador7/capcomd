// forge-fake (docs/spec/plugin-api.md §7.4, §17.2 step 6): the test forge, loaded like any plugin (a host's candidate,
// or CAPCOMD_TEST_PLUGINS). It lands what the kernel hands it as the spec says a forge does: a direct land is a CAS push
// of `sha` onto the target leased at `targetSha`; a pr land opens (or finds) an in-memory pull request and merges it by
// pushing exactly `sha`, the commit the checks passed on. Idempotent by `mrgId`. Records every call and whether the
// kernel held the target's lock when it called `land`; knobs to move the target first, fail a land, or not claim PRs.
// Its branches are the remote's own (`git ls-remote`, as any forge may read them) unless a test hands it a listing, a
// failure, or failures that pass (to see the kernel retry); its login answers what a test says, per use.
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { definePlugin, PluginError, type Forge, type ForgeBranches, type ForgeLogin, type ForgeLoginUse, type LandOutcome, type LandRequest, type PullRequestRef, type SeamCall } from "../../../packages/plugin/src/index";
import { lsRemoteBranches } from "../../../src/plugins/forges/git";
import { Git } from "../../../src/merge/git";
import { lockKey } from "../../../src/merge/lock";

type Pull = PullRequestRef & { remote: string; mrgId: string | null };

export const fake = {
  /** Every `land`, with whether the target's lock file existed then (when `lockDir` is set). */
  lands: [] as Array<{ req: LandRequest; lockHeld: boolean | null }>,
  calls: [] as string[],
  pulls: [] as Pull[],
  published: [] as Array<{ path: string; owner: string | null; name: string; visibility: string; bare: string }>,
  /** Remotes `matches` claims (a prefix each); none: it is chosen only by name. */
  claims: [] as string[],
  pullRequests: true,
  /** Where the kernel keeps the target locks (`<workdir>/locks`), to check `land` runs under one. */
  lockDir: null as string | null,
  /** Runs before the next lands (each call removes nothing: clear it yourself). */
  beforeLand: null as null | ((req: LandRequest, n: number) => Promise<void>),
  /** The next land's outcome, without pushing. */
  failNext: null as LandOutcome | null,
  /** `describe().publish`: it creates repositories (POST /v1/projects/publish asks the first that does). */
  publish: true,
  /** What `listBranches` answers: null reads the remote with `git ls-remote`; an Error is thrown. */
  branches: null as ForgeBranches | Error | null,
  /** `listBranches` throws a transient error (classified `transient`) this many times first. */
  flakyBranches: 0,
  /** What `login` answers per use (the kernel must never see it reject: `loginThrows` makes it). */
  logins: { pullRequests: { ok: true, accounts: [] }, publish: { ok: true, accounts: [] } } as Record<ForgeLoginUse, ForgeLogin>,
  loginThrows: false,
  /** Every SeamCall a method got, by method (its deadline and trace), to check the kernel's wrapper. */
  seen: [] as Array<{ method: string; deadline: string; traceId: string }>,
  /** `findPullRequest` never settles and ignores its signal (the kernel must still answer `timeout`). */
  hangFind: false,
  reset() {
    Object.assign(fake, {
      lands: [], calls: [], pulls: [], published: [], claims: [], pullRequests: true, lockDir: null, beforeLand: null, failNext: null,
      publish: true, branches: null, flakyBranches: 0, logins: { pullRequests: { ok: true, accounts: [] }, publish: { ok: true, accounts: [] } }, loginThrows: false, seen: [], hangFind: false,
    });
  },
};

/** A failure the fake forge says is worth trying again. */
export class FlakyError extends Error { constructor() { super("the fake service hiccupped"); this.name = "FlakyError"; } }

const ref = (p: Pull): PullRequestRef => ({ number: p.number, url: p.url, state: p.state, head: p.head, base: p.base, mergeSha: p.mergeSha ?? null });

/** The CAS push: `sha` onto `target` only while the remote still has `targetSha` there. */
async function push(req: LandRequest, c: SeamCall): Promise<{ ok: true; already: boolean } | { ok: false; text: string }> {
  const r = await new Git(req.workdir).run(["push", "--porcelain", `--force-with-lease=refs/heads/${req.target}:${req.targetSha}`, "origin", `${req.sha}:refs/heads/${req.target}`], { signal: c.signal });
  if (r.code === 0) return { ok: true, already: r.stdout.split("\n").some((l) => l.startsWith("=")) };
  return { ok: false, text: (r.stdout + r.stderr).trim() };
}

class FakeForge implements Forge {
  describe() { return { name: "fake", label: "Fake forge", pullRequests: fake.pullRequests, publish: fake.publish }; }
  matches(remote: string) { return fake.claims.some((p) => remote.startsWith(p)); }
  classifyError(e: unknown) {
    if (e instanceof PluginError && e.code === "unsupported") return { kind: "config" as const, retryable: false as const, hint: e.message };
    if (e instanceof FlakyError) return { kind: "transient" as const, retryable: true as const, retryAfterMs: 10 };
    if (e instanceof PluginError && e.code === "unavailable") return { kind: "auth" as const, retryable: false as const, hint: e.hint ?? "Log in to the fake forge" };
    return { kind: "unknown" as const, retryable: false as const };
  }

  async land(req: LandRequest, c: SeamCall): Promise<LandOutcome> {
    fake.calls.push(`land ${req.mode}`);
    fake.lands.push({ req, lockHeld: fake.lockDir ? existsSync(join(fake.lockDir, `${lockKey(req.remote, req.target)}.lock`)) : null });
    if (req.mode === "pr" && !fake.pullRequests) throw new PluginError("unsupported", "the fake forge has no pull requests here");
    if (fake.failNext) { const f = fake.failNext; fake.failNext = null; return f; }
    if (fake.beforeLand) await fake.beforeLand(req, fake.lands.length);
    if (req.mode === "direct") {
      const r = await push(req, c);
      return r.ok ? { status: "merged", sha: req.sha, already: r.already, how: "push", pr: null } : { status: "conflict", targetSha: "", detail: r.text };
    }
    // Idempotent by mrgId: the pull request this merge already merged.
    const done = fake.pulls.find((p) => p.mrgId === req.mrgId && p.state === "merged");
    if (done) return { status: "merged", sha: done.mergeSha!, already: true, how: "pr-fake", pr: done.number };
    const pr = fake.pulls.find((p) => p.remote === req.remote && p.head === req.branch && p.base === req.target && p.state === "open")
      ?? (await this.openPullRequest({ remote: req.remote, head: req.branch, base: req.target, title: req.subject, body: req.body }, c), fake.pulls.at(-1)!);
    pr.mrgId = req.mrgId;
    const r = await push(req, c);
    if (!r.ok) return { status: "conflict", targetSha: "", detail: r.text };
    Object.assign(pr, { state: "merged", mergeSha: req.sha });
    return { status: "merged", sha: req.sha, already: false, how: "pr-fake", pr: pr.number };
  }

  async openPullRequest(input: { remote: string; head: string; base: string; title: string; body: unknown }, _c?: SeamCall): Promise<PullRequestRef> {
    fake.calls.push(`open ${input.head}->${input.base}`);
    if (!fake.pullRequests) throw new PluginError("unsupported", "the fake forge has no pull requests here");
    const open = fake.pulls.find((p) => p.remote === input.remote && p.head === input.head && p.base === input.base && p.state !== "closed");
    if (open) return ref(open);
    const p: Pull = { number: fake.pulls.length + 1, url: `fake://pull/${fake.pulls.length + 1}`, state: "open", head: input.head, base: input.base, mergeSha: null, remote: input.remote, mrgId: null };
    fake.pulls.push(p);
    return ref(p);
  }

  async findPullRequest(input: { remote: string; head: string; base: string }, c?: SeamCall): Promise<PullRequestRef | null> {
    fake.calls.push(`find ${input.head}->${input.base}`);
    if (c) fake.seen.push({ method: "findPullRequest", deadline: c.deadline, traceId: c.trace.traceId });
    if (fake.hangFind) return new Promise(() => {});
    const mine = fake.pulls.filter((p) => p.remote === input.remote && p.head === input.head && p.base === input.base);
    const pick = mine.find((p) => p.state === "merged") ?? mine.find((p) => p.state === "open");
    return pick ? ref(pick) : null;
  }

  /** A bare repository under a temp dir, added as origin and pushed to. */
  async publishRepository(input: { path: string; owner: string | null; name: string; visibility: "private" | "public" }, c: SeamCall) {
    fake.calls.push(`publish ${input.owner}/${input.name}`);
    const root = mkdtempSync(join(tmpdir(), "forge-fake-"));
    const bare = join(root, `${input.name}.git`);
    mkdirSync(bare);
    await new Git(bare).ok(["init", "-q", "--bare"]);
    const git = new Git(input.path);
    await git.ok(["remote", "add", "origin", bare]);
    const r = await git.run(["push", "-q", "-u", "origin", "HEAD"], { signal: c.signal });
    if (r.code !== 0) throw new PluginError("unavailable", `the fake forge couldn't push: ${r.stderr.trim()}`);
    fake.published.push({ ...input, bare });
    return { remote: bare, url: `fake://${input.owner}/${input.name}` };
  }

  async listBranches(input: { remote: string; cwd: string; max: number }, c: SeamCall): Promise<ForgeBranches> {
    fake.calls.push(`branches ${input.remote}`);
    fake.seen.push({ method: "listBranches", deadline: c.deadline, traceId: c.trace.traceId });
    if (fake.flakyBranches > 0) { fake.flakyBranches--; throw new FlakyError(); }
    if (fake.branches instanceof Error) throw fake.branches;
    return fake.branches ?? lsRemoteBranches(input, c);
  }

  async login(input: { use: ForgeLoginUse; accounts?: boolean }, c: SeamCall): Promise<ForgeLogin> {
    fake.calls.push(`login ${input.use}${input.accounts ? " accounts" : ""}`);
    fake.seen.push({ method: "login", deadline: c.deadline, traceId: c.trace.traceId });
    if (fake.loginThrows) throw new PluginError("unavailable", "the fake forge can't tell who you are", "Log in to the fake forge");
    return fake.logins[input.use];
  }
}

export const plugin = definePlugin({
  activate(ctx) { ctx.seams.forge(new FakeForge()); },
});
