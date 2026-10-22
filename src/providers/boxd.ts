// BoxdProvider: SandboxProvider backed by boxd.sh VMs via @boxd-sh/sdk (0.2.x).
// See docs/boxd.md for the design (idempotency, egress, keepalive, credentials).
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { SandboxProvider, VmId, VmSpec, ExecResult, VmInfo } from "./sandbox";
import {
  SandboxConfigError,
  SandboxHibernatedError,
  SandboxNotFoundError,
  SandboxTimeoutError,
  mapBoxdError,
} from "./boxd-errors";
import { env } from "../utils/env";
import { stateDir } from "../utils/home";

export * from "./boxd-errors";

/** The subset of `Boxd` (from @boxd-sh/sdk) this provider calls. Lets tests inject a mock. */
export interface BoxdMachine {
  id: string;
  name: string;
  status: string;
  egressAllow?: string[];
}
export interface BoxdLike {
  machines: {
    create(p: Record<string, unknown>): Promise<BoxdMachine>;
    get(id: string): Promise<BoxdMachine>;
    list(p?: Record<string, unknown>): Promise<BoxdMachine[]>;
    delete(id: string): Promise<void>;
    waitUntilReady(id: string, p?: { timeout?: number; pollInterval?: number }): Promise<BoxdMachine>;
    exec(id: string, p: { command: string | string[]; env?: Record<string, string>; cwd?: string; timeout?: number }): Promise<{ stdout: string; stderr: string; exitCode: number }>;
    streamExec?(id: string, p: { command: string | string[]; env?: Record<string, string>; tty?: boolean; cols?: number; rows?: number }): any;
    setEgressAllow(id: string, entries: string[]): Promise<string[]>;
    setDeleteAfter?(id: string, seconds: number): Promise<unknown>;
    pause(id: string): Promise<unknown>;
    resume(id: string): Promise<unknown>;
    wake(id: string): Promise<void>;
    files: {
      upload(id: string, path: string, data: Uint8Array): Promise<number>;
      download(id: string, path: string): Promise<Uint8Array>;
    };
    checkpoints: {
      create(id: string, name: string): Promise<unknown>;
      restore(id: string, name: string): Promise<void>;
    };
  };
  snapshots: {
    create(machine: string, name: string): Promise<unknown>;
    get?(name: string): Promise<any>;
    list?(): Promise<any[]>;
    delete?(name: string): Promise<void>;
  };
  secrets?: {
    set(name: string, value: string, opts?: { scope?: string; domains?: string[]; org?: string }): Promise<unknown>;
    list(opts?: Record<string, unknown>): Promise<Array<{ name: string; scope?: string; domains?: string[] }>>;
    delete?(name: string, opts?: { scope?: string }): Promise<void>;
  };
  close?(): Promise<void>;
}

/**
 * Per-task short-lived git credentials. Called before every `git ...` exec; the
 * returned env is passed to that one exec only and never logged or stored.
 * Return null when no credential source is configured (git then runs without one).
 */
export type GitCredentialHook = (ctx: { vmId: VmId; labels: Record<string, string>; cmd: string[] }) =>
  Promise<Record<string, string> | null>;

export const noGitCredentials: GitCredentialHook = async () => null;

export interface BoxdProviderOptions {
  /** Injected client (tests). Defaults to `new Boxd({ apiKey })` from @boxd-sh/sdk. */
  client?: BoxdLike;
  /** Defaults to env BOXD_API_KEY. Never logged. */
  apiKey?: string;
  /** SQLite file for the idemKey → VM id ledger. Default env CAPCOMD_BOXD_DB or .relay/boxd.sqlite. */
  dbPath?: string;
  gitCredentials?: GitCredentialHook;
  /** Keepalive interval. boxd auto-hibernates idle VMs (4h); default every 30 min. 0 disables. */
  keepaliveMs?: number;
  /** Org to create machines in (optional). */
  org?: string;
  /** VM name prefix; `list(prefix)` filters on it. */
  namePrefix?: string;
}

const DEAD = new Set(["destroyed", "failed"]);
const ASLEEP = new Set(["hibernated", "suspended"]);

/** Deterministic, DNS-safe VM name for an idempotency key (taskId+epoch etc). */
export function vmNameFor(idemKey: string, prefix = "relay-"): string {
  const h = createHash("sha256").update(idemKey).digest("hex").slice(0, 16);
  return `${prefix}${h}`;
}

export function assertEgress(allow: string[] | undefined): string[] {
  const list = (allow ?? []).map((s) => s.trim()).filter(Boolean);
  if (list.length === 0) {
    throw new SandboxConfigError("egress allowlist is empty; boxd treats [] as unrestricted, so capcomd refuses to send it");
  }
  return list;
}

export class BoxdProvider implements SandboxProvider {
  readonly client: BoxdLike;
  private db: Database;
  private keepalives = new Map<VmId, ReturnType<typeof setInterval>>();
  private labels = new Map<VmId, Record<string, string>>();
  private gitCredentials: GitCredentialHook;
  private keepaliveMs: number;
  private org?: string;
  private prefix: string;

  constructor(opts: BoxdProviderOptions = {}) {
    if (opts.client) {
      this.client = opts.client;
    } else {
      const apiKey = opts.apiKey ?? process.env.BOXD_API_KEY;
      if (!apiKey) throw new SandboxConfigError("BoxdProvider requires BOXD_API_KEY");
      // Lazy require keeps grpc-js out of processes that never select boxd.
      const { Boxd } = require("@boxd-sh/sdk") as typeof import("@boxd-sh/sdk");
      this.client = new Boxd({ apiKey }) as unknown as BoxdLike;
    }
    this.gitCredentials = opts.gitCredentials ?? noGitCredentials;
    this.keepaliveMs = opts.keepaliveMs ?? 30 * 60_000;
    this.org = opts.org ?? process.env.BOXD_ORG;
    this.prefix = opts.namePrefix ?? "relay-";
    const path = opts.dbPath ?? env("BOXD_DB") ?? join(stateDir(), "boxd.sqlite");
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
    this.db.exec(`CREATE TABLE IF NOT EXISTS boxd_vms (
      idem_key TEXT PRIMARY KEY, name TEXT NOT NULL, vm_id TEXT, state TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
  }

  /** Ledger row for an idempotency key (exposed for tests and docs). */
  record(idemKey: string): { idem_key: string; name: string; vm_id: string | null; state: string } | null {
    return (this.db.query("SELECT idem_key, name, vm_id, state FROM boxd_vms WHERE idem_key = ?").get(idemKey) as any) ?? null;
  }

  private upsert(idemKey: string, name: string, vmId: string | null, state: string) {
    const now = Date.now();
    this.db.query(`INSERT INTO boxd_vms (idem_key, name, vm_id, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(idem_key) DO UPDATE SET name=excluded.name, vm_id=excluded.vm_id, state=excluded.state, updated_at=excluded.updated_at`)
      .run(idemKey, name, vmId, state, now, now);
  }

  private async tryGet(idOrName: string): Promise<BoxdMachine | null> {
    try {
      return await this.client.machines.get(idOrName);
    } catch (err) {
      if (mapBoxdError(err) instanceof SandboxNotFoundError) return null;
      throw mapBoxdError(err, idOrName, "machines.get");
    }
  }

  async ensure(spec: VmSpec): Promise<{ id: VmId; created: boolean }> {
    const egress = assertEgress(spec.egressAllow);
    const name = vmNameFor(spec.idemKey, this.prefix);
    const row = this.record(spec.idemKey);

    // 1. Reuse what the ledger says we already created (crash after create+record).
    // 2. Else reuse by deterministic name (crash after create, before record).
    let machine: BoxdMachine | null = null;
    if (row?.vm_id && row.state !== "destroyed") machine = await this.tryGet(row.vm_id);
    if (!machine) machine = await this.tryGet(name);
    if (machine && DEAD.has(machine.status)) machine = null;

    let created = false;
    if (!machine) {
      // Record intent before the create call so a crash leaves a trail.
      this.upsert(spec.idemKey, name, null, "creating");
      try {
        machine = await this.client.machines.create({
          name,
          ...(this.org ? { org: this.org } : {}),
          isolated: spec.isolated,
          ...(spec.fromSnapshot ? { fromSnapshot: spec.fromSnapshot } : {}),
          ...(spec.size ? { config: { vcpu: spec.size.vcpu } } : {}),
          // Platform-enforced backstop: the VM deletes itself even if relay dies.
          deleteAfter: spec.ttlSeconds,
        });
        created = true;
      } catch (err) {
        const cls = (err as any)?.constructor?.name;
        if (cls === "ConflictError" || (err as any)?.grpcCode === 6) {
          machine = await this.tryGet(name); // lost a race with our own retry
          if (!machine) throw mapBoxdError(err, undefined, "machines.create");
        } else {
          throw mapBoxdError(err, undefined, "machines.create");
        }
      }
    }

    // VM id is durable in SQLite before anything uses the VM.
    this.upsert(spec.idemKey, name, machine.id, "created");
    this.labels.set(machine.id, spec.labels ?? {});

    if (ASLEEP.has(machine.status)) await this.wakeUp(machine.id, machine.status);

    // Always apply an explicit, non-empty allowlist (restored-from-snapshot VMs start unrestricted).
    const applied = await this.client.machines.setEgressAllow(machine.id, egress).catch((err) => {
      throw mapBoxdError(err, machine!.id, "setEgressAllow");
    });
    if (!applied || applied.length === 0) {
      throw new SandboxConfigError("boxd returned an empty egress allowlist after set; refusing to use an unrestricted VM", machine.id);
    }
    this.startKeepalive(machine.id);
    return { id: machine.id, created };
  }

  private async wakeUp(id: VmId, status: string) {
    try {
      if (status === "hibernated") await this.client.machines.wake(id);
      else await this.client.machines.resume(id);
    } catch (err) {
      throw new SandboxHibernatedError(`could not wake ${status} VM: ${(err as Error)?.message}`, id, err);
    }
  }

  private startKeepalive(id: VmId) {
    if (this.keepaliveMs <= 0 || this.keepalives.has(id)) return;
    const t = setInterval(() => {
      this.client.machines.exec(id, { command: ["true"], timeout: 30_000 }).catch(() => {});
    }, this.keepaliveMs);
    (t as any).unref?.();
    this.keepalives.set(id, t);
  }

  private stopKeepalive(id: VmId) {
    const t = this.keepalives.get(id);
    if (t) clearInterval(t);
    this.keepalives.delete(id);
  }

  async waitReady(id: VmId, timeoutMs: number): Promise<void> {
    const m = await this.tryGet(id);
    if (!m) throw new SandboxNotFoundError(`VM ${id} not found`, id);
    if (ASLEEP.has(m.status)) await this.wakeUp(id, m.status);
    try {
      await this.client.machines.waitUntilReady(id, { timeout: timeoutMs });
    } catch (err) {
      const mapped = mapBoxdError(err, id, "waitUntilReady");
      if (mapped instanceof SandboxNotFoundError) throw mapped;
      if (mapped instanceof SandboxTimeoutError || /ready/i.test((err as Error)?.message ?? "")) {
        throw new SandboxTimeoutError(`VM ${id} not ready within ${timeoutMs}ms`, id, err);
      }
      throw mapped;
    }
  }

  async exec(id: VmId, cmd: string[], opts?: { env?: Record<string, string>; timeoutMs?: number; cwd?: string }): Promise<ExecResult> {
    let env = opts?.env;
    if (cmd[0] === "git") {
      const creds = await this.gitCredentials({ vmId: id, labels: this.labels.get(id) ?? {}, cmd });
      if (creds) env = { ...(env ?? {}), ...creds };
    }
    try {
      const r = await this.client.machines.exec(id, {
        command: cmd,
        ...(env ? { env } : {}),
        ...(opts?.cwd ? { cwd: opts.cwd } : {}),
        ...(opts?.timeoutMs ? { timeout: opts.timeoutMs } : {}),
      });
      return { code: r.exitCode, stdout: r.stdout, stderr: r.stderr };
    } catch (err) {
      const mapped = mapBoxdError(err, id, "exec");
      if (!(mapped instanceof SandboxNotFoundError) && (err as any)?.constructor?.name === "ConflictError") {
        const m = await this.tryGet(id);
        if (m && ASLEEP.has(m.status)) throw new SandboxHibernatedError(`VM ${id} is ${m.status}`, id, err);
      }
      throw mapped;
    }
  }

  async upload(id: VmId, path: string, data: Uint8Array): Promise<void> {
    await this.client.machines.files.upload(id, path, data).catch((e) => { throw mapBoxdError(e, id, "upload"); });
  }

  async download(id: VmId, path: string): Promise<Uint8Array> {
    return this.client.machines.files.download(id, path).catch((e) => { throw mapBoxdError(e, id, "download"); });
  }

  async setEgress(id: VmId, allow: string[]): Promise<void> {
    const list = assertEgress(allow);
    await this.client.machines.setEgressAllow(id, list).catch((e) => { throw mapBoxdError(e, id, "setEgressAllow"); });
  }

  async checkpoint(id: VmId, name: string): Promise<void> {
    await this.client.machines.checkpoints.create(id, name).catch((e) => { throw mapBoxdError(e, id, "checkpoint"); });
  }

  async restore(id: VmId, name: string): Promise<void> {
    await this.client.machines.checkpoints.restore(id, name).catch((e) => { throw mapBoxdError(e, id, "restore"); });
  }

  async snapshot(id: VmId, name: string): Promise<void> {
    await this.client.snapshots.create(id, name).catch((e) => { throw mapBoxdError(e, id, "snapshot"); });
  }

  // ---- EnvPlatform (capcomd env|secrets|doctor) ----
  private snapInfo(x: any, name: string) {
    const st = String(x?.status ?? "unknown");
    return { name: String(x?.name ?? name), id: x?.id ? String(x.id) : undefined, status: (["pending", "ready", "failed"].includes(st) ? st : "unknown") as any, createdAt: x?.createdAt ? String(x.createdAt) : undefined };
  }
  async snapshotCreate(id: VmId, name: string) {
    const r = await this.client.snapshots.create(id, name).catch((e) => { throw mapBoxdError(e, id, "snapshots.create"); });
    return this.snapInfo(r, name);
  }
  async snapshotGet(name: string) {
    if (!this.client.snapshots.get) throw new SandboxConfigError("boxd SDK lacks snapshots.get (need @boxd-sh/sdk >= 0.2.17)");
    try { return this.snapInfo(await this.client.snapshots.get(name), name); }
    catch (e) { if ((e as any)?.constructor?.name === "NotFoundError" || /not.?found/i.test(String((e as Error)?.message))) return null; throw mapBoxdError(e, undefined, "snapshots.get"); }
  }
  async snapshotList() {
    if (!this.client.snapshots.list) return [];
    const xs = await this.client.snapshots.list().catch((e) => { throw mapBoxdError(e, undefined, "snapshots.list"); });
    return xs.map((x) => this.snapInfo(x, String(x?.name)));
  }
  async snapshotDelete(name: string) {
    if (!this.client.snapshots.delete) throw new SandboxConfigError("boxd SDK lacks snapshots.delete");
    await this.client.snapshots.delete(name).catch((e) => { throw mapBoxdError(e, undefined, "snapshots.delete"); });
  }
  async secretSet(name: string, value: string, opts: { domains: string[]; scope: "private" | "org" }) {
    if (!this.client.secrets) throw new SandboxConfigError("boxd SDK lacks secrets (need @boxd-sh/sdk >= 0.2.17)");
    if (!opts.domains.length) throw new SandboxConfigError(`refusing to set ${name} without bound domains`);
    // Never let the value reach an error message.
    await this.client.secrets.set(name, value, { scope: opts.scope, domains: opts.domains, ...(this.org ? { org: this.org } : {}) })
      .catch((e) => { const m = mapBoxdError(e, undefined, "secrets.set"); m.message = m.message.split(value).join("[REDACTED]"); throw m; });
  }
  async secretDelete(name: string, scope: "private" | "org" = "private") {
    if (!this.client.secrets?.delete) throw new SandboxConfigError("boxd SDK lacks secrets.delete");
    await this.client.secrets.delete(name, { scope }).catch((e) => { throw mapBoxdError(e, undefined, "secrets.delete"); });
  }

  /** Interactive PTY exec (capcomd auth login). */
  streamExec(id: VmId, cmd: string[], opts: { env?: Record<string, string>; tty?: boolean; cols?: number; rows?: number } = {}) {
    if (!this.client.machines.streamExec) throw new SandboxConfigError("boxd SDK lacks machines.streamExec");
    const st = this.client.machines.streamExec(id, { command: cmd, env: opts.env, tty: opts.tty ?? true, cols: opts.cols ?? 200, rows: opts.rows ?? 40 });
    return {
      write: (d: string | Uint8Array) => st.write(d), end: () => st.end(), close: () => st.close(),
      resize: (c: number, r: number) => st.resize(c, r), output: st as AsyncIterable<Uint8Array>, wait: () => st.wait() as Promise<number>,
    };
  }

  async secretList() {
    if (!this.client.secrets) return [];
    const xs = await this.client.secrets.list().catch((e) => { throw mapBoxdError(e, undefined, "secrets.list"); });
    return xs.map((x) => ({ name: x.name, scope: String(x.scope ?? ""), domains: [...(x.domains ?? [])] }));
  }

  async suspend(id: VmId): Promise<void> {
    this.stopKeepalive(id);
    await this.client.machines.pause(id).catch((e) => { throw mapBoxdError(e, id, "pause"); });
  }

  async resume(id: VmId): Promise<void> {
    await this.client.machines.resume(id).catch((e) => { throw mapBoxdError(e, id, "resume"); });
    this.startKeepalive(id);
  }

  async extendTtl(id: VmId, seconds: number): Promise<void> {
    await this.client.machines.setDeleteAfter?.(id, seconds).catch((e: unknown) => { throw mapBoxdError(e, id, "setDeleteAfter"); });
  }

  /** Idempotent: a VM that is already gone counts as destroyed. */
  async destroy(id: VmId): Promise<void> {
    this.stopKeepalive(id);
    try {
      await this.client.machines.delete(id);
    } catch (err) {
      const mapped = mapBoxdError(err, id, "delete");
      if (!(mapped instanceof SandboxNotFoundError)) throw mapped;
    }
    this.db.query("UPDATE boxd_vms SET state='destroyed', updated_at=? WHERE vm_id = ?").run(Date.now(), id);
    this.labels.delete(id);
  }

  async list(prefix: string): Promise<VmInfo[]> {
    const all = await this.client.machines.list(this.org ? { org: this.org } : undefined).catch((e) => { throw mapBoxdError(e, undefined, "list"); });
    return all.filter((m) => m.name.startsWith(prefix)).map((m) => ({ id: m.id, name: m.name, state: m.status }));
  }

  async close(): Promise<void> {
    for (const id of [...this.keepalives.keys()]) this.stopKeepalive(id);
    await this.client.close?.();
    this.db.close();
  }
}
