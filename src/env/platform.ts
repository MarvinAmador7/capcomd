// Snapshot and host-bound secret operations used by `capcomd env|secrets|auth|doctor` (ADR-020: a provider has
// snapshots, secrets, both or neither). BoxdProvider has both, DockerProvider snapshots (images), FakeProvider both.
export type SnapshotStatus = "pending" | "ready" | "failed" | "unknown";
export interface SnapshotInfo { name: string; status: SnapshotStatus; id?: string; createdAt?: string }
export interface SecretInfo { name: string; scope: string; domains: string[] }

export interface SnapshotPlatform {
  snapshotCreate(vmId: string, name: string): Promise<SnapshotInfo>;
  snapshotGet(name: string): Promise<SnapshotInfo | null>;
  snapshotList(): Promise<SnapshotInfo[]>;
  snapshotDelete(name: string): Promise<void>;
}
export interface SecretPlatform {
  /** Value is sent once to the platform and never returned or logged. */
  secretSet(name: string, value: string, opts: { domains: string[]; scope: "private" | "org" }): Promise<void>;
  secretList(): Promise<SecretInfo[]>;
  secretDelete?(name: string, scope?: "private" | "org"): Promise<void>;
}
export type EnvPlatform = SnapshotPlatform & SecretPlatform;

export function isSnapshotPlatform(p: unknown): p is SnapshotPlatform {
  return !!p && typeof (p as any).snapshotGet === "function" && typeof (p as any).snapshotCreate === "function";
}
export function isSecretPlatform(p: unknown): p is SecretPlatform {
  return !!p && typeof (p as any).secretSet === "function" && typeof (p as any).secretList === "function";
}
export function isEnvPlatform(p: unknown): p is EnvPlatform {
  return isSnapshotPlatform(p) && isSecretPlatform(p);
}
