// Capability events.wait (ADR-026 §3), against a real engine: GET /v1/events/wait looks again as soon as the run's scope
// actor says it appended (its eventsChanged broadcast, sent after each transaction that appended commits, heard through
// rivetSource's subscribeEvents), not at its next poll. This server polls once a minute, so a wait that answers within
// a moment of the append was woken by the push. Both ways an event reaches the log are covered: addEvent (run.archived,
// run.restored) and a plugin's own event (recordPluginEvent). The unit side, with the memory source and the daemon
// scope: tests/api/events-wait.test.ts.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { addClient, loadClients } from "../../src/api/clients";
import { rivetSource } from "../../src/api/rivet-source";
import { harnessApp } from "../../src/api/server";
import { harnessState } from "../../src/api/state";
import { client } from "../../src/core/relay";
import { world, newRun, type World } from "./harness";

let w: World;
let src: ReturnType<typeof rivetSource>;
let app: ReturnType<typeof harnessApp>;
let token = "";
const SLOW = 60_000;

beforeAll(async () => {
  w = await world("events-wait-push");
  const clients = join(mkdtempSync(join(tmpdir(), "capcomd-events-push-")), "harness-clients.json");
  token = addClient("reader", ["read"], clients).token;
  src = rivetSource();
  app = harnessApp({ source: src, clients: () => loadClients(clients), state: harnessState(null), pollMs: SLOW });
}, 180_000);
afterAll(async () => { await w?.stop(); });

const get = async (q: string, signal?: AbortSignal) => {
  const r = await app.request(`/v1/events/wait?${q}`, { headers: { authorization: `Bearer ${token}` }, ...(signal ? { signal } : {}) });
  return { status: r.status, body: (await r.json()) as any };
};
const head = async (run: string) => ((await client().scope.getOrCreate([run]).getEvents({})) as Array<{ seq: number }>).at(-1)?.seq ?? 0;
let n = 0;
const note = (run: string) => client().scope.getOrCreate([run]).recordPluginEvent({ type: "plugin.probe.noted", entity: "plugin:probe", text: "noted", data: {}, key: `probe-${++n}` }) as Promise<{ seq: number }>;
const until = async (cond: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error("condition not reached"); await Bun.sleep(5); }
};

test("a wait answers within moments of the append, through the scope's push", async () => {
  const run = await newRun(w);
  const after = await head(run);
  // Its first wait connects the run's feed: an append right away (before the feed is open) is still found, by the look
  // its (re)connect asks for.
  const t1 = Date.now();
  const first = get(`scope=${run}&after=${after}&type=plugin.probe.noted&wait=30`);
  const a = await note(run);
  const r1 = await first;
  expect(r1.body.events.map((e: any) => e.seq)).toEqual([a.seq]);
  expect(Date.now() - t1).toBeLessThan(5000);

  // With the feed open: addEvent's path (run.archived) and the plugin event's path, each timed from its append.
  const timings: number[] = [];
  let cursor = r1.body.cursor;
  for (const [type, act] of [
    ["run.archived", () => client().scope.getOrCreate([run]).archive({ by: "test" })],
    ["run.restored", () => client().scope.getOrCreate([run]).restore({ by: "test" })],
    ["plugin.probe.noted", () => note(run)],
  ] as const) {
    const p = get(`scope=${run}&after=${cursor}&type=${type}&wait=30`);
    await until(() => src.eventListeners(run) === 1);
    await Bun.sleep(50);
    const t0 = performance.now();
    await act();
    const r = await p;
    timings.push(performance.now() - t0);
    expect(r.body.events.map((e: any) => e.type)).toEqual([type]);
    expect(r.body.timedOut).toBe(false);
    cursor = r.body.cursor;
  }
  console.log(`events.wait push wake (append call + answer), ms: ${timings.map((t) => t.toFixed(1)).join(", ")}`);
  // The append's own actor call is in it; the minute's poll is not.
  for (const t of timings) expect(t).toBeLessThan(1000);
  expect(src.eventListeners()).toBe(0);
}, 60_000);

test("no lost event: appends while waits resume, from two waiters", async () => {
  const run = await newRun(w);
  const start = await head(run);
  const N = 20;
  const appended: number[] = [];
  const waiter = async () => {
    let cursor = start;
    const seen: number[] = [];
    while (seen.length < N) {
      const r = await get(`scope=${run}&after=${cursor}&type=plugin.probe.noted&wait=20`);
      expect(r.status).toBe(200);
      expect(r.body.timedOut).toBe(false);
      seen.push(...r.body.events.map((e: any) => e.seq));
      cursor = r.body.cursor;
    }
    return seen;
  };
  const both = Promise.all([waiter(), waiter()]);
  for (let i = 0; i < N; i++) {
    appended.push((await note(run)).seq);
    await Bun.sleep(i % 3 === 0 ? 0 : i % 3 === 1 ? 3 : 40);
  }
  const [a, b] = await both;
  expect(a).toEqual(appended);
  expect(b).toEqual(appended);
  expect(src.eventListeners()).toBe(0);
}, 90_000);

test("listeners and the feed's connection go when the waits do, aborted ones too", async () => {
  const run = await newRun(w);
  const after = await head(run);
  const acs = Array.from({ length: 8 }, () => new AbortController());
  const gone = acs.map((ac) => get(`scope=${run}&after=${after}&type=agent.done&wait=30`, ac.signal).catch(() => null));
  await until(() => src.eventListeners(run) === 8);
  for (const ac of acs) ac.abort();
  await Promise.all(gone);
  await until(() => src.eventListeners(run) === 0, 2000);
  // The connection stays a little while for a resumed wait, then closes.
  await until(() => src.eventFeeds() === 0, 15_000);
}, 60_000);

test("after the engine restarts, an append still wakes the wait (the feed reconnects and looks)", async () => {
  const run = await newRun(w);
  const after = await head(run);
  const p = get(`scope=${run}&after=${after}&type=plugin.probe.noted&wait=40`);
  await until(() => src.eventListeners(run) === 1);
  await Bun.sleep(200);
  await w.restart(500);
  // Appended once the engine is back (an actor call retries until then): the reconnected feed hears it, or its
  // reconnect's look finds it.
  const t0 = Date.now();
  const a = await note(run);
  const r = await p;
  expect(r.body.events.map((e: any) => e.seq)).toEqual([a.seq]);
  expect(Date.now() - t0).toBeLessThan(10_000);
}, 120_000);
