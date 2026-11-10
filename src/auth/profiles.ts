// Subscription auth profiles: local ledger + resolution (ADR-015 §5).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { env as envVar } from "../utils/env";
import { ENV_PREFIX } from "../env/resolve";
import { stateDir } from "../utils/home";
import { providerStateFile } from "../providers/registry";

export type ProfileAgent = "claude-code" | "codex" | "fx";
/** The agent kinds with a plan login, in the order `capcomd auth status` lists them. */
export const PROFILE_AGENTS: readonly ProfileAgent[] = ["claude-code", "codex", "fx"];
export interface AuthProfile {
  agent: ProfileAgent;
  /** Snapshot holding the login (`capcomd-auth-<agent>-<envhash>`); absent when the token lives in a boxd secret. */
  snapshot?: string;
  /** Where the credential lives: boxd host-bound secret (claude long-lived token) or inside the snapshot. */
  store: "secret" | "snapshot";
  /** claude: setup-token (CLAUDE_CODE_OAUTH_TOKEN) | codex, fx's Vercel login: device-auth (~/.codex/auth.json,
   *  ~/.fx/auth.json) | fx's Grok login: browser-code (a code pasted back, ~/.fx/grok-auth.json). */
  method: "setup-token" | "device-auth" | "browser-code";
  /** Which of the provider's plan logins this is, for a provider with several (`describe().logins`; fx: vercel, grok). */
  login?: string;
  /** The env snapshot the login image was made from (agents with the login boot from it, so from this env). */
  env: string;
  createdAt: string;
  /** `capcomd env build` moved the login onto `env` from this older env snapshot (src/auth/carry.ts), and when. */
  carriedFrom?: string;
  carriedAt?: string;
  verifiedAt?: string;
  verified?: boolean;
}
export type AuthLedger = Partial<Record<ProfileAgent, AuthProfile>>;

export const AUTH_PREFIX = "capcomd-auth-";
export const CLAUDE_TOKEN_SECRET = "CLAUDE_CODE_OAUTH_TOKEN";
export const authSnapshotName = (agent: ProfileAgent, envSnapshot: string) => `${AUTH_PREFIX}${agent === "claude-code" ? "claude" : agent}-${envSnapshot.replace(ENV_PREFIX, "")}`;

export function authLedgerPath(source: Record<string, string | undefined> = process.env): string {
  return envVar("AUTH_LEDGER", source) ?? join(stateDir(source), providerStateFile("auths.json", source));
}
export function readAuthLedger(path = authLedgerPath()): AuthLedger {
  if (!existsSync(path)) return {};
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return {}; }
}
export function writeAuthLedger(l: AuthLedger, path = authLedgerPath()) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(l, null, 2) + "\n", { mode: 0o600 });
}
export function profileFor(agent: string, source: Record<string, string | undefined> = process.env): AuthProfile | undefined {
  if (!PROFILE_AGENTS.includes(agent as ProfileAgent)) return undefined;
  return readAuthLedger(authLedgerPath(source))[agent as ProfileAgent];
}
