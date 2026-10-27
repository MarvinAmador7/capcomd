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

/** The name prefix capcomd gives every machine it creates (boxd VMs and Docker containers): `list(MACHINE_PREFIX)`
 *  finds them. Kept from capcomd's old name, so existing idempotency keys and names stay stable. */
export const MACHINE_PREFIX = "relay-";

export interface VmInfo {
  id: VmId;
  name: string;
  state: string;
  /** When the provider created it (ms epoch), when it says. */
  createdAt?: number | null;
  /** When it will be deleted (ms epoch): the platform's delete-after time, or capcomd's sweep ledger (Docker). */
  deleteAt?: number | null;
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
