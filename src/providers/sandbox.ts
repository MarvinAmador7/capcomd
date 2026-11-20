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

/** What a provider keeps of a machine it hibernates (ADR-026 §6, `caps.hibernate`): its memory too (`memory`), only its
 *  disk (`disk`: files survive, processes don't), or it can't hibernate (`none`). */
export type HibernateCap = "memory" | "disk" | "none";

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
  /** ADR-026 §6: park the machine (boxd `hibernate`, never `pause`; Docker `docker stop`): it stops billing for its
   *  compute and keeps its disk (`caps.hibernate`). Only a provider that can has it. */
  hibernate?(id: VmId): Promise<void>;
  /** ADR-026 §5 path 2: wake a parked machine. Rejects not_found when it is gone. */
  wake?(id: VmId): Promise<void>;
  /** Resolves when the provider answers (about `id`, if given; "not found" is an answer too); rejects when it doesn't.
   *  Asked after an exec failed transiently, to tell an outage from a command that ran out of time. */
  probe?(id?: VmId): Promise<void>;
}
