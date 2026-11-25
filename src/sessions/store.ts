// ADR-026 §2: an agent's CLI session, kept beyond its machine. The runner copies the session file out as it grows
// (src/agents/session-sync.ts) into the session stores: always the host's (`stateDir()/sessions/<run>/<agent>/`, the
// source of truth), and the replica the user chose (`sessions.replica` in ~/.capcomd/config.json, or
// CAPCOMD_SESSIONS_REPLICA: `icloud-drive`; none by default), which gets every object after the host has it and is
// read only when the host has nothing (recovery on another Mac). restoreSession (src/sessions/restore.ts) puts a saved
// session back into a fresh machine.
//
// The objects of one agent, by key (packages/plugin/src/session-store.ts):
//   <run>/<agent>/ref.json                       the latest saved session: SessionRef, plus how many segments it has
//                                                and the sizes of its folder's files (the record: recordSession)
//   <run>/<agent>/<session>/file/000001.gz …     the session file in order, a gzip member each, redacted
//   <run>/<agent>/<session>/folder/<path>.gz     Claude Code's `<id>/` folder beside it (subagents, tool results)
// The record is a file beside the session, not an agent field or a scope event: sessions stay out of the actors'
// SQLite (their size), and a client has nothing to show of them. They are kept as long as the run and deleted with it
// (deleteRunSessions).
import { gunzipSync } from "node:zlib";
import type { SessionStore } from "../../packages/plugin/src/session-store";
import { readConfig, userConfigPath } from "../config/store";
import { hostSessionStore, sessionsRoot } from "./host";
import { icloudDriveStore } from "./icloud-drive";
import { join } from "node:path";

/** A saved CLI session (ADR-026 phase 2 seam). `file`: its name as the CLI wrote it; `bytes`: its size as saved
 *  (redacted, uncompressed), which a restore writes. */
export type SessionRef = { cli: "claude" | "codex"; sessionId: string; file: string; bytes: number; savedAt: number };
/** The record behind a SessionRef: its segments, and its folder's files (path → size in the machine). */
export type SavedSession = SessionRef & { segments: number; folder?: Record<string, number> };

/** Where the host keeps an agent's sessions. */
export const sessionDir = (runId: string, agentId: string) => join(sessionsRoot(), runId, agentId);

export const refKey = (runId: string, agentId: string) => `${runId}/${agentId}/ref.json`;
export const segmentKey = (runId: string, agentId: string, sessionId: string, n: number) => `${runId}/${agentId}/${sessionId}/file/${String(n).padStart(6, "0")}.gz`;
export const folderKey = (runId: string, agentId: string, sessionId: string, rel: string) => `${runId}/${agentId}/${sessionId}/folder/${rel}.gz`;

/** The session stores by name: the host's, and the replicas capcomd ships (an S3-compatible one and Vercel Blob are
 *  next; a plugin's, once plugins can register one, joins here). */
export const SESSION_REPLICAS: Record<string, () => SessionStore> = { "icloud-drive": () => icloudDriveStore() };

type Stores = { primary: SessionStore; replica: SessionStore | null };
let override: Stores | null = null;
/** Tests: the stores to use instead of the configured ones (null: back to them). */
export function useSessionStores(s: Stores | null): void { override = s; }

/** The replica the user chose (`CAPCOMD_SESSIONS_REPLICA`, else `sessions.replica` in the user config), or null. */
export function replicaName(env: Record<string, string | undefined> = process.env): string | null {
  const v = env.CAPCOMD_SESSIONS_REPLICA ?? (env.CAPCOMD_NO_CONFIG ? undefined : readConfig(userConfigPath(env)).sessions?.replica ?? undefined);
  return v && v !== "none" && v !== "null" ? v : null;
}

let warned = new Set<string>();
const warnOnce = (what: string) => { if (!warned.has(what)) { warned.add(what); console.error(`[sessions] ${what}`); } };

/** The stores now: the host's, and the replica when one is chosen and known. */
export function sessionStores(): Stores {
  if (override) return override;
  const name = replicaName();
  const make = name ? SESSION_REPLICAS[name] : undefined;
  if (name && !make) warnOnce(`sessions.replica ${JSON.stringify(name)} isn't a session store capcomd has (${Object.keys(SESSION_REPLICAS).join(", ")}); sessions stay on this Mac only`);
  return { primary: hostSessionStore(), replica: make ? make() : null };
}

/** Replica writes, in order, after the host's: never waited on by the agent (the host copy is what counts). */
let replicaQueue: Promise<void> = Promise.resolve();
/** Resolves when every replica write asked for so far is done (tests; a daemon stopping). */
export const replicaIdle = () => replicaQueue;

/** `data` under `key` in the host store, then (queued) in the replica. */
export async function putSessionObject(key: string, data: Uint8Array, stores = sessionStores()): Promise<void> {
  await stores.primary.put(key, data);
  const replica = stores.replica;
  if (!replica) return;
  replicaQueue = replicaQueue.then(async () => {
    const ok = await replica.available().catch((e) => ({ ok: false as const, reason: String((e as Error)?.message ?? e), fix: null }));
    if (!ok.ok) { warnOnce(`replica ${replica.describe().name} is unavailable (${ok.reason}); sessions stay on this Mac only${ok.fix ? `. ${ok.fix}` : ""}`); return; }
    await replica.put(key, data);
  }).catch((e) => warnOnce(`replica ${replica.describe().name}: couldn't write ${key}: ${String((e as Error)?.message ?? e).slice(0, 300)}`));
}

const isRef = (v: any): v is SavedSession =>
  v && (v.cli === "claude" || v.cli === "codex") && typeof v.sessionId === "string" && typeof v.file === "string" && Number.isFinite(v.bytes) && Number.isFinite(v.savedAt);

/** Records `ref` as the agent's latest saved session (the host's record, and the replica's). */
export async function recordSession(runId: string, agentId: string, ref: SessionRef & Partial<SavedSession>): Promise<void> {
  const rec: SavedSession = { cli: ref.cli, sessionId: ref.sessionId, file: ref.file, bytes: ref.bytes, savedAt: ref.savedAt, segments: ref.segments ?? 0, ...(ref.folder ? { folder: ref.folder } : {}) };
  await putSessionObject(refKey(runId, agentId), new TextEncoder().encode(JSON.stringify(rec)));
}

async function readRecord(store: SessionStore, runId: string, agentId: string): Promise<SavedSession | null> {
  const b = await store.get(refKey(runId, agentId));
  if (!b) return null;
  try { const v = JSON.parse(new TextDecoder().decode(b)); return isRef(v) ? { ...v, segments: Number(v.segments) || 0 } : null; } catch { return null; }
}

/** The agent's latest saved session's record (the host's, else the replica's), or null. */
export async function savedSession(runId: string, agentId: string, stores = sessionStores()): Promise<SavedSession | null> {
  const host = await readRecord(stores.primary, runId, agentId).catch(() => null);
  if (host || !stores.replica) return host;
  return readRecord(stores.replica, runId, agentId).catch(() => null);
}

/** The agent's latest saved session, or null when none was saved. */
export async function latestSession(runId: string, agentId: string): Promise<SessionRef | null> {
  const s = await savedSession(runId, agentId);
  return s ? { cli: s.cli, sessionId: s.sessionId, file: s.file, bytes: s.bytes, savedAt: s.savedAt } : null;
}

/** A saved session's file and folder, from the store that has all of it (the host's, else the replica's). */
export async function readSession(runId: string, agentId: string, stores = sessionStores()): Promise<{ ref: SavedSession; file: Uint8Array; folder: Array<{ path: string; data: Uint8Array }> } | null> {
  for (const store of [stores.primary, stores.replica]) {
    if (!store) continue;
    try {
      const ref = await readRecord(store, runId, agentId);
      if (!ref) continue;
      const parts: Uint8Array[] = [];
      for (let n = 1; n <= ref.segments; n++) {
        const seg = await store.get(segmentKey(runId, agentId, ref.sessionId, n));
        if (!seg) throw new Error(`segment ${n} of ${ref.segments} is missing`);
        parts.push(gunzipSync(seg));
      }
      const folder: Array<{ path: string; data: Uint8Array }> = [];
      for (const rel of Object.keys(ref.folder ?? {})) {
        const f = await store.get(folderKey(runId, agentId, ref.sessionId, rel));
        if (f) folder.push({ path: rel, data: new Uint8Array(gunzipSync(f)) });
      }
      return { ref, file: new Uint8Array(Buffer.concat(parts)), folder };
    } catch (e) {
      warnOnce(`${store.describe().name}: couldn't read the session of ${runId}/${agentId}: ${String((e as Error)?.message ?? e).slice(0, 300)}`);
    }
  }
  return null;
}

/** Every session of the run, in every store (the run is deleted or archived for good). */
export async function deleteRunSessions(runId: string, stores = sessionStores()): Promise<void> {
  await stores.primary.delete(`${runId}/`);
  if (stores.replica) await stores.replica.delete(`${runId}/`).catch((e) => warnOnce(`replica ${stores.replica!.describe().name}: couldn't delete ${runId}: ${String((e as Error)?.message ?? e).slice(0, 300)}`));
}

/** Tests: forget the warnings already given. */
export const resetSessionWarnings = () => { warned = new Set(); };
