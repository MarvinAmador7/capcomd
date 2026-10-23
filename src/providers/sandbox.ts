export type VmId = string;

/** An egress allowlist of just this means "unrestricted", said on purpose (an empty list is refused as a mistake). */
export const OPEN_EGRESS = "*";

export interface VmSpec {
  idemKey: string;
  fromSnapshot?: string;
  forkOf?: VmId;
  size?: { vcpu: 1 | 2 | 4 | 8 };
  egressAllow: string[];
  isolated: true;
  ttlSeconds: number;
  labels: Record<string, string>;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface VmInfo {
  id: VmId;
  name: string;
  state: string;
}

export interface SandboxProvider {
  ensure(spec: VmSpec): Promise<{ id: VmId; created: boolean }>;
  waitReady(id: VmId, timeoutMs: number): Promise<void>;
  exec(
    id: VmId,
    cmd: string[],
    opts?: {
      env?: Record<string, string>;
      timeoutMs?: number;
      cwd?: string;
    }
  ): Promise<ExecResult>;
  upload(id: VmId, path: string, data: Uint8Array): Promise<void>;
  download(id: VmId, path: string): Promise<Uint8Array>;
  setEgress(id: VmId, allow: string[]): Promise<void>;
  checkpoint(id: VmId, name: string): Promise<void>;
  restore(id: VmId, name: string): Promise<void>;
  snapshot(id: VmId, name: string): Promise<void>;
  suspend(id: VmId): Promise<void>;
  resume(id: VmId): Promise<void>;
  destroy(id: VmId): Promise<void>;
  list(prefix: string): Promise<VmInfo[]>;
  /** Move the VM's delete deadline to `seconds` from now (a lease the running work keeps renewing). */
  extendTtl?(id: VmId, seconds: number): Promise<void>;
}
