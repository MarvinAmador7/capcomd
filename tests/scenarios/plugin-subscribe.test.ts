// `ctx.events.subscribe` in `capcomd serve` (docs/spec/plugin-api.md §8.4): the daemon's plugin host reads the daemon's
// own events and each run's through the engine (src/cli/commands/serve.ts, src/plugins/events.ts). The event-listener
// fixture (tests/plugins/fixtures/event-listener, loaded through CAPCOMD_TEST_PLUGINS) hears the note it writes on the
// daemon stream when the daemon starts, and a new run's run.created and agent.spawned events, in seq order, one at a
// time, with the run's own seqs; in the CLI's process the same plugin has no stream to subscribe to and listens to nothing.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { dottedType } from "../../src/api/envelope";
import type { Heard } from "../plugins/fixtures/event-listener/index";
import { world, newRun, spawnRoot, trajectory, waitAll, WORKER, type World } from "./harness";

const LISTENER = join(import.meta.dir, "..", "plugins", "fixtures", "event-listener");
let w: World;
let logDir: string | undefined;
let log: string;
const heard = (): Heard[] => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Heard) : []);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 30_000) => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await sleep(100); return cond(); };

beforeAll(async () => {
  logDir = mkdtempSync(join(tmpdir(), "capcomd-plugin-subscribe-"));
  log = join(logDir, "events.ndjson");
  w = await world("plugin-subscribe", { CAPCOMD_TEST_PLUGINS: LISTENER, CAPCOMD_TEST_EVENT_LOG: log, NODE_ENV: "test" });
}, 120_000);
afterAll(async () => {
  try { await w?.stop(); } finally { if (logDir) rmSync(logDir, { recursive: true, force: true }); }
});

test("the daemon's plugin hears its note on the daemon stream and a new run's events, in order, one at a time", async () => {
  // The daemon started: the plugin noted it on the daemon stream and heard its own note back.
  expect(await until(() => heard().some((h) => h.stream === "daemon"))).toBe(true);
  expect(heard().filter((h) => h.stream === "daemon").map((h) => [h.type, h.text])).toEqual([["plugin.event-listener.noted", "The daemon started."]]);

  const run = await newRun(w);
  const worker = w.script("worker", WORKER);
  const root = await spawnRoot(w, run, "worker", `FILE=src/a.txt CONTENT=a ${worker}`);
  expect((await waitAll(w, run, [root], 120_000)).agents[0].status).toBe("done");
  expect(await until(() => heard().some((h) => h.stream === run && h.type === "agent.spawned"))).toBe(true);
  await sleep(1500);   // a few more polls: nothing else comes

  const mine = heard().filter((h) => h.stream === run);
  const want = (await trajectory(w, run) as Array<{ seq: number; type: string }>).map((e) => ({ seq: e.seq, type: /^[A-Z]/.test(e.type) ? dottedType(e.type) : e.type }))
    .filter((e) => e.type === "run.created" || e.type === "agent.spawned");
  expect(mine.map((h) => [h.type, h.seq])).toEqual(want.map((e) => [e.type, e.seq]));
  expect(mine.map((h) => h.type)).toEqual(["run.created", "agent.spawned"]);
  expect(heard().every((h) => h.overlap === 1)).toBe(true);
}, 180_000);
