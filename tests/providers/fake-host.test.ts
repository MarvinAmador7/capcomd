// The fake-host sandbox runs VM scripts on this host. They call GNU `timeout -k`, which macOS lacks: there the
// provider puts a stand-in first on PATH, and it must behave as GNU's does. The agent runner wraps an agent with a time
// limit in `timeout -k 10 …`: a stand-in that waited the 10 s out after every TERM made each such agent 10 s slower
// on macOS than on Linux.
import { expect, test } from "bun:test";
import { FakeProvider } from "../../src/providers/fake";

const machine = async () => {
  const p = new FakeProvider({ hostExec: true });
  const { id } = await p.ensure({ idemKey: `fh-${Math.random()}`, isolated: true, ttlSeconds: 60, egressAllow: [], labels: {} });
  await p.waitReady(id, 1000);
  return { p, id };
};
const timed = async (f: () => Promise<{ code: number }>) => { const t0 = Date.now(); const r = await f(); return { code: r.code, ms: Date.now() - t0 }; };

test("timeout -k: a command that ends at the TERM ends the wait with 124 then, not the kill delay later", async () => {
  const { p, id } = await machine();
  const r = await timed(() => p.exec(id, ["timeout", "-k", "10", "1", "sh", "-c", "sleep 60"]));
  expect(r.code).toBe(124);
  expect(r.ms).toBeLessThan(5000);
}, 20_000);

test("timeout -k: a command that ignores TERM is killed the kill delay after it; one that ends in time keeps its code", async () => {
  const { p, id } = await machine();
  const r = await timed(() => p.exec(id, ["timeout", "-k", "1", "1", "sh", "-c", "trap '' TERM; sleep 60"]));
  expect(r.code).not.toBe(0);
  expect(r.ms).toBeGreaterThanOrEqual(1900);
  expect(r.ms).toBeLessThan(8000);
  expect((await p.exec(id, ["timeout", "-k", "10", "5", "sh", "-c", "exit 3"])).code).toBe(3);
}, 20_000);
