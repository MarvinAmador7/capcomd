/** Minimal typed git runner. Hooks always run (we never pass --no-verify). */
export class GitError extends Error {
  constructor(readonly args: string[], readonly code: number, readonly stdout: string, readonly stderr: string) {
    super(`git ${args.join(" ")} failed (${code}): ${stderr.trim() || stdout.trim()}`);
    this.name = "GitError";
  }
}

export interface GitResult { code: number; stdout: string; stderr: string; timedOut?: boolean; stalled?: boolean }

export interface GitRunOptions {
  input?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Kill it when its stderr (git's `--progress` output) has been quiet this long: a stall, not a slow transfer. */
  stallMs?: number;
  /** Each progress line git writes to stderr (`Receiving objects:  45% (…), 212.00 MiB | 1.20 MiB/s`), as it comes. */
  onProgress?: (line: string) => void;
}

/** stderr read as it comes: every chunk is activity, and its last line is git's latest progress. All of it is kept. */
async function watchedText(stream: ReadableStream<Uint8Array>, onChunk: (lastLine: string) => void): Promise<string> {
  const dec = new TextDecoder();
  let text = "";
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    const part = dec.decode(chunk, { stream: true });
    text += part;
    onChunk(part.split(/[\r\n]/).map((l) => l.trim()).filter(Boolean).at(-1) ?? "");
  }
  return text + dec.decode();
}

export class Git {
  constructor(readonly cwd: string, readonly extraEnv: Record<string, string> = {}) {}

  /**
   * `timeoutMs` (default: none) bounds a call that can hang on the network: git runs in its own process group, and at
   * the deadline the whole group (git, ssh, a remote helper) is killed and the result is `{ code: 124, timedOut: true }`.
   * An aborted `signal` (a seam call's, docs/spec/plugin-api.md §7.1) ends it the same way, and so does `stallMs` of
   * silence on stderr (`stalled: true` too): a fetch run with `--progress` writes there while objects arrive, so a big
   * one that is slow but moving runs on, up to `timeoutMs`.
   */
  async run(args: string[], opts: GitRunOptions = {}): Promise<GitResult> {
    const bounded = !!opts.timeoutMs || !!opts.signal || !!opts.stallMs;
    if (opts.signal?.aborted) return { code: 124, stdout: "", stderr: `git ${args[0]} was cancelled`, timedOut: true };
    const proc = Bun.spawn(["git", ...args], {
      ...(bounded ? { detached: true } : {}),
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
    let timer: ReturnType<typeof setTimeout> | undefined, stall: ReturnType<typeof setTimeout> | undefined;
    let fired: "timeout" | "abort" | "stall" | null = null, onAbort = () => {}, kill = (_why: "timeout" | "abort" | "stall") => {};
    const poke = () => {
      if (!opts.stallMs || fired) return;
      clearTimeout(stall);
      stall = setTimeout(() => kill("stall"), opts.stallMs);
    };
    const watched = !!opts.stallMs || !!opts.onProgress;
    const done = Promise.all([
      new Response(proc.stdout).text(),
      watched ? watchedText(proc.stderr, (line) => { poke(); if (line) opts.onProgress?.(line); }) : new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (!bounded) {
      const [stdout, stderr, code] = await done;
      return { code, stdout, stderr };
    }
    const expired = new Promise<null>((resolve) => {
      kill = (why) => {
        if (fired) return;
        fired = why;
        try { process.kill(-proc.pid, "SIGKILL"); } catch { proc.kill("SIGKILL"); }
        // Don't wait for the pipes: a grandchild outside the group could still hold them open.
        proc.exited.then(() => resolve(null), () => resolve(null));
      };
      if (opts.timeoutMs) timer = setTimeout(() => kill("timeout"), opts.timeoutMs);
      onAbort = () => kill("abort");
      opts.signal?.addEventListener("abort", onAbort, { once: true });
    });
    poke();
    done.catch(() => {});
    try {
      const r = await Promise.race([done, expired]);
      if (!r || fired) {
        const why = fired === "abort" ? `git ${args[0]} was cancelled` : fired === "stall" ? `git ${args[0]} made no progress for ${Math.round(opts.stallMs! / 1000)} s` : `git ${args[0]} timed out after ${opts.timeoutMs} ms`;
        return { code: 124, stdout: "", stderr: why, timedOut: true, ...(fired === "stall" ? { stalled: true } : {}) };
      }
      const [stdout, stderr, code] = r;
      return { code, stdout, stderr };
    } finally {
      clearTimeout(timer);
      clearTimeout(stall);
      opts.signal?.removeEventListener("abort", onAbort);
    }
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
