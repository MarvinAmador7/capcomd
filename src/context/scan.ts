// The context layer's secret scan (ADR-025 §8, "secrets copied into a lesson"): what decides that a candidate lesson
// (capture, ./capture.ts) or an item under .capcomd/context/ (lint, ./lint.ts) holds a secret. It refuses, it never
// redacts: a redacted lesson can still hold a shorter secret (a prefix, a piece the redactor didn't recognise), and a
// layer every later agent reads is the wrong place to find out. It is seeded with every secret value the kernel put in
// the run (`runSecrets`), then checks the redactor's token shapes and a few more, long random-looking strings and the
// paths where credentials are kept. What it says is in the kernel's words, never the text it matched.
import { existsSync, readFileSync } from "fs";
import { PATTERNS } from "../agents/redact";

export type ScanReason = "secret" | "token" | "entropy" | "path";
export interface ScanHit { reason: ScanReason; what: string }

const WHAT: Record<ScanReason, string> = {
  secret: "a secret value of the run",
  token: "something shaped like a credential (an API key, a token, a private key)",
  entropy: "a long random-looking string that may be a credential",
  path: "a path where credentials are kept (.env*, *.pem, secrets/, ~/.aws, ~/.ssh)",
};

/** Credential shapes besides the redactor's (src/agents/redact.ts). */
const SHAPES: readonly RegExp[] = [
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,                       // AWS access key ids
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/,          // a private key
  /\bxox[abeoprs]-[A-Za-z0-9-]{10,}/,                    // Slack tokens
  /\bbxds?_[A-Za-z0-9_-]{16,}/,                          // boxd keys
  /\bAIza[0-9A-Za-z_-]{35}/,                             // Google API keys
  /\b[rs]k_live_[0-9A-Za-z]{16,}/,                       // Stripe live keys
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i,        // a URL with a password in it
];

/** Where credentials are kept (ADR-025 §8's denylist: `.env*`, `*.pem`, `secrets/`, `~/.aws`, and their kin). */
const PATHS: readonly RegExp[] = [
  /(?:^|[^\w.$-])\.env[\w.-]*/,                          // .env, .env.local (not process.env)
  /\b[\w.-]+\.(?:pem|p12|pfx|jks|keystore)\b/i,
  /\bid_(?:rsa|dsa|ecdsa|ed25519)\b/,
  /(?:^|[^\w.-])secrets\//i,
  /~\/\.(?:aws|ssh|gnupg)\b|\.aws\/credentials\b|(?:^|[^\w-])\.ssh\/|\.netrc\b|\.git-credentials\b/,
];

/** Shannon entropy of `s`, in bits per character. */
function entropy(s: string): number {
  const n = new Map<string, number>();
  for (const c of s) n.set(c, (n.get(c) ?? 0) + 1);
  let h = 0;
  for (const k of n.values()) { const p = k / s.length; h -= p * Math.log2(p); }
  return h;
}

/** A word that looks like a generated key: long, digits and both cases (so neither a commit id nor an identifier), and
 *  close to random (a 32-character base62 key has about 4.6 bits a character, English and code names under 4). */
const randomLooking = (w: string) => w.length >= 32 && /\d/.test(w) && /[a-z]/.test(w) && /[A-Z]/.test(w) && entropy(w) >= 4.3;

/** The text as the scan reads it: invisible format characters dropped, so nothing hides behind one, and look-alikes
 *  folded (NFKC: full-width letters and digits, no-break spaces; every dash a hyphen), so none passes for another. */
const plain = (t: string) => String(t ?? "").replace(/\p{Cf}+/gu, "").normalize("NFKC").replace(/\p{Pd}/gu, "-");

/**
 * A scan seeded with `secrets` (values shorter than 8 characters are ignored: they would match too much): `scan(text)`
 * is the first thing it finds, or null. The order is the reason's: a run's secret, a credential's shape, a random-looking
 * string, a credentials path.
 */
export function secretScan(secrets: ReadonlyArray<string | null | undefined> = []): (text: string) => ScanHit | null {
  const seeded = [...new Set(secrets.filter((s): s is string => typeof s === "string").map((s) => plain(s).trim()).filter((s) => s.length >= 8))];
  const hit = (reason: ScanReason): ScanHit => ({ reason, what: WHAT[reason] });
  return (text: string) => {
    const t = plain(text);
    if (seeded.some((s) => t.includes(s))) return hit("secret");
    if (PATTERNS.some((p) => t.search(p) >= 0) || SHAPES.some((p) => p.test(t))) return hit("token");
    if (t.split(/[^A-Za-z0-9+_=-]+/).some(randomLooking)) return hit("entropy");
    if (PATHS.some((p) => p.test(t))) return hit("path");
    return null;
  };
}

/** Variables that hold a credential by their name: GITHUB_TOKEN, OPENAI_API_KEY, AWS_SECRET_ACCESS_KEY, … */
const SECRET_NAME = /(?:^|_)(?:API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)(?:_|$)/i;
/** A value that can be a secret: not a number, a flag or a path (CAPCOMD_TOKEN_TTL_MS is named like one). */
const valueOf = (v: unknown): string | null => {
  const s = typeof v === "string" ? v.trim() : "";
  return s.length >= 8 && !/^[\d.:_-]+$/.test(s) && !/^(?:true|false|yes|no|on|off)$/i.test(s) && !s.startsWith("/") && !s.startsWith("~") ? s : null;
};

/**
 * Every secret value the kernel puts in run `runId` (ADR-025 §8), as this process holds them: the agent providers'
 * credentials, the plugins' secrets (§10.3), every variable named like a credential in the run's environment (this
 * process's, with the run's recorded settings on top), the key that signs in-VM tokens, and the forge's credential for
 * the run's repository (`remote`). Values only: what the scan is seeded with, never printed.
 */
export async function runSecrets(o: { runId?: string | null; remote?: string | null } = {}): Promise<string[]> {
  const { runEnv } = await import("../merge/run-config");
  const source = await runEnv(o.runId ?? undefined);
  const out = new Set<string>();
  const add = (v: unknown) => { const s = valueOf(v); if (s) out.add(s); };
  const { agentSeams } = await import("../plugins/agents");
  for (const s of agentSeams()) add(source[s.describe().secretName]);
  const { BUILTINS } = await import("../plugins/builtins");
  const { secretOrUndefined } = await import("../plugins/secrets");
  for (const b of BUILTINS) {
    const m = b.manifest as { name: string; config?: { properties?: Record<string, { "x-secret"?: unknown } | undefined> } };
    for (const [k, p] of Object.entries(m.config?.properties ?? {})) if (p?.["x-secret"] === true) add(secretOrUndefined(m, k, source));
  }
  for (const [k, v] of Object.entries(source)) if (SECRET_NAME.test(k)) add(v);
  add(source.CAPCOMD_RPC_KEY);
  try {
    const { rpcKeyFile } = await import("../subagents/token");
    const f = rpcKeyFile(source);
    if (existsSync(f)) add(readFileSync(f, "utf8"));
  } catch { /* no key file: no tokens were signed here */ }
  if (o.remote) {
    const { remoteCredentialFor } = await import("../plugins/forges");
    add((await remoteCredentialFor(o.remote, 5_000).catch(() => null))?.password);
  }
  return [...out];
}
