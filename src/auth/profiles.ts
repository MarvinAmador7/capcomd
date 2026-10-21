// Subscription auth profiles: local ledger + resolution (ADR-015 §5).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { env as envVar } from "../utils/env";
import { ENV_PREFIX } from "../env/resolve";
import { stateDir } from "../utils/home";

export type ProfileAgent = "claude-code" | "codex";
export interface AuthProfile {
  agent: ProfileAgent;
  /** Snapshot holding the login (`capcomd-auth-<agent>-<envhash>`); absent when the token lives in a boxd secret. */
  snapshot?: string;
  /** Where the credential lives: boxd host-bound secret (claude long-lived token) or inside the snapshot. */
  store: "secret" | "snapshot";
  /** claude: setup-token (CLAUDE_CODE_OAUTH_TOKEN) | codex: device-auth (~/.codex/auth.json). */
  method: "setup-token" | "device-auth";
  env: string;
  createdAt: string;
  verifiedAt?: string;
  verified?: boolean;
}
export type AuthLedger = Partial<Record<ProfileAgent, AuthProfile>>;

export const AUTH_PREFIX = "capcomd-auth-";
export const CLAUDE_TOKEN_SECRET = "CLAUDE_CODE_OAUTH_TOKEN";
export const authSnapshotName = (agent: ProfileAgent, envSnapshot: string) => `${AUTH_PREFIX}${agent === "claude-code" ? "claude" : "codex"}-${envSnapshot.replace(ENV_PREFIX, "")}`;

export function authLedgerPath(source: Record<string, string | undefined> = process.env): string {
  return envVar("AUTH_LEDGER", source) ?? join(stateDir(source), "auths.json");
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
  if (agent !== "claude-code" && agent !== "codex") return undefined;
  return readAuthLedger(authLedgerPath(source))[agent];
}
