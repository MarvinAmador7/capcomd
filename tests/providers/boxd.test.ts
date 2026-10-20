import { describe, expect, test, beforeEach } from "bun:test";
import {
  BoxdProvider, vmNameFor, SandboxConfigError, SandboxQuotaError, SandboxTimeoutError,
  SandboxHibernatedError, SandboxNotFoundError, type BoxdLike, type BoxdMachine,
} from "../../src/providers/boxd";
import { providerFromEnv } from "../../src/dependencies";
import { FakeProvider } from "../../src/providers/fake";

// Error classes named like the SDK's so mapBoxdError matches them by name + gRPC code.
class NotFoundError extends Error { grpcCode = 5; }
class RateLimitError extends Error { grpcCode = 8; }
class ConflictError extends Error { grpcCode = 9; }
class APIStatusError extends Error { constructor(m: string, public grpcCode: number) { super(m); } }

type Call = [string, ...any[]];
function mockSdk() {
  const calls: Call[] = [];
  const vms = new Map<string, BoxdMachine>();
  let n = 0;
  const find = (idOrName: string) => vms.get(idOrName) ?? [...vms.values()].find((m) => m.name === idOrName);
  const sdk: BoxdLike & { calls: Call[]; vms: typeof vms; fail: Record<string, Error | undefined> } = {
    calls, vms, fail: {},
    machines: {
      async create(p) {
        calls.push(["create", p]);
        if (sdk.fail.create) throw sdk.fail.create;
        const m = { id: `m_${++n}`, name: p.name as string, status: "pending", egressAllow: [] };
        vms.set(m.id, m); return m;
      },
      async get(id) { calls.push(["get", id]); const m = find(id); if (!m) throw new NotFoundError(`no ${id}`); return m; },
      async list() { calls.push(["list"]); return [...vms.values()]; },
      async delete(id) { calls.push(["delete", id]); if (!vms.delete(id)) throw new NotFoundError(`no ${id}`); },
      async waitUntilReady(id, p) {
        calls.push(["waitUntilReady", id, p]);
        if (sdk.fail.wait) throw sdk.fail.wait;
        const m = find(id)!; m.status = "running"; return m;
      },
      async exec(id, p) {
        calls.push(["exec", id, p]);
        if (sdk.fail.exec) throw sdk.fail.exec;
        return { stdout: "ok\n", stderr: "", exitCode: 0 };
      },
      async setEgressAllow(id, entries) { calls.push(["setEgressAllow", id, entries]); find(id)!.egressAllow = entries; return entries; },
      async pause(id) { calls.push(["pause", id]); return {}; },
      async resume(id) { calls.push(["resume", id]); find(id)!.status = "running"; return {}; },
      async wake(id) { calls.push(["wake", id]); find(id)!.status = "running"; },
      files: { async upload() { return 0; }, async download() { return new Uint8Array(); } },
      checkpoints: { async create() { return {}; }, async restore() {} },
    },
    snapshots: { async create() { return {}; } },
  };
  return sdk;
}

const spec = (over: Partial<Parameters<BoxdProvider["ensure"]>[0]> = {}) => ({
  idemKey: "relay-run1-task-1-e1", isolated: true as const, ttlSeconds: 3600,
  egressAllow: ["github.com", "registry.npmjs.org"], labels: { taskId: "task-1" }, ...over,
});

describe("BoxdProvider (mocked SDK)", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let p: BoxdProvider;
  beforeEach(() => { sdk = mockSdk(); p = new BoxdProvider({ client: sdk, dbPath: ":memory:", keepaliveMs: 0 }); });

  test("create uses a deterministic name from the idempotency key, isolated, deleteAfter=ttl", async () => {
    const r = await p.ensure(spec());
    expect(r.created).toBe(true);
    const create = sdk.calls.find((c) => c[0] === "create")![1];
    expect(create.name).toBe(vmNameFor("relay-run1-task-1-e1"));
    expect(create.isolated).toBe(true);
    expect(create.deleteAfter).toBe(3600);
  });

  test("VM id is recorded in SQLite before the VM is used (before setEgressAllow)", async () => {
    let recordedAtEgress: any = "unset";
    const orig = sdk.machines.setEgressAllow;
    sdk.machines.setEgressAllow = async (id, e) => { recordedAtEgress = p.record("relay-run1-task-1-e1"); return orig(id, e); };
    const { id } = await p.ensure(spec());
    expect(recordedAtEgress.vm_id).toBe(id);
    expect(recordedAtEgress.state).toBe("created");
  });

  test("retry with the same key reuses the recorded VM (no second create)", async () => {
    const a = await p.ensure(spec());
    const b = await p.ensure(spec());
    expect(b).toEqual({ id: a.id, created: false });
    expect(sdk.calls.filter((c) => c[0] === "create").length).toBe(1);
  });

  test("crash after create but before record: a fresh provider reuses the VM by name", async () => {
    // Simulate: VM exists remotely with our deterministic name, ledger is empty.
    sdk.vms.set("m_orphan", { id: "m_orphan", name: vmNameFor("relay-run1-task-1-e1"), status: "running" });
    const fresh = new BoxdProvider({ client: sdk, dbPath: ":memory:", keepaliveMs: 0 });
    const r = await fresh.ensure(spec());
    expect(r).toEqual({ id: "m_orphan", created: false });
    expect(sdk.calls.some((c) => c[0] === "create")).toBe(false);
    expect(fresh.record("relay-run1-task-1-e1")!.vm_id).toBe("m_orphan");
  });

  test("create racing ConflictError (name already taken by our own earlier attempt) adopts that VM", async () => {
    const name = vmNameFor("relay-run1-task-1-e1");
    let hidden = true; // pre-create lookup misses; the VM appears once create reports the conflict
    const origGet = sdk.machines.get;
    sdk.machines.get = async (id) => { if (hidden && id === name) throw new NotFoundError("no"); return origGet(id); };
    sdk.machines.create = async (prm) => {
      sdk.calls.push(["create", prm]); hidden = false;
      sdk.vms.set("m_9", { id: "m_9", name, status: "running" });
      throw new ConflictError("already exists");
    };
    const r = await p.ensure(spec());
    expect(r).toEqual({ id: "m_9", created: false });
    expect(p.record("relay-run1-task-1-e1")!.vm_id).toBe("m_9");
  });

  test("a recorded VM that was destroyed remotely is recreated", async () => {
    const a = await p.ensure(spec());
    sdk.vms.delete(a.id);
    const b = await p.ensure(spec());
    expect(b.created).toBe(true);
    expect(b.id).not.toBe(a.id);
  });

  test("always sends an explicit non-empty egress allowlist; empty is refused before any create", async () => {
    const { id } = await p.ensure(spec());
    expect(sdk.calls.find((c) => c[0] === "setEgressAllow")).toEqual(["setEgressAllow", id, ["github.com", "registry.npmjs.org"]]);
    await expect(p.ensure(spec({ idemKey: "k2", egressAllow: [] }))).rejects.toBeInstanceOf(SandboxConfigError);
    await expect(p.ensure(spec({ idemKey: "k3", egressAllow: ["  "] }))).rejects.toBeInstanceOf(SandboxConfigError);
    await expect(p.setEgress(id, [])).rejects.toBeInstanceOf(SandboxConfigError);
    expect(sdk.calls.filter((c) => c[0] === "create").length).toBe(1);
  });

  test("hibernated VM on reuse is woken; keepalive execs run on the interval", async () => {
    const a = await p.ensure(spec());
    sdk.vms.get(a.id)!.status = "hibernated";
    await p.ensure(spec());
    expect(sdk.calls.some((c) => c[0] === "wake" && c[1] === a.id)).toBe(true);

    const k = new BoxdProvider({ client: sdk, dbPath: ":memory:", keepaliveMs: 20 });
    const { id } = await k.ensure(spec({ idemKey: "ka" }));
    await Bun.sleep(70);
    const pings = sdk.calls.filter((c) => c[0] === "exec" && c[1] === id && c[2].command[0] === "true");
    expect(pings.length).toBeGreaterThanOrEqual(2);
    await k.destroy(id);
    const after = sdk.calls.length; await Bun.sleep(50);
    expect(sdk.calls.slice(after).some((c) => c[0] === "exec")).toBe(false);
  });

  test("git execs get per-task credentials from the hook; other execs do not", async () => {
    const seen: any[] = [];
    const q = new BoxdProvider({
      client: sdk, dbPath: ":memory:", keepaliveMs: 0,
      gitCredentials: async (ctx) => { seen.push(ctx); return { GIT_ASKPASS_TOKEN: "short-lived" }; },
    });
    const { id } = await q.ensure(spec());
    await q.exec(id, ["git", "push", "origin", "b"]);
    await q.exec(id, ["ls"]);
    const execs = sdk.calls.filter((c) => c[0] === "exec");
    expect(execs[0]![2].env).toEqual({ GIT_ASKPASS_TOKEN: "short-lived" });
    expect(execs[1]![2].env).toBeUndefined();
    expect(seen[0].labels).toEqual({ taskId: "task-1" });
  });

  test("typed errors: quota, timeout, hibernated, not found", async () => {
    sdk.fail.create = new RateLimitError("quota exceeded");
    await expect(p.ensure(spec())).rejects.toBeInstanceOf(SandboxQuotaError);
    sdk.fail.create = undefined;

    const { id } = await p.ensure(spec());
    sdk.fail.wait = new Error("machine not ready after 10ms");
    await expect(p.waitReady(id, 10)).rejects.toBeInstanceOf(SandboxTimeoutError);
    sdk.fail.wait = new APIStatusError("deadline exceeded", 4);
    await expect(p.waitReady(id, 10)).rejects.toBeInstanceOf(SandboxTimeoutError);

    sdk.vms.get(id)!.status = "hibernated";
    sdk.fail.exec = new ConflictError("machine is not running");
    await expect(p.exec(id, ["ls"])).rejects.toBeInstanceOf(SandboxHibernatedError);

    sdk.fail.exec = new NotFoundError("gone");
    await expect(p.exec(id, ["ls"])).rejects.toBeInstanceOf(SandboxNotFoundError);
    await expect(p.waitReady("m_nope", 10)).rejects.toBeInstanceOf(SandboxNotFoundError);
  });

  test("destroy is idempotent, marks the ledger, and list filters by prefix", async () => {
    const { id } = await p.ensure(spec());
    sdk.vms.set("m_x", { id: "m_x", name: "someone-else", status: "running" });
    expect((await p.list("relay-")).map((v) => v.id)).toEqual([id]);
    await p.destroy(id);
    await p.destroy(id); // NotFound swallowed
    expect(p.record("relay-run1-task-1-e1")!.state).toBe("destroyed");
    expect(await p.list("relay-")).toEqual([]);
  });

  test("CAPCOMD_SANDBOX selects the provider; fake is the default", () => {
    expect(providerFromEnv({})).toBeInstanceOf(FakeProvider);
    expect(providerFromEnv({ CAPCOMD_SANDBOX: "fake" })).toBeInstanceOf(FakeProvider);
    expect(() => providerFromEnv({ CAPCOMD_SANDBOX: "nope" })).toThrow();
  });
});
