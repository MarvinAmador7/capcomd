/** Minimal typed git runner. Hooks always run (we never pass --no-verify). */
export class GitError extends Error {
  constructor(readonly args: string[], readonly code: number, readonly stdout: string, readonly stderr: string) {
    super(`git ${args.join(" ")} failed (${code}): ${stderr.trim() || stdout.trim()}`);
    this.name = "GitError";
  }
}

export interface GitResult { code: number; stdout: string; stderr: string }

export class Git {
  constructor(readonly cwd: string, readonly extraEnv: Record<string, string> = {}) {}

  async run(args: string[], opts: { input?: string; env?: Record<string, string> } = {}): Promise<GitResult> {
    const proc = Bun.spawn(["git", ...args], {
      cwd: this.cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_EDITOR: "true",
        // Deterministic identity for commits capcomd itself creates, unless the repo/user configures one.
        GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? "capcomd",
        GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? "capcomd@localhost",
        GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? "capcomd",
        GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? "capcomd@localhost",
        ...this.extraEnv,
        ...opts.env,
      },
      stdin: opts.input !== undefined ? new TextEncoder().encode(opts.input) : "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  }

  /** Run and throw GitError on non-zero exit. Returns trimmed stdout. */
  async ok(args: string[], opts: { input?: string; env?: Record<string, string> } = {}): Promise<string> {
    const r = await this.run(args, opts);
    if (r.code !== 0) throw new GitError(args, r.code, r.stdout, r.stderr);
    return r.stdout.trim();
  }

  async revParse(ref: string): Promise<string | null> {
    const r = await this.run(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return r.code === 0 ? r.stdout.trim() : null;
  }

  async isAncestor(a: string, b: string): Promise<boolean> {
    return (await this.run(["merge-base", "--is-ancestor", a, b])).code === 0;
  }

  async unmergedFiles(): Promise<string[]> {
    const out = await this.run(["diff", "--name-only", "--diff-filter=U"]);
    return out.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  }
}
