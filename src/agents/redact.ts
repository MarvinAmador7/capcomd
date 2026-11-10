// Secret redaction for anything that may reach logs, traces, events or prompts.
// Known secret *values* (exact match) are replaced, plus well-known token shapes.
/** The token shapes the redactor replaces (src/context/scan.ts refuses text that has one). */
export const PATTERNS: readonly RegExp[] = [
  /sk-ant-[A-Za-z0-9_\-]{8,}/g,             // Anthropic API keys
  /sk-proj-[A-Za-z0-9_\-]{8,}/g,            // OpenAI project keys
  /gh[pousr]_[A-Za-z0-9]{20,}/g,            // GitHub tokens
  /eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}/g, // JWTs (ChatGPT/codex access tokens)
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /(x-access-token:)[^@\s]+(@)/g,           // tokens embedded in git URLs
  /cct1\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}/g, // ADR-017 in-VM capability tokens
];

/** Pattern-only deep redaction (no key heuristics): for agent-authored data stored by the engine. */
export function redactShapes<T>(v: T): T {
  const r = new Redactor();
  const walk = (x: any): any => typeof x === "string" ? r.text(x) : Array.isArray(x) ? x.map(walk) : x && typeof x === "object" ? Object.fromEntries(Object.entries(x).map(([k, y]) => [k, walk(y)])) : x;
  return walk(v);
}

export const REDACTED = "[REDACTED]";
/** The keys whose string value `Redactor.value` replaces whole, whatever its shape. */
export const SECRET_KEY = /api[_-]?key|token|secret|password|authorization/i;

/** A URL in text: its scheme, then up to whitespace, a quote or a bracket (or, in the callback, the next URL's scheme). */
const URL_IN_TEXT = /([a-z][a-z0-9+.-]*:\/\/)([^\s"'`<>]*)/gi;
const SCHEME = /[a-z][a-z0-9+.-]*:\/\//i;
/** A URL's query (or fragment) parameter that carries a credential: a SECRET_KEY name, a signature's or a key's. */
const SECRET_PARAM = new RegExp(`${SECRET_KEY.source}|signature|credential|key$|^(?:sig|auth|pass|passwd|pwd)$`, "i");

/**
 * Text with each URL's credentials taken out, for a URL a client is shown (a profile's `sharing.source`): its userinfo
 * (`user:password@`, or a token standing as the user) and each `name=value` (split at `&` or `;`) of its query or
 * fragment whose name, percent-decoded, says it is a credential (`token`, `access_token`, `api_key`, `privateKey`,
 * `sig`, …), with a `?` or `#` left empty dropped. A URL inside another (`https://a/b,https://u:p@c`,
 * `?url=https://u:p@c`) is taken as a URL of its own. What is left still says where it points; a credential with no
 * such place or name shows.
 */
export function withoutUrlCredentials(text: string): string {
  const named = (kv: string) => {
    if (!kv.includes("=")) return false;
    let name = kv.slice(0, kv.indexOf("="));
    try { name = decodeURIComponent(name.replace(/\+/g, " ")); } catch { /* as written */ }
    return SECRET_PARAM.test(name);
  };
  const params = (part: string) => part.split("&").map((g) => g.split(";").filter((kv) => !named(kv)).join(";")).filter(Boolean).join("&");
  return text.replace(URL_IN_TEXT, (_m, scheme: string, all: string) => {
    const next = all.search(SCHEME);
    const rest = next < 0 ? all : all.slice(0, next);
    const end = rest.search(/[/?#]/);
    const authority = end < 0 ? rest : rest.slice(0, end);
    let tail = end < 0 ? "" : rest.slice(end);
    const hash = tail.indexOf("#");
    const fragment = hash < 0 ? "" : params(tail.slice(hash + 1));
    if (hash >= 0) tail = tail.slice(0, hash);
    const q = tail.indexOf("?");
    const query = q < 0 ? "" : params(tail.slice(q + 1));
    if (q >= 0) tail = tail.slice(0, q);
    const url = `${scheme}${authority.slice(authority.lastIndexOf("@") + 1)}${tail}${query ? `?${query}` : ""}${fragment ? `#${fragment}` : ""}`;
    return next < 0 ? url : url + withoutUrlCredentials(all.slice(next));
  });
}

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
      for (const [k, x] of Object.entries(v)) o[k] = SECRET_KEY.test(k) && typeof x === "string" ? REDACTED : this.value(x);
      return o as T;
    }
    return v;
  }
  contains(s: string): boolean {
    return this.secrets.some((x) => s.includes(x)) || PATTERNS.some((p) => { p.lastIndex = 0; const r = p.test(s); p.lastIndex = 0; return r; });
  }
}
