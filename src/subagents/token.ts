// ADR-017: capability tokens for in-VM capcomd. A token names a run, the agent it acts as
// (the root of the subtree it may touch), the ops it may call, and an expiry. It is an
// HMAC over the claims with a key that never leaves the orchestrator host, so the VM can
// present it but not forge or widen it. Revocation: the scope's `revoked` table (by jti),
// and a token dies with its agent (any terminal status).
import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { env } from "../utils/env";

export const ALL_OPS = [
  "spawn", "await", "wait-any", "status", "tree", "cancel", "send", "inbox", "handoff", "events",
  "budget", "task", "kv", "verify", "merge", "inspect", "logs", "heartbeat", "result",
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

let cachedKey: Buffer | null = null;
/** Host-only signing key: CAPCOMD_RPC_KEY, else ~/.capcomd/rpc.key (created 0600). */
export function signingKey(): Buffer {
  if (cachedKey) return cachedKey;
  const fromEnv = env("RPC_KEY");
  if (fromEnv) return (cachedKey = Buffer.from(fromEnv));
  const p = env("RPC_KEY_FILE") ?? join(homedir(), ".capcomd", "rpc.key");
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

/** Ops an agent's token carries: everything for spawners (merge stays verify-gated, never operator). */
export function opsFor(limits: { allowSpawn: boolean }): Op[] {
  return limits.allowSpawn ? [...ALL_OPS] : ["status", "heartbeat", "kv", "task", "inbox", "send", "result"];
}
