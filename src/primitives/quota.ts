// ADR-019 §6: a provider's usage limit belongs to the login, not the agent. When one agent reports it, every agent on
// that login (in any run) would hit it too, so the engine host remembers it and new work on that login waits for the
// reset instead of failing.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { stateDir } from "../utils/home";
import { env } from "../utils/env";

export interface QuotaRecord { until: number; at: number; runId: string; agentId: string }

/** How long a pause lasts when the provider gave no reset time (then the agent tries again). */
export const quotaRetryMs = () => Number(env("QUOTA_RETRY_MS") ?? 60 * 60_000);

const file = () => env("QUOTA_LEDGER") ?? join(stateDir(), "quotas.json");
function readAll(): Record<string, QuotaRecord> {
  try { return JSON.parse(readFileSync(file(), "utf8")); } catch { return {}; }
}
function writeAll(all: Record<string, QuotaRecord>) {
  mkdirSync(dirname(file()), { recursive: true });
  const tmp = `${file()}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(all, null, 2) + "\n");
  renameSync(tmp, file());
}

/** The login an agent spends from: its provider and auth mode ("claude:subscription"); null for fake agents. */
export function loginOf(spec: unknown): string | null {
  const s = spec as { provider?: string; kind?: string; auth?: string } | null;
  const provider = s?.provider ?? s?.kind;
  return provider ? `${provider}:${s?.auth ?? "apikey"}` : null;
}

/** When the login's usage limit resets (ms epoch), or 0 when it isn't known to be limited. */
export function quotaUntil(login: string, now = Date.now()): number {
  const r = readAll()[login];
  return r && r.until > now ? r.until : 0;
}

export function recordQuota(login: string, r: QuotaRecord) {
  const all = readAll();
  if ((all[login]?.until ?? 0) >= r.until) return;
  writeAll({ ...all, [login]: r });
}

/** `resume` is the operator saying the login can work again (e.g. after an upgrade). */
export function clearQuota(login: string) {
  const all = readAll();
  if (!all[login]) return;
  delete all[login];
  writeAll(all);
}
