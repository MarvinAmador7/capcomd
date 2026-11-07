// ADR-017: capability tokens for in-VM capcomd. A token names a run, the agent it acts as
// (the root of the subtree it may touch), the ops it may call, and an expiry. It is an
// HMAC over the claims with a key that never leaves the orchestrator host, so the VM can
// present it but not forge or widen it. Revocation: the scope's `revoked` table (by jti),
// and a token dies with its agent (any terminal status).
import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";
import { env } from "../utils/env";
import { homeFile } from "../utils/home";

export const ALL_OPS = [
  "spawn", "await", "wait-any", "status", "tree", "cancel", "send", "inbox", "handoff", "events",
  "budget", "task", "kv", "verify", "merge", "inspect", "logs", "heartbeat", "result", "grant", "title", "fetch", "check",
  // Plugin API §16.2: background jobs in the agent's own machine.
  "job.start", "job.output", "job.list", "job.kill",
] as const;
export type Op = (typeof ALL_OPS)[number];

export interface Claims {
  v: 1;
  run: string;
  /** The agent this token acts as; writes are limited to its subtree. */
  sub: string;
  ops: Op[];
  /** Expiry, ms since epoch. */
  exp: number;
  jti: string;
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** The signing key's file: CAPCOMD_RPC_KEY_FILE, else rpc.key in the capcomd home like the rest of its state
 *  (~/.capcomd/rpc.key, $CAPCOMD_HOME/rpc.key, or <repo>/.relay/rpc.key in a dev checkout; src/utils/home.ts). */
export function rpcKeyFile(source: Record<string, string | undefined> = process.env): string {
  return env("RPC_KEY_FILE", source) ?? homeFile("rpc.key", source);
}

let cachedKey: Buffer | null = null;
/** Host-only signing key: CAPCOMD_RPC_KEY, else the key file (rpcKeyFile; created 0600). Read once per process. */
export function signingKey(): Buffer {
  if (cachedKey) return cachedKey;
  const fromEnv = env("RPC_KEY");
  if (fromEnv) return (cachedKey = Buffer.from(fromEnv));
  const p = rpcKeyFile();
  if (!existsSync(p)) {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, randomBytes(32).toString("hex"), { mode: 0o600 });
  }
  try { chmodSync(p, 0o600); } catch {}
  return (cachedKey = Buffer.from(readFileSync(p, "utf8").trim()));
}

export const DEFAULT_TOKEN_TTL_MS = Number(env("TOKEN_TTL_MS") ?? 30 * 60_000);

export function mint(c: Omit<Claims, "v" | "jti" | "exp"> & { ttlMs?: number; jti?: string }, key = signingKey()): { token: string; claims: Claims } {
  const claims: Claims = { v: 1, run: c.run, sub: c.sub, ops: [...c.ops], exp: Date.now() + (c.ttlMs ?? DEFAULT_TOKEN_TTL_MS), jti: c.jti ?? randomBytes(9).toString("base64url") };
  const body = b64(JSON.stringify(claims));
  const sig = b64(createHmac("sha256", key).update(`cct1.${body}`).digest());
  return { token: `cct1.${body}.${sig}`, claims };
}

export type VerifyResult = { ok: true; claims: Claims } | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

/** Signature + expiry only; revocation and agent liveness are checked against the scope. */
export function verifyToken(token: string, key = signingKey(), now = Date.now()): VerifyResult {
  const parts = String(token ?? "").trim().split(".");
  if (parts.length !== 3 || parts[0] !== "cct1") return { ok: false, reason: "malformed" };
  const want = createHmac("sha256", key).update(`cct1.${parts[1]}`).digest();
  const got = Buffer.from(parts[2]!, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return { ok: false, reason: "bad_signature" };
  let claims: Claims;
  try { claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")); } catch { return { ok: false, reason: "malformed" }; }
  if (claims.v !== 1 || typeof claims.run !== "string" || typeof claims.sub !== "string" || !Array.isArray(claims.ops)) return { ok: false, reason: "malformed" };
  if (now > claims.exp) return { ok: false, reason: "expired" };
  return { ok: true, claims };
}

/** Background jobs in the agent's own machine (plugin API §16.2). */
export const JOB_OPS: readonly Op[] = ["job.start", "job.output", "job.list", "job.kill"];
/** What an agent that may not spawn may call: name its tab, read what it sees of the tree (its own subtree and its
 *  siblings'), keep notes and coordinate (kv, task, send, inbox), report progress and declare its result (where its
 *  lessons go, ADR-025). Nothing that starts, stops, lands or pays for another agent's work. */
export const LEAF_OPS: readonly Op[] = ["title", "status", "tree", "inspect", "logs", "events", "budget", "heartbeat", "kv", "task", "inbox", "send", "result"];

/**
 * Ops an agent's token carries: everything for spawners (merge stays verify-gated, never operator), LEAF_OPS and the job
 * ops for any other. `jobs: false` (its profile lets it run no command of its own: `mayRunCommands`) leaves the job ops
 * out, so `capcomd job start` is never a way around its tool policy.
 */
export function opsFor(limits: { allowSpawn: boolean }, o: { jobs?: boolean } = {}): Op[] {
  const ops = limits.allowSpawn ? [...ALL_OPS] : [...LEAF_OPS, ...JOB_OPS];
  return o.jobs === false ? ops.filter((x) => !JOB_OPS.includes(x)) : ops;
}

/** The unrestricted shell as a tool rule: `Bash`, `Bash()`, `Bash(*)`, `Bash(:*)` (the empty prefix: every command), as
 *  src/profiles/v1.ts `readOnlyTools` reads them. */
const SHELL = /^Bash(\((:?\*)?\))?$/;
/**
 * Whether an agent's profile lets it run any command of its own: a background job runs whatever it is given, so only
 * such an agent's token has the job ops. Not when its allow-list names tools but no unrestricted shell (`Bash`,
 * `Bash(*)`, `Bash(:*)`; a reviewer's `Bash(bun test:*)` is a command, not a shell), its deny-list names the shell, or its Codex
 * sandbox is read-only. An orchestrate agent keeps them in its token: the RPC refuses its `job start` by name (plugin API
 * §16.1 item 6), and `job list` is harmless.
 */
export function mayRunCommands(spec: unknown): boolean {
  const s = (spec ?? {}) as { allowedTools?: unknown; disallowedTools?: unknown; sandbox?: unknown };
  const tools = (v: unknown) => (Array.isArray(v) ? v.map((t) => String(t).trim()) : null);
  const allowed = tools(s.allowedTools), denied = tools(s.disallowedTools);
  if (allowed?.length && !allowed.some((t) => SHELL.test(t))) return false;
  if (denied?.some((t) => SHELL.test(t))) return false;
  return s.sandbox !== "read-only";
}

/**
 * Whether a real agent's token has the job ops: its profile lets it run commands of its own (`mayRunCommands`), and so
 * does the config it runs with (src/agents/config.ts `loadAgentConfig`), which the daemon's CAPCOMD_AGENT_ALLOWED_TOOLS,
 * CAPCOMD_AGENT_DISALLOWED_TOOLS and, for a Codex agent, CAPCOMD_CODEX_SANDBOX narrow too. `effective` null (a config
 * that can't be read): none (fail closed; the run reports the config itself). An orchestrate agent's is its profile's
 * alone: its config is its provider's orchestrate policy, and the RPC refuses its `job start` by name.
 */
export function mayRunJobs(spec: unknown, effective: { allowedTools?: string[]; disallowedTools?: string[]; codexSandbox?: string } | null): boolean {
  const s = (spec ?? {}) as { toolMode?: unknown; provider?: unknown };
  if (!mayRunCommands(spec)) return false;
  if (s.toolMode === "orchestrate") return true;
  if (!effective) return false;
  return mayRunCommands({ allowedTools: effective.allowedTools, disallowedTools: effective.disallowedTools, ...(s.provider === "codex" ? { sandbox: effective.codexSandbox } : {}) });
}
