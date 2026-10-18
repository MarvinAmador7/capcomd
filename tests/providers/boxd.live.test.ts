// Live boxd integration test. Skipped unless BOXD_API_KEY is set. Never prints the key.
import { describe, expect, test, afterAll } from "bun:test";
import { BoxdProvider } from "../../src/providers/boxd";

const live = !!process.env.BOXD_API_KEY;
const created: string[] = [];
let provider: BoxdProvider | null = null;

describe.skipIf(!live)("BoxdProvider live (BOXD_API_KEY)", () => {
  afterAll(async () => {
    // Safety net: destroy anything this test created even if an assertion failed.
    for (const id of created) await provider?.destroy(id).catch(() => {});
    await provider?.close();
  });

  test("create → uname → egress allowlist blocks a non-allowed host → destroy", async () => {
    provider = new BoxdProvider({ dbPath: ":memory:", keepaliveMs: 0 });
    const idemKey = `live-test-${Date.now()}-e1`;
    const { id, created: isNew } = await provider.ensure({
      idemKey, isolated: true, ttlSeconds: 900,
      egressAllow: ["example.com"], labels: { test: "live" },
    });
    created.push(id);
    console.log(`[live] created vm ${id} (new=${isNew})`);
    await provider.waitReady(id, 180_000);

    const u = await provider.exec(id, ["sh", "-c", "uname -a && echo ok"], { timeoutMs: 60_000 });
    console.log(`[live] uname exit=${u.code}\n${u.stdout.trim()}`);
    expect(u.code).toBe(0);
    expect(u.stdout).toContain("ok");

    const probe = (url: string) =>
      provider!.exec(id, ["sh", "-c",
        `if command -v curl >/dev/null; then curl -sS -m 15 -o /dev/null -w '%{http_code}' ${url}; else wget -q -T 15 -O /dev/null ${url} && echo 200; fi`],
        { timeoutMs: 60_000 });
    const allowed = await probe("https://example.com/");
    console.log(`[live] allowed https://example.com -> exit=${allowed.code} out=${allowed.stdout.trim()} err=${allowed.stderr.trim().slice(0, 200)}`);
    const blocked = await probe("https://www.google.com/");
    console.log(`[live] blocked https://www.google.com -> exit=${blocked.code} out=${blocked.stdout.trim()} err=${blocked.stderr.trim().slice(0, 200)}`);
    expect(allowed.code).toBe(0);
    expect(blocked.code).not.toBe(0);

    await provider.destroy(id);
    created.splice(created.indexOf(id), 1);
    const left = (await provider.list("relay-")).filter((v) => v.id === id);
    console.log(`[live] destroyed vm ${id}; still listed: ${left.length}`);
    expect(left.length).toBe(0);
  }, 400_000);
});
