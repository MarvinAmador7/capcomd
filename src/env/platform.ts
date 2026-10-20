// Snapshot + host-bound secret operations used by `capcomd env|secrets|doctor`.
// Implemented by BoxdProvider (real) and FakeProvider (tests).
export type SnapshotStatus = "pending" | "ready" | "failed" | "unknown";
export interface SnapshotInfo { name: string; status: SnapshotStatus; id?: string; createdAt?: string }
export interface SecretInfo { name: string; scope: string; domains: string[] }

export interface EnvPlatform {
  snapshotCreate(vmId: string, name: string): Promise<SnapshotInfo>;
  snapshotGet(name: string): Promise<SnapshotInfo | null>;
  snapshotList(): Promise<SnapshotInfo[]>;
  snapshotDelete(name: string): Promise<void>;
  /** Value is sent once to boxd and never returned or logged. */
  secretSet(name: string, value: string, opts: { domains: string[]; scope: "private" | "org" }): Promise<void>;
  secretList(): Promise<SecretInfo[]>;
}

export function isEnvPlatform(p: unknown): p is EnvPlatform {
  return !!p && typeof (p as any).snapshotGet === "function" && typeof (p as any).secretSet === "function";
}
