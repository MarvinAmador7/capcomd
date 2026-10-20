// Secret redaction for anything that may reach logs, traces, events or prompts.
// Known secret *values* (exact match) are replaced, plus well-known token shapes.
const PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_\-]{8,}/g,             // Anthropic API keys
  /sk-proj-[A-Za-z0-9_\-]{8,}/g,            // OpenAI project keys
  /gh[pousr]_[A-Za-z0-9]{20,}/g,            // GitHub tokens
  /eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}/g, // JWTs (ChatGPT/codex access tokens)
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /(x-access-token:)[^@\s]+(@)/g,           // tokens embedded in git URLs
];

export const REDACTED = "[REDACTED]";

export class Redactor {
  private secrets: string[];
  constructor(secrets: Array<string | undefined | null> = []) {
    this.secrets = secrets.filter((s): s is string => !!s && s.length >= 6).sort((a, b) => b.length - a.length);
  }
  add(secret: string | undefined | null) {
    if (secret && secret.length >= 6 && !this.secrets.includes(secret)) {
      this.secrets.push(secret);
      this.secrets.sort((a, b) => b.length - a.length);
    }
  }
  text(s: string): string {
    let out = s;
    for (const secret of this.secrets) out = out.split(secret).join(REDACTED);
    for (const p of PATTERNS) out = out.replace(p, (_m, a, b) => (a !== undefined && b !== undefined && typeof a === "string" && typeof b === "string" ? `${a}${REDACTED}${b}` : REDACTED));
    return out;
  }
  /** Deep-redact any JSON-like value (strings anywhere, including object keys' values). */
  value<T>(v: T): T {
    if (typeof v === "string") return this.text(v) as unknown as T;
    if (Array.isArray(v)) return v.map((x) => this.value(x)) as unknown as T;
    if (v && typeof v === "object") {
      const o: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) o[k] = /api[_-]?key|token|secret|password|authorization/i.test(k) && typeof x === "string" ? REDACTED : this.value(x);
      return o as T;
    }
    return v;
  }
  contains(s: string): boolean {
    return this.secrets.some((x) => s.includes(x)) || PATTERNS.some((p) => { p.lastIndex = 0; const r = p.test(s); p.lastIndex = 0; return r; });
  }
}
