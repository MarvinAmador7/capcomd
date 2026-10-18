import type {
  SandboxProvider,
  VmId,
  VmSpec,
  ExecResult,
  VmInfo,
} from "./sandbox";

export class BoxdProvider implements SandboxProvider {
  constructor(private apiKey: string) {
    if (!apiKey) {
      throw new Error("BoxdProvider requires BOXD_API_KEY");
    }
  }

  async ensure(spec: VmSpec): Promise<{ id: VmId; created: boolean }> {
    throw new Error("BoxdProvider not implemented - credentials required");
  }

  async waitReady(id: VmId, timeoutMs: number): Promise<void> {
    throw new Error("BoxdProvider not implemented");
  }

  async exec(
    id: VmId,
    cmd: string[],
    opts?: {
      env?: Record<string, string>;
      timeoutMs?: number;
      cwd?: string;
    }
  ): Promise<ExecResult> {
    throw new Error("BoxdProvider not implemented");
  }

  async upload(id: VmId, path: string, data: Uint8Array): Promise<void> {
    throw new Error("BoxdProvider not implemented");
  }

  async download(id: VmId, path: string): Promise<Uint8Array> {
    throw new Error("BoxdProvider not implemented");
  }

  async setEgress(id: VmId, allow: string[]): Promise<void> {
    throw new Error("BoxdProvider not implemented");
  }

  async checkpoint(id: VmId, name: string): Promise<void> {
    throw new Error("BoxdProvider not implemented");
  }

  async restore(id: VmId, name: string): Promise<void> {
    throw new Error("BoxdProvider not implemented");
  }

  async snapshot(id: VmId, name: string): Promise<void> {
    throw new Error("BoxdProvider not implemented");
  }

  async suspend(id: VmId): Promise<void> {
    throw new Error("BoxdProvider not implemented");
  }

  async resume(id: VmId): Promise<void> {
    throw new Error("BoxdProvider not implemented");
  }

  async destroy(id: VmId): Promise<void> {
    throw new Error("BoxdProvider not implemented");
  }

  async list(prefix: string): Promise<VmInfo[]> {
    throw new Error("BoxdProvider not implemented");
  }
}
