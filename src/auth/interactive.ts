// Interactive exec bridge (boxd streamExec with a PTY) + a token-redacting output filter.
export interface InteractiveSession {
  write(data: string | Uint8Array): void;
  end(): void;
  close(): void;
  resize?(cols: number, rows: number): void;
  output: AsyncIterable<Uint8Array>;
  wait(): Promise<number>;
}
export interface InteractiveExec {
  streamExec(id: string, cmd: string[], opts: { env?: Record<string, string>; tty?: boolean; cols?: number; rows?: number }): InteractiveSession;
}
export const hasInteractive = (p: unknown): p is InteractiveExec => typeof (p as any)?.streamExec === "function";

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
export const stripAnsi = (s: string) => s.replace(ANSI, "");

/**
 * Passes CLI output through to the user's terminal while capturing and masking tokens
 * (`claude setup-token` prints the token at the end). Lines whose visible text holds a token are
 * printed ANSI-stripped with the token masked; a partial line that could be the start of a token
 * is held back until it completes. Tokens never reach the terminal, logs or errors.
 */
export class TokenFilter {
  private pending = "";
  private heldSince = 0;
  readonly tokens: string[] = [];
  constructor(private patterns: RegExp[], private mask = "[token captured — hidden]") {}

  private scrub(raw: string): string {
    const plain = stripAnsi(raw);
    let hit = false;
    for (const p of this.patterns) {
      p.lastIndex = 0;
      for (const m of plain.matchAll(new RegExp(p.source, "g"))) { hit = true; if (!this.tokens.includes(m[0])) this.tokens.push(m[0]); }
    }
    if (!hit) return raw;
    let out = plain;
    for (const p of this.patterns) out = out.replace(new RegExp(p.source, "g"), this.mask);
    return out;
  }
  /** Could the tail of `s` be the beginning of a token? */
  private risky(s: string): boolean {
    const plain = stripAnsi(s);
    return /sk-?$|sk-a[n]?[t]?-?$|sk-ant-[A-Za-z0-9_\-]*$|s$/.test(plain) || /\x1b[^a-zA-Z]*$/.test(s);
  }
  /** Feed a chunk; returns what is safe to print now. */
  push(chunk: string): string {
    if (chunk && !this.pending) this.heldSince = Date.now();
    this.pending += chunk;
    const nl = this.pending.lastIndexOf("\n");
    let out = "";
    if (nl >= 0) {
      for (const line of this.pending.slice(0, nl + 1).split(/(?<=\n)/)) out += this.scrub(line);
      this.pending = this.pending.slice(nl + 1);
    }
    if (nl >= 0 && this.pending) this.heldSince = Date.now();
    const tokenish = /sk-ant-/.test(stripAnsi(this.pending));
    const stale = Date.now() - this.heldSince > 800;
    if (this.pending && !tokenish && (!this.risky(this.pending) || stale)) { out += this.pending; this.pending = ""; }
    return out;
  }
  /** Release whatever is held (scrubbed). */
  flush(): string { const s = this.scrub(this.pending); this.pending = ""; return s; }
}

export const CLAUDE_TOKEN = /sk-ant-oat\d*-[A-Za-z0-9_\-]{20,}/;
/** Shapes masked in any login output (JWT access/refresh tokens, Anthropic tokens). */
export const AUTH_SHAPES = [CLAUDE_TOKEN, /sk-ant-[A-Za-z0-9_\-]{20,}/, /eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}/];

/**
 * Bridge a session to the local terminal: stdout via TokenFilter, local stdin → session.
 * Returns the exit code and captured tokens (in memory only).
 */
export async function bridge(s: InteractiveSession, o: { patterns: RegExp[]; stdout?: (s: string) => void; stdin?: NodeJS.ReadStream | null; timeoutMs: number }): Promise<{ code: number; tokens: string[] }> {
  const f = new TokenFilter(o.patterns);
  const out = o.stdout ?? ((x: string) => process.stdout.write(x));
  const dec = new TextDecoder();
  const stdin = o.stdin === undefined ? process.stdin : o.stdin;
  const onData = (d: Buffer) => s.write(new Uint8Array(d));
  let raw = false;
  if (stdin) {
    if (stdin.isTTY) { stdin.setRawMode(true); raw = true; }
    stdin.on("data", onData); stdin.resume();
  }
  const resize = () => s.resize?.(process.stdout.columns || 200, process.stdout.rows || 40);
  if (process.stdout.isTTY) process.stdout.on("resize", resize);
  let tick: ReturnType<typeof setInterval> | undefined;
  const timer = setTimeout(() => s.close(), o.timeoutMs);
  try {
    tick = setInterval(() => { /* release a held non-token partial after a pause */ const x = f.push(""); if (x) out(x); }, 200);
    for await (const chunk of s.output) { const x = f.push(dec.decode(chunk, { stream: true })); if (x) out(x); }
    const code = await s.wait();
    out(f.flush());
    return { code, tokens: [...f.tokens] };
  } finally {
    clearTimeout(timer); if (tick) clearInterval(tick);
    if (stdin) { stdin.off("data", onData); if (raw) stdin.setRawMode(false); stdin.pause(); }
    if (process.stdout.isTTY) process.stdout.off("resize", resize);
  }
}
