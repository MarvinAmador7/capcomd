# boxd: first sandbox/VM backend for relay
> Reconstruction: HIGH confidence (verbatim from the original session transcript). Originally researched 2026-10-16.

Researched 2026-10-16. Confirmed: **boxd (boxd.sh)** is a microVM provider for devs and agents, the right product. **[Doc]** = docs.boxd.sh or boxd.sh (URL). **[Inference]** = ours.

## Sources
Overview https://docs.boxd.sh/ · TS SDK https://docs.boxd.sh/reference/typescript-sdk · gRPC API https://docs.boxd.sh/reference/grpc-api · Fork https://docs.boxd.sh/guides/fork · Snapshots https://docs.boxd.sh/guides/snapshots · Checkpoints https://docs.boxd.sh/guides/checkpoints · Suspend/resume https://docs.boxd.sh/guides/suspend-resume · Delete after https://docs.boxd.sh/guides/delete-after · Resources & limits https://docs.boxd.sh/guides/resources · Egress control https://docs.boxd.sh/guides/egress · Env & secrets https://docs.boxd.sh/guides/env-secrets · Disks https://docs.boxd.sh/guides/disks · Sandboxes https://docs.boxd.sh/use-cases/sandboxes · Agent swarm https://docs.boxd.sh/use-cases/agent-swarm-intelligence · Crabbox https://docs.boxd.sh/use-cases/oss-integrations/crabbox · CLI https://docs.boxd.sh/cli/commands · Pricing https://boxd.sh/pricing · npm `@boxd-sh/sdk` (0.2.17, first published 2026-05-01, updated 2026-10-16).

## What it is [Doc]
"Persistent, hardware-isolated Linux computers that boot in milliseconds, fork, snapshot and hibernate when idle". Each machine is a dedicated microVM (KVM per search result/sandboxes page) with root, full Linux, a 100 GB copy-on-write disk, and Docker preinstalled. Built on Ignition, the open-source microVM orchestrator (https://github.com/lttle-cloud/ignition).

## Features
| Area | Doc claims | URL |
|---|---|---|
| API/SDK | TS `@boxd-sh/sdk`: "Promise-only, ESM-only. Runs on Node 20+, Bun, and Deno"; Python SDK; public gRPC API `boxd.sh:9443` (TLS, short-lived JWT, reflection on); API keys per org (`BOXD_API_KEY`) | typescript-sdk, grpc-api |
| Lifecycle | `machines.create/get/list/delete`, `start/stop/reboot`, `pause/resume` (standby), `hibernate/wake`, `fork`, `rename` (reboots), `resize` (reboots), `waitUntilReady` (create/fork return when *scheduled*, polls ≤ 90 s), `deleteSelf` | typescript-sdk |
| Boot / fork | Fresh machine "under 10ms"; fork "under 200ms" incl. memory, disk and running processes (same PIDs); CLI example boot 160 ms | overview, fork, sandboxes |
| Snapshots | Named memory+disk capture; `create({fromSnapshot})` resumes as captured; saving the same name **replaces** the version (old ones not restorable); create fails while a new version is saving | snapshots, sdk |
| Checkpoints | In-place rollback (reboot into captured state), max 10 per machine | checkpoints |
| Sleep | States running / standby (sub-ms wake) / hibernated (~85 ms) / stopped. Auto-suspend off by default; **auto-hibernate on, 4 h with no network traffic. It watches network, not CPU**, so a CPU-only job can be hibernated mid-work; clocks stop while asleep | suspend-resume |
| Delete-after | Platform-enforced timer (`deleteAfter` seconds / cron), fires in any state, including asleep | delete-after |
| Filesystem | 100 GB CoW disk per machine, persistent by default; standalone disks that outlive machines (attach at `/mnt/...`); file upload/download/listDir/copy APIs; backups to object storage | resources, disks, sdk |
| Exec | `machines.exec(id, {command, env, timeout})` returns stdout/stderr/exit (timeout cancels the call, "the remote process may keep running"); `streamExec` with `tty`, `resize`, stdin, separate stderr without tty; `logs(id, {follow})` | sdk |
| Isolation | `isolated: true` (fixed at creation, inherited by forks and snapshot-created machines): no peers, no in-machine boxd CLI/metadata/integrations/**git & gh credential helpers**/agent logins | sandboxes, cli |
| Egress | `setEgressAllow(id, entries)`: hostnames, wildcards, IPv4/CIDR, takes effect within 1 s, set only from outside, can't be loosened by root inside; forks inherit, **snapshot-created machines start unrestricted** | egress |
| Secrets | Host-bound secrets: machine sees a `bxds_` placeholder; the real value is inserted only on requests to named hosts; on isolated machines they arrive in exec/SSH sessions only | egress, env-secrets |
| Networking | private org network by default, named `networks`, HTTPS domain per machine, proxies, 3 raw port forwards | resources |
| Limits | default 2 vCPU/8 GiB (sizes 1/4, 2/8, 4/16, 8/32); 50 machines/org (2 without payment method), hibernated/stopped count; raiseable by email | resources |
| Pricing | Credit-based, €30 free credits; €0.039/vCPU-h (running only), €0.012/GiB-h RAM *in use*, €0.00008/GiB-h disk *written*; per-second metering | pricing |
| Regions | **Not documented.** Pricing lists "EU data residency" under Custom | pricing |
| Self-host | Custom plan: "self-host on your own hardware or BYOC"; docs mention `boxd-ctl` quotas when self-hosted; no public self-host guide found | pricing, resources |
| Maturity | SDK 0.2.x; docs actively updated; third-party integrations (Crabbox, Flue, TanStack AI…) | npm, use-cases |

## SandboxProvider interface (refined)
```ts
export type VmId = string;
export interface VmSpec {
  idemKey: string;            // => deterministic machine name, e.g. relay-<run8>-<worker>-<epoch>
  fromSnapshot?: string;      // repo+toolchain base image
  forkOf?: VmId;              // warm parent (see worktrees section)
  size?: { vcpu: 1|2|4|8 };
  egressAllow: string[];      // boxd: [] = UNRESTRICTED; always pass a non-empty minimal list
  isolated: true;
  ttlSeconds: number;         // hard safety net -> boxd deleteAfter
  labels: Record<string,string>; // runId, workerId, epoch (boxd: encode in name; no labels API found)
}
export interface ExecResult { code: number; stdout: string; stderr: string }
export interface SandboxProvider {
  ensure(spec: VmSpec): Promise<{ id: VmId; created: boolean }>; // idempotent by idemKey
  waitReady(id: VmId, timeoutMs: number): Promise<void>;
  exec(id: VmId, cmd: string[], o?: { env?: Record<string,string>; timeoutMs?: number; cwd?: string }): Promise<ExecResult>;
  stream(id: VmId, cmd: string[], o?: { tty?: boolean; cols?: number; rows?: number }): AsyncIterable<Uint8Array> & { write(d: string): void; wait(): Promise<number>; close(): void };
  upload(id: VmId, path: string, data: Uint8Array | { fromPath: string }): Promise<void>;
  download(id: VmId, path: string): Promise<Uint8Array>;
  setEgress(id: VmId, allow: string[]): Promise<void>;
  checkpoint(id: VmId, name: string): Promise<void>;       // boxd checkpoints (max 10)
  restore(id: VmId, name: string): Promise<void>;
  snapshot(id: VmId, name: string): Promise<void>;
  suspend(id: VmId): Promise<void>; resume(id: VmId): Promise<void>;
  destroy(id: VmId): Promise<void>;                         // idempotent: not-found = ok
  list(prefix: string): Promise<{ id: VmId; name: string; state: string }[]>; // for orphan reaping
}
```
boxd mapping: `ensure` = `machines.get(name)` → if missing `machines.create({name, fromSnapshot, isolated:true, deleteAfter})` or `fork`, catching a name-taken error as "exists" (fork docs: a taken name fails with `name '…' is already taken`; [Inference] assume the same on create). `stream` = `streamExec`; `setEgress` = `setEgressAllow`; `destroy` = `delete`; `list` = `machines.list()` filtered by name prefix.
**Caveat:** in boxd, an empty allowlist means *unrestricted* [Doc: SDK "empty = unrestricted"]. Our "deny all" must be expressed as a minimal non-empty allowlist (e.g. only the git host and package registry). Always call `setEgress` after creating from a snapshot, since snapshots carry no allowlist [Doc].

## WorkerActor integration (with ADR-008 Worker machine)
- **Who creates/destroys:** WorkerActor only. `provisioning` → `ensure(spec)` with `idemKey = relay-${runId8}-${workerId}-e${epoch}`. A retry after a crash finds the same machine by name, so creation is exactly-once-ish. The id is persisted with the transition `VM_READY`.
- **Ready:** `waitReady` (≤ 90 s per boxd default) before the first exec.
- **Effects inside VM:** clone/fetch repo via `exec` (isolated machines have no git credential helpers [Doc]; use a host-bound secret token scoped to the git host, or push from the host side after `download` of a bundle). [Inference] Prefer: the VM commits; the host fetches a `git bundle` via `download` and the VerifierActor merges, so push credentials never enter the VM.
- **Lease expiry:** TaskBoard emits `LEASE_EXPIRED` → WorkerActor `draining` → `checkpoint` (optional, for debugging) → `destroy`, or keep it suspended for N minutes for inspection.
- **Auto-hibernate risk:** long CPU-bound builds without network can hibernate after 4 h [Doc]. Set the auto-hibernate timeout to 0 or above the task max, and rely on `deleteAfter` + our reaper.
- **Orphan reaping:** two layers. (1) boxd `deleteAfter = task max + grace` on every VM (platform-enforced even if relay is dead) [Doc]. (2) RunActor scheduled every 5 min: `list("relay-<run8>-")`, then destroy any machine whose name doesn't match a live WorkerActor in `busy|idle|provisioning`.
- **exec timeout:** cancels the call, but the remote process may keep running [Doc]. Track pids or wrap commands in `timeout(1)` inside the VM.

## Snapshots/forks vs worktrees [Inference built on doc facts]
- Snapshot `relay-base-<repo>-<sha>` = repo cloned + deps installed + build cache warm. Workers `create({fromSnapshot})` in ms with near-zero extra disk (CoW).
- Or keep one warm "base" machine per run and `fork` it per worker: a fork carries memory and running processes (e.g. warm `tsc --watch`, dev DB). This addresses Cursor's disk/compile hotspot by giving each worker its own disk and CPU without re-installing.
- Each VM then holds an ordinary clone on its own branch. Host-side git worktrees are needed only for the local-bwrap backend.
- Snapshot names keep only the latest version [Doc], so version the name by sha. Creating from a name fails while that name is re-saving.
- Checkpoints (≤ 10) give "undo" before risky agent steps.

## Open questions / risks
1. Regions/latency from Costa Rica, and EU vs US placement: undocumented.
2. Idempotent create semantics (name collision error code) need a test.
3. Is per-worker VM cost acceptable: 2 vCPU running ≈ €0.1/h at default size [Doc pricing]. 20 workers × 8 h ≈ €16/run-day [Inference].
4. Org cap of 50 machines (incl. hibernated) limits fan-out until raised.
5. Self-host only via a custom deal; no public guide.
6. SDK 0.2.x: pin the version and keep the interface boundary.
