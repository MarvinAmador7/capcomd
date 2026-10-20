// BoxdProvider EnvPlatform methods against a mocked SDK client (shapes from @boxd-sh/sdk 0.2.17 d.ts/README).
import { expect, test } from "bun:test";
import { BoxdProvider } from "../../src/providers/boxd";

function client() {
  const calls: any[] = [];
  const snaps = new Map<string, any>();
  const secrets = new Map<string, any>();
  const c: any = {
    machines: {},
    snapshots: {
      async create(machine: string, name: string) { calls.push(["snapshots.create", machine, name]); snaps.set(name, { id: "s1", name, version: 1, status: "pending" }); return snaps.get(name); },
      async get(name: string) { const s = snaps.get(name); if (!s) { class NotFoundError extends Error {} throw new NotFoundError(`snapshot ${name} not found`); } s.status = "ready"; return s; },
      async list() { return [...snaps.values()]; },
      async delete(name: string) { calls.push(["snapshots.delete", name]); snaps.delete(name); },
    },
    secrets: {
      async set(name: string, value: string, opts: any) {
        calls.push(["secrets.set", name, opts]);
        if (name === "BAD") throw new Error(`invalid secret value ${value}`);
        secrets.set(name, { name, scope: opts.scope, domains: opts.domains });
      },
      async list() { return [...secrets.values()]; },
    },
  };
  return { c, calls };
}

test("snapshots + host-bound secrets map onto the SDK; values never in errors", async () => {
  const { c, calls } = client();
  const p = new BoxdProvider({ client: c, dbPath: ":memory:", keepaliveMs: 0 });
  expect(await p.snapshotCreate("m1", "capcomd-env-a")).toMatchObject({ name: "capcomd-env-a", status: "pending", id: "s1" });
  expect(await p.snapshotGet("capcomd-env-a")).toMatchObject({ status: "ready" });
  expect(await p.snapshotGet("missing")).toBeNull();
  expect((await p.snapshotList()).map((s) => s.name)).toEqual(["capcomd-env-a"]);
  await p.snapshotDelete("capcomd-env-a");
  await p.secretSet("ANTHROPIC_API_KEY", "sk-ant-api03-SECRET-0123456789abcdef", { domains: ["api.anthropic.com"], scope: "private" });
  expect(calls).toContainEqual(["secrets.set", "ANTHROPIC_API_KEY", { scope: "private", domains: ["api.anthropic.com"] }]);
  expect(await p.secretList()).toEqual([{ name: "ANTHROPIC_API_KEY", scope: "private", domains: ["api.anthropic.com"] }]);
  const err = await p.secretSet("BAD", "sk-ant-api03-LEAKY-0123456789abcdef", { domains: ["x.com"], scope: "private" }).catch((e) => e);
  expect(String(err.message)).not.toContain("LEAKY");
  await expect(p.secretSet("X", "v", { domains: [], scope: "private" })).rejects.toThrow("without bound domains");
});
