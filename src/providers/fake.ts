import type {
  SandboxProvider,
  VmId,
  VmSpec,
  ExecResult,
  VmInfo,
} from "./sandbox";
import { chmodSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

/**
 * hostExec runs VM scripts on this host. They target Ubuntu VMs and use GNU `timeout` and `setsid`,
 * which macOS lacks: on non-Linux hosts, put minimal perl stand-ins (and the host's node directory) first on PATH.
 */
let shimDir: string | null = null;
function hostShimDir(): string | null {
  if (process.platform === "linux") return null;
  if (shimDir) return shimDir;
  const d = mkdtempSync(join(tmpdir(), "capcomd-hostshims-"));
  // setsid CMD…: new session, then exec.
  writeFileSync(join(d, "setsid"), `#!/bin/sh\nexec perl -MPOSIX -e 'POSIX::setsid(); exec { $ARGV[0] } @ARGV or exit 127' -- "$@"\n`);
  // timeout [-k KILL] SECS CMD…: TERM the command's process group after SECS (KILL after KILL more), exit 124 like GNU.
  writeFileSync(join(d, "timeout"), `#!/bin/sh
k=0; if [ "$1" = "-k" ]; then k=$2; shift 2; fi
s=$1; shift
exec perl -e '
  my ($k, $s) = (shift, shift);
  my $p = fork; if (!$p) { setpgrp(0, 0); exec { $ARGV[0] } @ARGV or exit 127 }
  $SIG{ALRM} = sub { kill "TERM", -$p; if ($k) { sleep $k; kill "KILL", -$p } waitpid($p, 0); exit 124 };
  alarm $s; waitpid($p, 0); exit($? & 127 ? 128 + ($? & 127) : $? >> 8)' "$k" "$s" "$@"
`);
  for (const f of ["setsid", "timeout"]) chmodSync(join(d, f), 0o755);
  return (shimDir = d);
}
function withHostShims(env: Record<string, string>): Record<string, string> {
  const d = hostShimDir();
  if (!d) return env;
  // VM scripts call node (and npm next to it); the host's may live outside the minimal PATH (Homebrew, nvm):
  // add its real directory, never a link to it (scripts derive npm from `dirname $(command -v node)`).
  const node = Bun.which("node");
  const nodeDir = node ? dirname(node) : null;
  // Last, as a fallback only: a script's own node (e.g. a VM image's) must win.
  return { ...env, PATH: [d, env.PATH ?? process.env.PATH ?? "/usr/bin:/bin", nodeDir].filter(Boolean).join(":") };
}

interface FakeVm {
  id: VmId;
  name: string;
  state: "creating" | "ready" | "suspended" | "destroyed";
  spec: VmSpec;
  files: Map<string, Uint8Array>;
  checkpoints: Map<string, any>;
  createTime: number;
}

export interface FakeProviderOptions {
  /**
   * Run exec/upload/download for real on this host (tests of the agent adapter with a fake
   * `claude` binary). Paths are host paths; env is the given env only (plus `inheritEnv`).
   */
  hostExec?: boolean;
  /** Host env names passed through in hostExec mode (e.g. GIT_* fixtures). */
  inheritEnv?: string[];
  /** Records every exec (cmd + env names, never values) for assertions. */
  log?: Array<{ cmd: string[]; envKeys: string[]; env?: Record<string, string> }>;
  /** Test hook: make ensure() fail like boxd does for a bad key ("auth"). */
  failEnsure?: "auth";
  /** Machine env every VM sees (exec env overrides it), e.g. simulated boxd secret placeholders. */
  vmEnv?: Record<string, string>;
}

export class FakeProvider implements SandboxProvider {
  private vms = new Map<string, FakeVm>();
  private nextId = 1;
  public clock: number = Date.now();
  public egress = new Map<VmId, string[]>();
  /** Simulated boxd snapshots and host-bound secrets (values kept only to assert they never leak). */
  public snapshots = new Map<string, { name: string; status: "pending" | "ready" | "failed"; fromVm: VmId; polls: number }>();
  public secrets = new Map<string, { value: string; scope: string; domains: string[]; placeholder: string }>();
  /** Polls of snapshotGet before a snapshot reports ready (simulates boxd's async build). */
  public snapshotReadyAfter = 1;
  constructor(readonly opts: FakeProviderOptions = {}) {}

  /** What a VM's own environment holds: vmEnv plus a bxds_ placeholder per bound secret (never the value). */
  machineEnv(): Record<string, string> {
    const env: Record<string, string> = { ...(this.opts.vmEnv ?? {}) };
    for (const [name, s] of this.secrets) env[name] = s.placeholder;
    return env;
  }

  async snapshotCreate(vmId: VmId, name: string) {
    const vm = this.vms.get(vmId);
    if (!vm || vm.state !== "ready") throw new Error(`VM ${vmId} must be running to snapshot`);
    this.snapshots.set(name, { name, status: "pending", fromVm: vmId, polls: 0 });
    return { name, status: "pending" as const, id: `snap-${name}` };
  }
  async snapshotGet(name: string) {
    const s = this.snapshots.get(name);
    if (!s) return null;
    if (s.status === "pending" && ++s.polls >= this.snapshotReadyAfter) s.status = "ready";
    return { name, status: s.status, id: `snap-${name}` };
  }
  async snapshotList() { return [...this.snapshots.values()].map((s) => ({ name: s.name, status: s.status, id: `snap-${s.name}` })); }
  async snapshotDelete(name: string) { this.snapshots.delete(name); }
  async secretSet(name: string, value: string, o: { domains: string[]; scope: string }) {
    if (this.secretsDenied) { const { mapBoxdError } = await import("./boxd-errors"); class PermissionDeniedError extends Error {} throw mapBoxdError(new PermissionDeniedError("secrets require a member credential"), undefined, "secrets.set"); }
    const h = new Bun.CryptoHasher("sha256").update(name + value).digest("hex").slice(0, 24);
    this.secrets.set(name, { value, scope: o.scope, domains: [...o.domains], placeholder: `bxds_${h}` });
  }
  async secretDelete(name: string) { this.secrets.delete(name); }
  /** Test hook: make secrets.* fail like an org-scoped boxd key does. */
  public secretsDenied = false;
  /** Interactive exec: host process with piped stdio (hostExec mode). */
  streamExec(id: VmId, cmd: string[], opts: { env?: Record<string, string> } = {}) {
    const vm = this.vms.get(id);
    if (!vm || vm.state !== "ready") throw new Error(`VM ${id} not ready`);
    if (!this.opts.hostExec) throw new Error("FakeProvider.streamExec needs hostExec");
    this.opts.log?.push({ cmd, envKeys: Object.keys(opts.env ?? {}), env: opts.env });
    const env: Record<string, string> = {};
    for (const k of this.opts.inheritEnv ?? []) if (process.env[k] !== undefined) env[k] = process.env[k]!;
    Object.assign(env, this.machineEnv(), opts.env ?? {});
    const proc = Bun.spawn(cmd, { env: withHostShims(env), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    async function* merged() { for await (const c of proc.stdout as any) yield c as Uint8Array; }
    return {
      write: (d: string | Uint8Array) => { proc.stdin.write(d); proc.stdin.flush(); },
      end: () => proc.stdin.end(), close: () => proc.kill(), output: merged(), wait: () => proc.exited,
    };
  }

  async secretList() { if (this.secretsDenied) throw new Error("PermissionDenied: secrets require a member credential"); return [...this.secrets.entries()].map(([name, s]) => ({ name, scope: s.scope, domains: s.domains })); }
  specOf(id: VmId): VmSpec | undefined { return this.vms.get(id)?.spec; }

  async ensure(spec: VmSpec): Promise<{ id: VmId; created: boolean }> {
    if (this.opts.failEnsure === "auth") {
      const { mapBoxdError } = await import("./boxd-errors");
      class AuthenticationError extends Error {}
      throw mapBoxdError(new AuthenticationError("invalid or expired API key"), undefined, "machines.create");
    }
    const existing = Array.from(this.vms.values()).find(
      (vm) => vm.name === spec.idemKey && vm.state !== "destroyed"
    );

    if (existing) {
      return { id: existing.id, created: false };
    }

    const id = `vm-${this.nextId++}`;
    const vm: FakeVm = {
      id,
      name: spec.idemKey,
      state: "creating",
      spec,
      files: new Map(),
      checkpoints: new Map(),
      createTime: this.clock,
    };
    this.vms.set(id, vm);
    this.egress.set(id, [...spec.egressAllow]);

    setTimeout(() => {
      if (this.vms.get(id)?.state === "creating") {
        this.vms.get(id)!.state = "ready";
      }
    }, 10);

    return { id, created: true };
  }

  async waitReady(id: VmId, timeoutMs: number): Promise<void> {
    const vm = this.vms.get(id);
    if (!vm) throw new Error(`VM ${id} not found`);

    const start = Date.now();
    while (vm.state === "creating") {
      if (Date.now() - start > timeoutMs) {
        throw new Error(`VM ${id} not ready within ${timeoutMs}ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
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
    const vm = this.vms.get(id);
    if (!vm) throw new Error(`VM ${id} not found`);
    if (vm.state !== "ready") throw new Error(`VM ${id} not ready`);
    this.opts.log?.push({ cmd, envKeys: Object.keys(opts?.env ?? {}), env: opts?.env });

    if (this.opts.hostExec) {
      const env: Record<string, string> = {};
      for (const k of this.opts.inheritEnv ?? []) if (process.env[k] !== undefined) env[k] = process.env[k]!;
      Object.assign(env, this.machineEnv(), opts?.env ?? {});
      const proc = Bun.spawn(cmd, { cwd: opts?.cwd, env: withHostShims(env), stdout: "pipe", stderr: "pipe", stdin: "ignore" });
      const timer = opts?.timeoutMs ? setTimeout(() => proc.kill("SIGKILL"), opts.timeoutMs) : null;
      const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      if (timer) clearTimeout(timer);
      return { code, stdout, stderr };
    }

    if (cmd[0] === "git" && cmd[1] === "commit") {
      return { code: 0, stdout: "[main abc1234] test commit\n", stderr: "" };
    }

    if (cmd[0] === "git" && cmd[1] === "push") {
      return { code: 0, stdout: "", stderr: "" };
    }

    return {
      code: 0,
      stdout: `Executed: ${cmd.join(" ")}`,
      stderr: "",
    };
  }

  async upload(id: VmId, path: string, data: Uint8Array): Promise<void> {
    const vm = this.vms.get(id);
    if (!vm) throw new Error(`VM ${id} not found`);
    if (this.opts.hostExec) { await Bun.write(path, data); return; }
    vm.files.set(path, data);
  }

  async download(id: VmId, path: string): Promise<Uint8Array> {
    const vm = this.vms.get(id);
    if (!vm) throw new Error(`VM ${id} not found`);
    if (this.opts.hostExec) return new Uint8Array(await Bun.file(path).arrayBuffer());
    const data = vm.files.get(path);
    if (!data) throw new Error(`File ${path} not found in VM ${id}`);
    return data;
  }

  async setEgress(id: VmId, allow: string[]): Promise<void> {
    const vm = this.vms.get(id);
    if (!vm) throw new Error(`VM ${id} not found`);
    this.egress.set(id, [...allow]);
  }

  async checkpoint(id: VmId, name: string): Promise<void> {
    const vm = this.vms.get(id);
    if (!vm) throw new Error(`VM ${id} not found`);
    vm.checkpoints.set(name, { state: vm.state, files: new Map(vm.files) });
  }

  async restore(id: VmId, name: string): Promise<void> {
    const vm = this.vms.get(id);
    if (!vm) throw new Error(`VM ${id} not found`);
    const checkpoint = vm.checkpoints.get(name);
    if (!checkpoint) throw new Error(`Checkpoint ${name} not found`);
    vm.state = checkpoint.state;
    vm.files = new Map(checkpoint.files);
  }

  async snapshot(id: VmId, name: string): Promise<void> {
    const vm = this.vms.get(id);
    if (!vm) throw new Error(`VM ${id} not found`);
    this.snapshots.set(name, { name, status: "ready", fromVm: id, polls: 0 });
  }

  async suspend(id: VmId): Promise<void> {
    const vm = this.vms.get(id);
    if (!vm) throw new Error(`VM ${id} not found`);
    vm.state = "suspended";
  }

  async resume(id: VmId): Promise<void> {
    const vm = this.vms.get(id);
    if (!vm) throw new Error(`VM ${id} not found`);
    if (vm.state === "suspended") {
      vm.state = "ready";
    }
  }

  async destroy(id: VmId): Promise<void> {
    const vm = this.vms.get(id);
    if (!vm) return;
    vm.state = "destroyed";
  }

  async list(prefix: string): Promise<VmInfo[]> {
    const result: VmInfo[] = [];
    for (const vm of this.vms.values()) {
      if (vm.name.startsWith(prefix) && vm.state !== "destroyed") {
        const shouldReap =
          vm.spec.ttlSeconds > 0 &&
          this.clock - vm.createTime > vm.spec.ttlSeconds * 1000;
        if (!shouldReap) {
          result.push({
            id: vm.id,
            name: vm.name,
            state: vm.state,
          });
        }
      }
    }
    return result;
  }

  advanceClock(ms: number): void {
    this.clock += ms;
  }
}
