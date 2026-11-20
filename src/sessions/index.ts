// ADR-026 §2: durable CLI sessions. The store seam and its providers (host, icloud-drive), the records, and restore.
export type { SessionStore, SessionStoreDescriptor } from "../../packages/plugin/src/session-store";
export { type SavedSession, type SessionRef, deleteRunSessions, latestSession, recordSession, replicaIdle, sessionDir, sessionStores, useSessionStores } from "./store";
export { restoreSession } from "./restore";
export { hostSessionStore, sessionsRoot } from "./host";
export { icloudDriveStore } from "./icloud-drive";
