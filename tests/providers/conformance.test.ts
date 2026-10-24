// ADR-020 §3: what every sandbox provider must do, run against each one that is available here. Docker runs when a
// daemon answers (OrbStack, Docker Desktop, CI's Linux runners); boxd isn't run here (it needs an account).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DockerProvider, dockerBin } from "../../src/providers/docker";
import { SandboxNotFoundError } from "../../src/providers/boxd-errors";
import type { SandboxProvider } from "../../src/providers/sandbox";

const IMAGE = process.env.CAPCOMD_TEST_DOCKER_IMAGE ?? "debian:bookworm-slim";
const dockerUp = (() => { try { return Bun.spawnSync([dockerBin(), "version", "--format", "{{.Server.Version}}"]).exitCode === 0; } catch { return false; } })();

interface Subject { name: string; make: () => SandboxProvider & Record<string, any>; available: boolean; snapshots: boolean; interactive: boolean }
const subjects: Subject[] = [
  { name: "docker", available: dockerUp, snapshots: true, interactive: true,
    make: () => new DockerProvider({ image: IMAGE, namePrefix: "capcomd-conf-", ledgerPath: join(mkdtempSync(join(tmpdir(), "capcomd-conf-")), "ttl.json") }) },
];

for (const s of subjects) {
  describe.skipIf(!s.available)(`provider conformance: ${s.name}`, () => {
    const p = s.make();
    const made: string[] = [];
    const spec = (key: string, extra: Record<string, unknown> = {}) => ({ idemKey: `conf-${key}-${process.pid}`, egressAllow: ["*"], isolated: true as const, ttlSeconds: 600, labels: { purpose: "conformance" }, ...extra });
    const box = async (key: string, extra: Record<string, unknown> = {}) => {
      const r = await p.ensure(spec(key, extra));
      made.push(r.id);
      await p.waitReady(r.id, 120_000);
      return r.id;
    };
    afterAll(async () => { for (const id of made) await p.destroy(id).catch(() => {}); });

    test("ensure is idempotent by key; list finds it by prefix; destroy is idempotent", async () => {
      const a = await p.ensure(spec("idem"));
      made.push(a.id);
      expect(a.created).toBe(true);
      const b = await p.ensure(spec("idem"));
      expect(b).toEqual({ id: a.id, created: false });
      await p.waitReady(a.id, 120_000);
      expect((await p.list("capcomd-conf-")).map((v) => v.id)).toContain(a.id);
      await p.destroy(a.id);
      await p.destroy(a.id);
      expect((await p.list("capcomd-conf-")).map((v) => v.id)).not.toContain(a.id);
      await expect(p.exec(a.id, ["true"])).rejects.toBeInstanceOf(SandboxNotFoundError);
    }, 180_000);

    test("exec: argv, exit code, stdout and stderr, env, cwd, and a timeout that kills the command", async () => {
      const id = await box("exec");
      expect(await p.exec(id, ["sh", "-c", "echo out; echo err >&2; exit 3"])).toEqual({ code: 3, stdout: "out\n", stderr: "err\n" });
      expect((await p.exec(id, ["printenv", "SECRETISH"], { env: { SECRETISH: "a b'c" } })).stdout).toBe("a b'c\n");
      expect((await p.exec(id, ["pwd"], { cwd: "/tmp" })).stdout).toBe("/tmp\n");
      const t0 = Date.now();
      const slow = await p.exec(id, ["sh", "-c", "sleep 60; echo late"], { timeoutMs: 2000 });
      expect(slow.code).not.toBe(0);
      expect(slow.stdout).not.toContain("late");
      expect(Date.now() - t0).toBeLessThan(20_000);
      // killed in the sandbox, not only this client (no procps in a slim image: read /proc)
      expect((await p.exec(id, ["sh", "-c", "for f in /proc/[0-9]*/cmdline; do tr '\\0' ' ' < $f 2>/dev/null; echo; done | grep -c '^sleep 60' || true"])).stdout.trim()).toBe("0");
    }, 180_000);

    test("upload and download round-trip bytes; a detached process outlives the exec that started it", async () => {
      const id = await box("files");
      const bytes = new Uint8Array(70_000).map((_, i) => (i * 31) % 256);
      await p.upload(id, "/tmp/blob.bin", bytes);
      expect(Buffer.from(await p.download(id, "/tmp/blob.bin")).equals(Buffer.from(bytes))).toBe(true);
      await p.exec(id, ["sh", "-c", "setsid nohup sh -c 'sleep 2; echo done > /tmp/later' > /dev/null 2>&1 < /dev/null & echo started"]);
      await Bun.sleep(3500);
      expect((await p.exec(id, ["cat", "/tmp/later"])).stdout).toBe("done\n");
    }, 180_000);

    test.skipIf(!s.snapshots)("snapshots: a sandbox from a snapshot has its files; get, list and delete", async () => {
      const id = await box("snap-src");
      await p.exec(id, ["sh", "-c", "echo baked > /opt/baked.txt"]);
      const name = `capcomd-conf-snap-${process.pid}`;
      expect(await p.snapshotCreate(id, name)).toMatchObject({ name, status: "ready" });
      expect(await p.snapshotGet(name)).toMatchObject({ name, status: "ready" });
      expect((await p.snapshotList()).map((x: any) => x.name)).toContain(name);
      const child = await box("snap-child", { fromSnapshot: name });
      expect((await p.exec(child, ["cat", "/opt/baked.txt"])).stdout).toBe("baked\n");
      await p.destroy(child);
      await p.snapshotDelete(name);
      expect(await p.snapshotGet(name)).toBeNull();
    }, 300_000);

    test.skipIf(!s.interactive)("streamExec: a command with a terminal reads input and writes output", async () => {
      const id = await box("tty");
      const sess = p.streamExec(id, ["sh", "-c", "read x; echo got:$x; tty"], { tty: true });
      sess.write("hello\n");
      let out = "";
      const reader = (async () => { for await (const c of sess.output) out += new TextDecoder().decode(c); })();
      expect(await sess.wait()).toBe(0);
      await reader;
      expect(out).toContain("got:hello");
      expect(out).toMatch(/\/dev\/pts\/\d+/);
    }, 120_000);

    test("sweep removes sandboxes whose delete-after time has passed, and only those", async () => {
      const old = await box("sweep-old");
      const fresh = await box("sweep-fresh");
      await p.extendTtl!(old, -1);
      const gone: string[] = await p.sweep();
      expect(gone).toContain(old);
      expect(gone).not.toContain(fresh);
      expect((await p.list("capcomd-conf-")).map((v) => v.id)).not.toContain(old);
    }, 180_000);
  });
}
