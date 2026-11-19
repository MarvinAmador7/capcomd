// Under load the engine refuses a command it never ran and says when to ask again ("overloaded … retry after N ms").
// capcomd's client waits that long and asks again, a few times and a couple of seconds at most (src/core/engine-retry.ts);
// a not_found or any other error is not retried. Seen in CI: a lookup of an unknown run met the refusal and the plugin
// services answered "unavailable" instead of not_found.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { RivetError } from "rivetkit";
import { OVERLOAD_RETRY, overloadRetryAfterMs, retryOverloaded, retryingClient } from "../../src/core/engine-retry";

/** The refusal as rivetkit's client throws it (copied from the CI log). */
const overloaded = (ms = 100) =>
  new RivetError("depot", "overloaded", `The storage host refused the command (volume_transition); retry after ${ms} ms.`, {
    metadata: { reason: "volume_transition", retry_after_ms: ms },
  });
const notFound = () => new RivetError("actor", "not_found", "The actor does not exist or was destroyed.");

/** A fake that refuses `times` times, then answers with `then`. */
function refusing<T>(times: number, then: () => T) {
  const fake = { calls: 0, run: async () => (++fake.calls <= times ? Promise.reject(overloaded()) : then()) };
  return fake;
}
const waits: number[] = [];
const opts = { ...OVERLOAD_RETRY, sleep: async (ms: number) => void waits.push(ms) };

test("the refusal's wait comes from its metadata, else its text; nothing else is a refusal", () => {
  expect(overloadRetryAfterMs(overloaded(250))).toBe(250);
  expect(overloadRetryAfterMs(Object.assign(new Error("The storage host refused the command; retry after 40 ms."), { code: "overloaded" }))).toBe(40);
  expect(overloadRetryAfterMs(notFound())).toBeNull();
  expect(overloadRetryAfterMs(new RivetError("actor", "overloaded", "queue full"))).toBeNull(); // no wait asked: not ours to guess
  expect(overloadRetryAfterMs(new RivetError("user", "internal", "retry after 100 ms"))).toBeNull();
  expect(overloadRetryAfterMs(new Error("fetch failed"))).toBeNull();
  expect(overloadRetryAfterMs(null)).toBeNull();
});

test("refused twice, then answered: the answer, after waiting what the engine asked", async () => {
  waits.length = 0;
  const f = refusing(2, () => "run");
  expect(await retryOverloaded(f.run, opts)).toBe("run");
  expect([f.calls, waits]).toEqual([3, [100, 100]]);
});

test("refused, then not_found: not_found, never retried", async () => {
  waits.length = 0;
  const f = refusing(3, () => Promise.reject(notFound()));
  const e = await retryOverloaded(f.run, opts).catch((x) => x);
  expect([e.code, f.calls, waits.length]).toEqual(["not_found", 4, 3]);
});

test("another error is thrown at once", async () => {
  waits.length = 0;
  let calls = 0;
  const e = await retryOverloaded(async () => { calls++; throw new RivetError("user", "conflict", "already exists"); }, opts).catch((x) => x);
  expect([e.code, calls, waits.length]).toEqual(["conflict", 1, 0]);
});

test("refused past the attempts or the wait cap: the engine's refusal as it was", async () => {
  waits.length = 0;
  const always = refusing(Infinity, () => "never");
  const e = await retryOverloaded(always.run, opts).catch((x) => x);
  expect([e.group, e.code, always.calls, waits]).toEqual(["depot", "overloaded", OVERLOAD_RETRY.attempts, [100, 100, 100, 100]]);

  // A wait past the cap is not waited.
  waits.length = 0;
  let calls = 0;
  const slow = await retryOverloaded(async () => { calls++; throw overloaded(1500); }, opts).catch((x) => x);
  expect([slow.code, calls, waits]).toEqual(["overloaded", 2, [1500]]);
});

// The real client against a fake engine: rivetkit parses the refusal, and an existing-actor lookup through relay's client
// waits it out, so an unknown run is still not_found and a known one is found.
let server: ReturnType<typeof Bun.serve>;
let refuse = 0;
let lookups = 0;
let known = new Set<string>();
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/metadata") return Response.json({ runtime: "engine", version: "test" });
      if (req.method === "GET" && url.pathname === "/actors") {
        lookups++;
        if (refuse > 0) {
          refuse--;
          return Response.json(
            { group: "depot", code: "overloaded", message: "The storage host refused the command (volume_transition); retry after 20 ms.", metadata: { reason: "volume_transition", retry_after_ms: 20 } },
            { status: 503 },
          );
        }
        const key = url.searchParams.get("key") ?? "";
        const actors = [...known].some((k) => key.includes(k))
          ? [{ actor_id: "a1", name: url.searchParams.get("name"), key, create_ts: 1, namespace_id: "default", runner_name_selector: "default", crash_policy: "sleep" }]
          : [];
        return Response.json({ actors });
      }
      return new Response("no", { status: 404 });
    },
  });
  process.env.CAPCOMD_ENDPOINT = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));

test("relay's existingActor waits out the refusal: unknown stays null (not_found), known is found", async () => {
  const { existingActor } = await import("../../src/core/relay");
  refuse = 2; lookups = 0;
  expect(await existingActor("scope", ["run-ghost-overloaded"])).toBeNull();
  expect([lookups, refuse]).toEqual([3, 0]);

  known = new Set(["run-known-overloaded"]);
  refuse = 1; lookups = 0;
  expect(await existingActor("scope", ["run-known-overloaded"])).not.toBeNull();
  expect(lookups).toBe(2);

  // Refused past the attempts: thrown as the engine's refusal (callers answer "unavailable").
  refuse = 100; lookups = 0;
  const e = await existingActor("scope", ["run-still-refused"]).catch((x) => x);
  expect([e.group, e.code, lookups]).toEqual(["depot", "overloaded", OVERLOAD_RETRY.attempts]);
  refuse = 0;
});

test("a handle's non-promise methods pass through untouched", () => {
  const handle = { connect: () => "conn", sync: () => 7 };
  // As rivetkit's client: an actor kind is not a property of the client itself.
  const c = retryingClient(new Proxy({}, { get: (_, p) => (p === "run" ? { get: () => handle, getOrCreate: () => handle } : undefined) }) as any);
  expect(c.run.get(["x"]).connect()).toBe("conn");
  expect(c.run.getOrCreate(["x"]).sync()).toBe(7);
});
