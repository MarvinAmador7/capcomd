/** Minimal typed git runner. A host repo's (src/merge/host-git.ts `hostGit`) runs under its GitPolicy: no hooks, no
 *  filters, and for local work none of the user's own git settings, since its commits may be a sandbox's. */
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
  /** Standard input as a stream (a file read a chunk at a time, never whole in memory). `input` wins. */
  stdin?: ReadableStream<Uint8Array>;
  /** A command that talks to a remote (host-git.ts remoteGit, lsRemote): a GitPolicy keeps the user's own settings for
   *  it (their credential helper, ssh, proxies). */
  network?: boolean;
}

/**
 * How a host repo's git runs (src/merge/host-git.ts owns it): `args` go before the subcommand (`-c` settings, which
 * beat every config file and GIT_CONFIG_COUNT), `inherit` filters the environment this process passes on, and `env` is
 * set last, over the caller's.
 */
export interface GitPolicy {
  args(network: boolean): string[];
  inherit(env: Record<string, string | undefined>, network: boolean): Record<string, string | undefined>;
  env(network: boolean): Record<string, string>;
}

/** stderr read as it comes: every chunk is activity, and each line in it (git ends a progress update with \r) is heard.
 *  All of it is kept. */
async function watchedText(stream: ReadableStream<Uint8Array>, onChunk: (lines: string[]) => void): Promise<string> {
  const dec = new TextDecoder();
  let text = "";
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    const part = dec.decode(chunk, { stream: true });
    text += part;
    onChunk(part.split(/[\r\n]/).map((l) => l.trim()).filter(Boolean));
  }
  return text + dec.decode();
}

export class Git {
  constructor(readonly cwd: string, readonly extraEnv: Record<string, string> = {}, readonly policy?: GitPolicy) {}

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
    const net = !!opts.network;
    const env: Record<string, string | undefined> = {
      ...(this.policy ? this.policy.inherit(process.env, net) : process.env),
      GIT_TERMINAL_PROMPT: "0",
      GIT_EDITOR: "true",
      // Deterministic identity for commits capcomd itself creates (the environment beats any git config).
      GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? "capcomd",
      GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? "capcomd@localhost",
      GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? "capcomd",
      GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? "capcomd@localhost",
      ...this.extraEnv,
      ...opts.env,
      ...(this.policy?.env(net) ?? {}),
    };
    for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
    const proc = Bun.spawn(["git", ...(this.policy?.args(net) ?? []), ...args], {
      ...(bounded ? { detached: true } : {}),
      cwd: this.cwd,
      env: env as Record<string, string>,
      stdin: opts.input !== undefined ? new TextEncoder().encode(opts.input) : opts.stdin ?? "ignore",
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
      watched ? watchedText(proc.stderr, (lines) => { poke(); for (const l of lines) opts.onProgress?.(l); }) : new Response(proc.stderr).text(),
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
  async ok(args: string[], opts: Pick<GitRunOptions, "input" | "env" | "network"> = {}): Promise<string> {
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
